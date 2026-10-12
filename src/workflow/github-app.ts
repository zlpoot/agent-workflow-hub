import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { clientFail, same } from '../client/local.js';
import { externalPath, readExternalFile } from '../shared/external-files.js';
import { appJwt } from '../shared/github-app-auth.js';
import type { Native } from './local-fast-github.js';

export interface Actor { id: number; login: string; type: 'User' | 'Bot' }
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
const stop = () => clientFail('github_app', 'GitHub App identity, scope, credentials or operation could not be verified; no personal fallback.');

/** Files must already be Owner-protected. Never change permissions of an existing key. */
export function protectedAppPath(path: string): void {
  externalPath(path);
  if (process.platform !== 'win32') {
    if (lstatSync(path).mode & 0o077) stop();
    return;
  }
  // Fixed ACL inspection; paths travel as data, never PowerShell code.
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $a=Get-Acl -LiteralPath $env:AWH_ACL_PATH; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $ok=@($u,"S-1-5-18","S-1-5-32-544"); if($ok -notcontains $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value){exit 2}; foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq "Allow" -and $ok -notcontains $r.IdentityReference.Value){exit 3}}'],
  { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, AWH_ACL_PATH: path }, windowsHide: true, timeout: 10000, encoding: 'utf8' });
  if (r.error || r.status !== 0) stop();
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
    } catch { return stop(); }
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
  async #inspect(c: Pick<Connection, 'app_id' | 'app_slug' | 'private_key_path'>, repository: string, pinned?: Connection) {
    let jwt: string;
    try { this.#d.protect(c.private_key_path); jwt = appJwt(String(c.app_id), readExternalFile(c.private_key_path, 65536, true), this.#d.now()); }
    catch { return stop(); }
    const expiries = new Map<string, number>([[jwt, this.#d.now() + 540000]]);
    const request = async (path: string, credential: string, method = 'GET', body?: Native): Promise<any> => {
      try {
        if (!expiries.has(credential) || expiries.get(credential)! <= this.#d.now()) return stop();
        const r = await this.#d.fetch(`https://api.github.com${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!r.ok) return stop();
        const value = await r.json();
        if (expiries.get(credential)! <= this.#d.now()) return stop();
        if (!value || typeof value !== 'object') return stop();
        return value;
      } catch { return stop(); }
    };
    const app = await request('/app', jwt);
    if (app.id !== c.app_id || app.slug !== c.app_slug) return stop();
    const inst = await request(`/repos/${repository}/installation`, jwt);
    if (!positive(inst.id) || inst.app_id !== app.id || inst.app_slug !== app.slug || inst.account?.login !== repository.split('/')[0] ||
        inst.repository_selection !== 'selected' || inst.suspended_at !== null || pinned && inst.id !== pinned.installation_id ||
        inst.permissions?.contents !== 'write' || inst.permissions?.pull_requests !== 'write' || inst.permissions?.metadata !== 'read') return stop();
    const mint = async (permissions: Native, id?: number) => {
      const v = await request(`/app/installations/${inst.id}/access_tokens`, jwt, 'POST', { ...(id ? { repository_ids: [id] } : {}), permissions });
      const expiry = Date.parse(v.expires_at);
      if (typeof v.token !== 'string' || !v.token || !Number.isFinite(expiry) || expiry <= this.#d.now() + 30000 || expiry > this.#d.now() + 3660000 ||
          !same(v.permissions, { metadata: 'read', ...permissions }) || id && (!Array.isArray(v.repositories) || v.repositories.length !== 1 || v.repositories[0].id !== id || v.repositories[0].full_name !== repository)) return stop();
      expiries.set(v.token, expiry);
      return { token: v.token as string, expiry };
    };
    const metadata = await mint({ metadata: 'read' });
    const repositories: { id: number; full_name: string }[] = [];
    let total: number | undefined;
    for (let page = 1; page <= 2; page++) {
      if (metadata.expiry <= this.#d.now()) return stop();
      const v = await request(`/installation/repositories?per_page=100&page=${page}`, metadata.token);
      if (!positive(v.total_count) || v.total_count > 128 || total !== undefined && total !== v.total_count || !Array.isArray(v.repositories) || !v.repositories.length || v.repositories.length > 100) return stop();
      total = v.total_count;
      for (const r of v.repositories) { if (!positive(r.id) || !repoName(r.full_name)) return stop(); repositories.push({ id: r.id, full_name: r.full_name }); }
      if (repositories.length >= v.total_count) break;
    }
    repositories.sort((a,b) => a.id - b.id);
    if (repositories.length !== total || new Set(repositories.map(r => r.id)).size !== total || new Set(repositories.map(r => r.full_name)).size !== total ||
        !repositories.some(r => r.full_name === repository) || pinned && !same(repositories, pinned.repositories)) return stop();
    const actor = await request(`/users/${encodeURIComponent(app.slug + '[bot]')}`, metadata.token);
    if (!positive(actor.id) || actor.login !== `${app.slug}[bot]` || actor.type !== 'Bot') return stop();
    const delivery_actor: Actor = { id: actor.id, login: actor.login, type: 'Bot' };
    if (pinned && !same(delivery_actor, pinned.delivery_actor)) return stop();
    return { installation_id: inst.id as number, repositories, delivery_actor, request, mint, metadata };
  }
  async connect(input: { app_id: number; app_slug: string; private_key_path: string; repositories: string[]; reviewer: string }, confirm: boolean) {
    if (!confirm || !positive(input.app_id) || !/^[a-z0-9-]+$/.test(input.app_slug) || !input.repositories.length || input.repositories.length > 128 ||
        !input.repositories.every(repoName) || new Set(input.repositories).size !== input.repositories.length || !/^[A-Za-z0-9-]+$/.test(input.reviewer)) return stop();
    // Owner provisions the parent ACL once; no fake credential discovery or permission changes.
    externalPath(this.#d.configPath, true);
    this.#d.protect(join(this.#d.configPath, '..'));
    const inspected = await this.#inspect(input, input.repositories[0]!);
    if (!same([...input.repositories].sort(), inspected.repositories.map(r => r.full_name).sort())) return stop();
    const user = await inspected.request(`/users/${input.reviewer}`, inspected.metadata.token);
    if (!positive(user.id) || user.login !== input.reviewer || user.type !== 'User' || user.id === inspected.delivery_actor.id) return stop();
    const connection: Connection = { schema_version: '1.0', app_id: input.app_id, app_slug: input.app_slug, private_key_path: input.private_key_path,
      installation_id: inspected.installation_id, repositories: inspected.repositories, delivery_actor: inspected.delivery_actor,
      reviewer: { id: user.id, login: user.login, type: 'User' } };
    try { writeFileSync(this.#d.configPath, JSON.stringify(validate(connection), null, 2), { flag: 'wx', mode: 0o600 }); this.#d.protect(this.#d.configPath); }
    catch { return stop(); }
    return this.status();
  }
  async preflight(repository: string): Promise<AppDelivery> {
    const c = this.#read(), binding = this.#bound(c, repository), live = await this.#inspect(c, repository, c);
    const user = await live.request(`/users/${c.reviewer.login}`, live.metadata.token);
    if (user.id !== c.reviewer.id || user.login !== c.reviewer.login || user.type !== 'User') return stop();
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
      push: async (cwd, branch, head) => {
        if (!/^codex\/local-fast-[1-9]\d*$/.test(branch) || !/^[a-f0-9]{40}$/.test(head)) return stop();
        await operation({ contents: 'write' }, async (token, valid) => {
          const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(this.#d.env).filter(([k]) => !/^(GIT_|GH_|GITHUB_|AWH_|NODE_|SSH_)/i.test(k)));
          Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
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
          if (keys.split(/\r?\n/).some(k => /^(http\.|https\.|url\.|credential\.|include|filter\.|core\.(gitproxy|sshcommand|fsmonitor))/i.test(k)) ||
              run(['branch','--show-current']) !== branch || run(['rev-parse','HEAD']) !== head || run(['status','--porcelain=v1'])) return stop();
          const config = [['credential.helper',''], ['credential.https://github.com.helper',''], ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
            ['http.https://github.com/.extraheader',`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]];
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
