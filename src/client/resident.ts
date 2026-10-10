import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AwhClient } from './client.js';
import { ClientError, clientFail, inspectRepository, readConfig, readManifest, readJson } from './local.js';
import { externalPath, externalFilePath } from '../shared/external-files.js';
import { requestJson } from './http.js';
import { safeData } from '../shared/security.js';

// Explicit foreground service. The private control capability remains outside Git;
// its loopback listener cannot register/run tasks or use a browser session.
export interface ResidentStatus { running: boolean; online: boolean; last_seen: string | null; observed_at: string;
  failures: number; code: string | null; authority_verified: false }
interface Lease { schema_version: '1.0'; endpoint: string; capability: string }
function leasePath(configPath: string, cwd: string): string {
  const identity = inspectRepository(cwd), manifest = readManifest(identity), config = readConfig(configPath, identity.root, true);
  externalPath(config.state_directory);
  const binding = createHash('sha256').update(JSON.stringify([manifest.project.id, identity.repository, config.endpoint, config.executor_id])).digest('hex');
  return join(config.state_directory, 'resident-' + binding + '.json');
}
function lease(path: string): Lease {
  externalFilePath(path, 1024);
  const value = readJson(path, 1024, false) as Lease;
  if (!value || Object.keys(value).sort().join(',') !== 'capability,endpoint,schema_version' || value.schema_version !== '1.0' ||
      !/^awh_cp_[A-Za-z0-9_-]{43}$/.test(value.capability) || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value.endpoint) || new URL(value.endpoint).port === '')
    clientFail('resident_state', 'Invalid resident control state; preserve it for local operator inspection');
  return value;
}
export async function residentControl(configPath: string, action: 'status' | 'stop', cwd = process.cwd()) {
  const path = leasePath(configPath, cwd);
  if (!existsSync(path)) return { running: false, online: false, code: 'resident_stopped', authority_verified: false };
  const value = lease(path);
  try {
    const response = await requestJson(value.endpoint, '/' + action, value.capability, action === 'stop' ? 'POST' : 'GET', undefined, undefined, { timeoutMs: 2000, maxBytes: 4096 });
    safeData(response);
    if (action === 'stop') {
      if (Object.keys(response).sort().join(',') !== 'authority_verified,stopping' || response.stopping !== true) throw new Error();
    } else if (Object.keys(response).sort().join(',') !== 'authority_verified,code,failures,last_seen,observed_at,online,running' ||
      typeof response.running !== 'boolean' || typeof response.online !== 'boolean' || !Number.isSafeInteger(response.failures) || Number(response.failures) < 0 ||
      typeof response.observed_at !== 'string' || !Number.isFinite(Date.parse(response.observed_at)) ||
      response.last_seen !== null && (typeof response.last_seen !== 'string' || !Number.isFinite(Date.parse(response.last_seen))) ||
      response.code !== null && (typeof response.code !== 'string' || !/^[a-z_]{1,64}$/.test(response.code))) throw new Error();
    return response;
  }
  catch { return { running: null, online: false, code: 'resident_unreachable', safe_next_step: 'Preserve state; inspect the original resident process and stale lease before restarting.', authority_verified: false }; }
}
export async function startResident(configPath: string, options: { cwd?: string; intervalMs?: number } = {}) {
  const cwd = options.cwd ?? process.cwd(), interval = options.intervalMs ?? 15000;
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 30000) clientFail('resident_interval', 'Resident interval must be between 1000 and 30000 ms');
  const path = leasePath(configPath, cwd), client = new AwhClient(configPath, cwd), binding = client.presenceBinding();
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch { return clientFail('resident_busy', 'Resident lease already exists; use status/stop or request local stale-state inspection'); }
  let closing = false, timer: NodeJS.Timeout | undefined, inFlight: Promise<void> | undefined;
  const capability = 'awh_cp_' + randomBytes(32).toString('base64url'), expected = createHash('sha256').update(capability).digest();
  let state: ResidentStatus = { running: true, online: false, last_seen: null, observed_at: new Date().toISOString(), failures: 0, code: 'heartbeat_pending', authority_verified: false };
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const tick = async () => {
    try { const result = await client.heartbeat(binding); state = { ...state, online: true, last_seen: result.last_seen, code: null }; }
    catch (error) { state = { ...state, online: false, failures: state.failures + 1, code: error instanceof ClientError && ['network','timeout','authentication','response_binding','state','machine'].includes(error.code) ? error.code : 'heartbeat_blocked' }; }
    state.observed_at = new Date().toISOString();
    if (!closing) timer = setTimeout(schedule, interval);
  };
  const schedule = () => { inFlight = tick(); };
  const server = createServer((request, response) => {
    const host = '127.0.0.1:' + (server.address() as { port: number }).port;
    const provided = request.headers.authorization?.slice('Bearer '.length) ?? '';
    const authorized = request.headersDistinct.authorization?.length === 1 && request.headers.authorization?.startsWith('Bearer ') &&
      timingSafeEqual(expected, createHash('sha256').update(provided).digest());
    if (!authorized || request.headers.host !== host || request.headersDistinct.host?.length !== 1 || request.headers.origin !== undefined || request.headers.cookie !== undefined ||
        request.headers['sec-fetch-site'] !== undefined || !['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
      response.writeHead(401); response.end(); return;
    }
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json');
    if (request.url === '/status' && request.method === 'GET') response.end(JSON.stringify(state));
    else if (request.url === '/stop' && request.method === 'POST' && !request.headers['transfer-encoding'] && !Number(request.headers['content-length'] ?? 0)) {
      response.end(JSON.stringify({ stopping: true, authority_verified: false })); void close();
    } else { response.writeHead(404); response.end(JSON.stringify({ authority_verified: false })); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 16;
  const signal = () => { void close(); };
  const close = async () => {
    if (closing) return done;
    closing = true; clearTimeout(timer); process.off('SIGINT', signal); process.off('SIGTERM', signal);
    await inFlight;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    closeSync(fd); unlinkSync(path); state.running = false; state.online = false; finish();
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    writeFileSync(fd, JSON.stringify({ schema_version: '1.0', endpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port, capability }));
    process.once('SIGINT', signal); process.once('SIGTERM', signal); schedule();
    return { done, close, status: () => structuredClone(state) };
  } catch { await close(); return clientFail('resident_start', 'Resident could not start; details suppressed'); }
}
