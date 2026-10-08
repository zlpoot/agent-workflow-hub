import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export class ControlPlaneError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never {
  throw new ControlPlaneError(status, code, message);
}
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 32 * 1024;
export const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
export interface Principal { readonly id: string; readonly project_ids: readonly string[]; readonly executor_ids: readonly string[] }
export interface RegisteredClient extends Principal { token_sha256: string }
export type Authenticate = (request: IncomingMessage) => Principal | null;

// Separate, locally provisioned Control Plane credentials. No GitHub/repository credentials.
export function createAuthenticator(clients: readonly RegisteredClient[]): Authenticate {
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
    return { hash: Buffer.from(client.token_sha256, 'hex'), principal: Object.freeze({ id: client.id,
      project_ids: Object.freeze([...client.project_ids]), executor_ids: Object.freeze([...client.executor_ids]) }) };
  });
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

// Inspect iteratively before recursive protocol validation. Never echo rejected input.
export function safeData(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }], seen = new Set<object>();
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 10000 || item.depth > 32) fail(400, 'invalid_json', 'JSON complexity limit exceeded');
    if (typeof item.value === 'string') {
      if (/-----BEGIN[^\r\n]*PRIVATE KEY-----|\b(?:gh[psuor]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|awh_cp_[A-Za-z0-9_-]+)\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|authorization\s*:\s*(?:basic|bearer)\s+\S+/i.test(item.value))
        fail(400, 'credential_data', 'Credential material cannot be stored');
    } else if (item.value !== null && typeof item.value === 'object') {
      if (seen.has(item.value) || (!Array.isArray(item.value) && Object.getPrototypeOf(item.value) !== Object.prototype && Object.getPrototypeOf(item.value) !== null))
        fail(400, 'invalid_json', 'Expected plain JSON data');
      seen.add(item.value);
      for (const key of Reflect.ownKeys(item.value)) {
        if (Array.isArray(item.value) && key === 'length') continue;
        const property = Object.getOwnPropertyDescriptor(item.value, key)!;
        if (typeof key !== 'string' || !property.enumerable || !('value' in property)) fail(400, 'invalid_json', 'Expected plain JSON data');
        if (/^(?:pem|jwt|authorization|privatekey|installationtoken|accesstoken|githubtoken|token|credential|credentials)$/.test(key.replace(/[-_]/g, '').toLowerCase()))
          fail(400, 'credential_data', 'Credential fields cannot be stored');
        pending.push({ value: property.value, depth: item.depth + 1 });
      }
    } else if (item.value !== null && typeof item.value !== 'boolean' && !(typeof item.value === 'number' && Number.isFinite(item.value)))
      fail(400, 'invalid_json', 'Expected finite JSON data');
  }
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > MAX_BODY_BYTES) fail(413, 'body_too_large', 'JSON body exceeds the byte limit');
}
