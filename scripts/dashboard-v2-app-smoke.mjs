import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dashboardHeaders } from '../dist/dashboard/gateway.js';

// Fixed isolated host with the real Gateway/management service and injected App.
// It never accepts real inputs or opens a production/native confirmation window.
assert.equal(process.argv.length,2);
const output='.handoff/dashboard-v2-app-smoke';mkdirSync(output,{recursive:true});
const child=spawn(process.execPath,['scripts/github-app-dashboard-fixture.mjs'],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
let browser,sequence=0;
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Isolated fixture startup timeout')),10000);child.stdout.on('data',chunk=>{text+=chunk;for(const line of text.split('\n'))try{const value=JSON.parse(line);if(value.v2_url){clearTimeout(timer);resolve(value);}}catch{}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Fixture stopped'));});});
const mode=value=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{child.off('message',listener);reject(new Error('Fixture IPC timeout'));},5000),listener=message=>{if(message.kind==='ack'&&message.id===id){clearTimeout(timer);child.off('message',listener);resolve(message);}};child.on('message',listener);child.send({kind:'mode',value,id});});
try {
  const started=await ready,origin=new URL(started.v2_url).origin;
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser=await chromium.launch({headless:true,executablePath:process.env.AWH_DASHBOARD_TEST_BROWSER??(existsSync(edge)?edge:undefined)});
  const context=await browser.newContext({viewport:{width:1440,height:1024},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[],requests=[];
  await context.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',r=>requests.push({path:new URL(r.url()).pathname,origin:new URL(r.url()).origin,method:r.method(),authorization:!!r.headers().authorization,...(r.method()==='POST'?{fields:Object.keys(r.postDataJSON()).sort(),csrf:!!r.headers()['x-awh-csrf']}:{} )}));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const settings=async()=>{await page.getByRole('button',{name:/^设置/}).click();await page.getByRole('heading',{name:'GitHub App',exact:true}).waitFor();};
  const fill=async()=>{for(const [name,value] of [['App ID',String(started.input.app_id)],['App slug',started.input.app_slug],['PEM 本机路径',started.input.private_key_path],['Reviewer',started.input.reviewer]])await page.getByRole('textbox',{name,exact:true}).fill(value);};
  const detect=async()=>{await page.getByRole('button',{name:'检测配置',exact:true}).click();await page.getByRole('heading',{name:'检测结果',exact:true}).waitFor();};
  const shot=async name=>{await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});const key=page.getByRole('textbox',{name:'PEM 本机路径',exact:true});await page.screenshot({path:output+'/'+name+'.png',fullPage:true,mask:await key.count()?[key]:[],maskColor:'#dce5e2'});};

  await mode('readonly');const response=await page.goto(started.v2_url);assert.equal(response.headers()['content-security-policy'],dashboardHeaders['Content-Security-Policy']);await settings();
  const readonly='当前 Viewer 仅可查看。本机可信 Owner 启用管理功能后，才能检测和连接。';
  await page.getByText(readonly,{exact:true}).waitFor();assert(await page.getByRole('button',{name:'检测配置',exact:true}).isDisabled());assert.equal(requests.filter(r=>r.method==='POST').length,0);
  await shot('desktop-readonly');
  await mode('restart');await page.getByRole('button',{name:'刷新连接状态',exact:true}).click();await page.getByRole('textbox',{name:'App ID',exact:true}).waitFor();
  await page.getByText('未连接 · NOT_CONNECTED',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'App slug',exact:true}).inputValue(),'zlpoot-awh-builder');assert.equal(await page.getByRole('textbox',{name:'Reviewer',exact:true}).inputValue(),'zlpoot');
  assert(await page.getByText('App Fixture · 模拟数据 · 真实 Preflight NOTRUN',{exact:true}).isVisible());
  await shot('desktop-not-connected');await fill();
  await page.getByRole('textbox',{name:'PEM 本机路径',exact:true}).fill('../key.pem');assert(await page.getByRole('button',{name:'检测配置',exact:true}).isDisabled());await fill();
  for(const [fault,message] of [['all','安装范围为 All repositories；请 Owner 在 GitHub 改为 Selected repositories。'],['permissions','缺少 Contents: write / Pull requests: write / Metadata: read。']]){
    await mode(fault);await detect();await page.getByText(message,{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'连接并保存',exact:true}).count(),0);
  }
  await mode('not-installed');await page.getByRole('button',{name:'检测配置',exact:true}).click();await page.getByText('此 App 尚未安装到账号。',{exact:true}).waitFor();
  await mode('success');const before=requests.filter(r=>r.path.endsWith('/detect')&&r.method==='POST').length;
  await page.getByRole('button',{name:'检测配置',exact:true}).evaluate(button=>{button.click();button.click();});await page.getByRole('heading',{name:'检测结果',exact:true}).waitFor();
  assert.equal(requests.filter(r=>r.path.endsWith('/detect')&&r.method==='POST').length-before,1);
  assert.equal(await page.locator('.app-repositories li').count(),2);assert(await page.getByText('synthetic-builder[bot]',{exact:false}).isVisible());assert(await page.getByRole('button',{name:'连接并保存',exact:true}).isDisabled());
  await shot('desktop-detected');
  await page.getByRole('checkbox',{name:'确认实际身份和完整安装仓库范围'}).check();
  await page.getByRole('combobox',{name:'只读检查仓库',exact:true}).selectOption('synthetic-org/repository-2');assert(await page.getByRole('button',{name:'连接并保存',exact:true}).isDisabled());
  // The real service lock and hook prevent duplicate writes while Owner is pending.
  await mode('pending');await page.getByRole('checkbox',{name:'确认实际身份和完整安装仓库范围'}).check();await page.getByRole('button',{name:'连接并保存',exact:true}).click();
  await page.getByText('等待 Windows Owner 确认…',{exact:false}).waitFor();assert(await page.getByRole('button',{name:'刷新连接状态',exact:true}).isDisabled());
  const competing=await context.newPage();competing.setDefaultTimeout(10000);await competing.goto(started.v2_url);await competing.getByRole('button',{name:/^设置/}).click();
  for(const [name,value] of [['App ID','5'],['App slug',started.input.app_slug],['PEM 本机路径',started.input.private_key_path],['Reviewer',started.input.reviewer]])await competing.getByRole('textbox',{name,exact:true}).fill(value);
  await competing.getByRole('button',{name:'检测配置',exact:true}).click();await competing.getByRole('alert').filter({hasText:'另一个 App 操作正在进行，请等待完成后重试。'}).waitFor();await competing.close();
  await mode('release-cancel');await page.getByText('本机 Owner 已取消连接。',{exact:true}).waitFor();await shot('desktop-owner-cancelled');
  await mode('success');await fill();await detect();await page.getByRole('checkbox',{name:'确认实际身份和完整安装仓库范围'}).check();
  // Navigation aborts the pending operation. Remount must re-read server state.
  await mode('pending');await page.getByRole('button',{name:'连接并保存',exact:true}).click();await page.getByText('等待 Windows Owner 确认…',{exact:false}).waitFor();
  await page.getByRole('button',{name:/^总览/}).click();await mode('release-cancel');await settings();await page.getByText('未连接 · NOT_CONNECTED',{exact:true}).waitFor();
  await mode('success');await fill();await detect();await page.getByRole('checkbox',{name:'确认实际身份和完整安装仓库范围'}).check();
  await page.getByRole('button',{name:'连接并保存',exact:true}).click();await page.getByText('模拟检查通过 · PREFLIGHT_PASS',{exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'PEM 本机路径',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'连接并保存',exact:true}).count(),0);await shot('desktop-connected');
  for(const [fault,message] of [['permissions','安装缺少所需仓库权限。'],['identity','App、Installation、Bot 或 Reviewer 与已确认身份不一致。'],['scope','Selected Repository 集合不完整或与保存的范围发生变化。'],['network','无法完成 GitHub 网络请求或请求已超时。']]){
    await mode(fault);await page.getByRole('button',{name:'重新检查',exact:true}).click();await page.getByText(message,{exact:true}).waitFor();assert(await page.getByRole('button',{name:'重新检查',exact:true}).isVisible());assert.equal(await page.getByRole('button',{name:'连接并保存',exact:true}).count(),0);
  }
  await mode('success');await page.getByRole('button',{name:'重新检查',exact:true}).click();await page.getByText('模拟检查通过 · PREFLIGHT_PASS',{exact:true}).waitFor();
  await page.reload();await settings();await page.getByText('已保存本机连接 · 待检查 · CONNECTED_LOCAL',{exact:true}).waitFor();
  await mode('restart');await page.getByRole('button',{name:'刷新连接状态',exact:true}).click();await page.getByText('已保存本机连接 · 待检查 · CONNECTED_LOCAL',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('mobile-connected');
  const button=page.getByRole('button',{name:'重新检查',exact:true});await button.focus();await page.keyboard.press('Enter');await page.getByText('模拟检查通过 · PREFLIGHT_PASS',{exact:true}).waitFor();
  // Capability is re-read before every POST, even if the displayed flag was stale.
  await mode('readonly');const posts=requests.filter(r=>r.method==='POST').length;await page.getByRole('button',{name:'重新检查',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'当前是只读 Viewer，本机可信 Owner 管理功能尚未启用。'}).waitFor();assert.equal(requests.filter(r=>r.method==='POST').length,posts);assert(await page.getByRole('button',{name:'重新检查',exact:true}).isDisabled());
  await page.getByRole('button',{name:'刷新连接状态',exact:true}).click();await page.getByText(readonly,{exact:true}).waitFor();await shot('mobile-readonly');
  const state=await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,cookie:document.cookie,text:document.body.textContent,csp:window.__csp}));
  assert.equal(state.local,0);assert.equal(state.session,0);assert.equal(state.cookie,'');assert(!/ghs_|BEGIN PRIVATE KEY/.test(state.text));assert.deepEqual(state.csp,[]);assert.deepEqual(errors,[]);
  assert(requests.every(r=>r.origin===origin&&!r.authorization));
  for(const r of requests.filter(r=>r.method!=='GET')){
    assert.equal(r.method,'POST');assert(r.csrf);const action=r.path.split('/').at(-1);assert(r.path.startsWith('/dashboard/github-app/v1/'));
    assert.deepEqual(r.fields,{detect:['app_id','app_slug','private_key_path','reviewer'],connect:['detection_id','installation_id','repository'],preflight:['repository']}[action]);
  }
  await page.getByRole('link',{name:'Dashboard V1'}).click();await page.getByRole('tab',{name:'设置',exact:true}).click();await page.getByRole('heading',{name:'GitHub App',exact:true}).waitFor();await page.getByText(readonly,{exact:true}).waitFor();assert(await page.getByRole('button',{name:'重新检查',exact:true}).isDisabled());
  const result={status:'PASS',fixture:true,real_detect_connect_preflight:'NOTRUN',native_owner_ui:'NOTRUN',browser:await browser.version(),scenarios:['readonly unconnected','input validation','all repositories','permissions','not installed','duplicate click','full selected set','ack invalidation','pending Owner + concurrency','cancel fixture','unmount abort/remount','connect + auto-preflight fixture','no overwrite','identity/scope/network drift','refresh/service restart','390px + keyboard Enter','fresh capability check blocks POST','CSP + no browser storage','closed same-origin GET/POST routes','V1 shared-hook fallback'],page_errors:errors.length,csp_violations:state.csp,requests:requests.length,screenshots:'synthetic only; PEM path masked; no credentials or personal paths'};
  writeFileSync(output+'/verification.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser?.close();if(child.connected)child.disconnect();await new Promise(resolve=>child.exitCode===null?child.once('exit',resolve):resolve());}
