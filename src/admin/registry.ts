import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { externalPath, readExternalFile } from '../shared/external-files.js';
import { safeData } from '../shared/security.js';

export class AdminError extends Error {
  constructor(readonly code: string) { super('Administrator authorization refused: ' + code); }
}
export function deny(code: string): never { throw new AdminError(code); }
export const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const encode = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
export const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);
export const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function closed(value: any, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) deny('schema');
}
export function parse(bytes: Buffer): any {
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); safeData(value); return value; }
  catch { return deny('schema'); }
}
export function read(path: string): Buffer {
  try { return readExternalFile(path, 64 * 1024, true); } catch { return deny('external_source'); }
}
export interface Actor { login: string; id: number }
export function actor(value: any): void {
  closed(value, ['login','id']);
  if (typeof value.login !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value.login) || !Number.isSafeInteger(value.id) || value.id < 1) deny('operator');
}
export interface Trust {
  schema_version: '1.0'; kind: 'admin_trust'; registry_root: string; operator: Actor;
  installation_sha256: string; host: string;
}
export interface Task {
  repository: string; issue: number; branch: string; base_sha: string; head_sha: string | null;
  profile: string; workflow: string; executor_id: string; machine_id: string; expires_at: string;
  stages: Stage[]; provider_operations: ProviderOperation[];
  revision?: RevisionAuthorization;
  verification_recovery?: VerificationRecoveryAuthorization;
}
export interface VerificationRecoveryAuthorization { original_version: string; run_id: string; previous_head: string }
export interface RevisionAuthorization {
  original_version: string; run_id: string; pull_request: number; previous_head: string; review_id: number;
}
export type Stage = 'observe' | 'develop' | 'deliver';
export type ProviderOperation = 'push' | 'draft_pr' | 'evidence' | 'handoff';
export interface ProjectPolicy {
  builder_policy: any; stages: Stage[];
  permissions: { contents: 'read' | 'write'; issues: 'read' | 'write'; pull_requests: 'read' | 'write' };
}
export interface Proposal {
  schema_version: '1.0'; kind: 'admin_proposal'; version: string; action: 'project' | 'grant' | 'revoke';
  expected_state_sha256: string | null; policy: unknown | null; task: Task | null;
  target_version: string | null; policy_version: string | null;
}
export interface Approval {
  schema_version: '1.0'; kind: 'admin_approval'; id: string; operator: Actor;
  proposal_sha256: string; expected_state_sha256: string | null;
  approved_at: string; expires_at: string; reason: string;
}
export interface Entry {
  version: string; action: 'project' | 'grant' | 'revoke'; proposal_sha256: string;
  approval_sha256: string; policy_sha256: string | null; target_version: string | null;
}
export interface State {
  schema_version: '1.0'; kind: 'admin_state'; generation: number;
  previous_state_sha256: string | null; entries: Entry[]; receipt_ids: string[];
}
export function proposal(value: any): Proposal {
  closed(value, ['schema_version','kind','version','action','expected_state_sha256','policy','task','target_version','policy_version']);
  if (value.schema_version !== '1.0' || value.kind !== 'admin_proposal' || !id(value.version) ||
      !['project','grant','revoke'].includes(value.action) || value.expected_state_sha256 !== null && !hash(value.expected_state_sha256)) deny('schema');
  if (value.action === 'revoke') {
    if (value.policy !== null || value.task !== null || value.policy_version !== null || !id(value.target_version)) deny('schema');
  } else if (value.action === 'project') {
    if (value.task !== null || value.target_version !== null || value.policy_version !== null) deny('schema');
    projectPolicy(value.policy);
  } else {
    const task = value.task;
    closed(task, ['repository','issue','branch','base_sha','head_sha','profile','workflow','executor_id','machine_id','expires_at','stages','provider_operations', ...(task?.revision !== undefined ? ['revision'] : []), ...(task?.verification_recovery !== undefined ? ['verification_recovery'] : [])]);
    if (task.verification_recovery !== undefined) {
      closed(task.verification_recovery,['original_version','run_id','previous_head']);
      const r = task.verification_recovery;
      if (task.revision || !id(r.original_version) || r.original_version === value.version || !/^run-[a-f0-9-]{36}$/.test(r.run_id) ||
          !sha(r.previous_head) || !sha(task.head_sha) || task.head_sha === r.previous_head || !Array.isArray(task.stages) || !task.stages.includes('deliver')) deny('verification_recovery_scope');
    }
    if (task.revision !== undefined) {
      closed(task.revision,['original_version','run_id','pull_request','previous_head','review_id']);
      const r = task.revision;
      if (!id(r.original_version) || !/^run-[a-f0-9-]{36}$/.test(r.run_id) || !sha(r.previous_head) || !sha(task.head_sha) || task.head_sha === r.previous_head ||
          ![r.pull_request,r.review_id].every(v => Number.isSafeInteger(v) && v > 0) || task.provider_operations.includes('draft_pr')) deny('revision_scope');
    }
    if (!sha(task.base_sha) || task.head_sha !== null && (!sha(task.head_sha) || task.base_sha === task.head_sha) || !timestamp(task.expires_at) ||
        ![task.profile,task.workflow,task.executor_id,task.machine_id].every(id) || !Number.isSafeInteger(task.issue) || task.issue < 1 ||
        typeof task.repository !== 'string' || typeof task.branch !== 'string' || value.target_version !== null || value.policy !== null || !id(value.policy_version) ||
        !subset(task.stages,['observe','develop','deliver'],false) || !subset(task.provider_operations,['push','draft_pr','evidence','handoff'],true) ||
        !task.stages.includes('deliver') && task.provider_operations.length) deny('schema');
  }
  return value;
}
function subset(value: any, allowed: string[], empty: boolean): boolean {
  return Array.isArray(value) && (empty || value.length > 0) && value.length <= allowed.length && new Set(value).size === value.length && value.every(v => allowed.includes(v));
}
export function projectPolicy(value: any): ProjectPolicy {
  closed(value,['builder_policy','stages','permissions']); closed(value.permissions,['contents','issues','pull_requests']);
  if (!value.builder_policy || !subset(value.stages,['observe','develop','deliver'],false) || !Object.values(value.permissions).every(v => ['read','write'].includes(v as string)) ||
      !value.stages.includes('deliver') && Object.values(value.permissions).includes('write')) deny('project_scope');
  return value;
}
/** Derive a bounded fixed Builder view from two independently approved records. No new authority. */
export function materialize(project: ProjectPolicy, task: Task, version: string): any {
  const template = project.builder_policy, selected = template.profiles.find((p: any) => p.id === task.profile), workflow = selected?.workflows.find((w: any) => w.id === task.workflow);
  if (!selected || !workflow || selected.repository !== task.repository || workflow.work_item.repo !== task.repository ||
      !workflow.executor_restrictions.executor_ids.includes(task.executor_id) || !workflow.executor_restrictions.machine_ids.includes(task.machine_id) ||
      !task.stages.every(stage => project.stages.includes(stage)) ||
      task.provider_operations.some(operation => project.permissions[operation === 'push' ? 'contents' : 'pull_requests'] !== 'write') ||
      (workflow.branch_mode === 'issue_prefix' ? task.branch !== workflow.branch + task.issue : task.branch !== workflow.branch || task.issue !== workflow.work_item.issue)) deny('task_scope');
  return { ...template, default_selection: { profile: task.profile, workflow: task.workflow }, profiles: [{ ...selected, workflows: [{ ...workflow,
    version: task.revision?.original_version ?? version, branch: task.branch, branch_mode: 'fixed', work_item: { repo: task.repository, issue: task.issue },
    executor_restrictions: { executor_ids: [task.executor_id], machine_ids: [task.machine_id] } }] }] };
}
export function approval(value: any, trust: Trust, expectedProposal: string, expectedState: string | null, now: string, requireFresh: boolean): Approval {
  closed(value, ['schema_version','kind','id','operator','proposal_sha256','expected_state_sha256','approved_at','expires_at','reason']);
  actor(value.operator);
  if (value.schema_version !== '1.0' || value.kind !== 'admin_approval' || !id(value.id) ||
      encode(value.operator) !== encode(trust.operator) || value.proposal_sha256 !== expectedProposal || value.expected_state_sha256 !== expectedState ||
      !timestamp(value.approved_at) || !timestamp(value.expires_at) || value.approved_at > now || value.expires_at <= value.approved_at ||
      Date.parse(value.expires_at) - Date.parse(value.approved_at) > 86400000 || requireFresh && value.expires_at <= now ||
      typeof value.reason !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(value.reason)) deny('approval');
  return value;
}
export function trustContext(env: NodeJS.ProcessEnv = process.env): { trust: Trust; trustFile: string; trustPin: string } {
  const trustFile = env.AWH_ADMIN_TRUST_FILE, trustPin = env.AWH_ADMIN_TRUST_SHA256;
  if (!trustFile || !hash(trustPin)) deny('independent_trust_pin_required');
  const bytes = read(trustFile); if (digest(bytes) !== trustPin) deny('trust_digest');
  const trust: Trust = parse(bytes);
  closed(trust, ['schema_version','kind','registry_root','operator','installation_sha256','host']); actor(trust.operator);
  if (trust.schema_version !== '1.0' || trust.kind !== 'admin_trust' || !hash(trust.installation_sha256) || typeof trust.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(trust.host)) deny('schema');
  if (trust.host !== hostname()) deny('host_binding');
  const root = externalPath(trust.registry_root), info = lstatSync(root);
  if (!info.isDirectory() || process.platform !== 'win32' && (info.mode & 0o077)) deny('registry_protection');
  return { trust, trustFile, trustPin };
}
export function snapshot(trust: Trust): { state: State; statePin: string | null } {
  const path = join(trust.registry_root, 'state.json');
  if (!existsSync(path)) return { state: { schema_version: '1.0', kind: 'admin_state', generation: 0, previous_state_sha256: null, entries: [], receipt_ids: [] }, statePin: null };
  const bytes = read(path), state: State = parse(bytes);
  closed(state, ['schema_version','kind','generation','previous_state_sha256','entries','receipt_ids']);
  if (state.schema_version !== '1.0' || state.kind !== 'admin_state' || !Number.isSafeInteger(state.generation) || state.generation < 1 ||
      state.previous_state_sha256 !== null && !hash(state.previous_state_sha256) || !Array.isArray(state.entries) || !Array.isArray(state.receipt_ids) ||
      state.entries.length !== state.generation || state.receipt_ids.length !== state.generation || state.generation > 128 ||
      !state.receipt_ids.every(id) || new Set(state.receipt_ids).size !== state.receipt_ids.length) deny('state');
  const versions = new Map<string, Entry>(), revoked = new Set<string>();
  for (const entry of state.entries) {
    closed(entry, ['version','action','proposal_sha256','approval_sha256','policy_sha256','target_version']);
    if (!id(entry.version) || versions.has(entry.version) || !['project','grant','revoke'].includes(entry.action) || !hash(entry.proposal_sha256) || !hash(entry.approval_sha256) ||
        (entry.action !== 'revoke' ? !hash(entry.policy_sha256) || entry.target_version !== null : entry.policy_sha256 !== null || !id(entry.target_version) || !versions.has(entry.target_version) || versions.get(entry.target_version)?.action === 'revoke' || revoked.has(entry.target_version))) deny('state');
    if (entry.action === 'revoke') revoked.add(entry.target_version!);
    versions.set(entry.version, entry);
  }
  // Immutable snapshots retain prior generations; changing old bindings is detectable.
  let previousPin: string | null = null;
  for (let generation = 1; generation <= state.generation; generation++) {
    const historicalBytes = read(join(trust.registry_root, 'state.' + generation + '.json'));
    const historical: State = parse(historicalBytes);
    closed(historical, ['schema_version','kind','generation','previous_state_sha256','entries','receipt_ids']);
    if (historical.schema_version !== '1.0' || historical.kind !== 'admin_state' || historical.generation !== generation || historical.previous_state_sha256 !== previousPin ||
        encode(historical.entries) !== encode(state.entries.slice(0,generation)) || encode(historical.receipt_ids) !== encode(state.receipt_ids.slice(0,generation))) deny('history_conflict');
    previousPin = digest(historicalBytes);
  }
  if (previousPin !== digest(bytes)) deny('history_conflict');
  return { state, statePin: digest(bytes) };
}
export function readEntry(trust: Trust, entry: Entry, receiptId: string, now: string) {
  const prefix = join(trust.registry_root, entry.version);
  const proposalBytes = read(prefix + '.proposal.json'), approvalBytes = read(prefix + '.approval.json');
  if (digest(proposalBytes) !== entry.proposal_sha256 || digest(approvalBytes) !== entry.approval_sha256) deny('record_digest');
  const proposed = proposal(parse(proposalBytes));
  if (proposed.version !== entry.version || proposed.action !== entry.action || proposed.target_version !== entry.target_version) deny('record_identity');
  const approved = approval(parse(approvalBytes), trust, entry.proposal_sha256, proposed.expected_state_sha256, now, false);
  if (approved.id !== receiptId) deny('receipt_identity');
  let policy: any = null;
  if (entry.action !== 'revoke') {
    const policyBytes = read(prefix + '.policy.json');
    if (digest(policyBytes) !== entry.policy_sha256 || entry.action === 'project' && encode(proposed.policy) !== policyBytes.toString('utf8')) deny('policy_digest');
    policy = parse(policyBytes);
    if (digest(encode(entry.action === 'project' ? projectPolicy(policy).builder_policy.installation : policy.installation)) !== trust.installation_sha256) deny('installation_scope');
  }
  return { proposed, approved, policy };
}
export function approvedProject(trust: Trust, state: State, version: string, now: string): ProjectPolicy {
  const index = state.entries.findIndex(entry => entry.version === version && entry.action === 'project');
  if (index < 0 || state.entries.some(entry => entry.target_version === version)) deny('project_unapproved_or_revoked');
  return projectPolicy(readEntry(trust,state.entries[index]!,state.receipt_ids[index]!,now).policy);
}
/** Observation uses an existing independently approved Project, never a task proposal. */
export function projectObservationContext(env: NodeJS.ProcessEnv = process.env, now = new Date().toISOString()) {
  if (!timestamp(now)) deny('clock');
  const context = trustContext(env), {state} = snapshot(context.trust), selected = env.AWH_ADMIN_VERSION;
  if (!id(selected)) deny('explicit_approved_version_required');
  const index = state.entries.findIndex(e => e.version === selected && e.action !== 'revoke');
  if (index < 0 || state.entries.some(e => e.target_version === selected)) deny('unapproved_or_revoked');
  const entry = state.entries[index]!, record = readEntry(context.trust,entry,state.receipt_ids[index]!,now);
  const version = entry.action === 'project' ? selected : record.proposed.policy_version!;
  const project = approvedProject(context.trust,state,version,now);
  if (!project.stages.includes('observe')) deny('stage_not_authorized');
  return {...context,version,project};
}
/** Revision is a new immutable grant; its original task and policy remain independently readable. */
export function revisionOriginal(trust: Trust, state: State, proposed: Proposal, now: string) {
  const task = proposed.task!, r = task.revision;
  if (!r) return null;
  const i = state.entries.findIndex(e => e.version === r.original_version && e.action === 'grant');
  if (i < 0 || state.entries.some(e => e.target_version === r.original_version)) deny('revision_original');
  const original = readEntry(trust,state.entries[i]!,state.receipt_ids[i]!,now), first = original.proposed.task!;
  if (first.revision || proposed.policy_version !== original.proposed.policy_version ||
      ['repository','issue','branch','base_sha','profile','workflow','executor_id','machine_id'].some(k => task[k as keyof Task] !== first[k as keyof Task]) ||
      !task.stages.every(s => first.stages.includes(s)) || !task.provider_operations.every(o => first.provider_operations.includes(o))) deny('revision_original');
  return original;
}
/** A fixed-HEAD failure needs a new independently approved grant, never edited history. */
export function verificationRecoveryOriginal(trust: Trust, state: State, proposed: Proposal, now: string) {
  const task = proposed.task!, r = task.verification_recovery;
  if (!r) return null;
  const i = state.entries.findIndex(e => e.version === r.original_version && e.action === 'grant');
  if (i < 0 || state.entries.some(e => e.target_version === r.original_version)) deny('verification_recovery_original');
  const original = readEntry(trust,state.entries[i]!,state.receipt_ids[i]!,now), first = original.proposed.task!;
  if (first.revision || first.head_sha !== r.previous_head || proposed.policy_version !== original.proposed.policy_version ||
      ['repository','issue','branch','base_sha','profile','workflow','executor_id','machine_id'].some(k => task[k as keyof Task] !== first[k as keyof Task]) ||
      !task.stages.every(s => first.stages.includes(s)) || !task.provider_operations.every(o => first.provider_operations.includes(o))) deny('verification_recovery_original');
  return original;
}
export function managedContext(env: NodeJS.ProcessEnv = process.env, now = new Date().toISOString()) {
  if (!env.AWH_ADMIN_TRUST_FILE && !env.AWH_ADMIN_TRUST_SHA256 && !env.AWH_ADMIN_VERSION) return null;
  if (!timestamp(now)) deny('clock');
  const context = trustContext(env), version = env.AWH_ADMIN_VERSION;
  if (!id(version)) deny('explicit_approved_version_required');
  const { state } = snapshot(context.trust), index = state.entries.findIndex(entry => entry.version === version && entry.action === 'grant');
  if (index < 0 || state.entries.some(entry => entry.action === 'revoke' && entry.target_version === version)) deny('unapproved_or_revoked');
  const record = readEntry(context.trust, state.entries[index]!, state.receipt_ids[index]!, now);
  if (record.proposed.task!.expires_at <= now) deny('task_expired');
  const project = approvedProject(context.trust,state,record.proposed.policy_version!,now);
  revisionOriginal(context.trust,state,record.proposed,now);
  verificationRecoveryOriginal(context.trust,state,record.proposed,now);
  if (encode(materialize(project,record.proposed.task!,version)) !== encode(record.policy)) deny('task_scope');
  return { ...context, version, ...record, project };
}
