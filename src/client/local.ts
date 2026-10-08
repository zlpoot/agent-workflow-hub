import { spawnSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { assertEntity, assertClientMetadata, type ProjectManifest } from '../protocol/index.js';
import { safeData, validId } from '../control-plane/security.js';
import { CLIENT_VERSION } from './version.js';

export class ClientError extends Error {
  constructor(readonly code: string, message: string, readonly http_status?: number) { super(message); }
}
export function clientFail(code: string, message: string): never { throw new ClientError(code, message); }
export const same = (a: unknown, b: unknown): boolean => {
  const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ?
    '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}' : JSON.stringify(v);
  return canonical(a) === canonical(b);
};
export const platform = (): 'windows' | 'macos' | 'linux' => {
  if (process.platform === 'win32') return 'windows'; if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux'; return clientFail('platform', 'Unsupported Client platform');
};
function git(root: string, args: string[], optional = false): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|GH_|GITHUB_|AWH_|SSH_|NODE_OPTIONS$)/i.test(k)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: root.replaceAll('\\', '/'),
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_TERMINAL_PROMPT: '0' });
  const r = spawnSync('git', ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false', ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (optional && r.status === 1 && !r.error) return '';
  if (r.error || r.status !== 0) return clientFail('git', 'Read-only Git identity inspection failed (details suppressed)');
  return r.stdout.trim();
}
export interface RepositoryIdentity { root: string; repository: string; sha: string; ref: string; dirty: boolean }
export function ignoredDeliveryLogs(identity: RepositoryIdentity): void {
  if (!git(identity.root, ['check-ignore', '--no-index', '.handoff/awh-evidence'], true))
    clientFail('delivery_logs', 'Delivery evidence requires an ignored .handoff directory');
  const path = join(identity.root, '.handoff');
  try {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path) clientFail('delivery_logs', 'Delivery log directory cannot be redirected');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export function inspectRepository(cwd = process.cwd()): RepositoryIdentity {
  let candidate = realpathSync(cwd);
  for (;;) {
    try { const marker = lstatSync(join(candidate, '.git')); if (marker.isSymbolicLink() || !marker.isDirectory() && !marker.isFile()) clientFail('git', 'Invalid worktree marker'); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(candidate); if (parent === candidate) clientFail('git', 'A real Git worktree is required'); candidate = parent; }
  }
  const root = realpathSync(git(candidate, ['rev-parse', '--show-toplevel']));
  if (root !== candidate) clientFail('git', 'Git root does not match the real worktree root');
  const names = git(root, ['config', '--local', '--no-includes', '--name-only', '--list']);
  if (names.split('\n').some(key => /^(?:include|url\.|filter\.)/i.test(key))) clientFail('origin', 'Included, rewritten or filtered Git configuration is unsupported');
  const worktreeConfig = git(root, ['config', '--local', '--no-includes', '--bool', '--get-all', 'extensions.worktreeConfig'], true);
  if (worktreeConfig && !['true', 'false'].includes(worktreeConfig)) clientFail('origin', 'Ambiguous worktree configuration extension is unsupported');
  // Enabling the extension does not itself override anything. Accept only an unused worktree scope.
  if (worktreeConfig === 'true') {
    const worktreePath = resolve(root, git(root, ['rev-parse', '--git-path', 'config.worktree']));
    let present = true;
    try { regular(worktreePath, 1024 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; present = false; }
    if (present && git(root, ['config', '--worktree', '--no-includes', '--name-only', '--list']))
      clientFail('origin', 'Nonempty worktree-specific Git configuration is unsupported (keys and values suppressed)');
  }
  const origin = git(root, ['config', '--local', '--no-includes', '--get-all', 'remote.origin.url']);
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin);
  if (!match) clientFail('origin', 'A single canonical GitHub origin is required (value suppressed)');
  const sha = git(root, ['rev-parse', '--verify', 'HEAD']); if (!/^[a-f0-9]{40}$/.test(sha)) clientFail('git', 'A committed exact source HEAD is required');
  const branch = git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], true);
  // Do not spawn child Git processes in submodule worktrees with independent executable config.
  return { root, repository: match[1]!, sha, ref: branch || sha, dirty: !!git(root, ['status', '--porcelain', '--ignore-submodules=all']) };
}
function regular(path: string, max: number): Buffer {
  const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.size > max) clientFail('file', 'Expected a bounded regular file');
  return readFileSync(path);
}
export function readJson(path: string, max = 64 * 1024, guard = true): unknown {
  try { const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(regular(path, max))); if (guard) safeData(value); return value; }
  catch (error) { if (error instanceof ClientError) throw error; return clientFail('file', 'Invalid or unavailable JSON file (contents suppressed)'); }
}
function manifestPath(root: string, create = false): string {
  const dir = join(root, '.awh');
  if (create) { try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) clientFail('manifest', 'Manifest directory must be inside the verified Git root');
  return join(dir, 'project.yaml');
}
export function readManifest(identity: RepositoryIdentity): ProjectManifest {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(regular(manifestPath(identity.root), 4096));
    const lines = text.replaceAll('\r\n', '\n').trimEnd().split('\n');
    if (lines.length !== 6 || lines[1] !== 'project:' || lines[4] !== 'profile:') clientFail('manifest', 'Expected the minimal AWH YAML mapping');
    const scalar = (line: string, prefix: string) => {
      if (!line.startsWith(prefix)) clientFail('manifest', 'Unexpected or duplicate Manifest field');
      const value = line.slice(prefix.length);
      if (value.startsWith('"')) { const parsed: unknown = JSON.parse(value); if (typeof parsed !== 'string') clientFail('manifest', 'Manifest scalar must be a string'); return parsed; }
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)) clientFail('manifest', 'Unsupported YAML scalar, tag, alias or comment');
      return value;
    };
    const manifest = assertEntity('manifest', { apiVersion: scalar(lines[0]!, 'apiVersion: '),
      project: { id: scalar(lines[2]!, '  id: '), repository: scalar(lines[3]!, '  repository: ') }, profile: { ref: scalar(lines[5]!, '  ref: ') } });
    if (manifest.project.repository !== identity.repository) clientFail('origin_mismatch', 'Manifest repository does not match verified Git origin');
    return manifest;
  } catch (error) { if (error instanceof ClientError) throw error; return clientFail('manifest', 'Invalid or unavailable minimal Manifest (contents suppressed)'); }
}
export function initManifest(identity: RepositoryIdentity, projectId: string, profileRef: string): ProjectManifest {
  const manifest = assertEntity('manifest', { apiVersion: 'awh/v1', project: { id: projectId, repository: identity.repository }, profile: { ref: profileRef } });
  const path = manifestPath(identity.root, true);
  const content = `apiVersion: awh/v1\nproject:\n  id: ${JSON.stringify(projectId)}\n  repository: ${JSON.stringify(identity.repository)}\nprofile:\n  ref: ${JSON.stringify(profileRef)}\n`;
  try { writeFileSync(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!same(readManifest(identity), manifest)) clientFail('manifest_conflict', 'Existing Manifest identity cannot be overwritten'); }
  return manifest;
}
export interface ClientConfig { schema_version: '1.0'; endpoint: string; credential_file: string; state_directory: string; executor_id: string; executor_type: string; profile_version?: string; ca_certificate_file?: string }
function outside(root: string, path: string): void {
  const rel = relative(root, path); if (!rel || !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel))
    clientFail('configuration', 'Client configuration, credential and state must be outside the project');
}
export function readConfig(path: string, root: string): ClientConfig {
  if (!isAbsolute(path)) clientFail('configuration', 'Explicit absolute Client config path is required');
  outside(root, realpathSync(path));
  const config = readJson(path) as ClientConfig;
  if (!config || Array.isArray(config) || Object.keys(config).some(key => !['schema_version','endpoint','credential_file','state_directory','executor_id','executor_type','profile_version','ca_certificate_file'].includes(key)) ||
      config.schema_version !== '1.0' || !validId(config.executor_id) || typeof config.executor_type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(config.executor_type) ||
      typeof config.credential_file !== 'string' || !isAbsolute(config.credential_file) || typeof config.state_directory !== 'string' || !isAbsolute(config.state_directory) ||
      config.profile_version !== undefined && !validId(config.profile_version)) clientFail('configuration', 'Invalid Client config');
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); } catch { return clientFail('endpoint', 'Invalid explicitly configured Control Plane endpoint'); }
  if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      !['http:', 'https:'].includes(endpoint.protocol) || endpoint.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') clientFail('endpoint', 'Endpoint requires verified HTTPS or explicit numeric loopback transport; no redirects or TLS bypass');
  if (config.ca_certificate_file !== undefined) {
    if (endpoint.protocol !== 'https:' || typeof config.ca_certificate_file !== 'string' || !isAbsolute(config.ca_certificate_file))
      clientFail('configuration', 'A CA certificate requires HTTPS and an absolute external path');
    outside(root, realpathSync(config.ca_certificate_file)); readCaCertificate(config);
    for (let directory = dirname(realpathSync(config.ca_certificate_file)); ; directory = dirname(directory)) {
      try { lstatSync(join(directory, '.git')); clientFail('configuration', 'CA certificate must remain outside all repositories'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (dirname(directory) === directory) break;
    }
  }
  outside(root, realpathSync(config.credential_file)); outside(root, resolve(config.state_directory));
  let parent = resolve(config.state_directory); const suffix: string[] = [];
  for (;;) {
    try { lstatSync(parent); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; suffix.unshift(basename(parent)); parent = dirname(parent); }
  }
  config.state_directory = resolve(realpathSync(parent), ...suffix); outside(root, config.state_directory);
  mkdirSync(config.state_directory, { recursive: true, mode: 0o700 });
  outside(root, realpathSync(config.state_directory));
  if (lstatSync(config.state_directory).isSymbolicLink()) clientFail('configuration', 'Client state directory cannot be a symbolic link');
  return { ...config, endpoint: endpoint.origin };
}
export function readCaCertificate(config: ClientConfig): Buffer | undefined {
  if (config.ca_certificate_file === undefined) return undefined;
  try {
    const pem = regular(config.ca_certificate_file, 64 * 1024);
    if (!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem.toString('ascii')))
      clientFail('certificate', 'Expected one public CA certificate; private key material is forbidden');
    const ca = new X509Certificate(pem);
    if (!ca.ca || Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) <= Date.now()) clientFail('certificate', 'CA certificate is not currently valid');
    return pem;
  } catch { return clientFail('certificate', 'Invalid or unavailable CA certificate (details suppressed)'); }
}
export function readCredential(config: ClientConfig): string {
  try {
    if (process.platform !== 'win32' && (lstatSync(config.credential_file).mode & 0o077)) clientFail('credential', 'Dedicated credential file must be owner-only');
    const value = regular(config.credential_file, 1024).toString('utf8').trim();
    if (!/^awh_cp_[A-Za-z0-9_-]{43,128}$/.test(value)) clientFail('credential', 'A dedicated Control Plane credential is required; GitHub credentials are unsupported');
    return value;
  } catch (error) { if (error instanceof ClientError) throw error; return clientFail('credential', 'Dedicated credential file is unavailable (contents suppressed)'); }
}
export function atomicJson(path: string, data: unknown, guard = true): void {
  if (guard) safeData(data); const temporary = path + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
export interface Machine { schema_version: '1.0'; id: string; name: string; platform: 'windows' | 'macos' | 'linux'; arch: string }
export function machine(config: ClientConfig, create = true): Machine {
  const path = join(config.state_directory, 'machine.json');
  try { if (create) writeFileSync(path, JSON.stringify({ schema_version: '1.0', id: 'machine-' + randomUUID(), name: hostname(), platform: platform(), arch: process.arch }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const m = readJson(path) as Machine;
  if (!m || Object.keys(m).sort().join(',') !== 'arch,id,name,platform,schema_version' || m.schema_version !== '1.0' || !validId(m.id) || m.platform !== platform() || m.arch !== process.arch)
    clientFail('machine', 'Local machine identity is invalid; refusing to replace it');
  assertClientMetadata({ schema_version: '1.0', executor_type: config.executor_type, machine_name: m.name, arch: m.arch, client_version: CLIENT_VERSION });
  return m;
}
export async function locked<T>(path: string, action: () => Promise<T>): Promise<T> {
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch { return clientFail('busy', 'Client state is locked; retry after the current command finishes (stale locks require explicit local recovery)'); }
  try { return await action(); } finally { closeSync(fd); unlinkSync(path); }
}
