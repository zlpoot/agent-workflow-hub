import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { clientFail, readJson } from '../client/local.js';
import { LocalFast, type LocalFastDependencies } from './local-fast.js';
import { githubTransport } from './local-fast-github.js';
import { ReviewBridge, type ReviewContext, type ReviewDecisionName } from './local-fast-review.js';
import { LocalFastWatcher, type WatchDependencies } from './local-fast-watcher.js';

export const LOCAL_FAST_COMMANDS = [
  'local-fast bind --repo <owner/name> --issues 1,2,3 --confirm [--check <bounded-command>]',
  'local-fast flow status|next', 'local-fast stage prepare',
  'local-fast stage execute --title <title> --body <UTF8-file> --message <commit-message> [--check <bounded-command>]',
  'local-fast review prepare --pr <GitHub-PR-URL> [--output <JSON-file>]',
  'local-fast review publish --context <JSON-file> --decision PASS|REQUEST_CHANGES --body <independent-report-file>',
  'local-fast watch authorize --repo <owner/name> --issues 1,2,3 --expires <UTC-date> --executor <absolute-codex.exe> --confirm [--allow-merge]',
  'local-fast watch run [--once]', 'local-fast watch status', 'local-fast watch retry --confirm'
];
function textFile(path: string, max = 16000): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch { return clientFail('file', 'Expected a bounded regular UTF-8 report file.'); }
}
function flags(args: string[], required: string[], optional: string[] = [], boolean: string[] = []): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (![...required, ...optional, ...boolean].includes(key) || options.has(key)) clientFail('arguments', 'Unknown or duplicate Local Fast option.');
    if (boolean.includes(key)) options.set(key, 'true');
    else { const value = args[++i]; if (!value || value.startsWith('--')) clientFail('arguments', 'Missing Local Fast option value.'); options.set(key, value); }
  }
  if (!required.every(key => options.has(key))) clientFail('arguments', 'Missing required Local Fast options.');
  return options;
}
export async function localFastMain(args: string[], cwd = process.cwd(), deps: Partial<LocalFastDependencies> = {}, watch: Partial<WatchDependencies> = {}): Promise<unknown> {
  if (args.length === 1 && args[0] === '--help') return { mode: 'local-fast', commands: LOCAL_FAST_COMMANDS, platform: 'windows', strict_artifacts: false };
  const [command, sub] = args;
  if (command === 'review' && ['prepare','publish'].includes(sub!)) {
    const bridge = new ReviewBridge(githubTransport(cwd, deps.run));
    if (sub === 'prepare') {
      const options = flags(args.slice(2), ['--pr'], ['--output']), context = bridge.prepare(options.get('--pr')!);
      if (options.has('--output')) writeFileSync(options.get('--output')!, JSON.stringify(context, null, 2), { flag: 'wx' });
      return context;
    }
    const options = flags(args.slice(2), ['--context','--decision','--body']);
    return bridge.publish(readJson(options.get('--context')!, 8 * 1024 * 1024, false) as ReviewContext, options.get('--decision')! as ReviewDecisionName, textFile(options.get('--body')!));
  }
  if (command === 'watch') {
    if (!['authorize','run','status','retry'].includes(sub!)) clientFail('arguments', 'Use local-fast watch authorize, run, status or retry.');
    const options = sub === 'authorize' ? flags(args.slice(2), ['--repo','--issues','--expires','--executor'], [], ['--confirm','--allow-merge']) : flags(args.slice(2), [], [], sub === 'run' ? ['--once'] : sub === 'retry' ? ['--confirm'] : []);
    const watcher = new LocalFastWatcher(cwd, { fast: deps, ...watch });
    if (sub === 'authorize') return watcher.authorize(options.get('--repo')!, options.get('--issues')!, options.get('--expires')!, options.get('--executor')!, options.has('--allow-merge'), options.has('--confirm'));
    if (sub === 'status') return watcher.status();
    if (sub === 'retry') return watcher.retry(options.has('--confirm'));
    const controller = new AbortController(), stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { return await watcher.run(options.has('--once'), controller.signal, value => { if (!options.has('--once')) console.error(JSON.stringify(value)); }); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
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
  const body = textFile(options.get('--body')!);
  return new LocalFast(cwd, deps).execute({ title: options.get('--title')!, message: options.get('--message')!, body, checks });
}
