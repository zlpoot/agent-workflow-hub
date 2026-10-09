import { createHash } from 'node:crypto';
export const HUB_REPO = 'zlpoot/agent-workflow-hub';
export const FUTURE_REPO = 'zlpoot/future-ui';
export const WEBSKILL_REPO = 'zlpoot/webskill';

export interface Workflow {
  readonly id: string;
  readonly branch: string;
  readonly work_item: Readonly<{ repo: string; issue: number }>;
  readonly verification_commands: readonly string[];
  readonly bootstrap_paths: readonly string[] | null;
}
export interface ProjectProfile {
  readonly id: string;
  readonly repository: string;
  readonly base: string;
  readonly workflows: readonly Workflow[];
}
export interface BuilderSelection { profile: string; workflow: string }
export class ProfileError extends Error {}
const workflow = (id: string, branch: string, issue: number, commands: string[], paths: string[] | null, repository = HUB_REPO): Workflow =>
  Object.freeze({ id, branch, work_item: Object.freeze({ repo: repository, issue }),
    verification_commands: Object.freeze(commands), bootstrap_paths: paths ? Object.freeze(paths) : null });

// Repository/workflow policy is checked-in data, never caller-provided URLs, agents or machine paths.
export const PROFILES: readonly ProjectProfile[] = Object.freeze([
  Object.freeze({ id: 'hub', repository: HUB_REPO, base: 'main', workflows: Object.freeze([
    workflow('c05', 'codex/c05-github-app-builder', 4, ['pnpm check'], null),
    workflow('c06', 'codex/c06-project-profiles', 6, ['pnpm check'], null),
    workflow('c07', 'codex/c07-webskill-profile', 8, ['pnpm check'], null),
    workflow('c07-r1', 'codex/c07-r1-git-transport', 10, ['pnpm check'], null),
    workflow('c07-r2', 'codex/c07-r2-receive-pack', 13, ['pnpm check'], null),
    workflow('c07-r3', 'codex/c07-r3-scoped-helper', 16, ['pnpm check'], null),
    workflow('c1a', 'codex/c1a-protocol', 19, ['pnpm check'], null),
    workflow('c1b', 'codex/c1b-control-plane', 20, ['pnpm check'], null),
    workflow('c1c', 'codex/c1c-client', 21, ['pnpm check'], null),
    workflow('c1e', 'codex/c1e-dashboard-api-contract', 23, ['pnpm check'], null),
    workflow('c1g', 'codex/c1g-dashboard-readonly', 30, ['pnpm check'], null),
    workflow('v02-mvp', 'codex/v02-repeatable-workflow', 41, ['pnpm check'], null),
    workflow('v01-mvp', 'codex/v01-mvp', 39, ['pnpm check'], null),
    workflow('c1h', 'codex/c12-trusted-onboarding', 31, ['pnpm check'], null),
    workflow('c1h-b0', 'codex/c1h-b0-security', 31,
      ['pnpm build', 'node --test tests/onboarding.test.mjs tests/builder.test.mjs'], null),
    workflow('c1i', 'codex/c1i-doctor-prototype', 32,
      ['pnpm build', 'node --test tests/doctor.test.mjs', 'node --test tests/client.test.mjs'], null),
    // One-time #34 code publication only; dynamic declarations never select Builder authority.
    workflow('c1k', 'codex/c1k-versioned-profile-prototype', 34,
      ['pnpm build', 'node --test tests/versioned-profile.test.mjs', 'node --test tests/doctor.test.mjs'], null),
    workflow('c1j', 'codex/c1j-dashboard-wizard-prototype', 33,
      ['pnpm build', 'pnpm typecheck', 'node --test tests/dashboard-ui.test.mjs tests/dashboard-wizard.test.mjs tests/doctor.test.mjs'], null),
    workflow('c1d', 'codex/c1d-builder-adapter', 22, ['pnpm check'], null),
  ]) }),
  Object.freeze({ id: 'future-ui', repository: FUTURE_REPO, base: 'main', workflows: Object.freeze([
    workflow('repeatable-docs', 'codex/awh-task-', 0, ['git diff --check origin/main...HEAD'],
      ['docs/management/awh-repeatable-workflow.md', 'docs/management/awh-v01-acceptance.md'], FUTURE_REPO),
    workflow('mvp-docs', 'codex/awh-v01-acceptance', 88, ['git diff --check origin/main...HEAD'],
      ['docs/management/awh-v01-acceptance.md', '.awh/project.yaml', '.gitignore'], FUTURE_REPO),
    workflow('bootstrap', 'codex/awh-c06-bootstrap', 6,
      ['pnpm lint', 'pnpm typecheck', 'pnpm test'], ['docs/management/agent-workflow-hub.md']),
  ]) }),
  Object.freeze({ id: 'webskill', repository: WEBSKILL_REPO, base: 'main', workflows: Object.freeze([
    workflow('bootstrap', 'codex/awh-c07-webskill-bootstrap', 8,
      ['pnpm check:foundations', 'pnpm lint', 'pnpm typecheck'], ['docs/management/agent-workflow-hub.md']),
  ]) }),
]);
export const DEFAULT_SELECTION: Readonly<BuilderSelection> = Object.freeze({ profile: 'hub', workflow: 'c05' });
export const ALLOWED_INSTALLATION_SETS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([HUB_REPO]), Object.freeze([HUB_REPO, FUTURE_REPO].sort()),
  Object.freeze([HUB_REPO, FUTURE_REPO, WEBSKILL_REPO].sort()),
  // Dormant installation member only: no agent-desktop Profile or write workflow.
  Object.freeze([HUB_REPO, FUTURE_REPO, WEBSKILL_REPO, 'zlpoot/agent-desktop'].sort()),
]);

export function selectWorkflow(selection: BuilderSelection = DEFAULT_SELECTION) {
  if (!selection || typeof selection !== 'object' || Object.keys(selection).length !== 2 ||
    !Object.hasOwn(selection, 'profile') || !Object.hasOwn(selection, 'workflow'))
    throw new ProfileError('Select only a fixed profile and workflow');
  const profile = PROFILES.find(p => p.id === selection.profile);
  const chosen = profile?.workflows.find(w => w.id === selection.workflow);
  if (!profile || !chosen) throw new ProfileError('Unsupported profile or workflow');
  return Object.freeze({ profile, workflow: chosen });
}

export function allowedInstallation(repositories: unknown, total: unknown): repositories is { full_name: string }[] {
  if (!Array.isArray(repositories) || repositories.length !== total ||
    !repositories.every(r => r && typeof r.full_name === 'string')) return false;
  const names = repositories.map(r => r.full_name).sort();
  return ALLOWED_INSTALLATION_SETS.some(set => JSON.stringify(set) === JSON.stringify(names));
}

// One checked-in template. Caller data can only fill a positive Issue and its canonical branch.
export const REPEATABLE_VERSION = 'v02-repeatable-v1';
export const TASK_PREFIX = 'codex/awh-task-';
export interface TaskBinding {
  repository: string; issue: number; branch: string; source_sha: string;
  profile_ref: string; profile_version: string; executor_id: string; machine_id: string; fingerprint: string;
}
export function taskBinding(value: Omit<TaskBinding, 'fingerprint'>): TaskBinding {
  const keys = ['repository','issue','branch','source_sha','profile_ref','profile_version','executor_id','machine_id'];
  if (!value || Object.keys(value).sort().join(',') !== [...keys].sort().join(',') ||
      value.repository !== FUTURE_REPO || !Number.isSafeInteger(value.issue) || value.issue < 1 ||
      value.branch !== TASK_PREFIX + value.issue || !/^[a-f0-9]{40}$/.test(value.source_sha) ||
      value.profile_ref !== 'future-ui/c1c-acceptance' || value.profile_version !== REPEATABLE_VERSION ||
      value.executor_id !== 'c1c-future-ui-windows' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.machine_id))
    throw new ProfileError('Task binding differs from the trusted Windows Future UI template');
  const ordered = Object.fromEntries(keys.map(k => [k, value[k as keyof typeof value]]));
  return Object.freeze({ ...value, fingerprint: createHash('sha256').update(JSON.stringify(ordered)).digest('hex') });
}
export function bindWorkflow(selection: BuilderSelection | undefined, binding?: TaskBinding) {
  const fixed = selectWorkflow(selection);
  if (fixed.workflow.id !== 'repeatable-docs') {
    if (binding !== undefined) throw new ProfileError('Fixed workflows do not accept a Task binding');
    return fixed;
  }
  if (!binding || Object.keys(binding).length !== 9) throw new ProfileError('Repeatable delivery requires a frozen Task binding');
  const { fingerprint, ...data } = binding;
  const checked = taskBinding(data);
  if (checked.fingerprint !== fingerprint) throw new ProfileError('Task fingerprint mismatch');
  return Object.freeze({ profile: fixed.profile, workflow: Object.freeze({ ...fixed.workflow,
    branch: checked.branch, work_item: Object.freeze({ repo: checked.repository, issue: checked.issue }) }) });
}
