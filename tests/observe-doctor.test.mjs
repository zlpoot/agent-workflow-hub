import './trusted-policy-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { doctor } from '../dist/client/doctor.js';
import { deliveryPolicy } from '../dist/client/delivery-policy.js';
import { AwhClient } from '../dist/client/client.js';
import { deliver } from '../dist/client/deliver.js';
import { machine, initManifest, inspectRepository } from '../dist/client/local.js';
import { createLocalOnboarding } from '../dist/dashboard/onboarding.js';
import { npmEntry, npmEnv } from '../scripts/npm-tool.mjs';
import { CLIENT_VERSION } from '../dist/client/version.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(k)));
const check = (report, id) => { const item = report.checks.find(c => c.id === id); assert(item, id); return item; };
function git(cwd, args) {
  const r = spawnSync('git', ['-c','commit.gpgsign=false','-c','core.hooksPath='+(process.platform === 'win32' ? 'NUL' : '/dev/null'),...args],
    { cwd, env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:process.platform === 'win32' ? 'NUL' : '/dev/null' }, encoding:'utf8', windowsHide:true });
  assert.equal(r.status, 0, 'Scratch Git failed'); return r.stdout.trim();
}
function snapshot(base) {
  const result = {};
  const walk = dir => { for (const name of readdirSync(dir).sort()) { const path = join(dir,name), st = lstatSync(path);
    if (st.isDirectory()) walk(path); else result[path.slice(base.length)] = hash(readFileSync(path)); } };
  walk(base); return result;
}
async function fixture(t) {
  const base = mkdtempSync(join(tmpdir(),'awh-observe-doctor-')), repo = join(base,'consumer'); mkdirSync(repo);
  t.after(() => { assert.equal(dirname(base),tmpdir()); assert(base.startsWith(join(tmpdir(),'awh-observe-doctor-'))); rmSync(base,{recursive:true,force:true}); });
  const repository = 'sample/observe-only', project = 'observe-project', ref = 'observe/' + project;
  git(repo,['init','-b','feature/local-observation']); git(repo,['config','user.name','Fixture']); git(repo,['config','user.email','fixture@example.invalid']);
  writeFileSync(join(repo,'.git','info','exclude'),'.handoff/\n');
  git(repo,['remote','add','origin','https://github.com/'+repository+'.git']); writeFileSync(join(repo,'product.txt'),'keep'); git(repo,['add','.']); git(repo,['commit','-m','fixture']);
  initManifest(inspectRepository(repo),project,ref); git(repo,['add','.']); git(repo,['commit','-m','fixture identity']);
  const calls = [], h = { base, repo, repository, project, ref, calls };
  const server = createServer((req,res) => {
    calls.push([req.method,req.url]); assert.equal(req.method,'GET');
    const value = req.url.startsWith('/v1/projects/') ? { project:{schema_version:'1.0',kind:'project',id:project,repository,profile_ref:ref} } :
      req.url === '/v1/enrollment' ? { enrollment:h.remoteGrant } : req.url === '/v1/executors' ? { executors:[{
        executor:{schema_version:'1.0',kind:'executor',id:h.config.executor_id,display_name:'codex on '+h.m.name,machine:{id:h.m.id,platform:h.m.platform}},
        client:{schema_version:'1.0',executor_type:'codex',machine_name:h.m.name,arch:h.m.arch,client_version:CLIENT_VERSION},last_seen:'2026-10-11T00:00:00.000Z'}] } : {profiles:[]};
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({authority_verified:false,...value}));
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r)); t.after(() => new Promise(r => {server.close(r);server.closeAllConnections();}));
  const state = join(base,'state'); mkdirSync(state); const credential = join(base,'credential'), configPath = join(base,'client.json');
  const config = {schema_version:'1.0',endpoint:'http://127.0.0.1:'+server.address().port,credential_file:credential,state_directory:state,executor_id:'observe-executor',executor_type:'codex'};
  writeFileSync(credential,'awh_cp_'+'D'.repeat(43),{mode:0o600}); writeFileSync(configPath,JSON.stringify(config)); const m = machine(config);
  const manifest = {apiVersion:'awh/v1',project:{id:project,repository},profile:{ref}};
  const request = {schema_version:'1.0',kind:'enrollment_request',id:'observe-request',repository,project_id:project,profile_ref:ref,client_id:'observe-client',executor_id:config.executor_id,
    machine:{id:m.id,platform:m.platform},worktree_id:'worktree-'+hash(repo).slice(0,32),token_sha256:hash(readFileSync(credential)),mode:'observe',branch:'feature/local-observation',sha:git(repo,['rev-parse','HEAD']),work_item:null};
  const grant = {request,manifest,approved_at:'2026-10-11T00:00:00.000Z',capability:'register_presence'};
  writeFileSync(join(base,'request.json'),JSON.stringify(request)); writeFileSync(join(base,'approved.json'),JSON.stringify(grant));
  const namespace = join(state,hash(JSON.stringify([project,repository,config.endpoint,config.executor_id]))); mkdirSync(namespace);
  writeFileSync(join(namespace,'session.json'),JSON.stringify({schema_version:'1.0',manifest,endpoint:config.endpoint,executor_id:config.executor_id,machine_id:m.id,initial:null,work_item:null,events:[],pending:null}));
  Object.assign(h,{config,configPath,m,grant,remoteGrant:grant}); return h;
}
async function withoutDeliverPolicy(action) {
  const saved = [process.env.AWH_BUILDER_POLICY_FILE,process.env.AWH_BUILDER_POLICY_SHA256];
  try { delete process.env.AWH_BUILDER_POLICY_FILE; delete process.env.AWH_BUILDER_POLICY_SHA256; return await action(); }
  finally { for (const [i,key] of ['AWH_BUILDER_POLICY_FILE','AWH_BUILDER_POLICY_SHA256'].entries()) { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; } }
}

test('approved Observe without Deliver pin or repository grant: Doctor is read-only and Deliver stays denied',async t => {
  const h = await fixture(t);
  for (const missing of [true,false]) {
    const run = async () => {
      const before = snapshot(h.base), previousCalls = h.calls.length;
      const offline = await doctor({configPath:h.configPath,cwd:h.repo});
      assert.equal(offline.status,'not_checked'); assert.equal(h.calls.length,previousCalls);
      for (const id of ['repository','profile','machine_executor','client_state']) assert.equal(check(offline,id).status,'passed');
      assert.equal(check(offline,'deliver').status,'not_checked'); assert.equal(offline.authority_verified,false);
      const live = await doctor({configPath:h.configPath,cwd:h.repo,probeCp:true});
      for (const id of ['profile','cp_profile','cp_connection','cp_executor']) assert.equal(check(live,id).status,'passed');
      assert.equal(live.status,'not_checked'); assert.equal(check(live,'deliver').status,'not_checked');
      assert.deepEqual(h.calls.slice(previousCalls).map(c => c[1]),['/v1/projects/'+h.project,'/v1/enrollment','/v1/executors']);
      assert.throws(() => deliveryPolicy(h.ref));
      let deliveryCalls = 0;
      await assert.rejects(deliver(new AwhClient(h.configPath,h.repo),{title:'Denied Observe delivery',body:'No grant'},
        {connect:async () => {deliveryCalls++; throw Error('Must not connect');},verify:async () => {deliveryCalls++; throw Error('Must not verify');}}),e => e.code === 'profile');
      assert.equal(deliveryCalls,0); assert(h.calls.every(([method]) => method === 'GET')); assert.deepEqual(snapshot(h.base),before);
    };
    if (missing) await withoutDeliverPolicy(run); else await run();
  }
  writeFileSync(join(h.repo,'product.txt'),'retained local changes');
  await withoutDeliverPolicy(async () => { const report = await doctor({configPath:h.configPath,cwd:h.repo}); assert.equal(check(report,'worktree').code,'local_changes_retained'); assert.equal(report.status,'not_checked'); });
});

test('Observe cannot be approved by Manifest alone or mismatched local/CP Enrollment identity',async t => {
  const h = await fixture(t), path = join(h.base,'approved.json');
  for (const change of [g => g.request.machine.id = 'other-machine',g => g.request.executor_id = 'other-executor',g => g.request.worktree_id = 'other-worktree',
    g => g.request.repository = g.manifest.project.repository = 'sample/other',g => g.manifest.profile.ref = 'observe/other-project']) {
    const changed = structuredClone(h.grant); change(changed); writeFileSync(path,JSON.stringify(changed));
    await withoutDeliverPolicy(async () => assert.equal(check(await doctor({configPath:h.configPath,cwd:h.repo}),'profile').status,'blocked'));
  }
  rmSync(path); assert.equal(check(await doctor({configPath:h.configPath,cwd:h.repo}),'profile').status,'blocked');
  writeFileSync(path,JSON.stringify(h.grant)); h.remoteGrant = structuredClone(h.grant); h.remoteGrant.request.machine.id = 'other-machine';
  await withoutDeliverPolicy(async () => { const r = await doctor({configPath:h.configPath,cwd:h.repo,probeCp:true}); assert.equal(check(r,'profile').status,'passed'); assert.equal(check(r,'cp_profile').code,'enrollment_binding'); });
});

test('installed Client through Viewer offline diagnosis preserves Observe without Deliver policy',async t => {
  const h = await fixture(t), output = join(h.base,'packages');
  const packed = spawnSync(process.execPath,[resolve('scripts/client-pack.mjs'),'--output',output],{env:cleanEnv(),encoding:'utf8',windowsHide:true,timeout:60000}); assert.equal(packed.status,0,packed.stderr);
  const artifact = JSON.parse(packed.stdout), prefix = join(h.base,'installed'); mkdirSync(prefix); writeFileSync(join(prefix,'package.json'),'{"private":true}');
  const installed = spawnSync(process.execPath,[npmEntry(),'install','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund',artifact.artifact],{env:npmEnv(join(h.base,'cache')),encoding:'utf8',windowsHide:true,timeout:60000}); assert.equal(installed.status,0,installed.stderr);
  const entry = join(prefix,'node_modules','@zlpoot','awh-client','dist','client','cli.js'), viewer = {id:'observe-viewer',project_ids:[h.project]};
  const binding = {id:'observe-binding',project_id:h.project,repository:h.repository,worktree:h.repo,client_entry:entry,client_entry_sha256:hash(readFileSync(entry)),config_file:h.configPath};
  for (const missing of [true,false]) {
    const run = async () => { const before = snapshot(h.base), count = h.calls.length;
      const diagnosis = await createLocalOnboarding([binding]).diagnose(viewer,binding.id);
      assert.equal(diagnosis.source,'installed_client_offline'); assert.equal(diagnosis.status,'not_checked');
      assert.equal(check(diagnosis,'profile').status,'passed'); assert.equal(check(diagnosis,'repository').status,'passed'); assert.equal(check(diagnosis,'installation').status,'passed');
      assert.equal(check(diagnosis,'deliver').status,'not_checked'); assert.equal(diagnosis.authority_verified,false);
      assert.equal(h.calls.length,count); assert.deepEqual(snapshot(h.base),before);
    };
    if (missing) await withoutDeliverPolicy(run); else await run();
  }
});
