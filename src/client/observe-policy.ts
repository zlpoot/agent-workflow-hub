import { deliveryPolicy, matchDeliveryPolicy } from './delivery-policy.js';
import { comparePolicy, type PolicyFacts } from '../shared/preflight.js';
import type { ProfilePolicy } from '../protocol/index.js';

export const observationPolicy = deliveryPolicy;
export function compareObservedPolicy(policy: ProfilePolicy, ref: string) {
  const fixed = observationPolicy(ref, policy.version);
  const approved: Partial<PolicyFacts> = { repository: fixed.profile.repository, issue_repository: fixed.workflow.work_item.repo,
    ...(fixed.workflow.branch_mode === 'fixed' ? { issue: fixed.workflow.work_item.issue } : {}), base: fixed.profile.base,
    branch: fixed.workflow.branch, checks: fixed.workflow.verification_commands, profile_ref: ref, profile_version: fixed.workflow.version };
  const result = comparePolicy(approved, { repository: policy.repository, base: policy.base, branch: policy.branch.ref,
    checks: policy.verification.commands, profile_ref: policy.ref, profile_version: policy.version });
  try { matchDeliveryPolicy(policy, ref); } catch { result.status = 'blocked'; }
  return result;
}
