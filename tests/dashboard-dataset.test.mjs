import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { ControlPlaneStore } from '../dist/control-plane/store.js';
import { npmEntry, npmEnv } from '../scripts/npm-tool.mjs';

const root = realpathSync(new URL('../', import.meta.url));
const marker = '示例预览 · 模拟数据';
const tabs = ['总览', '项目', '执行器', '运行记录', '时间线', '项目接入'];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(key)));

function cleanupScope(t) {
  const callbacks = [];
  t.after(async () => {
    const errors = [];
    for (const callback of callbacks.reverse()) { try { await callback(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Isolated dashboard cleanup failed');
  });
  return { after: callback => callbacks.push(callback) };
}

async function start(t, args) {
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  });
  // Diagnostics may contain local paths; only the fixed loopback URL is reflected.
  child.stderr.resume();
  return new Promise((resolveUrl, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Isolated dashboard did not start')), 10000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Isolated dashboard launch failed')); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Isolated dashboard stopped')); });
    child.stdout.on('data', chunk => {
      output += String(chunk);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/dashboard/);
      if (match) { clearTimeout(timeout); resolveUrl(match[0]); }
    });
  });
}
async function open(t, url) {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  await page.goto(url); await page.getByRole('heading', { name: '最近运行', exact: true }).waitFor();
  t.after(() => assert.deepEqual(errors, []));
  return { page, context };
}
async function checkTabs(page, fixture) {
  for (const name of tabs) {
    await page.getByRole('tab', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    const notice = page.getByRole('note', { name: '模拟数据来源' });
    if (fixture) { assert(await notice.isVisible()); assert.equal(await notice.textContent(), marker); }
    else { assert.equal(await notice.count(), 0); assert.equal(await page.getByText(marker, { exact: true }).count(), 0); }
  }
}

test('fixture data stays visibly labelled across tabs, mobile and offline refresh', { timeout: 45000 }, async t => {
  t = cleanupScope(t);
  const url = await start(t, ['scripts/dashboard-fixture.mjs']);
  const { page, context } = await open(t, url);
  assert.equal(await page.locator('meta[name="awh-dataset"]').getAttribute('content'), 'fixture');
  await checkTabs(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: '总览', exact: true }).click();
  assert(await page.getByRole('note', { name: '模拟数据来源' }).isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await context.setOffline(true);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('alert').first().waitFor();
  assert(await page.getByRole('note', { name: '模拟数据来源' }).isVisible());
});

test('installed standard Viewer never displays the fixture marker', { timeout: 60000 }, async t => {
  t = cleanupScope(t);
  const base = mkdtempSync(join(tmpdir(), 'awh-dataset-viewer-'));
  t.after(() => {
    const target = realpathSync(base);
    assert.equal(dirname(target), realpathSync(tmpdir())); assert(target.startsWith(join(realpathSync(tmpdir()), 'awh-dataset-viewer-')));
    rmSync(target, { recursive: true, force: true });
  });
  const pack = spawnSync(process.execPath, ['scripts/client-pack.mjs', '--viewer'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(pack.status, 0, 'Isolated Viewer package creation failed');
  const artifact = JSON.parse(pack.stdout).artifact;
  assert.equal(dirname(resolve(artifact)), join(root, '.handoff', 'packages'));
  const install = spawnSync(process.execPath, [npmEntry(), 'install', '--prefix', join(base, 'installed'), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', artifact],
    { cwd: base, env: npmEnv(join(base, 'cache')), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(install.status, 0, 'Offline Viewer package installation failed');
  const fixture = JSON.parse(readFileSync(new URL('../examples/protocol/webskill.json', import.meta.url)));
  const database = join(base, 'fixture.sqlite'), store = new ControlPlaneStore(database, [fixture.profile_policy]);
  try { store.registerProject({ id: 'fixture-reader', project_ids: [fixture.project.id], executor_ids: [] }, fixture.manifest); } finally { store.close(); }
  const probe = createServer(); await new Promise(resolvePort => probe.listen(0, '127.0.0.1', resolvePort));
  const port = probe.address().port; await new Promise(resolvePort => probe.close(resolvePort));
  const config = join(base, 'viewer.json');
  writeFileSync(config, JSON.stringify({ schema_version: '1.0', mode: 'local_browser_direct', database, port,
    viewer: { id: 'dataset-viewer', project_ids: [fixture.project.id] }, local_bindings: [] }));
  const url = await start(t, [join(base, 'installed', 'node_modules', '@zlpoot', 'awh-viewer', 'dist', 'dashboard-cli.js'), '--config', config]);
  const { page } = await open(t, url);
  assert.equal(await page.locator('meta[name="awh-dataset"]').count(), 0);
  await checkTabs(page, false);
});
