import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {writeFileSync,readFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {harness} from './helpers/local-fast-harness.mjs';
import {localFastRun} from '../dist/workflow/local-fast-github.js';
import {LocalFastWatcher} from '../dist/workflow/local-fast-watcher.js';

test('native transient REST reads retry once; writes, auth, limits, Git and ambiguous options never replay', t=>{
 const original=childProcess.spawnSync;let calls=0,response;
 childProcess.spawnSync=()=>{calls++;return calls===1?response:{status:0,stdout:'{"ok":true}',stderr:''};};syncBuiltinESMExports();
 t.after(()=>{childProcess.spawnSync=original;syncBuiltinESMExports();});
 for(const failure of [{status:1,stdout:'',stderr:'TLS handshake timeout'},{status:1,stdout:'',stderr:'HTTP 503 Service Unavailable'},{error:Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}),stdout:'',stderr:''}]){
  calls=0;response=failure;assert.equal(localFastRun('gh',['api','--paginate','--slurp','repos/synthetic/repo/pulls?state=all'],process.cwd()),'{"ok":true}');assert.equal(calls,2);
 }
 for(const args of [['api','--method','POST','repos/synthetic/repo/pulls'],['api','-XGET','repos/synthetic/repo'],['api','graphql','-f','query=...'],['pr','create'],['api','repos/synthetic/repo','--input','-']]){
  calls=0;response={status:1,stdout:'',stderr:'unexpected EOF'};assert.throws(()=>localFastRun('gh',args,process.cwd()),e=>e.code==='local_fast_gh');assert.equal(calls,1);
 }
 for(const stderr of ['HTTP 401 authentication failed','HTTP 403 permission denied','HTTP 429 rate limit','invalid response','HTTP 503 rate limit']){
  calls=0;response={status:1,stdout:'',stderr};assert.throws(()=>localFastRun('gh',['api','user'],process.cwd()),e=>e.code==='local_fast_gh');assert.equal(calls,1);
 }
 calls=0;response={status:1,stdout:'',stderr:'connection reset'};assert.throws(()=>localFastRun('git',['push','origin'],process.cwd()));assert.equal(calls,1);
 calls=0;response={status:1,stdout:'',stderr:'unexpected EOF'};childProcess.spawnSync=()=>{calls++;return response;};syncBuiltinESMExports();assert.throws(()=>localFastRun('gh',['api','user'],process.cwd()));assert.equal(calls,2);
});

test('published task resumes observation after a read failure without redeveloping or retaining a stale error',{skip:process.platform!=='win32',timeout:180000},async t=>{
 const h=harness(t);await h.bind();
 const localData=mkdtempSync(join(realpathSync(tmpdir()),'awh-read-recovery-'));
 t.after(()=>{assert.equal(dirname(realpathSync(localData)),realpathSync(tmpdir()));rmSync(localData,{recursive:true,force:true,maxRetries:5});});
 let fail=false,launches=0;
 const watcher=new LocalFastWatcher(h.repo,{localData,interactive:true,fast:{...h.deps,run:(command,args,cwd)=>{if(fail&&command==='gh'&&args.some(a=>/\/pulls\/10$/.test(a)))throw new Error('synthetic read failure');return h.deps.run(command,args,cwd);}},
  executor:{type:'codex-cli',run:async(request,started)=>{launches++;started(process.pid);writeFileSync(join(request.task.worktree,'code.txt'),'published candidate\n');return {exit_code:0};}}});
 watcher.authorize('synthetic-org/local-fast','1,2,3',new Date(Date.now()+3600000).toISOString(),realpathSync(process.execPath),false,true);
 const scope=readFileSync(watcher.scope_file,'utf8');
 await watcher.run(true);assert.equal(launches,1);assert.equal(h.prs.length,1);const head=h.prs[0].head.sha;
 fail=true;assert.equal((await watcher.run(true)).reason,'local_fast_github');assert.equal(watcher.status().status,'BLOCKED');
 fail=false;await watcher.run(true);const status=watcher.status();
 assert.equal(status.status,'AWAITING_INDEPENDENT_REVIEW');assert.equal(status.last_error,undefined);assert.equal(status.executor_launches,1);
 assert.equal(launches,1);assert.equal(h.prs.length,1);assert.equal(h.prs[0].head.sha,head);assert.equal(readFileSync(watcher.scope_file,'utf8'),scope);
});

test('installed GUI worker isolates blocking reads, supports stop/Stage continuation and suppresses failure details',{skip:process.platform!=='win32',timeout:90000},async t=>{
 const h=harness(t),base=dirname(h.repo),preload=join(base,'worker-preload.mjs'),runner=pathToFileURL(join(process.cwd(),'dist/dashboard/local-fast-watch-worker.js')).href;
 const watcher=pathToFileURL(join(process.cwd(),'dist/workflow/local-fast-watcher.js')).href,fast=pathToFileURL(join(process.cwd(),'dist/workflow/local-fast.js')).href;
 writeFileSync(preload,`import {LocalFastWatcher} from ${JSON.stringify(watcher)};import {LocalFast} from ${JSON.stringify(fast)};
 LocalFast.prototype.scope=function(){return {repository_id:42};};
 LocalFastWatcher.prototype.resumeStage=async function(){return {status:'AWAITING_INDEPENDENT_REVIEW'};};
 LocalFastWatcher.prototype.run=async function(_once,signal){
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
  if(process.env.AWH_WORKER_FAILURE==='1')throw new Error('private diagnostic must not escape');
  if(process.env.AWH_WORKER_STOP==='1')return await new Promise(resolve=>{if(signal.aborted)resolve({status:'STOPPED'});else signal.addEventListener('abort',()=>resolve({status:'STOPPED'}),{once:true});});
  return {status:'AWAITING_INDEPENDENT_REVIEW',scope_version:'must-not-leak'};
 };`);
 const program=`import assert from 'node:assert/strict';import {runLocalFastWatchWorker} from ${JSON.stringify(runner)};
 let ticks=0;const timer=setInterval(()=>ticks++,10);
 const controller=new AbortController();
 if(process.env.AWH_WORKER_STOP==='1')setTimeout(()=>controller.abort(),100);
 const result=await runLocalFastWatchWorker(${JSON.stringify(h.repo)},process.env.AWH_WORKER_STAGE==='1'?'resume-stage':'start',controller.signal);
 clearInterval(timer);assert(ticks>=10,'HTTP event loop stayed responsive during blocking native reads');
 assert.deepEqual(Object.keys(result).sort(),process.env.AWH_WORKER_FAILURE==='1'?['reason','status']:['status']);
 assert.equal(result.status,process.env.AWH_WORKER_FAILURE==='1'?'BLOCKED':process.env.AWH_WORKER_STOP==='1'?'STOPPED':'AWAITING_INDEPENDENT_REVIEW');
 if(result.reason)assert.equal(result.reason,'local_fast_watch_operation');
 const aborted=new AbortController();aborted.abort();assert.deepEqual(await runLocalFastWatchWorker('unused','start',aborted.signal),{status:'STOPPED'});
 console.log(JSON.stringify({status:result.status,responsive:true}));`;
 const programFile=join(base,'worker-client.mjs');writeFileSync(programFile,program);
 for(const flag of ['AWH_WORKER_STAGE','AWH_WORKER_STOP','AWH_WORKER_FAILURE']){
  const r=await new Promise((resolve,reject)=>childProcess.execFile(process.execPath,['--import',pathToFileURL(preload).href,programFile],{env:{...process.env,[flag]:'1'},windowsHide:true,timeout:25000},(error,stdout,stderr)=>error?reject(new Error(stderr)):resolve({stdout,stderr})));
  assert.match(r.stdout,/"responsive":true/);assert.doesNotMatch(r.stdout+r.stderr,/must-not-leak|private diagnostic/);
 }
});
