import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const bootstrapDocument = targetBranch === 'codex/awh-v01-acceptance' ? 'docs/management/awh-v01-acceptance.md' : 'docs/management/agent-workflow-hub.md';
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
      else if (url.includes('/git/ref/heads/')) data = { ref: `refs/heads/${targetBranch}`,
        url: `https://api.github.com/repos/${targetRepo}/git/refs/heads/${targetBranch}`,
        object: { type: 'commit', sha: head, url: `https://api.github.com/repos/${targetRepo}/git/commits/${head}` } };
      else if (url.includes('/compare/')) data = { status: 'ahead', files: [{ filename: bootstrapDocument, status: 'added' }] };
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
      if (args[1][0] === 'diff') return { status: 0, stdout: bootstrapDocument + '\0' };
      return { status: 0, stdout: '', stderr: '' };
    },
    ...overrides.deps,
  };
  return { deps, requests, git, advance: ms => { clock += ms; } };
}

test('Adapter Draft restoration is fixed App-owned exact-head and read back', async () => {
  let restored = false;
  const f = fake({ response: (url, options, value) => {
    if (url.endsWith('/graphql')) { assert(JSON.parse(options.body).query.includes('convertPullRequestToDraft')); restored = true; return { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } }; }
    if (url.endsWith('/pulls/5')) return { ...value, draft: restored };
    return value;
  } });
  const builder = await connectBuilder(f.deps);
  await assert.rejects(builder.restoreDraft(5, 'c'.repeat(40)), /exact head/);
  assert(!f.requests.some(r => r.url.endsWith('/graphql')));
  const p = await builder.restoreDraft(5, head); assert(p.draft); assert.equal(p.head, head); assert.equal(p.base, base);
  assert.equal(f.requests.filter(r => r.url.endsWith('/graphql')).length, 1);
});
test('Draft restoration refuses foreign actor before mutation', async () => {
  const f = fake({ response: (url, options, value) => url.endsWith('/pulls/5') ? { ...value, user: { login: 'foreign', type: 'User' } } : value });
  const builder = await connectBuilder(f.deps); await assert.rejects(builder.restoreDraft(5, head), /identity/);
  assert(!f.requests.some(r => r.url.endsWith('/graphql')));
});
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
  assert.equal(config['credential.https://github.com.helper'], '');
  assert.equal(config['http.https://github.com/.extraheader'], `AUTHORIZATION: basic ${Buffer.from('x-access-token:fake-installation-secret').toString('base64')}`);
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
  assert.deepEqual(Object.keys(b).sort(), ['preflight', 'push', 'createPR', 'updatePR', 'readPR', 'createComment', 'editComment', 'readComment', 'ready', 'restoreDraft', 'readLifecycle'].sort());
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
  ['hub', 'c07-r1', HUB_REPO, 'codex/c07-r1-git-transport'],
  ['hub', 'c07-r2', HUB_REPO, 'codex/c07-r2-receive-pack'],
  ['hub', 'c07-r3', HUB_REPO, 'codex/c07-r3-scoped-helper'],
  ['hub', 'c1a', HUB_REPO, 'codex/c1a-protocol'],
  ['hub', 'c1b', HUB_REPO, 'codex/c1b-control-plane'],
  ['hub', 'c1c', HUB_REPO, 'codex/c1c-client'],
  ['hub', 'c1e', HUB_REPO, 'codex/c1e-dashboard-api-contract'],
  ['hub', 'c1g', HUB_REPO, 'codex/c1g-dashboard-readonly'],
  ['hub', 'c1h', HUB_REPO, 'codex/c12-trusted-onboarding'],
  ['hub', 'c1d', HUB_REPO, 'codex/c1d-builder-adapter'],
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

// All three transport stages use the fixed push operation; no generic Git/API seam is exposed.
const matchesTransport = (args, stage) => stage === 'push' ? args.includes('push') && !args.includes('--dry-run') :
  stage === 'dry-run' ? args.includes('--dry-run') : args.includes('ls-remote');
const stageName = stage => ({ 'ls-remote': 'authenticated_read_probe', 'dry-run': 'receive_pack_dry_run', push: 'push' })[stage];
const stageMessage = stage => `App HTTPS Git ${{ 'ls-remote': 'authenticated probe', 'dry-run': 'receive-pack dry-run', push: 'push' }[stage]} failed`;
const stageCount = stage => ({ 'ls-remote': 1, 'dry-run': 2, push: 3 })[stage];
function failingTransport(stage, result, overrides = {}) {
  const f = fake(overrides), spawn = f.deps.spawn;
  f.deps.spawn = (...args) => {
    const normal = spawn(...args);
    return matchesTransport(args[1], stage) ? result : normal;
  };
  return f;
}
const transportCalls = f => f.git.filter(([, args]) => args.includes('ls-remote') || args.includes('push'));

test('transport: read PASS → fixed receive-pack dry-run PASS → push with identical token environment', async () => {
  const f = fake();
  await (await connectBuilder(f.deps)).push();
  const [probe, dryRun, push] = transportCalls(f);
  assert.equal(transportCalls(f).length, 3);
  assert.deepEqual(probe[1], ['-c', 'credential.helper=', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    '-c', 'http.followRedirects=false', 'ls-remote', '--exit-code', `https://github.com/${REPO}.git`, 'refs/heads/main']);
  assert(push[1].includes('push'));
  assert.deepEqual(dryRun[1], [...probe[1].slice(0, 6), 'push', '--dry-run', `https://github.com/${REPO}.git`, `HEAD:refs/heads/${BRANCH}`]);
  assert.deepEqual(push[1], [...probe[1].slice(0, 6), 'push', `https://github.com/${REPO}.git`, `HEAD:refs/heads/${BRANCH}`]);
  assert.strictEqual(probe[2].env, dryRun[2].env);
  assert.strictEqual(probe[2].env, push[2].env);
  const env = probe[2].env;
  const configs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.deepEqual(configs.filter(([key]) => /extraheader/i.test(key)), [
    ['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${Buffer.from('x-access-token:fake-installation-secret').toString('base64')}`],
  ]);
  assert(!configs.some(([key]) => key === 'http.extraheader'));
  assert.deepEqual(configs.filter(([key]) => key.startsWith('credential.')), [
    ['credential.helper', ''], ['credential.https://github.com.helper', ''],
  ]);
  for (const [, args] of [probe, dryRun, push]) {
    assert(!args.join(' ').includes('fake-installation-secret'));
    assert(!args.join(' ').includes('AUTHORIZATION'));
    assert(!args.some(arg => arg.includes('x-access-token@')));
  }
});

test('transport: authenticated read auth FAIL leaves push NOTRUN', async () => {
  const f = failingTransport('ls-remote', { status: 128, stdout: '', stderr: 'fatal: Authentication failed' });
  await assert.rejects((await connectBuilder(f.deps)).push(), e => {
    assert.equal(e.message, 'App HTTPS Git authenticated probe failed');
    assert.equal(e.category, 'git_authentication'); return true;
  });
  assert.equal(transportCalls(f).length, 1);
  assert(!f.git.some(([, args]) => args.includes('push')));
});

const diagnosticCases = [
  ['git_network_or_proxy', { status: 128, stderr: 'Failed to connect to 127.0.0.1 port 7890' }],
  ['git_network_or_proxy', { status: 128, stderr: 'Could not resolve proxy: proxy.invalid' }],
  ['git_network_or_proxy', { status: 128, stderr: 'SSL certificate problem: unable to get local issuer certificate' }],
  ['git_authentication', { status: 128, stderr: 'fatal: Authentication failed for fixed repository' }],
  ['git_authentication', { status: 128, stderr: "fatal: could not read Username: terminal prompts disabled" }],
  ['git_remote_permission_or_policy', { status: 128, stderr: 'remote: Write access to repository not granted.' }],
  ['git_remote_permission_or_policy', { status: 1, stderr: 'remote: error: GH013: Repository rule violations found' }],
  ['git_non_fast_forward_or_ref_conflict', { status: 1, stderr: '! [rejected] HEAD -> branch (non-fast-forward)' }],
  ['git_non_fast_forward_or_ref_conflict', { status: 1, stderr: 'error: cannot lock ref: reference already exists' }],
  ['git_timeout', { status: null, error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) }],
  ['git_timeout', { status: 128, stderr: 'Operation timed out after 60000 milliseconds' }],
  ['git_transport_unknown', { status: 128, stdout: 'unrecognized upstream text', stderr: 'unexpected failure with untrusted detail' }],
];
for (const stage of ['ls-remote', 'dry-run', 'push']) test(`transport: ${stage} classifies all six failure categories without raw output`, async () => {
  for (const [category, result] of diagnosticCases) {
    const f = failingTransport(stage, { stdout: '', stderr: '', ...result });
    await assert.rejects((await connectBuilder(f.deps)).push(), e => {
      assert.equal(e.category, category);
      assert.equal(e.message, stageMessage(stage)); assert.equal(e.stage, stageName(stage));
      assert(!e.message.includes(result.stderr || result.stdout || 'untrusted detail')); return true;
    });
    assert.equal(transportCalls(f).length, stageCount(stage));
  }
});

for (const stage of ['ls-remote', 'dry-run', 'push']) test(`transport secret redaction: ${stage} scans stdout/stderr before sanitized classification even on exit zero`, async () => {
  const jwt = createJwt('123', pem, now);
  const secrets = [pem, jwt, 'fake-installation-secret', 'fake-inspection-secret',
    Buffer.from('x-access-token:fake-installation-secret').toString('base64'),
    'ghs_unrecognizedToken', 'github_pat_unknownSecret', 'AUTHORIZATION: basic unrecognizedCredential'];
  for (const secret of secrets) for (const stream of ['stdout', 'stderr']) for (const status of [0, 128]) {
    const f = failingTransport(stage, { status, stdout: '', stderr: 'fatal: Authentication failed', [stream]: String(secret) });
    await assert.rejects((await connectBuilder(f.deps)).push(), e => {
      assert.equal(e.message, stageMessage(stage) + ' (details suppressed)');
      assert.equal(e.stage, stageName(stage));
      assert.equal(e.category, stream === 'stdout' ? 'git_authentication' : 'git_transport_unknown');
      assert(e.suppression_reason.length > 0);
      assert(!JSON.stringify(e).includes(String(secret))); return true;
    });
    assert.equal(transportCalls(f).length, stageCount(stage));
  }
});

test('transport secret redaction: spawn errors do not expose credentials or a misleading category', async () => {
  for (const thrown of [true, false]) {
    const f = fake(), spawn = f.deps.spawn;
    f.deps.spawn = (...args) => {
      const result = spawn(...args);
      if (!args[1].includes('ls-remote')) return result;
      const error = Object.assign(new Error('Authentication failed: fake-installation-secret'), { code: 'ETIMEDOUT' });
      if (thrown) throw error;
      return { status: null, error, stdout: '', stderr: '' };
    };
    await assert.rejects((await connectBuilder(f.deps)).push(), e => {
      assert.equal(e.message, 'App HTTPS Git authenticated probe failed (details suppressed)');
      assert.equal(e.stage, 'authenticated_read_probe');
      assert.equal(e.category, thrown ? undefined : 'git_timeout');
      assert.deepEqual(e.suppression_reason, thrown ? ['spawn_exception'] : ['known_installation_token']); return true;
    });
    assert.equal(transportCalls(f).length, 1);
  }
});

test('transport proxy preservation: HTTP(S) upper/lowercase survive while caller credentials, config and debug do not', async () => {
  const f = fake();
  const proxies = { HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890',
    http_proxy: 'http://127.0.0.1:7890', https_proxy: 'http://127.0.0.1:7890' };
  Object.assign(f.deps.env, proxies, { GIT_CURL_VERBOSE: '1', GIT_TRACE_CURL: '1', GIT_CONFIG_GLOBAL: 'user-config',
    GIT_CONFIG_SYSTEM: 'user-config', GIT_ASKPASS: 'user-helper', GH_ENTERPRISE_TOKEN: 'user-token',
    GITHUB_OTHER: 'user-token', AWH_OTHER: 'secret-config', SSH_ASKPASS: 'user-helper', SSH_ASKPASS_REQUIRE: 'force' });
  await (await connectBuilder(f.deps)).push();
  for (const [, args, { env }] of f.git) {
    for (const [key, value] of Object.entries(proxies)) assert.equal(env[key], value);
    for (const key of ['GIT_CURL_VERBOSE', 'GIT_TRACE_CURL', 'GIT_TRACE', 'GIT_ASKPASS', 'GIT_CONFIG_SYSTEM',
      'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_OTHER', 'AWH_OTHER', 'AWH_GITHUB_APP_ID',
      'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE']) assert.equal(env[key], undefined);
    assert.equal(env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    const keys = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
    assert(keys.every(key => ['safe.directory', 'credential.helper', 'credential.https://github.com.helper', 'http.https://github.com/.extraheader'].includes(key)));
    assert.equal(env[`GIT_CONFIG_VALUE_${keys.indexOf('credential.helper')}`], '');
    if (args.includes('ls-remote') || args.includes('push')) {
      assert.equal(env[`GIT_CONFIG_VALUE_${keys.indexOf('credential.https://github.com.helper')}`], '');
      assert(args.includes(`core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`));
      assert(args.includes('http.followRedirects=false'));
    }
  }
});

test('transport: unsafe local overrides fail before authenticated read or push', async () => {
  for (const config of ['http.proxy', 'https.proxy', 'url.evil.insteadof', 'credential.helper', 'include.path',
    'includeif.gitdir.path', 'core.gitproxy', 'core.sshcommand']) {
    const f = fake(), spawn = f.deps.spawn;
    f.deps.spawn = (...args) => {
      const result = spawn(...args);
      return args[1].includes('--name-only') ? { status: 0, stdout: config + '\n' } : result;
    };
    await assert.rejects((await connectBuilder(f.deps)).push(), /details suppressed/);
    assert.equal(transportCalls(f).length, 0);
  }
});

for (const [name, keys] of [
  ['single', 'credential.https://github.com.helper\n'],
  ['duplicate', 'credential.https://github.com.helper\ncredential.https://github.com.helper\n'],
  ['case variation', 'CrEdEnTiAl.HtTpS://GitHub.CoM.HeLpEr\r\nCREDENTIAL.HTTPS://GITHUB.COM.HELPER\r\n'],
]) test(`scoped-helper allowlist: ${name} exact GitHub host key passes key-only scan`, async () => {
  const f = fake(), spawn = f.deps.spawn;
  f.deps.spawn = (...args) => {
    const result = spawn(...args);
    return args[1].includes('--name-only') ? { status: 0, stdout: 'core.bare\n' + keys + 'remote.origin.url\n' } : result;
  };
  await (await connectBuilder(f.deps)).push();
  assert.equal(transportCalls(f).length, 3);
  assert.deepEqual(f.git.filter(([, args]) => args[0] === 'config').map(([, args]) => args), [
    ['config', '--local', '--get', 'remote.origin.url'], ['config', '--local', '--name-only', '--list'],
  ], 'only the fixed origin value and local key names are read; helper values are never queried');
});

for (const key of [
  'credential.helper', 'credential.username', 'credential.useHttpPath',
  'credential.https://github.com.username', 'credential.https://github.com.useHttpPath',
  'credential.https://github.com/zlpoot/webskill.git.helper', 'credential.https://github.com/any-path.helper',
  'credential.https://github.com/.helper', 'credential.https://gitlab.com.helper',
  'credential.http://github.com.helper', 'credential.https://github.com:443.helper',
  'credential.https://github.com.evil.helper', 'credential.https://github.com.helper.extra',
  'http.proxy', 'https.proxy', 'url.evil.insteadof', 'include.path', 'includeif.gitdir.path',
  'core.gitProxy', 'core.sshCommand',
]) test(`scoped-helper allowlist: refuses ${key} even alongside allowed duplicate keys`, async () => {
  const f = fake(), spawn = f.deps.spawn;
  f.deps.spawn = (...args) => {
    const result = spawn(...args);
    return args[1].includes('--name-only') ? { status: 0,
      stdout: `credential.https://github.com.helper\n${key.toUpperCase()}\ncredential.https://github.com.helper\n` } : result;
  };
  await assert.rejects((await connectBuilder(f.deps)).push(), /details suppressed/);
  assert.equal(transportCalls(f).length, 0);
  assert(!f.requests.some(r => r.url.includes('/git/ref/heads/')), 'unsafe local config stops before fixed-ref gate');
});

test('real Git precedence: generic reset leaves duplicate scoped helpers visible; Builder scoped reset empties effective helper', async () => {
  const f = fake();
  await (await connectBuilder(f.deps)).push();
  const transportEnv = transportCalls(f)[0][2].env;
  const fixture = mkdtempSync(join(tmpdir(), 'awh-scoped-helper-'));
  try {
    // Reuse the actual Builder transport environment. Every command is local config
    // resolution only: no credential fill, helper invocation, Git network or App secret.
    const git = (args, env = transportEnv) => {
      const r = spawnSync('git', args, { cwd: fixture, env, encoding: 'utf8', timeout: 10000 });
      assert.ifError(r.error); assert.equal(r.status, 0, r.stderr); return r.stdout;
    };
    git(['init', '--quiet']);
    const key = 'credential.https://github.com.helper';
    git(['config', '--local', '--add', key, 'awh-dummy-helper-one']);
    git(['config', '--local', '--add', key, 'awh-dummy-helper-two']);
    const configPath = join(fixture, '.git', 'config');
    const before = readFileSync(configPath, 'utf8');
    const genericEnv = { ...transportEnv };
    const config = Array.from({ length: Number(genericEnv.GIT_CONFIG_COUNT) }, (_, i) =>
      [genericEnv[`GIT_CONFIG_KEY_${i}`], genericEnv[`GIT_CONFIG_VALUE_${i}`]]).filter(([k]) => k !== key);
    for (let i = 0; i < Number(genericEnv.GIT_CONFIG_COUNT); i++) {
      delete genericEnv[`GIT_CONFIG_KEY_${i}`]; delete genericEnv[`GIT_CONFIG_VALUE_${i}`];
    }
    genericEnv.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([k, v], i) => Object.assign(genericEnv, { [`GIT_CONFIG_KEY_${i}`]: k, [`GIT_CONFIG_VALUE_${i}`]: v }));
    const query = ['config', '--get-urlmatch', 'credential.helper', 'https://github.com/zlpoot/webskill.git'];
    assert.equal(git(query, genericEnv).trim(), 'awh-dummy-helper-two', 'generic empty helper cannot reset the local host scope');
    assert.equal(git(query).trim(), '', 'same-scope Builder empty helper wins over both local entries');
    assert.equal(readFileSync(configPath, 'utf8'), before, 'resolution must not mutate fixture config');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('C1-A fixed workflow binds Hub #19, exact-head Ready and unchanged installation boundaries', async () => {
  const selection = { profile: 'hub', workflow: 'c1a' };
  const { profile, workflow } = selectWorkflow(selection);
  assert.equal(profile.repository, HUB_REPO); assert.equal(profile.base, 'main');
  assert.deepEqual(workflow, { id: 'c1a', branch: 'codex/c1a-protocol', work_item: { repo: HUB_REPO, issue: 19 },
    verification_commands: ['pnpm check'], bootstrap_paths: null });
  const handoff = structuredClone(record); handoff.work_item.issue = 19;
  const body = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`\n${JSON.stringify(validation)}`;
  const f = fake({ branch: workflow.branch, handoffBody: body, installed: selectedSets[3] });
  const builder = await connectBuilder(f.deps, selection);
  await assert.rejects(builder.ready(5, head, record, 10), /work item/);
  await assert.rejects(builder.ready(5, 'c'.repeat(40), handoff, 10), /Confirmed Handoff validation failed/);
  assert.equal((await builder.ready(5, head, handoff, 10)).draft, false);
  assert.deepEqual(PROFILES.map(p => p.id), ['hub', 'future-ui', 'webskill']);
  for (const key of ['repo', 'base', 'branch', 'api', 'url', 'git', 'gh'])
    assert.throws(() => selectWorkflow({ ...selection, [key]: 'untrusted' }));
});

test('C1-B fixed workflow binds Hub #20 and preserves exact-head Handoff, scopes and forbidden operations', async () => {
  const selection = { profile: 'hub', workflow: 'c1b' };
  const { profile, workflow } = selectWorkflow(selection);
  assert.equal(profile.repository, HUB_REPO); assert.equal(profile.base, 'main');
  assert.deepEqual(workflow, { id: 'c1b', branch: 'codex/c1b-control-plane', work_item: { repo: HUB_REPO, issue: 20 },
    verification_commands: ['pnpm check'], bootstrap_paths: null });
  const handoff = structuredClone(record); handoff.work_item.issue = 20;
  const body = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`\n${JSON.stringify(validation)}`;
  const f = fake({ branch: workflow.branch, handoffBody: body, installed: selectedSets[3] });
  const builder = await connectBuilder(f.deps, selection);
  await assert.rejects(builder.ready(5, head, record, 10), /work item/);
  await assert.rejects(builder.ready(5, 'c'.repeat(40), handoff, 10), /Confirmed Handoff validation failed/);
  assert.equal((await builder.ready(5, head, handoff, 10)).draft, false);
  for (const key of ['approve', 'review', 'merge', 'request', 'fetch', 'token']) assert.equal(builder[key], undefined);
  for (const key of ['repo', 'base', 'branch', 'api', 'url', 'git', 'gh']) assert.throws(() => selectWorkflow({ ...selection, [key]: 'untrusted' }));
});

test('C1-C fixed workflow binds Hub #21 and preserves exact-head Handoff, scopes and forbidden operations', async () => {
  const selection = { profile: 'hub', workflow: 'c1c' };
  const { profile, workflow } = selectWorkflow(selection);
  assert.equal(profile.repository, HUB_REPO); assert.equal(profile.base, 'main');
  assert.deepEqual(workflow, { id: 'c1c', branch: 'codex/c1c-client', work_item: { repo: HUB_REPO, issue: 21 },
    verification_commands: ['pnpm check'], bootstrap_paths: null });
  const handoff = structuredClone(record); handoff.work_item.issue = 21;
  const body = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`\n${JSON.stringify(validation)}`;
  const f = fake({ branch: workflow.branch, handoffBody: body, installed: selectedSets[3] });
  const builder = await connectBuilder(f.deps, selection);
  await assert.rejects(builder.ready(5, head, record, 10), /work item/);
  await assert.rejects(builder.ready(5, 'c'.repeat(40), handoff, 10), /Confirmed Handoff validation failed/);
  assert.equal((await builder.ready(5, head, handoff, 10)).draft, false);
  for (const key of ['approve', 'review', 'merge', 'request', 'fetch', 'token']) assert.equal(builder[key], undefined);
  for (const key of ['repo', 'base', 'branch', 'api', 'url', 'git', 'gh']) assert.throws(() => selectWorkflow({ ...selection, [key]: 'untrusted' }));
});

test('C1-E fixed workflow binds Hub #23 without bypassing App, scope, exact-head or work-item gates', async () => {
  const selection = { profile: 'hub', workflow: 'c1e' };
  const { profile, workflow } = selectWorkflow(selection);
  assert.equal(profile.repository, HUB_REPO); assert.equal(profile.base, 'main');
  assert.deepEqual(workflow, { id: 'c1e', branch: 'codex/c1e-dashboard-api-contract', work_item: { repo: HUB_REPO, issue: 23 },
    verification_commands: ['pnpm check'], bootstrap_paths: null });
  const f = fake({ branch: workflow.branch, installed: selectedSets[3] });
  const builder = await connectBuilder(f.deps, selection);
  const handoff = structuredClone(record); handoff.work_item.issue = 23;
  await assert.rejects(builder.ready(5, head, record, 10), /work item/);
  await assert.rejects(builder.ready(5, 'c'.repeat(40), handoff, 10), /Confirmed Handoff validation failed/);
  const wrongChecks = structuredClone(handoff); wrongChecks.verification.checks[0].command = 'arbitrary command';
  await assert.rejects(builder.ready(5, head, wrongChecks, 10), /verification commands/);
  const tokens = f.requests.filter(request => request.url.endsWith('/access_tokens')).map(request => JSON.parse(request.body));
  assert.deepEqual(tokens[0], { permissions: inspectionPermissions });
  assert.deepEqual(tokens[1], { repositories: ['agent-workflow-hub'], permissions: { contents: 'write', issues: 'write', pull_requests: 'write' } });
  for (const key of ['approve', 'review', 'merge', 'request', 'fetch', 'token']) assert.equal(builder[key], undefined);
  for (const key of ['repo', 'base', 'branch', 'api', 'url', 'git', 'gh']) assert.throws(() => selectWorkflow({ ...selection, [key]: 'untrusted' }));
});

test('C1-G fixed workflow binds Hub #30 with single-repository App scope and rejects broad delivery overrides', async () => {
  const selection = { profile: 'hub', workflow: 'c1g' };
  const { profile, workflow } = selectWorkflow(selection);
  assert.equal(profile.repository, HUB_REPO); assert.equal(profile.base, 'main');
  assert.deepEqual(workflow, { id: 'c1g', branch: 'codex/c1g-dashboard-readonly', work_item: { repo: HUB_REPO, issue: 30 }, verification_commands: ['pnpm check'], bootstrap_paths: null });
  const f = fake({ branch: workflow.branch, installed: selectedSets[3] });
  const builder = await connectBuilder(f.deps, selection);
  const handoff = structuredClone(record); handoff.work_item.issue = 30;
  await assert.rejects(builder.ready(5, head, record, 10), /work item/);
  await assert.rejects(builder.ready(5, 'c'.repeat(40), handoff, 10), /Confirmed Handoff validation failed/);
  const wrongChecks = structuredClone(handoff); wrongChecks.verification.checks[0].command = 'arbitrary command';
  await assert.rejects(builder.ready(5, head, wrongChecks, 10), /verification commands/);
  const tokens = f.requests.filter(request => request.url.endsWith('/access_tokens')).map(request => JSON.parse(request.body));
  assert.deepEqual(tokens[0], { permissions: inspectionPermissions });
  assert.deepEqual(tokens[1], { repositories: ['agent-workflow-hub'], permissions: { contents: 'write', issues: 'write', pull_requests: 'write' } });
  for (const key of ['approve', 'review', 'merge', 'request', 'fetch', 'token']) assert.equal(builder[key], undefined);
  for (const key of ['repo', 'base', 'branch', 'api', 'url', 'git', 'gh']) assert.throws(() => selectWorkflow({ ...selection, [key]: 'untrusted' }));
});

test('C1-H fixed workflow binds offline Hub #31 and refuses work-item, head, checks and target overrides', async () => {
  const selection = { profile: 'hub', workflow: 'c1h' };
  const { profile, workflow } = selectWorkflow(selection);
  assert.equal(profile.repository, HUB_REPO); assert.equal(profile.base, 'main');
  assert.deepEqual(workflow, { id: 'c1h', branch: 'codex/c12-trusted-onboarding',
    work_item: { repo: HUB_REPO, issue: 31 }, verification_commands: ['pnpm check'], bootstrap_paths: null });
  const f = fake({ branch: workflow.branch, installed: selectedSets[3] });
  const builder = await connectBuilder(f.deps, selection);
  const handoff = structuredClone(record); handoff.work_item.issue = 31;
  await assert.rejects(builder.ready(5, head, record, 10), /work item/);
  await assert.rejects(builder.ready(5, 'c'.repeat(40), handoff, 10), /Confirmed Handoff validation failed/);
  const wrongChecks = structuredClone(handoff); wrongChecks.verification.checks[0].command = 'arbitrary command';
  await assert.rejects(builder.ready(5, head, wrongChecks, 10), /verification commands/);
  assert.equal(f.requests.some(r => r.url.endsWith('/graphql')), false);
  for (const key of ['approve', 'review', 'merge', 'request', 'fetch', 'token']) assert.equal(builder[key], undefined);
  for (const key of ['repo', 'repository', 'base', 'branch', 'work_item', 'verification_commands', 'bootstrap_paths', 'api', 'url', 'git', 'gh'])
    assert.throws(() => selectWorkflow({ ...selection, [key]: 'untrusted' }));
  assert.throws(() => { workflow.work_item.issue = 30; });
  assert.throws(() => { workflow.verification_commands.push('other'); });
  for (const option of ['--url', '--ref', '--git-args', '--dry-run', '--force', '--repo', '--base', '--branch']) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/builder-cli.js', import.meta.url)),
      '--profile', 'hub', '--workflow', 'c1h', 'push', option, 'untrusted'],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
    assert.equal(child.status, 2); assert.match(child.stderr, /Unsupported Builder operation/);
  }
});

test('C1-H refuses malformed installation scope and broader write tokens before delivery', async () => {
  const selection = { profile: 'hub', workflow: 'c1h' };
  for (const response of [
    (url, _, v) => url.endsWith('/installation') ? { ...v, repository_selection: 'all' } : v,
    (url, _, v) => url.includes('/installation/repositories') ? { ...v, total_count: v.total_count + 1 } : v,
    (url, _, v) => url.includes('/installation/repositories') ? { total_count: 5, repositories: [...v.repositories, { full_name: 'zlpoot/fifth' }] } : v,
    (url, _, v) => url.includes('/installation/repositories') ? { total_count: 4, repositories: [...v.repositories.slice(0, 3), v.repositories[0]] } : v,
    (url, options, v) => url.endsWith('/access_tokens') && JSON.parse(options.body).repositories
      ? { ...v, repositories: [{ full_name: HUB_REPO }, { full_name: FUTURE_REPO }] } : v,
    (url, options, v) => url.endsWith('/access_tokens') && JSON.parse(options.body).repositories
      ? { ...v, permissions: { ...v.permissions, administration: 'write' } } : v,
  ]) {
    const f = fake({ branch: 'codex/c12-trusted-onboarding', installed: selectedSets[3], response });
    await assert.rejects(connectBuilder(f.deps, selection), /mismatch|not allowed|only the selected/);
    assert.equal(f.git.some(g => g[1][0] === 'push'), false);
    assert.equal(f.requests.some(r => r.url.endsWith('/pulls')), false);
  }
});

test('scoped-helper repair workflow binds Hub #16 and exact-head Ready; arbitrary transport options refused', async () => {
  const selection = { profile: 'hub', workflow: 'c07-r3' };
  const { profile, workflow } = selectWorkflow(selection);
  assert.equal(profile.repository, HUB_REPO); assert.equal(profile.base, 'main');
  assert.deepEqual(workflow, { id: 'c07-r3', branch: 'codex/c07-r3-scoped-helper', work_item: { repo: HUB_REPO, issue: 16 },
    verification_commands: ['pnpm check'], bootstrap_paths: null });
  const handoff = structuredClone(record); handoff.work_item.issue = 16;
  const body = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`\n${JSON.stringify(validation)}`;
  const f = fake({ branch: workflow.branch, handoffBody: body, installed: selectedSets[3] });
  const builder = await connectBuilder(f.deps, selection);
  await assert.rejects(builder.ready(5, head, record, 10), /work item/);
  assert.equal((await builder.ready(5, head, handoff, 10)).draft, false);
  for (const option of ['--url', '--ref', '--git-args', '--dry-run', '--force', '--repo', '--base', '--branch']) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/builder-cli.js', import.meta.url)),
      '--profile', 'hub', '--workflow', 'c07-r3', 'push', option, 'untrusted'],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: 'Unsupported Builder operation or arguments' });
  }
  assert(PROFILES.every(p => p.id !== 'agent-desktop'));
});

test('transport: expired token after authenticated read cannot dispatch push', async () => {
  const f = fake(), spawn = f.deps.spawn;
  f.deps.spawn = (...args) => {
    const result = spawn(...args);
    if (args[1].includes('ls-remote')) f.advance(3600000);
    return result;
  };
  await assert.rejects((await connectBuilder(f.deps)).push(), /token expired/);
  assert.equal(transportCalls(f).length, 1);
});

test('transport repair workflow binds Hub #10 and exact-head Ready without changing external Profiles', async () => {
  const selection = { profile: 'hub', workflow: 'c07-r1' };
  const { profile, workflow } = selectWorkflow(selection);
  assert.equal(profile.repository, HUB_REPO); assert.equal(profile.base, 'main');
  assert.deepEqual(workflow, { id: 'c07-r1', branch: 'codex/c07-r1-git-transport',
    work_item: { repo: HUB_REPO, issue: 10 }, verification_commands: ['pnpm check'], bootstrap_paths: null });
  const handoff = structuredClone(record); handoff.work_item.issue = 10;
  const body = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`\n${JSON.stringify(validation)}`;
  const f = fake({ branch: workflow.branch, handoffBody: body, installed: selectedSets[3] });
  const builder = await connectBuilder(f.deps, selection);
  await assert.rejects(builder.ready(5, head, record, 10), /work item/);
  assert.equal((await builder.ready(5, head, handoff, 10)).draft, false);
  assert(PROFILES.every(p => p.id !== 'agent-desktop'));
});

function transportCLI(mode, stage = 'dry-run') {
  const script = `
    import { generateKeyPairSync } from 'node:crypto';
    import fs from 'node:fs/promises';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({type:'pkcs8',format:'pem'});
    const realpath = fs.realpath;
    fs.realpath = async path => String(path).endsWith('generated-memory-key.pem') ? path : realpath(path);
    fs.readFile = async () => Buffer.from(key);
    let jwt;
    const mode = ${JSON.stringify(mode)};
    const stage = ${JSON.stringify(stage)};
    cp.spawnSync = (_, args) => {
      if (args[0] === 'rev-parse') return {status:0,stdout:${JSON.stringify(repoRoot)}};
      if (args.includes('--get')) return {status:0,stdout:'https://github.com/${REPO}.git'};
      if (args[0] === 'config') return {status:0,stdout:'remote.origin.url'};
      if (args[0] === 'branch') return {status:0,stdout:${JSON.stringify(BRANCH)}};
      const isTarget = stage === 'ls-remote' ? args.includes('ls-remote') : stage === 'dry-run' ? args.includes('--dry-run') : args.includes('push') && !args.includes('--dry-run');
      if (!isTarget) return {status:0,stdout:'${base}\\trefs/heads/main\\n',stderr:''};
      const leaked = mode === 'pem' ? key : mode === 'jwt' ? jwt : mode === 'token' ? 'fake-installation-secret' :
        mode === 'basic' ? Buffer.from('x-access-token:fake-installation-secret').toString('base64') :
        mode === 'token-like' ? 'github_pat_untrustedToken' : mode === 'header' ? 'AUTHORIZATION: basic untrustedCredential' :
        mode === 'jwt-pattern' ? 'eyJunknown.payload.signature' : mode === 'partial-pem' ? '-----BEGIN PRIVATE KEY-----\\nunbounded secret' : undefined;
      if (mode === 'spawn') throw new Error('fake-installation-secret Authentication failed');
      return {status:mode === 'success' || mode === 'secret-success' ? 0 : 128,stdout:mode === 'secret-success' ? 'fake-installation-secret' : leaked || 'untrusted-success-output',stderr:leaked ? 'Authentication failed' : mode === 'success' || mode === 'secret-success' ? '' : mode};
    };
    syncBuiltinESMExports();
    process.env.AWH_GITHUB_APP_ID = '123';
    process.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH = join(tmpdir(), 'generated-memory-key.pem');
    const permissions = ${JSON.stringify(permissions)};
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/app')) jwt = options.headers.Authorization.slice(7);
      const v = url.endsWith('/app') ? {id:123,slug:'test-builder'} : url.endsWith('/installation') ?
        {id:456,app_id:123,account:{login:'zlpoot'},repository_selection:'selected',suspended_at:null,permissions} :
        url.includes('/installation/repositories') ? {total_count:1,repositories:[{full_name:'${REPO}'}]} :
        url.includes('/git/ref/heads/') ? {ref:'refs/heads/${BRANCH}',url:'https://api.github.com/repos/${REPO}/git/refs/heads/${BRANCH}',
          object:{type:'commit',sha:'${head}',url:'https://api.github.com/repos/${REPO}/git/commits/${head}'}} :
        {token:'fake-installation-secret',expires_at:new Date(Date.now()+3599000).toISOString(),permissions:JSON.parse(options.body).repositories?permissions:{metadata:'read'},repositories:[{full_name:'${REPO}'}]};
      return new Response(JSON.stringify(v));
    };
    process.argv = [process.execPath, 'builder-cli.js', 'push'];
    await import('./dist/builder-cli.js');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: repoRoot, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
}

test('transport real CLI emits only fixed error, stage and machine-readable category for all six classes', () => {
  for (const [mode, category] of [
    ['Failed to connect to proxy', 'git_network_or_proxy'], ['Authentication failed', 'git_authentication'],
    ['remote: Write access to repository not granted', 'git_remote_permission_or_policy'],
    ['non-fast-forward', 'git_non_fast_forward_or_ref_conflict'], ['Operation timed out', 'git_timeout'],
    ['untrusted arbitrary upstream text', 'git_transport_unknown'],
  ]) {
    const child = transportCLI(mode);
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: stageMessage('dry-run'), stage: stageName('dry-run'), category });
  }
});

test('transport real CLI exposes only safe suppression provenance and sanitized category', () => {
  for (const stage of ['ls-remote', 'dry-run', 'push']) for (const [mode, suppression_reason] of [ ['pem', ['known_private_key']], ['jwt', ['jwt_pattern', 'known_jwt']],
    ['token', ['known_installation_token']], ['basic', ['known_basic_credential']], ['token-like', ['github_token_pattern']],
    ['header', ['authorization_header']], ['jwt-pattern', ['jwt_pattern']] ]) {
    const child = transportCLI(mode, stage);
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: stageMessage(stage) + ' (details suppressed)',
      stage: stageName(stage), category: 'git_authentication', suppression_reason });
  }
});

test('transport real CLI success stdout does not disclose credentials or Git output', () => {
  const child = transportCLI('success');
  assert.equal(child.status, 0); assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { pushed: BRANCH, actor });
});

test('receive-pack dry-run FAIL leaves real push NOTRUN; expiry after dry-run also blocks push', async () => {
  const failed = failingTransport('dry-run', { status: 1, stdout: '', stderr: 'remote rejected: hook declined' });
  await assert.rejects((await connectBuilder(failed.deps)).push(), e => {
    assert.equal(e.stage, 'receive_pack_dry_run');
    assert.equal(e.category, 'git_remote_permission_or_policy'); return true;
  });
  assert.equal(transportCalls(failed).length, 2);
  assert(!transportCalls(failed).some(([, args]) => matchesTransport(args, 'push')));
  const expired = fake(), spawn = expired.deps.spawn;
  expired.deps.spawn = (...args) => {
    const result = spawn(...args);
    if (args[1].includes('--dry-run')) expired.advance(3600000);
    return result;
  };
  await assert.rejects((await connectBuilder(expired.deps)).push(), e => {
    assert.match(e.message, /token expired/);
    assert.equal(e.stage, undefined); assert.equal(e.category, undefined); assert.equal(e.suppression_reason, undefined);
    return true;
  });
  assert.equal(transportCalls(expired).length, 2);
});

test('suppression provenance: every detector, overlaps and duplicates use sorted enums only', async () => {
  const jwt = createJwt('123', pem, now);
  const cases = [
    [pem, ['known_private_key']], [jwt, ['jwt_pattern', 'known_jwt']],
    ['fake-installation-secret fake-inspection-secret', ['known_installation_token']],
    [Buffer.from('x-access-token:fake-installation-secret').toString('base64'), ['known_basic_credential']],
    ['Authorization: custom credential', ['authorization_header']],
    ['ghs_unknown github_pat_unknownSecret', ['github_token_pattern']],
    ['eyJunknown.payload.signature', ['jwt_pattern']],
    [`Authorization: Bearer ${jwt}\nAuthorization: basic ${Buffer.from('x-access-token:fake-installation-secret').toString('base64')}\nfake-installation-secret ghs_unknown\n${pem}`,
      ['authorization_header', 'github_token_pattern', 'jwt_pattern', 'known_basic_credential', 'known_installation_token', 'known_jwt', 'known_private_key']],
  ];
  for (const [secret, reasons] of cases) {
    const f = failingTransport('dry-run', { status: 1, stdout: String(secret), stderr: 'remote: Write access to repository not granted.' });
    await assert.rejects((await connectBuilder(f.deps)).push(), e => {
      assert.deepEqual(e.suppression_reason, reasons);
      assert.equal(e.category, 'git_remote_permission_or_policy');
      assert.deepEqual(Object.keys(e).sort(), ['category', 'stage', 'suppression_reason']);
      assert(!JSON.stringify(e).includes(String(secret))); return true;
    });
  }
});

test('sanitized classifier ignores category words inside credentials, headers, PEM and credential URLs', async () => {
  for (const text of [
    'Authorization: Basic Authentication failed',
    'Authorization: custom Operation timed out',
    '-----BEGIN RSA PRIVATE KEY-----\nGH013 non-fast-forward\n-----END RSA PRIVATE KEY-----',
    '-----begin private key-----\nAuthentication failed\n-----end private key-----',
    'https://user:Authentication_failed@github.com/private/repo.git',
  ]) {
    const f = failingTransport('dry-run', { status: 1, stdout: text, stderr: 'unrecognized failure' });
    await assert.rejects((await connectBuilder(f.deps)).push(), e => {
      assert.equal(e.category, 'git_transport_unknown'); assert.equal(e.stage, 'receive_pack_dry_run');
      assert(!JSON.stringify(e).includes(text)); return true;
    });
  }
  // Known secret contents must be removed before applying the matcher too.
  for (const token of ['Authentication failed', 'Operation timed out', 'non-fast-forward']) {
    const f = failingTransport('dry-run', { status: 1, stdout: token, stderr: 'unrecognized failure' }, {
      response: (url, options, data) => url.endsWith('/access_tokens') && JSON.parse(options.body).repositories ? { ...data, token } : data,
    });
    await assert.rejects((await connectBuilder(f.deps)).push(), e => {
      assert.equal(e.category, 'git_transport_unknown'); assert.deepEqual(e.suppression_reason, ['known_installation_token']); return true;
    });
  }
});

for (const stage of ['ls-remote', 'dry-run', 'push']) test(`suppression provenance: ${stage} unsafe sanitize and direct spawn exception omit category`, async () => {
  const f = failingTransport(stage, { status: 128, stdout: '-----BEGIN PRIVATE KEY-----\nunbounded secret ghs_unknown',
    stderr: 'Authorization: Bearer fake-installation-secret\nAuthentication failed' });
  await assert.rejects((await connectBuilder(f.deps)).push(), e => {
    assert.equal(e.category, undefined); assert.equal(e.stage, stageName(stage));
    assert.deepEqual(e.suppression_reason, ['authorization_header', 'github_token_pattern', 'known_installation_token', 'known_private_key']);
    return true;
  });
  const thrown = fake(), spawn = thrown.deps.spawn;
  thrown.deps.spawn = (...args) => {
    const result = spawn(...args);
    if (matchesTransport(args[1], stage)) throw new Error('Authorization: Bearer fake-installation-secret upstream arbitrary stage');
    return result;
  };
  await assert.rejects((await connectBuilder(thrown.deps)).push(), e => {
    assert.equal(e.message, stageMessage(stage) + ' (details suppressed)');
    assert.equal(e.category, undefined); assert.equal(e.stage, stageName(stage));
    assert.deepEqual(e.suppression_reason, ['spawn_exception']); return true;
  });
  assert.equal(transportCalls(thrown).length, stageCount(stage));
});

test('transport CLI secret raw never appears on either stream for all three fixed stages', () => {
  for (const stage of ['ls-remote', 'dry-run', 'push']) for (const [mode, reasons] of [
    ['spawn', ['spawn_exception']], ['partial-pem', ['known_private_key']],
  ]) {
    const child = transportCLI(mode, stage);
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: stageMessage(stage) + ' (details suppressed)', stage: stageName(stage), suppression_reason: reasons });
  }
  for (const stage of ['ls-remote', 'dry-run', 'push']) {
    const child = transportCLI('secret-success', stage);
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: stageMessage(stage) + ' (details suppressed)', stage: stageName(stage),
      category: 'git_transport_unknown', suppression_reason: ['known_installation_token'] });
  }
});

test('fixed receive-pack URL/ref and WebSkill-only write token across all existing Profiles', async () => {
  for (const profile of PROFILES) for (const workflow of profile.workflows) {
    const f = fake({ repository: profile.repository, branch: workflow.branch, installed: selectedSets[3] });
    await (await connectBuilder(f.deps, { profile: profile.id, workflow: workflow.id })).push();
    const [read, dry, push] = transportCalls(f);
    assert.deepEqual(dry[1].slice(6), ['push', '--dry-run', `https://github.com/${profile.repository}.git`, `HEAD:refs/heads/${workflow.branch}`]);
    assert.deepEqual(push[1].slice(6), ['push', `https://github.com/${profile.repository}.git`, `HEAD:refs/heads/${workflow.branch}`]);
    assert.strictEqual(read[2].env, dry[2].env); assert.strictEqual(dry[2].env, push[2].env);
    const mint = f.requests.filter(r => r.url.endsWith('/access_tokens'));
    assert.deepEqual(JSON.parse(mint[0].body), { permissions: { metadata: 'read' } });
    assert.deepEqual(JSON.parse(mint[1].body).repositories, [profile.repository.split('/')[1]]);
    if (profile.id === 'webskill') assert.deepEqual(JSON.parse(mint[1].body).repositories, ['webskill']);
  }
});

test('receive-pack repair workflow binds Hub #13 and exact-head Ready; arbitrary transport options refused', async () => {
  const selection = { profile: 'hub', workflow: 'c07-r2' };
  const { profile, workflow } = selectWorkflow(selection);
  assert.equal(profile.repository, HUB_REPO); assert.equal(profile.base, 'main');
  assert.deepEqual(workflow, { id: 'c07-r2', branch: 'codex/c07-r2-receive-pack', work_item: { repo: HUB_REPO, issue: 13 },
    verification_commands: ['pnpm check'], bootstrap_paths: null });
  const handoff = structuredClone(record); handoff.work_item.issue = 13;
  const body = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`\n${JSON.stringify(validation)}`;
  const f = fake({ branch: workflow.branch, handoffBody: body, installed: selectedSets[3] });
  const builder = await connectBuilder(f.deps, selection);
  await assert.rejects(builder.ready(5, head, record, 10), /work item/);
  assert.equal((await builder.ready(5, head, handoff, 10)).draft, false);
  for (const option of ['--url', '--ref', '--git-args', '--dry-run', '--force', '--repo', '--base', '--branch']) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/builder-cli.js', import.meta.url)),
      '--profile', 'hub', '--workflow', 'c07-r2', 'push', option, 'untrusted'],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: 'Unsupported Builder operation or arguments' });
  }
  assert(PROFILES.every(p => p.id !== 'agent-desktop'));
});

const fixedRefResponse = (repository = REPO, branch = BRANCH, commit = head) => ({
  ref: `refs/heads/${branch}`, url: `https://api.github.com/repos/${repository}/git/refs/heads/${branch}`,
  object: { type: 'commit', sha: commit, url: `https://api.github.com/repos/${repository}/git/commits/${commit}` },
});
const absentRef = () => new Response('untrusted 404 body fake-installation-secret', { status: 404 });
const presentRef = (commit = head, repository = REPO, branch = BRANCH) => () => new Response(JSON.stringify(fixedRefResponse(repository, branch, commit)));
function refGate(states, overrides = {}) {
  const f = fake(overrides), fetch = f.deps.fetch, spawn = f.deps.spawn, events = [];
  const url = `https://api.github.com/repos/${overrides.repository ?? REPO}/git/ref/heads/${overrides.branch ?? BRANCH}`;
  let reads = 0;
  f.deps.fetch = async (target, options) => {
    if (target !== url) return fetch(target, options);
    f.requests.push({ url: target, ...options }); events.push(reads === 0 ? 'ref_before' : 'ref_after');
    assert(reads < states.length, 'Unexpected extra fixed-ref read');
    return states[reads++](f);
  };
  f.deps.spawn = (...args) => {
    if (args[1].includes('ls-remote')) events.push('read');
    else if (args[1].includes('--dry-run')) events.push('dry-run');
    else if (args[1].includes('push')) events.push('push');
    return spawn(...args);
  };
  return { ...f, events, refURL: url };
}

test('ref-state gate: ABSENT → dry-run → ABSENT permits push via independent App API reads', async () => {
  const f = refGate([absentRef, absentRef]);
  assert.deepEqual(await (await connectBuilder(f.deps)).push(), { pushed: BRANCH, actor });
  assert.deepEqual(f.events, ['ref_before', 'read', 'dry-run', 'ref_after', 'push']);
  const reads = f.requests.filter(r => r.url === f.refURL);
  assert.equal(reads.length, 2);
  for (const r of reads) {
    assert.equal(r.method, 'GET'); assert.equal(r.redirect, 'error'); assert.equal(r.cache, 'no-store');
    assert.equal(r.headers['Cache-Control'], 'no-cache'); assert(r.signal instanceof AbortSignal);
    assert.equal(r.headers.Authorization, 'Bearer fake-installation-secret'); assert.equal(r.body, undefined);
  }
});

test('ref-state gate: PRESENT SHA A → dry-run → same SHA A permits push', async () => {
  const f = refGate([presentRef(), presentRef()]);
  await (await connectBuilder(f.deps)).push();
  assert.deepEqual(f.events, ['ref_before', 'read', 'dry-run', 'ref_after', 'push']);
});

test('ref-state gate: created, updated or deleted remote ref blocks real push', async () => {
  for (const states of [[absentRef, presentRef()], [presentRef(), presentRef(base)], [presentRef(), absentRef]]) {
    const f = refGate(states);
    await assert.rejects((await connectBuilder(f.deps)).push(), e => {
      assert.equal(e.message, 'Fixed feature ref changed during receive-pack dry-run; push refused');
      assert.equal(e.stage, undefined); assert.equal(e.category, undefined); return true;
    });
    assert.deepEqual(f.events, ['ref_before', 'read', 'dry-run', 'ref_after']);
    assert(!transportCalls(f).some(([, args]) => matchesTransport(args, 'push')));
  }
});

test('ref-state gate: malformed JSON, wrong ref/repository/type/SHA and unexpected success status fail closed before or after dry-run', async () => {
  const valid = fixedRefResponse();
  const malformed = [null, [], {}, { ...valid, ref: 'refs/heads/main' }, { ...valid, ref: 'refs/tags/' + BRANCH },
    { ...valid, url: 'https://api.github.com/repos/evil/repo/git/refs/heads/' + BRANCH },
    { ...valid, object: null }, { ...valid, object: { ...valid.object, type: 'tree' } },
    ...['a'.repeat(39), 'g'.repeat(40), 'fake-installation-secret', null, 123].map(sha => ({ ...valid, object: { ...valid.object, sha } })),
    { ...valid, object: { ...valid.object, url: 'https://api.github.com/repos/evil/repo/git/commits/' + head } },
  ].map(value => () => new Response(JSON.stringify(value)));
  malformed.push(() => new Response('invalid JSON Authorization: Bearer fake-installation-secret'),
    () => new Response(JSON.stringify(valid), { status: 201 }));
  for (const bad of malformed) for (const at of ['before', 'after']) {
    const f = refGate(at === 'before' ? [bad] : [presentRef(), bad]);
    await assert.rejects((await connectBuilder(f.deps)).push(), e => {
      assert(e.message === 'Invalid fixed feature ref state (details suppressed)' || e.message === 'Fixed feature ref state unavailable (details suppressed)');
      assert.equal(e.stage, undefined); assert.equal(e.category, undefined); assert(!e.message.includes('fake-installation-secret')); return true;
    });
    assert.deepEqual(f.events, at === 'before' ? ['ref_before'] : ['ref_before', 'read', 'dry-run', 'ref_after']);
  }
});

test('ref-state gate: API/network/redirect failures before or after dry-run block real push with no upstream diagnostics', async () => {
  const failures = [401, 403, 409, 422, 500].map(status => () => new Response('Authorization: Bearer fake-installation-secret', { status }));
  failures.push(() => { throw new Error('network timeout fake-installation-secret'); },
    () => { throw new TypeError('redirect to https://user:fake-installation-secret@evil.invalid'); });
  for (const bad of failures) for (const at of ['before', 'after']) {
    const f = refGate(at === 'before' ? [bad] : [presentRef(), bad]);
    await assert.rejects((await connectBuilder(f.deps)).push(), e => {
      assert.equal(e.message, 'Fixed feature ref state unavailable (details suppressed)');
      assert.equal(e.stage, undefined); assert.equal(e.category, undefined); assert.equal(e.suppression_reason, undefined); return true;
    });
    assert.deepEqual(f.events, at === 'before' ? ['ref_before'] : ['ref_before', 'read', 'dry-run', 'ref_after']);
  }
});

test('ref-state gate: token expiry during either ref read, JSON decode or after readback blocks push', async () => {
  for (const at of ['before', 'after']) for (const point of ['response', 'json']) {
    const expire = f => {
      if (point === 'response') { f.advance(3600000); return absentRef(); }
      const r = presentRef()();
      const json = r.json.bind(r); r.json = async () => { const value = await json(); f.advance(3600000); return value; };
      return r;
    };
    const f = refGate(at === 'before' ? [expire] : [presentRef(), expire]);
    await assert.rejects((await connectBuilder(f.deps)).push(), /token expired/);
    assert.deepEqual(f.events, at === 'before' ? ['ref_before'] : ['ref_before', 'read', 'dry-run', 'ref_after']);
  }
});

test('ref-state gate: each Profile always uses its fixed repository/feature branch and single write token', async () => {
  for (const profile of PROFILES) for (const workflow of profile.workflows) {
    const f = refGate([absentRef, absentRef], { repository: profile.repository, branch: workflow.branch, installed: selectedSets[3] });
    const b = await connectBuilder(f.deps, { profile: profile.id, workflow: workflow.id });
    assert.equal(b.readFeatureRefState, undefined); assert.equal(b.refState, undefined);
    // JS arguments cannot override this no-argument fixed operation.
    await b.push({ ref: 'refs/heads/main', url: 'https://evil.invalid', repository: 'evil/repo' });
    const reads = f.requests.filter(r => r.url === f.refURL);assert.equal(reads.length, 2);
    assert(reads.every(r => r.url === `https://api.github.com/repos/${profile.repository}/git/ref/heads/${workflow.branch}`));
    assert.deepEqual(f.events, ['ref_before', 'read', 'dry-run', 'ref_after', 'push']);
    assert.deepEqual(JSON.parse(f.requests.find(r => r.url.endsWith('/access_tokens') && JSON.parse(r.body).repositories).body).repositories,
      [profile.repository.split('/')[1]]);
    assert(!f.requests.some(r => r.url.includes('evil.invalid') || r.url.includes('evil/repo')));
  }
});

test('ref-state gate: read or dry-run failure skips the after-ref read and real push', async () => {
  for (const stage of ['ls-remote', 'dry-run']) {
    const f = refGate([absentRef]), spawn = f.deps.spawn;
    f.deps.spawn = (...args) => {
      const normal = spawn(...args);
      return matchesTransport(args[1], stage) ? { status: 128, stdout: '', stderr: 'Authentication failed' } : normal;
    };
    await assert.rejects((await connectBuilder(f.deps)).push(), e => e.stage === stageName(stage));
    assert.deepEqual(f.events, stage === 'ls-remote' ? ['ref_before', 'read'] : ['ref_before', 'read', 'dry-run']);
  }
});


const nativeReview = (id, state = 'APPROVED', commit = head, login = 'independent-reviewer') => ({ id, state, commit_id: commit, user: { login, type: 'User' } });
function lifecycleFixture(reviews = [], { merged = false, issueClosed = false, mutate } = {}) {
  return fake({ response: (url, options, value) => {
    if (url.includes('/reviews?')) value = reviews;
    else if (url.endsWith('/issues/4')) value = { number: 4, state: issueClosed ? 'closed' : 'open' };
    else if (url.endsWith('/pulls/5')) value = { ...value, merged, state: merged ? 'closed' : 'open', merge_commit_sha: merged ? 'c'.repeat(40) : null };
    return mutate ? mutate(url, value) : value;
  } });
}
test('MVP provider closeout reads exact native approval, merged PR and closed Issue without mutations', async () => {
  const f=lifecycleFixture([nativeReview(101)],{merged:true,issueClosed:true});
  const b=await connectBuilder(f.deps),r=await b.readLifecycle(5,head);
  assert.equal(r.review.id,101);assert(r.merged&&r.issue_closed);assert.equal(r.merge_sha,'c'.repeat(40));assert.equal(r.authority_verified,false);
  assert(f.requests.filter(x=>!x.url.endsWith('/access_tokens')).every(x=>x.method==='GET'));
});
test('MVP wrong-head, dismissed, bot and superseded approvals cannot complete; change requests block',async()=>{
  for(const reviews of [[nativeReview(1,'APPROVED',base)], [nativeReview(1),nativeReview(2,'DISMISSED')], [nativeReview(1),nativeReview(2,'CHANGES_REQUESTED')], [{...nativeReview(1),user:{login:actor,type:'Bot'}}]]) {
    const f=lifecycleFixture(reviews,{merged:true,issueClosed:true});const r=await(await connectBuilder(f.deps)).readLifecycle(5,head);assert.equal(r.review,null);
  }
  const f=lifecycleFixture([nativeReview(1),nativeReview(2,'COMMENTED')]);assert.equal((await(await connectBuilder(f.deps)).readLifecycle(5,head)).review.id,1);
});
test('MVP provider read refuses wrong head, malformed Review and changing merge state',async()=>{
  let reads=0;
  for(const mutate of [(url,v)=>url.endsWith('/pulls/5')?{...v,head:{...v.head,sha:base}}:v, (url,v)=>url.includes('/reviews?')?[{id:1,state:'APPROVED'}]:v, (url,v)=>url.endsWith('/pulls/5')&&++reads===2?{...v,state:'closed',merged:true,merge_commit_sha:base}:v]) {
    const f=lifecycleFixture([],{mutate});await assert.rejects((await connectBuilder(f.deps)).readLifecycle(5,head));
  }
});
test('fixed MVP selections preserve separate repositories, work items and docs-only verification',()=>{
  const hub=selectWorkflow({profile:'hub',workflow:'v01-mvp'}),future=selectWorkflow({profile:'future-ui',workflow:'mvp-docs'});
  assert.deepEqual(hub.workflow.work_item,{repo:HUB_REPO,issue:39});assert.equal(hub.workflow.branch,'codex/v01-mvp');
  assert.deepEqual(future.workflow.work_item,{repo:FUTURE_REPO,issue:88});assert.equal(future.workflow.branch,'codex/awh-v01-acceptance');
  assert.deepEqual(future.workflow.verification_commands,['git diff --check origin/main...HEAD']);assert(!future.workflow.bootstrap_paths.includes('package.json'));
});
