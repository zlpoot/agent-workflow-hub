import { deny, validate } from './security.js';
import { OBSERVATION } from './types.js';

type State = 'passed' | 'blocked' | 'not_checked';
interface Check { state: State; code: string }
const choices = {
  enrollment: [['passed', 'fixture_approved', 'none'], ['blocked', 'pending_approval', 'request_operator_enrollment']],
  client: [['passed', 'fixture_paired', 'none'], ['blocked', 'missing_client', 'complete_private_pairing']],
  git_identity: [['not_checked', 'client_local_claim_only', 'confirm_local_git_identity']],
  branch_verification: [['not_checked', 'not_run', 'run_authorized_verification']],
  provider_app_permissions: [['not_checked', 'no_live_preflight', 'perform_app_readonly_preflight']],
} as const;
type Name = keyof typeof choices;
interface Diagnostics { state: 'blocked' | 'not_checked'; checks: Record<Name, Check> }

// Pure, closed projection of an already scope-checked offline Diagnostics response.
// No CLI, filesystem/network probe, route, production authority or reflected identifiers.
export function doctorDiagnosticContract(value: unknown) {
  const input = validate<Diagnostics>('Diagnostics', value);
  const checks = Object.fromEntries((Object.keys(choices) as Name[]).map(name => {
    const check = input.checks[name];
    const choice = choices[name].find(([state, code]) => state === check.state && code === check.code);
    if (!choice) deny(500, 'diagnostic_projection');
    return [name, { state: choice[0], code: choice[1], safe_next_step: choice[2], ...OBSERVATION }];
  }));
  const blocked = Object.values(checks).some(check => check.state === 'blocked');
  return validate<Record<string, unknown>>('DoctorDiagnostics', {
    state: blocked ? 'blocked' : 'not_checked', checks, ...OBSERVATION,
  });
}
