import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { text } from '../dashboard/zh-CN.mjs';

// Starts only the synthetic, in-memory fixture host; never accepts a live CP URL.
const output = '.handoff/dashboard-smoke'; mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ['scripts/dashboard-fixture.mjs'], { stdio: ['ignore', 'pipe', 'ignore'] });
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture host did not start')), 10000);
    child.on('exit', () => { clearTimeout(timeout); reject(new Error('Fixture host stopped')); });
    child.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+\/dashboard/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.AWH_DASHBOARD_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  const page = await context.newPage(), errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => network.push({ url: request.url(), method: request.method(), headers: request.headers() }));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  await page.goto(url); await page.getByRole('heading', { name: '最近运行' }).waitFor();
  assert(await page.getByText('示例预览 · 模拟数据').isVisible());
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.title(), 'AWH · 工作流面板');
  await page.screenshot({ path: `${output}/overview.png`, fullPage: true, animations: 'disabled' });
  for (const name of ['Projects', 'Executors', 'Runs', 'Timeline']) {
    await page.getByRole('tab', { name: text(name), exact: true }).click();
    await page.getByRole('heading', { name: text(name), exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: text(name), exact: true }).getAttribute('aria-selected'), 'true');
    await page.screenshot({ path: `${output}/${name.toLowerCase()}.png`, fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('tab', { name: '运行记录', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索运行记录' }).fill('does-not-exist');
  await page.getByRole('heading', { name: '没有匹配的记录' }).waitFor();
  await page.screenshot({ path: `${output}/empty.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('textbox', { name: '搜索运行记录' }).fill('失败');
  assert.equal(await page.getByRole('button', { name: 'fixture-future-ui-run', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'fixture-webskill-run', exact: true }).count(), 0);
  await page.getByRole('textbox', { name: '搜索运行记录' }).fill('');
  await page.getByRole('button', { name: 'fixture-future-ui-run', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await page.getByText('未实时核验 GitHub', { exact: true }).first().waitFor();
  assert(await page.getByRole('button', { name: '关闭详情' }).isVisible());
  await page.screenshot({ path: `${output}/run-detail.png`, fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: '总览', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: '项目' }).waitFor();
  const cookies = await context.cookies();
  assert(cookies.every(cookie => cookie.name === 'awh_viewer' && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/dashboard'));
  const storage = await page.evaluate(() => ({ cookies: document.cookie, local: localStorage.length, session: sessionStorage.length }));
  assert.deepEqual(storage, { cookies: '', local: 0, session: 0 });
  assert(network.every(request => request.method === 'GET' && new URL(request.url).origin === new URL(url).origin && !request.headers.authorization));
  assert(!network.some(request => /\/v1\/(?:projects|executors|runs)(?:\/|$)/.test(new URL(request.url).pathname.replace('/dashboard/v1/', '/read/'))));
  await context.setOffline(true);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert(await page.getByText('显示上次成功读取的快照', { exact: false }).isVisible());
  await page.screenshot({ path: `${output}/offline.png`, fullPage: true, animations: 'disabled' });
  await context.setOffline(false); await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText('已连接 · 最近成功刷新：', { exact: false }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true, animations: 'disabled' });
  assert.equal(errors.length, 0, errors.join('\n'));
  // Evidence contains no cookie values or request headers.
  const evidence = { browser: await browser.version(), views: ['Overview', 'Projects', 'Executors', 'Runs', 'Timeline'],
    checks: ['Chinese document/title/navigation/status/diagnostics/errors', 'Chinese status search', 'render', 'search-empty', 'Run diagnostics', 'Dialog Escape', 'keyboard tabs', 'HttpOnly session', 'empty browser storage', 'same-origin GET only', 'offline retains snapshot', 'reconnect', 'mobile'],
    request_count: network.length, browser_errors: errors.length, locale: 'zh-CN', dataset: 'synthetic fixture only', authority_verified: false };
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence));
} finally { await browser?.close(); child.kill(); }
