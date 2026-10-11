import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { fail, validId } from '../control-plane/security.js';

export interface Viewer { readonly id: string; readonly project_ids: readonly string[] }
export interface ViewerSession extends Viewer { readonly session_sha256: string; readonly expires_at: string }
export type AuthenticateViewer = (request: IncomingMessage) => Viewer | null;

// Separate opaque HttpOnly cookie sessions, provisioned by a trusted host/gateway; never Client bearers.
// This first implementation deliberately accepts only an exact IPv4 loopback origin.
export function createViewerAuthenticator(sessions: readonly ViewerSession[], now = Date.now, allowEmptyLocalScope = false): AuthenticateViewer {
  if (!Array.isArray(sessions) || !sessions.length || sessions.length > 64) fail(500, 'configuration', 'Explicit viewer sessions are required');
  const ids = new Set<string>(), hashes = new Set<string>();
  const registry = sessions.map(session => {
    if (!session || Object.keys(session).sort().join(',') !== 'expires_at,id,project_ids,session_sha256' || !validId(session.id) || ids.has(session.id) ||
        !Array.isArray(session.project_ids) || !session.project_ids.length && !allowEmptyLocalScope || session.project_ids.length > 64 || !session.project_ids.every(validId) ||
        new Set(session.project_ids).size !== session.project_ids.length || !/^[a-f0-9]{64}$/.test(session.session_sha256) || hashes.has(session.session_sha256) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(session.expires_at) || !Number.isFinite(Date.parse(session.expires_at)))
      fail(500, 'configuration', 'Invalid viewer session');
    ids.add(session.id); hashes.add(session.session_sha256);
    return { hash: Buffer.from(session.session_sha256, 'hex'), expires: Date.parse(session.expires_at),
      viewer: Object.freeze({ id: session.id, project_ids: Object.freeze([...session.project_ids]) }) };
  });
  return request => {
    const loopback = (address: string | undefined) => address === '127.0.0.1' || address === '::ffff:127.0.0.1';
    const host = `127.0.0.1:${request.socket.localPort}`;
    if (!loopback(request.socket.localAddress) || !loopback(request.socket.remoteAddress) || request.headersDistinct.host?.length !== 1 ||
        request.headers.host !== host || request.headers.authorization !== undefined ||
        (request.headersDistinct.origin?.length ?? 0) > 1 || (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) ||
        (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) ||
        request.headersDistinct.cookie?.length !== 1) return null;
    const cookies = request.headers.cookie?.split(';').map(value => value.trim()) ?? [];
    const sessionCookies = cookies.filter(value => value.startsWith('awh_viewer='));
    if (sessionCookies.length !== 1) return null;
    const match = /^awh_viewer=([A-Za-z0-9_-]{43,128})$/.exec(sessionCookies[0]!);
    if (!match) return null;
    const digest = createHash('sha256').update(match[1]!).digest();
    return registry.find(session => timingSafeEqual(session.hash, digest) && now() < session.expires)?.viewer ?? null;
  };
}
