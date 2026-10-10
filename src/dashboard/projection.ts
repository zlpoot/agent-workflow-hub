import { createHash } from 'node:crypto';
import { fail, validId } from '../control-plane/security.js';
import type { DashboardStore, DashboardReadView, StoredEvent } from '../control-plane/store.js';
import { RUN_STATES, type Event, type Run } from '../protocol/types.js';
import type { Viewer } from './security.js';

const indexes = new WeakMap<DashboardReadView, { runs: Map<string, Run>; events: Map<string, StoredEvent[]>; projects: Map<string, StoredEvent[]> }>();
function index(view: DashboardReadView) {
  let value = indexes.get(view);
  if (!value) {
    value = { runs: new Map(view.runs.map(run => [run.id, run])), events: new Map(), projects: new Map() };
    for (const entry of view.events) {
      const events = value.events.get(entry.event.run_id) ?? []; events.push(entry); value.events.set(entry.event.run_id, events);
      const project = value.runs.get(entry.event.run_id)!.project_id;
      const entries = value.projects.get(project) ?? []; entries.push(entry); value.projects.set(project, entries);
    }
    indexes.set(view, value);
  }
  return value;
}
const terminal = (run: Run) => run.state === 'completed' || run.state === 'failed';
const envelope = { contract_version: '1.0' as const, authority_verified: false as const };
type NumberRef = { provider: 'github'; repository: string; kind: string; number: number };
export function githubRef(ref: NumberRef) {
  // URLs are constructed from typed provider references, never arbitrary extension URLs.
  const path = ref.kind === 'issue' ? 'issues' : ref.kind === 'pull_request' ? 'pull' : null;
  return { ...ref, url: path ? `https://github.com/${ref.repository}/${path}/${ref.number}` : null, authority_verified: false as const };
}
function eventRefs(event: Event) {
  const data = event.payload.data;
  const refs: ReturnType<typeof githubRef>[] = [];
  for (const key of ['pull_request', 'comment', 'review'] as const)
    if (key in data) refs.push(githubRef((data as unknown as Record<string, NumberRef>)[key]!));
  return refs;
}
export function timeline(entry: StoredEvent, view: DashboardReadView) {
  const event = entry.event, run = index(view).runs.get(event.run_id)!;
  const data = event.payload.data;
  return { ...envelope, cursor: entry.cursor, event_id: event.id, sequence: event.sequence, project_id: run.project_id, run_id: run.id,
    executor_id: run.executor_id, machine_id: run.machine_id, actor: null, actor_provenance: 'not_recorded' as const,
    source_sha: run.source.sha, type: event.type, step_id: 'step_id' in data ? data.step_id : null, timestamp: event.occurred_at,
    result: 'exit_code' in data ? data.exit_code === 0 ? 'passed' as const : 'failed' as const :
      ['VERIFICATION_PASSED', 'RUN_COMPLETED'].includes(event.type) ? 'passed' as const :
        ['VERIFICATION_FAILED', 'RUN_FAILED'].includes(event.type) ? 'failed' as const : 'unknown' as const,
    github_refs: eventRefs(event), evidence: null, provenance: 'runtime_event_declaration' as const };
}
function steps(events: StoredEvent[]) {
  const open = new Map<string, { id: string; name: string | null }>();
  let last: { id: string; name: string | null } | null = null;
  for (const { event } of events) {
    if (event.type === 'STEP_STARTED') { last = { id: event.payload.data.step_id, name: event.payload.data.name }; open.set(last.id, last); }
    if (event.type === 'STEP_COMPLETED') { last = open.get(event.payload.data.step_id) ?? { id: event.payload.data.step_id, name: null }; open.delete(last.id); }
    if (event.type === 'RUN_FAILED' || event.type === 'RUN_COMPLETED') open.clear();
  }
  return { current_step: [...open.values()].at(-1) ?? null, last_step: last };
}
function runSummary(run: Run, view: DashboardReadView) {
  const events = index(view).events.get(run.id) ?? [];
  const work = view.work_items.find(work => work.id === run.work_item_id);
  const refs = events.flatMap(entry => eventRefs(entry.event));
  return { ...envelope, id: run.id, project_id: run.project_id, work_item: work ? { id: work.id, reference: githubRef(work.reference) } : null,
    state: run.state, state_provenance: 'runtime_projection' as const, executor_id: run.executor_id, machine_id: run.machine_id,
    source: { ...run.source, url: `https://github.com/${run.source.repository}/commit/${run.source.sha}` }, profile: run.profile,
    ...steps(events), created_at: run.created_at, started_at: run.started_at, finished_at: run.completed_at, updated_at: run.updated_at,
    github_refs: refs.filter((ref, index) => refs.findIndex(candidate => candidate.kind === ref.kind && candidate.repository === ref.repository && candidate.number === ref.number) === index) };
}
function diagnostics(run: Run, view: DashboardReadView) {
  const policy = view.policies.find(policy => policy.ref === run.profile.ref && policy.version === run.profile.version);
  const item = view.work_items.find(item => item.id === run.work_item_id);
  const events = view.events.filter(entry => entry.event.run_id === run.id);
  const verification = events.findLast(entry => ['VERIFICATION_STARTED', 'VERIFICATION_PASSED', 'VERIFICATION_FAILED'].includes(entry.event.type));
  const data = verification?.event.payload.data;
  const observedChecks = data && 'checks' in data ? data.checks : null;
  const expected = policy?.verification.commands ?? null;
  const match = verification?.event.type === 'VERIFICATION_PASSED' && observedChecks !== null && expected !== null &&
    JSON.stringify(observedChecks.map(check => check.command)) === JSON.stringify(expected) && observedChecks.every(check => check.exit_code === 0);
  const comparison = (status: 'passed' | 'blocked' | 'not_checked', observed: unknown, expected: unknown, provenance: string, hint: string) =>
    ({ status, observed, expected, provenance, action_hint: hint, authority_verified: false as const });
  return { branch: comparison(policy ? run.source.ref === (policy.branch.mode === 'issue_prefix' ? policy.branch.ref + item?.reference.number : policy.branch.ref) ? 'passed' : 'blocked' : 'not_checked', run.source.ref, policy?.branch.ref ?? null,
      'client_source_declaration_vs_trusted_policy', 'Confirm the real branch against the approved Policy; do not switch active worktrees automatically.'),
    checks: comparison(observedChecks ? match ? 'passed' : 'blocked' : 'not_checked', observedChecks, expected, 'runtime_verification_declaration', 'Verify exact source SHA and the ordered checks through Builder evidence.'),
    work_item: comparison('not_checked', item?.reference ?? null, null, 'runtime_binding_only', 'Confirm the selected Issue against the approved per-work-item Policy.'),
    policy_version: comparison(policy ? 'passed' : 'not_checked', run.profile.version, policy?.version ?? null, 'stored_trusted_binding', 'Confirm the exact immutable Policy version.'),
    github_app: comparison('not_checked', null, null, 'no_live_provider_check', 'Run an explicitly authorized App live preflight outside the Dashboard.'),
    provider_permissions: comparison('not_checked', null, null, 'no_live_provider_check', 'Live-verify provider permissions before delivery.'),
    verification_subject_sha: data && 'subject_sha' in data ? data.subject_sha : null, verification_cursor: verification?.cursor ?? null };
}
export class DashboardProjection {
  constructor(readonly store: DashboardStore, readonly viewer: Viewer, readonly now = Date.now, readonly readView?: () => DashboardReadView) {}
  view() { return this.readView ? this.readView() : this.store.dashboardReadView(this.viewer); }
  projects(view = this.view()) {
    return view.projects.map(project => {
      const runs = view.runs.filter(run => run.project_id === project.id);
      return { ...envelope, id: project.id, name: null, repository: project.repository, profile_ref: project.profile_ref, enabled: null,
        last_activity: runs.map(run => run.updated_at).sort().at(-1) ?? null,
        active_runs: runs.filter(run => !terminal(run)).map(run => runSummary(run, view)), metadata_provenance: 'stored_registry' as const };
    });
  }
  runs(view = this.view()) { return view.runs.map(run => runSummary(run, view)); }
  executors(view = this.view()) {
    const observed = this.now();
    return view.executors.map(({ executor, client, last_seen }) => {
      const age = observed - Date.parse(last_seen);
      const bindings = view.enrollment_bindings?.filter(b => b.executor_id === executor.id) ?? [];
      return { ...envelope, id: executor.id, display_name: executor.display_name, type: client?.executor_type ?? null,
        ...(bindings.length ? {project_ids:[...new Set(bindings.map(b => b.project_id))],worktrees:bindings.map(b => ({id:b.worktree_id ?? null,path:b.worktree ?? null}))} : {}),
        machine: { ...executor.machine, name: client?.machine_name ?? null, arch: client?.arch ?? null }, platform: executor.machine.platform,
        last_seen, heartbeat_at: null, status: !Number.isFinite(age) || age < 0 ? 'unknown' as const : age <= 60000 ? 'online' as const : 'offline' as const,
        observed_at: new Date(observed).toISOString(), freshness_ms: 60000, presence_provenance: 'server_registration_or_heartbeat' as const,
        current_runs: view.runs.filter(run => run.executor_id === executor.id && !terminal(run)).map(run => ({ id: run.id, project_id: run.project_id, state: run.state })) };
    });
  }
  snapshot() {
    const view = this.view();
    return { ...envelope, cursor: view.cursor, projects: this.projects(view), runs: this.runs(view), executors: this.executors(view) };
  }
  scope(projectId: string) { if (!this.viewer.project_ids.includes(projectId)) fail(403, 'forbidden', 'Project is outside the viewer scope'); }
  detail(kind: 'projects' | 'runs' | 'executors', id: string) {
    const view = this.view();
    if (kind === 'projects') this.scope(id);
    const value = this[kind](view).find(item => item.id === id);
    if (!value) fail(404, 'not_found', 'Dashboard entity was not found in the viewer scope');
    if (kind !== 'runs') return value;
    const run = view.runs.find(run => run.id === id)!;
    return { ...value, diagnostics: diagnostics(run, view) };
  }
  timeline(runId: string | null, after: number, limit: number, projectId: string | null = null) {
    const view = this.view();
    if (projectId) this.scope(projectId);
    if (after > view.cursor) fail(400, 'invalid_cursor', 'Cursor is ahead of the Event Store');
    if (runId && !view.runs.some(run => run.id === runId && (!projectId || run.project_id === projectId))) fail(404, 'not_found', 'Run was not found in the viewer scope');
    const history = runId ? index(view).events.get(runId) ?? [] : projectId ? index(view).projects.get(projectId) ?? [] : view.events;
    let low = 0, high = history.length;
    while (low < high) { const mid = (low + high) >>> 1; if (history[mid]!.cursor <= after) low = mid + 1; else high = mid; }
    const entries = history.slice(low, low + limit + 1);
    const items = entries.slice(0, limit).map(entry => timeline(entry, view));
    return { ...envelope, items, next_cursor: entries.length > limit ? items.at(-1)!.cursor : null, snapshot_cursor: view.cursor };
  }
  page(kind: 'projects' | 'runs' | 'executors', url: URL) {
    const allowed = kind === 'runs' ? ['limit', 'cursor', 'project_id', 'state', 'executor_id'] : ['limit', 'cursor', 'project_id'];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'invalid_query', 'Unsupported or repeated query parameter');
    const limit = integer(url.searchParams.get('limit'), 100, 100);
    if (limit < 1) fail(400, 'invalid_query', 'Limit must be between one and 100');
    const project = url.searchParams.get('project_id'), executor = url.searchParams.get('executor_id'), state = url.searchParams.get('state');
    if (project) { if (!validId(project)) fail(400, 'invalid_query', 'Invalid project filter'); this.scope(project); }
    if (executor && !validId(executor)) fail(400, 'invalid_query', 'Invalid executor filter');
    if (state && !RUN_STATES.includes(state as Run['state'])) fail(400, 'invalid_query', 'Invalid state filter');
    if ([project, executor, state].some(value => value === '')) fail(400, 'invalid_query', 'Empty filter');
    const binding = createHash('sha256').update(JSON.stringify([kind, [...this.viewer.project_ids].sort(), project, executor, state])).digest('hex');
    let after = '';
    if (url.searchParams.has('cursor')) {
      try {
        const text = url.searchParams.get('cursor')!;
        if (text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
        const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== binding || !validId(parsed[1])) throw new Error();
        after = parsed[1];
      } catch { fail(400, 'invalid_cursor', 'Invalid cursor for this scope and filter'); }
    }
    const view = this.view();
    const values = this[kind](view).filter(item => {
      if (kind === 'projects') return !project || item.id === project;
      if (kind === 'executors') return !project || view.runs.some(run => run.executor_id === item.id && run.project_id === project);
      const run = view.runs.find(run => run.id === item.id)!;
      return (!project || run.project_id === project) && (!executor || run.executor_id === executor) && (!state || run.state === state);
    });
    if (after && !values.some(item => item.id === after)) fail(400, 'invalid_cursor', 'Cursor no longer belongs to this result set; restart pagination');
    const remaining = values.filter(value => value.id > after), items = remaining.slice(0, limit);
    return { ...envelope, items, next_cursor: remaining.length > limit ? Buffer.from(JSON.stringify([binding, items.at(-1)!.id])).toString('base64url') : null,
      snapshot_cursor: view.cursor };
  }
}
export function integer(value: string | null, fallback = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
    fail(400, 'invalid_cursor', 'Invalid integer cursor or limit');
  return Number(value);
}
