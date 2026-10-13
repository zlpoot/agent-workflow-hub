import { Badge, Button, Card, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { PHASE_META, stamp } from '../semantics.js';
import type { DashboardPhase } from '../semantics.js';
import { githubObservation } from '../selectors.js';
import type { Task } from '../../../src/dashboard/tasks.js';

/** Connection state, data freshness and source of truth in one persistent strip. */
export function ConnectionBar({ phase, lastRefresh, cursor, tasks, fixture, refreshing, onRefresh }: {
  phase: DashboardPhase; lastRefresh: number | null; cursor: number | null; tasks: Task[];
  fixture: boolean; refreshing: boolean; onRefresh: () => void;
}) {
  const meta = PHASE_META[phase] ?? PHASE_META.error;
  const github = githubObservation(tasks);
  return <Card size="small" styles={{ body: { padding: 14 } }} style={{ marginBottom: 16 }}>
    <Space wrap size={[12, 8]} style={{ width: '100%' }}>
      <Badge status={phase === 'live' ? 'success' : phase === 'partial' ? 'warning' : ['offline', 'error', 'outdated'].includes(phase) ? 'error' : 'processing'} text={meta.label} />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        最近成功刷新：{stamp(lastRefresh)} · 快照游标 {cursor ?? '—'}
      </Typography.Text>
      <Tag color="default" style={{ marginInlineEnd: 0 }}>GitHub 观察：{github.label}</Tag>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        GitHub 最近实际成功：{stamp(github.lastSuccess)}{github.retryAt ? ` · 下次允许查询：${stamp(github.retryAt)}` : ''}
      </Typography.Text>
      {fixture && <Tag color="gold" style={{ marginInlineEnd: 0 }}>示例预览 · 模拟数据</Tag>}
      <Button size="small" aria-label="刷新" title="刷新" icon={<ReloadOutlined />} onClick={onRefresh}
        disabled={phase === 'loading' || refreshing}>刷新</Button>
    </Space>
    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
      本机注册与事件存储每 10 秒观察一次，CP 事件经 SSE 增量接收；注册与心跳不代表 GitHub 授权核验，断线或过期不显示为在线。
    </Typography.Paragraph>
  </Card>;
}
