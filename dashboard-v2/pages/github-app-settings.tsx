import type { ReactNode, InputHTMLAttributes } from "react";
import { GitBranch, ShieldCheck, ArrowUpRight, RefreshCw } from "lucide-react";
import { useGithubAppSettings, labels, installationProblems, type Facts, type Repository } from "../../dashboard/use-github-app";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Select } from "../components/select";

function Field({label,...props}:{label:string}&InputHTMLAttributes<HTMLInputElement>) {
  return <label className="app-field">{label}<Input aria-label={label} {...props}/></label>;
}
function Fact({label,children}:{label:string;children:ReactNode}) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
function Identity({facts}:{facts:Pick<Facts,"delivery_actor"|"reviewer">}) {
  return <dl className="app-identity"><Fact label="Builder Bot">{facts.delivery_actor.login}<small>ID {facts.delivery_actor.id} · {facts.delivery_actor.type}</small></Fact><Fact label="Reviewer">{facts.reviewer.login}<small>ID {facts.reviewer.id} · {facts.reviewer.type}</small></Fact></dl>;
}
function Repositories({items}:{items:Repository[]}) {
  return <section className="app-scope"><h3>完整 Selected Repository 集合 · {items.length} 个仓库</h3><ul className="app-repositories" aria-label="完整安装仓库范围">{items.map(r=><li key={r.id}><span>{r.full_name}</span><small>ID {r.id}</small></li>)}</ul></section>;
}
function Link({href,children}:{href:string;children:ReactNode}) {
  return <a className="external" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}<ArrowUpRight size={14} aria-hidden="true"/></a>;
}
export function GithubAppSettings() {
  const {state,enabled,busy,error,appId,setAppId,slug,setSlug,key,setKey,reviewer,setReviewer,installation,setInstallation,repository,setRepository,ack,setAck,refresh,operation,changed,selected,connected,invalid,disabled}=useGithubAppSettings();
  const statusLabel=state?.fixture&&state.status==="PREFLIGHT_PASS"?"模拟检查通过":state?labels[state.status]??"状态未知":"读取中";
  return <div className="app-settings-v2" id="github-app-settings">
    <div className="app-settings-intro"><GitBranch size={24} aria-hidden="true"/><div><p className="eyebrow">LOCAL CONNECTION</p><h2>GitHub App</h2><p className="muted">首次检测并核对完整安装范围；连接后保留配置，通过检查确认当前状态。</p></div><Badge variant="outline" className={state?.status==="BLOCKED"?"status-warn":""}>{statusLabel}{state&&` · ${state.status}`}</Badge></div>
    {state?.fixture&&<div className="fixture-note" role="note">App Fixture · 模拟数据 · 真实 Preflight NOTRUN</div>}
    {!enabled&&!busy&&<div className="notice" role="status">当前 Viewer 仅可查看。本机可信 Owner 启用管理功能后，才能检测和连接。</div>}
    {busy&&<div className="app-progress" role="status" aria-live="polite">{busy}…{busy==="等待 Windows Owner 确认"&&<p>请在“AWH GitHub App 本机 Owner 确认”窗口核对身份和完整仓库范围。取消或超时后返回此页。</p>}</div>}
    {error&&<div className="notice" role="alert">{error} <a href="/dashboard/v2">重新进入 Dashboard V2</a></div>}
    {state?.problem&&<div className="notice" role="alert"><strong>{state.problem.message}</strong><p>{state.problem.next_action}</p>{state.saved&&<p>连接已经保存，本次检查未通过；无需重复连接。</p>}</div>}
    {!connected&&<Card className="app-settings-card"><div className="app-card-heading"><span className="app-step">01</span><div><h3>检测 App 配置</h3><p className="muted">使用已有 App 和 PEM 文件，本页仅提交本机路径。</p></div></div>
      <form className="app-stack" autoComplete="off" onSubmit={e=>{e.preventDefault();if(!invalid&&!disabled)void operation('detect',{app_id:Number(appId),app_slug:slug,private_key_path:key,reviewer},'检测配置');}}>
        <div className="app-input-grid">
          <Field label="App ID" inputMode="numeric" value={appId} disabled={disabled} required aria-describedby="app-input-help" onChange={e=>{changed();setAppId(e.target.value);}}/>
          <Field label="App slug" value={slug} disabled={disabled} required onChange={e=>{changed();setSlug(e.target.value);}}/>
          <Field label="PEM 本机路径" placeholder="C:\OwnerSecrets\builder.pem" value={key} disabled={disabled} required autoComplete="off" onChange={e=>{changed();setKey(e.target.value);}}/>
          <Field label="Reviewer" value={reviewer} disabled={disabled} required onChange={e=>{changed();setReviewer(e.target.value);}}/>
        </div>
        <p className="muted" id="app-input-help">App ID 来自 GitHub App 设置。PEM 使用已有文件的绝对路径，必须位于 Git 仓库外并受本机 Owner 保护；不要粘贴私钥内容或 Token。</p>
        <div className="app-actions"><Button type="submit" disabled={disabled||invalid}>检测配置</Button><Link href="https://github.com/settings/apps">打开 GitHub App 设置</Link></div>
      </form>
    </Card>}
    {state?.installations&&<Card className="app-settings-card app-stack" aria-label="检测结果"><div className="app-card-heading"><span className="app-step">02</span><div><h3>检测结果</h3><p className="muted">App {state.app_slug} · ID {state.app_id}</p></div></div>
      {state.installations.filter(i=>i.status==='BLOCKED').map(i=><div className="notice" role="alert" key={i.installation_id}>Installation {i.installation_id} · {i.account}<p>{installationProblems[i.reason??'']??'安装、范围或身份未能校验，请核对 GitHub 设置并重新检测。'}</p></div>)}
      {selected&&<>
        <Select label="安装账号" value={installation} disabled={disabled} onChange={e=>{setInstallation(e.target.value);setAck(false);const facts=state.installations?.find(i=>String(i.facts?.installation_id)===e.target.value)?.facts;setRepository(facts?.repositories[0]?.full_name??'');}}>{state.installations.filter(i=>i.status==='DETECTED'&&i.facts).map(i=><option key={i.facts!.installation_id} value={i.facts!.installation_id}>{i.facts!.account.login} · Installation {i.facts!.installation_id}</option>)}</Select>
        <dl className="app-identity"><Fact label="Installation">{selected.installation_id}</Fact><Fact label="所属账号">{selected.account.login}<small>ID {selected.account.id} · {selected.account.type}</small></Fact><Fact label="权限">Contents: {selected.permissions.contents} · Pull requests: {selected.permissions.pull_requests} · Metadata: {selected.permissions.metadata}</Fact></dl>
        <Identity facts={selected}/><Repositories items={selected.repositories}/>
        <Select label="只读检查仓库" value={repository} disabled={disabled} onChange={e=>{setRepository(e.target.value);setAck(false);}}>{selected.repositories.map(r=><option key={r.id} value={r.full_name}>{r.full_name}</option>)}</Select>
        <label className="app-ack"><input type="checkbox" aria-label="确认实际身份和完整安装仓库范围" checked={ack} disabled={disabled} onChange={e=>setAck(e.target.checked)}/>我已核对实际 App、Bot、Reviewer 和完整 Selected Repository 范围。</label>
        <div className="app-actions"><Button disabled={disabled||!ack||!state.detection_id} onClick={()=>void operation('connect',{detection_id:state.detection_id,installation_id:selected.installation_id,repository},'等待 Windows Owner 确认')}>连接并保存</Button><p className="muted">下一步需要 Windows 本机 Owner 确认。</p></div>
      </>}
    </Card>}
    {connected&&<Card className="app-settings-card app-stack" aria-label="已有 App 连接"><div className="app-card-heading"><ShieldCheck aria-hidden="true"/><div><h3>本机连接</h3><p className="muted">{state?.app_slug} · App ID {state?.app_id} · Installation {state?.installation_id}</p></div></div>
      {state?.inspection&&<dl className="app-identity"><Fact label="核验账号">{state.inspection.account.login}<small>ID {state.inspection.account.id} · {state.inspection.account.type}</small></Fact><Fact label="实际权限">Contents: {state.inspection.permissions.contents} · Pull requests: {state.inspection.permissions.pull_requests} · Metadata: {state.inspection.permissions.metadata}</Fact></dl>}
      {state?.delivery_actor&&state.reviewer&&<Identity facts={{delivery_actor:state.delivery_actor,reviewer:state.reviewer}}/>}{state?.repositories&&<Repositories items={state.repositories}/>}
      <p className="muted">CONNECTED_LOCAL 仅表示本机配置可读。{state?.fixture?'本页结果来自模拟服务，未执行真实 GitHub Preflight。':'PREFLIGHT_PASS 表示本次实际 GitHub 检查通过。'}返回此页会回读 GitHub 范围；身份、队列与 Merge 授权保持原样。</p>
      {state?.scope_change&&<section className="app-stack" aria-label="GitHub 仓库范围变化"><h3>GitHub 仓库范围已更新</h3>
        <p>新增：{state.scope_change.added.map(r=>r.full_name).join('、')||'无'}；移除：{state.scope_change.removed.map(r=>r.full_name).join('、')||'无'}。</p>
        <Repositories items={state.scope_change.repositories}/>
        <p className="muted">上方本机连接保留旧范围。确认后仅同步仓库清单，保留旧连接备份；移除的仓库将无法通过交付检查。</p>
        <label className="app-ack"><input type="checkbox" aria-label="确认更新后的完整仓库范围" checked={ack} disabled={disabled} onChange={e=>setAck(e.target.checked)}/>我已核对 GitHub 当前完整仓库范围。</label>
        <Button disabled={disabled||!ack} onClick={()=>void operation('sync-scope',{proposal_id:state.scope_change!.proposal_id},'等待 Windows Owner 确认')}>确认同步仓库范围…</Button>
      </section>}
      {state?.scope_saved&&<p role="status">仓库范围已同步。请选择仓库并重新检查，然后为新项目单独绑定 Issue 队列与 Owner scope。</p>}
      {state?.checked_at&&<p className="muted">最近检查：{new Date(state.checked_at).toLocaleString('zh-CN')}</p>}
      <div className="app-recheck"><Select label="检查仓库" value={repository} disabled={disabled} onChange={e=>setRepository(e.target.value)}>{state?.repositories?.map(r=><option key={r.id} value={r.full_name}>{r.full_name}</option>)}</Select><Button disabled={disabled||!repository} onClick={()=>void operation('preflight',{repository},'重新检查')}><RefreshCw aria-hidden="true"/>重新检查</Button></div>
    </Card>}
    <div className="app-actions"><Button variant="outline" disabled={!!busy} onClick={()=>void refresh()}>刷新连接状态</Button>{connected&&<Button variant="outline" disabled={!!busy||!enabled} onClick={()=>void refresh()}>同步 GitHub 仓库范围</Button>}<Link href="https://github.com/settings/installations">查看 GitHub 安装与仓库范围</Link></div>
    <p className="muted app-settings-boundary">仅本机 Owner 管理模式允许检测、连接及检查。App 连接不授予任务执行、独立 Review、Merge 或生产部署权限。</p>
  </div>;
}
