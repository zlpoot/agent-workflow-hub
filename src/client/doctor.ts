import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AwhClient } from './client.js';
import { CLIENT_PACKAGE, CLIENT_VERSION } from './version.js';
import { ClientError, clientFail, inspectRepository, machine, readCaCertificate, readConfig, readCredential, readManifest, same,
  readJson, type ClientConfig, type RepositoryIdentity, type Machine } from './local.js';
import { observationPolicy, compareObservedPolicy } from './observe-policy.js';
import { loadApprovedWorkItem, versionedPreflight, VersionedProfileError, type ApprovedWorkItem } from './versioned-profile.js';
import { formatPreflight, type PolicyFacts, type PolicyPreflight, type PreflightStatus } from '../shared/preflight.js';
import { PROFILES, ProfileError, selectWorkflow } from '../profiles.js';
import { assertEntity, assertClientMetadata, ProtocolError, type ProjectManifest } from '../protocol/index.js';
import { ControlPlaneError, safeData } from '../shared/security.js';
import { externalFilePath, externalPath } from '../shared/external-files.js';
import { requestJson } from './http.js';

export type DoctorStatus = PreflightStatus;
type DoctorSource = 'client_artifact' | 'local_git' | 'manifest_identity' | 'checked_in_profile' | 'external_config' | 'local_state' | 'control_plane_get' | 'not_observed' | 'operator_policy';
type Details = Record<string, string | boolean | number | null | readonly string[] | { repository: string; issue: number | null }>;
export interface DoctorCheck { id: string; status: DoctorStatus; code: string; source: DoctorSource; safe_next_step: string; details?: Details }
export interface DoctorReport {
  schema_version: '1.0'; kind: 'client_doctor'; client: { package: string; version: string };
  mode: 'offline' | 'cp_readonly_probe'; status: DoctorStatus; checks: DoctorCheck[]; policy_preflight?: PolicyPreflight; declared_preflight?: PolicyPreflight; authority_verified: false;
}
const REQUEST_PROFILE = 'Request an approved Profile/version and Work Item through Hub #34; preserve the current branch and project files.';
const PRESERVE = 'Preserve existing state and request bounded operator diagnosis; do not reset, delete, retry delivery or replace identities.';
const CONFIGURE = 'Follow the manual trusted external configuration guide with the owner; do not create, overwrite or rebind an existing configuration.';
const knownFailure = (error: unknown): string => {
  if (error instanceof ProfileError) return 'profile';
  if (error instanceof VersionedProfileError) return 'versioned_' + error.code;
  const code = error instanceof ClientError || error instanceof ProtocolError || error instanceof ControlPlaneError ? error.code : '';
  return ['git','origin','origin_mismatch','manifest','configuration','endpoint','certificate','credential','machine','state','file','platform','recovery','state_limit',
    'revision_overlay','revision_receipt','authentication','http','network','timeout','tls','response_schema','response_size','response_binding','delivery_policy','profile',
    'schema','binding','sequence','idempotency','timestamp','credential_data','invalid_json','body_too_large'].includes(code) ? code : 'invalid_local_or_remote_data';
};
// Only explicitly selected non-secret identity/comparison fields enter the bounded DTO.
const display = (value: string): string => {
  try { if (value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) return '[suppressed]'; safeData(value); return value; }
  catch { return '[suppressed]'; }
};
const knownCommands = new Set(PROFILES.flatMap(p => p.workflows.flatMap(w => [...w.verification_commands])));
const displayCommand = (command: string) => knownCommands.has(command) ? command : '[unregistered command suppressed]';
const fixedPolicy = observationPolicy;
// Diagnostic data only: never infer a current Issue from a retained Session.
const dynamicIssue = (branch: string, prefix: string): number | null => {
  if (!branch.startsWith(prefix)) return null;
  const suffix = branch.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(suffix)) return null;
  const issue = Number(suffix);
  return Number.isSafeInteger(issue) ? issue : null;
};

/** No network unless explicitly requested. Config/Manifest are observations, never authorization. */
export async function doctor(options: { configPath?: string; probeCp?: boolean; cwd?: string;
  trustPath?: string; workItem?: { id: string; version: string }; observationPath?: string } = {}): Promise<DoctorReport> {
  const report: DoctorReport = { schema_version: '1.0', kind: 'client_doctor', client: { package: CLIENT_PACKAGE, version: CLIENT_VERSION },
    mode: options.probeCp ? 'cp_readonly_probe' : 'offline', status: 'not_checked', checks: [], authority_verified: false };
  const add = (id: string, status: DoctorStatus, code: string, source: DoctorSource, safe_next_step: string, details?: Details) => {
    report.checks.push({ id, status, code, source, safe_next_step, ...(details ? { details: structuredClone(details) } : {}) });
  };
  let identity: RepositoryIdentity | undefined, manifest: ProjectManifest | undefined, config: ClientConfig | undefined, m: Machine | undefined;
  let fixed: ReturnType<typeof fixedPolicy> | undefined, local: ReturnType<AwhClient['inspectLocalDiagnostics']> | undefined;
  let approved: ApprovedWorkItem | undefined;
  const versionedRequested = options.trustPath !== undefined || options.workItem !== undefined || options.observationPath !== undefined;
  if (versionedRequested) {
    try {
      if (!options.trustPath || !options.workItem || options.probeCp) clientFail('profile', 'Versioned prototype requires explicit operator trust/selection and offline mode');
      approved = loadApprovedWorkItem(options.trustPath, options.workItem);
      add('policy_source', 'passed', 'operator_pins_and_approvals_match', 'operator_policy', 'Local operator trust root verified; no Provider or shell grant.');
    } catch (error) { add('policy_source', 'blocked', knownFailure(error), 'operator_policy', REQUEST_PROFILE); }
  }
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
    if (pkg.name !== CLIENT_PACKAGE) throw new Error();
    const matches = pkg.version === CLIENT_VERSION && pkg.bin?.awh === 'dist/client/cli.js';
    add('installation', matches ? 'passed' : 'blocked', matches ? 'standalone_metadata_matches' : 'standalone_metadata_conflict', 'client_artifact', 'Verify the supplied tarball version and SHA-256 through the trusted distribution channel.');
  } catch { add('installation', 'not_checked', 'standalone_metadata_not_verified', 'client_artifact', 'Install the verified standalone tarball outside the project and run its awh entry point.'); }
  add('artifact_provenance', 'not_checked', 'tarball_digest_not_verified', 'not_observed', 'Compare the installed artifact with the owner-supplied SHA-256; package metadata alone is not provenance.');
  try {
    identity = inspectRepository(options.cwd);
    const supported = PROFILES.some(p => p.repository === identity!.repository) || approved?.work_item.repository === identity.repository;
    add('repository', supported ? 'passed' : 'blocked', supported ? 'canonical_root_origin_verified' : 'repository_not_in_static_profiles', 'local_git', supported ? 'Continue read-only diagnosis.' : REQUEST_PROFILE,
      { root_verified: true, origin_verified: true, repository: supported ? identity.repository : '[unsupported]', head: identity.sha, branch: display(identity.ref), dirty: identity.dirty });
    add('worktree', identity.dirty ? 'blocked' : 'passed', identity.dirty ? 'worktree_dirty' : 'worktree_clean', 'local_git', identity.dirty ? 'Preserve local changes; arrange an explicitly authorized clean candidate separately.' : 'Continue read-only diagnosis.');
  } catch (error) { add('repository', 'blocked', knownFailure(error), 'local_git', 'Run Doctor inside the intended real Git worktree; ask the owner to diagnose origin/root configuration.'); }
  if (identity) {
    try { manifest = readManifest(identity); add('manifest', 'passed', 'manifest_origin_matches', 'manifest_identity', 'Manifest is project identity only; it does not approve a policy.'); }
    catch (error) { add('manifest', 'blocked', knownFailure(error), 'manifest_identity', 'Ask the owner to inspect the minimal Manifest; preserve its existing contents.'); }
  } else add('manifest', 'not_checked', 'repository_unavailable', 'manifest_identity', CONFIGURE);
  if (options.configPath && identity) {
    try {
      externalFilePath(options.configPath, 64 * 1024);
      const requested = readJson(options.configPath) as ClientConfig;
      // Inspect the declared path before readConfig canonicalizes it; a redirected
      // alias must not become an apparently safe existing state directory.
      try { lstatSync(requested.state_directory); externalPath(requested.state_directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      config = readConfig(options.configPath, identity.root, true);
      // Validate the dedicated secret's safe location/type without reading its contents offline.
      externalFilePath(config.credential_file, 1024);
      if (config.ca_certificate_file) externalFilePath(config.ca_certificate_file, 64 * 1024);
      add('configuration', 'passed', 'external_config_valid', 'external_config', 'Keep the original endpoint, CA, dedicated credential and namespace unchanged.');
    } catch (error) { config = undefined; add('configuration', 'blocked', knownFailure(error), 'external_config', CONFIGURE); }
  } else add('configuration', options.configPath ? 'not_checked' : 'blocked', options.configPath ? 'repository_unavailable' : 'explicit_config_missing', 'external_config', CONFIGURE);
  if (manifest && identity && !versionedRequested) {
    try {
      fixed = fixedPolicy(manifest.profile.ref, config?.profile_version);
      if (fixed.profile.repository !== identity.repository) clientFail('profile', 'Profile and origin disagree');
      add('profile', 'passed', 'static_profile_mapping', 'checked_in_profile', 'This comparison grants no execution or delivery authority.',
        { ref: display(manifest.profile.ref), repository: fixed.profile.repository, base: fixed.profile.base,
          branch: fixed.workflow.branch, work_item: { repository: fixed.workflow.work_item.repo,
            issue: fixed.workflow.id === 'repeatable-docs' ? dynamicIssue(identity.ref, fixed.workflow.branch) : fixed.workflow.work_item.issue }, verification_commands: fixed.workflow.verification_commands });
      const prefix = fixed.workflow.id === 'repeatable-docs';
      const branchMatches = prefix ? dynamicIssue(identity.ref, fixed.workflow.branch) !== null : identity.ref === fixed.workflow.branch;
      add('branch', branchMatches ? 'passed' : 'blocked', branchMatches ? 'branch_matches_static_mapping' : 'branch_profile_conflict', 'checked_in_profile', branchMatches ? 'Continue read-only diagnosis.' : REQUEST_PROFILE,
        { expected_branch: fixed.workflow.branch, actual_branch: display(identity.ref), branch_mode: prefix ? 'issue_prefix' : 'fixed' });
      if (manifest.profile.ref === 'future-ui/c1c-acceptance')
        add('legacy_bootstrap', 'not_checked', 'acceptance_is_not_bootstrap_authorization', 'checked_in_profile', REQUEST_PROFILE,
          { expected_branch: selectWorkflow({ profile: 'future-ui', workflow: 'bootstrap' }).workflow.branch,
            actual_ref: manifest.profile.ref, bootstrap_commands: selectWorkflow({ profile: 'future-ui', workflow: 'bootstrap' }).workflow.verification_commands });
    } catch (error) { fixed = undefined; add('profile', 'blocked', knownFailure(error), 'checked_in_profile', REQUEST_PROFILE); }
  } else add('profile', 'not_checked', versionedRequested ? 'versioned_comparison_below' : 'manifest_unavailable', versionedRequested ? 'operator_policy' : 'checked_in_profile', CONFIGURE);
  add('profile_version', 'not_checked', 'effective_approved_version_not_observed', 'not_observed', REQUEST_PROFILE);
  if (config) {
    try {
      externalPath(config.state_directory); m = machine(config, false);
      add('machine_executor', 'passed', 'existing_machine_executor_valid', 'local_state', 'Local identity exists; CP registration remains a separate observation.', { machine_present: true, executor_present: true });
    } catch (error) { add('machine_executor', 'blocked', knownFailure(error), 'local_state', PRESERVE); }
  } else add('machine_executor', 'not_checked', 'config_unavailable', 'local_state', CONFIGURE);
  if (config && m && options.configPath) {
    try {
      local = new AwhClient(options.configPath, options.cwd).inspectLocalDiagnostics();
      add('client_state', 'passed', 'existing_session_binding_valid', 'local_state', 'Preserve original session and history; local validation does not prove CP synchronization.');
    } catch (error) { add('client_state', 'blocked', knownFailure(error), 'local_state', PRESERVE); }
  } else add('client_state', 'not_checked', 'identity_or_config_unavailable', 'local_state', PRESERVE);
  if (local) {
    add('pending_events', local.pending_events ? 'blocked' : 'passed', local.pending_events ? 'event_ack_pending' : 'no_local_pending_events', 'local_state', local.pending_events ? PRESERVE : 'Continue read-only diagnosis.', { count: local.pending_events });
    const uncertain = local.journal_count || local.interrupted_revisions || local.locked || local.recovery_records;
    add('journal', uncertain ? 'blocked' : 'passed', uncertain ? 'journal_or_reconciliation_requires_inspection' : 'no_local_journals_or_locks', 'local_state', uncertain ? PRESERVE : 'Continue read-only diagnosis.',
      { retained_journals: local.journal_count, interrupted_revisions: local.interrupted_revisions, lock_present: local.locked, recovery_record_present: local.recovery_records });
  } else {
    add('pending_events', 'not_checked', 'session_unavailable', 'local_state', PRESERVE);
    add('journal', 'not_checked', 'session_unavailable', 'local_state', PRESERVE);
  }
  if (fixed && local?.run && local.work_item) {
    const item = local.work_item.reference;
    const expectedIssue = fixed.workflow.id === 'repeatable-docs' ? dynamicIssue(identity!.ref, fixed.workflow.branch) : fixed.workflow.work_item.issue;
    const matches = item.repository === fixed.workflow.work_item.repo && item.number === expectedIssue && local.run.profile.ref === manifest!.profile.ref &&
      (config?.profile_version === undefined || local.run.profile.version === config.profile_version);
    add('work_item', expectedIssue === null ? 'not_checked' : matches ? 'passed' : 'blocked',
      expectedIssue === null ? 'dynamic_issue_unavailable' : matches ? 'local_work_item_matches_static_mapping' : 'work_item_profile_conflict',
      'checked_in_profile', matches ? 'Comparison only; request current approved Work Item authority through #34.' : REQUEST_PROFILE,
      { expected_work_item: { repository: fixed.workflow.work_item.repo, issue: expectedIssue },
        actual_work_item: { repository: display(item.repository), issue: item.number }, observed_ref: display(local.run.profile.ref), observed_version: display(local.run.profile.version) });
  } else add('work_item', 'not_checked', 'local_work_item_unavailable', 'local_state', REQUEST_PROFILE);
  if (fixed && local?.verification_commands) {
    const matches = same(local.verification_commands, fixed.workflow.verification_commands);
    add('verification', matches ? 'passed' : 'blocked', matches ? 'recorded_commands_match' : 'recorded_commands_profile_conflict', 'checked_in_profile', matches ? 'Recorded command comparison only; Doctor does not execute or attest product checks.' : REQUEST_PROFILE,
      { expected_commands: fixed.workflow.verification_commands, actual_commands: local.verification_commands.map(displayCommand) });
  } else add('verification', 'not_checked', 'recorded_checks_unavailable', 'local_state', 'Doctor does not execute checks; compare retained verification records with an approved Profile.');
  if (approved && manifest && identity) {
    try {
      const declared = options.observationPath ? readJson(options.observationPath) as Partial<PolicyFacts> : {};
      const declaration = versionedPreflight(approved, declared);
      if (options.observationPath) {
        report.declared_preflight = declaration;
        add('declared_bindings', declaration.status, 'untrusted_declarations_compared', 'operator_policy', 'Declarations cannot replace actual Git/Manifest/config facts or approve rights.');
      }
      const observed: Partial<PolicyFacts> = { ...declared, repository: identity.repository, branch: identity.ref, profile_ref: manifest.profile.ref,
        ...(config ? { executor: config.executor_id, ...(config.profile_version ? { profile_version: config.profile_version } : {}) } : {}),
        ...(local?.run ? { profile_ref: local.run.profile.ref, profile_version: local.run.profile.version } : {}),
        ...(local?.work_item ? { issue_repository: local.work_item.reference.repository, issue: local.work_item.reference.number } : {}),
        ...(local?.verification_commands ? { checks: local.verification_commands } : {}) };
      report.policy_preflight = versionedPreflight(approved, observed);
      add('versioned_policy', report.policy_preflight.status, 'approved_effective_vs_observed', 'operator_policy', 'Base/check/Issue declarations are observations; Develop only reports data. Deliver requires a separate gate.');
    } catch (error) { add('versioned_policy', 'blocked', knownFailure(error), 'operator_policy', REQUEST_PROFILE); }
  }
  if (options.probeCp && !versionedRequested && config && manifest) {
    try {
      const secret = readCredential(config), ca = readCaCertificate(config);
      const get = (path: string) => requestJson(config!.endpoint, path, secret, 'GET', undefined, ca, { timeoutMs: 3000, maxBytes: 64 * 1024, tlsDiagnostic: true });
      const projectResponse = await get('/v1/projects/' + encodeURIComponent(manifest.project.id)); safeData(projectResponse);
      if (Object.keys(projectResponse).sort().join(',') !== 'authority_verified,project') clientFail('response_schema', 'Invalid Project envelope');
      const project = assertEntity('project', projectResponse.project);
      if (project.id !== manifest.project.id || project.repository !== manifest.project.repository || project.profile_ref !== manifest.profile.ref) clientFail('response_binding', 'CP Project mismatch');
      add('cp_connection', 'passed', 'cp_authenticated_project_get_matches', 'control_plane_get', 'A GET observation does not approve a Profile, delivery, Review or production operation.');
      try {
        const response = await get('/v1/profiles?project_id=' + encodeURIComponent(manifest.project.id)); safeData(response);
        if (Object.keys(response).sort().join(',') !== 'authority_verified,profiles' || !Array.isArray(response.profiles) || response.profiles.length > 256) clientFail('response_schema', 'Invalid Profile envelope');
        const policies = response.profiles.map(p => assertEntity('profile_policy', p)).filter(p => p.ref === manifest!.profile.ref && (!config!.profile_version || p.version === config!.profile_version));
        if (policies.length !== 1) clientFail('profile', 'One observed Profile version required');
        const observed = policies[0]!, expected = observationPolicy(manifest.profile.ref, observed.version);
        const details = { observed_version: display(observed.version), expected_branch: expected.workflow.branch, actual_branch: display(observed.branch.ref),
          expected_commands: expected.workflow.verification_commands, actual_commands: observed.verification.commands.map(displayCommand) };
        try {
          const comparison = compareObservedPolicy(observed, manifest.profile.ref);
          // Preserve the Doctor rule that unregistered CP command text is suppressed.
          const checksDiff = comparison.differences.find(d => d.field === 'checks');
          if (checksDiff) checksDiff.observed = observed.verification.commands.map(displayCommand);
          report.policy_preflight = comparison;
          if (comparison.status === 'blocked') clientFail('profile', 'Observed policy conflicts with static observation mapping');
          add('cp_profile', 'passed', 'cp_policy_matches_static_mapping', 'control_plane_get', 'Observed CP Registry version is comparison data; effective Work Item approval through #34 remains unverified.', details);
        } catch (error) { add('cp_profile', 'blocked', knownFailure(error), 'control_plane_get', REQUEST_PROFILE, details); }
      } catch (error) { add('cp_profile', 'blocked', knownFailure(error), 'control_plane_get', REQUEST_PROFILE); }
      if (m) {
        try {
          const response = await get('/v1/executors'); safeData(response);
          if (Object.keys(response).sort().join(',') !== 'authority_verified,executors' || !Array.isArray(response.executors) || response.executors.length > 64) clientFail('response_schema', 'Invalid Executor envelope');
          const expected = { schema_version: '1.0', kind: 'executor', id: config.executor_id, display_name: config.executor_type + ' on ' + m.name, machine: { id: m.id, platform: m.platform } };
          const entries = response.executors.filter((entry: any) => entry?.executor?.id === config!.executor_id);
          const entry = entries[0] as Record<string, unknown> | undefined;
          if (entries.length !== 1 || !entry || Object.keys(entry).sort().join(',') !== 'client,executor,last_seen' ||
              !same(assertEntity('executor', entry.executor), expected) || !same(assertClientMetadata(entry.client), { schema_version: '1.0', executor_type: config.executor_type, machine_name: m.name, arch: m.arch, client_version: CLIENT_VERSION }) ||
              typeof entry.last_seen !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.last_seen) || !Number.isFinite(Date.parse(entry.last_seen))) clientFail('response_binding', 'Registered executor/Client mismatch');
          add('cp_executor', 'passed', 'cp_existing_registration_matches', 'control_plane_get', 'Preserve the current machine/executor registration.');
        } catch (error) { add('cp_executor', 'blocked', knownFailure(error), 'control_plane_get', PRESERVE); }
      } else add('cp_executor', 'not_checked', 'local_machine_unavailable', 'control_plane_get', PRESERVE);
    } catch (error) {
      add('cp_connection', 'blocked', knownFailure(error), 'control_plane_get', 'Ask the owner to diagnose the original endpoint, CA and dedicated credential under bounded live authorization; no fallback.');
      add('cp_profile', 'not_checked', 'cp_connection_unavailable', 'control_plane_get', REQUEST_PROFILE);
      add('cp_executor', 'not_checked', 'cp_connection_unavailable', 'control_plane_get', PRESERVE);
    }
  } else {
    add('cp_connection', 'not_checked', options.probeCp ? 'config_or_manifest_unavailable' : 'cp_probe_not_requested', 'not_observed', 'Use --probe-cp only with the existing approved config and a separate bounded live authorization for the real CP.');
    add('cp_profile', 'not_checked', 'cp_registry_not_observed', 'not_observed', REQUEST_PROFILE);
    add('cp_executor', 'not_checked', 'cp_registration_not_observed', 'not_observed', PRESERVE);
  }
  for (const [id, code] of [['app_scope','app_selected_set_permissions_not_live_verified'], ['remote_state','github_remote_not_observed'], ['github_review','independent_exact_head_review_not_observed']] as const)
    add(id, 'not_checked', code, 'not_observed', 'Obtain separate authorized live evidence and independent exact-head Review; Doctor does not access GitHub.');
  report.status = report.checks.some(c => c.status === 'blocked') ? 'blocked' : report.checks.some(c => c.status === 'not_checked') ? 'not_checked' : 'passed';
  safeData(report);
  return report;
}

export function formatDoctor(report: DoctorReport): string {
  return [`AWH Doctor ${report.client.version} (${report.mode}): ${report.status}`, ...report.checks.map(c =>
    `${c.status} ${c.id}: ${c.code} [${c.source}]${c.details ? '\n  ' + JSON.stringify(c.details) : ''}\n  Next: ${c.safe_next_step}`),
    ...(report.policy_preflight ? ['Effective observation comparison:', formatPreflight(report.policy_preflight)] : []),
    ...(report.declared_preflight ? ['Untrusted declaration comparison:', formatPreflight(report.declared_preflight)] : []), 'authority_verified=false'].join('\n');
}
export function isDoctorReport(value: unknown): value is DoctorReport {
  return !!value && typeof value === 'object' && (value as DoctorReport).kind === 'client_doctor';
}
