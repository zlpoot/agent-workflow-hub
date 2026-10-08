import { mkdtempSync, realpathSync, lstatSync, writeFileSync, readFileSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { deny } from './security.js';

export interface OfflineFixture { readonly directory: string; readonly fixture_id: string }
const FORMAT = 'awh-onboarding-offline-v1';
// Only ever creates a new temp directory/file; no caller-selected existing DB path.
export function createOfflineFixture(): OfflineFixture {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'awh-onboarding-fixture-')), fixture_id = randomUUID();
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ format: FORMAT, fixture_id }), { flag: 'wx', mode: 0o600 });
  closeSync(openSync(join(directory, 'onboarding-fixture.sqlite'), 'wx', 0o600));
  return Object.freeze({ directory, fixture_id });
}
export function fixtureDatabase(fixture: OfflineFixture): string {
  if (!fixture || Object.keys(fixture).sort().join(',') !== 'directory,fixture_id' || typeof fixture.directory !== 'string' || !/^[a-f0-9-]{36}$/.test(fixture.fixture_id)) deny(500, 'fixture_boundary');
  try {
    if (dirname(fixture.directory) !== realpathSync(tmpdir()) || !/^awh-onboarding-fixture-[A-Za-z0-9]+$/.test(basename(fixture.directory)) ||
        lstatSync(fixture.directory).isSymbolicLink() || realpathSync(fixture.directory) !== fixture.directory) deny(500, 'fixture_boundary');
    const markerPath = join(fixture.directory, 'fixture.json'), path = join(fixture.directory, 'onboarding-fixture.sqlite');
    for (const file of [markerPath,path]) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) deny(500, 'fixture_boundary'); }
    for (const suffix of ['-wal','-shm','-journal']) if (existsSync(path+suffix)) { const stat=lstatSync(path+suffix); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) deny(500,'fixture_boundary'); }
    if (lstatSync(markerPath).size > 1024) deny(500, 'fixture_boundary');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (marker.format !== FORMAT || marker.fixture_id !== fixture.fixture_id || Object.keys(marker).sort().join(',') !== 'fixture_id,format') deny(500, 'fixture_boundary');
    return path;
  } catch { return deny(500, 'fixture_boundary'); }
}
export function destroyOfflineFixture(fixture: OfflineFixture): void {
  fixtureDatabase(fixture); // Resolve and verify the exact temp target before recursive removal.
  rmSync(fixture.directory, { recursive: true, force: true });
}
