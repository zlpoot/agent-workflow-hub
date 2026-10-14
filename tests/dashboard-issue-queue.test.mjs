import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {harness,repository} from './helpers/local-fast-harness.mjs';
import {createLocalFastProjects} from '../dist/dashboard/local-fast-projects.js';
import {LocalFastWatcher} from '../dist/workflow/local-fast-watcher.js';
import {LocalFastObservationAdapter} from '../dist/dashboard/local-fast-observation.js';
import {readFlow} from '../dist/workflow/flow.js';
import {assertContract} from '../dashboard/adapter.mjs';
import {chromium} from 'playwright';
import {createDashboardGateway} from '../dist/dashboard/gateway.js';
import {fixtureStore} from './store-fixture.mjs';

export async function completedQueue(t){
 const h=harness(t),external=mkdtempSync(join(tmpdir(),'awh-queue-case-')),state=join(external,'viewer');mkdirSync(state);
 const executable=join(external,'codex.exe');writeFileSync(executable,'synthetic');
 await h.client().bind(repository,'1',true,['node --test tests/smoke.test.mjs']);
 h.git(['add','.awh/flow.json']);h.git(['commit','-m','Synthetic old queue declaration']);const head=h.git(['rev-parse','HEAD']);
 h.git(['push',h.remote,'HEAD:refs/heads/codex/local-fast-1']);
 h.prs.push({number:10,html_url:`https://github.com/${repository}/pull/10`,state:'open',draft:false,merged_at:null,merge_commit_sha:head,
  user:{id:11,login:'synthetic-owner',type:'User'},body:`<!-- awh-local-fast:${repository}#1 -->\nCloses #1`,
  head:{ref:'codex/local-fast-1',sha:head,repo:{id:42,full_name:repository}},base:{ref:'main',sha:h.initialMain,repo:{id:42,full_name:repository}}});
 h.review(10);h.merge(10);
 const original=JSON.parse(readFileSync(h.statePath));original.tasks=[{issue:1,branch:'codex/local-fast-1',base:h.initialMain,worktree:join(h.repo,'.handoff/local-fast/issue-1'),phase:'completed',head,pr:10}];writeFileSync(h.statePath,JSON.stringify(original));
 const watch={platform:'win32',interactive:true,localData:external,fast:h.deps,alive:()=>false};
 const oldWatcher=new LocalFastWatcher(h.repo,watch);oldWatcher.authorize(repository,'1',new Date(Date.now()+3600000).toISOString(),executable,true,true);
 const oldScope=readFileSync(oldWatcher.scope_file),grant=JSON.parse(oldScope),oldWatch=join(dirname(oldWatcher.scope_file),'watcher.json');
 writeFileSync(oldWatch,JSON.stringify({scope_version:grant.scope_version,status:'QUEUE_COMPLETED',attempts:[{issue:1,status:'published',executor_pid:123}],executor_launches:1,merge_count:1,human_interventions:1}));
 const config={project_roots:[dirname(h.repo)],state_directory:state},overrides={fast:h.deps,watch};
 const gui=createLocalFastProjects(config,overrides);t.after(()=>gui.close());
 await gui.handle('attach',{directory:h.repo,repository,head,confirm:true});
 const preview=await gui.handle('inspect',{directory:h.repo});
 const save=issues=>gui.handle('queue-save',{directory:h.repo,repository,head,issues,queue_revision:preview.queue_revision,confirm:true});
 const command=async(c,a,cwd)=>{
  const path=a.at(-1);if(c==='gh'&&path.includes('/check-runs'))return JSON.stringify({total_count:0,check_runs:[]});
  if(c==='gh'&&path.endsWith('/status'))return JSON.stringify({total_count:0,statuses:[]});
  const value=h.deps.run(c,a,cwd);
  if(c==='gh'&&path.includes('/reviews'))return JSON.stringify(JSON.parse(value).map(r=>({...r,user:{...r.user,login:'synthetic-reviewer',type:'User'}})));
  return value;
 };
 return {h,head,gui,watch,config,overrides,executable,oldWatcher,oldScope,oldWatch,preview,save,command};
}
test('Issue browser is bounded, read-only, excludes PRs, and rejects scope/page injection',async t=>{
 const f=await completedQueue(t),run=f.h.deps.run;
 f.h.deps.run=(c,a,cwd)=>{const value=run(c,a,cwd);return c==='gh'&&a.at(-1).includes('/issues?')?JSON.stringify([...JSON.parse(value),{number:99,title:'Synthetic PR',state:'open',pull_request:{}}]):value;};
 const rows=await f.gui.handle('issues',{directory:f.h.repo,page:1});
 assert.deepEqual(rows.items.map(i=>i.number),[2,3,4,5,6]);assert(rows.items.every(i=>i.url.startsWith(`https://github.com/${repository}/issues/`)));
 const bytes=readFileSync(f.h.statePath);
 await assert.rejects(f.gui.handle('issues',{directory:f.h.repo,repository:'other/repo'}),e=>e.code==='local_fast_input');
 for(const page of ['1',0,21,1.5])await assert.rejects(f.gui.handle('issues',{directory:f.h.repo,page}));
 assert(readFileSync(f.h.statePath).equals(bytes));
});
test('candidate order persists through service restart without changing binding, grants or starting execution',async t=>{
 const f=await completedQueue(t),before=readFileSync(f.h.statePath),watch=readFileSync(f.oldWatch);
 await f.gui.handle('queue-draft',{directory:f.h.repo,repository,issues:'6,5'});
 const restored=createLocalFastProjects(f.config,f.overrides);t.after(()=>restored.close());
 assert.deepEqual((await restored.handle('inspect',{directory:f.h.repo})).draft_issues,[6,5]);
 assert(readFileSync(f.h.statePath).equals(before));assert(readFileSync(f.oldWatch).equals(watch));assert(readFileSync(f.oldWatcher.scope_file).equals(f.oldScope));
 await assert.rejects(f.gui.handle('queue-draft',{directory:f.h.repo,repository,issues:'5,5'}),e=>e.code==='local_fast_input');
});
test('completed round rolls over once, retains exact history and old authority, requires fresh scope, and initializes worktree declarations',async t=>{
 const f=await completedQueue(t),before=readFileSync(f.h.statePath),watch=readFileSync(f.oldWatch);
 const saved=await f.save('6,5');assert.deepEqual(saved.issues,[6,5]);assert(saved.queue_id!=='legacy');
 const archived=join(f.h.repo,'.git/awh-local-fast/queues/legacy/state.json');assert(readFileSync(archived).equals(before));
 assert(readFileSync(f.oldWatcher.scope_file).equals(f.oldScope));assert(readFileSync(f.oldWatch).equals(watch));
 assert.deepEqual(readFlow(f.h.repo).issues,[6,5]);
 await assert.rejects(f.save('5,6'),e=>e.code==='local_fast_preview_changed');
 const currentWatcher=new LocalFastWatcher(f.h.repo,f.watch);assert(!existsSync(currentWatcher.scope_file));
 await assert.rejects(currentWatcher.run(true));
 await assert.rejects(f.oldWatcher.run(true),e=>e.code==='local_fast_watch_scope');
 currentWatcher.authorize(repository,'6,5',new Date(Date.now()+3600000).toISOString(),f.executable,false,true);
 const scope=JSON.parse(readFileSync(currentWatcher.scope_file));assert.equal(scope.queue_id,saved.queue_id);assert.equal(scope.allow_merge,false);
 assert(readFileSync(f.oldWatcher.scope_file).equals(f.oldScope));
 const selected=await f.h.client().flow(true);assert.equal(selected.issue,6);assert.deepEqual(readFlow(selected.worktree).issues,[6,5]);
});
test('closed/reused Issues and repository locks cannot replace the current queue',async t=>{
 const f=await completedQueue(t),before=readFileSync(f.h.statePath);
 f.h.closeIssue(6);await assert.rejects(f.save('6,5'),e=>e.code==='local_fast_issue');
 await assert.rejects(f.save('1,5'),e=>e.code==='local_fast_queue_history');
 const lock=join(dirname(f.oldWatcher.scope_file),'watcher.lock');writeFileSync(lock,JSON.stringify({pid:process.pid,scope_version:JSON.parse(f.oldScope).scope_version}));
 await assert.rejects(f.save('5'),e=>e.code==='local_fast_watch_locked');assert(readFileSync(f.h.statePath).equals(before));assert(existsSync(lock));unlinkSync(lock);
});
test('in-flight queues may save candidates but cannot change execution order',async t=>{
 const h=harness(t);await h.bind();await h.client().flow(true);
 const external=mkdtempSync(join(tmpdir(),'awh-active-candidate-'));const gui=createLocalFastProjects({project_roots:[dirname(h.repo)],state_directory:external},{fast:h.deps,watch:{platform:'win32',localData:external,alive:()=>false}});t.after(()=>gui.close());
 await gui.handle('attach',{directory:h.repo,repository,head:h.initialMain,confirm:true});const p=await gui.handle('inspect',{directory:h.repo}),before=readFileSync(h.statePath);
 assert.equal(p.queue_editable,false);await gui.handle('queue-draft',{directory:h.repo,repository,issues:'6,5'});
 await assert.rejects(gui.handle('queue-save',{directory:h.repo,repository,head:h.initialMain,issues:'6,5',queue_revision:p.queue_revision,confirm:true}),e=>e.code==='local_fast_queue_active');assert(readFileSync(h.statePath).equals(before));
});
test('observation retains actual archived PR/Review/Merge and shows new Issues blocked on their own Owner scope',async t=>{
 const f=await completedQueue(t);await f.save('6,5');
 const adapter=new LocalFastObservationAdapter(f.gui.configs,{command:f.command,alive:()=>false});
 const tasks=await adapter.observe(f.gui.projectIds(),[],{refresh_github:true});assert.equal(tasks.length,3);
 const history=tasks.find(t=>t.issue.number===1);assert.equal(history.queue_archived,true);assert.equal(history.state,'completed');assert.equal(history.pr.number,10);assert.equal(history.review.decision,'PASS');assert.equal(history.watcher.status,'QUEUE_COMPLETED');assert.equal(history.owner_scope.status,'not_checked');
 for(const task of tasks.filter(t=>!t.queue_archived)){assert.equal(task.state,'blocked');assert.match(task.blockers.join(' '),/Owner/);assert.equal(task.watcher.executor_running,null);}
 for(const task of tasks)assertContract('TaskResponse',{contract_version:'1.0',authority_verified:false,item:task});
});
test('canonical queue changes during a simulated Coding child stop Stage before publication',async t=>{
 const f=await completedQueue(t);const saved=await f.save('6,5');
 const watch={...f.watch,executor:{type:'codex-cli',run:async()=>{const state=JSON.parse(readFileSync(f.h.statePath));state.queue_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';writeFileSync(f.h.statePath,JSON.stringify(state));return {exit_code:0};}}};
 const current=new LocalFastWatcher(f.h.repo,watch);current.authorize(repository,'6,5',new Date(Date.now()+3600000).toISOString(),f.executable,false,true);
 const result=await current.run(true);assert.equal(result.reason,'local_fast_watch_scope_changed');
 assert(!f.h.calls.some(c=>c.command==='git'&&c.args[0]==='push'));assert(readFileSync(f.oldWatcher.scope_file).equals(f.oldScope));assert(saved.queue_id!=='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
});
test('Windows Edge Issue selection/sort/remove, draft restore, cancelled and duplicate-confirmed next round preserve old history',{skip:process.platform!=='win32',timeout:240000},async t=>{
 const f=await completedQueue(t),before=readFileSync(f.h.statePath),oldWatch=readFileSync(f.oldWatch);
 const profile=JSON.parse(readFileSync('examples/protocol/project-alpha.json')).profile_policy;
 let gui=f.gui,store,gateway,origin;
 const start=async()=>{store=fixtureStore(':memory:',[profile]);gateway=createDashboardGateway({enabled:true,store,assets:'dist/dashboard-ui',assetsV2:'dist/dashboard-v2',localBrowserViewer:{id:'issue-queue-fixture',project_ids:gui.projectIds()},localFastProjects:gui,tasks:new LocalFastObservationAdapter(gui.configs,{command:f.command,alive:()=>false})});await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${gateway.server.address().port}`;};
 await start();const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const output=join(process.cwd(),'.handoff/issue-queue-browser');mkdirSync(output,{recursive:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage();page.setDefaultTimeout(60000);
  const errors=[],actions=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/dashboard/local-fast/v1/'))actions.push(new URL(r.url()).pathname.split('/').at(-1));});
  await page.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));});
  const project=async()=>{await page.goto(origin+'/dashboard');await page.getByRole('button',{name:/项目.*Projects/}).click();await page.getByRole('button',{name:new RegExp(repository)}).click();await page.getByText('正在处理本机操作…',{exact:true}).waitFor({state:'hidden'});await page.getByRole('list',{name:'GitHub OPEN Issues',exact:true}).locator('li').first().waitFor();};
  await project();await page.getByLabel('筛选本页 Issue').fill('Issue 5');await page.getByRole('button',{name:'加入 Issue #5',exact:true}).click();assert(await page.getByRole('button',{name:'Issue #5 已加入',exact:true}).isDisabled());
  await page.getByLabel('筛选本页 Issue').fill('');await page.getByRole('button',{name:'加入 Issue #6',exact:true}).click();await page.getByRole('button',{name:'上移 Issue #6',exact:true}).click();assert.equal(await page.getByLabel('候选 Issue 队列').inputValue(),'6,5');
  await page.getByRole('button',{name:'移除 Issue #5',exact:true}).click();await page.getByRole('button',{name:'加入 Issue #5',exact:true}).click();await page.getByRole('button',{name:'保存候选队列',exact:true}).click();await page.getByText('候选队列已保存，Viewer 重启后可继续编辑。',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'ordered-candidate.png'),fullPage:true});assert(readFileSync(f.h.statePath).equals(before));
  await gateway.close();store.close();gui=createLocalFastProjects(f.config,f.overrides);await start();await project();assert.equal(await page.getByLabel('候选 Issue 队列').inputValue(),'6,5');
  await page.getByRole('button',{name:'预览保存执行队列…',exact:true}).click();assert((await page.getByRole('dialog').innerText()).includes('6,5'));await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();assert(readFileSync(f.h.statePath).equals(before));
  await page.getByRole('button',{name:'预览保存执行队列…',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).dblclick();await page.getByRole('dialog').waitFor({state:'hidden'});
  const state=JSON.parse(readFileSync(f.h.statePath));assert.deepEqual(state.issues,[6,5]);assert.deepEqual(state.previous_queues,['legacy']);
  assert(readFileSync(join(f.h.repo,'.git/awh-local-fast/queues/legacy/state.json')).equals(before));assert(readFileSync(f.oldWatcher.scope_file).equals(f.oldScope));assert(readFileSync(f.oldWatch).equals(oldWatch));
  await page.waitForFunction(async()=>{const s=await(await fetch('/dashboard/v1/snapshot')).json();return s.tasks.length===3&&s.tasks.find(t=>t.issue.number===1)?.queue_archived;},{},{polling:1000});
  await page.getByRole('heading',{name:'历史任务 · 已保留的队列',exact:true}).waitFor();assert(await page.getByRole('button',{name:'启动已有 Owner scope…',exact:true}).isDisabled());
  await page.getByLabel('Codex 可执行文件').fill(f.executable);await page.getByRole('button',{name:'复制Owner 授权命令',exact:true}).click();const command=await page.evaluate(()=>navigator.clipboard.readText());assert(command.includes("--issues '6,5'"));assert(command.includes('dist'));
  await page.screenshot({path:join(output,'new-round-history.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(output,'mobile-candidate.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__csp),[]);assert(!actions.some(a=>['start','authorize'].includes(a)));
  writeFileSync(join(output,'verification.json'),JSON.stringify({status:'PASS',provider:'SIMULATED',scope:'ISOLATED',order:[6,5],draft_restart:true,cancel:true,duplicate_confirm:true,history_unchanged:true,new_scope_required:true,queue_started:false,page_errors:errors},null,2));
 }finally{await browser.close();await gateway.close();store.close();}
});
