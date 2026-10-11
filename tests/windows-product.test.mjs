import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AwhClient } from '../dist/client/client.js';
import { CLIENT_VERSION } from '../dist/client/version.js';
import { initManifest, inspectRepository } from '../dist/client/local.js';
import { startResident, residentControl } from '../dist/client/resident.js';
import { createControlPlaneServer, createAuthenticator, ControlPlaneStore } from '../dist/control-plane/index.js';
import { createDashboardGateway } from '../dist/dashboard/gateway.js';
import { createLocalOnboarding } from '../dist/dashboard/onboarding.js';
import { readViewerConfig } from '../dist/dashboard-cli.js';
import { wizardModel } from '../dashboard/wizard-model.mjs';
import { diagnosisContract, matchLocalBinding } from '../dashboard/onboarding.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(k)));
function git(cwd, args) { const r=spawnSync('git',['-c','commit.gpgsign=false','-c','core.hooksPath='+ (process.platform==='win32'?'NUL':'/dev/null'),...args],
  {cwd,env:{...env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8',windowsHide:true}); assert.equal(r.status,0,'Fixture Git failed');return r.stdout.trim(); }
async function setup(t) {
  const base=mkdtempSync(join(tmpdir(),'awh-windows-product-')),repo=join(base,'consumer');mkdirSync(repo);
  git(repo,['init','-b','codex/awh-c07-webskill-bootstrap']);git(repo,['config','user.name','Fixture']);git(repo,['config','user.email','fixture@example.invalid']);
  git(repo,['remote','add','origin','https://github.com/zlpoot/webskill.git']);writeFileSync(join(repo,'fixture.txt'),'unchanged');git(repo,['add','.']);git(repo,['commit','-m','fixture']);
  initManifest(inspectRepository(repo),'webskill','webskill/bootstrap');git(repo,['add','.']);git(repo,['commit','-m','identity']);
  const fixture=JSON.parse(readFileSync(new URL('../examples/protocol/webskill.json',import.meta.url))), token='awh_cp_'+randomBytes(32).toString('base64url');
  const principal={id:'fixture-client',project_ids:['webskill'],executor_ids:['fixture-executor']};
  const store=new ControlPlaneStore(join(base,'fixture.sqlite'),[{...fixture.profile_policy,ref:'webskill/bootstrap'}]);
  const service=createControlPlaneServer({store,authenticate:createAuthenticator([{...principal,token_sha256:digest(token)}])});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const residents=[];
  t.after(async()=>{for(const resident of residents)await resident.close();await service.close();store.close();assert.equal(dirname(base),tmpdir());assert(base.startsWith(join(tmpdir(),'awh-windows-product-')));rmSync(base,{recursive:true,force:true});});
  const config={schema_version:'1.0',endpoint:'http://127.0.0.1:'+service.server.address().port,credential_file:join(base,'dedicated.credential'),state_directory:join(base,'state'),executor_id:'fixture-executor',executor_type:'codex'};
  writeFileSync(config.credential_file,token,{mode:0o600});const configPath=join(base,'client.json');writeFileSync(configPath,JSON.stringify(config));
  const client=new AwhClient(configPath,repo),registered=await client.register();
  const requests=[];service.server.on('request',r=>requests.push({path:r.url,method:r.method}));
  return {base,repo,configPath,config,client,registered,store,principal,fixture,requests,residents,service};
}
async function until(predicate) {for(let i=0;i<80;i++){if(await predicate())return;await delay(50);}throw new Error('Fixture timed out');}
function bytes(path) {const output={};function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())walk(file);else output[file]=digest(readFileSync(file));}}walk(path);return output;}

test('resident start/status/stop/restart preserves Client/Machine/project bytes and writes only verified heartbeats',async t=>{
  const h=await setup(t),before=bytes(h.config.state_directory),source=bytes(h.repo);
  const resident=await startResident(h.configPath,{cwd:h.repo,intervalMs:1000});h.residents.push(resident);
  await until(()=>resident.status().online);assert.equal((await residentControl(h.configPath,'status',h.repo)).online,true);
  await assert.rejects(startResident(h.configPath,{cwd:h.repo}),e=>e.code==='resident_busy');
  await until(()=>h.requests.filter(r=>r.path.endsWith('/heartbeat')).length>=2);
  const descriptor=readdirSync(h.config.state_directory).find(n=>n.startsWith('resident-'));
  const lease=JSON.parse(readFileSync(join(h.config.state_directory,descriptor)));
  assert.equal((await fetch(lease.endpoint+'/stop',{method:'POST'})).status,401);
  assert.equal((await fetch(lease.endpoint+'/status',{headers:{Authorization:'Bearer '+lease.capability,Origin:'https://evil.invalid'}})).status,401);
  assert.equal((await residentControl(h.configPath,'stop',h.repo)).stopping,true);await resident.done;
  assert.deepEqual(bytes(h.config.state_directory),before);assert.deepEqual(bytes(h.repo),source);
  assert(h.requests.every(r=>r.method==='GET'||r.method==='POST'&&r.path==='/v1/executors/fixture-executor/heartbeat'));
  const restarted=await startResident(h.configPath,{cwd:h.repo,intervalMs:1000});h.residents.push(restarted);await until(()=>restarted.status().online);await restarted.close();
  assert.deepEqual(bytes(h.config.state_directory),before);assert.equal((await residentControl(h.configPath,'status',h.repo)).code,'resident_stopped');
});
test('registration mismatch blocks heartbeat before any write; malformed resident state never controls a process',async t=>{
  const h=await setup(t);h.store.registerExecutor(h.principal,h.registered.executor,{...h.registered.client,client_version:'0.0.0'});
  await assert.rejects(h.client.heartbeat(),e=>e.code==='response_binding');assert(!h.requests.some(r=>r.method==='POST'));
  const service=await startResident(h.configPath,{cwd:h.repo,intervalMs:1000});h.residents.push(service);await until(()=>service.status().failures>0);
  assert.equal(service.status().online,false);assert.equal(service.status().code,'response_binding');await service.close();
});
test('resident refuses configuration and endpoint changes before writes without rebinding identity',async t=>{
  const h=await setup(t),service=await startResident(h.configPath,{cwd:h.repo,intervalMs:1000});h.residents.push(service);await until(()=>service.status().online);
  const writes=h.requests.filter(r=>r.method==='POST').length;
  writeFileSync(h.configPath,JSON.stringify({...h.config,executor_type:'other'}));await until(()=>service.status().failures>0);
  assert.equal(service.status().code,'response_binding');assert.equal(h.requests.filter(r=>r.method==='POST').length,writes);
  writeFileSync(h.configPath,JSON.stringify(h.config));await until(()=>service.status().online);await service.close();
  const pinned=h.client.presenceBinding(),original=readFileSync(h.configPath);writeFileSync(h.configPath,JSON.stringify({...h.config,endpoint:'http://127.0.0.1:1'}));
  await assert.rejects(h.client.heartbeat(pinned),e=>['state','response_binding'].includes(e.code));writeFileSync(h.configPath,original);
});
test('resident reports temporary CP outage and reconnects only to the original endpoint with preserved state',async t=>{
  const h=await setup(t),before=bytes(h.config.state_directory),resident=await startResident(h.configPath,{cwd:h.repo,intervalMs:1000});h.residents.push(resident);await until(()=>resident.status().online);
  const port=h.service.server.address().port;await h.service.close();await until(()=>resident.status().failures>0);assert.equal(resident.status().online,false);assert.equal(resident.status().code,'network');
  await new Promise(resolve=>h.service.server.listen(port,'127.0.0.1',resolve));await until(()=>resident.status().online);await resident.close();assert.deepEqual(bytes(h.config.state_directory),before);
});
test('ordinary browser bootstrap is explicit scoped loopback navigation; APIs, foreign origins and expired sessions cannot bootstrap',async t=>{
  const h=await setup(t),viewer={id:'local-viewer',project_ids:['webskill']};let now=Date.now();
  const gateway=createDashboardGateway({enabled:true,store:h.store,assets:'dist/dashboard-ui',localBrowserViewer:viewer,now:()=>now});
  await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));t.after(()=>gateway.close());const root='http://127.0.0.1:'+gateway.server.address().port;
  assert.equal((await fetch(root+'/dashboard')).status,401);assert.equal((await fetch(root+'/dashboard/v1/snapshot')).status,401);
  const headers={'Sec-Fetch-Site':'none','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
  const navigate=await new Promise((resolve,reject)=>{const req=request(root+'/dashboard',{headers},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,cookie:res.headers['set-cookie']?.[0]}));});req.on('error',reject);req.end();});
  assert.equal(navigate.status,200);const cookie=navigate.cookie;assert(cookie.includes('HttpOnly; SameSite=Strict; Path=/dashboard'));
  const auth={Cookie:cookie.split(';')[0]};const snapshot=await (await fetch(root+'/dashboard/v1/snapshot',{headers:auth})).json();assert.deepEqual(snapshot.projects.map(p=>p.id),['webskill']);
  assert.equal((await fetch(root+'/dashboard',{headers:{...headers,Origin:'https://evil.invalid'}})).status,401);
  assert.equal((await fetch(root+'/dashboard',{headers:{...headers,Host:'localhost:'+gateway.server.address().port}})).status,401);
  assert.equal((await fetch(root+'/dashboard',{headers:{...headers,Authorization:'Bearer invalid'}})).status,401);
  assert.equal((await fetch(root+'/dashboard/onboarding/v1/doctor/webskill',{headers:auth,method:'POST'})).status,405);
  now+=3600001;assert.equal((await fetch(root+'/dashboard/v1/snapshot',{headers:auth})).status,401);
  const renewed=await new Promise((resolve,reject)=>{const req=request(root+'/dashboard',{headers},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,cookie:res.headers['set-cookie']?.[0]}));});req.on('error',reject);req.end();});
  assert.equal(renewed.status,200);assert.notEqual(renewed.cookie,cookie);
});
test('unavailable local installation is a current timestamped blocker, scoped IDs and configuration overrides fail closed',async t=>{
  const h=await setup(t),binding={id:'local-webskill',project_id:'webskill',repository:'zlpoot/webskill',worktree:h.repo,client_entry:join(h.base,'missing/dist/client/cli.js'),client_entry_sha256:'a'.repeat(64),config_file:h.configPath};
  const channel=createLocalOnboarding([binding]);assert.equal(channel.list({id:'v',project_ids:['foreign']}).length,0);
  assert.throws(()=>channel.diagnose({id:'v',project_ids:['foreign']},binding.id),/outside/);
  const diagnosis=await channel.diagnose({id:'v',project_ids:['webskill']},binding.id);assert.equal(diagnosis.status,'blocked');assert.equal(diagnosis.approved_version,null);assert(Number.isFinite(Date.parse(diagnosis.observed_at)));
  assert(!JSON.stringify(diagnosis).includes(h.base));assert(!JSON.stringify(diagnosis).includes(h.config.endpoint));
  assert.throws(()=>createLocalOnboarding([{...binding,command:'arbitrary'}]));assert.throws(()=>createLocalOnboarding([binding,binding]));
  assert.equal(matchLocalBinding([binding],'zlpoot/webskill',h.repo).id,binding.id);assert.equal(matchLocalBinding([binding],'evil/repo',h.repo),null);
  assert.throws(()=>diagnosisContract({...diagnosis,authority_verified:true}));
});
test('wizard current diagnosis overrides no historical facts, and unknown worktrees never become approved',()=>{
  const state={snapshot:{projects:[{id:'p',repository:'zlpoot/webskill',profile_ref:'webskill/bootstrap'}],runs:[],cursor:0},phase:'live',lastRefresh:1,events:[]};
  const diagnosis={id:'binding',project_id:'p',repository:'zlpoot/webskill',source:'installed_client_offline',status:'blocked',client_version:CLIENT_VERSION,approved_version:null,observed_at:new Date().toISOString(),authority_verified:false,
    checks:[{id:'configuration',status:'passed',code:'external_config_valid',source:'external_config',safe_next_step:'preserve'},{id:'branch',status:'blocked',code:'branch_profile_conflict',source:'checked_in_profile',safe_next_step:'request policy'}]};
  const model=wizardModel(state,'reader:p',false,diagnosis);assert.equal(model.currentDoctor,'blocked');assert.equal(model.configuration,'passed');assert.equal(model.installedVersion,CLIENT_VERSION);assert.equal(model.approvedVersion,null);
  assert.equal(wizardModel(state,'reader:p',false,{...diagnosis,repository:'evil/repo'}).currentDoctor,'not_checked');
  const history=wizardModel(state,'history:future-ui',false,diagnosis);assert.equal(history.currentDoctor,'not_checked');assert.equal(history.checks.length,22);
});
test('viewer deployment config separates read database and trusted local bindings, rejecting extra rights and unspecific scope',async t=>{
  const h=await setup(t),path=join(h.base,'viewer.json'),value={schema_version:'1.0',mode:'local_browser_direct',database:join(h.base,'fixture.sqlite'),port:4311,viewer:{id:'local-viewer',project_ids:['webskill']},local_bindings:[]};
  writeFileSync(path,JSON.stringify(value));assert.equal(readViewerConfig(path).mode,'local_browser_direct');
  const schema=JSON.parse(readFileSync(new URL('../docs/local-viewer.schema.json',import.meta.url))), validate=new Ajv2020({strict:true}).compile(schema);
  assert.equal(validate(value),true);assert.equal(validate({...value,viewer:{...value.viewer,project_ids:[]}}),false);assert.equal(validate({...value,command:'arbitrary'}),false);
  for(const bad of [{...value,command:'arbitrary'},{...value,viewer:{...value.viewer,project_ids:[]}},{...value,mode:'anonymous_lan'}]){writeFileSync(path,JSON.stringify(bad));assert.throws(()=>readViewerConfig(path));}
  assert.equal(existsSync(join(h.repo,'viewer.json')),false);
});
