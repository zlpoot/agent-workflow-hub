import { createPrivateKey, sign } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHandoff } from './validator.js';

export const REPO = 'zlpoot/agent-workflow-hub';
export const BRANCH = 'codex/c05-github-app-builder';
const API = 'https://api.github.com';
const ROOT = `/repos/${REPO}`;
const PERMISSIONS = { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' };
const WRITE_PERMISSIONS = { contents: 'write', issues: 'write', pull_requests: 'write' };
const INSPECTION_PERMISSIONS = { metadata: 'read' };
function fail(message: string): never { throw new BuilderError(message); }
export class BuilderError extends Error {}
type Json = Record<string, any>; // GitHub JSON is checked at each boundary before use.
export interface Dependencies {
  env: NodeJS.ProcessEnv;
  now: () => number;
  read: typeof readFile;
  fetch: typeof fetch;
  spawn: typeof spawnSync;
  cwd: () => string;
  realpath: typeof realpath;
}
const defaults: Dependencies = { env: process.env, now: Date.now, read: readFile, fetch, spawn: spawnSync,
  cwd: process.cwd, realpath };
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
const equalPermissions = (p: unknown, expected: Record<string, string> = PERMISSIONS) => p !== null && typeof p === 'object' &&
  JSON.stringify(Object.entries(p).sort()) === JSON.stringify(Object.entries(expected).sort());

// Root inspection has no App credentials. Authenticate Git only after the root and key boundary are proven.
function gitEnvironment(source: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(source).filter(([k]) =>
    !/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$)/i.test(k)));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: root.replaceAll('\\', '/'),
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_TERMINAL_PROMPT: '0' };
}

export function createJwt(appId: string, pem: Buffer | string, now: number): string {
  if (!/^[1-9]\d*$/.test(appId) || !Number.isSafeInteger(Number(appId))) fail('Invalid App ID');
  if (!Number.isFinite(now) || now < 60000) fail('Invalid clock');
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') fail('Private key must be RSA');
    const seconds = Math.floor(now / 1000);
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
  } catch { return fail('Private key is not a usable RSA signing key'); }
}

// Returns only fixed Builder operations. Credentials and generic API requests stay in this closure.
export async function connectBuilder(overrides: Partial<Dependencies> = {}) {
  const d = { ...defaults, ...overrides };
  const appId = d.env.AWH_GITHUB_APP_ID;
  const keyPath = d.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId || !keyPath) fail('Required App ID or private key path environment is missing');
  const override = d.env.AWH_GITHUB_INSTALLATION_ID;
  if (override && (!/^[1-9]\d*$/.test(override) || !positive(Number(override)))) fail('Invalid installation ID override');
  if (!isAbsolute(keyPath)) fail('Private key path must be absolute and outside the repository');
  let root: string;
  try {
    // The helper lives in src/ or dist/ of its worktree. Trust only that directory for the Git root query.
    const helperRoot = await d.realpath(fileURLToPath(new URL('../', import.meta.url)));
    const query = d.spawn('git', ['rev-parse', '--show-toplevel'], {
      cwd: d.cwd(), env: gitEnvironment(d.env, helperRoot), encoding: 'utf8', timeout: 10000,
    });
    if (query.error || query.status !== 0 || !query.stdout.trim() || !isAbsolute(query.stdout.trim()))
      fail('Cannot resolve repository worktree root');
    root = await d.realpath(query.stdout.trim());
    if (root !== helperRoot) fail('Builder must run within its own repository worktree');
  } catch { return fail('Cannot verify repository worktree root (details suppressed)'); }
  let canonicalKeyPath: string;
  try { canonicalKeyPath = await d.realpath(keyPath); }
  catch { return fail('Private key file unavailable; check existence and read permissions'); }
  const rel = relative(root, canonicalKeyPath);
  if (!rel || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)))
    fail('Private key must be outside the repository');
  let pem: Buffer;
  try { pem = await d.read(canonicalKeyPath) as Buffer; }
  catch { return fail('Private key file unavailable; check existence and read permissions'); }
  const jwt = createJwt(appId, pem, d.now());
  const secrets = [pem.toString(), jwt];
  const safeText = (v: unknown): string => {
    if (typeof v !== 'string' || secrets.some(s => s && v.includes(s)) ||
      /-----BEGIN .*PRIVATE KEY-----|\b(?:gh[psuor]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(v))
      fail('Secret-like or invalid text refused');
    return v;
  };
  const request = async (path: string, credential: string, method = 'GET', body?: unknown): Promise<Json> => {
    let r: Response;
    let value: unknown;
    try {
      r = await d.fetch(`${API}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!r.ok) fail(`GitHub request failed (HTTP ${r.status})`);
      value = await r.json();
    } catch (e) {
      if (e instanceof BuilderError) throw e;
      return fail('GitHub request failed (network, timeout, redirect or invalid JSON; details suppressed)');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid GitHub response');
    return value as Json;
  };
  const app = await request('/app', jwt);
  if (app.id !== Number(appId) || typeof app.slug !== 'string' || !/^[a-z0-9-]+$/.test(app.slug)) fail('App identity mismatch');
  const actor = `${app.slug}[bot]`;
  const inst = await request(`${ROOT}/installation`, jwt);
  if (!positive(inst.id) || inst.app_id !== Number(appId) || inst.account?.login !== 'zlpoot' ||
    inst.repository_selection !== 'selected' || inst.suspended_at !== null || !equalPermissions(inst.permissions) ||
    (override !== undefined && Number(override) !== inst.id)) fail('Installation identity, scope or permissions mismatch');
  const mint = async (restricted: boolean) => {
    const v = await request(`/app/installations/${inst.id}/access_tokens`, jwt, 'POST', {
      ...(restricted ? { repositories: ['agent-workflow-hub'] } : {}),
      permissions: restricted ? WRITE_PERMISSIONS : INSPECTION_PERMISSIONS,
    });
    if (typeof v.token !== 'string' || !v.token || typeof v.expires_at !== 'string') fail('Invalid installation token response');
    secrets.push(v.token, Buffer.from(`x-access-token:${v.token}`).toString('base64'));
    const expiry = Date.parse(v.expires_at);
    // GitHub's clock can be slightly ahead of the local clock; never extend the returned expiry itself.
    if (!Number.isFinite(expiry) || expiry <= d.now() || expiry > d.now() + 3600000 + 60000)
      fail('Invalid installation token expiry');
    if (!equalPermissions(v.permissions, restricted ? PERMISSIONS : INSPECTION_PERMISSIONS)) fail('Installation token permissions mismatch');
    return { token: v.token as string, expiry };
  };
  // Metadata-only inspection covers the *actual* installation scope without granting writes to extra repositories.
  const scopeToken = await mint(false);
  const repositories = await request('/installation/repositories?per_page=100', scopeToken.token);
  if (repositories.total_count !== 1 || !Array.isArray(repositories.repositories) ||
    repositories.repositories.length !== 1 || repositories.repositories[0]?.full_name !== REPO)
    fail('Installation must select only the target repository');
  const { token, expiry } = await mint(true);
  const live = () => { if (d.now() >= expiry) fail('Installation token expired; rerun the command'); };
  const call = (path: string, method = 'GET', body?: unknown) => { live(); return request(path, token, method, body); };
  const id = (v: number) => { if (!positive(v)) fail('Invalid GitHub object number'); return v; };
  const prSummary = (p: Json) => {
    if (!positive(p.number) || p.user?.login !== actor || p.user?.type !== 'Bot' || !sha(p.head?.sha) ||
      !sha(p.base?.sha) || p.head?.ref !== BRANCH || p.base?.ref !== 'main' ||
      p.head?.repo?.full_name !== REPO || p.base?.repo?.full_name !== REPO ||
      p.state !== 'open' || typeof p.draft !== 'boolean' || typeof p.node_id !== 'string' || !/^[A-Za-z0-9_=+-]+$/.test(p.node_id))
      fail('PR identity, repository, branch or state mismatch');
    return { number: p.number as number, url: `https://github.com/${REPO}/pull/${p.number}`, actor,
      head: p.head.sha as string, base: p.base.sha as string, draft: p.draft as boolean, node_id: safeText(p.node_id) };
  };
  const readPR = async (number: number) => prSummary(await call(`${ROOT}/pulls/${id(number)}`));
  const commentSummary = (c: Json, number: number) => {
    if (!positive(c.id) || c.user?.login !== actor || c.user?.type !== 'Bot' || c.issue_url !== `${API}${ROOT}/issues/${id(number)}`)
      fail('Comment actor or PR mismatch');
    return { id: c.id as number, actor, url: `https://github.com/${REPO}/pull/${number}#issuecomment-${c.id}`, body: safeText(c.body) };
  };
  const readComment = async (number: number, comment: number) =>
    commentSummary(await call(`${ROOT}/issues/comments/${id(comment)}`), number);
  return Object.freeze({
    preflight: () => ({ repo: REPO, app_id: Number(appId), installation_id: inst.id as number, actor,
      repository_selection: 'selected', repositories: [REPO], permissions: { ...PERMISSIONS } }),
    push: () => {
      live();
      const inspectEnv = gitEnvironment(d.env, root);
      const env = { ...inspectEnv };
      const config = [
        ['http.extraheader', ''], ['http.https://github.com/.extraheader', ''],
        ['http.https://github.com/.extraheader', `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`],
        ['credential.helper', ''], ['safe.directory', root.replaceAll('\\', '/')],
      ];
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_COUNT: String(config.length), GIT_TERMINAL_PROMPT: '0' });
      config.forEach(([k, v], i) => Object.assign(env, { [`GIT_CONFIG_KEY_${i}`]: k, [`GIT_CONFIG_VALUE_${i}`]: v }));
      try {
        // Local URL rewrites, proxies and credential configuration could reroute the authenticated push.
        const local = d.spawn('git', ['config', '--local', '--name-only', '--list'],
          { cwd: root, env: inspectEnv, encoding: 'utf8', timeout: 10000 });
        if (local.error || local.status !== 0 || /^(http\.|https\.|url\.|credential\.|include|core\.(gitproxy|sshcommand))/im.test(local.stdout))
          fail('Unsafe local Git transport configuration');
        const branch = d.spawn('git', ['branch', '--show-current'], { cwd: root, env: inspectEnv, encoding: 'utf8', timeout: 10000 });
        if (branch.error || branch.status !== 0 || branch.stdout.trim() !== BRANCH) fail('Push requires the C0.5 feature branch');
        const r = d.spawn('git', ['-c', 'credential.helper=', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
          '-c', 'http.followRedirects=false', 'push', `https://github.com/${REPO}.git`, `HEAD:refs/heads/${BRANCH}`],
        { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
        if (r.error || r.status !== 0) fail('App HTTPS Git push failed (details suppressed)');
      } catch { fail('App HTTPS Git push failed (details suppressed)'); }
      return { pushed: BRANCH, actor };
    },
    createPR: async (title: string, body: string) => prSummary(await call(`${ROOT}/pulls`, 'POST',
      { title: safeText(title), body: safeText(body), head: BRANCH, base: 'main', draft: true })),
    updatePR: async (number: number, title: string, body: string) => {
      await readPR(number);
      return prSummary(await call(`${ROOT}/pulls/${id(number)}`, 'PATCH', { title: safeText(title), body: safeText(body) }));
    },
    readPR,
    createComment: async (number: number, body: string) => {
      await readPR(number);
      return commentSummary(await call(`${ROOT}/issues/${id(number)}/comments`, 'POST', { body: safeText(body) }), number);
    },
    editComment: async (number: number, comment: number, body: string) => {
      await readPR(number); await readComment(number, comment);
      return commentSummary(await call(`${ROOT}/issues/comments/${id(comment)}`, 'PATCH', { body: safeText(body) }), number);
    },
    readComment,
    ready: async (number: number, expectedHead: string, record: unknown, comment: number) => {
      const validation = validateHandoff(record, expectedHead);
      if (!validation.ready_claim_valid) fail('Confirmed Handoff validation failed');
      const handoff = record as import('./validator.js').BuilderHandoff;
      if (handoff.work_item.repo !== REPO || handoff.work_item.issue !== 4 || handoff.candidate.pr !== number)
        fail('Handoff work item or PR mismatch');
      const p = await readPR(number);
      if (p.head !== expectedHead || p.base !== handoff.candidate.base_sha) fail('Remote PR version mismatch');
      const c = await readComment(number, comment);
      const blocks = [...c.body.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
      let published: unknown;
      try { published = JSON.parse(blocks[0]?.[1] ?? ''); } catch { fail('Published Handoff JSON missing'); }
      if (!c.body.startsWith('AWH-HANDOFF v0.1\n') || JSON.stringify(published) !== JSON.stringify(record) ||
        !c.body.includes(JSON.stringify(validation))) fail('Published Handoff or CLI result mismatch');
      for (const ref of handoff.verification.evidence_refs) {
        const match = ref.match(new RegExp(`^https://github\\.com/${REPO}/pull/${number}#issuecomment-(\\d+)$`));
        if (!match || Number(match[1]) === comment) fail('Evidence must reference a separate Builder comment on this PR');
        const evidence = await readComment(number, Number(match[1]));
        if (!evidence.body.startsWith('Builder evidence\n') || !evidence.body.includes(expectedHead)) fail('Builder evidence version mismatch');
      }
      const latest = await readPR(number);
      if (latest.head !== expectedHead || latest.base !== p.base) fail('Remote PR version changed');
      try {
        const result = await call('/graphql', 'POST', {
          query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}',
          variables: { id: p.node_id },
        });
        if (result.errors || result.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) fail('Ready publication failed');
        const final = await readPR(number);
        if (final.head !== expectedHead || final.base !== p.base || final.draft) fail('Ready readback or version mismatch');
        return final;
      } catch {
        // A timeout may hide a successful mutation. Restore Draft before reporting any uncertain Ready result.
        try {
          const restored = await call('/graphql', 'POST', {
            query: 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}',
            variables: { id: p.node_id },
          });
          if (restored.errors || restored.data?.convertPullRequestToDraft?.pullRequest?.isDraft !== true)
            fail('Draft restoration failed');
          if (!(await readPR(number)).draft) fail('Draft restoration readback failed');
        } catch { return fail('Ready failed; Draft restoration could not be confirmed'); }
        return fail('Ready failed; PR restored to Draft');
      }
    },
  });
}
