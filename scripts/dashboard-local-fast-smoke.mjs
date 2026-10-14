import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { ControlPlaneStore } from '../dist/control-plane/store.js';
import { npmEntry, npmEnv } from './npm-tool.mjs';

// Explicit original completed checkout only; no flow/next, start, authorize or Stage.
assert.equal(process.platform,'win32');
assert.equal(process.argv.length,3,'Supply the existing completed Sandbox root');
const repository=realpathSync(process.argv[2]),root=realpathSync(new URL('../',import.meta.url));
const output=join(root,'.handoff','local-fast-smoke');mkdirSync(output,{recursive:true});
const external=mkdtempSync(join(tmpdir(),'awh-issue97-viewer-')),state=join(external,'state');mkdirSync(state);
const bindingFile=join(repository,'.git','awh-local-fast','state.json'),binding=JSON.parse(readFileSync(bindingFile));
assert.equal(binding.repository,'zlpoot/awh-m1-e-sandbox');assert.deepEqual(binding.issues,[1,2]);assert(binding.tasks.every(t=>t.phase==='completed'));
const watcherDirectory=join(process.env.LOCALAPPDATA,'AWH','local-fast',String(binding.repository_id));
const watch=JSON.parse(readFileSync(join(watcherDirectory,'watcher.json')));assert.equal(watch.status,'QUEUE_COMPLETED');assert(!existsSync(join(watcherDirectory,'watcher.lock')));
const protectedFiles=[bindingFile,join(watcherDirectory,'scope.json'),join(watcherDirectory,'watcher.json')];
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex'),before=protectedFiles.map(digest);
const env=npmEnv(join(external,'cache'));
const command=args=>{const r=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
let child,browser;let failures=[];
async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}}
try {
  const pack=JSON.parse(command(['scripts/client-pack.mjs','--viewer','--output',join(output,'packages')]));
  command([npmEntry(),'install','--prefix',join(external,'install'),'--ignore-scripts','--offline','--no-audit','--no-fund',pack.artifact]);
  const installed=join(external,'install','node_modules','@zlpoot','awh-viewer');
  const database=join(external,'cp.sqlite');const profile=JSON.parse(readFileSync(join(root,'examples','protocol','project-alpha.json'))).profile_policy;
  new ControlPlaneStore(database,[profile],undefined,'initialize').close();const dbBefore=digest(database);
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const config=join(external,'viewer.json');writeFileSync(config,JSON.stringify({schema_version:'1.0',mode:'local_browser_direct',database,port,viewer:{id:'issue97-isolated-viewer',project_ids:[]},local_bindings:[],local_fast_projects:{project_roots:[dirname(repository)],state_directory:state}}));
  const start=async()=>{
    child=spawn(process.execPath,[join(installed,'dist','dashboard-cli.js'),'--config',config],{cwd:external,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Viewer timeout')),15000);let bytes='';child.stderr.on('data',v=>failures.push(String(v)));child.once('exit',()=>{clearTimeout(timer);reject(new Error('Viewer exited'));});child.stdout.on('data',chunk=>{bytes+=chunk;try{const result=JSON.parse(bytes);clearTimeout(timer);resolve(result);}catch{}});});
  };
  const ready=await start();const origin=new URL(ready.url).origin;
  browser=await chromium.launch({headless:false,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const context=await browser.newContext({viewport:{width:1600,height:1100},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));context.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  await page.goto(ready.v2_url);await page.getByRole('link',{name:'添加项目',exact:true}).click();
  await page.getByLabel('Local Fast 项目目录',{exact:true}).fill(repository);
  await page.getByRole('button',{name:'检查 Local Fast 项目',exact:true}).click();
  await page.getByRole('dialog').waitFor();assert((await page.getByRole('dialog').innerText()).includes('确认只读观察已有队列'));
  await page.getByRole('button',{name:'取消',exact:true}).click();assert(!existsSync(join(state,'dashboard-local-fast.json')));
  await page.getByRole('button',{name:'检查 Local Fast 项目',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});await page.screenshot({path:join(output,'add-project.png'),fullPage:true});
  await page.goto(ready.v2_url);
  const observations=[];
  const completedSnapshot=async()=>{
    const until=Date.now()+60000;
    while(Date.now()<until){const s=await page.evaluate(async()=>await(await fetch('/dashboard/v1/snapshot')).json());observations.push({at:new Date().toISOString(),tasks:s.tasks?.map(t=>({issue:t.issue.number,state:t.state,observations:t.observations}))});if(s.tasks?.length===2&&s.tasks.every(t=>t.state==='completed'))return s;await new Promise(r=>setTimeout(r,1000));}
    writeFileSync(join(output,'observations-failed.json'),JSON.stringify(observations,null,2));throw new Error('Completed Sandbox snapshot did not stabilize');
  };
  const snapshot=await completedSnapshot();
  writeFileSync(join(output,'snapshot-readback.json'),JSON.stringify(snapshot,null,2));
  assert.equal(snapshot.runs.length,0);assert.equal(snapshot.tasks.length,2);
  for(const task of snapshot.tasks){assert.equal(task.state,'completed');assert.equal(task.review.state,'COMMENTED');assert.equal(task.review.decision,'PASS');assert.equal(task.pr.state,'closed');assert(task.pr.merged_at);assert.equal(task.watcher.status,'QUEUE_COMPLETED');assert(task.history.some(h=>h.source==='watcher'&&h.type==='attempt_published'));assert.equal(task.stage.status,'passed');}
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByRole('button',{name:`#1 ${snapshot.tasks[0].issue.title}`,exact:true}).first().waitFor();
  await page.getByText('已完成',{exact:true}).nth(2).waitFor();
  await page.screenshot({path:join(output,'overview.png'),fullPage:true});
  await page.getByRole('button',{name:/任务.*Tasks/}).click();await page.screenshot({path:join(output,'tasks.png'),fullPage:true});
  for(const task of snapshot.tasks){
    await page.getByRole('button',{name:`#${task.issue.number} ${task.issue.title}`,exact:true}).click();await page.getByRole('dialog').waitFor();
    await page.screenshot({path:join(output,`issue-${task.issue.number}-detail.png`),fullPage:true});
    await page.getByRole('heading',{name:'证据与 HEAD',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(output,`issue-${task.issue.number}-evidence.png`),fullPage:true});
    await page.getByRole('heading',{name:'历史记录',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(output,`issue-${task.issue.number}-history.png`),fullPage:true});
    await page.getByRole('dialog').getByRole('button',{name:'关闭任务详情',exact:true}).click();
  }
  await stop();await start();await page.goto(ready.v2_url);
  await completedSnapshot();
  assert.equal(digest(database),dbBefore);assert.deepEqual(protectedFiles.map(digest),before);assert.equal(errors.length,0);
  assert(!requests.some(r=>/\/(start|bind|authorize|stop)$/.test(r.url)));
  writeFileSync(join(output,'snapshot.json'),JSON.stringify(snapshot,null,2));
  writeFileSync(join(output,'observations.json'),JSON.stringify(observations,null,2));
  writeFileSync(join(output,'acceptance.json'),JSON.stringify({status:'PASS',platform:process.platform,installed_viewer:installed,external,artifact:pack.artifact,head:command(['-e',"process.stdout.write(require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())"]),tasks:snapshot.tasks.map(t=>({issue:t.issue.number,state:t.state,pr:t.pr.number,head:t.source_head,review:t.review,watcher:t.watcher,stage:t.stage})),cp_runs:0,protected_files_unchanged:true,restore:'PASS',page_errors:errors,owner_confirmation:'GUI_OWNER_CONFIRMATION_NOT_INTEGRATED',new_business_e2e:'NOTRUN'},null,2));
  console.log(JSON.stringify({status:'PASS',output,external}));
} catch(error){writeFileSync(join(output,'failure.json'),JSON.stringify({error:String(error),stderr:failures},null,2));throw error;}
finally{await browser?.close();await stop();assert.deepEqual(protectedFiles.map(digest),before);}
