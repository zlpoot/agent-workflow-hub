import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { fail } from './security.js';

// Operator-owned deployment files. No discovery, repository files or redirected ancestors.
export function absoluteDeploymentPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') ||
      value.split(/[\\/]/).some(part => part === '.' || part === '..'))
    fail(500, 'configuration', 'An explicit absolute external path is required');
  const path = normalize(value);
  if (process.platform === 'win32' && path.slice(parse(path).root.length).split(/[\\/]/).some(part =>
      /[:<>"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    fail(500, 'configuration', 'Unsupported Windows path');
  return path;
}

export function externalPath(value: unknown, missingLeaf = false): string {
  const path = absoluteDeploymentPath(value);
  let current = path;
  if (missingLeaf) {
    try { lstatSync(path); fail(500, 'configuration', 'Initialization requires a new database path'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    current = dirname(path);
  }
  for (let directory = current; ; directory = dirname(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || directory !== current && !info.isDirectory())
      fail(500, 'configuration', 'Deployment paths cannot traverse symbolic links');
    if (existsSync(join(directory, '.git'))) fail(500, 'configuration', 'Deployment paths must remain outside repositories');
    if (dirname(directory) === directory) break;
  }
  const canonical = realpathSync(current);
  if ((process.platform === 'win32' ? canonical.toLowerCase() : canonical) !==
      (process.platform === 'win32' ? current.toLowerCase() : current))
    fail(500, 'configuration', 'Deployment path cannot be redirected');
  if (missingLeaf && !lstatSync(current).isDirectory()) fail(500, 'configuration', 'Database parent directory must already exist');
  return path;
}

export function externalFilePath(value: unknown, max = Number.MAX_SAFE_INTEGER): string {
  const path = externalPath(value), info = lstatSync(path);
  if (!info.isFile() || info.size === 0 || info.size > max) fail(500, 'configuration', 'Expected a nonempty bounded regular deployment file');
  return path;
}

export function readExternalFile(value: unknown, max: number, privateKey = false): Buffer {
  const path = externalFilePath(value, max), fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size === 0 || info.size > max || privateKey && process.platform !== 'win32' && (info.mode & 0o077))
      fail(500, 'configuration', 'Invalid deployment file type, size or private key permissions');
    const data = Buffer.alloc(max + 1); let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (!count) break; length += count;
    }
    if (!length || length > max) fail(500, 'configuration', 'Deployment file exceeds the byte limit or is empty');
    return data.subarray(0, length);
  } finally { closeSync(fd); }
}
