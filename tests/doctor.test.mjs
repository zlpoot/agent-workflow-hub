import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, lstatSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doctor, formatDoctor, CLIENT_VERSION } from '../dist/client/index.js';
import { machine, initManifest, inspectRepository } from '../dist/client/local.js';
import { npmEntry, npmEnv } from '../scripts/npm-tool.mjs';
import { tlsFixture } from './tls-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), cli = join(root,'dist/client/cli.js');
export const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(key)));
const hash = value => createHash('sha256').update(value).digest('hex');
export function git(cwd, args) {
  const r = spawnSync('git',['-c','commit.gpgsign=false','-c','core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null'),...args],
    {cwd,env:{...cleanEnv(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'},encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,'Scratch Git failed'); return r.stdout.trim();
}
function temporary(t) {
  const base=mkdtempSync(join(tmpdir(),'awh-doctor-'));
  t.after(() => { assert.equal(dirname(base),tmpdir()); assert(base.startsWith(join(tmpdir(),'awh-doctor-'))); rmSync(base,{recursive:true,force:true}); });
  return base;
}
function fixture(t, { repository='zlpoot/webskill', ref='webskill/bootstrap', branch='codex/awh-c07-webskill-bootstrap' }={}) {
  const base=temporary(t),repo=join(base,'consumer');mkdirSync(repo);git(repo,['init','-b',branch]);
  git(repo,['config','user.name','Fixture']);git(repo,['config','user.email','fixture@example.invalid']);
  git(repo,['remote','add','origin','https://github.com/'+repository+'.git']);writeFileSync(join(repo,'product.txt'),'unchanged fixture');
  git(repo,['add','.']);git(repo,['commit','-m','scratch']);initManifest(inspectRepository(repo),repository.split('/')[1],ref);
  git(repo,['add','.awh/project.yaml']);git(repo,['commit','-m','scratch identity']);
  const configPath=join(base,'client.json'),state=join(base,'state'),credential=join(base,'client.credential');mkdirSync(state);
  const config={schema_version:'1.0',endpoint:'http://127.0.0.1:1',credential_file:credential,state_directory:state,executor_id:'doctor-fixture',executor_type:'codex',profile_version:'fixture-v1'};
  writeFileSync(credential,'awh_cp_'+'D'.repeat(43),{mode:0o600});writeFileSync(configPath,JSON.stringify(config));
  const m=machine(config),manifest={apiVersion:'awh/v1',project:{id:repository.split('/')[1],repository},profile:{ref}};
  const namespace=join(state,hash(JSON.stringify([manifest.project.id,repository,config.endpoint,config.executor_id])));mkdirSync(namespace);
  const session={schema_version:'1.0',manifest,endpoint:config.endpoint,executor_id:config.executor_id,machine_id:m.id,initial:null,work_item:null,events:[],pending:null};
  const save=()=>writeFileSync(join(namespace,'session.json'),JSON.stringify(session));save();
  const update=patch=>{Object.assign(config,patch);writeFileSync(configPath,JSON.stringify(config));};
  return {base,repo,configPath,config,state,namespace,session,manifest,m,save,update};
}
function snapshot(path) {
  const result={};
  function walk(dir) { for(const name of readdirSync(dir).sort()) { const file=join(dir,name),st=lstatSync(file);if(st.isDirectory())walk(file);else result[file.slice(path.length)]=st.isSymbolicLink()?'symlink':hash(readFileSync(file)); } }
  walk(path);return result;
}
const check=(report,id)=>{const c=report.checks.find(c=>c.id===id);assert(c,'Missing check '+id);return c;};
function startSession(h, pending=false) {
  const example=JSON.parse(readFileSync(join(root,'examples/protocol/webskill.json')));
  h.session.initial={...example.run,source:{...example.run.source,sha:git(h.repo,['rev-parse','HEAD']),ref:git(h.repo,['branch','--show-current'])},executor_id:h.config.executor_id,machine_id:h.m.id,profile:{ref:h.manifest.profile.ref,version:'fixture-v1'}};
  h.session.work_item=example.work_item;
  if(pending)h.session.pending=event(h,'RUN_STARTED',1,{source_sha:h.session.initial.source.sha});
  h.save();
}
function event(h,type,sequence,data) { return {schema_version:'1.0',kind:'event',id:'event-doctor-'+sequence,run_id:h.session.initial.id,sequence,type,occurred_at:`2026-10-07T00:00:0${sequence}.000Z`,payload:{schema_version:'1.0',data,extensions:{}}}; }
function runCli(file,args,cwd) { return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[file,...args],{cwd,env:cleanEnv(),windowsHide:true});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));}); }

test('offline Doctor preserves all scratch bytes, never reads secret contents, and leaves remote claims unchecked',async t=>{
  const h=fixture(t);writeFileSync(h.config.credential_file,'unreadable-as-a-valid-credential',{mode:0o600});const before=snapshot(h.base);
  const report=await doctor({configPath:h.configPath,cwd:h.repo});assert.deepEqual(snapshot(h.base),before);
  for(const id of ['repository','manifest','configuration','machine_executor','client_state','pending_events','journal','branch'])assert.equal(check(report,id).status,'passed');
  for(const id of ['artifact_provenance','profile_version','cp_connection','cp_profile','cp_executor','app_scope','remote_state','github_review','work_item','verification'])assert.equal(check(report,id).status,'not_checked');
  assert.equal(report.status,'not_checked');assert.equal(report.authority_verified,false);assert(!JSON.stringify(report).includes(h.config.endpoint));assert(!JSON.stringify(report).includes(h.config.executor_id));assert(!JSON.stringify(report).includes(h.base));
});
test('no config still explains real origin, Manifest and dirty flag without discovery or writes',async t=>{
  const h=fixture(t);writeFileSync(join(h.repo,'product.txt'),'local unsaved change');const before=snapshot(h.base);
  const report=await doctor({cwd:h.repo});assert.equal(check(report,'configuration').code,'explicit_config_missing');assert.equal(check(report,'worktree').code,'worktree_dirty');
  assert.equal(check(report,'repository').details.dirty,true);assert.equal(check(report,'cp_connection').status,'not_checked');assert.deepEqual(snapshot(h.base),before);
});
test('wrong repository, malformed/mismatched Manifest and malicious origin stay bounded and secret-free',async t=>{
  const h=fixture(t,{repository:'zlpoot/unknown',ref:'webskill/bootstrap'});assert.equal(check(await doctor({cwd:h.repo}),'repository').status,'blocked');
  writeFileSync(join(h.repo,'.awh/project.yaml'),'apiVersion: awh/v1\nproject:\n  id: webskill\n  repository: zlpoot/webskill\nprofile:\n  ref: webskill/bootstrap\n');
  assert.equal(check(await doctor({cwd:h.repo}),'manifest').code,'origin_mismatch');
  writeFileSync(join(h.repo,'.awh/project.yaml'),'invalid');assert.equal(check(await doctor({cwd:h.repo}),'manifest').status,'blocked');
  const secret='github_pat_DO_NOT_PRINT';git(h.repo,['remote','set-url','origin','https://'+secret+'@github.com/zlpoot/webskill.git']);
  const report=await doctor({cwd:h.repo});assert.equal(check(report,'repository').code,'origin');assert(!JSON.stringify(report).includes(secret));
});
test('config endpoint/CA errors and redirected external paths are blocked without creating state',async t=>{
  const h=fixture(t);
  for(const endpoint of ['http://192.0.2.1:4310','https://user:password@example.invalid','https://example.invalid/path']){
    h.update({endpoint});assert.equal(check(await doctor({cwd:h.repo,configPath:h.configPath}),'configuration').code,'endpoint');
  }
  const ca=join(h.base,'ca.pem');writeFileSync(ca,'not a certificate');h.update({endpoint:'https://127.0.0.1:1',ca_certificate_file:ca});
  assert.equal(check(await doctor({cwd:h.repo,configPath:h.configPath}),'configuration').code,'certificate');
  delete h.config.ca_certificate_file;h.update({endpoint:'http://127.0.0.1:1',state_directory:join(h.base,'does-not-exist')});
  const before=snapshot(h.base);const report=await doctor({cwd:h.repo,configPath:h.configPath});assert.equal(check(report,'machine_executor').status,'blocked');assert.equal(existsSync(h.config.state_directory),false);assert.deepEqual(snapshot(h.base),before);
  const alias=join(h.base,'state-alias');symlinkSync(h.state,alias,process.platform==='win32'?'junction':'dir');h.update({state_directory:alias});
  assert.equal(check(await doctor({cwd:h.repo,configPath:h.configPath}),'configuration').status,'blocked');
});
test('missing original machine/session stays blocked and is never replaced or initialized',async t=>{
  for(const missing of ['machine.json','session.json']){
    const h=fixture(t);rmSync(join(missing==='machine.json'?h.state:h.namespace,missing));const before=snapshot(h.base);
    const report=await doctor({configPath:h.configPath,cwd:h.repo});assert.equal(check(report,missing==='machine.json'?'machine_executor':'client_state').status,'blocked');assert.deepEqual(snapshot(h.base),before);
  }
});
test('future-ui acceptance ref conflicts explain current and legacy bootstrap expectations and request #34',async t=>{
  const h=fixture(t,{repository:'zlpoot/future-ui',ref:'future-ui/c1c-acceptance',branch:'feature/current-product'});const before=snapshot(h.base);
  const report=await doctor({configPath:h.configPath,cwd:h.repo});assert.equal(check(report,'branch').status,'blocked');assert.equal(check(report,'branch').details.actual_branch,'feature/current-product');
  assert.equal(check(report,'branch').details.expected_branch,'codex/awh-v01-acceptance');assert.equal(check(report,'legacy_bootstrap').details.expected_branch,'codex/awh-c06-bootstrap');
  assert(check(report,'branch').safe_next_step.includes('#34'));assert.deepEqual(snapshot(h.base),before);
});
test('Manifest cannot approve an unknown/cross-repository Profile, and CP version/check conflicts are explicit',async t=>{
  const h=fixture(t,{ref:'webskill/owner-approved-in-project-json'});
  assert.equal(check(await doctor({configPath:h.configPath,cwd:h.repo}),'profile').code,'profile');
  const path=join(h.repo,'.awh/project.yaml');writeFileSync(path,readFileSync(path,'utf8').replace('webskill/owner-approved-in-project-json','hub/c05'));
  assert.equal(check(await doctor({configPath:h.configPath,cwd:h.repo}),'profile').status,'blocked');
  writeFileSync(path,readFileSync(path,'utf8').replace('hub/c05','webskill/bootstrap'));
  const example=JSON.parse(readFileSync(join(root,'examples/protocol/webskill.json')));let mode='version';
  const server=await mock(t,(req,res)=>{
    if(req.url.startsWith('/v1/projects/'))return envelope(res,{project:{...example.project,profile_ref:'webskill/bootstrap'}});
    if(req.url.startsWith('/v1/profiles'))return envelope(res,{profiles:[{...example.profile_policy,ref:'webskill/bootstrap',version:mode==='version'?'unselected-v2':'fixture-v1',verification:{commands:mode==='commands'?['pnpm check']:example.profile_policy.verification.commands}}]});
    envelope(res,{executors:[]});
  });h.update({endpoint:'http://127.0.0.1:'+server.address().port});
  let report=await doctor({configPath:h.configPath,cwd:h.repo,probeCp:true});assert.equal(check(report,'cp_profile').code,'profile');assert.equal(check(report,'profile_version').status,'not_checked');
  mode='commands';report=await doctor({configPath:h.configPath,cwd:h.repo,probeCp:true});assert.equal(check(report,'cp_profile').code,'delivery_policy');assert.deepEqual(check(report,'cp_profile').details.actual_commands,['pnpm check']);assert.equal(check(report,'cp_executor').code,'response_binding');
});
test('pending Event, journal/lock and recorded check/Work Item mismatches are observations, never execution',async t=>{
  const h=fixture(t);startSession(h,true);let report=await doctor({configPath:h.configPath,cwd:h.repo});assert.equal(check(report,'pending_events').code,'event_ack_pending');assert.equal(check(report,'work_item').status,'passed');
  h.session.events=[h.session.pending,event(h,'VERIFICATION_STARTED',2,{subject_sha:h.session.initial.source.sha}),event(h,'VERIFICATION_PASSED',3,{subject_sha:h.session.initial.source.sha,checks:[{command:'pnpm wrong-do-not-execute',exit_code:0}]})];
  h.session.pending=null;h.session.work_item.reference.repository='zlpoot/webskill';h.session.work_item.reference.number=147;h.save();writeFileSync(join(h.namespace,'fixture.delivery.json'),'{}');writeFileSync(join(h.namespace,'session.json.lock'),'');
  const before=snapshot(h.base);report=await doctor({configPath:h.configPath,cwd:h.repo});assert.equal(check(report,'work_item').status,'blocked');assert.equal(check(report,'verification').code,'recorded_commands_profile_conflict');assert.equal(check(report,'journal').status,'blocked');assert.deepEqual(snapshot(h.base),before);
});
async function mock(t, handler, tls) {
  const server=tls?httpsServer(tls,handler):createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return server;
}
const envelope=(res,value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({authority_verified:false,...value}));};
test('CP probe is opt-in GET-only and verifies existing Project/Profile/Executor without heartbeat or mutations',async t=>{
  const h=fixture(t),calls=[];const example=JSON.parse(readFileSync(join(root,'examples/protocol/webskill.json')));
  const server=await mock(t,(req,res)=>{calls.push([req.method,req.url]);
    if(req.url.startsWith('/v1/projects/'))return envelope(res,{project:{...example.project,profile_ref:h.manifest.profile.ref}});
    if(req.url.startsWith('/v1/profiles'))return envelope(res,{profiles:[{...example.profile_policy,ref:h.manifest.profile.ref}]});
    envelope(res,{executors:[{executor:{schema_version:'1.0',kind:'executor',id:h.config.executor_id,display_name:'codex on '+h.m.name,machine:{id:h.m.id,platform:h.m.platform}},client:{schema_version:'1.0',executor_type:'codex',machine_name:h.m.name,arch:h.m.arch,client_version:CLIENT_VERSION},last_seen:'2026-10-09T00:00:00.000Z'}]});
  });h.update({endpoint:'http://127.0.0.1:'+server.address().port});
  await doctor({configPath:h.configPath,cwd:h.repo});assert.deepEqual(calls,[]);const before=snapshot(h.base);
  const report=await doctor({configPath:h.configPath,cwd:h.repo,probeCp:true});for(const id of ['cp_connection','cp_profile','cp_executor'])assert.equal(check(report,id).status,'passed');
  assert.equal(check(report,'profile_version').status,'not_checked');assert(calls.every(([method])=>method==='GET'));assert.equal(calls.length,3);assert.deepEqual(snapshot(h.base),before);
});
test('offline failure, timeout, auth/redirect/malformed responses keep fixed original categories and suppress bodies',async t=>{
  const h=fixture(t);let report=await doctor({configPath:h.configPath,cwd:h.repo,probeCp:true});assert.equal(check(report,'cp_connection').code,'network');
  for(const mode of ['timeout','auth','redirect','schema','oversize']){
    const secret='awh_cp_'+'SECRET'.repeat(8),server=await mock(t,(_req,res)=>{
      if(mode==='timeout')return;
      if(mode==='schema')return envelope(res,{project:{secret}});
      if(mode==='oversize')return envelope(res,{project:secret.repeat(1500)});
      res.writeHead(mode==='auth'?401:307,{'content-type':'text/plain',location:'http://127.0.0.1:1'});res.end(secret);
    });h.update({endpoint:'http://127.0.0.1:'+server.address().port});report=await doctor({configPath:h.configPath,cwd:h.repo,probeCp:true});
    assert.equal(check(report,'cp_connection').code,{timeout:'timeout',auth:'authentication',redirect:'http',schema:'credential_data',oversize:'response_size'}[mode]);assert(!JSON.stringify(report).includes(secret));
  }
});
test('TLS SAN mismatch is blocked; no insecure fallback and no HTTP handler reached',async t=>{
  const h=fixture(t),tls=tlsFixture({ip:'192.0.2.10'});let calls=0;const server=await mock(t,(_req,res)=>{calls++;envelope(res,{});},tls);
  const ca=join(h.base,'ca.pem');writeFileSync(ca,tls.ca);h.update({endpoint:'https://127.0.0.1:'+server.address().port,ca_certificate_file:ca});
  const report=await doctor({configPath:h.configPath,cwd:h.repo,probeCp:true});assert.equal(check(report,'cp_connection').code,'tls');assert.equal(calls,0);
});
test('CLI text/JSON share grounded check statuses; help and strict bounded argument handling',async t=>{
  const h=fixture(t);const json=await runCli(cli,['doctor','--json'],h.repo),text=await runCli(cli,['doctor'],h.repo),report=JSON.parse(json.stdout);assert.equal(json.code,2);assert.equal(text.code,2);assert.equal(text.stdout.trim(),formatDoctor(report));
  for(const args of [['doctor','--json','--json'],['doctor','--repo','evil'],['doctor','--fix'],['doctor','--probe-cp','--endpoint','http://127.0.0.1']])assert.equal((await runCli(cli,args,h.repo)).code,2);
  assert(JSON.parse((await runCli(cli,['--help'],h.repo)).stdout).commands.some(x=>x.startsWith('doctor')));assert.equal(JSON.parse((await runCli(cli,['doctor','--help'],h.repo)).stdout).read_only,true);
});
test('standalone tarball installs offline, exports Doctor, and actual awh bin runs in consumer without Hub checkout',async t=>{
  const h=fixture(t),output=join(h.base,'packages');const packed=spawnSync(process.execPath,[join(root,'scripts/client-pack.mjs'),'--output',output],{cwd:root,env:cleanEnv(),encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(packed.status,0,packed.stderr);
  const artifact=JSON.parse(packed.stdout);assert.equal(artifact.version,CLIENT_VERSION);assert(artifact.files.includes('dist/client/doctor.js'));assert(artifact.files.includes('doctor.md'));
  const prefix=join(h.base,'installed');mkdirSync(prefix);writeFileSync(join(prefix,'package.json'),'{"private":true}');
  const installed=spawnSync(process.execPath,[npmEntry(),'install','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund',artifact.artifact],{cwd:prefix,env:npmEnv(join(h.base,'cache')),encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(installed.status,0,installed.stderr);
  const packageRoot=join(prefix,'node_modules/@zlpoot/awh-client'),installedCli=join(packageRoot,'dist/client/cli.js'),before=snapshot(h.repo);
  const result=await runCli(installedCli,['--config',h.configPath,'doctor','--json'],h.repo);assert.equal(result.code,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(check(report,'installation').status,'passed');assert.equal(report.status,'not_checked');assert.deepEqual(snapshot(h.repo),before);
  const bin=join(prefix,'node_modules/.bin/awh'+(process.platform==='win32'?'.cmd':''));
  const invoked=process.platform==='win32'?spawnSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c',`""${bin}" doctor --json"`],{cwd:h.repo,env:cleanEnv(),encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true}):spawnSync(bin,['doctor','--json'],{cwd:h.repo,env:cleanEnv(),encoding:'utf8'});
  assert.equal(invoked.status,2);assert.equal(JSON.parse(invoked.stdout).kind,'client_doctor');
  const metadataPath=join(packageRoot,'package.json'),metadata=JSON.parse(readFileSync(metadataPath));metadata.version='0.4.4';writeFileSync(metadataPath,JSON.stringify(metadata));
  const stale=JSON.parse((await runCli(installedCli,['--config',h.configPath,'doctor','--json'],h.repo)).stdout);assert.equal(check(stale,'installation').code,'standalone_metadata_conflict');
});
