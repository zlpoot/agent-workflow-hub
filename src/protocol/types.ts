export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ProtocolVersion = '1.0';
export interface ProjectManifest {
  apiVersion: 'awh/v1';
  project: { id: string; repository: string };
  profile: { ref: string };
}
export interface Project {
  schema_version: ProtocolVersion;
  kind: 'project';
  id: string;
  repository: string;
  profile_ref: string;
}
export interface ProfilePolicy {
  schema_version: ProtocolVersion;
  kind: 'profile_policy';
  ref: string;
  version: string;
  repository: string;
  base: string;
  branch: { mode: 'fixed' | 'issue_prefix'; ref: string };
  verification: { commands: string[] };
  github_app: {
    identity: 'installation'; repository_scope: 'single'; selected_set_policy: 'exact';
    permissions: { contents: 'write'; issues: 'write'; metadata: 'read'; pull_requests: 'write' };
  };
  review: { mode: 'independent_exact_head'; builder_is_reviewer: false };
  delivery: { draft_pr: true; handoff_version: '0.1'; confirmed_publication_required: true; exact_head_required: true };
  executor_restrictions: { executor_ids: string[]; machine_ids: string[] } | null;
}
export interface Executor {
  schema_version: ProtocolVersion;
  kind: 'executor';
  id: string;
  display_name: string;
  machine: { id: string; platform: 'windows' | 'macos' | 'linux' };
}
export interface GitHubNumberRef<K extends 'issue' | 'pull_request' | 'issue_comment' | 'review'> {
  provider: 'github'; repository: string; kind: K; number: number;
}
export interface GitHubCommitRef {
  provider: 'github'; repository: string; sha: string; ref: string;
}
export interface WorkItem {
  schema_version: ProtocolVersion;
  kind: 'work_item';
  id: string;
  project_id: string;
  reference: GitHubNumberRef<'issue'>;
}
export const RUN_STATES = ['created', 'running', 'verifying', 'awaiting_review', 'reviewing', 'review_passed', 'completed', 'failed'] as const;
export type RunState = typeof RUN_STATES[number];
export interface Run {
  schema_version: ProtocolVersion;
  kind: 'run';
  id: string;
  project_id: string;
  work_item_id: string;
  executor_id: string;
  machine_id: string;
  source: GitHubCommitRef;
  profile: { ref: string; version: string };
  state: RunState;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
}
export interface Check { command: string; exit_code: number }
export interface EventData {
  RUN_STARTED: { source_sha: string };
  STEP_STARTED: { step_id: string; name: string };
  STEP_COMPLETED: { step_id: string; exit_code: number };
  VERIFICATION_STARTED: { subject_sha: string };
  VERIFICATION_PASSED: { subject_sha: string; checks: Check[] };
  VERIFICATION_FAILED: { subject_sha: string; checks: Check[]; reason: string };
  GITHUB_PUSH_COMPLETED: { commit: GitHubCommitRef };
  GITHUB_PR_CREATED: { pull_request: GitHubNumberRef<'pull_request'>; base_sha: string; head_sha: string };
  HANDOFF_PUBLISHED: {
    handoff_version: '0.1'; publication: 'pending' | 'confirmed' | 'failed';
    pull_request: GitHubNumberRef<'pull_request'>; comment: GitHubNumberRef<'issue_comment'>;
    base_sha: string; head_sha: string; subject_sha: string;
  };
  REVIEW_STARTED: { pull_request: GitHubNumberRef<'pull_request'>; subject_sha: string; reviewer_executor_id: string };
  REVIEW_PASSED: {
    pull_request: GitHubNumberRef<'pull_request'>; subject_sha: string; reviewer_executor_id: string;
    review: GitHubNumberRef<'review'>;
  };
  RUN_COMPLETED: { outcome: 'pass' };
  RUN_FAILED: { reason: string };
}
export type EventType = keyof EventData;
export type EventOf<T extends EventType> = {
  schema_version: ProtocolVersion; kind: 'event'; id: string; run_id: string;
  sequence: number; type: T; occurred_at: string;
  payload: { schema_version: ProtocolVersion; data: EventData[T]; extensions: { [key: string]: Json } };
};
export type Event = { [T in EventType]: EventOf<T> }[EventType];
export interface ProtocolEntities {
  manifest: ProjectManifest; project: Project; profile_policy: ProfilePolicy; executor: Executor;
  work_item: WorkItem; run: Run; event: Event;
}
