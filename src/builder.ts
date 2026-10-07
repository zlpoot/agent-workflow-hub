import { createPrivateKey, sign } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { relative, isAbsolute, dirname, join } from 'node:path';
import { validateHandoff } from './validator.js';
import { allowedInstallation, selectWorkflow, HUB_REPO, type BuilderSelection } from './profiles.js';

export const REPO = HUB_REPO;
export const BRANCH = selectWorkflow().workflow.branch;
const API = 'https://api.github.com';
const PERMISSIONS = { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' };
const WRITE_PERMISSIONS = { contents: 'write', issues: 'write', pull_requests: 'write' };
const INSPECTION_PERMISSIONS = { metadata: 'read' };
function fail(message: string): never { throw new BuilderError(message); }
type GitTransportCategory = 'git_network_or_proxy' | 'git_authentication' | 'git_remote_permission_or_policy' |
  'git_non_fast_forward_or_ref_conflict' | 'git_timeout' | 'git_transport_unknown';
type GitTransportStage = 'authenticated_read_probe' | 'receive_pack_dry_run' | 'push';
type SuppressionReason = 'known_private_key' | 'known_jwt' | 'known_installation_token' |
  'known_basic_credential' | 'authorization_header' | 'github_token_pattern' | 'jwt_pattern' | 'spawn_exception';
export class BuilderError extends Error {
  constructor(message: string, readonly category?: GitTransportCategory, readonly stage?: GitTransportStage,
    readonly suppression_reason?: readonly SuppressionReason[]) { super(message); }
}
type Json = Record<string, any>; // GitHub JSON is checked at each boundary before use.
export interface Dependencies {
  env: NodeJS.ProcessEnv;
  now: () => number;
  read: typeof readFile;
  fetch: typeof fetch;
  spawn: typeof spawnSync;
  cwd: () => string;
  realpath: typeof realpath;
  stat: typeof stat;
}
const defaults: Dependencies = { env: process.env, now: Date.now, read: readFile, fetch, spawn: spawnSync,
  cwd: process.cwd, realpath, stat };
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
const equalPermissions = (p: unknown, expected: Record<string, string> = PERMISSIONS) => p !== null && typeof p === 'object' &&
  JSON.stringify(Object.entries(p).sort()) === JSON.stringify(Object.entries(expected).sort());

// Root inspection has no App credentials. Authenticate Git only after the root and key boundary are proven.
function gitEnvironment(source: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(source).filter(([k]) =>
    !/^(GIT_|GH_|GITHUB_|AWH_|SSH_ASKPASS$|SSH_ASKPASS_REQUIRE$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$)/i.test(k)));
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
export async function connectBuilder(overrides: Partial<Dependencies> = {}, selection?: BuilderSelection) {
  const { profile, workflow } = selectWorkflow(selection);
  const REPO = profile.repository, BRANCH = workflow.branch, ROOT = `/repos/${REPO}`;
  const d = { ...defaults, ...overrides };
  const appId = d.env.AWH_GITHUB_APP_ID;
  const keyPath = d.env.AWH_GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId || !keyPath) fail('Required App ID or private key path environment is missing');
  const override = d.env.AWH_GITHUB_INSTALLATION_ID;
  if (override && (!/^[1-9]\d*$/.test(override) || !positive(Number(override)))) fail('Invalid installation ID override');
  if (!isAbsolute(keyPath)) fail('Private key path must be absolute and outside the repository');
  let root: string;
  try {
    // Walk to the nearest .git marker (directory or linked-worktree file), then verify it with Git.
    let candidate = await d.realpath(d.cwd());
    for (;;) {
      try {
        const marker = await d.stat(join(candidate, '.git'));
        if (!marker.isDirectory() && !marker.isFile()) fail('Invalid Git worktree marker');
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const parent = dirname(candidate);
        if (parent === candidate) fail('No Git worktree found');
        candidate = parent;
      }
    }
    const query = d.spawn('git', ['rev-parse', '--show-toplevel'], {
      cwd: candidate, env: gitEnvironment(d.env, candidate), encoding: 'utf8', timeout: 10000,
    });
    if (query.error || query.status !== 0 || !query.stdout.trim() || !isAbsolute(query.stdout.trim()))
      fail('Cannot resolve repository worktree root');
    root = await d.realpath(query.stdout.trim());
    if (root !== candidate) fail('Git worktree root mismatch');
    const origin = d.spawn('git', ['config', '--local', '--get', 'remote.origin.url'], {
      cwd: root, env: gitEnvironment(d.env, root), encoding: 'utf8', timeout: 10000,
    });
    if (origin.error || origin.status !== 0 || ![
      `https://github.com/${REPO}`, `https://github.com/${REPO}.git`, `git@github.com:${REPO}`, `git@github.com:${REPO}.git`,
    ].includes(origin.stdout.trim())) fail('Worktree repository does not match selected Profile');
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
  const knownSecrets: { value: string; reason: SuppressionReason }[] = [
    { value: pem.toString(), reason: 'known_private_key' }, { value: jwt, reason: 'known_jwt' },
  ];
  const secretLike = (v: string) => secrets.some(s => s && v.includes(s)) ||
    /-----BEGIN .*PRIVATE KEY-----|\b(?:gh[psuor]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|authorization\s*:\s*(?:basic|bearer)\s+\S+/i.test(v);
  const safeText = (v: unknown): string => {
    if (typeof v !== 'string' || secretLike(v))
      fail('Secret-like or invalid text refused');
    return v;
  };
  const sanitizeTransport = (text: string) => {
    const reasons = new Set<SuppressionReason>();
    const spans: { start: number; end: number }[] = [];
    let safe = true;
    const add = (start: number, end: number, reason?: SuppressionReason) => {
      if (reason) reasons.add(reason);
      spans.push({ start, end });
    };
    // Detect every match against the original text before replacing overlapping spans.
    for (const { value, reason } of knownSecrets) {
      if (!value) continue;
      for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1))
        add(start, start + value.length, reason);
    }
    for (const [pattern, reason] of [
      [/authorization\s*:[^\r\n]*/gi, 'authorization_header'],
      [/\b(?:gh[psuor]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/gi, 'github_token_pattern'],
      [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, 'jwt_pattern'],
    ] as const) {
      for (const match of text.matchAll(pattern)) add(match.index, match.index + match[0].length, reason);
    }
    // A truncated/unknown PEM cannot be bounded safely, so report only provenance.
    for (const match of text.matchAll(/-----BEGIN ([^\r\n]*PRIVATE KEY)-----/gi)) {
      reasons.add('known_private_key');
      const footer = `-----END ${match[1]}-----`;
      const end = text.toLowerCase().indexOf(footer.toLowerCase(), match.index + match[0].length);
      if (end === -1) safe = false;
      else add(match.index, end + footer.length);
    }
    // Credential URLs are never diagnostic evidence, including unknown userinfo.
    for (const match of text.matchAll(/https?:\/\/[^\s/]*@[^\s]*/gi))
      add(match.index, match.index + match[0].length);
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    let sanitized = '', cursor = 0;
    for (let i = 0; i < spans.length; i++) {
      const start = spans[i]!.start;
      let end = spans[i]!.end;
      while (i + 1 < spans.length && spans[i + 1]!.start <= end) end = Math.max(end, spans[++i]!.end);
      sanitized += text.slice(cursor, start) + '[suppressed]';
      cursor = end;
    }
    sanitized += text.slice(cursor);
    return { text: safe ? sanitized : null, reasons: [...reasons].sort() };
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
      ...(restricted ? { repositories: [REPO.split('/')[1]] } : {}),
      permissions: restricted ? WRITE_PERMISSIONS : INSPECTION_PERMISSIONS,
    });
    if (typeof v.token !== 'string' || !v.token || typeof v.expires_at !== 'string') fail('Invalid installation token response');
    secrets.push(v.token, Buffer.from(`x-access-token:${v.token}`).toString('base64'));
    knownSecrets.push({ value: v.token, reason: 'known_installation_token' },
      { value: Buffer.from(`x-access-token:${v.token}`).toString('base64'), reason: 'known_basic_credential' });
    const expiry = Date.parse(v.expires_at);
    // GitHub's clock can be slightly ahead of the local clock; never extend the returned expiry itself.
    if (!Number.isFinite(expiry) || expiry <= d.now() || expiry > d.now() + 3600000 + 60000)
      fail('Invalid installation token expiry');
    if (!equalPermissions(v.permissions, restricted ? PERMISSIONS : INSPECTION_PERMISSIONS)) fail('Installation token permissions mismatch');
    if (restricted && (!Array.isArray(v.repositories) || v.repositories.length !== 1 || v.repositories[0]?.full_name !== REPO))
      fail('Write token must authorize only the selected Profile repository');
    return { token: v.token as string, expiry };
  };
  // Metadata-only inspection covers the *actual* installation scope without granting writes to extra repositories.
  const scopeToken = await mint(false);
  const repositories = await request('/installation/repositories?per_page=100', scopeToken.token);
  if (!allowedInstallation(repositories.repositories, repositories.total_count))
    fail('Installation selected repository set is not allowed');
  const repositoryNames = (repositories.repositories as { full_name: string }[]).map(r => r.full_name);
  if (!repositoryNames.includes(REPO)) fail('Selected Profile repository is not installed; stop at Human Gate');
  const { token, expiry } = await mint(true);
  const live = () => { if (d.now() >= expiry) fail('Installation token expired; rerun the command'); };
  const call = (path: string, method = 'GET', body?: unknown) => { live(); return request(path, token, method, body); };
  // No caller ref/path: independently read only this workflow's feature branch.
  // null means controlled ABSENT; PRESENT is a validated commit SHA.
  const readFeatureRefState = async (): Promise<string | null> => {
    live();
    let response: Response;
    try {
      response = await d.fetch(`${API}${ROOT}/git/ref/heads/${BRANCH}`, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache' },
      });
    } catch { return fail('Fixed feature ref state unavailable (details suppressed)'); }
    live();
    if (response.status === 404) return null;
    if (response.status !== 200) fail('Fixed feature ref state unavailable (details suppressed)');
    let value: Json;
    try { value = await response.json(); }
    catch { return fail('Invalid fixed feature ref state (details suppressed)'); }
    live();
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.ref !== `refs/heads/${BRANCH}` || value.url !== `${API}${ROOT}/git/refs/heads/${BRANCH}` ||
      value.object?.type !== 'commit' || !sha(value.object?.sha) ||
      value.object.url !== `${API}${ROOT}/git/commits/${value.object.sha}`)
      fail('Invalid fixed feature ref state (details suppressed)');
    return value.object.sha as string;
  };
  const id = (v: number) => { if (!positive(v)) fail('Invalid GitHub object number'); return v; };
  const prSummary = (p: Json) => {
    if (!positive(p.number) || p.user?.login !== actor || p.user?.type !== 'Bot' || !sha(p.head?.sha) ||
      !sha(p.base?.sha) || p.head?.ref !== BRANCH || p.base?.ref !== profile.base ||
      p.head?.repo?.full_name !== REPO || p.base?.repo?.full_name !== REPO ||
      p.state !== 'open' || typeof p.draft !== 'boolean' || typeof p.node_id !== 'string' || !/^[A-Za-z0-9_=+-]+$/.test(p.node_id))
      fail('PR identity, repository, branch or state mismatch');
    return { number: p.number as number, url: `https://github.com/${REPO}/pull/${p.number}`, actor,
      head: p.head.sha as string, base: p.base.sha as string, draft: p.draft as boolean, node_id: safeText(p.node_id) };
  };
  const checkBootstrap = async (baseSha: string, headSha: string) => {
    if (!workflow.bootstrap_paths) return;
    const comparison = await call(`${ROOT}/compare/${baseSha}...${headSha}`);
    if (comparison.status !== 'ahead' || !Array.isArray(comparison.files) || !comparison.files.length ||
      comparison.files.length > workflow.bootstrap_paths.length ||
      comparison.files.some((f: Json) => !workflow.bootstrap_paths!.includes(f.filename) || !['added', 'modified'].includes(f.status)))
      fail('Remote bootstrap candidate must stay in the fixed docs-only path');
  };
  const readPR = async (number: number) => {
    const p = prSummary(await call(`${ROOT}/pulls/${id(number)}`));
    await checkBootstrap(p.base, p.head);
    return p;
  };
  const commentSummary = (c: Json, number: number) => {
    if (!positive(c.id) || c.user?.login !== actor || c.user?.type !== 'Bot' || c.issue_url !== `${API}${ROOT}/issues/${id(number)}`)
      fail('Comment actor or PR mismatch');
    return { id: c.id as number, actor, url: `https://github.com/${REPO}/pull/${number}#issuecomment-${c.id}`, body: safeText(c.body) };
  };
  const readComment = async (number: number, comment: number) =>
    commentSummary(await call(`${ROOT}/issues/comments/${id(comment)}`), number);
  return Object.freeze({
    preflight: () => ({ repo: REPO, app_id: Number(appId), installation_id: inst.id as number, actor,
      repository_selection: 'selected', repositories: [...repositoryNames].sort(), permissions: { ...PERMISSIONS } }),
    push: async () => {
      live();
      const inspectEnv = gitEnvironment(d.env, root);
      const env = { ...inspectEnv };
      const config = [
        ['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`],
        ['credential.helper', ''], ['credential.https://github.com.helper', ''],
        ['safe.directory', root.replaceAll('\\', '/')],
      ];
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_COUNT: String(config.length), GIT_TERMINAL_PROMPT: '0' });
      config.forEach(([k, v], i) => Object.assign(env, { [`GIT_CONFIG_KEY_${i}`]: k, [`GIT_CONFIG_VALUE_${i}`]: v }));
      try {
        // Inspect key names only. The exact GitHub host helper is neutralized in transport env;
        // generic, path-scoped and other-host credentials still fail closed.
        const local = d.spawn('git', ['config', '--local', '--name-only', '--list'],
          { cwd: root, env: inspectEnv, encoding: 'utf8', timeout: 10000 });
        if (local.error || local.status !== 0 || local.stdout.split(/\r?\n/).some(key =>
          key.toLowerCase() !== 'credential.https://github.com.helper' &&
          /^(http\.|https\.|url\.|credential\.|include|core\.(gitproxy|sshcommand))/i.test(key)))
          fail('Unsafe local Git transport configuration');
        const branch = d.spawn('git', ['branch', '--show-current'], { cwd: root, env: inspectEnv, encoding: 'utf8', timeout: 10000 });
        if (branch.error || branch.status !== 0 || branch.stdout.trim() !== BRANCH) fail('Push requires the selected workflow feature branch');
        if (workflow.bootstrap_paths) {
          const baseline = await call(`${ROOT}/git/ref/heads/${profile.base}`);
          if (!sha(baseline.object?.sha)) fail('Invalid bootstrap baseline SHA');
          const changed = d.spawn('git', ['diff', '--no-ext-diff', '--name-only', '-z', baseline.object.sha, 'HEAD', '--'],
            { cwd: root, env: inspectEnv, encoding: 'utf8', timeout: 10000 });
          const paths = changed.stdout.split('\0').filter(Boolean);
          if (changed.error || changed.status !== 0 || !paths.length || paths.some(p => !workflow.bootstrap_paths!.includes(p)))
            fail('Bootstrap changes must stay in the fixed docs-only path');
        }
      } catch { fail('App HTTPS Git push failed (details suppressed)'); }
      const transport = (stage: GitTransportStage, args: string[]) => {
        const message = {
          authenticated_read_probe: 'App HTTPS Git authenticated probe failed',
          receive_pack_dry_run: 'App HTTPS Git receive-pack dry-run failed',
          push: 'App HTTPS Git push failed',
        }[stage];
        const suppressed = (reasons: readonly SuppressionReason[]) => {
          throw new BuilderError(`${message} (details suppressed)`, undefined, stage, reasons);
        };
        let result;
        try {
          result = d.spawn('git', ['-c', 'credential.helper=',
            '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
            '-c', 'http.followRedirects=false', ...args],
          { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
        } catch { return suppressed(['spawn_exception']); }
        let diagnostic;
        try {
          const output = [result.stdout, result.stderr, result.error?.message].map((v: unknown) => {
            if (v === undefined || v === null) return '';
            if (typeof v === 'string') return v;
            if (Buffer.isBuffer(v)) return v.toString('utf8');
            throw new Error();
          }).join('\n');
          diagnostic = sanitizeTransport(output);
        } catch { return suppressed(['spawn_exception']); }
        // Scan even successful output, before selecting any diagnostic category.
        if (diagnostic.text === null) return suppressed(diagnostic.reasons);
        if (!result.error && result.status === 0 && !diagnostic.reasons.length) return;
        const text = diagnostic.text; // Sanitized text is classifier input only; never publish it.
        let category: GitTransportCategory = 'git_transport_unknown';
        const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ETIMEDOUT' || /timed? out|timeout/i.test(text)) category = 'git_timeout';
        else if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH'].includes(code ?? '') ||
          /could not resolve (?:host|proxy)|failed to connect|couldn't connect|connection (?:refused|reset)|proxy (?:connect|authentication)|returned error: 407|ssl certificate|tls|ssl_connect|network is unreachable|unable to get local issuer/i.test(text))
          category = 'git_network_or_proxy';
        else if (/authentication failed|could not read (?:username|password)|terminal prompts disabled|invalid username or (?:password|token)|http basic: access denied|returned error: 401/i.test(text))
          category = 'git_authentication';
        else if (/non-fast-forward|fetch first|cannot lock ref|failed to update ref|reference already exists|stale info/i.test(text))
          category = 'git_non_fast_forward_or_ref_conflict';
        else if (/permission to .+ denied|write access .+ not granted|repository not found|returned error: 403|gh006|gh013|protected branch|repository rule|remote rejected|hook declined/i.test(text))
          category = 'git_remote_permission_or_policy';
        throw new BuilderError(diagnostic.reasons.length ? `${message} (details suppressed)` : message,
          category, stage, diagnostic.reasons.length ? diagnostic.reasons : undefined);
      };
      const url = `https://github.com/${REPO}.git`;
      const before = await readFeatureRefState();
      live();
      transport('authenticated_read_probe', ['ls-remote', '--exit-code', url, `refs/heads/${profile.base}`]);
      live();
      transport('receive_pack_dry_run', ['push', '--dry-run', url, `HEAD:refs/heads/${BRANCH}`]);
      const after = await readFeatureRefState();
      if (before !== after) fail('Fixed feature ref changed during receive-pack dry-run; push refused');
      live();
      transport('push', ['push', url, `HEAD:refs/heads/${BRANCH}`]);
      return { pushed: BRANCH, actor };
    },
    createPR: async (title: string, body: string) => {
      const safeTitle = safeText(title), safeBody = safeText(body);
      if (workflow.bootstrap_paths) {
        const baseRef = await call(`${ROOT}/git/ref/heads/${profile.base}`);
        const headRef = await call(`${ROOT}/git/ref/heads/${BRANCH}`);
        if (!sha(baseRef.object?.sha) || !sha(headRef.object?.sha)) fail('Invalid bootstrap branch SHA');
        await checkBootstrap(baseRef.object.sha, headRef.object.sha);
      }
      const p = prSummary(await call(`${ROOT}/pulls`, 'POST',
        { title: safeTitle, body: safeBody, head: BRANCH, base: profile.base, draft: true }));
      await checkBootstrap(p.base, p.head);
      return p;
    },
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
      if (handoff.work_item.repo !== workflow.work_item.repo || handoff.work_item.issue !== workflow.work_item.issue || handoff.candidate.pr !== number)
        fail('Handoff work item or PR mismatch');
      if (handoff.verification.checks.length !== workflow.verification_commands.length ||
        handoff.verification.checks.some((c, i) => c.command !== workflow.verification_commands[i]))
        fail('Handoff verification commands do not match selected Profile workflow');
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
