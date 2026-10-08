import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuthenticator, createControlPlaneServer, ControlPlaneStore, ControlPlaneError, safeData } from './control-plane/index.js';
import type { ProfilePolicy } from './protocol/index.js';
import type { RegisteredClient } from './control-plane/index.js';
import { readHttpsConfig } from './control-plane/tls.js';

export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node dist/control-plane-cli.js --database <sqlite-file> --config <trusted-json-file> [--port <1-65535>] [--https-config <external-json-file>]\nHTTP binds only to 127.0.0.1; optional native HTTPS binds one explicitly configured private IPv4 interface. Both listeners share one store.'); return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--database', '--config', '--port', '--https-config'].includes(key) || options.has(key) || !value || value.startsWith('--'))
      throw new ControlPlaneError(500, 'configuration', 'Invalid Control Plane startup arguments');
    options.set(key, value);
  }
  if (!options.has('--database') || !options.has('--config')) throw new ControlPlaneError(500, 'configuration', 'Database and trusted config file are required');
  const portText = options.get('--port') ?? '4310', port = Number(portText);
  if (!/^[1-9][0-9]{0,4}$/.test(portText) || port > 65535) throw new ControlPlaneError(500, 'configuration', 'Invalid port');
  const raw = readFileSync(resolve(options.get('--config')!));
  if (raw.length > 64 * 1024) throw new ControlPlaneError(500, 'configuration', 'Trusted config exceeds the byte limit');
  const config: unknown = JSON.parse(raw.toString('utf8'));
  safeData(config);
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).sort().join(',') !== 'clients,profiles')
    throw new ControlPlaneError(500, 'configuration', 'Config must contain only clients and profiles');
  const typed = config as { clients: RegisteredClient[]; profiles: ProfilePolicy[] };
  const https = options.has('--https-config') ? readHttpsConfig(options.get('--https-config')!) : null;
  const authenticate = createAuthenticator(typed.clients), store = new ControlPlaneStore(resolve(options.get('--database')!), typed.profiles);
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
  main(process.argv.slice(2)).catch(() => { console.error('Control Plane startup failed; check arguments, trusted config and database (details suppressed)'); process.exitCode = 1; });
}
