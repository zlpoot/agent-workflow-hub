import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const output='.handoff/github-app-dashboard-smoke';mkdirSync(output,{recursive:true});
const child=spawn(process.execPath,['scripts/github-app-dashboard-fixture.mjs'],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
let browser, sequence=0, requests=[], consoles=[];
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Fixture startup timeout')),10000);child.stdout.on('data',c=>{text+=c;for(const line of text.split('\n'))try{const value=JSON.parse(line);if(value.url){clearTimeout(timer);resolve(value);}}catch{}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Fixture stopped'));});});
const mode=value=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{child.off('message',listener);reject(new Error('Fixture IPC timeout'));},5000),listener=message=>{if(message.kind==='ack'&&message.id===id){clearTimeout(timer);child.off('message',listener);resolve(message);}};child.on('message',listener);child.send({kind:'mode',value,id});});
try {
  const started=await ready;
  const installed='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  browser=await chromium.launch({headless:true,executablePath:process.env.AWH_DASHBOARD_TEST_BROWSER|| (existsSync(installed)?installed:undefined)});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  page.on('pageerror',e=>consoles.push(e.message));
  page.on('request',r=>{requests.push({url:r.url(),method:r.method()});});
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(started.url).origin?route.continue():route.abort());
  const settings=async()=>{await page.getByRole('tab',{name:'设置',exact:true}).click();await page.getByRole('heading',{name:'GitHub App',exact:true}).waitFor();await page.getByRole('button',{name:'刷新连接状态',exact:true}).waitFor({state:'visible'});};
  const fill=async()=>{await page.getByRole('textbox',{name:'App ID',exact:true}).fill(String(started.input.app_id));await page.getByRole('textbox',{name:'App slug',exact:true}).fill(started.input.app_slug);await page.getByRole('textbox',{name:'PEM 本机路径',exact:true}).fill(started.input.private_key_path);await page.getByRole('textbox',{name:'Reviewer',exact:true}).fill(started.input.reviewer);};
  const detect=async()=>{await page.getByRole('button',{name:'检测配置',exact:true}).click();await page.getByRole('heading',{name:'检测结果',exact:true}).waitFor();};
  await page.goto(started.url);await settings();await page.getByText('未连接 · NOT_CONNECTED',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'App slug',exact:true}).inputValue(),'zlpoot-awh-builder');assert.equal(await page.getByRole('textbox',{name:'Reviewer',exact:true}).inputValue(),'zlpoot');
  assert(await page.getByText('App Fixture · 模拟数据 · 真实 Preflight NOTRUN',{exact:true}).isVisible());
  await page.screenshot({path:output+'/not-connected.png',fullPage:true});
  await fill();await page.getByRole('textbox',{name:'PEM 本机路径',exact:true}).fill('../private.pem');assert(await page.getByRole('button',{name:'检测配置',exact:true}).isDisabled());await fill();
  for(const [fault,message] of [['all','安装范围为 All repositories；请 Owner 在 GitHub 改为 Selected repositories。'],['permissions','缺少 Contents: write / Pull requests: write / Metadata: read。']]){
    await mode(fault);await detect();await page.getByText(message,{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'连接并保存',exact:true}).count(),0);
    await page.screenshot({path:output+'/detection-'+fault+'.png',fullPage:true});
  }
  await mode('not-installed');await page.getByRole('button',{name:'检测配置',exact:true}).click();await page.getByText('此 App 尚未安装到账号。',{exact:true}).waitFor();
  await mode('success');const before=requests.filter(r=>r.method==='POST'&&r.url.endsWith('/detect')).length;
  await page.getByRole('button',{name:'检测配置',exact:true}).evaluate(button=>{button.click();button.click();});await page.getByRole('heading',{name:'检测结果',exact:true}).waitFor();
  assert.equal(requests.filter(r=>r.method==='POST'&&r.url.endsWith('/detect')).length-before,1);
  assert.equal(await page.locator('.app-repositories li').count(),2);assert(await page.getByText('synthetic-builder[bot]',{exact:false}).isVisible());assert(await page.getByRole('button',{name:'连接并保存',exact:true}).isDisabled());
  await page.screenshot({path:output+'/detected.png',fullPage:true});
  await mode('cancel');await page.getByRole('checkbox',{name:'确认实际身份和完整安装仓库范围'}).check();await page.getByRole('button',{name:'连接并保存',exact:true}).click();await page.getByText('本机 Owner 已取消连接。',{exact:true}).waitFor();
  await page.screenshot({path:output+'/owner-cancelled.png',fullPage:true});
  await mode('success');await fill();await detect();await page.getByRole('checkbox',{name:'确认实际身份和完整安装仓库范围'}).check();
  await page.getByRole('button',{name:'连接并保存',exact:true}).click();await page.getByText('实际检查通过 · PREFLIGHT_PASS',{exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'PEM 本机路径',exact:true}).count(),0);
  await page.screenshot({path:output+'/connected.png',fullPage:true});
  for(const [fault,message] of [['permissions','安装缺少所需仓库权限。'],['identity','App、Installation、Bot 或 Reviewer 与已确认身份不一致。'],['network','无法完成 GitHub 网络请求或请求已超时。']]){
    await mode(fault);await page.getByRole('button',{name:'重新检查',exact:true}).click();await page.getByText(message,{exact:true}).waitFor();assert(await page.getByRole('button',{name:'重新检查',exact:true}).isVisible());
    await page.screenshot({path:output+'/'+fault+'.png',fullPage:true});
  }
  await mode('success');await page.getByRole('button',{name:'重新检查',exact:true}).click();await page.getByText('实际检查通过 · PREFLIGHT_PASS',{exact:true}).waitFor();
  await page.reload();await settings();await page.getByText('已保存本机连接 · 待检查 · CONNECTED_LOCAL',{exact:true}).waitFor();
  await mode('restart');await page.getByRole('button',{name:'刷新连接状态',exact:true}).click();await page.getByText('已保存本机连接 · 待检查 · CONNECTED_LOCAL',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'/mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const button=page.getByRole('button',{name:'重新检查',exact:true});await button.focus();await page.keyboard.press('Enter');await page.getByText('实际检查通过 · PREFLIGHT_PASS',{exact:true}).waitFor();
  await mode('readonly');await page.getByRole('button',{name:'刷新连接状态',exact:true}).click();await page.getByText('当前 Viewer 仅可查看。本机可信 Owner 启用管理功能后，才能检测和连接。',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'重新检查',exact:true}).isDisabled());
  await page.screenshot({path:output+'/readonly.png',fullPage:true});
  assert.equal(consoles.length,0,consoles.join('\n'));assert(requests.every(r=>new URL(r.url).origin===new URL(started.url).origin));
  const storage=await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,cookie:document.cookie,text:document.body.textContent}));assert.equal(storage.local,0);assert.equal(storage.session,0);assert.equal(storage.cookie,'');assert(!storage.text.includes('ghs_'));assert(!storage.text.includes('BEGIN PRIVATE KEY'));
  writeFileSync(output+'/result.json',JSON.stringify({status:'PASS',fixture:true,real_preflight:'NOTRUN',browser:await browser.version(),scenarios:['not_connected','input_validation','all_repositories','permission_detection','not_installed','duplicate_click','full_selected_set','owner_cancel_fixture','connect_owner_confirm_fixture','auto_preflight_fixture','permissions','identity_drift','network','refresh','service_restart','readonly','390px','keyboard'],native_owner_ui:'NOTRUN',page_errors:consoles.length,all_requests_same_origin:true},null,2));
  console.log('GitHub App Dashboard browser smoke PASS (injected Fixture; live Preflight and native UI acceptance NOTRUN)');
} finally {await browser?.close();if(child.connected)child.disconnect();await new Promise(resolve=>child.exitCode===null?child.once('exit',resolve):resolve());}
