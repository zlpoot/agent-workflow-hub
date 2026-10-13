import type { Task } from '../../src/dashboard/tasks.js';
import { taskStale, localStale, githubStale } from '../task-freshness.mjs';
import type { DashboardState, TaskDetail } from './useDashboard.js';

export interface PresentedTask extends Task {
  factsCurrent: boolean;
  factReason: string | null;
}

/** Refresh clears Reader.error before it has new facts; retain the invalidation until success. */
export function presentationState(previous: DashboardState, incoming: DashboardState): DashboardState {
  return { ...incoming, factsUnavailable: incoming.phase === 'refreshing'
    ? previous.factsUnavailable || ['offline', 'outdated', 'error', 'partial'].includes(previous.phase)
    : ['offline', 'outdated', 'error', 'partial'].includes(incoming.phase) };
}

/** One conservative presentation boundary; never alters the Reader or its contract. */
export function presentTask(task: Task, state: DashboardState, now = Date.now(), detailUnavailable = false): PresentedTask {
  const ahead = state.events.some(event => event.cursor > (state.snapshot?.cursor ?? -1));
  const reason = detailUnavailable ? '详情尚未成功读取'
    : ahead ? '事件水位领先快照'
    : state.factsUnavailable || ['offline', 'outdated', 'error', 'partial', 'loading'].includes(state.phase) ? '当前快照尚未核验'
    : taskStale(task, now) || localStale(task, now) || (task.github_head && githubStale(task, now)) ? '任务观察已过期'
    : null;
  if (!reason) return { ...task, factsCurrent: true, factReason: null };
  return { ...task, factsCurrent: false, factReason: reason,
    state: 'unknown', active_actor: null, waiting_for: null, executor: null, machine: null,
    next_action: '等待重新读取并核验当前任务事实', blockers: [],
    watcher: { status: 'UNKNOWN', running: null, executor_running: null, stale_lock: null },
    owner_scope: { status: 'not_checked', expires_at: null, allow_merge: null },
  };
}

export const presentTasks = (state: DashboardState, now = Date.now()) =>
  (state.snapshot?.tasks ?? []).map(task => presentTask(task, state, now));

export function presentDetail(detail: TaskDetail, state: DashboardState, now = Date.now()) {
  if (!detail.item) return { ...detail, item: null };
  const snapshotTask = state.snapshot?.tasks?.find(task => task.id === detail.item?.id);
  // An open drawer must not resurrect an older successful detail after snapshot recovery.
  const item = snapshotTask && (snapshotTask.updated_at ?? '') >= (detail.item.updated_at ?? '') ? snapshotTask : detail.item;
  return { ...detail, item: presentTask(item, state, now, detail.loading || !!detail.error || !snapshotTask) };
}
