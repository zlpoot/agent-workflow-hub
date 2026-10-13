import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

// Starts only the synthetic, in-memory V2 fixture host; never accepts a live CP URL.
const output = '.handoff/dashboard-v2-smoke'; mkdirSync(output, { recursive: true });
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(key)));
const child = spawn(process.execPath, ['scripts/dashboard-v2-preview.mjs', '--port', '0'], { env: fixtureEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('V2 fixture host did not start')), 15000);
    child.on('exit', () => { clearTimeout(timeout); reject(new Error('V2 fixture host stopped')); });
    child.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+\/dashboard\/v2/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.AWH_DASHBOARD_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  await context.addInitScript(() => { window.__cspViolations = []; document.addEventListener('securitypolicyviolation', e => window.__cspViolations.push(e.violatedDirective)); });
  const page = await context.newPage(), errors = [], expectedErrors = [], network = [];
  let offlinePhase = false;
  const isCpRoute = pathname => /^\/v1\/(?:projects|executors|runs)(?:\/|$)/.test(pathname);
  page.on('pageerror', error => errors.push(error.message));
  // The deliberate offline step makes the browser log resource failures; those are expected.
  page.on('console', message => { if (message.type() === 'error') {
    const text = message.text();
    if (offlinePhase && /Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(text)) expectedErrors.push(text);
    else errors.push(`console: ${text}`);
  } });
  page.on('request', request => network.push({ url: request.url(), method: request.method(), headers: request.headers() }));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());

  const documentResponse = await page.goto(url);
  const csp = documentResponse.headers()['content-security-policy'];
  assert.equal(csp, "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  await page.getByRole('heading', { name: '等待独立 Review', exact: true }).waitFor();
  await page.getByText('已连接', { exact: true }).first().waitFor();
  assert(await page.getByText('示例预览 · 模拟数据').first().isVisible());
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.title(), 'AWH · 工作流指挥台 V2');
  assert(await page.getByText('GitHub 授权未核验').first().isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${output}/overview-desktop.png`, fullPage: true, animations: 'disabled' });

  // Tasks workbench: filters, search, empty state, detail drawer.
  await page.getByRole('menuitem', { name: '任务' }).click();
  await page.getByLabel('搜索任务').waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${output}/tasks-desktop.png`, fullPage: true, animations: 'disabled' });
  await page.getByLabel('按阶段筛选').click();
  await page.getByLabel('按阶段筛选').press('Home');
  for (let i = 0; i < 10; i++) await page.getByLabel('按阶段筛选').press('ArrowDown');
  await page.getByLabel('按阶段筛选').press('Enter');
  await page.getByRole('button', { name: '模拟 · PASS 等待 checks', exact: true }).waitFor();
  assert.equal(await page.locator('tr[data-row-key]').count(), 1);
  await page.getByLabel('按阶段筛选').click();
  for (let i = 0; i < 10; i++) await page.getByLabel('按阶段筛选').press('ArrowUp');
  await page.getByLabel('按阶段筛选').press('Enter');
  await page.getByRole('button', { name: '模拟 · 等待 ChatGPT Review', exact: true }).first().waitFor();
  await page.getByLabel('搜索任务').fill('does-not-exist');
  await page.getByText('当前筛选条件下没有任务').waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${output}/tasks-empty.png`, fullPage: true, animations: 'disabled' });
  await page.getByLabel('搜索任务').fill('等待 ChatGPT Review');
  await page.getByRole('button', { name: '模拟 · 等待 ChatGPT Review', exact: true }).first().click();
  await page.getByRole('dialog', { name: /等待 ChatGPT Review/ }).waitFor();
  await page.getByText('Review 与验证', { exact: true }).waitFor();
  await page.getByText('当前事实待核验', { exact: false }).waitFor({ state: 'hidden' });
  const detailText = await page.getByRole('dialog', { name: /等待 ChatGPT Review/ }).innerText();
  assert(!/not_checked|permission_denied|administrator_policy|local_fast_contract/.test(detailText),
    `raw contract value leaked into the detail panel: ${detailText}`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${output}/task-detail.png`, fullPage: false, animations: 'disabled' });
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
  offlinePhase = true;
  await context.setOffline(true);
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByRole('alert').waitFor();
  assert(await page.getByText('显示上次成功读取的快照', { exact: false }).first().isVisible());
  assert(await page.getByText(/状态未知 \/ 待核验 \d+ 项/).isVisible());
  assert.equal(await page.getByRole('button', { name: '模拟 · Codex 正在开发', exact: true }).count(), 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${output}/offline.png`, fullPage: true, animations: 'disabled' });
  await context.setOffline(false);
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByText('已连接', { exact: false }).first().waitFor();
  offlinePhase = false;
  assert(await page.getByRole('button', { name: '模拟 · Codex 正在开发', exact: true }).first().isVisible());

  // Actual Chromium + unchanged Reader, with a controlled synthetic event high-water mark.
  // Native EventSource still connects to the isolated host; only the test event is injected.
  await context.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native { constructor(...args) { super(...args); window.__v2Stream = this; } };
  });
  const scenario = await context.newPage();
  scenario.on('pageerror', e => errors.push(e.message));
  let detailFailure = false;
  scenario.on('console', message => {
    if (message.type() !== 'error') return;
    if (detailFailure && /503/.test(message.text())) expectedErrors.push(message.text());
    else errors.push(`${message.text()} at ${message.location().url}`);
  });
  scenario.on('request', request => network.push({ url: request.url(), method: request.method(), headers: request.headers() }));
  await scenario.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  await scenario.goto(url);
  await scenario.getByText('已连接', { exact: false }).first().waitFor();
  const snapshot = await (await context.request.get(new URL('/dashboard/v1/snapshot', url).href)).json();
  const timeline = await (await context.request.get(new URL(`/dashboard/v1/runs/${snapshot.runs[0].id}/timeline`, url).href)).json();
  const event = { ...timeline.items[0], cursor: snapshot.cursor + 1 };
  let mode = 'hold', release, caught;
  const received = new Promise(resolve => caught = resolve);
  await scenario.route('**/dashboard/v1/snapshot*', async route => {
    if (mode === 'hold') { caught(); await new Promise(resolve => release = resolve); }
    const response = await route.fetch(), body = await response.json();
    if (mode === 'catchup') body.cursor = event.cursor;
    await route.fulfill({ response, json: body });
  });
  await scenario.route('**/dashboard/v1/runs/*/timeline*', async route => {
    const response = await route.fetch(), body = await response.json();
    if (mode === 'catchup') body.snapshot_cursor = event.cursor;
    await route.fulfill({ response, json: body });
  });
  await scenario.evaluate(event => window.__v2Stream.dispatchEvent(new MessageEvent('timeline-event', { data: JSON.stringify(event), lastEventId: String(event.cursor) })), event);
  await scenario.getByText('部分数据 · 同步中', { exact: true }).first().waitFor();
  assert.equal(await scenario.getByRole('button', { name: '模拟 · Codex 正在开发', exact: true }).count(), 0);
  await received;
  await scenario.getByText('刷新中', { exact: true }).first().waitFor();
  assert.equal(await scenario.getByRole('button', { name: '模拟 · Codex 正在开发', exact: true }).count(), 0);
  await scenario.getByRole('menuitem', { name: '任务' }).click();
  const developerRow = scenario.locator('tr[data-row-key="fixture:task:1"]');
  assert.match(await developerRow.innerText(), /状态未知/);
  assert.doesNotMatch(await developerRow.innerText(), /Codex 模拟执行器/);
  await scenario.getByRole('button', { name: '模拟 · Codex 正在开发', exact: true }).click();
  const staleDrawer = scenario.getByRole('dialog', { name: /模拟 · Codex 正在开发/ });
  await staleDrawer.getByText('历史 源码 HEAD', { exact: true }).waitFor();
  assert.doesNotMatch(await staleDrawer.innerText(), /运行中|Codex 模拟执行器/);
  mode = 'lag'; release();
  await scenario.getByText('部分数据 · 同步中', { exact: true }).first().waitFor();
  assert.match(await developerRow.innerText(), /状态未知/);
  mode = 'catchup';
  // The real 10s read poll catches up while the Drawer remains open.
  await scenario.getByText('已连接', { exact: true }).first().waitFor();
  await staleDrawer.getByText('当前事实待核验', { exact: false }).waitFor({ state: 'hidden' });
  assert.match(await developerRow.innerText(), /Codex 模拟执行器/);
  await scenario.keyboard.press('Escape');
  // A successful snapshot cannot turn a failed detail fallback into current facts.
  await scenario.route('**/dashboard/v1/tasks/*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  detailFailure = true;
  await scenario.getByRole('button', { name: '模拟 · PASS 等待 Watcher', exact: true }).click();
  const failedDrawer = scenario.getByRole('dialog', { name: /PASS 等待 Watcher/ });
  await failedDrawer.getByText('任务详情暂不可用', { exact: false }).waitFor();
  assert.match(await failedDrawer.innerText(), /状态未知/);
  assert.match(await failedDrawer.innerText(), /历史 Review 与验证/);
  assert.doesNotMatch(await failedDrawer.innerText(), /监听中|运行中/);
  assert.deepEqual(await scenario.evaluate(() => window.__cspViolations), []);
  await scenario.close();

  // 390px mobile: nav drawer, overview, tasks, no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: '等待独立 Review', exact: true }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${output}/overview-mobile.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('dialog', { name: '导航' }).getByRole('menuitem', { name: '任务' }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${output}/nav-mobile.png`, animations: 'disabled' });
  await page.getByRole('menuitem', { name: '任务' }).click();
  await page.getByLabel('搜索任务').waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${output}/tasks-mobile.png`, fullPage: true, animations: 'disabled' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole('button', { name: '模拟 · 等待 ChatGPT Review', exact: true }).first().click();
  await page.getByRole('dialog', { name: /等待 ChatGPT Review/ }).waitFor();
  await page.waitForTimeout(500);
  const box = await page.getByRole('dialog', { name: /等待 ChatGPT Review/ }).boundingBox();
  assert(box.x >= 0 && box.x + box.width <= 390, `mobile drawer is outside the viewport: ${JSON.stringify(box)}`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${output}/task-detail-mobile.png`, fullPage: false, animations: 'disabled' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.keyboard.press('Escape');

  const cookies = await context.cookies();
  assert(cookies.every(cookie => cookie.name === 'awh_viewer' && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/dashboard'));
  const storage = await page.evaluate(() => ({ cookies: document.cookie, local: localStorage.length, session: sessionStorage.length }));
  assert.deepEqual(storage, { cookies: '', local: 0, session: 0 });
  assert(network.every(request => request.method === 'GET' && new URL(request.url).origin === new URL(url).origin && !request.headers.authorization));
  assert(!network.some(request => isCpRoute(new URL(request.url).pathname)));
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);

  const evidence = { view: 'dashboard-v2-antd', baseline_issue: 86, baseline_sha: '8470e51bec7c5a5a5c4301b6900c6a8c5cc05503', bundle_sha256: createHash('sha256').update(readFileSync('dist/dashboard-v2/app.js')).digest('hex'), browser: await browser.version(),
    url_pattern: 'http://127.0.0.1:<port>/dashboard/v2', dataset: 'synthetic fixture only', authority_verified: false,
    screenshots: ['overview-desktop', 'tasks-desktop', 'tasks-empty', 'task-detail', 'offline', 'overview-mobile', 'nav-mobile', 'tasks-mobile', 'task-detail-mobile'],
    checks: ['Overview renders waiting-review/blocked/next-action sections', 'Tasks filters + search + empty state',
      'Task detail drawer opens and closes with Escape', 'keyboard navigation between views', 'offline hides current facts and restores after refresh', 'native SSE with controlled partial -> refreshing -> lag -> catch-up', 'open drawer recovers with snapshot', 'detail 503 fallback is historical',
      '390px no horizontal overflow', 'HttpOnly same-site viewer cookie', 'empty browser storage',
      'same-origin GET reads only', 'no CP routes', 'no console or page errors'],
    request_count: network.length, browser_errors: errors.length, expected_fault_console_errors: expectedErrors.length, csp, csp_violations: 0, viewport_desktop: 1440, viewport_mobile: 390, locale: 'zh-CN' };
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser?.close(); child.kill(); }
