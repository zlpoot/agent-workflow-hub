import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fail, validId, safeData } from '../shared/security.js';
import { externalPath } from '../shared/external-files.js';
import { actor, applyGitHub, observation, taskBase, type ObservationOptions, type Task, type TaskAdapter } from './tasks.js';

export interface LocalFastObservationConfig {
  project_id: string; repository: string; root: string;
  watcher_directory?: string; machine: { id: string; name: string; platform: string }; executor_name?: string;
}
export type GitHubObservationConfig = Pick<LocalFastObservationConfig,'project_id'|'repository'|'root'>;
import { sharedGitHubCache, githubReadFailure } from './github-observation-cache.js';

type Native = Record<string, any>;
export interface ObservationDependencies {
  now: () => number; alive: (pid: number) => boolean | null;
  command: (command: 'git'|'gh', args: string[], cwd: string) => Promise<string>;
}
const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AWH_|GH_TOKEN$|GITHUB_TOKEN$|GIT_CONFIG|NODE_OPTIONS$)/i.test(k)));
const defaults: ObservationDependencies = {
  now: Date.now, alive: pid => { try {process.kill(pid,0);return true;} catch(error) {return (error as NodeJS.ErrnoException).code==='ESRCH'?false:null;} },
  command: (command,args,cwd) => new Promise((resolve,reject) => {
    execFile(command,args,{cwd,env:{...env(),GH_HOST:'github.com',GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0'},windowsHide:true,timeout:10000,maxBuffer:2*1024*1024},(error,stdout,stderr)=>{
      if (error) reject(githubReadFailure(stdout,stderr,Date.now()));
      else resolve(stdout.trim());
    });
  })
};
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v)>0;
/** Refuse redirection and bound file sizes. The only repository file names come from the adapter. */
function file(path: string, max = 512*1024): Native {
  for (let p=path;;p=dirname(p)) { if (lstatSync(p).isSymbolicLink()) throw new Error('redirected_file'); if (dirname(p)===p) break; }
  const info=lstatSync(path); if (!info.isFile() || info.size>max || !info.size) throw new Error('invalid_file');
  return JSON.parse(readFileSync(path,'utf8'));
}
function safeLabel(value: unknown, max = 160): string {
  safeData(value);
  if (typeof value !== 'string' || !value || value.length>max || /[\x00-\x1f]|(?:gh[psuor]_|github_pat_|awh_cp_)|PRIVATE KEY|[A-Z]:[\\/]|\\\\/i.test(value)) throw new Error('invalid_label');
  return value;
}
export function validateObservationConfigs(configs: LocalFastObservationConfig[], projectIds: readonly string[]) {
  if (!Array.isArray(configs) || configs.length>32) fail(500,'configuration','Invalid observation configuration');
  const ids=new Set();
  for (const c of configs) {
    if (!c || Object.keys(c).some(k=>!['project_id','repository','root','watcher_directory','machine','executor_name'].includes(k)) || !validId(c.project_id) || !projectIds.includes(c.project_id) ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(c.repository) || c.repository.includes('..') || !isAbsolute(c.root) || !c.machine || Object.keys(c.machine).sort().join(',')!=='id,name,platform' || !validId(c.machine.id) || ids.has(c.project_id)) fail(500,'configuration','Invalid explicit observation scope');
    safeLabel(c.machine.name);safeLabel(c.machine.platform);if(c.executor_name)safeLabel(c.executor_name);
    if (realpathSync(c.root).toLowerCase()!==resolve(c.root).toLowerCase()) fail(500,'configuration','Observation root cannot be redirected');
    if(c.watcher_directory)externalPath(c.watcher_directory);
    ids.add(c.project_id);
  }
}
export function validateGitHubObservationConfigs(configs: GitHubObservationConfig[], projectIds: readonly string[]) {
  if(!Array.isArray(configs)||configs.length>32)fail(500,'configuration','Invalid GitHub observation configuration');
  for(const c of configs)if(!c||Object.keys(c).sort().join(',')!=='project_id,repository,root')fail(500,'configuration','Invalid GitHub observation fields');
  validateObservationConfigs(configs.map(c=>({...c,machine:{id:'observer',name:'Observer',platform:'unknown'}})),projectIds);
}
export class LocalFastObservationAdapter implements TaskAdapter {
  private readonly deps: ObservationDependencies;
  private cache = new Map<string,{at:number;tasks:Task[]}>();
  private pending = new Map<string,Promise<Task[]>>();
  constructor(readonly configs: readonly LocalFastObservationConfig[], overrides: Partial<ObservationDependencies> = {}) {this.deps={...defaults,...overrides};}
  async observe(projectIds: readonly string[], _managed:readonly Task[]=[], options:ObservationOptions={}): Promise<Task[]> {
    const groups: Task[][]=[];
    // Serialize bounded repository reads; no local discovery, scheduling or writes.
    for (const c of this.configs.filter(c=>projectIds.includes(c.project_id))) {
      const cached=this.cache.get(c.project_id);
      if(cached && this.deps.now()-cached.at>=0 && this.deps.now()-cached.at<5000) {groups.push(await this.enrich(c,structuredClone(cached.tasks),options));continue;}
      let pending=this.pending.get(c.project_id);
      if(!pending) {pending=this.read(c).then(tasks=>{this.cache.set(c.project_id,{at:this.deps.now(),tasks});return tasks;}).finally(()=>this.pending.delete(c.project_id));this.pending.set(c.project_id,pending);}
      groups.push(await this.enrich(c,structuredClone(await pending),options));
    }
    return groups.flat();
  }
  private repositoryIds=new Map<string,number>();
  private async enrich(c:GitHubObservationConfig,tasks:Task[],options:ObservationOptions){
    const cache=sharedGitHubCache(this.deps);
    await cache.observe(c,tasks.filter(t=>t.issue.number>0),options);
    for(const task of tasks)if(task.issue.number>0){
      this.projectGitHub(c,task,options,this.repositoryIds.get(c.project_id));
      if(task.state!=='completed'&&task.state!=='unknown'){
        const stopped=task.watcher.running===false&&(task.waiting_for?.role==='watcher'||['ready','queued'].includes(task.state));
        const blocked=task.watcher.stale_lock||task.history.some(h=>h.source==='watcher'&&h.type==='attempt_blocked');
        if(task.owner_scope.status==='expired'||stopped||blocked){task.state='blocked';task.active_actor=null;task.waiting_for=actor('owner','Owner');task.blockers.push(task.owner_scope.status==='expired'?'Owner 有界授权已过期':blocked?'Watcher 执行失败或存在失效锁':'Watcher 已停止，无法自动推进');task.next_action='Owner 检查 Watcher 或授权并决定恢复';}
      }
      const at=task.observations.find(o=>o.source==='github')?.observed_at;
      if(at&&task.pr?.merged_at)task.history.push({source:'github',type:'MERGED',occurred_at:task.pr.merged_at,observed_at:at,head:task.pr.merge_sha,run_id:null});
      if(at&&task.review)task.history.push({source:'github',type:'REVIEW_'+task.review.state,occurred_at:null,observed_at:at,head:task.review.commit_id,run_id:null});
    }
    return tasks;
  }
  projectGitHub(c:GitHubObservationConfig,task:Task,options:ObservationOptions={},repositoryId?:number){
    const cached=sharedGitHubCache(this.deps).read(c.repository,task,options.github_interval_seconds??300);
    task.github_refresh=cached.refresh;
    try{
      if(task.repository!==c.repository||task.project_id!==c.project_id||repositoryId!==undefined&&cached.repositoryId!==null&&cached.repositoryId!==repositoryId)throw new Error('repository_mismatch');
      if(cached.record){
        const facts=structuredClone(cached.record.facts);facts.issue.title=safeLabel(facts.issue.title,512);for(const r of facts.reviews??[])safeLabel(r.user?.login);
        const localUpdated=task.updated_at;
        applyGitHub(task,facts,cached.record.at);
        task.updated_at=[localUpdated,task.updated_at].filter((v):v is string=>!!v).sort().at(-1)??null;
        const gh=task.observations.find(o=>o.source==='github')!;gh.freshness=cached.fresh?'fresh':'stale';
        if(!cached.fresh||!cached.gateFresh){task.review_gate.status='stale';task.review_gate.reason='历史 Review 仅供查看，当前 Gate 未重新核验';}
      }else task.observations.push({...observation('github',this.deps.now(),'not_checked'),observed_at:null});
      if(!cached.fresh){
        const gh=task.observations.find(o=>o.source==='github')!;
        gh.status=cached.error==='permission_denied'?'permission_denied':cached.record?'unknown':'not_checked';gh.error_code=cached.error;
        task.review_gate.status=cached.record?'stale':'not_checked';task.review_gate.reason='历史 Review 仅供查看，当前 Gate 未重新核验';
        if(!task.active_actor){task.state='unknown';task.waiting_for=actor('owner','Owner');task.next_action='刷新 GitHub 以核验当前事实；历史 Review 不代表当前 Gate';}
      }
    }catch{
      task.github_refresh.status='failed';
      task.review_gate={status:'not_checked',source:'not_checked',reason:'GitHub 来源身份或数据未核验'};
      task.observations=task.observations.filter(o=>o.source!=='github').concat({...observation('github',this.deps.now(),'unknown'),observed_at:null,error_code:'read_failed'});
      if(!task.active_actor){task.state='unknown';task.waiting_for=actor('owner','Owner');task.next_action='检查 GitHub 只读来源并重新核验';}
    }
  }
  private async read(c:LocalFastObservationConfig):Promise<Task[]> {
    const now=this.deps.now();let state:Native;let operationPid:number|null=null;
    try {
      const origin=await this.deps.command('git',['remote','get-url','origin'],c.root);
      if(![`git@github.com:${c.repository}.git`,`git@github.com:${c.repository}`,`https://github.com/${c.repository}.git`,`https://github.com/${c.repository}`].includes(origin))throw new Error('repository_mismatch');
      const common=resolve(c.root,await this.deps.command('git',['rev-parse','--git-common-dir'],c.root));
      state=file(join(common,'awh-local-fast','state.json'));
      if(state.schema_version!=='1.0'||state.mode!=='local-fast'||state.repository!==c.repository||!positive(state.repository_id)||resolve(state.root)!==resolve(c.root)||!Array.isArray(state.issues)||!state.issues.length||state.issues.length>128||!state.issues.every(positive)||new Set(state.issues).size!==state.issues.length||!Array.isArray(state.tasks)||state.tasks.length>state.issues.length)throw new Error('invalid_binding');
      this.repositoryIds.set(c.project_id,state.repository_id);
      for(const [i,t] of state.tasks.entries()) if(t.issue!==state.issues[i]||!['preparing','developing','publishing','awaiting_review','completed'].includes(t.phase)||t.head!==undefined&&!sha(t.head)||t.pr!==undefined&&!positive(t.pr))throw new Error('invalid_task');
      const operation=join(common,'awh-local-fast','operation.lock');
      if(existsSync(operation))try {const pid=file(operation);if(positive(pid))operationPid=pid;}catch{/* A stale or malformed lock cannot prove Stage execution. */}
    } catch(error) {
      // Retain an explicit unavailable source rather than silently removing a configured project.
      const task=taskBase(`lf:${c.project_id}:unavailable`,c.project_id,c.repository,0);task.workflow='local-fast';task.state='unknown';task.waiting_for=actor('owner','Owner');task.machine=c.machine;
      task.next_action='Owner 检查已配置的 Local Fast 只读来源';task.blockers=['Local Fast 来源无法读取或身份不匹配'];task.observations=[{...observation('local_fast',now,'unknown'),error_code:error instanceof Error&&['repository_mismatch','invalid_binding','invalid_task','redirected_file','invalid_file'].includes(error.message)?error.message:'read_failed'}];return [task];
    }
    let scope:Native|undefined,watch:Native|undefined,lock:Native|undefined,watchRead=false;
    try {
      if(c.watcher_directory) {
        scope=file(join(c.watcher_directory,'scope.json'));
        if(scope.repository!==state.repository||scope.repository_id!==state.repository_id||scope.root!==state.root||JSON.stringify(scope.issues)!==JSON.stringify(state.issues)||scope.source!=='windows-owner-confirmation'||typeof scope.allow_merge!=='boolean'||!Number.isFinite(Date.parse(scope.expires_at)))throw new Error('scope_mismatch');
        watch=file(join(c.watcher_directory,'watcher.json'));
        if(watch.scope_version!==scope.scope_version||!Array.isArray(watch.attempts)||watch.attempts.length>1000)throw new Error('watcher_mismatch');
        if(existsSync(join(c.watcher_directory,'watcher.lock'))) {lock=file(join(c.watcher_directory,'watcher.lock'));if(lock.scope_version!==scope.scope_version||!positive(lock.pid))throw new Error('lock_mismatch');}
        watchRead=true;
      }
    } catch {scope=watch=lock=undefined;}
    const tasks:Task[]=[];
    for(const [i,issue] of state.issues.entries()) {
      const t=state.tasks[i];const task=taskBase(`lf:${c.project_id}:${issue}`,c.project_id,c.repository,issue);task.workflow='local-fast';task.machine=c.machine;task.executor=c.executor_name??'Coding Executor';task.updated_at=new Date(now).toISOString();
      task.observations=[observation('local_fast',now),observation('watcher',now,watchRead?'verified':'not_checked'),observation('owner_scope',now,scope?'verified':'not_checked')];
      if(scope)task.owner_scope={status:Date.parse(scope.expires_at)>now?'valid':'expired',expires_at:scope.expires_at,allow_merge:scope.allow_merge};
      const attempt=watch?.attempts.filter((a:Native)=>a.issue===issue).at(-1);
      const running=watchRead?(lock?this.deps.alive(lock.pid):false):null;
      const executorRunning=watchRead?!!attempt&&attempt.status==='running'&&positive(attempt.executor_pid)&&this.deps.alive(attempt.executor_pid):null;
      task.watcher={status:watch?safeLabel(watch.status):'not_checked',running,executor_running:executorRunning,stale_lock:watchRead&&running!==null?!!lock&&!running:null};
      if(t) {
        task.source_head=t.head??(sha(t.pending_head)?t.pending_head:null);
        if(t.pr)task.pr={number:t.pr,state:null,draft:null,merged_at:null,merge_sha:null};
        task.history.push({source:'local_fast',type:t.phase,occurred_at:null,observed_at:new Date(now).toISOString(),head:task.source_head,run_id:null});
        if(executorRunning) {task.state='developing';task.active_actor=actor('coding_executor',task.executor!);task.waiting_for=null;task.next_action='等待实际 Coding Executor 完成';}
        else if(t.phase==='publishing'&&operationPid&&this.deps.alive(operationPid)) {task.state='verifying';task.active_actor=actor('stage','AWH Stage');task.waiting_for=null;task.next_action='等待 AWH Stage 验证和交付';}
        else if(t.phase==='awaiting_review') {task.state='awaiting_review';task.waiting_for=actor('reviewer','ChatGPT Reviewer');task.next_action='等待 ChatGPT Review';}
        else if(t.phase==='developing'||t.phase==='publishing'||t.phase==='completed') {task.state='unknown';task.waiting_for=actor('owner','Owner');task.next_action='重新核验执行、交付或完成状态';}
        else task.state='ready';
        if(task.source_head)try {
          const path=join(c.root,'.handoff','local-fast','checks',`${issue}-${task.source_head}.json`);const check=file(path,2*1024*1024);
          if(check.mode!=='local-fast'||check.head!==task.source_head||!Array.isArray(check.logs)||!Array.isArray(state.checks)||check.logs.length>64||!check.logs.every((l:Native)=>typeof l.command==='string'&&Number.isInteger(l.exit_code)))throw new Error('invalid_checks');
          const checks=check.logs.map((l:Native)=>({name:safeLabel(l.command,240),exit_code:l.exit_code}));
          const complete=state.checks.every((cmd:string)=>check.logs.some((l:Native)=>l.command===cmd&&l.exit_code===0));
          task.stage={head:check.head,status:checks.some((l:Task['stage']['checks'][number])=>l.exit_code!==0)?'failed':complete?'passed':'not_checked',checks};
          task.history.push({source:'local_fast',type:`stage_${task.stage.status}`,occurred_at:statSync(path).mtime.toISOString(),observed_at:new Date(now).toISOString(),head:check.head,run_id:null});
        } catch {/* Missing evidence is not PASS. */}
      }

      if(attempt?.status==='blocked')task.history.push({source:'watcher',type:'attempt_blocked',occurred_at:null,observed_at:new Date(now).toISOString(),head:task.source_head,run_id:null});
      if(attempt&&['reserved','running','published'].includes(attempt.status))task.history.push({source:'watcher',type:'attempt_'+attempt.status,occurred_at:null,observed_at:new Date(now).toISOString(),head:sha(attempt.head)?attempt.head:task.source_head,run_id:null});
      if(watch)task.history.push({source:'watcher',type:task.watcher.status,occurred_at:null,observed_at:new Date(now).toISOString(),head:task.source_head,run_id:null});
      if(task.pr?.merged_at)task.history.push({source:'github',type:'MERGED',occurred_at:task.pr.merged_at,observed_at:task.updated_at!,head:task.pr.merge_sha,run_id:null});
      if(task.review)task.history.push({source:'github',type:`REVIEW_${task.review.state}`,occurred_at:null,observed_at:task.updated_at!,head:task.review.commit_id,run_id:null});
      tasks.push(task);
    }
    return tasks;
  }
}
/** Optional native-fact verification for CP tasks; never discovers ordinary Issues or creates CP records. */
export class GitHubObservationAdapter implements TaskAdapter {
  private readonly reader:LocalFastObservationAdapter;
  private readonly deps:ObservationDependencies;
  constructor(readonly configs:readonly GitHubObservationConfig[],overrides:Partial<ObservationDependencies>={}) {this.deps={...defaults,...overrides};this.reader=new LocalFastObservationAdapter([],this.deps);}
  async observe(projectIds:readonly string[],managedTasks:readonly Task[]=[],options:ObservationOptions={}):Promise<Task[]> {
    const tasks:Task[]=[];
    for(const c of this.configs.filter(c=>projectIds.includes(c.project_id))){
      const selected=managedTasks.filter(t=>t.project_id===c.project_id&&t.repository===c.repository).map(t=>structuredClone(t));
      if(!selected.length)continue;
      const origin=await this.deps.command('git',['remote','get-url','origin'],c.root).catch(()=>null);
      if(![`git@github.com:${c.repository}.git`,`git@github.com:${c.repository}`,`https://github.com/${c.repository}.git`,`https://github.com/${c.repository}`].includes(origin??'')){
        for(const task of selected){task.review_gate.status='not_checked';if(!task.active_actor)task.state='unknown';}tasks.push(...selected);continue;
      }
      await sharedGitHubCache(this.deps).observe(c,selected,options);
      for(const task of selected)this.reader.projectGitHub(c,task,options);
      tasks.push(...selected);
    }
    return tasks;
  }
}
export function combineTaskAdapters(...adapters:TaskAdapter[]):TaskAdapter {return {observe:async(scope,managed,options)=>{const tasks:Task[]=[];for(const adapter of adapters)tasks.push(...await adapter.observe(scope,managed,options));return tasks;}};}
