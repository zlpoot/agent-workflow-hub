import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge, Button, Card, Dialog, Flex, Heading, Select, Table, Tabs, Text, TextField, Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import './style.css';
import { DashboardReader, safeGitHubUrl, safeSourceUrl } from './adapter.mjs';
import { text, errorText, searchText } from './zh-CN.mjs';
import { Wizard } from './wizard.js';

type Ref = { provider: string; repository: string; kind: string; number: number; authority_verified: false };
type Step = { id: string; name: string | null };
type Run = { id: string; project_id: string; state: string; executor_id: string; machine_id: string;
  work_item: { id: string; reference: Ref } | null; source: { sha: string; ref: string; repository: string };
  profile: { ref: string; version: string }; current_step: Step | null; last_step: Step | null;
  created_at: string; updated_at: string; finished_at: string | null; github_refs: Ref[] };
type Project = { id: string; name: string | null; repository: string; profile_ref: string; enabled: boolean | null;
  last_activity: string | null; active_runs: Run[]; metadata_provenance: string };
type Executor = { id: string; display_name: string; type: string | null; machine: { id: string; name: string | null; arch: string | null };
  platform: string; last_seen: string; status: string; observed_at: string; presence_provenance: string; current_runs: { id: string }[] };
type Event = { cursor: number; event_id: string; run_id: string; project_id: string; executor_id: string; machine_id: string;
  type: string; step_id: string | null; source_sha: string; result: string; timestamp: string; provenance: string; github_refs: Ref[] };
type State = { snapshot: { cursor: number; projects: Project[]; runs: Run[]; executors: Executor[] } | null;
  events: Event[]; phase: string; lastRefresh: number | null; error: string | null };
type Comparison = { status: string; provenance: string; action_hint: string; observed: unknown; expected: unknown };
type Diagnostics = Record<string, Comparison | string | number | null>;
const views = ['Overview', 'Projects', 'Executors', 'Runs', 'Timeline', 'Wizard'];
const labels: Record<string, string> = { loading: '加载中', refreshing: '刷新中', connecting: '连接实时更新中', live: '已连接', partial: '部分数据 · 同步中',
  offline: '离线 · 显示上次快照', outdated: '数据已过期 · 显示上次快照', error: '暂不可用' };
const color = (status: string): 'teal' | 'red' | 'amber' | 'gray' =>
  ['online', 'completed', 'passed', 'live'].includes(status) ? 'teal' : ['failed', 'blocked', 'offline', 'error'].includes(status) ? 'red' :
    ['running', 'partial', 'refreshing', 'outdated', 'verifying'].includes(status) ? 'amber' : 'gray';
const known = (value: unknown) => value === null || value === undefined ? '未提供' : typeof value === 'boolean' ? value ? '已启用' : '未启用' : String(value);
const stamp = (value: string | number | null) => value === null ? '未知' : new Date(value).toLocaleString('zh-CN', { hour12: false });
const short = (sha: string) => sha.slice(0, 10);
function Status({ value }: { value: string }) { return <Badge color={color(value)} variant="soft">{text(value)}</Badge>; }
function External({ url, children }: { url: string | null; children: React.ReactNode }) {
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}<span aria-hidden="true"> ↗</span></a> : <span>{children}</span>;
}
function Issue({ run }: { run: Run }) { return run.work_item ? <External url={safeGitHubUrl(run.work_item.reference)}>#{run.work_item.reference.number}</External> : <>未知</>; }
function Fact({ label, value }: { label: string; value: React.ReactNode }) { return <div className="fact"><Text as="div" size="2" color="gray">{label}</Text><div>{value}</div></div>; }
function Empty({ children }: { children: React.ReactNode }) { return <Card className="empty"><Heading size="4">没有匹配的记录</Heading><Text color="gray">{children}</Text></Card>; }
function App() {
  const [view, setView] = useState('Overview'), [search, setSearch] = useState(''), [project, setProject] = useState('all'), [status, setStatus] = useState('all');
  const [state, setState] = useState<State>({ snapshot: null, events: [], phase: 'loading', lastRefresh: null, error: null });
  const reader = useRef<DashboardReader | null>(null);
  const [selection, setSelection] = useState<{ kind: string; item: Project | Executor | Run } | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null), [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => { const client = reader.current = new DashboardReader({ publish: setState }); void client.refresh(); return () => client.stop(); }, []);
  useEffect(() => {
    setDiagnostics(null); setDetailError(null);
    if (selection?.kind !== 'Run') return;
    const abort = new AbortController();
    reader.current?.get('/runs/' + encodeURIComponent(selection.item.id), 'RunResponse', abort.signal)
      .then((response: { item: { diagnostics: Diagnostics } }) => { if (!abort.signal.aborted) setDiagnostics(response.item.diagnostics); })
      .catch((error: Error) => { if (!abort.signal.aborted) setDetailError(error.message); });
    return () => abort.abort();
  }, [selection]);
  const snapshot = state.snapshot, projects = snapshot?.projects ?? [], runs = snapshot?.runs ?? [], executors = snapshot?.executors ?? [];
  const matching = (value: unknown) => searchText(value).toLowerCase().includes(search.toLowerCase());
  const scopedRuns = runs.filter(run => (project === 'all' || run.project_id === project) && (status === 'all' || run.state === status) && matching(run));
  const scopedEvents = state.events.filter(event => (project === 'all' || event.project_id === project) && matching(event));
  const runTable = (items: Run[]) => !items.length ? <Empty>当前视图没有运行记录。请清除筛选条件，或等待新的运行记录。</Empty> : <div className="table-wrap"><Table.Root variant="surface">
    <Table.Header><Table.Row>{['运行记录 / 工作项', '项目', '状态', '执行器 / 机器', '源码', '当前 / 最近步骤'].map(label => <Table.ColumnHeaderCell key={label}>{label}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header>
    <Table.Body>{items.map(run => <Table.Row key={run.id}><Table.RowHeaderCell><button className="record" onClick={() => setSelection({ kind: 'Run', item: run })}>{run.id}</button><div className="secondary"><Issue run={run} /> · {stamp(run.updated_at)}</div></Table.RowHeaderCell>
      <Table.Cell>{run.project_id}</Table.Cell><Table.Cell><Status value={run.state} /></Table.Cell><Table.Cell>{run.executor_id}<div className="secondary mono">{run.machine_id}</div></Table.Cell>
      <Table.Cell><External url={safeSourceUrl(run.source)}><code>{short(run.source.sha)}</code></External><div className="secondary">{run.source.ref}</div></Table.Cell>
      <Table.Cell>{run.current_step?.name ?? run.current_step?.id ?? '—'}<div className="secondary">最近：{run.last_step?.name ?? run.last_step?.id ?? '未知'}</div></Table.Cell></Table.Row>)}</Table.Body></Table.Root></div>;
  const eventTable = (items: Event[]) => !items.length ? <Empty>当前查看范围内没有已保存的事件。</Empty> : <div className="table-wrap"><Table.Root variant="surface"><Table.Header><Table.Row>
    {['游标 / 时间', '事件 / 步骤', '运行记录 / 项目', '执行器 / 机器', '结果', '源码 / 引用'].map(label => <Table.ColumnHeaderCell key={label}>{label}</Table.ColumnHeaderCell>)}
    </Table.Row></Table.Header><Table.Body>{items.map(event => <Table.Row key={event.cursor}>
      <Table.RowHeaderCell><code>#{event.cursor}</code><div className="secondary">{stamp(event.timestamp)}</div></Table.RowHeaderCell>
      <Table.Cell>{text(event.type)}<div className="secondary">{known(event.step_id)}</div></Table.Cell><Table.Cell>{event.run_id}<div className="secondary">{event.project_id}</div></Table.Cell>
      <Table.Cell>{event.executor_id}<div className="secondary mono">{event.machine_id}</div><div className="secondary">操作人：未知 · 未记录</div></Table.Cell>
      <Table.Cell><Status value={event.result} /></Table.Cell><Table.Cell><code>{short(event.source_sha)}</code>{event.github_refs.map(ref => <div key={ref.kind + ref.repository + ref.number}><External url={safeGitHubUrl(ref)}>{text(ref.kind)} #{ref.number}</External></div>)}
      <div className="secondary">运行时声明 · GitHub 授权未核验</div></Table.Cell></Table.Row>)}</Table.Body></Table.Root></div>;
  const fixture = document.querySelector('meta[name="awh-dataset"]')?.getAttribute('content') === 'fixture';
  return <Theme accentColor="teal" grayColor="slate" radius="medium" scaling="100%"><Tabs.Root value={view} onValueChange={value => { setView(value); setSearch(''); setStatus('all'); }} orientation="vertical" className="shell">
    <aside className="sidebar"><div className="brand"><span className="brandmark">A</span><div><strong>AWH</strong><div className="secondary">工作流中心</div></div></div>
      <Text size="1" color="gray" className="nav-label">工作区</Text><Tabs.List className="nav" aria-label="面板导航">{views.map((name, i) => <Tabs.Trigger key={name} value={name}><span className="nav-symbol" aria-hidden="true">{['◫', '▣', '◇', '▷', '≡', '+'][i]}</span>{text(name)}</Tabs.Trigger>)}</Tabs.List>
      <div className="sidebar-bottom"><Badge variant="outline">只读</Badge><p>运行时记录，保留原始数据来源。</p><Text size="1" color="gray">GitHub 授权未核验</Text></div></aside>
    <main><header className="topbar"><Text size="2" color="gray">工作区 <span aria-hidden="true">/</span> <strong>{text(view)}</strong></Text><Flex gap="3" align="center" wrap="wrap"><Status value={state.phase} /><Button variant="soft" size="2" onClick={() => void reader.current?.refresh()} disabled={state.phase === 'loading' || state.phase === 'refreshing'}>刷新</Button><Button size="2" onClick={() => setView('Wizard')}>添加项目向导</Button></Flex></header>
      <div className="content"><div className="page-title"><div><Text className="eyebrow" size="1">智能体工作流中心</Text><Heading size="7">{text(view)}</Heading><Text color="gray">{view === 'Overview' ? '集中查看各项目与机器上已记录的工作。' : view === 'Timeline' ? '按全局游标顺序查看当前范围内已保存的事件。' : '查看当前范围内已记录的身份信息和活动。'}</Text></div>{fixture && <Badge color="amber">示例预览 · 模拟数据</Badge>}</div>
      <div className="freshness"><Text size="2">{labels[state.phase]} · 最近成功刷新：{state.lastRefresh === null ? '暂无' : stamp(state.lastRefresh)}</Text><Text size="1" color="gray">快照游标 {snapshot?.cursor ?? '—'} · 注册信息与事件存储 · GitHub 授权未核验</Text></div>
      {state.error && <div className="notice" role="alert">{errorText(state.error)}。{snapshot ? '显示上次成功读取的快照；在线状态可能已过期。' : '暂无可用快照。'}</div>}
      {view === 'Wizard' ? <Tabs.Content value="Wizard"><Wizard state={state} fixture={fixture}
        onNavigate={(destination, id) => { setProject(id); setSearch(''); setStatus('all'); setView(destination); }}
        onProject={id => { const item = projects.find(p => p.id === id); if (item) setSelection({ kind: 'Project', item }); }} /></Tabs.Content> : !snapshot ? <Card className="empty"><Heading size="4">{state.phase === 'loading' ? '正在加载活动记录…' : '面板暂不可用'}</Heading><Text color="gray">{state.phase === 'loading' ? '正在读取一致的快照与已保存的时间线。' : '需要受保护的同源查看会话，并启用只读网关。'}</Text></Card> : <>
      {view !== 'Overview' && <Flex gap="3" wrap="wrap" className="filters"><TextField.Root aria-label={`搜索${text(view)}`} placeholder={`搜索${text(view)}…`} value={search} onChange={event => setSearch(event.target.value)} className="search" />
        <Select.Root value={project} onValueChange={setProject}><Select.Trigger aria-label="按项目筛选" /><Select.Content><Select.Item value="all">全部项目</Select.Item>{projects.map(item => <Select.Item key={item.id} value={item.id}>{item.id}</Select.Item>)}</Select.Content></Select.Root>
        {view === 'Runs' && <Select.Root value={status} onValueChange={setStatus}><Select.Trigger aria-label="按运行状态筛选" /><Select.Content><Select.Item value="all">全部状态</Select.Item>{[...new Set(runs.map(run => run.state))].sort().map(value => <Select.Item key={value} value={value}>{text(value)}</Select.Item>)}</Select.Content></Select.Root>}</Flex>}
      <Tabs.Content value="Overview"><div className="metrics">{[['项目', projects.length, '已保存的注册身份'], ['执行器', executors.length, '关联当前范围内的运行记录'], ['活动运行', runs.filter(run => !['completed', 'failed'].includes(run.state)).length, '依据运行时记录的状态'], ['已记录事件', state.events.length, '截至当前快照游标']].map(([label, count, note]) => <Card key={label}><Text color="gray" size="2">{label}</Text><Heading size="8" className="metric-number">{count}</Heading><Text size="1" color="gray">{note}</Text></Card>)}</div>
        <div className="section-heading"><Heading size="4">最近运行</Heading><Button variant="ghost" onClick={() => setView('Runs')}>查看全部运行 →</Button></div>{runTable([...runs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5))}
        <div className="section-heading"><Heading size="4">最新活动</Heading><Button variant="ghost" onClick={() => setView('Timeline')}>查看时间线 →</Button></div>{eventTable(state.events.slice(-5))}</Tabs.Content>
      <Tabs.Content value="Projects">{!projects.filter(item => (project === 'all' || item.id === project) && matching(item)).length ? <Empty>当前视图没有项目。</Empty> : <div className="project-grid">{projects.filter(item => (project === 'all' || item.id === project) && matching(item)).map(item => <Card key={item.id}><Flex justify="between" align="start"><Heading size="4"><button className="record" onClick={() => setSelection({ kind: 'Project', item })}>{item.id}</button></Heading><Badge color="gray">启用状态：{known(item.enabled)}</Badge></Flex><p>{item.repository}</p><div className="secondary">配置档引用：{item.profile_ref}</div><div className="project-bottom"><strong>{item.active_runs.length} 个活动运行</strong><Text size="1" color="gray">{stamp(item.last_activity)}</Text></div><Text size="1" color="gray">已保存的注册信息 · 名称：{known(item.name)}</Text></Card>)}</div>}</Tabs.Content>
      <Tabs.Content value="Executors">{!executors.filter(item => matching(item) && (project === 'all' || runs.some(run => run.executor_id === item.id && run.project_id === project))).length ? <Empty>没有执行器关联当前范围内的运行记录。</Empty> : <div className="table-wrap"><Table.Root variant="surface"><Table.Header><Table.Row>{['执行器', '机器', '平台 / 类型', '在线状态', '最近服务端联系', '当前运行'].map(label => <Table.ColumnHeaderCell key={label}>{label}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header><Table.Body>{executors.filter(item => matching(item) && (project === 'all' || runs.some(run => run.executor_id === item.id && run.project_id === project))).map(item => <Table.Row key={item.id}><Table.RowHeaderCell><button className="record" onClick={() => setSelection({ kind: 'Executor', item })}>{item.display_name}</button><div className="secondary">{item.id}</div></Table.RowHeaderCell><Table.Cell>{known(item.machine.name)}<div className="secondary mono">{item.machine.id}</div></Table.Cell><Table.Cell>{item.platform}<div className="secondary">{known(item.type)} / {known(item.machine.arch)}</div></Table.Cell><Table.Cell><Status value={['offline', 'outdated'].includes(state.phase) ? 'unknown' : item.status} /></Table.Cell><Table.Cell>{stamp(item.last_seen)}<div className="secondary">注册或心跳</div></Table.Cell><Table.Cell>{item.current_runs.length}</Table.Cell></Table.Row>)}</Table.Body></Table.Root></div>}</Tabs.Content>
      <Tabs.Content value="Runs">{runTable(scopedRuns)}</Tabs.Content><Tabs.Content value="Timeline">{eventTable(scopedEvents)}</Tabs.Content>
      </>}
      <footer>只读查看 · 运行时声明不代表独立审查或 GitHub 批准。</footer></div></main>
    </Tabs.Root>
    <Dialog.Root open={selection !== null} onOpenChange={open => { if (!open) setSelection(null); }}><Dialog.Content maxWidth="780px"><Flex justify="between" align="start" gap="3"><Dialog.Title>{selection ? text(selection.kind) : ''}：{selection?.item.id}</Dialog.Title><Dialog.Close><Button variant="soft">关闭详情</Button></Dialog.Close></Flex><Dialog.Description>当前查看范围内已记录的事实。GitHub 授权状态未核验。</Dialog.Description>
      {selection && <div className="detail-facts">{selection.kind === 'Project' ? (() => { const item = selection.item as Project; return <><Fact label="仓库" value={item.repository} /><Fact label="配置档" value={item.profile_ref} /><Fact label="启用状态" value={known(item.enabled)} /><Fact label="最近活动" value={stamp(item.last_activity)} /><Fact label="数据来源" value={text(item.metadata_provenance)} />{runTable(item.active_runs)}</>; })() : selection.kind === 'Executor' ? (() => { const item = selection.item as Executor; return <><Fact label="机器标识" value={<code>{item.machine.id}</code>} /><Fact label="平台 / 类型" value={`${item.platform} / ${known(item.type)}`} /><Fact label="最近服务端联系" value={stamp(item.last_seen)} /><Fact label="在线状态" value={<Status value={['offline', 'outdated'].includes(state.phase) ? 'unknown' : item.status} />} /><Fact label="数据来源" value={text(item.presence_provenance)} /></>; })() : (() => { const item = selection.item as Run; return <><Fact label="工作项" value={<Issue run={item} />} /><Fact label="状态" value={<Status value={item.state} />} /><Fact label="源码 SHA / 引用" value={<><External url={safeSourceUrl(item.source)}><code>{item.source.sha}</code></External><p>{item.source.ref}</p></>} /><Fact label="配置档" value={`${item.profile.ref} @ ${item.profile.version}`} /><Fact label="执行器 / 机器" value={`${item.executor_id} / ${item.machine_id}`} /><Heading size="4" mt="4">策略诊断</Heading>{detailError ? <div role="alert">{errorText(detailError)}</div> : !diagnostics ? <Text color="gray">正在加载诊断…</Text> : <>{Object.entries(diagnostics).filter(([, value]) => value !== null && typeof value === 'object').map(([key, value]) => { const diagnostic = value as Comparison; return <div className="diagnostic" key={key}><Flex justify="between"><strong>{text(key)}</strong><Status value={diagnostic.status} /></Flex><div className="secondary">{text(diagnostic.provenance)}</div><p>{text(diagnostic.action_hint)}</p><Text size="1">实际记录：{JSON.stringify(diagnostic.observed)} · 策略预期：{JSON.stringify(diagnostic.expected)}</Text></div>; })}<Fact label="验证对象 SHA" value={known(diagnostics.verification_subject_sha)} /></>}<Heading size="4" mt="4">运行时间线</Heading>{eventTable(state.events.filter(event => event.run_id === item.id))}</>; })()}</div>}
      </Dialog.Content></Dialog.Root>
  </Theme>;
}
createRoot(document.getElementById('root')!).render(<App />);
