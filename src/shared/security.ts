export class ControlPlaneError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never {
  throw new ControlPlaneError(status, code, message);
}
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 32 * 1024;
export const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
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
