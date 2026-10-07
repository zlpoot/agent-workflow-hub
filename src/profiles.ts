export const HUB_REPO = 'zlpoot/agent-workflow-hub';
export const FUTURE_REPO = 'zlpoot/future-ui';

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
const workflow = (id: string, branch: string, issue: number, commands: string[], paths: string[] | null): Workflow =>
  Object.freeze({ id, branch, work_item: Object.freeze({ repo: HUB_REPO, issue }),
    verification_commands: Object.freeze(commands), bootstrap_paths: paths ? Object.freeze(paths) : null });

// Repository/workflow policy is checked-in data, never caller-provided URLs, agents or machine paths.
export const PROFILES: readonly ProjectProfile[] = Object.freeze([
  Object.freeze({ id: 'hub', repository: HUB_REPO, base: 'main', workflows: Object.freeze([
    workflow('c05', 'codex/c05-github-app-builder', 4, ['pnpm check'], null),
    workflow('c06', 'codex/c06-project-profiles', 6, ['pnpm check'], null),
  ]) }),
  Object.freeze({ id: 'future-ui', repository: FUTURE_REPO, base: 'main', workflows: Object.freeze([
    workflow('bootstrap', 'codex/awh-c06-bootstrap', 6,
      ['pnpm lint', 'pnpm typecheck', 'pnpm test'], ['docs/management/agent-workflow-hub.md']),
  ]) }),
]);
export const DEFAULT_SELECTION: Readonly<BuilderSelection> = Object.freeze({ profile: 'hub', workflow: 'c05' });
export const ALLOWED_INSTALLATION_SETS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([HUB_REPO]), Object.freeze([HUB_REPO, FUTURE_REPO].sort()),
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
