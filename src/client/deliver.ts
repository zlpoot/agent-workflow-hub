import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BuilderError, connectBuilder } from '../builder.js';
import { validateHandoff, type BuilderHandoff } from '../validator.js';
import { safeData } from '../control-plane/security.js';
import type { Json } from '../protocol/index.js';
import { AwhClient, type DeliveryObservation } from './client.js';
import { atomicJson, ClientError, clientFail, ignoredDeliveryLogs, inspectRepository, readManifest, same } from './local.js';
import { deliveryPolicy } from './delivery-policy.js';
import { bindWorkflow, type TaskBinding } from '../profiles.js';
import { CLIENT_VERSION } from './version.js';

export interface DeliveryOptions { title: string; body: string; holdDraft?: boolean; issue?: number }
export interface VerificationLog { command: string; exit_code: number; stdout: string; stderr: string; elapsed_ms: number }
export interface DeliveryDependencies {
  connect: typeof connectBuilder;
  verify: (command: string, root: string) => Promise<VerificationLog>;
}
export class DeliveryError extends Error {
  constructor(readonly original: unknown, readonly stage: string) { super('Delivery stopped; original operation failure retained, pending Events require explicit retry'); }
}
const credentialOutput = (value: string) => /-----BEGIN[^\r\n]*PRIVATE KEY-----|\b(?:gh[psuor]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|awh_cp_[A-Za-z0-9_-]+)\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|authorization\s*:\s*(?:basic|bearer)\s+\S+/i.test(value);
const statistic = (output: string, label: string): number | null => {
  const match = new RegExp('(?:#|ℹ) ' + label + ' (\\d+)').exec(output); return match ? Number(match[1]) : null;
};
const defaults: DeliveryDependencies = { connect: connectBuilder, verify: async (command, root) => {
  // These are literal commands from checked-in policies, never shell text from CP/Manifest/user data.
  if (!['git diff --check origin/main...HEAD','pnpm check','pnpm check:foundations','pnpm lint','pnpm typecheck','pnpm test'].includes(command))
    clientFail('delivery_policy', 'Unsupported fixed verification command');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$)/i.test(k)));
  const at = Date.now();
  const r = command === 'git diff --check origin/main...HEAD' ? spawnSync('git', ['-c','core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), 'diff','--check','origin/main...HEAD'], { cwd: root, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', timeout: 10000, windowsHide: true }) : process.platform === 'win32' ? spawnSync('cmd.exe', ['/d','/s','/c',command], { cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024, windowsHide: true }) :
    spawnSync('pnpm', command.slice(5).split(' '), { cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024 });
  const log = { command, exit_code: r.error || r.status === null ? 2 : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', elapsed_ms: Date.now() - at };
  if (credentialOutput(log.stdout) || credentialOutput(log.stderr)) return { ...log, exit_code: 2, stdout: '[verification output suppressed by credential guard]', stderr: '[verification output suppressed by credential guard]' };
  return log;
} };

// Builder returns checked provider identifiers; only these references enter the observation stream.
export async function deliver(client: AwhClient, options: DeliveryOptions, overrides: Partial<DeliveryDependencies> = {}) {
  if (Object.keys(options).some(k => !['title','body','holdDraft','issue'].includes(k)) || typeof options.title !== 'string' || !options.title.trim() ||
      options.title.length > 256 || typeof options.body !== 'string' || options.body.length > 16000 || options.issue !== undefined && (!Number.isSafeInteger(options.issue) || options.issue < 1) || options.holdDraft !== undefined && typeof options.holdDraft !== 'boolean')
    clientFail('arguments', 'Delivery requires a bounded PR title/body and fixed options');
  safeData(options);
  const identity = inspectRepository(client.cwd), deps = { ...defaults, ...overrides };
  ignoredDeliveryLogs(identity);
  let prepared: Awaited<ReturnType<typeof connectBuilder>> | undefined;
  return client.observeDelivery(async o => execute(o), options.issue, async binding => {
    const selected = deliveryPolicy(readManifest(identity).profile.ref, binding.profile_version);
    prepared = await deps.connect({ cwd: () => identity.root }, selected.selection, binding);
    if (prepared.preflight().issue_state !== 'open') clientFail('issue', 'A new Task requires an open ordinary Issue');
  });

  async function execute(o: DeliveryObservation) {
    const selected = deliveryPolicy(readManifest(identity).profile.ref, o.run.profile.version), fixed = { selection: selected.selection, ...bindWorkflow(selected.selection, o.task_binding) };
    if (existsSync(o.journal)) clientFail('delivery_state', 'Recorded delivery cannot be repeated; reconcile uncertain provider operations explicitly');
    const journal: { schema_version: string; run_id: string; source_sha: string; stage: string; disposition: string; refs: Record<string, Json>; task_binding?: TaskBinding } =
      { schema_version: '1.0', run_id: o.run.id, source_sha: identity.sha, stage: 'created', disposition: 'in_progress', refs: {}, ...(o.task_binding ? { task_binding: o.task_binding } : {}) };
    writeFileSync(o.journal, JSON.stringify(journal), { flag: 'wx', mode: 0o600 });
    const stage = (name: string) => { journal.stage = name; atomicJson(o.journal, journal); };
    const exact = () => { const now = inspectRepository(client.cwd); if (!same(now, identity) || now.dirty) clientFail('exact_head', 'Delivery source changed or became dirty; original exact-head verification cannot be reused'); };
    const refs = (values: Record<string, Json>) => { Object.assign(journal.refs, values); atomicJson(o.journal, journal); };
    const github = <K extends 'pull_request' | 'issue_comment'>(kind: K, number: number) => ({ provider: 'github' as const, repository: fixed.profile.repository, kind, number });
    const logs: VerificationLog[] = [], checks: { command: string; exit_code: number }[] = [];
    let openStep = false;
    let readyCandidate: { builder: Awaited<ReturnType<typeof connectBuilder>>; number: number } | null = null;
    try {
      stage('preflight'); await o.emit('STEP_STARTED', { step_id: 'builder-preflight', name: 'GitHub App fixed-scope preflight' }); openStep = true;
      const builder = prepared ?? await deps.connect({ cwd: () => identity.root }, fixed.selection);
      const preflight = builder.preflight();
      await o.emit('STEP_COMPLETED', { step_id: 'builder-preflight', exit_code: 0 }); openStep = false;
      stage('verification'); exact(); await o.emit('VERIFICATION_STARTED', { subject_sha: identity.sha });
      const before = inspectRepository(client.cwd), startedAt = new Date().toISOString();
      const evidenceDirectory = join(identity.root, '.handoff', o.run.id);
      mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
      for (const command of fixed.workflow.verification_commands) {
        const result = await deps.verify(command, identity.root);
        if (result.command !== command || !Number.isSafeInteger(result.exit_code) || result.exit_code < 0 || !Number.isFinite(result.elapsed_ms))
          clientFail('verification', 'Invalid fixed verification result');
        // Injected executors cannot put secret-bearing output into evidence either.
        if (credentialOutput(result.stdout) || credentialOutput(result.stderr)) { result.stdout = '[verification output suppressed]'; result.stderr = '[verification output suppressed]'; result.exit_code = 2; }
        logs.push(result); checks.push({ command, exit_code: result.exit_code });
        atomicJson(join(evidenceDirectory, 'verification.json'), { started_at: startedAt, before_sha: before.sha, after_sha: inspectRepository(client.cwd).sha, logs }, false);
        if (result.exit_code !== 0) {
          const original = new BuilderError('Fixed Builder verification failed (exit code ' + result.exit_code + ')');
          try { await o.emit('VERIFICATION_FAILED', { subject_sha: identity.sha, checks, reason: 'Fixed Builder verification failed; original logs retained locally' }); } catch { /* original verification failure remains authoritative */ }
          throw original;
        }
      }
      exact();
      await o.emit('VERIFICATION_PASSED', { subject_sha: identity.sha, checks });
      stage('push'); exact(); await builder.push(); exact();
      await o.emit('GITHUB_PUSH_COMPLETED', { commit: o.run.source });
      stage('pr-create'); const pr = await builder.createPR(options.title, options.body + (o.task_binding ? '\n\nReferences ' + o.task_binding.repository + '#' + o.task_binding.issue : ''));
      if (pr.head !== identity.sha || !pr.draft) clientFail('exact_head', 'Created PR does not match the verified Draft candidate');
      refs({ repository: fixed.profile.repository, pull_request: pr.number, base_sha: pr.base, head_sha: pr.head, pr_url: pr.url });
      await o.emit('GITHUB_PR_CREATED', { pull_request: github('pull_request', pr.number), base_sha: pr.base, head_sha: pr.head });
      stage('evidence'); exact();
      const metadata = JSON.stringify({ environment: { platform: process.platform, arch: process.arch, node: process.version, client_version: CLIENT_VERSION },
        ...(o.task_binding ? { task_binding: { ...o.task_binding, pull_request: pr.number } } : {}), command_order: fixed.workflow.verification_commands, before_sha: before.sha, after_sha: identity.sha, clean_before: !before.dirty, clean_after: true,
        started_at: startedAt, finished_at: new Date().toISOString(), run_id: o.run.id, actor: preflight.actor, checks,
        statistics: logs.map(log => ({ command: log.command, elapsed_ms: log.elapsed_ms, tests: statistic(log.stdout, 'tests'), pass: statistic(log.stdout, 'pass'), fail: statistic(log.stdout, 'fail') })) }, null, 2);
      const raw = JSON.stringify(logs, null, 2), parts = raw.match(/[\s\S]{1,48000}/g) ?? [];
      if (parts.length > 64) clientFail('evidence_size', 'Builder evidence exceeds bounded publication budget; full local logs retained');
      const evidenceRecords = [];
      for (const [i, part] of parts.entries()) {
        const body = 'Builder evidence\n' + metadata + '\nRaw verification output part ' + (i + 1) + '/' + parts.length + '\n' + part;
        const record = await builder.createComment(pr.number, body);
        if ((await builder.readComment(pr.number, record.id)).body !== body) clientFail('evidence_readback', 'Builder evidence readback mismatch');
        evidenceRecords.push(record);
      }
      const evidence = evidenceRecords[0]!;
      refs({ evidence_comment: evidence.id, evidence_url: evidence.url });
      const handoff: BuilderHandoff = { schema_version: '0.1', kind: 'builder_handoff', work_item: { ...fixed.workflow.work_item },
        candidate: { pr: pr.number, base_sha: pr.base, head_sha: pr.head }, producer: { executor: o.executor_id, run_id: o.run.id },
        verification: { subject_sha: pr.head, lifecycle: 'completed', outcome: 'pass', checks, evidence_refs: evidenceRecords.map(e => e.url) },
        handoff: { next_step: 'review', publication: 'pending' } };
      const task = o.task_binding ? { ...o.task_binding, pull_request: pr.number } : null;
      const render = () => 'AWH-HANDOFF v0.1\n```json\n' + JSON.stringify(handoff, null, 2) + '\n```\n' + JSON.stringify(validateHandoff(handoff, identity.sha)) + (task ? '\nAWH Task Binding v0.2\n' + JSON.stringify(task) : '');
      stage('handoff-pending'); atomicJson(join(evidenceDirectory, 'handoff.pending.json'), handoff);
      const pendingBody = render(), comment = await builder.createComment(pr.number, pendingBody);
      refs({ handoff_comment: comment.id, handoff_url: comment.url });
      if ((await builder.readComment(pr.number, comment.id)).body !== pendingBody) clientFail('handoff_readback', 'Pending Handoff readback mismatch');
      const handoffData = () => ({ handoff_version: '0.1', publication: handoff.handoff.publication,
        pull_request: github('pull_request', pr.number), comment: github('issue_comment', comment.id), base_sha: pr.base, head_sha: pr.head, subject_sha: identity.sha });
      const extensions = { ...(task ? { task_binding: task as unknown as Json } : {}), evidence: evidenceRecords.map(e => github('issue_comment', e.id)), work_item: { provider: 'github', repository: fixed.workflow.work_item.repo, kind: 'issue', number: fixed.workflow.work_item.issue } };
      await o.emit('HANDOFF_PUBLISHED', handoffData(), { ...extensions, builder_milestone: 'evidence_published_and_handoff_pending' });
      stage('handoff-confirmed'); handoff.handoff.publication = 'confirmed';
      const validation = validateHandoff(handoff, identity.sha); if (!validation.ready_claim_valid) clientFail('handoff', 'Confirmed Handoff did not pass the original read-only validator');
      atomicJson(join(evidenceDirectory, 'handoff.confirmed.json'), handoff); atomicJson(join(evidenceDirectory, 'handoff.cli.json'), validation);
      const confirmedBody = render(); await builder.editComment(pr.number, comment.id, confirmedBody);
      if ((await builder.readComment(pr.number, comment.id)).body !== confirmedBody) clientFail('handoff_readback', 'Confirmed Handoff readback mismatch');
      const current = await builder.readPR(pr.number); if (current.head !== identity.sha || current.base !== pr.base || !current.draft) clientFail('exact_head', 'Remote candidate changed before Ready');
      exact(); await o.emit('HANDOFF_PUBLISHED', handoffData(), { ...extensions, builder_milestone: 'handoff_confirmed' });
      let final = current;
      if (!options.holdDraft) { stage('ready'); exact(); readyCandidate = { builder, number: pr.number }; final = await builder.ready(pr.number, identity.sha, handoff, comment.id); }
      stage('waiting'); await o.emit('HANDOFF_PUBLISHED', handoffData(), { ...extensions, builder_milestone: options.holdDraft ? 'waiting_for_human_acceptance' : 'pr_ready_waiting_for_independent_review' });
      journal.disposition = options.holdDraft ? 'draft_waiting_for_acceptance' : 'waiting_for_independent_review'; atomicJson(o.journal, journal);
      return { run_id: o.run.id, pr: final, evidence: { id: evidence.id, url: evidence.url }, handoff: { id: comment.id, url: comment.url },
        disposition: journal.disposition, ...(task ? { task } : {}), authority_verified: false };
    } catch (error) {
      let restorationFailed = false;
      if (readyCandidate) { try { await readyCandidate.builder.restoreDraft(readyCandidate.number, identity.sha); } catch { restorationFailed = true; } }
      journal.disposition = 'stopped';
      let observationFailed = false;
      try { atomicJson(o.journal, journal); } catch { observationFailed = true; }
      if (openStep) { try { await o.emit('STEP_COMPLETED', { step_id: 'builder-preflight', exit_code: 2 }); } catch { /* pending remains durable */ } }
      try { await o.retainFailure('Builder delivery stopped at ' + journal.stage + '; original operation failure retained' + (restorationFailed ? '; Draft restoration could not be confirmed' : ''), journal.stage); } catch { observationFailed = true; }
      const failure = new DeliveryError(error, journal.stage);
      if (restorationFailed) failure.message += '; Draft restoration could not be confirmed';
      if (observationFailed) failure.message += '; local failure observation could not be persisted';
      throw failure;
    }
  }
}

export function deliveryDiagnostic(error: DeliveryError) {
  const original = error.original;
  return { code: 'delivery_stopped', message: error.message, stage: error.stage,
    original: original instanceof BuilderError ? { code: 'builder', message: original.message,
      ...(original.category ? { category: original.category } : {}), ...(original.stage ? { stage: original.stage } : {}),
      ...(original.suppression_reason ? { suppression_reason: original.suppression_reason } : {}) } :
      original instanceof ClientError ? { code: original.code, message: original.message } : { code: 'operation', message: 'Operation details suppressed' } };
}
