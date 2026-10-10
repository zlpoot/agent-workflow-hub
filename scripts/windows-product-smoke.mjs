import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createControlPlaneServer, ControlPlaneStore, createAuthenticator } from '../dist/control-plane/index.js';
import { initManifest, inspectRepository } from '../dist/client/local.js';
import { CLIENT_VERSION } from '../dist/client/version.js';
import { npmEntry, npmEnv } from './npm-tool.mjs';

// Entirely synthetic CP/projects and fresh external installs. No production input.
assert.equal(process.argv.length,2,'No live input accepted');
const output=resolve('.handoff/windows-product-smoke',new Date().toISOString().replaceAll(':','-'));
mkdirSync(output,{recursive:true});const base=mkdtempSync(join(tmpdir(),'awh-installed-windows-'));
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(k)));
const sha=value=>createHash('sha256').update(value).digest('hex');
function sync(file,args,cwd=base,env=cleanEnv){const r=spawnSync(file,args,{cwd,env,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,windowsHide:true});assert.equal(r.status,0,'Fixture command failed: '+args[0]);return r.stdout.trim();}
const git=(cwd,args)=>sync('git',['-c','commit.gpgsign=false','-c','core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null'),...args],cwd,{...cleanEnv,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
function repository(name,origin,ref){const root=join(base,name);mkdirSync(root);git(root,['init','-b','product/fixture']);git(root,['config','user.name','Fixture']);git(root,['config','user.email','fixture@example.invalid']);git(root,['remote','add','origin','https://github.com/'+origin+'.git']);writeFileSync(join(root,'product.txt'),'preserved fixture');git(root,['add','.']);git(root,['commit','-m','fixture']);initManifest(inspectRepository(root),name,ref);git(root,['add','.']);git(root,['commit','-m','identity']);return root;}
function bytes(path){const result={};function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())walk(file);else result[file.slice(path.length)]=sha(readFileSync(file));}}walk(path);return result;}
async function until(predicate){for(let i=0;i<120;i++){if(await predicate())return;await delay(100);}throw new Error('Installed fixture timed out');}
function child(file,args,cwd){const p=spawn(process.execPath,[file,...args],{cwd,env:cleanEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});p.output='';p.diagnostic='';p.stdout.on('data',b=>p.output+=b.toString());p.stderr.on('data',b=>p.diagnostic+=b.toString());return p;}
async function command(entry,args,cwd){return new Promise((resolveResult,reject)=>{const p=child(entry,args,cwd);const timer=setTimeout(()=>{p.kill();reject(new Error('Fixture Client timeout'));},30000);p.once('error',reject);p.once('close',code=>{clearTimeout(timer);if(![0,2].includes(code))reject(new Error('Fixture Client failed'));else resolveResult({code,value:JSON.parse(p.output)});});});}
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
const sourceBefore=sync('git',['rev-parse','HEAD'],process.cwd());
let cp,store,resident,viewer,browser;
try{
  const packages=[];
  for(const component of ['client','viewer']){
    const pack=JSON.parse(sync(process.execPath,['scripts/client-pack.mjs',...(component==='viewer'?['--viewer']:[]),'--output',join(output,'packages')],process.cwd()));packages.push({component,...pack});
    const install=join(base,component+'-install');sync(process.execPath,[npmEntry(),'install','--prefix',install,'--offline','--ignore-scripts','--no-audit','--no-fund',pack.artifact],base,npmEnv(join(base,component+'-cache')));
  }
  const entry=join(base,'client-install/node_modules/@zlpoot/awh-client/dist/client/cli.js'),viewerEntry=join(base,'viewer-install/node_modules/@zlpoot/awh-viewer/dist/dashboard-cli.js');
  const clientVersion=(await command(entry,['--version'],base)).value;assert.equal(clientVersion.version,CLIENT_VERSION);
  const repo=repository('webskill','zlpoot/webskill','webskill/bootstrap'),other=repository('second','zlpoot/unapproved-example','unapproved/example');
  const f=JSON.parse(readFileSync('examples/protocol/webskill.json'));store=new ControlPlaneStore(join(base,'scratch.sqlite'),[{...f.profile_policy,ref:'webskill/bootstrap'}]);
  const token='awh_cp_'+randomBytes(32).toString('base64url'),principal={id:'scratch-client',project_ids:['webskill'],executor_ids:['scratch-executor']};
  cp=createControlPlaneServer({store,authenticate:createAuthenticator([{...principal,token_sha256:sha(token)}])});await new Promise(r=>cp.server.listen(0,'127.0.0.1',r));
  const config={schema_version:'1.0',endpoint:'http://127.0.0.1:'+cp.server.address().port,credential_file:join(base,'original.credential'),state_directory:join(base,'original-state'),executor_id:'scratch-executor',executor_type:'codex'};
  writeFileSync(config.credential_file,token,{mode:0o600});const configPath=join(base,'original-client.json');writeFileSync(configPath,JSON.stringify(config));
  const registered=(await command(entry,['--config',configPath,'register'],repo)).value;
  store.registerWorkItem(principal,f.work_item);store.createRun(principal,{...f.run,executor_id:registered.executor.id,machine_id:registered.executor.machine.id,profile:{...f.run.profile,ref:'webskill/bootstrap'}});
  // These are retained synthetic records seeded before the measurement window.
  const beforeView=store.dashboardReadView({project_ids:['webskill']}),beforeState=bytes(config.state_directory),beforeRepo=bytes(repo),beforeOther=bytes(other),writes=[];
  cp.server.on('request',request=>{if(request.method!=='GET')writes.push(request.url);});
  const viewerConfig=join(base,'viewer.json'),port=await freePort(),binding={id:'scratch-webskill',project_id:'webskill',repository:'zlpoot/webskill',worktree:repo,client_entry:entry,client_entry_sha256:sha(readFileSync(entry)),config_file:configPath};
  writeFileSync(viewerConfig,JSON.stringify({schema_version:'1.0',mode:'local_browser_direct',database:join(base,'scratch.sqlite'),port,viewer:{id:'scratch-viewer',project_ids:['webskill','second']},local_bindings:[binding,{...binding,id:'scratch-second',project_id:'second',repository:'zlpoot/unapproved-example',worktree:other,config_file:undefined}]}));
  viewer=child(viewerEntry,['--config',viewerConfig],base);await until(()=>{if(viewer.exitCode!==null){writeFileSync(join(output,'viewer-start.stderr.log'),viewer.diagnostic);throw new Error('Installed Viewer exited; see private fixture startup log');}return viewer.output.includes('/dashboard');});
  browser=await chromium.launch({headless:true,executablePath:process.env.AWH_DASHBOARD_TEST_BROWSER||undefined});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],requests=[];
  const origin='http://127.0.0.1:'+port;page.on('pageerror',error=>errors.push(error.message));page.on('request',r=>requests.push({method:r.method(),origin:new URL(r.url()).origin}));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin+'/dashboard');await page.getByRole('heading',{name:'最近运行'}).waitFor();
  await page.getByRole('button',{name:'添加项目向导',exact:true}).click();await page.getByRole('heading',{name:'第 1 步 · 选择项目'}).waitFor();
  assert(!(await page.locator('.wizard-source').innerText()).includes('#35'));await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.getByRole('button',{name:'检测当前安装与配置',exact:true}).click();await page.getByText('当前安装：'+CLIENT_VERSION+' · 配置：passed',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'installed-current.png'),fullPage:true});await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.getByText('当前已安装 Client 离线 Doctor · 观测时间',{exact:false}).waitFor();assert(await page.getByText('branch_profile_conflict',{exact:true}).isVisible());
  await page.screenshot({path:join(output,'installed-doctor.png'),fullPage:true});
  const current=await page.evaluate(()=>fetch('/dashboard/onboarding/v1/doctor/scratch-webskill').then(r=>r.json()));assert.equal(current.item.client_version,CLIENT_VERSION);assert.equal(current.item.status,'blocked');assert.equal(current.item.approved_version,null);
  const second=await page.evaluate(()=>fetch('/dashboard/onboarding/v1/doctor/scratch-second').then(r=>r.json()));assert.equal(second.item.status,'blocked');assert(second.item.checks.some(c=>c.code==='repository_not_in_static_profiles'));
  await page.getByRole('button',{name:'1选择项目',exact:false}).click().catch(()=>{});
  await page.getByRole('button',{name:'上一步',exact:true}).click();await page.getByRole('button',{name:'上一步',exact:true}).click();
  await page.getByText('输入本机实际 Git 工作树与仓库',{exact:true}).click();await page.getByRole('textbox',{name:'本机仓库',exact:true}).fill('evil/unregistered');await page.getByRole('textbox',{name:'本机工作树',exact:true}).fill(repo);
  await page.getByRole('button',{name:'核对本机登记',exact:true}).click();assert(await page.getByText('BLOCKED：此工作树未在当前 Viewer 范围登记。',{exact:false}).isVisible());
  const first=await page.evaluate(()=>fetch('/dashboard/v1/snapshot').then(r=>r.json()));
  // Force only the temporary fixture's last_seen to the past; never a real DB.
  const {DatabaseSync}=await import('node:sqlite');const fixtureDb=new DatabaseSync(join(base,'scratch.sqlite'));fixtureDb.prepare('UPDATE executors SET last_seen = ? WHERE id = ?').run(new Date(Date.now()-61000).toISOString(),registered.executor.id);fixtureDb.close();
  await until(()=>page.getByText('已连接 · 最近成功刷新：',{exact:false}).isVisible());
  await until(async()=>{const v=await page.evaluate(()=>fetch('/dashboard/v1/snapshot').then(r=>r.json()));return v.executors[0]?.status==='offline';});
  await page.evaluate(()=>{window.fixtureHints=0;const es=new EventSource('/dashboard/v1/events/stream?after=0');es.addEventListener('view-refresh',()=>window.fixtureHints++);window.fixtureStream=es;});
  await until(()=>page.evaluate(()=>window.fixtureHints>=1));
  resident=child(entry,['--config',configPath,'resident','start'],repo);await until(()=>resident.output.includes('started'));
  await until(async()=>{const result=await command(entry,['--config',configPath,'resident','status'],repo);return result.value.online===true;});
  await until(async()=>page.evaluate(()=>window.fixtureHints>=2));const online=await page.evaluate(()=>fetch('/dashboard/v1/snapshot').then(r=>r.json()));assert.equal(online.executors[0].status,'online');assert.equal(online.cursor,first.cursor);
  await page.getByRole('tab',{name:'执行器',exact:true}).click();await page.getByText('在线',{exact:true}).waitFor();await page.screenshot({path:join(output,'installed-presence.png'),fullPage:true});
  const stop=await command(entry,['--config',configPath,'resident','stop'],repo);assert.equal(stop.value.stopping,true);await until(()=>resident.exitCode!==null);resident=null;
  const stopped=await command(entry,['--config',configPath,'resident','status'],repo);assert.equal(stopped.value.running,false);
  resident=child(entry,['--config',configPath,'resident','start'],repo);await until(()=>resident.output.includes('started'));await until(async()=> (await command(entry,['--config',configPath,'resident','status'],repo)).value.online===true);
  assert.equal((await command(entry,['--config',configPath,'resident','stop'],repo)).value.stopping,true);await until(()=>resident.exitCode!==null);resident=null;
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'添加项目向导',exact:true}).click();await page.screenshot({path:join(output,'installed-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  const cookies=await context.cookies();assert(cookies.every(c=>c.name==='awh_viewer'&&c.httpOnly&&c.sameSite==='Strict'&&c.path==='/dashboard'));assert.deepEqual(await page.evaluate(()=>({cookie:document.cookie,local:localStorage.length,session:sessionStorage.length})),{cookie:'',local:0,session:0});
  const afterView=store.dashboardReadView({project_ids:['webskill']});assert.deepEqual(afterView.projects,beforeView.projects);assert.deepEqual(afterView.runs,beforeView.runs);assert.deepEqual(afterView.events,beforeView.events);assert.deepEqual(bytes(config.state_directory),beforeState);assert.deepEqual(bytes(repo),beforeRepo);assert.deepEqual(bytes(other),beforeOther);
  assert(writes.length>=2&&writes.every(path=>path==='/v1/executors/scratch-executor/heartbeat'));assert.equal(errors.length,0);assert(requests.every(r=>r.method==='GET'&&r.origin===origin));
  const evidence={status:'INSTALLED_WINDOWS_OFFLINE_FIXTURE_PASS',environment:{platform:process.platform,arch:process.arch,node:process.version,browser:await browser.version()},source_before:sourceBefore,source_after:sync('git',['rev-parse','HEAD'],process.cwd()),packages:packages.map(({component,version,artifact,sha256})=>({component,version,artifact,sha256})),checks:['clean external offline install without source imports','ordinary browser bootstrap','default current source','installed Client offline Doctor/config/version','unapproved second Git project blocked','unknown input blocked','Client start/status/stop/restart','browser REST/SSE cursor-constant heartbeat refresh','existing identity/project/state/Run/Event bytes preserved','scoped HttpOnly cookie','390px viewport'],heartbeat_writes:writes.length,new_business_writes:0,production_operations:0,scope:'synthetic scratch CP and Git projects only; real Future UI/second project/RC/Mac/review NOTRUN',authority_verified:false};
  assert.equal(evidence.source_before,evidence.source_after);writeFileSync(join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await browser?.close();resident?.kill();viewer?.kill();if(viewer?.exitCode===null)await new Promise(r=>viewer.once('exit',r));await cp?.close();store?.close();assert.equal(dirname(base),tmpdir());assert(base.startsWith(join(tmpdir(),'awh-installed-windows-')));rmSync(base,{recursive:true,force:true});}
