import { catalog, refreshPolicy } from './trusted-policy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { loadTrustedPolicy, selectWorkflow, allowedInstallation, taskBinding, supportsRevision } from '../dist/profiles.js';
import { connectBuilder } from '../dist/builder.js';
import { matchDeliveryPolicy } from '../dist/client/delivery-policy.js';
import { policyFor } from './workflow-fixture.mjs';

test('missing or altered administrator pin blocks Builder before credentials, Git or network',async()=>{
 let calls=0;const denied=()=>{calls++;throw new Error('Must not access credentials or provider');};
 try{
  delete process.env.AWH_BUILDER_POLICY_FILE;
  await assert.rejects(connectBuilder({read:denied,fetch:denied,spawn:denied,realpath:denied,stat:denied,cwd:denied}),/Administrator-approved/);
  refreshPolicy();process.env.AWH_BUILDER_POLICY_SHA256='0'.repeat(64);
  await assert.rejects(connectBuilder({read:denied,fetch:denied,spawn:denied,realpath:denied,stat:denied,cwd:denied}),/Administrator-approved/);
  assert.equal(calls,0);
 }finally{refreshPolicy();}
});
test('checked-in files and redirected external policy cannot become administrator authority',t=>{
 const directory=mkdtempSync(join(tmpdir(),'awh-policy-boundary-'));t.after(()=>{refreshPolicy();assert.equal(dirname(directory),tmpdir());rmSync(directory,{recursive:true,force:true});});
 const bytes=JSON.stringify(catalog),pin=createHash('sha256').update(bytes).digest('hex'),file=join(directory,'policy.json');writeFileSync(file,bytes,{mode:0o600});
 process.env.AWH_BUILDER_POLICY_SHA256=pin;process.env.AWH_BUILDER_POLICY_FILE=resolve('tests/fixtures/builder-policy.json');assert.throws(loadTrustedPolicy,/Administrator-approved/);
 const alias=join(directory,'alias');symlinkSync(directory,alias,process.platform==='win32'?'junction':'dir');process.env.AWH_BUILDER_POLICY_FILE=join(alias,'policy.json');assert.throws(loadTrustedPolicy,/Administrator-approved/);
});
test('an arbitrary project, version, executor or complete unapproved repository set cannot grant delivery',()=>{
 const policy=loadTrustedPolicy();assert(Object.isFrozen(policy.profiles[0].workflows[0]));
 assert.throws(()=>selectWorkflow({profile:'unapproved',workflow:'default'}));
 const cp=policyFor('project-alpha','repeatable');matchDeliveryPolicy(cp,cp.ref);
 for(const mutate of [p=>p.repository='evil/project',p=>p.version='other',p=>p.verification.commands=['pnpm install'],p=>p.executor_restrictions.executor_ids=['arbitrary']]){const changed=structuredClone(cp);mutate(changed);assert.throws(()=>matchDeliveryPolicy(changed,cp.ref));}
 const selected=policy.installation.selected_repository_sets.at(-1).map(full_name=>({full_name}));
 assert(allowedInstallation(selected,selected.length));assert(!allowedInstallation([...selected,{full_name:'example-org/unapproved'}],selected.length+1));
 assert(!allowedInstallation([...selected,selected[0]],selected.length+1));assert(!allowedInstallation(selected,selected.length+1));
});

test('Revision refuses a different approved base, missing check or additional checks before credentials or provider access',async()=>{
 const profile=catalog.profiles.find(p=>p.id==='project-alpha'),workflow=profile.workflows.find(w=>w.id==='repeatable');
 const originalBase=profile.base,originalCommands=[...workflow.verification_commands];let calls=0;
 const denied=()=>{calls++;throw new Error('Must not access credentials or provider');};
 try{
  assert(supportsRevision(profile,workflow));
  for(const [base,commands] of [['release',originalCommands],['main',['pnpm check']],['main',[...originalCommands,'pnpm check']]]){
   profile.base=base;workflow.verification_commands=commands;refreshPolicy();
   assert(!supportsRevision(profile,workflow));
   const binding=taskBinding({repository:profile.repository,issue:90,branch:workflow.branch+'90',source_sha:'a'.repeat(40),profile_ref:'project-alpha/repeatable',profile_version:workflow.version,executor_id:'alpha-executor',machine_id:'fixture-machine'});
   await assert.rejects(connectBuilder({read:denied,fetch:denied,spawn:denied,realpath:denied,stat:denied,cwd:denied},{profile:'project-alpha',workflow:'repeatable'},binding,'revision'),/approved main diff-check policy/);
  }
  assert.equal(calls,0);
 }finally{profile.base=originalBase;workflow.verification_commands=originalCommands;refreshPolicy();}
});
