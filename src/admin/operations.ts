import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateBuilderPolicy, type ApprovedPolicy } from '../profiles.js';
import { externalPath } from '../shared/external-files.js';
import { approval, approvedProject, deny, digest, encode, hash, id, managedContext, materialize, parse, projectPolicy, proposal, read, readEntry, revisionOriginal, verificationRecoveryOriginal, snapshot, trustContext,
  type Entry, type Proposal, type ProjectPolicy, type State, type Task } from './registry.js';

// Same bounded grammar as the existing Deliver executor. Never execute proposed commands.
export const verificationCommand = (command: string): boolean =>
  /^pnpm(?: --config\.verifyDepsBeforeRun=false)? (?:run )?[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(command) ||
  /^node --test(?: tests\/[A-Za-z0-9_.\/-]+\.mjs)+$/.test(command) && !command.includes('..') ||
  /^git diff --check origin\/[A-Za-z0-9_./-]+\.\.\.HEAD$/.test(command);
export function checkedProject(value: unknown): ProjectPolicy {
  // Only an independently approved reusable template may explicitly allow all repository code paths.
  // It is materialized to an exact fixed Work Item before the existing Builder consumes it.
  const project = projectPolicy(value), policy = validateBuilderPolicy(project.builder_policy,true);
  if (policy.profiles.length !== 1 || policy.profiles.some(profile => profile.workflows.some(workflow =>
    !workflow.verification_commands.every(verificationCommand)))) deny('project_scope');
  return project;
}
export function checkedGrant(value: Proposal): ApprovedPolicy {
  if (value.action !== 'grant' || !value.task) deny('grant_required');
  const { trust } = trustContext(), { state } = snapshot(trust);
  const project = checkedProject(approvedProject(trust,state,value.policy_version!,new Date().toISOString()));
  revisionOriginal(trust,state,value,new Date().toISOString());
  verificationRecoveryOriginal(trust,state,value,new Date().toISOString());
  return validateBuilderPolicy(materialize(project,value.task,value.version));
}
function freshWrite(path: string, bytes: string): void {
  externalPath(path,true); const fd = openSync(path,'wx',0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function immutableWrite(path: string, bytes: string, recovery: boolean): void {
  if (recovery && existsSync(path)) { if (!read(path).equals(Buffer.from(bytes))) deny('recovery_conflict'); return; }
  freshWrite(path,bytes);
}
function recoverLock(root: string, version: string, proposalPin: string, approvalPin: string): void {
  const lockPath = join(root,'admin.lock'); if (!existsSync(lockPath)) return;
  const owner = parse(read(lockPath));
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.proposal_sha256 !== proposalPin || owner.approval_sha256 !== approvalPin) deny('recovery_lock');
  let dead = false; try { process.kill(owner.pid,0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (!dead) deny('recovery_owner_alive_or_unknown');
  const archived = join(root,version + '.recovered-lock-' + owner.pid + '.json'); externalPath(archived,true); renameSync(lockPath,archived);
}
function proposedState(): string | null {
  if (!process.env.AWH_ADMIN_TRUST_FILE && !process.env.AWH_ADMIN_TRUST_SHA256) return null;
  return snapshot(trustContext().trust).statePin;
}
function saveProposal(value: Proposal, output: string): object {
  const bytes = encode(proposal(value)); freshWrite(output,bytes);
  return { status: 'PROPOSED', proposal_sha256: digest(bytes), version: value.version, authority_verified: false };
}
/** Register a reusable project/workflow version, still inert until independently approved. */
export function proposeProject(project: unknown, version: string, output: string): object {
  return saveProposal({ schema_version: '1.0', kind: 'admin_proposal', action: 'project', version, expected_state_sha256: proposedState(),
    policy: checkedProject(project), task: null, target_version: null, policy_version: null },output);
}
/** A work item references an approved immutable policy, never an unapproved JSON template. */
export function prepareGrant(policyVersion: string, version: string, task: Task, output: string): object {
  const value = proposal({ schema_version: '1.0', kind: 'admin_proposal', action: 'grant', version, expected_state_sha256: proposedState(),
    policy: null, task, target_version: null, policy_version: policyVersion });
  checkedGrant(value); if (task.expires_at <= new Date().toISOString()) deny('task_expired');
  return saveProposal(value,output);
}
export function prepareRevoke(version: string, target: string, output: string): object {
  const { trust } = trustContext(), { state, statePin } = snapshot(trust);
  if (!state.entries.some(entry => entry.version === target && entry.action !== 'revoke') || state.entries.some(entry => entry.target_version === target)) deny('unapproved_or_revoked');
  return saveProposal({ schema_version: '1.0', kind: 'admin_proposal', action: 'revoke', version, expected_state_sha256: statePin,
    policy: null, task: null, target_version: target, policy_version: null },output);
}
export function prepareApproval(proposalPath: string, receiptId: string, reason: string, output: string): object {
  const bytes = read(proposalPath), value = proposal(parse(bytes)), { trust } = trustContext(), now = new Date().toISOString();
  const receipt = approval({ schema_version: '1.0', kind: 'admin_approval', id: receiptId, operator: trust.operator,
    proposal_sha256: digest(bytes), expected_state_sha256: value.expected_state_sha256, approved_at: now,
    expires_at: new Date(Date.parse(now) + 3600000).toISOString(), reason },trust,digest(bytes),value.expected_state_sha256,now,true);
  const receiptBytes = encode(receipt); freshWrite(output,receiptBytes);
  return { status: 'APPROVAL_PREPARED', approval_sha256: digest(receiptBytes), independent_administrator_pin_required: true, authority_verified: false };
}
/** Recovery replays only exact local immutable bytes, never any Provider operation. */
export function approveProposal(proposalPath: string, recovery = false): object {
  const { trust } = trustContext(), bytes = read(proposalPath), value = proposal(parse(bytes)), now = new Date().toISOString();
  const approvalFile = process.env.AWH_ADMIN_APPROVAL_FILE, approvalPin = process.env.AWH_ADMIN_APPROVAL_SHA256;
  if (!approvalFile || !hash(approvalPin)) deny('independent_approval_pin_required');
  const approvalBytes = read(approvalFile); if (digest(approvalBytes) !== approvalPin) deny('approval_digest');
  const receipt = approval(parse(approvalBytes),trust,digest(bytes),value.expected_state_sha256,now,false);
  const before = snapshot(trust), committedIndex = before.state.entries.findIndex(entry => entry.version === value.version);
  if (committedIndex >= 0) {
    const entry = before.state.entries[committedIndex]!;
    readEntry(trust,entry,before.state.receipt_ids[committedIndex]!,now);
    if (entry.proposal_sha256 !== digest(bytes) || entry.approval_sha256 !== approvalPin || before.state.receipt_ids[committedIndex] !== receipt.id) deny('replayed_approval');
    if (recovery) recoverLock(trust.registry_root,value.version,digest(bytes),approvalPin);
    return { status: 'ALREADY_COMMITTED', version: value.version, generation: before.state.generation, provider_writes: 0, authority_verified: false };
  }
  approval(parse(approvalBytes),trust,digest(bytes),value.expected_state_sha256,now,true);
  const policy = value.action === 'project' ? checkedProject(value.policy) : value.action === 'grant' ? checkedGrant(value) : null;
  const installation = value.action === 'project' ? (policy as ProjectPolicy).builder_policy.installation : (policy as ApprovedPolicy | null)?.installation;
  if (policy && (value.task && value.task.expires_at <= now || digest(encode(installation)) !== trust.installation_sha256)) deny('installation_or_expiry');
  const lockPath = join(trust.registry_root,'admin.lock');
  if (recovery) recoverLock(trust.registry_root,value.version,digest(bytes),approvalPin);
  externalPath(lockPath,true); let lock: number;
  try { lock = openSync(lockPath,'wx',0o600); } catch { return deny('concurrent_approval_or_stale_lock'); }
  try {
    writeFileSync(lock,encode({ pid: process.pid, proposal_sha256: digest(bytes), approval_sha256: approvalPin })); fsyncSync(lock);
    const { state, statePin } = snapshot(trust);
    if (statePin !== value.expected_state_sha256) deny('stale_approval');
    if (state.entries.some(entry => entry.version === value.version) || state.receipt_ids.includes(receipt.id)) deny('replayed_approval');
    if (state.generation >= 128) deny('history_limit');
    state.entries.forEach((entry,index) => readEntry(trust,entry,state.receipt_ids[index]!,now));
    if (value.action === 'revoke' && (!state.entries.some(entry => entry.version === value.target_version && entry.action !== 'revoke') || state.entries.some(entry => entry.target_version === value.target_version))) deny('unapproved_or_revoked');
    const policyBytes = policy ? encode(policy) : null;
    const entry: Entry = { version: value.version, action: value.action, proposal_sha256: digest(bytes), approval_sha256: approvalPin,
      policy_sha256: policyBytes === null ? null : digest(policyBytes), target_version: value.target_version };
    const prefix = join(trust.registry_root,value.version);
    // A protected transaction descriptor is written first. Incomplete writes remain evidence.
    const transaction = encode({ proposal_sha256: digest(bytes), approval_sha256: approvalPin, expected_state_sha256: statePin });
    if (recovery && (!existsSync(prefix + '.transaction.json') || !read(prefix + '.transaction.json').equals(Buffer.from(transaction)))) deny('recovery_transaction');
    immutableWrite(prefix + '.transaction.json',transaction,recovery);
    immutableWrite(prefix + '.proposal.json',bytes.toString('utf8'),recovery);
    immutableWrite(prefix + '.approval.json',approvalBytes.toString('utf8'),recovery);
    if (policyBytes !== null) immutableWrite(prefix + '.policy.json',policyBytes,recovery);
    const next: State = { schema_version: '1.0', kind: 'admin_state', generation: state.generation + 1, previous_state_sha256: statePin,
      entries: [...state.entries,entry], receipt_ids: [...state.receipt_ids,receipt.id] };
    const nextBytes = encode(next), pending = join(trust.registry_root,'state.pending.json');
    immutableWrite(join(trust.registry_root,'state.' + next.generation + '.json'),nextBytes,recovery);
    immutableWrite(pending,nextBytes,recovery);
    renameSync(pending,join(trust.registry_root,'state.json'));
    const readback = snapshot(trust); if (readback.statePin !== digest(nextBytes)) deny('state_readback');
    return { status: value.action === 'revoke' ? 'REVOKED' : 'APPROVED', version: value.version, generation: next.generation,
      state_sha256: readback.statePin, policy_sha256: entry.policy_sha256, operator: receipt.operator, approved_at: receipt.approved_at,
      provider_writes: 0, authority_verified: false };
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
export function inspectRegistry(): any {
  const { trust } = trustContext(), { state, statePin } = snapshot(trust), now = new Date().toISOString();
  const entries = state.entries.map((entry,index) => {
    const record = readEntry(trust,entry,state.receipt_ids[index]!,now), previousPin = index === 0 ? null : digest(read(join(trust.registry_root,'state.' + index + '.json')));
    if (record.proposed.expected_state_sha256 !== previousPin) deny('history_conflict');
    if (entry.action === 'project') checkedProject(record.policy);
    return { ...entry, operator: record.approved.operator, approved_at: record.approved.approved_at, approval_source: 'protected-external-independent-pin',
      policy_version: record.proposed.policy_version, task: record.proposed.task, policy: entry.action === 'project' ? record.policy : null,
      revoked: state.entries.some(revoke => revoke.target_version === entry.version), expired: !!record.proposed.task && record.proposed.task.expires_at <= now };
  });
  return { status: 'INSPECTED', generation: state.generation, state_sha256: statePin, entries, provider_writes: 0, authority_verified: false };
}
/** Safe status for launch preparation: never returns authority files, pins or executable environment. */
export function launcherDescriptor(version: string): object {
  if (!id(version)) deny('version');
  const context = managedContext({ ...process.env, AWH_ADMIN_VERSION: version }); if (!context) deny('independent_trust_pin_required');
  return { status: 'LOCAL_AUTHORIZATION_VALID', version, policy_version: context.proposed.policy_version, task: context.proposed.task,
    operator: context.approved.operator, approved_at: context.approved.approved_at, provider_scope: 'NOTRUN', authority_verified: false };
}
export function inspectProposal(path: string): object {
  const bytes = read(path), value = proposal(parse(bytes));
  if (value.action === 'project') checkedProject(value.policy); if (value.action === 'grant') checkedGrant(value);
  return { status: 'PROPOSED', proposal_sha256: digest(bytes), proposal: value, authority_verified: false };
}
export function compareProposals(leftPath: string, rightPath: string): object {
  const leftBytes = read(leftPath), rightBytes = read(rightPath), left = proposal(parse(leftBytes)), right = proposal(parse(rightBytes));
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  const walk = (before: any, after: any, field: string) => {
    if (encode(before) === encode(after)) return;
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
      for (const key of new Set([...Object.keys(before),...Object.keys(after)])) walk(before[key] ?? null,after[key] ?? null,field ? field + '.' + key : key);
    } else changes.push({ field, before: before ?? null, after: after ?? null });
  };
  walk(left,right,''); return { status: 'COMPARED', left_sha256: digest(leftBytes), right_sha256: digest(rightBytes), changes, authority_verified: false };
}
export function diagnoseRegistry(version?: string): object {
  try {
    const inspected = inspectRegistry(), { trust } = trustContext(), { state } = snapshot(trust), known = new Set(state.entries.map(entry => entry.version));
    const orphanRecords = readdirSync(trust.registry_root).filter(name => /\.(?:proposal|approval|policy|transaction)\.json$/.test(name) && !known.has(name.replace(/\.(?:proposal|approval|policy|transaction)\.json$/,'')) || /^state\.\d+\.json$/.test(name) && Number(name.split('.')[1]) > state.generation);
    const lockPresent = existsSync(join(trust.registry_root,'admin.lock')), pendingSwitch = existsSync(join(trust.registry_root,'state.pending.json'));
    const authorization = version ? launcherDescriptor(version) : null;
    return { ...inspected, status: lockPresent || pendingSwitch || orphanRecords.length ? 'BLOCKED' : 'INSPECTED', authorization,
      lock_present: lockPresent, pending_switch: pendingSwitch, orphan_records: orphanRecords,
      recovery: 'Preserve evidence. An independently pinned administrator may recover only this exact local transaction; no Provider retry.' };
  } catch (error) { return { status: 'BLOCKED', code: error instanceof Error && 'code' in error ? error.code : 'registry_unavailable',
    recovery: 'Restore independent administrator trust and immutable records; obtain an explicit approved project/work item/stage.', authority_verified: false }; }
}
