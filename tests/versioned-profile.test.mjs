import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadApprovedWorkItem,versionedPreflight,approvedRevisionDiff,declareDevelop,reportDevelop,policyFingerprint } from '../dist/client/versioned-profile.js';
import { formatPreflight } from '../dist/shared/preflight.js';
import { deliveryPolicy } from '../dist/client/delivery-policy.js';
import { selectWorkflow,DEFAULT_SELECTION } from '../dist/profiles.js';
import { facts,trustedFixture } from './versioned-profile-fixture.mjs';
const now='2026-10-09T12:00:00.000Z';
function temp(t){const p=mkdtempSync(join(tmpdir(),'awh-policy-'));t.after(()=>{assert.equal(dirname(p),tmpdir());assert(p.startsWith(join(tmpdir(),'awh-policy-')));rmSync(p,{recursive:true,force:true});});return p;}
const load=(f,time=now)=>loadApprovedWorkItem(f.path,f.selection,time);
const refused=(fn,code)=>assert.throws(fn,e=>e.code===code);
test('new approved business Work Item has no fixed source mapping; immutable Observe and Develop declarations grant no delivery',t=>{
  const f=trustedFixture(temp(t)),a=load(f),p=versionedPreflight(a,facts);assert.equal(p.status,'passed');assert.equal(p.provider_scope,'not_checked');assert.equal(p.deliver,'blocked');assert.equal(p.authority_verified,false);assert(formatPreflight(p).includes('issue: approved=901'));
  assert.throws(()=>selectWorkflow({profile:'hub',workflow:'fixture-business'}));assert.throws(()=>deliveryPolicy(facts.profile_ref,'v1'));assert.deepEqual(DEFAULT_SELECTION,{profile:'hub',workflow:'c05'});
  assert(Object.isFrozen(a.work_item.checks));assert.throws(()=>{a.work_item.issue=902;});
  const r=declareDevelop(a,facts,{id:'run-fixture',source_sha:'a'.repeat(40)},now);
  const s=reportDevelop(a,r,{sequence:1,type:'started',checks:[]},now);
  const c=reportDevelop(a,s,{sequence:2,type:'checks_reported',checks:facts.checks.map(command=>({command,exit_code:0}))},now);
  const done=reportDevelop(a,c,{sequence:3,type:'completed',checks:[]},now);assert.equal(done.events.length,3);assert.equal(r.events.length,0);assert.equal(done.execution,'declarations_only');
});
test('one-time c1k code publication remains fixed Hub scope; historical defaults and profiles retain bindings',()=>{
  const chosen=selectWorkflow({profile:'hub',workflow:'c1k'});assert.equal(chosen.profile.repository,'zlpoot/agent-workflow-hub');assert.equal(chosen.profile.base,'main');
  assert.deepEqual(chosen.workflow,{id:'c1k',branch:'codex/c1k-versioned-profile-prototype',work_item:{repo:'zlpoot/agent-workflow-hub',issue:34},verification_commands:['pnpm build','node --test tests/versioned-profile.test.mjs','node --test tests/doctor.test.mjs'],bootstrap_paths:null});
  for(const [workflow,issue] of [['c1h',31],['c1h-b0',31],['c1i',32]])assert.equal(selectWorkflow({profile:'hub',workflow}).workflow.work_item.issue,issue);
  assert.equal(selectWorkflow().workflow.id,'c05');assert.equal(selectWorkflow({profile:'future-ui',workflow:'bootstrap'}).workflow.branch,'codex/awh-c06-bootstrap');assert.equal(selectWorkflow({profile:'webskill',workflow:'bootstrap'}).workflow.branch,'codex/awh-c07-webskill-bootstrap');
  assert.throws(()=>selectWorkflow({profile:'hub',workflow:'c1k',repo:'zlpoot/other'}));assert.throws(()=>deliveryPolicy('hub/c1k'));
});
test('every binding difference is visible and Develop refuses all wrong or incomplete declarations',t=>{
  const a=load(trustedFixture(temp(t)));
  const wrong={repository:'zlpoot/other',issue_repository:'zlpoot/other',issue:902,base:'release',branch:'codex/wrong',executor:'other-executor',checks:[...facts.checks].reverse(),profile_ref:'hub/other',profile_version:'v2',work_item_version:'v2'};
  for(const [field,value] of Object.entries(wrong)){const observed={...facts,[field]:value},p=versionedPreflight(a,observed);assert.equal(p.status,'blocked');assert.equal(p.differences.find(d=>d.field===field).status,'blocked');refused(()=>declareDevelop(a,observed,{id:'run',source_sha:'a'.repeat(40)},now),'binding');}
  assert.equal(versionedPreflight(a,{}).status,'not_checked');refused(()=>declareDevelop(a,{}, {id:'run',source_sha:'a'.repeat(40)},now),'binding');refused(()=>versionedPreflight(a,facts,'deliver',now),'stage');
});
test('catalog byte tampering and unapproved revisions cannot self-authorize even with recomputed file pins',t=>{
  const dir=temp(t),f=trustedFixture(dir);writeFileSync(join(dir,'profiles.json'),readFileSync(join(dir,'profiles.json'),'utf8')+' ');refused(()=>load(f),'source_fingerprint');
  const changed=trustedFixture(dir,({catalog})=>{catalog.work_items[0].issue=999;});refused(()=>load(changed),'unapproved_version');
  const revision=trustedFixture(dir,({catalog})=>{catalog.work_items[0].work_item_version='v2';});refused(()=>load(revision),'unapproved_version');
  const unapproved=trustedFixture(dir);refused(()=>loadApprovedWorkItem(unapproved.path,{id:'business-901',version:'v9'},now),'unapproved_version');
});
test('duplicate/conflicting versions and wrong approval actor/source are closed failures',t=>{
  const dir=temp(t);
  for(const mutation of [({catalog})=>catalog.profiles.push({...catalog.profiles[0]}),({catalog})=>catalog.work_items.push({...catalog.work_items[0]}),({approvals})=>approvals.entries.push({...approvals.entries[0]})])refused(()=>load(trustedFixture(dir,mutation)),'duplicate_version');
  for(const field of ['operator','source'])refused(()=>load(trustedFixture(dir,({approvals})=>{approvals.entries[1][field]='untrusted';})),'approval_source');
  refused(()=>load(trustedFixture(dir,({approvals,approval,catalog})=>approvals.entries.push(approval('work_item','unused','v1',catalog.work_items[0])))),'approval_conflict');
});
test('Work Item is narrowed by template; expanded branch/repo/executor/check/stage cannot use work-item approval alone',t=>{
  const dir=temp(t);
  for(const patch of [{repository:'zlpoot/other'},{base:'other'},{branch:'feature/other'},{executor:'other'},{checks:['pnpm arbitrary']}]){
    refused(()=>load(trustedFixture(dir,({catalog,approvals})=>{Object.assign(catalog.work_items[0],patch);approvals.entries[1].fingerprint=policyFingerprint(catalog.work_items[0]);})),'template_scope');
  }
  refused(()=>load(trustedFixture(dir,({catalog,approvals})=>{catalog.profiles[0].stages=['observe'];approvals.entries[0].fingerprint=policyFingerprint(catalog.profiles[0]);})),'template_scope');
  const a=load(trustedFixture(dir,({catalog,approvals})=>{catalog.work_items[0].stages=['observe'];approvals.entries[1].fingerprint=policyFingerprint(catalog.work_items[0]);}));refused(()=>declareDevelop(a,facts,{id:'run',source_sha:'a'.repeat(40)},now),'stage');
});
test('closed DTOs, expiry and invalid clock fail without disclosing input; no forged loaded snapshot',t=>{
  const dir=temp(t),f=trustedFixture(dir),a=load(f);
  refused(()=>load(f,'2100-01-01T00:00:00.000Z'),'expired');refused(()=>load(f,'invalid'),'schema');refused(()=>versionedPreflight({...a},facts),'untrusted_source');
  refused(()=>versionedPreflight(a,{...facts,url:'https://example.invalid'}),'schema');
  refused(()=>load(trustedFixture(dir,({catalog})=>{catalog.profiles[0].shell='bad';})),'schema');
  refused(()=>versionedPreflight(a,{checks:['awh_cp_'+'X'.repeat(43)]}),'credential_data');
});
test('external source guard rejects project files and symlinked policy files',t=>{
  const dir=temp(t),project=join(dir,'project');mkdirSync(project);mkdirSync(join(project,'.git'));const f=trustedFixture(project);refused(()=>load(f),'untrusted_source');
  const outside=join(dir,'outside');mkdirSync(outside);trustedFixture(outside);const alias=join(dir,'redirected');
  symlinkSync(outside,alias,process.platform==='win32'?'junction':'dir');refused(()=>loadApprovedWorkItem(join(alias,'trust.json'),f.selection,now),'untrusted_source');
});
test('historical Run keeps old immutable policy; new approved version does not rewrite it or accept its reports',t=>{
  const dir=temp(t),a=load(trustedFixture(dir)),r=declareDevelop(a,facts,{id:'old-run',source_sha:'b'.repeat(40)},now);
  const f=trustedFixture(dir,({catalog,approvals,approval})=>{const old=catalog.work_items[0],next={...old,work_item_version:'v2',issue:902,branch:'codex/new-business-902'};catalog.work_items.push(next);approvals.entries.push({...approval('work_item',next.id,'v2',next),supersedes:policyFingerprint(old)});});
  const b=loadApprovedWorkItem(f.path,{id:'business-901',version:'v2'},now);assert.equal(r.binding.issue,901);assert.equal(b.work_item.issue,902);
  const diff=approvedRevisionDiff(a,b,now);assert.deepEqual(diff.changes.map(d=>d.field),['issue','branch','work_item_version']);assert.equal(diff.next_approval.supersedes,a.fingerprint);assert.equal(diff.approval_action,'none');assert.equal(diff.authority_verified,false);
  refused(()=>reportDevelop(b,r,{sequence:1,type:'started',checks:[]},now),'binding');assert.equal(reportDevelop(a,r,{sequence:1,type:'started',checks:[]},now).binding.work_item_version,'v1');assert.equal(load(f).work_item.issue,901);
});
test('same operator trust path cannot reuse a loaded version with new policy or approval bytes',t=>{
  const dir=temp(t);load(trustedFixture(dir));
  const edited=trustedFixture(dir,({catalog,approvals})=>{catalog.work_items[0].issue=902;approvals.entries[1].fingerprint=policyFingerprint(catalog.work_items[0]);});refused(()=>load(edited),'version_conflict');
  const reason=trustedFixture(dir,({approvals})=>{approvals.entries[1].reason='Changed approval under reused version';});refused(()=>load(reason),'version_conflict');
});
test('Run/Event reports reject unknown payload, arbitrary checks, sequence/replay and claimed success after failed checks',t=>{
  const a=load(trustedFixture(temp(t))),r=declareDevelop(a,facts,{id:'run',source_sha:'a'.repeat(40)},now),start={sequence:1,type:'started',checks:[]};
  refused(()=>reportDevelop(a,r,{...start,shell:'do not run'},now),'schema');refused(()=>reportDevelop(a,r,{...start,sequence:2},now),'event');
  const s=reportDevelop(a,r,start,now);refused(()=>reportDevelop(a,s,start,now),'event');
  refused(()=>reportDevelop(a,s,{sequence:2,type:'checks_reported',checks:[{command:'pnpm arbitrary',exit_code:0}]},now),'event_checks');
  const c=reportDevelop(a,s,{sequence:2,type:'checks_reported',checks:facts.checks.map(command=>({command,exit_code:1}))},now);refused(()=>reportDevelop(a,c,{sequence:3,type:'completed',checks:[]},now),'event_outcome');
  assert.equal(reportDevelop(a,c,{sequence:3,type:'failed',checks:[]},now).events.length,3);
  refused(()=>reportDevelop(a,{...r,work_item_fingerprint:'c'.repeat(64)},start,now),'run_binding');
});
