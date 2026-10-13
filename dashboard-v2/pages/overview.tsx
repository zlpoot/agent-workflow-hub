import { ArrowRight,Layers,Users,Activity } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { TaskList,type TaskListProps } from '../components/task-list';
import { taskFacts } from '../lib/task-model.mjs';
import type { Snapshot } from '../hooks/use-dashboard';
export function Overview({tasks,open,disconnected,now,snapshot,showTasks}:TaskListProps&{snapshot:Snapshot;showTasks:()=>void}) {
  const counts=[['开发中',tasks.filter(t=>['developing','verifying','merging'].includes(taskFacts(t,disconnected,now).state)).length],['等待独立 Review',tasks.filter(t=>taskFacts(t,disconnected,now).state==='awaiting_review').length],['阻塞 / 待处理',tasks.filter(t=>['blocked','unknown','changes_requested'].includes(taskFacts(t,disconnected,now).state)).length],['已完成',tasks.filter(t=>taskFacts(t,disconnected,now).state==='completed').length]] as const;
  const pending=tasks.filter(t=>taskFacts(t,disconnected,now).state!=='completed'&&(t.waiting_for||taskFacts(t,disconnected,now).state==='unknown'));
  return <><div className="metrics">{counts.map(([label,count],i)=><Card key={label} className={`metric metric-${i}`}><span className="muted">{label}</span><strong>{disconnected?'—':count.toString().padStart(2,'0')}</strong><span className="muted text-xs">{disconnected?'历史快照 · 当前未知':'当前查看范围'}</span></Card>)}</div>
    <div className="section-title"><div><h2>下一步，从这里开始</h2><p className="muted">等待责任方与可核验的下一动作</p></div><Button variant="ghost" onClick={showTasks}>全部任务 <ArrowRight aria-hidden="true"/></Button></div><TaskList tasks={pending.slice(0,4)} open={open} disconnected={disconnected} now={now}/>
    <div className="inventory"><Card><Layers aria-hidden="true"/><div><h3>项目概况</h3><p>{new Set([...snapshot.projects.map(p=>p.id),...tasks.map(t=>t.project_id)]).size} 个项目 · {tasks.length} 个任务</p><p className="muted">CP 注册 / Owner 配置的本机队列</p></div></Card><Card><Users aria-hidden="true"/><div><h3>执行者概况</h3><p>{snapshot.executors.length} 个注册执行者 · {new Set(tasks.flatMap(t=>t.executor?[t.executor]:[])).size} 个任务执行者声明</p><p className="muted">仅注册和任务声明；不代表当前在线</p></div></Card><Card><Activity aria-hidden="true"/><div><h3>观察链路</h3><p>REST 快照 + SSE 失效通知</p><p className="muted">本机状态每 10 秒观察 · GitHub 授权未核验</p></div></Card></div>
    <div className="section-title"><div><h2>最近任务</h2><p className="muted">按已有记录的更新时间排列</p></div></div><TaskList tasks={[...tasks].sort((a,b)=>(b.updated_at??'').localeCompare(a.updated_at??'')).slice(0,5)} open={open} disconnected={disconnected} now={now}/></>;
}
