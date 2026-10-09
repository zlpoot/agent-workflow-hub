import { DatabaseSync } from 'node:sqlite';
import { externalFilePath } from '../shared/external-files.js';
import { appendEvent, assertEntity, assertClientMetadata, validateBindings, type ClientMetadata } from '../protocol/index.js';
import type { Event, Executor, ProfilePolicy, Project, ProtocolEntities, Run, WorkItem } from '../protocol/index.js';
import { executorAccess, fail, MAX_PAYLOAD_BYTES, projectAccess, safeData, type Principal } from './security.js';

export const DATABASE_VERSION = 2;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface StoredEvent { cursor: number; event: Event }
export interface DashboardReadView {
  cursor: number;
  projects: Project[];
  policies: ProfilePolicy[];
  runs: Run[];
  work_items: WorkItem[];
  executors: { executor: Executor; client?: ClientMetadata; last_seen: string }[];
  events: StoredEvent[];
}
const decode = <T>(row: Row, column = 'record'): T => JSON.parse(String(row[column])) as T;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function entity<K extends keyof ProtocolEntities>(kind: K, input: unknown): ProtocolEntities[K] {
  safeData(input);
  return assertEntity(kind, input);
}

// Startup qualification is read-only; an existing service never initializes, migrates or seeds.
export function validateExistingDatabase(path: string, policies: readonly ProfilePolicy[]): string {
  const checked = externalFilePath(path), db = new DatabaseSync(checked, { readOnly: true, allowExtension: false });
  try {
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== DATABASE_VERSION)
      fail(500, 'database_version', 'Normal startup requires an existing CP v2 database');
    const columns: Record<string, string[]> = {
      profiles: ['ref','version','record'], projects: ['id','record'],
      executors: ['id','client_id','last_seen','record'], work_items: ['id','project_id','record'],
      runs: ['id','project_id','executor_id','work_item_id','client_id','initial','record'],
      events: ['cursor','run_id','event_id','sequence','record'], executor_clients: ['executor_id','record'],
    };
    for (const [table, expected] of Object.entries(columns)) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
      if (actual.join(',') !== expected.join(',')) fail(500, 'database_identity', 'Database does not have the expected CP tables');
    }
    for (const name of ['events_no_update','events_no_delete','runs_identity_no_update','profiles_no_update','profiles_no_delete'])
      if (!db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name))
        fail(500, 'database_identity', 'Database is missing CP immutability controls');
    for (const policy of policies) {
      const old = db.prepare('SELECT record FROM profiles WHERE ref = ? AND version = ?').get(policy.ref, policy.version);
      if (!old || canonical(decode(old)) !== canonical(policy))
        fail(409, 'profile_conflict', 'Normal startup cannot add or replace a trusted Profile version');
    }
    for (const row of db.prepare('SELECT record FROM projects').all()) {
      const project = entity('project', decode(row));
      const versions = db.prepare('SELECT record FROM profiles WHERE ref = ?').all(project.profile_ref);
      if (!versions.length || versions.some(version => entity('profile_policy', decode(version)).repository !== project.repository))
        fail(500, 'database_identity', 'Existing Project identity must agree with its trusted Profiles');
    }
    return checked;
  } finally { db.close(); }
}

// Synchronous transactions contain no await or network I/O. BEGIN IMMEDIATE serializes all writers.
export class ControlPlaneStore {
  readonly #db: DatabaseSync;
  #revision = 0;
  constructor(path: string, policies: readonly ProfilePolicy[], readonly now = () => new Date().toISOString(), mode: 'legacy' | 'existing' = 'legacy') {
    if (!Array.isArray(policies) || policies.length === 0 || policies.length > 256) fail(500, 'configuration', 'Trusted Profile policies are required');
    policies.forEach(policy => entity('profile_policy', policy));
    if (mode !== 'legacy' && mode !== 'existing') fail(500, 'configuration', 'Invalid store startup mode');
    if (mode === 'existing') path = validateExistingDatabase(path, policies);
    this.#db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false });
    try {
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.transaction(() => {
        const version = Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
        if (mode === 'existing' && version !== DATABASE_VERSION) fail(500, 'database_version', 'Existing CP version changed during startup');
        if (version > DATABASE_VERSION) fail(500, 'database_version', 'Database schema is newer than this server');
        if (version !== 0 && version !== 1 && version !== DATABASE_VERSION) fail(500, 'database_version', 'Unsupported database schema');
        if (version === 0) this.#db.exec(`
          CREATE TABLE profiles (ref TEXT NOT NULL, version TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(ref, version)) STRICT;
          CREATE TABLE projects (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
          CREATE TABLE executors (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, last_seen TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
          CREATE TABLE work_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
          CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), executor_id TEXT NOT NULL REFERENCES executors(id),
            work_item_id TEXT NOT NULL REFERENCES work_items(id), client_id TEXT NOT NULL, initial TEXT NOT NULL CHECK(json_valid(initial)), record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
          CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), event_id TEXT NOT NULL,
            sequence INTEGER NOT NULL CHECK(sequence > 0), record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(run_id, event_id), UNIQUE(run_id, sequence)) STRICT;
          CREATE INDEX runs_project ON runs(project_id);
          CREATE INDEX events_run ON events(run_id, sequence);
          CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
          CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
          CREATE TRIGGER runs_identity_no_update BEFORE UPDATE OF id, project_id, executor_id, work_item_id, client_id, initial ON runs BEGIN SELECT RAISE(ABORT, 'Run identity is immutable'); END;
          CREATE TRIGGER profiles_no_update BEFORE UPDATE ON profiles BEGIN SELECT RAISE(ABORT, 'Profile versions are immutable'); END;
          CREATE TRIGGER profiles_no_delete BEFORE DELETE ON profiles BEGIN SELECT RAISE(ABORT, 'Profile versions are immutable'); END;
          PRAGMA user_version = 1;
        `);
        if (version < 2) this.#db.exec(`
          CREATE TABLE executor_clients (executor_id TEXT PRIMARY KEY REFERENCES executors(id), record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
          PRAGMA user_version = 2;
        `);
        for (const policy of policies) {
          const versions = this.#db.prepare('SELECT record FROM profiles WHERE ref = ?').all(policy.ref);
          if (versions.some(row => decode<ProfilePolicy>(row).repository !== policy.repository))
            fail(409, 'profile_conflict', 'Trusted Profile identity cannot be rebound to another repository');
          const old = this.#db.prepare('SELECT record FROM profiles WHERE ref = ? AND version = ?').get(policy.ref, policy.version);
          if (old && canonical(decode(old)) !== canonical(policy)) fail(409, 'profile_conflict', 'Trusted Profile version cannot be replaced');
          if (!old && mode === 'existing') fail(409, 'profile_conflict', 'Normal startup cannot seed Profiles');
          if (!old) this.#db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run(policy.ref, policy.version, JSON.stringify(policy));
        }
      });
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { this.#db.close(); }
  private transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.#db.exec('COMMIT'); ++this.#revision; return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  private row(table: 'projects' | 'executors' | 'work_items' | 'runs', id: string): Row {
    const row = this.#db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) fail(404, 'not_found', 'Registry entity was not found');
    return row;
  }
  private insert(table: 'projects' | 'work_items', value: Project | WorkItem): 'created' | 'idempotent' {
    const old = this.#db.prepare(`SELECT record FROM ${table} WHERE id = ?`).get(value.id);
    if (old) {
      if (canonical(decode(old)) !== canonical(value)) fail(409, 'identity_conflict', 'Registry identity cannot be rebound');
      return 'idempotent';
    }
    if (table === 'projects') this.#db.prepare('INSERT INTO projects VALUES (?, ?)').run(value.id, JSON.stringify(value));
    else this.#db.prepare('INSERT INTO work_items VALUES (?, ?, ?)').run(value.id, (value as WorkItem).project_id, JSON.stringify(value));
    return 'created';
  }
  registerProject(principal: Principal, input: unknown) {
    const manifest = entity('manifest', input);
    projectAccess(principal, manifest.project.id);
    const policies = this.#db.prepare('SELECT record FROM profiles WHERE ref = ?').all(manifest.profile.ref).map(row => decode<ProfilePolicy>(row));
    if (!policies.length || policies.some(policy => policy.repository !== manifest.project.repository))
      fail(403, 'profile_binding', 'Manifest must match a trusted Profile repository');
    const project: Project = { schema_version: '1.0', kind: 'project', id: manifest.project.id,
      repository: manifest.project.repository, profile_ref: manifest.profile.ref };
    return this.transaction(() => ({ project, disposition: this.insert('projects', project) }));
  }
  getProject(principal: Principal, id: string): Project { projectAccess(principal, id); return decode(this.row('projects', id)); }
  listProjects(principal: Principal): Project[] {
    return this.#db.prepare('SELECT record FROM projects ORDER BY id').all().map(row => decode<Project>(row)).filter(p => principal.project_ids.includes(p.id));
  }
  listProfiles(principal: Principal, projectId: string): ProfilePolicy[] {
    const project = this.getProject(principal, projectId);
    return this.#db.prepare('SELECT record FROM profiles WHERE ref = ? ORDER BY version').all(project.profile_ref).map(row => decode<ProfilePolicy>(row));
  }
  private metadata(id: string): { client?: ClientMetadata } {
    const row = this.#db.prepare('SELECT record FROM executor_clients WHERE executor_id = ?').get(id);
    return row ? { client: decode<ClientMetadata>(row) } : {};
  }
  registerExecutor(principal: Principal, input: unknown, client?: unknown) {
    const executor = entity('executor', input);
    if (client !== undefined) { safeData(client); assertClientMetadata(client); }
    executorAccess(principal, executor.id);
    return this.transaction(() => {
      const old = this.#db.prepare('SELECT * FROM executors WHERE id = ?').get(executor.id);
      if (old && (old.client_id !== principal.id || canonical(decode(old)) !== canonical(executor)))
        fail(409, 'identity_conflict', 'Executor identity or owner cannot be rebound');
      if (!old) this.#db.prepare('INSERT INTO executors VALUES (?, ?, ?, ?)').run(executor.id, principal.id, this.now(), JSON.stringify(executor));
      if (client !== undefined) this.#db.prepare('INSERT INTO executor_clients VALUES (?, ?) ON CONFLICT(executor_id) DO UPDATE SET record = excluded.record')
        .run(executor.id, JSON.stringify(client));
      return { executor, ...this.metadata(executor.id), last_seen: String((old ?? this.row('executors', executor.id)).last_seen), disposition: old ? 'idempotent' : 'created' };
    });
  }
  listExecutors(principal: Principal) {
    return this.#db.prepare('SELECT * FROM executors WHERE client_id = ? ORDER BY id').all(principal.id)
      .filter(row => principal.executor_ids.includes(String(row.id))).map(row => ({ executor: decode<Executor>(row), ...this.metadata(String(row.id)), last_seen: String(row.last_seen) }));
  }
  heartbeat(principal: Principal, id: string) {
    executorAccess(principal, id);
    return this.transaction(() => {
      const row = this.row('executors', id);
      if (row.client_id !== principal.id) fail(403, 'forbidden', 'Executor belongs to another client');
      const lastSeen = [this.now(), String(row.last_seen)].sort().at(-1)!;
      this.#db.prepare('UPDATE executors SET last_seen = ? WHERE id = ?').run(lastSeen, id);
      return { executor: decode<Executor>(row), ...this.metadata(id), last_seen: lastSeen };
    });
  }
  registerWorkItem(principal: Principal, input: unknown) {
    const workItem = entity('work_item', input);
    this.getProject(principal, workItem.project_id);
    // Work references may belong to the Hub (external bootstrap); they remain provider declarations.
    return this.transaction(() => ({ work_item: workItem, disposition: this.insert('work_items', workItem) }));
  }
  getWorkItem(principal: Principal, id: string): WorkItem {
    const workItem = decode<WorkItem>(this.row('work_items', id)); projectAccess(principal, workItem.project_id); return workItem;
  }
  createRun(principal: Principal, input: unknown) {
    const run = entity('run', input);
    const project = this.getProject(principal, run.project_id);
    executorAccess(principal, run.executor_id);
    if (run.state !== 'created') fail(409, 'state', 'New Runs must begin in created state');
    const owner = this.row('executors', run.executor_id);
    if (owner.client_id !== principal.id) fail(403, 'forbidden', 'Executor belongs to another client');
    const policy = this.#db.prepare('SELECT record FROM profiles WHERE ref = ? AND version = ?').get(run.profile.ref, run.profile.version);
    if (!policy) fail(403, 'profile_binding', 'Run requires an exact trusted Profile version');
    const bundle = { manifest: { apiVersion: 'awh/v1', project: { id: project.id, repository: project.repository }, profile: { ref: project.profile_ref } },
      project, profile_policy: decode<ProfilePolicy>(policy), executor: decode<Executor>(owner), work_item: this.getWorkItem(principal, run.work_item_id), run };
    if (!validateBindings(bundle).valid) fail(409, 'binding', 'Run Registry bindings do not match');
    return this.transaction(() => {
      const old = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id);
      if (old) {
        if (old.client_id !== principal.id || canonical(decode(old, 'initial')) !== canonical(run)) fail(409, 'identity_conflict', 'Run identity cannot be rebound');
        return { run: decode<Run>(old), disposition: 'idempotent' };
      }
      this.#db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)').run(run.id, run.project_id, run.executor_id, run.work_item_id,
        principal.id, JSON.stringify(run), JSON.stringify(run));
      return { run, disposition: 'created' };
    });
  }
  getRun(principal: Principal, id: string): Run {
    const run = decode<Run>(this.row('runs', id)); projectAccess(principal, run.project_id); return run;
  }
  listRuns(principal: Principal, projectId: string): Run[] {
    this.getProject(principal, projectId);
    return this.#db.prepare('SELECT record FROM runs WHERE project_id = ? ORDER BY id').all(projectId).map(row => decode<Run>(row));
  }
  listEvents(principal: Principal, runId: string, after = 0, limit = 100): StoredEvent[] {
    this.getRun(principal, runId);
    return this.#db.prepare('SELECT cursor, record FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(runId, after, limit).map(row => ({ cursor: Number(row.cursor), event: decode<Event>(row) }));
  }
  append(principal: Principal, runId: string, input: unknown) {
    const event = entity('event', input);
    if (Buffer.byteLength(JSON.stringify(event.payload)) > MAX_PAYLOAD_BYTES) fail(413, 'payload_too_large', 'Event payload exceeds the byte limit');
    if (event.run_id !== runId) fail(409, 'binding', 'Event Run ID does not match the route');
    return this.transaction(() => {
      const row = this.row('runs', runId), initial = decode<Run>(row, 'initial');
      projectAccess(principal, initial.project_id); executorAccess(principal, initial.executor_id);
      if (row.client_id !== principal.id) fail(403, 'forbidden', 'Run belongs to another client');
      const history = this.#db.prepare('SELECT record FROM events WHERE run_id = ? ORDER BY sequence').all(runId).map(row => decode<Event>(row));
      const result = appendEvent(initial, history, event);
      if (result.disposition === 'appended') {
        this.#db.prepare('INSERT INTO events (run_id, event_id, sequence, record) VALUES (?, ?, ?, ?)').run(runId, event.id, event.sequence, JSON.stringify(event));
        this.#db.prepare('UPDATE runs SET record = ? WHERE id = ?').run(JSON.stringify(result.run), runId);
      }
      const stored = this.#db.prepare('SELECT cursor FROM events WHERE run_id = ? AND event_id = ?').get(runId, event.id)!;
      return { disposition: result.disposition, cursor: Number(stored.cursor), run: result.run, event, authority_verified: false as const };
    });
  }
  dashboardRevision(): string { return `${this.#revision}:${this.#db.prepare('PRAGMA data_version').get()!.data_version}:${this.latestCursor()}`; }
  latestCursor(): number { return Number(this.#db.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events').get()!.cursor); }
  // One bounded SQLite read transaction; never seeds policies, mutates history or exposes client owners.
  dashboardReadView(principal: Pick<Principal, 'project_ids'>): DashboardReadView {
    return readDashboard(this.#db, principal);
  }
  streamEvents(principal: Principal, after: number, limit = 100): StoredEvent[] {
    const placeholders = principal.project_ids.map(() => '?').join(',');
    if (!placeholders) return [];
    return this.#db.prepare(`SELECT e.cursor, e.record FROM events e JOIN runs r ON r.id = e.run_id
      WHERE e.cursor > ? AND r.project_id IN (${placeholders}) ORDER BY e.cursor LIMIT ?`)
      .all(after, ...principal.project_ids, limit).map(row => ({ cursor: Number(row.cursor), event: decode<Event>(row) }));
  }
}

export interface DashboardStore {
  dashboardReadView(principal: Pick<Principal, 'project_ids'>): DashboardReadView;
  dashboardRevision(): string;
}
function latestCursor(db: DatabaseSync) { return Number(db.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events').get()!.cursor); }
function metadata(db: DatabaseSync, id: string): { client?: ClientMetadata } {
  const row = db.prepare('SELECT record FROM executor_clients WHERE executor_id = ?').get(id);
  return row ? { client: decode<ClientMetadata>(row) } : {};
}
function readDashboard(db: DatabaseSync, principal: Pick<Principal, 'project_ids'>): DashboardReadView {
  const scope = principal.project_ids;
  if (!scope.length || scope.length > 64) fail(403, 'forbidden', 'Explicit viewer project scope is required');
  const placeholders = scope.map(() => '?').join(',');
  const bounded = (sql: string, args: string[], limit: number): Row[] => {
    const rows = db.prepare(sql + ' LIMIT ?').all(...args, limit + 1);
    if (rows.length > limit) fail(503, 'projection_limit', 'Dashboard projection exceeds the local MVP limit');
    return rows;
  };
  db.exec('BEGIN');
  try {
    const cursor = latestCursor(db);
    const projects = bounded(`SELECT record FROM projects WHERE id IN (${placeholders}) ORDER BY id`, [...scope], 64).map(row => decode<Project>(row));
    const runs = bounded(`SELECT record FROM runs WHERE project_id IN (${placeholders}) ORDER BY id`, [...scope], 1000).map(row => decode<Run>(row));
    const workItems = bounded(`SELECT record FROM work_items WHERE project_id IN (${placeholders}) ORDER BY id`, [...scope], 1000).map(row => decode<WorkItem>(row));
    const executors = bounded(`SELECT DISTINCT e.* FROM executors e JOIN runs r ON r.executor_id = e.id WHERE r.project_id IN (${placeholders}) ORDER BY e.id`, [...scope], 1000)
      .map(row => ({ executor: decode<Executor>(row), ...metadata(db, String(row.id)), last_seen: String(row.last_seen) }));
    const events = bounded(`SELECT e.cursor, e.record FROM events e JOIN runs r ON r.id = e.run_id WHERE r.project_id IN (${placeholders}) ORDER BY e.cursor`, [...scope], 10000)
      .map(row => ({ cursor: Number(row.cursor), event: decode<Event>(row) }));
    const policies = bounded(`SELECT DISTINCT p.record FROM profiles p JOIN projects j ON j.id IN (${placeholders}) AND p.ref = json_extract(j.record, '$.profile_ref') ORDER BY p.ref, p.version`, [...scope], 256)
      .map(row => decode<ProfilePolicy>(row));
    db.exec('COMMIT');
    return { cursor, projects, policies, runs, work_items: workItems, executors, events };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
// A separate sidecar can read an existing v2 DB without migrations, trusted config or write methods.
export class DashboardReadStore implements DashboardStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path, { readOnly: true, timeout: 1000, allowExtension: false });
    try {
      if (Number(this.#db.prepare('PRAGMA user_version').get()!.user_version) !== DATABASE_VERSION)
        fail(500, 'database_version', 'Dashboard requires an existing v2 database');
    } catch (error) { this.#db.close(); throw error; }
  }
  close() { this.#db.close(); }
  dashboardRevision() { return String(this.#db.prepare('PRAGMA data_version').get()!.data_version) + ':' + latestCursor(this.#db); }
  dashboardReadView(principal: Pick<Principal, 'project_ids'>) { return readDashboard(this.#db, principal); }
}
