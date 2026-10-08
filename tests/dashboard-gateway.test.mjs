import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { ControlPlaneStore, DashboardReadStore } from '../dist/control-plane/store.js';
import { createDashboardGateway } from '../dist/dashboard/gateway.js';
import { DashboardStreamCache } from '../dist/dashboard/stream-cache.js';
import { createViewerAuthenticator } from '../dist/dashboard/security.js';

function setup(t) {
  const f = JSON.parse(readFileSync(new URL('../examples/protocol/future-ui.json', import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), 'awh-read-gateway-')), path = join(dir, 'fixture.sqlite');
  const writer = new ControlPlaneStore(path, [f.profile_policy]);
  const p = { id: 'fixture-client', project_ids: [f.project.id], executor_ids: [f.executor.id] };
  writer.registerProject(p, f.manifest); writer.registerExecutor(p, f.executor); writer.registerWorkItem(p, f.work_item); writer.createRun(p, f.run);
  const reader = new DashboardReadStore(path), viewer = { id: 'viewer', project_ids: [f.project.id] };
  const stores = [reader, writer];
  t.after(() => { for (const store of stores) store.close(); assert.equal(dirname(dir), tmpdir()); assert(basename(dir).startsWith('awh-read-gateway-')); rmSync(dir, { recursive: true, force: true }); });
  return { f, p, writer, reader, viewer, path, stores };
}
test('read-only sidecar neither seeds/migrates history nor exposes mutations, and observes external Registry writes', t => {
  const h = setup(t), inspector = new DatabaseSync(h.path, { readOnly: true }); h.stores.push(inspector);
  const history = () => ['profiles', 'projects', 'runs', 'events', 'work_items'].map(table => inspector.prepare(`SELECT * FROM ${table}`).all());
  const before = history(), version = inspector.prepare('PRAGMA user_version').get(), revision = h.reader.dashboardRevision();
  assert.equal(h.reader.registerProject, undefined); assert.equal(h.reader.append, undefined);
  for (let i = 0; i < 10; ++i) h.reader.dashboardReadView(h.viewer);
  assert.deepEqual(history(), before); assert.deepEqual(inspector.prepare('PRAGMA user_version').get(), version);
  h.writer.registerExecutor(h.p, h.f.executor, { schema_version: '1.0', executor_type: 'codex', machine_name: 'fixture-windows', arch: 'x64', client_version: '0.1.0' });
  assert.notEqual(h.reader.dashboardRevision(), revision); assert.equal(h.reader.dashboardReadView(h.viewer).executors[0].client.machine_name, 'fixture-windows');
});
test('shared SSE cache performs one projection per exact scope and bounded cheap probes for 64 idle viewers', t => {
  const h = setup(t); let reads = 0, probes = 0, clock = 0;
  const counted = { dashboardRevision: () => { ++probes; return h.reader.dashboardRevision(); }, dashboardReadView: viewer => { ++reads; return h.reader.dashboardReadView(viewer); } };
  const cache = new DashboardStreamCache(counted, () => clock);
  for (let tick = 0; tick < 16; ++tick) { clock = tick * 250; for (let viewer = 0; viewer < 64; ++viewer) cache.read({ ...h.viewer, id: 'viewer-' + viewer }); }
  assert.equal(reads, 1); assert.equal(probes, 16);
  const foreign = cache.read({ id: h.viewer.id, project_ids: ['webskill'] }); assert.deepEqual(foreign.snapshot.projects, []); assert.equal(reads, 2);
});
test('cache refreshes own/external writes, cursor-constant metadata and presence, preserving event watermark', t => {
  const h = setup(t); let clock = 0, presence = Date.now();
  const cache = new DashboardStreamCache(h.reader, () => clock), read = (fresh = false) => cache.read(h.viewer, () => presence, fresh);
  const first = read(), cursor = first.snapshot.cursor;
  h.writer.registerExecutor(h.p, h.f.executor, { schema_version: '1.0', executor_type: 'codex', machine_name: 'registered-again', arch: 'x64', client_version: '0.1.0' });
  clock += 250; const next = read(); assert.notEqual(next.fingerprint, first.fingerprint); assert.equal(next.snapshot.cursor, cursor);
  presence += 61000; clock += 250; const offline = read(); assert.equal(offline.snapshot.executors[0].status, 'offline'); assert.notEqual(offline.fingerprint, next.fingerprint);
  h.writer.heartbeat(h.p, h.f.executor.id); clock += 250; presence = Date.now(); assert.equal(read().snapshot.executors[0].status, 'online');
  const own = new DashboardStreamCache(h.writer, () => clock), revision = h.writer.dashboardRevision(); own.read(h.viewer);
  h.writer.heartbeat(h.p, h.f.executor.id); assert.notEqual(h.writer.dashboardRevision(), revision);
  h.writer.append(h.p, h.f.run.id, { schema_version: '1.0', kind: 'event', id: 'start', run_id: h.f.run.id, sequence: 1, type: 'RUN_STARTED', occurred_at: new Date().toISOString(), payload: { schema_version: '1.0', data: { source_sha: h.f.run.source.sha }, extensions: {} } });
  // A new connection from a just-fetched REST watermark must not be rejected by the 250ms cache.
  assert.equal(read(true).projection.timeline(null, 1, 100).snapshot_cursor, 1);
});
async function service(t, enabled = true) {
  const h = setup(t), token = randomBytes(32).toString('base64url');
  const authenticate = createViewerAuthenticator([{ ...h.viewer, session_sha256: createHash('sha256').update(token).digest('hex'), expires_at: new Date(Date.now() + 3600000).toISOString() }]);
  const gateway = createDashboardGateway(enabled ? { enabled, store: h.reader, authenticate, assets: 'dist/dashboard-ui' } : {});
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve)); t.after(() => gateway.close());
  const origin = `http://127.0.0.1:${gateway.server.address().port}`;
  const get = (path, headers = {}, method = 'GET') => fetch(origin + path, { method, headers: { Cookie: 'awh_viewer=' + token, ...headers } });
  return { ...h, origin, get };
}
test('gateway defaults OFF and opt-in rejects incomplete configuration', async t => {
  assert.throws(() => createDashboardGateway({ enabled: true }), /explicit read store/);
  const h = await service(t, false); assert.equal((await h.get('/dashboard')).status, 404); assert.equal((await h.get('/dashboard/v1/snapshot')).status, 404);
});
test('protected same-origin UI/assets/REST have CSP and closed routes without Client or provider writes', async t => {
  const h = await service(t);
  for (const path of ['/dashboard', '/dashboard/app.js', '/dashboard/app.css', '/dashboard/v1/snapshot']) {
    const response = await h.get(path); assert.equal(response.status, 200); assert(response.headers.get('content-security-policy').includes("connect-src 'self'"));
    assert(!response.headers.has('access-control-allow-origin')); assert.equal(response.headers.get('cache-control'), 'no-store'); await response.arrayBuffer();
  }
  for (const path of ['/dashboard-ui/validators.cjs', '/dashboard/build-inputs.json', '/dashboard/.env', '/v1/runs', '/login', '/dashboard?token=not-a-real-token'])
    assert.equal((await h.get(path)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal((await h.get('/dashboard/v1/snapshot', {}, method)).status, 405);
  for (const headers of [{ Cookie: '' }, { Authorization: 'Bearer fixture-invalid' }, { Origin: 'https://evil.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    for (const path of ['/dashboard', '/dashboard/app.js', '/dashboard/v1/snapshot']) assert.equal((await h.get(path, headers)).status, 401, Object.keys(headers).join(','));
  }
  const rebound = await new Promise(resolve => { const req = request(h.origin + '/dashboard', { headers: { Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); req.end(); });
  assert.equal(rebound, 401);
  const traversal = await new Promise(resolve => { const req = request(h.origin + '/dashboard', { path: '/dashboard/%2e%2e/.env', headers: { Cookie: 'awh_viewer=invalid' } }, response => { response.resume(); resolve(response.statusCode); }); req.end(); });
  assert.equal(traversal, 400);
});
