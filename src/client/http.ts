import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ClientError } from './local.js';

// Direct HTTP(S), never caller proxy auto-discovery, redirects, cookies or GitHub credentials.
export async function requestJson(endpoint: string, path: string, credential: string, method: 'GET' | 'POST', data?: unknown, ca?: Buffer): Promise<Record<string, unknown>> {
  const url = new URL(path, endpoint), encoded = data === undefined ? undefined : JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const fail = (code: string, message: string, status?: number) => reject(new ClientError(code, message, status));
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, agent: false,
      ...(url.protocol === 'https:' ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : {}),
      headers: { Authorization: 'Bearer ' + credential, Accept: 'application/json',
        ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }) } }, res => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) { res.resume(); fail(status === 401 || status === 403 ? 'authentication' : 'http', 'Control Plane rejected the request; no identity fallback or automatic retry', status); return; }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(res.headers['content-type'] ?? '')) { res.resume(); fail('response_schema', 'Control Plane response media type is invalid'); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { res.destroy(); fail('response_size', 'Control Plane response exceeds the byte limit'); }
        else chunks.push(chunk);
      });
      res.on('error', () => fail('network', 'Control Plane response was interrupted (details suppressed)'));
      res.on('end', () => {
        try {
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'authority_verified') || (value as { authority_verified?: unknown }).authority_verified !== false)
            throw new Error('Invalid envelope');
          resolve(value as Record<string, unknown>);
        } catch { fail('response_schema', 'Control Plane response is invalid; contents suppressed'); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); fail('timeout', 'Control Plane request timed out; retry the pending operation explicitly'); }, 15000);
    timer.unref(); req.on('close', () => clearTimeout(timer));
    req.on('error', () => fail('network', 'Control Plane connection failed (details suppressed); no credential or endpoint fallback'));
    req.end(encoded);
  });
}
