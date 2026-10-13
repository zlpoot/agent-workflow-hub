import { useGithubAppSettings, labels, installationProblems, type Facts, type Repository } from './use-github-app';
import { Badge, Button, Card, Checkbox, Flex, Heading, Tabs, Text, TextField } from '@radix-ui/themes';

function Identity({ facts }: { facts: Pick<Facts,'delivery_actor'|'reviewer'> }) {
  return <dl className="app-facts"><dt>Builder Bot</dt><dd>{facts.delivery_actor.login} <span className="secondary">ID {facts.delivery_actor.id} · {facts.delivery_actor.type}</span></dd><dt>Reviewer</dt><dd>{facts.reviewer.login} <span className="secondary">ID {facts.reviewer.id} · {facts.reviewer.type}</span></dd></dl>;
}
function Repositories({ items }: { items: Repository[] }) {
  return <div><Text as="p" weight="medium">完整 Selected Repository 集合 · {items.length} 个仓库</Text><ul className="app-repositories" aria-label="完整安装仓库范围">{items.map(r => <li key={r.id}><span>{r.full_name}</span><Text size="1" color="gray">ID {r.id}</Text></li>)}</ul></div>;
}
export function GithubAppSettings() {
  const { state,enabled,busy,error,appId,setAppId,slug,setSlug,key,setKey,reviewer,setReviewer,installation,setInstallation,repository,setRepository,ack,setAck,refresh,operation,changed,selected,connected,invalid,disabled } = useGithubAppSettings();
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
