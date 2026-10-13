import { useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Select } from '../components/select';
import { TaskList,type TaskListProps } from '../components/task-list';
import { filterTasks,taskLabels } from '../lib/task-model.mjs';
export function Tasks({tasks,...props}:TaskListProps) {
  const defaults={search:'',project:'all',stage:'all',role:'all',machine:'all'};
  const [filters,setFilters]=useState(defaults);
  const set=(key:keyof typeof defaults,value:string)=>setFilters(old=>({...old,[key]:value}));
  const filtered=filterTasks(tasks,filters,props.disconnected,props.now);
  return <><div className="filters"><div className="search-field"><Search size={16} aria-hidden="true"/><Input aria-label="搜索任务" placeholder="搜索任务、Issue、PR 或执行者…" value={filters.search} onChange={e=>set('search',e.target.value)}/></div><Select label="项目" value={filters.project} onChange={e=>set('project',e.target.value)}><option value="all">全部项目</option>{[...new Set(tasks.map(t=>t.project_id))].map(id=><option key={id}>{id}</option>)}</Select><Select label="阶段" value={filters.stage} onChange={e=>set('stage',e.target.value)}><option value="all">全部阶段</option>{Object.entries(taskLabels).map(([id,label])=><option value={id} key={id}>{label}</option>)}</Select><Select label="角色" value={filters.role} onChange={e=>set('role',e.target.value)}><option value="all">全部角色</option>{[['coding_executor','Coding Executor'],['reviewer','Reviewer'],['owner','Owner'],['stage','AWH Stage'],['watcher','Watcher']].map(([id,label])=><option value={id} key={id}>{label}</option>)}</Select><Select label="机器" value={filters.machine} onChange={e=>set('machine',e.target.value)}><option value="all">全部机器</option>{[...new Map(tasks.flatMap(t=>t.machine?[[t.machine.id,t.machine.name] as const]:[]))].map(([id,name])=><option key={id} value={id}>{name}</option>)}</Select></div><div className="section-title"><p className="muted" role="status">{filtered.length} / {tasks.length} 个任务</p><Button variant="ghost" onClick={()=>setFilters(defaults)}>清除筛选</Button></div><TaskList tasks={filtered} {...props}/></>;
}
