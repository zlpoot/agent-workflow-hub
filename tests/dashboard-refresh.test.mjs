import test from 'node:test';
import assert from 'node:assert/strict';
import {applyGitHub,taskBase,observation,actor} from '../dist/dashboard/tasks.js';
import {GitHubObservationCache,GitHubReadError,githubReadFailure} from '../dist/dashboard/github-observation-cache.js';
import {localStale,githubStale,taskStale} from '../dashboard/task-freshness.mjs';
import {DashboardReader} from '../dashboard/adapter.mjs';
import {catalog,refreshPolicy} from './trusted-policy-fixture.mjs';
const repo='example-org/project-alpha',head='a'.repeat(40),start=Date.parse('2026-10-12T10:00:00Z');
function task(issue=1){const t=taskBase(`task:${issue}`,'p',repo,issue);t.source_head=head;t.pr={number:issue+10,state:null,draft:null,merged_at:null,merge_sha:null};return t;}
function pr(number=11,merged=false){return {number,state:merged?'closed':'open',draft:!merged,merged_at:merged?'2026-10-12T08:00:00Z':null,merge_commit_sha:merged?'b'.repeat(40):null,head:{sha:head,repo:{full_name:repo}},base:{repo:{full_name:repo}},user:{id:10,login:'builder-bot'}};}
const review=(patch={})=>({id:30,state:'APPROVED',commit_id:head,user:{type:'User',id:20,login:'trusted-reviewer'},...patch});
const facts=reviews=>({issue:{number:1,state:'open',title:'Native task'},pr:pr(),reviews,checks:{status:'none',count:0}});
test('standard Gate uses the same administrator policy identities as Strict; raw native Review is distinct',()=>{
  const original=structuredClone(catalog);catalog.installation.reviewers=[{login:'trusted-reviewer',id:20}];refreshPolicy();
  try{
    for(const r of [review({user:{type:'User',id:99,login:'stranger'}}),review({user:{type:'Bot',id:20,login:'trusted-reviewer'}}),review({user:{type:'User',id:99,login:'trusted-reviewer'}}),review({user:{type:'User',id:20,login:'wrong-login'}})]){
      const t=task();applyGitHub(t,facts([r]),start);assert.equal(t.review.state,'APPROVED');assert.equal(t.review.decision,null);assert.notEqual(t.state,'awaiting_merge');assert.notEqual(t.review_gate.status,'passed');
    }
    let t=task();applyGitHub(t,facts([review()]),start);assert.equal(t.review_gate.source,'administrator_policy');assert.equal(t.review_gate.status,'passed');assert.equal(t.state,'awaiting_merge');
    t=task();applyGitHub(t,facts([review({commit_id:'c'.repeat(40)})]),start);assert.notEqual(t.review_gate.status,'passed');assert.equal(t.review.matches_head,false);
    t=task();t.source_head='c'.repeat(40);applyGitHub(t,facts([review()]),start);assert.equal(t.review_gate.status,'stale');assert.equal(t.state,'blocked');
    t=task();applyGitHub(t,facts([review(),review({id:31,state:'DISMISSED'})]),start);assert.notEqual(t.review_gate.status,'passed');
    t=task();applyGitHub(t,facts([review(),review({id:31,state:'CHANGES_REQUESTED'})]),start);assert.equal(t.state,'changes_requested');
    t=task();applyGitHub(t,facts([review(),review({id:31,state:'CHANGES_REQUESTED',user:{type:'User',id:99,login:'stranger'}})]),start);assert.equal(t.review_gate.status,'passed');
    t=task();applyGitHub(t,facts([review(),review({id:31,state:'CHANGES_REQUESTED',commit_id:'c'.repeat(40)})]),start);assert.equal(t.review_gate.status,'changes_requested');assert.equal(t.review.matches_head,false);
    const pin=process.env.AWH_BUILDER_POLICY_SHA256;process.env.AWH_BUILDER_POLICY_SHA256='0'.repeat(64);t=task();applyGitHub(t,facts([review()]),start);assert.equal(t.review_gate.status,'not_checked');assert.equal(t.review.decision,null);assert.match(t.next_action,/授权未核验/);process.env.AWH_BUILDER_POLICY_SHA256=pin;
  }finally{Object.assign(catalog,original);refreshPolicy();}
});
function harness({merged=false,count=3}={}){
  let now=start,fail=null,drift=false,release=null,pause=false;const calls=[];
  const tasks=Array.from({length:count},(_,i)=>{const t=task(i+1);t.workflow='local-fast';return t;});
  const c={repository:repo,root:'configured-root'};
  const cache=new GitHubObservationCache({now:()=>now,command:async(command,args)=>{
    const path=args.at(-1);calls.push(path);if(pause){pause=false;await new Promise(resolve=>release=resolve);}if(fail)throw fail;
    if(path===`repos/${repo}`)return JSON.stringify({id:12,full_name:repo});
    const n=Number(/\/(?:issues|pulls)\/(\d+)/.exec(path)?.[1]);
    if(path.includes('/issues/'))return JSON.stringify({number:n,title:'Observed task',state:merged?'closed':'open'});
    if(/\/pulls\/\d+$/.test(path))return JSON.stringify({...pr(n,merged),head:{sha:drift?'c'.repeat(40):head,repo:{full_name:repo}}});
    if(path.includes('/reviews'))return JSON.stringify([review()]);
    if(path.endsWith('/status'))return JSON.stringify({statuses:[],total_count:0});
    if(path.includes('/check-runs'))return JSON.stringify({total_count:0,check_runs:[]});throw new Error('Unexpected path');
  }});
  return {cache,c,tasks,calls,advance:ms=>now+=ms,fail:e=>fail=e,recover:()=>fail=null,drift:()=>drift=true,pause:()=>pause=true,release:()=>release?.()};
}
test('default 5 minute active refresh, 1 minute and off modes; manual bypasses cache but coalesces',{timeout:5000},async()=>{
  const h=harness({count:1});await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert.equal(h.calls.length,7);const at=h.cache.read(repo,h.tasks[0]).record.at;
  h.advance(15000);await h.cache.observe(h.c,h.tasks);assert.equal(h.calls.length,7);assert.equal(h.cache.read(repo,h.tasks[0]).record.at,at);
  h.advance(285000);await h.cache.observe(h.c,h.tasks);await new Promise(setImmediate);assert.equal(h.calls.length,14);
  h.advance(60000);await h.cache.observe(h.c,h.tasks,{github_interval_seconds:60});await new Promise(setImmediate);assert.equal(h.calls.length,21);
  h.advance(3600000);await h.cache.observe(h.c,h.tasks,{github_interval_seconds:0});assert.equal(h.calls.length,21);
  h.pause();const one=h.cache.observe(h.c,h.tasks,{github_interval_seconds:0,refresh_github:true}),two=h.cache.observe(h.c,h.tasks,{github_interval_seconds:0,refresh_github:true});await new Promise(setImmediate);h.release();await Promise.all([one,two]);assert.equal(h.calls.length,28);
  await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert.equal(h.calls.length,28);
});
test('three completed tasks read metadata once, then no GitHub calls for an hour of 10-second local polls',async()=>{
  const h=harness({merged:true});await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert.equal(h.calls.length,19);assert.equal(h.calls.filter(p=>p===`repos/${repo}`).length,1);
  const observed=h.cache.read(repo,h.tasks[0]).record.at;
  for(let i=0;i<359;i++){h.advance(10000);await h.cache.observe(h.c,h.tasks);}
  assert.equal(h.calls.length,19);assert.equal(h.cache.read(repo,h.tasks[0]).record.at,observed);assert.equal(h.cache.read(repo,h.tasks[0]).gateFresh,false);
  h.advance(10000);await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert.equal(h.calls.length,38);
});
test('failure retains history but clears current Gate freshness; manual cannot bypass Retry-After/reset or failure backoff',async()=>{
  const h=harness({count:1});await h.cache.observe(h.c,h.tasks,{refresh_github:true});h.advance(10000);h.fail(new GitHubReadError('rate_limited',start+180000));await h.cache.observe(h.c,h.tasks,{refresh_github:true});const n=h.calls.length;
  assert.equal(h.cache.read(repo,h.tasks[0]).refresh.status,'rate_limited');assert.equal(h.cache.read(repo,h.tasks[0]).gateFresh,false);assert(h.cache.read(repo,h.tasks[0]).record);
  for(let i=0;i<10;i++)await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert.equal(h.calls.length,n);
  h.advance(170000);h.recover();h.drift();await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert.equal(h.cache.read(repo,h.tasks[0]).record.facts.pr.head.sha,'c'.repeat(40));
  h.advance(10000);h.fail(new Error('network'));await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert.equal(h.cache.read(repo,h.tasks[0]).refresh.status,'failed');assert.equal(h.cache.read(repo,h.tasks[0]).fresh,false);
  const failedCalls=h.calls.length;await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert.equal(h.calls.length,failedCalls);
  const error=githubReadFailure('HTTP/2.0 429\r\nRetry-After: 120\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: '+(start/1000+300)+'\r\n\r\n{}','rate limit exceeded',start);assert.equal(error.retryAt,start+300000);
});
test('shared request budget stops large completed queues instead of spawning unlimited child requests',async()=>{
  const h=harness({merged:true,count:15});await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert.equal(h.calls.length,73);h.advance(10000);await h.cache.observe(h.c,h.tasks,{refresh_github:true});assert(h.calls.length<=80);assert.equal(h.cache.read(repo,h.tasks[14]).refresh.status,'rate_limited');
});
test('slow queued reads exceed the bounded batch deadline without publishing a partial Gate',async()=>{
  let now=start,calls=0;
  const cache=new GitHubObservationCache({now:()=>now,command:async()=>{calls++;now+=46000;return JSON.stringify({id:12,full_name:repo});}}),t=task();
  await cache.observe({repository:repo,root:'configured'},[t],{refresh_github:true});assert.equal(calls,1);assert.equal(cache.read(repo,t).refresh.status,'failed');assert.equal(cache.read(repo,t).gateFresh,false);
});
test('fresh local execution survives old GitHub observations; Gate ages by independent configured interval',()=>{
  const t=task();t.active_actor=actor('coding_executor','Codex');t.observations=[observation('local_fast',start),observation('github',start-120000)];
  assert.equal(localStale(t,start),false);assert.equal(githubStale(t,start),false);assert.equal(taskStale(t,start),false);
  t.github_refresh.interval_seconds=60;assert.equal(githubStale(t,start),true);assert.equal(taskStale(t,start),false);assert.equal(localStale(t,start+46000),true);
});
test('browser manual refresh sends explicit native-refresh read and shares repeated clicks',async()=>{
  const paths=[];let release;const reader=new DashboardReader({publish:()=>{},githubInterval:300,fetcher:async path=>{paths.push(path);await new Promise(resolve=>release=resolve);return {ok:false,status:503};},openStream:()=>null});
  const a=reader.refreshGitHub(),b=reader.refreshGitHub();assert.equal(a,b);assert.match(paths[0],/refresh_github=1.*github_interval=300/);release();await assert.rejects(a);reader.stop();
});
