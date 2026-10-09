import { createHash } from 'node:crypto';
import { dirname, join, normalize } from 'node:path';
import { readExternalFile } from '../shared/external-files.js';
import { safeData } from '../shared/security.js';
import { comparePolicy, type PolicyFacts, type PolicyPreflight } from '../shared/preflight.js';

export class VersionedProfileError extends Error {
  constructor(readonly code: string) { super('Versioned policy refused: ' + code); }
}
function deny(code: string): never { throw new VersionedProfileError(code); }
type Stage = 'observe' | 'develop';
export interface VersionedTemplate {
  ref: string; version: string; repository: string; base: string; branch_prefix: string;
  executors: string[]; checks: string[]; stages: Stage[];
}
export interface VersionedWorkItem extends PolicyFacts {
  id: string; expires_at: string | null; stages: Stage[];
}
interface Approval { kind: 'profile' | 'work_item'; id: string; version: string; fingerprint: string;
  operator: string; source: string; approved_at: string; reason: string; supersedes: string | null }
interface Anchor { schema_version: '1.0'; kind: 'policy_trust'; operator: string; source: string;
  catalog_sha256: string; approvals_sha256: string }
export interface ApprovedWorkItem {
  readonly template: VersionedTemplate; readonly work_item: VersionedWorkItem;
  readonly approval: Approval; readonly profile_approval: Approval; readonly fingerprint: string;
}
const loaded = new WeakSet<object>();
// Bounded process-local conflict memory; persistent/production anti-rollback is deferred.
const revisions = new Map<string, Map<string, string>>();
const closed = (v: any, keys: string[]) => {
  if (!v || Array.isArray(v) || typeof v !== 'object' || Object.keys(v).sort().join(',') !== keys.sort().join(',')) deny('schema');
};
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const repo = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(v);
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(v) && !v.includes('..') && !v.includes('//') && !v.endsWith('.lock') && !/[./]$/.test(v);
const prefix = (v: unknown) => typeof v === 'string' && /[-/]$/.test(v) && ref(v.endsWith('/') ? v.slice(0,-1) : v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const list = (v: any, check: (x: any) => boolean, max = 32) => Array.isArray(v) && v.length > 0 && v.length <= max && new Set(v).size === v.length && v.every(check);
const commands = (v: any) => list(v, x => typeof x === 'string' && /^[\x20-\x7e]{1,128}$/.test(x));
const stages = (v: any) => list(v, x => x === 'observe' || x === 'develop', 2);
const canonical = (v: any): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ?
  '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
export function policyFingerprint(value: unknown): string { safeData(value); return createHash('sha256').update(canonical(value)).digest('hex'); }
function freeze<T>(v: T): T { if (v && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; }
function facts(v: any, partial = false): void {
  const validators: Record<keyof PolicyFacts, (x: any) => boolean> = { repository: repo, issue_repository: repo,
    issue: x => Number.isSafeInteger(x) && x > 0, base: ref, branch: ref, executor: id, checks: commands,
    profile_ref: id, profile_version: id, work_item_version: id };
  for (const [k, validate] of Object.entries(validators)) if ((!partial || v[k] !== undefined) && !validate(v[k])) deny('schema');
}
const factKeys = ['repository','issue_repository','issue','base','branch','executor','checks','profile_ref','profile_version','work_item_version'];
function read(path: string): Buffer { try { return readExternalFile(path, 64 * 1024); } catch { return deny('untrusted_source'); } }
function parse(bytes: Buffer): any { try { const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); safeData(v); return v; } catch { return deny('schema'); } }

/** Trust path is supplied by the operator, never discovered from project/config/env/Issue.
 * Anchor and two fixed sibling files must be OS-protected outside every Git repository.
 * Pins authenticate approved bytes relative to this explicit local trust root, not an operator signature.
 */
export function loadApprovedWorkItem(trustPath: string, selection: { id: string; version: string }, now = new Date().toISOString()): ApprovedWorkItem {
  safeData(selection); closed(selection, ['id','version']); if (!id(selection.id) || !id(selection.version) || !timestamp(now)) deny('schema');
  const anchor: Anchor = parse(read(trustPath));
  closed(anchor, ['schema_version','kind','operator','source','catalog_sha256','approvals_sha256']);
  if (anchor.schema_version !== '1.0' || anchor.kind !== 'policy_trust' || !id(anchor.operator) || !id(anchor.source) || !hash(anchor.catalog_sha256) || !hash(anchor.approvals_sha256)) deny('schema');
  const catalogBytes = read(join(dirname(trustPath), 'profiles.json')), approvalBytes = read(join(dirname(trustPath), 'approvals.json'));
  const digest = (v: Buffer) => createHash('sha256').update(v).digest('hex');
  if (digest(catalogBytes) !== anchor.catalog_sha256 || digest(approvalBytes) !== anchor.approvals_sha256) deny('source_fingerprint');
  const catalog = parse(catalogBytes), approvals = parse(approvalBytes);
  closed(catalog, ['schema_version','kind','profiles','work_items']); closed(approvals, ['schema_version','kind','entries']);
  if (catalog.schema_version !== '1.0' || catalog.kind !== 'versioned_profiles' || approvals.schema_version !== '1.0' || approvals.kind !== 'policy_approvals' ||
      !Array.isArray(catalog.profiles) || !Array.isArray(catalog.work_items) || !Array.isArray(approvals.entries) ||
      !catalog.profiles.length || !catalog.work_items.length || catalog.profiles.length > 64 || catalog.work_items.length > 64 || approvals.entries.length > 128) deny('schema');
  const entries: Approval[] = approvals.entries, seen = new Set<string>();
  for (const a of entries) {
    closed(a, ['kind','id','version','fingerprint','operator','source','approved_at','reason','supersedes']);
    if (!['profile','work_item'].includes(a.kind) || !id(a.id) || !id(a.version) || !hash(a.fingerprint) || a.operator !== anchor.operator || a.source !== anchor.source ||
        !timestamp(a.approved_at) || a.approved_at > now || typeof a.reason !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(a.reason) || a.supersedes !== null && !hash(a.supersedes)) deny('approval_source');
    const key = `${a.kind}:${a.id}:${a.version}`; if (seen.has(key)) deny('duplicate_version'); seen.add(key);
  }
  const consumed = new Set<Approval>();
  const approve = (kind: Approval['kind'], key: string, version: string, value: unknown) => {
    const a = entries.find(a => a.kind === kind && a.id === key && a.version === version);
    if (!a || a.fingerprint !== policyFingerprint(value)) deny('unapproved_version');
    if (consumed.has(a)) deny('duplicate_version'); consumed.add(a); return a;
  };
  for (const p of catalog.profiles as VersionedTemplate[]) {
    closed(p, ['ref','version','repository','base','branch_prefix','executors','checks','stages']);
    if (!id(p.ref) || !id(p.version) || !repo(p.repository) || !ref(p.base) || !prefix(p.branch_prefix) || !list(p.executors,id) || !commands(p.checks) || !stages(p.stages)) deny('schema');
    approve('profile', p.ref, p.version, p);
  }
  let selected: ApprovedWorkItem | undefined;
  for (const w of catalog.work_items as VersionedWorkItem[]) {
    closed(w, [...factKeys,'id','expires_at','stages']); facts(w);
    if (!id(w.id) || !stages(w.stages) || w.expires_at !== null && !timestamp(w.expires_at)) deny('schema');
    const a = approve('work_item', w.id, w.work_item_version, w), p = (catalog.profiles as VersionedTemplate[]).find(p => p.ref === w.profile_ref && p.version === w.profile_version);
    if (!p || w.repository !== p.repository || w.base !== p.base || !w.branch.startsWith(p.branch_prefix) || w.branch.length <= p.branch_prefix.length ||
        !p.executors.includes(w.executor) || canonical(w.checks) !== canonical(p.checks) || w.stages.some(s => !p.stages.includes(s))) deny('template_scope');
    if (w.id === selection.id && w.work_item_version === selection.version) {
      if (w.expires_at !== null && w.expires_at <= now) deny('expired');
      selected = { template: p, work_item: w, approval: a, profile_approval: entries.find(a => a.kind === 'profile' && a.id === p.ref && a.version === p.version)!, fingerprint: policyFingerprint(w) };
    }
  }
  if (consumed.size !== entries.length) deny('approval_conflict');
  for (const a of entries) if (a.supersedes !== null) {
    const prior = entries.find(p => p.kind === a.kind && p.id === a.id && p.version !== a.version && p.fingerprint === a.supersedes);
    if (!prior || prior.approved_at > a.approved_at || prior.fingerprint === a.fingerprint) deny('approval_conflict');
    const visited = new Set<Approval>([a]); let cursor: Approval | undefined = prior;
    while (cursor) {
      if (visited.has(cursor)) deny('approval_conflict'); visited.add(cursor);
      const previous: string | null = cursor.supersedes;
      cursor = previous === null ? undefined : entries.find(p => p.kind === a.kind && p.id === a.id && p.fingerprint === previous);
      if (previous !== null && !cursor) deny('approval_conflict');
    }
  }
  if (!selected) deny('unapproved_version');
  const sourcePath = process.platform === 'win32' ? normalize(trustPath).toLowerCase() : normalize(trustPath);
  const history = revisions.get(sourcePath) ?? new Map<string, string>();
  for (const a of entries) {
    const key = `${a.kind}:${a.id}:${a.version}`, fingerprint = policyFingerprint(a);
    if (history.has(key) && history.get(key) !== fingerprint) deny('version_conflict');
  }
  if (!revisions.has(sourcePath) && revisions.size >= 128 || new Set([...history.keys(), ...seen]).size > 4096) deny('history_limit');
  for (const a of entries) history.set(`${a.kind}:${a.id}:${a.version}`, policyFingerprint(a));
  revisions.set(sourcePath, history);
  freeze(selected); loaded.add(selected); return selected;
}
function authentic(value: ApprovedWorkItem, now: string): void {
  if (!loaded.has(value) || !timestamp(now)) deny('untrusted_source');
  if (value.approval.approved_at > now || value.profile_approval.approved_at > now) deny('approval_source');
  if (value.work_item.expires_at !== null && value.work_item.expires_at <= now) deny('expired');
}
/** Readable/machine-readable approved revision diff; never an approval operation. */
export function approvedRevisionDiff(previous: ApprovedWorkItem, next: ApprovedWorkItem, now = new Date().toISOString()) {
  authentic(previous, now); authentic(next, now);
  if (previous.work_item.id !== next.work_item.id || previous.template.ref !== next.template.ref) deny('revision_binding');
  const changes = (['template','work_item'] as const).flatMap(scope => {
    const before = previous[scope] as unknown as Record<string, unknown>, after = next[scope] as unknown as Record<string, unknown>;
    return Object.keys(before).filter(field => canonical(before[field]) !== canonical(after[field])).map(field =>
      ({ scope, field, previous: structuredClone(before[field]), next: structuredClone(after[field]) }));
  });
  return freeze({ schema_version: '1.0', kind: 'approved_revision_diff', previous_fingerprint: previous.fingerprint,
    next_fingerprint: next.fingerprint, changes, previous_approval: structuredClone(previous.approval), next_approval: structuredClone(next.approval),
    approval_action: 'none', deliver: 'blocked', authority_verified: false });
}
export function versionedPreflight(value: ApprovedWorkItem, observed: Partial<PolicyFacts>, stage: Stage = 'observe', now = new Date().toISOString()): PolicyPreflight {
  authentic(value, now); safeData(observed);
  if (!observed || Array.isArray(observed) || Object.keys(observed).some(k => !factKeys.includes(k))) deny('schema'); facts(observed, true);
  if (!value.work_item.stages.includes(stage)) deny('stage');
  const approved = Object.fromEntries(factKeys.map(k => [k, value.work_item[k as keyof PolicyFacts]])) as unknown as PolicyFacts;
  return freeze(comparePolicy(approved, observed, stage));
}
export interface DevelopRun {
  schema_version: '1.0'; kind: 'develop_declaration'; id: string; source_sha: string; binding: PolicyFacts;
  profile_fingerprint: string; work_item_fingerprint: string; approval_fingerprint: string;
  events: { sequence: number; type: 'started' | 'checks_reported' | 'completed' | 'failed'; checks: { command: string; exit_code: number }[] }[];
  provider_scope: 'not_checked'; execution: 'declarations_only'; deliver: 'blocked'; authority_verified: false;
}
export function declareDevelop(value: ApprovedWorkItem, observed: PolicyFacts, run: { id: string; source_sha: string }, now = new Date().toISOString()): DevelopRun {
  safeData(run); closed(run, ['id','source_sha']); if (!id(run.id) || !/^[a-f0-9]{40}$/.test(run.source_sha)) deny('schema');
  const preflight = versionedPreflight(value, observed, 'develop', now); if (preflight.status !== 'passed') deny('binding');
  return freeze({ schema_version: '1.0', kind: 'develop_declaration', id: run.id, source_sha: run.source_sha, binding: preflight.approved_effective as PolicyFacts,
    profile_fingerprint: policyFingerprint(value.template), work_item_fingerprint: value.fingerprint, approval_fingerprint: policyFingerprint(value.approval),
    events: [], provider_scope: 'not_checked', execution: 'declarations_only', deliver: 'blocked', authority_verified: false });
}
export function reportDevelop(value: ApprovedWorkItem, run: DevelopRun, event: DevelopRun['events'][number], now = new Date().toISOString()): DevelopRun {
  safeData(run); safeData(event); authentic(value, now);
  closed(run, ['schema_version','kind','id','source_sha','binding','profile_fingerprint','work_item_fingerprint','approval_fingerprint','events','provider_scope','execution','deliver','authority_verified']);
  const original = declareDevelop(value, run.binding, { id: run.id, source_sha: run.source_sha }, now);
  const { events, ...metadata } = run, { events: _initial, ...expected } = original;
  if (canonical(metadata) !== canonical(expected) || !Array.isArray(events) || events.length > 3) deny('run_binding');
  const all = [...events, event];
  for (let i = 0; i < all.length; i++) {
    const e = all[i]!; closed(e, ['sequence','type','checks']);
    if (e.sequence !== i + 1 || !Array.isArray(e.checks) || e.checks.length > 32) deny('event');
    const allowed = i === 0 ? ['started'] : i === 1 ? ['checks_reported','failed'] : i === 2 && all[1]!.type === 'checks_reported' ? ['completed','failed'] : [];
    if (!allowed.includes(e.type)) deny('event');
    for (const c of e.checks) { closed(c, ['command','exit_code']); if (!Number.isSafeInteger(c.exit_code) || c.exit_code < 0 || c.exit_code > 255) deny('event'); }
    if (e.type === 'checks_reported' ? canonical(e.checks.map(c => c.command)) !== canonical(value.work_item.checks) : e.checks.length !== 0) deny('event_checks');
    if (e.type === 'completed' && all[1]!.checks.some(c => c.exit_code !== 0)) deny('event_outcome');
  }
  return freeze({ ...original, events: structuredClone(all) });
}
