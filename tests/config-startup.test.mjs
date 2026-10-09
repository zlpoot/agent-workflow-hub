import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readRuntimeConfig, readTrustedConfig } from '../dist/control-plane/config.js';
import { validateExistingDatabase } from '../dist/control-plane/store.js';
import { readExternalFile, externalPath } from '../dist/shared/external-files.js';
import { safeData, ControlPlaneError } from '../dist/shared/security.js';
import * as legacy from '../dist/control-plane/security.js';
const policy = JSON.parse(readFileSync(new URL('../examples/protocol/webskill.json', import.meta.url))).profile_policy;
const cli = new URL('../dist/control-plane-cli.js', import.meta.url);
const token = 'awh_cp_' + 'F'.repeat(43); // Disposable offline credential; never real material.
const trusted = { clients: [{ id: 'scratch-client', project_ids: ['webskill'], executor_ids: ['scratch-executor'], token_sha256: createHash('sha256').update(token).digest('hex') }], profiles: [policy] };
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'awh-issue47-'));
  t.after(() => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert(dir.startsWith(join(tmpdir(), 'awh-issue47-'))); rmSync(dir, { recursive: true, force: true }); });
  const config = join(dir, 'trusted.json'), database = join(dir, 'scratch.sqlite'), runtime = join(dir, 'runtime.json');
  writeFileSync(config, JSON.stringify(trusted));
  const data = { schema_version: '1.0', database, trusted_config_file: config, port: 4310 };
  const put = value => writeFileSync(runtime, JSON.stringify(value)); put(data);
  const run = args => spawnSync(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { dir, config, database, runtime, data, put, run };
}
test('documented config examples follow closed schemas; unknown fields fail', () => {
  const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
  ajv.addSchema(JSON.parse(readFileSync(new URL('../src/protocol/schema.json', import.meta.url))));
  for (const name of ['cp-runtime','cp-trusted','client','https','viewer-sessions']) {
    const schema = JSON.parse(readFileSync(new URL(`../config/schemas/${name}.schema.json`, import.meta.url))), validate = ajv.compile(schema);
    const sample = JSON.parse(readFileSync(new URL(`../config/examples/${name}.json`, import.meta.url)));
    assert(validate(sample), JSON.stringify(validate.errors));
    const bad = Array.isArray(sample) ? [{ ...sample[0], unexpected: true }] : { ...sample, unexpected: true };
    assert.equal(validate(bad), false);
  }
});
test('runtime and trusted parsing reject source/field/version/path conflicts before DB creation', t => {
  const h = scratch(t); assert.deepEqual(readRuntimeConfig(h.runtime), h.data); assert.deepEqual(readTrustedConfig(h.config), trusted);
  for (const change of [{ schema_version: '2.0' }, { unexpected: true }, { port: '4310' }, { port: 0 }, { database: 'relative.sqlite' }, { database: h.dir + '/child/../escape.sqlite' }, { https_config_file: '' }]) {
    h.put({ ...h.data, ...change }); assert.throws(() => readRuntimeConfig(h.runtime)); assert(!existsSync(h.database));
  }
  h.put(h.data);
  const conflict = h.run(['init','--runtime-config',h.runtime,'--port','4310']); assert.equal(conflict.status, 1); assert(!existsSync(h.database));
  for (const config of [{ ...trusted, schema_version: '1.0' }, { ...trusted, profiles: [policy, policy] }, { ...trusted, clients: [...trusted.clients, ...trusted.clients] }]) {
    writeFileSync(h.config, JSON.stringify(config)); assert.throws(() => readTrustedConfig(h.config));
  }
});
test('explicit init is exclusive; normal startup rejects missing/empty/wrong DB without creating or migrating', t => {
  const h = scratch(t);
  const args = ['--runtime-config', h.runtime];
  assert.equal(h.run(args).status, 1); assert(!existsSync(h.database));
  writeFileSync(h.database, ''); assert.equal(h.run(args).status, 1); assert.equal(readFileSync(h.database).length, 0);
  const wrong = new DatabaseSync(h.database); wrong.exec('PRAGMA user_version=1; CREATE TABLE unrelated(id TEXT);'); wrong.close();
  const before = readFileSync(h.database); assert.equal(h.run(args).status, 1); assert(readFileSync(h.database).equals(before));
  const other = join(h.dir, 'new.sqlite'); h.put({ ...h.data, database: other });
  const init = h.run(['init', ...args]); assert.equal(init.status, 0, init.stderr); assert.match(init.stdout, /initialized/); assert(!init.stdout.includes('listening'));
  const bytes = readFileSync(other); assert.equal(h.run(['init', ...args]).status, 1); assert(readFileSync(other).equals(bytes));
  assert.equal(validateExistingDatabase(other, [policy]), other);
  const changed = { ...policy, version: 'different-version' }; assert.throws(() => validateExistingDatabase(other, [changed])); assert(readFileSync(other).equals(bytes));
  const fake = new DatabaseSync(h.database); fake.exec('PRAGMA user_version=2'); fake.close();
  assert.throws(() => validateExistingDatabase(h.database, [policy]));
});
test('deployment files reject repositories, parent junctions/symlinks, directories and oversize bytes', t => {
  const h = scratch(t); assert(readExternalFile(h.config, 65536).length);
  assert.throws(() => readExternalFile(h.config, 2)); assert.throws(() => readExternalFile(h.dir, 65536));
  const linked = join(h.dir, 'linked'), target = join(h.dir, 'target'); mkdirSync(target); writeFileSync(join(target, 'config.json'), '{}');
  symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readExternalFile(join(linked, 'config.json'), 65536)); assert.throws(() => externalPath(join(linked, 'new.sqlite'), true));
  writeFileSync(join(h.dir, '.git'), 'fixture'); assert.throws(() => readExternalFile(h.config, 65536)); assert.throws(() => externalPath(h.database, true));
});
test('scratch CLI init → serve → authenticated query and restart preserves existing v2 and old flag contract', async t => {
  const h = scratch(t), portServer = createServer(); await new Promise(r => portServer.listen(0, '127.0.0.1', r));
  const port = portServer.address().port; await new Promise(r => portServer.close(r)); h.put({ ...h.data, port });
  const init = h.run(['init','--runtime-config',h.runtime]); assert.equal(init.status, 0, init.stderr);
  const start = async args => {
    const child = spawn(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), ...args], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', errors = ''; child.stderr.on('data', x => errors += x); const exit = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null) { child.kill(); await exit; } });
    let timer;
    try { await Promise.race([new Promise(r => child.stdout.on('data', x => { output += x; if (output.includes('listening')) r(); })), exit.then(() => { throw new Error('Scratch CLI exited before listening: ' + errors); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Scratch startup timed out')), 10000); })]); }
    finally { clearTimeout(timer); }
    return { child, exit };
  };
  for (const args of [['serve','--runtime-config',h.runtime], ['--database',h.database,'--config',h.config,'--port',String(port)]]) {
    const service = await start(args), response = await fetch(`http://127.0.0.1:${port}/v1/projects`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.authority_verified, false); assert.deepEqual(body.projects, []);
    service.child.kill(); await service.exit;
  }
  assert.equal(validateExistingDatabase(h.database, [policy]), h.database);
});
test('shared security retains the old Error class and exported validation functions', () => {
  assert.equal(legacy.ControlPlaneError, ControlPlaneError); assert.equal(legacy.safeData, safeData);
  assert.throws(() => safeData({ token: 'offline' }), e => e instanceof legacy.ControlPlaneError && e.code === 'credential_data');
});
test('Client config flag cannot silently override a different environment source', () => {
  const result = spawnSync(process.execPath, ['dist/client/cli.js','--config','/different.json','status'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AWH_CLIENT_CONFIG: '/original.json' } });
  assert.equal(result.status, 2); assert.match(result.stderr, /configuration/); assert(!result.stderr.includes('/original.json'));
});
