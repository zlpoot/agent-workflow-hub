import { validateHandoff, type BuilderHandoff, type Result } from '../validator.js';
import { assertEntity, ProtocolError } from './validation.js';
import type { EventOf } from './types.js';

export interface HandoffEventContext {
  id: string; run_id: string; sequence: number; occurred_at: string;
  repository: string; comment_number: number;
}
export function mapHandoffV01(value: unknown, expectedHead: string, context: HandoffEventContext): {
  event: EventOf<'HANDOFF_PUBLISHED'>; validation: Result; authority_verified: false;
} {
  const validation = validateHandoff(value, expectedHead);
  if (!validation.schema_valid) throw new ProtocolError('schema', 'Invalid v0.1 Handoff');
  const record = value as BuilderHandoff;
  if (record.producer.run_id !== context.run_id || record.candidate.head_sha.toLowerCase() !== expectedHead.toLowerCase())
    throw new ProtocolError('binding', 'Handoff must match the Run and expected head');
  if (record.handoff.publication === 'confirmed' && !validation.ready_claim_valid)
    throw new ProtocolError('binding', 'Confirmed Handoff requires a valid v0.1 Ready claim');
  const event: EventOf<'HANDOFF_PUBLISHED'> = {
    schema_version: '1.0', kind: 'event', id: context.id, run_id: context.run_id,
    sequence: context.sequence, type: 'HANDOFF_PUBLISHED', occurred_at: context.occurred_at,
    payload: { schema_version: '1.0', extensions: {}, data: {
      handoff_version: '0.1', publication: record.handoff.publication,
      pull_request: { provider: 'github', repository: context.repository, kind: 'pull_request', number: record.candidate.pr },
      comment: { provider: 'github', repository: context.repository, kind: 'issue_comment', number: context.comment_number },
      base_sha: record.candidate.base_sha.toLowerCase(), head_sha: record.candidate.head_sha.toLowerCase(), subject_sha: record.verification.subject_sha.toLowerCase(),
    } },
  };
  assertEntity('event', event);
  return { event, validation, authority_verified: false };
}
