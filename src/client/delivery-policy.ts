import { selectWorkflow, type BuilderSelection } from '../profiles.js';
import { clientFail, same } from './local.js';
import type { ProfilePolicy } from '../protocol/index.js';

export function deliveryPolicy(ref: string, version?: string) {
  const [profile, workflow, extra] = ref.split('/');
  if (!profile || !workflow || extra) clientFail('delivery_policy', 'Explicit approved Profile/workflow required');
  const selection: BuilderSelection = { profile, workflow }, approved = selectWorkflow(selection);
  if (version !== undefined && version !== approved.workflow.version) clientFail('delivery_policy', 'Unapproved Profile version');
  return { selection, ...approved };
}
export function matchDeliveryPolicy(policy: ProfilePolicy, ref: string): void {
  const fixed = deliveryPolicy(ref, policy.version);
  if (policy.ref !== ref || policy.repository !== fixed.profile.repository || policy.base !== fixed.profile.base ||
      policy.branch.mode !== fixed.workflow.branch_mode || policy.branch.ref !== fixed.workflow.branch ||
      !same(policy.verification.commands, fixed.workflow.verification_commands) || !same(policy.executor_restrictions, fixed.workflow.executor_restrictions))
    clientFail('delivery_policy', 'Control Plane policy differs from the administrator-approved Builder policy');
}
