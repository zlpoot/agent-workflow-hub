import { readFileSync } from 'node:fs';
import type { BuilderHandoff } from '../validator.js';
import { validateHandoff } from '../validator.js';
import { safeData } from '../control-plane/security.js';
import { clientFail, same } from './local.js';
import { digest, RevisionReceipt, REVISION_COMMAND } from './revision.js';

export interface PublicationComment { id: number; actor: string; actor_type: string; body: string; url: string }
export function publicationBodies(prepared: any, pending: string) {
  safeData(prepared); safeData(pending);
  const match = /^AWH-HANDOFF v0\.1\n```json\n([\s\S]*?)\n```\nAWH-REVISION v0\.2\.1\n```json\n([\s\S]*?)\n```$/.exec(pending);
  if (!match) clientFail('publication_receipt', 'Frozen pending Handoff format is invalid');
  let handoff: BuilderHandoff, metadata: unknown;
  try { handoff = JSON.parse(match[1]!); metadata = JSON.parse(match[2]!); } catch { return clientFail('publication_receipt', 'Invalid frozen Handoff JSON'); }
  const expected: BuilderHandoff = { schema_version: '0.1', kind: 'builder_handoff',
    work_item: { repo: prepared.task.repository, issue: prepared.task.issue },
    candidate: { pr: prepared.pull_request.number, base_sha: prepared.base_sha, head_sha: prepared.new_head },
    producer: { executor: prepared.task.executor_id, run_id: prepared.run_id },
    verification: { subject_sha: prepared.new_head, lifecycle: 'completed', outcome: 'pass', checks: [{ command: REVISION_COMMAND, exit_code: 0 }],
      evidence_refs: [`https://github.com/${prepared.task.repository}/pull/${prepared.pull_request.number}#issuecomment-${prepared.evidence.comment.number}`] },
    handoff: { next_step: 'review', publication: 'pending' } };
  const revision = { schema_version: '1.0', revision_id: prepared.revision_id, run_id: prepared.run_id,
    original_head: prepared.source_sha, previous_head: prepared.previous_head, new_head: prepared.new_head,
    previous_handoff: `https://github.com/${prepared.task.repository}/pull/${prepared.pull_request.number}#issuecomment-${prepared.previous_handoff.number}`,
    evidence: expected.verification.evidence_refs[0], evidence_sha256: prepared.evidence.sha256 };
  if (!same(handoff, expected) || !same(metadata, revision) || !validateHandoff(handoff, prepared.new_head).schema_valid)
    clientFail('publication_receipt', 'Frozen pending Handoff identity differs from its receipt');
  const render = (h: BuilderHandoff) => 'AWH-HANDOFF v0.1\n```json\n' + JSON.stringify(h, null, 2) + '\n```\nAWH-REVISION v0.2.1\n```json\n' + JSON.stringify(revision, null, 2) + '\n```';
  if (render(handoff) !== pending) clientFail('publication_receipt', 'Frozen pending Handoff bytes differ from the original format');
  const confirmed = { ...handoff, handoff: { ...handoff.handoff, publication: 'confirmed' as const } };
  if (!validateHandoff(confirmed, prepared.new_head).ready_claim_valid) clientFail('publication_receipt', 'Invalid confirmed Handoff');
  return { pending, confirmed: render(confirmed), handoff: confirmed };
}
export function publicationObservation(prepared: any, bodies: ReturnType<typeof publicationBodies>, comments: PublicationComment[]) {
  const related = comments.filter(c => c.body.startsWith('AWH-HANDOFF v0.1') &&
    (c.body.includes(prepared.revision_id) || c.body.includes(prepared.run_id) && c.body.includes(prepared.new_head)));
  if (related.length > 1) clientFail('publication_conflict', 'Multiple revision Handoffs; stop for independent reconciliation');
  const c = related[0];
  if (c && (c.actor !== prepared.actor || c.actor_type !== 'Bot' || ![bodies.pending, bodies.confirmed].includes(c.body) ||
      c.id === prepared.evidence.comment.number || c.id === prepared.previous_handoff.number))
    clientFail('publication_conflict', 'Existing revision Handoff has conflicting identity or bytes');
  return c ? { kind: 'existing' as const, comment_id: c.id, body_sha256: digest(c.body), publication: c.body === bodies.confirmed ? 'confirmed' as const : 'pending' as const } :
    { kind: 'negative_observation' as const, comment_id: null, first_post_not_submitted_proven: false, automatic_repost_authorized: false };
}
export function publicationScope(receipt: RevisionReceipt, prepared: any, recovery: string | null, oldBody: string,
  observation: ReturnType<typeof publicationObservation>) {
  return { revision_id: receipt.id, run_id: prepared.run_id, namespace_sha256: prepared.namespace_sha256, repository: prepared.task.repository, issue: prepared.task.issue,
    pr: prepared.pull_request.number, branch: prepared.task.branch, base_sha: prepared.base_sha, original_head: prepared.source_sha,
    previous_head: prepared.previous_head, new_head: prepared.new_head, phase0_sha256: digest(readFileSync(receipt.file(0))),
    phase1_sha256: digest(readFileSync(receipt.file(1))), pending_body_sha256: digest(receipt.phases()[1]!.value.body),
    session_sha256: prepared.session_sha256, journal_sha256: prepared.journal_sha256, cp_events_sha256: prepared.cp_events_sha256,
    evidence_sha256: prepared.evidence.sha256, previous_handoff_sha256: digest(oldBody), recovery_receipt_sha256: recovery, observation };
}
export interface PublicationAuthorization {
  schema_version: '1.0'; kind: 'revision_publication_resume'; decision: 'authorize_once'; revision_id: string;
  run_id: string; pr: number; new_head: string; scope_sha256: string; action: 'post_once' | 'adopt'; comment_id: number | null;
  ambiguity_decision: 'accept_bounded_duplicate_risk' | 'adopt_exact_existing_comment';
}
export function parsePublicationAuthorization(body: string, scope: ReturnType<typeof publicationScope>): PublicationAuthorization {
  const match = /^AWH-PUBLICATION-RESUME v0\.2\.1-R1\n```json\n([\s\S]*?)\n```$/.exec(body);
  if (!match) clientFail('publication_authorization', 'Explicit single-use Human publication authorization is required');
  let a: PublicationAuthorization;
  try { a = JSON.parse(match[1]!); safeData(a); } catch { return clientFail('publication_authorization', 'Invalid Human authorization format'); }
  if (!a || Object.keys(a).sort().join(',') !== 'action,ambiguity_decision,comment_id,decision,kind,new_head,pr,revision_id,run_id,schema_version,scope_sha256' ||
      a.schema_version !== '1.0' || a.kind !== 'revision_publication_resume' || a.decision !== 'authorize_once' ||
      a.revision_id !== scope.revision_id || a.run_id !== scope.run_id || a.pr !== scope.pr || a.new_head !== scope.new_head || a.scope_sha256 !== digest(JSON.stringify(scope)) ||
      (scope.observation.kind === 'negative_observation' ? a.action !== 'post_once' || a.comment_id !== null || a.ambiguity_decision !== 'accept_bounded_duplicate_risk' :
        a.action !== 'adopt' || a.comment_id !== scope.observation.comment_id || a.ambiguity_decision !== 'adopt_exact_existing_comment'))
    clientFail('publication_authorization', 'Human decision does not match the frozen receipt and current observation');
  return a;
}
