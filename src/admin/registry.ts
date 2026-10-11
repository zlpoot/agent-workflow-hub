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
  repository: string; issue: number; branch: string; base_sha: string; head_sha: string;
  profile: string; workflow: string; executor_id: string; machine_id: string; expires_at: string;
}
export interface Proposal {
  schema_version: '1.0'; kind: 'admin_proposal'; version: string; action: 'grant' | 'revoke';
  expected_state_sha256: string | null; policy: unknown | null; task: Task | null;
  target_version: string | null;
}
export interface Approval {
  schema_version: '1.0'; kind: 'admin_approval'; id: string; operator: Actor;
  proposal_sha256: string; expected_state_sha256: string | null;
  approved_at: string; expires_at: string; reason: string;
}
export interface Entry {
  version: string; action: 'grant' | 'revoke'; proposal_sha256: string;
  approval_sha256: string; policy_sha256: string | null; target_version: string | null;
}
export interface State {
  schema_version: '1.0'; kind: 'admin_state'; generation: number;
  previous_state_sha256: string | null; entries: Entry[]; receipt_ids: string[];
}
export function proposal(value: any): Proposal {
  closed(value, ['schema_version','kind','version','action','expected_state_sha256','policy','task','target_version']);
  if (value.schema_version !== '1.0' || value.kind !== 'admin_proposal' || !id(value.version) ||
      !['grant','revoke'].includes(value.action) || value.expected_state_sha256 !== null && !hash(value.expected_state_sha256)) deny('schema');
  if (value.action === 'revoke') {
    if (value.policy !== null || value.task !== null || !id(value.target_version)) deny('schema');
  } else {
    const task = value.task;
    closed(task, ['repository','issue','branch','base_sha','head_sha','profile','workflow','executor_id','machine_id','expires_at']);
    if (!sha(task.base_sha) || !sha(task.head_sha) || task.base_sha === task.head_sha || !timestamp(task.expires_at) ||
        ![task.profile,task.workflow,task.executor_id,task.machine_id].every(id) || !Number.isSafeInteger(task.issue) || task.issue < 1 ||
        typeof task.repository !== 'string' || typeof task.branch !== 'string' || value.target_version !== null || !value.policy) deny('schema');
  }
  return value;
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
    if (!id(entry.version) || versions.has(entry.version) || !['grant','revoke'].includes(entry.action) || !hash(entry.proposal_sha256) || !hash(entry.approval_sha256) ||
        (entry.action === 'grant' ? !hash(entry.policy_sha256) || entry.target_version !== null : entry.policy_sha256 !== null || !id(entry.target_version) || versions.get(entry.target_version)?.action !== 'grant' || revoked.has(entry.target_version))) deny('state');
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
  if (entry.action === 'grant') {
    const policyBytes = read(prefix + '.policy.json');
    if (digest(policyBytes) !== entry.policy_sha256 || encode(proposed.policy) !== policyBytes.toString('utf8')) deny('policy_digest');
    policy = parse(policyBytes);
    if (digest(encode(policy.installation)) !== trust.installation_sha256) deny('installation_scope');
  }
  return { proposed, approved, policy };
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
  return { ...context, version, ...record };
}
