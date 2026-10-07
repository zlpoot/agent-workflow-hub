import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { validateEntity, validateBindings, replayRun, appendEvent, mapHandoffV01, RUN_STATES, ProtocolError } from '../dist/protocol/index.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../examples/protocol/${name}.json`, import.meta.url)));
const sample = fixture('webskill'), initial = sample.run;
const sha = 'a'.repeat(40), base = 'b'.repeat(40);
const pr = { provider: 'github', repository: initial.source.repository, kind: 'pull_request', number: 200 };
const comment = { provider: 'github', repository: initial.source.repository, kind: 'issue_comment', number: 300 };
const review = { provider: 'github', repository: initial.source.repository, kind: 'review', number: 400 };
const timestamp = seq => `2026-10-07T00:00:${String(seq).padStart(2, '0')}.000Z`;
const event = (type, data, sequence) => ({ schema_version: '1.0', kind: 'event', id: `event-${sequence}`, run_id: initial.id,
  sequence, type, occurred_at: timestamp(sequence), payload: { schema_version: '1.0', data, extensions: {} } });
const data = {
  RUN_STARTED: { source_sha: initial.source.sha },
  STEP_STARTED: { step_id: 'build', name: 'build' },
  STEP_COMPLETED: { step_id: 'build', exit_code: 0 },
  VERIFICATION_STARTED: { subject_sha: sha },
  VERIFICATION_PASSED: { subject_sha: sha, checks: [{ command: 'pnpm check', exit_code: 0 }] },
  VERIFICATION_FAILED: { subject_sha: sha, checks: [{ command: 'pnpm check', exit_code: 1 }], reason: 'Check failed' },
  GITHUB_PUSH_COMPLETED: { commit: { ...initial.source, sha, ref: 'codex/awh-c07-webskill-bootstrap' } },
  GITHUB_PR_CREATED: { pull_request: pr, base_sha: base, head_sha: sha },
  HANDOFF_PUBLISHED: { handoff_version: '0.1', publication: 'confirmed', pull_request: pr, comment, base_sha: base, head_sha: sha, subject_sha: sha },
  REVIEW_STARTED: { pull_request: pr, subject_sha: sha, reviewer_executor_id: 'fixture-reviewer' },
  REVIEW_PASSED: { pull_request: pr, subject_sha: sha, reviewer_executor_id: 'fixture-reviewer', review },
  RUN_COMPLETED: { outcome: 'pass' },
  RUN_FAILED: { reason: 'Execution failed' },
};
const successTypes = ['RUN_STARTED', 'STEP_STARTED', 'STEP_COMPLETED', 'VERIFICATION_STARTED', 'VERIFICATION_PASSED',
  'GITHUB_PUSH_COMPLETED', 'GITHUB_PR_CREATED', 'HANDOFF_PUBLISHED', 'REVIEW_STARTED', 'REVIEW_PASSED', 'RUN_COMPLETED'];
const success = () => successTypes.map((type, i) => event(type, structuredClone(data[type]), i + 1));
const rejects = (fn, code) => assert.throws(fn, e => e instanceof ProtocolError && e.code === code);

test('standalone draft 2020-12 schema compiles without network and matches entity fixtures', () => {
  const schema = JSON.parse(readFileSync(new URL('../src/protocol/schema.json', import.meta.url)));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addFormat('date-time', fullFormats['date-time']);
  const validate = ajv.compile(schema);
  assert.equal(schema.$id, 'urn:awh:protocol:1.0');
  assert.deepEqual(schema.$defs.run.properties.state.enum, RUN_STATES);
  for (const name of ['webskill', 'future-ui']) {
    const records = fixture(name);
    for (const [kind, value] of Object.entries(records)) {
      assert(validate(value), JSON.stringify(validate.errors));
      assert.deepEqual(validateEntity(kind, value), { valid: true, authority_verified: false, errors: [] });
    }
    assert.deepEqual(validateBindings(records), { valid: true, authority_verified: false, errors: [] });
    assert.equal(records.profile_policy.executor_restrictions, null);
  }
  for (const [type, payload] of Object.entries(data)) assert(validate(event(type, payload, 1)), JSON.stringify(validate.errors));
  const failedPass = event('VERIFICATION_PASSED', { subject_sha: sha, checks: [{ command: 'pnpm check', exit_code: 1 }] }, 1);
  assert.equal(validate(failedPass), false);
});

for (const [kind, value] of Object.entries(sample)) test(`${kind} rejects missing fields, extra authority and versions`, () => {
  for (const key of Object.keys(value)) {
    const changed = structuredClone(value); delete changed[key];
    assert.equal(validateEntity(kind, changed).valid, false, key);
  }
  for (const field of ['approved', 'merge_authorized', 'url', 'command', 'root'])
    assert.equal(validateEntity(kind, { ...value, [field]: 'injected' }).valid, false, field);
  const changed = structuredClone(value);
  if (kind === 'manifest') changed.apiVersion = 'awh/v2'; else changed.schema_version = '2.0';
  assert.equal(validateEntity(kind, changed).valid, false);
  for (const bad of [null, [], 'text', 12]) assert.equal(validateEntity(kind, bad).valid, false);
});

for (const [type, payload] of Object.entries(data)) test(`${type} has a closed envelope and required domain payload`, () => {
  const valid = event(type, payload, 1);
  assert.equal(validateEntity('event', valid).valid, true);
  for (const key of Object.keys(valid)) {
    const changed = structuredClone(valid); delete changed[key];
    assert.equal(validateEntity('event', changed).valid, false, key);
  }
  for (const key of Object.keys(payload)) {
    const changed = structuredClone(valid); delete changed.payload.data[key];
    assert.equal(validateEntity('event', changed).valid, false, key);
  }
  for (const changed of [
    { ...valid, type: 'MERGE' }, { ...valid, sequence: 0 }, { ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, payload: { ...valid.payload, schema_version: '2.0' } },
    { ...valid, payload: { ...valid.payload, data: { ...payload, approved: true } } },
    { ...valid, occurred_at: '2026-02-30T00:00:00.000Z' }, { ...valid, occurred_at: '2026-10-07T08:00:00+08:00' },
  ]) assert.equal(validateEntity('event', changed).valid, false);
});

test('extensions accept only finite plain JSON and never establish authority', () => {
  for (const kind of ['unknown', 'toString', 'constructor', '__proto__'])
    assert.equal(validateEntity(kind, {}).valid, false);
  const e = event('RUN_STARTED', data.RUN_STARTED, 1);
  e.payload.extensions = { domain: { list: [null, true, 1, 'data'] }, approved: true };
  assert.deepEqual(validateEntity('event', e), { valid: true, authority_verified: false, errors: [] });
  for (const extension of [{ bad: undefined }, { bad: Infinity }, { bad: NaN }, { bad: () => 1 }, { bad: 1n }, { bad: new Date() }, { bad: [, 1] }]) {
    e.payload.extensions = extension;
    assert.equal(validateEntity('event', e).valid, false);
  }
  const circular = {}; circular.self = circular; e.payload.extensions = circular;
  assert.equal(validateEntity('event', e).valid, false);
  let invoked = false;
  e.payload.extensions = { get bad() { invoked = true; return 1; } };
  assert.equal(validateEntity('event', e).valid, false); assert.equal(invoked, false);
});

test('Manifest cannot supply policy; registry bindings detect version, repository, executor and work item drift', () => {
  for (const bad of [null, [], 'data', {}, { ...sample, approved: true }]) assert.equal(validateBindings(bad).valid, false);
  const injected = structuredClone(sample.manifest); injected.profile.policy = sample.profile_policy;
  assert.equal(validateEntity('manifest', injected).valid, false);
  for (const mutate of [
    f => f.manifest.project.repository = 'attacker/repo', f => f.project.id = 'other',
    f => f.manifest.profile.ref = 'other/default', f => f.profile_policy.repository = 'other/repo',
    f => f.run.source.repository = 'other/repo', f => f.work_item.project_id = 'other',
    f => f.run.work_item_id = 'other', f => f.run.project_id = 'other', f => f.run.profile.version = 'other-version',
    f => f.run.profile.ref = 'other/default', f => f.run.executor_id = 'other', f => f.run.machine_id = 'other',
    f => f.profile_policy.executor_restrictions = { executor_ids: ['other'], machine_ids: ['other'] },
  ]) { const f = structuredClone(sample); mutate(f); assert.equal(validateBindings(f).valid, false); }
  const restricted = structuredClone(sample);
  restricted.profile_policy.executor_restrictions = { executor_ids: [sample.executor.id], machine_ids: [sample.executor.machine.id] };
  assert.equal(validateBindings(restricted).valid, true);
  assert.notEqual(sample.work_item.reference.repository, sample.project.repository, 'cross-repo Issue reference is intentional');
  for (const mutate of [
    p => p.github_app.identity = 'user', p => p.github_app.repository_scope = 'all', p => p.github_app.permissions.administration = 'write',
    p => p.review.builder_is_reviewer = true, p => p.delivery.exact_head_required = false,
    p => p.verification.commands = [], p => p.base = '../main', p => p.branch.ref = 'bad ref',
  ]) { const p = structuredClone(sample.profile_policy); mutate(p); assert.equal(validateEntity('profile_policy', p).valid, false); }
});

test('replay covers the success lifecycle, keeps source immutable and returns frozen snapshots', () => {
  const history = success(), before = structuredClone({ initial, history });
  const result = replayRun(initial, history);
  assert.equal(result.run.state, 'completed'); assert.equal(result.authority_verified, false);
  assert.equal(result.run.source.sha, initial.source.sha); assert.notEqual(result.run.source.sha, sha);
  assert.equal(result.run.started_at, timestamp(1)); assert.equal(result.run.completed_at, timestamp(11));
  assert.deepEqual({ initial, history }, before);
  assert.throws(() => result.events[0].payload.data.source_sha = sha, TypeError);
  assert.throws(() => result.run.source.sha = sha, TypeError);
  history[0].payload.data.source_sha = sha;
  assert.equal(result.events[0].payload.data.source_sha, initial.source.sha);
  assert.equal(replayRun(initial, success().slice(0, 8)).run.state, 'awaiting_review', 'Builder delivery does not complete independent Review');
});

test('idempotent retries compare all fields independent of object key order; append never modifies history', () => {
  const first = success()[0], history = [first], before = structuredClone(history);
  const reordered = { ...Object.fromEntries(Object.entries(first).reverse()),
    payload: { extensions: {}, data: { source_sha: initial.source.sha }, schema_version: '1.0' } };
  const retry = appendEvent(initial, history, reordered);
  assert.equal(retry.disposition, 'idempotent'); assert.equal(retry.events.length, 1); assert.deepEqual(history, before);
  const next = appendEvent(initial, history, success()[1]);
  assert.equal(next.disposition, 'appended'); assert.equal(next.events.length, 2); assert.deepEqual(history, before);
  const conflict = structuredClone(first); conflict.payload.extensions.changed = true;
  rejects(() => appendEvent(initial, history, conflict), 'idempotency');
  const sameSequence = { ...first, id: 'different-id' };
  rejects(() => appendEvent(initial, history, sameSequence), 'sequence');
  rejects(() => replayRun(initial, [first, first]), 'idempotency');
  const gap = { ...success()[1], sequence: 3 };
  rejects(() => appendEvent(initial, history, gap), 'sequence');
  rejects(() => replayRun(initial, [success()[1], first]), 'sequence');
  const terminal = success();
  assert.equal(appendEvent(initial, terminal, terminal[0]).disposition, 'idempotent', 'late retry is harmless after completion');
});

test('Run state rules reject out-of-phase events and terminal writes', () => {
  for (const [type, payload] of Object.entries(data)) if (!['RUN_STARTED', 'RUN_FAILED'].includes(type))
    rejects(() => replayRun(initial, [event(type, payload, 1)]), 'state');
  const history = success();
  rejects(() => replayRun(initial, [history[0], { ...history[0], id: 'again', sequence: 2, occurred_at: timestamp(2) }]), 'state');
  for (const type of Object.keys(data)) rejects(() => appendEvent(initial, history, event(type, data[type], 12)), 'state');
  const failed = [event('RUN_FAILED', data.RUN_FAILED, 1)];
  assert.equal(replayRun(initial, failed).run.state, 'failed');
  rejects(() => appendEvent(initial, failed, event('RUN_STARTED', data.RUN_STARTED, 2)), 'state');
  const verifyFailed = success().slice(0, 4).concat(event('VERIFICATION_FAILED', data.VERIFICATION_FAILED, 5));
  assert.equal(replayRun(initial, verifyFailed).run.state, 'failed');
  const incompleteStep = success().slice(0, 2).concat(event('VERIFICATION_STARTED', data.VERIFICATION_STARTED, 3));
  rejects(() => replayRun(initial, incompleteStep), 'state');
  const wrongStep = success().slice(0, 2).concat(event('STEP_COMPLETED', { step_id: 'other', exit_code: 0 }, 3));
  rejects(() => replayRun(initial, wrongStep), 'state');
  const failedStep = success().slice(0, 4); failedStep[2].payload.data.exit_code = 1;
  rejects(() => replayRun(initial, failedStep), 'state');
  rejects(() => replayRun({ ...initial, state: 'running', started_at: initial.created_at }, []), 'state');
});

test('event and Run timestamps, Run identity and verified SHA references are enforced', () => {
  const history = success();
  for (const [index, mutate, code] of [
    [0, e => e.run_id = 'other', 'binding'], [0, e => e.payload.data.source_sha = sha, 'binding'],
    [4, e => e.payload.data.subject_sha = base, 'binding'], [5, e => e.payload.data.commit.repository = 'other/repo', 'binding'],
    [5, e => e.payload.data.commit.sha = base, 'binding'], [6, e => e.payload.data.head_sha = base, 'binding'],
    [6, e => e.payload.data.pull_request.repository = 'other/repo', 'binding'],
    [7, e => e.payload.data.subject_sha = base, 'binding'], [7, e => e.payload.data.base_sha = sha, 'binding'],
    [7, e => e.payload.data.comment.repository = 'other/repo', 'binding'],
    [7, e => e.payload.data.publication = 'pending', 'state'],
    [8, e => e.payload.data.reviewer_executor_id = initial.executor_id, 'binding'],
    [8, e => e.payload.data.pull_request.number++, 'binding'], [9, e => e.payload.data.subject_sha = base, 'binding'],
    [9, e => e.payload.data.reviewer_executor_id = 'other-reviewer', 'binding'],
    [9, e => e.payload.data.review.repository = 'other/repo', 'binding'],
    [1, e => e.occurred_at = initial.created_at, 'timestamp'],
  ]) {
    const changed = structuredClone(history); mutate(changed[index]);
    rejects(() => replayRun(initial, changed), code);
  }
  const nonzero = structuredClone(history); nonzero[4].payload.data.checks[0].exit_code = 1;
  rejects(() => replayRun(initial, nonzero), 'schema');
  for (const changed of [
    { ...initial, started_at: initial.created_at }, { ...initial, completed_at: initial.created_at },
    { ...initial, updated_at: '2026-10-06T00:00:00.000Z' },
    { ...initial, state: 'completed', completed_at: initial.created_at },
  ]) assert.equal(validateEntity('run', changed).valid, false);
});

test('a new verification cycle invalidates old candidate, publication and review claims', () => {
  const history = success().slice(0, 8);
  history.push(event('VERIFICATION_STARTED', { subject_sha: base }, 9));
  history.push(event('VERIFICATION_PASSED', { subject_sha: base, checks: [{ command: 'pnpm check', exit_code: 0 }] }, 10));
  rejects(() => appendEvent(initial, history, event('REVIEW_STARTED', data.REVIEW_STARTED, 11)), 'binding');
  const nextPR = { ...data.GITHUB_PR_CREATED, head_sha: base };
  history.push(event('GITHUB_PR_CREATED', nextPR, 11));
  rejects(() => appendEvent(initial, history, event('REVIEW_STARTED', { ...data.REVIEW_STARTED, subject_sha: base }, 12)), 'state');
});

const handoff = publication => ({ schema_version: '0.1', kind: 'builder_handoff', work_item: { repo: 'zlpoot/agent-workflow-hub', issue: 8 },
  candidate: { pr: pr.number, base_sha: base, head_sha: sha.toUpperCase() }, producer: { executor: 'Fixture Builder', run_id: initial.id },
  verification: { subject_sha: sha.toUpperCase(), lifecycle: 'completed', outcome: 'pass', checks: [{ command: 'pnpm check', exit_code: 0 }],
    evidence_refs: ['https://github.com/zlpoot/webskill/pull/200#issuecomment-299'] }, handoff: { next_step: 'review', publication } });
const context = { id: 'handoff-event', run_id: initial.id, sequence: 8, occurred_at: timestamp(8), repository: pr.repository, comment_number: comment.number };
test('v0.1 mapping retains validation semantics and emits only HANDOFF_PUBLISHED references', () => {
  for (const publication of ['pending', 'confirmed', 'failed']) {
    const record = handoff(publication), before = structuredClone(record);
    const mapped = mapHandoffV01(record, sha, context);
    assert.deepEqual(record, before); assert.equal(mapped.authority_verified, false);
    assert.equal(mapped.validation.schema_valid, true); assert.equal(mapped.validation.authority_verified, false);
    assert.equal(mapped.validation.ready_claim_valid, publication === 'confirmed');
    assert.equal(mapped.event.type, 'HANDOFF_PUBLISHED'); assert.equal(mapped.event.payload.data.head_sha, sha);
    assert.equal(replayRun(initial, success().slice(0, 7).concat(mapped.event)).run.state, 'awaiting_review');
  }
  for (const mutate of [r => r.verification.outcome = 'fail', r => r.verification.checks[0].exit_code = 1, r => r.verification.subject_sha = base]) {
    const record = handoff('confirmed'); mutate(record); rejects(() => mapHandoffV01(record, sha, context), 'binding');
  }
  rejects(() => mapHandoffV01(handoff('pending'), base, context), 'binding');
  rejects(() => mapHandoffV01(handoff('confirmed'), sha, { ...context, run_id: 'other' }), 'binding');
  rejects(() => mapHandoffV01({ ...handoff('confirmed'), approved: true }, sha, context), 'schema');
  const pending = mapHandoffV01(handoff('pending'), sha, context).event;
  const confirmed = mapHandoffV01(handoff('confirmed'), sha, { ...context, id: 'confirmed-event', sequence: 9, occurred_at: timestamp(9) }).event;
  const previous = success().slice(0, 7).concat(pending);
  assert.equal(appendEvent(initial, previous, confirmed).run.state, 'awaiting_review');
  const changed = structuredClone(confirmed); changed.payload.data.comment.number++;
  rejects(() => appendEvent(initial, previous, changed), 'binding');
});

test('Protocol APIs operate with network, subprocess and filesystem mutation disabled', () => {
  const script = `import {validateEntity,replayRun,appendEvent} from './dist/protocol/index.js';
    const run=${JSON.stringify(initial)},events=${JSON.stringify(success())};
    if (!validateEntity('run',run).valid || replayRun(run,events).run.state !== 'completed' ||
      appendEvent(run,events,events[0]).disposition !== 'idempotent') throw Error('Unexpected result');`;
  const result = spawnSync(process.execPath, ['--import', './tests/deny-side-effects.mjs', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
