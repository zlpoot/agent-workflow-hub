import { lstatSync, readFileSync } from 'node:fs';
import { clientFail } from '../client/local.js';
import { LocalFast, type LocalFastDependencies } from './local-fast.js';

export const LOCAL_FAST_COMMANDS = [
  'local-fast bind --repo <owner/name> --issues 1,2,3 --confirm [--check <bounded-command>]',
  'local-fast flow status|next', 'local-fast stage prepare',
  'local-fast stage execute --title <title> --body <UTF8-file> --message <commit-message> [--check <bounded-command>]'
];
export async function localFastMain(args: string[], cwd = process.cwd(), deps: Partial<LocalFastDependencies> = {}): Promise<unknown> {
  if (args.length === 1 && args[0] === '--help') return { mode: 'local-fast', commands: LOCAL_FAST_COMMANDS, platform: 'windows', strict_artifacts: false };
  const [command, sub] = args;
  if (command === 'flow' && args.length === 2 && ['status', 'next'].includes(sub!)) return new LocalFast(cwd, deps).flow(sub === 'next');
  if (command === 'stage' && args.length === 2 && sub === 'prepare') return new LocalFast(cwd, deps).prepare();
  const bind = command === 'bind', execute = command === 'stage' && sub === 'execute';
  if (!bind && !execute) clientFail('arguments', 'Use local-fast --help; arbitrary Git/GitHub operations are unavailable.');
  const options = new Map<string, string>(), checks: string[] = [], allowed = bind ? ['--repo', '--issues', '--confirm', '--check'] : ['--title', '--body', '--message', '--check'];
  for (let i = bind ? 1 : 2; i < args.length; i++) {
    const key = args[i]!;
    if (!allowed.includes(key) || key !== '--check' && options.has(key)) clientFail('arguments', 'Unknown or duplicate Local Fast option.');
    if (key === '--confirm') { options.set(key, 'true'); continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) clientFail('arguments', 'Missing Local Fast option value.');
    if (key === '--check') checks.push(value); else options.set(key, value);
  }
  if (checks.length > 32 || !(bind ? ['--repo', '--issues', '--confirm'] : ['--title', '--body', '--message']).every(key => options.has(key))) clientFail('arguments', 'An exact repository/queue confirmation or title/body/message is required.');
  if (bind) return new LocalFast(cwd, deps).bind(options.get('--repo')!, options.get('--issues')!, true, checks);
  let body: string;
  try {
    const file = options.get('--body')!, stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000) throw new Error();
    body = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  } catch { return clientFail('file', 'PR body must be a bounded regular UTF-8 file.'); }
  return new LocalFast(cwd, deps).execute({ title: options.get('--title')!, message: options.get('--message')!, body, checks });
}
