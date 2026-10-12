import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ClientError, same } from '../client/local.js';
import { externalPath, readExternalFile } from '../shared/external-files.js';
import { appJwt } from '../shared/github-app-auth.js';
import type { Native } from './local-fast-github.js';

export interface Actor { id: number; login: string; type: 'User' | 'Bot' }
export interface AppInput { app_id: number; app_slug: string; private_key_path: string; reviewer: string }
export interface AppInstallation {
  installation_id: number; account: { id: number; login: string; type: string };
  repository_selection: string; permissions: { contents: string; pull_requests: string; metadata: string };
  repositories: { id: number; full_name: string }[]; delivery_actor: Actor; reviewer: Actor;
}
export type AppInspection = { app_id: number; app_slug: string; installations: ({ status: 'DETECTED'; facts: AppInstallation } | { status: 'BLOCKED'; installation_id: number; account: string; reason: string })[] };
type AppSession = { app: Native; jwt: string; request: (path: string, credential: string, method?: string, body?: Native) => Promise<any>; expiries: Map<string, number> };
export class GithubAppError extends ClientError {
  constructor(readonly reason: string) { super('github_app', 'GitHub App identity, scope, credentials or operation could not be verified; no personal fallback.'); }
}
export interface AppBinding {
  provider: 'github-app'; app_id: number; app_slug: string; installation_id: number;
  repository: string; repository_id: number; delivery_actor: Actor; reviewer: Actor;
}
interface Connection {
  schema_version: '1.0'; app_id: number; app_slug: string; private_key_path: string;
  installation_id: number; repositories: { id: number; full_name: string }[]; delivery_actor: Actor; reviewer: Actor;
}
export interface AppDependencies {
  fetch: typeof fetch; now: () => number; spawn: typeof spawnSync; env: NodeJS.ProcessEnv;
  protect: (path: string) => void; configPath: string;
}
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const repoName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(v) && !v.includes('..');
const stop = (reason = 'verification_failed'): never => { throw new GithubAppError(reason); };

/** Files must already be Owner-protected. Never change permissions of an existing key. */
export function protectedAppPath(path: string): void {
  externalPath(path);
  if (process.platform !== 'win32') {
    if (lstatSync(path).mode & 0o077) stop('unsafe_acl');
    return;
  }
  // Fixed ACL inspection; paths travel as data, never PowerShell code.
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $a=Get-Acl -LiteralPath $env:AWH_ACL_PATH; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $ok=@($u,"S-1-5-18","S-1-5-32-544"); if($ok -notcontains $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value){exit 2}; foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq "Allow" -and $ok -notcontains $r.IdentityReference.Value){exit 3}}'],
  { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, AWH_ACL_PATH: path }, windowsHide: true, timeout: 10000, encoding: 'utf8' });
  if (r.error || r.status !== 0) stop('unsafe_acl');
}
export function appConfigPath(env = process.env): string {
  if (!env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)) return stop();
  return join(env.LOCALAPPDATA, 'AWH', 'github-app', 'connection.json');
}
function validate(c: Connection): Connection {
  if (!c || Object.keys(c).sort().join(',') !== 'app_id,app_slug,delivery_actor,installation_id,private_key_path,repositories,reviewer,schema_version' ||
      c.schema_version !== '1.0' || !positive(c.app_id) || !/^[a-z0-9-]+$/.test(c.app_slug) || !positive(c.installation_id) ||
      typeof c.private_key_path !== 'string' || !isAbsolute(c.private_key_path) || !Array.isArray(c.repositories) || !c.repositories.length || c.repositories.length > 128 ||
      c.repositories.some(r => !positive(r.id) || !repoName(r.full_name) || Object.keys(r).sort().join(',') !== 'full_name,id') ||
      new Set(c.repositories.map(r => r.id)).size !== c.repositories.length || new Set(c.repositories.map(r => r.full_name)).size !== c.repositories.length ||
      !positive(c.delivery_actor?.id) || Object.keys(c.delivery_actor).sort().join(',') !== 'id,login,type' || c.delivery_actor.login !== `${c.app_slug}[bot]` || c.delivery_actor.type !== 'Bot' ||
      !positive(c.reviewer?.id) || Object.keys(c.reviewer).sort().join(',') !== 'id,login,type' || !/^[A-Za-z0-9-]{1,39}$/.test(c.reviewer.login) || c.reviewer.type !== 'User' || c.reviewer.id === c.delivery_actor.id) stop();
  return c;
}
export interface AppDelivery {
  binding: AppBinding;
  inspection: AppInstallation;
  push(cwd: string, branch: string, head: string): Promise<void>;
  pulls(branch: string): Promise<Native[]>;
  create(branch: string, title: string, body: string): Promise<void>;
  update(pr: number, title: string, body: string): Promise<void>;
}
/** Fixed Local Fast operations only; no credentials or arbitrary request method are exposed. */
export class GithubApp {
  readonly #d: AppDependencies;
  constructor(overrides: Partial<AppDependencies> = {}) {
    this.#d = { fetch, now: Date.now, spawn: spawnSync, env: process.env, protect: protectedAppPath,
      configPath: overrides.configPath ?? appConfigPath(overrides.env), ...overrides };
  }
  #read(): Connection {
    try {
      this.#d.protect(this.#d.configPath);
      return validate(JSON.parse(readExternalFile(this.#d.configPath, 65536, true).toString('utf8')));
    } catch { return stop('configuration_invalid'); }
  }
  binding(repository: string): AppBinding { return this.#bound(this.#read(), repository); }
  #bound(c: Connection, repository: string): AppBinding {
    const repo = c.repositories.find(r => r.full_name === repository);
    if (!repo) return stop();
    return { provider: 'github-app', app_id: c.app_id, app_slug: c.app_slug, installation_id: c.installation_id,
      repository, repository_id: repo.id, delivery_actor: c.delivery_actor, reviewer: c.reviewer };
  }
  status() {
    if (!existsSync(this.#d.configPath)) return { status: 'NOT_CONNECTED', provider: 'github-app', next_action: 'OWNER_CONNECT_ONCE' };
    const c = this.#read();
    return { status: 'CONNECTED_LOCAL', provider: 'github-app', app_id: c.app_id, app_slug: c.app_slug, installation_id: c.installation_id,
      repositories: c.repositories, delivery_actor: c.delivery_actor, reviewer: c.reviewer, live_verified: false };
  }
  async #authenticate(c: Pick<Connection, 'app_id' | 'app_slug' | 'private_key_path'>, signal?: AbortSignal) {
    if (!positive(c.app_id) || !/^[a-z0-9-]{1,100}$/.test(c.app_slug)) return stop('invalid_input');
    let jwt: string;
    try { this.#d.protect(c.private_key_path); }
    catch (e) { if (e instanceof GithubAppError) throw e; return stop('unsafe_key_path'); }
    try { jwt = appJwt(String(c.app_id), readExternalFile(c.private_key_path, 65536, true), this.#d.now()); }
    catch { return stop('invalid_key'); }
    const expiries = new Map<string, number>([[jwt, this.#d.now() + 540000]]);
    const request = async (path: string, credential: string, method = 'GET', body?: Native): Promise<any> => {
      try {
        if (!expiries.has(credential) || expiries.get(credential)! <= this.#d.now()) return stop();
        const r = await this.#d.fetch(`https://api.github.com${path}`, { method, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
          headers: { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!r.ok) return stop(r.status === 401 ? 'app_authentication' : r.status === 404 ? 'github_not_found' : r.status === 403 || r.status === 429 ? 'github_forbidden' : 'github_unavailable');
        const value = await r.json();
        if (expiries.get(credential)! <= this.#d.now()) return stop();
        if (!value || typeof value !== 'object') return stop();
        return value;
      } catch (e) { if (e instanceof GithubAppError) throw e; return stop('network_error'); }
    };
    const app = await request('/app', jwt);
    if (app.id !== c.app_id || app.slug !== c.app_slug) return stop('identity_drift');
    return { app, jwt, request, expiries };
  }
  async #inspect(c: Pick<Connection, 'app_id' | 'app_slug' | 'private_key_path'>, repository: string, pinned?: Connection, signal?: AbortSignal) {
    const auth = await this.#authenticate(c, signal);
    const inst = await auth.request(`/repos/${repository}/installation`, auth.jwt);
    return this.#inspectInstallation(auth, inst, repository, pinned);
  }
  async #inspectInstallation(auth: AppSession, inst: Native, repository?: string, pinned?: Connection) {
    const { app, jwt, request, expiries } = auth;
    if (!positive(inst.id) || inst.app_id !== app.id || inst.app_slug !== app.slug ||
        !positive(inst.account?.id) || !['User','Organization'].includes(inst.account?.type) ||
        typeof inst.account?.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(inst.account.login) ||
        repository && inst.account.login !== repository.split('/')[0] || pinned && inst.id !== pinned.installation_id) return stop('identity_drift');
    if (inst.repository_selection !== 'selected') return stop('all_repositories');
    if (inst.suspended_at !== null) return stop('installation_suspended');
    if (inst.permissions?.contents !== 'write' || inst.permissions?.pull_requests !== 'write' || inst.permissions?.metadata !== 'read') return stop('permissions_insufficient');
    const mint = async (permissions: Native, id?: number) => {
      const v = await request(`/app/installations/${inst.id}/access_tokens`, jwt, 'POST', { ...(id ? { repository_ids: [id] } : {}), permissions });
      const expiry = Date.parse(v.expires_at);
      if (typeof v.token !== 'string' || !v.token) return stop();
      if (!Number.isFinite(expiry) || expiry <= this.#d.now() + 30000 || expiry > this.#d.now() + 3660000) return stop('token_expiry');
      if (!same(v.permissions, { metadata: 'read', ...permissions })) return stop('token_permissions');
      if (id && (!Array.isArray(v.repositories) || v.repositories.length !== 1 || v.repositories[0].id !== id || v.repositories[0].full_name !== repository)) return stop('token_scope');
      expiries.set(v.token, expiry);
      return { token: v.token as string, expiry };
    };
    const metadata = await mint({ metadata: 'read' });
    const repositories: { id: number; full_name: string }[] = [];
    let total: number | undefined;
    for (let page = 1; page <= 2; page++) {
      if (metadata.expiry <= this.#d.now()) return stop();
      const v = await request(`/installation/repositories?per_page=100&page=${page}`, metadata.token);
      if (!positive(v.total_count) || v.total_count > 128 || total !== undefined && total !== v.total_count || !Array.isArray(v.repositories) || !v.repositories.length || v.repositories.length > 100) return stop('scope_drift');
      total = v.total_count;
      for (const r of v.repositories) { if (!positive(r.id) || !repoName(r.full_name)) return stop(); repositories.push({ id: r.id, full_name: r.full_name }); }
      if (repositories.length >= v.total_count) break;
    }
    repositories.sort((a,b) => a.id - b.id);
    if (repositories.some(r => r.full_name.split('/')[0] !== inst.account.login)) return stop('scope_drift');
    if (repositories.length !== total || new Set(repositories.map(r => r.id)).size !== total || new Set(repositories.map(r => r.full_name)).size !== total ||
        repository && !repositories.some(r => r.full_name === repository) || pinned && !same(repositories, pinned.repositories)) return stop('scope_drift');
    const actor = await request(`/users/${encodeURIComponent(app.slug + '[bot]')}`, metadata.token);
    if (!positive(actor.id) || actor.login !== `${app.slug}[bot]` || actor.type !== 'Bot') return stop('bot_identity');
    const delivery_actor: Actor = { id: actor.id, login: actor.login, type: 'Bot' };
    if (pinned && !same(delivery_actor, pinned.delivery_actor)) return stop('identity_drift');
    return { installation_id: inst.id as number, repositories, delivery_actor, request, mint, metadata,
      account: { id: inst.account.id as number, login: inst.account.login as string, type: inst.account.type as string },
      repository_selection: 'selected', permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } };
  }
  async detect(input: AppInput, signal?: AbortSignal): Promise<AppInspection> {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(input.reviewer)) return stop('invalid_input');
    const auth = await this.#authenticate(input, signal), all: Native[] = [];
    let complete = false;
    for (let page = 1; page <= 2; page++) {
      const v = await auth.request(`/app/installations?per_page=100&page=${page}`, auth.jwt);
      if (!Array.isArray(v) || v.length > 100 || all.length + v.length > 128) return stop('installation_limit');
      all.push(...v);
      if (v.length < 100) { complete = true; break; }
    }
    if (!complete || new Set(all.map(v => v.id)).size !== all.length) return stop('installation_limit');
    if (!all.length) return stop('not_installed');
    const installations: AppInspection['installations'] = [];
    for (const inst of all) {
      if (!positive(inst.id) || !positive(inst.account?.id) || !['User','Organization'].includes(inst.account?.type)) return stop('identity_drift');
      try {
        const live = await this.#inspectInstallation(auth, inst);
        const user = await live.request(`/users/${input.reviewer}`, live.metadata.token);
        if (!positive(user.id) || user.login !== input.reviewer || user.type !== 'User' || user.id === live.delivery_actor.id) return stop('reviewer_identity');
        installations.push({ status: 'DETECTED', facts: { installation_id: live.installation_id, account: live.account, repository_selection: live.repository_selection,
          permissions: live.permissions, repositories: live.repositories, delivery_actor: live.delivery_actor, reviewer: { id: user.id, login: user.login, type: 'User' } } });
      } catch (e) {
        if (!(e instanceof GithubAppError)) throw e;
        installations.push({ status: 'BLOCKED', installation_id: inst.id, account: /^[A-Za-z0-9-]{1,39}$/.test(inst.account.login) ? inst.account.login : '', reason: e.reason });
      }
    }
    return { app_id: input.app_id, app_slug: input.app_slug, installations };
  }
  async connect(input: AppInput & { repositories: string[] }, confirm: boolean, expected?: AppInstallation, signal?: AbortSignal, canSave?: () => boolean) {
    if (!confirm || !positive(input.app_id) || !/^[a-z0-9-]+$/.test(input.app_slug) || !input.repositories.length || input.repositories.length > 128 ||
        !input.repositories.every(repoName) || new Set(input.repositories).size !== input.repositories.length || !/^[A-Za-z0-9-]+$/.test(input.reviewer)) return stop();
    // Owner provisions the parent ACL once; no fake credential discovery or permission changes.
    try { externalPath(this.#d.configPath, true); this.#d.protect(join(this.#d.configPath, '..')); }
    catch (e) { if (e instanceof GithubAppError) throw e; return stop('configuration_directory'); }
    const inspected = await this.#inspect(input, input.repositories[0]!, undefined, signal);
    if (!same([...input.repositories].sort(), inspected.repositories.map(r => r.full_name).sort())) return stop();
    const user = await inspected.request(`/users/${input.reviewer}`, inspected.metadata.token);
    if (!positive(user.id) || user.login !== input.reviewer || user.type !== 'User' || user.id === inspected.delivery_actor.id) return stop();
    const connection: Connection = { schema_version: '1.0', app_id: input.app_id, app_slug: input.app_slug, private_key_path: input.private_key_path,
      installation_id: inspected.installation_id, repositories: inspected.repositories, delivery_actor: inspected.delivery_actor,
      reviewer: { id: user.id, login: user.login, type: 'User' } };
    if (expected && !same({ installation_id: inspected.installation_id, account: inspected.account, repository_selection: inspected.repository_selection,
      permissions: inspected.permissions, repositories: inspected.repositories, delivery_actor: inspected.delivery_actor, reviewer: connection.reviewer }, expected)) return stop('identity_drift');
    if (signal?.aborted || canSave && !canSave()) return stop('operation_cancelled');
    try { writeFileSync(this.#d.configPath, JSON.stringify(validate(connection), null, 2), { flag: 'wx', mode: 0o600 }); this.#d.protect(this.#d.configPath); }
    catch { return stop('connection_save_failed'); }
    return this.status();
  }
  async preflight(repository: string, signal?: AbortSignal): Promise<AppDelivery> {
    const c = this.#read(), binding = this.#bound(c, repository), live = await this.#inspect(c, repository, c, signal);
    const user = await live.request(`/users/${c.reviewer.login}`, live.metadata.token);
    if (user.id !== c.reviewer.id || user.login !== c.reviewer.login || user.type !== 'User') return stop('identity_drift');
    const operation = async (permissions: Native, fn: (token: string, valid: () => void) => Promise<any>) => {
      // Re-read the Owner configuration immediately before every short-lived token.
      if (!same(this.#read(), c)) return stop();
      const t = await live.mint(permissions, binding.repository_id);
      if (t.expiry <= this.#d.now() + 30000) return stop();
      return fn(t.token, () => { if (t.expiry <= this.#d.now()) stop(); });
    };
    const root = `/repos/${repository}`;
    return {
      binding,
      inspection: { installation_id: live.installation_id, account: live.account, repository_selection: live.repository_selection, permissions: live.permissions,
        repositories: live.repositories, delivery_actor: live.delivery_actor, reviewer: { id: user.id, login: user.login, type: 'User' } },
      push: async (cwd, branch, head) => {
        if (!/^codex\/local-fast-[1-9]\d*$/.test(branch) || !/^[a-f0-9]{40}$/.test(head)) return stop();
        await operation({ contents: 'write' }, async (token, valid) => {
          const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(this.#d.env).filter(([k]) => !/^(GIT_|GH_|GITHUB_|AWH_|NODE_|SSH_)/i.test(k)));
          // Empty askPass overrides suppress Git's configured/SSH fallback;
          // GIT_TERMINAL_PROMPT=0 alone only disables the final terminal prompt.
          Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
            GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' });
          const run = (args: string[]) => {
            try {
              valid();
              const r = this.#d.spawn('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
              if (r.error || r.status !== 0) return stop();
              return String(r.stdout).trim();
            } catch { return stop(); }
          };
          // Effective local + optional worktree keys; --worktree itself fails on
          // ordinary linked worktrees when that extension is not enabled.
          const keys = run(['config','--name-only','--list']);
          if (keys.split(/\r?\n/).some(k => /^(http\.|https\.|url\.|credential\.|include|filter\.|gpg\.|push\.gpgsign(?:$|\.)|remote\..*\.(?:vcs|receivepack|uploadpack)(?:$|\.)|core\.(gitproxy|sshcommand|fsmonitor|askpass))/i.test(k)) ||
              run(['branch','--show-current']) !== branch || run(['rev-parse','HEAD']) !== head || run(['status','--porcelain=v1'])) return stop();
          const config = [['credential.helper',''], ['credential.https://github.com.helper',''], ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
            ['http.https://github.com/.extraheader',`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`],
            ['core.askPass', '']]; // Also neutralize a config change after inspection.
          env.GIT_CONFIG_COUNT = String(config.length);
          config.forEach(([k,v],i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
          run(['push', '--no-follow-tags', '--recurse-submodules=no', `https://github.com/${repository}.git`, `${head}:refs/heads/${branch}`]);
          const ref = await live.request(`${root}/git/ref/heads/${branch}`, token);
          if (ref.ref !== `refs/heads/${branch}` || ref.object?.sha !== head) return stop();
        });
      },
      pulls: async branch => {
        if (!/^codex\/local-fast-[1-9]\d*$/.test(branch)) return stop();
        return operation({ pull_requests: 'read' }, async token => {
          const all: Native[] = [];
          for (let page = 1; page <= 2; page++) {
            const v = await live.request(`${root}/pulls?state=all&head=${encodeURIComponent(repository.split('/')[0] + ':' + branch)}&base=main&per_page=100&page=${page}`, token);
            if (!Array.isArray(v)) return stop();
            all.push(...v);
            if (v.length < 100) return all;
          }
          return stop();
        });
      },
      create: async (branch, title, body) => {
        if (!/^codex\/local-fast-[1-9]\d*$/.test(branch)) return stop();
        await operation({ pull_requests: 'write' }, token => live.request(`${root}/pulls`, token, 'POST', { head: branch, base: 'main', draft: true, title, body }));
      },
      update: async (pr, title, body) => {
        if (!positive(pr)) return stop();
        await operation({ pull_requests: 'write' }, async token => {
          const p = await live.request(`${root}/pulls/${pr}`, token);
          if (p.state !== 'open' || p.merged_at || !same({ id: p.user?.id, login: p.user?.login, type: p.user?.type }, c.delivery_actor) || p.head?.repo?.id !== binding.repository_id || p.base?.repo?.id !== binding.repository_id || p.base?.ref !== 'main' || !/^codex\/local-fast-[1-9]\d*$/.test(p.head?.ref)) return stop();
          if (!p.draft) {
            if (typeof p.node_id !== 'string' || !/^[A-Za-z0-9_=-]+$/.test(p.node_id)) return stop();
            const converted = await live.request('/graphql', token, 'POST', { query: 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}', variables: { id: p.node_id } });
            if (converted.errors || converted.data?.convertPullRequestToDraft?.pullRequest?.id !== p.node_id || converted.data?.convertPullRequestToDraft?.pullRequest?.isDraft !== true) return stop();
          }
          await live.request(`${root}/pulls/${pr}`, token, 'PATCH', { title, body });
        });
      }
    };
  }
}
