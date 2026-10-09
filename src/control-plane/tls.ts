import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readExternalFile } from '../shared/external-files.js';
import { fail } from './security.js';

// Provisioning belongs to the OS/operator. No certificate minting, key logging or trust bypass.
const externalFile = readExternalFile;
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
