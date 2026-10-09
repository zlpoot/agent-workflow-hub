import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Event, EventData } from '../protocol/index.js';
import { replayRun } from '../protocol/index.js';
import type { TaskBinding } from '../profiles.js';
import { clientFail, git, readJson, same } from './local.js';
import { exclusiveRecoveryFile } from './recovery.js';
import { validateHandoff } from '../validator.js';

export const REVISION_COMMAND = 'git diff --check origin/main...HEAD';
export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const revisionId = (run: string, task: TaskBinding, previous: string, head: string, pr: number) =>
  'revision-' + digest(JSON.stringify([run, task.fingerprint, previous, head, pr]));

export function inspectRevision(root: string, original: string, previous: string, head: string, base: string, paths: readonly string[]) {
  if (previous === head || git(root, ['merge-base', '--is-ancestor', previous, head], true) !== '' ||
      git(root, ['merge-base', previous, head]) !== previous || git(root, ['merge-base', original, head]) !== original)
    clientFail('revision_ancestry', 'Revision must be a strict descendant of both the previous and original candidate');
  if (git(root, ['rev-parse', 'origin/main']) !== base) clientFail('revision_base', 'Trusted origin/main must match the original PR base');
  return [previous, original].map(from => {
    const names = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', '-C', '--find-copies-harder', from, head, '--']).split('\0');
    if (names.at(-1) === '') names.pop();
    if (!names.length || names.length % 2 || names.some((v, i) => i % 2 ? !paths.includes(v) : !['A','M'].includes(v)))
      clientFail('revision_paths', 'Both revision diffs must contain only added or modified allowlisted documents');
    // Disallow executable/symlink/submodule changes, even at an allowlisted document path.
    const raw = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--raw', '--no-abbrev', '--no-renames', from, head, '--']);
    if (raw.split('\n').some(line => !/^:(?:000000|100644) 100644 [a-f0-9]{40} [a-f0-9]{40} [AM]\t/.test(line)))
      clientFail('revision_paths', 'Revision documents must remain regular non-executable files');
    const diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', from, head, '--']);
    if (!diff || diff.includes('GIT binary patch') || /^Binary files /m.test(diff)) clientFail('revision_paths', 'Revision requires an inspectable text diff');
    return { from, head, name_status_sha256: digest(names.join('\0')), diff_sha256: digest(diff) };
  });
}

export interface RevisionEvidence { command: typeof REVISION_COMMAND; before_sha: string; after_sha: string; base_sha: string;
  exit_code: 0; stdout: string; stderr: string; environment: Record<string, unknown>; started_at: string; finished_at: string }
export function parseRevisionEvidence(body: string, actor: string, head: string, base: string): RevisionEvidence {
  const reject = () => clientFail('revision_evidence', 'Existing App evidence must contain exact-head clean verification, environment and raw output');
  let metadata: Record<string, any>, v: Record<string, any>;
  try {
    const match = /^Builder evidence — documentation review correction\n```json\n([\s\S]+?)\n```\nRaw stdout: ([^\n]+)\nRaw stderr: ([^\n]+)/.exec(body);
    if (!match) return reject();
    metadata = JSON.parse(match[1]!); v = metadata.verification;
    if (JSON.parse(match[2]!) !== v.stdout || JSON.parse(match[3]!) !== v.stderr) return reject();
  } catch { return reject(); }
  if (metadata.actor !== actor || !v || v.command !== REVISION_COMMAND || v.command_runs !== 1 || v.exit_code !== 0 ||
      v.before_sha !== head || v.after_sha !== head || v.base_sha !== base || v.clean_before !== true || v.clean_after !== true ||
      typeof v.stdout !== 'string' || typeof v.stderr !== 'string' || !v.environment || typeof v.environment !== 'object' || Array.isArray(v.environment) ||
      !['platform','arch','node','git'].every(k => typeof v.environment[k] === 'string' && v.environment[k].trim()) ||
      ![v.started_at,v.finished_at].every(t => typeof t === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t) && Number.isFinite(Date.parse(t))) ||
      v.finished_at < v.started_at) return reject();
  return { command: REVISION_COMMAND, before_sha: head, after_sha: head, base_sha: base, exit_code: 0,
    stdout: v.stdout, stderr: v.stderr, environment: v.environment, started_at: v.started_at, finished_at: v.finished_at };
}

// Each phase is exclusive and fsynced. Interrupted provider phases are never replayed.
interface Phase { schema_version: '1.0'; revision_id: string; phase: number; previous_sha256: string | null; value: any }
export class RevisionReceipt {
  constructor(readonly directory: string, readonly id: string) {
    if (!/^revision-[a-f0-9]{64}$/.test(id)) clientFail('revision_receipt', 'Invalid revision receipt ID');
  }
  file(phase: number) { return join(this.directory, this.id + '.revision.' + phase + '.json'); }
  phases(): Phase[] {
    const result: Phase[] = [];
    for (let phase = 0; phase <= 5; phase++) {
      if (!existsSync(this.file(phase))) continue;
      const p = readJson(this.file(phase), 256 * 1024) as Phase;
      if (phase !== result.length || !p || Object.keys(p).sort().join(',') !== 'phase,previous_sha256,revision_id,schema_version,value' ||
          p.schema_version !== '1.0' || p.revision_id !== this.id || p.phase !== phase ||
          p.previous_sha256 !== (phase ? digest(readFileSync(this.file(phase - 1))) : null))
        clientFail('revision_receipt', 'Interrupted or conflicting revision receipt; preserve it for reconciliation');
      result.push(p);
    }
    return result;
  }
  append(value: unknown) {
    const phases = this.phases(), phase = phases.length;
    if (phase > 5) clientFail('revision_receipt', 'Revision receipt is already complete');
    exclusiveRecoveryFile(this.file(phase), JSON.stringify({ schema_version: '1.0', revision_id: this.id, phase,
      previous_sha256: phase ? digest(readFileSync(this.file(phase - 1))) : null, value }, null, 2));
  }
}

export function revisionReceipts(directory: string): RevisionReceipt[] {
  const files = readdirSync(directory).filter(n => n.includes('.revision.'));
  if (files.length > 1536 || files.some(n => !/^revision-[a-f0-9]{64}\.revision\.[0-5]\.json$/.test(n)))
    clientFail('revision_receipt', 'Unknown revision sidecar; refusing state replacement');
  return [...new Set(files.map(n => n.split('.')[0]!))].map(id => new RevisionReceipt(directory, id));
}

export interface RevisionOverlay { schema_version: '1.0'; run_id: string; session_sha256: string; journal_sha256: string;
  events: Event[]; pending: Event | null; completed: boolean }
export function validateOverlay(value: RevisionOverlay, initial: Parameters<typeof replayRun>[0], events: Event[], session: Buffer, journal: Buffer) {
  if (!value || Object.keys(value).sort().join(',') !== 'completed,events,journal_sha256,pending,run_id,schema_version,session_sha256' ||
      value.schema_version !== '1.0' || value.run_id !== (initial as { id: string }).id || value.session_sha256 !== digest(session) ||
      value.journal_sha256 !== digest(journal) || !Array.isArray(value.events) || value.events.length > 256 || typeof value.completed !== 'boolean' ||
      value.events.some(e => !['PR_REVISION_LINKED','REVIEW_STARTED','REVIEW_PASSED','RUN_COMPLETED'].includes(e.type)) ||
      value.pending && !['PR_REVISION_LINKED','REVIEW_STARTED','REVIEW_PASSED','RUN_COMPLETED'].includes(value.pending.type))
    clientFail('revision_overlay', 'Original delivery bytes or revision overlay changed; history retained');
  const projection = replayRun(initial, [...events, ...value.events]);
  if (!value.events.length && value.pending?.type !== 'PR_REVISION_LINKED' || !projection.revisions.length && value.events.length ||
      value.completed !== (projection.run.state === 'completed')) clientFail('revision_overlay', 'Invalid revision overlay lifecycle');
  if (value.pending) replayRun(initial, [...events, ...value.events, value.pending]);
  return projection;
}

export function validateRevisionData(data: EventData['PR_REVISION_LINKED'], prepared: any, handoffBody: string) {
  if (!same(data.evidence, prepared.evidence) || data.revision_id !== prepared.revision_id || data.source_sha !== prepared.source_sha ||
      data.previous_head !== prepared.previous_head || data.new_head !== prepared.new_head || data.base_sha !== prepared.base_sha ||
      !same(data.pull_request, prepared.pull_request) || !same(data.previous_handoff, prepared.previous_handoff) ||
      data.ref !== prepared.task.branch || data.handoff.sha256 !== digest(handoffBody))
    clientFail('revision_receipt', 'Revision Event disagrees with its immutable receipt');
  let h: any, metadata: any;
  try {
    const match = /^AWH-HANDOFF v0\.1\n```json\n([\s\S]+?)\n```\nAWH-REVISION v0\.2\.1\n```json\n([\s\S]+?)\n```$/.exec(handoffBody);
    h = JSON.parse(match?.[1] ?? 'null'); metadata = JSON.parse(match?.[2] ?? 'null');
  } catch { clientFail('revision_receipt', 'Stored revision Handoff is invalid'); }
  const url = (number: number) => 'https://github.com/' + data.pull_request.repository + '/pull/' + data.pull_request.number + '#issuecomment-' + number;
  if (!validateHandoff(h, data.new_head).ready_claim_valid || h.producer.run_id !== prepared.run_id || h.producer.executor !== prepared.task.executor_id ||
      h.candidate.pr !== data.pull_request.number || h.candidate.base_sha !== data.base_sha ||
      h.work_item.repo !== prepared.task.repository || h.work_item.issue !== prepared.task.issue ||
      !same(h.verification.checks, data.checks) || !same(h.verification.evidence_refs, [url(data.evidence.comment.number)]) ||
      !same(metadata, { schema_version: '1.0', revision_id: data.revision_id, run_id: prepared.run_id, original_head: data.source_sha,
        previous_head: data.previous_head, new_head: data.new_head, previous_handoff: url(data.previous_handoff.number), evidence: url(data.evidence.comment.number), evidence_sha256: data.evidence.sha256 }))
    clientFail('revision_receipt', 'Stored confirmed Handoff must bind the real Run and complete revision metadata');
}
