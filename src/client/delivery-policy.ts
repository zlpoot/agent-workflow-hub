import { selectWorkflow, REPEATABLE_VERSION, TASK_PREFIX, type BuilderSelection } from '../profiles.js';
import { clientFail, same } from './local.js';
import type { ProfilePolicy } from '../protocol/index.js';

// Only checked-in Builder policies can authorize execution; CP commands are comparison data.
export function deliveryPolicy(ref: string, version?: string) {
  if (!['hub/c1d', 'hub/v01-mvp', 'hub/v02-mvp', 'future-ui/c1c-acceptance', 'future-ui/mvp-docs', 'webskill/bootstrap', 'future-ui/bootstrap', 'webskill/default', 'future-ui/default'].includes(ref))
    clientFail('delivery_policy', 'No fixed delivery workflow is registered for this Profile');
  const [profile, workflow] = ref.split('/');
  // C1-C default refs already describe these exact bootstrap policies; keep their identity intact.
  const selection: BuilderSelection = { profile: profile!, workflow: workflow === 'default' ? 'bootstrap' : workflow === 'c1c-acceptance' ? version === REPEATABLE_VERSION ? 'repeatable-docs' : 'mvp-docs' : workflow! };
  return { selection, ...selectWorkflow(selection) };
}
export function matchDeliveryPolicy(policy: ProfilePolicy, ref: string): void {
  const fixed = deliveryPolicy(ref, policy.version);
  if (policy.ref !== ref || policy.repository !== fixed.profile.repository || policy.base !== fixed.profile.base ||
      policy.branch.mode !== (fixed.workflow.id === 'repeatable-docs' ? 'issue_prefix' : 'fixed') ||
      policy.branch.ref !== fixed.workflow.branch || !same(policy.verification.commands, fixed.workflow.verification_commands))
    clientFail('delivery_policy', 'Trusted Control Plane policy differs from the checked-in Builder policy');
  if (fixed.workflow.id === 'repeatable-docs' && (!policy.executor_restrictions ||
      !same(policy.executor_restrictions.executor_ids, ['c1c-future-ui-windows']) || policy.executor_restrictions.machine_ids.length !== 1 || policy.branch.ref !== TASK_PREFIX))
    clientFail('delivery_policy', 'Repeatable delivery requires one trusted Windows executor and machine');
}
