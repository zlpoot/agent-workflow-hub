import { useEffect, useRef, useState } from 'react';
import { Button, Card, Dialog, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import { localFastRequest } from './local-fast-api';

export function LocalFastProject({onConnected}:{onConnected:(project:string)=>void}) {
  const [directory,setDirectory]=useState(''),[roots,setRoots]=useState<string[]>([]),[directories,setDirectories]=useState<string[]>([]);
  const [preview,setPreview]=useState<any>(null),[status,setStatus]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[available,setAvailable]=useState(true);
  const [issues,setIssues]=useState(''),[checks,setChecks]=useState(''),[provider,setProvider]=useState('personal-gh'),[confirmation,setConfirmation]=useState<'attach'|'bind'|'start'|null>(null);
  const pending=useRef(false),abort=useRef<AbortController|null>(null);
  const call=async(action:string,data:Record<string,unknown>)=>{
    if(pending.current)return null;pending.current=true;setBusy(true);setError('');
    const controller=abort.current=new AbortController();
    try {
      return await localFastRequest(action,data,controller.signal);
    }catch(e){if(e instanceof Error&&e.message==='local_fast_unavailable')setAvailable(false);else if(!controller.signal.aborted)setError('操作未完成：'+(e instanceof Error?e.message:'unavailable')+'。保留原队列与历史。');return null;}
    finally{pending.current=false;if(!controller.signal.aborted)setBusy(false);}
  };
  const browse=async(path?:string)=>{const result=await call('browse',path?{directory:path}:{});if(result){setRoots(result.roots);setDirectories(result.directories);if(result.current){setDirectory(result.current);setPreview(null);setStatus(null);}}};
  useEffect(()=>{void browse();return()=>abort.current?.abort();},[]);
  const refresh=async(root=directory)=>{const result=await call('status',{directory:root});if(result)setStatus(result);};
  const confirm=async()=>{
    if(!preview||!confirmation)return;
    const action=confirmation,result=await call(action,{directory:preview.directory,confirm:true,...(action!=='start'?{repository:preview.repository,head:preview.head}:{}),...(action==='bind'?{issues,checks:checks.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),provider}:{})});
    if(result){setConfirmation(null);if(action!=='start'){setPreview(result);setStatus(null);onConnected(result.project_id);}else await refresh(preview.directory);}
  };
  if(!available)return <Card><Heading size="4">Local Fast 本机接入未启用</Heading><Text>请在此 Windows Viewer 的安装设置中启用可信项目目录和独立保存目录。</Text></Card>;
  return <Card className="enrollment-stack" aria-label="Local Fast 项目接入">
    <Heading size="5">Local Fast 项目</Heading><Text>观察已有队列，或确认新队列。无需 CP 项目批准。已有队列与 Watcher 历史保持原样。</Text>
    <Flex gap="2" wrap="wrap">{roots.map(root=><Button key={root} variant="soft" disabled={busy} onClick={()=>void browse(root)}>{root}</Button>)}</Flex>
    <label className="enrollment-field">项目目录<TextField.Root aria-label="Local Fast 项目目录" value={directory} disabled={busy} onChange={e=>{setDirectory(e.target.value);setPreview(null);setStatus(null);}}/></label>
    <Flex gap="2"><Button variant="soft" disabled={busy||!directory} onClick={()=>void browse(directory)}>浏览目录</Button><Button disabled={busy||!directory} onClick={()=>void(async()=>{const p=await call('inspect',{directory});if(p){setPreview(p);setIssues(p.issues.join(','));setChecks(p.checks.join('\n'));setProvider(p.provider);setConfirmation(p.bound?'attach':'bind');}})()}>检查 Local Fast 项目</Button></Flex>
    {directories.length>0&&<details open><summary>选择子目录</summary><Flex gap="2" wrap="wrap">{directories.map(path=><Button key={path} variant="soft" disabled={busy} onClick={()=>void browse(path)}>{path.split(/[\\/]/).at(-1)}</Button>)}</Flex></details>}
    {preview&&<><Text weight="medium">{preview.repository} · {preview.branch} · {preview.head.slice(0,10)}</Text><Text>队列：{preview.issues.join(' → ')||'尚未绑定'} · {preview.provider}</Text>
      {preview.bound&&<Flex gap="2" wrap="wrap"><Button variant="soft" disabled={busy} onClick={()=>void refresh()}>查询 Watcher</Button><Button variant="soft" asChild><a href="/dashboard/v2">查看 V2 任务</a></Button></Flex>}
    </>}
    {status&&<><Text role="status">Watcher：{status.status} {status.reason??''} · GUI：{status.gui_status} {status.gui_reason??''} · Owner scope：{status.expires_at??'缺少或不可用'} · 自动 Merge：{status.allow_merge===true?'已由 Owner 允许':'未允许'}</Text>
      <Flex gap="2"><Button disabled={busy||status.status==='BLOCKED'||status.status==='QUEUE_COMPLETED'||status.watcher_running||status.stale_lock||['RUNNING','STOPPING'].includes(status.gui_status)} onClick={()=>setConfirmation('start')}>启动已有 Owner scope</Button><Button variant="soft" disabled={busy||!['RUNNING','STOPPING'].includes(status.gui_status)} onClick={()=>void(async()=>{const result=await call('stop',{directory});if(result)setStatus(result);})()}>停止本 GUI Watcher</Button></Flex>
      <details><summary>Windows Owner 确认引导</summary><Text>GUI_OWNER_CONFIRMATION_NOT_INTEGRATED：缺少有效授权时，由 Owner 在项目目录的交互式 Windows 终端中运行已安装 Client 的命令。确认精确仓库、队列、UTC 到期时间、Codex.exe，以及是否允许 Merge；完成后回到此页查询并启动。</Text><pre>{`awh local-fast watch authorize --repo ${preview?.repository} --issues ${preview?.issues.join(',')} --expires <UTC-date> --executor <absolute-codex.exe> --confirm [--allow-merge]`}</pre><Text>取消、到期、锁占用和完成队列不会被 GUI 自动修复。只可停止本 GUI 启动的进程。</Text></details>
    </>}
    {error&&<Text role="alert" color="red">{error}</Text>}
    <Dialog.Root open={confirmation!==null} onOpenChange={open=>{if(!open&&!busy)setConfirmation(null);}}><Dialog.Content maxWidth="620px" onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>{if(busy)e.preventDefault();}}>
      <Dialog.Title>{confirmation==='start'?'确认启动 Watcher':confirmation==='bind'?'确认新 Local Fast 队列':'确认只读观察已有队列'}</Dialog.Title><Dialog.Description>{preview?.repository} · {preview?.directory}</Dialog.Description>
      {confirmation==='bind'?<div className="enrollment-stack"><label>有序 Issue 列表<TextField.Root aria-label="Local Fast Issue 列表" value={issues} disabled={busy} onChange={e=>setIssues(e.target.value)} placeholder="1,2,3"/></label><label>校验命令（每行一条）<textarea aria-label="Local Fast 校验命令" value={checks} disabled={busy} onChange={e=>setChecks(e.target.value)} placeholder="pnpm typecheck"/></label><label>交付身份<select aria-label="Local Fast 交付身份" value={provider} disabled={busy} onChange={e=>setProvider(e.target.value)}><option value="personal-gh">personal-gh</option><option value="github-app">github-app（已有连接）</option></select></label><Text>将使用已有 Local Fast.bind 校验真实 GitHub Issue 和登录。绑定不启动开发；冲突保留已有队列。</Text></div>:<Text>{confirmation==='start'?'仅使用已保存 Windows Owner scope；其仓库、队列、时效、执行器与 Merge 上限保持不变。':'队列 '+preview?.issues.join(' → ')+' 将关联到 V2；CP Runs 可以为空。'}</Text>}
      {error&&<Text role="alert" color="red">{error}</Text>}<Flex gap="3" justify="end" mt="4"><Button variant="soft" disabled={busy} onClick={()=>setConfirmation(null)}>取消</Button><Button disabled={busy||confirmation==='bind'&&!issues} onClick={()=>void confirm()}>{busy?'正在处理…':'确认'}</Button></Flex>
    </Dialog.Content></Dialog.Root>
  </Card>;
}
