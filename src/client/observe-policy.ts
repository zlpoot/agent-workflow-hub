import { deliveryPolicy } from './delivery-policy.js';
import { selectWorkflow } from '../profiles.js';
import { clientFail } from './local.js';
import { comparePolicy, type PolicyFacts } from '../shared/preflight.js';
import type { ProfilePolicy } from '../protocol/index.js';

/** Read-only static comparison, independent of the Deliver allowlist. */
export function observationPolicy(ref: string, version?: string) {
  if (ref === 'future-ui/c1c-acceptance' || ref === 'future-ui/default' || ref === 'webskill/default') return deliveryPolicy(ref, version);
  const [profile, workflow, extra] = ref.split('/');
  if (extra || !profile || !workflow) clientFail('profile', 'No static observation mapping');
  return selectWorkflow({ profile, workflow });
}
export function compareObservedPolicy(policy: ProfilePolicy, ref: string) {
  const fixed = observationPolicy(ref, policy.version);
  const repeatable = fixed.workflow.id === 'repeatable-docs';
  const approved: Partial<PolicyFacts> = { repository: fixed.profile.repository, issue_repository: fixed.workflow.work_item.repo,
    ...(repeatable ? { executor: 'c1c-future-ui-windows' } : { issue: fixed.workflow.work_item.issue }), base: fixed.profile.base,
    branch: fixed.workflow.branch, checks: fixed.workflow.verification_commands, profile_ref: ref };
  const result = comparePolicy(approved, { repository: policy.repository, base: policy.base, branch: policy.branch.ref,
    checks: policy.verification.commands, profile_ref: policy.ref, profile_version: policy.version,
    ...(repeatable ? { executor: policy.executor_restrictions?.executor_ids.length === 1 ? policy.executor_restrictions.executor_ids[0]! : '[ambiguous]' } : {}) });
  if (policy.branch.mode !== (fixed.workflow.id === 'repeatable-docs' ? 'issue_prefix' : 'fixed')) result.status = 'blocked';
  if (repeatable && policy.executor_restrictions?.machine_ids.length !== 1) result.status = 'blocked';
  return result;
}
