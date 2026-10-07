// Preload only into the tested CLI child, so forbidden actions fail the test.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('Forbidden side effect'); };
globalThis.fetch = denied;
for (const module of [http, https]) for (const key of ['request', 'get']) module[key] = denied;
for (const module of [net, tls]) module.connect = denied;
net.createConnection = denied;
for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) cp[key] = denied;
for (const key of ['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'mkdir', 'truncate', 'chmod']) {
  fs[key] = denied;
  fs[key + 'Sync'] = denied;
  fsp[key] = denied;
}
syncBuiltinESMExports();
