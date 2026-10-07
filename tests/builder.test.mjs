import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBuilder, createJwt, BRANCH, REPO } from '../dist/builder.js';

// Ephemeral key generated in memory; no real credential and no saved key fixture.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const now = 1800000000123;
const permissions = { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' };
const actor = 'test-builder[bot]';
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const pr = { number: 5, user: { login: actor, type: 'Bot' }, head: { sha: head, ref: BRANCH, repo: { full_name: REPO } },
  base: { sha: base, ref: 'main', repo: { full_name: REPO } }, draft: true, state: 'open', node_id: 'PR_test' };
const comment = (id, body) => ({ id, body, user: { login: actor, type: 'Bot' }, issue_url: `https://api.github.com/repos/${REPO}/issues/5` });
const record = { schema_version: '0.1', kind: 'builder_handoff', work_item: { repo: REPO, issue: 4 },
  candidate: { pr: 5, base_sha: base, head_sha: head }, producer: { executor: 'Codex Builder', run_id: 'offline' },
  verification: { subject_sha: head, lifecycle: 'completed', outcome: 'pass', checks: [{ command: 'pnpm check', exit_code: 0 }],
    evidence_refs: [`https://github.com/${REPO}/pull/5#issuecomment-9`] }, handoff: { next_step: 'review', publication: 'confirmed' } };
const validation = { schema_valid: true, ready_claim_valid: true, authority_verified: false, errors: [] };
const handoffBody = `AWH-HANDOFF v0.1\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n\n${JSON.stringify(validation)}`;
function fake(overrides = {}) {
  const requests = [], git = [];
  let clock = now, ready = false;
  const deps = {
    env: { AWH_GITHUB_APP_ID: '123', AWH_GITHUB_APP_PRIVATE_KEY_PATH: join(tmpdir(), 'awh-test-only.pem'),
      PATH: process.env.PATH, GIT_TRACE: '1', GIT_CONFIG_COUNT: '99', GH_TOKEN: 'user-session', GITHUB_TOKEN: 'user-session', NODE_OPTIONS: '--inspect' },
    now: () => clock,
    read: async () => Buffer.from(pem),
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      assert.equal(new URL(url).host, 'api.github.com');
      assert.equal(options.redirect, 'error');
      assert(options.signal instanceof AbortSignal);
      let data;
      if (url.endsWith('/app')) data = { id: 123, slug: 'test-builder' };
      else if (url.endsWith('/installation')) data = { id: 456, app_id: 123, account: { login: 'zlpoot' }, repository_selection: 'selected', suspended_at: null, permissions };
      else if (url.endsWith('/access_tokens')) data = { token: 'fake-installation-secret', expires_at: new Date(now + 3600000).toISOString(), permissions };
      else if (url.includes('/installation/repositories')) data = { total_count: 1, repositories: [{ full_name: REPO }] };
      else if (url.endsWith('/graphql')) { ready = true; data = { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }; }
      else if (url.endsWith('/issues/comments/10')) data = comment(10, handoffBody);
      else if (url.endsWith('/issues/comments/9')) data = comment(9, `Builder evidence\n${head}`);
      else if (url.endsWith('/comments')) data = comment(11, JSON.parse(options.body).body);
      else data = { ...pr, draft: !ready };
      if (overrides.response) data = overrides.response(url, options, data);
      return new Response(JSON.stringify(data));
    },
    spawn: (...args) => {
      git.push(args);
      if (args[1][0] === 'config') return { status: 0, stdout: 'core.bare\nremote.origin.url\n' };
      if (args[1][0] === 'branch') return { status: 0, stdout: BRANCH + '\n' };
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
  assert.deepEqual(JSON.parse(f.requests[2].body), { permissions: { contents: 'write', issues: 'write', pull_requests: 'write' } });
  assert.deepEqual(JSON.parse(f.requests[4].body), { repositories: ['agent-workflow-hub'], permissions: { contents: 'write', issues: 'write', pull_requests: 'write' } });
  assert.equal(f.requests[3].headers.Authorization, 'Bearer fake-installation-secret');
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
    await assert.rejects(connectBuilder(f.deps), /only the target/);
    assert.equal(f.requests.length, 4);
  }
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
  await assert.rejects(b.readPR(5), /expired/); assert.throws(() => b.push(), /expired/);
  assert.equal(f.requests.length, 5);
});

test('Git token stays in child environment, fixed HTTPS branch, no logged-user credential or trace', async () => {
  const f = fake(), b = await connectBuilder(f.deps);
  assert.deepEqual(b.push(), { pushed: BRANCH, actor });
  const [cmd, args, options] = f.git.at(-1);
  assert.equal(cmd, 'git'); assert(args.includes(`https://github.com/${REPO}.git`));
  assert.equal(args.at(-1), `HEAD:refs/heads/${BRANCH}`);
  assert(!JSON.stringify(args).includes('fake-installation-secret'));
  for (const k of ['GIT_TRACE', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'AWH_GITHUB_APP_PRIVATE_KEY_PATH']) assert.equal(options.env[k], undefined);
  assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  const config = Object.fromEntries(Array.from({ length: Number(options.env.GIT_CONFIG_COUNT) }, (_, i) => [options.env[`GIT_CONFIG_KEY_${i}`], options.env[`GIT_CONFIG_VALUE_${i}`]]));
  assert.equal(config['credential.helper'], '');
  assert.equal(config['http.https://github.com/.extraheader'], `Authorization: Basic ${Buffer.from('x-access-token:fake-installation-secret').toString('base64')}`);
});

test('unsafe local Git transport, wrong branch and Git errors are refused safely', async () => {
  for (const unsafe of ['url.evil.insteadof', 'http.proxy', 'credential.helper', 'include.path']) {
    const f = fake({ deps: { spawn: () => ({ status: 0, stdout: unsafe }) } });
    assert.throws((await connectBuilder(f.deps)).push, /push failed/);
  }
  const f = fake({ deps: { spawn: (_, a) => a[0] === 'config' ? { status: 0, stdout: '' } : { status: 0, stdout: 'main' } } });
  assert.throws((await connectBuilder(f.deps)).push, /push failed/);
  const bad = fake({ deps: { spawn: () => { throw new Error(pem); } } });
  assert.throws((await connectBuilder(bad.deps)).push, e => !e.message.includes(pem));
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
    fs.readFile = async () => Buffer.from(key);
    syncBuiltinESMExports();
    process.env.AWH_GITHUB_APP_ID = '123';
    process.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH = join(tmpdir(), 'generated-memory-key.pem');
    const permissions = ${JSON.stringify(permissions)};
    globalThis.fetch = async url => {
      let v = url.endsWith('/app') ? {id:123,slug:'test-builder'} : url.endsWith('/installation') ?
        {id:456,app_id:123,account:{login:'zlpoot'},repository_selection:'selected',suspended_at:null,permissions} :
        url.includes('/installation/repositories') ? {total_count:1,repositories:[{full_name:'${REPO}'}]} :
        {token:'fake-installation-secret',expires_at:new Date(Date.now()+3599000).toISOString(),permissions};
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
