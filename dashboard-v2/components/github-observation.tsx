import { useState } from 'react';
import type { Task } from '../../src/dashboard/tasks.js';
import type { useDashboard } from '../hooks/use-dashboard';
import { Button } from './ui/button';
import { Select } from './select';
import { stamp } from '../lib/task-model.mjs';
export function GitHubObservation({tasks,reader,now}:{tasks:Task[];reader:ReturnType<typeof useDashboard>['reader'];now:number}) {
  const [interval,setInterval]=useState(300),[busy,setBusy]=useState(false),[cooldown,setCooldown]=useState(0),[error,setError]=useState('');
  const refreshes=tasks.map(t=>t.github_refresh),retry=refreshes.flatMap(r=>r.retry_at?[r.retry_at]:[]).sort().at(-1);
  const success=refreshes.flatMap(r=>r.last_success_at?[r.last_success_at]:[]).sort().at(-1)??null;
  const status=busy?'querying':refreshes.some(r=>r.status==='rate_limited')?'rate_limited':refreshes.some(r=>r.status==='failed')?'failed':refreshes.some(r=>r.status==='querying')?'querying':refreshes.some(r=>r.status==='success')?'success':'not_checked';
  const labels:Record<string,string>={querying:'查询中',rate_limited:'限流 / 退避',failed:'失败',success:'成功',not_checked:'未核验'};
  const refresh=async()=>{if(busy)return;setBusy(true);setError('');try{await reader.current?.refreshGitHub();}catch{setError('GitHub 观察请求失败；历史快照仅供查看。');}finally{setBusy(false);setCooldown(Date.now()+10000);}};
  return <><div className="github-observation"><Select label="GitHub 自动刷新" value={interval} onChange={e=>{const value=Number(e.target.value);setInterval(value);reader.current?.setGitHubInterval(value);void reader.current?.refresh();}}><option value={300}>每 5 分钟（默认）</option><option value={60}>每 1 分钟</option><option value={0}>仅手动</option></Select><Button variant="outline" onClick={()=>void refresh()} disabled={busy||now<cooldown||!!retry&&Date.parse(retry)>now}>刷新 GitHub</Button><p className="muted">GitHub：{labels[status]} · 最近实际成功：{stamp(success)}{retry&&<><br/>下次允许查询：{stamp(retry)}</>}</p></div>{error&&<p role="alert" className="notice">{error}</p>}</>;
}
