import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateHandoff } from '../dist/validator.js';

const example = JSON.parse(readFileSync(new URL('../examples/ready.json', import.meta.url), 'utf8'));
const head = example.candidate.head_sha;
const fresh = () => structuredClone(example);
const set = (record, path, value) => {
  const parts = path.split('.');
  const leaf = parts.pop();
  const parent = parts.reduce((v, key) => v[key], record);
  parent[leaf] = value;
};
const checkSchemaError = (record, path) => {
  const result = validateHandoff(record, head);
  assert.equal(result.schema_valid, false);
  assert.equal(result.ready_claim_valid, false);
  assert.equal(result.authority_verified, false);
  assert(result.errors.some(e => e.category === 'schema' && e.path === path), JSON.stringify(result));
  assert(result.errors.every(e => e.category === 'schema'));
};

test('Ready passes, normalizes SHA case and never verifies authority', () => {
  assert.deepEqual(validateHandoff(fresh(), head.toUpperCase()), {
    schema_valid: true, ready_claim_valid: true, authority_verified: false, errors: [],
  });
});

for (const executor of ['human', 'another-runner', '自定义执行器']) {
  test(`executor is only a declaration: ${executor}`, () => {
    const record = fresh();
    record.producer.executor = executor;
    assert.equal(validateHandoff(record, head).ready_claim_valid, true);
  });
}

const objects = [
  ['', ['schema_version', 'kind', 'work_item', 'candidate', 'producer', 'verification', 'handoff']],
  ['work_item', ['repo', 'issue']],
  ['candidate', ['pr', 'base_sha', 'head_sha']],
  ['producer', ['executor', 'run_id']],
  ['verification', ['subject_sha', 'lifecycle', 'outcome', 'checks', 'evidence_refs']],
  ['verification.checks.0', ['command', 'exit_code']],
  ['handoff', ['next_step', 'publication']],
];
const diagnosticPath = path => '$.' + path.replace('.0.', '[0].');

for (const [path, keys] of objects) {
  for (const key of keys) {
    test(`missing required field ${path ? path + '.' : ''}${key}`, () => {
      const record = fresh();
      const parent = path ? path.split('.').reduce((v, k) => v[k], record) : record;
      delete parent[key];
      checkSchemaError(record, diagnosticPath(path ? `${path}.${key}` : key));
    });
  }
  for (const extra of ['approved', 'merge_authorized']) {
    test(`unknown field rejected at ${path || '$'}: ${extra}`, () => {
      const record = fresh();
      const parent = path ? path.split('.').reduce((v, k) => v[k], record) : record;
      parent[extra] = true;
      checkSchemaError(record, diagnosticPath(path ? `${path}.${extra}` : extra));
    });
  }
}

for (const value of [null, [], 'record', 1]) {
  test(`invalid root ${JSON.stringify(value)}`, () => checkSchemaError(value, '$'));
}
for (const path of ['work_item', 'candidate', 'producer', 'verification', 'handoff', 'verification.checks.0']) {
  for (const value of [null, [], 'object']) {
    test(`invalid object ${path}: ${JSON.stringify(value)}`, () => {
      const record = fresh();
      set(record, path, value);
      checkSchemaError(record, '$.' + path.replace('.0', '[0]'));
    });
  }
}

const invalidFields = [
  ['schema_version', ['0.2', 0.1, null]],
  ['kind', ['review', 1]],
  ['work_item.repo', ['repo', 'owner/repo/extra', ' owner/repo', 'owner/', 1]],
  ['work_item.issue', [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]],
  ['candidate.pr', [0, -2, 1.1, '2']],
  ['candidate.base_sha', ['a'.repeat(39), 'g'.repeat(40), 1]],
  ['candidate.head_sha', ['a'.repeat(7), 'g'.repeat(40), null]],
  ['verification.subject_sha', ['a'.repeat(41), 'g'.repeat(40), false]],
  ['producer.executor', ['', ' \t\n', 1]],
  ['producer.run_id', ['', '  ', null]],
  ['verification.lifecycle', ['running', 1]],
  ['verification.outcome', ['ok', false]],
  ['verification.checks', [[], {}, null]],
  ['verification.checks.0.command', ['', ' \n', 1]],
  ['verification.checks.0.exit_code', ['0', 0.5, null, Number.MAX_SAFE_INTEGER + 1]],
  ['verification.evidence_refs', [[], 'https://example.com', null]],
  ['verification.evidence_refs.0', ['http://example.com', 'https://', 'javascript:alert(1)', 'https://example.com/a b', 1]],
  ['handoff.next_step', ['merge', 1]],
  ['handoff.publication', ['published', false]],
];
for (const [path, values] of invalidFields) {
  for (const value of values) {
    test(`invalid ${path}: ${JSON.stringify(value)}`, () => {
      const record = fresh();
      set(record, path, value);
      checkSchemaError(record, '$.' + path.replace('.0', '[0]'));
    });
  }
}

const notReady = [
  ['verification.lifecycle', 'failed'],
  ['verification.lifecycle', 'cancelled'],
  ['verification.outcome', 'fail'],
  ['verification.outcome', 'inconclusive'],
  ['verification.checks.0.exit_code', 1],
  ['verification.checks.0.exit_code', -1],
  ['verification.subject_sha', 'b'.repeat(40)],
  ['handoff.publication', 'pending'],
  ['handoff.publication', 'failed'],
];
for (const [path, value] of notReady) {
  test(`schema-valid but not Ready: ${path}=${value}`, () => {
    const record = fresh();
    set(record, path, value);
    const result = validateHandoff(record, head);
    assert.equal(result.schema_valid, true);
    assert.equal(result.ready_claim_valid, false);
    assert.equal(result.authority_verified, false);
    assert.deepEqual(result.errors.map(e => [e.category, e.path]), [['ready', diagnosticPath(path)]]);
  });
}

test('expected head mismatch cannot be Ready', () => {
  const result = validateHandoff(fresh(), 'b'.repeat(40));
  assert.equal(result.schema_valid, true);
  assert.equal(result.ready_claim_valid, false);
  assert.equal(result.errors[0].path, '$.candidate.head_sha');
});
test('invalid expected head is an input diagnostic', () => {
  const result = validateHandoff(fresh(), 'short');
  assert.equal(result.ready_claim_valid, false);
  assert.equal(result.errors[0].category, 'input');
});
test('every check must pass and all unmet Ready conditions are reported', () => {
  const record = fresh();
  record.verification.checks.push({ command: 'another check', exit_code: 3 });
  record.verification.lifecycle = 'failed';
  record.verification.outcome = 'fail';
  record.handoff.publication = 'pending';
  const result = validateHandoff(record, head);
  assert.equal(result.schema_valid, true);
  assert.equal(result.errors.length, 4);
  assert(result.errors.some(e => e.path === '$.verification.checks[1].exit_code'));
});
test('validation does not mutate record', () => {
  const record = fresh();
  validateHandoff(record, head);
  assert.deepEqual(record, example);
});
test('HTTPS scheme is case-insensitive and URLs are not fetched', () => {
  const record = fresh();
  record.verification.evidence_refs = ['HTTPS://example.invalid/evidence'];
  assert.equal(validateHandoff(record, head).ready_claim_valid, true);
});
