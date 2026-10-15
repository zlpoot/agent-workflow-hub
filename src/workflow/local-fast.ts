import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicJson, clientFail, inspectRepository, readJson, same } from '../client/local.js';
import { deliveryDependencies, type VerificationLog } from '../client/deliver.js';
import { initFlow, readFlow } from './flow.js';
import { localFastRun } from './local-fast-github.js';
import { selectReview, REVIEW_DELIVERY_INSTRUCTIONS, type ReviewDecision } from './local-fast-review.js';
import { GithubApp, type AppBinding, type AppDelivery } from './github-app.js';
import { createHash, randomUUID } from 'node:crypto';

type Native = Record<string, any>;
type Task = { issue: number; branch: string; base: string; worktree: string; phase: 'preparing' | 'developing' | 'publishing' | 'awaiting_review' | 'completed'; head?: string; pending_head?: string; pr?: number; create_attempted?: boolean; coding_executor?: { type: 'codex-cli' }; delivery_actor?: AppBinding['delivery_actor'] };
interface State {
  schema_version: '1.0'; mode: 'local-fast'; repository: string; repository_id: number;
  owner: { login: string; id: number }; root: string; issues: number[]; checks: string[]; tasks: Task[];
  delivery?: AppBinding;
  queue_id?: string; previous_queues?: string[];
}
export const validQueueId = (value: unknown): value is string => typeof value === 'string' && (value === 'legacy' || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value));
export interface LocalFastDependencies {
  platform: NodeJS.Platform;
  run: (command: 'git' | 'gh', args: string[], cwd: string) => string;
  verify: (command: string, root: string) => Promise<VerificationLog>;
  app: Pick<GithubApp, 'binding' | 'preflight'>;
}
const defaults: LocalFastDependencies = {
  platform: process.platform, verify: deliveryDependencies.verify,
  run: localFastRun,
  app: { binding: repository => new GithubApp().binding(repository), preflight: repository => new GithubApp().preflight(repository) }
};
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const marker = (s: State, issue: number) => `<!-- awh-local-fast:${s.repository}#${issue} -->`;
const result = (status: string, fields: Native = {}): Native => ({ mode: 'local-fast', status, authority_verified: false, ...fields });
function checkCommand(command: string) {
  if (!/^pnpm(?: --config\.verifyDepsBeforeRun=false)? (?:run )?[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(command) &&
      !(/^node --test(?: tests\/[A-Za-z0-9_.\/-]+\.mjs)+$/.test(command) && !command.includes('..')) && command !== 'git diff --check origin/main...HEAD')
    clientFail('local_fast_check', 'Use a pnpm script, node --test tests/<files>.mjs, or the main diff check.');
}

/** Personal, local state shared by this repository's worktrees. No CP/Builder records. */
export class LocalFast {
  private readonly deps: LocalFastDependencies;
  private readonly common: string;
  private readonly directory: string;
  private readonly file: string;
  constructor(readonly cwd = process.cwd(), overrides: Partial<LocalFastDependencies> = {}) {
    this.deps = { ...defaults, ...overrides };
    if (this.deps.platform !== 'win32') clientFail('local_fast_platform', 'Local Fast supports Windows single-machine repositories only.');
    const identity = inspectRepository(cwd);
    this.common = resolve(identity.root, this.git(['rev-parse', '--git-common-dir'], identity.root));
    this.directory = join(this.common, 'awh-local-fast');
    this.file = join(this.directory, 'state.json');
  }
  private git(args: string[], cwd = this.cwd) { return this.deps.run('git', args, cwd); }
  private api(path: string, pages = false): any {
    let value: any;
    try { value = JSON.parse(this.deps.run('gh', ['api', ...(pages ? ['--paginate', '--slurp'] : []), path], this.cwd)); }
    catch { return clientFail('local_fast_github', 'Cannot read native GitHub facts using the existing login.'); }
    if (pages) { if (!Array.isArray(value) || !value.every(Array.isArray)) clientFail('local_fast_github', 'Incomplete GitHub pagination.'); return value.flat(); }
    return value;
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    mkdirSync(this.directory, { recursive: true });
    const file = join(this.directory, 'operation.lock');
    let fd: number;
    try { fd = openSync(file, 'wx'); } catch { return clientFail('local_fast_locked', 'Another operation or an interrupted lock exists; preserve state and inspect before continuing.'); }
    try { writeFileSync(fd, String(process.pid)); return await operation(); }
    finally { closeSync(fd); unlinkSync(file); }
  }
  private identity(repository: string, id?: number, owner?: State['owner']) {
    const local = inspectRepository(this.cwd);
    if (local.repository !== repository) clientFail('local_fast_scope', 'The actual origin differs from the confirmed repository.');
    // Inspect effective fetch AND push URLs with the user's real Git configuration.
    for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
      const urls = this.git(args).split('\n');
      if (urls.length !== 1 || ![`git@github.com:${repository}.git`, `git@github.com:${repository}`, `https://github.com/${repository}.git`, `https://github.com/${repository}`].includes(urls[0]!))
        clientFail('local_fast_scope', 'Effective Git fetch/push destination differs from the confirmed repository.');
    }
    const user = this.api('user'), repo = this.api(`repos/${repository}`);
    if (!positive(user.id) || typeof user.login !== 'string' || user.type !== 'User' || !positive(repo.id) || repo.full_name !== repository || repo.default_branch !== 'main' || repo.permissions?.push !== true || repo.archived || repo.disabled ||
        id !== undefined && repo.id !== id || owner && (owner.id !== user.id || owner.login !== user.login))
      clientFail('local_fast_permission', 'A normal GitHub user with write permission to the confirmed repository and an existing main is required.');
    return { local, user: { login: user.login as string, id: user.id as number }, id: repo.id as number };
  }
  private load(): State {
    const s = readJson(this.file, 256 * 1024) as State;
    if (!s || s.schema_version !== '1.0' || s.mode !== 'local-fast' || !REPO.test(s.repository) || !positive(s.repository_id) || !positive(s.owner?.id) || typeof s.owner.login !== 'string' || typeof s.root !== 'string' ||
        !Array.isArray(s.issues) || !s.issues.length || s.issues.length > 128 || !s.issues.every(positive) || new Set(s.issues).size !== s.issues.length ||
        !Array.isArray(s.checks) || !s.checks.length || !s.checks.every(c => typeof c === 'string') || !Array.isArray(s.tasks) || s.tasks.length > s.issues.length)
      clientFail('local_fast_state', 'Invalid Local Fast binding; preserve the local file.');
    if (s.queue_id !== undefined && (!validQueueId(s.queue_id) || s.queue_id === 'legacy') || s.previous_queues !== undefined && (!Array.isArray(s.previous_queues) || s.previous_queues.length > 32 || !s.previous_queues.every(validQueueId) || new Set(s.previous_queues).size !== s.previous_queues.length || s.previous_queues.includes(s.queue_id!))) clientFail('local_fast_state','Invalid queue history references');
    s.checks.forEach(checkCommand);
    if (s.delivery && (s.delivery.provider !== 'github-app' || !same(this.deps.app.binding(s.repository), s.delivery) || s.delivery.repository_id !== s.repository_id))
      clientFail('local_fast_app_binding', 'Saved App connection differs from this queue; preserve its history.');
    for (const [i, t] of s.tasks.entries()) {
      if (t.issue !== s.issues[i] || t.branch !== `codex/local-fast-${t.issue}` || !SHA.test(t.base) || t.worktree !== join(s.root, '.handoff', 'local-fast', `issue-${t.issue}`) ||
          t.create_attempted !== undefined && typeof t.create_attempted !== 'boolean' || t.coding_executor && t.coding_executor.type !== 'codex-cli' || t.delivery_actor && (!s.delivery || !same(t.delivery_actor, s.delivery.delivery_actor)) ||
          !['preparing', 'developing', 'publishing', 'awaiting_review', 'completed'].includes(t.phase) || t.head !== undefined && !SHA.test(t.head) || t.pending_head !== undefined && !SHA.test(t.pending_head) || t.pr !== undefined && !positive(t.pr) ||
          (t.phase === 'awaiting_review' || t.phase === 'completed') && (!t.pr || !t.head) || i < s.tasks.length - 1 && t.phase !== 'completed')
        clientFail('local_fast_state', 'Invalid sequential Local Fast history; preserve worktrees.');
    }
    this.identity(s.repository, s.repository_id, s.owner);
    const boundRoot = inspectRepository(s.root);
    if (boundRoot.repository !== s.repository || resolve(boundRoot.root, this.git(['rev-parse', '--git-common-dir'], boundRoot.root)) !== this.common)
      clientFail('local_fast_state', 'The original binding root is not a worktree of this repository.');
    const declaration = join(inspectRepository(this.cwd).root, '.awh', 'flow.json');
    if (existsSync(declaration) && !same(readFlow(this.cwd).issues, s.issues) && !this.archives(s).some(old=>same(old.issues,readFlow(this.cwd).issues))) clientFail('local_fast_queue_scope', 'Queue differs from the confirmed binding and preserved declarations.');
    return s;
  }
  private save(s: State) { atomicJson(this.file, s); }
  scope() {
    const { repository, repository_id, owner, root, issues, checks, delivery, queue_id } = this.load();
    return { repository, repository_id, owner, root, issues: [...issues], checks: [...checks], ...(delivery ? { delivery } : {}), ...(queue_id ? { queue_id } : {}) };
  }
  assertScope(expected: ReturnType<LocalFast['scope']>) {
    const s=readJson(this.file,256*1024) as State;
    if(!s||s.schema_version!=='1.0'||s.mode!=='local-fast')clientFail('local_fast_watch_scope_changed','Invalid canonical binding during execution');
    const current={repository:s.repository,repository_id:s.repository_id,owner:s.owner,root:s.root,issues:s.issues,checks:s.checks,...(s.delivery?{delivery:s.delivery}:{}),...(s.queue_id!==undefined?{queue_id:s.queue_id}:{})};
    if(!same(current,expected))clientFail('local_fast_watch_scope_changed','The canonical queue changed during Watcher execution');
  }
  private archives(s: State): State[] {
    return (s.previous_queues??[]).map(id=>{
      const old = readJson(join(this.directory,'queues',id,'state.json'),256*1024) as State;
      if (old.schema_version!=='1.0'||old.mode!=='local-fast'||old.repository!==s.repository||old.repository_id!==s.repository_id||old.root!==s.root||!same(old.owner,s.owner)||!Array.isArray(old.issues)||!old.issues.length||old.issues.length>128||!old.issues.every(positive)||new Set(old.issues).size!==old.issues.length||!Array.isArray(old.tasks)||old.tasks.length>old.issues.length||(old.queue_id??'legacy')!==id) clientFail('local_fast_state','Preserved queue identity is invalid');
      return old;
    });
  }
  queueInfo() {
    // Display metadata only. Scope-changing operations independently validate identity via load().
    const state=readJson(this.file,256*1024) as State;
    if(!Array.isArray(state.tasks)||!Array.isArray(state.issues))clientFail('local_fast_state','Invalid queue metadata');
    return {queue_id:state.queue_id??'legacy',queue_revision:createHash('sha256').update(readFileSync(this.file)).digest('hex'),
      queue_editable:state.tasks.length===0||state.tasks.length===state.issues.length&&state.tasks.every(t=>t.phase==='completed'),queue_started:state.tasks.length>0,history_count:state.previous_queues?.length??0};
  }
  openIssues(page=1) {
    if(!Number.isSafeInteger(page)||page<1||page>20)clientFail('local_fast_issue_page','Use a bounded Issue page');
    const identity=inspectRepository(this.cwd);this.identity(identity.repository);
    const rows=this.api(`repos/${identity.repository}/issues?state=open&per_page=50&page=${page}`);
    if(!Array.isArray(rows)||rows.length>50)clientFail('local_fast_issue','Cannot read the bounded Issue page');
    const items=rows.filter(row=>!row.pull_request).map(row=>{
      if(!positive(row.number)||row.state!=='open'||typeof row.title!=='string'||row.title.length>512||/[\x00-\x1f]/.test(row.title))clientFail('local_fast_issue','Invalid ordinary Issue metadata');
      return {number:row.number,title:row.title,state:'open',url:`https://github.com/${identity.repository}/issues/${row.number}`};
    });
    if(new Set(items.map(row=>row.number)).size!==items.length)clientFail('local_fast_issue','Duplicate Issue metadata');
    return {repository:identity.repository,items,page,next_page:rows.length===50&&page<20?page+1:null,observed_at:new Date().toISOString()};
  }
  private declareQueue(cwd: string,s: State) {
    const directory=join(inspectRepository(cwd).root,'.awh');
    if(existsSync(join(directory,'flow.json'))&&!same(readFlow(cwd).issues,s.issues)){
      if(!s.queue_id||!this.archives(s).some(old=>same(old.issues,readFlow(cwd).issues)))clientFail('flow_queue','Unknown declaration conflict; preserve it');
      atomicJson(join(directory,'flow.json'),{schema_version:'1.0',issues:s.issues});return;
    }
    initFlow(cwd,s.issues.join(','));
  }
  /** Explicit finite replacement only when unstarted or natively completed; old grants are never reused. */
  async setQueue(issues: string, expected: string, confirm: boolean, idle:()=>void) {
    if(!confirm||!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(issues))clientFail('local_fast_confirmation','Confirm the exact ordered Issue queue');
    const queue=issues.split(',').map(Number);
    if(queue.length>128||!queue.every(positive)||new Set(queue).size!==queue.length)clientFail('flow_queue','Use distinct positive Issue numbers');
    return this.locked(async()=>{
      const original=this.load();
      const preview=inspectRepository(this.cwd);
      if(this.cwd!==original.root||this.queueInfo().queue_revision!==expected)clientFail('local_fast_preview_changed','Inspect the original root and current queue again');
      idle();
      if(same(queue,original.issues)&&!original.tasks.length)return result('BOUND',{repository:original.repository,queue,queue_id:original.queue_id??'legacy'});
      if(original.tasks.length){
        const facts=await this.select(original,false);
        if(facts.status!=='QUEUE_COMPLETED'||original.issues.some(n=>this.issue(original,n).state!=='closed'))clientFail('local_fast_queue_active','Finish the current queue before creating another round');
      }
      const past=this.archives(original);
      if([...past,original].some(old=>old.tasks.some(t=>queue.includes(t.issue))))clientFail('local_fast_queue_history','Executed Issues cannot be queued again');
      for(const number of queue)if(this.issue(original,number).state!=='open')clientFail('local_fast_issue','Queue only open ordinary Issues');
      if(original.delivery)await this.deps.app.preflight(original.repository);
      this.identity(original.repository,original.repository_id,original.owner);
      if(!same(inspectRepository(this.cwd),preview)||this.queueInfo().queue_revision!==expected)clientFail('local_fast_preview_changed','Repository or queue changed during inspection');
      const id=original.queue_id??'legacy',previous=[...(original.previous_queues??[]),id];
      if(previous.length>32)clientFail('local_fast_queue_limit','Preserved queue history capacity reached');
      const archived=join(this.directory,'queues',id,'state.json'),bytes=readFileSync(this.file);
      mkdirSync(join(archived,'..'),{recursive:true});
      if(existsSync(archived)){if(!readFileSync(archived).equals(bytes))clientFail('local_fast_queue_history','An archive differs; preserve both states');}
      else writeFileSync(archived,bytes,{flag:'wx'});
      // One atomic canonical binding commit. A known old declaration remains safe after interruption.
      const updated:State={...original,issues:queue,tasks:[],queue_id:randomUUID(),previous_queues:previous};
      idle();this.save(updated);this.declareQueue(this.cwd,updated);
      return result('BOUND',{repository:updated.repository,queue,queue_id:updated.queue_id,history_count:previous.length,owner_authorization_required:true});
    });
  }
  private main(s: State) {
    const ref = this.api(`repos/${s.repository}/git/ref/heads/main`);
    if (ref.ref !== 'refs/heads/main' || !SHA.test(ref.object?.sha)) clientFail('local_fast_main', 'Cannot verify native main.');
    return ref.object.sha as string;
  }
  private issue(s: State, number: number): Native {
    const issue = this.api(`repos/${s.repository}/issues/${number}`);
    if (issue.number !== number || issue.pull_request || !['open', 'closed'].includes(issue.state) || typeof issue.title !== 'string') clientFail('local_fast_issue', 'Queue entries must be real ordinary GitHub Issues.');
    return issue;
  }
  async bind(repository: string, issues: string, confirm: boolean, checks: string[] = [], provider: 'personal-gh' | 'github-app' = 'personal-gh') {
    if (!['personal-gh', 'github-app'].includes(provider)) clientFail('local_fast_provider', 'Select personal-gh or github-app explicitly.');
    if (!confirm || !REPO.test(repository) || repository.includes('..')) clientFail('local_fast_confirmation', 'Confirm the exact repository and Issue queue with local-fast bind --repo owner/name --issues 1,2,3 --confirm.');
    if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(issues)) clientFail('flow_queue', 'Use distinct positive Issue numbers.');
    const queue = issues.split(',').map(Number);
    if (queue.length > 128 || !queue.every(positive) || new Set(queue).size !== queue.length) clientFail('flow_queue', 'Use 1–128 distinct positive Issue numbers.');
    const commands = [...new Set(['git diff --check origin/main...HEAD', ...checks])]; commands.forEach(checkCommand);
    return this.locked(async () => {
      const identity = this.identity(repository);
      const delivery = provider === 'github-app' ? (await this.deps.app.preflight(repository)).binding : undefined;
      if (delivery && delivery.repository_id !== identity.id) clientFail('local_fast_app_binding', 'App and Owner repository identities differ.');
      const proposed: State = { schema_version: '1.0', mode: 'local-fast', repository, repository_id: identity.id, owner: identity.user, root: identity.local.root, issues: queue, checks: commands, tasks: [], ...(delivery ? { delivery } : {}) };
      if (existsSync(this.file)) {
        const original = this.load();
        const {queue_id:_queue,previous_queues:_previous,...pinned}=original;
        if (!same({ ...pinned, tasks: [] }, proposed)) clientFail('local_fast_binding_conflict', 'Existing binding differs; progress and scope cannot be overwritten.');
        return result('BOUND', { repository, queue, owner: identity.user.login });
      }
      this.main(proposed);
      for (const number of queue) if (this.issue(proposed, number).state !== 'open') clientFail('local_fast_issue', 'Bind only open ordinary Issues.');
      initFlow(this.cwd, issues);
      // Local exclusions are shared by worktrees, without editing the user's tracked files.
      const exclude = join(this.common, 'info', 'exclude'); mkdirSync(join(this.common, 'info'), { recursive: true });
      const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (!current.split(/\r?\n/).includes('.handoff/')) writeFileSync(exclude, current + '\n.handoff/\n');
      this.save(proposed);
      return result('BOUND', { repository, queue, owner: identity.user.login, verification_commands: commands });
    });
  }
  private prs(s: State, t: Task): Native[] {
    return this.api(`repos/${s.repository}/pulls?state=all&head=${s.repository.split('/')[0]}:${t.branch}&base=main&per_page=100`, true);
  }
  private pr(s: State, t: Task, p: Native) {
    const author = s.delivery ? same({ id: p.user?.id, login: p.user?.login, type: p.user?.type }, s.delivery.delivery_actor) : p.user?.id === s.owner.id;
    if (!positive(p.number) || p.head?.repo?.id !== s.repository_id || p.base?.repo?.id !== s.repository_id || p.head.ref !== t.branch || p.base.ref !== 'main' || !author ||
        !SHA.test(p.head.sha) || typeof p.body !== 'string' || !p.body.includes(marker(s, t.issue)) || t.pr && p.number !== t.pr || !['open', 'closed'].includes(p.state))
      clientFail('local_fast_pr_scope', 'Native PR differs from this Local Fast repository, author, branch or Issue.');
    return p;
  }
  private review(s: State, p: Native): ReviewDecision | undefined {
    const reviews: Native[] = this.api(`repos/${s.repository}/pulls/${p.number}/reviews?per_page=100`, true);
    return selectReview(reviews, p.user.id, p.head.sha, s.delivery?.reviewer);
  }
  private checks(s: State, p: Native): boolean {
    const rollup = JSON.parse(this.deps.run('gh', ['pr', 'view', String(p.number), '--repo', s.repository, '--json', 'statusCheckRollup'], this.cwd));
    if (!Array.isArray(rollup.statusCheckRollup)) clientFail('local_fast_checks', 'Cannot read native GitHub check status.');
    return rollup.statusCheckRollup.every((c: Native) => c.__typename === 'StatusContext' ? c.state === 'SUCCESS' : c.__typename === 'CheckRun' && c.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion));
  }
  private async select(s: State, advance: boolean): Promise<Native> {
    const completed: number[] = [];
    for (const number of s.issues) {
      const t = s.tasks.find(t => t.issue === number);
      if (!t) {
        if (this.issue(s, number).state !== 'open') clientFail('local_fast_issue', 'Next Issue is closed without a recorded merged candidate.');
        const base = this.main(s), branch = `codex/local-fast-${number}`;
        if (!advance) return result('READY', { repository: s.repository, issue: number, branch, base_sha: base, completed });
        this.git(['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
        if (this.git(['rev-parse', 'origin/main']) !== base || this.main(s) !== base) clientFail('local_fast_main_changed', 'main changed while fetching; run flow next again.');
        if (this.git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]) || this.git(['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])) clientFail('local_fast_branch_conflict', 'An unrecorded Issue branch exists; preserve it.');
        const task: Task = { issue: number, branch, base, worktree: join(s.root, '.handoff', 'local-fast', `issue-${number}`), phase: 'preparing' };
        if (this.prs(s, task).length) clientFail('local_fast_pr_conflict', 'An unrecorded PR exists for the next Issue branch.');
        s.tasks.push(task); this.save(s); mkdirSync(join(s.root, '.handoff', 'local-fast'), { recursive: true });
        this.git(['worktree', 'add', '-b', branch, task.worktree, base]);
        this.declareQueue(task.worktree,s); task.phase = 'developing'; this.save(s);
        return this.ready(s, task, completed);
      }
      if (t.phase === 'preparing') {
        if (!advance) return result('PREPARING', { issue: number, worktree: t.worktree });
        if (!existsSync(join(t.worktree, '.git'))) clientFail('local_fast_interrupted_prepare', 'Worktree preparation was interrupted before a complete worktree existed; preserve the reserved branch and state.');
        const prepared = inspectRepository(t.worktree);
        if (prepared.repository !== s.repository || prepared.ref !== t.branch || prepared.sha !== t.base ||
            resolve(prepared.root, this.git(['rev-parse', '--git-common-dir'], prepared.root)) !== this.common)
          clientFail('local_fast_interrupted_prepare', 'The interrupted worktree differs from the reserved Issue; preserve it.');
        this.declareQueue(t.worktree,s); t.phase = 'developing'; this.save(s);
        return this.ready(s, t, completed);
      }
      const candidates = t.pr ? [this.api(`repos/${s.repository}/pulls/${t.pr}`)] : this.prs(s, t);
      if (candidates.length > 1) clientFail('local_fast_pr_conflict', 'Multiple native PRs exist for one Issue branch.');
      if (!candidates.length) {
        if (t.phase === 'completed' || t.phase === 'awaiting_review') clientFail('local_fast_pr_missing', 'The recorded PR is unavailable.');
        return t.phase === 'publishing' ? result('PUBLISHING', { issue: number, worktree: t.worktree, next_action: 'RESUME_SAME_STAGE' }) : this.ready(s, t, completed);
      }
      const p = this.pr(s, t, candidates[0]!);
      if (t.head !== p.head.sha && t.pending_head !== p.head.sha) clientFail('local_fast_head_changed', 'Remote candidate changed; preserve and reconcile the same PR.');
      if (t.phase === 'publishing' && (p.head.sha !== t.pending_head || !p.draft)) return result('PUBLISHING', { issue: number, worktree: t.worktree, next_action: 'RESUME_SAME_STAGE' });
      const review = this.review(s, p), ci = this.checks(s, p);
      if (p.merged_at) {
        if (review?.decision !== 'PASS' || !ci) clientFail('local_fast_merge_gate', 'Merged candidate lacks an exact-head native approval/Local Fast comment PASS or passing GitHub checks.');
        if (advance && t.phase !== 'completed') { t.pr = p.number; t.head = p.head.sha; delete t.pending_head; t.phase = 'completed'; this.save(s); }
        completed.push(number); continue;
      }
      if (p.state === 'closed' || t.phase === 'completed') clientFail('local_fast_closed_pr', 'PR was closed without merge or completed history changed.');
      if (advance && (!t.pr || t.phase === 'publishing')) { t.pr = p.number; t.head = p.head.sha; delete t.pending_head; t.phase = 'awaiting_review'; this.save(s); }
      return result(review?.decision === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES' : 'AWAITING_REVIEW', { issue: number, branch: t.branch, worktree: t.worktree,
        head: p.head.sha, pr_url: p.html_url, review, github_checks_passed: ci, completed, next_action: 'AWAITING_INDEPENDENT_REVIEW',
        ...(review?.decision === 'REQUEST_CHANGES' ? { instructions: ['Repair this same PR in the returned worktree, then execute Stage again. The new HEAD requires a fresh Review; only Human-authorized actual merge permits the next Issue.'] } : {}) });
    }
    return result('QUEUE_COMPLETED', { repository: s.repository, completed });
  }
  private ready(s: State, t: Task, completed: number[]): Native {
    return result('READY', { repository: s.repository, issue: t.issue, issue_url: `https://github.com/${s.repository}/issues/${t.issue}`, branch: t.branch,
      base_sha: t.base, worktree: t.worktree, completed, verification_commands: s.checks, delivery_entry: 'awh local-fast stage execute --title <title> --body <UTF8-file> --message <commit-message>',
      instructions: ['Work in the returned Issue worktree. Read the ordinary Issue and implement only its scope.',
        'Run necessary focused checks; stage execute commits changes, verifies the clean final HEAD, pushes and creates or updates this Issue’s Draft PR.',
        'Stop for ChatGPT independent Review. Fix this same PR after Request Changes. Never approve or merge it.',
        'After Human merge, flow next verifies native exact-head Review/checks and fetches latest main for the next queued Issue. No administrator policy, SHA, digest or launcher is required.'] });
  }
  async flow(advance = false) {
    const run = async () => {
      const s = this.load();
      if (s.delivery && !same((await this.deps.app.preflight(s.repository)).binding, s.delivery)) clientFail('local_fast_app_binding', 'Live App binding changed.');
      return this.select(s, advance);
    };
    return advance ? this.locked(run) : run();
  }
  prepare(): Native {
    const s = this.load(), identity = inspectRepository(this.cwd), t = s.tasks.find(t => t.phase !== 'completed');
    if (!t || identity.root !== t.worktree || identity.ref !== t.branch || t.phase === 'preparing') clientFail('local_fast_stage_scope', 'Use flow next, then enter its active Issue worktree.');
    return { ...this.ready(s, t, s.tasks.filter(t => t.phase === 'completed').map(t => t.issue)), issue_details: this.issue(s, t.issue) };
  }
  async execute(options: { title: string; body: string; message: string; checks?: string[] }): Promise<Native> {
    if (![options.title, options.message].every(v => typeof v === 'string' && !!v.trim() && v.length <= 256) || typeof options.body !== 'string' || options.body.length > 16000 || /AWH-HANDOFF|Builder evidence/.test(options.body))
      clientFail('local_fast_arguments', 'Use a bounded title, commit message and ordinary PR body; formal Builder artifacts are unavailable in Local Fast.');
    const extra = options.checks ?? []; extra.forEach(checkCommand);
    return this.locked(async () => {
      const s = this.load(), identity = inspectRepository(this.cwd), t = s.tasks.find(t => t.phase !== 'completed');
      if (!t || identity.root !== t.worktree || identity.ref !== t.branch || t.phase === 'preparing') clientFail('local_fast_stage_scope', 'Execute only in the current queued Issue worktree.');
      if (this.issue(s, t.issue).state !== 'open') clientFail('local_fast_issue', 'The active Issue must remain open.');
      const candidates = t.pr ? [this.api(`repos/${s.repository}/pulls/${t.pr}`)] : this.prs(s, t);
      if (candidates.length > 1) clientFail('local_fast_pr_conflict', 'Multiple candidate PRs exist.');
      const previous = candidates[0] ? this.pr(s, t, candidates[0]) : undefined;
      if (previous && (previous.merged_at || previous.state !== 'open' || previous.head.sha !== t.head && previous.head.sha !== t.pending_head)) clientFail('local_fast_pr_changed', 'Candidate is merged, closed or has an unexpected head.');
      this.git(['merge-base', '--is-ancestor', t.base, 'HEAD']);
      if (identity.dirty) { this.git(['add', '--all']); this.git(['diff', '--cached', '--check']); this.git(['commit', '-m', options.message]); }
      const final = inspectRepository(this.cwd);
      if (final.dirty || final.sha === t.base) clientFail('local_fast_candidate', 'A clean committed Issue candidate is required.');
      const exact = () => { if (!same(inspectRepository(this.cwd), final)) clientFail('local_fast_exact_head', 'Candidate changed during verification/publication.'); };
      const logs: VerificationLog[] = [], commands = [...new Set([...s.checks, ...extra])];
      const folder = join(s.root, '.handoff', 'local-fast', 'checks'); mkdirSync(folder, { recursive: true });
      for (const command of commands) {
        exact(); const log = await this.deps.verify(command, final.root); logs.push(log);
        writeFileSync(join(folder, `${t.issue}-${final.sha}.json`), JSON.stringify({ mode: 'local-fast', head: final.sha, logs }, null, 2));
        if (log.exit_code !== 0) clientFail('local_fast_verification', 'Focused verification failed; the local commit and raw logs are retained, no push occurred.');
        exact();
      }
      this.identity(s.repository, s.repository_id, s.owner); exact();
      const app: AppDelivery | undefined = s.delivery ? await this.deps.app.preflight(s.repository) : undefined;
      if (app && !same(app.binding, s.delivery)) clientFail('local_fast_app_binding', 'Live App identity differs.');
      const remote = this.git(['ls-remote', '--heads', 'origin', `refs/heads/${t.branch}`]).split(/\s/)[0];
      if (remote && remote !== final.sha && remote !== t.head && remote !== t.pending_head) clientFail('local_fast_remote_conflict', 'Remote branch changed outside this recorded candidate; no force push is allowed.');
      t.pending_head = final.sha; t.phase = 'publishing';
      if (s.delivery) { t.coding_executor = { type: 'codex-cli' }; t.delivery_actor = { ...s.delivery.delivery_actor }; }
      this.save(s); exact();
      if (remote !== final.sha) {
        if (app) await app.push(final.root, t.branch, final.sha);
        else this.git(['push', '--set-upstream', 'origin', `HEAD:refs/heads/${t.branch}`]);
      }
      const readback = this.api(`repos/${s.repository}/git/ref/heads/${t.branch}`);
      if (readback.object?.sha !== final.sha) clientFail('local_fast_push_readback', 'Pushed branch head was not confirmed; resume this same Stage.');
      exact();
      const prs = app ? await app.pulls(t.branch) : this.prs(s, t);
      if (prs.length > 1) clientFail('local_fast_pr_conflict', 'Multiple native PRs exist.');
      const deliveryText = s.delivery ? `Delivery Provider: github-app; Coding Executor: codex-cli; Delivery Actor: ${s.delivery.delivery_actor.login} (${s.delivery.delivery_actor.id}, Bot). Trusted Reviewer: ${s.delivery.reviewer.login} (${s.delivery.reviewer.id}, User). Only native APPROVED/CHANGES_REQUESTED on the current HEAD counts; COMMENTED never opens this gate.` : 'ordinary GitHub identity';
      const body = `${marker(s, t.issue)}\nLocal Fast: ${deliveryText}, local verification only. Independent Review pending.\n\nCloses #${t.issue}\n\n${options.body}\n\n## Independent Review delivery\n\n${s.delivery ? 'Read the exact GitHub HEAD independently and publish a native APPROVE or REQUEST_CHANGES using the saved trusted personal Reviewer. Read back Review ID, reviewer id/login/type, state and commit_id. Keep the existing Owner queue and merge scope.' : REVIEW_DELIVERY_INSTRUCTIONS}`;
      const bodyFile = join(folder, `issue-${t.issue}-pr-body.md`); writeFileSync(bodyFile, body);
      if (prs[0]) {
        const p = this.pr(s, t, prs[0]);
        if (p.state !== 'open' || p.merged_at || p.head.sha !== final.sha) clientFail('local_fast_pr_changed', 'Cannot update a changed or closed PR.');
        t.pr = p.number; this.save(s);
        if (app) await app.update(p.number, options.title, body);
        else {
          if (!p.draft) this.deps.run('gh', ['pr', 'ready', String(p.number), '--repo', s.repository, '--undo'], this.cwd);
          this.deps.run('gh', ['pr', 'edit', String(p.number), '--repo', s.repository, '--title', options.title, '--body-file', bodyFile], this.cwd);
        }
      } else {
        if (app) {
          if (t.create_attempted) clientFail('local_fast_pr_ack_unknown', 'A prior create may have reached GitHub. Read back this same branch; absence cannot authorize automatic replay. Preserve the candidate.');
          t.create_attempted = true; this.save(s);
          await app.create(t.branch, options.title, body);
        } else this.deps.run('gh', ['pr', 'create', '--repo', s.repository, '--base', 'main', '--head', t.branch, '--title', options.title, '--body-file', bodyFile, '--draft'], this.cwd);
      }
      const confirmed = app ? await app.pulls(t.branch) : this.prs(s, t);
      if (confirmed.length !== 1) clientFail('local_fast_pr_readback', 'Draft PR was not confirmed; preserve state and resume this same Stage.');
      const p = this.pr(s, t, confirmed[0]!);
      if (!p.draft || p.state !== 'open' || p.head.sha !== final.sha) clientFail('local_fast_pr_readback', 'Native exact-head Draft PR was not confirmed.');
      exact(); t.pr = p.number; t.head = final.sha; delete t.pending_head; t.phase = 'awaiting_review'; this.save(s);
      return result('awaiting_review', { issue: t.issue, pr_url: p.html_url, head: final.sha, coding_executor: { type: 'codex-cli' }, delivery_provider: s.delivery ? 'github-app' : 'personal-gh', delivery_actor: s.delivery?.delivery_actor ?? s.owner, local_verification_file: join(folder, `${t.issue}-${final.sha}.json`), next_action: 'AWAITING_INDEPENDENT_REVIEW' });
    });
  }
}
