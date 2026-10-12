import { spawnSync } from 'node:child_process';
import { clientFail } from '../client/local.js';

export type Native = Record<string, any>;
export type NativeRun = (command: 'git' | 'gh', args: string[], cwd: string, input?: string) => string;
export const localFastRun: NativeRun = (command, args, cwd, input) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^AWH_/i.test(key)));
  const r = spawnSync(command, args, { cwd, input, env: { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) clientFail('local_fast_' + command, `${command} operation failed using the existing login; credentials and remote diagnostics are suppressed.`);
  return r.stdout.trim();
};
export interface ReviewTransport {
  read(path: string, pages?: boolean): any;
  write(path: string, method: 'POST' | 'PUT', body: Native): any;
  ready(repository: string, pr: number): void;
}
export function githubTransport(cwd: string, run: NativeRun = localFastRun): ReviewTransport {
  const decode = (value: string) => { try { return JSON.parse(value); } catch { return clientFail('local_fast_github', 'Invalid native GitHub response.'); } };
  return {
    read(path, pages = false) {
      const value = decode(run('gh', ['api', ...(pages ? ['--paginate', '--slurp'] : []), path], cwd));
      if (!pages) return value;
      if (!Array.isArray(value) || !value.every(Array.isArray)) clientFail('local_fast_github', 'Incomplete native GitHub pagination.');
      return value.flat();
    },
    write: (path, method, body) => decode(run('gh', ['api', '--method', method, '--input', '-', path], cwd, JSON.stringify(body))),
    ready(repository, pr) { run('gh', ['pr', 'ready', String(pr), '--repo', repository], cwd); }
  };
}
