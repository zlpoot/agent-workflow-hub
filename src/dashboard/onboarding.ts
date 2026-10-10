import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { absoluteDeploymentPath, externalFilePath } from '../shared/external-files.js';
import { fail, safeData, validId } from '../shared/security.js';
import { inspectRepository, readManifest } from '../client/local.js';
import { CLIENT_PACKAGE, CLIENT_VERSION } from '../client/version.js';
import type { Viewer } from './security.js';

export interface LocalBinding { id: string; project_id: string; repository: string; worktree: string; client_entry: string;
  client_entry_sha256: string; config_file?: string; policy_trust_file?: string; work_item?: { id: string; version: string } }
export interface LocalCheck { id: string; status: 'passed' | 'blocked' | 'not_checked'; code: string; source: string; safe_next_step: string }
export interface LocalDiagnosis { id: string; project_id: string; repository: string; observed_at: string; source: 'installed_client_offline';
  status: 'passed' | 'blocked' | 'not_checked'; client_version: string | null; approved_version: string | null;
  differences: { field: string; expected: string | number | null; observed: string | number | null; status: 'passed' | 'blocked' | 'not_checked' }[];
  checks: LocalCheck[]; authority_verified: false }
const failure = (binding: LocalBinding, code: string): LocalDiagnosis => ({ id: binding.id, project_id: binding.project_id,
  repository: binding.repository, observed_at: new Date().toISOString(), source: 'installed_client_offline', status: 'blocked', client_version: null, approved_version: null,
  differences: [], checks: [{ id: 'local_diagnosis', status: 'blocked', code, source: 'trusted_local_binding', safe_next_step: '请操作人核对已登记工作树、Client 安装及外置配置；保留现有身份和文件。' }], authority_verified: false });
const statuses = ['passed','blocked','not_checked'];
// Only fixed Doctor argv from operator-owned mappings. A browser selects an ID;
// it cannot submit a path, config, executable, command, permission or network probe.
export function createLocalOnboarding(bindings: readonly LocalBinding[]) {
  if (!Array.isArray(bindings) || bindings.length > 64) fail(500, 'configuration', 'Bounded explicit local bindings required');
  const ids = new Set<string>();
  const registry = bindings.map(b => {
    safeData(b);
    if (!b || Object.keys(b).some(k => !['id','project_id','repository','worktree','client_entry','client_entry_sha256','config_file','policy_trust_file','work_item'].includes(k)) ||
        !validId(b.id) || ids.has(b.id) || !validId(b.project_id) || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(b.repository) ||
        !isAbsolute(b.worktree) || !isAbsolute(b.client_entry) || !/^[a-f0-9]{64}$/.test(b.client_entry_sha256) ||
        b.config_file !== undefined && !isAbsolute(b.config_file) || b.policy_trust_file !== undefined && !isAbsolute(b.policy_trust_file) ||
        (b.policy_trust_file === undefined) !== (b.work_item === undefined) || b.work_item &&
        (Object.keys(b.work_item).sort().join(',') !== 'id,version' || !validId(b.work_item.id) || !validId(b.work_item.version)))
      fail(500, 'configuration', 'Invalid or duplicate trusted local binding');
    ids.add(b.id); return { ...structuredClone(b), worktree: absoluteDeploymentPath(b.worktree), client_entry: absoluteDeploymentPath(b.client_entry),
      ...(b.config_file ? { config_file: absoluteDeploymentPath(b.config_file) } : {}),
      ...(b.policy_trust_file ? { policy_trust_file: absoluteDeploymentPath(b.policy_trust_file) } : {}) };
  });
  const current = new Map<string, LocalDiagnosis>(), pending = new Map<string, Promise<LocalDiagnosis>>();
  const visible = (viewer: Viewer, id: string) => {
    const binding = registry.find(b => b.id === id && viewer.project_ids.includes(b.project_id));
    if (!binding) fail(404, 'not_found', 'Local binding is outside the viewer scope');
    return binding;
  };
  const run = async (b: LocalBinding): Promise<LocalDiagnosis> => {
    try {
      const identity = inspectRepository(b.worktree);
      if (identity.root !== realpathSync(b.worktree) || identity.repository !== b.repository) return failure(b, 'local_repository_mismatch');
      // Missing Manifest is a Doctor blocker rather than an enrollment write.
      try { const m = readManifest(identity); if (m.project.id !== b.project_id) return failure(b, 'local_project_mismatch'); }
      catch { /* Doctor explains the missing/mismatched Manifest below. */ }
      externalFilePath(b.client_entry, 1024 * 1024);
      const packagePath = join(dirname(dirname(dirname(b.client_entry))), 'package.json');
      externalFilePath(packagePath, 64 * 1024);
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (pkg.name !== CLIENT_PACKAGE || pkg.version !== CLIENT_VERSION || pkg.bin?.awh !== 'dist/client/cli.js' ||
          b.client_entry !== join(dirname(packagePath), 'dist/client/cli.js') ||
          createHash('sha256').update(readFileSync(b.client_entry)).digest('hex') !== b.client_entry_sha256) return failure(b, 'client_installation_mismatch');
      const args = [b.client_entry, ...(b.config_file ? ['--config', b.config_file] : []), 'doctor', '--json',
        ...(b.policy_trust_file ? ['--policy-trust', b.policy_trust_file, '--work-item', b.work_item!.id, '--work-item-version', b.work_item!.version] : [])];
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_|GITHUB_|AWH_|SSH_|NODE_|NPM_CONFIG_|npm_config_)/i.test(key)));
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: identity.root, env, windowsHide: true, stdio: ['ignore','pipe','ignore'] });
        let text = '', bytes = 0, finished = false;
        const timer = setTimeout(() => { finished = true; child.kill(); reject(new Error()); }, 30000);
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) { finished = true; child.kill(); reject(new Error()); } else text += chunk.toString('utf8'); });
        child.once('error', () => { clearTimeout(timer); reject(new Error()); });
        child.once('close', code => { clearTimeout(timer); if (!finished && [0,2].includes(code!)) resolve(text); else reject(new Error()); });
      });
      const report = JSON.parse(output); safeData(report);
      if (report.kind !== 'client_doctor' || report.schema_version !== '1.0' || report.mode !== 'offline' || report.authority_verified !== false ||
          report.client?.package !== CLIENT_PACKAGE || report.client?.version !== CLIENT_VERSION || !statuses.includes(report.status) ||
          !Array.isArray(report.checks) || report.checks.length > 64) return failure(b, 'doctor_contract_mismatch');
      const seen = new Set<string>();
      const checks: LocalCheck[] = report.checks.map((c: LocalCheck) => {
        if (!validId(c.id) || seen.has(c.id) || !statuses.includes(c.status) || !validId(c.code) || !validId(c.source) || typeof c.safe_next_step !== 'string' || c.safe_next_step.length > 1024) throw new Error();
        seen.add(c.id); return { id: c.id, status: c.status, code: c.code, source: c.source, safe_next_step: c.safe_next_step };
      });
      const value = (v: unknown): string | number | null => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
        if (typeof v === 'string' && v.length <= 1024) return v;
        if (Array.isArray(v) && v.length <= 16 && v.every(s => typeof s === 'string' && s.length <= 256)) return v.join(' → ');
        throw new Error();
      };
      const differences: LocalDiagnosis['differences'] = [];
      if (report.policy_preflight?.kind === 'policy_preflight' && report.policy_preflight.authority_verified === false) {
        if (!Array.isArray(report.policy_preflight.differences) || report.policy_preflight.differences.length > 10) throw new Error();
        for (const d of report.policy_preflight.differences) {
          if (!['repository','issue_repository','issue','base','branch','executor','checks','profile_ref','profile_version','work_item_version'].includes(d.field) || !statuses.includes(d.status)) throw new Error();
          differences.push({ field: d.field, expected: value(d.expected), observed: value(d.observed), status: d.status });
        }
      } else {
        const branch = report.checks.find((c: { id: string }) => c.id === 'branch');
        if (branch?.details) differences.push({ field: 'branch · 静态策略比较', expected: value(branch.details.expected_branch), observed: value(branch.details.actual_branch), status: branch.status });
      }
      return { id: b.id, project_id: b.project_id, repository: b.repository, observed_at: new Date().toISOString(), source: 'installed_client_offline',
        status: checks.some(c => c.status === 'blocked') ? 'blocked' : checks.some(c => c.status === 'not_checked') ? 'not_checked' : 'passed',
        client_version: CLIENT_VERSION, approved_version: checks.some(c => c.id === 'policy_source' && c.status === 'passed') &&
          typeof report.policy_preflight?.approved_effective?.work_item_version === 'string' && validId(report.policy_preflight.approved_effective.work_item_version)
          ? report.policy_preflight.approved_effective.work_item_version : null, differences, checks, authority_verified: false };
    } catch { return failure(b, 'local_doctor_unavailable'); }
  };
  return {
    list: (viewer: Viewer) => registry.filter(b => viewer.project_ids.includes(b.project_id)).map(b => ({ id: b.id, project_id: b.project_id,
      repository: b.repository, worktree: b.worktree, current: current.get(b.id) ?? null })),
    diagnose: (viewer: Viewer, id: string): Promise<LocalDiagnosis> => {
      const b = visible(viewer, id), existing = pending.get(id), cached = current.get(id);
      if (existing) return existing;
      if (cached && Date.now() - Date.parse(cached.observed_at) < 5000) return Promise.resolve(cached);
      if (pending.size >= 2) fail(503, 'diagnosis_busy', 'Local diagnosis capacity reached');
      const result = run(b).then(value => { current.set(id, value); return value; }).finally(() => pending.delete(id));
      pending.set(id, result); return result;
    }
  };
}
