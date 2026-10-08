import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
export function npmEntry() {
  const candidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH ?? '').split(delimiter).flatMap(path => [join(path, 'npm'), join(path, 'node_modules/npm/bin/npm-cli.js'), join(path, '../lib/node_modules/npm/bin/npm-cli.js')])];
  for (const path of candidates) {
    try { if (existsSync(path)) { const file = realpathSync(path); if (file.endsWith('npm-cli.js')) return file; } } catch {}
  }
  throw new Error('A Node installation with npm is required for local package creation/installation');
}
export function npmEnv(cache) {
  mkdirSync(cache, { recursive: true });
  const user = join(cache, 'empty-user.npmrc'), global = join(cache, 'empty-global.npmrc');
  writeFileSync(user, ''); writeFileSync(global, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_|GITHUB_|AWH_|NPM_TOKEN$|NODE_OPTIONS$|npm_config_)/i.test(key)));
  return { ...env, npm_config_userconfig: user, npm_config_globalconfig: global,
    npm_config_cache: cache, npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
}
