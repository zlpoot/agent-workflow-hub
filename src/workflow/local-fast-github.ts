import { spawnSync } from 'node:child_process';
import { clientFail } from '../client/local.js';

export type Native = Record<string, any>;
export type NativeRun = (command: 'git' | 'gh', args: string[], cwd: string, input?: string) => string;
export const localFastRun: NativeRun = (command, args, cwd, input) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^AWH_/i.test(key)));
  const invoke = () => spawnSync(command, args, { cwd, input, env: { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  // Retry only an unambiguously read-only native REST GET on a transient transport error.
  // Never replay Git, GraphQL, Review/PR writes, authentication failures or rate limits.
  const read = command === 'gh' && input === undefined && args[0] === 'api' &&
    args.slice(1).every(arg => arg === '--paginate' || arg === '--slurp' || /^(?:user|repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^\s]*)?)$/.test(arg)) &&
    args.some(arg => arg === 'user' || arg.startsWith('repos/'));
  let r = invoke();
  if (read && (r.error || r.status !== 0) && !/\b(?:401|403|429)\b|rate limit|authentication|permission/i.test(r.stderr ?? '') &&
      (/\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/.test((r.error as NodeJS.ErrnoException | undefined)?.code ?? '') ||
       /\b(?:502|503|504)\b|TLS handshake timeout|connection reset|unexpected EOF|i\/o timeout|temporary failure|timed out/i.test(r.stderr ?? ''))) r = invoke();
  if (r.error || r.status !== 0) clientFail('local_fast_' + command, `${command} operation failed using the existing login; credentials and remote diagnostics are suppressed.`);
  return r.stdout.trim();
};
export interface ReviewTransport {
  read(path: string, pages?: boolean): any;
  write(path: string, method: 'POST' | 'PUT', body: Native): any;
  ready(repository: string, pr: number): void;
  closingIssues(repository: string, pr: number): { total: number; issues: { number: number; repository: string }[] };
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
    ready(repository, pr) { run('gh', ['pr', 'ready', String(pr), '--repo', repository], cwd); },
    closingIssues(repository, pr) {
      const [owner, name] = repository.split('/');
      const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:2){totalCount nodes{number repository{nameWithOwner}}}}}}';
      const response = decode(run('gh', ['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${pr}`], cwd));
      const references = response.data?.repository?.pullRequest?.closingIssuesReferences;
      if (response.errors || !Number.isSafeInteger(references?.totalCount) || !Array.isArray(references?.nodes)) clientFail('local_fast_github', 'Cannot read native closing Issue references.');
      return { total: references.totalCount, issues: references.nodes.map((issue: Native) => ({ number: issue.number, repository: issue.repository?.nameWithOwner })) };
    }
  };
}
