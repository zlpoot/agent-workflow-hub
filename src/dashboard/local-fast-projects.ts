import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { atomicJson, ClientError, inspectRepository } from '../client/local.js';
import { localFastRun } from '../workflow/local-fast-github.js';
import { externalPath, readExternalFile } from '../shared/external-files.js';
import { fail } from '../shared/security.js';
import { LocalFast, type LocalFastDependencies } from '../workflow/local-fast.js';
import { LocalFastWatcher, type WatchDependencies, type WatchScope } from '../workflow/local-fast-watcher.js';
import { detectCodexExecutable } from './codex-executable.js';
import type { LocalFastObservationConfig } from './local-fast-observation.js';
import { fileURLToPath } from 'node:url';

export interface LocalFastProjectsConfig { project_roots: string[]; state_directory: string }
export function validateLocalFastProjects(c: LocalFastProjectsConfig) {
  if (!c || Object.keys(c).sort().join(',') !== 'project_roots,state_directory' || !Array.isArray(c.project_roots) || !c.project_roots.length || c.project_roots.length > 16) fail(500,'configuration','Invalid local project setup');
  externalPath(c.state_directory);
  for (const root of c.project_roots) {
    if (!isAbsolute(root) || resolve(root).toLowerCase() !== realpathSync(root).toLowerCase() || !lstatSync(root).isDirectory()) fail(500,'configuration','Invalid trusted project root');
  }
}
/** OS-user GUI association only. Binding and execution retain existing Local Fast gates. */
export function createLocalFastProjects(c: LocalFastProjectsConfig, overrides: { fast?: Partial<LocalFastDependencies>; watch?: Partial<WatchDependencies>;
  confirmOwner?:(scope:WatchScope,signal:AbortSignal)=>Promise<boolean>; detectExecutor?:()=>string|null } = {}) {
  validateLocalFastProjects(c);
  const file = join(c.state_directory,'dashboard-local-fast.json');
  const draftFile = join(c.state_directory,'dashboard-local-fast-queues.json');
  const drafts = new Map<string,number[]>();
  const roots: string[] = [];
  const configs: LocalFastObservationConfig[] = [];
  const runs = new Map<string,{ controller: AbortController; done: Promise<unknown>; status: string; reason?: string }>();
  let busy = false, closed = false;
  const shutdown=new AbortController();
  const allowed = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 1024 || !isAbsolute(value) || value.split(/[\\/]/).some(p=>p==='..'||p==='.')) fail(400,'directory','Choose a trusted local directory');
    const root=resolve(value);
    if (!c.project_roots.some(parent=>{const r=relative(parent,root);return r===''||!r.startsWith('..')&&!isAbsolute(r);})) fail(403,'directory','Directory is outside trusted project roots');
    return root;
  };
  const selected = (value: unknown) => {
    const requested=allowed(value),root=realpathSync(requested);
    if(root.toLowerCase()!==requested.toLowerCase())fail(403,'directory','Redirected directories are unavailable');
    for (let p=root;;p=resolve(p,'..')) {if(lstatSync(p).isSymbolicLink())fail(403,'directory','Redirected directories are unavailable');if(resolve(p,'..')===p)break;}
    return root;
  };
  const numbers = (value:unknown,empty=false) => {
    if(typeof value!=='string'||!((empty&&value==='')||/^[1-9]\d*(?:,[1-9]\d*)*$/.test(value)))fail(400,'local_fast_input','Use ordered distinct positive Issue numbers');
    const rows=value===''?[]:value.split(',').map(Number);
    if(rows.length>128||rows.some(n=>!Number.isSafeInteger(n))||new Set(rows).size!==rows.length)fail(400,'local_fast_input','Invalid finite queue');
    return rows;
  };
  if(existsSync(draftFile)){
    const saved=JSON.parse(readExternalFile(draftFile,65536).toString('utf8'));
    if(!saved||Object.keys(saved).sort().join(',')!=='items,schema_version'||saved.schema_version!=='1.0'||!Array.isArray(saved.items)||saved.items.length>32)fail(500,'configuration','Invalid saved candidate queues');
    for(const item of saved.items){if(!item||Object.keys(item).sort().join(',')!=='directory,issues'||!Array.isArray(item.issues))fail(500,'configuration','Invalid candidate queue');const root=allowed(item.directory);if(drafts.has(root))fail(500,'configuration','Duplicate candidate queue');drafts.set(root,numbers(item.issues.join(','),true));}
  }
  const inspect = (value: unknown) => {
    const root=selected(value), identity=inspectRepository(root);
    if(identity.root!==root)fail(400,'directory','Choose the Git root');
    return {identity,fast:new LocalFast(root,overrides.fast)};
  };
  const association = (root: string): LocalFastObservationConfig => {
    const {identity,fast}=inspect(root), scope=fast.scope();
    if(scope.root!==root||scope.repository!==identity.repository)fail(409,'local_fast_binding','Select the original binding root');
    return {project_id:'lf-'+createHash('sha256').update(root).digest('hex').slice(0,24),repository:scope.repository,root,
      watcher_directory:join(overrides.watch?.localData??process.env.LOCALAPPDATA??'','AWH','local-fast',String(scope.repository_id)),
      machine:{id:'machine-'+createHash('sha256').update(hostname()).digest('hex').slice(0,24),name:hostname(),platform:process.platform},executor_name:'Codex'};
  };
  const add = (root: string) => {
    const config=association(root), existing=configs.find(x=>x.root===root);
    if(!existing){if(configs.length>=32)fail(409,'local_fast_limit','Project capacity reached');configs.push(config);roots.push(root);}
    return existing??config;
  };
  if(existsSync(file)) {
    const saved=JSON.parse(readExternalFile(file,65536).toString('utf8'));
    if(!saved||!['roots,schema_version','repositories,roots,schema_version'].includes(Object.keys(saved).sort().join(','))||saved.schema_version!=='1.0'||!Array.isArray(saved.roots)||saved.roots.length>32||new Set(saved.roots).size!==saved.roots.length||saved.repositories!==undefined&&(!Array.isArray(saved.repositories)||saved.repositories.length!==saved.roots.length||!saved.repositories.every((r:unknown)=>typeof r==='string'&&/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(r)&&!r.includes('..'))))fail(500,'configuration','Invalid saved local associations');
    // Restore identity from Git and binding; an unavailable source remains explicitly configured.
    for(const [i,value] of saved.roots.entries()) {
      const root=allowed(value),repository=saved.repositories?.[i]??inspect(root).identity.repository;
      const config:LocalFastObservationConfig={project_id:'lf-'+createHash('sha256').update(root).digest('hex').slice(0,24),repository,root,machine:{id:'machine-'+createHash('sha256').update(hostname()).digest('hex').slice(0,24),name:hostname(),platform:process.platform},executor_name:'Codex'};
      try {const live=association(root);if(live.repository===repository)Object.assign(config,live);} catch { /* Observer reports unavailable binding, never live execution. */ }
      configs.push(config);roots.push(root);
    }
  }
  const preview = (directory: unknown) => {
    const {identity,fast}=inspect(directory);
    const common=resolve(identity.root,(overrides.fast?.run??localFastRun)('git',['rev-parse','--git-common-dir'],identity.root));
    // Absence must be distinguished from a corrupt/conflicting binding.
    let scope;
    if(existsSync(join(common,'awh-local-fast','state.json')))scope=fast.scope();
    return {directory:identity.root,repository:identity.repository,head:identity.sha,branch:identity.ref,dirty:identity.dirty,bound:!!scope,issues:scope?.issues??[],checks:scope?.checks??[],provider:scope?.delivery?'github-app':'personal-gh',
      ...(scope?fast.queueInfo():{}),draft_issues:drafts.get(identity.root)??[],owner_native:!!overrides.confirmOwner,codex_executable:(overrides.detectExecutor??detectCodexExecutable)(),owner_cli:{node:process.execPath,entry:fileURLToPath(new URL('../client/cli.js',import.meta.url))}};
  };
  const watchStatus = (root: string) => {
    inspect(root);
    const run=runs.get(root);
    const owner_confirmation=overrides.confirmOwner?'native_windows_owner':'GUI_OWNER_CONFIRMATION_NOT_INTEGRATED';
    try {const state=new LocalFastWatcher(root,{fast:overrides.fast,...overrides.watch}).status();return {...state,gui_status:run?.status??'IDLE',gui_reason:run?.reason??null,owner_confirmation};}
    catch(error) {return {status:'BLOCKED',reason:error instanceof ClientError?error.code:'local_fast_watch_scope',gui_status:run?.status??'IDLE',owner_confirmation};}
  };
  return { configs, projectIds:()=>configs.map(c=>c.project_id), async handle(action:string,data:Record<string,unknown>,signal:AbortSignal=new AbortController().signal,authorized:()=>boolean=()=>true) {
    if(busy||closed)fail(409,'local_fast_busy','Wait for the current local operation');
    busy=true;
    try {
      const fields:Record<string,string[]>={list:[],browse:['directory'],inspect:['directory'],issues:['directory','page'],'queue-draft':['directory','repository','issues'],'queue-save':['directory','repository','head','issues','queue_revision','confirm'],attach:['directory','repository','head','confirm'],bind:['directory','repository','head','issues','checks','provider','confirm'],status:['directory'],start:['directory','confirm'],stop:['directory'],'owner-authorize':['directory','repository','head','issues','queue_revision','expires','executable','allow_merge']};
      if(!fields[action]||Object.keys(data).some(k=>!fields[action]!.includes(k)))fail(400,'local_fast_input','Closed local actions required');
      if(action==='list')return {items:configs.map(config=>{
        try {const item=preview(config.root);if(!item.bound||item.repository!==config.repository)throw new Error('binding_mismatch');return {project_id:config.project_id,...item,available:true};}
        catch(error){return {project_id:config.project_id,directory:config.root,repository:config.repository,available:false,reason:error instanceof ClientError?error.code:!existsSync(config.root)?'directory_missing':'local_fast_binding'};}
      })};
      if(action==='browse') {if(data.directory===undefined)return {roots:c.project_roots,current:null,directories:[]};const root=selected(data.directory);return {roots:c.project_roots,current:root,directories:readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&!e.name.startsWith('.')).slice(0,128).map(e=>join(root,e.name))};}
      if(action==='inspect')return preview(data.directory);
      const {identity,fast}=inspect(data.directory),root=identity.root;
      if(action==='issues'){if(data.page!==undefined&&typeof data.page!=='number')fail(400,'local_fast_input','Use a numeric Issue page');return fast.openIssues(data.page===undefined?1:data.page as number);}
      if(action==='queue-draft'){
        if(data.repository!==identity.repository)fail(409,'local_fast_preview_changed','Repository changed');
        const rows=numbers(data.issues,true);
        if(!drafts.has(root)&&drafts.size>=32)fail(409,'local_fast_limit','Candidate queue capacity reached');
        const items=[...drafts.entries()].filter(([directory])=>directory!==root).map(([directory,issues])=>({directory,issues}));items.push({directory:root,issues:rows});
        atomicJson(draftFile,{schema_version:'1.0',items});drafts.set(root,rows);return {draft_issues:rows};
      }
      if(action==='queue-save'){
        if(!roots.includes(root))fail(403,'local_fast_project','Associate the project before changing its queue');
        if(data.confirm!==true||data.repository!==identity.repository||data.head!==identity.sha||typeof data.queue_revision!=='string')fail(409,'local_fast_preview_changed','Confirm the exact current preview');
        numbers(data.issues);
        const prior=runs.get(root);if(prior&&['RUNNING','STOPPING'].includes(prior.status))fail(409,'local_fast_watch_locked','Wait for this GUI Watcher to stop');
        const watcher=new LocalFastWatcher(root,{fast:overrides.fast,...overrides.watch});
        const previous=fast.queueInfo().queue_id;
        await watcher.changeQueue(idle=>fast.setQueue(data.issues as string,data.queue_revision as string,true,idle));
        if(fast.queueInfo().queue_id!==previous)runs.delete(root);
        return {...preview(root),project_id:configs.find(x=>x.root===root)!.project_id};
      }
      if(action==='attach'||action==='bind') {
        if(data.confirm!==true)fail(400,'local_fast_confirmation','Explicit project confirmation required');
        if(data.repository!==identity.repository||data.head!==identity.sha)fail(409,'local_fast_preview_changed','Git identity changed since preview; inspect and confirm again');
        if(action==='bind') {
          if(typeof data.issues!=='string'||!Array.isArray(data.checks)||data.checks.length>16||!data.checks.every(x=>typeof x==='string'&&x.length<=240)||!['personal-gh','github-app'].includes(String(data.provider)))fail(400,'local_fast_input','Select the exact finite queue and bounded checks');
          await fast.bind(identity.repository,data.issues,true,data.checks as string[],data.provider as 'personal-gh'|'github-app');
        }
        const item=add(root);atomicJson(file,{schema_version:'1.0',roots,repositories:configs.map(c=>c.repository)});return {project_id:item.project_id,...preview(root)};
      }
      if(!roots.includes(root))fail(403,'local_fast_project','Confirm this project first');
      if(action==='owner-authorize'){
        if(!overrides.confirmOwner)fail(409,'GUI_OWNER_CONFIRMATION_NOT_INTEGRATED','Native Windows Owner is unavailable');
        if(data.repository!==identity.repository||data.head!==identity.sha||data.queue_revision!==fast.queueInfo().queue_revision)fail(409,'local_fast_preview_changed','Confirm the exact current queue');
        if(typeof data.expires!=='string'||typeof data.executable!=='string'||typeof data.allow_merge!=='boolean')fail(400,'local_fast_input','Explicit native scope fields required');
        numbers(data.issues);
        const watcher=new LocalFastWatcher(root,{fast:overrides.fast,...overrides.watch});
        const result=await watcher.authorizeNative(data.repository as string,data.issues as string,data.expires,data.executable,data.allow_merge,overrides.confirmOwner,
          AbortSignal.any([signal,shutdown.signal,AbortSignal.timeout(210000)]),()=>!closed&&authorized());
        return {...watchStatus(root),owner_result:result.status};
      }
      if(action==='status')return watchStatus(root);
      if(action==='stop') {const run=runs.get(root);if(run){run.controller.abort();run.status='STOPPING';}return watchStatus(root);}
      if(data.confirm!==true)fail(400,'local_fast_confirmation','Confirm starting the saved Owner scope');
      const prior=runs.get(root);if(prior&&['RUNNING','STOPPING'].includes(prior.status))return watchStatus(root);
      const watcher=new LocalFastWatcher(root,{fast:overrides.fast,...overrides.watch}),status=watcher.status();
      if(status.watcher_running||status.stale_lock||status.status==='QUEUE_COMPLETED')fail(409,'local_fast_watch_unavailable','Completed queues and existing locks cannot be restarted');
      const controller=new AbortController(),run={controller,done:Promise.resolve() as Promise<unknown>,status:'RUNNING',reason:undefined as string|undefined};
      runs.set(root,run);
      run.done=watcher.run(false,controller.signal).then(result=>{run.status=result.status;run.reason=result.reason;},error=>{run.status='BLOCKED';run.reason=error instanceof ClientError?error.code:'local_fast_watch_operation';});
      return {status:'STARTING',owner_confirmation:'saved_windows_owner_scope'};
    } catch(error) {if(error instanceof ClientError)fail(409,error.code,'Local Fast operation blocked; preserve history');throw error;}
    finally {busy=false;}
  },close:async()=>{closed=true;shutdown.abort();for(const run of runs.values())run.controller.abort();await Promise.allSettled([...runs.values()].map(r=>r.done));}};
}
