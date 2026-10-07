import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBuilder, createJwt, BRANCH, REPO } from '../dist/builder.js';
import { PROFILES, selectWorkflow, allowedInstallation, HUB_REPO, FUTURE_REPO, WEBSKILL_REPO } from '../dist/profiles.js';

// Ephemeral key generated in memory; no real credential and no saved key fixture.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const now = 1800000000123;
const permissions = { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' };
const inspectionPermissions = { metadata: 'read' };
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const actor = 'test-builder[bot]';
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const pr = { number: 5, user: { login: actor, type: 'Bot' }, head: { sha: head, ref: BRANCH, repo: { full_name: REPO } },
  base: { sha: base, ref: 'main', repo: { full_name: REPO } }, draft: true, state: 'open', node_id: 'PR_test' };
const comment = (id, body, repo = REPO) => ({ id, body, user: { login: actor, type: 'Bot' }, issue_url: `https://api.github.com/repos/${repo}/issues/5` });
const record = { schema_version: '0.1', kind: 'builder_handoff', work_item: { repo: REPO, issue: 4 },
  candidate: { pr: 5, base_sha: base, head_sha: head }, producer: { executor: 'Codex Builder', run_id: 'offline' },
  verification: { subject_sha: head, lifecycle: 'completed', outcome: 'pass', checks: [{ command: 'pnpm check', exit_code: 0 }],
    evidence_refs: [`https://github.com/${REPO}/pull/5#issuecomment-9`] }, handoff: { next_step: 'review', publication: 'confirmed' } };
const validation = { schema_valid: true, ready_claim_valid: true, authority_verified: false, errors: [] };
const handoffBody = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n\n${JSON.stringify(validation)}`;
function fake(overrides = {}) {
  const requests = [], git = [];
  const targetRepo = overrides.repository ?? REPO;
  const targetBranch = overrides.branch ?? BRANCH;
  const installed = overrides.installed ?? [REPO];
  let clock = now, ready = false;
  const deps = {
    env: { AWH_GITHUB_APP_ID: '123', AWH_GITHUB_APP_PRIVATE_KEY_PATH: join(tmpdir(), 'awh-test-only.pem'),
      PATH: process.env.PATH, GIT_TRACE: '1', GIT_CONFIG_COUNT: '99', GH_TOKEN: 'user-session', GITHUB_TOKEN: 'user-session', NODE_OPTIONS: '--inspect' },
    now: () => clock,
    cwd: () => repoRoot,
    realpath: async path => resolve(path),
    stat: async path => {
      if (resolve(path) === join(repoRoot, '.git')) return { isDirectory: () => true, isFile: () => false };
      throw Object.assign(new Error('No marker'), { code: 'ENOENT' });
    },
    read: async () => Buffer.from(pem),
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      assert.equal(new URL(url).host, 'api.github.com');
      assert.equal(options.redirect, 'error');
      assert(options.signal instanceof AbortSignal);
      let data;
      if (url.endsWith('/app')) data = { id: 123, slug: 'test-builder' };
      else if (url.endsWith('/installation')) data = { id: 456, app_id: 123, account: { login: 'zlpoot' }, repository_selection: 'selected', suspended_at: null, permissions };
      else if (url.endsWith('/access_tokens')) {
        const inspect = !Object.hasOwn(JSON.parse(options.body), 'repositories');
        data = { token: inspect ? 'fake-inspection-secret' : 'fake-installation-secret',
          expires_at: new Date(now + 3600000).toISOString(), permissions: inspect ? inspectionPermissions : permissions,
          repositories: (inspect ? installed : [targetRepo]).map(full_name => ({ full_name })) };
      }
      else if (url.includes('/installation/repositories')) data = { total_count: installed.length, repositories: installed.map(full_name => ({ full_name })) };
      else if (url.endsWith('/git/ref/heads/main')) data = { object: { sha: base } };
      else if (url.includes('/git/ref/heads/')) data = { object: { sha: head } };
      else if (url.includes('/compare/')) data = { status: 'ahead', files: [{ filename: 'docs/management/agent-workflow-hub.md', status: 'added' }] };
      else if (url.endsWith('/graphql')) { ready = true; data = { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }; }
      else if (url.endsWith('/issues/comments/10')) data = comment(10, overrides.handoffBody ?? handoffBody, targetRepo);
      else if (url.endsWith('/issues/comments/9')) data = comment(9, `Builder evidence\n${head}`, targetRepo);
      else if (url.endsWith('/comments')) data = comment(11, JSON.parse(options.body).body, targetRepo);
      else data = { ...pr, draft: !ready, head: { ...pr.head, ref: targetBranch, repo: { full_name: targetRepo } },
        base: { ...pr.base, repo: { full_name: targetRepo } } };
      if (overrides.response) data = overrides.response(url, options, data);
      return new Response(JSON.stringify(data));
    },
    spawn: (...args) => {
      git.push(args);
      if (args[1][0] === 'rev-parse') return { status: 0, stdout: repoRoot + '\n' };
      if (args[1][0] === 'config' && args[1].includes('--get')) return { status: 0, stdout: `https://github.com/${targetRepo}.git\n` };
      if (args[1][0] === 'config') return { status: 0, stdout: 'core.bare\nremote.origin.url\n' };
      if (args[1][0] === 'branch') return { status: 0, stdout: targetBranch + '\n' };
      if (args[1][0] === 'diff') return { status: 0, stdout: 'docs/management/agent-workflow-hub.md\0' };
      return { status: 0, stdout: '', stderr: '' };
    },
    ...overrides.deps,
  };
  return { deps, requests, git, advance: ms => { clock += ms; } };
}

test('JWT RS256 signature and skew/expiry claims at clock boundaries', () => {
  for (const clock of [60000, now, now + 876]) {
    const jwt = createJwt('123', pem, clock), [h, p, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iat: Math.floor(clock / 1000) - 60, exp: Math.floor(clock / 1000) + 540, iss: '123' });
    assert(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
  }
  for (const clock of [NaN, Infinity, -1]) assert.throws(() => createJwt('123', pem, clock), /clock/);
  for (const id of ['0', '-1', '1.2', '123evil', '9007199254740992']) assert.throws(() => createJwt(id, pem, now), /App ID/);
  assert.throws(() => createJwt('123', 'secret invalid key text', now), e => !e.message.includes('secret invalid key text'));
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => createJwt('123', ec.privateKey.export({ type: 'pkcs8', format: 'pem' }), now), /RSA/);
});

test('automatic installation resolution, exact request headers/body and narrowed token', async () => {
  const f = fake(), b = await connectBuilder(f.deps);
  assert.deepEqual(b.preflight(), { repo: REPO, app_id: 123, installation_id: 456, actor, repository_selection: 'selected', repositories: [REPO], permissions });
  assert.equal(f.requests.length, 5);
  assert(f.requests[1].url.endsWith(`/repos/${REPO}/installation`));
  for (const i of [2, 4]) {
    const r = f.requests[i];
    assert.equal(r.method, 'POST');
    assert(r.url.endsWith('/app/installations/456/access_tokens'));
    assert.equal(r.headers.Accept, 'application/vnd.github+json');
    assert.equal(r.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.match(r.headers.Authorization, /^Bearer eyJ/);
  }
  assert.deepEqual(JSON.parse(f.requests[2].body), { permissions: { metadata: 'read' } });
  assert.deepEqual(JSON.parse(f.requests[4].body), { repositories: ['agent-workflow-hub'], permissions: { contents: 'write', issues: 'write', pull_requests: 'write' } });
  assert.equal(f.requests[3].headers.Authorization, 'Bearer fake-inspection-secret');
  assert(!JSON.stringify(b.preflight()).includes('fake-installation-secret'));
});

test('explicit installation override must match live repository lookup', async () => {
  const f = fake(); f.deps.env.AWH_GITHUB_INSTALLATION_ID = '456';
  await connectBuilder(f.deps);
  f.deps.env.AWH_GITHUB_INSTALLATION_ID = '789';
  await assert.rejects(connectBuilder(f.deps), /mismatch/);
  f.deps.env.AWH_GITHUB_INSTALLATION_ID = '../456';
  await assert.rejects(connectBuilder(f.deps), /override/);
});

for (const [name, mutate] of [
  ['all repositories', v => ({ ...v, repository_selection: 'all' })],
  ['wrong App', v => ({ ...v, app_id: 999 })],
  ['wrong owner', v => ({ ...v, account: { login: 'other' } })],
  ['suspended', v => ({ ...v, suspended_at: 'date' })],
  ['extra administration', v => ({ ...v, permissions: { ...permissions, administration: 'read' } })],
  ['actions write', v => ({ ...v, permissions: { ...permissions, actions: 'write' } })],
  ['workflows write', v => ({ ...v, permissions: { ...permissions, workflows: 'write' } })],
  ['missing contents write', v => ({ ...v, permissions: { ...permissions, contents: 'read' } })],
]) test(`preflight refuses ${name} before token minting`, async () => {
  const f = fake({ response: (url, _, v) => url.endsWith('/installation') ? mutate(v) : v });
  await assert.rejects(connectBuilder(f.deps), /mismatch/);
  assert.equal(f.requests.length, 2);
});

test('actual installation repository list is checked before narrowing', async () => {
  for (const response of [{ total_count: 2, repositories: [{ full_name: REPO }, { full_name: 'zlpoot/other' }] },
    { total_count: 1, repositories: [{ full_name: 'zlpoot/other' }] }]) {
    const f = fake({ response: (url, _, v) => url.includes('/installation/repositories') ? response : v });
    await assert.rejects(connectBuilder(f.deps), /repository set is not allowed/);
    assert.equal(f.requests.length, 4);
    const minted = f.requests.filter(r => r.url.endsWith('/access_tokens'));
    assert.equal(minted.length, 1, 'no write token may be minted before scope passes');
    assert.deepEqual(JSON.parse(minted[0].body), { permissions: { metadata: 'read' } });
    assert(!Object.values(JSON.parse(minted[0].body).permissions).includes('write'));
  }
});

test('inspection token with unexpected write permission fails before scope lookup or write mint', async () => {
  const f = fake({ response: (url, _, v) => url.endsWith('/access_tokens') ? { ...v, permissions } : v });
  await assert.rejects(connectBuilder(f.deps), /token permissions mismatch/);
  assert.equal(f.requests.length, 3);
});

test('nested invocation rejects a key in the worktree root before key read or authentication', async () => {
  let readCount = 0;
  const f = fake({ deps: { cwd: () => join(repoRoot, 'src'), read: async () => { readCount++; return Buffer.from(pem); } } });
  f.deps.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH = join(repoRoot, 'root-secret.pem');
  await assert.rejects(connectBuilder(f.deps), /outside the repository/);
  assert.equal(readCount, 0); assert.equal(f.requests.length, 0);
  const [cmd, args, options] = f.git[0];
  assert.equal(cmd, 'git'); assert.deepEqual(args, ['rev-parse', '--show-toplevel']);
  assert.equal(options.cwd, repoRoot);
  assert.equal(options.env.GIT_CONFIG_VALUE_0, repoRoot.replaceAll('\\', '/'));
  assert.equal(options.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH, undefined);
  assert(!JSON.stringify(options).includes('fake-installation-secret'));
});

test('nested invocation with an external key uses the verified root for safe.directory and push cwd', async () => {
  const f = fake({ deps: { cwd: () => join(repoRoot, 'src') } });
  const b = await connectBuilder(f.deps); await b.push();
  for (const [, args, options] of f.git.slice(1)) {
    assert.equal(options.cwd, repoRoot);
    const safeKey = Array.from({ length: Number(options.env.GIT_CONFIG_COUNT) }, (_, i) => i)
      .find(i => options.env[`GIT_CONFIG_KEY_${i}`] === 'safe.directory');
    assert.equal(options.env[`GIT_CONFIG_VALUE_${safeKey}`], repoRoot.replaceAll('\\', '/'));
    if (args[0] !== '-c') assert(!JSON.stringify(options.env).includes('fake-installation-secret'));
  }
});

test('unverifiable or different worktree root fails before reading the key', async () => {
  for (const result of [{ status: 128, stdout: '', stderr: pem }, { status: 0, stdout: 'relative/path' },
    { status: 0, stdout: tmpdir() }]) {
    let readCount = 0;
    const f = fake({ deps: { spawn: () => result, read: async () => { readCount++; return Buffer.from(pem); } } });
    await assert.rejects(connectBuilder(f.deps), e => /worktree root/.test(e.message) && !e.message.includes(pem));
    assert.equal(readCount, 0); assert.equal(f.requests.length, 0);
  }
});

test('canonical key path in the worktree is refused even through an outside symlink', async () => {
  const f = fake({ deps: { realpath: async path => resolve(path) === resolve(join(tmpdir(), 'awh-test-only.pem'))
    ? join(repoRoot, 'hidden-secret.pem') : resolve(path) } });
  await assert.rejects(connectBuilder(f.deps), /outside the repository/);
  assert.equal(f.requests.length, 0);
});

test('missing environment, unavailable file and wrong key produce safe failures', async () => {
  for (const env of [{}, { AWH_GITHUB_APP_ID: '123' }]) await assert.rejects(connectBuilder(fake({ deps: { env } }).deps), /environment/);
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    const f = fake({ deps: { read: async () => { throw Object.assign(new Error(pem), { code }); } } });
    await assert.rejects(connectBuilder(f.deps), /existence and read permissions/);
    assert.equal(f.requests.length, 0);
  }
  const f = fake({ deps: { read: async () => Buffer.from('not a key') } });
  await assert.rejects(connectBuilder(f.deps), /RSA signing key/);
  f.deps.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH = join(process.cwd(), 'secret.pem');
  await assert.rejects(connectBuilder(f.deps), /outside/);
});

test('non-2xx, invalid JSON, network and timeout errors suppress upstream secrets', async () => {
  const fetches = [async () => new Response(pem, { status: 403 }), async () => new Response(pem),
    async () => { throw new Error(pem); }, async () => { throw new DOMException(pem, 'TimeoutError'); }];
  for (const fetch of fetches) {
    await assert.rejects(connectBuilder(fake({ deps: { fetch } }).deps), e => {
      assert(!e.message.includes(pem)); assert.match(e.message, /GitHub request failed/); return true;
    });
  }
});

test('expired, overlong, malformed and overpermissioned token responses fail closed', async () => {
  for (const mutation of [v => ({ ...v, expires_at: new Date(now).toISOString() }),
    v => ({ ...v, expires_at: new Date(now + 3660001).toISOString() }), v => ({ ...v, expires_at: 'invalid' }),
    v => ({ ...v, token: null }), v => ({ ...v, permissions: { ...permissions, actions: 'write' } })]) {
    await assert.rejects(connectBuilder(fake({ response: (url, _, v) => url.endsWith('/access_tokens') ? mutation(v) : v }).deps), /token/);
  }
  const f = fake(), b = await connectBuilder(f.deps); f.advance(3600000);
  await assert.rejects(b.readPR(5), /expired/); await assert.rejects(b.push(), /expired/);
  assert.equal(f.requests.length, 5);
});

test('Git token stays in child environment, fixed HTTPS branch, no logged-user credential or trace', async () => {
  const f = fake(), b = await connectBuilder(f.deps);
  assert.deepEqual(await b.push(), { pushed: BRANCH, actor });
  const [cmd, args, options] = f.git.at(-1);
  assert.equal(cmd, 'git'); assert(args.includes(`https://github.com/${REPO}.git`));
  assert.equal(args.at(-1), `HEAD:refs/heads/${BRANCH}`);
  assert(!JSON.stringify(args).includes('fake-installation-secret'));
  for (const k of ['GIT_TRACE', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'AWH_GITHUB_APP_PRIVATE_KEY_PATH']) assert.equal(options.env[k], undefined);
  assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(options.cwd, repoRoot);
  const config = Object.fromEntries(Array.from({ length: Number(options.env.GIT_CONFIG_COUNT) }, (_, i) => [options.env[`GIT_CONFIG_KEY_${i}`], options.env[`GIT_CONFIG_VALUE_${i}`]]));
  assert.equal(config['credential.helper'], '');
  assert.equal(config['http.https://github.com/.extraheader'], `Authorization: Basic ${Buffer.from('x-access-token:fake-installation-secret').toString('base64')}`);
});

test('unsafe local Git transport, wrong branch and Git errors are refused safely', async () => {
  for (const unsafe of ['url.evil.insteadof', 'http.proxy', 'credential.helper', 'include.path']) {
    const f = fake({ deps: { spawn: (_, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? repoRoot : args.includes('--get') ? `https://github.com/${REPO}.git` : unsafe }) } });
    await assert.rejects((await connectBuilder(f.deps)).push(), /push failed/);
  }
  const f = fake({ deps: { spawn: (_, a) => ({ status: 0, stdout: a[0] === 'rev-parse' ? repoRoot : a.includes('--get') ? `https://github.com/${REPO}.git` : a[0] === 'config' ? '' : 'main' }) } });
  await assert.rejects((await connectBuilder(f.deps)).push(), /push failed/);
  const bad = fake({ deps: { spawn: (_, args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: repoRoot };
    if (args.includes('--get')) return { status: 0, stdout: `https://github.com/${REPO}.git` };
    throw new Error(pem);
  } } });
  await assert.rejects((await connectBuilder(bad.deps)).push(), e => !e.message.includes(pem));
});

test('Builder exposes only fixed operations, requires App bot for PR/comments, rejects secret text', async () => {
  const f = fake(), b = await connectBuilder(f.deps);
  assert.deepEqual(Object.keys(b).sort(), ['preflight', 'push', 'createPR', 'updatePR', 'readPR', 'createComment', 'editComment', 'readComment', 'ready'].sort());
  await b.createPR('Title', 'Implements #4');
  assert.deepEqual(JSON.parse(f.requests.at(-1).body), { title: 'Title', body: 'Implements #4', head: BRANCH, base: 'main', draft: true });
  await b.updatePR(5, 'Final title', 'Final body');
  await b.createComment(5, 'Builder evidence');
  await b.editComment(5, 10, 'Updated Handoff');
  for (const text of [pem, 'fake-installation-secret', 'ghs_fakeToken', createJwt('123', pem, now)])
    await assert.rejects(b.createPR('Title', text), /Secret-like/);
  await assert.rejects(b.readPR(-1), /number/);
  for (const mutate of [v => ({ ...v, user: { login: 'zlpoot', type: 'User' } }), v => ({ ...v, head: { ...v.head, ref: 'main' } })])
    await assert.rejects((await connectBuilder(fake({ response: (url, _, v) => url.endsWith('/pulls/5') ? mutate(v) : v }).deps)).readPR(5), /mismatch/);
  const reflected = await connectBuilder(fake({ response: (url, _, v) => url.endsWith('/issues/comments/9') ? { ...v, body: 'fake-installation-secret' } : v }).deps);
  await assert.rejects(reflected.readComment(5, 9), /Secret-like/);
});

test('Ready requires confirmed published Handoff, bot evidence and exact remote version', async () => {
  const f = fake(), b = await connectBuilder(f.deps);
  assert.equal((await b.ready(5, head, record, 10)).draft, false);
  assert(f.requests.some(r => r.url.endsWith('/graphql')));
  for (const bad of [{ ...record, handoff: { ...record.handoff, publication: 'pending' } },
    { ...record, work_item: { ...record.work_item, issue: 3 } }]) {
    const g = fake(); await assert.rejects((await connectBuilder(g.deps)).ready(5, head, bad, 10));
    assert(!g.requests.some(r => r.url.endsWith('/graphql')));
  }
  for (const mutation of [
    (url, v) => url.endsWith('/pulls/5') ? { ...v, head: { ...v.head, sha: base } } : v,
    (url, v) => url.endsWith('/issues/comments/10') ? { ...v, body: handoffBody.replace('confirmed', 'pending') } : v,
    (url, v) => url.endsWith('/issues/comments/9') ? { ...v, user: { login: 'zlpoot', type: 'User' } } : v,
  ]) {
    const g = fake({ response: (url, _, v) => mutation(url, v) });
    await assert.rejects((await connectBuilder(g.deps)).ready(5, head, record, 10));
    assert(!g.requests.some(r => r.url.endsWith('/graphql')));
  }
});

test('real wrapper CLI rejects forbidden operations before key read/network and never echoes arguments', () => {
  const cli = new URL('../dist/builder-cli.js', import.meta.url);
  for (const op of ['approve', 'merge', 'review', 'request', 'administration', 'workflow', 'api', 'gh', 'push --force', 'toString']) {
    const child = spawnSync(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), op, pem],
      { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: 'Unsupported Builder operation or arguments' });
  }
  const child = spawnSync(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), 'preflight'],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
  assert.equal(child.status, 2); assert.equal(child.stdout, ''); assert(!child.stderr.includes('BEGIN'));
});

test('successful real CLI never prints PEM, signed JWT, token or API response extras', () => {
  const script = `
    import { generateKeyPairSync } from 'node:crypto';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({type:'pkcs8',format:'pem'});
    const realpath = fs.realpath;
    fs.realpath = async path => String(path).endsWith('generated-memory-key.pem') ? path : realpath(path);
    fs.readFile = async () => Buffer.from(key);
    syncBuiltinESMExports();
    process.env.AWH_GITHUB_APP_ID = '123';
    process.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH = join(tmpdir(), 'generated-memory-key.pem');
    const permissions = ${JSON.stringify(permissions)};
    globalThis.fetch = async (url, options) => {
      let v = url.endsWith('/app') ? {id:123,slug:'test-builder'} : url.endsWith('/installation') ?
        {id:456,app_id:123,account:{login:'zlpoot'},repository_selection:'selected',suspended_at:null,permissions} :
        url.includes('/installation/repositories') ? {total_count:1,repositories:[{full_name:'${REPO}'}]} :
        {token:'fake-installation-secret',expires_at:new Date(Date.now()+3599000).toISOString(),permissions:JSON.parse(options.body).repositories?permissions:{metadata:'read'},repositories:[{full_name:'${REPO}'}]};
      return new Response(JSON.stringify({...v,untrusted_echo:key}));
    };
    process.argv = [process.execPath, 'builder-cli.js', 'preflight'];
    await import('./dist/builder-cli.js');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
  assert.equal(child.status, 0); assert.equal(child.stderr, '');
  assert.equal(child.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(child.stdout).actor, actor);
  assert(!/BEGIN|eyJ|fake-installation-secret|untrusted_echo/.test(child.stdout));
});

test('real CLI from a nested directory resolves the Git root and refuses an in-repo key before read', () => {
  const cli = new URL('../dist/builder-cli.js', import.meta.url).href;
  const keyPath = join(repoRoot, 'root-secret.pem');
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const actualRealpath = fs.realpath;
    fs.realpath = async path => path === ${JSON.stringify(keyPath)} ? path : actualRealpath(path);
    fs.readFile = async () => { throw new Error('Key read must not occur'); };
    syncBuiltinESMExports();
    process.env.AWH_GITHUB_APP_ID = '123';
    process.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH = ${JSON.stringify(keyPath)};
    globalThis.fetch = async () => { throw new Error('Network must not occur'); };
    process.argv = [process.execPath, 'builder-cli.js', 'preflight'];
    await import(${JSON.stringify(cli)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: join(repoRoot, 'src'), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
  assert.equal(child.status, 2); assert.equal(child.stdout, '');
  assert.deepEqual(JSON.parse(child.stderr), { error: 'Private key must be outside the repository' });
});

test('uncertain Ready mutation restores and reads back Draft', async () => {
  let readyCalls = 0, restored = false;
  const f = fake({ response: (url, options, data) => {
    if (url.endsWith('/graphql') && options.body.includes('markPullRequestReadyForReview')) {
      readyCalls++; throw new Error('upstream secret');
    }
    if (url.endsWith('/graphql') && options.body.includes('convertPullRequestToDraft')) {
      restored = true; return { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } };
    }
    if (restored && url.endsWith('/pulls/5')) return { ...data, draft: true };
    return data;
  } });
  await assert.rejects((await connectBuilder(f.deps)).ready(5, head, record, 10), /restored to Draft/);
  assert.equal(readyCalls, 1); assert(restored);
});

test('fixed immutable Profiles reject arbitrary repository/base/workflow overrides', () => {
  assert.equal(selectWorkflow().profile.repository, HUB_REPO);
  const future = selectWorkflow({ profile: 'future-ui', workflow: 'bootstrap' });
  assert.equal(future.profile.repository, FUTURE_REPO); assert.equal(future.profile.base, 'main');
  assert.deepEqual(future.workflow.bootstrap_paths, ['docs/management/agent-workflow-hub.md']);
  assert.deepEqual(future.workflow.verification_commands, ['pnpm lint', 'pnpm typecheck', 'pnpm test']);
  for (const selection of [{ profile: 'evil/repo', workflow: 'bootstrap' }, { profile: 'hub', workflow: 'merge' },
    { profile: 'future-ui', workflow: 'c05' }, { profile: 'hub', workflow: 'c06', repo: 'evil/repo' },
    { profile: 'hub', workflow: 'c06', base: 'evil' }]) assert.throws(() => selectWorkflow(selection));
  assert.throws(() => { PROFILES[0].repository = 'evil/repo'; });
  assert.throws(() => { future.workflow.bootstrap_paths.push('packages/evil.ts'); });
});

for (const [profile, workflow, repository, branch] of [
  ['hub', 'c06', HUB_REPO, 'codex/c06-project-profiles'],
  ['future-ui', 'bootstrap', FUTURE_REPO, 'codex/awh-c06-bootstrap'],
]) test(`${profile} in dual selected scope mints only a single-repository write token and binds API/Git`, async () => {
  const f = fake({ repository, branch, installed: [FUTURE_REPO, HUB_REPO] });
  const b = await connectBuilder(f.deps, { profile, workflow });
  assert.deepEqual(b.preflight().repositories, [HUB_REPO, FUTURE_REPO].sort());
  const tokens = f.requests.filter(r => r.url.endsWith('/access_tokens'));
  assert.equal(tokens.length, 2);
  assert.deepEqual(JSON.parse(tokens[0].body), { permissions: { metadata: 'read' } });
  assert.deepEqual(JSON.parse(tokens[1].body), { repositories: [repository.split('/')[1]],
    permissions: { contents: 'write', issues: 'write', pull_requests: 'write' } });
  await b.push();
  assert(f.git.at(-1)[1].includes(`https://github.com/${repository}.git`));
  assert.equal(f.git.at(-1)[1].at(-1), `HEAD:refs/heads/${branch}`);
  await b.createPR('Title', 'Implements Hub #6');
  const create = f.requests.find(r => r.method === 'POST' && r.url.endsWith('/pulls'));
  assert.equal(create.url, `https://api.github.com/repos/${repository}/pulls`);
  assert.deepEqual(JSON.parse(create.body), { title: 'Title', body: 'Implements Hub #6', head: branch, base: 'main', draft: true });
});

test('Hub c06 remains usable with only the original single-repository installation', async () => {
  const f = fake({ branch: 'codex/c06-project-profiles' });
  const b = await connectBuilder(f.deps, { profile: 'hub', workflow: 'c06' });
  assert.deepEqual(b.preflight().repositories, [HUB_REPO]);
  assert.equal((await b.createPR('Title', 'Phase A')).actor, actor);
});

test('missing future-ui installation stops before its write token (Human Gate)', async () => {
  const f = fake({ repository: FUTURE_REPO, branch: 'codex/awh-c06-bootstrap' });
  await assert.rejects(connectBuilder(f.deps, { profile: 'future-ui', workflow: 'bootstrap' }), /Human Gate/);
  assert.equal(f.requests.filter(r => r.url.endsWith('/access_tokens')).length, 1);
});

test('wrong, extra, duplicate or future-only selected sets never produce a write token', async () => {
  for (const installed of [[HUB_REPO, FUTURE_REPO, 'zlpoot/other'], [FUTURE_REPO], [HUB_REPO, HUB_REPO], []]) {
    const f = fake({ installed });
    await assert.rejects(connectBuilder(f.deps, { profile: 'hub', workflow: 'c06' }), /set is not allowed/);
    const tokens = f.requests.filter(r => r.url.endsWith('/access_tokens'));
    assert.equal(tokens.length, 1); assert.deepEqual(JSON.parse(tokens[0].body).permissions, { metadata: 'read' });
  }
});

test('effective write-token response must also authorize exactly the selected repository', async () => {
  for (const repos of [[{ full_name: FUTURE_REPO }], [{ full_name: HUB_REPO }, { full_name: FUTURE_REPO }], []]) {
    const f = fake({ response: (url, options, v) => url.endsWith('/access_tokens') && JSON.parse(options.body).repositories
      ? { ...v, repositories: repos } : v });
    await assert.rejects(connectBuilder(f.deps), /Write token must authorize only/);
  }
});

test('selected Profile cannot authenticate from a different repository worktree', async () => {
  const f = fake();
  await assert.rejects(connectBuilder(f.deps, { profile: 'future-ui', workflow: 'bootstrap' }), /worktree root/);
  assert.equal(f.requests.length, 0);
});

test('future-ui bootstrap blocks product/dependency paths before authenticated push or PR creation', async () => {
  for (const path of ['packages/ui/index.ts', 'pnpm-lock.yaml', 'docs/management/grant.md']) {
    const f = fake({ repository: FUTURE_REPO, branch: 'codex/awh-c06-bootstrap', installed: [HUB_REPO, FUTURE_REPO] });
    const realSpawn = f.deps.spawn;
    f.deps.spawn = (...args) => args[1][0] === 'diff' ? { status: 0, stdout: path + '\0' } : realSpawn(...args);
    const b = await connectBuilder(f.deps, { profile: 'future-ui', workflow: 'bootstrap' });
    await assert.rejects(b.push(), /push failed/);
    assert(!f.git.some(([, args]) => args.includes('push')));
    const g = fake({ repository: FUTURE_REPO, branch: 'codex/awh-c06-bootstrap', installed: [HUB_REPO, FUTURE_REPO],
      response: (url, _, v) => url.includes('/compare/') ? { status: 'ahead', files: [{ filename: path, status: 'modified' }] } : v });
    await assert.rejects((await connectBuilder(g.deps, { profile: 'future-ui', workflow: 'bootstrap' })).createPR('Title', 'Body'), /docs-only/);
    assert(!g.requests.some(r => r.method === 'POST' && r.url.endsWith('/pulls')));
  }
});

test('future-ui Ready binds the Hub work item, full verification command set and future-ui evidence', async () => {
  const handoff = structuredClone(record);
  handoff.work_item.issue = 6;
  handoff.verification.checks = ['pnpm lint', 'pnpm typecheck', 'pnpm test'].map(command => ({ command, exit_code: 0 }));
  handoff.verification.evidence_refs = [`https://github.com/${FUTURE_REPO}/pull/5#issuecomment-9`];
  const body = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`\n${JSON.stringify(validation)}`;
  const f = fake({ repository: FUTURE_REPO, branch: 'codex/awh-c06-bootstrap', installed: [HUB_REPO, FUTURE_REPO], handoffBody: body });
  const b = await connectBuilder(f.deps, { profile: 'future-ui', workflow: 'bootstrap' });
  const missing = structuredClone(handoff); missing.verification.checks = [{ command: 'pnpm check', exit_code: 0 }];
  await assert.rejects(b.ready(5, head, missing, 10), /verification commands/);
  const wrongRepo = structuredClone(handoff); wrongRepo.work_item.repo = FUTURE_REPO;
  await assert.rejects(b.ready(5, head, wrongRepo, 10), /work item/);
  assert.equal((await b.ready(5, head, handoff, 10)).draft, false);
});

test('Profile CLI rejects arbitrary repo and forbidden actions before credentials', () => {
  const cli = fileURLToPath(new URL('../dist/builder-cli.js', import.meta.url));
  for (const args of [
    ['--profile', 'evil/repo', '--workflow', 'bootstrap', 'preflight'],
    ['--profile', 'hub', '--workflow', 'merge', 'preflight'],
    ['--profile', 'hub', '--workflow', 'c06', 'approve'],
    ['--profile', 'hub', '--workflow', 'c06', 'push', '--repo', 'evil/repo'],
  ]) {
    const child = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert(!child.stderr.includes('environment')); assert(!child.stderr.includes('evil/repo'));
  }
});

test('webskill/bootstrap fixes every boundary without an Agent or local clone path', () => {
  const webskill = selectWorkflow({ profile: 'webskill', workflow: 'bootstrap' });
  assert.deepEqual(webskill, { profile: { id: 'webskill', repository: WEBSKILL_REPO, base: 'main', workflows: [webskill.workflow] },
    workflow: { id: 'bootstrap', branch: 'codex/awh-c07-webskill-bootstrap', work_item: { repo: HUB_REPO, issue: 8 },
      verification_commands: ['pnpm check:foundations', 'pnpm lint', 'pnpm typecheck'],
      bootstrap_paths: ['docs/management/agent-workflow-hub.md'] } });
  const hub = selectWorkflow({ profile: 'hub', workflow: 'c07' });
  assert.equal(hub.workflow.branch, 'codex/c07-webskill-profile');
  assert.deepEqual(hub.workflow.work_item, { repo: HUB_REPO, issue: 8 });
  assert.deepEqual(hub.workflow.verification_commands, ['pnpm check']);
  for (const key of ['repository', 'base', 'branch', 'work_item', 'verification_commands', 'bootstrap_paths', 'url', 'api', 'git'])
    assert.throws(() => selectWorkflow({ profile: 'webskill', workflow: 'bootstrap', [key]: 'override' }));
  assert.throws(() => { webskill.profile.base = 'other'; });
  assert.throws(() => { webskill.workflow.branch = 'other'; });
  assert.throws(() => { webskill.workflow.work_item.issue = 147; });
  assert.throws(() => { webskill.workflow.verification_commands.reverse(); });
  assert.throws(() => { webskill.workflow.bootstrap_paths.push('AGENTS.md'); });
});

const dormantRepo = 'zlpoot/agent-desktop';
const selectedSets = [[HUB_REPO], [HUB_REPO, FUTURE_REPO], [HUB_REPO, FUTURE_REPO, WEBSKILL_REPO],
  [HUB_REPO, FUTURE_REPO, WEBSKILL_REPO, dormantRepo]];
const workflows = [
  ['hub', 'c05', HUB_REPO, BRANCH],
  ['hub', 'c06', HUB_REPO, 'codex/c06-project-profiles'],
  ['hub', 'c07', HUB_REPO, 'codex/c07-webskill-profile'],
  ['future-ui', 'bootstrap', FUTURE_REPO, 'codex/awh-c06-bootstrap'],
  ['webskill', 'bootstrap', WEBSKILL_REPO, 'codex/awh-c07-webskill-bootstrap'],
];
for (const installed of selectedSets) for (const [profile, workflow, repository, branch] of workflows) {
  test(`selected-set ${installed.length} repositories / ${profile}/${workflow} narrows writes or stops at Human Gate`, async () => {
    const f = fake({ repository, branch, installed: [...installed].reverse() });
    if (!installed.includes(repository)) {
      await assert.rejects(connectBuilder(f.deps, { profile, workflow }), /Human Gate/);
      assert.equal(f.requests.filter(r => r.url.endsWith('/access_tokens')).length, 1);
    } else {
      const b = await connectBuilder(f.deps, { profile, workflow });
      assert.deepEqual(b.preflight().repositories, [...installed].sort());
      const tokens = f.requests.filter(r => r.url.endsWith('/access_tokens'));
      assert.equal(tokens.length, 2);
      assert.deepEqual(JSON.parse(tokens[1].body), { repositories: [repository.split('/')[1]],
        permissions: { contents: 'write', issues: 'write', pull_requests: 'write' } });
      await b.push();
      assert(f.git.at(-1)[1].includes(`https://github.com/${repository}.git`));
      assert.equal(f.git.at(-1)[1].at(-1), `HEAD:refs/heads/${branch}`);
      await b.createPR('Title', 'Fixed Profile');
      const create = f.requests.find(r => r.method === 'POST' && r.url.endsWith('/pulls'));
      assert.equal(create.url, `https://api.github.com/repos/${repository}/pulls`);
      assert.equal(JSON.parse(create.body).head, branch);
      assert.equal(JSON.parse(create.body).base, 'main');
      assert.equal(JSON.parse(create.body).draft, true);
    }
    const tokens = f.requests.filter(r => r.url.endsWith('/access_tokens'));
    assert.deepEqual(JSON.parse(tokens[0].body), { permissions: { metadata: 'read' } });
    const inspection = f.requests.find(r => r.url.includes('/installation/repositories'));
    assert.equal(inspection.headers.Authorization, 'Bearer fake-inspection-secret');
  });
}

test('selected-set permits exactly four complete sets and rejects partial, unexpected and malformed lists', async () => {
  for (const installed of [[], [FUTURE_REPO], [WEBSKILL_REPO], [FUTURE_REPO, WEBSKILL_REPO],
    [HUB_REPO, WEBSKILL_REPO], [HUB_REPO, HUB_REPO], [HUB_REPO, FUTURE_REPO, WEBSKILL_REPO, 'zlpoot/other'],
    [HUB_REPO, FUTURE_REPO, WEBSKILL_REPO, WEBSKILL_REPO], [HUB_REPO, FUTURE_REPO, 'other/webskill'],
    [HUB_REPO, dormantRepo], [HUB_REPO, FUTURE_REPO, dormantRepo],
    [...selectedSets[3], 'zlpoot/unknown-fifth'], [...selectedSets[3], dormantRepo],
    [HUB_REPO, FUTURE_REPO, WEBSKILL_REPO, 'other/agent-desktop']]) {
    const f = fake({ installed });
    await assert.rejects(connectBuilder(f.deps, { profile: 'hub', workflow: 'c07' }), /set is not allowed/);
    assert.equal(f.requests.filter(r => r.url.endsWith('/access_tokens')).length, 1);
  }
  for (const [repositories, total] of [[null, 0], [[{}], 1], [[{ full_name: HUB_REPO }], 2],
    [[{ full_name: HUB_REPO }], '1']]) assert.equal(allowedInstallation(repositories, total), false);
  const incomplete = fake({ installed: selectedSets[2], response: (url, _, v) => url.includes('/installation/repositories')
    ? { ...v, total_count: 4 } : v });
  await assert.rejects(connectBuilder(incomplete.deps), /set is not allowed/);
  assert.equal(incomplete.requests.filter(r => r.url.endsWith('/access_tokens')).length, 1);
});

test('dormant agent-desktop has no Profile or write path in the four-repository installation', async () => {
  assert.deepEqual(PROFILES.map(p => p.id), ['hub', 'future-ui', 'webskill']);
  assert(PROFILES.every(p => p.repository !== dormantRepo));
  for (const profile of ['agent-desktop', dormantRepo]) for (const workflow of ['bootstrap', 'c07']) {
    const f = fake({ installed: selectedSets[3] });
    assert.throws(() => selectWorkflow({ profile, workflow }), /Unsupported profile/);
    await assert.rejects(connectBuilder(f.deps, { profile, workflow }), /Unsupported profile/);
    assert.equal(f.requests.length, 0); assert.equal(f.git.length, 0);
  }
  for (const [profile, workflow, repository, branch] of workflows) {
    const f = fake({ repository, branch, installed: selectedSets[3] });
    const b = await connectBuilder(f.deps, { profile, workflow });
    await b.push(); await b.createPR('Title', 'Fixed Profile');
    const write = f.requests.filter(r => r.url.endsWith('/access_tokens') && JSON.parse(r.body).repositories);
    assert.equal(write.length, 1);
    assert.deepEqual(JSON.parse(write[0].body).repositories, [repository.split('/')[1]]);
    assert(!f.requests.some(r => r.url.includes('/repos/' + dormantRepo)));
    assert(!f.git.some(([, args]) => args.some(arg => arg.includes('github.com/' + dormantRepo))));
    for (const repositories of [[dormantRepo], [repository, dormantRepo], selectedSets[3]]) {
      const bad = fake({ repository, branch, installed: selectedSets[3], response: (url, options, data) =>
        url.endsWith('/access_tokens') && JSON.parse(options.body).repositories
          ? { ...data, repositories: repositories.map(full_name => ({ full_name })) } : data });
      await assert.rejects(connectBuilder(bad.deps, { profile, workflow }), /Write token must authorize only/);
    }
  }
});

test('triple installation rejects metadata inspection escalation and multi-repository WebSkill write response', async () => {
  for (const repositoryResponse of [[HUB_REPO], [WEBSKILL_REPO, FUTURE_REPO], selectedSets[2], []]) {
    const f = fake({ repository: WEBSKILL_REPO, installed: selectedSets[2], response: (url, options, v) =>
      url.endsWith('/access_tokens') && JSON.parse(options.body).repositories
        ? { ...v, repositories: repositoryResponse.map(full_name => ({ full_name })) } : v });
    await assert.rejects(connectBuilder(f.deps, { profile: 'webskill', workflow: 'bootstrap' }), /Write token must authorize only/);
  }
  const escalated = fake({ installed: selectedSets[2], response: (url, options, v) =>
    url.endsWith('/access_tokens') && !JSON.parse(options.body).repositories
      ? { ...v, permissions: { metadata: 'read', contents: 'write' } } : v });
  await assert.rejects(connectBuilder(escalated.deps), /token permissions/);
  assert.equal(escalated.requests.filter(r => r.url.endsWith('/access_tokens')).length, 1);
  assert(!escalated.requests.some(r => r.url.includes('/installation/repositories')));
});

test('WebSkill bootstrap denies product and management-boundary changes locally and remotely', async () => {
  for (const path of ['AGENTS.md', 'package.json', 'pnpm-lock.yaml', 'packages/runtime/index.ts', 'docs/management/grant.md']) {
    const f = fake({ repository: WEBSKILL_REPO, branch: 'codex/awh-c07-webskill-bootstrap', installed: selectedSets[2] });
    const spawn = f.deps.spawn;
    f.deps.spawn = (...args) => args[1][0] === 'diff' ? { status: 0, stdout: path + '\0' } : spawn(...args);
    await assert.rejects((await connectBuilder(f.deps, { profile: 'webskill', workflow: 'bootstrap' })).push(), /push failed/);
    assert(!f.git.some(([, args]) => args.includes('push')));
  }
  for (const files of [[], [{ filename: 'packages/runtime/index.ts', status: 'added' }],
    [{ filename: 'docs/management/agent-workflow-hub.md', status: 'removed' }],
    [{ filename: 'docs/management/agent-workflow-hub.md', status: 'renamed' }],
    [{ filename: 'docs/management/agent-workflow-hub.md', status: 'added' }, { filename: 'AGENTS.md', status: 'modified' }]]) {
    const f = fake({ repository: WEBSKILL_REPO, branch: 'codex/awh-c07-webskill-bootstrap', installed: selectedSets[2],
      response: (url, _, v) => url.includes('/compare/') ? { status: 'ahead', files } : v });
    await assert.rejects((await connectBuilder(f.deps, { profile: 'webskill', workflow: 'bootstrap' })).createPR('Title', 'Body'), /docs-only/);
    assert(!f.requests.some(r => r.method === 'POST' && r.url.endsWith('/pulls')));
  }
});

test('WebSkill Ready binds Hub #8, ordered verification, bot evidence and exact head', async () => {
  const handoff = structuredClone(record);
  handoff.work_item.issue = 8;
  const commands = ['pnpm check:foundations', 'pnpm lint', 'pnpm typecheck'];
  handoff.verification.checks = commands.map(command => ({ command, exit_code: 0 }));
  handoff.verification.evidence_refs = [`https://github.com/${WEBSKILL_REPO}/pull/5#issuecomment-9`];
  const body = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`\n${JSON.stringify(validation)}`;
  const f = fake({ repository: WEBSKILL_REPO, branch: 'codex/awh-c07-webskill-bootstrap', installed: selectedSets[2], handoffBody: body });
  const b = await connectBuilder(f.deps, { profile: 'webskill', workflow: 'bootstrap' });
  for (const checks of [commands.slice(1), [...commands].reverse(), ['pnpm check'], [...commands, 'pnpm test']]) {
    const invalid = structuredClone(handoff);
    invalid.verification.checks = checks.map(command => ({ command, exit_code: 0 }));
    await assert.rejects(b.ready(5, head, invalid, 10), /verification commands/);
  }
  for (const work_item of [{ repo: HUB_REPO, issue: 6 }, { repo: WEBSKILL_REPO, issue: 8 }, { repo: WEBSKILL_REPO, issue: 147 }])
    await assert.rejects(b.ready(5, head, { ...handoff, work_item }, 10), /work item/);
  await assert.rejects(b.ready(5, base, handoff, 10), /Confirmed Handoff/);
  assert(!f.requests.some(r => r.url.endsWith('/graphql')));
  assert.equal((await b.ready(5, head, handoff, 10)).draft, false);
});

test('WebSkill CLI cannot pass through arbitrary repo/base/branch/API/URL/Git before credentials', () => {
  const cli = fileURLToPath(new URL('../dist/builder-cli.js', import.meta.url));
  for (const extra of ['--repo', '--base', '--branch', '--api', '--url', '--git']) {
    const child = spawnSync(process.execPath, [cli, '--profile', 'webskill', '--workflow', 'bootstrap', 'push', extra, 'override'],
      { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: 'Unsupported Builder operation or arguments' });
  }
  const f = fake();
  return assert.rejects(connectBuilder(f.deps, { profile: 'webskill', workflow: 'bootstrap' }), /worktree root/)
    .then(() => assert.equal(f.requests.length, 0));
});
