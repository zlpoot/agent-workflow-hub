import {useState} from 'react';
import {Card} from './ui/card';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {validQueue} from '../lib/local-fast-model.mjs';
import {stamp} from '../lib/task-model.mjs';

export type IssuePage={repository:string;items:{number:number;title:string;state:string;url:string}[];page:number;next_page:number|null;observed_at:string};
export function IssueQueue({repository,value,setValue,page,busy,query,saveDraft,saveQueue,bound,editable,unstarted,current,associated}:{repository:string;value:string;setValue:(value:string)=>void;page:IssuePage|null;busy:boolean;query:(page:number)=>void;saveDraft:()=>void;saveQueue:()=>void;bound:boolean;editable:boolean;unstarted:boolean;current:number[];associated:boolean}){
 const [search,setSearch]=useState('');
 const numbers=validQueue(value)?value.split(',').map(Number):[];
 const move=(index:number,offset:number)=>{const copy=[...numbers];[copy[index],copy[index+offset]]=[copy[index+offset],copy[index]];setValue(copy.join(','));};
 const items=page?.items.filter(i=>(i.number+' '+i.title).toLowerCase().includes(search.toLowerCase()))??[];
 return <Card className="detail-card project-stack" aria-label="Issue 查询与队列编辑"><div className="section-title"><div><h2>GitHub Issues 与候选队列</h2><p className="muted">查询已有 OPEN Issue，按你选择的顺序逐项执行。</p></div><Button variant="outline" disabled={busy} onClick={()=>query(1)}>查询 / 刷新 Issues</Button></div>
  <Input aria-label="筛选本页 Issue" placeholder="筛选本页：编号或标题" value={search} onChange={e=>setSearch(e.target.value)}/>
  {page&&<><p className="muted">GitHub 读取：{stamp(page.observed_at)} · 第 {page.page} 页，每页最多 50 条。</p><ul className="project-stack" aria-label="GitHub OPEN Issues">{items.map(item=><li key={item.number} className="flex flex-wrap items-center justify-between gap-2"><a href={item.url} target="_blank" rel="noopener noreferrer">#{item.number} {item.title}</a><Button variant="outline" disabled={busy||numbers.includes(item.number)||numbers.length>=128||bound&&!unstarted&&current.includes(item.number)} onClick={()=>setValue([...numbers,item.number].join(','))}>{numbers.includes(item.number)?`Issue #${item.number} 已加入`:`加入 Issue #${item.number}`}</Button></li>)}</ul>{!items.length&&<p className="muted">本页没有匹配的 OPEN Issue。</p>}<div className="flex gap-2"><Button variant="outline" disabled={busy||page.page===1} onClick={()=>query(page.page-1)}>上一页 Issues</Button><Button variant="outline" disabled={busy||!page.next_page} onClick={()=>query(page.next_page!)}>下一页 Issues</Button></div></>}
  <h3>候选队列 · 执行顺序</h3><p className="muted">保存候选队列会保留你的选择和顺序。确认执行队列后，还需本轮 Windows Owner 授权才能启动。</p>
  <Input aria-label="候选 Issue 队列" placeholder="也可输入 5,6" disabled={busy} value={value} onChange={e=>setValue(e.target.value)}/>
  {value&&!validQueue(value)&&<p role="alert">请输入不重复的正整数 Issue 编号，以逗号分隔。</p>}
  <ol className="project-stack" aria-label="候选队列顺序">{numbers.map((number,index)=><li className="flex flex-wrap items-center justify-between gap-2" key={number}><a href={`https://github.com/${repository}/issues/${number}`} target="_blank" rel="noopener noreferrer">{index+1}. Issue #{number}{page?.items.find(i=>i.number===number)?.title&&' · '+page.items.find(i=>i.number===number)!.title}</a><div className="flex gap-2"><Button variant="outline" aria-label={`上移 Issue #${number}`} disabled={busy||index===0} onClick={()=>move(index,-1)}>上移</Button><Button variant="outline" aria-label={`下移 Issue #${number}`} disabled={busy||index===numbers.length-1} onClick={()=>move(index,1)}>下移</Button><Button variant="outline" aria-label={`移除 Issue #${number}`} disabled={busy} onClick={()=>setValue(numbers.filter(n=>n!==number).join(','))}>移除</Button></div></li>)}</ol>
  {!numbers.length&&<p className="muted">候选队列为空。点击 Issue 旁的“加入”按钮。</p>}
  <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy||!!value&&!validQueue(value)} onClick={saveDraft}>保存候选队列</Button>{bound&&unstarted&&<Button variant="outline" disabled={busy} onClick={()=>setValue(current.join(','))}>复制当前队列到候选队列</Button>}{bound&&<Button disabled={busy||!validQueue(value)||!editable||!associated} onClick={saveQueue}>预览保存执行队列…</Button>}</div>
  {bound&&!editable&&<p className="notice">当前执行队列尚未完成。候选队列可以编辑、排序和保存，执行队列在完成后才能切换下一轮。</p>}
 </Card>;
}
