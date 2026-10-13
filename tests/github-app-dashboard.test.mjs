import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createGithubAppManagement, appInput } from '../dist/dashboard/github-app-management.js';
import { GithubAppError } from '../dist/workflow/github-app.js';
import { dashboardAppFixture } from './helpers/github-app-dashboard-fixture.mjs';
import { createDashboardGateway } from '../dist/dashboard/gateway.js';
import { fixtureStore } from './store-fixture.mjs';
import { request as httpRequest } from 'node:http';

function fixture(t, count=2) {
  const directory = mkdtempSync(join(tmpdir(), 'awh-app-dashboard-'));
  t.after(() => { assert.equal(dirname(directory),tmpdir());assert(basename(directory).startsWith('awh-app-dashboard-'));rmSync(directory,{recursive:true,force:true}); });
  return dashboardAppFixture(directory,count);
}
const noWrites = f => assert(f.calls.every(c => c.method === 'GET' || c.method === 'POST' && c.path.endsWith('/access_tokens') && !Object.values(c.body.permissions).includes('write')));
const signal = () => new AbortController().signal;
const denied = code => e => e.code === code;
test('Provider discovers the entire selected set and real actor/account shapes without credential return', async t => {
  const f=fixture(t,101), result=await f.app.detect(f.input);
  assert.equal(result.installations[0].status,'DETECTED');assert.equal(result.installations[0].facts.repositories.length,101);
  assert.equal(result.installations[0].facts.account.id,20);assert.equal(result.installations[0].facts.delivery_actor.type,'Bot');assert.equal(result.installations[0].facts.reviewer.type,'User');
  assert(!JSON.stringify(result).includes('ghs_'));assert(!JSON.stringify(result).includes('PRIVATE KEY'));assert(!JSON.stringify(result).includes(f.key));assert(!existsSync(f.configPath));noWrites(f);
});
test('Detection reports installation problems and refuses missing installations', async t => {
  const f=fixture(t);
  for(const [mode,reason] of [['all','all_repositories'],['permissions','permissions_insufficient']]) {f.setMode(mode);const r=await f.app.detect(f.input);assert.equal(r.installations[0].reason,reason);}
  f.setMode('not-installed');await assert.rejects(f.app.detect(f.input),e=>e instanceof GithubAppError&&e.reason==='not_installed');noWrites(f);
});
test('Multiple installations keep blocked accounts separate from a complete selectable installation', async t => {
  const f=fixture(t);f.setMode('mixed');const r=await f.app.detect(f.input);
  assert.equal(r.installations.length,2);assert.equal(r.installations[0].reason,'all_repositories');assert.equal(r.installations[1].facts.installation_id,9);
  assert.deepEqual(r.installations[1].facts.repositories,f.repositories);assert(!f.calls.some(c=>c.path==='/app/installations/8/access_tokens'));noWrites(f);
});
test('Owner-reviewed facts are pinned across connect; drift never saves configuration', async t => {
  const f=fixture(t), detection=await f.app.detect(f.input), facts=detection.installations[0].facts;
  f.setMode('reviewer');await assert.rejects(f.app.connect({...f.input,repositories:f.repositories.map(r=>r.full_name)},true,facts),e=>e.reason==='identity_drift');
  assert(!existsSync(f.configPath));noWrites(f);
});
test('Saving checks current session/cancellation after GitHub inspection and before the exact file write', async t => {
  const f=fixture(t),facts=(await f.app.detect(f.input)).installations[0].facts;
  await assert.rejects(f.app.connect({...f.input,repositories:f.repositories.map(r=>r.full_name)},true,facts,signal(),()=>false),e=>e.reason==='operation_cancelled');assert(!existsSync(f.configPath));noWrites(f);
});
test('Request whitelist rejects browser confirmation, repository injection, bad IDs and relative paths', () => {
  const valid={app_id:5,app_slug:'synthetic-builder',private_key_path:'C:\\OwnerSecrets\\app.pem',reviewer:'synthetic-owner'};
  for(const patch of [{confirm:true},{repositories:['other/repo']},{app_id:1.5},{app_id:'5'},{private_key_path:'../key.pem'},{private_key_path:'\\\\host\\share\\key.pem'},{app_slug:'bad/slug'},{reviewer:'owner[bot]'}]) assert.throws(()=>appInput({...valid,...patch}),denied('app_input'));
  assert.deepEqual(appInput(valid),valid);
});
test('Ordinary Viewer has local status but cannot mutate even with a fresh CSRF', async t => {
  const f=fixture(t), service=createGithubAppManagement({app:f.app});
  const local=service.read('session');assert.equal(local.status,'NOT_CONNECTED');assert.equal(local.management_enabled,false);
  await assert.rejects(service.handle('detect',f.input,'session',local.csrf,signal()),denied('app_owner_unavailable'));assert.equal(f.calls.length,0);service.close();
});
test('Native Owner cancellation consumes detection and prevents browser replay', {skip:process.platform!=='win32'}, async t => {
  const f=fixture(t), requests=[], service=createGithubAppManagement({app:f.app,confirm:async request=>{requests.push(request);return false;},fixture:true});
  const detected=await service.handle('detect',f.input,'session',service.read('session').csrf,signal());
  const selection={detection_id:detected.detection_id,installation_id:9,repository:f.repositories[0].full_name};
  const token=service.read('session').csrf,result=await service.handle('connect',selection,'session',token,signal());
  assert.equal(result.problem.code,'owner_cancelled');assert.equal(requests[0].kind,'github_app_connection');assert.deepEqual(requests[0].facts.repositories,f.repositories);assert(!existsSync(f.configPath));
  await assert.rejects(service.handle('connect',selection,'session',token,signal()),denied('app_csrf'));
  await assert.rejects(service.handle('connect',selection,'session',service.read('session').csrf,signal()),denied('app_detection_expired'));service.close();noWrites(f);
});
test('Confirmed connect saves once, automatically preflights, then survives service restart as local state', {skip:process.platform!=='win32'}, async t => {
  const f=fixture(t), service=createGithubAppManagement({app:f.app,confirm:async()=>true,fixture:true});
  const detected=await service.handle('detect',f.input,'session',service.read('session').csrf,signal());
  const result=await service.handle('connect',{detection_id:detected.detection_id,installation_id:9,repository:f.repositories[0].full_name},'session',service.read('session').csrf,signal());
  assert.equal(result.status,'PREFLIGHT_PASS');assert.equal(result.saved,true);assert.equal(result.fixture,true);assert.equal(result.binding.reviewer.id,11);
  const saved=readFileSync(f.configPath,'utf8');assert(!saved.includes('PRIVATE KEY'));assert(!saved.includes('ghs_'));
  service.close();const restarted=createGithubAppManagement({app:f.app,confirm:async()=>true});assert.equal(restarted.read('new-session').status,'CONNECTED_LOCAL');
  f.setMode('permissions');const blocked=await restarted.handle('preflight',{repository:f.repositories[0].full_name},'new-session',restarted.read('new-session').csrf,signal());
  assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.problem.code,'permissions_insufficient');assert.equal(blocked.connection_status,'CONNECTED_LOCAL');assert.equal(readFileSync(f.configPath,'utf8'),saved);restarted.close();noWrites(f);
});
test('CSRF is consumed once, session-bound and time-bound; duplicate operations cannot race', {skip:process.platform!=='win32'}, async t => {
  const f=fixture(t);let clock=Date.now(), release;const confirmation=new Promise(r=>release=r);
  const service=createGithubAppManagement({app:f.app,now:()=>clock,confirm:()=>confirmation});
  const token=service.read('A').csrf;await assert.rejects(service.handle('detect',f.input,'B',token,signal()),denied('app_csrf'));
  const detected=await service.handle('detect',f.input,'A',token,signal());await assert.rejects(service.handle('detect',f.input,'A',token,signal()),denied('app_csrf'));
  const data={detection_id:detected.detection_id,installation_id:9,repository:f.repositories[0].full_name};
  const first=service.handle('connect',data,'A',service.read('A').csrf,signal());
  await assert.rejects(service.handle('connect',data,'A',service.read('A').csrf,signal()),denied('app_busy'));release(false);await first;
  const expired=service.read('A').csrf;clock+=300001;await assert.rejects(service.handle('detect',f.input,'A',expired,signal()),denied('app_csrf'));service.close();
});
test('Illegal Git paths and network errors fail closed without disclosing key/HTTP diagnostics', async t => {
  const f=fixture(t);
  await assert.rejects(f.app.detect({...f.input,private_key_path:join(process.cwd(),'package.json')}),e=>e.reason==='invalid_key'||e.reason==='unsafe_key_path');
  f.setMode('network');await assert.rejects(f.app.detect(f.input),e=>e.reason==='network_error'&&!e.message.includes('diagnostic'));assert(!existsSync(f.configPath));
});
test('Loopback gateway guards App endpoints with local cookie, strict same-origin and CSRF; ordinary remote REST stays read-only', async t => {
  const profile=JSON.parse(readFileSync(new URL('../examples/protocol/project-alpha.json',import.meta.url))).profile_policy;
  const f=fixture(t), store=fixtureStore(':memory:',[profile]), service=createGithubAppManagement({app:f.app});
  const gateway=createDashboardGateway({enabled:true,store,assets:'dist/dashboard-ui',localBrowserViewer:{id:'fixture-viewer',project_ids:[]},githubApp:service});
  await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));t.after(async()=>{await gateway.close();store.close();});
  const port=gateway.server.address().port, origin=`http://127.0.0.1:${port}`;
  const send=(path,method='GET',headers={},body)=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path,method,headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:text?JSON.parse(text.startsWith('{')?text:'{}'):null}));});req.on('error',reject);req.end(body);
  });
  assert.equal((await send('/dashboard/github-app/v1/status')).status,401);
  const doc=await send('/dashboard','GET',{'sec-fetch-dest':'document','sec-fetch-mode':'navigate','sec-fetch-site':'none'}), cookie=doc.headers['set-cookie'][0].split(';')[0];
  const local=await send('/dashboard/github-app/v1/status','GET',{cookie});assert.equal(local.body.item.status,'NOT_CONNECTED');
  const common={cookie,origin,'sec-fetch-site':'same-origin','content-type':'application/json','x-awh-csrf':local.body.item.csrf};
  assert.equal((await send('/dashboard/github-app/v1/connect','POST',common,'{}')).status,403);
  assert.equal((await send('/dashboard/github-app/v1/detect','POST',{...common,origin:'https://evil.invalid'},'{}')).status,401);
  assert.equal((await send('/dashboard/github-app/v1/detect','POST',{...common,'x-awh-csrf':''},'{}')).status,403);
  assert.equal((await send('/dashboard/v1/projects','POST',common,'{}')).status,405);
  assert.equal(f.calls.length,0);
});
test('Opt-in gateway rejects API passthrough, extra confirmation/scope fields, replay, malformed/oversized input and expired sessions', {skip:process.platform!=='win32'}, async t=>{
  const profile=JSON.parse(readFileSync(new URL('../examples/protocol/project-alpha.json',import.meta.url))).profile_policy;
  const f=fixture(t),store=fixtureStore(':memory:',[profile]);let clock=Date.now();
  const service=createGithubAppManagement({app:f.app,now:()=>clock,confirm:async()=>true});
  const gateway=createDashboardGateway({enabled:true,store,assets:'dist/dashboard-ui',localBrowserViewer:{id:'fixture-viewer',project_ids:[]},githubApp:service,now:()=>clock});
  await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));t.after(async()=>{await gateway.close();store.close();});const origin=`http://127.0.0.1:${gateway.server.address().port}`;
  const cookie=await new Promise((resolve,reject)=>{const request=httpRequest(origin+'/dashboard',{headers:{'sec-fetch-dest':'document','sec-fetch-mode':'navigate','sec-fetch-site':'none'}},response=>{response.resume();response.once('end',()=>resolve(response.headers['set-cookie'][0].split(';')[0]));});request.once('error',reject);request.end();});
  const headers={cookie,origin,'sec-fetch-site':'same-origin','content-type':'application/json'};
  const grant=async()=>{const r=await fetch(origin+'/dashboard/github-app/v1/status',{headers:{cookie}});return (await r.json()).item.csrf;};
  const post=(action,body,token)=>fetch(origin+'/dashboard/github-app/v1/'+action,{method:'POST',headers:{...headers,'x-awh-csrf':token},body:typeof body==='string'?body:JSON.stringify(body)});
  let token=await grant();let response=await post('detect',{...f.input,confirm:true},token);assert.equal(response.status,400);assert.equal(f.calls.length,0);
  assert.equal((await post('detect',f.input,token)).status,403);
  assert.equal((await post('api',{},await grant())).status,404);
  assert.equal((await post('detect','{',await grant())).status,400);
  assert.equal((await post('detect',JSON.stringify({padding:'x'.repeat(5000)}),await grant())).status,413);
  token=await grant();response=await post('detect',f.input,token);assert.equal(response.status,200);const detected=(await response.json()).item;
  response=await post('connect',{detection_id:detected.detection_id,installation_id:9,repository:'other/repo'},await grant());assert.equal(response.status,400);assert(!existsSync(f.configPath));
  response=await post('detect',f.input,await grant());const next=(await response.json()).item;const selection={detection_id:next.detection_id,installation_id:9,repository:f.repositories[0].full_name};
  token=await grant();clock+=3600001;assert.equal((await post('connect',selection,token)).status,401);assert(!existsSync(f.configPath));noWrites(f);
});
