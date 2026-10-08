import { X509Certificate, createPrivateKey } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute, dirname, join } from 'node:path';
import { fail } from './security.js';

// Provisioning belongs to the OS/operator. No certificate minting, key logging or trust bypass.
function externalFile(path: unknown, max: number, privateKey = false): Buffer {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(500, 'configuration', 'TLS files require explicit absolute external paths');
  const canonical = realpathSync(path), st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > max) fail(500, 'configuration', 'TLS file must be a bounded regular file');
  for (let directory = dirname(canonical); ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) fail(500, 'configuration', 'TLS configuration and keys must remain outside repositories');
    if (dirname(directory) === directory) break;
  }
  if (privateKey && process.platform !== 'win32' && (st.mode & 0o077)) fail(500, 'configuration', 'TLS private key must be owner-only');
  return readFileSync(path);
}
export function readHttpsConfig(path: string): { host: string; port: number; tls: { cert: Buffer; key: Buffer } } {
  const config = JSON.parse(externalFile(path, 16 * 1024).toString('utf8')) as Record<string, unknown>;
  if (!config || Array.isArray(config) || Object.keys(config).sort().join(',') !== 'certificate_file,host,port,private_key_file')
    fail(500, 'configuration', 'Invalid HTTPS listener configuration');
  const host = config.host;
  if (typeof host !== 'string' || !/^(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(host) ||
      host.split('.').some(part => Number(part) > 255 || String(Number(part)) !== part) || !Number.isInteger(config.port) || (config.port as number) < 1 || (config.port as number) > 65535)
    fail(500, 'configuration', 'HTTPS requires an explicit private IPv4 interface and valid port');
  const cert = externalFile(config.certificate_file, 64 * 1024), key = externalFile(config.private_key_file, 16 * 1024, true);
  const leaf = new X509Certificate(cert);
  if (leaf.ca || leaf.checkIP(host) !== host || Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now() || !leaf.checkPrivateKey(createPrivateKey(key)))
    fail(500, 'configuration', 'TLS certificate must match the private key, current validity and listener IP SAN');
  return { host, port: config.port as number, tls: { cert, key } };
}
