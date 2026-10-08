import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { ControlPlaneStore } from '../dist/control-plane/store.js';
import { dashboardRoute } from '../dist/dashboard/routes.js';
import { createViewerAuthenticator } from '../dist/dashboard/security.js';
import { dashboardHeaders } from '../dist/dashboard/gateway.js';

// Fixture-only loopback preview. No DB/config/path/credential/provider inputs are accepted.
if (process.argv.length !== 2) throw new Error('Fixture preview takes no arguments');
const fixtures = ['future-ui', 'webskill'].map(name => JSON.parse(readFileSync(`examples/protocol/${name}.json`, 'utf8')));
const store = new ControlPlaneStore(':memory:', fixtures.map(f => f.profile_policy));
for (const [i, f] of fixtures.entries()) {
  const principal = { id: 'fixture-' + i, project_ids: [f.project.id], executor_ids: [f.executor.id] };
  store.registerProject(principal, f.manifest); store.registerExecutor(principal, f.executor,
    { schema_version: '1.0', executor_type: 'codex', machine_name: i ? 'mac-fixture' : 'windows-fixture', arch: i ? 'arm64' : 'x64', client_version: '0.1.0' });
  store.registerWorkItem(principal, f.work_item); store.createRun(principal, f.run);
  const append = (sequence, type, data) => store.append(principal, f.run.id, { schema_version: '1.0', kind: 'event', id: `fixture-${i}-${sequence}`,
    run_id: f.run.id, sequence, type, occurred_at: new Date(Date.now() - (10 - sequence) * 1000).toISOString(), payload: { schema_version: '1.0', data, extensions: {} } });
  append(1, 'RUN_STARTED', { source_sha: f.run.source.sha }); append(2, 'STEP_STARTED', { step_id: 'verify', name: 'Verify contract' });
  if (!i) append(3, 'RUN_FAILED', { reason: 'Synthetic failure for read-only preview' });
}
const cookie = randomBytes(32).toString('base64url');
const authenticate = createViewerAuthenticator([{ id: 'fixture-viewer', project_ids: fixtures.map(f => f.project.id),
  session_sha256: createHash('sha256').update(cookie).digest('hex'), expires_at: new Date(Date.now() + 3600000).toISOString() }]);
const files = new Map([['/dashboard', ['text/html', readFileSync('dist/dashboard-ui/index.html', 'utf8').replace('<title>', '<meta name="awh-dataset" content="fixture"><title>')]],
  ['/dashboard/app.js', ['text/javascript', readFileSync('dist/dashboard-ui/app.js')]], ['/dashboard/app.css', ['text/css', readFileSync('dist/dashboard-ui/app.css')]]]);
const streams = new Set();
const server = createServer((request, response) => {
  for (const [key, value] of Object.entries(dashboardHeaders)) response.setHeader(key, value);
  const host = `127.0.0.1:${request.socket.localPort}`;
  if (request.headers.host !== host || request.headers.authorization || (request.headers.origin && request.headers.origin !== `http://${host}`) ||
      (request.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(request.headers['sec-fetch-site']))) { response.writeHead(403); response.end(); return; }
  try {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname.startsWith('/dashboard/v1/')) { dashboardRoute(request, response, url, { store, authenticate, streams, interval: 250 }); return; }
    const file = files.get(url.pathname);
    if (request.method !== 'GET' || !file || url.search) { response.writeHead(404); response.end(); return; }
    if (url.pathname === '/dashboard') response.setHeader('Set-Cookie', `awh_viewer=${cookie}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=3600`);
    else if (!authenticate(request)) { response.writeHead(401); response.end(); return; }
    response.setHeader('Content-Type', file[0]); response.end(file[1]);
  } catch { if (response.headersSent) response.destroy(); else { response.writeHead(400); response.end(); } }
});
server.listen(0, '127.0.0.1', () => console.log(`Fixture preview: http://127.0.0.1:${server.address().port}/dashboard (synthetic only; expires in one hour)`));
const stop = () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); server.close(() => { store.close(); process.exit(0); }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
setTimeout(stop, 3600000).unref();
