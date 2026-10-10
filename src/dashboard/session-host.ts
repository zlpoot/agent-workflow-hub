import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ControlPlaneError, fail } from '../control-plane/security.js';
import { createViewerAuthenticator, type ViewerSession } from './security.js';

// Exchanges only a pre-existing operator-provisioned opaque secret. No credential generator,
// public login page, URL token, Client bearer, or JavaScript access to the HttpOnly cookie.
export function createSessionProvisioner(sessions: readonly ViewerSession[], now = Date.now) {
  createViewerAuthenticator(sessions, now); // Same closed trusted registry validation as the reader.
  const registry = sessions.map(s => ({ hash: Buffer.from(s.session_sha256, 'hex'), expires: Date.parse(s.expires_at) }));
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') fail(405, 'read_only', 'Explicit session exchange requires POST');
    if (request.headers.origin !== `http://127.0.0.1:${request.socket.localPort}` ||
        request.headersDistinct['content-type']?.length !== 1 || request.headers['content-type'] !== 'text/plain' ||
        request.headers['content-encoding'] !== undefined || request.headers.cookie !== undefined ||
        request.headers['content-length'] !== undefined && !/^(?:[1-9][0-9]?|1[01][0-9]|12[0-8])$/.test(request.headers['content-length']))
      fail(401, 'viewer_unauthorized', 'Explicit same-origin opaque secret exchange required');
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      const cleanup = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', error); };
      const error = () => { cleanup(); reject(new ControlPlaneError(400, 'invalid_body', 'Session exchange unavailable')); };
      const data = (chunk: Buffer) => { size += chunk.length; if (size > 128) { cleanup(); request.pause(); reject(new ControlPlaneError(413, 'body_too_large', 'Session exchange unavailable')); } else chunks.push(chunk); };
      const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
      const timer = setTimeout(() => { cleanup(); request.pause(); reject(new ControlPlaneError(408, 'body_timeout', 'Session exchange unavailable')); }, 5000); timer.unref();
      request.on('data', data).once('end', end).once('error', error).once('aborted', error);
    });
    const secret = raw.toString('ascii');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret) || !Buffer.from(secret, 'ascii').equals(raw)) fail(401, 'viewer_unauthorized', 'Session exchange unavailable');
    const digest = createHash('sha256').update(raw).digest();
    const session = registry.find(s => timingSafeEqual(s.hash, digest) && now() < s.expires);
    if (!session) fail(401, 'viewer_unauthorized', 'Session exchange unavailable');
    const seconds = Math.floor((session.expires - now()) / 1000);
    if (seconds <= 0) fail(401, 'viewer_unauthorized', 'Session exchange unavailable');
    response.writeHead(204, { 'Set-Cookie': `awh_viewer=${secret}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=${seconds}` }); response.end();
  };
}
