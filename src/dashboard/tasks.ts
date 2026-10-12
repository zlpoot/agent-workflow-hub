import type { DashboardReadView } from '../control-plane/store.js';
import { selectReview } from '../workflow/local-fast-review.js';
import { createHash } from 'node:crypto';
import { standardReviewGate } from './review-authorization.js';

export const TASK_STATES = ['queued','ready','developing','verifying','awaiting_review','changes_requested','review_passed','awaiting_merge','merging','completed','blocked','unknown'] as const;
export type TaskState = typeof TASK_STATES[number];
export type Role = 'coding_executor' | 'reviewer' | 'owner' | 'stage' | 'watcher';
export interface Actor { role: Role; name: string }
export interface Observation {
  source: 'control_plane' | 'local_fast' | 'github' | 'owner_scope' | 'watcher';
  status: 'verified' | 'unknown' | 'not_checked' | 'permission_denied';
  observed_at: string | null; freshness: 'fresh' | 'stale' | 'unknown'; error_code: string | null;
}
export interface GitHubRefresh { status:'not_checked'|'querying'|'success'|'failed'|'rate_limited'; last_success_at:string|null; retry_at:string|null; interval_seconds:0|60|300 }
export interface ObservationOptions { github_interval_seconds?:0|60|300; refresh_github?:boolean }
export interface Task {
  id: string; project_id: string; repository: string; workflow: 'standard' | 'local-fast'; fixture: boolean;
  issue: { number: number; title: string | null; state: 'open' | 'closed' | null };
  pr: { number: number; state: 'open' | 'closed' | null; draft: boolean | null; merged_at: string | null; merge_sha: string | null } | null;
  state: TaskState; active_actor: Actor | null; waiting_for: Actor | null; machine: { id: string; name: string; platform: string } | null;
  executor: string | null; run_ids: string[]; source_head: string | null; github_head: string | null;
  review: { id: number; state: string; commit_id: string; actor: string; decision: 'PASS' | 'REQUEST_CHANGES' | null; matches_head: boolean } | null;
  review_gate: { status:'passed'|'changes_requested'|'pending'|'not_checked'|'stale'; source:'administrator_policy'|'local_fast_contract'|'not_checked'; reason:string };
  github_refresh:GitHubRefresh;
  checks: { status: 'passed' | 'pending' | 'failed' | 'not_checked' | 'none'; count: number };
  stage: { head: string | null; status: 'passed' | 'failed' | 'not_checked'; checks: { name: string; exit_code: number }[] };
  watcher: { status: string; running: boolean | null; executor_running: boolean | null; stale_lock: boolean | null };
  owner_scope: { status: 'valid' | 'expired' | 'not_checked'; expires_at: string | null; allow_merge: boolean | null };
  next_action: string; blockers: string[]; updated_at: string | null; observations: Observation[];
  history: { source: string; type: string; occurred_at: string | null; observed_at: string; head: string | null; run_id: string | null }[];
}
export interface TaskAdapter { observe(projectIds: readonly string[], managedTasks?: readonly Task[],options?:ObservationOptions): Promise<Task[]> }
export const actor = (role: Role, name: string): Actor => ({ role, name });
export const observation = (source: Observation['source'], now: number, status: Observation['status'] = 'verified'): Observation =>
  ({ source, status, observed_at: new Date(now).toISOString(), freshness: status === 'verified' ? 'fresh' : 'unknown', error_code: null });
export function taskBase(id: string, project: string, repository: string, issue: number): Task {
  if(id.length>128)id='task:'+createHash('sha256').update(id).digest('hex');
  return { id, project_id: project, repository, workflow: 'standard', fixture: false, issue: { number: issue, title: null, state: null }, pr: null,
    state: 'queued', active_actor: null, waiting_for: actor('coding_executor','Coding Executor'), machine: null, executor: null, run_ids: [],
    source_head: null, github_head: null, review: null, review_gate:{status:'not_checked',source:'not_checked',reason:'Review Gate 尚未核验'},github_refresh:{status:'not_checked',last_success_at:null,retry_at:null,interval_seconds:300},checks: { status: 'not_checked', count: 0 }, stage: { head: null, status: 'not_checked', checks: [] },
    watcher: { status: 'not_checked', running: null, executor_running: null, stale_lock: null }, owner_scope: { status: 'not_checked', expires_at: null, allow_merge: null },
    next_action: '等待 Coding Executor 领取任务', blockers: [], updated_at: null, observations: [], history: [] };
}
/** CP declarations retain their provenance; no runtime completion or PASS becomes a native GitHub fact. */
export function controlPlaneTasks(view: DashboardReadView, now: number): Task[] {
  return view.work_items.map(work => {
    const task = taskBase(`cp:${work.id}`, work.project_id, work.reference.repository, work.reference.number);
    const runs = view.runs.filter(run => run.work_item_id === work.id).sort((a,b) => a.updated_at.localeCompare(b.updated_at));
    task.run_ids = runs.map(run => run.id);
    const run = runs.at(-1);
    task.observations = [observation('control_plane',now), { source:'github',status:'not_checked',observed_at:null,freshness:'unknown',error_code:null }];
    if (!run) return task;
    task.source_head = run.source.sha; task.updated_at = run.updated_at;
    const executor = view.executors.find(e => e.executor.id === run.executor_id);
    task.executor = executor?.executor.display_name ?? run.executor_id;
    task.machine = { id:run.machine_id,name:executor?.client?.machine_name ?? run.machine_id,platform:executor?.executor.machine.platform ?? 'unknown' };
    const events = view.events.filter(e => e.event.run_id === run.id).map(e => e.event);
    for (const event of events) {
      task.history.push({source:'control_plane',type:event.type,occurred_at:event.occurred_at,observed_at:new Date(now).toISOString(),head:run.source.sha,run_id:run.id});
      const data = event.payload.data;
      if ('pull_request' in data) task.pr = {number:data.pull_request.number,state:null,draft:null,merged_at:null,merge_sha:null};
      if ('head_sha' in data) task.source_head = data.head_sha;
      if ('new_head' in data) task.source_head = data.new_head;
      if ('checks' in data && 'subject_sha' in data) task.stage = {head:data.subject_sha,status:event.type === 'VERIFICATION_PASSED' ? 'passed' : 'failed',checks:data.checks.map(c => ({name:c.command,exit_code:c.exit_code}))};
      if ('checks' in data && 'new_head' in data) task.stage={head:data.new_head,status:data.checks.every(c=>c.exit_code===0)?'passed':'failed',checks:data.checks.map(c=>({name:c.command,exit_code:c.exit_code}))};
    }
    const fresh = executor && now - Date.parse(executor.last_seen) >= 0 && now - Date.parse(executor.last_seen) <= 60000;
    if (run.state === 'running' || run.state === 'verifying') {
      task.state = fresh && run.started_at ? run.state === 'running' ? 'developing' : 'verifying' : 'unknown';
      if (task.state !== 'unknown') task.active_actor = actor(run.state === 'running' ? 'coding_executor' : 'stage',run.state === 'running' ? task.executor : 'AWH Stage');
      task.waiting_for = null; task.next_action = fresh ? '等待当前执行完成' : '重新核验执行器在线状态';
      if (!fresh) task.observations[0]!.freshness = 'stale';
    } else if (run.state === 'awaiting_review' || run.state === 'reviewing' || run.state === 'review_passed') {
      task.state = 'awaiting_review'; task.waiting_for = actor('reviewer','独立 Reviewer'); task.next_action = '核验当前 GitHub HEAD 的原生 Review';
      // Only an explicit REVIEW_STARTED and live reviewer presence prove active review.
      const started = [...events].reverse().find(e => e.type === 'REVIEW_STARTED');
      if (run.state === 'reviewing' && started?.type === 'REVIEW_STARTED' && started.payload.data.subject_sha===task.source_head) {
        const reviewer = view.executors.find(e => e.executor.id === started.payload.data.reviewer_executor_id);
        if (reviewer && now - Date.parse(reviewer.last_seen) >= 0 && now - Date.parse(reviewer.last_seen) <= 60000) task.active_actor = actor('reviewer',reviewer.executor.display_name);
      }
    } else if (run.state === 'failed') {
      task.state = 'blocked'; task.waiting_for = actor('owner','Owner'); task.blockers.push('CP 记录运行失败；请查看运行时间线'); task.next_action = 'Owner 检查失败并决定恢复';
    } else if (run.state === 'completed') {
      task.state = 'unknown'; task.waiting_for = actor('owner','Owner'); task.next_action = '核验 GitHub Merge 与 Issue CLOSED';
    } else task.state = 'ready';
    return task;
  });
}

export interface GitHubFacts {
  issue: { number: number; title: string; state: string; pull_request?: unknown };
  pr?: { number: number; state: string; draft: boolean; merged_at: string | null; merge_commit_sha: string | null; head: { sha: string; repo: { full_name: string } }; base: { repo: { full_name: string } }; user: { id: number;login?:string } };
  reviews?: Record<string, any>[];
  checks?: Task['checks'];
}
export function applyGitHub(task: Task, facts: GitHubFacts, now: number) {
  if (facts.issue.number !== task.issue.number || facts.issue.pull_request || !['open','closed'].includes(facts.issue.state)) throw new Error('Issue identity mismatch');
  task.issue = {number:facts.issue.number,title:facts.issue.title,state:facts.issue.state as 'open'|'closed'};
  const p = facts.pr;
  if (p) {
    if (p.number !== task.pr?.number || p.head.repo.full_name !== task.repository || p.base.repo.full_name !== task.repository || !/^[a-f0-9]{40}$/.test(p.head.sha) || !['open','closed'].includes(p.state) || typeof p.draft!=='boolean' || p.merged_at!==null&&!Number.isFinite(Date.parse(p.merged_at)) || p.merge_commit_sha!==null&&!/^[a-f0-9]{40}$/.test(p.merge_commit_sha)) throw new Error('PR identity mismatch');
    task.pr = {number:p.number,state:p.state as 'open'|'closed',draft:p.draft,merged_at:p.merged_at,merge_sha:p.merge_commit_sha}; task.github_head = p.head.sha;
    if(task.active_actor?.role==='reviewer'&&task.source_head!==p.head.sha)task.active_actor=null;
    const reviews = facts.reviews ?? [];
    if(!reviews.every(r=>Number.isSafeInteger(r.id)&&r.id>0&&Number.isSafeInteger(r.user?.id)&&r.user.id>0&&typeof r.user.login==='string'&&/^[a-f0-9]{40}$/.test(r.commit_id)&&['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING'].includes(r.state)))throw new Error('Invalid native Review facts');
    // Structured author COMMENTED records are a Local Fast contract only.
    const authorization=task.workflow==='standard'&&typeof p.user.login==='string'?standardReviewGate(task.repository,reviews,p.user.login,p.head.sha):null;
    const strict=authorization?.selected;
    const selected = task.workflow==='local-fast'?selectReview(reviews,p.user.id,p.head.sha):strict?{review_id:strict.review.id,decision:strict.decision}:undefined;
    task.review_gate={status:selected?.decision==='PASS'?'passed':selected?'changes_requested':task.workflow==='standard'&&!authorization?'not_checked':'pending',source:task.workflow==='local-fast'?'local_fast_contract':authorization?'administrator_policy':'not_checked',reason:selected?'已依据身份与原生 Review 核验':task.workflow==='standard'&&reviews.length?authorization?'身份条件已核验；没有当前有效的授权 Review 决定':'GitHub 已观察到 Review，但授权未核验':'等待当前 HEAD 的受信 Review'};
    if(task.source_head&&task.source_head!==p.head.sha){task.review_gate.status='stale';task.review_gate.reason='源码 HEAD 与 GitHub HEAD 不一致；历史 Review 不适用于当前候选';}
    const r = selected ? reviews.find(r => r.id === selected.review_id) : reviews.filter(r => r.state !== 'PENDING').sort((a,b)=>a.id-b.id).at(-1);
    if (r) {
      if(!['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED'].includes(r.state))throw new Error('Invalid native Review state');
      task.review = {id:r.id,state:r.state,commit_id:r.commit_id,actor:r.user.login,decision:selected?.decision ?? null,matches_head:r.commit_id === p.head.sha};
    }
    task.checks = facts.checks ?? {status:'not_checked',count:0};
    if (p.merged_at && facts.issue.state === 'closed') {
      task.state = 'completed'; task.active_actor = task.waiting_for = null; task.blockers = []; task.next_action = '已完成：GitHub Merge 与 Issue CLOSED 已核实';
    } else if (p.merged_at || p.state === 'closed') {
      task.state = 'blocked'; task.active_actor = null; task.waiting_for = actor('owner','Owner'); task.blockers.push(p.merged_at ? 'PR 已合并，但 Issue 尚未关闭' : 'PR 已关闭但未合并'); task.next_action = 'Owner 核对 PR 与 Issue 状态';
    } else if (task.source_head && task.source_head !== p.head.sha && !task.active_actor) {
      task.state = 'blocked'; task.waiting_for = actor('coding_executor','Coding Executor'); task.blockers.push('HEAD 漂移：本机源码与 GitHub HEAD 不一致，旧 PASS 不再有效'); task.next_action = '核对新 HEAD 并重新验证、独立 Review';
    } else if(task.stage.status==='failed'&&task.stage.head===p.head.sha) {
      task.state='blocked';task.active_actor=null;task.waiting_for=actor('coding_executor','Coding Executor');task.blockers.push('当前 HEAD 的 Stage 验证失败');task.next_action='修复 Stage 验证失败后重新交付同一 PR';
    } else if(task.state==='blocked'&&task.observations.some(o=>o.source==='control_plane')) {
      task.active_actor=null;task.waiting_for=actor('owner','Owner');task.next_action='Owner 检查 CP 失败并决定恢复';
    } else if (selected?.decision === 'REQUEST_CHANGES') {
      task.state = task.active_actor?.role === 'coding_executor' ? 'developing' : 'changes_requested'; task.waiting_for = task.active_actor ? null : actor('coding_executor','Coding Executor'); task.next_action = '在同一 PR 修复 Review 意见';
    } else if (selected?.decision === 'PASS' && !task.active_actor) {
      task.state = ['passed','none'].includes(task.checks.status) ? 'awaiting_merge' : 'review_passed';
      task.waiting_for = task.owner_scope.status === 'valid' && task.owner_scope.allow_merge ? actor('watcher','AWH Watcher') : actor('owner','Owner');
      task.next_action = ['passed','none'].includes(task.checks.status) ? '等待获授权的合并责任方处理' : 'Review 已通过；等待核验 GitHub checks';
      if (task.checks.status === 'failed') {task.state='blocked';task.blockers.push('GitHub checks 失败');task.waiting_for=actor('coding_executor','Coding Executor');task.next_action='修复失败的 GitHub checks';}
    } else if (!task.active_actor) {
      task.state='awaiting_review';task.waiting_for=task.workflow==='standard'&&reviews.length&&!authorization?actor('owner','Owner'):actor('reviewer',task.workflow === 'local-fast' ? 'ChatGPT Reviewer' : '独立 Reviewer');task.next_action=task.workflow==='standard'&&reviews.length?authorization?'等待授权 Reviewer 对当前 HEAD 提交有效 Review':'GitHub 已观察到 Review，但授权未核验；核对管理员 Reviewer 策略':'等待当前 HEAD 的独立原生 GitHub Review';
    }
  }
  task.updated_at = new Date(now).toISOString();
  task.observations = task.observations.filter(o=>o.source!=='github').concat(observation('github',now));
}
