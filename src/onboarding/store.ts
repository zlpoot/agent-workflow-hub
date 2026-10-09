import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { RegisteredClient } from '../control-plane/security.js';
import { fixtureDatabase, type OfflineFixture } from './fixture.js';
import { canonical, deny, equalHash, hash, OnboardingError, scopeAccess, serviceAccess, validateConfig } from './security.js';
import { OBSERVATION, type Binding, type ClientPeer, type FixtureConfig, type OperatorPrincipal, type PairingScope } from './types.js';
import { OfflineAdmission, OFFLINE_LIMITS } from './admission.js';

const VERSION = 101, TTL = 300_000, ATTEMPTS = 3;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
interface RequestRow { id: string; owner: string; binding: Binding; state: 'pending' | 'approved' | 'rejected'; created: number }
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const iso = (value: number) => new Date(value).toISOString();
function bindingOf(scope: Binding): Binding {
  return { project_id: scope.project_id, repository: scope.repository, profile_ref: scope.profile_ref, profile_version: scope.profile_version };
}
export class OfflineOnboardingStore {
  readonly #db: DatabaseSync;
  readonly #config: FixtureConfig;
  readonly #clock: () => number;
  readonly #path: string;
  #authenticationFloor = 0;
  readonly admission = new OfflineAdmission();
  constructor(fixture: OfflineFixture, config: FixtureConfig, clock = Date.now) {
    this.#config = validateConfig(config); this.#clock = clock;
    const path = fixtureDatabase(fixture), fresh = statSync(path).size === 0;
    this.#path = path;
    // Before any writable connection/PRAGMA, refuse ordinary CP v2 and unknown fixture DBs.
    if (!fresh) {
      const probe = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      try {
        if (Number(probe.prepare('PRAGMA user_version').get()!.user_version) !== VERSION ||
            probe.prepare('SELECT fixture_id FROM fixture_metadata WHERE id=1').get()?.fixture_id !== fixture.fixture_id) deny(500, 'fixture_boundary');
      } finally { probe.close(); }
    }
    this.#db = new DatabaseSync(path, { timeout: OFFLINE_LIMITS.busy_ms, allowExtension: false, enableForeignKeyConstraints: true });
    try {
      // Only a newly created empty fixture needs journal-mode initialization.
      if (fresh) this.#db.exec('PRAGMA journal_mode=WAL');
      this.#db.exec('PRAGMA synchronous=FULL');
      this.#db.exec('BEGIN IMMEDIATE');
      this.storageCapacity();
      const pageSize = Number(this.#db.prepare('PRAGMA page_size').get()!.page_size);
      this.#db.exec(`PRAGMA max_page_count=${Math.floor(OFFLINE_LIMITS.storage_bytes/pageSize)};`);
      const version = Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
      if (version === 0 && fresh) this.#db.exec(`
        CREATE TABLE fixture_metadata(id INTEGER PRIMARY KEY CHECK(id=1), fixture_id TEXT NOT NULL, config_sha256 TEXT NOT NULL, clock INTEGER NOT NULL) STRICT;
        CREATE TABLE trusted_profiles(ref TEXT NOT NULL, version TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(ref,version)) STRICT;
        CREATE TABLE reserved_projects(id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
        CREATE TABLE reserved_clients(id TEXT PRIMARY KEY, executor_id TEXT UNIQUE NOT NULL, machine_id TEXT UNIQUE NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
        CREATE TABLE requests(id TEXT PRIMARY KEY, owner TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')), created INTEGER NOT NULL) STRICT;
        CREATE TABLE project_bindings(id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
        CREATE TABLE invitations(id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), secret_sha256 TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('pending_delivery','active','claimed','revoked','expired','locked')), expires INTEGER NOT NULL, attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3)) STRICT;
        CREATE TABLE clients(id TEXT PRIMARY KEY, executor_id TEXT UNIQUE NOT NULL, machine_id TEXT UNIQUE NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
          token_sha256 TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('pending_delivery','active','revoked'))) STRICT;
        CREATE TABLE nonces(id TEXT PRIMARY KEY, session_sha256 TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL CHECK(consumed IN (0,1))) STRICT;
        CREATE TABLE audit(cursor INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
          project_id TEXT, repository TEXT, result TEXT NOT NULL CHECK(result IN ('accepted','denied')), code TEXT NOT NULL) STRICT;
        CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Immutable audit'); END;
        CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Immutable audit'); END;
        CREATE TRIGGER binding_no_update BEFORE UPDATE ON project_bindings BEGIN SELECT RAISE(ABORT,'Immutable project'); END;
        CREATE TRIGGER binding_no_delete BEFORE DELETE ON project_bindings BEGIN SELECT RAISE(ABORT,'Immutable project'); END;
        CREATE TRIGGER profile_no_update BEFORE UPDATE ON trusted_profiles BEGIN SELECT RAISE(ABORT,'Immutable Profile'); END;
        CREATE TRIGGER profile_no_delete BEFORE DELETE ON trusted_profiles BEGIN SELECT RAISE(ABORT,'Immutable Profile'); END;
        CREATE TRIGGER client_identity_no_update BEFORE UPDATE OF id,executor_id,machine_id,record,token_sha256 ON clients BEGIN SELECT RAISE(ABORT,'Immutable Client'); END;
        CREATE TRIGGER client_no_delete BEFORE DELETE ON clients BEGIN SELECT RAISE(ABORT,'Immutable Client'); END;
        CREATE TRIGGER invitation_binding_no_update BEFORE UPDATE OF id,record,secret_sha256,expires ON invitations BEGIN SELECT RAISE(ABORT,'Immutable invitation'); END;
        CREATE TRIGGER request_binding_no_update BEFORE UPDATE OF id,owner,record,created ON requests BEGIN SELECT RAISE(ABORT,'Immutable request'); END;
        CREATE TRIGGER request_terminal BEFORE UPDATE OF state ON requests WHEN OLD.state!='pending' AND NEW.state!=OLD.state BEGIN SELECT RAISE(ABORT,'Terminal request'); END;
        CREATE TRIGGER invitation_terminal BEFORE UPDATE OF state ON invitations WHEN OLD.state NOT IN ('active','pending_delivery') AND NEW.state!=OLD.state BEGIN SELECT RAISE(ABORT,'Terminal invitation'); END;
        CREATE TRIGGER client_terminal BEFORE UPDATE OF state ON clients WHEN OLD.state='revoked' AND NEW.state!='revoked' BEGIN SELECT RAISE(ABORT,'Terminal Client'); END;
        CREATE TRIGGER reservation_project_no_update BEFORE UPDATE ON reserved_projects BEGIN SELECT RAISE(ABORT,'Immutable reservation'); END;
        CREATE TRIGGER reservation_project_no_delete BEFORE DELETE ON reserved_projects BEGIN SELECT RAISE(ABORT,'Immutable reservation'); END;
        CREATE TRIGGER reservation_client_no_update BEFORE UPDATE ON reserved_clients BEGIN SELECT RAISE(ABORT,'Immutable reservation'); END;
        CREATE TRIGGER reservation_client_no_delete BEFORE DELETE ON reserved_clients BEGIN SELECT RAISE(ABORT,'Immutable reservation'); END;
        PRAGMA user_version=101;
      `);
      else if (version !== VERSION) deny(500, 'fixture_boundary');
      this.auditCapacity();
      const digest = hash(canonical({ service: this.#config.service, profiles: this.#config.profiles, reserved_projects: this.#config.reserved_projects, reserved_clients: this.#config.reserved_clients }));
      const meta = this.#db.prepare('SELECT * FROM fixture_metadata WHERE id=1').get();
      if (meta && (meta.fixture_id !== fixture.fixture_id || meta.config_sha256 !== digest)) deny(409, 'trusted_config_conflict');
      if (!meta) {
        this.#db.prepare('INSERT INTO fixture_metadata VALUES(1,?,?,0)').run(fixture.fixture_id,digest);
        for (const policy of this.#config.profiles) this.#db.prepare('INSERT INTO trusted_profiles VALUES(?,?,?)').run(policy.ref,policy.version,JSON.stringify(policy));
        for (const p of this.#config.reserved_projects) this.#db.prepare('INSERT INTO reserved_projects VALUES(?,?)').run(p.project_id,JSON.stringify(p));
        for (const c of this.#config.reserved_clients) this.#db.prepare('INSERT INTO reserved_clients VALUES(?,?,?,?)').run(c.client_id,c.executor_id,c.machine_id,JSON.stringify(c));
      }
      this.tick(); this.#db.exec('COMMIT');
    } catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} this.#db.close(); throw error; }
  }
  close(): void { this.#db.close(); }
  get config(): FixtureConfig { return structuredClone(this.#config); }
  authenticationTime(): number {
    return this.admissionTime();
  }
  // Constant-cost trusted clock lookup for session pre-admission; no SQLite read/write.
  admissionTime(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000_000) deny(500,'clock');
    return this.#authenticationFloor = Math.max(value,this.#authenticationFloor);
  }
  now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000_000) deny(500, 'clock');
    return this.#authenticationFloor = Math.max(value, this.#authenticationFloor, Number(this.#db.prepare('SELECT clock FROM fixture_metadata WHERE id=1').get()!.clock));
  }
  private tick(): number { const now = this.now(); this.#db.prepare('UPDATE fixture_metadata SET clock=? WHERE id=1').run(now); return now; }
  private transaction<T>(action: (now: number) => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.storageCapacity(); this.auditCapacity();
      const result = action(this.tick()); this.#db.exec('COMMIT'); return result;
    }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  // Called only inside an authenticated, schema-checked business decision boundary.
  // Roll back business changes first, then commit the fixed denial under the same quota/write lock.
  private decision<T>(actor: string, action: string, target: string, binding: () => Binding | null, operation: (now: number) => T): T {
    const result = this.transaction(now => {
      this.#db.exec('SAVEPOINT trusted_decision');
      try {
        const value = operation(now); this.#db.exec('RELEASE trusted_decision');
        return { accepted: true as const, value };
      } catch (error) {
        if (!(error instanceof OnboardingError) || ![
          'operator_scope','profile_binding','identity_conflict','terminal_request','terminal_invitation',
          'project_not_approved','executor_scope','delivery_binding','service_binding','claim_race','not_found',
        ].includes(error.code)) throw error;
        this.#db.exec('ROLLBACK TO trusted_decision; RELEASE trusted_decision');
        this.audit(actor,action,target,binding(),'denied',error.code);
        return { accepted: false as const, status: error.status, code: error.code };
      }
    });
    if (!result.accepted) deny(result.status,result.code);
    return result.value;
  }
  // Both initialization and mutations call this while holding SQLite's writer reservation.
  private storageCapacity(): void {
    for (const suffix of ['', '-wal', '-journal']) {
      try { if (statSync(this.#path+suffix).size >= OFFLINE_LIMITS.storage_bytes) deny(503,'storage_limit'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private audit(actor: string, action: string, target: string, binding: Binding | null, result = 'accepted', code = 'ok'): void {
    this.auditCapacity();
    this.#db.prepare('INSERT INTO audit(at,actor,action,target,project_id,repository,result,code) VALUES(?,?,?,?,?,?,?,?)')
      .run(iso(this.now()),actor,action,target,binding?.project_id ?? null,binding?.repository ?? null,result,code);
  }
  private auditCapacity(): void {
    if (Number(this.#db.prepare('SELECT COUNT(*) AS n FROM audit').get()!.n) >= OFFLINE_LIMITS.audit_rows) deny(503,'audit_limit');
  }
  // Kept for fixture API compatibility; never persist arbitrary rejection codes.
  recordDenied(_code: string): void { this.admission.denied('anonymous',400); }
  nonce(operator: OperatorPrincipal) {
    return this.transaction(now => {
      this.#db.prepare('DELETE FROM nonces WHERE expires<=?').run(now);
      const count = Number(this.#db.prepare('SELECT COUNT(*) AS n FROM nonces WHERE session_sha256=? AND consumed=0').get(operator.session_sha256)!.n);
      if (count >= 64) deny(429, 'nonce_limit');
      const id = randomUUID(), expires = now + 60_000;
      this.#db.prepare('INSERT INTO nonces VALUES(?,?,?,0)').run(id,operator.session_sha256,expires);
      this.audit(operator.id,'nonce_issued',id,null); return { nonce: id, expires_at: iso(expires), ...OBSERVATION };
    });
  }
  consumeNonce(operator: OperatorPrincipal, id: string): void {
    this.transaction(now => {
      const row = this.#db.prepare('SELECT * FROM nonces WHERE id=?').get(id);
      if (!row || row.session_sha256 !== operator.session_sha256 || Number(row.expires) <= now || row.consumed !== 0) deny(403, 'nonce');
      this.#db.prepare('UPDATE nonces SET consumed=1 WHERE id=?').run(id); this.audit(operator.id,'nonce_consumed',id,null);
    });
  }
  private requestRow(id: string): RequestRow {
    const row = this.#db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if (!row) deny(404, 'not_found');
    return { id: String(row.id), owner: String(row.owner), binding: json(row.record), state: row.state as RequestRow['state'], created: Number(row.created) };
  }
  private requestView(row: RequestRow) { return { id: row.id, ...row.binding, state: row.state, created_at: iso(row.created), ...OBSERVATION }; }
  request(operator: OperatorPrincipal, binding: Binding) {
    return this.decision(operator.id,'project_request_denied',binding.project_id,() => binding,now => {
      for (const table of ['reserved_projects','project_bindings']) {
        const bound = this.#db.prepare(`SELECT record FROM ${table} WHERE id=?`).get(binding.project_id);
        if (bound && canonical(json(bound.record)) !== canonical(binding)) deny(409, 'identity_conflict');
      }
      const old = this.#db.prepare('SELECT id,record FROM requests WHERE owner=? AND json_extract(record,\'$.project_id\')=?').get(operator.id,binding.project_id);
      if (old && canonical(json(old.record)) !== canonical(binding)) deny(409, 'identity_conflict');
      const id = old ? String(old.id) : randomUUID();
      if (!old) this.#db.prepare('INSERT INTO requests VALUES(?,?,?,\'pending\',?)').run(id,operator.id,JSON.stringify(binding),now);
      this.audit(operator.id,'project_requested',id,binding); return this.requestView(this.requestRow(id));
    });
  }
  readRequest(operator: OperatorPrincipal, id: string) {
    const row = this.requestRow(id);
    if (row.owner !== operator.id) scopeAccess(operator,row.binding.repository);
    return this.requestView(row);
  }
  decide(operator: OperatorPrincipal, id: string, decision: 'approve' | 'reject') {
    let binding: Binding | null = null;
    return this.decision(operator.id,decision === 'approve' ? 'project_approve_denied' : 'project_reject_denied',id,() => binding,() => {
      const row = this.requestRow(id); binding = row.binding; scopeAccess(operator,binding.repository);
      const state = decision === 'approve' ? 'approved' : 'rejected';
      if (row.state !== 'pending' && row.state !== state) deny(409, 'terminal_request');
      if (state === 'approved') {
        this.policy(binding);
        for (const table of ['reserved_projects','project_bindings']) {
          const old = this.#db.prepare(`SELECT record FROM ${table} WHERE id=?`).get(binding.project_id);
          if (old && canonical(json(old.record)) !== canonical(binding)) deny(409, 'identity_conflict');
        }
        this.#db.prepare('INSERT OR IGNORE INTO project_bindings VALUES(?,?)').run(binding.project_id,JSON.stringify(binding));
      }
      this.#db.prepare('UPDATE requests SET state=? WHERE id=?').run(state,id);
      this.audit(operator.id,'project_'+state,id,binding); return this.requestView(this.requestRow(id));
    });
  }
  private policy(binding: Binding) {
    const policy = this.#config.profiles.find(p => p.ref === binding.profile_ref && p.version === binding.profile_version && p.repository === binding.repository);
    if (!policy) deny(403, 'profile_binding'); return policy;
  }
  private project(id: string): Binding {
    const row = this.#db.prepare('SELECT record FROM project_bindings WHERE id=?').get(id);
    if (!row) deny(409, 'project_not_approved'); return json(row.record);
  }
  private invitationView(row: Row) {
    const scope = json<PairingScope>(row.record), state = row.state === 'active' && Number(row.expires) <= this.now() ? 'expired' : String(row.state);
    return { id: String(row.id), project_id: scope.project_id, state, expires_at: iso(Number(row.expires)), attempts_remaining: Math.max(0, ATTEMPTS - Number(row.attempts)), ...OBSERVATION };
  }
  private identityAvailable(scope: PairingScope): void {
    for (const table of ['reserved_clients','clients']) {
      if (this.#db.prepare(`SELECT id FROM ${table} WHERE id=? OR executor_id=? OR machine_id=?`).get(scope.client_id,scope.executor_id,scope.machine_id)) deny(409, 'identity_conflict');
    }
  }
  createInvitation(operator: OperatorPrincipal, scope: PairingScope, delivery: ClientPeer | null) {
    let material = '';
    const result = this.decision(operator.id,'invitation_create_denied',scope.project_id,() => bindingOf(scope),now => {
      scopeAccess(operator,scope.repository); serviceAccess(scope,this.#config.service);
      if (!delivery || !delivery.verified || canonical(delivery.scope) !== canonical(scope)) deny(403, 'delivery_binding');
      if (canonical(this.project(scope.project_id)) !== canonical(bindingOf(scope))) deny(409, 'identity_conflict');
      const restrictions = this.policy(scope).executor_restrictions;
      if (restrictions && (!restrictions.executor_ids.includes(scope.executor_id) || !restrictions.machine_ids.includes(scope.machine_id))) deny(403, 'executor_scope');
      this.identityAvailable(scope);
      this.#db.prepare('UPDATE invitations SET state=\'expired\' WHERE state=\'active\' AND expires<=?').run(now);
      const conflict = this.#db.prepare(`SELECT id FROM invitations WHERE state IN ('active','pending_delivery') AND
        (json_extract(record,'$.client_id')=? OR json_extract(record,'$.executor_id')=? OR json_extract(record,'$.machine_id')=?)`).get(scope.client_id,scope.executor_id,scope.machine_id);
      if (conflict) deny(409, 'identity_conflict');
      const id = randomUUID(); material = 'awh_pair_' + randomBytes(32).toString('base64url');
      this.#db.prepare('INSERT INTO invitations VALUES(?,?,?,\'pending_delivery\',?,0)').run(id,JSON.stringify(scope),hash(material,'pairing\0'),now + TTL);
      this.audit(operator.id,'invitation_created',id,scope); return this.invitationView(this.#db.prepare('SELECT * FROM invitations WHERE id=?').get(id)!);
    });
    try {
      delivery!.deliverInvitation(result.id,material);
      this.transaction(() => { if (this.#db.prepare('UPDATE invitations SET state=\'active\' WHERE id=? AND state=\'pending_delivery\'').run(result.id).changes !== 1) deny(409,'delivery_interrupted'); this.audit(operator.id,'invitation_delivered',result.id,scope); });
    }
    catch { this.transaction(() => { this.#db.prepare('UPDATE invitations SET state=\'revoked\' WHERE id=? AND state=\'pending_delivery\'').run(result.id); this.audit(operator.id,'delivery_failed',result.id,scope,'denied','delivery_failed'); }); deny(500, 'delivery_failed'); }
    finally { material = ''; }
    return this.invitationView(this.#db.prepare('SELECT * FROM invitations WHERE id=?').get(result.id)!);
  }
  revoke(operator: OperatorPrincipal, id: string) {
    let binding: Binding | null = null;
    return this.decision(operator.id,'invitation_revoke_denied',id,() => binding,() => {
      const row = this.#db.prepare('SELECT * FROM invitations WHERE id=?').get(id); if (!row) deny(404, 'not_found');
      const scope = json<PairingScope>(row.record); binding = bindingOf(scope); scopeAccess(operator,scope.repository);
      if (row.state === 'claimed') deny(409, 'terminal_invitation');
      if (row.state === 'active' || row.state === 'pending_delivery') this.#db.prepare('UPDATE invitations SET state=\'revoked\' WHERE id=?').run(id);
      this.audit(operator.id,'invitation_revoked',id,scope); return this.invitationView(this.#db.prepare('SELECT * FROM invitations WHERE id=?').get(id)!);
    });
  }
  claim(id: string, material: string, scope: PairingScope, peer: ClientPeer) {
    if (!peer.verified) deny(401, 'client_channel');
    let credential = '';
    let binding: Binding | null = null;
    const result = this.decision(peer.scope.client_id,'claim_refused',id,() => binding,now => {
      const row = this.#db.prepare('SELECT * FROM invitations WHERE id=?').get(id);
      if (!row) return { denied: true as const, status: 401, code: 'pairing_denied' };
      const expected = json<PairingScope>(row.record);
      if (row.state !== 'active' || now >= Number(row.expires)) {
        if (row.state === 'active') this.#db.prepare('UPDATE invitations SET state=\'expired\' WHERE id=?').run(id);
        this.audit(peer.scope.client_id,'claim_denied',id,expected,'denied','invitation_unavailable');
        return { denied: true as const, status: 410, code: 'invitation_unavailable' };
      }
      if (!equalHash(String(row.secret_sha256),hash(material,'pairing\0')) || canonical(expected) !== canonical(scope) || canonical(peer.scope) !== canonical(expected)) {
        const attempts = Number(row.attempts) + 1;
        this.#db.prepare('UPDATE invitations SET attempts=?,state=? WHERE id=?').run(attempts,attempts >= ATTEMPTS ? 'locked' : 'active',id);
        this.audit(peer.scope.client_id,'claim_denied',id,expected,'denied','pairing_denied');
        return { denied: true as const, status: 403, code: 'pairing_denied' };
      }
      binding = bindingOf(expected);
      this.identityAvailable(scope);
      if (canonical(this.project(scope.project_id)) !== canonical(bindingOf(scope))) deny(409, 'identity_conflict');
      serviceAccess(scope,this.#config.service);
      credential = 'awh_cp_' + randomBytes(32).toString('base64url');
      this.#db.prepare('INSERT INTO clients VALUES(?,?,?,?,?,\'pending_delivery\')').run(scope.client_id,scope.executor_id,scope.machine_id,JSON.stringify(scope),hash(credential));
      if (this.#db.prepare('UPDATE invitations SET state=\'claimed\' WHERE id=? AND state=\'active\'').run(id).changes !== 1) deny(409, 'claim_race');
      this.audit(scope.client_id,'claim_consumed',id,scope); return { denied: false as const };
    });
    if (result.denied) deny(result.status,result.code);
    // Never authenticate a pending delivery. A crash/failing activation leaves it blocked.
    try {
      peer.provisionCredential(credential);
      this.transaction(() => { if (this.#db.prepare('UPDATE clients SET state=\'active\' WHERE id=? AND state=\'pending_delivery\'').run(scope.client_id).changes !== 1) deny(409,'delivery_interrupted'); this.audit(scope.client_id,'client_activated',scope.client_id,scope); });
    } catch {
      this.transaction(() => { this.#db.prepare('UPDATE clients SET state=\'revoked\' WHERE id=? AND state=\'pending_delivery\'').run(scope.client_id); this.audit(scope.client_id,'credential_delivery_failed',scope.client_id,scope,'denied','delivery_failed'); });
      deny(500, 'delivery_failed');
    } finally { credential = ''; }
    return { client_id: scope.client_id, project_id: scope.project_id, state: 'active', git_identity: 'client_local_claim', ...OBSERVATION };
  }
  authenticateClient(credential: string): PairingScope | null {
    if (!/^awh_cp_[A-Za-z0-9_-]{43}$/.test(credential)) return null;
    const row = this.#db.prepare('SELECT record,token_sha256 FROM clients WHERE state=\'active\' AND token_sha256=?').get(hash(credential));
    return row && equalHash(String(row.token_sha256),hash(credential)) ? json(row.record) : null;
  }
  // Trusted backend-only adapter for compatibility tests; never an API response or config write.
  clientRegistry(): RegisteredClient[] {
    return this.#db.prepare('SELECT id,record,token_sha256 FROM clients WHERE state=\'active\'').all().map(row => {
      const scope = json<PairingScope>(row.record); return { id: String(row.id), project_ids: [scope.project_id], executor_ids: [scope.executor_id], token_sha256: String(row.token_sha256) };
    });
  }
  diagnostics(id: string, operator?: OperatorPrincipal, client?: PairingScope) {
    const row = this.#db.prepare('SELECT record FROM project_bindings WHERE id=?').get(id), binding = row ? json<Binding>(row.record) : null;
    if (operator) {
      const pending = !binding ? this.#db.prepare('SELECT record FROM requests WHERE json_extract(record,\'$.project_id\')=? LIMIT 1').get(id) : null;
      const requested = pending ? json<Binding>(pending.record) : null;
      if (!binding && !requested) deny(404, 'not_found'); scopeAccess(operator,(binding ?? requested)!.repository);
    } else if (!client || client.project_id !== id) deny(403, 'client_scope');
    const policy = binding ? this.policy(binding) : null;
    const active = client ? this.#db.prepare('SELECT id FROM clients WHERE id=? AND state=\'active\'').get(client.client_id) :
      this.#db.prepare('SELECT id FROM clients WHERE json_extract(record,\'$.project_id\')=? AND state=\'active\'').get(id);
    return { project_id: id, state: binding && active ? 'not_checked' : 'blocked', binding,
      policy: policy ? { branch: policy.branch.ref, verification_commands: [...policy.verification.commands] } : null,
      checks: { enrollment: { state: binding ? 'passed' : 'blocked', code: binding ? 'fixture_approved' : 'pending_approval' },
        client: { state: active ? 'passed' : 'blocked', code: active ? 'fixture_paired' : 'missing_client' },
        git_identity: { state: 'not_checked', code: 'client_local_claim_only' }, branch_verification: { state: 'not_checked', code: 'not_run' },
        provider_app_permissions: { state: 'not_checked', code: 'no_live_preflight' } }, ...OBSERVATION };
  }
  readAudit(operator: OperatorPrincipal, after: number) {
    if (operator.role !== 'operator') deny(403, 'operator_scope');
    const placeholders = operator.repository_scope.map(() => '?').join(',');
    const entries = this.#db.prepare(`SELECT * FROM audit WHERE cursor>? AND (repository IS NULL OR repository IN (${placeholders})) ORDER BY cursor LIMIT 100`).all(after,...operator.repository_scope);
    return { entries, next_cursor: entries.length ? Number(entries.at(-1)!.cursor) : after, ...OBSERVATION };
  }
}
