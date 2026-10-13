import type { Task } from '../../src/dashboard/tasks.js';
import type { Snapshot } from './useDashboard.js';
import { GITHUB_REFRESH_LABELS, ROLE_LABELS, isActive, isAwaitingReview, isBlocked } from './semantics.js';

export interface ProjectRow {
  id: string;
  name: string | null;
  repository: string;
  profile_ref: string;
  provenance: string;
  last_activity: string | null;
  active_runs: number;
}

/** Registered projects plus explicitly observed local-fast projects. Both keep their provenance. */
export function projectRows(snapshot: Snapshot | null, tasks: Task[]): ProjectRow[] {
  const registered = snapshot?.projects ?? [];
  const observed = [...new Map(
    tasks.filter(task => task.workflow === 'local-fast' && !registered.some(p => p.id === task.project_id))
      .map(task => [task.project_id, task] as const)
  ).values()].map(task => ({
    id: task.project_id, name: task.repository, repository: task.repository, profile_ref: 'local-fast',
    enabled: null as boolean | null, last_activity: task.updated_at, active_runs: [], metadata_provenance: 'local_fast_observation',
  }));
  return [...registered, ...observed].map(project => ({
    id: project.id, name: project.name, repository: project.repository, profile_ref: project.profile_ref,
    provenance: project.metadata_provenance, last_activity: project.last_activity, active_runs: project.active_runs.length,
  }));
}

export function projectOptions(snapshot: Snapshot | null, tasks: Task[]) {
  const rows = projectRows(snapshot, tasks);
  const map = new Map<string, string>(rows.map(row => [row.id, row.repository]));
  for (const task of tasks) if (!map.has(task.project_id)) map.set(task.project_id, task.repository);
  return [...map.entries()].map(([id, repository]) => ({ value: id, label: `${id} · ${repository}` }));
}

export function overviewMetrics(snapshot: Snapshot | null, tasks: Task[]) {
  const runs = snapshot?.runs ?? [];
  const executors = snapshot?.executors ?? [];
  return {
    projects: projectRows(snapshot, tasks).length,
    executors: executors.length,
    developing: tasks.filter(isActive).length,
    awaitingReview: tasks.filter(isAwaitingReview).length,
    blocked: tasks.filter(isBlocked).length,
    completed: tasks.filter(task => task.state === 'completed').length,
    activeRuns: runs.filter(run => !['completed', 'failed'].includes(run.state)).length,
    events: 0,
  };
}

/** Next responsible party + next action, grouped by the role that has to move. */
export function nextActionGroups(tasks: Task[]) {
  const groups = new Map<string, { role: string; label: string; count: number; actions: string[]; tasks: Task[] }>();
  for (const task of tasks) {
    if (!task.waiting_for && !task.active_actor) continue;
    const role = task.active_actor?.role ?? task.waiting_for!.role;
    const name = task.active_actor?.name ?? task.waiting_for!.name;
    const entry = groups.get(role) ?? { role, label: name, count: 0, actions: [], tasks: [] };
    entry.count += 1;
    entry.tasks.push(task);
    if (task.next_action && !entry.actions.includes(task.next_action)) entry.actions.push(task.next_action);
    groups.set(role, entry);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
    .map(group => ({ ...group, label: ROLE_LABELS[group.role] ?? group.label }));
}

export function githubObservation(tasks: Task[]) {
  const refreshes = tasks.map(task => task.github_refresh);
  const status = refreshes.some(item => item.status === 'rate_limited') ? 'rate_limited'
    : refreshes.some(item => item.status === 'querying') ? 'querying'
      : refreshes.some(item => item.status === 'failed') ? 'failed'
        : refreshes.some(item => item.status === 'success') ? 'success' : 'not_checked';
  const lastSuccess = refreshes.map(item => item.last_success_at).filter((v): v is string => !!v).sort().at(-1) ?? null;
  const retryAt = refreshes.map(item => item.retry_at).filter((v): v is string => !!v).sort().at(-1) ?? null;
  return { status, label: GITHUB_REFRESH_LABELS[status] ?? status, lastSuccess, retryAt };
}

export const sortedByUpdate = (tasks: Task[]) =>
  [...tasks].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
