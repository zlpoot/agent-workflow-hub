import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { ControlPlaneStore } from '../dist/control-plane/store.js';
import { createControlPlaneServer } from '../dist/control-plane/server.js';
import { createViewerAuthenticator } from '../dist/dashboard/security.js';
import { DashboardStreamCache } from '../dist/dashboard/stream-cache.js';

// Reproduce the actual merged pre-P2 serializer/poll pattern, not a synthetic sleep.
const baseline = '04f7b4373de6238e44e2a43c92c5d9726af0090d';
const source = execFileSync('git', ['show', baseline + ':src/dashboard/projection.ts'], { encoding: 'utf8' });
writeFileSync('dist/dashboard-ui/baseline-projection.mjs', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { DashboardProjection: OldProjection } = await import('../dist/dashboard-ui/baseline-projection.mjs');
const f = JSON.parse(readFileSync('examples/protocol/future-ui.json', 'utf8'));
const viewer = { id: 'viewer', project_ids: [f.project.id] }, principal = { id: 'fixture-client', project_ids: [f.project.id], executor_ids: [f.executor.id] };
const results = [];
for (const size of [{ name: 'small', runs: 2, events: 4 }, { name: 'near-cap', runs: 1000, events: 9999 }]) {
  console.log('Measuring fixture ' + size.name + ' (synthetic only)');
  const dir = mkdtempSync(join(tmpdir(), 'awh-sse-load-')), path = join(dir, 'fixture.sqlite');
  const store = new ControlPlaneStore(path, [f.profile_policy]);
  let service, writer;
  const aborts = [];
  try {
    store.registerProject(principal, f.manifest); store.registerExecutor(principal, f.executor); store.registerWorkItem(principal, f.work_item);
    writer = new DatabaseSync(path); writer.exec('BEGIN');
    const addRun = writer.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)');
    const addEvent = writer.prepare('INSERT INTO events (run_id, event_id, sequence, record) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < size.runs; ++i) {
      const id = 'load-run-' + String(i).padStart(4, '0'), initial = { ...f.run, id }, projected = { ...initial, state: 'running', started_at: initial.created_at };
      addRun.run(id, f.project.id, f.executor.id, f.work_item.id, principal.id, JSON.stringify(initial), JSON.stringify(projected));
      const perRun = Math.floor(size.events / size.runs) + (i < size.events % size.runs ? 1 : 0);
      for (let j = 1; j <= perRun; ++j) {
        const event = { schema_version: '1.0', kind: 'event', id: `load-${i}-${j}`, run_id: id, sequence: j,
          type: j === 1 ? 'RUN_STARTED' : j % 2 === 0 ? 'STEP_STARTED' : 'STEP_COMPLETED', occurred_at: f.run.created_at,
          payload: { schema_version: '1.0', data: j === 1 ? { source_sha: f.run.source.sha } : j % 2 === 0 ? { step_id: 'verify-' + j, name: 'Verify' } : { step_id: 'verify-' + (j - 1), exit_code: 0 }, extensions: {} } };
        addEvent.run(id, event.id, j, JSON.stringify(event));
      }
    }
    writer.exec('COMMIT');
    let views = 0, probes = 0;
    const readView = store.dashboardReadView.bind(store), revision = store.dashboardRevision.bind(store);
    store.dashboardReadView = scope => { ++views; return readView(scope); };
    store.dashboardRevision = () => { ++probes; return revision(); };
    const measure = async optimized => {
      views = 0; probes = 0; let clock = 0;
      const cache = new DashboardStreamCache(store, () => clock), old = new OldProjection(store, viewer);
      const cpu = process.cpuUsage(), start = performance.now(), writeLatencies = [], loopDelays = [];
      for (let tick = 0; tick < 2; ++tick) {
        clock = tick * 250;
        const queued = performance.now(), pending = new Promise(resolve => setImmediate(() => { loopDelays.push(performance.now() - queued); resolve(); }));
        for (let connection = 0; connection < 64; ++connection) {
          if (optimized) { const cached = cache.read(viewer); cached.projection.timeline(null, size.events, 100); }
          else { old.timeline(null, size.events, 100); old.snapshot(); }
        }
        await pending;
        const writeStart = performance.now(); store.heartbeat(principal, f.executor.id); writeLatencies.push(performance.now() - writeStart);
        // Each tick is an idle window; reset cache after the explicitly measured writer to avoid conflating refresh with idle.
        if (optimized) cache.read(viewer, Date.now, true);
      }
      const used = process.cpuUsage(cpu);
      return { viewers: 64, ticks: 2, interval_ms: 250, elapsed_ms: +(performance.now() - start).toFixed(2), cpu_ms: +((used.user + used.system) / 1000).toFixed(2),
        full_projection_reads: views, cheap_revision_probes: probes, queued_callback_max_ms: +Math.max(...loopDelays).toFixed(2), writer_transaction_max_ms: +Math.max(...writeLatencies).toFixed(2) };
    };
    const before = await measure(false), after = await measure(true);
    assert.equal(before.full_projection_reads, 256); assert(after.full_projection_reads <= 3); assert(after.cpu_ms < before.cpu_ms);
    // Actual 64 SSE connections, default 250ms timers, plus CP HTTP heartbeat writes.
    const token = randomBytes(32).toString('base64url'), clientToken = 'awh_cp_' + randomBytes(32).toString('base64url');
    const auth = createViewerAuthenticator([{ ...viewer, session_sha256: createHash('sha256').update(token).digest('hex'), expires_at: new Date(Date.now() + 60000).toISOString() }]);
    service = createControlPlaneServer({ store, authenticate: req => req.headers.authorization === 'Bearer ' + clientToken ? principal : null, dashboard: { authenticate: auth } });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${service.server.address().port}`;
    const readers = await Promise.all(Array.from({ length: 64 }, async () => {
      const abort = new AbortController(); aborts.push(abort);
      const response = await fetch(origin + '/dashboard/v1/events/stream?after=' + size.events, { headers: { Cookie: 'awh_viewer=' + token }, signal: abort.signal });
      assert.equal(response.status, 200); const reader = response.body.getReader(); await reader.read(); return reader;
    }));
    // Settle initial hints before measuring a strictly idle window.
    await new Promise(resolve => setTimeout(resolve, 300)); views = 0; probes = 0;
    const cpu = process.cpuUsage(), start = performance.now(); await new Promise(resolve => setTimeout(resolve, 1100));
    const used = process.cpuUsage(cpu), idle = { elapsed_ms: +(performance.now() - start).toFixed(2), cpu_ms: +((used.user + used.system) / 1000).toFixed(2), full_projection_reads: views, cheap_revision_probes: probes };
    assert.equal(idle.full_projection_reads, 0); assert(idle.cheap_revision_probes <= 5);
    const latencies = [];
    for (let i = 0; i < 5; ++i) {
      const start = performance.now(); const response = await fetch(origin + `/v1/executors/${f.executor.id}/heartbeat`, { method: 'POST', headers: { Authorization: 'Bearer ' + clientToken, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 200); await response.arrayBuffer(); latencies.push(performance.now() - start);
    }
    const http_write_max_ms = +Math.max(...latencies).toFixed(2); assert(http_write_max_ms < 1000, 'CP heartbeat starved by idle viewers');
    const lastRun = 'load-run-' + String(size.runs - 1).padStart(4, '0');
    const nextSequence = Math.floor(size.events / size.runs) + 1;
    const liveEvent = { schema_version: '1.0', kind: 'event', id: 'load-live-append', run_id: lastRun, sequence: nextSequence,
      type: nextSequence % 2 === 0 ? 'STEP_STARTED' : 'STEP_COMPLETED', occurred_at: new Date().toISOString(),
      payload: { schema_version: '1.0', data: nextSequence % 2 === 0 ? { step_id: 'live-step', name: 'Live load fixture' } : { step_id: 'verify-' + (nextSequence - 1), exit_code: 0 }, extensions: {} } };
    const appendStart = performance.now();
    const appended = await fetch(origin + `/v1/runs/${lastRun}/events`, { method: 'POST', headers: { Authorization: 'Bearer ' + clientToken, 'Content-Type': 'application/json' }, body: JSON.stringify(liveEvent) });
    assert.equal(appended.status, 201); const appendBody = await appended.json(); assert.equal(appendBody.cursor, size.events + 1);
    const http_event_append_ms = +(performance.now() - appendStart).toFixed(2); assert(http_event_append_ms < 1000, 'CP Event append starved by idle viewers');
    for (const abort of aborts) abort.abort(); await Promise.allSettled(readers.map(reader => reader.cancel()));
    const result = { fixture: size, baseline, before, after, actual_64_stream_idle: idle, http_heartbeat_writes: 5, http_write_max_ms, http_event_append_ms, final_event_cursor: appendBody.cursor,
      method: 'Two 64-viewer poll batches using exact merged serializer vs shared cache, then actual idle streams and CP HTTP writes; fixture only' };
    results.push(result); console.log(JSON.stringify(result));
  } finally { for (const abort of aborts) abort.abort(); await service?.close(); writer?.close(); store.close(); assert.equal(dirname(dir), tmpdir()); assert(basename(dir).startsWith('awh-sse-load-')); rmSync(dir, { recursive: true, force: true }); }
}
mkdirSync('.handoff/dashboard-load', { recursive: true });
writeFileSync('.handoff/dashboard-load/evidence.json', JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, results }, null, 2) + '\n');
