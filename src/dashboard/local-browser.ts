import { randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createViewerAuthenticator, type Viewer } from './security.js';

// Explicit local OS-user access, distinct from remote authenticated hosting.
// One bounded, project-scoped cookie; no browser bearer, query secret or issuer API.
export function localBrowserSession(viewer: Viewer, now = Date.now) {
  let token = randomBytes(32).toString('base64url'), expires = now() + 3600000;
  const authenticator = () => createViewerAuthenticator([{ ...viewer,
    session_sha256: createHash('sha256').update(token).digest('hex'), expires_at: new Date(expires).toISOString() }], now, true);
  const authenticate: ReturnType<typeof createViewerAuthenticator> = request => authenticator()(request);
  return { authenticate, bootstrap(request: IncomingMessage, response: ServerResponse): Viewer | null {
    if (request.method !== 'GET' || !['/dashboard','/dashboard/'].includes(request.url ?? '') ||
      request.headers['sec-fetch-dest'] !== 'document' || request.headers['sec-fetch-mode'] !== 'navigate' ||
      !['none', 'same-origin'].includes(String(request.headers['sec-fetch-site']))) return null;
    if (now() >= expires) { token = randomBytes(32).toString('base64url'); expires = now() + 3600000; }
    response.setHeader('Set-Cookie', `awh_viewer=${token}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=${Math.max(0, Math.floor((expires - now()) / 1000))}`);
    return viewer;
  } };
}
