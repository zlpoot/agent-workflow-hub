import { existsSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const dist = join(root, 'dist');
if (existsSync(dist)) {
  const target = realpathSync(dist);
  if (relative(root, target) !== 'dist') throw new Error('Refuse redirected build output');
  rmSync(target, { recursive: true });
}
