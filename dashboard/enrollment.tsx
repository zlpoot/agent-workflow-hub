import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Flex, Heading, Text, TextField } from '@radix-ui/themes';

type Preview = {repository:string;branch:string;head:string;dirty:boolean;worktree:string;project_id:string;machine:{id:string;platform:string};executor_id:string;status:string;request_file:string|null;mode:string};
export function Enrollment({onConnected}:{onConnected:(project:string)=>void}) {
  const [directory,setDirectory] = useState(''), [directories,setDirectories] = useState<string[]>([]), [roots,setRoots] = useState<string[]>([]);
  const [preview,setPreview] = useState<Preview|null>(null),[busy,setBusy] = useState(false),[error,setError] = useState(''),[available,setAvailable] = useState<boolean|null>(null);
  const [mode,setMode] = useState('observe'),[policies,setPolicies] = useState<any[]>([]),[selection,setSelection] = useState(''),[confirmed,setConfirmed] = useState(false),[diagnosis,setDiagnosis] = useState<any>(null),[repair,setRepair] = useState<any>(null),[bindings,setBindings] = useState<any[]>([]);
  const abort = useRef<AbortController|null>(null);
  const call = async (action:string,data:Record<string,unknown>) => {
    abort.current?.abort();const controller = abort.current = new AbortController();setBusy(true);setError('');
    try {
      const response = await fetch('/dashboard/enrollment/v1/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal});
      if (response.status === 404) {setAvailable(false);return null;}
      if (response.status === 401) throw new Error('会话已到期，请点击顶部“重新进入 Dashboard”。');
      const result = await response.json();
      if (!response.ok || result.authority_verified !== false || !result.item) throw new Error('接入未完成：'+(result.error?.code ?? 'unavailable')+'。请核对 CP 批准或机器安装设置。');
      setAvailable(true);return result.item;
    } catch(e) {if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '本机接入不可用');return null;}
    finally {if (!controller.signal.aborted) setBusy(false);}
  };
  const browse = async (path?:string) => {const value = await call('browse',path ? {directory:path} : {});if (value) {setRoots(value.roots);setDirectories(value.directories);if (value.current) setDirectory(value.current);}};
  useEffect(() => {void browse().then(async () => {const result = await call('bindings',{});if(result)setBindings(result.items);});return () => abort.current?.abort();},[]);
  const inspect = async () => {setPreview(null);setDiagnosis(null);setRepair(null);setConfirmed(false);const p = await call('inspect',{directory});if (p) {setPreview(p);setMode(p.mode);const result = await call('policies',{directory});if(result){setPolicies(result.items);setSelection(result.items[0]?.id ?? '');}}};
  if (available === false) return <Card><Heading size="4">新增本机项目</Heading><Text>当前 Viewer 尚未启用机器初始化配置。请管理员完成一次 Client setup 并配置 Viewer；已有项目诊断仍可使用。</Text></Card>;
  return <Card className="wizard-stack" aria-label="新增本机项目">
    <Heading size="5">添加本机项目</Heading><Text>选择目录 → 确认信息 → 选择能力和授权 → 接入并查看在线状态</Text>
    <Badge>当前机器 · 已安装 Client</Badge>
    <Flex gap="2" wrap="wrap">{roots.map(root => <Button variant="soft" key={root} disabled={busy} onClick={() => void browse(root)}>{root}</Button>)}</Flex>
    <label>项目目录<TextField.Root aria-label="新增项目目录" value={directory} onChange={e => {setDirectory(e.target.value);setPreview(null);setConfirmed(false);}} /></label>
    <Flex gap="2" wrap="wrap"><Button variant="soft" disabled={busy || !directory} onClick={() => void browse(directory)}>浏览目录</Button><Button disabled={busy || !directory} onClick={() => void inspect()}>识别项目</Button></Flex>
    {directories.length > 0 && <details open><summary>选择子目录</summary><Flex gap="2" wrap="wrap">{directories.map(path => <Button variant="soft" key={path} disabled={busy} onClick={() => {setDirectory(path);setPreview(null);setConfirmed(false);void browse(path);}}>{path.split(/[\\/]/).at(-1)}</Button>)}</Flex></details>}
    {error && <div className="notice" role="alert">{error}</div>}
    {preview && <>
      <dl><dt>仓库</dt><dd>{preview.repository}</dd><dt>分支</dt><dd>{preview.branch}</dd><dt>Project</dt><dd>{preview.project_id}（CP 批准时核对全局项目）</dd><dt>Machine</dt><dd>{preview.machine.id} · {preview.machine.platform}</dd><dt>Worktree</dt><dd>{preview.worktree}</dd><dt>Executor</dt><dd>{preview.executor_id}</dd></dl>
      {preview.dirty && <Text>目录有本机改动，将保留；仅观察接入允许此状态。</Text>}
      <label>接入能力 <select aria-label="新增项目能力" value={mode} disabled={preview.status !== 'confirmation_required'} onChange={e => setMode(e.target.value)}><option value="observe">仅观察</option><option value="develop">受信开发准备</option></select></label>
      {mode === 'develop' && <><label>已批准任务 <select aria-label="批准任务" value={selection} onChange={e => setSelection(e.target.value)}>{policies.map(w => <option key={w.id} value={w.id}>#{w.issue} · {w.branch} · {w.version}</option>)}</select></label>{policies.length === 0 && <Text color="red">当前分支没有已批准的开发任务。可以选择仅观察，或请求管理员批准。</Text>}<Text>接入仍只登记与心跳，不启动任务或 Deliver。</Text></>}
      <Text>必要授权：新增专用 Client / Executor 绑定；缺失时生成最小 Manifest 和仓库外项目配置。CP 管理员批准后才登记，现有项目身份和业务历史保留。</Text>
      <label><input type="checkbox" aria-label="确认新增项目授权" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我确认上述信息和接入操作</label>
      {preview.status === 'confirmation_required' && <Button disabled={busy || !confirmed || mode === 'develop' && policies.length === 0} onClick={() => {const w = policies.find(w => w.id === selection);void call('request',{directory,mode,...(mode === 'develop' ? {work_item:{id:w.id,version:w.version}} : {})}).then(p => {if(p)setPreview(p);});}}>提交接入申请</Button>}
      {preview.request_file && preview.status !== 'registered' && <div className="notice">等待 CP 管理员批准。申请文件：{preview.request_file}。无需复制凭据或修改项目源码。</div>}
      {preview.status !== 'confirmation_required' && <Flex gap="2" wrap="wrap"><Button disabled={busy || !confirmed} onClick={() => {void call('connect',{directory}).then(p => {if(p){setPreview(p);onConnected(p.project_id);}});}}>批准后确认接入 / 重试</Button><Button variant="soft" disabled={busy} onClick={() => {void call('doctor',{directory}).then(setDiagnosis);}}>Doctor 检查</Button><Button variant="soft" disabled={busy} onClick={() => {setConfirmed(false);void call('plan',{directory}).then(setRepair);}}>预览 Doctor 修复</Button></Flex>}
      {repair && <div className="notice">将核对 CP 批准，恢复缺失 Manifest / 项目配置，并重试登记和心跳；不替换冲突配置或清理业务历史。<Button disabled={busy || !confirmed} onClick={() => {void call('repair',{directory}).then(p => {if(p){setPreview(p);onConnected(p.project_id);}});}}>确认执行修复</Button></div>}
      {preview.status === 'registered' && <Text color="teal">已完成登记，Resident 正在启动。请查看 Executor 的实际在线状态。</Text>}
      {diagnosis && <div>{diagnosis.checks?.map((c:any) => <p key={c.id}>{c.id} · {c.status} · {c.code} — {c.safe_next_step}</p>)}</div>}
    </>}
    {bindings.length > 0 && <details><summary>本机已接入 Project / Machine / Worktree / Executor</summary>{bindings.map(b => <p key={b.worktree_id}>{b.project_id} · {b.machine_id} · {b.worktree} · {b.executor_id}（在线状态见执行器视图）</p>)}</details>}
  </Card>;
}
