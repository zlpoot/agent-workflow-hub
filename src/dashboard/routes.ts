import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail, validId } from '../control-plane/security.js';
import type { DashboardStore } from '../control-plane/store.js';
import { DashboardProjection, integer } from './projection.js';
import type { AuthenticateViewer } from './security.js';
import { streamCache } from './stream-cache.js';
import { TASK_STATES, controlPlaneTasks, type TaskAdapter } from './tasks.js';

function query(url: URL, keys: string[]) {
  for (const key of url.searchParams.keys()) if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1)
    fail(400, 'invalid_query', 'Unsupported or repeated query parameter');
}
function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(value));
}
export async function dashboardRoute(request: IncomingMessage, response: ServerResponse, url: URL,
  options: { store: DashboardStore; authenticate: AuthenticateViewer; streams: Set<ServerResponse>; interval: number; now?: () => number; tasks?: TaskAdapter }) {
  const viewer = options.authenticate(request);
  if (!viewer) fail(401, 'viewer_unauthorized', 'A separate same-origin viewer session is required');
  // Authenticate every path and reject every mutation before body parsing; no Client principal is granted.
  if (request.method !== 'GET') fail(405, 'read_only', 'Dashboard sessions have read-only access');
  const projection = new DashboardProjection(options.store, viewer, options.now);
  const path = url.pathname.slice('/dashboard/v1'.length);
  const tasks = async (cp = controlPlaneTasks(projection.view(), (options.now ?? Date.now)())) => {
    const observed = await options.tasks?.observe(viewer.project_ids,cp) ?? [];
    const current=options.authenticate(request);
    if (!current || current.id!==viewer.id || JSON.stringify(current.project_ids)!==JSON.stringify(viewer.project_ids)) fail(401, 'viewer_unauthorized', 'Viewer session expired or scope changed');
    return [...new Map([...cp,...observed.filter(t=>viewer.project_ids.includes(t.project_id))].map(t=>[t.id,t])).values()];
  };
  if (path === '/snapshot') { query(url, []); const snapshot=projection.snapshot(); if(options.tasks)snapshot.tasks=await tasks(snapshot.tasks); json(response, snapshot); return; }
  if (path === '/tasks' || path.startsWith('/tasks/')) {
    let id='';try{id=decodeURIComponent(path.slice('/tasks/'.length));}catch{fail(400,'invalid_id','Invalid task ID');}
    if(path !== '/tasks') {
      query(url,[]);if(!validId(id))fail(400,'invalid_id','Invalid task ID');
      const item=(await tasks()).find(t=>t.id===id);if(!item)fail(404,'not_found','Task outside viewer scope or unavailable');
      json(response,{contract_version:'1.0',authority_verified:false,item});return;
    }
    query(url,['project_id','state','role','machine_id','limit','offset']);
    const project=url.searchParams.get('project_id'),state=url.searchParams.get('state'),role=url.searchParams.get('role'),machine=url.searchParams.get('machine_id');
    if(project){if(!validId(project))fail(400,'invalid_query','Invalid project');projection.scope(project);}
    if(state&&!TASK_STATES.includes(state as typeof TASK_STATES[number])||role&&!['coding_executor','reviewer','owner','stage','watcher'].includes(role)||machine&&!validId(machine)||[project,state,role,machine].some(x=>x===''))fail(400,'invalid_query','Invalid task filter');
    const limit=integer(url.searchParams.get('limit'),100,100),offset=integer(url.searchParams.get('offset'),0,10000);if(!limit)fail(400,'invalid_query','Invalid limit');
    const items=(await tasks()).filter(t=>(!project||t.project_id===project)&&(!state||t.state===state)&&(!role||t.active_actor?.role===role||t.waiting_for?.role===role)&&(!machine||t.machine?.id===machine)).sort((a,b)=>a.id.localeCompare(b.id));
    json(response,{contract_version:'1.0',authority_verified:false,items:items.slice(offset,offset+limit),next_offset:items.length>offset+limit?offset+limit:null});return;
  }
  if (path === '/events/stream') {
    query(url, ['after', 'project_id', 'run_id']);
    if ((request.headersDistinct['last-event-id']?.length ?? 0) > 1 || (url.searchParams.has('after') && request.headers['last-event-id'] !== undefined))
      fail(400, 'invalid_cursor', 'Choose one stream cursor');
    const text = request.headersDistinct['last-event-id']?.[0] ?? url.searchParams.get('after');
    if (text === null || text === undefined) fail(400, 'cursor_required', 'Fetch a REST snapshot then supply its cursor or a saved Event cursor');
    let cursor = integer(text);
    const project = url.searchParams.get('project_id'), run = url.searchParams.get('run_id');
    for (const id of [project, run]) if (id !== null && !validId(id)) fail(400, 'invalid_query', 'Invalid stream scope');
    const cache = streamCache(options.store);
    cache.read(viewer, options.now, true).projection.timeline(run, cursor, 1, project);
    if (options.streams.size >= 64) fail(503, 'stream_limit', 'SSE connection limit reached');
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    response.setTimeout(0); response.flushHeaders(); response.write(': connected\n\n'); options.streams.add(response);
    let heartbeat = Date.now(), blockedSince: number | null = null, fingerprint = '';
    const poll = () => {
      if (response.destroyed || response.writableEnded) return;
      if (response.writableNeedDrain) {
        blockedSince ??= Date.now();
        if (Date.now() - blockedSince > 15000) response.destroy();
        return;
      }
      blockedSince = null;
      try {
        const authenticated = options.authenticate(request);
        if (!authenticated || authenticated.id !== viewer.id || JSON.stringify(authenticated.project_ids) !== JSON.stringify(viewer.project_ids)) { response.destroy(); return; }
        const cached = cache.read(viewer, options.now);
        const page = cached.projection.timeline(run, cursor, 100, project);
        for (const entry of page.items) {
          const drained = response.write(`id: ${entry.cursor}\nevent: timeline-event\ndata: ${JSON.stringify(entry)}\n\n`);
          cursor = entry.cursor;
          if (response.writableLength > 128 * 1024) { response.destroy(); return; }
          if (!drained) return;
        }
        // Registrations/heartbeats are not persisted Events. Hints have no id and never advance the replay cursor.
        // Reconnect always refreshes REST; hints only invalidate the browser's read projection.
        const snapshot = cached.snapshot;
        const next = cached.fingerprint;
        if (fingerprint !== next) {
          fingerprint = next;
          response.write(`event: view-refresh\ndata: ${JSON.stringify({ contract_version: '1.0', authority_verified: false, snapshot_cursor: snapshot.cursor })}\n\n`);
        }
        if (Date.now() - heartbeat >= 15000) { response.write(': heartbeat\n\n'); heartbeat = Date.now(); }
        if (response.writableLength > 128 * 1024) response.destroy();
      } catch { response.destroy(); }
    };
    const timer = setInterval(poll, options.interval); timer.unref();
    response.once('close', () => { clearInterval(timer); options.streams.delete(response); });
    poll(); return;
  }
  const match = /^\/(projects|runs|executors)(?:\/([^/]+)(?:\/(timeline))?)?$/.exec(path);
  if (!match) fail(404, 'not_found', 'Dashboard endpoint was not found');
  const kind = match[1] as 'projects' | 'runs' | 'executors', id = match[2];
  if (id !== undefined && !validId(id)) fail(400, 'invalid_id', 'Invalid Registry ID');
  if (match[3]) {
    if (kind !== 'runs') fail(404, 'not_found', 'Dashboard endpoint was not found');
    query(url, ['after', 'limit']); const limit = integer(url.searchParams.get('limit'), 100, 100);
    if (limit < 1) fail(400, 'invalid_query', 'Limit must be between one and 100');
    json(response, projection.timeline(id!, integer(url.searchParams.get('after')), limit)); return;
  }
  if (id) { query(url, []); json(response, { contract_version: '1.0', authority_verified: false, item: projection.detail(kind, id) }); }
  else json(response, projection.page(kind, url));
}
