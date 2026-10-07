import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuthenticator, createControlPlaneServer, ControlPlaneStore, ControlPlaneError, safeData } from './control-plane/index.js';
import type { ProfilePolicy } from './protocol/index.js';
import type { RegisteredClient } from './control-plane/index.js';

export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node dist/control-plane-cli.js --database <sqlite-file> --config <trusted-json-file> [--port <1-65535>]\nBinds to 127.0.0.1. Config contains clients (token hashes/scopes) and trusted Profile policies.'); return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--database', '--config', '--port'].includes(key) || options.has(key) || !value || value.startsWith('--'))
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
  const authenticate = createAuthenticator(typed.clients), store = new ControlPlaneStore(resolve(options.get('--database')!), typed.profiles);
  const service = createControlPlaneServer({ store, authenticate });
  try {
    await new Promise<void>((resolveListen, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolveListen); });
  } catch (error) { store.close(); throw error; }
  console.log(`AWH Control Plane listening at http://127.0.0.1:${port}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true;
    void service.close().then(() => store.close()).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Control Plane startup failed; check arguments, trusted config and database (details suppressed)'); process.exitCode = 1; });
}
