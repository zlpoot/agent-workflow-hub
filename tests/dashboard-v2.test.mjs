import './trusted-policy-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dashboardHeaders } from '../dist/dashboard/gateway.js';
import { taskFixtures } from './task-fixture.mjs';

// Targeted Dashboard V2 PoC checks: isolated fixture host, unchanged read contract,
// untouched V1 assets and a browser bundle that contains no server sources.
const root = new URL('../', import.meta.url);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(key)));

async function startPreview(t) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['scripts/dashboard-v2-preview.mjs', '--port', '0'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('V2 preview did not start')), 15000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('V2 preview stopped')); });
    child.stdout.on('data', data => {
      const match = String(data).match(/http:\/\/127\.0\.0\.1:(\d+)\/dashboard\/v2/);
      if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { base, v2: `${base}/dashboard/v2`, api: `${base}/dashboard/v1` };
}

test('dashboard v2 poc serves an isolated fixture host over the unchanged read contract', async t => {
  const { v2, api } = await startPreview(t);
  const response = await fetch(v2, { redirect: 'error' });
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /^text\/html; charset=utf-8/);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<meta name="awh-dataset" content="fixture">/);
  assert.match(html, /\/dashboard\/v2\/app\.js/);
  assert.doesNotMatch(html, /\/dashboard\/app\.js/);
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /awh_viewer=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/dashboard/);
  const headers = { cookie: setCookie.split(';')[0] };

  const bundle = await fetch(`${v2}/app.js`, { headers, redirect: 'error' });
  assert.equal(bundle.status, 200);
  assert.match(String(bundle.headers.get('content-type')), /^text\/javascript/);

  const snapshot = await (await fetch(`${api}/snapshot`, { headers, redirect: 'error' })).json();
  assert.equal(snapshot.authority_verified, false);
  assert.ok(snapshot.projects.length > 0 && snapshot.executors.length > 0);
  assert.ok(snapshot.tasks.length >= taskFixtures().length);
  assert.ok(snapshot.tasks.every(task => task.fixture === true || typeof task.id === 'string'));

  const detail = await (await fetch(`${api}/tasks/${encodeURIComponent('fixture:task:3')}`, { headers, redirect: 'error' })).json();
  assert.equal(detail.authority_verified, false);
  assert.equal(detail.item.state, 'awaiting_review');

  assert.equal((await fetch(`${api}/snapshot`, { method: 'POST', headers, redirect: 'error' })).status, 405);
  assert.equal((await fetch(`${api}/snapshot`, { redirect: 'error' })).status, 401);
  assert.equal((await fetch(`${v2}/missing.js`, { headers, redirect: 'error' })).status, 404);
});

test('dashboard v2 build output stays isolated from the existing dashboard v1 assets', () => {
  const inputs = JSON.parse(readFileSync(new URL('../dist/dashboard-v2/build-inputs.json', import.meta.url), 'utf8'));
  assert.ok(inputs.some(path => path.startsWith('dashboard/v2/')));
  assert.ok(inputs.some(path => path === 'dashboard/adapter.mjs'), 'V2 must reuse the existing DashboardReader');
  assert.ok(!inputs.some(path => /^(?:\.\.\/)+src\//.test(path)), 'server sources must not reach the browser bundle');
  const sizes = JSON.parse(readFileSync(new URL('../dist/dashboard-v2/build-size.json', import.meta.url), 'utf8'));
  const script = sizes.find(entry => entry.file.endsWith('app.js'));
  assert.ok(script && script.bytes > 0 && script.gzip > 0 && script.gzip < script.bytes);
  assert.ok(sizes.every(entry => !entry.file.includes('dashboard-ui')), 'V2 must not overwrite dashboard-ui assets');
});

test('dashboard v2 keeps the published gateway security headers byte for byte', () => {
  assert.equal(dashboardHeaders['Content-Security-Policy'],
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  assert.equal(dashboardHeaders['Referrer-Policy'], 'no-referrer');
});
