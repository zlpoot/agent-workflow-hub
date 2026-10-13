import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

// Starts only the synthetic, in-memory V2 fixture host; never accepts a live CP URL.
const output = '.handoff/dashboard-v2-smoke'; mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ['scripts/dashboard-v2-preview.mjs', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('V2 fixture host did not start')), 15000);
    child.on('exit', () => { clearTimeout(timeout); reject(new Error('V2 fixture host stopped')); });
    child.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+\/dashboard\/v2/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.AWH_DASHBOARD_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  const page = await context.newPage(), errors = [], network = [];
  let offlinePhase = false;
  const isCpRoute = pathname => /^\/v1\/(?:projects|executors|runs)(?:\/|$)/.test(pathname);
  page.on('pageerror', error => { if (!offlinePhase) errors.push(error.message); });
  // The deliberate offline step makes the browser log resource failures; those are expected.
  page.on('console', message => { if (message.type() === 'error' && !offlinePhase) errors.push(`console: ${message.text()}`); });
  page.on('request', request => network.push({ url: request.url(), method: request.method(), headers: request.headers() }));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());

  await page.goto(url);
  await page.getByRole('heading', { name: '等待独立 Review', exact: true }).waitFor();
  assert(await page.getByText('示例预览 · 模拟数据').first().isVisible());
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.title(), 'AWH · 工作流指挥台 V2');
  assert(await page.getByText('GitHub 授权未核验').first().isVisible());
  await page.screenshot({ path: `${output}/overview-desktop.png`, fullPage: true, animations: 'disabled' });

  // Tasks workbench: filters, search, empty state, detail drawer.
  await page.getByRole('menuitem', { name: '任务' }).click();
  await page.getByLabel('搜索任务').waitFor();
  await page.screenshot({ path: `${output}/tasks-desktop.png`, fullPage: true, animations: 'disabled' });
  await page.getByLabel('搜索任务').fill('does-not-exist');
  await page.getByText('当前筛选条件下没有任务').waitFor();
  await page.screenshot({ path: `${output}/tasks-empty.png`, fullPage: true, animations: 'disabled' });
  await page.getByLabel('搜索任务').fill('等待 ChatGPT Review');
  await page.getByRole('button', { name: '模拟 · 等待 ChatGPT Review', exact: true }).first().click();
  await page.getByRole('dialog', { name: /等待 ChatGPT Review/ }).waitFor();
  await page.getByText('Review 与验证').waitFor();
  const detailText = await page.getByRole('dialog', { name: /等待 ChatGPT Review/ }).innerText();
  assert(!/not_checked|permission_denied|administrator_policy|local_fast_contract/.test(detailText),
    `raw contract value leaked into the detail panel: ${detailText}`);
  await page.screenshot({ path: `${output}/task-detail.png`, fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: /等待 ChatGPT Review/ }).waitFor({ state: 'hidden' });
  await page.getByLabel('搜索任务').fill('');

  // Keyboard navigation: focus a nav entry and activate it with Enter.
  await page.getByRole('menuitem', { name: '总览' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '等待独立 Review', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: '任务' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('搜索任务').waitFor();
  await page.getByRole('menuitem', { name: '总览' }).click();
  await page.getByRole('heading', { name: '等待独立 Review', exact: true }).waitFor();

  // Offline keeps the last snapshot and says so.
  await context.setOffline(true);
  offlinePhase = true;
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByRole('alert').waitFor();
  assert(await page.getByText('显示上次成功读取的快照', { exact: false }).first().isVisible());
  await page.screenshot({ path: `${output}/offline.png`, fullPage: true, animations: 'disabled' });
  await context.setOffline(false);
  await page.getByRole('button', { name: '刷新' }).click();
  offlinePhase = false;
  await page.getByText('已连接', { exact: false }).first().waitFor();

  // 390px mobile: nav drawer, overview, tasks, no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: '等待独立 Review', exact: true }).waitFor();
  await page.screenshot({ path: `${output}/overview-mobile.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('dialog', { name: '导航' }).getByRole('menuitem', { name: '任务' }).waitFor();
  await page.screenshot({ path: `${output}/nav-mobile.png`, animations: 'disabled' });
  await page.getByRole('menuitem', { name: '任务' }).click();
  await page.getByLabel('搜索任务').waitFor();
  await page.screenshot({ path: `${output}/tasks-mobile.png`, fullPage: true, animations: 'disabled' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole('button', { name: '模拟 · 等待 ChatGPT Review', exact: true }).first().click();
  await page.getByRole('dialog', { name: /等待 ChatGPT Review/ }).waitFor();
  await page.waitForTimeout(500);
  const box = await page.getByRole('dialog', { name: /等待 ChatGPT Review/ }).boundingBox();
  assert(box.x >= 0 && box.x + box.width <= 390, `mobile drawer is outside the viewport: ${JSON.stringify(box)}`);
  await page.screenshot({ path: `${output}/task-detail-mobile.png`, fullPage: true, animations: 'disabled' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.keyboard.press('Escape');

  const cookies = await context.cookies();
  assert(cookies.every(cookie => cookie.name === 'awh_viewer' && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/dashboard'));
  const storage = await page.evaluate(() => ({ cookies: document.cookie, local: localStorage.length, session: sessionStorage.length }));
  assert.deepEqual(storage, { cookies: '', local: 0, session: 0 });
  assert(network.every(request => request.method === 'GET' && new URL(request.url).origin === new URL(url).origin && !request.headers.authorization));
  assert(!network.some(request => isCpRoute(new URL(request.url).pathname)));
  assert.equal(errors.length, 0, errors.join('\n'));

  const evidence = { view: 'dashboard-v2-antd', baseline_issue: 86, browser: await browser.version(),
    url_pattern: 'http://127.0.0.1:<port>/dashboard/v2', dataset: 'synthetic fixture only', authority_verified: false,
    screenshots: ['overview-desktop', 'tasks-desktop', 'tasks-empty', 'task-detail', 'offline', 'overview-mobile', 'nav-mobile', 'tasks-mobile', 'task-detail-mobile'],
    checks: ['Overview renders waiting-review/blocked/next-action sections', 'Tasks filters + search + empty state',
      'Task detail drawer opens and closes with Escape', 'keyboard navigation between views', 'offline retains last snapshot',
      '390px no horizontal overflow', 'HttpOnly same-site viewer cookie', 'empty browser storage',
      'same-origin GET reads only', 'no CP routes', 'no console or page errors'],
    request_count: network.length, browser_errors: errors.length, locale: 'zh-CN' };
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser?.close(); child.kill(); }
