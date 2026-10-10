import { closeSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuthenticator, createControlPlaneServer, ControlPlaneStore, ControlPlaneError } from './control-plane/index.js';
import { readHttpsConfig } from './control-plane/tls.js';
import { readRuntimeConfig, readTrustedConfig } from './control-plane/config.js';
import { externalPath, externalFilePath } from './shared/external-files.js';
import { approveEnrollment } from './control-plane/enrollment.js';

export async function main(args: string[]): Promise<void> {
  if (args[0] === 'approve-project') {
    const entries = new Map<string,string>();
    for (let i = 1; i < args.length; i++) {
      const key = args[i]!;
      if (!['--request','--config','--database','--policy-trust','--confirm'].includes(key) || entries.has(key)) throw new ControlPlaneError(400,'arguments','Invalid approval arguments');
      if (key === '--confirm') { entries.set(key,'true'); continue; }
      const value = args[++i]; if (!value || value.startsWith('--')) throw new ControlPlaneError(400,'arguments','Missing approval argument'); entries.set(key,value);
    }
    if (!['--request','--config','--database'].every(k => entries.has(k))) throw new ControlPlaneError(400,'arguments','Explicit request, trust and database required');
    console.log(JSON.stringify(approveEnrollment({ request: entries.get('--request')!, trustedConfig: entries.get('--config')!, database: entries.get('--database')!, confirm: entries.has('--confirm'), policyTrust: entries.get('--policy-trust') }))); return;
  }
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node dist/control-plane-cli.js [init|serve] --runtime-config <external-json-file>\nLocal CP-owner approval: approve-project --request <external-request> --database <existing-v2.sqlite> --config <external-trusted-file> [--policy-trust <external-anchor>] [--confirm]\nLegacy arguments: [init|serve] --database <external-sqlite-file> --config <external-trusted-json-file> [--port <1-65535>] [--https-config <external-json-file>]\nNormal startup requires an existing CP v2 database. init exclusively creates a new database and exits. HTTP binds only to 127.0.0.1; optional native HTTPS uses an explicit private IPv4 interface.'); return;
  }
  const mode = args[0] === 'init' ? 'init' : 'serve';
  if (args[0] === 'init' || args[0] === 'serve') args = args.slice(1);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--database', '--config', '--port', '--https-config', '--runtime-config'].includes(key) || options.has(key) || !value || value.startsWith('--'))
      throw new ControlPlaneError(500, 'configuration', 'Invalid Control Plane startup arguments');
    options.set(key, value);
  }
  if (options.has('--runtime-config')) {
    if (options.size !== 1) throw new ControlPlaneError(500, 'configuration', 'Deployment configuration cannot be overridden by legacy arguments');
    const config = readRuntimeConfig(options.get('--runtime-config')!);
    options.clear(); options.set('--database', config.database); options.set('--config', config.trusted_config_file); options.set('--port', String(config.port));
    if (config.https_config_file) options.set('--https-config', config.https_config_file);
  }
  if (!options.has('--database') || !options.has('--config')) throw new ControlPlaneError(500, 'configuration', 'Database and trusted config file are required');
  const portText = options.get('--port') ?? '4310', port = Number(portText);
  if (!/^[1-9][0-9]{0,4}$/.test(portText) || port > 65535) throw new ControlPlaneError(500, 'configuration', 'Invalid port');
  const typed = readTrustedConfig(options.get('--config')!);
  const https = options.has('--https-config') ? readHttpsConfig(options.get('--https-config')!) : null;
  let current = typed;
  // Operator-owned snapshot is revalidated before use; no network reload or approval API.
  const authenticate: ReturnType<typeof createAuthenticator> = request => {
    try { const next = readTrustedConfig(options.get('--config')!); validateSnapshot(next); current = next; return createAuthenticator(next.clients, next.enrollments)(request); }
    catch { return null; }
  };
  const validateSnapshot = (next: typeof typed) => {
    if (JSON.stringify(next.profiles) !== JSON.stringify(typed.profiles)) throw new ControlPlaneError(409,'profile_conflict','Workflow policies cannot change during enrollment');
  };
  const path = mode === 'init' ? externalPath(options.get('--database')!, true) : externalFilePath(options.get('--database')!);
  if (mode === 'init') {
    // Exclusive reservation: never overwrite an existing file. Retain failed initialization for inspection.
    const fd = openSync(path, 'wx', 0o600); closeSync(fd);
    const store = new ControlPlaneStore(path, typed.profiles); store.close();
    console.log('AWH Control Plane database initialized (v2); no listener started'); return;
  }
  const store = new ControlPlaneStore(path, typed.profiles, undefined, 'existing', () => current.enrollments);
  const service = createControlPlaneServer({ store, authenticate });
  const secure = https ? createControlPlaneServer({ store, authenticate, tls: https.tls }) : null;
  const services = secure ? [service, secure] : [service];
  try {
    await new Promise<void>((resolveListen, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolveListen); });
    if (secure && https) await new Promise<void>((resolveListen, reject) => { secure.server.once('error', reject); secure.server.listen(https.port, https.host, resolveListen); });
  } catch (error) { await Promise.allSettled(services.map(s => s.close())); store.close(); throw error; }
  console.log(`AWH Control Plane listening at http://127.0.0.1:${port}`);
  if (https) console.log(`AWH Control Plane listening at https://${https.host}:${https.port}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true;
    void Promise.allSettled(services.map(s => s.close())).then(results => { store.close(); if (results.some(r => r.status === 'rejected')) process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Control Plane startup failed; check arguments, external configuration and existing database (details suppressed)'); process.exitCode = 1; });
}
