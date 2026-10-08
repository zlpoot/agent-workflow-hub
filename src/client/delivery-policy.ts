import { selectWorkflow, type BuilderSelection } from '../profiles.js';
import { clientFail, same } from './local.js';
import type { ProfilePolicy } from '../protocol/index.js';

// Only checked-in Builder policies can authorize execution; CP commands are comparison data.
export function deliveryPolicy(ref: string) {
  if (!['hub/c1d', 'webskill/bootstrap', 'future-ui/bootstrap', 'webskill/default', 'future-ui/default'].includes(ref))
    clientFail('delivery_policy', 'No fixed delivery workflow is registered for this Profile');
  const [profile, workflow] = ref.split('/');
  // C1-C default refs already describe these exact bootstrap policies; keep their identity intact.
  const selection: BuilderSelection = { profile: profile!, workflow: workflow === 'default' ? 'bootstrap' : workflow! };
  return { selection, ...selectWorkflow(selection) };
}
export function matchDeliveryPolicy(policy: ProfilePolicy, ref: string): void {
  const fixed = deliveryPolicy(ref);
  if (policy.ref !== ref || policy.repository !== fixed.profile.repository || policy.base !== fixed.profile.base ||
      policy.branch.ref !== fixed.workflow.branch || !same(policy.verification.commands, fixed.workflow.verification_commands))
    clientFail('delivery_policy', 'Trusted Control Plane policy differs from the fixed Builder policy');
}
