import { taskStale, localStale } from "../../dashboard/task-freshness.mjs";
export const taskLabels = {
  queued: "排队中",
  ready: "准备开发",
  developing: "正在开发",
  verifying: "验证 / 交付",
  awaiting_review: "等待独立 Review",
  changes_requested: "要求修改",
  review_passed: "Review 通过",
  awaiting_merge: "等待合并",
  merging: "正在合并",
  completed: "已完成",
  blocked: "阻塞 / 待处理",
  unknown: "状态未知",
};
export const sourceLabels = {
  control_plane: "CP 运行时声明",
  local_fast: "Local Fast 本机记录",
  github: "GitHub 原生观察",
  owner_scope: "Owner scope 摘要",
  watcher: "Watcher 本机观察",
};
export const phaseLabels = {
  loading: "加载中",
  refreshing: "刷新中",
  connecting: "连接实时更新中",
  live: "已连接",
  partial: "部分数据 · 同步中",
  outdated: "数据已过期",
  offline: "离线",
  error: "暂不可用",
};
export const stamp = (value) =>
  value == null
    ? "未提供"
    : new Date(value).toLocaleString("zh-CN", { hour12: false });
/** @param {string} phase @param {number|null} snapshotCursor @param {{cursor:number}[]} events */
export function taskSnapshotPending(phase, snapshotCursor = null, events = []) {
  return (
    phase === "partial" ||
    (snapshotCursor !== null &&
      events.some((event) => event.cursor > snapshotCursor))
  );
}
/** @param {string} phase @param {number|null} snapshotCursor @param {{cursor:number}[]} events */
export function taskSnapshotUnreliable(
  phase,
  snapshotCursor = null,
  events = [],
) {
  return (
    taskSnapshotPending(phase, snapshotCursor, events) ||
    ["offline", "outdated", "error"].includes(phase)
  );
}
export function taskFacts(task, disconnected, now = Date.now()) {
  const unknown = disconnected || taskStale(task, now);
  const actorUnknown = disconnected || localStale(task, now);
  return {
    state: unknown ? "unknown" : task.state,
    actor: actorUnknown
      ? "未知 / 已过期"
      : (task.active_actor?.name ?? "未观察到执行"),
    waiting: unknown ? "重新核验" : (task.waiting_for?.name ?? "—"),
    action: unknown ? "恢复读取并重新核验来源" : task.next_action,
  };
}
export function overviewCounts(tasks, disconnected, now = Date.now()) {
  const counts = {
    developing: 0,
    awaiting_review: 0,
    pending: 0,
    completed: 0,
  };
  for (const task of tasks) {
    const state = taskFacts(task, disconnected, now).state;
    if (["developing", "verifying", "merging"].includes(state))
      counts.developing++;
    else if (state === "awaiting_review") counts.awaiting_review++;
    else if (state === "completed") counts.completed++;
    // All other stages, including unknown/expired facts, still need handling.
    else counts.pending++;
  }
  return counts;
}
export function filterTasks(tasks, filters, disconnected, now = Date.now()) {
  return tasks.filter(
    (task) =>
      (filters.project === "all" || task.project_id === filters.project) &&
      (filters.stage === "all" ||
        taskFacts(task, disconnected, now).state === filters.stage) &&
      (filters.role === "all" ||
        (!disconnected &&
          !taskStale(task, now) &&
          (task.waiting_for?.role === filters.role ||
            task.active_actor?.role === filters.role))) &&
      (filters.machine === "all" || task.machine?.id === filters.machine) &&
      `${task.repository} ${task.project_id} ${task.issue.number} ${task.issue.title ?? ""} ${task.pr?.number ?? ""} ${task.executor ?? ""}`
        .toLowerCase()
        .includes(filters.search.trim().toLowerCase()),
  );
}
