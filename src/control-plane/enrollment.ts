import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { externalFilePath, readExternalFile } from '../shared/external-files.js';
import { fail } from '../shared/security.js';
import { enrollmentRequest, enrollmentGrants, type EnrollmentGrant } from '../shared/enrollment.js';
import { readTrustedConfig } from './config.js';
import { validateExistingDatabase } from './store.js';
import { loadApprovedWorkItem, versionedPreflight } from '../client/versioned-profile.js';

// Local CP-owner action only. No HTTP administrator, arbitrary command, Provider or migration.
export function approveEnrollment(options: { request: string; trustedConfig: string; database: string; confirm: boolean; policyTrust?: string }) {
  const path = externalFilePath(options.trustedConfig), lock = path + '.enrollment.lock';
  if (!options.confirm) return applyEnrollment(options);
  let fd: number; try {fd = openSync(lock,'wx',0o600);}catch {return fail(409,'enrollment_busy','Another local approval is active');}
  try {return applyEnrollment(options);}finally{closeSync(fd);unlinkSync(lock);}
}
function applyEnrollment(options: { request: string; trustedConfig: string; database: string; confirm: boolean; policyTrust?: string }) {
  const request = enrollmentRequest(JSON.parse(readExternalFile(options.request, 16384).toString('utf8')));
  const trusted = readTrustedConfig(options.trustedConfig);
  validateExistingDatabase(options.database, trusted.profiles, trusted.enrollments);
  const old = trusted.enrollments.find(g => g.request.id === request.id);
  if (old) {
    if (JSON.stringify(old.request) !== JSON.stringify(request)) fail(409, 'identity_conflict', 'Request ID cannot change');
    return { status: 'approved', request_id: request.id, project_id: old.manifest.project.id, capability: old.capability, disposition: 'idempotent', authority_verified: false };
  }
  const db = new DatabaseSync(externalFilePath(options.database), { readOnly: true, allowExtension: false });
  let grant: EnrollmentGrant;
  try {
    const projects = db.prepare('SELECT record FROM projects').all().map(r => JSON.parse(String(r.record)));
    const matches = projects.filter(p => p.repository.toLowerCase() === request.repository.toLowerCase());
    if (matches.length > 1) fail(409, 'project_ambiguous', 'Repository has multiple retained Project identities; owner resolution required');
    const existing = matches[0];
    const projectId = existing?.id ?? 'project-' + createHash('sha256').update(request.repository.toLowerCase()).digest('hex').slice(0,32);
    const profileRef = existing?.profile_ref ?? 'observe/' + projectId;
    if (projects.some(p => p.id === projectId && p.repository.toLowerCase() !== request.repository.toLowerCase()) ||
        db.prepare('SELECT id FROM executors WHERE id = ?').get(request.executor_id)) fail(409, 'identity_conflict', 'New enrollment cannot take an existing identity');
    if (request.mode === 'develop') {
      if (!options.policyTrust || !request.work_item) fail(403, 'development_authorization_required', 'Explicit approved Work Item trust required');
      const approved = loadApprovedWorkItem(options.policyTrust, request.work_item);
      const w = approved.work_item;
      const { id: _id, expires_at: _expires, stages: _stages, ...facts } = w;
      if (versionedPreflight(approved, facts, 'develop').status !== 'passed')
        fail(403, 'development_authorization_required', 'Approved development binding required');
      if (w.repository !== request.repository || w.branch !== request.branch || w.executor !== request.executor_id || w.profile_ref !== request.profile_ref)
        fail(403, 'development_authorization_required', 'Development request differs from approved Work Item');
    }
    grant = { request, manifest: { apiVersion: 'awh/v1', project: { id: projectId, repository: existing?.repository ?? request.repository }, profile: { ref: profileRef } },
      approved_at: new Date().toISOString(), capability: 'register_presence' };
  } finally { db.close(); }
  const result = { status: options.confirm ? 'approved' : 'approval_required', request_id: request.id, project_id: grant.manifest.project.id,
    repository: request.repository, machine_id: request.machine.id, executor_id: request.executor_id, mode: request.mode, capability: grant.capability,
    writes: ['add dedicated Client scope', 'add immutable enrollment grant'], authority_verified: false };
  if (!options.confirm) return result;
  const next = { clients: [...trusted.clients, { id: request.client_id, project_ids: [grant.manifest.project.id], executor_ids: [request.executor_id], token_sha256: request.token_sha256 }],
    profiles: trusted.profiles, enrollments: enrollmentGrants([...trusted.enrollments, grant]) };
  if (trusted.clients.some(c => c.id === request.client_id || c.token_sha256 === request.token_sha256 || c.executor_ids.includes(request.executor_id)))
    fail(409, 'identity_conflict', 'Existing Client scopes cannot be expanded by enrollment');
  const path = externalFilePath(options.trustedConfig), temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
    readTrustedConfig(temporary); renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  return result;
}
