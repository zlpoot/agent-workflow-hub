import { performance } from 'node:perf_hooks';
import { deny } from './security.js';
import { OBSERVATION, type FixtureRequest } from './types.js';

export const OFFLINE_LIMITS = Object.freeze({ body_bytes: 65536, body_nodes: 1024, body_depth: 16,
  header_bytes: 16384, header_count: 64, header_values: 4, window_ms: 1000,
  operator_requests: 256, operator_identity_requests: 64, pairing_requests: 128, pairing_identity_requests: 32,
  anonymous_requests: 64, inflight: 8, identities: 64, aggregate_count: 1000000,
  audit_rows: 8192, storage_bytes: 8 * 1024 * 1024, busy_ms: 50 });
export type AdmissionLane = 'anonymous' | 'operator' | 'pairing';
type Category = 'access' | 'input' | 'rate' | 'storage' | 'internal';
const lanes: AdmissionLane[] = ['anonymous', 'operator', 'pairing'];
const categories: Category[] = ['access', 'input', 'rate', 'storage', 'internal'];
interface Bucket { started: number; requests: number; inflight: number; identities: Map<string,number> }

// One bounded controller per fixture store; no IP/cookie/token/request-keyed buckets or DB access.
export class OfflineAdmission {
  readonly #buckets = Object.fromEntries(lanes.map(lane => [lane, { started: 0, requests: 0, inflight: 0, identities: new Map<string,number>() }])) as Record<AdmissionLane,Bucket>;
  readonly #denied = Object.fromEntries(lanes.map(lane => [lane, Object.fromEntries(categories.map(c => [c,0]))])) as Record<AdmissionLane,Record<Category,number>>;
  #last = 0;
  constructor(readonly clock: () => number = () => performance.now()) {}
  enter(lane: AdmissionLane, identity?: string): () => void {
    const now = this.clock();
    if (!Number.isFinite(now) || now < this.#last) deny(500,'admission_clock');
    this.#last = now;
    const bucket = this.#buckets[lane];
    if (now - bucket.started >= OFFLINE_LIMITS.window_ms) {
      bucket.started = now; bucket.requests = 0; bucket.identities.clear();
    }
    const limit = lane === 'operator' ? OFFLINE_LIMITS.operator_requests : lane === 'pairing' ? OFFLINE_LIMITS.pairing_requests : OFFLINE_LIMITS.anonymous_requests;
    if (bucket.requests >= limit || bucket.inflight >= OFFLINE_LIMITS.inflight) deny(429,'admission_limit');
    if (identity !== undefined) this.bindIdentity(lane,identity);
    bucket.requests++; bucket.inflight++;
    let released = false;
    return () => { if (!released) { released = true; bucket.inflight--; } };
  }
  // Reserve a known fixture identity's quota; this never confers authentication or scope.
  private bindIdentity(lane: AdmissionLane, identity: string): void {
    const bucket=this.#buckets[lane], limit=lane==='operator' ? OFFLINE_LIMITS.operator_identity_requests : OFFLINE_LIMITS.pairing_identity_requests;
    if (!bucket.identities.has(identity) && bucket.identities.size >= OFFLINE_LIMITS.identities ||
        (bucket.identities.get(identity) ?? 0) >= limit) deny(429,'admission_limit');
    bucket.identities.set(identity,(bucket.identities.get(identity) ?? 0)+1);
  }
  denied(lane: AdmissionLane, status: number): void {
    const category: Category = status === 429 ? 'rate' : status === 503 ? 'storage' : status === 401 || status === 403 ? 'access' : status < 500 ? 'input' : 'internal';
    this.#denied[lane][category] = Math.min(OFFLINE_LIMITS.aggregate_count,this.#denied[lane][category]+1);
  }
  snapshot() {
    return { ...OBSERVATION, state: 'not_checked' as const, limits: { ...OFFLINE_LIMITS },
      lanes: Object.fromEntries(lanes.map(lane => [lane, { requests: this.#buckets[lane].requests, inflight: this.#buckets[lane].inflight, identities: this.#buckets[lane].identities.size, denied: { ...this.#denied[lane] } }])) };
  }
}

// Inspect descriptors and bounded values before schema validation or any JSON.stringify.
export function boundedRequest(request: FixtureRequest): void {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype) deny(400,'request');
  const requestKeys = Reflect.ownKeys(request);
  if (requestKeys.length > 4) deny(400,'request');
  for (const key of requestKeys) {
    const p = Object.getOwnPropertyDescriptor(request,key)!;
    if (typeof key !== 'string' || !['method','path','headers','body'].includes(key) || !p.enumerable || !('value' in p)) deny(400,'request');
  }
  if (typeof request.method !== 'string' || request.method.length > 16 || typeof request.path !== 'string' || request.path.length > 1024 ||
      !request.headers || Object.getPrototypeOf(request.headers) !== Object.prototype) deny(400,'request');
  const keys = Reflect.ownKeys(request.headers);
  if (keys.length > OFFLINE_LIMITS.header_count) deny(413,'request_too_large');
  let bytes = 0;
  const text = (value: unknown, maximum: number): number => {
    if (typeof value !== 'string') deny(400,'request');
    if (value.length > maximum) deny(413,'request_too_large');
    return Buffer.byteLength(value);
  };
  for (const key of keys) {
    const p = Object.getOwnPropertyDescriptor(request.headers,key)!;
    if (typeof key !== 'string' || !p.enumerable || !('value' in p)) deny(400,'request');
    bytes += text(key,OFFLINE_LIMITS.header_bytes);
    if (Array.isArray(p.value)) {
      if (p.value.length > OFFLINE_LIMITS.header_values) deny(413,'request_too_large');
      for (let i=0;i<p.value.length;i++) {
        const item=Object.getOwnPropertyDescriptor(p.value,String(i));
        if (!item || !('value' in item)) deny(400,'request');
        bytes += text(item.value,OFFLINE_LIMITS.header_bytes);
      }
    } else bytes += text(p.value,OFFLINE_LIMITS.header_bytes);
    if (bytes > OFFLINE_LIMITS.header_bytes) deny(413,'request_too_large');
  }
  if (request.body === undefined) return;
  const stack = [{ value: request.body, depth: 0 }], seen = new Set<object>();
  let nodes = 0; bytes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > OFFLINE_LIMITS.body_nodes || depth > OFFLINE_LIMITS.body_depth) deny(400,'request_complexity');
    if (typeof value === 'string') bytes += text(value,OFFLINE_LIMITS.body_bytes)*6+2;
    else if (value !== null && typeof value === 'object') {
      if (seen.has(value) || !Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value))) deny(400,'request');
      if (Array.isArray(value) && (Object.getPrototypeOf(value)!==Array.prototype ||
          value.length+nodes+stack.length>OFFLINE_LIMITS.body_nodes)) deny(400,'request_complexity');
      seen.add(value);
      const fields = Reflect.ownKeys(value);
      if (fields.length > OFFLINE_LIMITS.body_nodes) deny(400,'request_complexity');
      // Dense JSON arrays only: holes and extra properties must never expand later serialization.
      if (Array.isArray(value) && fields.length!==value.length+1) deny(400,'request');
      for (const key of fields) {
        if (Array.isArray(value) && key === 'length') continue;
        const p=Object.getOwnPropertyDescriptor(value,key)!;
        if (typeof key !== 'string' || !p.enumerable || !('value' in p)) deny(400,'request');
        if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key)>=value.length)) deny(400,'request');
        // Charge worst-case JSON string escaping without allocating a serialized body.
        bytes += text(key,OFFLINE_LIMITS.body_bytes)*6+4;
        stack.push({ value:p.value, depth:depth+1 });
        if (stack.length+nodes > OFFLINE_LIMITS.body_nodes) deny(400,'request_complexity');
      }
      bytes += 2;
    } else if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) bytes += 24;
    else deny(400,'request');
    if (bytes > OFFLINE_LIMITS.body_bytes) deny(413,'request_too_large');
  }
}
