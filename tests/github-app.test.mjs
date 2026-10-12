import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { GithubApp, protectedAppPath } from '../dist/workflow/github-app.js';
import { githubAppMain } from '../dist/workflow/github-app-cli.js';
import { LocalFast } from '../dist/workflow/local-fast.js';
import { selectReview, ReviewBridge } from '../dist/workflow/local-fast-review.js';
import { LocalFastWatcher } from '../dist/workflow/local-fast-watcher.js';
import { githubTransport } from '../dist/workflow/local-fast-github.js';
import { harness, repository, options } from './helpers/local-fast-harness.mjs';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const bot = { id: 77, login: 'synthetic-builder[bot]', type: 'Bot' };
const reviewer = { id: 11, login: 'synthetic-owner', type: 'User' };
const head = 'a'.repeat(40), old = 'b'.repeat(40);
const denied = e => e.code === 'github_app';
function fixture(t, h, overrides = {}) {
  const base = mkdtempSync(join(tmpdir(), 'awh-app-test-'));
  const key = join(base, 'test.pem'), configPath = join(base, 'connection.json');
  writeFileSync(key, pem, { mode: 0o600 });
  t.after(() => { const target = realpathSync(base); assert(relative(realpathSync(tmpdir()), target).startsWith('awh-app-test-')); rmSync(target, { recursive: true, force: true }); });
  const calls = [], spawnCalls = [], mutate = new Map();
  let now = Date.parse('2026-10-12T12:00:00Z'), loseAck = false, invisible = false, creates = 0, failPush = false, unsafeKeys = '', expireOnInspection = false;
  const response = v => new Response(JSON.stringify(v));
  const fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search, body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body });
    assert.equal(init.redirect, 'error'); assert(url.startsWith('https://api.github.com/'));
    let v;
    if (path === '/app') v = { id: 5, slug: 'synthetic-builder' };
    else if (path.endsWith('/installation')) v = { id: 9, app_id: 5, app_slug: 'synthetic-builder', account: { id: 15, login: repository.split('/')[0], type: 'Organization' }, repository_selection: 'selected', suspended_at: null, permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } };
    else if (path.endsWith('/access_tokens')) {
      const write = Object.values(body.permissions).includes('write');
      if (write) assert.deepEqual(body.repository_ids, [42]);
      v = { token: 'ghs_syntheticOnly', expires_at: new Date(now + 3600000).toISOString(), permissions: { metadata: 'read', ...body.permissions }, ...(body.repository_ids ? { repositories: [{ id: 42, full_name: repository }] } : {}) };
    } else if (path.startsWith('/installation/repositories')) v = { total_count: 1, repositories: [{ id: 42, full_name: repository }] };
    else if (path.startsWith('/users/synthetic-builder')) v = bot;
    else if (path === '/users/synthetic-owner') v = reviewer;
    else if (path.includes('/git/ref/heads/')) v = { ref: 'refs/heads/' + path.split('/git/ref/heads/')[1], object: { sha: h?.readRef(path.split('/git/ref/heads/')[1]) ?? head } };
    else if (path.includes('/pulls?')) { const branch = new URL(url).searchParams.get('head').split(':')[1]; v = invisible ? [] : h?.prs.filter(p => p.head.ref === branch) ?? []; if (h) v.forEach(p => { p.head.sha = h.readRef(p.head.ref); }); }
    else if (path.endsWith('/pulls') && init.method === 'POST') {
      creates++;
      const number = 9 + creates;
      if (h && !invisible) h.prs.push({ number, node_id: `PR_${number}`, html_url: `https://github.com/${repository}/pull/${number}`, state: 'open', draft: true, user: bot, body: body.body,
        head: { ref: body.head, sha: h.readRef(body.head), repo: { id: 42 } }, base: { ref: 'main', sha: h.readRef('main'), repo: { id: 42 } },
        changed_files: h.git(['diff','--name-only',`${h.readRef('main')}...${h.readRef(body.head)}`]).split('\n').filter(Boolean).length });
      if (loseAck) { loseAck = false; throw new Error('server diagnostics with ghs_syntheticOnly and ' + pem); }
      v = h?.prs.at(-1) ?? { number };
    } else if (path === '/graphql') {
      assert.equal(body.query, 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}');
      h.prs.find(p => p.node_id === body.variables.id).draft = true; v = { data: { convertPullRequestToDraft: { pullRequest: { id: body.variables.id, isDraft: true } } } };
    } else if (/\/pulls\/\d+$/.test(path)) { v = h.prs.find(p => p.number === Number(path.split('/').at(-1))); v.head.sha = h.readRef(v.head.ref); if (init.method === 'PATCH') { v.body = body.body; } }
    else throw new Error('Unexpected API request ' + path);
    if (mutate.has(path)) { const change = mutate.get(path); v = typeof change === 'function' ? change(structuredClone(v), body) : change; }
    return response(v);
  };
  const app = new GithubApp({ configPath, fetch, now: () => now, protect: () => {}, spawn(command, args, settings) {
    spawnCalls.push({ command, args, settings: { ...settings, env: { ...settings.env } } });
    assert.equal(command, 'git');
    if (args[0] === 'config' && expireOnInspection) now += 3600001;
    if (args[0] === 'config' && unsafeKeys) return { status: 0, stdout: unsafeKeys, stderr: '' };
    if (args[0] === 'push' && failPush) return { status: 1, stderr: 'ghs_syntheticOnly', stdout: '' };
    const translated = h && args[0] === 'push' ? ['push', '--no-follow-tags', '--recurse-submodules=no', h.remote, args.at(-1)] : args;
    return { status: 0, stdout: h ? h.git(translated, settings.cwd) : args[0] === 'config' ? '' : args[0] === 'branch' ? 'codex/local-fast-1' : args[0] === 'rev-parse' ? head : '', stderr: '' };
  }, ...overrides });
  const connect = () => app.connect({ app_id: 5, app_slug: 'synthetic-builder', private_key_path: key, repositories: [repository], reviewer: reviewer.login }, true);
  return { app, connect, key, configPath, calls, spawnCalls, mutate, advance(ms) { now += ms; }, loseAck() { loseAck = true; }, invisible(v) { invisible = v; }, creates: () => creates, failPush(v) { failPush = v; }, unsafeKeys(v) { unsafeKeys = v; }, expireOnInspection() { expireOnInspection = true; } };
}

test('one-time connect discovers installation, resolves real Bot/User IDs, stores only external references; preflight is read-only', async t => {
  const f = fixture(t);
  assert.equal(f.app.status().status, 'NOT_CONNECTED');
  assert.equal((await f.connect()).status, 'CONNECTED_LOCAL');
  const saved = readFileSync(f.configPath, 'utf8'); assert(!saved.includes(pem)); assert(!saved.includes('ghs_'));
  assert.equal(JSON.parse(saved).installation_id, 9); assert.equal(JSON.parse(saved).delivery_actor.id, 77);
  assert.deepEqual((await f.app.preflight(repository)).binding.reviewer, reviewer);
  assert(!f.calls.some(c => c.method !== 'GET' && !c.path.endsWith('/access_tokens')));
  assert(f.calls.filter(c => c.path.endsWith('/access_tokens')).every(c => !Object.values(c.body.permissions).includes('write')));
  assert.equal((await githubAppMain(['preflight','--repo',repository], f.app)).status, 'PREFLIGHT_PASS');
  await assert.rejects(f.connect()); assert.equal(readFileSync(f.configPath, 'utf8'), saved);
  await assert.rejects(githubAppMain(['exec','gh','api'], f.app), e => e.code === 'arguments');
});

describe('App connection and token boundaries', () => {
  const cases = [
    ['wrong App ID', '/app', v => ({ ...v, id: 6 })],
    ['wrong slug', '/app', v => ({ ...v, slug: 'other' })],
    ['wrong installation App', `/repos/${repository}/installation`, v => ({ ...v, app_id: 6 })],
    ['all repository scope', `/repos/${repository}/installation`, v => ({ ...v, repository_selection: 'all' })],
    ['wrong account', `/repos/${repository}/installation`, v => ({ ...v, account: { login: 'other' } })],
    ['suspended installation', `/repos/${repository}/installation`, v => ({ ...v, suspended_at: 'today' })],
    ['insufficient permission', `/repos/${repository}/installation`, v => ({ ...v, permissions: { metadata: 'read', contents: 'read' } })],
    ['wrong repository', '/installation/repositories?per_page=100&page=1', v => ({ ...v, repositories: [{ id: 43, full_name: 'other/repo' }] })],
    ['duplicate selected set', '/installation/repositories?per_page=100&page=1', v => ({ total_count: 2, repositories: [...v.repositories, ...v.repositories] })],
    ['expired token', '/app/installations/9/access_tokens', v => ({ ...v, expires_at: '2020-01-01T00:00:00Z' })],
    ['excess token permissions', '/app/installations/9/access_tokens', v => ({ ...v, permissions: { metadata: 'read', contents: 'write' } })],
    ['fake Bot type', '/users/synthetic-builder%5Bbot%5D', v => ({ ...v, type: 'User' })],
    ['fake personal Reviewer', '/users/synthetic-owner', v => ({ ...v, type: 'Bot' })]
  ];
  for (const [name,path,change] of cases) test(name, async t => { const f = fixture(t); f.mutate.set(path,change); await assert.rejects(f.connect(),denied); assert(!existsSync(f.configPath)); });
});

test('pinned installation/repository/Bot/Reviewer cannot silently change after connect', async t => {
  const f = fixture(t); await f.connect();
  for (const [path, change] of [[`/repos/${repository}/installation`, v => ({...v,id:10})], ['/installation/repositories?per_page=100&page=1', v => ({ ...v,repositories:[{id:43,full_name:repository}] })], ['/users/synthetic-builder%5Bbot%5D', v => ({...v,id:78})], ['/users/synthetic-owner',v => ({...v,id:12})]]) {
    f.mutate.set(path,change); await assert.rejects(f.app.preflight(repository),denied); f.mutate.clear();
  }
  await assert.rejects(f.app.preflight('other/repo'),denied);
  f.mutate.set('/app', () => { throw new Error('network private diagnostic ' + pem); });
  await assert.rejects(f.app.preflight(repository), e => denied(e) && !e.message.includes('PRIVATE KEY'));
});

test('complete selected-set pagination is inspected before narrowing; inconsistent or partial pages fail closed', async t => {
  const f = fixture(t); await f.connect();
  const repos = [{id:42,full_name:repository}, ...Array.from({length:100},(_,i)=>({id:100+i,full_name:`synthetic-org/repo-${i}`}))];
  const saved = JSON.parse(readFileSync(f.configPath)); saved.repositories = repos;
  writeFileSync(f.configPath,JSON.stringify(saved));
  const first = '/installation/repositories?per_page=100&page=1', second = '/installation/repositories?per_page=100&page=2';
  f.mutate.set(first,{total_count:101,repositories:repos.slice(0,100)}); f.mutate.set(second,{total_count:101,repositories:repos.slice(100)});
  assert.equal((await f.app.preflight(repository)).binding.repository_id,42);
  assert(f.calls.some(c=>c.path===second));
  for (const v of [{total_count:100,repositories:repos.slice(100)},{total_count:101,repositories:[]},{total_count:101,repositories:[repos[0]]}]) { f.mutate.set(second,v); await assert.rejects(f.app.preflight(repository),denied); }
  assert(!f.calls.some(c=>c.body?.repository_ids));
});

test('operation-minimum single-repository push/PR tokens and no persistent credentials or hooks', async t => {
  const f = fixture(t); await f.connect(); const delivery = await f.app.preflight(repository);
  await delivery.push(process.cwd(), 'codex/local-fast-1', head); await delivery.pulls('codex/local-fast-1'); await delivery.create('codex/local-fast-1','title','body');
  const operations = f.calls.filter(c => c.path.endsWith('/access_tokens') && c.body.repository_ids);
  assert.deepEqual(operations.map(c => c.body.permissions), [{contents:'write'}, {pull_requests:'read'}, {pull_requests:'write'}]);
  assert(operations.every(c => c.body.repository_ids.length === 1 && c.body.repository_ids[0] === 42));
  const pushed = f.spawnCalls.find(c => c.args[0] === 'push'); assert.equal(pushed.args[3], `https://github.com/${repository}.git`);
  assert(pushed.args.includes('--no-follow-tags')); assert(pushed.args.includes('--recurse-submodules=no'));
  assert(!pushed.args.join(' ').includes('ghs_')); assert(!pushed.settings.env.GH_TOKEN); assert(!pushed.settings.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH);
  assert.equal(pushed.settings.env.GIT_CONFIG_VALUE_2, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert(!f.spawnCalls.some(c => c.args[0] === 'config' && !c.args.includes('--name-only')));
  assert.equal(f.app.inspect,undefined); assert.equal(f.app.d,undefined);
  f.mutate.set('/app/installations/9/access_tokens', (v,b) => b.repository_ids ? {...v,repositories:[{id:43,full_name:repository}]} : v);
  await assert.rejects(delivery.create('codex/local-fast-1','title','body'), denied);
  f.mutate.clear();
  f.mutate.set('/app/installations/9/access_tokens',(v,b)=>b.repository_ids ? {...v,expires_at:'2020-01-01T00:00:00Z'} : v);
  await assert.rejects(delivery.create('codex/local-fast-1','title','body'),denied);
});

test('transport refuses executable/redirecting Git configuration and expiry during inspection before push', async t => {
  const f = fixture(t); await f.connect(); const d = await f.app.preflight(repository);
  for (const key of ['url.evil.insteadof','http.extraheader','credential.helper','include.path','core.fsmonitor','filter.evil.clean',
    'core.askPass','CORE.ASKPASS','gpg.program','gpg.ssh.program','push.gpgSign','remote.origin.vcs','remote.origin.receivepack','remote.origin.uploadpack']) {
    f.unsafeKeys(key); await assert.rejects(d.push(process.cwd(),'codex/local-fast-1',head),denied);
  }
  f.unsafeKeys(''); f.expireOnInspection(); await assert.rejects(d.push(process.cwd(),'codex/local-fast-1',head),denied);
  assert(!f.spawnCalls.some(c=>c.args[0]==='push'));
});

function isolatedAskPassGit(t, overrides = {}) {
  const f = fixture(t, undefined, overrides), base = dirname(f.configPath), repo = join(base, 'repo'); mkdirSync(repo);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(GIT_|GH_|GITHUB_|AWH_|NODE_|SSH_)/i.test(k)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform === 'win32' ? 'NUL' : '/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'',SSH_ASKPASS:''});
  const git = args => {
    const r = spawnSync('git',args,{cwd:repo,env,encoding:'utf8',windowsHide:true,timeout:15000});
    assert(!r.error && r.status === 0,'isolated Git setup failed; diagnostics suppressed'); return r.stdout.trim();
  };
  git(['init','-b','codex/local-fast-1']); git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','-m','Synthetic baseline']);
  const marker = join(base,'askpass-marker'), helper = join(base,process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
  const escapedMarker = marker.replaceAll('\\','/').replaceAll("'", "'\\''");
  writeFileSync(helper,process.platform === 'win32' ? `@echo off\r\necho invoked>>"${marker}"\r\nif defined GIT_CONFIG_VALUE_3 echo inherited-auth-environment>>"${marker}"\r\necho synthetic-credential\r\n` :
    `#!/bin/sh\nprintf 'invoked\\n' >> '${escapedMarker}'\nif [ -n "$GIT_CONFIG_VALUE_3" ]; then printf 'inherited-auth-environment\\n' >> '${escapedMarker}'; fi\nprintf 'synthetic-credential\\n'\n`);
  chmodSync(helper,0o700);
  return { ...f,repo,env,git,marker,helper,sha:git(['rev-parse','HEAD']) };
}

for (const scope of ['local','worktree']) test(`askPass ${scope} configuration is rejected before an authenticated Git child`, {timeout:90000}, async t => {
  let isolated; const spawned = [];
  isolated = isolatedAskPassGit(t,{spawn(command,args,settings){spawned.push({args,env:{...settings.env}});return spawnSync(command,args,settings);}});
  if (scope === 'worktree') isolated.git(['config','extensions.worktreeConfig','true']);
  isolated.git(['config',`--${scope}`,'core.askPass',isolated.helper.replaceAll('\\','/')]);
  await isolated.connect(); const d = await isolated.app.preflight(repository);
  await assert.rejects(d.push(isolated.repo,'codex/local-fast-1',isolated.sha),denied);
  assert(spawned.some(c=>c.args[0]==='config'));
  assert(!spawned.some(c=>c.args[0]==='push'));
  assert(spawned.every(c=>!Object.values(c.env).some(v=>typeof v==='string' && v.startsWith('AUTHORIZATION: basic '))));
  assert(!existsSync(isolated.marker));
});

async function authChallenge(t) {
  const source = `const {createServer}=require('node:http');const server=createServer((req,res)=>{req.resume();process.send({kind:'request'});res.writeHead(401,{'WWW-Authenticate':'Basic realm="synthetic"','Content-Length':'0'});res.end();});server.listen(0,'127.0.0.1',()=>process.send({kind:'listening',port:server.address().port}));`;
  const child = spawn(process.execPath,['-e',source],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  let requests = 0;
  let requestObserved;
  const observed = new Promise(resolve=>{requestObserved=resolve;});
  const exited = new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{if(child.exitCode === null)child.kill();await exited;});
  const port = await new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>reject(new Error('isolated 401 server did not start')),10000);
    child.on('message',message=>{if(message.kind==='request'){requests++;requestObserved();}if(message.kind==='listening'){clearTimeout(timer);resolve(message.port);}});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('isolated 401 server failed'));});
  });
  return {url:`http://127.0.0.1:${port}/synthetic.git`,requests:()=>requests,waitForRequest:()=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('isolated endpoint received no request')),5000);
    observed.then(()=>{clearTimeout(timer);resolve();});
  })};
}

test('askPass 401 challenge cannot execute config or inherited helpers with the App token environment', {timeout:90000}, async t => {
  const server = await authChallenge(t), inherited = {...process.env};
  let isolated, rejectedPush;
  isolated = isolatedAskPassGit(t,{env:inherited,spawn(command,args,settings){
    if(args[0] !== 'push')return spawnSync(command,args,settings);
    assert.equal(args[3],`https://github.com/${repository}.git`);
    // Emulate a late config change; the production environment must still block it.
    isolated.git(['config','core.askPass',isolated.helper.replaceAll('\\','/')]);
    const localArgs=[...args];localArgs[3]=server.url;
    const env={...settings.env,NO_PROXY:'127.0.0.1',no_proxy:'127.0.0.1',GIT_CONFIG_KEY_3:`http.${server.url}.extraheader`};
    const result=spawnSync(command,localArgs,{...settings,env,timeout:10000});
    rejectedPush={args:localArgs,env,error:result.error?.code,status:result.status};
    return result;
  }});
  inherited.GIT_ASKPASS=isolated.helper; inherited.SSH_ASKPASS=isolated.helper; inherited.SSH_ASKPASS_REQUIRE='force';
  await isolated.connect(); const d=await isolated.app.preflight(repository);
  await assert.rejects(d.push(isolated.repo,'codex/local-fast-1',isolated.sha),denied);
  assert(rejectedPush); assert.equal(rejectedPush.env.GIT_ASKPASS,''); assert.equal(rejectedPush.env.SSH_ASKPASS,''); assert.equal(rejectedPush.env.SSH_ASKPASS_REQUIRE,'never');
  assert.equal(rejectedPush.env.GIT_CONFIG_KEY_4,'core.askPass'); assert.equal(rejectedPush.env.GIT_CONFIG_VALUE_4,'');
  assert.equal(rejectedPush.error,undefined); assert.notEqual(rejectedPush.status,0);
  await server.waitForRequest();assert(server.requests()>0);
  assert(!existsSync(isolated.marker),'401 must not execute any askPass helper');
  // Positive control proves this endpoint/helper can reproduce the reviewed leak,
  // using only the fixture's fake token and recording presence, never its value.
  const controlEnv={...rejectedPush.env,GIT_CONFIG_COUNT:'4'};
  delete controlEnv.GIT_ASKPASS;delete controlEnv.SSH_ASKPASS;delete controlEnv.SSH_ASKPASS_REQUIRE;
  delete controlEnv.GIT_CONFIG_KEY_4;delete controlEnv.GIT_CONFIG_VALUE_4;
  const control=spawnSync('git',rejectedPush.args,{cwd:isolated.repo,env:controlEnv,encoding:'utf8',windowsHide:true,timeout:10000});
  assert(!control.error && control.status !== 0,'positive 401 control must complete with authentication failure');
  assert(existsSync(isolated.marker),'positive control must invoke the benign helper');
  assert.match(readFileSync(isolated.marker,'utf8'),/inherited-auth-environment/);
});

test('trusted personal exact-head native decisions only; latest dismissal/old head invalidates PASS', () => {
  const r = (id, user = reviewer, state = 'APPROVED', sha = head) => ({ id, user, state, commit_id: sha, body: '' });
  assert.equal(selectReview([r(1)],bot.id,head,reviewer).decision,'PASS');
  assert.equal(selectReview([r(1),r(2,reviewer,'CHANGES_REQUESTED')],bot.id,head,reviewer).decision,'REQUEST_CHANGES');
  for (const user of [bot,{...reviewer,id:22},{...reviewer,login:'imposter'},{...reviewer,type:'Bot'}]) assert.equal(selectReview([r(1,user)],bot.id,head,reviewer),undefined);
  for (const state of ['COMMENTED','DISMISSED','PENDING']) assert.equal(selectReview([r(1,reviewer,state)],bot.id,head,reviewer),undefined);
  assert.equal(selectReview([r(1),r(2,reviewer,'DISMISSED')],bot.id,head,reviewer),undefined);
  assert.equal(selectReview([r(1),r(2,reviewer,'APPROVED',old)],bot.id,head,reviewer),undefined);
  assert.equal(selectReview([r(1)],bot.id,old,reviewer),undefined);
  assert.equal(selectReview([r(1),r(2,{...reviewer,login:'imposter'})],bot.id,head,reviewer),undefined);
});

function appWorkflow(t) {
  const h = harness(t), f = fixture(t,h);
  const run = h.deps.run;
  h.deps.run = (command,args,cwd,input) => {
    const value = run(command,args,cwd,input);
    if (command === 'gh' && args.at(-1).includes('/reviews') && !args.at(-1).includes('/comments')) {
      const data = JSON.parse(value), list = args.includes('--slurp') ? data.flat() : [data];
      for (const r of list) r.user = r.user.id === reviewer.id ? reviewer : r.user.id === bot.id ? bot : { ...reviewer,id:r.user.id };
      return JSON.stringify(data);
    }
    return value;
  };
  h.deps.app = f.app;
  const client = (cwd = h.repo) => new LocalFast(cwd,h.deps);
  return {h,f,client};
}

test('actual App provider simulated Stage: bot publication, same PR repair/new HEAD, completed queue preserved', {timeout:180000}, async t => {
  const {h,f,client} = appWorkflow(t); await f.connect();
  await client().bind(repository,'1',true,['node --test tests/smoke.test.mjs'],'github-app');
  const ready = await client().flow(true), active = client(ready.worktree);
  writeFileSync(join(ready.worktree,'code.txt'),'app candidate\n'); const first = await active.execute(options);
  assert.deepEqual(first.delivery_actor,bot); assert.equal(first.coding_executor.type,'codex-cli'); assert.equal(f.creates(),1);
  h.review(10,'APPROVED',22); assert.equal((await active.flow()).review,undefined);
  h.review(10,'COMMENTED',11); assert.equal((await active.flow()).review,undefined);
  h.review(10,'CHANGES_REQUESTED',11); assert.equal((await active.flow()).status,'REQUEST_CHANGES');
  h.prs[0].draft = false; writeFileSync(join(ready.worktree,'code.txt'),'app fixed\n');
  const fixed = await active.execute(options); assert.equal(fixed.pr_url,first.pr_url); assert.notEqual(fixed.head,first.head); assert.equal(f.creates(),1); assert(h.prs[0].draft);
  assert.equal((await active.flow()).review,undefined); h.review(10,'APPROVED',11); assert.equal((await active.flow()).review.decision,'PASS');
  h.merge(10); assert.equal((await active.flow(true)).status,'QUEUE_COMPLETED'); const history = readFileSync(h.statePath,'utf8');
  assert.equal((await active.flow()).status,'QUEUE_COMPLETED'); assert.equal(readFileSync(h.statePath,'utf8'),history);
  assert(!h.calls.some(c => c.command === 'gh' && c.args[0] === 'pr' && ['create','edit','ready'].includes(c.args[1])));
  assert(!h.calls.some(c => c.command === 'git' && c.args[0] === 'push'));
});

test('lost create ACK readback recovers one PR; absent uncertain ACK stays BLOCKED across restart', {timeout:180000}, async t => {
  const {h,f,client} = appWorkflow(t); await f.connect(); await client().bind(repository,'1',true,[],'github-app');
  const ready = await client().flow(true); writeFileSync(join(ready.worktree,'code.txt'),'candidate\n');
  f.loseAck(); await assert.rejects(client(ready.worktree).execute(options),denied); assert.equal(f.creates(),1);
  f.invisible(true); await assert.rejects(client(ready.worktree).execute(options), e => e.code === 'local_fast_pr_ack_unknown'); assert.equal(f.creates(),1);
  f.invisible(false); const resumed = await client(ready.worktree).execute(options); assert.equal(resumed.pr_url,h.prs[0].html_url); assert.equal(f.creates(),1);
});

test('App push failure retains candidate; no personal fallback; retry checks exact head and author', {timeout:180000}, async t => {
  const {h,f,client} = appWorkflow(t); await f.connect(); await client().bind(repository,'1',true,[],'github-app');
  const ready = await client().flow(true); writeFileSync(join(ready.worktree,'code.txt'),'candidate\n');
  f.failPush(true); await assert.rejects(client(ready.worktree).execute(options),denied);
  assert.equal(JSON.parse(readFileSync(h.statePath)).tasks[0].phase,'publishing'); assert.equal(h.prs.length,0);
  f.failPush(false); await client(ready.worktree).execute(options);
  const good = h.prs[0].user;
  for (const user of [reviewer,{...bot,id:78},{...bot,login:'other[bot]'},{...bot,type:'User'}]) { h.prs[0].user=user; await assert.rejects(client(ready.worktree).flow(),e=>e.code==='local_fast_pr_scope'); }
  h.prs[0].user=good; f.mutate.set('/app', v=>({...v,id:6})); await assert.rejects(client(ready.worktree).execute(options),denied);
  assert(!h.calls.some(c=>c.command==='gh' && c.args[0]==='pr' && c.args[1]==='create'));
});

test('App Watcher preserves allow_merge and advances only its bounded queue after trusted native Review', {timeout:240000}, async t => {
  const {h,f,client} = appWorkflow(t); await f.connect(); await client().bind(repository,'1,2',true,[],'github-app');
  const ready = await client().flow(true); writeFileSync(join(ready.worktree,'code.txt'),'first app issue\n'); await client(ready.worktree).execute(options);
  let launches = 0;
  const watcher = (label,allowMerge) => {
    const localData = realpathSync(dirname(f.configPath)); const childData = join(localData,label); mkdirSync(childData);
    const w = new LocalFastWatcher(h.repo,{platform:'win32',localData:childData,interactive:true,now:()=>Date.parse('2026-10-12T12:00:00Z'),fast:h.deps,
      github:githubTransport(h.repo,h.deps.run),executor:{type:'codex-cli',async run(request,started){launches++;started(99999999);writeFileSync(join(request.task.worktree,'code.txt'),'next bounded issue\n');return {exit_code:0};}},alive:()=>false});
    w.authorize(repository,'1,2','2026-10-13T00:00:00Z',realpathSync(process.execPath),allowMerge,true);
    return w;
  };
  const blocked = watcher('wait-human',false), allowed = watcher('authorized',true);
  h.review(10,'APPROVED',22); assert.equal((await allowed.run(true)).next_action,'AWAITING_INDEPENDENT_REVIEW');
  h.review(10,'APPROVED',11); assert.equal((await blocked.run(true)).next_action,'AWAIT_HUMAN_MERGE'); assert.equal(launches,0); assert(!h.prs[0].merged_at);
  assert.equal((await allowed.run(true)).status,'MERGE_CONFIRMED');
  const next = await allowed.run(true); assert.equal(next.issue,2); assert.equal(launches,1); assert.equal(f.creates(),2);
  h.review(11,'APPROVED',11); assert.equal((await allowed.run(true)).status,'MERGE_CONFIRMED');
  const complete = await allowed.run(true); assert.equal(complete.status,'QUEUE_COMPLETED'); assert.deepEqual(complete.completed,[1,2]); assert.equal(complete.merge_count,2);
  assert.equal(h.prs.length,2); assert(!h.calls.some(c=>c.command==='gh' && c.args[0]==='pr' && c.args[1]==='create'));
});

test('App Review Bridge requires saved personal id/login and always publishes native events', {timeout:120000}, async t => {
  const {h,f,client} = appWorkflow(t); await f.connect(); await client().bind(repository,'1',true,[],'github-app');
  const ready = await client().flow(true); writeFileSync(join(ready.worktree,'code.txt'),'reviewable app candidate\n'); const candidate = await client(ready.worktree).execute(options);
  const bridge = new ReviewBridge(githubTransport(h.repo,h.deps.run),repo=>f.app.binding(repo)), context = bridge.prepare(candidate.pr_url);
  assert.equal(context.delivery.delivery_actor.type,'Bot');
  h.user(22); assert.equal(bridge.publish(context,'PASS','independent report').status,'REVIEW_NOT_PUBLISHED');
  h.user(11); const requested = bridge.publish(context,'REQUEST_CHANGES','fix the current candidate'); assert.equal(requested.native_state,'CHANGES_REQUESTED');
  const approved = bridge.publish(context,'PASS','independent exact head report'); assert.equal(approved.status,'REVIEW_PUBLISHED_PASS'); assert.equal(approved.native_state,'APPROVED');
  assert.equal((await client(ready.worktree).flow()).review.reviewer.id,11);
});

test('credential paths cannot point into repository', t => {
  assert.throws(()=>protectedAppPath(process.cwd()));
  const f = fixture(t); writeFileSync(f.key,'unusable');
  return assert.rejects(f.connect(),denied);
});
