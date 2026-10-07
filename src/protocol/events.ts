import { assertEntity, ProtocolError } from './validation.js';
import type { Event, EventData, GitHubNumberRef, Run, RunState } from './types.js';

export interface ReplayResult {
  run: Readonly<Run>; events: readonly Event[]; authority_verified: false;
}
export interface AppendResult extends ReplayResult { disposition: 'appended' | 'idempotent' }
function require(condition: boolean, code: ConstructorParameters<typeof ProtocolError>[0], message: string): asserts condition {
  if (!condition) throw new ProtocolError(code, message);
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
const samePR = (a: GitHubNumberRef<'pull_request'>, b: GitHubNumberRef<'pull_request'>) =>
  a.provider === b.provider && a.repository === b.repository && a.number === b.number;

// Replay derives a runtime projection only. Provider facts remain unverified declarations.
export function replayRun(initial: unknown, history: readonly unknown[]): ReplayResult {
  const run = structuredClone(assertEntity('run', initial));
  require(run.state === 'created', 'state', 'Replay requires an initial created Run');
  require(Array.isArray(history), 'schema', 'Event history must be an array');
  const events: Event[] = [], ids = new Set<string>(), steps = new Map<string, number | null>();
  let verificationSha: string | null = null;
  let candidate: EventData['GITHUB_PR_CREATED'] | null = null;
  let publication: EventData['HANDOFF_PUBLISHED'] | null = null;
  let reviewer: string | null = null;
  const state = (...states: RunState[]) => require(states.includes(run.state), 'state', 'Event is not allowed in the current Run state');
  for (const input of history) {
    const event = structuredClone(assertEntity('event', input));
    require(event.run_id === run.id, 'binding', 'Event belongs to a different Run');
    require(!ids.has(event.id), 'idempotency', 'Stored history contains a duplicate event ID');
    require(event.sequence === events.length + 1, 'sequence', 'Event sequence must start at one and be contiguous');
    require(event.occurred_at >= run.updated_at, 'timestamp', 'Event timestamps must not move backwards');
    const checkPR = (pr: GitHubNumberRef<'pull_request'>, sha: string) => {
      require(candidate !== null && samePR(candidate.pull_request, pr) && candidate.head_sha === sha && verificationSha === sha,
        'binding', 'PR and verification must refer to the same candidate head');
    };
    switch (event.type) {
      case 'RUN_STARTED':
        state('created');
        require(event.payload.data.source_sha === run.source.sha, 'binding', 'Run start must match the recorded source SHA');
        run.state = 'running'; run.started_at = event.occurred_at;
        break;
      case 'STEP_STARTED':
        state('running');
        require(!steps.has(event.payload.data.step_id), 'state', 'Step identity cannot be reused');
        steps.set(event.payload.data.step_id, null);
        break;
      case 'STEP_COMPLETED':
        state('running');
        require(steps.has(event.payload.data.step_id) && steps.get(event.payload.data.step_id) === null, 'state', 'Step completion requires an open step');
        steps.set(event.payload.data.step_id, event.payload.data.exit_code);
        break;
      case 'VERIFICATION_STARTED':
        state('running', 'awaiting_review');
        require([...steps.values()].every(code => code === 0), 'state', 'Verification requires completed successful steps');
        verificationSha = event.payload.data.subject_sha;
        candidate = null; publication = null; reviewer = null; run.state = 'verifying';
        break;
      case 'VERIFICATION_PASSED':
        state('verifying');
        require(event.payload.data.subject_sha === verificationSha, 'binding', 'Verification result must match its start SHA');
        run.state = 'awaiting_review';
        break;
      case 'VERIFICATION_FAILED':
        state('verifying');
        require(event.payload.data.subject_sha === verificationSha, 'binding', 'Verification result must match its start SHA');
        run.state = 'failed'; run.completed_at = event.occurred_at;
        break;
      case 'GITHUB_PUSH_COMPLETED':
        state('running', 'awaiting_review');
        require(event.payload.data.commit.repository === run.source.repository, 'binding', 'Push repository must match the Run project');
        if (run.state === 'awaiting_review') require(event.payload.data.commit.sha === verificationSha, 'binding', 'Push must match the verified head');
        break;
      case 'GITHUB_PR_CREATED':
        state('awaiting_review');
        require(event.payload.data.pull_request.repository === run.source.repository && event.payload.data.head_sha === verificationSha,
          'binding', 'PR must match the verified project candidate');
        require(candidate === null, 'state', 'One candidate PR is allowed per verification cycle');
        candidate = event.payload.data;
        break;
      case 'HANDOFF_PUBLISHED':
        state('awaiting_review');
        checkPR(event.payload.data.pull_request, event.payload.data.head_sha);
        require(event.payload.data.subject_sha === verificationSha && event.payload.data.base_sha === candidate!.base_sha &&
          event.payload.data.comment.repository === run.source.repository, 'binding', 'Handoff must match the verified candidate');
        if (publication) require(event.payload.data.comment.number === publication.comment.number, 'binding', 'Publication updates must use the same Handoff comment');
        publication = event.payload.data;
        break;
      case 'REVIEW_STARTED':
        state('awaiting_review');
        checkPR(event.payload.data.pull_request, event.payload.data.subject_sha);
        require(publication?.publication === 'confirmed', 'state', 'Review requires a declared confirmed Handoff');
        require(event.payload.data.reviewer_executor_id !== run.executor_id, 'binding', 'Builder cannot declare itself the independent reviewer');
        reviewer = event.payload.data.reviewer_executor_id; run.state = 'reviewing';
        break;
      case 'REVIEW_PASSED':
        state('reviewing');
        checkPR(event.payload.data.pull_request, event.payload.data.subject_sha);
        require(event.payload.data.reviewer_executor_id === reviewer && event.payload.data.review.repository === run.source.repository,
          'binding', 'Review result must match the reviewer and project');
        run.state = 'review_passed';
        break;
      case 'RUN_COMPLETED':
        state('review_passed'); run.state = 'completed'; run.completed_at = event.occurred_at;
        break;
      case 'RUN_FAILED':
        state('created', 'running', 'verifying', 'awaiting_review', 'reviewing', 'review_passed');
        run.state = 'failed'; run.completed_at = event.occurred_at;
        break;
    }
    run.updated_at = event.occurred_at;
    ids.add(event.id); events.push(event);
  }
  return immutable({ run, events, authority_verified: false });
}

export function appendEvent(initial: unknown, history: readonly unknown[], input: unknown): AppendResult {
  const previous = replayRun(initial, history), event = assertEntity('event', input);
  const duplicate = previous.events.find(e => e.id === event.id);
  if (duplicate) {
    require(canonical(duplicate) === canonical(event), 'idempotency', 'Event ID retry conflicts with the stored event');
    return immutable({ ...previous, disposition: 'idempotent' });
  }
  const next = replayRun(initial, [...previous.events, event]);
  return immutable({ ...next, disposition: 'appended' });
}
