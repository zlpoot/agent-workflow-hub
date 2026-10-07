import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const example = JSON.parse(readFileSync(new URL('../examples/ready.json', import.meta.url), 'utf8'));
const head = example.candidate.head_sha;
const run = (args, nodeArgs = []) => {
  const child = spawnSync(process.execPath, [...nodeArgs, cli, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.trim().split('\n').length, 1, 'one JSON result, no extra output');
  const result = JSON.parse(child.stdout);
  assert.equal(result.authority_verified, false);
  return { code: child.status, result, raw: child.stdout };
};
const withFile = (contents, callback) => {
  const dir = mkdtempSync(join(tmpdir(), 'awh-cli-'));
  try {
    const file = join(dir, 'handoff record.json');
    writeFileSync(file, contents);
    callback(file, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const recordTest = (name, mutate, schemaValid, exitCode, category) => test(name, () => {
  const record = structuredClone(example);
  mutate(record);
  withFile(JSON.stringify(record), file => {
    const { code, result } = run([file, '--expected-head', head]);
    assert.equal(code, exitCode);
    assert.equal(result.schema_valid, schemaValid);
    assert.equal(result.ready_claim_valid, exitCode === 0);
    if (category) assert(result.errors.every(e => e.category === category));
  });
});
recordTest('CLI accepts valid Ready', () => {}, true, 0);
recordTest('CLI rejects missing field', r => { delete r.candidate; }, false, 1, 'schema');
recordTest('CLI rejects wrong type', r => { r.verification.checks = 1; }, false, 1, 'schema');
recordTest('CLI rejects short SHA', r => { r.candidate.head_sha = 'aaaaaaa'; }, false, 1, 'schema');
recordTest('CLI rejects non-hex SHA', r => { r.candidate.base_sha = 'z'.repeat(40); }, false, 1, 'schema');
recordTest('CLI rejects unknown version', r => { r.schema_version = '1.0'; }, false, 1, 'schema');
recordTest('CLI rejects authorization extension', r => { r.approved = true; }, false, 1, 'schema');
recordTest('CLI reports subject mismatch as Ready failure', r => { r.verification.subject_sha = 'b'.repeat(40); }, true, 1, 'ready');
recordTest('CLI accepts schema-valid failed verification but fails Ready', r => {
  r.verification.lifecycle = 'failed'; r.verification.outcome = 'fail'; r.verification.checks[0].exit_code = 1;
}, true, 1, 'ready');
recordTest('CLI accepts schema-valid cancellation but fails Ready', r => {
  r.verification.lifecycle = 'cancelled'; r.verification.outcome = 'inconclusive';
}, true, 1, 'ready');
recordTest('CLI pending publication is not Ready', r => { r.handoff.publication = 'pending'; }, true, 1, 'ready');
recordTest('CLI accepts human executor', r => { r.producer.executor = 'human'; }, true, 0);

test('CLI expected head must match, case-insensitively', () => withFile(JSON.stringify(example), file => {
  assert.equal(run([file, '--expected-head', head.toUpperCase()]).code, 0);
  const { code, result } = run([file, '--expected-head', 'b'.repeat(40)]);
  assert.equal(code, 1);
  assert.equal(result.schema_valid, true);
  assert.equal(result.ready_claim_valid, false);
  assert.equal(result.errors[0].path, '$.candidate.head_sha');
}));
for (const args of [[], ['record.json'], ['record.json', '--expected-head'],
  ['record.json', '--expected-head', 'short'], ['record.json', '--unknown', head],
  ['record.json', '--expected-head', head, 'extra'], ['record.json', '--expected-head', head, '--expected-head', head]]) {
  test(`CLI argument failure: ${JSON.stringify(args)}`, () => {
    const { code, result } = run(args);
    assert.equal(code, 2);
    assert.equal(result.schema_valid, false);
    assert.equal(result.errors[0].category, 'input');
    assert.equal(result.errors[0].path, '$args');
  });
}
test('CLI file read error', () => withFile('{}', (_, dir) => {
  const { code, result } = run([join(dir, 'missing.json'), '--expected-head', head]);
  assert.equal(code, 2);
  assert.equal(result.errors[0].path, '$file');
  assert.match(result.errors[0].reason, /ENOENT/);
}));
for (const contents of ['{bad', '', '\ufeff{}']) {
  test(`CLI JSON parse error: ${JSON.stringify(contents)}`, () => withFile(contents, file => {
    const { code, result } = run([file, '--expected-head', head]);
    assert.equal(code, 2);
    assert.equal(result.errors[0].category, 'input');
    assert.equal(result.errors[0].path, '$file');
  }));
}
test('CLI deterministic output; command, URL and identity remain inert; input unchanged', () => {
  withFile('{}', (file, dir) => {
    const marker = join(dir, 'executed.txt');
    const record = structuredClone(example);
    record.producer.executor = 'claimed-admin';
    record.verification.checks[0].command = `node -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "executed")'`;
    record.verification.evidence_refs = ['https://127.0.0.1:1/must-not-be-requested'];
    const contents = JSON.stringify(record);
    writeFileSync(file, contents);
    const nodeArgs = ['--import', new URL('./deny-side-effects.mjs', import.meta.url).href];
    const first = run([file, '--expected-head', head], nodeArgs);
    const second = run([file, '--expected-head', head], nodeArgs);
    assert.equal(first.code, 0);
    assert.equal(first.raw, second.raw);
    assert.equal(readFileSync(file, 'utf8'), contents);
    assert.equal(existsSync(marker), false);
  });
});
