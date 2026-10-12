import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {taskBase,applyGitHub,controlPlaneTasks} from '../dist/dashboard/tasks.js';
import {LocalFastObservationAdapter,GitHubObservationAdapter,validateObservationConfigs} from '../dist/dashboard/local-fast-observation.js';
import {createDashboardGateway} from '../dist/dashboard/gateway.js';
import {createViewerAuthenticator} from '../dist/dashboard/security.js';
import {assertContract} from '../dashboard/adapter.mjs';
import {taskFixtures} from './task-fixture.mjs';
const head='a'.repeat(40),repo='example-org/project-alpha';
const now=Date.parse('2026-10-12T08:00:00Z');
const pr=(overrides={})=>({number:3,state:'open',draft:true,merged_at:null,merge_commit_sha:null,head:{sha:head,repo:{full_name:repo}},base:{repo:{full_name:repo}},user:{id:1},...overrides});
const review=(overrides={})=>({id:9,state:'APPROVED',commit_id:head,user:{id:2,login:'reviewer'},...overrides});
function task(){const t=taskBase('lf:p:1','p',repo,1);t.workflow='local-fast';t.source_head=head;t.pr={number:3,state:null,draft:null,merged_at:null,merge_sha:null};return t;}
function facts(reviews=[],overrides={}){return {issue:{number:1,title:'Managed task',state:'open'},pr:pr(),reviews,checks:{status:'passed',count:0},...overrides};}
test('native exact-HEAD review, changes, merge and identity gates; no claimed reviewer execution',()=>{
  let t=task();applyGitHub(t,facts(),now);assert.equal(t.state,'awaiting_review');assert.equal(t.active_actor,null);assert.equal(t.waiting_for.name,'ChatGPT Reviewer');
  t=task();applyGitHub(t,facts([review()]),now);assert.equal(t.state,'awaiting_merge');assert.equal(t.waiting_for.role,'owner');
  t=task();applyGitHub(t,facts([review({state:'CHANGES_REQUESTED'})]),now);assert.equal(t.state,'changes_requested');
  t=task();applyGitHub(t,facts([review({commit_id:'b'.repeat(40)})]),now);assert.equal(t.state,'awaiting_review');assert.equal(t.review.matches_head,false);assert.equal(t.review.decision,null);
  t=task();applyGitHub(t,facts([review()],{pr:pr({head:{sha:'b'.repeat(40),repo:{full_name:repo}}})}),now);assert.equal(t.state,'blocked');assert.match(t.blockers.join(' '),/HEAD/);
  t=task();applyGitHub(t,facts([review()],{pr:pr({state:'closed',merged_at:'2026-10-12T07:00:00Z',merge_commit_sha:'c'.repeat(40)}),issue:{number:1,title:'Managed task',state:'closed'}}),now);assert.equal(t.state,'completed');assert.equal(t.active_actor,null);assert.equal(t.waiting_for,null);
  t=task();applyGitHub(t,facts([],{pr:pr({state:'closed',merged_at:'2026-10-12T07:00:00Z'})}),now);assert.equal(t.state,'blocked');
  assert.throws(()=>applyGitHub(task(),facts([],{pr:pr({head:{sha:head,repo:{full_name:'foreign/repo'}}})}),now));
});
test('structured COMMENTED author PASS is Local Fast only; dismissed/latest review cannot reuse PASS',()=>{
  const commented=review({state:'COMMENTED',user:{id:1,login:'owner'},body:'AWH-LOCAL-FAST-REVIEW v1\n```json\n'+JSON.stringify({head,decision:'PASS'})+'\n```'});
  let t=task();applyGitHub(t,facts([commented]),now);assert.equal(t.state,'awaiting_merge');assert.equal(t.review.state,'COMMENTED');
  t=task();t.workflow='standard';applyGitHub(t,facts([commented]),now);assert.equal(t.state,'awaiting_review');
  t=task();applyGitHub(t,facts([review(),review({id:10,state:'DISMISSED'})]),now);assert.equal(t.state,'awaiting_review');
  t=task();applyGitHub(t,facts([review()],{checks:{status:'failed',count:1}}),now);assert.equal(t.state,'blocked');
  t=task();t.stage={head,status:'failed',checks:[{name:'Focused check',exit_code:1}]};applyGitHub(t,facts([review()]),now);assert.equal(t.state,'blocked');assert.match(t.blockers.join(' '),/Stage/);
});
function adapterFixture(t){
  const dir=mkdtempSync(join(tmpdir(),'awh-task-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const root=join(dir,'repo'),watcher=join(dir,'watcher');mkdirSync(join(root,'.git','awh-local-fast'),{recursive:true});mkdirSync(watcher);
  const state={schema_version:'1.0',mode:'local-fast',repository:repo,repository_id:12,root,issues:[1],checks:['node --test tests/smoke.test.mjs'],tasks:[{issue:1,phase:'completed',pr:3,head}]};
  const save=()=>writeFileSync(join(root,'.git','awh-local-fast','state.json'),JSON.stringify(state));save();
  const scope={repository:repo,repository_id:12,root,issues:[1],source:'windows-owner-confirmation',scope_version:'v1',expires_at:'2026-10-13T08:00:00Z',allow_merge:true};
  writeFileSync(join(watcher,'scope.json'),JSON.stringify(scope));
  const watch={scope_version:'v1',attempts:[{issue:1,status:'published'}],status:'QUEUE_COMPLETED'};
  const saveWatch=()=>writeFileSync(join(watcher,'watcher.json'),JSON.stringify(watch));saveWatch();
  const config={project_id:'p',repository:repo,root,watcher_directory:watcher,machine:{id:'test-machine',name:'Test machine',platform:'windows'},executor_name:'Other Agent'};
  let clock=now,deny=false,headDrift=false,merge=true;const requests=[];
  const deps={now:()=>clock,alive:pid=>pid===123,command:async(command,args,cwd)=>{
    requests.push({command,args,cwd});if(command==='git')return args[0]==='remote'?`https://github.com/${repo}.git`:'.git';
    if(deny)throw new Error('permission_denied');const path=args.at(-1);
    if(path===`repos/${repo}`)return JSON.stringify({id:12,full_name:repo});
    if(path.includes('/issues/1'))return JSON.stringify({number:1,title:'Real task',state:merge?'closed':'open'});
    if(path.endsWith('/pulls/3'))return JSON.stringify(pr({head:{sha:headDrift?'b'.repeat(40):head,repo:{full_name:repo}},state:merge?'closed':'open',merged_at:merge?'2026-10-12T07:00:00Z':null,merge_commit_sha:merge?'c'.repeat(40):null}));
    if(path.includes('/reviews'))return JSON.stringify([review()]);
    if(path.endsWith('/status'))return JSON.stringify({statuses:[],total_count:0});
    if(path.includes('/check-runs'))return JSON.stringify({check_runs:[],total_count:0});throw new Error('Unexpected request '+path);
  }};
  const adapter=new LocalFastObservationAdapter([config],deps);
  return {adapter,state,watch,save,saveWatch,requests,config,root,watcher,deps,advance:()=>clock+=16000,deny:()=>deny=true,drift:()=>headDrift=true,unmerged:()=>merge=false};
}
test('read-only adapter checks live GitHub facts, finite queue, cache, scope and no sensitive paths/logs',async t=>{
  const h=adapterFixture(t);validateObservationConfigs([h.config],['p']);
  assert.throws(()=>validateObservationConfigs([h.config],['foreign']));assert.throws(()=>validateObservationConfigs([{...h.config,machine:{...h.config.machine,name:'C:/private'}}],['p']));
  assert.deepEqual(await h.adapter.observe(['foreign']),[]);assert.equal(h.requests.length,0);
  mkdirSync(join(h.root,'.handoff','local-fast','checks'),{recursive:true});
  writeFileSync(join(h.root,'.handoff','local-fast','checks',`1-${head}.json`),JSON.stringify({mode:'local-fast',head,logs:[{command:h.state.checks[0],exit_code:0,stdout:'private raw output',stderr:'private raw error'}]}));
  const tasks=await h.adapter.observe(['p'],[],{refresh_github:true});assert.equal(tasks[0].state,'completed');assert.equal(tasks[0].watcher.running,false);assert.equal(tasks[0].machine.name,'Test machine');
  assertContract('TaskResponse',{contract_version:'1.0',authority_verified:false,item:tasks[0]});
  const serialized=JSON.stringify(tasks);assert(!serialized.includes(h.root));assert(!serialized.includes(h.watcher));assert(!serialized.includes('executable'));
  assert(!serialized.includes('private raw'));assert.equal(tasks[0].stage.status,'passed');
  assert(h.requests.every(r=>r.command==='git'||r.args[0]==='api'&&r.args.includes('--method')&&r.args.includes('GET')&&(r.args.at(-1)===`repos/${repo}`||r.args.at(-1).startsWith(`repos/${repo}/`))));
  const count=h.requests.length;await h.adapter.observe(['p'],[],{refresh_github:true});assert.equal(h.requests.length,count);
  h.advance();h.deny();const unknown=(await h.adapter.observe(['p'],[],{refresh_github:true}))[0];assert.equal(unknown.state,'unknown');assert.equal(unknown.review_gate.status,'stale');assert.equal(unknown.observations.at(-1).status,'permission_denied');assert.equal(unknown.active_actor,null);
});
test('Watcher stopped, HEAD drift, actual executor PID, incomplete Stage and invalid binding stay honest',async t=>{
  const h=adapterFixture(t);h.unmerged();h.state.tasks[0].phase='awaiting_review';h.save();mkdirSync(join(h.root,'.handoff','local-fast','checks'),{recursive:true});writeFileSync(join(h.root,'.handoff','local-fast','checks',`1-${head}.json`),JSON.stringify({mode:'local-fast',head,logs:[]}));let task=(await h.adapter.observe(['p'],[],{refresh_github:true}))[0];assert.equal(task.state,'blocked');assert.equal(task.stage.status,'not_checked');assert.match(task.blockers.join(' '),/Watcher/);
  h.advance();h.drift();task=(await h.adapter.observe(['p'],[],{refresh_github:true}))[0];assert.equal(task.state,'blocked');assert.match(task.blockers.join(' '),/HEAD/);
  h.advance();h.state.tasks[0].phase='developing';h.watch.attempts[0]={issue:1,status:'running',executor_pid:123};h.save();h.saveWatch();writeFileSync(join(h.watcher,'watcher.lock'),JSON.stringify({scope_version:'v1',pid:123}));task=(await h.adapter.observe(['p'],[],{refresh_github:true}))[0];assert.equal(task.active_actor.name,'Other Agent');assert.equal(task.state,'developing');
  h.advance();h.state.tasks[0].phase='publishing';h.watch.attempts[0]={issue:1,status:'published'};h.save();h.saveWatch();writeFileSync(join(h.root,'.git','awh-local-fast','operation.lock'),'123');task=(await h.adapter.observe(['p'],[],{refresh_github:true}))[0];assert.equal(task.active_actor.role,'stage');assert.equal(task.state,'verifying');
  h.advance();h.state.repository='foreign/repo';h.save();task=(await h.adapter.observe(['p'],[],{refresh_github:true}))[0];assert.equal(task.state,'unknown');assert.equal(task.issue.number,0);
});
test('all fixtures conform to closed DTO; browser rejects injected credentials and unknown nested fields',()=>{
  for(const item of taskFixtures(now))assertContract('TaskResponse',{contract_version:'1.0',authority_verified:false,item});
  const item=taskFixtures(now)[0];assert.throws(()=>assertContract('TaskResponse',{contract_version:'1.0',authority_verified:false,item:{...item,token:'secret'}}));
  assert.throws(()=>assertContract('TaskResponse',{contract_version:'1.0',authority_verified:false,item:{...item,watcher:{...item.watcher,scope_file:'C:/secret'}}}));
});
test('CP completion/review declaration is not native PASS; stale presence suppresses active actor and retains histories',()=>{
  const f=JSON.parse(readFileSync(new URL('../examples/protocol/project-alpha.json',import.meta.url)));const run={...f.run,state:'review_passed',started_at:'2026-10-12T07:00:00Z'};
  const view={work_items:[f.work_item],runs:[run],events:[],executors:[{executor:f.executor,last_seen:new Date(now-120000).toISOString()}]};
  let t=controlPlaneTasks(view,now)[0];assert.equal(t.state,'awaiting_review');assert.equal(t.review,null);
  run.state='completed';t=controlPlaneTasks(view,now)[0];assert.equal(t.state,'unknown');
  run.state='running';t=controlPlaneTasks(view,now)[0];assert.equal(t.active_actor,null);assert.equal(t.observations[0].freshness,'stale');
});
test('CP native GitHub observer joins only configured managed tasks; cache invalidates changed HEAD and failure clears PASS',async t=>{
  const h=adapterFixture(t),c={project_id:'p',repository:repo,root:h.root};const adapter=new GitHubObservationAdapter([c],h.deps);
  const original=task();original.workflow='standard';original.id='cp:test';
  assert.deepEqual(await adapter.observe(['foreign'],[original]),[]);
  let results=await adapter.observe(['p'],[original],{refresh_github:true});assert.equal(results[0].state,'completed');assert.equal(original.github_head,null);
  h.unmerged();h.advance();results=await adapter.observe(['p'],[original],{refresh_github:true});assert.equal(results[0].state,'awaiting_review');
  h.advance();h.deny();results=await adapter.observe(['p'],[original],{refresh_github:true});assert.equal(results[0].state,'unknown');assert.equal(results[0].review_gate.status,'stale');
});
test('two Viewer adapters share native reads while live local process state refreshes independently',async t=>{
  const h=adapterFixture(t);h.unmerged();h.state.tasks[0].phase='developing';h.watch.attempts[0]={issue:1,status:'running',executor_pid:123};h.save();h.saveWatch();writeFileSync(join(h.watcher,'watcher.lock'),JSON.stringify({scope_version:'v1',pid:123}));
  const second=new LocalFastObservationAdapter([h.config],h.deps);
  const [one,two]=await Promise.all([h.adapter.observe(['p'],[],{refresh_github:true}),second.observe(['p'],[],{refresh_github:true})]);assert.equal(one[0].active_actor.name,'Other Agent');assert.equal(two[0].active_actor.name,'Other Agent');assert.equal(h.requests.filter(r=>r.command==='gh').length,7);
  const ghAt=one[0].observations.find(o=>o.source==='github').observed_at;
  h.advance();h.watch.attempts[0]={issue:1,status:'published'};h.saveWatch();rmSync(join(h.watcher,'watcher.lock'));
  const updated=(await h.adapter.observe(['p']))[0];assert.equal(updated.active_actor,null);assert.equal(updated.watcher.running,false);assert.equal(updated.observations.find(o=>o.source==='github').observed_at,ghAt);assert.equal(h.requests.filter(r=>r.command==='gh').length,7);
});
test('task API authenticates, scopes adapters, rejects mutations/invalid filters and reads details',async t=>{
  const view={cursor:0,projects:[],runs:[],work_items:[],executors:[],events:[],policies:[]};
  const store={dashboardReadView:()=>view,dashboardRevision:()=>''};
  const cookie='a'.repeat(43);const authenticate=createViewerAuthenticator([{id:'viewer',project_ids:['project-alpha'],session_sha256:createHash('sha256').update(cookie).digest('hex'),expires_at:new Date(now+3600000).toISOString()}],()=>now);
  const gateway=createDashboardGateway({enabled:true,store,assets:'dist/dashboard-ui',authenticate,now:()=>now,tasks:{observe:async ids=>{assert.deepEqual(ids,['project-alpha']);return taskFixtures(now);}}});
  await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));t.after(()=>gateway.close());const base=`http://127.0.0.1:${gateway.server.address().port}/dashboard/v1`;
  const get=(path,options={})=>fetch(base+path,{headers:{Cookie:'awh_viewer='+cookie},...options});
  assert.equal((await fetch(base+'/tasks')).status,401);assert.equal((await get('/tasks',{method:'POST'})).status,405);assert.equal((await get('/tasks?project_id=foreign')).status,403);assert.equal((await get('/tasks?state=wrong')).status,400);assert.equal((await get('/tasks?role=owner&role=reviewer')).status,400);
  const page=await (await get('/tasks?limit=2')).json();assert.equal(page.items.length,2);assert(page.items.every(i=>i.project_id==='project-alpha'));assertContract('TaskPage',page);
  const detail=await (await get('/tasks/'+encodeURIComponent(page.items[0].id))).json();assertContract('TaskResponse',detail);
  assert.equal((await get('/tasks/fixture:task:2')).status,404);
});
