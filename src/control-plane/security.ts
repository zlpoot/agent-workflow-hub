import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { enrollmentGrants, type EnrollmentGrant } from '../shared/enrollment.js';

import { fail, validId } from '../shared/security.js';
export { ControlPlaneError, fail, validId, MAX_BODY_BYTES, MAX_PAYLOAD_BYTES, safeData } from '../shared/security.js';

export interface Principal { readonly id: string; readonly project_ids: readonly string[]; readonly executor_ids: readonly string[]; readonly enrollment?: EnrollmentGrant }
export interface RegisteredClient extends Principal { token_sha256: string }
export type Authenticate = (request: IncomingMessage) => Principal | null;

// Separate, locally provisioned Control Plane credentials. No GitHub/repository credentials.
export function createAuthenticator(clients: readonly RegisteredClient[], enrollments: readonly EnrollmentGrant[] = []): Authenticate {
  const grants = enrollmentGrants(enrollments);
  if (!Array.isArray(clients) || clients.length === 0 || clients.length > 64) fail(500, 'configuration', 'Registered clients are required');
  const ids = new Set<string>(), hashes = new Set<string>(), executors = new Set<string>();
  const registry = clients.map(client => {
    if (!client || Object.keys(client).sort().join(',') !== 'executor_ids,id,project_ids,token_sha256' || !validId(client.id) ||
        ids.has(client.id) || typeof client.token_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(client.token_sha256) || hashes.has(client.token_sha256))
      fail(500, 'configuration', 'Invalid registered client');
    for (const scope of [client.project_ids, client.executor_ids]) {
      if (!Array.isArray(scope) || scope.length === 0 || scope.length > 64 || !scope.every(validId) || new Set(scope).size !== scope.length)
        fail(500, 'configuration', 'Explicit client scopes are required');
    }
    for (const id of client.executor_ids) {
      if (executors.has(id)) fail(500, 'configuration', 'Executor ownership must be unique');
      executors.add(id);
    }
    ids.add(client.id); hashes.add(client.token_sha256);
    const enrollment = grants.find(g => g.request.client_id === client.id);
    if (enrollment && (client.project_ids.join(',') !== enrollment.manifest.project.id || client.executor_ids.join(',') !== enrollment.request.executor_id || client.token_sha256 !== enrollment.request.token_sha256))
      fail(500, 'configuration', 'Enrollment requires exactly one dedicated project and executor scope');
    return { hash: Buffer.from(client.token_sha256, 'hex'), principal: Object.freeze({ id: client.id,
      project_ids: Object.freeze([...client.project_ids]), executor_ids: Object.freeze([...client.executor_ids]), ...(enrollment ? { enrollment: Object.freeze(enrollment) } : {}) }) };
  });
  if (grants.some(g => !ids.has(g.request.client_id))) fail(500, 'configuration', 'Enrollment Client is missing');
  return request => {
    if (request.headersDistinct.authorization?.length !== 1) return null;
    const match = /^Bearer (awh_cp_[A-Za-z0-9_-]{43,128})$/.exec(request.headers.authorization ?? '');
    if (!match) return null;
    const digest = createHash('sha256').update(match[1]!).digest();
    return registry.find(client => timingSafeEqual(client.hash, digest))?.principal ?? null;
  };
}

export function projectAccess(principal: Principal, id: string): void {
  if (!principal.project_ids.includes(id)) fail(403, 'forbidden', 'Project is outside the registered client scope');
}
export function executorAccess(principal: Principal, id: string): void {
  if (!principal.executor_ids.includes(id)) fail(403, 'forbidden', 'Executor is outside the registered client scope');
}
