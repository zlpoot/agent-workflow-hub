import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { fixtureStore } from '../tests/store-fixture.mjs';
import { dashboardHeaders } from '../dist/dashboard/gateway.js';
import { readZip } from './release-archive.mjs';
import { npmEntry, npmEnv } from './npm-tool.mjs';

// Installed production Viewer, scratch CP declarations, no fixture host/TaskAdapter,
// live GitHub, real credentials, production config or production state.
assert.equal(process.argv.length, 2, 'No live inputs are accepted');
const root = realpathSync(new URL('../', import.meta.url));
const output = join(root, '.handoff/dashboard-v2-viewer-smoke'); mkdirSync(output, {recursive:true});
const base = mkdtempSync(join(tmpdir(), 'awh-v2-viewer-'));
const env = {...npmEnv(join(base,'cache')), LOCALAPPDATA:join(base,'localapp')}; mkdirSync(env.LOCALAPPDATA);
const command = args => {
  const r = spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
  assert.equal(r.status,0,r.stderr || 'Local packaging/install failed'); return r.stdout;
};
let browser, child, writer;
const stopViewer = async () => {
  if (child && child.exitCode === null && child.signalCode === null) {const exited=once(child,'exit');child.kill();await exited;}
};
try {
  const pack = JSON.parse(command(['scripts/client-pack.mjs','--viewer','--output',join(output,'packages')]));
  for (const file of ['index.html','app.js','app.css']) assert(pack.files.includes('dist/dashboard-v2/'+file));
  assert(!pack.files.some(f=>/build-report|build-inputs|tests\/|fixture/.test(f)));
  const ui = JSON.parse(command(['scripts/ui-pack.mjs','--output',join(output,'packages')]));
  const archive = readZip(readFileSync(ui.artifact));
  assert.deepEqual([...archive.keys()].sort(),['index.html','app.js','app.css','validators.cjs','v2/index.html','v2/app.js','v2/app.css'].sort());
  command([npmEntry(),'install','--prefix',join(base,'installed'),'--ignore-scripts','--offline','--no-audit','--no-fund',pack.artifact]);
  const installed = join(base,'installed/node_modules/@zlpoot/awh-viewer');
  for (const file of ['index.html','app.js','app.css','validators.cjs']) assert.deepEqual(archive.get(file),readFileSync(join(installed,'dist/dashboard-ui',file)));
  for (const file of ['index.html','app.js','app.css']) assert.deepEqual(archive.get('v2/'+file),readFileSync(join(installed,'dist/dashboard-v2',file)));

  const f = JSON.parse(readFileSync(join(root,'examples/protocol/project-alpha.json'),'utf8').replaceAll('project-alpha','issue90-scratch').replaceAll('fixture','scratch'));
  const stamp = new Date().toISOString(); f.run.created_at=stamp; f.run.updated_at=stamp;
  f.work_item.reference.repository=f.project.repository;
  f.executor.display_name='Windows 隔离执行器';
  const database = join(base,'scratch.sqlite'); writer=fixtureStore(database,[f.profile_policy]);
  const principal={id:'scratch-client',project_ids:[f.project.id],executor_ids:[f.executor.id]};
  writer.registerProject(principal,f.manifest);
  writer.registerExecutor(principal,f.executor,{schema_version:'1.0',executor_type:'codex',machine_name:'windows-issue90-scratch',arch:'x64',client_version:'0.1.0'});
  writer.registerWorkItem(principal,f.work_item);writer.createRun(principal,f.run);
  let sequence=0;
  const append=(type,data)=>writer.append(principal,f.run.id,{schema_version:'1.0',kind:'event',id:'scratch-event-'+(++sequence),run_id:f.run.id,sequence,type,occurred_at:new Date().toISOString(),payload:{schema_version:'1.0',data,extensions:{}}});
  append('RUN_STARTED',{source_sha:f.run.source.sha});
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const config=join(base,'viewer.json');writeFileSync(config,JSON.stringify({schema_version:'1.0',mode:'local_browser_direct',database,port,viewer:{id:'scratch-viewer',project_ids:[f.project.id]},local_bindings:[]}));
  const startViewer=async()=>{
    child=spawn(process.execPath,[join(installed,'dist/dashboard-cli.js'),'--config',config],{cwd:base,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Installed Viewer timeout')),10000);let bytes='';
      child.once('error',()=>{clearTimeout(timer);reject(new Error('Installed Viewer launch failed'));});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Installed Viewer stopped before readiness'));});
      child.stderr.on('data',data=>process.stderr.write(data));
      child.stdout.on('data',data=>{bytes+=data;try{const result=JSON.parse(bytes);clearTimeout(timer);assert.equal(result.v2_url,`http://127.0.0.1:${port}/dashboard/v2`);resolve(result);}catch(error){if(bytes.includes('\n')){clearTimeout(timer);reject(error);}}});
    });
  };
  const ready=await startViewer(), origin=new URL(ready.url).origin;
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser=await chromium.launch({headless:true,executablePath:process.env.AWH_DASHBOARD_TEST_BROWSER ?? (existsSync(edge)?edge:undefined)});
  const context=await browser.newContext({viewport:{width:1440,height:1024},reducedMotion:'reduce'});
  await context.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));});
  const requests=[],errors=[],phases=new Set();
  context.on('request',r=>requests.push({path:new URL(r.url()).pathname,origin:new URL(r.url()).origin,method:r.method(),authorization:!!r.headers().authorization}));
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  let releaseSnapshot, releaseStream;
  const snapshotGate=new Promise(resolve=>{releaseSnapshot=resolve;}),streamGate=new Promise(resolve=>{releaseStream=resolve;});
  await page.route('**/dashboard/v1/snapshot*',async route=>{await snapshotGate;await route.continue();});
  await page.route('**/dashboard/v1/events/stream*',async route=>{await streamGate;await route.continue();});
  const response=await page.goto(ready.v2_url);
  assert.equal(response.status(),200);assert.equal(response.headers()['content-security-policy'],dashboardHeaders['Content-Security-Policy']);
  await page.getByText('加载中',{exact:true}).waitFor();phases.add('loading');releaseSnapshot();
  await page.getByText('连接实时更新中',{exact:true}).waitFor();phases.add('connecting');releaseStream();
  await page.getByText('已连接',{exact:true}).waitFor();phases.add('live');
  assert.equal(await page.locator('meta[name="awh-dataset"]').count(),0);
  assert.equal(await page.getByText('示例预览 · 模拟数据',{exact:true}).count(),0);
  const snapshot=await (await context.request.get(origin+'/dashboard/v1/snapshot')).json();
  assert.equal(snapshot.authority_verified,false);assert.equal(snapshot.tasks.length,1);assert.equal(snapshot.tasks[0].fixture,false);assert.equal(snapshot.tasks[0].state,'developing');
  assert(snapshot.tasks[0].observations.some(o=>o.source==='github'&&o.status==='not_checked'));
  await page.getByRole('button',{name:/^设置/}).click();
  await page.getByRole('heading',{name:'GitHub App',exact:true}).waitFor();
  await page.getByText('当前 Viewer 仅可查看。本机可信 Owner 启用管理功能后，才能检测和连接。',{exact:true}).waitFor();
  assert(await page.getByRole('button',{name:'检测配置',exact:true}).isDisabled());
  assert(await page.getByRole('textbox',{name:'PEM 本机路径',exact:true}).isDisabled());
  assert.equal(await page.getByText('App Fixture · 模拟数据 · 真实 Preflight NOTRUN',{exact:true}).count(),0);
  await page.screenshot({path:join(output,'installed-v2-settings-readonly.png'),fullPage:true});
  await page.getByRole('button',{name:/^总览/}).click();
  await page.screenshot({path:join(output,'desktop-overview.png'),fullPage:true});
  await page.getByRole('button',{name:/^任务/}).click();
  const table=page.locator('.desktop-table');await table.getByText('正在开发',{exact:true}).waitFor();
  assert(await table.getByText('windows-issue90-scratch',{exact:true}).isVisible());
  assert.equal(await table.getByRole('link',{name:'Issue',exact:true}).getAttribute('href'),`https://github.com/${f.work_item.reference.repository}/issues/${f.work_item.reference.number}`);
  await table.getByRole('button',{name:/^#6 /}).click();const detail=page.getByRole('dialog');await detail.waitFor();
  await detail.getByText('正在重新核验任务…').waitFor({state:'hidden'});
  assert(await detail.getByText('Windows 隔离执行器',{exact:true}).first().isVisible());
  await page.screenshot({path:join(output,'desktop-detail.png')});await page.keyboard.press('Escape');
  // Real persistent events through the installed read-only store and SSE, no route/ES double.
  append('VERIFICATION_STARTED',{subject_sha:f.run.source.sha});
  await table.getByText('验证 / 交付',{exact:true}).waitFor();
  append('VERIFICATION_PASSED',{subject_sha:f.run.source.sha,checks:f.profile_policy.verification.commands.map(command=>({command,exit_code:0}))});
  append('GITHUB_PR_CREATED',{pull_request:{provider:'github',repository:f.run.source.repository,kind:'pull_request',number:42},base_sha:'2'.repeat(40),head_sha:f.run.source.sha});
  await table.getByRole('link',{name:'PR #42',exact:true}).waitFor();
  assert.equal(await table.getByRole('link',{name:'PR #42',exact:true}).getAttribute('href'),`https://github.com/${f.work_item.reference.repository}/pull/42`);
  append('RUN_FAILED',{reason:'Isolated test failure'});
  await table.getByText('Owner',{exact:true}).waitFor();assert(await table.getByText('阻塞 / 待处理',{exact:true}).isVisible());
  await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('已连接',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'desktop-tasks.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});const mobile=page.locator('.mobile-tasks');
  assert(await mobile.getByText('Windows 隔离执行器 · windows-issue90-scratch',{exact:true}).isVisible());
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(output,'mobile-tasks.png'),fullPage:true});
  await mobile.getByRole('button',{name:/^#6 /}).click();await detail.waitFor();await page.screenshot({path:join(output,'mobile-detail.png')});await page.keyboard.press('Escape');
  await page.getByRole('button',{name:/^总览/}).click();await page.screenshot({path:join(output,'mobile-overview.png'),fullPage:true});
  await page.getByRole('button',{name:/^任务/}).click();
  // Stop and restart this exact scratch Viewer. Retained snapshot downgrades facts.
  await stopViewer();await page.getByRole('alert').waitFor();phases.add('offline/outdated');
  await mobile.getByText('状态未知',{exact:true}).waitFor();assert(await mobile.getByText('等待：重新核验',{exact:true}).isVisible());
  await page.screenshot({path:join(output,'mobile-offline.png'),fullPage:true});
  await startViewer();await page.reload();await page.getByText('已连接',{exact:true}).waitFor();phases.add('recovered');
  await page.getByRole('button',{name:/^任务/}).click();await mobile.getByText('等待：Owner',{exact:true}).waitFor();
  const denied=await context.newPage();await denied.goto(ready.v2_url);
  assert.equal((await context.request.post(origin+'/dashboard/v1/snapshot',{data:{}})).status(),405);
  for(const path of ['/dashboard/v2/build-report.json','/dashboard/v2/validators.cjs'])assert.equal((await context.request.get(origin+path)).status(),404);
  assert.equal((await context.request.get(origin+'/dashboard/v1/snapshot',{headers:{Origin:'https://evil.invalid'}})).status(),401);
  assert.equal((await context.request.get(origin+'/dashboard/v1/snapshot',{headers:{Authorization:'Bearer invalid'}})).status(),401);
  const unauth=await browser.newContext();assert.equal((await unauth.request.get(origin+'/dashboard/v1/snapshot')).status(),401);await unauth.close();
  // Storage and network assertions cover all V2 interactions before intentional API denial probes.
  assert.deepEqual(await page.evaluate(()=>({cookie:document.cookie,local:localStorage.length,session:sessionStorage.length})),{cookie:'',local:0,session:0});
  assert((await context.cookies()).every(c=>c.httpOnly&&c.sameSite==='Strict'&&c.path==='/dashboard'));
  assert(requests.every(r=>r.origin===origin&&r.method==='GET'&&!r.authorization));
  assert.deepEqual(await page.evaluate(()=>window.__csp),[]);assert.deepEqual(errors,[]);
  await page.getByRole('link',{name:'Dashboard V1'}).click();await page.getByRole('heading',{name:'最近运行',exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/dashboard');assert.equal(await page.getByText('示例预览 · 模拟数据',{exact:true}).count(),0);
  await page.screenshot({path:join(output,'v1-fallback.png'),fullPage:true});
  await page.getByRole('tab',{name:'设置',exact:true}).click();
  await page.getByText('当前 Viewer 仅可查看。本机可信 Owner 启用管理功能后，才能检测和连接。',{exact:true}).waitFor();
  assert(await page.getByRole('button',{name:'检测配置',exact:true}).isDisabled());
  await stopViewer();writer.close();writer=null;
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),before=sha(readFileSync(database));
  await startViewer();await page.goto(ready.v2_url);await page.getByText('已连接',{exact:true}).waitFor();await stopViewer();
  assert.equal(sha(readFileSync(database)),before,'Viewer must preserve scratch database bytes');
  const evidence={platform:process.platform,browser:await browser.version(),host:'installed production Viewer + isolated scratch CP',fixture_host:false,authority_verified:false,viewer_sha256:pack.sha256,ui_sha256:ui.sha256,phases:[...phases],requests:requests.length,csp_violations:[],browser_errors:errors,database_bytes_unchanged:true,checks:['V2 direct bootstrap','installed V2 + V1 App settings readonly (no management policy; GET only)','same-origin GET Reader REST + real SSE','CP tasks/executor/machine/responsibility/detail + safe Issue/PR links','manual refresh','1440px + 390px','actual Viewer stop/restart degradation + recovery','HttpOnly/SameSite + empty browser storage + CSP','UI/Viewer byte equality + closed archives','V1 fallback'],native_owner_ui:'NOTRUN',real_app_connect:'NOTRUN',mac:'NOTRUN',production_cutover:'NOTRUN'};
  writeFileSync(join(output,'verification.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();await stopViewer();writer?.close();
  const target=realpathSync(base);assert.equal(dirname(target),realpathSync(tmpdir()));assert(target.startsWith(join(realpathSync(tmpdir()),'awh-v2-viewer-')));rmSync(target,{recursive:true,force:true});
}
