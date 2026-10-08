import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createAuthenticator, createControlPlaneServer, ControlPlaneStore, MAX_BODY_BYTES, MAX_PAYLOAD_BYTES, safeData } from '../dist/control-plane/index.js';
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/protocol/${name}.json`, import.meta.url)));
const sample = fixture('webskill'), other = fixture('future-ui');
const principal = { id: 'mac-client', project_ids: [sample.project.id], executor_ids: [sample.executor.id] };
const foreign = { id: 'windows-client', project_ids: [other.project.id], executor_ids: [other.executor.id] };
const observer = { id: 'observer', project_ids: [sample.project.id], executor_ids: ['observer-executor'] };
const event = (sequence = 1, changes = {}) => ({ schema_version: '1.0', kind: 'event', id: `event-${sequence}`, run_id: sample.run.id, sequence,
  type: sequence === 1 ? 'RUN_STARTED' : 'STEP_STARTED', occurred_at: `2026-10-07T00:00:${String(sequence).padStart(2, '0')}.000Z`,
  payload: { schema_version: '1.0', data: sequence === 1 ? { source_sha: sample.run.source.sha } : { step_id: `step-${sequence}`, name: 'build' }, extensions: {} }, ...changes });
const credential = p => { const token = 'awh_cp_' + randomBytes(32).toString('base64url'); return { token, client: { ...p, token_sha256: createHash('sha256').update(token).digest('hex') } }; };
function populate(store, p = principal, f = sample) {
  store.registerProject(p, f.manifest); store.registerExecutor(p, f.executor); store.registerWorkItem(p, f.work_item); store.createRun(p, f.run);
}
function database(t, policies = [sample.profile_policy, other.profile_policy]) {
  const dir = mkdtempSync(join(tmpdir(), 'awh-c1b-')), path = join(dir, 'runtime.sqlite');
  const stores = [], open = () => { const s = new ControlPlaneStore(path, policies); stores.push(s); return s; };
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, open, store: open() };
}
async function httpService(t, prepopulate = true) {
  const db = database(t), auth = credential(principal), windows = credential(foreign), readOnly = credential(observer);
  if (prepopulate) populate(db.store);
  const service = createControlPlaneServer({ store: db.store, authenticate: createAuthenticator([auth.client, windows.client, readOnly.client]), poll_interval_ms: 20 });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const call = async (path, method = 'GET', data, token = auth.token, headers = {}) => {
    const response = await fetch(url + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  };
  return { ...db, ...service, url, call, auth, windows, readOnly };
}
async function frame(reader) {
  let text = '';
  while (!text.includes('data: ')) {
    const { done, value } = await reader.read(); assert.equal(done, false); text += new TextDecoder().decode(value);
  }
  const data = JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6));
  const id = Number(text.split('\n').find(line => line.startsWith('id: ')).slice(4));
  return { id, data };
}

test('SQLite migration is repeatable, versioned, and preserves every registry and runtime after restart', t => {
  const db = database(t); populate(db.store); const appended = db.store.append(principal, sample.run.id, event());
  db.store.heartbeat(principal, sample.executor.id); const lastSeen = db.store.listExecutors(principal)[0].last_seen;
  db.store.close(); const restored = db.open();
  assert.deepEqual(restored.getProject(principal, sample.project.id), sample.project);
  assert.deepEqual(restored.getWorkItem(principal, sample.work_item.id), sample.work_item);
  assert.deepEqual(restored.listProfiles(principal, sample.project.id), [sample.profile_policy]);
  assert.equal(restored.listExecutors(principal)[0].last_seen, lastSeen);
  assert.equal(restored.getRun(principal, sample.run.id).state, 'running');
  assert.deepEqual(restored.listEvents(principal, sample.run.id), [{ cursor: appended.cursor, event: event() }]);
  assert.equal(restored.append(principal, sample.run.id, event()).disposition, 'idempotent');
  const raw = new DatabaseSync(db.path); assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1); raw.close();
});
test('future SQLite versions fail closed without downgrading the database', t => {
  const db = database(t); db.store.close();
  const raw = new DatabaseSync(db.path); raw.exec('PRAGMA user_version = 2'); raw.close();
  assert.throws(() => db.open(), e => e.code === 'database_version');
  const check = new DatabaseSync(db.path); assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2); check.close();
});
test('trusted Profile versions are immutable and new versions preserve old Run bindings', t => {
  const db = database(t); populate(db.store);
  assert.throws(() => new ControlPlaneStore(db.path, [{ ...sample.profile_policy, base: 'develop' }]), e => e.code === 'profile_conflict');
  assert.throws(() => new ControlPlaneStore(db.path, [{ ...sample.profile_policy, version: 'fixture-v2', repository: 'evil/repo' }]), e => e.code === 'profile_conflict');
  const newer = new ControlPlaneStore(db.path, [{ ...sample.profile_policy, version: 'fixture-v2' }]);
  assert.equal(newer.getRun(principal, sample.run.id).profile.version, 'fixture-v1');
  assert.equal(newer.listProfiles(principal, sample.project.id).length, 2); newer.close();
});
test('Project identity comes only from Manifest bound to trusted registry and is immutable', t => {
  const { store } = database(t);
  assert.throws(() => store.registerProject(principal, { ...sample.manifest, profile: { ref: 'webskill/arbitrary' } }), e => e.code === 'profile_binding');
  assert.throws(() => store.registerProject(principal, { ...sample.manifest, project: { ...sample.manifest.project, repository: 'evil/repo' } }), e => e.code === 'profile_binding');
  assert.throws(() => store.registerProject(principal, { ...sample.manifest, profile: { ...sample.manifest.profile, policy: sample.profile_policy } }), e => e.code === 'schema');
  assert.equal(store.registerProject(principal, sample.manifest).disposition, 'created');
  assert.equal(store.registerProject(principal, sample.manifest).disposition, 'idempotent');
  assert.equal(store.listProjects(foreign).length, 0);
});
test('Executor owner and machine cannot be rebound; heartbeat uses server time', t => {
  const { store } = database(t); populate(store);
  assert.throws(() => store.registerExecutor(principal, { ...sample.executor, machine: { id: 'different', platform: 'linux' } }), e => e.code === 'identity_conflict');
  const before = store.listExecutors(principal)[0].last_seen, after = store.heartbeat(principal, sample.executor.id);
  assert(after.last_seen >= before); assert.equal(store.listExecutors(foreign).length, 0);
  assert.throws(() => store.heartbeat(foreign, sample.executor.id), e => e.status === 403);
});
test('Run creation validates exact policy, Work Item, Executor, machine and source repository bindings', t => {
  const { store } = database(t); populate(store);
  for (const changed of [{ machine_id: 'different' }, { work_item_id: other.work_item.id }, { profile: { ...sample.run.profile, version: 'unknown' } },
    { source: { ...sample.run.source, repository: 'evil/repo' } }, { project_id: other.project.id }, { executor_id: other.executor.id }])
    assert.throws(() => store.createRun(principal, { ...sample.run, id: 'different-run', ...changed }));
  store.append(principal, sample.run.id, event());
  assert.equal(store.createRun(principal, sample.run).disposition, 'idempotent');
  assert.equal(store.createRun(principal, sample.run).run.state, 'running');
  assert.throws(() => store.createRun(principal, { ...sample.run, source: { ...sample.run.source, sha: 'a'.repeat(40) } }), e => e.code === 'identity_conflict');
});
test('append atomically derives state, rejects gaps/conflicts and accepts canonical exact retries', t => {
  const { store } = database(t); populate(store);
  const first = store.append(principal, sample.run.id, event()); assert.equal(first.disposition, 'appended'); assert.equal(first.run.state, 'running');
  const reordered = { ...event(), payload: { extensions: {}, data: { source_sha: sample.run.source.sha }, schema_version: '1.0' } };
  assert.equal(store.append(principal, sample.run.id, reordered).cursor, first.cursor);
  for (const bad of [event(3), event(1, { id: 'new-id' }), event(1, { occurred_at: '2026-10-07T00:00:02.000Z' }), event(2, { run_id: 'wrong-run' })])
    assert.throws(() => store.append(principal, sample.run.id, bad));
  assert.equal(store.listEvents(principal, sample.run.id).length, 1); assert.equal(store.getRun(principal, sample.run.id).state, 'running');
  const second = store.append(principal, sample.run.id, event(2)); assert(second.cursor > first.cursor);
  assert.equal(store.listEvents(principal, sample.run.id, 1, 1)[0].event.sequence, 2);
});
test('failure in projection write rolls back the inserted Event and cursor', t => {
  const db = database(t); populate(db.store);
  const raw = new DatabaseSync(db.path); raw.exec("CREATE TRIGGER simulate_fault BEFORE UPDATE OF record ON runs BEGIN SELECT RAISE(ABORT, 'test fault'); END;");
  assert.throws(() => db.store.append(principal, sample.run.id, event()));
  assert.equal(db.store.listEvents(principal, sample.run.id).length, 0); assert.equal(db.store.getRun(principal, sample.run.id).state, 'created');
  raw.exec('DROP TRIGGER simulate_fault'); raw.close();
  assert.equal(db.store.append(principal, sample.run.id, event()).cursor, 1);
});
test('SQL triggers prohibit event replacement/removal and initial Run identity edits', t => {
  const db = database(t); populate(db.store); db.store.append(principal, sample.run.id, event());
  const raw = new DatabaseSync(db.path);
  for (const sql of ["UPDATE events SET record = '{}'", 'DELETE FROM events', "UPDATE runs SET initial = '{}'", "UPDATE profiles SET record = '{}'", 'DELETE FROM profiles']) assert.throws(() => raw.exec(sql));
  assert.equal(raw.prepare('SELECT count(*) AS count FROM events').get().count, 1); raw.close();
});
test('Run state machine enforces terminal state, schema, timestamps and verification outcome', t => {
  const { store } = database(t); populate(store);
  assert.throws(() => store.append(principal, sample.run.id, event(1, { type: 'RUN_COMPLETED', payload: { schema_version: '1.0', data: { outcome: 'pass' }, extensions: {} } })), e => e.code === 'state');
  store.append(principal, sample.run.id, event());
  const failed = event(2, { type: 'RUN_FAILED', payload: { schema_version: '1.0', data: { reason: 'fixture failure' }, extensions: {} } });
  assert.equal(store.append(principal, sample.run.id, failed).run.state, 'failed');
  assert.throws(() => store.append(principal, sample.run.id, event(3)), e => e.code === 'state');
  assert.equal(store.append(principal, sample.run.id, failed).disposition, 'idempotent');
});
test('payload byte limit and credential rejection happen before any persistence', t => {
  const db = database(t); populate(db.store);
  const tooLarge = event(); tooLarge.payload.extensions.note = 'x'.repeat(MAX_PAYLOAD_BYTES);
  assert.throws(() => db.store.append(principal, sample.run.id, tooLarge), e => e.status === 413);
  for (const value of ['ghs_fixtureonly', 'github_pat_fixtureonly', 'eyJfixture.a.b', '-----BEGIN RSA PRIVATE KEY-----', 'Authorization: Bearer fixture']) {
    const secret = event(); secret.payload.extensions.note = value;
    assert.throws(() => db.store.append(principal, sample.run.id, secret), e => e.code === 'credential_data');
  }
  for (const key of ['private_key', 'jwt', 'installation-token', 'authorization', 'access_token']) {
    const secret = event(); secret.payload.extensions[key] = 'hidden';
    assert.throws(() => db.store.append(principal, sample.run.id, secret), e => e.code === 'credential_data');
  }
  assert.equal(db.store.latestCursor(), 0);
});
test('bounded JSON inspection rejects deep, cyclic and accessor input without invoking accessors', () => {
  let deep = {}; for (let i = 0; i < 40; i++) deep = { child: deep };
  assert.throws(() => safeData(deep), e => e.code === 'invalid_json');
  const cyclic = {}; cyclic.child = cyclic; assert.throws(() => safeData(cyclic));
  let invoked = false; assert.throws(() => safeData({ get child() { invoked = true; return 1; } })); assert.equal(invoked, false);
});
test('authenticator requires explicit unique registered identities, hashes and executor ownership', () => {
  const auth = credential(principal);
  for (const clients of [[], [auth.client, auth.client], [{ ...auth.client, project_ids: ['*'] }], [{ ...auth.client, token_sha256: 'bad' }],
    [auth.client, { ...credential(observer).client, executor_ids: [sample.executor.id] }]]) assert.throws(() => createAuthenticator(clients));
  const authenticate = createAuthenticator([auth.client]);
  assert.equal(authenticate({ headers: { authorization: 'Bearer ' + auth.token }, headersDistinct: { authorization: ['Bearer ' + auth.token] } }).id, principal.id);
  assert.equal(authenticate({ headers: { authorization: 'Bearer ' + auth.token }, headersDistinct: { authorization: ['first', 'second'] } }), null);
});
test('HTTP registration, registry reads, Work Item and Run creation expose runtime declarations', async t => {
  const h = await httpService(t, false);
  for (const [path, value] of [['/v1/projects/register', sample.manifest], ['/v1/executors/register', sample.executor], ['/v1/work-items/register', sample.work_item], ['/v1/runs', sample.run]]) {
    assert.equal((await h.call(path, 'POST', value)).status, 201); assert.equal((await h.call(path, 'POST', value)).status, 200);
  }
  for (const path of ['/v1/projects', '/v1/projects/webskill', '/v1/executors', '/v1/profiles?project_id=webskill', '/v1/work-items/' + sample.work_item.id,
    '/v1/runs?project_id=webskill', '/v1/runs/' + sample.run.id, '/v1/runs/' + sample.run.id + '/events']) {
    const result = await h.call(path); assert.equal(result.status, 200, path); assert.equal(result.body.authority_verified, false);
  }
  assert.equal((await h.call(`/v1/executors/${sample.executor.id}/heartbeat`, 'POST', {})).status, 200);
  assert.equal((await h.call(`/v1/executors/${sample.executor.id}/heartbeat`, 'POST', { last_seen: 'future' })).status, 400);
});
test('HTTP rejects missing, wrong and repository credentials on every read/write/SSE path', async t => {
  const h = await httpService(t);
  for (const token of [null, 'ghs_fixtureonly', 'eyJfixture.a.b', credential(principal).token])
    for (const path of ['/v1/projects', '/v1/events/stream', '/v1/projects/register']) assert.equal((await h.call(path, path.endsWith('register') ? 'POST' : 'GET', path.endsWith('register') ? sample.manifest : undefined, token)).status, 401);
});
test('HTTP scopes prevent cross-project reads/writes, forged Executor ownership and observer Event writes', async t => {
  const h = await httpService(t); populate(h.store, foreign, other);
  for (const path of ['/v1/projects/webskill', '/v1/runs/' + sample.run.id, '/v1/runs/' + sample.run.id + '/events', '/v1/work-items/' + sample.work_item.id])
    assert.equal((await h.call(path, 'GET', undefined, h.windows.token)).status, 403);
  assert.deepEqual((await h.call('/v1/projects', 'GET', undefined, h.windows.token)).body.projects, [other.project]);
  assert.equal((await h.call('/v1/executors/register', 'POST', sample.executor, h.windows.token)).status, 403);
  assert.equal((await h.call('/v1/runs/' + sample.run.id + '/events', 'POST', event(), h.readOnly.token)).status, 403);
  assert.equal(h.store.latestCursor(), 0);
});
test('HTTP append duplicates/conflicts, pagination and idempotency header are deterministic', async t => {
  const h = await httpService(t), path = '/v1/runs/' + sample.run.id + '/events';
  assert.equal((await h.call(path, 'POST', event(), h.auth.token, { 'Idempotency-Key': 'different' })).status, 400);
  const created = await h.call(path, 'POST', event(), h.auth.token, { 'Idempotency-Key': event().id }); assert.equal(created.status, 201);
  const retried = await h.call(path, 'POST', event()); assert.equal(retried.status, 200); assert.equal(retried.body.cursor, created.body.cursor);
  assert.equal((await h.call(path, 'POST', event(1, { id: 'conflict' }))).status, 409);
  assert.equal((await h.call(path, 'POST', event(3))).status, 409);
  assert.equal((await h.call(path, 'POST', { ...event(2), type: 'MERGE' })).status, 400);
  assert.equal((await h.call(path, 'POST', event(2))).status, 201);
  const page = await h.call(path + '?after=1&limit=1'); assert.equal(page.body.events.length, 1); assert.equal(page.body.events[0].event.sequence, 2);
  for (const query of ['?after=-1', '?after=1&after=2', '?limit=101', '?limit=0', '?after=9007199254740992', '?repository=evil/repo']) assert.equal((await h.call(path + query)).status, 400);
});
test('simultaneous HTTP retries commit exactly one Event and one state change', async t => {
  const h = await httpService(t), path = '/v1/runs/' + sample.run.id + '/events';
  const results = await Promise.all(Array.from({ length: 12 }, () => h.call(path, 'POST', event())));
  assert.equal(results.filter(r => r.status === 201).length, 1); assert.equal(results.filter(r => r.status === 200).length, 11);
  assert.equal(new Set(results.map(r => r.body.cursor)).size, 1); assert.equal(h.store.listEvents(principal, sample.run.id).length, 1);
});
test('independent concurrent SQLite connections serialize duplicate and conflicting appends', async t => {
  const db = database(t); populate(db.store);
  const gate = new SharedArrayBuffer(4), ready = [], results = [];
  for (let i = 0; i < 6; i++) {
    const worker = new Worker(new URL('./control-plane-worker.mjs', import.meta.url), { workerData: { path: db.path, policy: sample.profile_policy, principal, event: event(1, i === 5 ? { id: 'conflict' } : {}), gate } });
    t.after(() => worker.terminate());
    ready.push(new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
    results.push(new Promise((resolve, reject) => { worker.on('message', message => { if (!message.ready) resolve(message); }); worker.once('error', reject); }));
  }
  await Promise.all(ready); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const records = await Promise.all(results); assert.equal(records.filter(r => r.disposition === 'appended').length, 1);
  assert(records.every(r => ['appended', 'idempotent'].includes(r.disposition) || ['sequence', 'idempotency', 'state'].includes(r.error)));
  assert.equal(db.store.listEvents(principal, sample.run.id).length, 1); assert.equal(db.store.getRun(principal, sample.run.id).state, 'running');
});
test('SSE streams committed events, supports durable reconnect cursor and filters project scope', async t => {
  const h = await httpService(t); populate(h.store, foreign, other);
  h.store.append(foreign, other.run.id, { ...event(), run_id: other.run.id, payload: { schema_version: '1.0', data: { source_sha: other.run.source.sha }, extensions: {} } });
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(h.url + '/v1/events/stream', { headers: { Authorization: 'Bearer ' + h.auth.token }, signal: abort.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body.getReader();
  const created = await h.call('/v1/runs/' + sample.run.id + '/events', 'POST', event());
  const received = await frame(reader); assert.equal(received.id, created.body.cursor); assert.equal(received.data.event.run_id, sample.run.id); assert.equal(received.data.authority_verified, false);
  abort.abort(); await reader.cancel().catch(() => {});
  const second = await h.call('/v1/runs/' + sample.run.id + '/events', 'POST', event(2));
  const resumed = await fetch(h.url + '/v1/events/stream', { headers: { Authorization: 'Bearer ' + h.auth.token, 'Last-Event-ID': String(created.body.cursor) }, signal: AbortSignal.timeout(3000) });
  const resumedReader = resumed.body.getReader(); const next = await frame(resumedReader); assert.equal(next.id, second.body.cursor); assert.equal(next.data.event.sequence, 2); await resumedReader.cancel();
  for (const q of ['?after=-1', '?after=99999', '?after=0&after=1', '?after=1e3']) assert.equal((await h.call('/v1/events/stream' + q)).status, 400);
});
test('SSE reconnect after a full server/store restart recovers persisted history', async t => {
  const db = database(t); populate(db.store); const first = db.store.append(principal, sample.run.id, event()); db.store.close();
  const restored = db.open(); const second = restored.append(principal, sample.run.id, event(2));
  const auth = credential(principal), service = createControlPlaneServer({ store: restored, authenticate: createAuthenticator([auth.client]), poll_interval_ms: 20 });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); t.after(() => service.close());
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}/v1/events/stream`, { headers: { Authorization: 'Bearer ' + auth.token, 'Last-Event-ID': String(first.cursor) }, signal: AbortSignal.timeout(3000) });
  const reader = response.body.getReader(); const received = await frame(reader); assert.equal(received.id, second.cursor); await reader.cancel();
});
test('invalid JSON/media, body byte limits, sensitive payloads and unsupported authority routes are rejected', async t => {
  const h = await httpService(t), path = '/v1/runs/' + sample.run.id + '/events';
  const text = await fetch(h.url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + h.auth.token, 'Content-Type': 'application/json' }, body: '{' }); assert.equal(text.status, 400); await text.arrayBuffer();
  assert.equal((await h.call(path, 'POST', event(), h.auth.token, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await h.call(path, 'POST', event(), h.auth.token, { 'Content-Encoding': 'gzip' })).status, 415);
  const oversized = event(); oversized.payload.extensions.note = 'x'.repeat(MAX_BODY_BYTES); assert.equal((await h.call(path, 'POST', oversized)).status, 413);
  const secret = event(); secret.payload.extensions.note = h.auth.token; const refused = await h.call(path, 'POST', secret); assert.equal(refused.status, 400); assert(!JSON.stringify(refused.body).includes(h.auth.token));
  for (const route of ['/v1/profiles/register', '/v1/runs/start', '/v1/runs/merge', '/v1/github', '/v1/reviews/approve']) assert.equal((await h.call(route, 'POST', {})).status, 404);
  assert.equal((await h.call(path, 'DELETE')).status, 405); assert.equal(h.store.latestCursor(), 0);
});
test('streamed chunked bodies enforce the byte limit without relying on Content-Length', async t => {
  const h = await httpService(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(h.url + '/v1/projects/register', { method: 'POST', headers: { Authorization: 'Bearer ' + h.auth.token, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('x'.repeat(40000)); req.end('x'.repeat(40000));
  });
  assert.equal(status, 413);
});
test('CLI is locally startable with dedicated config, survives process restart and keeps credentials out of SQLite', async t => {
  const db = database(t); db.store.close(); const auth = credential(principal), config = join(db.dir, 'trusted.json');
  writeFileSync(config, JSON.stringify({ clients: [auth.client], profiles: [sample.profile_policy] }));
  const portService = createControlPlaneServer({ store: db.open(), authenticate: createAuthenticator([auth.client]) });
  await new Promise(resolve => portService.server.listen(0, '127.0.0.1', resolve)); const port = portService.server.address().port; await portService.close();
  const start = async () => {
    const child = spawn(process.execPath, ['dist/control-plane-cli.js', '--database', db.path, '--config', config, '--port', String(port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const exit = once(child, 'exit'); let output = '';
    await Promise.race([new Promise(resolve => child.stdout.on('data', data => { output += data; if (output.includes('listening')) resolve(); })), exit.then(() => { throw new Error('CLI exited before listening'); })]);
    return { child, stop: async () => { child.kill(); await exit; } };
  };
  const one = await start(), headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  for (const [path, value] of [['/v1/projects/register', sample.manifest], ['/v1/executors/register', sample.executor], ['/v1/work-items/register', sample.work_item], ['/v1/runs', sample.run], ['/v1/runs/' + sample.run.id + '/events', event()]]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(value) }); assert.equal(response.status, 201); await response.arrayBuffer();
  }
  await one.stop(); const two = await start();
  const response = await fetch(`http://127.0.0.1:${port}/v1/runs/${sample.run.id}`, { headers }); assert.equal((await response.json()).run.state, 'running'); await two.stop();
  assert(!readFileSync(db.path).includes(Buffer.from(auth.token))); assert(!readFileSync(db.path).includes(Buffer.from(auth.client.token_sha256)));
});
test('CLI rejects unknown arguments/config and suppresses startup diagnostics', () => {
  const result = spawnSync(process.execPath, ['dist/control-plane-cli.js', '--github-token', 'fixture'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert(!result.stderr.includes('fixture')); assert.equal(result.stdout, '');
  const help = spawnSync(process.execPath, ['dist/control-plane-cli.js', '--help'], { encoding: 'utf8', windowsHide: true }); assert.equal(help.status, 0); assert.match(help.stdout, /127\.0\.0\.1/);
});
