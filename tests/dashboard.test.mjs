import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ControlPlaneStore, createControlPlaneServer, createAuthenticator } from '../dist/control-plane/index.js';
import { DashboardProjection } from '../dist/dashboard/projection.js';
import { createViewerAuthenticator } from '../dist/dashboard/security.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../examples/protocol/${name}.json`, import.meta.url)));
const mac = fixture('webskill'), windows = fixture('future-ui');
const principal = f => ({ id: f.executor.id + '-client', project_ids: [f.project.id], executor_ids: [f.executor.id] });
const viewer = { id: 'operator', project_ids: ['webskill', 'future-ui'] };
const started = (f, sequence = 1) => ({ schema_version: '1.0', kind: 'event', id: `event-${sequence}`, run_id: f.run.id, sequence,
  type: sequence === 1 ? 'RUN_STARTED' : 'STEP_STARTED', occurred_at: `2026-10-07T00:00:0${sequence}.000Z`,
  payload: { schema_version: '1.0', data: sequence === 1 ? { source_sha: f.run.source.sha } : { step_id: 'build', name: 'build' }, extensions: {} } });
const hash = value => createHash('sha256').update(value).digest('hex');
const api = JSON.parse(readFileSync(new URL('../contracts/dashboard-v1.openapi.json', import.meta.url)));
const ajv = new Ajv({ strict: false }); addFormats(ajv); ajv.addSchema(api, 'urn:awh:dashboard:1.0');
const conforms = (name, value) => {
  const validate = ajv.compile({ $ref: `urn:awh:dashboard:1.0#/components/schemas/${name}` });
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
};
function setup(t, withMetadata = true) {
  const dir = mkdtempSync(join(tmpdir(), 'awh-dashboard-')), path = join(dir, 'fixture.sqlite');
  let clock = Date.parse('2026-10-07T00:00:30.000Z');
  const store = new ControlPlaneStore(path, [mac.profile_policy, windows.profile_policy], () => new Date(clock).toISOString());
  for (const f of [mac, windows]) {
    const p = principal(f);
    store.registerProject(p, f.manifest);
    store.registerExecutor(p, f.executor, withMetadata ? { schema_version: '1.0', executor_type: 'codex', machine_name: f.executor.machine.platform === 'windows' ? 'windows-fixture' : 'mac-fixture', arch: 'arm64', client_version: '0.1.0' } : undefined);
    store.registerWorkItem(p, f.work_item); store.createRun(p, f.run);
  }
  const projection = new DashboardProjection(store, viewer, () => clock), stores = [store];
  t.after(() => { for (const opened of stores) { try { opened.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  return { store, stores, path, projection, get clock() { return clock; }, advance: ms => { clock += ms; } };
}
async function http(t, withMetadata = true) {
  const h = setup(t, withMetadata), token = randomBytes(32).toString('base64url'), foreignToken = randomBytes(32).toString('base64url');
  const clientToken = 'awh_cp_' + randomBytes(32).toString('base64url');
  const sessions = [ { ...viewer, session_sha256: hash(token), expires_at: new Date(h.clock + 3600000).toISOString() },
    { id: 'mac-viewer', project_ids: ['webskill'], session_sha256: hash(foreignToken), expires_at: new Date(h.clock + 3600000).toISOString() } ];
  const authenticate = createViewerAuthenticator(sessions, () => h.clock);
  const service = createControlPlaneServer({ store: h.store, authenticate: createAuthenticator([{ ...principal(mac), token_sha256: hash(clientToken) }]),
    dashboard: { authenticate, now: () => h.clock }, poll_interval_ms: 20 });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const call = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { Cookie: 'awh_viewer=' + token, ...options.headers } });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const stream = async (path, headers = {}) => {
    const abort = new AbortController(); t.after(() => abort.abort());
    const response = await fetch(base + path, { headers: { Cookie: 'awh_viewer=' + token, ...headers }, signal: abort.signal });
    assert.equal(response.status, 200); const reader = response.body.getReader(); let buffer = '';
    const next = async type => {
      const deadline = setTimeout(() => abort.abort(), 3000);
      try {
        for (;;) {
          while (buffer.includes('\n\n')) {
            const end = buffer.indexOf('\n\n'), frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (frame.includes('event: ' + type)) {
              const lines = frame.split('\n');
              return { id: lines.find(line => line.startsWith('id: '))?.slice(4) ?? null, data: JSON.parse(lines.find(line => line.startsWith('data: ')).slice(6)) };
            }
          }
          const result = await reader.read(); if (result.done) return null; buffer += new TextDecoder().decode(result.value);
        }
      } finally { clearTimeout(deadline); }
    };
    return { next, abort, reader };
  };
  return { ...h, call, stream, base, token, foreignToken, clientToken, sessions };
}

test('OpenAPI is versioned, read-only, schema-complete and contains negative scope/auth/cursor examples', () => {
  assert.equal(api.openapi, '3.1.0'); assert.equal(api.info.version, '1.0.0');
  for (const path of Object.values(api.paths)) assert.deepEqual(Object.keys(path), ['get']);
  for (const name of Object.keys(api.components.schemas)) ajv.compile({ $ref: `urn:awh:dashboard:1.0#/components/schemas/${name}` });
  assert(api['x-negative-examples'].some(example => example.status === 401));
  assert(api['x-negative-examples'].some(example => example.status === 403));
  assert(api['x-negative-examples'].some(example => example.code === 'invalid_cursor'));
});
test('Mac WebSkill and Windows Future UI projections use stored facts with unknown metadata and false authority', t => {
  const h = setup(t, false), snapshot = h.projection.snapshot(); conforms('Snapshot', snapshot);
  assert.equal(snapshot.cursor, 0); assert.equal(snapshot.projects.length, 2); assert.equal(snapshot.executors.length, 2);
  for (const project of snapshot.projects) { assert.equal(project.name, null); assert.equal(project.enabled, null); conforms('ProjectSummary', project); }
  assert(snapshot.executors.some(executor => executor.platform === 'macos')); assert(snapshot.executors.some(executor => executor.platform === 'windows'));
  for (const executor of snapshot.executors) { assert.equal(executor.type, null); assert.equal(executor.heartbeat_at, null); assert.equal(executor.status, 'online'); }
  for (const run of snapshot.runs) { assert.equal(run.source.sha, '1'.repeat(40)); assert.equal(run.authority_verified, false); }
  const detail = h.projection.detail('runs', mac.run.id); conforms('RunDetail', detail);
  assert.equal(detail.diagnostics.github_app.status, 'not_checked'); assert.equal(detail.diagnostics.provider_permissions.status, 'not_checked');
  assert.equal(detail.diagnostics.work_item.status, 'not_checked'); assert.equal(detail.diagnostics.checks.status, 'not_checked');
  assert.equal(detail.diagnostics.branch.status, 'blocked'); assert.equal(detail.diagnostics.branch.observed, 'main');
});
test('executor online/offline/unknown reflects actual stored server contact, freshness and clock rollback only', t => {
  const h = setup(t); const last = h.projection.executors()[0].last_seen;
  h.advance(60001); assert(h.projection.executors().every(executor => executor.status === 'offline'));
  h.store.heartbeat(principal(mac), mac.executor.id); assert.equal(h.projection.executors().find(executor => executor.id === mac.executor.id).status, 'online');
  h.advance(-120000); assert(h.projection.executors().every(executor => executor.status === 'unknown'));
  assert(last); assert(h.projection.executors().every(executor => executor.presence_provenance === 'server_registration_or_heartbeat'));
});
test('global timeline order survives interleaved projects and idempotent Event retries without duplication', t => {
  const h = setup(t);
  h.store.append(principal(mac), mac.run.id, started(mac)); h.store.append(principal(windows), windows.run.id, started(windows));
  const third = h.store.append(principal(mac), mac.run.id, started(mac, 2));
  assert.equal(h.store.append(principal(mac), mac.run.id, started(mac, 2)).cursor, third.cursor);
  const page = h.projection.timeline(null, 0, 100); assert.deepEqual(page.items.map(event => event.cursor), [1, 2, 3]);
  for (const event of page.items) { conforms('TimelineEvent', event); assert.equal(event.actor, null); assert.equal(event.evidence, null); }
  assert.deepEqual(h.projection.timeline(mac.run.id, 0, 1).items.map(event => event.cursor), [1]);
  assert.equal(h.projection.timeline(mac.run.id, 0, 1).next_cursor, 1);
  assert.deepEqual(h.projection.timeline(mac.run.id, 1, 100).items.map(event => event.cursor), [3]);
  assert.equal(h.projection.detail('runs', mac.run.id).current_step.id, 'build');
});
test('checks are a runtime declaration comparison; no diagnostic establishes GitHub approval', t => {
  const h = setup(t), p = principal(mac);
  h.store.append(p, mac.run.id, started(mac));
  const event = (sequence, type, data) => ({ ...started(mac), id: `verification-${sequence}`, sequence, type, occurred_at: `2026-10-07T00:00:0${sequence}.000Z`, payload: { schema_version: '1.0', data, extensions: {} } });
  h.store.append(p, mac.run.id, event(2, 'VERIFICATION_STARTED', { subject_sha: '2'.repeat(40) }));
  h.store.append(p, mac.run.id, event(3, 'VERIFICATION_PASSED', { subject_sha: '2'.repeat(40), checks: mac.profile_policy.verification.commands.map(command => ({ command, exit_code: 0 })) }));
  const detail = h.projection.detail('runs', mac.run.id); conforms('RunDetail', detail);
  assert.equal(detail.diagnostics.checks.status, 'passed'); assert.equal(detail.diagnostics.verification_subject_sha, '2'.repeat(40));
  assert.equal(detail.source.sha, '1'.repeat(40)); assert.equal(detail.diagnostics.checks.provenance, 'runtime_verification_declaration');
  assert.equal(detail.diagnostics.github_app.status, 'not_checked'); assert.equal(detail.authority_verified, false);
  h.store.append(p, mac.run.id, event(4, 'VERIFICATION_STARTED', { subject_sha: '3'.repeat(40) }));
  const retry = h.projection.detail('runs', mac.run.id);
  assert.equal(retry.diagnostics.checks.status, 'not_checked'); assert.equal(retry.diagnostics.verification_subject_sha, '3'.repeat(40));
});
test('failed verification with all-zero checks stays blocked in RunDetail and the read API', async t => {
  const h = await http(t), p = principal(mac), subject = '2'.repeat(40);
  const checks = mac.profile_policy.verification.commands.map(command => ({ command, exit_code: 0 }));
  const event = (sequence, type, data) => ({ ...started(mac), id: `failed-verification-${sequence}`, sequence, type,
    occurred_at: `2026-10-07T00:00:0${sequence}.000Z`, payload: { schema_version: '1.0', data, extensions: {} } });
  h.store.append(p, mac.run.id, started(mac));
  h.store.append(p, mac.run.id, event(2, 'VERIFICATION_STARTED', { subject_sha: subject }));
  // Legal Protocol failure: commands succeeded, but an independent verification gate did not.
  h.store.append(p, mac.run.id, event(3, 'VERIFICATION_FAILED', { subject_sha: subject, checks, reason: 'independent gate failed' }));
  const detail = h.projection.detail('runs', mac.run.id); conforms('RunDetail', detail);
  assert.equal(detail.state, 'failed'); assert.equal(detail.diagnostics.checks.status, 'blocked');
  assert.deepEqual(detail.diagnostics.checks.observed, checks);
  assert.equal(detail.diagnostics.checks.provenance, 'runtime_verification_declaration');
  assert.equal(detail.diagnostics.verification_subject_sha, subject); assert.equal(detail.diagnostics.verification_cursor, 3);
  const response = await h.call(`/dashboard/v1/runs/${mac.run.id}`);
  assert.equal(response.status, 200); conforms('RunResponse', response.body);
  assert.equal(response.body.item.state, 'failed'); assert.equal(response.body.item.diagnostics.checks.status, 'blocked');
  assert.equal(response.body.item.authority_verified, false); assert.equal(response.body.item.diagnostics.checks.authority_verified, false);
  assert.equal(response.body.item.diagnostics.github_app.status, 'not_checked');
  assert.equal(response.body.item.diagnostics.provider_permissions.status, 'not_checked');
  assert.equal(h.projection.timeline(mac.run.id, 2, 100).items[0].result, 'failed');
});
test('overlapping steps retain correct identities and terminal failure clears current step', t => {
  const h = setup(t), p = principal(mac); h.store.append(p, mac.run.id, started(mac));
  const event = (sequence, type, data) => ({ ...started(mac), id: `step-event-${sequence}`, sequence, type,
    occurred_at: `2026-10-07T00:00:0${sequence}.000Z`, payload: { schema_version: '1.0', data, extensions: {} } });
  h.store.append(p, mac.run.id, event(2, 'STEP_STARTED', { step_id: 'one', name: 'first' }));
  h.store.append(p, mac.run.id, event(3, 'STEP_STARTED', { step_id: 'two', name: 'second' }));
  h.store.append(p, mac.run.id, event(4, 'STEP_COMPLETED', { step_id: 'one', exit_code: 0 }));
  const detail = h.projection.detail('runs', mac.run.id); assert.equal(detail.current_step.id, 'two'); assert.equal(detail.last_step.name, 'first');
  h.store.append(p, mac.run.id, event(5, 'RUN_FAILED', { reason: 'fixture failure' }));
  assert.equal(h.projection.detail('runs', mac.run.id).current_step, null);
});
test('runtime Handoff/Review claims retain false authority and do not forward arbitrary URLs or extension data', t => {
  const h = setup(t), p = principal(mac), head = '2'.repeat(40), base = '3'.repeat(40);
  const pr = { provider: 'github', repository: mac.project.repository, kind: 'pull_request', number: 42 };
  const comment = { ...pr, kind: 'issue_comment', number: 100 }, review = { ...pr, kind: 'review', number: 200 };
  const event = (sequence, type, data) => ({ ...started(mac), id: `authority-${sequence}`, sequence, type,
    occurred_at: `2026-10-07T00:00:0${sequence}.000Z`, payload: { schema_version: '1.0', data, extensions: { opaque_private_data: 'fixture-private-text', arbitrary_url: 'https://untrusted.invalid/secret' } } });
  for (const value of [event(1, 'RUN_STARTED', { source_sha: mac.run.source.sha }), event(2, 'VERIFICATION_STARTED', { subject_sha: head }),
    event(3, 'VERIFICATION_PASSED', { subject_sha: head, checks: mac.profile_policy.verification.commands.map(command => ({ command, exit_code: 0 })) }),
    event(4, 'GITHUB_PR_CREATED', { pull_request: pr, base_sha: base, head_sha: head }),
    event(5, 'HANDOFF_PUBLISHED', { handoff_version: '0.1', publication: 'confirmed', pull_request: pr, comment, base_sha: base, head_sha: head, subject_sha: head }),
    event(6, 'REVIEW_STARTED', { pull_request: pr, subject_sha: head, reviewer_executor_id: 'fixture-reviewer' }),
    event(7, 'REVIEW_PASSED', { pull_request: pr, subject_sha: head, reviewer_executor_id: 'fixture-reviewer', review })]) h.store.append(p, mac.run.id, value);
  const detail = h.projection.detail('runs', mac.run.id); assert.equal(detail.state, 'review_passed'); assert.equal(detail.authority_verified, false); conforms('RunDetail', detail);
  assert(detail.github_refs.some(ref => ref.url === 'https://github.com/zlpoot/webskill/pull/42'));
  assert(detail.github_refs.some(ref => ref.kind === 'review' && ref.url === null));
  const timeline = h.projection.timeline(mac.run.id, 0, 100); conforms('TimelinePage', timeline);
  assert(timeline.items.every(event => event.actor === null && event.authority_verified === false));
  assert(!JSON.stringify(timeline).includes('fixture-private-text')); assert(!JSON.stringify(timeline).includes('untrusted.invalid'));
});
test('read-only projection preserves SQLite version, rows, owners, Event cursor and exact history across restart', t => {
  const h = setup(t); h.store.append(principal(mac), mac.run.id, started(mac));
  const raw = new DatabaseSync(h.path), dump = () => ['projects', 'profiles', 'executors', 'executor_clients', 'work_items', 'runs', 'events'].map(table => raw.prepare(`SELECT * FROM ${table}`).all());
  const before = dump(); h.projection.snapshot(); h.projection.detail('runs', mac.run.id); h.projection.timeline(null, 0, 100);
  assert.deepEqual(dump(), before); assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2); raw.close();
  h.store.close(); const reopened = new ControlPlaneStore(h.path, [mac.profile_policy, windows.profile_policy]); h.stores.push(reopened);
  const projection = new DashboardProjection(reopened, viewer); assert.equal(projection.snapshot().cursor, 1); assert.equal(projection.runs().find(run => run.id === mac.run.id).state, 'running');
  assert.equal(reopened.append(principal(mac), mac.run.id, started(mac)).disposition, 'idempotent'); assert.equal(projection.timeline(null, 0, 100).items.length, 1);
});
test('snapshot and every list/detail/timeline route conform to the machine-readable contract', async t => {
  const h = await http(t); h.store.append(principal(mac), mac.run.id, started(mac));
  for (const [path, schema] of [['/snapshot', 'Snapshot'], ['/projects', 'ProjectPage'], ['/runs', 'RunPage'], ['/executors', 'ExecutorPage'],
    ['/projects/webskill', 'ProjectResponse'], [`/runs/${mac.run.id}`, 'RunResponse'], [`/executors/${mac.executor.id}`, 'ExecutorResponse'], [`/runs/${mac.run.id}/timeline`, 'TimelinePage']]) {
    const result = await h.call('/dashboard/v1' + path); assert.equal(result.status, 200, path); conforms(schema, result.body);
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('access-control-allow-origin'), null);
    assert(!JSON.stringify(result.body).includes(h.clientToken)); assert(!JSON.stringify(result.body).includes(h.token));
    assert(!JSON.stringify(result.body).includes('session_sha256')); assert(!JSON.stringify(result.body).includes('client_id'));
  }
});
test('viewer scope isolates all Project/Run/Executor/Snapshot/Timeline routes across Client owners', async t => {
  const h = await http(t), headers = { Cookie: 'awh_viewer=' + h.foreignToken };
  h.store.append(principal(mac), mac.run.id, started(mac)); h.store.append(principal(windows), windows.run.id, started(windows));
  for (const path of ['/projects', '/runs', '/executors', '/snapshot']) {
    const result = await h.call('/dashboard/v1' + path, { headers }); assert.equal(result.status, 200);
    assert(!JSON.stringify(result.body).includes(windows.run.id)); assert(!JSON.stringify(result.body).includes(windows.executor.id));
    assert(!JSON.stringify(result.body).includes(windows.project.repository));
  }
  for (const path of ['/projects/future-ui', '/runs?project_id=future-ui']) assert.equal((await h.call('/dashboard/v1' + path, { headers })).status, 403);
  for (const path of [`/runs/${windows.run.id}`, `/runs/${windows.run.id}/timeline`, `/executors/${windows.executor.id}`]) assert.equal((await h.call('/dashboard/v1' + path, { headers })).status, 404);
  assert.equal((await h.call(`/dashboard/v1/runs/${mac.run.id}/timeline`, { headers })).body.items.length, 1);
});
test('ID keyset pagination binds to resource/scope/filters and rejects malformed, empty or stale cursors', async t => {
  const h = await http(t), first = await h.call('/dashboard/v1/runs?limit=1');
  assert.equal(first.body.items.length, 1); assert(first.body.next_cursor);
  const second = await h.call('/dashboard/v1/runs?limit=1&cursor=' + first.body.next_cursor); assert.equal(second.status, 200);
  assert.notEqual(first.body.items[0].id, second.body.items[0].id); assert.equal(second.body.next_cursor, null);
  for (const suffix of ['?cursor=invalid', '?cursor=', '?limit=0', '?limit=101', '?state=approved', '?limit=1&limit=1', '?project_id=', '?unknown=1', '?executor_id='])
    assert.equal((await h.call('/dashboard/v1/runs' + suffix)).status, 400, suffix);
  assert.equal((await h.call('/dashboard/v1/runs?state=created&cursor=' + first.body.next_cursor)).status, 400);
  assert.equal((await h.call('/dashboard/v1/projects?cursor=' + first.body.next_cursor)).status, 400);
  assert.equal((await h.call('/dashboard/v1/runs?cursor=' + first.body.next_cursor, { headers: { Cookie: 'awh_viewer=' + h.foreignToken } })).status, 400);
  assert.equal((await h.call('/dashboard/v1/runs?project_id=webskill&state=created&executor_id=' + mac.executor.id)).body.items.length, 1);
});
test('browser boundary refuses Client bearer, PAT, JWT, cross-origin fetch, DNS rebinding and duplicate cookies', async t => {
  const h = await http(t);
  for (const headers of [{ Cookie: '' }, { Authorization: 'Bearer ' + h.clientToken }, { Authorization: 'Bearer ghp_fixture' },
    { Authorization: 'Bearer eyJfixture.fixture.fixture' }, { Origin: 'http://untrusted.invalid' }, { 'Sec-Fetch-Site': 'cross-site' },
    { Cookie: `awh_viewer=${h.token}; awh_viewer=${h.token}` }]) {
    const result = await h.call('/dashboard/v1/projects', { headers }); assert.equal(result.status, 401); conforms('Error', result.body);
  }
  // Fetch normalizes Host on this Node version; use raw HTTP to exercise a genuine rebinding request.
  const rebound = await new Promise((resolve, reject) => {
    const req = request(h.base + '/dashboard/v1/projects', { headers: { Host: 'evil.invalid', Cookie: 'awh_viewer=' + h.token } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }); req.once('error', reject); req.end();
  });
  assert.equal(rebound, 401);
  assert.equal((await h.call('/dashboard/v1/projects', { headers: { Origin: h.base, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await h.call('/v1/projects', { headers: { Authorization: 'Bearer ' + h.clientToken } })).status, 200);
  h.advance(3600001); assert.equal((await h.call('/dashboard/v1/projects')).status, 401);
});
test('viewer cannot mutate or start Executor/Run/Project/Profile/credential via any dashboard or Client endpoint', async t => {
  const h = await http(t), before = h.store.latestCursor();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    for (const path of ['/runs', '/projects', '/profiles', '/credentials', `/executors/${mac.executor.id}/heartbeat`, '/runs/start'])
      assert.equal((await h.call('/dashboard/v1' + path, { method, body: method === 'POST' ? 'not JSON' : undefined })).status, 405);
  for (const path of ['/v1/projects/register', '/v1/executors/register', '/v1/runs', `/v1/executors/${mac.executor.id}/heartbeat`])
    assert.equal((await h.call(path, { method: 'POST', body: '{}' })).status, 401);
  assert.equal(h.store.latestCursor(), before); assert.equal(h.store.getRun(principal(mac), mac.run.id).state, 'created');
});
test('SSE snapshot watermark, global reconnect cursor, scope gaps and idempotent retries do not duplicate Events', async t => {
  const h = await http(t); h.store.append(principal(mac), mac.run.id, started(mac));
  const snapshot = await h.call('/dashboard/v1/snapshot'); assert.equal(snapshot.body.cursor, 1);
  const first = await h.stream('/dashboard/v1/events/stream?after=1&project_id=webskill');
  const hint = await first.next('view-refresh'); conforms('ViewRefresh', hint.data); assert.equal(hint.id, null);
  h.store.append(principal(windows), windows.run.id, started(windows)); h.store.append(principal(mac), mac.run.id, started(mac, 2));
  const event = await first.next('timeline-event'); assert.equal(event.id, '3'); conforms('TimelineEvent', event.data); assert.equal(event.data.project_id, 'webskill'); first.abort.abort();
  h.store.append(principal(mac), mac.run.id, started(mac, 2)); assert.equal(h.store.latestCursor(), 3);
  const last = { ...started(mac, 2), id: 'finish-step', sequence: 3, type: 'STEP_COMPLETED', occurred_at: '2026-10-07T00:00:03.000Z',
    payload: { schema_version: '1.0', data: { step_id: 'build', exit_code: 0 }, extensions: {} } };
  h.store.append(principal(mac), mac.run.id, last);
  const second = await h.stream('/dashboard/v1/events/stream?project_id=webskill', { 'Last-Event-ID': '3' });
  const next = await second.next('timeline-event'); assert.equal(next.id, '4'); assert.equal(next.data.result, 'passed');
  assert.equal(h.store.latestCursor(), 4); second.abort.abort();
});
test('SSE isolates a viewer from other projects and rejects future/malformed/conflicting cursors before headers', async t => {
  const h = await http(t); h.store.append(principal(windows), windows.run.id, started(windows)); h.store.append(principal(mac), mac.run.id, started(mac));
  const stream = await h.stream('/dashboard/v1/events/stream?after=0', { Cookie: 'awh_viewer=' + h.foreignToken });
  const event = await stream.next('timeline-event'); assert.equal(event.id, '2'); assert.equal(event.data.project_id, 'webskill'); stream.abort.abort();
  for (const query of ['', '?after=-1', '?after=3', '?after=', '?after=0&after=0', '?after=0&run_id=', '?after=0&project_id='])
    assert.equal((await h.call('/dashboard/v1/events/stream' + query)).status, 400, query);
  assert.equal((await h.call('/dashboard/v1/events/stream?after=0', { headers: { 'Last-Event-ID': '0' } })).status, 400);
  assert.equal((await h.call('/dashboard/v1/events/stream?after=0&project_id=future-ui', { headers: { Cookie: 'awh_viewer=' + h.foreignToken } })).status, 403);
});
test('session expiry disconnects active streams and registration/heartbeat changes produce unnumbered refresh hints', async t => {
  const h = await http(t), stream = await h.stream('/dashboard/v1/events/stream?after=0');
  await stream.next('view-refresh'); const before = h.store.latestCursor();
  h.advance(1000); h.store.heartbeat(principal(mac), mac.executor.id);
  const hint = await stream.next('view-refresh'); assert.equal(hint.id, null); assert.equal(hint.data.snapshot_cursor, before);
  h.advance(3600000); assert.equal(await stream.next('timeline-event').catch(() => null), null);
});
test('dashboard is disabled by default, independent of the original Client authenticator', async t => {
  const h = setup(t), token = 'awh_cp_' + randomBytes(32).toString('base64url');
  const service = createControlPlaneServer({ store: h.store, authenticate: createAuthenticator([{ ...principal(mac), token_sha256: hash(token) }]) });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); t.after(() => service.close());
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}/dashboard/v1/projects`, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 404); assert.equal((await response.json()).authority_verified, false);
});
test('bounded views fail closed instead of silently truncating existing scoped Run history', t => {
  const h = setup(t), raw = new DatabaseSync(h.path), initial = raw.prepare('SELECT * FROM runs WHERE id = ?').get(mac.run.id);
  const insert = raw.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)'); raw.exec('BEGIN');
  for (let index = 0; index < 1000; index++) {
    const id = `bounded-run-${index}`, run = { ...mac.run, id };
    insert.run(id, initial.project_id, initial.executor_id, initial.work_item_id, initial.client_id, JSON.stringify(run), JSON.stringify(run));
  }
  raw.exec('COMMIT'); raw.close();
  assert.throws(() => h.projection.snapshot(), error => error.status === 503 && error.code === 'projection_limit');
  // Scope filtering precedes caps, so the other small project remains readable.
  assert.equal(new DashboardProjection(h.store, { id: 'other-viewer', project_ids: ['future-ui'] }).snapshot().runs.length, 1);
});
test('viewer sessions freeze explicit scope and reject wildcard, extra fields, duplicate identities and invalid expiry', () => {
  const session = { ...viewer, project_ids: [...viewer.project_ids], session_sha256: hash('fixture'), expires_at: '2026-10-07T01:00:00.000Z' };
  for (const entries of [[{ ...session, project_ids: ['*'] }], [{ ...session, executor_ids: ['arbitrary'] }], [session, session], [{ ...session, expires_at: 'never' }]])
    assert.throws(() => createViewerAuthenticator(entries), error => error.code === 'configuration');
  assert.doesNotThrow(() => createViewerAuthenticator([session]));
});
