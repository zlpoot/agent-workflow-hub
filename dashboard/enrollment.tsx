import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Dialog, Flex, Heading, Text, TextField } from '@radix-ui/themes';

type Preview = {repository:string;branch:string;head:string;dirty:boolean;worktree:string;project_id:string;machine:{id:string;platform:string};executor_id:string;status:string;request_file:string|null;mode:string};
const policyKey = (policy:{id:string;version:string}) => JSON.stringify([policy.id,policy.version]);
export function Enrollment({onConnected}:{onConnected:(project:string)=>void}) {
  const [directory,setDirectory] = useState(''), [directories,setDirectories] = useState<string[]>([]), [roots,setRoots] = useState<string[]>([]);
  const [preview,setPreview] = useState<Preview|null>(null),[busy,setBusy] = useState(false),[running,setRunning] = useState(false),[error,setError] = useState(''),[available,setAvailable] = useState<boolean|null>(null);
  const [mode,setMode] = useState('observe'),[policies,setPolicies] = useState<any[]>([]),[selection,setSelection] = useState(''),[diagnosis,setDiagnosis] = useState<any>(null),[repair,setRepair] = useState<any>(null),[bindings,setBindings] = useState<any[]>([]);
  const [ownerAvailable,setOwnerAvailable] = useState(false);
  const [confirmation,setConfirmation] = useState<'connect'|'repair'|null>(null);
  const abort = useRef<AbortController|null>(null), operation = useRef(false);
  const disabled = busy || running;
  const call = async (action:string,data:Record<string,unknown>) => {
    abort.current?.abort();const controller = abort.current = new AbortController();setBusy(true);setError('');
    try {
      const response = await fetch('/dashboard/enrollment/v1/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal});
      if (response.status === 404) {setAvailable(false);return null;}
      if (response.status === 401) throw new Error('会话已到期，请点击顶部“重新进入 Dashboard”。');
      const result = await response.json();
      if (!response.ok || result.authority_verified !== false || !result.item) {
        if (result.error?.code === 'owner_cancelled') throw new Error('已取消管理员批准，接入申请保留。');
        if (result.error?.code === 'owner_approval_failed') throw new Error('管理员批准未完成。请核对本机确认框和管理员设置。');
        if (action === 'connect' && result.error?.code === 'authentication') throw new Error('尚未取得有效的 CP 批准。请管理员核对接入申请，批准后点击“完成接入”。');
        throw new Error('接入未完成：'+(result.error?.code ?? 'unavailable')+'。请展开“详情与诊断”核对。');
      }
      setAvailable(true);return result.item;
    } catch(e) {if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '本机接入不可用');return null;}
    finally {if (!controller.signal.aborted) setBusy(false);}
  };
  const flow = async (work:()=>Promise<void>) => {
    if (operation.current) return;
    operation.current=true;setRunning(true);
    try {await work();} finally {operation.current=false;setRunning(false);}
  };
  const browse = async (path?:string) => {const value = await call('browse',path ? {directory:path} : {});if (value) {setRoots(value.roots);setDirectories(value.directories);if (value.current) {setDirectory(value.current);setPreview(null);setDiagnosis(null);setRepair(null);}}};
  useEffect(() => {void flow(async () => {await browse();const result = await call('bindings',{});if(result)setBindings(result.items);const owner=await call('owner-capabilities',{});if(owner)setOwnerAvailable(owner.enabled === true);});return () => abort.current?.abort();},[]);
  const prepare = () => flow(async () => {
    setPreview(null);setDiagnosis(null);setRepair(null);setPolicies([]);setSelection('');
    const p = await call('inspect',{directory});
    if (p) {setPreview(p);setMode(p.mode);const result = await call('policies',{directory});if(result){setPolicies(result.items);setSelection(result.items[0] ? policyKey(result.items[0]) : '');}setConfirmation('connect');}
  });
  const selectedPolicy = policies.find(w => policyKey(w) === selection);
  const complete = () => flow(async () => {
    if (!preview || confirmation === null || mode === 'develop' && preview.status === 'confirmation_required' && !selectedPolicy) return;
    const target=preview.worktree;
    let current=preview;
    if (confirmation === 'connect' && current.status === 'confirmation_required') {
      const requested=await call('request',{directory:target,mode,...(mode === 'develop' ? {work_item:{id:selectedPolicy.id,version:selectedPolicy.version}} : {})});
      if (!requested) return;
      current=requested;setPreview(current);
    }
    const connected=await call(confirmation === 'repair' ? 'repair' : 'connect',{directory:target});
    if (connected) {
      setPreview(connected);setConfirmation(null);setRepair(null);onConnected(connected.project_id);
      const result=await call('bindings',{});if(result)setBindings(result.items);
    } else if (current.status === 'approval_required') {setConfirmation(null);}
  });
  const approveAndConnect = () => flow(async () => {
    if (!preview || !ownerAvailable || preview.status !== 'approval_required') return;
    const target=preview.worktree;
    const approved=await call('owner-approve',{directory:target});
    if (!approved || approved.status !== 'approved') return;
    const connected=await call('connect',{directory:target});
    if (connected) {setPreview(connected);onConnected(connected.project_id);const result=await call('bindings',{});if(result)setBindings(result.items);}
    else {setPreview({...preview,status:'configured'});}
  });
  if (available === false) return <Card><Heading size="4">新增本机项目</Heading><Text>当前设备尚未完成接入设置。请管理员完成一次 Client 设置后再添加项目。</Text></Card>;
  return <Card className="wizard-stack" aria-label="新增本机项目">
    <Heading size="5">添加本机项目</Heading><Text>选择项目目录，点击接入，再确认即可。默认仅观察。</Text>
    <Badge>当前机器 · 已安装 Client</Badge>
    <Flex gap="2" wrap="wrap">{roots.map(root => <Button variant="soft" key={root} disabled={disabled} onClick={() => void flow(() => browse(root))}>{root}</Button>)}</Flex>
    <label className="enrollment-field">项目目录<TextField.Root aria-label="新增项目目录" value={directory} disabled={disabled} onChange={e => {setDirectory(e.target.value);setPreview(null);setDiagnosis(null);setRepair(null);setError('');}} /></label>
    <Flex gap="2" wrap="wrap"><Button variant="soft" disabled={disabled || !directory} onClick={() => void flow(() => browse(directory))}>浏览目录</Button><Button disabled={disabled || !directory} onClick={() => void prepare()}>{disabled ? '正在处理…' : preview?.status === 'approval_required' || preview?.status === 'configured' ? '完成接入' : preview?.status === 'registered' ? '重新检查接入' : '接入项目'}</Button></Flex>
    {directories.length > 0 && <details open><summary>选择子目录</summary><Flex gap="2" wrap="wrap">{directories.map(path => <Button variant="soft" key={path} disabled={disabled} onClick={() => void flow(() => browse(path))}>{path.split(/[\\/]/).at(-1)}</Button>)}</Flex></details>}
    {error && confirmation === null && <div className="notice" role="alert">{error}</div>}
    {preview && <>
      <Text weight="medium">{preview.repository} · {preview.branch}</Text>
      {preview.status === 'approval_required' && <div className="notice" role="status">{ownerAvailable ? '申请已提交。点击“管理员批准并接入”，在 Windows 确认框中批准后即可继续。' : '申请已提交，等待管理员批准。批准后点击“完成接入”，无需重新申请。'}</div>}
      {preview.status === 'approval_required' && ownerAvailable && <Button disabled={disabled} onClick={() => void approveAndConnect()}>{disabled ? '等待管理员确认…' : '管理员批准并接入…'}</Button>}
      {preview.status === 'approval_required' && running && <Text role="status">请查看 Windows 弹出的“AWH 管理员批准接入”窗口。若未在前台，可用 Alt+Tab 切换；取消或三分钟超时后会返回此页。</Text>}
      {preview.status === 'configured' && <Text>本机已有批准记录，点击“完成接入”核对并恢复连接。</Text>}
      {preview.status === 'registered' && <Text color="teal" role="status">已完成登记，正在启动连接。请到 Executor 查看实际在线状态。</Text>}
      <details><summary>详情与诊断</summary><div className="wizard-stack enrollment-details">
        <dl className="wizard-facts"><dt>项目目录</dt><dd>{preview.worktree}</dd><dt>Project</dt><dd>{preview.project_id}</dd><dt>Machine</dt><dd>{preview.machine.id} · {preview.machine.platform}</dd><dt>Executor</dt><dd>{preview.executor_id}</dd></dl>
        {preview.request_file && <Text>管理员申请文件：<code>{preview.request_file}</code></Text>}
        {preview.status !== 'confirmation_required' && <Flex gap="2" wrap="wrap"><Button variant="soft" disabled={disabled} onClick={() => void flow(async () => {setDiagnosis(await call('doctor',{directory:preview.worktree}));})}>Doctor 检查</Button><Button variant="soft" disabled={disabled} onClick={() => void flow(async () => {setRepair(await call('plan',{directory:preview.worktree}));})}>预览 Doctor 修复</Button></Flex>}
        {repair && <div className="notice">修复会核对批准、恢复缺失配置并重试接入。<Button disabled={disabled} onClick={() => setConfirmation('repair')}>修复接入…</Button></div>}
        {diagnosis && <div>{diagnosis.checks?.map((c:any) => <p key={c.id}>{c.id} · {c.status} · {c.code} — {c.safe_next_step}</p>)}</div>}
      </div></details>
    </>}
    <Dialog.Root open={confirmation !== null} onOpenChange={open => {if (!open && !disabled) setConfirmation(null);}}><Dialog.Content maxWidth="560px" onEscapeKeyDown={e => {if(disabled)e.preventDefault();}} onPointerDownOutside={e => {if(disabled)e.preventDefault();}}>
      <Dialog.Title>{confirmation === 'repair' ? '确认修复接入' : '确认接入项目'}</Dialog.Title>
      <Dialog.Description>{confirmation === 'repair' ? '核对管理员批准并恢复接入。现有身份和本机改动将保留。' : '将这个本机项目接入 AWH，保留现有身份和本机改动。'}</Dialog.Description>
      {preview && <div className="wizard-stack enrollment-details">
        <dl className="wizard-facts"><dt>仓库</dt><dd>{preview.repository}</dd><dt>分支</dt><dd>{preview.branch}</dd><dt>目录</dt><dd>{preview.worktree}</dd></dl>
        <Text>接入方式：{mode === 'observe' ? '仅观察' : '受信开发准备'}。批准后会生成缺失接入文件，并登记、启动心跳；不会启动开发任务或 Deliver。</Text>
        {preview.dirty && <Text>目录有本机改动，将保留。</Text>}
        {preview.status === 'confirmation_required' && confirmation === 'connect' && <details><summary>高级选项</summary><div className="wizard-stack enrollment-details">
          <label className="enrollment-field">接入能力<select className="enrollment-select" aria-label="新增项目能力" value={mode} disabled={disabled} onChange={e => setMode(e.target.value)}><option value="observe">仅观察</option><option value="develop">受信开发准备</option></select></label>
          {mode === 'develop' && <><label className="enrollment-field">已批准任务<select className="enrollment-select" aria-label="批准任务" aria-describedby={policies.length === 0 ? 'approved-task-help' : undefined} value={selection} disabled={disabled || policies.length === 0} onChange={e => setSelection(e.target.value)}>{policies.length === 0 && <option value="">暂无已批准任务</option>}{policies.map(w => <option key={policyKey(w)} value={policyKey(w)}>#{w.issue} · {w.branch} · {w.version}</option>)}</select></label>{policies.length === 0 && <Text id="approved-task-help" color="red">当前项目和分支没有已批准的开发任务。请选择仅观察，或请管理员批准任务。</Text>}</>}
        </div></details>}
        {preview.status === 'confirmation_required' || preview.status === 'approval_required' ? <Text size="2">尚未获批时会显示“等待管理员批准”，不会自动授予权限。</Text> : null}
      </div>}
      {error && <div className="notice enrollment-details" role="alert">{error}</div>}
      <Flex gap="3" justify="end" mt="4"><Button variant="soft" disabled={disabled} onClick={() => setConfirmation(null)}>取消</Button><Button disabled={disabled || mode === 'develop' && preview?.status === 'confirmation_required' && !selectedPolicy} onClick={() => void complete()}>{disabled ? '正在处理…' : confirmation === 'repair' ? '确认修复' : '确认接入'}</Button></Flex>
    </Dialog.Content></Dialog.Root>
    {bindings.length > 0 && <details><summary>已接入项目（{bindings.length}）</summary>{bindings.map(b => <p key={b.worktree_id}>{b.worktree} · {b.project_id}（在线状态见 Executor）</p>)}</details>}
  </Card>;
}
