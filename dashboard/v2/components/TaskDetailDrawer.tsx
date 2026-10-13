import { Alert, Descriptions, Drawer, Empty, Grid, Space, Spin, Tag, Timeline, Typography } from 'antd';
import type { TaskDetail } from '../useDashboard.js';
import { GitHubLink } from './GitHubLink.js';
import { AuthorityTag, FixtureTag, ReviewGateTag, StatusTag } from './StatusTag.js';
import { SourceNote } from './SourceNote.js';
import {
  CHECK_LABELS, FRESHNESS_LABELS, OBSERVATION_SOURCE_LABELS, OBSERVATION_STATUS_LABELS, OWNER_SCOPE_LABELS,
  ROLE_LABELS, WATCHER_LABELS, WORKFLOW_LABELS, safeCommitUrl, safeIssueUrl, safePullUrl, shortSha, stamp,
} from '../semantics.js';

/** Read-only detail panel. Every field keeps the provenance delivered by the read contract. */
export function TaskDetailDrawer({ detail, open, onClose }: { detail: TaskDetail; open: boolean; onClose: () => void }) {
  const screens = Grid.useBreakpoint();
  const task = detail.item;
  const items = task ? [
    { key: 'project', label: '项目 / 仓库', children: `${task.project_id} · ${task.repository}` },
    { key: 'workflow', label: '工作流', children: WORKFLOW_LABELS[task.workflow] ?? task.workflow },
    { key: 'state', label: '状态', children: <StatusTag value={task.state} /> },
    { key: 'issue', label: 'GitHub Issue', children: <GitHubLink url={safeIssueUrl(task.repository, task.issue.number)}>#{task.issue.number}{task.issue.title ? ` · ${task.issue.title}` : ''}</GitHubLink> },
    { key: 'pr', label: 'GitHub PR', children: task.pr ? <GitHubLink url={safePullUrl(task.repository, task.pr.number)}>#{task.pr.number}{task.pr.merged_at ? ' · 已合并' : ''}</GitHubLink> : '未关联 PR' },
    { key: 'active', label: '当前执行者', children: task.active_actor ? `${task.active_actor.name}（${ROLE_LABELS[task.active_actor.role] ?? task.active_actor.role}）` : '无 · 未开始' },
    { key: 'waiting', label: '等待责任方', children: task.waiting_for ? `${task.waiting_for.name}（${ROLE_LABELS[task.waiting_for.role] ?? task.waiting_for.role}）` : '无' },
    { key: 'next', label: '下一动作', children: task.next_action },
    { key: 'machine', label: '执行机器', children: task.machine ? `${task.machine.name ?? task.machine.id} · ${task.machine.id} · ${task.machine.platform}` : '未记录' },
    { key: 'head', label: '源码 HEAD', children: <code>{shortSha(task.source_head)}</code> },
    { key: 'github_head', label: 'GitHub HEAD', children: task.github_head
      ? <GitHubLink url={safeCommitUrl(task.repository, task.github_head)}><code>{shortSha(task.github_head)}</code></GitHubLink> : '未核验' },
    { key: 'checks', label: 'GitHub checks', children: `${CHECK_LABELS[task.checks.status] ?? task.checks.status}（${task.checks.count}）` },
    { key: 'stage', label: 'Stage 验证', children: `${CHECK_LABELS[task.stage.status] ?? task.stage.status}${task.stage.head ? ` · ${shortSha(task.stage.head)}` : ''}` },
    { key: 'owner', label: 'Owner 范围', children: `${OWNER_SCOPE_LABELS[task.owner_scope.status] ?? task.owner_scope.status}${task.owner_scope.expires_at ? ` · 过期 ${stamp(task.owner_scope.expires_at)}` : ''}` },
    { key: 'watcher', label: 'Watcher', children: `${WATCHER_LABELS[task.watcher.status] ?? task.watcher.status}${task.watcher.running === null ? '' : task.watcher.running ? ' · 运行中' : ' · 未运行'}` },
    { key: 'runs', label: '关联运行', children: task.run_ids.length ? task.run_ids.join(', ') : '未记录' },
    { key: 'updated', label: '最近更新', children: stamp(task.updated_at) },
  ] : [];

  return <Drawer open={open} onClose={onClose} placement="right" destroyOnHidden
    size={screens.lg ? 760 : 'default'}
    title={task ? <Space wrap size={8}><span>{task.issue.title ?? task.id}</span><StatusTag value={task.state} />{task.fixture && <FixtureTag />}<AuthorityTag /></Space> : '任务详情'}
    styles={{ body: { paddingBottom: 24 } }}>
    {!task ? <Empty description="没有选中的任务" /> : <>
      {detail.error && <Alert role="alert" type="warning" showIcon message={detail.error} style={{ marginBottom: 16 }} />}
      <Spin spinning={detail.loading}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={items} />
          <div>
            <Typography.Title level={5}>Review 与验证</Typography.Title>
            <Space wrap size={[8, 8]}>
              <ReviewGateTag status={task.review_gate.status} source={task.review_gate.source} />
              <Tag style={{ marginInlineEnd: 0 }}>checks：{CHECK_LABELS[task.checks.status] ?? task.checks.status}</Tag>
              <Tag style={{ marginInlineEnd: 0 }}>Stage：{CHECK_LABELS[task.stage.status] ?? task.stage.status}</Tag>
            </Space>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
              {task.review_gate.reason}
            </Typography.Paragraph>
            {task.review && <Typography.Paragraph style={{ marginBottom: 0 }}>
              原生 Review：{task.review.actor} · {task.review.state} · commit {shortSha(task.review.commit_id)}
              {task.review.matches_head ? ' · 与当前 HEAD 一致' : ' · 与当前 HEAD 不一致'}
            </Typography.Paragraph>}
          </div>
          <div>
            <Typography.Title level={5}>阻塞与待处理</Typography.Title>
            {task.blockers.length
              ? <Space direction="vertical" size={4}>{task.blockers.map(blocker => <Alert key={blocker} type="error" showIcon message={blocker} />)}</Space>
              : <Typography.Text type="secondary">当前记录没有阻塞项。</Typography.Text>}
          </div>
          <div>
            <Typography.Title level={5}>观察来源</Typography.Title>
            {task.observations.length
              ? <Timeline items={task.observations.map((observation, index) => ({
                key: index,
                children: <>{OBSERVATION_SOURCE_LABELS[observation.source] ?? observation.source} · {OBSERVATION_STATUS_LABELS[observation.status] ?? observation.status}
                  <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>观察时间 {stamp(observation.observed_at)} · 时效 {FRESHNESS_LABELS[observation.freshness] ?? observation.freshness}{observation.error_code ? ` · ${observation.error_code}` : ''}</Typography.Text></div></>,
              }))} />
              : <Typography.Text type="secondary">未记录观察来源。</Typography.Text>}
          </div>
          <div>
            <Typography.Title level={5}>最近活动</Typography.Title>
            {task.history.length
              ? <Timeline items={task.history.slice(-8).reverse().map((entry, index) => ({
                key: index,
                children: <>{entry.type} · {OBSERVATION_SOURCE_LABELS[entry.source] ?? entry.source}
                  <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    发生 {stamp(entry.occurred_at)} · 观察 {stamp(entry.observed_at)}{entry.head ? ` · ${shortSha(entry.head)}` : ''}{entry.run_id ? ` · ${entry.run_id}` : ''}
                  </Typography.Text></div></>,
              }))} />
              : <Typography.Text type="secondary">当前范围没有已记录的活动。</Typography.Text>}
          </div>
          <SourceNote extra={`最近更新时间 ${stamp(task.updated_at)}`} />
        </Space>
      </Spin>
    </>}
  </Drawer>;
}
