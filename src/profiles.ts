import { createHash } from 'node:crypto';
import { readExternalFile } from './shared/external-files.js';
import { safeData } from './shared/security.js';

export class ProfileError extends Error {}
export interface BuilderSelection { profile: string; workflow: string }
export interface Workflow {
  readonly id: string;
  readonly version: string;
  readonly branch: string;
  readonly branch_mode: 'fixed' | 'issue_prefix';
  readonly work_item: Readonly<{ repo: string; issue: number }>;
  readonly verification_commands: readonly string[];
  readonly bootstrap_paths: readonly string[] | null;
  readonly executor_restrictions: Readonly<{ executor_ids: readonly string[]; machine_ids: readonly string[] }>;
}
export interface ProjectProfile { readonly id: string; readonly repository: string; readonly base: string; readonly workflows: readonly Workflow[] }
export interface ApprovedPolicy {
  readonly schema_version: '1.0';
  readonly kind: 'builder_policy';
  readonly default_selection: Readonly<BuilderSelection>;
  readonly installation: Readonly<{ app_id: number; installation_id: number; account_login: string; app_slug: string;
    selected_repository_sets: readonly (readonly string[])[];
    reviewers: readonly Readonly<{ login: string; id: number }>[];
    authorization_actors: readonly Readonly<{ login: string; id: number }>[] }>;
  readonly profiles: readonly ProjectProfile[];
}
const deny = (): never => { throw new ProfileError('Administrator-approved Builder policy required or policy validation failed'); };
const object = (v: any, keys: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v);
const repo = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(v) && !v.includes('..');
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(v) && !v.includes('..') && !v.includes('//') && !v.split('/').some(s => !s || s.endsWith('.lock') || s.endsWith('.'));
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const list = (v: any, check: (x: any) => boolean, max = 128) => Array.isArray(v) && v.length > 0 && v.length <= max && new Set(v.map((x: any) => JSON.stringify(x))).size === v.length && v.every(check);
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

/** The administrator supplies an OS-protected external file and its independently
 * approved digest in the launcher environment. Never discover them from a project,
 * CP response, Issue, manifest or command argument. No built-in repository authority. */
export function loadTrustedPolicy(): ApprovedPolicy {
  try {
    const path = process.env.AWH_BUILDER_POLICY_FILE, pin = process.env.AWH_BUILDER_POLICY_SHA256;
    if (!path || !pin || !/^[a-f0-9]{64}$/.test(pin)) return deny();
    const bytes = readExternalFile(path, 256 * 1024, true);
    if (createHash('sha256').update(bytes).digest('hex') !== pin) return deny();
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); safeData(v);
    if (!object(v, ['schema_version','kind','default_selection','installation','profiles']) || v.schema_version !== '1.0' || v.kind !== 'builder_policy' ||
        !object(v.default_selection, ['profile','workflow']) || !id(v.default_selection.profile) || !id(v.default_selection.workflow)) return deny();
    const a = v.installation;
    if (!object(a, ['app_id','installation_id','account_login','app_slug','selected_repository_sets','reviewers','authorization_actors']) ||
        !positive(a.app_id) || !positive(a.installation_id) || typeof a.account_login !== 'string' || typeof a.app_slug !== 'string' || !/^[A-Za-z0-9-]+$/.test(a.account_login) || !/^[a-z0-9-]+$/.test(a.app_slug) ||
        !list(a.selected_repository_sets, set => list(set, repo) && set.every((r: string) => r.split('/')[0] === a.account_login), 32) ||
        ![a.reviewers,a.authorization_actors].every(actors => list(actors, actor => object(actor, ['login','id']) && typeof actor.login === 'string' && /^[A-Za-z0-9-]+$/.test(actor.login) && positive(actor.id)) && new Set(actors.map((actor: {login: string}) => actor.login)).size === actors.length && new Set(actors.map((actor: {id: number}) => actor.id)).size === actors.length)) return deny();
    if (!list(v.profiles, p => {
      if (!object(p, ['id','repository','base','workflows']) || !id(p.id) || !repo(p.repository) || !ref(p.base) ||
          !a.selected_repository_sets.some((set: string[]) => set.includes(p.repository))) return false;
      if (!list(p.workflows, w => object(w, ['id','version','branch','branch_mode','work_item','verification_commands','bootstrap_paths','executor_restrictions']) &&
          id(w.id) && id(w.version) && ['fixed','issue_prefix'].includes(w.branch_mode) &&
          (w.branch_mode === 'fixed' ? ref(w.branch) && w.branch !== p.base : typeof w.branch === 'string' && /[-/]$/.test(w.branch) && ref(w.branch + '1')) &&
          object(w.work_item, ['repo','issue']) && repo(w.work_item.repo) && (w.branch_mode === 'fixed' ? positive(w.work_item.issue) : w.work_item.issue === 0 && w.work_item.repo === p.repository) &&
          list(w.verification_commands, c => typeof c === 'string' && /^[\x20-\x7e]{1,512}$/.test(c) && !/[;&|`$<>\r\n]/.test(c), 32) &&
          (w.bootstrap_paths === null || list(w.bootstrap_paths, path => typeof path === 'string' && /^[A-Za-z0-9_.\/-]{1,256}$/.test(path) && !path.startsWith('/') && !path.split('/').some((s: string) => !s || s === '.' || s === '..'))) &&
          (w.branch_mode === 'fixed' || w.bootstrap_paths !== null) &&
          object(w.executor_restrictions, ['executor_ids','machine_ids']) && list(w.executor_restrictions.executor_ids,id) && list(w.executor_restrictions.machine_ids,id))) return false;
      return new Set(p.workflows.map((w: Workflow) => w.id)).size === p.workflows.length;
    }, 64) || new Set(v.profiles.map((p: ProjectProfile) => p.id)).size !== v.profiles.length ||
        !v.profiles.some((p: ProjectProfile) => p.id === v.default_selection.profile && p.workflows.some(w => w.id === v.default_selection.workflow))) return deny();
    return freeze(v as ApprovedPolicy);
  } catch { return deny(); }
}
export function selectWorkflow(selection?: BuilderSelection, policy = loadTrustedPolicy()) {
  selection ??= policy.default_selection;
  if (!object(selection, ['profile','workflow'])) return deny();
  const profile = policy.profiles.find(p => p.id === selection!.profile), workflow = profile?.workflows.find(w => w.id === selection!.workflow);
  if (!profile || !workflow) return deny();
  return Object.freeze({ profile, workflow });
}
export function allowedInstallation(repositories: unknown, total: unknown, policy = loadTrustedPolicy()): repositories is { full_name: string }[] {
  if (!Array.isArray(repositories) || !positive(total) || repositories.length !== total || !repositories.every(r => r && repo(r.full_name))) return false;
  const names = repositories.map(r => r.full_name).sort();
  return new Set(names).size === names.length && policy.installation.selected_repository_sets.some(set => JSON.stringify([...set].sort()) === JSON.stringify(names));
}
export interface TaskBinding { repository: string; issue: number; branch: string; source_sha: string; profile_ref: string; profile_version: string; executor_id: string; machine_id: string; fingerprint: string }
function checkedBinding(value: Omit<TaskBinding, 'fingerprint'>, policy: ApprovedPolicy): TaskBinding {
  const keys = ['repository','issue','branch','source_sha','profile_ref','profile_version','executor_id','machine_id'];
  if (!object(value, keys) || typeof value.profile_ref !== 'string') return deny();
  const [profileId, workflowId, extra] = value.profile_ref.split('/');
  if (!profileId || !workflowId || extra) return deny();
  const { profile, workflow } = selectWorkflow({ profile: profileId, workflow: workflowId }, policy);
  if (workflow.branch_mode !== 'issue_prefix' || value.repository !== profile.repository || !positive(value.issue) || value.branch !== workflow.branch + value.issue ||
      !/^[a-f0-9]{40}$/.test(value.source_sha) || value.profile_version !== workflow.version || !workflow.executor_restrictions.executor_ids.includes(value.executor_id) ||
      !workflow.executor_restrictions.machine_ids.includes(value.machine_id)) return deny();
  const ordered = Object.fromEntries(keys.map(k => [k, value[k as keyof typeof value]]));
  return Object.freeze({ ...value, fingerprint: createHash('sha256').update(JSON.stringify(ordered)).digest('hex') });
}
export function taskBinding(value: Omit<TaskBinding, 'fingerprint'>): TaskBinding {
  return checkedBinding(value, loadTrustedPolicy());
}
export function bindWorkflow(selection?: BuilderSelection, binding?: TaskBinding, policy = loadTrustedPolicy()) {
  const fixed = selectWorkflow(selection, policy);
  if (fixed.workflow.branch_mode === 'fixed') { if (binding !== undefined) return deny(); return fixed; }
  if (!binding || !object(binding, ['repository','issue','branch','source_sha','profile_ref','profile_version','executor_id','machine_id','fingerprint'])) return deny();
  const { fingerprint, ...data } = binding, checked = checkedBinding(data, policy);
  if (checked.fingerprint !== fingerprint || checked.profile_ref !== `${fixed.profile.id}/${fixed.workflow.id}`) return deny();
  return Object.freeze({ profile: fixed.profile, workflow: Object.freeze({ ...fixed.workflow, branch: checked.branch, work_item: Object.freeze({ repo: checked.repository, issue: checked.issue }) }) });
}
