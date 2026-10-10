#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DashboardReadStore } from './control-plane/store.js';
import { createDashboardGateway } from './dashboard/gateway.js';
import { createViewerAuthenticator } from './dashboard/security.js';
import { createSessionProvisioner } from './dashboard/session-host.js';
import { readExternalFile, externalPath, externalFilePath } from './shared/external-files.js';
import { fail, safeData } from './shared/security.js';
import { RELEASE_VERSION } from './release/version.js';

export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { console.log('awh-viewer --enable --config <absolute-external-json>\nDefault OFF. Config: schema_version=1.0, database (existing v2), sessions_file (pre-provisioned digest registry), assets (matching extracted UI directory), port. Read-only exact IPv4 loopback. Explicit POST /dashboard/session exchanges an existing opaque secret; no anonymous issuer.'); return; }
  if (args.length === 1 && args[0] === '--version') { console.log(RELEASE_VERSION); return; }
  if (args.length !== 3 || args[0] !== '--enable' || args[1] !== '--config' || !args[2]) fail(500, 'configuration', 'Viewer defaults OFF; explicit enable and external configuration required');
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExternalFile(args[2], 16384))); safeData(config);
  if (!config || Array.isArray(config) || Object.keys(config).sort().join(',') !== 'assets,database,port,schema_version,sessions_file' || config.schema_version !== '1.0' ||
      !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) fail(500, 'configuration', 'Invalid closed Viewer configuration');
  const database = externalFilePath(config.database), assets = externalPath(config.assets);
  const sessions = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExternalFile(config.sessions_file, 65536, true)));
  const authenticate = createViewerAuthenticator(sessions), provision = createSessionProvisioner(sessions);
  const embedded = JSON.parse(readFileSync(new URL('../awh-build.json', import.meta.url), 'utf8'));
  const ui = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExternalFile(join(assets, 'awh-build.json'), 65536)));
  if (embedded.kind !== 'awh_build' || ui.kind !== 'awh_build' || embedded.schema_version !== '1.0' || ui.schema_version !== '1.0' ||
      embedded.component !== 'awh-viewer' || ui.component !== 'awh-dashboard-ui' || ui.target !== 'static' ||
      ui.version !== RELEASE_VERSION || embedded.version !== RELEASE_VERSION || !/^[a-f0-9]{40}$/.test(embedded.source_commit) || ui.source_commit !== embedded.source_commit ||
      ui.provenance['contracts/dashboard-v1.openapi.json'] !== embedded.provenance['contracts/dashboard-v1.openapi.json'])
    fail(500, 'configuration', 'Viewer/UI source or contract mismatch');
  for (const file of ['index.html','app.js','app.css']) {
    const digest = createHash('sha256').update(readExternalFile(join(assets, file), 16 * 1024 * 1024)).digest('hex');
    if (ui.files[file] !== digest) fail(500, 'configuration', 'UI asset digest mismatch');
  }
  const store = new DashboardReadStore(database);
  let gateway: ReturnType<typeof createDashboardGateway> | undefined;
  try { const service = createDashboardGateway({ enabled: true, store, authenticate, provision, assets }); gateway = service;
    await new Promise<void>((done, reject) => { service.server.once('error', reject); service.server.listen(config.port, '127.0.0.1', done); });
  } catch (error) { if (gateway) await gateway.close(); store.close(); throw error; }
  console.log(`AWH Viewer listening at http://127.0.0.1:${config.port}/dashboard (read-only)`);
  const service = gateway;
  let closing = false;
  const stop = () => { if (closing) return; closing = true; void service.close().then(() => store.close()).catch(() => { store.close(); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Viewer startup failed; check explicit external configuration, existing v2 DB and matching UI (details suppressed)'); process.exitCode = 1; });
}
