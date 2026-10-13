import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Checkbox, Flex, Heading, Tabs, Text, TextField } from '@radix-ui/themes';

type Actor = { id: number; login: string; type: string };
type Repository = { id: number; full_name: string };
type Facts = { installation_id: number; account: Actor; repository_selection: string; permissions: { contents: string; pull_requests: string; metadata: string }; repositories: Repository[]; delivery_actor: Actor; reviewer: Actor };
type Inspection = { status: string; facts?: Facts; installation_id?: number; account?: string; reason?: string };
type State = { status: string; management_enabled?: boolean; fixture?: boolean; csrf?: string; app_id?: number; app_slug?: string; installation_id?: number;
  repositories?: Repository[]; delivery_actor?: Actor; reviewer?: Actor; installations?: Inspection[]; detection_id?: string; checked_at?: string;
  saved?: boolean; connection_status?: string; inspection?: Facts; problem?: { code: string; message: string; next_action: string } };
const labels: Record<string,string> = { NOT_CONNECTED: '未连接', CONNECTED_LOCAL: '已保存本机连接 · 待检查', PREFLIGHT_PASS: '实际检查通过', BLOCKED: '检查受阻', DETECTED: '已检测 · 待确认' };
const errors: Record<string,string> = {
  app_input: '填写的信息不合法，请核对 App ID、slug、PEM 绝对路径和 Reviewer。',
  app_owner_unavailable: '当前是只读 Viewer，本机可信 Owner 管理功能尚未启用。',
  app_detection_expired: '检测结果已过期或属于其他会话，请重新检测后确认。',
  app_csrf: '操作凭据已过期或已使用，请重新检测或重新检查。',
  app_busy: '另一个 App 操作正在进行，请等待完成后重试。',
  app_origin: '需要当前 Dashboard 的同源本机会话，请重新进入 Dashboard。',
  app_already_connected: '本机已有连接，请刷新状态并使用“重新检查”。此页面不会覆盖连接。',
};
const installationProblems: Record<string,string> = { all_repositories: '安装范围为 All repositories；请 Owner 在 GitHub 改为 Selected repositories。', permissions_insufficient: '缺少 Contents: write / Pull requests: write / Metadata: read。', installation_suspended: '安装已暂停，请 Owner 在 GitHub 恢复。', network_error: 'GitHub 网络请求失败或超时，请稍后重新检测。', reviewer_identity: 'Reviewer 必须是有效的个人 User。', identity_drift: 'App 或安装身份不匹配，请核对设置。', scope_drift: '无法核验完整安装仓库范围。' };
const endpoint = '/dashboard/github-app/v1/';
function Identity({ facts }: { facts: Pick<Facts,'delivery_actor'|'reviewer'> }) {
  return <dl className="app-facts"><dt>Builder Bot</dt><dd>{facts.delivery_actor.login} <span className="secondary">ID {facts.delivery_actor.id} · {facts.delivery_actor.type}</span></dd><dt>Reviewer</dt><dd>{facts.reviewer.login} <span className="secondary">ID {facts.reviewer.id} · {facts.reviewer.type}</span></dd></dl>;
}
function Repositories({ items }: { items: Repository[] }) {
  return <div><Text as="p" weight="medium">完整 Selected Repository 集合 · {items.length} 个仓库</Text><ul className="app-repositories" aria-label="完整安装仓库范围">{items.map(r => <li key={r.id}><span>{r.full_name}</span><Text size="1" color="gray">ID {r.id}</Text></li>)}</ul></div>;
}
export function GithubAppSettings() {
  const [state,setState] = useState<State|null>(null),[enabled,setEnabled] = useState(false),[busy,setBusy] = useState('读取状态'),[error,setError] = useState('');
  const [appId,setAppId] = useState(''),[slug,setSlug] = useState('zlpoot-awh-builder'),[key,setKey] = useState(''),[reviewer,setReviewer] = useState('zlpoot');
  const [installation,setInstallation] = useState(''),[repository,setRepository] = useState(''),[ack,setAck] = useState(false);
  const running = useRef(false), abort = useRef<AbortController|null>(null), alive = useRef(true);
  const read = async (signal: AbortSignal): Promise<State> => {
    const response = await fetch(endpoint+'status', { credentials: 'same-origin', signal });
    if (response.status === 404) throw new Error('此 Viewer 尚未提供 GitHub App 设置。请本机管理员更新 Viewer 后重试。');
    if (response.status === 401) throw new Error('会话已到期，请点击顶部“重新进入 Dashboard”。');
    const result = await response.json();
    if (!response.ok || result.authority_verified !== false || !result.item?.status) throw new Error('无法读取本机 App 状态，请稍后重试。');
    return result.item;
  };
  const refresh = async () => {
    if (running.current) return; running.current = true; setBusy('读取状态'); setError('');
    const controller = abort.current = new AbortController();
    try { const value = await read(controller.signal); if (alive.current) {setState(value);setEnabled(value.management_enabled === true);setRepository(value.repositories?.[0]?.full_name ?? '');setAck(false);} }
    catch(e) { if (alive.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : '状态暂不可用'); }
    finally { if (alive.current) setBusy(''); running.current = false; }
  };
  useEffect(() => { alive.current = true; void refresh(); return () => {alive.current = false;abort.current?.abort();}; }, []);
  const operation = async (action: string, data: Record<string,unknown>, label: string) => {
    if (running.current) return; running.current = true; setBusy(label); setError('');
    const controller = abort.current = new AbortController();
    try {
      const fresh = await read(controller.signal);
      setEnabled(fresh.management_enabled === true);
      const response = await fetch(endpoint+action, {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-AWH-CSRF':fresh.csrf ?? ''}, body:JSON.stringify(data), signal:AbortSignal.any([controller.signal,AbortSignal.timeout(action === 'connect' ? 430000 : 130000)])});
      if (response.status === 401) throw new Error('会话已到期，请重新进入 Dashboard。若连接状态不明，先刷新本机状态。');
      const result = await response.json();
      if (!response.ok || result.authority_verified !== false || !result.item) throw new Error(errors[result.error?.code] ?? '本机操作未完成，请刷新状态后重试。');
      if (!alive.current) return;
      const value: State = result.item;setState(value);setAck(false);
      if (action === 'detect') { const first = value.installations?.find(i => i.status === 'DETECTED')?.facts;setInstallation(String(first?.installation_id ?? ''));setRepository(first?.repositories[0]?.full_name ?? ''); }
      if (action === 'connect' && value.saved) {setKey('');setAppId('');}
    } catch(e) { if (alive.current && !controller.signal.aborted) {setError(e instanceof Error ? e.message : '操作未完成，请刷新状态后重试。');setAck(false);if(action === 'connect')setState(v => v ? {...v,detection_id:undefined} : v);} }
    finally { if (alive.current) setBusy('');running.current = false; }
  };
  const changed = () => {setAck(false);setState(v => v ? {status:'NOT_CONNECTED',management_enabled:enabled,fixture:v.fixture} : v);setInstallation('');setRepository('');setError('');};
  const selected = state?.installations?.find(i => i.status === 'DETECTED' && String(i.facts?.installation_id) === installation)?.facts;
  const connected = !!state?.repositories?.length && !!state?.installation_id || state?.saved === true || state?.connection_status === 'CONNECTED_LOCAL';
  const invalid = !/^[1-9]\d*$/.test(appId) || !Number.isSafeInteger(Number(appId)) || !/^[a-z0-9-]{1,100}$/.test(slug) || !/^[A-Za-z0-9-]{1,39}$/.test(reviewer) || !/^[A-Za-z]:[\\/]/.test(key) || /[\x00-\x1f]/.test(key);
  const disabled = !!busy || !enabled;
  return <Tabs.Root defaultValue="github-app" className="app-settings"><Tabs.List aria-label="设置分类"><Tabs.Trigger value="github-app">GitHub App</Tabs.Trigger></Tabs.List><Tabs.Content value="github-app"><Card className="app-stack" aria-label="GitHub App 设置">
    <Flex justify="between" align="center" gap="3" wrap="wrap"><Heading size="5">GitHub App</Heading>{state && <Badge color={state.status === 'PREFLIGHT_PASS' ? 'teal' : state.status === 'BLOCKED' ? 'red' : 'gray'}>{labels[state.status] ?? '状态未知'} · {state.status}</Badge>}</Flex>
    <Text color="gray">首次填写 App 信息并确认安装范围；连接后可直接查看状态和重新检查。</Text>
    {state?.fixture && <Badge color="amber" role="note">App Fixture · 模拟数据 · 真实 Preflight NOTRUN</Badge>}
    {!enabled && !busy && <div className="notice" role="status">当前 Viewer 仅可查看。本机可信 Owner 启用管理功能后，才能检测和连接。</div>}
    {busy && <Text role="status" aria-live="polite">{busy}…{busy === '等待 Windows Owner 确认' && '请在“AWH GitHub App 本机 Owner 确认”窗口核对身份和完整仓库范围。取消或超时后返回此页。'}</Text>}
    {error && <div className="notice" role="alert">{error}</div>}
    {state?.problem && <div className="notice" role="alert"><strong>{state.problem.message}</strong><p>{state.problem.next_action}</p>{state.saved && <Text>连接已经保存，本次检查未通过；无需重复连接。</Text>}</div>}
    {!connected && <form className="app-stack" onSubmit={e => {e.preventDefault();if(!invalid && !disabled)void operation('detect',{app_id:Number(appId),app_slug:slug,private_key_path:key,reviewer},'检测配置');}}>
      <div className="app-form"><label className="enrollment-field">App ID<TextField.Root aria-label="App ID" inputMode="numeric" value={appId} disabled={disabled} onChange={e => {changed();setAppId(e.target.value);}} required aria-describedby="app-input-help" /></label>
        <label className="enrollment-field">App slug<TextField.Root aria-label="App slug" value={slug} disabled={disabled} onChange={e => {changed();setSlug(e.target.value);}} required /></label>
        <label className="enrollment-field app-wide">PEM 本机路径<TextField.Root aria-label="PEM 本机路径" placeholder="C:\OwnerSecrets\builder.pem" value={key} disabled={disabled} autoComplete="off" onChange={e => {changed();setKey(e.target.value);}} required /></label>
        <label className="enrollment-field app-wide">Reviewer<TextField.Root aria-label="Reviewer" value={reviewer} disabled={disabled} onChange={e => {changed();setReviewer(e.target.value);}} required /></label></div>
      <Text size="2" color="gray" id="app-input-help">App ID 来自 GitHub App 设置。PEM 使用已有文件的绝对路径，必须位于 Git 仓库外并受本机 Owner 保护；不要粘贴私钥内容或 Token。</Text>
      <Flex gap="3" wrap="wrap"><Button type="submit" disabled={disabled || invalid}>检测配置</Button><a href="https://github.com/settings/apps" target="_blank" rel="noopener noreferrer">打开 GitHub App 设置 ↗</a></Flex>
    </form>}
    {state?.installations && <section className="app-stack" aria-label="检测结果">
      <Heading size="4">检测结果</Heading><Text>App {state.app_slug} · ID {state.app_id}</Text>
      {state.installations.filter(i => i.status === 'BLOCKED').map(i => <div className="notice" role="alert" key={i.installation_id}>Installation {i.installation_id} · {i.account}<p>{installationProblems[i.reason ?? ''] ?? '安装、范围或身份未能校验，请核对 GitHub 设置并重新检测。'}</p></div>)}
      {selected && <><label className="enrollment-field">安装账号<select className="enrollment-select" aria-label="安装账号" value={installation} disabled={disabled} onChange={e => {setInstallation(e.target.value);setAck(false);const facts=state.installations?.find(i => String(i.facts?.installation_id) === e.target.value)?.facts;setRepository(facts?.repositories[0]?.full_name ?? '');}}>{state.installations.filter(i => i.status === 'DETECTED' && i.facts).map(i => <option key={i.facts!.installation_id} value={i.facts!.installation_id}>{i.facts!.account.login} · Installation {i.facts!.installation_id}</option>)}</select></label>
        <dl className="app-facts"><dt>Installation</dt><dd>{selected.installation_id}</dd><dt>所属账号</dt><dd>{selected.account.login} · ID {selected.account.id} · {selected.account.type}</dd><dt>权限</dt><dd>Contents: {selected.permissions.contents} · Pull requests: {selected.permissions.pull_requests} · Metadata: {selected.permissions.metadata}</dd></dl><Identity facts={selected}/><Repositories items={selected.repositories}/>
        <label className="enrollment-field">只读检查仓库<select className="enrollment-select" aria-label="只读检查仓库" value={repository} disabled={disabled} onChange={e => {setRepository(e.target.value);setAck(false);}}>{selected.repositories.map(r => <option key={r.id} value={r.full_name}>{r.full_name}</option>)}</select></label>
        <Text as="label" className="app-ack"><Checkbox aria-label="确认实际身份和完整安装仓库范围" checked={ack} disabled={disabled} onCheckedChange={value => setAck(value === true)}/>我已核对实际 App、Bot、Reviewer 和完整 Selected Repository 范围。</Text>
        <Button disabled={disabled || !ack || !state.detection_id} onClick={() => void operation('connect',{detection_id:state.detection_id,installation_id:selected.installation_id,repository},'等待 Windows Owner 确认')}>连接并保存</Button></>}
    </section>}
    {connected && <section className="app-stack" aria-label="已有 App 连接"><Text weight="medium">{state?.app_slug} · App ID {state?.app_id} · Installation {state?.installation_id}</Text>
      {state?.inspection && <dl className="app-facts"><dt>核验账号</dt><dd>{state.inspection.account.login} · ID {state.inspection.account.id} · {state.inspection.account.type}</dd><dt>实际权限</dt><dd>Contents: {state.inspection.permissions.contents} · Pull requests: {state.inspection.permissions.pull_requests} · Metadata: {state.inspection.permissions.metadata}</dd></dl>}
      {state?.delivery_actor && state.reviewer && <Identity facts={{delivery_actor:state.delivery_actor,reviewer:state.reviewer}}/>}{state?.repositories && <Repositories items={state.repositories}/>}
      <Text color="gray" size="2">本机已保存连接。CONNECTED_LOCAL 只表示配置可读；PREFLIGHT_PASS 表示本次实际 GitHub 检查通过。</Text>
      {state?.checked_at && <Text size="2">最近检查：{new Date(state.checked_at).toLocaleString('zh-CN')}</Text>}
      <label className="enrollment-field">检查仓库<select className="enrollment-select" aria-label="检查仓库" value={repository} disabled={disabled} onChange={e => setRepository(e.target.value)}>{state?.repositories?.map(r => <option key={r.id} value={r.full_name}>{r.full_name}</option>)}</select></label>
      <Button disabled={disabled || !repository} onClick={() => void operation('preflight',{repository},'重新检查')}>重新检查</Button>
    </section>}
    <Flex gap="3" wrap="wrap"><Button variant="soft" disabled={!!busy} onClick={() => void refresh()}>刷新连接状态</Button><a href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">查看 GitHub 安装与仓库范围 ↗</a></Flex>
  </Card></Tabs.Content></Tabs.Root>;
}
