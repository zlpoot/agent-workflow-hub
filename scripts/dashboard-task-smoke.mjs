import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const real=process.argv[2]==='--real';
if(process.argv.length!==(real?4:2))throw new Error('Use no args for fixture smoke or --real http://127.0.0.1:PORT/dashboard for explicitly configured isolated Viewer');
let child,browser,url=real?process.argv[3]:null;
if(real&&!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/dashboard$/.test(url))throw new Error('Explicit loopback Viewer required');
const output=`.handoff/task-smoke-${real?'real':'fixture'}`;mkdirSync(output,{recursive:true});
const expected=real?['75603ef4749ce1a85583aefe60aa4814aa11de01','33c43364d3e017be39309a85cca6e6bd2871664d']:null;
const evidence={dataset:real?'real-readonly-history':'synthetic-fixture',errors:[],checks:[]};
const check=(name,condition)=>{assert(condition,name);evidence.checks.push(name);};
try {
  if(!real){child=spawn(process.execPath,['scripts/dashboard-fixture.mjs'],{windowsHide:true,stdio:['ignore','pipe','pipe']});url=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Fixture start timeout')),10000);child.stdout.on('data',data=>{const m=String(data).match(/http:\/\/127\.0\.0\.1:\d+\/dashboard/);if(m){clearTimeout(timeout);resolve(m[0]);}});child.on('exit',()=>reject(new Error('Fixture stopped')));});}
  browser=await chromium.launch({headless:true,executablePath:process.env.AWH_DASHBOARD_TEST_BROWSER||undefined});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push(e.message));
  await page.goto(url);await page.getByRole('heading',{name:'最近任务',exact:true}).waitFor({timeout:60000});
  const snapshot=await page.evaluate(async()=>{const r=await fetch('/dashboard/v1/snapshot');if(!r.ok)throw new Error('Snapshot failed');return r.json();});
  writeFileSync(`${output}/snapshot.json`,JSON.stringify(snapshot,null,2));
  if(real){
    check('Only two explicitly configured real tasks; no fixtures/CP Runs',snapshot.tasks.length===2&&snapshot.runs.length===0&&snapshot.tasks.every(t=>!t.fixture&&t.repository==='zlpoot/awh-local-fast-e2e'));
    for(const [i,t] of snapshot.tasks.entries()) {
      check(`Issue ${i+1} GitHub exact HEAD/native Review/Merge/CLOSED`,t.state==='completed'&&t.github_head===expected[i]&&t.source_head===expected[i]&&t.review.decision==='PASS'&&t.review.matches_head&&t.pr.merged_at&&t.issue.state==='closed');
      check(`Issue ${i+1} no active actor or waiting party; Watcher stopped`,t.active_actor===null&&t.waiting_for===null&&t.watcher.status==='QUEUE_COMPLETED'&&t.watcher.running===false);
      check(`Issue ${i+1} Stage exact-head checks pass`,t.stage.head===expected[i]&&t.stage.status==='passed');
    }
  }else check('Fixtures labeled per task and dataset',snapshot.tasks.some(t=>t.fixture)&&await page.getByText('示例预览 · 模拟数据',{exact:true}).first().isVisible());
  await page.screenshot({path:`${output}/overview-desktop.png`,fullPage:true,animations:'disabled'});
  await page.getByRole('tab',{name:'任务',exact:true}).click();
  await page.getByRole('combobox',{name:'按任务状态筛选'}).waitFor();
  await page.screenshot({path:`${output}/tasks-desktop.png`,fullPage:true,animations:'disabled'});
  if(!real){
    await page.getByRole('combobox',{name:'按角色筛选'}).selectOption('reviewer');await page.getByRole('row').filter({hasText:'Codex 正在开发'}).waitFor({state:'hidden'});const reviewerRow=page.getByRole('row').filter({has:page.getByRole('button',{name:/等待 ChatGPT Review/})});await reviewerRow.waitFor();await page.screenshot({path:`${output}/reviewer-filter.png`,fullPage:true,animations:'disabled'});check('Waiting reviewer shown without active reviewer',(await reviewerRow.innerText()).includes('ChatGPT Reviewer')&&(await reviewerRow.innerText()).includes('未观察到执行'));
    await page.getByRole('combobox',{name:'按角色筛选'}).selectOption('all');
    await page.getByRole('combobox',{name:'按任务状态筛选'}).selectOption('changes_requested');await page.getByRole('button',{name:/REQUEST_CHANGES/}).waitFor();check('REQUEST_CHANGES filter',await page.getByRole('button',{name:/REQUEST_CHANGES/}).isVisible());
    await page.getByRole('combobox',{name:'按任务状态筛选'}).selectOption('all');
    await page.getByRole('combobox',{name:'按机器筛选'}).selectOption('fixture-mac');await page.getByRole('row').filter({hasText:'Windows 模拟机器'}).first().waitFor({state:'hidden'});check('Machine filter',await page.getByRole('row').filter({hasText:'Windows 模拟机器'}).count()===0);await page.getByRole('combobox',{name:'按机器筛选'}).selectOption('all');
    await page.getByRole('combobox',{name:'按项目筛选'}).click();await page.getByRole('option',{name:/fixture-empty-project/}).click();await page.getByRole('heading',{name:'没有匹配的任务',exact:true}).waitFor();check('Project filter and empty registered project',await page.getByRole('heading',{name:'没有匹配的任务',exact:true}).isVisible());
    await page.getByRole('combobox',{name:'按项目筛选'}).click();await page.getByRole('option',{name:'全部项目',exact:true}).click();
  }
  await page.getByRole('button',{name:real?/#1 /:/等待 ChatGPT Review/}).first().focus();await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor();await page.getByText('证据来源与新鲜度',{exact:true}).waitFor();
  await page.getByText('正在重新核验任务…',{exact:true}).waitFor({state:'hidden',timeout:60000});
  check('Task detail read and DTO validation succeeded',await page.getByRole('dialog').getByRole('alert').count()===0);
  check('Detail linked issue/PR, source and native review',await page.getByRole('heading',{name:'GitHub 原生 Review / Merge',exact:true}).isVisible());
  await page.screenshot({path:`${output}/detail-desktop.png`,fullPage:true,animations:'disabled'});await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${output}/tasks-mobile.png`,fullPage:true,animations:'disabled'});
  check('390px layout does not overflow document',await page.evaluate(()=>document.documentElement.scrollWidth<=390));
  await page.getByRole('button',{name:real?/#1 /:/等待 ChatGPT Review/}).first().click();await page.getByRole('dialog').waitFor();await page.screenshot({path:`${output}/detail-mobile.png`,fullPage:true,animations:'disabled'});await page.keyboard.press('Escape');
  await page.getByRole('textbox',{name:'搜索任务'}).fill('no-such-task');await page.getByRole('heading',{name:'没有匹配的任务',exact:true}).waitFor();await page.screenshot({path:`${output}/empty-mobile.png`,fullPage:true,animations:'disabled'});await page.getByRole('textbox',{name:'搜索任务'}).fill('');
  await context.setOffline(true);await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('alert').first().waitFor();check('Offline tasks suppress current actor and state',await page.getByText('状态未知',{exact:true}).count()>0);await page.screenshot({path:`${output}/offline-mobile.png`,fullPage:true,animations:'disabled'});await context.setOffline(false);
  await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('alert').waitFor({state:'hidden',timeout:60000});
  check('No browser runtime errors',evidence.errors.length===0);
  evidence.url=url;evidence.observed_at=new Date().toISOString();evidence.status='PASS';
  if(real){const sources=JSON.parse(readFileSync('.handoff/evidence/real-source-before.json'));const hashes=sources.paths.map(path=>createHash('sha256').update(readFileSync(path)).digest('hex'));check('Real Local Fast state/Watcher/scope unchanged',JSON.stringify(hashes)===JSON.stringify(sources.sha256));evidence.source_sha256_after=hashes;}
  writeFileSync(`${output}/result.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}catch(error){evidence.status='FAIL';evidence.failure=error.stack;writeFileSync(`${output}/result.json`,JSON.stringify(evidence,null,2));throw error;}
finally{await browser?.close();child?.kill();}
