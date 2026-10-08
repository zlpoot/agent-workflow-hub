import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { AwhClient, initManifest, inspectRepository, readManifest, CLIENT_VERSION } from '../dist/client/index.js';
import { readConfig, machine } from '../dist/client/local.js';
import { createAuthenticator, createControlPlaneServer, ControlPlaneStore } from '../dist/control-plane/index.js';
import { npmEntry, npmEnv } from '../scripts/npm-tool.mjs';
import { tlsFixture } from './tls-fixture.mjs';
import { requestJson } from '../dist/client/http.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/protocol/${name}.json`, import.meta.url)));
const nativePlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(k)));
function git(cwd, args) {
  const r = spawnSync('git', ['-c','commit.gpgsign=false','-c','core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { cwd, env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, 'Fixture Git command failed'); return r.stdout.trim();
}
function consumer(base, name = 'consumer', repository = 'zlpoot/webskill') {
  const path = join(base, name); mkdirSync(path); git(path, ['init','-b','main']); git(path, ['config','user.name','Test']); git(path, ['config','user.email','test@example.invalid']);
  git(path, ['remote','add','origin','https://github.com/' + repository + '.git']); writeFileSync(join(path, 'source.txt'), 'fixture\n'); git(path, ['add','source.txt']); git(path, ['commit','-m','fixture']); return path;
}
function removeTemporary(path) {
  assert(dirname(path) === tmpdir() && path.startsWith(join(tmpdir(), 'awh-c1c-'))); rmSync(path, { recursive: true, force: true });
}
function temporary(t, cleanup = true) {
  const path = mkdtempSync(join(tmpdir(), 'awh-c1c-'));
  if (cleanup) t.after(() => removeTemporary(path)); return path;
}
async function harness(t, { proxy = false, policies } = {}) {
  const base = temporary(t, false), repo = consumer(base), f = fixture('webskill');
  const token = 'awh_cp_' + randomBytes(32).toString('base64url'), foreignToken = 'awh_cp_' + randomBytes(32).toString('base64url');
  const principal = { id: 'c1c-client', project_ids: ['webskill'], executor_ids: ['client-executor'] };
  const foreign = { id: 'other-client', project_ids: ['future-ui'], executor_ids: ['other-executor'] };
  const registered = (p, value) => ({ ...p, token_sha256: createHash('sha256').update(value).digest('hex') });
  const store = new ControlPlaneStore(join(base, 'runtime.sqlite'), policies ?? [f.profile_policy, fixture('future-ui').profile_policy]);
  const service = createControlPlaneServer({ store, authenticate: createAuthenticator([registered(principal, token), registered(foreign, foreignToken)]) });
  await new Promise(resolveListen => service.server.listen(0, '127.0.0.1', resolveListen));
  const cp = `http://127.0.0.1:${service.server.address().port}`;
  let endpoint = cp, fault = null, requests = 0; const attempts = [];
  service.server.on('request', () => requests++);
  if (proxy) {
    const forwarding = createServer(async (req, res) => {
      try {
        let text = ''; for await (const chunk of req) text += chunk;
        const e = req.url.endsWith('/events') && req.method === 'POST'; if (e) attempts.push(JSON.parse(text));
        const result = await fetch(cp + req.url, { method: req.method, headers: { authorization: req.headers.authorization, ...(text ? { 'content-type': 'application/json' } : {}) }, ...(text ? { body: text } : {}) });
        const value = await result.json();
        if (e && fault) { const saved = fault; fault = null; if (saved === 'lost') { res.destroy(); return; } value.cursor = 0; }
        res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
      } catch { res.destroy(); }
    });
    await new Promise(r => forwarding.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { forwarding.close(r); forwarding.closeAllConnections(); }));
    endpoint = `http://127.0.0.1:${forwarding.address().port}`;
  }
  const credential = join(base, 'client.credential'); writeFileSync(credential, token, { mode: 0o600 });
  const configPath = join(base, 'client.json'), config = { schema_version: '1.0', endpoint, credential_file: credential, state_directory: join(base,'state'), executor_id: 'client-executor', executor_type: 'codex' };
  writeFileSync(configPath, JSON.stringify(config)); initManifest(inspectRepository(repo), 'webskill', f.manifest.profile.ref);
  const client = new AwhClient(configPath, repo), sessionPath = () => join(config.state_directory, readdirSync(config.state_directory).find(n => /^[a-f0-9]{64}$/.test(n)), 'session.json');
  t.after(async () => { await service.close(); store.close(); removeTemporary(base); });
  return { base, repo, client, config, configPath, token, foreignToken, principal, foreign, store, cp, attempts, sessionPath,
    get requests() { return requests; }, fault(value) { fault = value; }, updateConfig(changes) { Object.assign(config, changes); writeFileSync(configPath, JSON.stringify(config)); } };
}
const errorCode = code => e => e.code === code;
async function runCli(file, args, cwd, env = cleanEnv()) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env, windowsHide: true }); let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); child.once('error', reject);
    child.once('close', code => resolveChild({ code, stdout, stderr }));
  });
}

test('real Git root/origin binding; minimal Manifest is idempotent, closed and never overwrites identity', t => {
  const base = temporary(t), repo = consumer(base); mkdirSync(join(repo,'nested')); const identity = inspectRepository(join(repo,'nested'));
  assert.equal(identity.root, repo); assert.equal(identity.repository, 'zlpoot/webskill'); assert.equal(identity.dirty, false);
  const manifest = initManifest(identity,'webskill','webskill/bootstrap'); assert.deepEqual(initManifest(identity,'webskill','webskill/bootstrap'),manifest);
  assert.deepEqual(readManifest(identity),manifest); assert.throws(() => initManifest(identity,'different','webskill/bootstrap'),errorCode('manifest_conflict'));
  const path = join(repo,'.awh/project.yaml'), original = readFileSync(path,'utf8');
  for (const invalid of [original + 'commands: []\n', original.replace('profile:', 'project:'), original.replace('"webskill/bootstrap"','&alias'), original.replace('"webskill/bootstrap"','!!str value'), original.replace('"zlpoot/webskill"','"evil/repo"')]) {
    writeFileSync(path,invalid); assert.throws(() => readManifest(identity));
  }
  writeFileSync(path,original); git(repo,['remote','set-url','origin','git@github.com:zlpoot/future-ui.git']); assert.throws(() => readManifest(inspectRepository(repo)),errorCode('origin_mismatch'));
  for (const origin of ['https://github.com/evil/repo?token=hidden', 'https://user:hidden@github.com/zlpoot/webskill.git','https://evil.invalid/zlpoot/webskill.git','file:///tmp/repo']) {
    git(repo,['remote','set-url','origin',origin]); assert.throws(() => inspectRepository(repo),errorCode('origin'));
  }
  git(repo,['remote','set-url','origin','https://github.com/zlpoot/webskill.git']); git(repo,['config','url.https://evil.invalid/.insteadOf','https://github.com/']); assert.throws(() => inspectRepository(repo),errorCode('origin'));
});

test('dedicated explicit off-project config fails closed on plaintext LAN, credentials, redirects in paths and unknown fields', async t => {
  const h = await harness(t), valid = { ...h.config };
  for (const endpoint of ['http://192.168.2.5:4310','http://localhost:4310','https://user:secret@example.invalid','https://example.invalid/path','https://example.invalid/?x=1','https://example.invalid/#x','file:///tmp/socket']) {
    h.updateConfig({ endpoint }); await assert.rejects(h.client.register(),errorCode('endpoint'));
  }
  h.updateConfig({ ...valid, arbitrary: 'hidden' }); await assert.rejects(h.client.register(),errorCode('configuration')); delete h.config.arbitrary; h.updateConfig(valid);
  const inside = join(h.repo,'config.json'); writeFileSync(inside,JSON.stringify(valid)); await assert.rejects(new AwhClient(inside,h.repo).register(),errorCode('configuration'));
  h.updateConfig({ state_directory: join(h.repo,'state') }); await assert.rejects(h.client.register(),errorCode('configuration')); h.updateConfig(valid);
  writeFileSync(valid.credential_file,'github_pat_test_only', { mode: 0o600 }); await assert.rejects(h.client.register(),errorCode('credential'));
  assert.equal(h.requests,0); assert.equal(h.store.listProjects(h.principal).length,0);
});

test('read-only Git inspection never executes configured fsmonitor or filter drivers', t => {
  const base = temporary(t), repo = consumer(base), marker = join(repo,'executed.marker'), script = join(repo,'driver.cjs');
  writeFileSync(script,"require('node:fs').writeFileSync(require('node:path').join(__dirname,'executed.marker'),'executed');process.stdout.write(require('node:fs').readFileSync(0));");
  const quote = path => "'" + path.replaceAll('\\','/').replaceAll("'","'\\''") + "'";
  const driver = quote(process.execPath) + ' ' + quote(script);
  git(repo,['config','core.fsmonitor',driver]);
  assert.equal(inspectRepository(repo).repository,'zlpoot/webskill'); assert.equal(existsSync(marker),false);
  git(repo,['config','filter.fixture.clean',driver]);writeFileSync(join(repo,'.gitattributes'),'source.txt filter=fixture\n');writeFileSync(join(repo,'source.txt'),'modified fixture\n');
  assert.throws(() => inspectRepository(repo),errorCode('origin')); assert.equal(existsSync(marker),false);
});

test('native Client registers metadata/heartbeat and reports exact source, ordered Events, status and explicit failed finish', async t => {
  const h = await harness(t), before = git(h.repo,['rev-parse','HEAD']);
  const registered = await h.client.register(); assert.equal(registered.client.client_version,CLIENT_VERSION); assert.equal(registered.client.executor_type,'codex');
  assert.equal(registered.executor.machine.platform,nativePlatform); assert.equal(registered.client.arch,process.arch); assert(registered.client.machine_name);
  assert.equal((await h.client.status()).run,null); const started = await h.client.start(21); assert.equal(started.event.sequence,1); assert.equal(started.run.state,'running');
  assert.equal(started.run.source.sha,before); assert.equal(started.run.source.repository,'zlpoot/webskill'); assert.equal(started.event.payload.extensions.source_dirty,true);
  assert.equal((await h.client.start(21)).run.id,started.run.id); await assert.rejects(h.client.start(22),errorCode('active_run'));
  await h.client.event('STEP_STARTED',{ step_id:'controlled', name:'Client reporting smoke test' }); await h.client.event('STEP_COMPLETED',{ step_id:'controlled', exit_code:0 });
  await assert.rejects(h.client.finish(),errorCode('review_gate'));
  const finished = await h.client.finish(true,{ reason:'Controlled C1-C smoke run; no delivery or independent Review requested' }); assert.equal(finished.run.state,'failed');
  assert.equal((await h.client.status()).run.state,'failed'); assert.equal((await h.client.finish()).reporting_finished,true);
  const events = h.store.listEvents(h.principal,started.run.id); assert.deepEqual(events.map(x => x.event.sequence),[1,2,3,4]);
  assert.equal(h.store.listProjects(h.foreign).length,0); assert.equal(h.store.listExecutors(h.foreign).length,0);
  const next = await h.client.start(22); assert.notEqual(next.run.id,started.run.id); assert(readdirSync(dirname(h.sessionPath())).includes(started.run.id + '.json'));
  assert.equal(git(h.repo,['rev-parse','HEAD']),before); assert.equal(git(h.repo,['status','--porcelain']),'?? .awh/');
});

for (const fault of ['lost','malformed']) test(`persisted exact retries after ${fault} ACK, including initial RUN_STARTED and process replacement`, async t => {
  const h = await harness(t,{proxy:true}); await h.client.register(); h.fault(fault);
  await assert.rejects(h.client.start(21)); const pending = JSON.parse(readFileSync(h.sessionPath())).pending; assert.equal(pending.type,'RUN_STARTED');
  assert.equal(h.store.listEvents(h.principal,pending.run_id).length,1); const restarted = new AwhClient(h.configPath,h.repo);
  assert.equal((await restarted.status()).pending_event.id,pending.id); const retried = await restarted.start(21); assert.equal(retried.disposition,'idempotent'); assert.deepEqual(retried.event,pending);
  h.fault(fault); await assert.rejects(restarted.event('STEP_STARTED',{step_id:'test',name:'test'})); const second = JSON.parse(readFileSync(h.sessionPath())).pending;
  await assert.rejects(restarted.event('STEP_COMPLETED',{step_id:'test',exit_code:0}),errorCode('pending'));
  assert.equal((await restarted.event(null)).disposition,'idempotent'); assert.equal(h.store.listEvents(h.principal,pending.run_id).length,2);
  assert.deepEqual(h.attempts,[pending,pending,second,second]); assert.equal(JSON.parse(readFileSync(h.sessionPath())).pending,null);
});

test('machine identity and session survive moving a consumer; corrupt state and concurrent mutation never silently reset', async t => {
  const h = await harness(t); await h.client.register(); const started = await h.client.start(21), original = readFileSync(join(h.config.state_directory,'machine.json'),'utf8');
  const moved = join(h.base,'relocated'); renameSync(h.repo,moved); const client = new AwhClient(h.configPath,moved); assert.equal((await client.status()).run.id,started.run.id);
  assert.equal(readFileSync(join(h.config.state_directory,'machine.json'),'utf8'),original);
  const path = h.sessionPath(); writeFileSync(path + '.lock',''); await assert.rejects(client.event('RUN_FAILED',{reason:'test'}),errorCode('busy'));
  assert.equal(h.store.listEvents(h.principal,started.run.id).length,1);
  const valid = readFileSync(path,'utf8'); writeFileSync(path,valid.replace('client-executor','foreign-executor')); await assert.rejects(client.status(),errorCode('state')); assert.equal(readFileSync(path,'utf8'),valid.replace('client-executor','foreign-executor'));
  writeFileSync(join(h.config.state_directory,'machine.json'),'{}'); assert.throws(() => machine(readConfig(h.configPath,moved)),errorCode('machine'));
});

test('ambiguous trusted versions require explicit external selection; Manifest never uploads policy', async t => {
  const policy = fixture('webskill').profile_policy, h = await harness(t,{policies:[policy,{...policy,version:'fixture-v2'}]}); await h.client.register();
  await assert.rejects(h.client.start(21),errorCode('profile')); h.updateConfig({profile_version:'fixture-v2'}); assert.equal((await h.client.start(21)).run.profile.version,'fixture-v2');
  for (const type of ['GITHUB_PR_CREATED','HANDOFF_PUBLISHED','REVIEW_PASSED','RUN_COMPLETED','MERGE']) await assert.rejects(h.client.event(type,{}),errorCode('event_type'));
  await assert.rejects(h.client.event('RUN_FAILED',{reason:'awh_cp_' + randomBytes(32).toString('base64url')})); assert.equal(h.store.latestCursor(),1);
});

test('auth scopes never fall back, network failure is explicit and CLI suppresses credentials/remote bodies', async t => {
  const h = await harness(t), cli = join(root,'dist/client/cli.js'); writeFileSync(h.config.credential_file,h.foreignToken);
  const failed = await runCli(cli,['--config',h.configPath,'register'],h.repo,{ ...cleanEnv(), GH_TOKEN:h.token, GITHUB_TOKEN:h.token }); assert.equal(failed.code,2);
  assert.equal(JSON.parse(failed.stderr).error.code,'authentication'); assert(!failed.stdout.includes(h.token) && !failed.stderr.includes(h.foreignToken)); assert.equal(h.store.listProjects(h.principal).length,0);
  const dead = createServer(); await new Promise(r => dead.listen(0,'127.0.0.1',r)); const port = dead.address().port; await new Promise(r => dead.close(r));
  writeFileSync(h.config.credential_file,h.token); h.updateConfig({endpoint:`http://127.0.0.1:${port}`}); await assert.rejects(h.client.register(),errorCode('network'));
  let destinationRequests = 0; const destination = createServer((req,res) => { destinationRequests++; res.end('{}'); }); await new Promise(r => destination.listen(0,'127.0.0.1',r)); t.after(() => new Promise(r => destination.close(r)));
  const redirect = createServer((req,res) => { res.writeHead(307,{location:`http://127.0.0.1:${destination.address().port}`}); res.end(h.token); }); await new Promise(r => redirect.listen(0,'127.0.0.1',r)); t.after(() => new Promise(r => redirect.close(r)));
  h.updateConfig({endpoint:`http://127.0.0.1:${redirect.address().port}`}); await assert.rejects(h.client.register(),errorCode('http')); assert.equal(destinationRequests,0);
  for (const args of [['deliver'],['register','--repo','evil/repo'],['start','--issue','1','--issue','2'],['event','--retry','--type','MERGE'],['finish','--outcome','pass','--data','file']]) {
    const r = await runCli(cli,['--config',h.configPath,...args],h.repo); assert.equal(r.code,2); assert.equal(JSON.parse(r.stderr).error.code,'arguments');
  }
});

test('local package installs offline with bundled runtime and real bin; full CLI journey from consumer without Hub source resolution', async t => {
  const h = await harness(t), output = join(h.base,'packages');
  const pack = spawnSync(process.execPath,[join(root,'scripts/client-pack.mjs'),'--output',output],{cwd:root,encoding:'utf8',env:cleanEnv(),timeout:60000,windowsHide:true});
  assert.equal(pack.status,0,pack.stderr); const artifact = JSON.parse(pack.stdout); assert.equal(artifact.version,CLIENT_VERSION); assert.equal(artifact.published_to_registry,false);
  const prefix = join(h.base,'installation'); mkdirSync(prefix); writeFileSync(join(prefix,'package.json'),'{"private":true}');
  const installed = spawnSync(process.execPath,[npmEntry(),'install','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund',artifact.artifact],{cwd:prefix,env:npmEnv(join(h.base,'npm-cache')),encoding:'utf8',timeout:60000,windowsHide:true});
  assert.equal(installed.status,0,'Independent offline installation failed');
  const packageRoot = join(prefix,'node_modules/@zlpoot/awh-client'), cli = join(packageRoot,'dist/client/cli.js');
  assert.equal(JSON.parse(readFileSync(join(packageRoot,'package.json'))).version,CLIENT_VERSION); assert(!artifact.files.some(f => /builder|control-plane\/(store|server)\.js/.test(f)));
  const shim = join(prefix,'node_modules/.bin/awh' + (process.platform === 'win32' ? '.cmd' : ''));
  const bin = process.platform === 'win32' ? spawnSync(process.env.ComSpec ?? 'cmd.exe',['/d','/s','/c',`""${shim}" --version"`],{cwd:h.repo,encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true}) : spawnSync(shim,['--version'],{cwd:h.repo,encoding:'utf8'});
  assert.equal(bin.status,0,bin.stderr); assert.equal(JSON.parse(bin.stdout).version,CLIENT_VERSION);
  // npm's Unix bin is a symlink. A Windows junction exercises the same argv/ESM path mismatch without admin privileges.
  const alias = join(h.base,'installed-cli-alias'); symlinkSync(dirname(cli),alias,process.platform === 'win32' ? 'junction' : 'dir');
  const linkedCli = join(alias,'cli.js');
  const linkedVersion = await runCli(linkedCli,['--version'],h.repo); assert.equal(linkedVersion.code,0,linkedVersion.stderr);
  assert.notEqual(linkedVersion.stdout.trim(),'','Symlinked installed CLI must execute its entry point');
  assert.equal(JSON.parse(linkedVersion.stdout).version,CLIENT_VERSION);
  const help = await runCli(linkedCli,['--help'],h.repo); assert.equal(help.code,0); assert.equal(JSON.parse(help.stdout).deliver,'unavailable until C1-D/#22');
  const invalid = await runCli(linkedCli,['deliver'],h.repo); assert.equal(invalid.code,2); assert.equal(JSON.parse(invalid.stderr).error.code,'arguments');
  const imported = await runCli('--input-type=module',['--eval',`await import(${JSON.stringify(new URL('../dist/client/cli.js',import.meta.url).href)})`],h.repo);
  assert.equal(imported.code,0,imported.stderr); assert.equal(imported.stdout,''); assert.equal(imported.stderr,'');
  const invoke = async args => { const r = await runCli(linkedCli,args,h.repo); assert.equal(r.code,0,r.stderr); assert(!r.stdout.includes(h.token)); return JSON.parse(r.stdout); };
  unlinkSync(join(h.repo,'.awh/project.yaml'));
  await invoke(['init','--profile',fixture('webskill').manifest.profile.ref]); await invoke(['--config',h.configPath,'register']); const started = await invoke(['--config',h.configPath,'start','--issue','21']);
  const payload = join(h.base,'event.json'); writeFileSync(payload,JSON.stringify({step_id:'installed',name:'Installed CLI smoke test'})); await invoke(['--config',h.configPath,'event','--type','STEP_STARTED','--data',payload]);
  assert.equal((await invoke(['--config',h.configPath,'status'])).run.id,started.run.id);
  writeFileSync(payload,JSON.stringify({reason:'Controlled installation test; no delivery/Review'})); assert.equal((await invoke(['--config',h.configPath,'finish','--outcome','failed','--data',payload])).run.state,'failed');
});

test('symlinked identity/configuration paths cannot inject project-local state', async t => {
  const h = await harness(t), redirect = join(h.base,'redirect');
  try { symlinkSync(h.repo,redirect,process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (['EPERM','EACCES'].includes(e.code)) { t.skip('OS does not permit symlink creation'); return; } throw e; }
  h.updateConfig({state_directory:join(redirect,'state')}); await assert.rejects(h.client.register(),errorCode('configuration'));
});

test('native verified HTTPS and loopback HTTP share Registry, Run history, credentials and scopes', async t => {
  const h = await harness(t), tls = tlsFixture(), caPath = join(h.base,'ca.pem'); writeFileSync(caPath,tls.ca);
  await h.client.register(); const started = await h.client.start(21);
  const secure = createControlPlaneServer({store:h.store,authenticate:createAuthenticator([{...h.principal,token_sha256:createHash('sha256').update(h.token).digest('hex')}]),tls});
  await new Promise(r=>secure.server.listen(0,'127.0.0.1',r)); t.after(()=>secure.close());
  const original = {...h.config}; h.updateConfig({endpoint:`https://127.0.0.1:${secure.server.address().port}`,ca_certificate_file:caPath});
  const registered = await h.client.register(); assert.equal(registered.executor.machine.id,h.store.getRun(h.principal,started.run.id).machine_id);
  await assert.rejects(requestJson(h.config.endpoint.replace('https:','http:'),'/v1/projects',h.token,'GET'),errorCode('network'));
  assert.equal((await requestJson(h.config.endpoint,'/v1/runs/'+started.run.id,h.token,'GET',undefined,tls.ca)).run.id,started.run.id);
  const newRun=await h.client.start(21);await h.client.event('STEP_STARTED',{step_id:'tls',name:'TLS reporting'});await h.client.event('STEP_COMPLETED',{step_id:'tls',exit_code:0});await h.client.finish(true,{reason:'Controlled TLS run'});
  const retained=await fetch(h.cp+'/v1/runs/'+newRun.run.id+'/events',{headers:{authorization:'Bearer '+h.token}});
  assert.deepEqual((await retained.json()).events.map(x=>x.event.sequence),[1,2,3,4]);
  // Endpoint changes are not migrations: old state remains byte-identical, and #27 must fix this before cutover.
  assert.equal((await h.client.status()).run.id,newRun.run.id);
  assert.equal(h.store.getRun(h.principal,started.run.id).state,'running');
  h.updateConfig(original); delete h.config.ca_certificate_file; h.updateConfig({});
  assert.equal((await h.client.status()).run.id,started.run.id);
});

for (const failure of ['untrusted','default-ca','wrong-ip','expired','down']) test(`TLS ${failure} fails before authenticated HTTP and never leaks credentials or falls back`, async t => {
  const h = await harness(t), tls = tlsFixture({ip:failure==='wrong-ip'?'192.168.2.99':'127.0.0.1',expired:failure==='expired'});
  const secure = createControlPlaneServer({store:h.store,authenticate:createAuthenticator([{...h.principal,token_sha256:createHash('sha256').update(h.token).digest('hex')}]),tls});
  let authenticated = 0; secure.server.on('request',()=>authenticated++);
  await new Promise(r=>secure.server.listen(0,'127.0.0.1',r)); const port = secure.server.address().port; t.after(()=>secure.close());
  if(failure==='down') await secure.close();
  const caPath=join(h.base,'ca.pem');writeFileSync(caPath,failure==='untrusted'?tlsFixture().ca:tls.ca);
  h.updateConfig({endpoint:`https://127.0.0.1:${port}`,ca_certificate_file:caPath});
  if(failure==='default-ca'){delete h.config.ca_certificate_file;h.updateConfig({});}
  const failed=await runCli(join(root,'dist/client/cli.js'),['--config',h.configPath,'register'],h.repo);
  assert.equal(failed.code,2);assert.equal(JSON.parse(failed.stderr).error.code,'network');
  assert(!failed.stderr.includes(h.token));assert(!failed.stdout.includes(h.token));assert.equal(authenticated,0);assert.equal(h.requests,0);
  assert.equal(h.store.listProjects(h.principal).length,0);
});

test('explicit CA is external, public-only, current and per HTTPS endpoint; no TLS environment bypass', async t => {
  const h=await harness(t), tls=tlsFixture(), path=join(h.base,'ca.pem');writeFileSync(path,tls.ca);
  h.updateConfig({ca_certificate_file:path});await assert.rejects(h.client.register(),errorCode('configuration'));
  h.updateConfig({endpoint:'https://127.0.0.1:1'});
  for(const invalid of [tls.key,Buffer.concat([tls.ca,tls.key]),tls.cert,tlsFixture({caExpired:true}).ca]){
    writeFileSync(path,invalid);await assert.rejects(h.client.register(),errorCode('certificate'));
  }
  const inside=join(h.repo,'ca.pem');writeFileSync(inside,tls.ca);h.updateConfig({ca_certificate_file:inside});await assert.rejects(h.client.register(),errorCode('configuration'));
  const otherRepo=consumer(h.base,'other-ca-repo');const otherCa=join(otherRepo,'ca.pem');writeFileSync(otherCa,tls.ca);h.updateConfig({ca_certificate_file:otherCa});await assert.rejects(h.client.register(),errorCode('configuration'));
  h.updateConfig({ca_certificate_file:path});writeFileSync(path,tls.ca);
  const failed=await runCli(join(root,'dist/client/cli.js'),['--config',h.configPath,'register'],h.repo,{...cleanEnv(),NODE_TLS_REJECT_UNAUTHORIZED:'0'});
  assert.equal(failed.code,2);assert.equal(JSON.parse(failed.stderr).error.code,'endpoint');assert(!failed.stderr.includes(h.token));assert.equal(h.requests,0);
});

test('endpoint cutover is blocked operationally: retained pending bytes and machine identity recover losslessly at original endpoint', async t => {
  const h=await harness(t,{proxy:true});await h.client.register();h.fault('lost');await assert.rejects(h.client.start(21));
  const originalEndpoint=h.config.endpoint,path=h.sessionPath(),pending=readFileSync(path),identity=readFileSync(join(h.config.state_directory,'machine.json'));
  h.updateConfig({endpoint:h.cp});assert.equal((await new AwhClient(h.configPath,h.repo).status()).run,null);
  assert(pending.equals(readFileSync(path)));assert(identity.equals(readFileSync(join(h.config.state_directory,'machine.json'))));
  h.updateConfig({endpoint:originalEndpoint});const restored=new AwhClient(h.configPath,h.repo);
  assert.equal((await restored.status()).pending_event.id,JSON.parse(pending).pending.id);
  const replay=await restored.start(21);assert.equal(replay.disposition,'idempotent');assert.equal(h.store.listEvents(h.principal,replay.run.id).length,1);
  assert.deepEqual(replay.event,JSON.parse(pending).pending);assert(identity.equals(readFileSync(join(h.config.state_directory,'machine.json'))));
});
