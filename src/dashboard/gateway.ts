import { createServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ControlPlaneError, fail } from '../control-plane/security.js';
import type { DashboardStore } from '../control-plane/store.js';
import type { AuthenticateViewer } from './security.js';
import { dashboardRoute } from './routes.js';
import { localBrowserSession } from './local-browser.js';
import type { Viewer } from './security.js';
import type { createLocalOnboarding } from './onboarding.js';

export interface GatewayOptions { enabled?: boolean; store?: DashboardStore; authenticate?: AuthenticateViewer; assets?: string; now?: () => number;
  localBrowserViewer?: Viewer; onboarding?: ReturnType<typeof createLocalOnboarding> }
export const dashboardHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
};
// Opt-in sidecar only. It neither changes the existing CP nor accepts Client/GitHub credentials.
// The trusted host must provision separate HttpOnly cookies scoped to /dashboard; no public login/token endpoint.
export function createDashboardGateway(options: GatewayOptions = {}) {
  if (options.enabled && (!options.store || (!options.authenticate && !options.localBrowserViewer) || !options.assets) || options.authenticate && options.localBrowserViewer)
    fail(500, 'configuration', 'An explicit read store, one viewer authenticator and built assets are required');
  const local = options.localBrowserViewer ? localBrowserSession(options.localBrowserViewer, options.now) : undefined;
  const authenticate = local?.authenticate ?? options.authenticate!;
  const files = options.enabled ? new Map([
    ['/dashboard', { type: 'text/html; charset=utf-8', body: readFileSync(resolve(options.assets!, 'index.html')) }],
    ['/dashboard/', { type: 'text/html; charset=utf-8', body: readFileSync(resolve(options.assets!, 'index.html')) }],
    ['/dashboard/app.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(resolve(options.assets!, 'app.js')) }],
    ['/dashboard/app.css', { type: 'text/css; charset=utf-8', body: readFileSync(resolve(options.assets!, 'app.css')) }]
  ]) : new Map();
  const streams = new Set<ServerResponse>();
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, async (request, response) => {
    for (const [key, value] of Object.entries(dashboardHeaders)) response.setHeader(key, value);
    try {
      if (!options.enabled) fail(404, 'not_found', 'Dashboard gateway is not enabled');
      const host = `127.0.0.1:${request.socket.localPort}`;
      const loopback = (address?: string) => address === '127.0.0.1' || address === '::ffff:127.0.0.1';
      if (!loopback(request.socket.localAddress) || !loopback(request.socket.remoteAddress) || request.headersDistinct.host?.length !== 1 || request.headers.host !== host ||
        request.headers.authorization !== undefined || (request.headersDistinct.origin?.length ?? 0) > 1 ||
        (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) ||
        (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))))
        fail(401, 'viewer_unauthorized', 'A same-origin loopback viewer session is required');
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 2048 || request.url.includes('\\') || /%2e|%2f|%5c/i.test(request.url))
        fail(400, 'invalid_route', 'Invalid request target');
      const url = new URL(request.url, 'http://dashboard.invalid');
      if (url.pathname.startsWith('/dashboard/onboarding/v1/')) {
        const viewer = authenticate(request);
        if (!viewer) fail(401, 'viewer_unauthorized', 'A separate viewer session is required');
        if (request.method !== 'GET') fail(405, 'read_only', 'Onboarding only performs offline diagnosis');
        if (!options.onboarding || url.search) fail(404, 'not_found', 'Local diagnosis is not configured');
        const path = url.pathname.slice('/dashboard/onboarding/v1/'.length);
        const value = path === 'projects' ? { items: options.onboarding.list(viewer) } : /^doctor\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(path)
          ? { item: await options.onboarding.diagnose(viewer, path.slice(7)) } : fail(404, 'not_found', 'Unknown local diagnosis path');
        // The session may have expired while the local child was running.
        if (!authenticate(request)) fail(401, 'viewer_unauthorized', 'Viewer session expired');
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ ...value, authority_verified: false })); return;
      }
      if (url.pathname.startsWith('/dashboard/v1/')) {
        dashboardRoute(request, response, url, { store: options.store!, authenticate, streams, interval: 250, now: options.now }); return;
      }
      if (!authenticate(request) && !local?.bootstrap(request, response)) fail(401, 'viewer_unauthorized', 'A separate viewer session is required');
      if (request.method !== 'GET') fail(405, 'read_only', 'Dashboard is read-only');
      const file = files.get(url.pathname);
      if (!file || url.search) fail(404, 'not_found', 'Dashboard asset was not found');
      response.writeHead(200, { 'Content-Type': file.type }); response.end(file.body);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof ControlPlaneError ? error.status : 500;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
      response.end(JSON.stringify({ authority_verified: false, error: { code: error instanceof ControlPlaneError ? error.code : 'internal', message: 'Dashboard request unavailable' } }));
    } finally { if (!request.complete && response.headersSent && !streams.has(response)) request.resume(); }
  });
  server.maxHeadersCount = 64;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return { server, close: async () => {
    for (const stream of streams) stream.destroy();
    await new Promise<void>((resolve, reject) => { server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()); server.closeAllConnections(); });
  } };
}
