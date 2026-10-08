import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { TextDecoder } from 'node:util';
import { ProtocolError } from '../protocol/index.js';
import { ControlPlaneStore } from './store.js';
import { ControlPlaneError, fail, MAX_BODY_BYTES, safeData, validId, type Authenticate, type Principal } from './security.js';
import { dashboardRoute } from '../dashboard/routes.js';
import type { AuthenticateViewer } from '../dashboard/security.js';

export interface ServerOptions { store: ControlPlaneStore; authenticate: Authenticate; poll_interval_ms?: number; tls?: { cert: Buffer; key: Buffer };
  dashboard?: { authenticate: AuthenticateViewer; now?: () => number } }
function number(value: string | null, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null) return 0;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
    fail(400, 'invalid_cursor', 'Invalid pagination or stream cursor');
  return Number(value);
}
function query(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
    fail(400, 'invalid_query', 'Unsupported or repeated query parameter');
}
function reply(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(status === 401 && (data as { error?: { code?: string } })?.error?.code === 'unauthorized' ? { 'WWW-Authenticate': 'Bearer' } : {}),
    ...(status >= 400 ? { Connection: 'close' } : {}) });
  response.end(JSON.stringify(data));
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headersDistinct['content-type']?.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? ''))
    fail(415, 'content_type', 'Request body must be application/json');
  if (request.headers['content-encoding']) fail(415, 'content_encoding', 'Encoded request bodies are unsupported');
  if (request.headers['content-length'] && number(request.headers['content-length']) > MAX_BODY_BYTES)
    fail(413, 'body_too_large', 'Request body exceeds the byte limit');
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { clearTimeout(timeout); request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', abort); };
    const error = () => { cleanup(); reject(new ControlPlaneError(400, 'invalid_body', 'Request body could not be read')); };
    const abort = () => error();
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { cleanup(); request.pause(); reject(new ControlPlaneError(413, 'body_too_large', 'Request body exceeds the byte limit')); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const timeout = setTimeout(() => { cleanup(); request.pause(); reject(new ControlPlaneError(408, 'body_timeout', 'Request body timed out')); }, 5000);
    timeout.unref();
    request.on('data', data).once('end', end).once('error', error).once('aborted', abort);
  });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { return fail(400, 'invalid_json', 'Request body must contain valid UTF-8 JSON'); }
  safeData(value); return value;
}

// No GitHub client, shell, local project scan or command execution is reachable from HTTP.
export function createControlPlaneServer(options: ServerOptions) {
  const { store, authenticate } = options, interval = options.poll_interval_ms ?? 250;
  if (!Number.isInteger(interval) || interval < 20 || interval > 5000) fail(500, 'configuration', 'Invalid SSE poll interval');
  const streams = new Set<ServerResponse>();
  const openStream = (request: IncomingMessage, response: ServerResponse, principal: Principal, url: URL) => {
    query(url, ['after']);
    if (url.searchParams.has('after') && request.headers['last-event-id']) fail(400, 'invalid_cursor', 'Choose one stream cursor');
    if ((request.headersDistinct['last-event-id']?.length ?? 0) > 1) fail(400, 'invalid_cursor', 'Repeated stream cursor');
    let cursor = number(request.headersDistinct['last-event-id']?.[0] ?? url.searchParams.get('after'));
    if (cursor > store.latestCursor()) fail(400, 'invalid_cursor', 'Stream cursor is ahead of the Event Store');
    if (streams.size >= 64) fail(503, 'stream_limit', 'SSE connection limit reached');
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    response.setTimeout(0); response.flushHeaders(); response.write(': connected\n\n'); streams.add(response);
    let lastHeartbeat = Date.now();
    const poll = () => {
      if (response.destroyed || response.writableEnded || response.writableNeedDrain) return;
      try {
        for (const entry of store.streamEvents(principal, cursor, 100)) {
          const frame = `id: ${entry.cursor}\nevent: run-event\ndata: ${JSON.stringify({ ...entry, authority_verified: false })}\n\n`;
          const drained = response.write(frame);
          cursor = entry.cursor;
          if (response.writableLength > 128 * 1024) { response.destroy(); break; }
          if (!drained) break;
        }
        if (Date.now() - lastHeartbeat >= 15000 && !response.destroyed && !response.writableNeedDrain) {
          response.write(': heartbeat\n\n'); lastHeartbeat = Date.now();
        }
      } catch { response.destroy(); }
    };
    const timer = setInterval(poll, interval); timer.unref();
    response.once('close', () => { clearInterval(timer); streams.delete(response); });
    poll();
  };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 2048) fail(400, 'invalid_route', 'Invalid request target');
      const url = new URL(request.url, 'http://control-plane.invalid');
      if (url.pathname === '/dashboard/v1' || url.pathname.startsWith('/dashboard/v1/')) {
        if (!options.dashboard) fail(404, 'not_found', 'Dashboard read gateway is not enabled');
        dashboardRoute(request, response, url, { store, authenticate: options.dashboard.authenticate, now: options.dashboard.now, streams, interval }); return;
      }
      const principal = authenticate(request);
      if (!principal) fail(401, 'unauthorized', 'A registered Control Plane client credential is required');
      const method = request.method;
      if (method === 'GET' && url.pathname === '/v1/events/stream') { openStream(request, response, principal, url); return; }
      const match = /^\/v1\/(projects|executors|work-items|runs)\/([^/]+)(?:\/(heartbeat|events))?$/.exec(url.pathname);
      const id = match?.[2];
      if (id && id !== 'register' && !validId(id)) fail(400, 'invalid_id', 'Invalid Registry ID');
      let result: unknown, status = 200;
      if (method === 'POST') {
        query(url, []);
        // Check the closed route set before consuming or interpreting body data.
        if (!['/v1/projects/register', '/v1/executors/register', '/v1/work-items/register', '/v1/runs'].includes(url.pathname) &&
            !(match?.[1] === 'executors' && match[3] === 'heartbeat') && !(match?.[1] === 'runs' && match[3] === 'events'))
          fail(404, 'not_found', 'Endpoint was not found');
        const value = await body(request);
        if (url.pathname === '/v1/projects/register') result = store.registerProject(principal, value);
        else if (url.pathname === '/v1/executors/register') {
          if (value && typeof value === 'object' && Object.hasOwn(value, 'executor')) {
            if (Object.keys(value).sort().join(',') !== 'client,executor') fail(400, 'registration', 'Invalid Client registration envelope');
            const envelope = value as { executor: unknown; client: unknown };
            result = store.registerExecutor(principal, envelope.executor, envelope.client);
          } else result = store.registerExecutor(principal, value);
        }
        else if (url.pathname === '/v1/work-items/register') result = store.registerWorkItem(principal, value);
        else if (url.pathname === '/v1/runs') result = store.createRun(principal, value);
        else if (match?.[1] === 'executors' && match[3] === 'heartbeat') {
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0)
            fail(400, 'heartbeat_body', 'Heartbeat body must be an empty object');
          result = store.heartbeat(principal, id!);
        } else {
          if (request.headers['idempotency-key'] !== undefined && (request.headersDistinct['idempotency-key']?.length !== 1 ||
              request.headers['idempotency-key'] !== (value as { id?: unknown })?.id))
            fail(400, 'idempotency_key', 'Idempotency-Key must match the Event ID');
          result = store.append(principal, id!, value);
        }
        if (['created', 'appended'].includes((result as { disposition?: string }).disposition ?? '')) status = 201;
      } else if (method === 'GET') {
        if (url.pathname === '/v1/profiles') {
          query(url, ['project_id']); const projectId = url.searchParams.get('project_id');
          if (!validId(projectId)) fail(400, 'invalid_id', 'A project_id is required');
          result = { profiles: store.listProfiles(principal, projectId) };
        } else if (url.pathname === '/v1/runs') {
          query(url, ['project_id']); const projectId = url.searchParams.get('project_id');
          if (!validId(projectId)) fail(400, 'invalid_id', 'A project_id is required');
          result = { runs: store.listRuns(principal, projectId) };
        } else if (match?.[1] === 'runs' && match[3] === 'events') {
          query(url, ['after', 'limit']); const after = number(url.searchParams.get('after'));
          const limit = url.searchParams.has('limit') ? number(url.searchParams.get('limit'), 100) : 100;
          if (limit < 1) fail(400, 'invalid_cursor', 'Page limit must be between one and 100');
          result = { events: store.listEvents(principal, id!, after, limit) };
        } else {
          query(url, []);
          if (url.pathname === '/v1/projects') result = { projects: store.listProjects(principal) };
          else if (url.pathname === '/v1/executors') result = { executors: store.listExecutors(principal) };
          else if (match && !match[3]) {
            if (match[1] === 'projects') result = { project: store.getProject(principal, id!) };
            else if (match[1] === 'work-items') result = { work_item: store.getWorkItem(principal, id!) };
            else if (match[1] === 'runs') result = { run: store.getRun(principal, id!) };
            else fail(404, 'not_found', 'Endpoint was not found');
          } else fail(404, 'not_found', 'Endpoint was not found');
        }
      } else fail(405, 'method_not_allowed', 'Method is unsupported');
      reply(response, status, { ...(result as object), authority_verified: false });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof ControlPlaneError) reply(response, error.status, { error: { code: error.code, message: error.message }, authority_verified: false });
      else if (error instanceof ProtocolError) reply(response, error.code === 'schema' ? 400 : 409,
        { error: { code: error.code, message: error.message }, authority_verified: false });
      else if ((error as { errcode?: number })?.errcode === 5) reply(response, 503, { error: { code: 'busy', message: 'Event Store is busy; retry the same Event' }, authority_verified: false });
      else reply(response, 500, { error: { code: 'internal', message: 'Control Plane request failed' }, authority_verified: false });
    } finally {
      if (!request.complete && response.headersSent && !streams.has(response)) {
        // Drain without buffering; destroying here can reset the socket before the error response arrives.
        request.resume();
      }
    }
  };
  const limits = { maxHeaderSize: 16 * 1024, headersTimeout: 10000, requestTimeout: 15000 };
  const listener = (request: IncomingMessage, response: ServerResponse) => { void handler(request, response); };
  const server = options.tls ? createHttpsServer({ ...limits, ...options.tls, minVersion: 'TLSv1.2' }, listener) : createServer(limits, listener);
  server.maxHeadersCount = 64;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return { server, close: async () => {
    for (const stream of streams) stream.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close(error => { if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve(); }); server.closeAllConnections();
    });
  } };
}
