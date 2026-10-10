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
  await page.getByRole('button', { name: '添加项目向导', exact: true }).click();
  await page.getByRole('heading', { name: '第 1 步 · 选择项目' }).waitFor();
  assert(await page.getByText('模拟 Reader 快照 · 非真实 CP', { exact: true }).isVisible());
  await page.getByRole('combobox', { name: '选择项目与来源' }).click();
  await page.getByRole('option', { name: 'Future UI · #35 历史离线样本', exact: true }).click();
  assert(await page.getByText('#35 已脱敏离线样本 · 2026-10-09', { exact: true }).isVisible());
  await page.getByRole('button', { name: '下一步', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '第 2 步 · 安装 / 认领' }).waitFor();
  await page.getByRole('combobox', { name: '安装平台' }).click(); await page.getByRole('option', { name: 'macOS · shell' }).click();
  assert((await page.getByLabel('脱敏安装与 Doctor 命令').innerText()).includes('shasum -a 256'));
  await page.getByRole('combobox', { name: '安装平台' }).click(); await page.getByRole('option', { name: 'Windows · PowerShell' }).click();
  assert((await page.getByLabel('脱敏安装与 Doctor 命令').innerText()).includes('awh.cmd'));
  await page.getByRole('button', { name: '复制脱敏命令模板', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /已复制脱敏|浏览器未允许复制/ }).waitFor();
  await page.screenshot({ path: `${output}/wizard-install.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('heading', { name: '第 3 步 · Doctor / Policy 诊断' }).waitFor();
  assert(await page.getByText('有 3 个保留 Journal 和 recovery record', { exact: false }).isVisible());
  assert(await page.getByText('9 passed / 4 blocked / 9 not_checked', { exact: false }).isVisible());
  assert(!(await page.locator('.wizard').innerText()).includes('Issue #0'));
  await page.screenshot({ path: `${output}/wizard-diagnosis.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('heading', { name: '第 4 步 · 任务 / 机器 / 时间线' }).waitFor();
  await page.getByRole('button', { name: '查看时间线', exact: true }).click();
  await page.getByRole('heading', { name: '时间线', exact: true }).waitFor();
  await page.getByRole('button', { name: '添加项目向导', exact: true }).click();
  await page.getByRole('combobox', { name: '选择项目与来源' }).click();
  await page.getByRole('option', { name: 'future-ui · 模拟 Reader 快照', exact: true }).click();
  assert(await page.getByText('模拟 Reader 快照 · 非真实 CP', { exact: true }).isVisible());
  await page.getByRole('button', { name: '查看已有项目详情', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await page.getByRole('heading', { name: '第 1 步 · 选择项目' }).waitFor();
  await page.getByRole('tab', { name: '总览', exact: true }).click();
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
  await page.getByRole('button', { name: '添加项目向导', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.screenshot({ path: `${output}/wizard-mobile.png`, animations: 'disabled' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  // Denied Viewer response in a new page, still only the synthetic host.
  const noViewer = await context.newPage();
  noViewer.on('pageerror', error => errors.push(error.message));
  noViewer.on('request', request => network.push({ url: request.url(), method: request.method(), headers: request.headers() }));
  await noViewer.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  await noViewer.route('**/dashboard/v1/**', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await noViewer.goto(url); await noViewer.getByRole('alert').waitFor();
  await noViewer.getByRole('button', { name: '添加项目向导', exact: true }).click();
  await noViewer.getByText('没有 Viewer 快照', { exact: false }).waitFor();
  assert(await noViewer.getByRole('button', { name: '下一步', exact: true }).isDisabled());
  await noViewer.getByRole('combobox', { name: '选择项目与来源' }).click();
  await noViewer.getByRole('option', { name: 'Future UI · #35 历史离线样本', exact: true }).click();
  for(let step=2;step<=4;step++){await noViewer.getByRole('button', { name: '下一步', exact: true }).click();await noViewer.getByRole('heading', { name: new RegExp('第 '+step+' 步') }).waitFor();}
  assert(await noViewer.getByRole('button', { name: '查看时间线', exact: true }).isDisabled());
  await noViewer.screenshot({ path: `${output}/wizard-no-viewer.png`, animations: 'disabled' });
  await noViewer.close();
  assert(network.every(request => request.method === 'GET' && new URL(request.url).origin === new URL(url).origin && !request.headers.authorization));
  assert.equal(errors.length, 0, errors.join('\n'));
  // Evidence contains no cookie values or request headers.
  const evidence = { browser: await browser.version(), views: ['Overview', 'Projects', 'Executors', 'Runs', 'Timeline', 'Wizard'],
    checks: ['Chinese document/title/navigation/status/diagnostics/errors', 'Chinese status search', 'render', 'search-empty', 'Run diagnostics', 'Dialog Escape', 'keyboard tabs', 'HttpOnly session', 'empty browser storage', 'same-origin GET only', 'offline retains snapshot', 'reconnect', 'mobile'],
    wizard_checks: ['four steps forward/back', 'Windows/Mac templates', 'copy template or bounded fallback', '#35 historical counts and journals',
      'scoped Reader source distinct from history', 'project detail and Timeline navigation', '390px no page overflow', 'no Viewer still navigable with unavailable Timeline'],
    request_count: network.length, browser_errors: errors.length, locale: 'zh-CN', dataset: 'synthetic fixture only', authority_verified: false };
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence));
} finally { await browser?.close(); child.kill(); }
