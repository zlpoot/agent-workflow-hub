import { Alert, Card, Empty, Skeleton, Typography } from 'antd';
import { PHASE_META } from '../semantics.js';
import type { DashboardPhase } from '../semantics.js';

/** Loading / empty / degraded states are real UI states, never faked as live data. */
export function LoadingBlock({ title, rows = 4 }: { title: string; rows?: number }) {
  return <Card><Typography.Title level={5} style={{ marginTop: 0 }}>{title}</Typography.Title>
    <Skeleton active paragraph={{ rows }} title={false} /></Card>;
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
    description={<>{title}<br /><Typography.Text type="secondary">{hint}</Typography.Text></>} /></Card>;
}

export function PhaseAlert({ phase, error, hasSnapshot }: { phase: DashboardPhase; error: string | null; hasSnapshot: boolean }) {
  const meta = PHASE_META[phase] ?? PHASE_META.error;
  if (!['outdated', 'offline', 'error'].includes(phase)) return null;
  const description = error
    ? `${error}。${hasSnapshot ? '显示上次成功读取的快照；在线状态可能已过期。' : '暂无可用快照。'}`
    : hasSnapshot ? '显示上次成功读取的快照；在线状态可能已过期。' : '暂无可用快照。';
  return <Alert role="alert" type={meta.alert} showIcon message={meta.label} description={description} style={{ marginBottom: 16 }} />;
}
