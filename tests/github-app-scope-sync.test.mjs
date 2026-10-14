import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {dashboardAppFixture} from './helpers/github-app-dashboard-fixture.mjs';
import {createGithubAppManagement} from '../dist/dashboard/github-app-management.js';

async function fixture(t, confirm=async()=>true) {
 const directory=mkdtempSync(join(tmpdir(),'awh-scope-sync-'));
 t.after(()=>{assert.equal(dirname(directory),tmpdir());assert(basename(directory).startsWith('awh-scope-sync-'));rmSync(directory,{recursive:true,force:true});});
 const f=dashboardAppFixture(directory);
 await f.app.connect({...f.input,repositories:f.repositories.map(r=>r.full_name)},true);
 const saved=readFileSync(f.configPath,'utf8'),binding=f.app.binding(f.repositories[0].full_name);
 let clock=Date.now();const service=createGithubAppManagement({app:f.app,confirm,now:()=>clock});t.after(()=>service.close());
 const call=(action,data={},session='owner',authorized=()=>true)=>service.handle(action,data,session,service.read(session).csrf,new AbortController().signal,authorized);
 return {...f,directory,saved,binding,service,call,advance(ms){clock+=ms;}};
}
const noWrites=f=>assert(f.calls.every(c=>c.method==='GET'||c.path.endsWith('/access_tokens')&&!Object.values(c.body.permissions).includes('write')));

test('actual scope refresh is metadata-only; native-confirmed addition persists, keeps identity and retained queue binding, restarts safely',async t=>{
 let request;const f=await fixture(t,async value=>{request=value;return true;});
 f.repositories.push({id:90,full_name:'synthetic-org/new-project'});
 await assert.rejects(f.app.preflight(f.binding.repository),e=>e.reason==='scope_drift');
 const refreshed=await f.call('refresh-scope');
 assert.equal(refreshed.status,'SCOPE_CHANGED');assert.equal(refreshed.scope_change.added[0].id,90);
 assert.equal(readFileSync(f.configPath,'utf8'),f.saved);assert(!JSON.stringify(refreshed).includes(f.key));assert(!JSON.stringify(refreshed).includes('ghs_'));
 const synced=await f.call('sync-scope',{proposal_id:refreshed.scope_change.proposal_id});
 assert.equal(synced.status,'SCOPE_SYNCED');assert.deepEqual(request.facts.repositories,f.repositories);assert.equal(request.kind,'github_app_connection');
 const old=JSON.parse(f.saved),updated=JSON.parse(readFileSync(f.configPath));
 assert.deepEqual({...updated,repositories:old.repositories},old);assert.deepEqual(f.app.binding(f.binding.repository),f.binding);
 assert.deepEqual((await f.app.preflight(f.binding.repository)).binding,f.binding);assert.equal(f.app.binding('synthetic-org/new-project').repository_id,90);
 const backup=readdirSync(f.directory).find(n=>n.includes('.backup-'));assert.deepEqual(JSON.parse(readFileSync(join(f.directory,backup))),old);
 const restarted=createGithubAppManagement({app:f.app,confirm:async()=>true});assert.equal(restarted.read('restart').repositories.length,3);restarted.close();noWrites(f);
});
test('removing the original inspection repository still synchronizes by installation; revoked repository cannot deliver',async t=>{
 const f=await fixture(t);const removed=f.repositories.shift();
 const refreshed=await f.call('refresh-scope');assert.deepEqual(refreshed.scope_change.removed,[removed]);
 await f.call('sync-scope',{proposal_id:refreshed.scope_change.proposal_id});
 await assert.rejects(f.app.preflight(removed.full_name));assert.equal(f.app.binding(f.repositories[0].full_name).repository_id,43);noWrites(f);
});
test('cancelled native confirmation, replay and browser scope injection preserve the original connection',async t=>{
 const f=await fixture(t,async()=>false);f.repositories.push({id:90,full_name:'synthetic-org/new-project'});
 const refreshed=await f.call('refresh-scope'),data={proposal_id:refreshed.scope_change.proposal_id};
 await assert.rejects(f.call('sync-scope',{...data,confirm:true}),e=>e.code==='app_input');
 assert.equal((await f.call('sync-scope',data)).problem.code,'owner_cancelled');
 await assert.rejects(f.call('sync-scope',data),e=>e.code==='app_detection_expired');assert.equal(readFileSync(f.configPath,'utf8'),f.saved);noWrites(f);
});
test('scope proposal is session-bound, expires, and cannot save after authorization disappears',async t=>{
 const f=await fixture(t);f.repositories.push({id:90,full_name:'synthetic-org/new-project'});
 let result=await f.call('refresh-scope'),data={proposal_id:result.scope_change.proposal_id};
 await assert.rejects(f.call('sync-scope',data,'another-session'),e=>e.code==='app_detection_expired');
 result=await f.call('refresh-scope');f.advance(300001);
 await assert.rejects(f.call('sync-scope',{proposal_id:result.scope_change.proposal_id}),e=>e.code==='app_detection_expired');
 result=await f.call('refresh-scope');assert.equal((await f.call('sync-scope',{proposal_id:result.scope_change.proposal_id},'owner',()=>false)).problem.code,'operation_cancelled');
 assert.equal(readFileSync(f.configPath,'utf8'),f.saved);noWrites(f);
});
test('scope or local identity changes while native confirmation is pending cannot replace the saved connection',async t=>{
 for(const change of ['remote','local']){
  let f;f=await fixture(t,async()=>{if(change==='remote')f.repositories.push({id:91,full_name:'synthetic-org/changed-again'});else {const c=JSON.parse(f.saved);c.reviewer.id=99;writeFileSync(f.configPath,JSON.stringify(c));}return true;});
  f.repositories.push({id:90,full_name:'synthetic-org/new-project'});const result=await f.call('refresh-scope');
  const blocked=await f.call('sync-scope',{proposal_id:result.scope_change.proposal_id});assert.equal(blocked.status,'BLOCKED');
  assert.equal(blocked.problem.code,change==='remote'?'scope_drift':'identity_drift');
  assert.equal(JSON.parse(readFileSync(f.configPath)).repositories.length,2);noWrites(f);
 }
});
test('partial, all-repository, suspended/invalid identity and network inspections cannot propose or save scope',async t=>{
 const f=await fixture(t);for(const mode of ['scope','all','permissions','identity','bot','reviewer','network']){
  f.setMode(mode);const result=await f.call('refresh-scope');assert.equal(result.status,'BLOCKED');assert.equal(result.scope_change,undefined);assert.equal(readFileSync(f.configPath,'utf8'),f.saved);
 }noWrites(f);
});
test('unchanged scope needs no native confirmation and a plain Viewer cannot invoke scope actions',async t=>{
 let confirmations=0;const f=await fixture(t,async()=>{confirmations++;return true;});
 assert.equal((await f.call('refresh-scope')).status,'SCOPE_CURRENT');assert.equal(confirmations,0);assert.equal(readFileSync(f.configPath,'utf8'),f.saved);
 const plain=createGithubAppManagement({app:f.app});await assert.rejects(plain.handle('refresh-scope',{},'s',plain.read('s').csrf,new AbortController().signal),e=>e.code==='app_owner_unavailable');plain.close();noWrites(f);
});
