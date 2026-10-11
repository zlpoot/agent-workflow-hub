import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import type { Event, Run } from '../protocol/index.js';
import { replayRun } from '../protocol/index.js';
import { taskBinding, taskVerificationCommands, type TaskBinding } from '../profiles.js';
import { managedContext, snapshot, readEntry, verificationRecoveryOriginal } from '../admin/registry.js';
import { clientFail, same } from './local.js';

export interface RecoveryLink { attempt_id: string; predecessor_run_id: string; old_sha: string; new_sha: string }
export interface RecoveryInspection { repository: string; issue: number; branch: string; source_sha: string; actor: string; app_id: number;
  remote_branch_absent: true; same_branch_pr_absent: true; contents_permission: 'read' }
export interface RecoveryRecord {
  schema_version: '1.0'; kind: 'verification_recovery'; link: RecoveryLink; namespace_sha256: string;
  predecessor_binding: TaskBinding; successor_binding: TaskBinding; successor_run_id: string;
  hashes: { session: string; journal: string; evidence: string | null; cp_events: string };
  evidence_json: string | null; inspection: RecoveryInspection; created_at: string;
}
export interface RecoveryJournal { schema_version: string; run_id: string; source_sha: string; stage: string; disposition: string;
  refs: Record<string, unknown>; task_binding?: TaskBinding }
export function qualifyRecovery(initial: Run, events: Event[], binding: TaskBinding | undefined, pending: boolean,
  journal: RecoveryJournal, evidence: unknown, next: TaskBinding, cp: Run, cpEvents: Event[]): void {
  const { fingerprint: _fingerprint, ...nextData } = next;
  const data = (i: number): Record<string, unknown> => events[i]?.payload.data as Record<string, unknown> ?? {};
  const reject = () => clientFail('recovery', 'Recovery requires an unchanged CP-confirmed pre-provider failure, matching evidence and a different clean source');
  let expectedRefs: Record<string, unknown> = {};
  const managed = managedContext();
  let nextVersion = binding?.profile_version;
  if (managed && binding && binding.profile_version !== next.profile_version) {
    const {state} = snapshot(managed.trust), i = state.entries.findIndex(e => e.action === 'grant' && e.version === next.profile_version);
    if (i < 0) return reject();
    const successor = readEntry(managed.trust,state.entries[i]!,state.receipt_ids[i]!,new Date().toISOString()), r = successor.proposed.task!.verification_recovery;
    if (!r || r.original_version !== binding.profile_version || r.run_id !== initial.id || r.previous_head !== binding.source_sha ||
        successor.proposed.task!.head_sha !== next.source_sha) return reject();
    verificationRecoveryOriginal(managed.trust,state,successor.proposed,new Date().toISOString());
    nextVersion = next.profile_version;
  }
  if (managed && binding) {
    const {state} = snapshot(managed.trust), index = state.entries.findIndex(e => e.action === 'grant' && e.version === binding.profile_version);
    if (index < 0) return reject();
    const original = readEntry(managed.trust,state.entries[index]!,state.receipt_ids[index]!,new Date().toISOString()), task = original.proposed.task!;
    expectedRefs = {administrator_binding:{authorization_version:binding.profile_version,policy_version:original.proposed.policy_version,
      repository:task.repository,issue:task.issue,branch:task.branch,base_sha:task.base_sha,head_sha:binding.source_sha,
      executor_id:task.executor_id,machine_id:task.machine_id,stages:task.stages,provider_operations:task.provider_operations}};
  }
  if (!binding || pending || initial.id !== journal.run_id || journal.schema_version !== '1.0' || journal.source_sha !== initial.source.sha ||
      journal.disposition !== 'stopped' || !['preflight','verification'].includes(journal.stage) ||
      !journal.refs || typeof journal.refs !== 'object' || Array.isArray(journal.refs) ||
      !(same(journal.refs,{}) || same(journal.refs,expectedRefs)) || !same(binding, journal.task_binding) ||
      binding.source_sha === next.source_sha || !same({ ...binding, source_sha: next.source_sha, profile_version: nextVersion, fingerprint: next.fingerprint }, next) ||
      !same(taskBinding(nextData), next) || !same(replayRun(initial, events).run, cp) || cp.state !== 'failed' || !same(events, cpEvents)) reject();
  const expected = journal.stage === 'verification'
    ? ['RUN_STARTED','STEP_STARTED','STEP_COMPLETED','VERIFICATION_STARTED','VERIFICATION_FAILED']
    : ['RUN_STARTED','STEP_STARTED','STEP_COMPLETED','RUN_FAILED'];
  if (!same(events.map(e => e.type), expected) || events.some(e => !same(e.payload.extensions.task_binding, binding)) || data(0).source_sha !== initial.source.sha ||
      data(1).step_id !== 'builder-preflight' || data(2).step_id !== 'builder-preflight') reject();
  if (journal.stage === 'preflight') {
    if (evidence !== null || data(2).exit_code !== 2 || events[3]?.payload.extensions.builder_stage !== 'preflight') reject();
  } else {
    const v = evidence as { started_at: string; before_sha: string; after_sha: string;
      logs: { command: string; exit_code: number; stdout: string; stderr: string; elapsed_ms: number }[] } | null;
    const commands = taskVerificationCommands(next);
    if (!v || Object.keys(v).sort().join(',') !== 'after_sha,before_sha,logs,started_at' || v.before_sha !== initial.source.sha || v.after_sha !== initial.source.sha ||
        !Number.isFinite(Date.parse(v.started_at)) || !Array.isArray(v.logs) || !v.logs.length || v.logs.length > commands.length ||
        data(2).exit_code !== 0 || data(3).subject_sha !== initial.source.sha || data(4).subject_sha !== initial.source.sha) reject();
    if (v!.logs.some((log, index) => Object.keys(log).sort().join(',') !== 'command,elapsed_ms,exit_code,stderr,stdout' || log.command !== commands[index] ||
        !Number.isSafeInteger(log.exit_code) || (index === v!.logs.length - 1 ? log.exit_code <= 0 : log.exit_code !== 0) || typeof log.stdout !== 'string' || typeof log.stderr !== 'string' ||
        !Number.isFinite(log.elapsed_ms) || log.elapsed_ms < 0) || !same(data(4).checks, v!.logs.map(log => ({command:log.command,exit_code:log.exit_code})))) reject();
  }
}
export function assertRecoveryInspection(value: RecoveryInspection, binding: TaskBinding): void {
  if (!value || Object.keys(value).sort().join(',') !== 'actor,app_id,branch,contents_permission,issue,remote_branch_absent,repository,same_branch_pr_absent,source_sha' ||
      value.repository !== binding.repository || value.issue !== binding.issue || value.branch !== binding.branch || value.source_sha !== binding.source_sha ||
      !/^[a-z0-9-]+\[bot\]$/.test(value.actor) || !Number.isSafeInteger(value.app_id) || value.app_id <= 0 ||
      value.remote_branch_absent !== true || value.same_branch_pr_absent !== true || value.contents_permission !== 'read')
    clientFail('recovery', 'Recovery requires single-repository read-only App inspection with no remote Task branch or PR');
}

export function exclusiveRecoveryFile(path: string, bytes: string | Buffer): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
