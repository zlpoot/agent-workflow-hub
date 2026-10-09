import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent, assertEntity, assertClientMetadata, replayRun, validateBindings } from '../protocol/index.js';
import type { ClientMetadata, Event, EventType, Executor, ProjectManifest, ProfilePolicy, ProtocolEntities, Run, WorkItem } from '../protocol/index.js';
import { safeData, MAX_PAYLOAD_BYTES } from '../control-plane/security.js';
import { connectBuilder } from '../builder.js';
import { taskBinding, bindWorkflow, REPEATABLE_VERSION, type TaskBinding } from '../profiles.js';
import { qualifyRecovery, assertRecoveryInspection, exclusiveRecoveryFile, type RecoveryRecord, type RecoveryLink, type RecoveryInspection, type RecoveryJournal } from './recovery.js';
import { CLIENT_VERSION } from './version.js';
import { atomicJson, clientFail, inspectRepository, locked, machine, readConfig, readCredential, readCaCertificate, readJson, readManifest, same, type Machine, type RepositoryIdentity, type ClientConfig } from './local.js';
import { requestJson } from './http.js';
import { deliveryPolicy, matchDeliveryPolicy } from './delivery-policy.js';
import { digest, inspectRevision, parseRevisionEvidence, revisionId, revisionReceipts, RevisionReceipt, validateOverlay, validateRevisionData,
  REVISION_COMMAND, type RevisionOverlay } from './revision.js';
import { validateHandoff, type BuilderHandoff } from '../validator.js';
import type { Json } from '../protocol/index.js';

export const CLIENT_EVENT_TYPES = ['STEP_STARTED', 'STEP_COMPLETED', 'VERIFICATION_STARTED', 'VERIFICATION_PASSED', 'VERIFICATION_FAILED', 'RUN_FAILED'] as const;
interface Session { schema_version: '1.0'; manifest: ProjectManifest; endpoint: string; executor_id: string; machine_id: string;
  initial: Run | null; work_item: WorkItem | null; events: Event[]; pending: Event | null; outbox?: Event[]; task_binding?: TaskBinding; previous_run?: string; recovery?: RecoveryLink }
export interface DeliveryObservation {
  run: Run; executor_id: string; journal: string; task_binding?: TaskBinding; recovery?: RecoveryLink;
  emit(type: EventType, data: unknown, extensions?: Record<string, Json>): Promise<void>;
  retainFailure(reason: string, stage: string): Promise<void>;
}
interface Context { identity: RepositoryIdentity; manifest: ProjectManifest; config: ClientConfig; machine: Machine; metadata: ClientMetadata; executor: Executor; credential: string; path: string }
const terminal = (run: Run) => ['completed', 'failed'].includes(run.state);
function checked<K extends keyof ProtocolEntities>(kind: K, value: unknown): ProtocolEntities[K] { safeData(value); return assertEntity(kind, value); }
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(k => ![...allowed, 'authority_verified'].includes(k))) clientFail('response_schema', 'Unexpected Control Plane response field');
}
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));

export class AwhClient {
  constructor(readonly configPath: string, readonly cwd = process.cwd()) {}
  private context(create = false): Context {
    const identity = inspectRepository(this.cwd), manifest = readManifest(identity), config = readConfig(this.configPath, identity.root);
    const m = machine(config, create), credential = readCredential(config);
    const metadata: ClientMetadata = { schema_version: '1.0', executor_type: config.executor_type, machine_name: m.name, arch: m.arch, client_version: CLIENT_VERSION };
    const executor: Executor = { schema_version: '1.0', kind: 'executor', id: config.executor_id, display_name: config.executor_type + ' on ' + m.name,
      machine: { id: m.id, platform: m.platform } };
    checked('executor', executor); assertClientMetadata(metadata);
    const namespace = createHash('sha256').update(JSON.stringify([manifest.project.id, manifest.project.repository, config.endpoint, config.executor_id])).digest('hex');
    const path = join(config.state_directory, namespace, 'session.json'); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path)) clientFail('state', 'Client session directory cannot be redirected');
    return { identity, manifest, config, machine: m, metadata, executor, credential, path };
  }
  private request(c: Context, path: string, method: 'GET' | 'POST' = 'GET', data?: unknown) {
    if (data !== undefined) safeData(data);
    return requestJson(c.config.endpoint, path, c.credential, method, data, readCaCertificate(c.config));
  }
  private empty(c: Context): Session { return { schema_version: '1.0', manifest: c.manifest, endpoint: c.config.endpoint,
    executor_id: c.executor.id, machine_id: c.machine.id, initial: null, work_item: null, events: [], pending: null }; }
  private validateSession(c: Context, value: unknown): Session {
    const s = value as Session;
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).filter(k => !['outbox','task_binding','previous_run','recovery'].includes(k)).sort().join(',') !== 'endpoint,events,executor_id,initial,machine_id,manifest,pending,schema_version,work_item' ||
        s.schema_version !== '1.0' || !same(checked('manifest', s.manifest), c.manifest) || s.endpoint !== c.config.endpoint ||
        s.executor_id !== c.executor.id || s.machine_id !== c.machine.id || !Array.isArray(s.events) ||
        s.outbox !== undefined && !Array.isArray(s.outbox) || s.events.length + (s.pending ? 1 : 0) + (s.outbox?.length ?? 0) > 256)
      clientFail('state', 'Client session binding is invalid; refusing to discard or replace it');
    if (s.initial === null) {
      if (s.work_item !== null || s.events.length || s.pending !== null || s.outbox?.length) clientFail('state', 'Invalid initial Client session');
    } else {
      const initial = checked('run', s.initial), item = checked('work_item', s.work_item);
      if (initial.state !== 'created' || initial.project_id !== c.manifest.project.id || initial.source.repository !== c.manifest.project.repository ||
          initial.executor_id !== c.executor.id || initial.machine_id !== c.machine.id || initial.work_item_id !== item.id || item.project_id !== initial.project_id)
        clientFail('state', 'Client Run identity does not match the project/machine');
      if (item.reference.repository !== c.manifest.project.repository) {
        const fixed = deliveryPolicy(c.manifest.profile.ref);
        if (item.reference.repository !== fixed.workflow.work_item.repo || item.reference.number !== fixed.workflow.work_item.issue)
          clientFail('state', 'Cross-repository Work Item must match the fixed Builder workflow');
      }
      if (s.task_binding) {
        const { fingerprint, ...data } = s.task_binding, bound = taskBinding(data);
        if (fingerprint !== bound.fingerprint || initial.source.repository !== bound.repository || initial.source.sha !== bound.source_sha ||
            initial.source.ref !== bound.branch || initial.profile.ref !== bound.profile_ref || initial.profile.version !== bound.profile_version ||
            initial.executor_id !== bound.executor_id || initial.machine_id !== bound.machine_id || item.reference.number !== bound.issue || item.reference.repository !== bound.repository)
          clientFail('state', 'Frozen Task binding differs from the Run');
      } else if (initial.profile.version === REPEATABLE_VERSION) clientFail('state', 'Repeatable Run has no frozen Task binding');
      if (s.previous_run !== undefined && (typeof s.previous_run !== 'string' || !/^run-[a-f0-9-]{36}$/.test(s.previous_run))) clientFail('state', 'Invalid previous Run reference');
      if (s.recovery && (Object.keys(s.recovery).sort().join(',') !== 'attempt_id,new_sha,old_sha,predecessor_run_id' ||
          !/^recovery-[a-f0-9-]{36}$/.test(s.recovery.attempt_id) || !/^run-[a-f0-9-]{36}$/.test(s.recovery.predecessor_run_id) ||
          !/^[a-f0-9]{40}$/.test(s.recovery.old_sha) || s.recovery.new_sha !== initial.source.sha || s.previous_run !== s.recovery.predecessor_run_id))
        clientFail('recovery', 'Recovery Session link is invalid');
      s.events.forEach(e => checked('event', e)); replayRun(initial, s.events);
      if (s.pending !== null) { checked('event', s.pending); appendEvent(initial, s.events, s.pending); }
      s.outbox?.forEach(e => checked('event', e));
      replayRun(initial, [...s.events, ...(s.pending ? [s.pending] : []), ...(s.outbox ?? [])]);
    }
    return s;
  }
  private overlay(c: Context, s: Session, sessionPath = c.path): RevisionOverlay | null {
    if (!s.initial) return null;
    const prefix = s.initial.id + '.revision-state.';
    const files = readdirSync(dirname(c.path)).filter(n => n.startsWith(prefix)).sort((a,b) => Number(a.slice(prefix.length).split('.')[0]) - Number(b.slice(prefix.length).split('.')[0]));
    if (files.length > 512) clientFail('revision_overlay', 'Revision state limit reached');
    let latest: RevisionOverlay | null = null;
    for (const [i, name] of files.entries()) {
      if (name !== prefix + i + '.json') clientFail('revision_overlay', 'Revision state sequence is interrupted');
      const envelope = readJson(join(dirname(c.path), name), 16 * 1024 * 1024, false) as { previous_sha256: string | null; value: RevisionOverlay };
      if (!envelope || Object.keys(envelope).sort().join(',') !== 'previous_sha256,value' || envelope.previous_sha256 !== (i ? digest(readFileSync(join(dirname(c.path), files[i-1]!))) : null))
        clientFail('revision_overlay', 'Revision state chain is conflicting');
      validateOverlay(envelope.value, s.initial, s.events, readFileSync(sessionPath), readFileSync(join(dirname(c.path), s.initial.id + '.delivery.json')));
      latest = envelope.value;
    }
    return latest;
  }
  private projected(c: Context, s: Session, path = c.path): Session {
    const o = this.overlay(c, s, path);
    if (!o) {
      if (s.initial && revisionReceipts(dirname(c.path)).some(r => { const p = r.phases(); return p.length === 6 && p[0]!.value.run_id === s.initial!.id; }))
        clientFail('revision_overlay', 'An acknowledged revision is missing its retained state layer');
      return s;
    }
    this.validateRevisionReceipts(c, s, o);
    return this.validateSession(c, { ...s, events: [...s.events, ...o.events], pending: o.pending });
  }
  private load(c: Context): Session { return existsSync(c.path) ? this.projected(c, this.validateSession(c, readJson(c.path, 16 * 1024 * 1024, false))) : this.empty(c); }
  private save(c: Context, s: Session): void {
    this.validateSession(c, s);
    const original = existsSync(c.path) ? this.validateSession(c, readJson(c.path, 16 * 1024 * 1024, false)) : null;
    if (original?.initial && original.initial.id === s.initial?.id && this.overlay(c, original)) {
      this.saveOverlay(c, original, { schema_version: '1.0', run_id: s.initial!.id, session_sha256: digest(readFileSync(c.path)),
        journal_sha256: digest(readFileSync(join(dirname(c.path), s.initial!.id + '.delivery.json'))),
        events: s.events.slice(original.events.length), pending: s.pending, completed: replayRun(s.initial, s.events).run.state === 'completed' });
    } else atomicJson(c.path, s, false);
  }
  private saveOverlay(c: Context, original: Session, value: RevisionOverlay) {
    validateOverlay(value, original.initial, original.events, readFileSync(c.path), readFileSync(join(dirname(c.path), value.run_id + '.delivery.json')));
    const prefix = value.run_id + '.revision-state.', files = readdirSync(dirname(c.path)).filter(n => n.startsWith(prefix));
    exclusiveRecoveryFile(join(dirname(c.path), prefix + files.length + '.json'), JSON.stringify({
      previous_sha256: files.length ? digest(readFileSync(join(dirname(c.path), prefix + (files.length - 1) + '.json'))) : null, value }, null, 2));
  }
  private validateRevisionReceipts(c: Context, original: Session, overlay: RevisionOverlay) {
    for (const event of [...overlay.events, ...(overlay.pending ? [overlay.pending] : [])]) {
      if (event.type !== 'PR_REVISION_LINKED') continue;
      const r = new RevisionReceipt(dirname(c.path), event.payload.data.revision_id), phases = r.phases(), p = phases[0]?.value;
      if (!p || phases.length < 5 || p.run_id !== original.initial!.id || p.namespace_sha256 !== digest(dirname(c.path)) ||
          p.session_sha256 !== overlay.session_sha256 || p.journal_sha256 !== overlay.journal_sha256 || !same(p.task, original.task_binding) ||
          !same(phases[4]!.value.event, event) || phases[4]!.value.event_sha256 !== digest(JSON.stringify(event)) ||
          p.evidence.sha256 !== digest(p.evidence_body)) clientFail('revision_receipt', 'Revision sidecar has no matching immutable receipt');
      validateRevisionData(event.payload.data, p, phases[4]!.value.handoff_body);
      if (phases.length === 6 && (phases[5]!.value.event_id !== event.id || !same(phases[5]!.value.ack?.event, event) ||
          !['appended','idempotent'].includes(phases[5]!.value.ack?.disposition)))
        clientFail('revision_receipt', 'Revision receipt acknowledgment differs from its fixed Event');
    }
  }
  private async project(c: Context) {
    const r = await this.request(c, '/v1/projects/' + encodeURIComponent(c.manifest.project.id)); keys(r, ['project']);
    const p = checked('project', r.project);
    if (p.id !== c.manifest.project.id || p.repository !== c.manifest.project.repository || p.profile_ref !== c.manifest.profile.ref)
      clientFail('response_binding', 'Control Plane Project does not match the Manifest');
    return p;
  }
  private async run(c: Context, initial: Run): Promise<Run> {
    const r = await this.request(c, '/v1/runs/' + encodeURIComponent(initial.id)); keys(r, ['run']);
    const run = checked('run', r.run);
    for (const key of ['id','project_id','work_item_id','executor_id','machine_id','source','profile','created_at'] as const)
      if (!same(run[key], initial[key])) clientFail('response_binding', 'Control Plane Run identity does not match the local Run');
    return run;
  }
  private async executor(c: Context) {
    const r = await this.request(c, '/v1/executors'); keys(r, ['executors']);
    if (!Array.isArray(r.executors) || r.executors.length > 64) clientFail('response_schema', 'Invalid Executor Registry response');
    const entry = r.executors.find((x: unknown) => x && typeof x === 'object' && (x as { executor?: Executor }).executor?.id === c.executor.id);
    if (!entry || !same(checked('executor', entry.executor), c.executor) || !timestamp(entry.last_seen)) clientFail('response_binding', 'Registered Executor does not match this machine; register first');
    safeData(entry); keys(entry, ['executor','last_seen','client']);
    if (entry.client === undefined || !same(assertClientMetadata(entry.client), c.metadata)) clientFail('response_binding', 'Registered Client metadata does not match this installation; register first');
    return entry as { executor: Executor; last_seen: string; client?: ClientMetadata };
  }
  async register() {
    const c = this.context(true);
    return locked(c.path + '.lock', async () => {
      const r = await this.request(c, '/v1/projects/register', 'POST', c.manifest); keys(r, ['project','disposition']);
      if (!['created','idempotent'].includes(String(r.disposition))) clientFail('response_schema', 'Invalid Project registration disposition');
      const p = checked('project', r.project); if (p.id !== c.manifest.project.id || p.repository !== c.manifest.project.repository || p.profile_ref !== c.manifest.profile.ref)
        clientFail('response_binding', 'Project registration response does not match the Manifest');
      const ex = await this.request(c, '/v1/executors/register', 'POST', { executor: c.executor, client: c.metadata }); keys(ex, ['executor','client','last_seen','disposition']);
      if (!['created','idempotent'].includes(String(ex.disposition)) || !same(checked('executor', ex.executor), c.executor) || !same(assertClientMetadata(ex.client), c.metadata) || !timestamp(ex.last_seen))
        clientFail('response_binding', 'Executor registration response does not match this Client');
      const heartbeat = await this.request(c, '/v1/executors/' + encodeURIComponent(c.executor.id) + '/heartbeat', 'POST', {}); keys(heartbeat, ['executor','client','last_seen']);
      if (!same(checked('executor', heartbeat.executor), c.executor) || !same(assertClientMetadata(heartbeat.client), c.metadata) || !timestamp(heartbeat.last_seen)) clientFail('response_binding', 'Invalid heartbeat response');
      return { project: p, executor: c.executor, client: c.metadata, last_seen: heartbeat.last_seen, authority_verified: false };
    });
  }
  async status() {
    const c = this.context(), s = this.load(c), p = await this.project(c), executor = await this.executor(c);
    const timeline = s.initial && (s.events.some(e => e.type === 'PR_REVISION_LINKED') || s.pending?.type === 'PR_REVISION_LINKED') ? await this.timeline(s.initial.id) : null;
    if (timeline && !same(timeline.events.map(e => e.event), s.events) && !same(timeline.events.map(e => e.event), [...s.events, ...(s.pending ? [s.pending] : [])]))
      clientFail('revision_history', 'Status CP history differs from the retained revision projection');
    return { project: p, ...executor, run: s.initial ? await this.run(c, s.initial) : null,
      effective_candidate_head: timeline ? timeline.effective_candidate_head : s.initial ? replayRun(s.initial, s.events).effective_candidate_head : null,
      revisions: timeline ? timeline.revisions : s.initial ? replayRun(s.initial, s.events).revisions : [],
      interrupted_revisions: this.revisionPending(c).map(r => ({ revision_id: r.id, phases: r.phases().length })),
      task: s.task_binding ?? (s.initial ? { issue: s.work_item!.reference.number, branch: s.initial.source.ref, source_sha: s.initial.source.sha, profile: s.initial.profile } : null),
      previous_run: s.previous_run ?? null, recovery: s.recovery ?? null, history: this.history(c).map(old => ({ run_id: old.initial!.id, issue: old.work_item!.reference.number, branch: old.initial!.source.ref, state: replayRun(old.initial!, old.events).run.state })),
      pending_event: s.pending ? { id: s.pending.id, sequence: s.pending.sequence, type: s.pending.type } : null,
      pending_delivery_events: (s.pending ? 1 : 0) + (s.outbox?.length ?? 0), authority_verified: false };
  }
  private makeEvent(c: Context, s: Session, type: EventType, data: unknown, extensions: Record<string, Json> = {}): Event {
    if (!s.initial) clientFail('state', 'Start a Run before reporting an Event');
    const history = [...s.events, ...(s.pending ? [s.pending] : []), ...(s.outbox ?? [])];
    if (history.length >= 256) clientFail('state_limit', 'Client Run event limit reached; explicit recovery is required');
    const run = replayRun(s.initial, history).run;
    const candidate = s.events.find(e => e.type === 'GITHUB_PR_CREATED');
    const task = s.task_binding ? { ...s.task_binding, ...(candidate?.type === 'GITHUB_PR_CREATED' ? { pull_request: candidate.payload.data.pull_request.number } : {}) } : null;
    const e = checked('event', { schema_version: '1.0', kind: 'event', id: 'event-' + randomUUID(), run_id: s.initial.id, sequence: history.length + 1,
      type, occurred_at: [new Date().toISOString(), run.updated_at].sort().at(-1),
      payload: { schema_version: '1.0', data, extensions: { ...(task ? { task_binding: task } : {}), ...(s.recovery ? { verification_recovery: s.recovery } : {}), ...extensions, client: c.metadata, source_dirty: c.identity.dirty } } });
    if (Buffer.byteLength(JSON.stringify(e.payload)) > MAX_PAYLOAD_BYTES) clientFail('payload_size', 'Event payload exceeds the Control Plane limit');
    appendEvent(s.initial, history, e); return e;
  }
  private async flush(c: Context, s: Session) {
    if (!s.initial || !s.pending) clientFail('pending', 'There is no pending Event to retry');
    const expected = appendEvent(s.initial, s.events, s.pending);
    const r = await this.request(c, '/v1/runs/' + encodeURIComponent(s.initial.id) + '/events', 'POST', s.pending);
    keys(r, ['event','run','cursor','disposition']);
    if (!same(checked('event', r.event), s.pending) || !same(checked('run', r.run), expected.run) ||
        !Number.isSafeInteger(r.cursor) || Number(r.cursor) < 1 || !['appended','idempotent'].includes(String(r.disposition)))
      clientFail('response_binding', 'Event acknowledgment does not match the pending operation; retained for recovery');
    s.events.push(s.pending); s.pending = null; this.save(c, s);
    return { event: r.event, run: r.run, cursor: r.cursor, disposition: r.disposition, authority_verified: false };
  }
  async start(issue: number) {
    return this.startRun(issue);
  }
  private async startRun(issue: number, deliveryRef?: string, binding?: TaskBinding) {
    if (!Number.isSafeInteger(issue) || issue < 1) clientFail('arguments', 'A positive Issue number is required');
    const c = this.context();
    return locked(c.path + '.lock', async () => {
      const s = this.load(c), p = await this.project(c), ex = await this.executor(c);
      if (this.revisionPending(c).length) clientFail('revision_pending', 'An interrupted revision blocks starting another Run');
      if (s.outbox?.length) clientFail('pending', 'Delivery Events require explicit deliver --retry');
      if (deliveryRef) {
        const currentJournal = s.initial?.id + '.delivery.json';
        const ended = s.initial && terminal(replayRun(s.initial, s.events).run);
        // Check all retained journals before archival: ordinary C1-C start may have
        // archived a delivery Run, but cannot authorize repeating provider writes.
        const journals = readdirSync(dirname(c.path)).filter(name => name.endsWith('.delivery.json') && (name !== currentJournal || ended));
        if (binding) await this.completedJournals(c, s, binding, journals);
        else if (journals.length)
          clientFail('delivery_reconciliation', 'Retained delivery requires explicit provider reconciliation and an approved fresh candidate; Event retry does not authorize another delivery');
      }
      if (s.initial && terminal(replayRun(s.initial, s.events).run)) {
        const archive = join(dirname(c.path), s.initial.id + '.json');
        try { writeFileSync(archive, readFileSync(c.path), { flag: 'wx', mode: 0o600 }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (!readFileSync(archive).equals(readFileSync(c.path))) clientFail('state', 'Archived Run conflict'); }
        const previous = s.initial.id;
        delete s.task_binding; delete s.outbox; delete s.recovery; Object.assign(s, this.empty(c)); s.previous_run = previous;
      }
      if (!s.initial) {
        const r = await this.request(c, '/v1/profiles?project_id=' + encodeURIComponent(p.id)); keys(r, ['profiles']);
        if (!Array.isArray(r.profiles) || r.profiles.length === 0 || r.profiles.length > 256) clientFail('response_schema', 'Invalid trusted Profile Registry response');
        const policies = r.profiles.map(v => checked('profile_policy', v)).filter(policy => policy.ref === c.manifest.profile.ref &&
          policy.repository === c.manifest.project.repository && (!c.config.profile_version || policy.version === c.config.profile_version));
        if (policies.length !== 1) clientFail('profile', 'Select one exact registered Profile version in the external Client config');
        const policy: ProfilePolicy = policies[0]!;
        if (deliveryRef) matchDeliveryPolicy(policy, deliveryRef);
        const itemRepo = deliveryRef ? deliveryPolicy(deliveryRef, binding?.profile_version).workflow.work_item.repo : p.repository;
        const workItem: WorkItem = { schema_version: '1.0', kind: 'work_item', id: 'work-' + createHash('sha256').update(JSON.stringify([p.id, itemRepo, issue])).digest('hex'),
          project_id: p.id, reference: { provider: 'github', repository: itemRepo, kind: 'issue', number: issue } };
        const now = new Date().toISOString();
        const initial: Run = { schema_version: '1.0', kind: 'run', id: 'run-' + randomUUID(), project_id: p.id, work_item_id: workItem.id,
          executor_id: c.executor.id, machine_id: c.machine.id, source: { provider: 'github', repository: c.identity.repository, sha: c.identity.sha, ref: c.identity.ref },
          profile: { ref: policy.ref, version: policy.version }, state: 'created', created_at: now, updated_at: now, started_at: null, completed_at: null };
        if (!validateBindings({ manifest: c.manifest, project: p, profile_policy: policy, executor: ex.executor, work_item: workItem, run: initial }).valid)
          clientFail('binding', 'Run binding violates the registered Profile policy');
        if (binding) s.task_binding = binding;
        s.initial = initial; s.work_item = workItem; s.pending = this.makeEvent(c, s, 'RUN_STARTED', { source_sha: initial.source.sha }); this.save(c, s);
      }
      if (binding && !same(s.task_binding, binding)) clientFail('active_run', 'An existing Run has a different frozen Task binding');
      if (s.work_item!.reference.number !== issue || s.work_item!.reference.repository !== (deliveryRef ? deliveryPolicy(deliveryRef, binding?.profile_version).workflow.work_item.repo : p.repository)) clientFail('active_run', 'A different Issue Run is active; finish it explicitly before starting another');
      if (s.events.length) {
        if (s.pending) clientFail('pending', 'Retry the pending Event explicitly before another operation');
        return { run: await this.run(c, s.initial!), disposition: 'idempotent', authority_verified: false };
      }
      const work = await this.request(c, '/v1/work-items/register', 'POST', s.work_item); keys(work, ['work_item','disposition']);
      if (!['created','idempotent'].includes(String(work.disposition)) || !same(checked('work_item', work.work_item), s.work_item)) clientFail('response_binding', 'Work Item acknowledgment mismatch');
      const created = await this.request(c, '/v1/runs', 'POST', s.initial); keys(created, ['run','disposition']);
      if (!['created','idempotent'].includes(String(created.disposition))) clientFail('response_schema', 'Invalid Run creation disposition');
      const returned = checked('run', created.run); for (const key of ['id','project_id','work_item_id','executor_id','machine_id','source','profile','created_at'] as const)
        if (!same(returned[key], s.initial![key])) clientFail('response_binding', 'Run creation acknowledgment mismatch');
      return this.flush(c, s);
    });
  }
  async event(type: string | null, data?: unknown) {
    if (type !== null && !(CLIENT_EVENT_TYPES as readonly string[]).includes(type)) clientFail('event_type', 'Only C1-C runtime Event types are available; delivery and Review reporting remain unavailable');
    const c = this.context();
    return locked(c.path + '.lock', async () => {
      const s = this.load(c); if (!s.initial || s.events.length === 0) clientFail('state', 'A started Run is required');
      if (s.events.some(e => e.type === 'PR_REVISION_LINKED') || this.revisionPending(c).length)
        clientFail('revision_pending', 'Revision lifecycle Events require link-revision --retry or sync');
      if (s.outbox?.length) clientFail('pending', 'Delivery Events require explicit deliver --retry');
      if (s.pending) {
        if (type !== null && (s.pending.type !== type || !same(s.pending.payload.data, data))) clientFail('pending', 'A different Event is pending; retry it explicitly without changing ID/sequence');
      } else {
        if (type === null) clientFail('pending', 'There is no pending Event to retry');
        s.pending = this.makeEvent(c, s, type as EventType, data); this.save(c, s);
      }
      return this.flush(c, s);
    });
  }
  async finish(failed = false, data?: unknown) {
    if (failed) return { ...await this.event('RUN_FAILED', data), reporting_finished: true };
    const c = this.context(), s = this.load(c);
    if (!s.initial || s.pending || s.outbox?.length) clientFail('state', 'A Run without a pending Event is required');
    const run = await this.run(c, s.initial);
    if (!terminal(run)) clientFail('review_gate', 'Successful completion requires C1-A independent delivery/Review; use finish --outcome failed --data for an explicitly unsuccessful test Run');
    return { run, reporting_finished: true, authority_verified: false };
  }

  // Separate from the generic runtime Event CLI: fixed delivery, one writer, no Review emission.
  async observeDelivery<T>(action: (observation: DeliveryObservation) => Promise<T>, issue?: number,
    preflight?: (binding: TaskBinding, recovery?: RecoveryLink) => Promise<void>,
    recovery?: { fromRun: string; inspect: (binding: TaskBinding) => Promise<RecoveryInspection> }): Promise<T> {
    const c = this.context();
    const policies = await this.request(c, '/v1/profiles?project_id=' + encodeURIComponent(c.manifest.project.id)); keys(policies, ['profiles']);
    if (!Array.isArray(policies.profiles) || policies.profiles.length > 256) clientFail('profile', 'Invalid trusted Profile Registry response');
    const matches = policies.profiles.map(v => checked('profile_policy', v)).filter(p => p.ref === c.manifest.profile.ref && (!c.config.profile_version || p.version === c.config.profile_version));
    if (matches.length !== 1) clientFail('profile', 'One exact trusted Profile version is required');
    const policy = matches[0]!; matchDeliveryPolicy(policy, c.manifest.profile.ref);
    const fixed = deliveryPolicy(c.manifest.profile.ref, policy.version), repeatable = fixed.workflow.id === 'repeatable-docs';
    if (repeatable && (!Number.isSafeInteger(issue) || issue! < 1)) clientFail('arguments', 'Repeatable deliver requires --issue');
    if (!repeatable && issue !== undefined && issue !== fixed.workflow.work_item.issue) clientFail('arguments', 'Fixed delivery Issue cannot be changed');
    const binding = repeatable ? taskBinding({ repository: c.identity.repository, issue: issue!, branch: c.identity.ref, source_sha: c.identity.sha,
      profile_ref: policy.ref, profile_version: policy.version, executor_id: c.executor.id, machine_id: c.machine.id }) : undefined;
    if (binding && (!policy.executor_restrictions!.machine_ids.includes(c.machine.id) || c.machine.platform !== 'windows')) clientFail('binding', 'Untrusted repeatable delivery machine');
    const resolved = bindWorkflow(fixed.selection, binding);
    if (c.identity.repository !== resolved.profile.repository || c.identity.ref !== resolved.workflow.branch || c.identity.dirty)
      clientFail('delivery_source', 'Delivery requires the controlled feature branch at an exact clean HEAD');
    if (recovery && !binding) clientFail('recovery', 'Recovery is available only for the repeatable docs-only template');
    if (recovery && binding) await this.recoverVerificationRun(c, binding, recovery.fromRun, recovery.inspect);
    if (binding) {
      await locked(c.path + '.lock', async () => {
        const s = this.load(c);
        if (s.pending && (s.pending.type !== 'RUN_STARTED' || s.events.length) || s.outbox?.length) clientFail('pending', 'Retry pending delivery Events before starting another Task');
        const journals = readdirSync(dirname(c.path)).filter(n => n.endsWith('.delivery.json'));
        await this.completedJournals(c, s, binding, journals);
        if (s.initial && !terminal(replayRun(s.initial, s.events).run) && (s.events.length > 1 || !same(s.task_binding, binding)))
          clientFail('delivery_state', 'A different or delivered Run is still active');
      });
      if (!preflight) clientFail('delivery_policy', 'Repeatable delivery requires App Issue preflight');
      await preflight(binding, this.load(c).recovery);
    }
    await this.startRun(binding?.issue ?? fixed.workflow.work_item.issue, c.manifest.profile.ref, binding);
    return locked(c.path + '.lock', async () => {
      const s = this.load(c);
      if (!s.initial || s.pending || s.outbox?.length || s.events.length !== 1 || s.events[0]?.type !== 'RUN_STARTED' ||
          !same(s.initial.profile, { ref: matches[0]!.ref, version: matches[0]!.version }) ||
          !same(s.initial.source, { provider: 'github', repository: c.identity.repository, sha: c.identity.sha, ref: c.identity.ref }))
        clientFail('delivery_state', 'A fresh exact-source delivery Run is required; retry never repeats GitHub operations');
      const enqueue = (type: EventType, data: unknown, extensions: Record<string, Json> = {}) => {
        if (!['STEP_STARTED','STEP_COMPLETED','VERIFICATION_STARTED','VERIFICATION_PASSED','VERIFICATION_FAILED','GITHUB_PUSH_COMPLETED','GITHUB_PR_CREATED','HANDOFF_PUBLISHED','RUN_FAILED'].includes(type))
          clientFail('event_type', 'Builder observation cannot declare Review or completion');
        const event = this.makeEvent(c, s, type, data, extensions);
        if (!s.pending) s.pending = event; else (s.outbox ??= []).push(event);
        this.save(c, s);
      };
      const flush = async () => {
        while (s.pending) { await this.flush(c, s); if (s.outbox?.length) { s.pending = s.outbox.shift()!; this.save(c, s); } }
      };
      const o: DeliveryObservation = { run: structuredClone(s.initial), executor_id: c.executor.id,
        journal: join(dirname(c.path), s.initial.id + '.delivery.json'), ...(s.task_binding ? { task_binding: s.task_binding } : {}), ...(s.recovery ? { recovery: s.recovery } : {}),
        emit: async (type, data, extensions) => { enqueue(type, data, extensions); await flush(); },
        retainFailure: async (reason, stage) => {
          const alreadyPending = !!s.pending || !!s.outbox?.length;
          const current = replayRun(s.initial!, [...s.events, ...(s.pending ? [s.pending] : []), ...(s.outbox ?? [])]).run;
          if (!terminal(current)) { enqueue('RUN_FAILED', { reason }, { builder_stage: stage }); }
          // A failure remains locally durable even when CP connectivity is lost.
          if (!alreadyPending) { try { await flush(); } catch { /* explicit deliver --retry; never mask the original Builder error */ } }
        } };
      return action(o);
    });
  }
  async timeline(runId?: string) {
    const c = this.context();
    if (runId !== undefined && !/^run-[a-f0-9-]{36}$/.test(runId)) clientFail('arguments', 'Expected a local archived Run id');
    const current = this.load(c), archived = runId ? join(dirname(c.path), runId + '.json') : '';
    const s = !runId || current.initial?.id === runId ? current : this.projected(c, this.validateSession(c, readJson(archived, 16 * 1024 * 1024, false)), archived);
    if (!s.initial) clientFail('state', 'No Run is available');
    const events: { cursor: number; event: Event }[] = [];
    for (let page = 0; page < 3; page++) {
      const after = events.at(-1)?.event.sequence ?? 0;
      const r = await this.request(c, '/v1/runs/' + encodeURIComponent(s.initial.id) + '/events?after=' + after + '&limit=100');
      keys(r, ['events']);
      if (!Array.isArray(r.events) || r.events.length > 100) clientFail('response_schema', 'Invalid Timeline page');
      for (const row of r.events) {
        const event = checked('event', row.event);
        if (!Number.isSafeInteger(row.cursor) || row.cursor < 1 || event.run_id !== s.initial.id || event.sequence !== events.length + 1)
          clientFail('response_binding', 'Timeline cursor or Run sequence mismatch');
        events.push({ cursor: row.cursor, event });
      }
      if (events.length > 256) clientFail('state_limit', 'Timeline exceeds Client history limit');
      if (r.events.length < 100) {
        const projection = replayRun(s.initial, events.map(e => e.event)), run = await this.run(c, s.initial);
        if (!same(run, projection.run)) clientFail('response_binding', 'Timeline and Run replay disagree');
        return { run, events, effective_candidate_head: projection.effective_candidate_head, revisions: projection.revisions, authority_verified: false };
      }
    }
    return clientFail('state_limit', 'Timeline exceeds Client history limit');
  }

  private revisionPending(c: Context, runId?: string) {
    return revisionReceipts(dirname(c.path)).filter(r => {
      const phases = r.phases();
      return phases.length < 6 && (!runId || phases[0]?.value.run_id === runId);
    });
  }
  async linkRevision(options: { run: string; pr: number; head: string; evidenceComment: number }, connect: typeof connectBuilder = connectBuilder) {
    if (Object.keys(options).sort().join(',') !== 'evidenceComment,head,pr,run' || !/^run-[a-f0-9-]{36}$/.test(options.run) ||
        !/^[a-f0-9]{40}$/.test(options.head) || ![options.pr,options.evidenceComment].every(v => Number.isSafeInteger(v) && v > 0))
      clientFail('arguments', 'link-revision requires an existing Run/PR, exact HEAD and evidence comment ID');
    const c = this.context();
    return locked(c.path + '.lock', async () => {
      const s = this.load(c), projection = s.initial ? replayRun(s.initial, s.events) : null;
      if (!s.initial || s.initial.id !== options.run || !s.task_binding || s.pending || s.outbox?.length ||
          projection!.run.state !== 'awaiting_review' || projection!.publication?.publication !== 'confirmed' ||
          projection!.candidate?.pull_request.number !== options.pr || c.identity.dirty || c.identity.sha !== options.head ||
          c.identity.ref !== s.initial.source.ref || this.revisionPending(c).length)
        clientFail('revision_state', 'Revision requires the same clean awaiting-review delivery with no pending or interrupted attempt');
      const fixed = deliveryPolicy(c.manifest.profile.ref, s.initial.profile.version);
      if (fixed.workflow.id !== 'repeatable-docs' || c.config.profile_version !== s.initial.profile.version)
        clientFail('revision_policy', 'First revision MVP supports only the trusted repeatable docs Profile');
      await this.project(c); await this.executor(c);
      const policies = await this.request(c, '/v1/profiles?project_id=' + encodeURIComponent(c.manifest.project.id)); keys(policies, ['profiles']);
      if (!Array.isArray(policies.profiles)) clientFail('response_schema', 'Invalid Profile response');
      const policy = policies.profiles.map(p => checked('profile_policy', p)).filter(p => p.ref === s.initial!.profile.ref && p.version === s.initial!.profile.version);
      if (policy.length !== 1) clientFail('revision_policy', 'Original immutable Profile is missing');
      matchDeliveryPolicy(policy[0]!, s.initial.profile.ref);
      if (!validateBindings({ manifest: c.manifest, project: await this.project(c), profile_policy: policy[0], executor: c.executor, work_item: s.work_item, run: s.initial }).valid)
        clientFail('revision_binding', 'Original Run identity no longer matches its trusted bindings');
      const capability = await this.request(c, '/v1/capabilities'); keys(capability, ['revision_linking','database_version']);
      if (capability.revision_linking !== 'v021-docs-v1' || capability.database_version !== 2)
        clientFail('revision_upgrade', 'CP revision runtime must be independently reviewed and explicitly deployed first');
      const timeline = await this.timeline(s.initial.id);
      if (!same(timeline.events.map(e => e.event), s.events) || !same(timeline.run, projection!.run))
        clientFail('revision_history', 'Original local history and CP timeline must match exactly');
      const journalPath = join(dirname(c.path), s.initial.id + '.delivery.json'), journal = readJson(journalPath) as Record<string, any>;
      const originalCandidate = s.events.find(e => e.type === 'GITHUB_PR_CREATED');
      if (journal.run_id !== s.initial.id || journal.source_sha !== s.initial.source.sha || !same(journal.task_binding, s.task_binding) ||
          !['draft_waiting_for_acceptance','waiting_for_independent_review'].includes(journal.disposition) ||
          originalCandidate?.type !== 'GITHUB_PR_CREATED' || journal.refs?.pull_request !== options.pr || journal.refs.repository !== c.identity.repository ||
          journal.refs.head_sha !== originalCandidate.payload.data.head_sha || originalCandidate.payload.data.head_sha !== s.initial.source.sha ||
          journal.refs.base_sha !== projection!.candidate!.base_sha)
        clientFail('revision_journal', 'Original delivery Journal and frozen candidate must agree');
      const base = projection!.candidate!.base_sha, previous = projection!.effective_candidate_head!;
      const diffs = inspectRevision(c.identity.root, s.initial.source.sha, previous, options.head, base, fixed.workflow.bootstrap_paths!);
      const { fingerprint: _fingerprint, ...task } = s.task_binding;
      const candidateBinding = taskBinding({ ...task, source_sha: options.head });
      const observer = await connect({ cwd: () => c.identity.root }, fixed.selection, candidateBinding, 'observe');
      const actor = observer.preflight().actor;
      const exactPR = async (builder: Awaited<ReturnType<typeof connectBuilder>>) => {
        const p = await builder.readPR(options.pr);
        if (p.number !== options.pr || p.actor !== actor || !p.draft || p.head !== options.head || p.base !== base)
          clientFail('revision_provider', 'Revision requires the same App-owned open Draft PR, original base and explicit new HEAD');
        if (await builder.readRevisionRef() !== options.head) clientFail('revision_provider', 'Fixed remote branch and PR head disagree');
        if (!same(inspectRepository(this.cwd), c.identity)) clientFail('revision_provider', 'Local source changed during revision qualification');
        return p;
      };
      await exactPR(observer);
      const evidence = await observer.readComment(options.pr, options.evidenceComment);
      if (evidence.actor !== actor || evidence.id !== options.evidenceComment) clientFail('revision_evidence', 'Evidence must match the explicit comment and trusted App');
      safeData(evidence.body);
      const verified = parseRevisionEvidence(evidence.body, actor, options.head, base);
      const old = await observer.readComment(options.pr, projection!.publication!.comment.number);
      if (old.actor !== actor || old.id !== projection!.publication!.comment.number) clientFail('revision_handoff', 'Previous Handoff must match the same trusted App and recorded comment');
      const h = /AWH-HANDOFF v0\.1\n```json\n([\s\S]+?)\n```/.exec(old.body);
      let previousHandoff: BuilderHandoff;
      try { previousHandoff = JSON.parse(h?.[1] ?? 'null'); } catch { return clientFail('revision_handoff', 'Original confirmed Handoff is invalid'); }
      if (!validateHandoff(previousHandoff, previous).ready_claim_valid || previousHandoff.producer.run_id !== s.initial.id ||
          previousHandoff.producer.executor !== s.initial.executor_id || previousHandoff.candidate.pr !== options.pr || previousHandoff.candidate.base_sha !== base ||
          previousHandoff.work_item.repo !== s.work_item!.reference.repository || previousHandoff.work_item.issue !== s.work_item!.reference.number)
        clientFail('revision_handoff', 'Previous Handoff must belong to the actual original Run and effective candidate');
      await exactPR(observer);
      const id = revisionId(s.initial.id, s.task_binding, previous, options.head, options.pr), receipt = new RevisionReceipt(dirname(c.path), id);
      if (receipt.phases().length) clientFail('revision_receipt', 'Revision attempt is already consumed; no provider replay');
      const github = (number: number) => ({ provider: 'github' as const, repository: c.identity.repository, kind: 'issue_comment' as const, number });
      const prepared = { revision_id: id, run_id: s.initial.id, namespace_sha256: digest(dirname(c.path)), task: s.task_binding,
        session_sha256: digest(readFileSync(c.path)), journal_sha256: digest(readFileSync(journalPath)), cp_events_sha256: digest(JSON.stringify(s.events)),
        source_sha: s.initial.source.sha, previous_head: previous, new_head: options.head, base_sha: base,
        pull_request: projection!.candidate!.pull_request, previous_handoff: projection!.publication!.comment,
        evidence: { comment: github(evidence.id), sha256: digest(evidence.body) }, evidence_body: evidence.body, verified, diffs, actor };
      receipt.append(prepared);
      const publisher = await connect({ cwd: () => c.identity.root }, fixed.selection, candidateBinding, 'revision');
      if (publisher.preflight().actor !== actor) clientFail('revision_provider', 'App identity changed before Handoff publication');
      await exactPR(publisher);
      if ((await publisher.readComment(options.pr, evidence.id)).body !== evidence.body || (await publisher.readComment(options.pr, old.id)).body !== old.body)
        clientFail('revision_provider', 'Evidence or prior Handoff changed before publication');
      const handoff: BuilderHandoff = { schema_version: '0.1', kind: 'builder_handoff', work_item: { repo: c.identity.repository, issue: s.work_item!.reference.number },
        candidate: { pr: options.pr, base_sha: base, head_sha: options.head }, producer: { executor: s.initial.executor_id, run_id: s.initial.id },
        verification: { subject_sha: options.head, lifecycle: 'completed', outcome: 'pass', checks: [{ command: REVISION_COMMAND, exit_code: 0 }], evidence_refs: [evidence.url] },
        handoff: { next_step: 'review', publication: 'pending' } };
      const metadata = { schema_version: '1.0', revision_id: id, run_id: s.initial.id, original_head: s.initial.source.sha, previous_head: previous,
        new_head: options.head, previous_handoff: old.url, evidence: evidence.url, evidence_sha256: digest(evidence.body) };
      const render = () => 'AWH-HANDOFF v0.1\n```json\n' + JSON.stringify(handoff, null, 2) + '\n```\nAWH-REVISION v0.2.1\n```json\n' + JSON.stringify(metadata, null, 2) + '\n```';
      receipt.append({ stage: 'publishing_pending_handoff', body: render() });
      const comment = await publisher.createComment(options.pr, render());
      if (comment.actor !== actor || comment.id === old.id || comment.id === evidence.id)
        clientFail('revision_handoff', 'New Handoff must have a fresh App-owned comment identity');
      receipt.append({ stage: 'pending_handoff_created', comment, body: render() });
      if ((await publisher.readComment(options.pr, comment.id)).body !== render()) clientFail('revision_handoff', 'Pending Handoff readback mismatch');
      handoff.handoff.publication = 'confirmed';
      if (!validateHandoff(handoff, options.head).ready_claim_valid) clientFail('revision_handoff', 'Confirmed revision Handoff is invalid');
      receipt.append({ stage: 'confirming_handoff', comment_id: comment.id, body: render() });
      await publisher.editComment(options.pr, comment.id, render());
      if ((await publisher.readComment(options.pr, comment.id)).body !== render()) clientFail('revision_handoff', 'Confirmed Handoff readback mismatch');
      await exactPR(publisher);
      if ((await publisher.readComment(options.pr, evidence.id)).body !== evidence.body || (await publisher.readComment(options.pr, old.id)).body !== old.body)
        clientFail('revision_provider', 'Evidence or previous Handoff changed during publication');
      const finalTimeline = await this.timeline(s.initial.id);
      if (!same(finalTimeline.events.map(e => e.event), s.events) || !same(finalTimeline.run, projection!.run))
        clientFail('revision_history', 'CP history changed before linking; retain confirmed Handoff and receipt');
      const event = this.makeEvent(c, s, 'PR_REVISION_LINKED', { revision_id: id, source_sha: prepared.source_sha, previous_head: previous, new_head: options.head,
        base_sha: base, ref: s.initial.source.ref, pull_request: prepared.pull_request, previous_handoff: prepared.previous_handoff,
        evidence: prepared.evidence, handoff: { comment: github(comment.id), sha256: digest(render()) }, checks: handoff.verification.checks });
      receipt.append({ stage: 'event_ready', event, event_sha256: digest(JSON.stringify(event)), handoff_body: render() });
      const original = this.validateSession(c, readJson(c.path, 16 * 1024 * 1024, false));
      this.saveOverlay(c, original, { schema_version: '1.0', run_id: s.initial.id, session_sha256: prepared.session_sha256, journal_sha256: prepared.journal_sha256,
        events: s.events.slice(original.events.length), pending: event, completed: false });
      s.pending = event;
      const ack = await this.flush(c, s); receipt.append({ stage: 'acknowledged', event_id: event.id, ack });
      return { ...ack, revision_id: id, effective_candidate_head: options.head, handoff: comment.url, github_mutations: 2 };
    });
  }
  async retryRevision() {
    const c = this.context();
    return locked(c.path + '.lock', async () => {
      const s = this.load(c), receipts = this.revisionPending(c);
      if (!s.initial || receipts.length !== 1 || receipts[0]!.phases().length !== 5)
        clientFail('revision_retry', 'Only a fully confirmed revision with a fixed Event permits ACK-only retry');
      const receipt = receipts[0]!, phases = receipt.phases(), prepared = phases[0]!.value, event = checked('event', phases[4]!.value.event);
      if (event.type !== 'PR_REVISION_LINKED' || prepared.run_id !== s.initial.id || prepared.namespace_sha256 !== digest(dirname(c.path)) ||
          !same(prepared.task, s.task_binding) || prepared.session_sha256 !== digest(readFileSync(c.path)) ||
          prepared.journal_sha256 !== digest(readFileSync(join(dirname(c.path), s.initial.id + '.delivery.json'))) ||
          phases[4]!.value.event_sha256 !== digest(JSON.stringify(event))) clientFail('revision_retry', 'Fixed revision receipt identity or Event bytes changed');
      validateRevisionData(event.payload.data, prepared, phases[4]!.value.handoff_body);
      if (!s.pending && !s.events.some(e => e.id === event.id)) {
        if (prepared.cp_events_sha256 !== digest(JSON.stringify(s.events))) clientFail('revision_retry', 'Original Event prefix changed');
        const original = this.validateSession(c, readJson(c.path, 16 * 1024 * 1024, false));
        this.saveOverlay(c, original, { schema_version: '1.0', run_id: s.initial.id, session_sha256: prepared.session_sha256, journal_sha256: prepared.journal_sha256,
          events: s.events.slice(original.events.length), pending: event, completed: false }); s.pending = event;
      }
      if (s.pending && !same(s.pending, event)) clientFail('revision_retry', 'A different operation is pending');
      const expected = appendEvent(s.initial, s.events, event), ack = await this.request(c, '/v1/runs/' + s.initial.id + '/events', 'POST', event);
      keys(ack, ['event','run','cursor','disposition']);
      if (!same(checked('event', ack.event), event) || !same(checked('run', ack.run), expected.run) ||
          !['appended','idempotent'].includes(String(ack.disposition)) || !Number.isSafeInteger(ack.cursor) || Number(ack.cursor) < 1)
        clientFail('revision_retry', 'Revision ACK did not match; fixed Event retained');
      if (!s.events.some(e => e.id === event.id)) s.events.push(event); s.pending = null; this.save(c, s);
      receipt.append({ stage: 'acknowledged', event_id: event.id, ack });
      return { ...ack, effective_candidate_head: event.payload.data.new_head, github_mutations: 0, authority_verified: false };
    });
  }

  // Separate provider observation; Builder execution cannot manufacture Review or success.
  async syncDelivery(connect: typeof connectBuilder = connectBuilder) {
    const c = this.context();
    return locked(c.path + '.lock', async () => {
      const s = this.load(c);
      if (!s.initial || s.pending || s.outbox?.length) clientFail('delivery_state', 'A delivered Run without pending Events is required; retry Events explicitly');
      if (this.revisionPending(c).length) clientFail('revision_pending', 'Revision receipt must be acknowledged before Sync');
      const projection = replayRun(s.initial, s.events), effective = projection.effective_candidate_head;
      if ((effective ?? s.initial.source.sha) !== c.identity.sha || s.initial.source.ref !== c.identity.ref || c.identity.dirty)
        clientFail('exact_head', 'Synchronize from the confirmed clean effective delivery candidate');
      const journalPath = join(dirname(c.path), s.initial.id + '.delivery.json');
      const journal = readJson(journalPath) as { run_id: string; source_sha: string; disposition: string; refs: Record<string, Json>; task_binding?: TaskBinding };
      const candidate = projection.candidate;
      if (!candidate || journal.run_id !== s.initial.id || journal.source_sha !== s.initial.source.sha ||
          journal.refs.pull_request !== candidate.pull_request.number ||
          !['draft_waiting_for_acceptance','waiting_for_independent_review','completed'].includes(journal.disposition))
        clientFail('delivery_state', 'Confirmed delivery journal and candidate are required');
      const fixed = deliveryPolicy(c.manifest.profile.ref, s.initial.profile.version);
      if (s.task_binding && !same(journal.task_binding, s.task_binding)) clientFail('delivery_state', 'Journal Task binding mismatch');
      let binding = s.task_binding;
      if (binding && projection.revisions.length) { const { fingerprint: _fingerprint, ...data } = binding; binding = taskBinding({ ...data, source_sha: effective! }); }
      if (projection.revisions.length) {
        const timeline = await this.timeline(s.initial.id);
        if (!same(timeline.events.map(e => e.event), s.events) || !same(timeline.run, projection.run)) clientFail('revision_history', 'CP revision history differs from local projection');
      }
      const builder = await connect({ cwd: () => c.identity.root }, fixed.selection, binding, binding ? 'observe' : undefined);
      const observation = await builder.readLifecycle(candidate.pull_request.number, effective!);
      if (observation.repository !== s.initial.source.repository || observation.pull_request !== candidate.pull_request.number || observation.head_sha !== effective ||
          observation.issue !== s.work_item!.reference.number || observation.issue_repository !== s.work_item!.reference.repository ||
          observation.review && observation.review.subject_sha !== effective || observation.merged && !/^[a-f0-9]{40}$/.test(observation.merge_sha ?? ''))
        clientFail('provider_binding', 'Provider lifecycle differs from the frozen Run');
      const emit = async (type: EventType, data: unknown) => {
        s.pending = this.makeEvent(c, s, type, data, { provider_observation: observation as unknown as Json });
        this.save(c, s); await this.flush(c, s);
      };
      let state = replayRun(s.initial, s.events).run.state;
      if (observation.review && !observation.changes_requested) {
        const reviewer = 'github:' + observation.review.login;
        const payload = { pull_request: candidate.pull_request, subject_sha: effective!, reviewer_executor_id: reviewer };
        if (state === 'awaiting_review') { await emit('REVIEW_STARTED', payload); state = 'reviewing'; }
        if (state === 'reviewing') {
          const started = s.events.find(e => e.type === 'REVIEW_STARTED');
          if (started?.type !== 'REVIEW_STARTED' || started.payload.data.reviewer_executor_id !== reviewer)
            clientFail('review_binding', 'Native Review actor differs from the recorded reviewer');
          await emit('REVIEW_PASSED', { ...payload, review: { provider: 'github', repository: fixed.profile.repository, kind: 'review', number: observation.review.id } }); state = 'review_passed';
        }
        if (state === 'review_passed' && observation.merged && observation.issue_closed) {
          await emit('RUN_COMPLETED', { outcome: 'pass' }); state = 'completed';
        }
      }
      if (state === 'completed') {
        if (!observation.review || !observation.merged || !observation.issue_closed || observation.changes_requested)
          clientFail('closeout_changed', 'Provider facts no longer support recorded completion');
        if (!projection.revisions.length) { journal.disposition = 'completed'; atomicJson(journalPath, journal); }
      }
      return { run: await this.run(c, s.initial), observation, github_mutations: 0, authority_verified: false };
    });
  }

  private history(c: Context): Session[] {
    const names = readdirSync(dirname(c.path)).filter(n => /^run-[a-f0-9-]{36}\.json$/.test(n));
    if (names.length > 1024) clientFail('state_limit', 'Archived Run limit reached');
    return names.map(n => { const path = join(dirname(c.path), n); return this.projected(c, this.validateSession(c, readJson(path, 16 * 1024 * 1024, false)), path); });
  }
  private async completedJournals(c: Context, current: Session, binding: TaskBinding, names: string[], freshPredecessor?: string) {
    const recovered = await this.recoveryRecords(c, current);
    const exempt = (old: Session) => old.initial!.id === freshPredecessor || recovered.has(old.initial!.id);
    const history = this.history(c), sessions = [...history, ...(current.initial ? [current] : [])];
    if (sessions.some(s => s.initial!.source.ref === binding.branch && (s !== current || terminal(replayRun(s.initial!, s.events).run)) &&
        !(s.initial!.id === freshPredecessor || recovered.get(s.initial!.id)?.successor_run_id === current.initial?.id && !terminal(replayRun(current.initial!, current.events).run))))
      clientFail('delivery_reconciliation', 'Task branch is already consumed; use a new Issue and branch');
    if (sessions.some(old => old.events.some(e => e.type === 'GITHUB_PUSH_COMPLETED' || e.type === 'GITHUB_PR_CREATED' || e.type === 'STEP_STARTED' && e.payload.data.step_id === 'builder-preflight') &&
        !names.includes(old.initial!.id + '.delivery.json')))
      clientFail('delivery_reconciliation', 'Delivery Journal is missing; preserve history and reconcile provider state');
    for (const name of names) {
      const old = sessions.find(s => s.initial!.id + '.delivery.json' === name);
      if (old && exempt(old)) continue;
      const j = readJson(join(dirname(c.path), name)) as { run_id: string; source_sha: string; disposition: string; refs: Record<string, Json>; task_binding?: TaskBinding };
      if (!old || old.pending || old.outbox?.length || j.run_id !== old.initial!.id || j.source_sha !== old.initial!.source.sha ||
          (j.disposition !== 'completed' && !(replayRun(old.initial!, old.events).revisions.length &&
            ['draft_waiting_for_acceptance','waiting_for_independent_review'].includes(j.disposition))) || replayRun(old.initial!, old.events).run.state !== 'completed')
        clientFail('delivery_reconciliation', 'Journal is stopped, ambiguous, pending or unfinished; only sync-confirmed completed delivery can be archived');
      const candidate = old.events.find(e => e.type === 'GITHUB_PR_CREATED');
      if (candidate?.type !== 'GITHUB_PR_CREATED' || j.refs.pull_request !== candidate.payload.data.pull_request.number ||
          j.refs.repository !== old.initial!.source.repository || j.refs.head_sha !== old.initial!.source.sha ||
          old.task_binding && !same(old.task_binding, j.task_binding) || !same(await this.run(c, old.initial!), replayRun(old.initial!, old.events).run))
        clientFail('delivery_reconciliation', 'Completed Journal candidate or CP replay disagrees; history retained');
    }
  }

  // Immutable one-shot receipt. A consumed/incomplete attempt never grants a second Run.
  private digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
  private async recoveryRecords(c: Context, current: Session): Promise<Map<string, RecoveryRecord>> {
    const names = readdirSync(dirname(c.path)).filter(n => n.endsWith('.recovery.json'));
    if (names.length > 1024) clientFail('state_limit', 'Recovery receipt limit reached');
    const sessions = [...this.history(c), ...(current.initial ? [current] : [])], result = new Map<string, RecoveryRecord>();
    for (const name of names) {
      const r = readJson(join(dirname(c.path), name)) as RecoveryRecord;
      if (!r || Object.keys(r).sort().join(',') !== 'created_at,evidence_json,hashes,inspection,kind,link,namespace_sha256,predecessor_binding,schema_version,successor_binding,successor_run_id' ||
          r.schema_version !== '1.0' || r.kind !== 'verification_recovery' || !r.link || name !== r.link.predecessor_run_id + '.recovery.json' ||
          r.namespace_sha256 !== this.digest(dirname(c.path)) || !timestamp(r.created_at) || !r.hashes ||
          Object.keys(r.hashes).sort().join(',') !== 'cp_events,evidence,journal,session')
        clientFail('recovery', 'Invalid immutable recovery receipt');
      assertRecoveryInspection(r.inspection, r.successor_binding);
      const old = sessions.find(s => s.initial!.id === r.link.predecessor_run_id), next = sessions.find(s => s.initial!.id === r.successor_run_id);
      if (!old || !next || !same(next.recovery, r.link) || !same(next.task_binding, r.successor_binding) ||
          !same(old.task_binding, r.predecessor_binding) || r.link.old_sha !== old.initial!.source.sha || r.link.new_sha !== next.initial!.source.sha ||
          r.hashes.session !== this.digest(readFileSync(join(dirname(c.path), old.initial!.id + '.json'))) ||
          r.hashes.journal !== this.digest(readFileSync(join(dirname(c.path), old.initial!.id + '.delivery.json'))) ||
          (r.evidence_json === null ? r.hashes.evidence !== null : typeof r.evidence_json !== 'string' || r.hashes.evidence !== this.digest(r.evidence_json)) ||
          r.hashes.cp_events !== this.digest(JSON.stringify(old.events)))
        clientFail('recovery', 'Recovery attempt is incomplete or its retained predecessor bytes changed; no replay allowed');
      const timeline = await this.timeline(old.initial!.id);
      qualifyRecovery(old.initial!, old.events, old.task_binding, !!old.pending || !!old.outbox?.length,
        readJson(join(dirname(c.path), old.initial!.id + '.delivery.json')) as RecoveryJournal,
        r.evidence_json === null ? null : JSON.parse(r.evidence_json), r.successor_binding, timeline.run, timeline.events.map(e => e.event));
      const first = next.events[0] ?? next.pending;
      if (!first || first.type !== 'RUN_STARTED' || !same(first.payload.extensions.verification_recovery, r.link))
        clientFail('recovery', 'Recovery successor has no matching immutable Event link');
      await this.run(c, next.initial!); result.set(old.initial!.id, r);
    }
    return result;
  }
  private async recoverVerificationRun(c: Context, binding: TaskBinding, fromRun: string,
    inspect: (binding: TaskBinding) => Promise<RecoveryInspection>): Promise<void> {
    if (!/^run-[a-f0-9-]{36}$/.test(fromRun)) clientFail('arguments', 'Recovery requires an exact predecessor Run ID');
    await locked(c.path + '.lock', async () => {
      const s = this.load(c), receiptPath = join(dirname(c.path), fromRun + '.recovery.json');
      if (!s.initial || s.initial.id !== fromRun || existsSync(receiptPath))
        clientFail('recovery', 'Recovery predecessor is not current or the one-shot attempt has already been consumed');
      const rawSession = readFileSync(c.path), journalPath = join(dirname(c.path), fromRun + '.delivery.json');
      const journal = readJson(journalPath) as RecoveryJournal, rawJournal = readFileSync(journalPath);
      const evidencePath = join(c.identity.root, '.handoff', fromRun, 'verification.json');
      const evidence = journal.stage === 'verification' ? readJson(evidencePath, 16 * 1024) : null;
      const evidenceJson = evidence === null ? null : readFileSync(evidencePath, 'utf8');
      const timeline = await this.timeline(fromRun);
      qualifyRecovery(s.initial, s.events, s.task_binding, !!s.pending || !!s.outbox?.length, journal, evidence, binding, timeline.run, timeline.events.map(e => e.event));
      const journals = readdirSync(dirname(c.path)).filter(n => n.endsWith('.delivery.json'));
      await this.completedJournals(c, s, binding, journals, fromRun);
      await this.project(c); await this.executor(c);
      const inspection = await inspect(binding); assertRecoveryInspection(inspection, binding);
      if (!same(inspectRepository(this.cwd), c.identity) || c.identity.dirty || !rawSession.equals(readFileSync(c.path)) || !rawJournal.equals(readFileSync(journalPath)) ||
          evidenceJson !== null && evidenceJson !== readFileSync(evidencePath, 'utf8'))
        clientFail('recovery', 'Recovery source or predecessor changed during qualification');
      const now = new Date().toISOString(), initial: Run = { ...s.initial, id: 'run-' + randomUUID(), source: { ...s.initial.source, sha: binding.source_sha },
        state: 'created', created_at: now, updated_at: now, started_at: null, completed_at: null };
      const link: RecoveryLink = { attempt_id: 'recovery-' + randomUUID(), predecessor_run_id: fromRun, old_sha: s.initial.source.sha, new_sha: binding.source_sha };
      const receipt: RecoveryRecord = { schema_version: '1.0', kind: 'verification_recovery', link, namespace_sha256: this.digest(dirname(c.path)),
        predecessor_binding: s.task_binding!, successor_binding: binding, successor_run_id: initial.id,
        hashes: { session: this.digest(rawSession), journal: this.digest(rawJournal), evidence: evidenceJson === null ? null : this.digest(evidenceJson), cp_events: this.digest(JSON.stringify(s.events)) },
        evidence_json: evidenceJson, inspection, created_at: now };
      safeData(receipt); exclusiveRecoveryFile(receiptPath, JSON.stringify(receipt, null, 2));
      const archive = join(dirname(c.path), fromRun + '.json');
      if (existsSync(archive)) { readJson(archive, 16 * 1024 * 1024, false); if (!rawSession.equals(readFileSync(archive))) clientFail('recovery', 'Recovery archive bytes conflict'); }
      else exclusiveRecoveryFile(archive, rawSession);
      const next: Session = { ...this.empty(c), initial, work_item: s.work_item, task_binding: binding, previous_run: fromRun, recovery: link };
      next.pending = this.makeEvent(c, next, 'RUN_STARTED', { source_sha: initial.source.sha }); this.save(c, next);
      const work = await this.request(c, '/v1/work-items/register', 'POST', next.work_item); keys(work, ['work_item','disposition']);
      if (!['created','idempotent'].includes(String(work.disposition)) || !same(checked('work_item', work.work_item), next.work_item)) clientFail('response_binding', 'Recovery Work Item acknowledgment mismatch');
      const created = await this.request(c, '/v1/runs', 'POST', initial); keys(created, ['run','disposition']);
      if (!['created','idempotent'].includes(String(created.disposition)) || !same(checked('run', created.run), initial)) clientFail('response_binding', 'Recovery Run acknowledgment mismatch');
      await this.flush(c, next);
    });
  }

  async retryDelivery() {
    const c = this.context(); deliveryPolicy(c.manifest.profile.ref);
    return locked(c.path + '.lock', async () => {
      const s = this.load(c);
      if (this.revisionPending(c).length) clientFail('revision_pending', 'Revision ACK retry is only available through link-revision --retry');
      if (!s.initial || !existsSync(join(dirname(c.path), s.initial.id + '.delivery.json')))
        clientFail('delivery_state', 'No recorded delivery is available to retry');
      let retried = 0;
      if (!s.pending && s.outbox?.length) { s.pending = s.outbox.shift()!; this.save(c, s); }
      while (s.pending) { await this.flush(c, s); retried++; if (s.outbox?.length) { s.pending = s.outbox.shift()!; this.save(c, s); } }
      return { run: await this.run(c, s.initial), retried_events: retried, github_operations_repeated: false, authority_verified: false };
    });
  }
}
