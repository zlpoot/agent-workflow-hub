import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {harness,repository} from './helpers/local-fast-harness.mjs';
import {LocalFastWatcher} from '../dist/workflow/local-fast-watcher.js';
import {createLocalFastProjects} from '../dist/dashboard/local-fast-projects.js';
const code=value=>e=>e.code===value;
async function setup(t,executor){
  const h=harness(t),external=mkdtempSync(join(tmpdir(),'awh-stage-recovery-')),state=join(external,'gui');mkdirSync(state);
  const executable=join(external,'codex.exe');writeFileSync(executable,'synthetic executor');
  await h.bind();
  // Keep the production defaults: mock process transport, not fast dependencies.
  // Real Git metadata/commits/local bare pushes and real focused Node tests still execute.
  const spawn=childProcess.spawnSync;
  childProcess.spawnSync=(command,args,options={})=>{
    const intercepted=command==='gh'||command==='git'&&['fetch','push','ls-remote'].includes(args[0])&&args.includes('origin');
    if(!intercepted)return spawn(command,args,options);
    try{return {status:0,stdout:h.deps.run(command,args,options.cwd),stderr:''};}
    catch(error){return {status:1,stdout:'',stderr:'Synthetic transport failure'};}
  };syncBuiltinESMExports();
  t.after(()=>{childProcess.spawnSync=spawn;syncBuiltinESMExports();});
  const watch={localData:external,interactive:true,fast:undefined,executor};
  const watcher=new LocalFastWatcher(h.repo,watch);
  watcher.authorize(repository,'1,2,3',new Date(Date.now()+3600000).toISOString(),executable,false,true);
  return {h,watch,watcher,external,config:{project_roots:[dirname(h.repo)],state_directory:state},watchFile:join(external,'AWH/local-fast/42/watcher.json')};
}
test('real default GUI fast dependencies survive explicit undefined through Coding, Stage and Draft PR',{skip:process.platform!=='win32',timeout:180000},async t=>{
  let launches=0;
  const {h,watch,config,watchFile}=await setup(t,{type:'codex-cli',run:async(request,started)=>{launches++;started(process.pid);writeFileSync(join(request.task.worktree,'code.txt'),'retained default candidate\n');return {exit_code:0};}});
  const gui=createLocalFastProjects(config,{watch,detectExecutor:()=>null});t.after(()=>gui.close());
  await gui.handle('attach',{directory:h.repo,repository,head:h.initialMain,confirm:true});
  await gui.handle('start',{directory:h.repo,confirm:true});
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){const record=existsSync(watchFile)?JSON.parse(readFileSync(watchFile)):null;if(record?.status==='AWAITING_INDEPENDENT_REVIEW')break;if(record?.status==='BLOCKED')assert.fail(record.last_error);await new Promise(r=>setTimeout(r,50));}
  assert.equal(JSON.parse(readFileSync(watchFile)).status,'AWAITING_INDEPENDENT_REVIEW');
  assert.equal(launches,1);assert.equal(h.prs.length,1);assert(h.prs[0].draft);assert.equal(JSON.parse(readFileSync(h.statePath)).tasks[0].phase,'awaiting_review');
  await gui.close();assert(!existsSync(join(dirname(watchFile),'watcher.lock')));
});
test('Stage-only recovery preserves prior attempt and candidate, validates scope/locks and never relaunches Coding',{skip:process.platform!=='win32',timeout:180000},async t=>{
  let launches=0;
  const {h,watch,watcher,watchFile}=await setup(t,{type:'codex-cli',run:async(request,started)=>{launches++;started(process.pid);writeFileSync(join(request.task.worktree,'code.txt'),'existing completed Coding changes\n');return {exit_code:0};}});
  // Reproduce the previous production fault after constructing its valid scope.
  watcher.deps.fast=undefined;
  assert.equal((await watcher.run(true)).reason,'local_fast_watch_operation');
  const binding=JSON.parse(readFileSync(h.statePath)),worktree=binding.tasks[0].worktree,candidate=readFileSync(join(worktree,'code.txt'),'utf8');
  assert.equal(h.prs.length,0);assert.equal(launches,1);const scope=readFileSync(watcher.scope_file,'utf8');
  const fixed=new LocalFastWatcher(h.repo,{...watch,executor:{type:'codex-cli',run:async()=>assert.fail('Recovery must never relaunch Coding')}});
  await assert.rejects(fixed.resumeStage(false),code('local_fast_confirmation'));
  const controller=new AbortController();controller.abort();await assert.rejects(fixed.resumeStage(true,controller.signal),code('local_fast_watch_recovery'));assert.equal(h.prs.length,0);
  const lock=join(dirname(watchFile),'watcher.lock');writeFileSync(lock,JSON.stringify({pid:process.pid}));await assert.rejects(fixed.resumeStage(true),code('local_fast_watch_locked'));
  const {unlinkSync}=await import('node:fs');unlinkSync(lock);
  const active=JSON.parse(readFileSync(watchFile));active.attempts[0].executor_pid=process.pid;writeFileSync(watchFile,JSON.stringify(active));await assert.rejects(fixed.resumeStage(true),code('local_fast_watch_locked'));
  delete active.attempts[0].executor_pid;writeFileSync(watchFile,JSON.stringify(active));
  const expired=new LocalFastWatcher(h.repo,{...watch,now:()=>Date.now()+2*3600000});await assert.rejects(expired.resumeStage(true),code('local_fast_watch_expired'));
  const delivered=await fixed.resumeStage(true);assert.equal(delivered.status,'AWAITING_INDEPENDENT_REVIEW');
  assert.equal(launches,1);assert.equal(h.prs.length,1);assert.equal(readFileSync(join(worktree,'code.txt'),'utf8'),candidate);assert.equal(readFileSync(watcher.scope_file,'utf8'),scope);
  const result=JSON.parse(readFileSync(watchFile));assert.equal(result.executor_launches,1);assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].status,'published');assert.equal(result.attempts[0].stage_resumptions,1);assert.equal(result.attempts[0].stage_recovery_reason,'local_fast_watch_operation');
  assert.equal(JSON.parse(readFileSync(h.statePath)).tasks.length,1);assert.equal(JSON.parse(readFileSync(h.statePath)).tasks[0].worktree,worktree);
  await assert.rejects(fixed.resumeStage(true),code('local_fast_watch_recovery'));assert.equal(h.prs.length,1);
});
