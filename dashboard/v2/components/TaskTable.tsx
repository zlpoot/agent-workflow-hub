import { Button, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import type { Task } from '../../../src/dashboard/tasks.js';
import { GitHubLink } from './GitHubLink.js';
import { FixtureTag, StatusTag } from './StatusTag.js';
import { EmptyState } from './StateViews.js';
import { nextOwnerLabel, safeIssueUrl, safePullUrl, shortSha, stamp } from '../semantics.js';

/** The one task list renderer used by Tasks and by the Overview drill-down. */
export function TaskTable({ tasks, loading, onOpen, compact }: {
  tasks: Task[]; loading: boolean; onOpen: (task: Task) => void; compact?: boolean;
}) {
  const columns: TableProps<Task>['columns'] = [
    {
      title: '任务 / 工作项', dataIndex: 'id', key: 'id', width: 260, fixed: 'left',
      render: (_value, task) => <>
        <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => onOpen(task)}>
          {task.issue.title ?? task.id}
        </Button>
        <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>#{task.issue.number} · {task.id}</Typography.Text></div>
        <div>{task.fixture ? <FixtureTag /> : null}</div>
      </>,
    },
    {
      title: '项目 / 仓库', key: 'project', width: 170,
      render: (_value, task) => <>
        <div>{task.project_id}</div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{task.repository}</Typography.Text>
      </>,
    },
    { title: '状态', key: 'state', width: 140, render: (_value, task) => <StatusTag value={task.state} note={task.next_action} /> },
    {
      title: '当前执行者', key: 'active', width: 150,
      render: (_value, task) => task.active_actor
        ? <>{task.active_actor.name}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{task.executor ?? '—'}</Typography.Text></div></>
        : <Typography.Text type="secondary">无 · 未开始</Typography.Text>,
    },
    {
      title: '下一责任方 / 动作', key: 'next', width: 220,
      render: (_value, task) => <>
        <div>{nextOwnerLabel(task)}</div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{task.next_action}</Typography.Text>
      </>,
    },
    {
      title: '执行机器', key: 'machine', width: 160,
      render: (_value, task) => task.machine
        ? <>{task.machine.name ?? task.machine.id}
          <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{task.machine.id} · {task.machine.platform}</Typography.Text></div></>
        : <Typography.Text type="secondary">未记录</Typography.Text>,
    },
    {
      title: 'GitHub', key: 'github', width: 150,
      render: (_value, task) => <>
        <div><GitHubLink url={safeIssueUrl(task.repository, task.issue.number)}>Issue #{task.issue.number}</GitHubLink></div>
        {task.pr && <div><GitHubLink url={safePullUrl(task.repository, task.pr.number)}>PR #{task.pr.number}</GitHubLink></div>}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>HEAD {shortSha(task.source_head)}</Typography.Text>
      </>,
    },
    { title: '最近更新', key: 'updated', width: 160, render: (_value, task) => stamp(task.updated_at) },
  ];

  return <Table<Task> rowKey="id" columns={columns} dataSource={tasks} loading={loading} size={compact ? 'small' : 'medium'}
    scroll={{ x: 1180 }} pagination={tasks.length > 10 ? { pageSize: 10, size: 'small', showSizeChanger: false } : false}
    locale={{ emptyText: <EmptyState title="当前筛选条件下没有任务" hint="清除筛选或搜索条件，或等待新的任务记录。" /> }} />;
}
