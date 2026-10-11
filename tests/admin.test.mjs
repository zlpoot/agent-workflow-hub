import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { approveProposal, prepareApproval, prepareRevoke, prepareGrant, proposeGrant, inspectRegistry, launcherDescriptor, inspectProposal, compareProposals, diagnoseRegistry } from '../dist/admin/operations.js';
import { digest, encode, managedContext } from '../dist/admin/registry.js';
import { loadTrustedPolicy } from '../dist/profiles.js';
import { connectBuilder } from '../dist/builder.js';
const originalPolicy = JSON.parse(readFileSync(new URL('./fixtures/builder-policy.json',import.meta.url)));
const envKeys = ['AWH_ADMIN_TRUST_FILE','AWH_ADMIN_TRUST_SHA256','AWH_ADMIN_APPROVAL_FILE','AWH_ADMIN_APPROVAL_SHA256','AWH_ADMIN_VERSION','AWH_ADMIN_EXECUTOR_ID','AWH_ADMIN_MACHINE_ID','AWH_BUILDER_POLICY_FILE','AWH_BUILDER_POLICY_SHA256'];
function fixture(t) {
 const saved = Object.fromEntries(envKeys.map(key=>[key,process.env[key]])); envKeys.forEach(key=>delete process.env[key]);
 const directory=mkdtempSync(join(tmpdir(),'awh-admin-test-')),root=join(directory,'registry');mkdirSync(root,{mode:0o700});
 t.after(()=>{for(const key of envKeys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}assert.equal(resolve(directory),join(tmpdir(),directory.split(/[\\/]/).at(-1)));rmSync(directory,{recursive:true,force:true});});
 const policy=structuredClone(originalPolicy),profile=policy.profiles[0],workflow=profile.workflows[0];
 policy.profiles=[{...profile,workflows:[{...workflow,verification_commands:['pnpm typecheck'],executor_restrictions:{executor_ids:['test-executor'],machine_ids:['test-machine']}}]}];
 policy.default_selection={profile:profile.id,workflow:workflow.id};
 const task={repository:profile.repository,issue:workflow.work_item.issue,branch:workflow.branch,base_sha:'b'.repeat(40),head_sha:'a'.repeat(40),profile:profile.id,workflow:workflow.id,executor_id:'test-executor',machine_id:'test-machine',expires_at:new Date(Date.now()+86400000).toISOString()};
 const trust={schema_version:'1.0',kind:'admin_trust',registry_root:root,operator:{login:'test-admin',id:12345},installation_sha256:digest(encode(policy.installation)),host:hostname()};
 const trustFile=join(directory,'trust.json');writeFileSync(trustFile,encode(trust),{mode:0o600});
 process.env.AWH_ADMIN_TRUST_FILE=trustFile;process.env.AWH_ADMIN_TRUST_SHA256=digest(encode(trust));
 const file=name=>join(directory,name),prepare=(version='v1',changed=policy)=>{const path=file(version+'.json');proposeGrant(changed,version,{...task},path);return path;};
 const pin=(path,receiptId='receipt-'+JSON.parse(readFileSync(path)).version)=>{const receipt=file(receiptId+'.json');prepareApproval(path,receiptId,'Synthetic isolated administrator approval',receipt);process.env.AWH_ADMIN_APPROVAL_FILE=receipt;process.env.AWH_ADMIN_APPROVAL_SHA256=digest(readFileSync(receipt));return receipt;};
 const activate=(version='v1')=>{process.env.AWH_ADMIN_VERSION=version;process.env.AWH_ADMIN_EXECUTOR_ID=task.executor_id;process.env.AWH_ADMIN_MACHINE_ID=task.machine_id;};
 return {root,policy,task,trustFile,file,prepare,pin,activate};
}
test('proposal and prepared receipt confer no authority; independent pins and exact operator are mandatory',async t=>{
 const f=fixture(t),path=f.prepare();assert.equal(inspectProposal(path).authority_verified,false);
 assert.throws(()=>approveProposal(path),/independent_approval_pin_required/);assert(!existsSync(join(f.root,'state.json')));
 const receipt=f.pin(path);delete process.env.AWH_ADMIN_APPROVAL_SHA256;
 assert.throws(()=>approveProposal(path),/independent_approval_pin_required/);
 process.env.AWH_ADMIN_APPROVAL_SHA256='0'.repeat(64);assert.throws(()=>approveProposal(path),/approval_digest/);
 const changed=JSON.parse(readFileSync(receipt));changed.operator.id++;writeFileSync(receipt,encode(changed));process.env.AWH_ADMIN_APPROVAL_SHA256=digest(readFileSync(receipt));
 assert.throws(()=>approveProposal(path),/approval/);
 f.activate();let calls=0;const blocked=()=>{calls++;throw Error('Provider or credentials must not be accessed');};
 await assert.rejects(connectBuilder({read:blocked,fetch:blocked,spawn:blocked,realpath:blocked,stat:blocked,cwd:blocked}));assert.equal(calls,0);
});
test('approved immutable versions retain history; explicit version selection never migrates to a newer grant',t=>{
 const f=fixture(t),one=f.prepare();f.pin(one);assert.equal(approveProposal(one).status,'APPROVED');f.activate();
 assert.equal(loadTrustedPolicy().profiles[0].workflows[0].version,'v1');
 const history=readFileSync(join(f.root,'v1.policy.json'));
 const two=f.prepare('v2');f.pin(two);approveProposal(two);
 assert.equal(loadTrustedPolicy().profiles[0].workflows[0].version,'v1');assert.deepEqual(readFileSync(join(f.root,'v1.policy.json')),history);
 assert.equal(inspectRegistry().entries.length,2);assert.equal(launcherDescriptor('v2').provider_scope,'NOTRUN');
 assert.throws(()=>approveProposal(two),/stale_approval|replayed_approval/);
});
test('expanded installation/repository set, unsupported checks and mismatched work item cannot be approved',t=>{
 const f=fixture(t),expanded=structuredClone(f.policy);expanded.installation.selected_repository_sets[0].push('example-org/extra');
 const path=f.prepare('expanded',expanded);f.pin(path);assert.throws(()=>approveProposal(path),/installation_or_expiry/);
 const bad=structuredClone(f.policy);bad.profiles[0].workflows[0].verification_commands=['node arbitrary-script.js'];
 assert.throws(()=>f.prepare('command',bad),/task_scope/);
 const wrong=structuredClone(f.policy);wrong.profiles[0].workflows[0].work_item.issue++;
 assert.throws(()=>f.prepare('wrong',wrong),/task_scope/);assert(!existsSync(join(f.root,'state.json')));
});
test('prefix template prepares a least-scope fixed task without changing source or accepting arbitrary branch/identity',t=>{
 const f=fixture(t),template=structuredClone(f.policy),workflow=template.profiles[0].workflows[0];workflow.branch_mode='issue_prefix';workflow.branch='codex/task-';workflow.work_item.issue=0;workflow.bootstrap_paths=['README.md'];
 const templateFile=f.file('template.json');writeFileSync(templateFile,encode(template),{mode:0o600});
 const task={...f.task,issue:90,branch:'codex/task-90'},out=f.file('prepared.json');
 prepareGrant(templateFile,'task90',task,out);
 const proposed=inspectProposal(out).proposal;assert.equal(proposed.task.issue,90);assert.equal(proposed.policy.profiles[0].workflows[0].branch_mode,'fixed');assert.equal(JSON.parse(readFileSync(templateFile)).profiles[0].workflows[0].work_item.issue,0);
 for(const changed of [{...task,branch:'codex/elsewhere'},{...task,executor_id:'unapproved'},{...task,machine_id:'wrong'}])assert.throws(()=>prepareGrant(templateFile,'wrong',changed,f.file('wrong.json')),/template_scope/);
});
test('revoke requires a separate pinned receipt; existing policy and approval bytes remain intact',async t=>{
 const f=fixture(t),path=f.prepare();f.pin(path);approveProposal(path);f.activate();const before=readFileSync(join(f.root,'v1.policy.json'));
 const revocation=f.file('revoke.json');prepareRevoke('revoke1','v1',revocation);assert.equal(managedContext().version,'v1');
 assert.throws(()=>approveProposal(revocation),/approval/);f.pin(revocation);assert.equal(approveProposal(revocation).status,'REVOKED');
 assert.deepEqual(readFileSync(join(f.root,'v1.policy.json')),before);assert.equal(inspectRegistry().entries[0].revoked,true);
 assert.throws(loadTrustedPolicy,/Administrator-approved/);assert.throws(()=>launcherDescriptor('v1'),/unapproved_or_revoked/);
 let calls=0;const forbidden=()=>{calls++;throw Error('Must fail before provider');};await assert.rejects(connectBuilder({read:forbidden,fetch:forbidden,spawn:forbidden,cwd:forbidden}));assert.equal(calls,0);
});
test('changed bytes/history, expired grants and a redirected trust root fail closed without falling back',t=>{
 const f=fixture(t),path=f.prepare();f.pin(path);approveProposal(path);f.activate();
 const policyPath=join(f.root,'v1.policy.json'),bytes=readFileSync(policyPath);writeFileSync(policyPath,Buffer.concat([bytes,Buffer.from(' ')]));
 assert.throws(loadTrustedPolicy);writeFileSync(policyPath,bytes);
 assert.throws(()=>managedContext(process.env,new Date(Date.now()+2*86400000).toISOString()),/task_expired/);
 const statePath=join(f.root,'state.1.json'),state=readFileSync(statePath);writeFileSync(statePath,Buffer.concat([state,Buffer.from(' ')]));assert.throws(loadTrustedPolicy);writeFileSync(statePath,state);
 const alias=f.file('alias');symlinkSync(f.root,alias,process.platform==='win32'?'junction':'dir');const trust=JSON.parse(readFileSync(f.trustFile));trust.registry_root=alias;
 writeFileSync(f.trustFile,encode(trust));process.env.AWH_ADMIN_TRUST_SHA256=digest(readFileSync(f.trustFile));assert.throws(loadTrustedPolicy);
});
test('concurrent independent approvals serialize: at most one generation becomes active, no replay overwrites history',async t=>{
 const f=fixture(t),first=f.prepare('one'),second=f.prepare('two');f.pin(first);const envOne={...process.env};f.pin(second);const envTwo={...process.env};
 const cli=resolve('dist/admin-cli.js');
 const launch=(path,env)=>{const child=spawn(process.execPath,[cli,'approve','--proposal',path,'--confirm'],{env,stdio:'ignore',windowsHide:true});return once(child,'exit').then(([code])=>code);};
 const results=await Promise.all([launch(first,envOne),launch(second,envTwo)]);assert.deepEqual([...results].sort(),[0,2]);assert.equal(inspectRegistry().generation,1);
 const names=readdirSync(f.root);assert.equal(names.filter(name=>name.endsWith('.policy.json')).length,1);
});
test('CLI strictly bounds arguments and emits inert proposal inspection; Issue/Client flags cannot inject authority',t=>{
 const f=fixture(t),path=f.prepare(),cli=resolve('dist/admin-cli.js');
 const run=args=>spawnSync(process.execPath,[cli,...args],{env:process.env,encoding:'utf8',windowsHide:true});
 assert.equal(run(['inspect','--proposal',path]).status,0);
 for(const args of [['approve','--proposal',path],['approve','--proposal',path,'--confirm','--token','personal'],['inspect','--proposal',path,'--proposal',path],['merge'],['diagnose','--confirm']])assert.equal(run(args).status,2);
 assert(!existsSync(join(f.root,'state.json')));
});
test('real CLI performs prepare/inspect/approval/launcher/revoke with synthetic external pins and retains history',t=>{
 const f=fixture(t),cli=resolve('dist/admin-cli.js'),template=f.file('template.json'),proposed=f.file('cli-proposal.json'),receipt=f.file('cli-receipt.json');
 const source=structuredClone(f.policy),workflow=source.profiles[0].workflows[0];workflow.branch_mode='issue_prefix';workflow.branch='codex/task-';workflow.work_item.issue=0;workflow.bootstrap_paths=['README.md'];
 writeFileSync(template,encode(source),{mode:0o600});
 const run=args=>{const result=spawnSync(process.execPath,[cli,...args],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 const task={...f.task,issue:90,branch:'codex/task-90'};
 assert.equal(run(['prepare','--template',template,'--profile',task.profile,'--workflow',task.workflow,'--repo',task.repository,'--issue','90','--branch',task.branch,'--base-sha',task.base_sha,'--head-sha',task.head_sha,'--executor',task.executor_id,'--machine',task.machine_id,'--expires-at',task.expires_at,'--version','cli-v1','--out',proposed]).status,'PROPOSED');
 assert.equal(run(['inspect','--proposal',proposed]).authority_verified,false);
 assert.equal(run(['approval-prepare','--proposal',proposed,'--receipt','cli-receipt','--reason','Synthetic CLI test','--out',receipt]).independent_administrator_pin_required,true);
 process.env.AWH_ADMIN_APPROVAL_FILE=receipt;process.env.AWH_ADMIN_APPROVAL_SHA256=digest(readFileSync(receipt));
 assert.equal(run(['approve','--proposal',proposed,'--confirm']).status,'APPROVED');
 assert.equal(run(['preflight','--version','cli-v1']).provider_scope,'NOTRUN');assert.equal(run(['launcher','--version','cli-v1']).task.head_sha,task.head_sha);
 const revoked=f.file('cli-revoke.json');run(['revoke','--version','cli-revocation','--target','cli-v1','--out',revoked]);f.pin(revoked);run(['approve','--proposal',revoked,'--confirm']);
 assert.equal(run(['inspect']).entries[0].revoked,true);assert.equal(run(['diagnose']).generation,2);
 const denied=spawnSync(process.execPath,[cli,'preflight','--version','cli-v1'],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(denied.status,2);
});
test('proposal comparison and crash diagnosis are read-only and preserve orphan evidence',t=>{
 const f=fixture(t),one=f.prepare(),two=f.prepare('v2');const changes=compareProposals(one,two);assert.equal(changes.authority_verified,false);assert(changes.changes.some(change=>change.field==='version'));
 writeFileSync(join(f.root,'orphan.policy.json'),'{}',{mode:0o600});
 const result=diagnoseRegistry();assert.equal(result.status,'BLOCKED');assert.deepEqual(result.orphan_records,['orphan.policy.json']);assert(existsSync(join(f.root,'orphan.policy.json')));
 assert(!existsSync(join(f.root,'state.json')));
});
test('administrator root is bound to the real OS host, not a Client-provided machine declaration',t=>{
 const f=fixture(t),trust=JSON.parse(readFileSync(f.trustFile));trust.host='different-host';writeFileSync(f.trustFile,encode(trust));process.env.AWH_ADMIN_TRUST_SHA256=digest(readFileSync(f.trustFile));
 assert.throws(()=>inspectRegistry(),/host_binding/);assert(!existsSync(join(f.root,'state.json')));
});

function fakeBuilder(f,overrides={}) {
 const root=resolve('.'),{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});let writeTokens=0,requests=0,keyReads=0;
 const task=f.task,app=f.policy.installation;
 const deps={env:{AWH_GITHUB_APP_ID:String(app.app_id),AWH_GITHUB_APP_PRIVATE_KEY_PATH:join(tmpdir(),'awh-synthetic-key.pem')},cwd:()=>root,realpath:async p=>resolve(p),
  stat:async p=>{if(resolve(p)===join(root,'.git'))return {isDirectory:()=>true,isFile:()=>false};throw Object.assign(Error(),{code:'ENOENT'});},
  read:async()=>{keyReads++;return privateKey.export({type:'pkcs8',format:'pem'});},
  spawn:(_file,args)=>{let stdout='';if(args[0]==='rev-parse')stdout=args[1]==='HEAD'?(overrides.head??task.head_sha):root;else if(args[0]==='config')stdout=`https://github.com/${task.repository}.git`;else if(args[0]==='branch')stdout=task.branch;return {status:0,stdout,stderr:''};},
  fetch:async(url,options)=>{requests++;let data;
   if(url.endsWith('/app'))data={id:app.app_id,slug:app.app_slug};
   else if(url.endsWith('/installation'))data={id:app.installation_id,app_id:app.app_id,account:{login:app.account_login},repository_selection:'selected',suspended_at:null,permissions:{contents:'write',issues:'write',pull_requests:'write',metadata:'read'}};
   else if(url.endsWith('/access_tokens')){const body=JSON.parse(options.body);if(Object.values(body.permissions).includes('write'))writeTokens++;data={token:'synthetic-secret-'+requests,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{...body.permissions,metadata:'read'},repositories:(body.repositories?[task.repository]:app.selected_repository_sets[0]).map(full_name=>({full_name}))};}
   else if(url.includes('/installation/repositories'))data={total_count:app.selected_repository_sets[0].length,repositories:app.selected_repository_sets[0].map(full_name=>({full_name}))};
   else if(url.endsWith('/git/ref/heads/main'))data={object:{sha:overrides.base??task.base_sha}};
   else if(url.endsWith('/issues/'+task.issue))data={number:task.issue,state:'open',html_url:`https://github.com/${task.repository}/issues/${task.issue}`};
   else throw Error('Unexpected synthetic request');
   return new Response(JSON.stringify(data));
  }};
 return {deps,counts:()=>({writeTokens,requests,keyReads})};
}
test('Builder checks exact clean HEAD and identities before keys; remote base before writes; revocation stops an already connected Builder',async t=>{
 const f=fixture(t),path=f.prepare();f.pin(path);approveProposal(path);f.activate();
 for(const field of ['AWH_ADMIN_EXECUTOR_ID','AWH_ADMIN_MACHINE_ID']){const saved=process.env[field];process.env[field]='wrong';const fake=fakeBuilder(f);await assert.rejects(connectBuilder(fake.deps));assert.equal(fake.counts().keyReads,0);process.env[field]=saved;}
 const wrongHead=fakeBuilder(f,{head:'c'.repeat(40)});await assert.rejects(connectBuilder(wrongHead.deps),/exact clean/);assert.equal(wrongHead.counts().keyReads,0);
 const wrongBase=fakeBuilder(f,{base:'c'.repeat(40)});await assert.rejects(connectBuilder(wrongBase.deps),/remote base/);assert.equal(wrongBase.counts().writeTokens,0);
 const fake=fakeBuilder(f),builder=await connectBuilder(fake.deps);assert.equal(builder.preflight().repo,f.task.repository);
 const before=fake.counts().requests,revocation=f.file('revoke.json');prepareRevoke('revoke1','v1',revocation);f.pin(revocation);approveProposal(revocation);
 await assert.rejects(builder.push(),/revoked/);assert.equal(fake.counts().requests,before);
 assert.throws(()=>builder.preflight(),/revoked/);
});
