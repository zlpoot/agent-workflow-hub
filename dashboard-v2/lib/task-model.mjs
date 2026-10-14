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
/** Task DTO has no trusted provider; the Reviewer must read the native PR author. */
export function localFastReviewInstruction(task) {
  return [
    `请独立审查 https://github.com/${task.repository}/pull/${task.pr.number} 的实际当前完整 HEAD、完整差异及 Issue，运行必要定向测试。`,
    '先读取 GitHub 原生 PR 作者与当前 Reviewer 账号，并通过已有原生 Review Bridge prepare 核对交付身份、受信 Reviewer 和返回的 review_template / delivery_instructions，再选择对应操作：',
    'github-app（Bot 作者）：由已绑定的独立个人 Reviewer 提交原生 APPROVED（API event: APPROVE）或 CHANGES_REQUESTED（API event: REQUEST_CHANGES）。个人账号的 COMMENTED + PASS 不会打开 Bot PR 的 Review Gate。',
    'personal-gh（Reviewer 与个人 PR 作者同账号）：提交原生 COMMENTED（API event: COMMENT），正文使用 AWH-LOCAL-FAST-REVIEW v1 的结构化模板，包含恰好 head 和 decision 两个字段，decision 为 PASS 或 REQUEST_CHANGES。其他独立个人账号可提交原生 APPROVED 或 CHANGES_REQUESTED。',
    '所有路径的 native commit_id 必须等于实际当前 HEAD；结构化 COMMENTED 的 head 也必须相同。发布后回读原生 Review 和当前 PR HEAD，未实际发布不算 Gate 通过。不要执行 Merge 或关闭 Issue。',
    `观察的历史 HEAD：${task.github_head ?? task.source_head ?? '未核验'}；请重新读取 GitHub。`,
  ].join('\n\n');
}
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
