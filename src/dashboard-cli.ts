#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readExternalFile, externalFilePath } from './shared/external-files.js';
import { ControlPlaneError, fail, safeData, validId } from './shared/security.js';
import { DashboardReadStore } from './control-plane/store.js';
import { createDashboardGateway } from './dashboard/gateway.js';
import { createLocalOnboarding, type LocalBinding } from './dashboard/onboarding.js';
import { createEnrollmentService } from './dashboard/enrollment.js';
import { readMachineConfig } from './client/enrollment.js';

interface ViewerConfig { schema_version: '1.0'; mode: 'local_browser_direct'; database: string; port: number; viewer: { id: string; project_ids: string[] }; local_bindings: LocalBinding[]; machine_config_file?: string }
export function readViewerConfig(path: string): ViewerConfig {
  let c: ViewerConfig;
  try { c = JSON.parse(readExternalFile(path, 64 * 1024).toString('utf8')); safeData(c); } catch { return fail(500, 'configuration', 'Invalid external viewer configuration (contents suppressed)'); }
  if (!c || !['database,local_bindings,mode,port,schema_version,viewer','database,local_bindings,machine_config_file,mode,port,schema_version,viewer'].includes(Object.keys(c).sort().join(',')) || c.schema_version !== '1.0' || c.mode !== 'local_browser_direct' ||
      !Number.isSafeInteger(c.port) || c.port < 1 || c.port > 65535 || !c.viewer || Object.keys(c.viewer).sort().join(',') !== 'id,project_ids' ||
      !validId(c.viewer.id) || !Array.isArray(c.viewer.project_ids) || !c.viewer.project_ids.length && !c.machine_config_file || c.viewer.project_ids.length > 64 ||
      !c.viewer.project_ids.every(validId) || new Set(c.viewer.project_ids).size !== c.viewer.project_ids.length || !Array.isArray(c.local_bindings) ||
      c.local_bindings.some(b => !c.viewer.project_ids.includes(b.project_id))) fail(500, 'configuration', 'Invalid viewer scope or deployment parameters');
  if (c.machine_config_file) readMachineConfig(c.machine_config_file);
  externalFilePath(c.database); createLocalOnboarding(c.local_bindings); return c;
}
export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--help') return console.log('awh-viewer --config <absolute-external-json-file>\nExplicit IPv4 loopback OS-user viewer, existing CP v2 read-only database, scoped browser cookie and opt-in offline installed-Client diagnosis. Ctrl+C stops the viewer.');
  if (args.length !== 2 || args[0] !== '--config') fail(500, 'configuration', 'Viewer requires exactly one explicit external configuration');
  const c = readViewerConfig(args[1]!), enrollment = c.machine_config_file ? createEnrollmentService(c.machine_config_file) : undefined;
  for (const b of enrollment?.bindings() ?? []) if (!c.viewer.project_ids.includes(b.project_id)) c.viewer.project_ids.push(b.project_id);
  const store = new DashboardReadStore(c.database, () => enrollment?.bindings() ?? []);
  // Assets are relative to the installed product, never an editable config path.
  const assets = join(dirname(fileURLToPath(import.meta.url)), 'dashboard-ui');
  readFileSync(join(assets, 'index.html'));
  const gateway = createDashboardGateway({ enabled: true, store, assets, localBrowserViewer: c.viewer, onboarding: createLocalOnboarding(c.local_bindings), enrollment });
  try { await new Promise<void>((resolve, reject) => { gateway.server.once('error', reject); gateway.server.listen(c.port, '127.0.0.1', resolve); }); }
  catch { await gateway.close(); store.close(); return fail(500, 'viewer_start', 'Viewer port unavailable; preserve the existing listener'); }
  console.log(JSON.stringify({ url: `http://127.0.0.1:${c.port}/dashboard`, access: 'explicit_local_os_user', expires_in_seconds: 3600, database: 'existing_v2_readonly', authority_verified: false }));
  await new Promise<void>(resolve => {
    const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void gateway.close().finally(() => { store.close(); resolve(); }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: { code: error instanceof ControlPlaneError ? error.code : 'viewer', message: 'Viewer operation failed; configuration and local diagnostics suppressed' }, authority_verified: false })); process.exitCode = 2;
});
