import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent, assertEntity, assertClientMetadata, replayRun, validateBindings } from '../protocol/index.js';
import type { ClientMetadata, Event, EventType, Executor, ProjectManifest, ProfilePolicy, ProtocolEntities, Run, WorkItem } from '../protocol/index.js';
import { safeData, MAX_PAYLOAD_BYTES } from '../control-plane/security.js';
import { CLIENT_VERSION } from './version.js';
import { atomicJson, clientFail, inspectRepository, locked, machine, readConfig, readCredential, readCaCertificate, readJson, readManifest, same, type Machine, type RepositoryIdentity, type ClientConfig } from './local.js';
import { requestJson } from './http.js';
import { deliveryPolicy, matchDeliveryPolicy } from './delivery-policy.js';
import type { Json } from '../protocol/index.js';

export const CLIENT_EVENT_TYPES = ['STEP_STARTED', 'STEP_COMPLETED', 'VERIFICATION_STARTED', 'VERIFICATION_PASSED', 'VERIFICATION_FAILED', 'RUN_FAILED'] as const;
interface Session { schema_version: '1.0'; manifest: ProjectManifest; endpoint: string; executor_id: string; machine_id: string;
  initial: Run | null; work_item: WorkItem | null; events: Event[]; pending: Event | null; outbox?: Event[] }
export interface DeliveryObservation {
  run: Run; executor_id: string; journal: string;
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
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).filter(k => k !== 'outbox').sort().join(',') !== 'endpoint,events,executor_id,initial,machine_id,manifest,pending,schema_version,work_item' ||
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
      s.events.forEach(e => checked('event', e)); replayRun(initial, s.events);
      if (s.pending !== null) { checked('event', s.pending); appendEvent(initial, s.events, s.pending); }
      s.outbox?.forEach(e => checked('event', e));
      replayRun(initial, [...s.events, ...(s.pending ? [s.pending] : []), ...(s.outbox ?? [])]);
    }
    return s;
  }
  private load(c: Context): Session { return existsSync(c.path) ? this.validateSession(c, readJson(c.path, 16 * 1024 * 1024, false)) : this.empty(c); }
  private save(c: Context, s: Session): void { this.validateSession(c, s); atomicJson(c.path, s, false); }
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
    return { project: p, ...executor, run: s.initial ? await this.run(c, s.initial) : null,
      pending_event: s.pending ? { id: s.pending.id, sequence: s.pending.sequence, type: s.pending.type } : null,
      pending_delivery_events: (s.pending ? 1 : 0) + (s.outbox?.length ?? 0), authority_verified: false };
  }
  private makeEvent(c: Context, s: Session, type: EventType, data: unknown, extensions: Record<string, Json> = {}): Event {
    if (!s.initial) clientFail('state', 'Start a Run before reporting an Event');
    const history = [...s.events, ...(s.pending ? [s.pending] : []), ...(s.outbox ?? [])];
    if (history.length >= 256) clientFail('state_limit', 'Client Run event limit reached; explicit recovery is required');
    const run = replayRun(s.initial, history).run;
    const e = checked('event', { schema_version: '1.0', kind: 'event', id: 'event-' + randomUUID(), run_id: s.initial.id, sequence: history.length + 1,
      type, occurred_at: [new Date().toISOString(), run.updated_at].sort().at(-1),
      payload: { schema_version: '1.0', data, extensions: { ...extensions, client: c.metadata, source_dirty: c.identity.dirty } } });
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
  private async startRun(issue: number, deliveryRef?: string) {
    if (!Number.isSafeInteger(issue) || issue < 1) clientFail('arguments', 'A positive Issue number is required');
    const c = this.context();
    return locked(c.path + '.lock', async () => {
      const s = this.load(c), p = await this.project(c), ex = await this.executor(c);
      if (s.outbox?.length) clientFail('pending', 'Delivery Events require explicit deliver --retry');
      if (s.initial && terminal(replayRun(s.initial, s.events).run)) {
        const archive = join(dirname(c.path), s.initial.id + '.json');
        try { writeFileSync(archive, JSON.stringify(s), { flag: 'wx', mode: 0o600 }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (!same(readJson(archive, 16 * 1024 * 1024, false), s)) clientFail('state', 'Archived Run conflict'); }
        Object.assign(s, this.empty(c));
      }
      if (!s.initial) {
        const r = await this.request(c, '/v1/profiles?project_id=' + encodeURIComponent(p.id)); keys(r, ['profiles']);
        if (!Array.isArray(r.profiles) || r.profiles.length === 0 || r.profiles.length > 256) clientFail('response_schema', 'Invalid trusted Profile Registry response');
        const policies = r.profiles.map(v => checked('profile_policy', v)).filter(policy => policy.ref === c.manifest.profile.ref &&
          policy.repository === c.manifest.project.repository && (!c.config.profile_version || policy.version === c.config.profile_version));
        if (policies.length !== 1) clientFail('profile', 'Select one exact registered Profile version in the external Client config');
        const policy: ProfilePolicy = policies[0]!;
        if (deliveryRef) matchDeliveryPolicy(policy, deliveryRef);
        const itemRepo = deliveryRef ? deliveryPolicy(deliveryRef).workflow.work_item.repo : p.repository;
        const workItem: WorkItem = { schema_version: '1.0', kind: 'work_item', id: 'work-' + createHash('sha256').update(JSON.stringify([p.id, itemRepo, issue])).digest('hex'),
          project_id: p.id, reference: { provider: 'github', repository: itemRepo, kind: 'issue', number: issue } };
        const now = new Date().toISOString();
        const initial: Run = { schema_version: '1.0', kind: 'run', id: 'run-' + randomUUID(), project_id: p.id, work_item_id: workItem.id,
          executor_id: c.executor.id, machine_id: c.machine.id, source: { provider: 'github', repository: c.identity.repository, sha: c.identity.sha, ref: c.identity.ref },
          profile: { ref: policy.ref, version: policy.version }, state: 'created', created_at: now, updated_at: now, started_at: null, completed_at: null };
        if (!validateBindings({ manifest: c.manifest, project: p, profile_policy: policy, executor: ex.executor, work_item: workItem, run: initial }).valid)
          clientFail('binding', 'Run binding violates the registered Profile policy');
        s.initial = initial; s.work_item = workItem; s.pending = this.makeEvent(c, s, 'RUN_STARTED', { source_sha: initial.source.sha }); this.save(c, s);
      }
      if (s.work_item!.reference.number !== issue || s.work_item!.reference.repository !== (deliveryRef ? deliveryPolicy(deliveryRef).workflow.work_item.repo : p.repository)) clientFail('active_run', 'A different Issue Run is active; finish it explicitly before starting another');
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
  async observeDelivery<T>(action: (observation: DeliveryObservation) => Promise<T>): Promise<T> {
    const c = this.context(), fixed = deliveryPolicy(c.manifest.profile.ref);
    if (c.identity.repository !== fixed.profile.repository || c.identity.ref !== fixed.workflow.branch || c.identity.dirty)
      clientFail('delivery_source', 'Delivery requires the fixed feature branch at an exact clean HEAD');
    const policies = await this.request(c, '/v1/profiles?project_id=' + encodeURIComponent(c.manifest.project.id)); keys(policies, ['profiles']);
    if (!Array.isArray(policies.profiles) || policies.profiles.length > 256) clientFail('profile', 'Invalid trusted Profile Registry response');
    const matches = policies.profiles.map(v => checked('profile_policy', v)).filter(p => p.ref === c.manifest.profile.ref && (!c.config.profile_version || p.version === c.config.profile_version));
    if (matches.length !== 1) clientFail('profile', 'One exact trusted Profile version is required');
    matchDeliveryPolicy(matches[0]!, c.manifest.profile.ref);
    await this.startRun(fixed.workflow.work_item.issue, c.manifest.profile.ref);
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
        journal: join(dirname(c.path), s.initial.id + '.delivery.json'),
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
  async retryDelivery() {
    const c = this.context(); deliveryPolicy(c.manifest.profile.ref);
    return locked(c.path + '.lock', async () => {
      const s = this.load(c);
      if (!s.initial || !existsSync(join(dirname(c.path), s.initial.id + '.delivery.json')))
        clientFail('delivery_state', 'No recorded delivery is available to retry');
      let retried = 0;
      if (!s.pending && s.outbox?.length) { s.pending = s.outbox.shift()!; this.save(c, s); }
      while (s.pending) { await this.flush(c, s); retried++; if (s.outbox?.length) { s.pending = s.outbox.shift()!; this.save(c, s); } }
      return { run: await this.run(c, s.initial), retried_events: retried, github_operations_repeated: false, authority_verified: false };
    });
  }
}
