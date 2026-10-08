import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge, Button, Card, Dialog, Flex, Heading, Select, Table, Tabs, Text, TextField, Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import './style.css';
import { DashboardReader, safeGitHubUrl, safeSourceUrl } from './adapter.mjs';

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
const views = ['Overview', 'Projects', 'Executors', 'Runs', 'Timeline'];
const labels: Record<string, string> = { loading: 'Loading', refreshing: 'Refreshing', connecting: 'Connecting live stream', live: 'Connected', partial: 'Partial · syncing',
  offline: 'Offline · last snapshot', outdated: 'Outdated · last snapshot', error: 'Unavailable' };
const color = (status: string): 'teal' | 'red' | 'amber' | 'gray' =>
  ['online', 'completed', 'passed', 'live'].includes(status) ? 'teal' : ['failed', 'blocked', 'offline', 'error'].includes(status) ? 'red' :
    ['running', 'partial', 'refreshing', 'outdated', 'verifying'].includes(status) ? 'amber' : 'gray';
const known = (value: unknown) => value === null || value === undefined ? 'Unknown' : String(value);
const stamp = (value: string | number | null) => value === null ? 'Unknown' : new Date(value).toLocaleString(undefined, { hour12: false });
const short = (sha: string) => sha.slice(0, 10);
function Status({ value }: { value: string }) { return <Badge color={color(value)} variant="soft">{value.replaceAll('_', ' ')}</Badge>; }
function External({ url, children }: { url: string | null; children: React.ReactNode }) {
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}<span aria-hidden="true"> ↗</span></a> : <span>{children}</span>;
}
function Issue({ run }: { run: Run }) { return run.work_item ? <External url={safeGitHubUrl(run.work_item.reference)}>#{run.work_item.reference.number}</External> : <>Unknown</>; }
function Fact({ label, value }: { label: string; value: React.ReactNode }) { return <div className="fact"><Text as="div" size="2" color="gray">{label}</Text><div>{value}</div></div>; }
function Empty({ children }: { children: React.ReactNode }) { return <Card className="empty"><Heading size="4">No matching records</Heading><Text color="gray">{children}</Text></Card>; }
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
  const matching = (value: unknown) => JSON.stringify(value).toLowerCase().includes(search.toLowerCase());
  const scopedRuns = runs.filter(run => (project === 'all' || run.project_id === project) && (status === 'all' || run.state === status) && matching(run));
  const scopedEvents = state.events.filter(event => (project === 'all' || event.project_id === project) && matching(event));
  const runTable = (items: Run[]) => !items.length ? <Empty>No Runs in this view. Clear filters or wait for a recorded Run.</Empty> : <div className="table-wrap"><Table.Root variant="surface">
    <Table.Header><Table.Row>{['Run / work item', 'Project', 'State', 'Executor / machine', 'Source', 'Current / last step'].map(label => <Table.ColumnHeaderCell key={label}>{label}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header>
    <Table.Body>{items.map(run => <Table.Row key={run.id}><Table.RowHeaderCell><button className="record" onClick={() => setSelection({ kind: 'Run', item: run })}>{run.id}</button><div className="secondary"><Issue run={run} /> · {stamp(run.updated_at)}</div></Table.RowHeaderCell>
      <Table.Cell>{run.project_id}</Table.Cell><Table.Cell><Status value={run.state} /></Table.Cell><Table.Cell>{run.executor_id}<div className="secondary mono">{run.machine_id}</div></Table.Cell>
      <Table.Cell><External url={safeSourceUrl(run.source)}><code>{short(run.source.sha)}</code></External><div className="secondary">{run.source.ref}</div></Table.Cell>
      <Table.Cell>{run.current_step?.name ?? run.current_step?.id ?? '—'}<div className="secondary">Last: {run.last_step?.name ?? run.last_step?.id ?? 'Unknown'}</div></Table.Cell></Table.Row>)}</Table.Body></Table.Root></div>;
  const eventTable = (items: Event[]) => !items.length ? <Empty>No persisted Events in this scope.</Empty> : <div className="table-wrap"><Table.Root variant="surface"><Table.Header><Table.Row>
    {['Cursor / time', 'Event / step', 'Run / project', 'Executor / machine', 'Result', 'Source / references'].map(label => <Table.ColumnHeaderCell key={label}>{label}</Table.ColumnHeaderCell>)}
    </Table.Row></Table.Header><Table.Body>{items.map(event => <Table.Row key={event.cursor}>
      <Table.RowHeaderCell><code>#{event.cursor}</code><div className="secondary">{stamp(event.timestamp)}</div></Table.RowHeaderCell>
      <Table.Cell>{event.type}<div className="secondary">{known(event.step_id)}</div></Table.Cell><Table.Cell>{event.run_id}<div className="secondary">{event.project_id}</div></Table.Cell>
      <Table.Cell>{event.executor_id}<div className="secondary mono">{event.machine_id}</div><div className="secondary">Actor: Unknown · not recorded</div></Table.Cell>
      <Table.Cell><Status value={event.result} /></Table.Cell><Table.Cell><code>{short(event.source_sha)}</code>{event.github_refs.map(ref => <div key={ref.kind + ref.repository + ref.number}><External url={safeGitHubUrl(ref)}>{ref.kind} #{ref.number}</External></div>)}
      <div className="secondary">Runtime declaration · authority unverified</div></Table.Cell></Table.Row>)}</Table.Body></Table.Root></div>;
  const fixture = document.querySelector('meta[name="awh-dataset"]')?.getAttribute('content') === 'fixture';
  return <Theme accentColor="teal" grayColor="slate" radius="medium" scaling="100%"><Tabs.Root value={view} onValueChange={value => { setView(value); setSearch(''); setStatus('all'); }} orientation="vertical" className="shell">
    <aside className="sidebar"><div className="brand"><span className="brandmark">A</span><div><strong>AWH</strong><div className="secondary">Workflow Hub</div></div></div>
      <Text size="1" color="gray" className="nav-label">WORKSPACE</Text><Tabs.List className="nav" aria-label="Dashboard views">{views.map((name, i) => <Tabs.Trigger key={name} value={name}><span className="nav-symbol" aria-hidden="true">{['◫', '▣', '◇', '▷', '≡'][i]}</span>{name}</Tabs.Trigger>)}</Tabs.List>
      <div className="sidebar-bottom"><Badge variant="outline">Read-only</Badge><p>Runtime facts, with their original provenance.</p><Text size="1" color="gray">GitHub authority unverified</Text></div></aside>
    <main><header className="topbar"><Text size="2" color="gray">Workspace <span aria-hidden="true">/</span> <strong>{view}</strong></Text><Flex gap="3" align="center"><Status value={state.phase} /><Button variant="soft" size="2" onClick={() => void reader.current?.refresh()} disabled={state.phase === 'loading' || state.phase === 'refreshing'}>Refresh</Button></Flex></header>
      <div className="content"><div className="page-title"><div><Text className="eyebrow" size="1">AGENT WORKFLOW HUB</Text><Heading size="7">{view}</Heading><Text color="gray">{view === 'Overview' ? 'A shared view of recorded work across projects and machines.' : view === 'Timeline' ? 'Persisted Events in global cursor order, across your viewer scope.' : 'Inspect recorded identities and activity in your viewer scope.'}</Text></div>{fixture && <Badge color="amber">Fixture preview · synthetic data</Badge>}</div>
      <div className="freshness"><Text size="2">{labels[state.phase]} · Last successful refresh: {state.lastRefresh === null ? 'None' : stamp(state.lastRefresh)}</Text><Text size="1" color="gray">Snapshot cursor {snapshot?.cursor ?? '—'} · Registry + Event Store · authority_verified=false</Text></div>
      {state.error && <div className="notice" role="alert">{state.error}. {snapshot ? 'Showing the last successful snapshot; presence may be stale.' : 'No snapshot is available.'}</div>}
      {!snapshot ? <Card className="empty"><Heading size="4">{state.phase === 'loading' ? 'Loading recorded activity…' : 'Dashboard unavailable'}</Heading><Text color="gray">{state.phase === 'loading' ? 'Fetching a consistent snapshot and persisted timeline.' : 'A protected same-origin viewer session and enabled read gateway are required.'}</Text></Card> : <>
      {view !== 'Overview' && <Flex gap="3" wrap="wrap" className="filters"><TextField.Root aria-label={`Search ${view}`} placeholder={`Search ${view.toLowerCase()}…`} value={search} onChange={event => setSearch(event.target.value)} className="search" />
        <Select.Root value={project} onValueChange={setProject}><Select.Trigger aria-label="Filter by project" /><Select.Content><Select.Item value="all">All projects</Select.Item>{projects.map(item => <Select.Item key={item.id} value={item.id}>{item.id}</Select.Item>)}</Select.Content></Select.Root>
        {view === 'Runs' && <Select.Root value={status} onValueChange={setStatus}><Select.Trigger aria-label="Filter by Run state" /><Select.Content><Select.Item value="all">All states</Select.Item>{[...new Set(runs.map(run => run.state))].sort().map(value => <Select.Item key={value} value={value}>{value}</Select.Item>)}</Select.Content></Select.Root>}</Flex>}
      <Tabs.Content value="Overview"><div className="metrics">{[['Projects', projects.length, 'Stored Registry identities'], ['Executors', executors.length, 'Linked to scoped Runs'], ['Active Runs', runs.filter(run => !['completed', 'failed'].includes(run.state)).length, 'Runtime projected states'], ['Recorded Events', state.events.length, 'Through snapshot watermark']].map(([label, count, note]) => <Card key={label}><Text color="gray" size="2">{label}</Text><Heading size="8" className="metric-number">{count}</Heading><Text size="1" color="gray">{note}</Text></Card>)}</div>
        <div className="section-heading"><Heading size="4">Recent Runs</Heading><Button variant="ghost" onClick={() => setView('Runs')}>View all Runs →</Button></div>{runTable([...runs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5))}
        <div className="section-heading"><Heading size="4">Latest activity</Heading><Button variant="ghost" onClick={() => setView('Timeline')}>Open Timeline →</Button></div>{eventTable(state.events.slice(-5))}</Tabs.Content>
      <Tabs.Content value="Projects">{!projects.filter(item => (project === 'all' || item.id === project) && matching(item)).length ? <Empty>No Projects in this view.</Empty> : <div className="project-grid">{projects.filter(item => (project === 'all' || item.id === project) && matching(item)).map(item => <Card key={item.id}><Flex justify="between" align="start"><Heading size="4"><button className="record" onClick={() => setSelection({ kind: 'Project', item })}>{item.id}</button></Heading><Badge color="gray">Enabled: {known(item.enabled)}</Badge></Flex><p>{item.repository}</p><div className="secondary">Profile: {item.profile_ref}</div><div className="project-bottom"><strong>{item.active_runs.length} active Runs</strong><Text size="1" color="gray">{stamp(item.last_activity)}</Text></div><Text size="1" color="gray">Stored Registry · name {known(item.name)}</Text></Card>)}</div>}</Tabs.Content>
      <Tabs.Content value="Executors">{!executors.filter(item => matching(item) && (project === 'all' || runs.some(run => run.executor_id === item.id && run.project_id === project))).length ? <Empty>No Executors linked to scoped Runs.</Empty> : <div className="table-wrap"><Table.Root variant="surface"><Table.Header><Table.Row>{['Executor', 'Machine', 'Platform / type', 'Presence', 'Last server contact', 'Current Runs'].map(label => <Table.ColumnHeaderCell key={label}>{label}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header><Table.Body>{executors.filter(item => matching(item) && (project === 'all' || runs.some(run => run.executor_id === item.id && run.project_id === project))).map(item => <Table.Row key={item.id}><Table.RowHeaderCell><button className="record" onClick={() => setSelection({ kind: 'Executor', item })}>{item.display_name}</button><div className="secondary">{item.id}</div></Table.RowHeaderCell><Table.Cell>{known(item.machine.name)}<div className="secondary mono">{item.machine.id}</div></Table.Cell><Table.Cell>{item.platform}<div className="secondary">{known(item.type)} / {known(item.machine.arch)}</div></Table.Cell><Table.Cell><Status value={['offline', 'outdated'].includes(state.phase) ? 'unknown' : item.status} /></Table.Cell><Table.Cell>{stamp(item.last_seen)}<div className="secondary">Registration or heartbeat</div></Table.Cell><Table.Cell>{item.current_runs.length}</Table.Cell></Table.Row>)}</Table.Body></Table.Root></div>}</Tabs.Content>
      <Tabs.Content value="Runs">{runTable(scopedRuns)}</Tabs.Content><Tabs.Content value="Timeline">{eventTable(scopedEvents)}</Tabs.Content>
      </>}
      <footer>Read-only viewer · Runtime declarations are not an independent Review or GitHub approval.</footer></div></main>
    </Tabs.Root>
    <Dialog.Root open={selection !== null} onOpenChange={open => { if (!open) setSelection(null); }}><Dialog.Content maxWidth="780px"><Flex justify="between" align="start" gap="3"><Dialog.Title>{selection?.kind}: {selection?.item.id}</Dialog.Title><Dialog.Close><Button variant="soft">Close details</Button></Dialog.Close></Flex><Dialog.Description>Recorded facts in your viewer scope. GitHub authority is unverified.</Dialog.Description>
      {selection && <div className="detail-facts">{selection.kind === 'Project' ? (() => { const item = selection.item as Project; return <><Fact label="Repository" value={item.repository} /><Fact label="Profile" value={item.profile_ref} /><Fact label="Enabled" value={known(item.enabled)} /><Fact label="Last activity" value={stamp(item.last_activity)} /><Fact label="Provenance" value={item.metadata_provenance} />{runTable(item.active_runs)}</>; })() : selection.kind === 'Executor' ? (() => { const item = selection.item as Executor; return <><Fact label="Machine identity" value={<code>{item.machine.id}</code>} /><Fact label="Platform / type" value={`${item.platform} / ${known(item.type)}`} /><Fact label="Last server contact" value={stamp(item.last_seen)} /><Fact label="Presence" value={<Status value={['offline', 'outdated'].includes(state.phase) ? 'unknown' : item.status} />} /><Fact label="Provenance" value={item.presence_provenance} /></>; })() : (() => { const item = selection.item as Run; return <><Fact label="Work item" value={<Issue run={item} />} /><Fact label="State" value={<Status value={item.state} />} /><Fact label="Source SHA / ref" value={<><External url={safeSourceUrl(item.source)}><code>{item.source.sha}</code></External><p>{item.source.ref}</p></>} /><Fact label="Profile" value={`${item.profile.ref} @ ${item.profile.version}`} /><Fact label="Executor / machine" value={`${item.executor_id} / ${item.machine_id}`} /><Heading size="4" mt="4">Policy diagnostics</Heading>{detailError ? <div role="alert">{detailError}</div> : !diagnostics ? <Text color="gray">Loading diagnostics…</Text> : <>{Object.entries(diagnostics).filter(([, value]) => value !== null && typeof value === 'object').map(([key, value]) => { const diagnostic = value as Comparison; return <div className="diagnostic" key={key}><Flex justify="between"><strong>{key.replaceAll('_', ' ')}</strong><Status value={diagnostic.status} /></Flex><div className="secondary">{diagnostic.provenance}</div><p>{diagnostic.action_hint}</p><Text size="1">Observed: {JSON.stringify(diagnostic.observed)} · Expected: {JSON.stringify(diagnostic.expected)}</Text></div>; })}<Fact label="Verification subject SHA" value={known(diagnostics.verification_subject_sha)} /></>}<Heading size="4" mt="4">Run Timeline</Heading>{eventTable(state.events.filter(event => event.run_id === item.id))}</>; })()}</div>}
      </Dialog.Content></Dialog.Root>
  </Theme>;
}
createRoot(document.getElementById('root')!).render(<App />);
