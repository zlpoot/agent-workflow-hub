import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateBuilderPolicy, type ApprovedPolicy } from '../profiles.js';
import { externalPath } from '../shared/external-files.js';
import { approval, deny, digest, encode, hash, id, managedContext, parse, proposal, read, readEntry, snapshot, trustContext,
  type Entry, type Proposal, type State, type Task } from './registry.js';

// Match the existing Deliver executor grammar; never execute a proposed command.
export const verificationCommand = (command: string): boolean =>
  /^pnpm(?: --config\.verifyDepsBeforeRun=false)? (?:run )?[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(command) ||
  /^node --test(?: tests\/[A-Za-z0-9_.\/-]+\.mjs)+$/.test(command) && !command.includes('..') ||
  /^git diff --check origin\/[A-Za-z0-9_./-]+\.\.\.HEAD$/.test(command);
export function checkedGrant(value: Proposal): ApprovedPolicy {
  if (value.action !== 'grant' || !value.task) deny('grant_required');
  const policy = validateBuilderPolicy(value.policy), task = value.task;
  const selected = policy.profiles.find(p => p.id === task.profile), workflow = selected?.workflows.find(w => w.id === task.workflow);
  if (policy.profiles.length !== 1 || selected?.workflows.length !== 1 || !workflow || workflow.version !== value.version || workflow.branch_mode !== 'fixed' ||
      selected.repository !== task.repository || workflow.branch !== task.branch || workflow.work_item.repo !== task.repository || workflow.work_item.issue !== task.issue ||
      workflow.executor_restrictions.executor_ids.length !== 1 || workflow.executor_restrictions.executor_ids[0] !== task.executor_id ||
      workflow.executor_restrictions.machine_ids.length !== 1 || workflow.executor_restrictions.machine_ids[0] !== task.machine_id ||
      policy.default_selection.profile !== task.profile || policy.default_selection.workflow !== task.workflow ||
      !workflow.verification_commands.every(verificationCommand)) deny('task_scope');
  return policy;
}
function freshWrite(path: string, bytes: string): void {
  externalPath(path, true);
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function proposedState(): string | null {
  if (!process.env.AWH_ADMIN_TRUST_FILE && !process.env.AWH_ADMIN_TRUST_SHA256) return null;
  return snapshot(trustContext().trust).statePin;
}
export function prepareGrant(templatePath: string, version: string, task: Task, output: string): object {
  if (!id(version)) deny('version');
  const template = validateBuilderPolicy(parse(read(templatePath))), selected = template.profiles.find(p => p.id === task.profile);
  const workflow = selected?.workflows.find(w => w.id === task.workflow);
  if (!selected || !workflow || selected.repository !== task.repository || workflow.work_item.repo !== task.repository ||
      !workflow.executor_restrictions.executor_ids.includes(task.executor_id) || !workflow.executor_restrictions.machine_ids.includes(task.machine_id) ||
      (workflow.branch_mode === 'issue_prefix' ? task.branch !== workflow.branch + task.issue : task.branch !== workflow.branch || task.issue !== workflow.work_item.issue)) deny('template_scope');
  const policy = { ...template, default_selection: { profile: task.profile, workflow: task.workflow }, profiles: [{ ...selected, workflows: [{ ...workflow,
    version, branch: task.branch, branch_mode: 'fixed' as const, work_item: { repo: task.repository, issue: task.issue },
    executor_restrictions: { executor_ids: [task.executor_id], machine_ids: [task.machine_id] } }] }] };
  return proposeGrant(policy, version, task, output);
}
/** One-time template registration proposal. It remains inert until independently approved. */
export function proposeGrant(policy: unknown, version: string, task: Task, output: string): object {
  const normalized = structuredClone(validateBuilderPolicy(policy));
  const selected = normalized.profiles.find(profile => profile.id === task.profile)?.workflows.find(workflow => workflow.id === task.workflow);
  if (!selected) deny('task_scope');
  // Each registered immutable task gets a distinct approved workflow version.
  (selected as { version: string }).version = version;
  const value = proposal({ schema_version: '1.0', kind: 'admin_proposal', action: 'grant', version,
    expected_state_sha256: proposedState(), policy: normalized, task, target_version: null });
  checkedGrant(value);
  if (value.task!.expires_at <= new Date().toISOString()) deny('task_expired');
  const bytes = encode(value); freshWrite(output, bytes);
  return { status: 'PROPOSED', proposal_sha256: digest(bytes), version, authority_verified: false };
}
export function prepareRevoke(version: string, target: string, output: string): object {
  const { trust } = trustContext(), { state, statePin } = snapshot(trust);
  if (!state.entries.some(entry => entry.version === target && entry.action === 'grant') || state.entries.some(entry => entry.target_version === target)) deny('unapproved_or_revoked');
  const value = proposal({ schema_version: '1.0', kind: 'admin_proposal', action: 'revoke', version,
    expected_state_sha256: statePin, policy: null, task: null, target_version: target });
  const bytes = encode(value); freshWrite(output, bytes);
  return { status: 'PROPOSED', proposal_sha256: digest(bytes), target_version: target, authority_verified: false };
}
export function prepareApproval(proposalPath: string, receiptId: string, reason: string, output: string): object {
  const bytes = read(proposalPath), value = proposal(parse(bytes)), { trust } = trustContext();
  const now = new Date().toISOString();
  const receipt = approval({ schema_version: '1.0', kind: 'admin_approval', id: receiptId, operator: trust.operator,
    proposal_sha256: digest(bytes), expected_state_sha256: value.expected_state_sha256,
    approved_at: now, expires_at: new Date(Date.parse(now) + 3600000).toISOString(), reason }, trust, digest(bytes), value.expected_state_sha256, now, true);
  const receiptBytes = encode(receipt); freshWrite(output, receiptBytes);
  return { status: 'APPROVAL_PREPARED', approval_sha256: digest(receiptBytes), independent_administrator_pin_required: true, authority_verified: false };
}
export function approveProposal(proposalPath: string): object {
  const { trust } = trustContext(), bytes = read(proposalPath), value = proposal(parse(bytes));
  const approvalFile = process.env.AWH_ADMIN_APPROVAL_FILE, approvalPin = process.env.AWH_ADMIN_APPROVAL_SHA256;
  if (!approvalFile || !hash(approvalPin)) deny('independent_approval_pin_required');
  const approvalBytes = read(approvalFile); if (digest(approvalBytes) !== approvalPin) deny('approval_digest');
  const now = new Date().toISOString(), receipt = approval(parse(approvalBytes), trust, digest(bytes), value.expected_state_sha256, now, true);
  const policy = value.action === 'grant' ? checkedGrant(value) : null;
  if (policy && (value.task!.expires_at <= now || digest(encode(policy.installation)) !== trust.installation_sha256)) deny('installation_or_expiry');
  const lockPath = join(trust.registry_root, 'admin.lock'); externalPath(lockPath, true);
  let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); } catch { return deny('concurrent_approval_or_stale_lock'); }
  try {
    const { state, statePin } = snapshot(trust);
    if (statePin !== value.expected_state_sha256) deny('stale_approval');
    if (state.entries.some(entry => entry.version === value.version) || state.receipt_ids.includes(receipt.id)) deny('replayed_approval');
    if (state.generation >= 128) deny('history_limit');
    // Validate the complete existing approved history before extending it.
    state.entries.forEach((entry, index) => readEntry(trust, entry, state.receipt_ids[index]!, now));
    if (value.action === 'revoke' && (!state.entries.some(entry => entry.version === value.target_version && entry.action === 'grant') || state.entries.some(entry => entry.target_version === value.target_version))) deny('unapproved_or_revoked');
    const policyBytes = policy ? encode(policy) : null;
    const entry: Entry = { version: value.version, action: value.action, proposal_sha256: digest(bytes), approval_sha256: approvalPin,
      policy_sha256: policyBytes === null ? null : digest(policyBytes), target_version: value.target_version };
    // Exclusive immutable records. A crash retains orphan files for diagnosis, never overwrites them.
    const prefix = join(trust.registry_root, value.version);
    freshWrite(prefix + '.proposal.json', bytes.toString('utf8'));
    freshWrite(prefix + '.approval.json', approvalBytes.toString('utf8'));
    if (policyBytes !== null) freshWrite(prefix + '.policy.json', policyBytes);
    const next: State = { schema_version: '1.0', kind: 'admin_state', generation: state.generation + 1, previous_state_sha256: statePin,
      entries: [...state.entries, entry], receipt_ids: [...state.receipt_ids, receipt.id] };
    const nextBytes = encode(next), pending = join(trust.registry_root, 'state.pending.json');
    freshWrite(join(trust.registry_root, 'state.' + next.generation + '.json'), nextBytes);
    freshWrite(pending, nextBytes);
    // One same-directory rename switches the launcher registry reference atomically.
    renameSync(pending, join(trust.registry_root, 'state.json'));
    return { status: value.action === 'grant' ? 'APPROVED' : 'REVOKED', version: value.version, generation: next.generation,
      state_sha256: digest(nextBytes), policy_sha256: entry.policy_sha256, operator: receipt.operator, approved_at: receipt.approved_at,
      provider_writes: 0, authority_verified: false };
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
export function inspectRegistry(): object {
  const { trust } = trustContext(), { state, statePin } = snapshot(trust), now = new Date().toISOString();
  const entries = state.entries.map((entry, index) => {
    const record = readEntry(trust, entry, state.receipt_ids[index]!, now);
    const previousPin = index === 0 ? null : digest(read(join(trust.registry_root, 'state.' + index + '.json')));
    if (record.proposed.expected_state_sha256 !== previousPin) deny('history_conflict');
    if (entry.action === 'grant') checkedGrant(record.proposed);
    return { ...entry, operator: record.approved.operator, approved_at: record.approved.approved_at,
      task: record.proposed.task, policy: record.policy, revoked: state.entries.some(revoke => revoke.target_version === entry.version) };
  });
  return { status: 'INSPECTED', generation: state.generation, state_sha256: statePin, entries, provider_writes: 0, authority_verified: false };
}
export function launcherDescriptor(version: string): object {
  if (!id(version)) deny('version');
  const context = managedContext({ ...process.env, AWH_ADMIN_VERSION: version });
  if (!context) deny('independent_trust_pin_required');
  checkedGrant(context.proposed);
  return { status: 'LOCAL_AUTHORIZATION_VALID', version, task: context.proposed.task, operator: context.approved.operator,
    approved_at: context.approved.approved_at, policy_file: join(context.trust.registry_root, version + '.policy.json'),
    policy_sha256: digest(encode(context.policy)), provider_scope: 'NOTRUN', authority_verified: false,
    environment: { AWH_ADMIN_TRUST_FILE: context.trustFile, AWH_ADMIN_TRUST_SHA256: context.trustPin, AWH_ADMIN_VERSION: version,
      AWH_ADMIN_EXECUTOR_ID: context.proposed.task!.executor_id, AWH_ADMIN_MACHINE_ID: context.proposed.task!.machine_id } };
}
export function inspectProposal(path: string): object {
  const bytes = read(path), value = proposal(parse(bytes));
  if (value.action === 'grant') checkedGrant(value);
  return { status: 'PROPOSED', proposal_sha256: digest(bytes), proposal: value, authority_verified: false };
}
export function compareProposals(leftPath: string, rightPath: string): object {
  const leftBytes = read(leftPath), rightBytes = read(rightPath);
  const left = proposal(parse(leftBytes)), right = proposal(parse(rightBytes));
  if (left.action === 'grant') checkedGrant(left);
  if (right.action === 'grant') checkedGrant(right);
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  const walk = (before: any, after: any, field: string) => {
    if (encode(before) === encode(after)) return;
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
      for (const key of new Set([...Object.keys(before),...Object.keys(after)])) walk(before[key] ?? null,after[key] ?? null,field ? field + '.' + key : key);
    } else changes.push({ field, before: before ?? null, after: after ?? null });
  };
  walk(left,right,'');
  return { status: 'COMPARED', left_sha256: digest(leftBytes), right_sha256: digest(rightBytes), changes, authority_verified: false };
}
export function diagnoseRegistry(): object {
  try {
    const inspected = inspectRegistry(), { trust } = trustContext(), { state } = snapshot(trust);
    const known = new Set(state.entries.map(entry => entry.version));
    const orphanRecords = readdirSync(trust.registry_root).filter(name => /\.(?:proposal|approval|policy)\.json$/.test(name) && !known.has(name.replace(/\.(?:proposal|approval|policy)\.json$/,'')) || /^state\.\d+\.json$/.test(name) && Number(name.split('.')[1]) > state.generation);
    const lockPresent = existsSync(join(trust.registry_root,'admin.lock')), pendingSwitch = existsSync(join(trust.registry_root,'state.pending.json'));
    return { ...inspected, status: lockPresent || pendingSwitch || orphanRecords.length ? 'BLOCKED' : 'INSPECTED',
      lock_present: lockPresent, pending_switch: pendingSwitch, orphan_records: orphanRecords,
      recovery: 'Preserve locks, pending switch and orphan records; an administrator must inspect crash state before authorizing recovery.' };
  }
  catch (error) { return { status: 'BLOCKED', code: error instanceof Error && 'code' in error ? error.code : 'registry_unavailable',
    recovery: 'Restore the independently pinned administrator trust root and immutable records; do not remove locks, repin changed data or reuse a consumed receipt.', authority_verified: false }; }
}
