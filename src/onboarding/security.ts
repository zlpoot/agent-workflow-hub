import { createHash, timingSafeEqual } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import schema from './schema.json' with { type: 'json' };
import { safeData, validId } from '../control-plane/security.js';
import { assertEntity } from '../protocol/index.js';
import type { FixtureConfig, FixtureRequest, OperatorPeer, OperatorPrincipal, OperatorSession, PairingScope, ServiceBinding } from './types.js';

export class OnboardingError extends Error {
  constructor(readonly status: number, readonly code: string) { super('Trusted onboarding request was blocked'); }
}
export function deny(status: number, code: string): never { throw new OnboardingError(status, code); }
export const hash = (value: string, domain = '') => createHash('sha256').update(domain + value).digest('hex');
export function equalHash(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
};
export function safeInput(value: unknown): void {
  try { safeData(value); } catch { deny(400, 'invalid_data'); }
  if (/awh_(?:pair|op)_[A-Za-z0-9_-]+/i.test(JSON.stringify(value))) deny(400, 'credential_data');
}
const ajv = new Ajv2020({ strict: true, allErrors: false, ownProperties: true });
ajv.addFormat('date-time', fullFormats['date-time']!); ajv.addSchema(schema);
const validators = Object.fromEntries(Object.keys(schema.$defs).map(name => [name, ajv.compile({ $ref: schema.$id + '#/$defs/' + name })]));
export function validate<T>(name: keyof typeof schema.$defs, value: unknown): T {
  safeInput(value); if (!validators[name]!(value)) deny(400, 'schema'); return value as T;
}
export function safeId(value: string): void { safeInput(value); if (!validId(value)) deny(400, 'invalid_id'); }
export function header(request: FixtureRequest, name: string): string | undefined {
  const matches = Object.entries(request.headers).filter(([key]) => key.toLowerCase() === name);
  if (!matches.length) return undefined;
  if (matches.length !== 1 || typeof matches[0]![1] !== 'string') deny(400, 'repeated_header');
  return matches[0]![1] as string;
}
export function scopeAccess(operator: OperatorPrincipal, repository: string): void {
  if (operator.role !== 'operator' || !operator.repository_scope.includes(repository)) deny(403, 'operator_scope');
}
export function serviceAccess(scope: PairingScope, service: ServiceBinding): void {
  if (scope.service_id !== service.service_id || scope.endpoint !== service.endpoint || scope.ca_sha256 !== service.ca_sha256) deny(403, 'service_binding');
}
export function authenticateOperator(request: FixtureRequest, peer: OperatorPeer, service: ServiceBinding, sessions: readonly OperatorSession[], now: number): OperatorPrincipal {
  if (!peer.verified || peer.origin !== service.operator_origin || peer.local_address !== '127.0.0.1' || peer.remote_address !== '127.0.0.1' ||
      header(request, 'host') !== new URL(service.operator_origin).host || header(request, 'authorization') !== undefined ||
      ['forwarded','x-forwarded-host','x-forwarded-proto','x-forwarded-for'].some(k => header(request, k) !== undefined)) deny(401, 'operator_unauthorized');
  const origin = header(request, 'origin'), fetchSite = header(request, 'sec-fetch-site');
  if (origin !== undefined && origin !== service.operator_origin || fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none' || request.method === 'POST' && origin !== service.operator_origin) deny(403, 'origin');
  const cookie = header(request, 'cookie') ?? '';
  // Never accept mixed Viewer/Client cookies or an unprefixed Viewer value.
  const match = /^awh_operator=(awh_op_[A-Za-z0-9_-]{43})$/.exec(cookie);
  if (!match) deny(401, 'operator_unauthorized');
  const digest = hash(match[1]!, 'operator\0');
  const session = sessions.find(s => equalHash(s.session_sha256, digest) && now < s.expires_at);
  if (!session) deny(401, 'operator_unauthorized');
  return Object.freeze({ id: session.id, role: session.role, repository_scope: Object.freeze([...session.repository_scope]), session_sha256: session.session_sha256 });
}
export function validateConfig(config: FixtureConfig): FixtureConfig {
  safeInput(config);
  if (!config || Object.keys(config).sort().join(',') !== 'operators,profiles,reserved_clients,reserved_projects,service') deny(500, 'configuration');
  const service = config.service;
  if (!service || Object.keys(service).sort().join(',') !== 'ca_sha256,endpoint,operator_origin,service_id') deny(500, 'configuration');
  safeId(service.service_id);
  let endpoint: URL, origin: URL;
  try { endpoint = new URL(service.endpoint); origin = new URL(service.operator_origin); } catch { return deny(500, 'configuration'); }
  if (endpoint.origin !== service.endpoint || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
      !['https:','http:'].includes(endpoint.protocol) || endpoint.protocol === 'http:' && (endpoint.hostname !== '127.0.0.1' || service.ca_sha256 !== null) ||
      endpoint.protocol === 'https:' && !/^[a-f0-9]{64}$/.test(service.ca_sha256 ?? '') ||
      origin.origin !== service.operator_origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) deny(500, 'configuration');
  if (!Array.isArray(config.profiles) || !config.profiles.length || config.profiles.length > 16) deny(500, 'configuration');
  const refs = new Set<string>();
  for (const policy of config.profiles) {
    try { assertEntity('profile_policy', policy); } catch { deny(500, 'configuration'); }
    const expected = { 'future-ui/default': 'zlpoot/future-ui', 'webskill/default': 'zlpoot/webskill' }[policy.ref];
    if (expected !== policy.repository || refs.has(policy.ref + '@' + policy.version)) deny(500, 'configuration');
    refs.add(policy.ref + '@' + policy.version);
  }
  if (!Array.isArray(config.operators) || !config.operators.length || config.operators.length > 64) deny(500, 'configuration');
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const session of config.operators) {
    if (!session || Object.keys(session).sort().join(',') !== 'expires_at,id,repository_scope,role,session_sha256' || !validId(session.id) ||
        !['requester','operator'].includes(session.role) || !Number.isSafeInteger(session.expires_at) || !/^[a-f0-9]{64}$/.test(session.session_sha256) ||
        ids.has(session.id) || hashes.has(session.session_sha256) || !Array.isArray(session.repository_scope) || !session.repository_scope.length || session.repository_scope.length > 2 ||
        new Set(session.repository_scope).size !== session.repository_scope.length || session.repository_scope.some(r => !['zlpoot/future-ui','zlpoot/webskill'].includes(r))) deny(500, 'configuration');
    ids.add(session.id); hashes.add(session.session_sha256);
  }
  if (!Array.isArray(config.reserved_projects) || !Array.isArray(config.reserved_clients) || config.reserved_projects.length > 64 || config.reserved_clients.length > 64) deny(500, 'configuration');
  const projects = new Set<string>(), clients = new Set<string>(), executors = new Set<string>(), machines = new Set<string>();
  for (const project of config.reserved_projects) {
    validate('ProjectRequest', project);
    if (projects.has(project.project_id) || !config.profiles.some(p => p.repository === project.repository && p.ref === project.profile_ref && p.version === project.profile_version)) deny(500, 'configuration');
    projects.add(project.project_id);
  }
  for (const client of config.reserved_clients) {
    if (!client || Object.keys(client).sort().join(',') !== 'client_id,executor_id,machine_id,project_id') deny(500, 'configuration');
    Object.values(client).forEach(safeId);
    if (!projects.has(client.project_id) || clients.has(client.client_id) || executors.has(client.executor_id) || machines.has(client.machine_id)) deny(500, 'configuration');
    clients.add(client.client_id); executors.add(client.executor_id); machines.add(client.machine_id);
  }
  return structuredClone(config);
}
