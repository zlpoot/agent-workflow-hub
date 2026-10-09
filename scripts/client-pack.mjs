import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CLIENT_PACKAGE, CLIENT_VERSION } from '../dist/client/version.js';
import { npmEntry, npmEnv } from './npm-tool.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url))), args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === '--output', 'Use only --output <directory>');
const output = resolve(args[1] ?? join(root, '.handoff/packages')); mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(output, '.client-stage-'));
try {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
  mkdirSync(join(stage, 'dist/control-plane'), { recursive: true });
  for (const path of ['client','protocol','shared','validator.js','profiles.js','builder.js']) cpSync(join(root, 'dist', path), join(stage, 'dist', path), { recursive: true });
  cpSync(join(root, 'dist/control-plane/security.js'), join(stage, 'dist/control-plane/security.js'));
  if (existsSync(join(root, 'docs/client.md'))) cpSync(join(root, 'docs/client.md'), join(stage, 'README.md'));
  cpSync(join(root, 'docs/doctor.md'), join(stage, 'doctor.md'));
  cpSync(join(root, 'docs/versioned-profile.md'), join(stage, 'versioned-profile.md'));
  const packageJson = { name: CLIENT_PACKAGE, version: CLIENT_VERSION, private: true, type: 'module', engines: { node: '>=24' },
    bin: { awh: 'dist/client/cli.js' }, exports: { '.': './dist/client/index.js' }, files: ['dist', 'doctor.md', 'versioned-profile.md'],
    dependencies: manifest.dependencies, bundledDependencies: Object.keys(manifest.dependencies) };
  writeFileSync(join(stage, 'package.json'), JSON.stringify(packageJson, null, 2));
  const copied = new Map();
  const copyDependency = (name, req) => {
    let path = dirname(req.resolve(name));
    while (!existsSync(join(path, 'package.json')) || JSON.parse(readFileSync(join(path, 'package.json'))).name !== name) {
      const parent = dirname(path); assert.notEqual(parent, path, 'Cannot locate runtime dependency'); path = parent;
    }
    const data = JSON.parse(readFileSync(join(path, 'package.json')));
    if (copied.has(name)) { assert.equal(copied.get(name), data.version, 'Bundled dependency version conflict'); return; }
    copied.set(name, data.version);
    cpSync(realpathSync(path), join(stage, 'node_modules', name), { recursive: true, dereference: true,
      filter: file => !relative(path, file).split(/[\\/]/).includes('node_modules') });
    const childRequire = createRequire(join(path, 'package.json'));
    for (const dependency of Object.keys({ ...data.dependencies, ...data.optionalDependencies })) copyDependency(dependency, childRequire);
  };
  for (const name of Object.keys(manifest.dependencies)) copyDependency(name, createRequire(join(root, 'package.json')));
  const r = spawnSync(process.execPath, [npmEntry(), 'pack', '--json', '--ignore-scripts', '--pack-destination', output], {
    cwd: stage, env: npmEnv(join(stage, '.cache')), encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  assert(!r.error && r.status === 0, 'Local npm pack failed (diagnostics suppressed)');
  const [packed] = JSON.parse(r.stdout); assert.equal(packed.name, CLIENT_PACKAGE); assert.equal(packed.version, CLIENT_VERSION);
  assert(packed.files.every(f => !/^(?:src|tests|\.handoff|credentials)\//.test(f.path) && !/(?:builder-cli|control-plane-cli|control-plane\/store|control-plane\/server)\.js$/.test(f.path)));
  assert(packed.files.some(f => f.path === 'dist/client/doctor.js') && packed.files.some(f => f.path === 'doctor.md'), 'Doctor runtime and manual guide must ship together');
  const archive = join(output, packed.filename); assert.equal(dirname(archive), output);
  console.log(JSON.stringify({ package: CLIENT_PACKAGE, version: CLIENT_VERSION, artifact: archive,
    sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), files: packed.files.map(f => f.path), bundled_runtime_dependencies: Object.fromEntries(copied), published_to_registry: false }));
} finally {
  const target = realpathSync(stage), base = realpathSync(output), rel = relative(base, target);
  assert(rel && !rel.startsWith('..') && dirname(target) === base && rel.startsWith('.client-stage-'), 'Refuse cleanup outside generated staging directory');
  rmSync(target, { recursive: true, force: true });
}
