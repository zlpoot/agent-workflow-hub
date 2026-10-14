import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../src/dashboard/tasks.js';
import { localFastRequest } from '../../dashboard/local-fast-api';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Select } from '../components/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../components/ui/sheet';
import { TaskList } from '../components/task-list';
import { stamp } from '../lib/task-model.mjs';
import { canStart, ownerCommand, recovery, validQueue } from '../lib/local-fast-model.mjs';
import { CopyText } from '../components/copy-text';
import {IssueQueue,type IssuePage} from '../components/issue-queue';

type Preview={directory:string;repository:string;head:string;branch:string;dirty:boolean;bound:boolean;issues:number[];checks:string[];provider:string;project_id?:string;queue_revision?:string;queue_editable?:boolean;queue_started?:boolean;draft_issues?:number[];owner_native?:boolean;codex_executable?:string|null;owner_cli?:{node:string;entry:string}};
type Project=Partial<Preview>&{project_id:string;directory:string;repository:string;available:boolean;reason?:string};
type Watch={status:string;reason?:string;gui_status:string;gui_reason?:string;expires_at?:string;allow_merge?:boolean;watcher_running?:boolean;stale_lock?:boolean;repository?:string;issues?:number[];observedAt:number};
export function Projects({tasks,open,disconnected,now,refresh}:{tasks:Task[];open:(id:string)=>void;disconnected:boolean;now:number;refresh:()=>void}) {
  const [projects,setProjects]=useState<Project[]>([]),[roots,setRoots]=useState<string[]>([]),[directories,setDirectories]=useState<string[]>([]);
  const [directory,setDirectory]=useState(''),[preview,setPreview]=useState<Preview|null>(null),[status,setStatus]=useState<Watch|null>(null);
  const [issues,setIssues]=useState(''),[checks,setChecks]=useState(''),[provider,setProvider]=useState('github-app');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[available,setAvailable]=useState(true),[confirmation,setConfirmation]=useState<'attach'|'bind'|'start'|'queue-save'|null>(null);
  const [issuePage,setIssuePage]=useState<IssuePage|null>(null),[draftSaved,setDraftSaved]=useState(false);
  const [expires,setExpires]=useState(()=>new Date(Date.now()+86400000).toISOString()),[executable,setExecutable]=useState(''),[allowMerge,setAllowMerge]=useState(false);
  const [ownerResult,setOwnerResult]=useState('');
  const pending=useRef(false),abort=useRef<AbortController|null>(null),mounted=useRef(true);
  const request=async(action:string,data:Record<string,unknown>={})=>localFastRequest(action,data,abort.current!.signal);
  const operation=async(work:()=>Promise<void>)=>{
    if(pending.current)return;pending.current=true;setBusy(true);setError('');abort.current=new AbortController();
    try {await work();}catch(e){if(mounted.current){const code=e instanceof Error?e.message:'unavailable';if(code==='local_fast_unavailable')setAvailable(false);else setError(code);setStatus(null);}}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  const list=async()=>{const value=await request('list');if(mounted.current)setProjects(value.items);};
  const watch=async(root:string)=>{const value=await request('status',{directory:root});if(mounted.current)setStatus({...value,observedAt:Date.now()});};
  const browse=async(path?:string)=>{
    const value=await request('browse',path?{directory:path}:{});if(!mounted.current)return;
    setRoots(value.roots);setDirectories(value.directories);if(value.current){setDirectory(value.current);setPreview(null);setStatus(null);}
  };
  const inspect=async(path:string,projectId?:string)=>{
    setPreview(null);setStatus(null);setIssuePage(null);setDraftSaved(false);const value:Preview=await request('inspect',{directory:path});if(!mounted.current)return;
    setDirectory(value.directory);setPreview({...value,project_id:projectId});setIssues((value.draft_issues??[]).join(','));setChecks(value.checks.join('\n'));setProvider(value.bound?value.provider:'github-app');
    setExecutable(value.codex_executable??'');setOwnerResult('');
    if(projectId)await watch(value.directory);
    const page=await request('issues',{directory:value.directory,page:1});if(mounted.current)setIssuePage(page);
  };
  useEffect(()=>{mounted.current=true;void operation(async()=>{await browse();await list();});return()=>{mounted.current=false;abort.current?.abort();};},[]);
  useEffect(()=>{
    if(!preview?.project_id||confirmation)return;
    const root=preview.directory,timer=setInterval(()=>void operation(()=>watch(root)),30000);
    return()=>clearInterval(timer);
  },[preview?.project_id,preview?.directory,confirmation]);
  const confirm=()=>operation(async()=>{
    if(!preview||!confirmation)return;
    const action=confirmation;
    if(action==='start'&&!canStart(status))throw new Error('local_fast_watch_scope');
    const result=await request(action,{directory:preview.directory,confirm:true,...(action!=='start'?{repository:preview.repository,head:preview.head}:{}),...(action==='bind'?{issues,checks:checks.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),provider}:action==='queue-save'?{issues,queue_revision:preview.queue_revision}:{})});
    if(!mounted.current)return;
    setConfirmation(null);
    if(action!=='start'){setPreview(result);await list();refresh();}
    await watch(preview.directory);
  });
  const projectTasks=preview?.project_id?tasks.filter(t=>t.project_id===preview.project_id):[];
  const command=ownerCommand(preview,expires,executable,allowMerge);
  const ownerValid=Number.isFinite(Date.parse(expires))&&Date.parse(expires)>now&&Date.parse(expires)-now<=30*86400000;
  const stale=!status||now-status.observedAt>=15000||now<status.observedAt;
  if(!available)return <Card className="detail-card"><h2>Local Fast 本机接入未启用</h2><p>请在此 Windows Viewer 的安装设置中启用可信项目目录与独立保存目录。已有 CP 接入仍可通过兼容入口使用。</p><Button asChild variant="outline"><a href="/dashboard/v1">兼容 CP Enrollment</a></Button></Card>;
  return <div className="project-stack">
    <Card className="detail-card"><div className="section-title"><div><h2>本机项目</h2><p className="muted">选择已有 Git 仓库，关联历史或配置有序 Issue 队列。</p></div><Button variant="outline" disabled={busy} onClick={()=>void operation(list)}>刷新项目</Button></div>
      {projects.length?<div className="project-inventory">{projects.map(p=><Button variant="outline" key={p.project_id} disabled={busy} onClick={()=>{setDirectory(p.directory);void operation(()=>inspect(p.directory,p.project_id));}}><span>{p.repository}<small>{p.directory}</small><small>{p.available?'Local Fast · 已关联':`${p.reason} · ${recovery(p.reason??'directory')}`}</small></span></Button>)}</div>:<p className="muted">暂无已关联项目。确认后自动保存，Viewer 重启可恢复。</p>}
    </Card>
    <Card className="detail-card project-stack" aria-label="Local Fast 项目接入"><h2>添加已有仓库 / 项目详情</h2>
      <div className="project-paths flex flex-wrap gap-2">{roots.map(root=><Button variant="outline" key={root} disabled={busy} onClick={()=>void operation(()=>browse(root))}>{root}</Button>)}</div>
      <label className="app-field">项目目录<Input aria-label="Local Fast 项目目录" value={directory} disabled={busy} onChange={e=>{setDirectory(e.target.value);setPreview(null);setStatus(null);setDirectories([]);setError('');}}/></label>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy||!directory} onClick={()=>void operation(()=>browse(directory))}>浏览目录</Button><Button disabled={busy||!directory} onClick={()=>void operation(()=>inspect(directory,projects.find(p=>p.directory.toLowerCase()===directory.toLowerCase())?.project_id))}>检查 Local Fast 项目</Button></div>
      {!!directories.length&&<details open><summary>选择子目录</summary><div className="project-paths flex flex-wrap gap-2">{directories.map(path=><Button variant="ghost" key={path} disabled={busy} onClick={()=>void operation(()=>browse(path))}>{path.split(/[\\/]/).at(-1)}</Button>)}</div></details>}
      {preview&&<><dl className="project-facts"><dt>仓库</dt><dd>{preview.repository}</dd><dt>分支 / HEAD</dt><dd>{preview.branch} · <code>{preview.head}</code></dd><dt>工作区</dt><dd>{preview.dirty?'有本机改动 · 保留原样':'干净'}</dd><dt>工作流</dt><dd>Local Fast</dd><dt>交付身份</dt><dd>{preview.bound?preview.provider:'配置已有身份'}</dd></dl>
        {preview.bound?<><h3>已绑定的 Issue 队列</h3><ol className="project-queue">{preview.issues.map(issue=><li key={issue}><a href={`https://github.com/${preview.repository}/issues/${issue}`} target="_blank" rel="noopener noreferrer">Issue #{issue}</a></li>)}</ol><p className="muted">定向检查：{preview.checks.join(' · ')||'未配置'}。关联保留队列、历史与现有交付身份。</p>
          {!preview.project_id&&<Button disabled={busy} onClick={()=>setConfirmation('attach')}>关联已有队列…</Button>}
        </>:<><p>尚未绑定。选择已有 GitHub Issue；服务端核对真实登录、权限、Issue 和队列冲突。</p><label className="app-field">有序 Issue 队列<Input aria-label="Local Fast Issue 列表" placeholder="12,15,18" value={issues} disabled={busy} onChange={e=>setIssues(e.target.value)}/></label>
          {issues&&!validQueue(issues)&&<p role="alert">请输入唯一的正整数 Issue 编号，以逗号分隔，最多 128 项。</p>}
          <label className="app-field">定向测试命令（每行一条）<textarea aria-label="Local Fast 校验命令" rows={3} placeholder="pnpm typecheck" disabled={busy} value={checks} onChange={e=>setChecks(e.target.value)}/></label>
          <Select label="交付身份" aria-label="Local Fast 交付身份" value={provider} disabled={busy} onChange={e=>setProvider(e.target.value)}><option value="github-app">github-app（已有连接）</option><option value="personal-gh">personal-gh（已有登录）</option></Select>
          <Button disabled={busy||!validQueue(issues)} onClick={()=>setConfirmation('bind')}>预览绑定队列…</Button></>}
      </>}
    </Card>
    {preview&&<IssueQueue repository={preview.repository} value={issues} setValue={value=>{setIssues(value);setDraftSaved(false);}} page={issuePage} busy={busy}
      query={page=>void operation(async()=>{const value=await request('issues',{directory:preview.directory,page});if(mounted.current)setIssuePage(value);})}
      saveDraft={()=>void operation(async()=>{await request('queue-draft',{directory:preview.directory,repository:preview.repository,issues});if(mounted.current)setDraftSaved(true);})}
      saveQueue={()=>setConfirmation('queue-save')} bound={preview.bound} editable={preview.queue_editable===true} unstarted={!preview.queue_started} current={preview.issues} associated={!!preview.project_id}/>}
    {draftSaved&&<p role="status">候选队列已保存，Viewer 重启后可继续编辑。</p>}
    {preview?.project_id&&<Card className="detail-card project-stack"><div className="section-title"><h2>Watcher 与 Windows Owner 授权</h2><Button variant="outline" disabled={busy} onClick={()=>void operation(()=>watch(preview.directory))}>查询 Watcher</Button></div>
      <p className="muted">最近本机查询：{stamp(status?.observedAt)}{stale?' · 当前状态未核验':''}</p>
      {status&&<><p role="status">Watcher：{status.status} · GUI：{status.gui_status}{stale?'（历史）':''}</p><dl className="project-facts"><dt>有效 Owner 仓库 / 队列</dt><dd>{stale?'当前未知':`${status.repository??'未核验'} · ${status.issues?.join(' → ')??'未核验'}`}</dd><dt>到期时间</dt><dd>{stamp(status.expires_at)}{status.expires_at&&Date.parse(status.expires_at)<=now?' · 已到期':''}</dd><dt>自动 Merge</dt><dd>{stale?'当前未知':status.allow_merge===true?'Owner 已允许':'未允许'}</dd><dt>Watcher / 锁</dt><dd>{stale?'当前未知':status.stale_lock?'失效锁 · 保留现场':status.watcher_running?'正在运行':'未运行'}</dd></dl>{(status.reason||status.gui_reason)&&<p className="notice">{status.reason??status.gui_reason} · {recovery(status.reason??status.gui_reason??'')}</p>}</>}
      <div className="flex flex-wrap gap-2"><Button disabled={busy||!canStart(status,now)} onClick={()=>setConfirmation('start')}>启动已有 Owner scope…</Button><Button variant="outline" disabled={busy||!status||!['RUNNING','STOPPING'].includes(status.gui_status)||status.gui_status==='STOPPING'} onClick={()=>void operation(async()=>{await request('stop',{directory:preview.directory});await watch(preview.directory);refresh();})}>停止本 GUI Watcher</Button></div>
      <details open={!status?.expires_at||!!ownerResult}><summary>Windows Owner 确认引导</summary><div className="project-stack"><p className="notice">{preview.owner_native?'页面将打开 Windows Owner 原生确认窗口。核对仓库、队列、UTC 到期、Codex.exe 与自动 Merge 后确认；保存后自动刷新状态，再启动 Watcher。':'GUI_OWNER_CONFIRMATION_NOT_INTEGRATED：本机未启用 Windows 原生确认，Owner 需在交互式终端运行下方命令，完成后点击“查询 Watcher”。'}</p>
        <label className="app-field">UTC 到期时间<Input aria-label="Owner UTC 到期时间" value={expires} disabled={busy} onChange={e=>setExpires(e.target.value)}/></label>
        <label className="app-field">Codex 可执行文件<Input aria-label="Codex 可执行文件" placeholder="C:\path\codex.exe" value={executable} disabled={busy} onChange={e=>setExecutable(e.target.value)}/></label>
        <p className="muted">{preview.codex_executable?'已自动识别本机 Codex 安装，可核对或手动调整。':'未找到有效 Codex.exe，请选择已安装的可执行文件。'}</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={allowMerge} disabled={busy} onChange={e=>setAllowMerge(e.target.checked)}/>允许 Watcher 在独立 Review PASS 后自动 Merge 并推进</label>
        {!ownerValid&&<p role="alert">到期时间必须是未来 30 天内的 UTC 时间，以 Z 结尾。</p>}
        {preview.owner_native&&<Button disabled={busy||!command||!ownerValid} onClick={()=>void operation(async()=>{
          setOwnerResult('');
          const result=await request('owner-authorize',{directory:preview.directory,repository:preview.repository,head:preview.head,queue_revision:preview.queue_revision,issues:preview.issues.join(','),expires,executable,allow_merge:allowMerge});
          if(mounted.current){setOwnerResult(result.owner_result);setStatus({...result,observedAt:Date.now()});refresh();}
        })}>{busy?'等待本机操作完成…':'打开 Windows Owner 授权窗口'}</Button>}
        {ownerResult&&<p role="status">{ownerResult==='OWNER_CANCELLED'?'已取消，未保存本轮授权。':'本轮 Owner 授权已保存，Watcher 状态已刷新。'}</p>}
        {command&&ownerValid?<details open={!preview.owner_native}><summary>终端授权备用方式</summary><CopyText label="Owner 授权命令" text={command}/></details>:<p className="muted">填写有效 UTC 到期时间与 Codex.exe 绝对路径后可授权。</p>}
        <p className="muted">取消、到期或 scope 冲突请由 Owner 按已有 CLI 处理；GUI 不覆盖授权。仅停止此 GUI 启动的 Watcher，Viewer 退出会停止其拥有的进程。</p>
      </div></details>
    </Card>}
    {preview?.project_id&&<Card className="detail-card"><h2>项目任务 · 队列顺序</h2><p className="muted">当前执行队列 · Local Fast 本机记录与真实 GitHub 观察；完成状态以 Merge / Issue CLOSED 回读为准。</p><TaskList tasks={projectTasks.filter(t=>preview.issues.includes(t.issue.number)).sort((a,b)=>preview.issues.indexOf(a.issue.number)-preview.issues.indexOf(b.issue.number))} open={open} disconnected={disconnected} now={now}/></Card>}
    {preview?.project_id&&projectTasks.some(t=>!preview.issues.includes(t.issue.number))&&<Card className="detail-card"><h2>历史任务 · 已保留的队列</h2><p className="muted">历史 Watcher 与 Owner 记录用于回看，新的执行队列需要本轮授权。</p><TaskList tasks={projectTasks.filter(t=>!preview.issues.includes(t.issue.number))} open={open} disconnected={disconnected} now={now}/></Card>}
    {busy&&<p role="status">正在处理本机操作…</p>}
    {error&&<div role="alert" className="notice">{error} · {recovery(error)} <a href="/dashboard/v2">重新进入 V2</a></div>}
    <Sheet open={confirmation!==null} onOpenChange={value=>{if(!value&&!busy)setConfirmation(null);}}><SheetContent className="task-sheet" showCloseButton={false} onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>{if(busy)e.preventDefault();}}><SheetHeader><SheetTitle>{confirmation==='start'?'确认启动 Watcher':confirmation==='queue-save'?'确认下一轮执行队列':confirmation==='bind'?'确认新 Local Fast 队列':'确认关联已有队列'}</SheetTitle><SheetDescription>核对本机项目与有限任务范围。</SheetDescription></SheetHeader><div className="sheet-body project-stack"><p>{preview?.repository}</p><p>{preview?.directory}</p><code>{preview?.head}</code><p>Issue 队列：{['bind','queue-save'].includes(confirmation??'')?issues:preview?.issues.join(' → ')}</p><p>交付身份：{provider}</p><pre>{confirmation==='bind'?checks:preview?.checks.join('\n')}</pre><p>{confirmation==='start'?`使用已保存 scope；到期 ${status?.expires_at}；自动 Merge：${status?.allow_merge?'已允许':'未允许'}。服务端再次核验实际授权。`:confirmation==='queue-save'?'保留当前队列与历史，保存新的有限执行顺序。旧授权不会用于新队列；启动前需本轮 Windows Owner 确认。':confirmation==='bind'?'确认绑定不会启动开发；已有队列冲突将拒绝，不覆盖历史。':'保存关联，保留已有队列与历史。'}</p>{error&&<p role="alert">{error} · {recovery(error)}</p>}<div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={()=>setConfirmation(null)}>取消</Button><Button disabled={busy||['bind','queue-save'].includes(confirmation??'')&&!validQueue(issues)||confirmation==='start'&&!canStart(status,now)} onClick={()=>void confirm()}>{busy?'正在处理…':'确认'}</Button></div></div></SheetContent></Sheet>
  </div>;
}
