// Presentation only: protocol states, identifiers, URLs and response data stay unchanged.
// The label/color tables below never reinterpret a value; they only render what the
// read contract delivered. Fixture rows keep an explicit 模拟数据 marker.
import type { Task } from '../../src/dashboard/tasks.js';

export type DashboardPhase = 'loading' | 'refreshing' | 'connecting' | 'live' | 'partial' | 'outdated' | 'offline' | 'error';

export const STATE_LABELS: Record<string, string> = {
  queued: '队列等待', ready: '准备开发', developing: '开发中', verifying: '验证中',
  awaiting_review: '等待独立 Review', changes_requested: 'Review 要求修改', review_passed: 'Review 已通过',
  awaiting_merge: '等待合并', merging: '合并中', completed: '已完成', blocked: '阻塞 / 待处理', unknown: '状态未知',
};

// antd Tag preset colours; the two workflow-critical states (等待 Review / 阻塞) stay distinct.
export const STATE_COLORS: Record<string, string> = {
  queued: 'default', ready: 'default', developing: 'processing', verifying: 'cyan',
  awaiting_review: 'warning', changes_requested: 'orange', review_passed: 'green',
  awaiting_merge: 'geekblue', merging: 'blue', completed: 'success', blocked: 'error', unknown: 'default',
};

export const PHASE_META: Record<DashboardPhase, { label: string; color: string; alert: 'success' | 'info' | 'warning' | 'error' }> = {
  loading: { label: '加载中', color: 'processing', alert: 'info' },
  refreshing: { label: '刷新中', color: 'processing', alert: 'info' },
  connecting: { label: '连接实时更新中', color: 'processing', alert: 'info' },
  live: { label: '已连接', color: 'success', alert: 'success' },
  partial: { label: '部分数据 · 同步中', color: 'warning', alert: 'warning' },
  outdated: { label: '数据已过期 · 显示上次快照', color: 'warning', alert: 'warning' },
  offline: { label: '离线 · 显示上次快照', color: 'error', alert: 'error' },
  error: { label: '暂不可用', color: 'error', alert: 'error' },
};

export const ROLE_LABELS: Record<string, string> = {
  coding_executor: 'Coding Executor',
  reviewer: '独立 Reviewer',
  owner: 'Owner',
  stage: 'AWH Stage',
  watcher: 'AWH Watcher',
};

export const REVIEW_GATE_LABELS: Record<string, string> = {
  passed: '已通过', changes_requested: '要求修改', pending: '等待中', not_checked: '未核验', stale: '已失效（HEAD 漂移）',
};
export const REVIEW_GATE_SOURCE_LABELS: Record<string, string> = {
  administrator_policy: '管理员策略核验',
  local_fast_contract: 'Local Fast 契约',
  not_checked: '未核验',
};
export const CHECK_LABELS: Record<string, string> = {
  passed: '通过', failed: '失败', pending: '等待中', not_checked: '未核验', none: '无 checks',
};
export const OWNER_SCOPE_LABELS: Record<string, string> = {
  valid: '有效', expired: '已过期', not_checked: '未核验',
};
export const OBSERVATION_SOURCE_LABELS: Record<string, string> = {
  control_plane: 'Control Plane 记录', local_fast: 'Local Fast 观察', github: 'GitHub 观察',
  owner_scope: 'Owner 范围', watcher: 'Watcher 观察',
};
export const OBSERVATION_STATUS_LABELS: Record<string, string> = {
  verified: '已观察', unknown: '未知', not_checked: '未核验', permission_denied: '权限不足',
};
export const FRESHNESS_LABELS: Record<string, string> = { fresh: '新鲜', stale: '已过期', unknown: '未知' };
export const WATCHER_LABELS: Record<string, string> = {
  not_checked: '未核验', WATCHING: '监听中', STOPPED: '已停止', IDLE: '空闲', UNKNOWN: '未知',
};
export const WORKFLOW_LABELS: Record<string, string> = { standard: 'Standard', 'local-fast': 'Local Fast' };
export const GITHUB_REFRESH_LABELS: Record<string, string> = {
  not_checked: '未核验', querying: '查询中', success: '成功', failed: '失败', rate_limited: '限流 / 退避',
};

export const PROVENANCE_NOTE = '运行时记录 · 注册与心跳不代表 GitHub 授权核验';
export const AUTHORITY_NOTE = 'authority_verified=false · GitHub 授权未核验';
export const REVIEW_NOTE = '只有真实证据才显示为 Review 通过；运行时声明不构成独立审查或 GitHub 批准';

export const text = (value: string) => STATE_LABELS[value] ?? ROLE_LABELS[value] ?? value;
export const stateLabel = (value: string | null | undefined) => (value && STATE_LABELS[value]) || '状态未知';
export const stateColor = (value: string | null | undefined) => (value && STATE_COLORS[value]) || 'default';
export const roleLabel = (value: string | null | undefined) => (value && ROLE_LABELS[value]) || null;

export const stamp = (value: string | number | null | undefined) =>
  value === null || value === undefined ? '未知' : new Date(value).toLocaleString('zh-CN', { hour12: false });
export const shortSha = (sha: string | null | undefined) => (!sha ? '未提供' : sha.slice(0, 10));

// Same-origin safe GitHub links. The repository/number/SHA validation mirrors
// dashboard/adapter.mjs so V2 can never widen the existing URL contract.
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;
export function safeIssueUrl(repository: string | null | undefined, number: number | null | undefined) {
  return repository && REPOSITORY.test(repository) && Number.isSafeInteger(number) && Number(number) >= 1
    ? `https://github.com/${repository}/issues/${number}` : null;
}
export function safePullUrl(repository: string | null | undefined, number: number | null | undefined) {
  return repository && REPOSITORY.test(repository) && Number.isSafeInteger(number) && Number(number) >= 1
    ? `https://github.com/${repository}/pull/${number}` : null;
}
export function safeCommitUrl(repository: string | null | undefined, sha: string | null | undefined) {
  return repository && REPOSITORY.test(repository) && sha && SHA.test(sha) ? `https://github.com/${repository}/commit/${sha}` : null;
}

export const isFixture = (task: Task) => task.fixture === true;
export const actorName = (actor: Task['active_actor'] | Task['waiting_for']) => actor?.name ?? null;
/** Who is responsible for the next step when nobody is currently acting. */
export const nextOwner = (task: Task) => task.active_actor ?? task.waiting_for;
export const nextOwnerLabel = (task: Task) => roleLabel(nextOwner(task)?.role ?? null) ?? '未记录';

export const isAwaitingReview = (task: Task) =>
  task.state === 'awaiting_review' || task.state === 'review_passed' || task.waiting_for?.role === 'reviewer';
export const isBlocked = (task: Task) => task.state === 'blocked' || task.blockers.length > 0;
export const isActive = (task: Task) => ['developing', 'verifying', 'merging'].includes(task.state);

export const searchText = (task: Task) => [
  task.id, task.project_id, task.repository, task.issue.title, `#${task.issue.number}`,
  task.state, stateLabel(task.state), task.executor, task.machine?.id, task.machine?.name,
  task.active_actor?.name, task.waiting_for?.name, task.next_action, ...task.blockers,
].filter(Boolean).join(' ').toLowerCase();
