import { Button, Card, Col, Empty, Grid, List, Row, Space, Tag, Typography } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, ProjectOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { PresentedTask as Task } from '../presentation.js';
import type { Snapshot } from '../useDashboard.js';
import { MetricCard } from '../components/MetricCard.js';
import { StatusTag } from '../components/StatusTag.js';
import { EmptyState, LoadingBlock } from '../components/StateViews.js';
import { SourceNote } from '../components/SourceNote.js';
import { nextActionGroups, overviewMetrics, projectRows, sortedByUpdate } from '../selectors.js';
import { isActive, isAwaitingReview, isBlocked, nextOwnerLabel, stamp } from '../semantics.js';

const heading = (value: string) => <Typography.Title level={5} style={{ margin: 0 }}>{value}</Typography.Title>;

function TaskLine({ task, onOpen }: { task: Task; onOpen: (task: Task) => void }) {
  return <List.Item actions={[<Button key="open" type="link" size="small" onClick={() => onOpen(task)}>查看详情</Button>]}>
    <List.Item.Meta
      title={<Space wrap size={8}>
        <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => onOpen(task)}>
          {task.issue.title ?? task.id}
        </Button>
        <StatusTag value={task.state} />
        <Tag style={{ marginInlineEnd: 0 }}>{task.project_id}</Tag>
      </Space>}
      description={<Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>下一责任方：{nextOwnerLabel(task)} · {task.next_action}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          执行者 {task.executor ?? '未记录'} · 机器 {task.machine?.name ?? task.machine?.id ?? '未记录'} · 最近更新 {stamp(task.updated_at)}
        </Typography.Text>
        {task.blockers.map(blocker => <Typography.Text key={blocker} type="danger" style={{ fontSize: 12 }}>阻塞：{blocker}</Typography.Text>)}
      </Space>} />
  </List.Item>;
}

/** Workflow command deck: what is moving, what is waiting for independent review, what is blocked, who acts next. */
export function OverviewPage({ snapshot, tasks, loading, onOpen }: {
  snapshot: Snapshot | null; tasks: Task[]; loading: boolean; onOpen: (task: Task) => void;
}) {
  const screens = Grid.useBreakpoint();
  const span = screens.lg ? 6 : screens.md ? 12 : 24;
  if (loading) return <LoadingBlock title="正在加载活动记录…" rows={6} />;
  if (!snapshot) return <EmptyState title="面板暂不可用" hint="需要受保护的同源查看会话，并启用只读网关。" />;

  const metrics = overviewMetrics(snapshot, tasks);
  const awaiting = sortedByUpdate(tasks.filter(isAwaitingReview));
  const blocked = sortedByUpdate(tasks.filter(isBlocked));
  const developing = sortedByUpdate(tasks.filter(isActive));
  const groups = nextActionGroups(tasks);
  const projects = projectRows(snapshot, tasks);

  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Typography.Text type="secondary">状态未知 / 待核验 {metrics.unknown} 项 · 任务总数 {tasks.length}</Typography.Text>
    <Row gutter={[16, 16]}>
      <Col xs={12} md={8} xl={4}><MetricCard title="项目" value={metrics.projects} note="CP 登记或显式本机观察" icon={<ProjectOutlined />} /></Col>
      <Col xs={12} md={8} xl={4}><MetricCard title="执行器" value={metrics.executors} note="登记执行者数量" /></Col>
      <Col xs={12} md={8} xl={4}><MetricCard title="进行中" value={metrics.developing} note="开发 / 验证 / 合并" icon={<ThunderboltOutlined />} tone="healthy" /></Col>
      <Col xs={12} md={8} xl={4}><MetricCard title="等待独立 Review" value={metrics.awaitingReview} note="当前 HEAD 尚无有效授权决定" icon={<ClockCircleOutlined />} tone="attention" /></Col>
      <Col xs={12} md={8} xl={4}><MetricCard title="阻塞 / 待处理" value={metrics.blocked} note="队列 / 修改 / PASS / 待合并 / 阻塞" icon={<ExclamationCircleOutlined />} tone="blocked" /></Col>
      <Col xs={12} md={8} xl={4}><MetricCard title="已完成" value={metrics.completed} note="GitHub Merge 与 Issue CLOSED 已核实" icon={<CheckCircleOutlined />} tone="healthy" /></Col>
    </Row>

    <Row gutter={[16, 16]}>
      <Col xs={24} xl={12}>
        <Card title={heading('等待独立 Review')} extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{awaiting.length} 项</Typography.Text>}>
          {awaiting.length
            ? <List size="small" dataSource={awaiting.slice(0, 6)} renderItem={task => <TaskLine task={task} onOpen={onOpen} />} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围没有等待独立 Review 的任务。" />}
        </Card>
      </Col>
      <Col xs={24} xl={12}>
        <Card title={heading('阻塞 / 待处理')} extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{blocked.length} 项</Typography.Text>}>
          {blocked.length
            ? <List size="small" dataSource={blocked.slice(0, 6)} renderItem={task => <TaskLine task={task} onOpen={onOpen} />} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围没有阻塞任务。" />}
        </Card>
      </Col>
    </Row>

    <Row gutter={[16, 16]}>
      <Col xs={24} xl={14}>
        <Card title={heading('进行中的开发')} extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{developing.length} 项</Typography.Text>}>
          {developing.length
            ? <List size="small" dataSource={developing.slice(0, 6)} renderItem={task => <TaskLine task={task} onOpen={onOpen} />} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围没有进行中的开发任务。" />}
        </Card>
      </Col>
      <Col xs={24} xl={10}>
        <Card title={heading('下一责任方与下一动作')}>
          {groups.length
            ? <List size="small" dataSource={groups} renderItem={group => <List.Item>
              <List.Item.Meta title={group.label}
                description={<Space direction="vertical" size={2}>
                  {group.actions.slice(0, 3).map(action => <Typography.Text key={action} type="secondary" style={{ fontSize: 12 }}>{action}</Typography.Text>)}
                </Space>} />
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>{group.count} 项</Tag>
            </List.Item>} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围内没有等待责任方的任务。" />}
        </Card>
      </Col>
    </Row>

    <Card title={heading('项目与执行者概况')} size="small">
      <Row gutter={[12, 12]}>
        {projects.length ? projects.map(project => <Col key={project.id} xs={24} md={12} xl={8}>
          <Card size="small" styles={{ body: { padding: 12 } }}>
            <Typography.Text strong>{project.id}</Typography.Text>
            <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{project.repository}</Typography.Text></div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {project.provenance === 'local_fast_observation' ? 'Local Fast 只读观察 · 尚未登记为 CP 项目' : '已保存的注册信息'}
              {' · 配置档 '}{project.profile_ref}{' · 上次快照活动运行 '}{project.active_runs}
            </Typography.Text>
          </Card>
        </Col>) : <Col span={span}><Typography.Text type="secondary">当前范围没有项目记录。</Typography.Text></Col>}
      </Row>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        执行者 {metrics.executors} 个 · 上次快照活动运行 {metrics.activeRuns} 个 · 在线状态来自服务端记录的注册或心跳，不是 GitHub 授权核验结果。
      </Typography.Paragraph>
    </Card>
    <SourceNote />
  </Space>;
}
