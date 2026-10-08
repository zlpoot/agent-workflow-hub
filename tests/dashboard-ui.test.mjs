import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ControlPlaneStore } from '../dist/control-plane/store.js';
import { DashboardProjection } from '../dist/dashboard/projection.js';
import { DashboardReader, assertContract, mergeEvents, safeGitHubUrl, safeSourceUrl } from '../dashboard/adapter.mjs';

function fixture(t) {
  const f = JSON.parse(readFileSync(new URL('../examples/protocol/webskill.json', import.meta.url)));
  const p = { id: 'fixture-client', project_ids: [f.project.id], executor_ids: [f.executor.id] };
  const store = new ControlPlaneStore(':memory:', [f.profile_policy], () => '2026-10-08T00:00:00.000Z'); t.after(() => store.close());
  store.registerProject(p, f.manifest); store.registerExecutor(p, f.executor); store.registerWorkItem(p, f.work_item); store.createRun(p, f.run);
  const append = (sequence, type, data) => store.append(p, f.run.id, { schema_version: '1.0', kind: 'event', id: 'fixture-event-' + sequence, run_id: f.run.id,
    sequence, type, occurred_at: '2026-10-08T00:00:00.000Z', payload: { schema_version: '1.0', data, extensions: {} } });
  append(1, 'RUN_STARTED', { source_sha: f.run.source.sha });
  const projection = new DashboardProjection(store, { id: 'viewer', project_ids: p.project_ids });
  return { f, store, projection, append };
}
class Stream {
  readyState = 0; closed = false; listeners = new Map();
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  emit(name, data, id = '') { if (name === 'open') this.readyState = 1; this.listeners.get(name)?.({ data: JSON.stringify(data), lastEventId: id }); }
  close() { this.closed = true; this.readyState = 2; }
}
function harness(h, fetcher) {
  const states = [], streams = [], tasks = [], requests = [];
  const reader = new DashboardReader({ publish: state => states.push(state), openStream: path => { const s = new Stream(); s.path = path; streams.push(s); return s; },
    schedule: (fn, ms) => { const task = { fn, ms }; tasks.push(task); return task; }, cancel: task => { const i = tasks.indexOf(task); if (i !== -1) tasks.splice(i, 1); },
    fetcher: async (path, options) => { requests.push({ path, options }); if (fetcher) return fetcher(path, options);
      const url = new URL(path, 'http://fixture.invalid');
      const body = url.pathname.endsWith('/snapshot') ? h.projection.snapshot() : h.projection.timeline(h.f.run.id, Number(url.searchParams.get('after')), 100);
      return { ok: true, json: async () => structuredClone(body) }; } });
  return { reader, states, streams, tasks, requests };
}
test('browser DTO validation rejects changed authority, extra secret fields and incompatible contract', t => {
  const h = fixture(t), snapshot = h.projection.snapshot(); assertContract('Snapshot', snapshot);
  for (const patch of [{ authority_verified: true }, { contract_version: '2.0' }, { token: 'never-display-this' }])
    assert.throws(() => assertContract('Snapshot', { ...snapshot, ...patch }), /contract mismatch/);
  assert.equal(snapshot.projects[0].enabled, null); assert.equal(snapshot.executors[0].type, null);
});
test('links reconstruct typed GitHub identities and refuse untrusted URLs, malformed references and non-issues', () => {
  const ref = { provider: 'github', repository: 'zlpoot/agent-workflow-hub', kind: 'issue', number: 30, authority_verified: false, url: 'https://evil.invalid/?secret=x' };
  assert.equal(safeGitHubUrl(ref), 'https://github.com/zlpoot/agent-workflow-hub/issues/30');
  for (const patch of [{ kind: 'review' }, { provider: 'other' }, { authority_verified: true }, { number: 0 }, { repository: 'x/../evil' }]) assert.equal(safeGitHubUrl({ ...ref, ...patch }), null);
  assert.equal(safeSourceUrl({ repository: 'zlpoot/future-ui', sha: '1'.repeat(40), url: 'javascript:alert(1)' }), 'https://github.com/zlpoot/future-ui/commit/' + '1'.repeat(40));
  assert.equal(safeSourceUrl({ repository: 'x/y?redirect=evil', sha: '1'.repeat(40) }), null);
});
test('Timeline dedup uses persistent global cursors, preserves gaps/order and rejects conflicting replay', t => {
  const h = fixture(t), event = h.projection.timeline(null, 0, 100).items[0];
  const third = { ...event, cursor: 3, event_id: 'third' };
  assert.deepEqual(mergeEvents([third], [event, third]).map(e => e.cursor), [1, 3]);
  assert.throws(() => mergeEvents([event], [{ ...event, result: 'passed' }]), /Conflicting/);
});
test('initial snapshot and history precede SSE; Connected appears only after actual open; refresh keeps connection', async t => {
  const h = fixture(t), b = harness(h); t.after(() => b.reader.stop()); await b.reader.refresh();
  assert.equal(b.reader.state.phase, 'connecting'); assert.deepEqual(b.reader.state.events.map(e => e.cursor), [1]);
  assert.equal(b.streams[0].path, '/dashboard/v1/events/stream?after=1'); b.streams[0].emit('open'); assert.equal(b.reader.state.phase, 'live');
  b.streams[0].emit('view-refresh', { contract_version: '1.0', authority_verified: false, snapshot_cursor: 1 });
  assert.equal(b.tasks.length, 1); await b.reader.refresh(); assert.equal(b.streams.length, 1); assert.equal(b.tasks.length, 0);
  assert(b.requests.every(({ path, options }) => path.startsWith('/dashboard/v1/') && options.method === 'GET' && options.credentials === 'same-origin' && options.redirect === 'error' && !options.headers));
});
test('incremental Event and heartbeat invalidation sync without duplication; reconnect refreshes saved watermark', async t => {
  const h = fixture(t), b = harness(h); t.after(() => b.reader.stop()); await b.reader.refresh(); b.streams[0].emit('open');
  h.append(2, 'STEP_STARTED', { step_id: 'verify', name: 'Verify' }); const event = h.projection.timeline(null, 1, 100).items[0];
  b.streams[0].emit('timeline-event', event, '2'); b.streams[0].emit('timeline-event', event, '2');
  assert.equal(b.reader.state.phase, 'partial'); assert.deepEqual(b.reader.state.events.map(e => e.cursor), [1, 2]);
  await b.reader.refresh(); assert.equal(b.reader.state.snapshot.cursor, 2); assert.equal(b.streams.length, 1);
  b.streams[0].onerror(); assert.equal(b.reader.state.phase, 'offline'); await b.reader.refresh(); assert.equal(b.streams.length, 2);
  assert.equal(b.streams[1].path, '/dashboard/v1/events/stream?after=2'); assert.deepEqual(b.reader.state.events.map(e => e.cursor), [1, 2]);
});
test('401/403/default-off 404 retain last snapshot and stop retry; arbitrary response bodies are never reflected', async t => {
  const h = fixture(t);
  for (const status of [401, 403, 404, 503]) {
    let failed = false; const b = harness(h, async path => failed ? { ok: false, status, json: async () => ({ secret: 'never-display' }) } :
      { ok: true, json: async () => path.endsWith('/snapshot') ? h.projection.snapshot() : h.projection.timeline(null, 0, 100) });
    await b.reader.refresh(); const good = b.reader.state.snapshot; failed = true; await b.reader.refresh();
    assert.equal(b.reader.state.snapshot, good); assert.equal(b.reader.state.phase, 'outdated'); assert(!b.reader.state.error.includes('never-display'));
    assert.equal(b.tasks.length, status === 503 ? 1 : 0); assert(b.streams[0].closed); b.reader.stop();
  }
});
test('incompatible JSON and network exceptions produce safe errors without replacing last good data', async t => {
  const h = fixture(t); const b = harness(h, async () => ({ ok: true, json: async () => { throw new Error('awh_cp_do-not-echo'); } }));
  t.after(() => b.reader.stop()); await b.reader.refresh(); assert.equal(b.reader.state.snapshot, null); assert(!b.reader.state.error.includes('awh_cp_'));
});
test('history pagination pins snapshot watermark; later Events replay and repeated pages fail closed', async t => {
  const h = fixture(t); const first = h.projection.snapshot(); h.append(2, 'STEP_STARTED', { step_id: 'verify', name: 'Verify' });
  const b = harness(h, async path => ({ ok: true, json: async () => path.endsWith('/snapshot') ? first : h.projection.timeline(null, 0, 100) }));
  t.after(() => b.reader.stop()); await b.reader.refresh(); assert.deepEqual(b.reader.state.events.map(e => e.cursor), [1]); assert.equal(b.streams[0].path, '/dashboard/v1/events/stream?after=1');
  const bad = harness(h, async path => ({ ok: true, json: async () => path.endsWith('/snapshot') ? h.projection.snapshot() : { ...h.projection.timeline(null, 0, 100), next_cursor: 0 } }));
  t.after(() => bad.reader.stop()); await bad.reader.refresh(); assert.equal(bad.reader.state.phase, 'error'); assert.equal(bad.streams.length, 0);
});
test('browser backfills more than one Timeline page in global cursor order without missing or repeating rows', async t => {
  const h = fixture(t);
  for (let sequence = 2; sequence <= 105; ++sequence) h.append(sequence, sequence % 2 === 0 ? 'STEP_STARTED' : 'STEP_COMPLETED',
    sequence % 2 === 0 ? { step_id: 'step-' + sequence, name: 'Verify' } : { step_id: 'step-' + (sequence - 1), exit_code: 0 });
  const b = harness(h); t.after(() => b.reader.stop()); await b.reader.refresh();
  assert.deepEqual(b.reader.state.events.map(event => event.cursor), Array.from({ length: 105 }, (_, i) => i + 1));
  assert(b.requests.some(({ path }) => path.endsWith('?after=100&limit=100'))); assert.equal(b.streams[0].path, '/dashboard/v1/events/stream?after=105');
});
test('Events received while REST refresh is in flight remain buffered beyond its watermark', async t => {
  const h = fixture(t); let hold = false, release, captured;
  const b = harness(h, async path => {
    if (path.endsWith('/snapshot')) return { ok: true, json: async () => h.projection.snapshot() };
    const page = h.projection.timeline(null, 0, 100);
    if (hold) { captured?.(); await new Promise(resolve => { release = resolve; }); }
    return { ok: true, json: async () => page };
  });
  t.after(() => b.reader.stop()); await b.reader.refresh(); b.streams[0].emit('open');
  hold = true; const pending = new Promise(resolve => { captured = resolve; }); const refresh = b.reader.refresh(); await pending;
  h.append(2, 'STEP_STARTED', { step_id: 'verify', name: 'Verify' }); const event = h.projection.timeline(null, 1, 100).items[0];
  b.streams[0].emit('timeline-event', event, '2'); release(); await refresh;
  assert.equal(b.reader.state.snapshot.cursor, 1); assert.equal(b.reader.state.phase, 'partial'); assert.deepEqual(b.reader.state.events.map(e => e.cursor), [1, 2]);
  assert.equal(b.streams.length, 1); assert.equal(b.tasks.length, 1);
});
test('stop aborts pending requests and stale stream callbacks cannot publish or reconnect', async t => {
  const h = fixture(t), b = harness(h); await b.reader.refresh(); b.reader.stop(); const count = b.states.length;
  b.streams[0].emit('open'); b.streams[0].onerror(); await b.reader.refresh(); assert.equal(b.states.length, count); assert.equal(b.tasks.length, 0);
});
test('browser build contains pinned component implementation and static contract validators, without server imports', () => {
  const inputs = JSON.parse(readFileSync(new URL('../dist/dashboard-ui/build-inputs.json', import.meta.url)));
  assert(inputs.some(input => input.includes('@radix-ui/themes'))); assert(inputs.includes('dist/dashboard-ui/validators.cjs'));
  assert(inputs.every(input => !/src\/|builder|control-plane/.test(input)));
  const source = readFileSync(new URL('../dashboard/adapter.mjs', import.meta.url), 'utf8'); assert(!/localStorage|sessionStorage|document\.cookie|Authorization|console\./.test(source));
});
