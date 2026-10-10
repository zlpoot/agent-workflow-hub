import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ControlPlaneStore, DashboardReadStore, validateExistingDatabase } from '../dist/control-plane/store.js';
import { approveEnrollment } from '../dist/control-plane/enrollment.js';
import { readTrustedConfig } from '../dist/control-plane/config.js';
import { createAuthenticator } from '../dist/control-plane/security.js';
import { enrollmentPreview, submitEnrollment, finishEnrollment, setupMachine, enrollmentBindings, diagnoseEnrollment } from '../dist/client/enrollment.js';
import { DashboardProjection } from '../dist/dashboard/projection.js';
import { localBrowserSession } from '../dist/dashboard/local-browser.js';
import { npmEntry, npmEnv } from '../scripts/npm-tool.mjs';
import { CLIENT_VERSION } from '../dist/client/version.js';
import { chromium } from 'playwright';
import { trustedFixture } from './versioned-profile-fixture.mjs';

const hash = v => createHash('sha256').update(v).digest('hex');
const resources = new WeakMap();
const env = {...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform === 'win32' ? 'NUL' : '/dev/null',GIT_TERMINAL_PROMPT:'0'};
const policy = JSON.parse(readFileSync(new URL('../examples/protocol/webskill.json',import.meta.url))).profile_policy;
function git(root,args){const r=spawnSync('git',['-c','core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null'),'-c','commit.gpgsign=false',...args],{cwd:root,env,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);}
function repo(base,name,origin='sample/second-project') {const root=join(base,name);mkdirSync(root);git(root,['init','-b','feature/customer-work']);git(root,['config','user.name','Fixture']);git(root,['config','user.email','fixture@example.invalid']);git(root,['remote','add','origin','https://github.com/'+origin+'.git']);writeFileSync(join(root,'unchanged.txt'),'retain');git(root,['add','.']);git(root,['commit','-m','fixture']);writeFileSync(join(root,'untracked.txt'),'local work');return root;}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function start(t,args){const child=spawn(process.execPath,['dist/control-plane-cli.js',...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});const exit=once(child,'exit');resources.get(t).children.push({child,exit});let output='',errors='';child.stderr.on('data',c=>errors+=c);let timer;try{await Promise.race([new Promise(r=>child.stdout.on('data',c=>{output+=c;if(output.includes('listening'))r();})),exit.then(()=>{throw new Error(errors);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CP startup timeout')),10000);})]);}finally{clearTimeout(timer);}return {child,exit};}
async function fixture(t){
 const base=mkdtempSync(join(tmpdir(),'awh-enrollment-'));const owned={children:[],readers:[],stops:[]};resources.set(t,owned);t.after(async()=>{await Promise.allSettled(owned.stops.map(stop=>stop()));for(const {child,exit} of owned.children){if(child.exitCode===null){child.kill();await exit;}}for(const reader of owned.readers)reader.close();assert.equal(dirname(base),tmpdir());assert(base.startsWith(join(tmpdir(),'awh-enrollment-')));rmSync(base,{recursive:true,force:true});});
 const database=join(base,'cp.sqlite'),trusted=join(base,'trusted.json'),token='awh_cp_'+randomBytes(32).toString('base64url');
 const oldClient={id:'old-client',project_ids:['legacy'],executor_ids:['old-executor'],token_sha256:hash(token)};
 writeFileSync(trusted,JSON.stringify({clients:[oldClient],profiles:[policy]}));const store=new ControlPlaneStore(database,[policy]);store.close();
 const endpoint='http://127.0.0.1:'+await port();const cp=await start(t,['serve','--database',database,'--config',trusted,'--port',new URL(endpoint).port]);
 const installed=join(base,'installed');mkdirSync(installed);
 const install=spawnSync(process.execPath,[npmEntry(),'install','--prefix',installed,'--offline','--ignore-scripts','--no-audit','--no-fund',resolve('.handoff/packages/zlpoot-awh-client-'+CLIENT_VERSION+'.tgz')],{env:npmEnv(join(base,'cache')),encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(install.status,0,'Standalone fixture install failed');
 const entry=join(installed,'node_modules','@zlpoot','awh-client','dist','client','cli.js'),home=join(base,'machine');mkdirSync(home);const machinePath=join(base,'machine.json');
 setupMachine({path:machinePath,endpoint,home,projectRoot:base,clientEntry:entry});
 owned.stops.push(async()=>{for(const binding of enrollmentBindings(machinePath)){await new Promise(resolve=>{const c=spawn(process.execPath,[entry,'--config',binding.config_file,'resident','stop'],{cwd:binding.worktree,windowsHide:true,stdio:'ignore'});c.once('close',()=>resolve());});}});
 return {base,database,trusted,oldClient,cp,endpoint,entry,home,machinePath};
}

test('unregistered dirty Git project: preview → request → trusted CP approval → installed init → presence without business writes',async t=>{
 const h=await fixture(t),root=repo(h.base,'project');const original=readFileSync(join(root,'unchanged.txt'));
 const preview=enrollmentPreview(h.machinePath,root);assert.equal(preview.dirty,true);assert.equal(preview.status,'confirmation_required');assert(!existsSync(join(root,'.awh')));
 const request=submitEnrollment(h.machinePath,root,'observe');assert.equal(request.status,'approval_required');assert(!existsSync(join(root,'.awh')));
 assert.deepEqual(submitEnrollment(h.machinePath,root,'observe'),request);await assert.rejects(finishEnrollment(h.machinePath,root));assert(!existsSync(join(root,'.awh')));
 const options={request:request.request_file,trustedConfig:h.trusted,database:h.database,confirm:false};assert.equal(approveEnrollment(options).status,'approval_required');assert.deepEqual(readTrustedConfig(h.trusted).clients,[h.oldClient]);
 approveEnrollment({...options,confirm:true});assert.equal(approveEnrollment({...options,confirm:true}).disposition,'idempotent');
 const finished=await new Promise((resolve,reject)=>{const c=spawn(process.execPath,[h.entry,'init','--machine-config',h.machinePath,'--directory',root,'--complete','--confirm'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);c.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});
 assert.equal(finished.status,'registered');assert(readFileSync(join(root,'unchanged.txt')).equals(original));assert(existsSync(join(root,'untracked.txt')));
 const binding=enrollmentBindings(h.machinePath)[0];const reader=new DashboardReadStore(h.database,()=>enrollmentBindings(h.machinePath));resources.get(t).readers.push(reader);
 const projection=new DashboardProjection(reader,{id:'fixture-viewer',project_ids:[finished.project_id]});const snapshot=projection.snapshot();assert.equal(snapshot.projects.length,1);assert.equal(snapshot.executors.length,1);assert.equal(snapshot.executors[0].status,'online');assert.equal(snapshot.runs.length,0);assert.equal(snapshot.cursor,0);
 const credential=readFileSync(join(dirname(finished.config_file),'credential'),'utf8');const headers={Authorization:'Bearer '+credential,'Content-Type':'application/json'};
 for(const path of ['/v1/runs','/v1/work-items/register','/v1/runs/unknown/events']){const r=await fetch(h.endpoint+path,{method:'POST',headers,body:'{}'});assert.equal(r.status,403);assert.equal((await r.json()).error.code,'presence_only');}
 const impersonation={schema_version:'1.0',kind:'executor',id:binding.executor_id,display_name:'Wrong',machine:{id:'wrong-machine',platform:process.platform==='win32'?'windows':'linux'}};
 assert.equal((await fetch(h.endpoint+'/v1/executors/register',{method:'POST',headers,body:JSON.stringify(impersonation)})).status,403);
 const cfg=readFileSync(finished.config_file);unlinkSync(finished.config_file);await finishEnrollment(h.machinePath,root);assert(readFileSync(finished.config_file).equals(cfg));
 const conflict=JSON.parse(cfg);conflict.executor_id='wrong-executor';writeFileSync(finished.config_file,JSON.stringify(conflict));const bytes=readFileSync(finished.config_file);await assert.rejects(finishEnrollment(h.machinePath,root));assert(readFileSync(finished.config_file).equals(bytes));writeFileSync(finished.config_file,cfg);
 const diagnosis=await diagnoseEnrollment(h.machinePath,root,true);assert.equal(diagnosis.checks.find(c=>c.id==='worktree').status,'passed');assert.equal(diagnosis.checks.find(c=>c.id==='cp_connection').status,'passed');
 const trust=readTrustedConfig(h.trusted);assert.deepEqual(trust.clients[0],h.oldClient);assert.deepEqual(trust.profiles,[policy]);validateExistingDatabase(h.database,trust.profiles,trust.enrollments);
 const db=new DatabaseSync(h.database,{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,0);db.close();
 h.cp.child.kill();await h.cp.exit;await start(t,['serve','--database',h.database,'--config',h.trusted,'--port',new URL(h.endpoint).port]);await finishEnrollment(h.machinePath,root);
});

test('one logical repository on two worktrees shares Project and Machine but isolates executors and credentials',async t=>{
 const h=await fixture(t),a=repo(h.base,'a'),b=repo(h.base,'b');
 const enrolled=[];
 for(const root of [a,b]){const request=submitEnrollment(h.machinePath,root,'observe');approveEnrollment({request:request.request_file,trustedConfig:h.trusted,database:h.database,confirm:true});enrolled.push(await finishEnrollment(h.machinePath,root));}
 assert.equal(enrolled[0].project_id,enrolled[1].project_id);assert.equal(enrolled[0].machine.id,enrolled[1].machine.id);assert.notEqual(enrolled[0].executor_id,enrolled[1].executor_id);assert.notEqual(enrolled[0].config_file,enrolled[1].config_file);
 const originalMachine=readFileSync(join(h.home,'state','machine.json')),newHome=join(h.base,'new-installation');mkdirSync(newHome);const nextMachinePath=join(h.base,'reuse-machine.json');
 setupMachine({path:nextMachinePath,home:newHome,endpoint:h.endpoint,projectRoot:h.base,clientEntry:h.entry,existingMachineState:join(h.home,'state')});
 assert.equal(enrollmentPreview(nextMachinePath,a).machine.id,enrolled[0].machine.id);assert(readFileSync(join(h.home,'state','machine.json')).equals(originalMachine));
 assert.throws(()=>submitEnrollment(h.machinePath,a,'develop',{id:'unapproved',version:'v1'}));
 const other=repo(h.base,'different-owner','other-owner/second-project');assert.notEqual(enrollmentPreview(h.machinePath,other).project_id,enrolled[0].project_id);
 const grants=readTrustedConfig(h.trusted);const changed=structuredClone(grants.clients);changed[1].project_ids.push('legacy');assert.throws(()=>createAuthenticator(changed,grants.enrollments));
});

test('expired local Viewer renews on explicit document navigation; stale cookie and API bootstrap stay denied',()=>{
 let now=1000;const viewer={id:'local-viewer',project_ids:['project']},session=localBrowserSession(viewer,()=>now),headers={};
 const navigation={method:'GET',url:'/dashboard',headers:{'sec-fetch-dest':'document','sec-fetch-mode':'navigate','sec-fetch-site':'none'}};
 session.bootstrap(navigation,{setHeader:(k,v)=>headers[k]=v});const old=headers['Set-Cookie'];now+=3600001;
 assert.equal(session.bootstrap({...navigation,url:'/dashboard/v1/snapshot'},{setHeader(){}}),null);
 assert(session.bootstrap(navigation,{setHeader:(k,v)=>headers[k]=v}));assert.notEqual(headers['Set-Cookie'],old);
});

test('trusted development preparation requires current approved Work Item and never enables business execution',async t=>{
 const h=await fixture(t),root=repo(h.base,'development','zlpoot/agent-workflow-hub');git(root,['checkout','-b','codex/new-business-901']);
 const trust=trustedFixture(h.base),config=JSON.parse(readFileSync(h.machinePath));config.policy_trust_file=trust.path;writeFileSync(h.machinePath,JSON.stringify(config));
 const request=submitEnrollment(h.machinePath,root,'develop',trust.selection);
 assert.throws(()=>approveEnrollment({request:request.request_file,trustedConfig:h.trusted,database:h.database,confirm:true}));
 approveEnrollment({request:request.request_file,trustedConfig:h.trusted,database:h.database,confirm:true,policyTrust:trust.path});const result=await finishEnrollment(h.machinePath,root);assert.equal(result.status,'registered');
 git(root,['checkout','feature/customer-work']);const diagnosis=await diagnoseEnrollment(h.machinePath,root);assert.equal(diagnosis.checks.find(c=>c.id==='development').status,'blocked');assert.equal(diagnosis.checks.find(c=>c.id==='worktree').status,'passed');
});

test('installed Viewer selects the exact approved Work Item version, connects and displays a run-free Executor',async t=>{
 const h=await fixture(t),root=repo(h.base,'browser-project','zlpoot/agent-workflow-hub');git(root,['checkout','-b','codex/new-business-901']);
 const trust=trustedFixture(h.base,({catalog,approvals,approval})=>{const next={...catalog.work_items[0],work_item_version:'v2'};catalog.work_items.push(next);approvals.entries.push(approval('work_item',next.id,next.work_item_version,next));});
 const machine=JSON.parse(readFileSync(h.machinePath));machine.policy_trust_file=trust.path;writeFileSync(h.machinePath,JSON.stringify(machine));
 const viewerInstall=join(h.base,'viewer-install');mkdirSync(viewerInstall);
 const install=spawnSync(process.execPath,[npmEntry(),'install','--prefix',viewerInstall,'--offline','--ignore-scripts','--no-audit','--no-fund',resolve('.handoff/packages/zlpoot-awh-viewer-'+CLIENT_VERSION+'.tgz')],{env:npmEnv(join(h.base,'viewer-cache')),encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(install.status,0);
 const viewerConfig=join(h.base,'viewer.json'),viewerPort=await port();writeFileSync(viewerConfig,JSON.stringify({schema_version:'1.0',mode:'local_browser_direct',database:h.database,port:viewerPort,viewer:{id:'local-viewer',project_ids:[]},local_bindings:[],machine_config_file:h.machinePath}));
 const entry=join(viewerInstall,'node_modules','@zlpoot','awh-viewer','dist','dashboard-cli.js');const child=spawn(process.execPath,[entry,'--config',viewerConfig],{windowsHide:true,stdio:['ignore','pipe','pipe']});const exit=once(child,'exit');resources.get(t).children.push({child,exit});let errors='',timer;child.stderr.on('data',x=>errors+=x);
 try{await Promise.race([new Promise(r=>child.stdout.on('data',x=>{if(x.toString().includes('explicit_local_os_user'))r();})),exit.then(()=>{throw new Error(errors);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Viewer startup timeout')),10000);})]);}finally{clearTimeout(timer);}
 const browser=await chromium.launch({channel:'msedge',headless:true});resources.get(t).stops.push(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:1000}});const failures=[];page.on('pageerror',e=>failures.push(e.message));
 await page.goto('http://127.0.0.1:'+viewerPort+'/dashboard');await page.getByRole('button',{name:'添加项目向导',exact:true}).click();
 await page.getByRole('button',{name:h.base,exact:true}).click();await page.getByRole('button',{name:'browser-project',exact:true}).click();await page.getByRole('button',{name:'识别项目',exact:true}).click();
 await page.getByRole('combobox',{name:'新增项目能力',exact:true}).selectOption('develop');
 const tasks=page.getByRole('combobox',{name:'批准任务',exact:true});await tasks.locator('option').nth(1).waitFor({state:'attached'});
 const options=await tasks.locator('option').evaluateAll(items=>items.map(o=>({value:o.value,label:o.textContent})));
 assert.equal(options.length,2);assert.notEqual(options[0].value,options[1].value);assert(options[1].label.endsWith('v2'));
 await tasks.selectOption({label:options[1].label});assert.equal(await tasks.inputValue(),options[1].value);
 await page.getByRole('checkbox',{name:'确认新增项目授权'}).check();await page.getByRole('button',{name:'提交接入申请',exact:true}).click();await page.getByText('等待 CP 管理员批准。',{exact:false}).waitFor();
 const preview=enrollmentPreview(h.machinePath,root);assert.deepEqual(JSON.parse(readFileSync(preview.request_file)).work_item,{id:trust.selection.id,version:'v2'});
 approveEnrollment({request:preview.request_file,trustedConfig:h.trusted,database:h.database,confirm:true,policyTrust:trust.path});
 await page.getByRole('button',{name:'批准后确认接入 / 重试',exact:true}).click();await page.getByRole('heading',{name:'执行器',exact:true}).waitFor();const binding=enrollmentBindings(h.machinePath)[0];
 resources.get(t).stops.push(async()=>{await new Promise(resolve=>{const c=spawn(process.execPath,[h.entry,'--config',binding.config_file,'resident','stop'],{cwd:root,windowsHide:true,stdio:'ignore'});c.once('close',()=>resolve());});});
 await page.getByText(binding.executor_id,{exact:true}).waitFor();await page.getByText(root,{exact:true}).waitFor();await page.getByText('在线',{exact:true}).first().waitFor();assert.deepEqual(failures,[]);
 const cookie=(await page.context().cookies())[0];const origin='http://127.0.0.1:'+viewerPort;
 const bad=await fetch(origin+'/dashboard/enrollment/v1/connect',{method:'POST',headers:{Cookie:cookie.name+'='+cookie.value,'Content-Type':'application/json'},body:JSON.stringify({directory:root})});assert.equal(bad.status,403);
 mkdirSync('.handoff/enrollment-evidence',{recursive:true});await page.screenshot({path:'.handoff/enrollment-evidence/installed-viewer.png',fullPage:true});
 const db=new DatabaseSync(h.database,{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,0);db.close();
});
