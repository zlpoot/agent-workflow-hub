import type { GitHubFacts, GitHubRefresh, ObservationOptions, Task } from './tasks.js';

type Native=Record<string,any>;
export interface GitHubReadDependencies { now:()=>number; command:(command:'git'|'gh',args:string[],cwd:string)=>Promise<string> }
export interface GitHubSource { repository:string;root:string }
export class GitHubReadError extends Error {
  constructor(readonly code:'read_failed'|'permission_denied'|'rate_limited',readonly retryAt:number|null=null){super(code);}
}
function headers(text:string):Record<string,string> {
  const result:Record<string,string>={};
  for(const line of text.split(/\r?\n/)){const m=/^([a-z-]+):\s*(.*)$/i.exec(line);if(m)result[m[1]!.toLowerCase()]=m[2]!;}
  return result;
}
export function githubReadFailure(stdout:string,stderr:string,now:number):GitHubReadError {
  const h=headers(stdout),limited=/HTTP[^\r\n]*\b429\b|rate limit|secondary limit/i.test(stdout+'\n'+stderr)||h['x-ratelimit-remaining']==='0';
  if(limited){const after=Number(h['retry-after']),reset=Number(h['x-ratelimit-reset'])*1000,date=Date.parse(h['retry-after']??'');return new GitHubReadError('rate_limited',Math.max(now+60000,Number.isFinite(after)&&after>0?now+after*1000:0,Number.isFinite(reset)?reset:0,Number.isFinite(date)?date:0));}
  return new GitHubReadError(/HTTP (401|403)|authentication|permission|not accessible/i.test(stderr)?'permission_denied':'read_failed');
}
interface RecordEntry {facts:GitHubFacts;at:number}
interface RepositoryEntry {records:Map<string,RecordEntry>;pending:Promise<void>|null;status:GitHubRefresh['status'];lastSuccess:number|null;lastAttempt:number;lastCompleted:number;retryAt:number;failures:number;error:string|null;repositoryId:number|null}
const key=(task:Task)=>`${task.issue.number}:${task.pr?.number??0}`;
const completed=(r:RecordEntry)=>!!r.facts.pr?.merged_at&&r.facts.issue.state==='closed';
const stamp=(n:number|null)=>n===null?null:new Date(n).toISOString();
/** One bounded, shared read cache per installed CLI identity. No persistent scheduler or execution authority. */
export class GitHubObservationCache {
  private repos=new Map<string,RepositoryEntry>();
  private requests:number[]=[];
  private blockedUntil=0;
  private transport:Promise<unknown>=Promise.resolve();
  constructor(private readonly deps:GitHubReadDependencies){}
  private entry(repository:string){let e=this.repos.get(repository);if(!e){e={records:new Map(),pending:null,status:'not_checked',lastSuccess:null,lastAttempt:-Infinity,lastCompleted:-Infinity,retryAt:0,failures:0,error:null,repositoryId:null};this.repos.set(repository,e);}return e;}
  private async api(c:GitHubSource,suffix:string,deadline=Infinity):Promise<any> {
    // Serialize child requests across repositories; don't queue another refresh behind an in-flight repo read.
    const operation=this.transport.catch(()=>{}).then(async()=>{
      const now=this.deps.now();if(now>deadline)throw new GitHubReadError('read_failed');if(now<this.blockedUntil)throw new GitHubReadError('rate_limited',this.blockedUntil);
      this.requests=this.requests.filter(t=>now-t<3600000&&t<=now);
      const minute=this.requests.filter(t=>now-t<60000);
      if(minute.length>=80||this.requests.length>=2400){const until=minute.length>=80?minute[0]!+60000:this.requests[0]!+3600000;this.blockedUntil=until;throw new GitHubReadError('rate_limited',until);}
      this.requests.push(now);
      try {
        const output=await this.deps.command('gh',['api','--include','--method','GET',`repos/${c.repository}${suffix?'/'+suffix:''}`],c.root);
        if(this.deps.now()>deadline)throw new GitHubReadError('read_failed');
        let body=output;
        if(/^HTTP\//.test(output)){
          const split=output.search(/\r?\n\r?\n/);if(split<0)throw new GitHubReadError('read_failed');const h=headers(output.slice(0,split));body=output.slice(split).trim();
          if(h['x-ratelimit-remaining']==='0')this.blockedUntil=Math.max(now+60000,Number(h['x-ratelimit-reset'])*1000||0);
        }
        return JSON.parse(body);
      }catch(error){if(error instanceof GitHubReadError&&error.code==='rate_limited')this.blockedUntil=Math.max(this.blockedUntil,error.retryAt??now+60000);throw error;}
    });
    this.transport=operation;return operation;
  }
  private async pages(c:GitHubSource,suffix:string,deadline:number){const values:Native[]=[];for(let page=1;page<=10;page++){const rows=await this.api(c,`${suffix}?per_page=100&page=${page}`,deadline);if(!Array.isArray(rows)||rows.length>100)throw new GitHubReadError('read_failed');values.push(...rows);if(rows.length<100)return values;}throw new GitHubReadError('read_failed');}
  private async facts(c:GitHubSource,t:Task,deadline:number):Promise<GitHubFacts>{
    const issue=await this.api(c,`issues/${t.issue.number}`,deadline);if(!t.pr)return {issue};
    const pr=await this.api(c,`pulls/${t.pr.number}`,deadline);if(!/^[a-f0-9]{40}$/.test(pr.head?.sha))throw new GitHubReadError('read_failed');
    const reviews=await this.pages(c,`pulls/${t.pr.number}/reviews`,deadline),status=await this.api(c,`commits/${pr.head.sha}/status`,deadline);
    const runs:Native[]=[];
    for(let page=1;page<=10;page++){const checks=await this.api(c,`commits/${pr.head.sha}/check-runs?per_page=100&page=${page}&filter=latest`,deadline);if(!Array.isArray(checks.check_runs)||!Number.isSafeInteger(checks.total_count))throw new GitHubReadError('read_failed');runs.push(...checks.check_runs);if(runs.length>=checks.total_count)break;if(page===10)throw new GitHubReadError('read_failed');}
    if(!Array.isArray(status.statuses)||status.statuses.length!==status.total_count||!status.statuses.every((s:Native)=>['success','pending','failure','error'].includes(s.state))||!runs.every(r=>['queued','in_progress','completed','waiting','requested','pending'].includes(r.status)))throw new GitHubReadError('read_failed');
    const failed=status.statuses.some((s:Native)=>['failure','error'].includes(s.state))||runs.some(r=>r.status==='completed'&&!['success','neutral','skipped'].includes(r.conclusion));
    const waiting=status.statuses.some((s:Native)=>s.state==='pending')||runs.some(r=>r.status!=='completed');
    const again=await this.api(c,`pulls/${t.pr.number}`,deadline);if(again.head?.sha!==pr.head.sha||again.state!==pr.state||again.merged_at!==pr.merged_at)throw new GitHubReadError('read_failed');
    const count=runs.length+status.statuses.length;
    return {issue,pr,reviews,checks:{status:failed?'failed':waiting?'pending':count?'passed':'none',count}};
  }
  async observe(c:GitHubSource,tasks:readonly Task[],options:ObservationOptions={}):Promise<void>{
    if(!tasks.length)return;
    const e=this.entry(c.repository),now=this.deps.now(),interval=options.github_interval_seconds??300;
    if(e.pending){if(options.refresh_github)await e.pending;return;}
    if(e.failures>=6&&!options.refresh_github)return;
    if(now<Math.max(e.retryAt,this.blockedUntil)){if(now<this.blockedUntil)e.status='rate_limited';return;}
    const force=!!options.refresh_github&&now-e.lastCompleted>=10000;
    const due=[...new Map(tasks.map(t=>[key(t),t])).values()].filter(t=>{const r=e.records.get(key(t));return force||interval!==0&&(!r||now-r.at<0||now-r.at>=(completed(r)?3600000:interval*1000));}).sort((a,b)=>Number(e.records.has(key(a)))-Number(e.records.has(key(b)))).slice(0,12);
    if(!due.length||now<e.retryAt)return;
    e.status='querying';e.lastAttempt=now;
    e.pending=(async()=>{
      try{
        const deadline=e.lastAttempt+45000;
        const meta=await this.api(c,'',deadline);if(!Number.isSafeInteger(meta.id)||meta.id<1||meta.full_name!==c.repository)throw new GitHubReadError('read_failed');
        e.repositoryId=meta.id;
        // Each complete fact tuple has its own native HEAD readback. Local reads never write this cache.
        for(const t of due){const facts=await this.facts(c,t,deadline),at=this.deps.now();e.records.set(key(t),{facts,at});e.lastSuccess=at;}
        e.status='success';e.error=null;e.failures=0;e.retryAt=0;
      }catch(error){
        e.failures++;const rate=error instanceof GitHubReadError&&error.code==='rate_limited';e.status=rate?'rate_limited':'failed';e.error=error instanceof GitHubReadError?error.code:error instanceof Error&&error.message==='permission_denied'?'permission_denied':'read_failed';
        e.retryAt=Math.max(this.deps.now()+Math.min(3600000,60000*2**Math.min(e.failures-1,6)),rate?(error.retryAt??0):0);if(rate)this.blockedUntil=Math.max(this.blockedUntil,e.retryAt);
      }finally{e.lastCompleted=this.deps.now();e.pending=null;}
    })();
    if(options.refresh_github)await e.pending;
  }
  read(repository:string,task:Task,interval:0|60|300=300){
    const e=this.entry(repository),record=e.records.get(key(task)),now=this.deps.now();
    const retry=Math.max(e.retryAt,this.blockedUntil),status=now<retry&&e.status!=='querying'?(this.blockedUntil>now?'rate_limited':e.status):e.status;
    const refresh:GitHubRefresh={status,last_success_at:stamp(e.lastSuccess),retry_at:retry>now?stamp(retry):null,interval_seconds:interval};
    const maxAge=record&&completed(record)?3600000:(interval||300)*1000+15000;
    return {record,repositoryId:e.repositoryId,refresh,error:e.error,fresh:!!record&&now-record.at>=0&&now-record.at<=maxAge&&!['failed','rate_limited'].includes(status),gateFresh:!!record&&now-record.at>=0&&now-record.at<=(interval||300)*1000+15000&&!['failed','rate_limited'].includes(status)};
  }
}
const shared=new WeakMap<GitHubReadDependencies['command'],GitHubObservationCache>();
export function sharedGitHubCache(deps:GitHubReadDependencies){let cache=shared.get(deps.command);if(!cache){cache=new GitHubObservationCache(deps);shared.set(deps.command,cache);}return cache;}
