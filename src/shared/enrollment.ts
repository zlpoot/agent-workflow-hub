import { safeData, validId, fail } from './security.js';
import type { ProjectManifest } from '../protocol/index.js';

export interface EnrollmentRequest {
  schema_version: '1.0'; kind: 'enrollment_request'; id: string; repository: string;
  project_id: string; profile_ref: string; client_id: string; executor_id: string;
  machine: { id: string; platform: 'windows' | 'macos' | 'linux' }; worktree_id: string;
  token_sha256: string; mode: 'observe' | 'develop'; branch: string; sha: string;
  work_item: { id: string; version: string } | null;
}
export interface EnrollmentGrant {
  request: EnrollmentRequest; manifest: ProjectManifest; approved_at: string;
  capability: 'register_presence';
}
const closed = (v: unknown, keys: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export function enrollmentRequest(value: unknown): EnrollmentRequest {
  safeData(value); const v = value as EnrollmentRequest;
  if (!closed(v, ['schema_version','kind','id','repository','project_id','profile_ref','client_id','executor_id','machine','worktree_id','token_sha256','mode','branch','sha','work_item']) ||
      v.schema_version !== '1.0' || v.kind !== 'enrollment_request' ||
      ![v.id,v.project_id,v.client_id,v.executor_id,v.worktree_id].every(validId) ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(v.repository) || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(v.profile_ref) ||
      !closed(v.machine, ['id','platform']) || !validId(v.machine.id) || !['windows','macos','linux'].includes(v.machine.platform) ||
      !/^[a-f0-9]{64}$/.test(v.token_sha256) || !['observe','develop'].includes(v.mode) ||
      !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(v.branch) || !/^[a-f0-9]{40}$/.test(v.sha) ||
      v.work_item !== null && (!closed(v.work_item, ['id','version']) || !validId(v.work_item.id) || !validId(v.work_item.version)) ||
      v.mode === 'observe' && v.work_item !== null || v.mode === 'develop' && v.work_item === null)
    fail(400, 'enrollment_request', 'Invalid bounded enrollment request');
  return structuredClone(v);
}
export function enrollmentGrants(value: unknown): EnrollmentGrant[] {
  if (!Array.isArray(value) || value.length > 64) fail(500, 'configuration', 'Bounded enrollment grants required');
  const clients = new Set<string>(), ids = new Set<string>();
  return value.map(v => {
    if (!closed(v, ['request','manifest','approved_at','capability']) || v.capability !== 'register_presence' ||
        typeof v.approved_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.approved_at) || !Number.isFinite(Date.parse(v.approved_at)))
      fail(500, 'configuration', 'Invalid enrollment grant');
    const request = enrollmentRequest(v.request);
    if (clients.has(request.client_id) || ids.has(request.id) || !closed(v.manifest, ['apiVersion','project','profile']) ||
        v.manifest.apiVersion !== 'awh/v1' || !closed(v.manifest.project, ['id','repository']) || !validId(v.manifest.project.id) ||
        v.manifest.project.repository !== request.repository || !closed(v.manifest.profile, ['ref']) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(v.manifest.profile.ref)) fail(500, 'configuration', 'Enrollment identity conflict');
    clients.add(request.client_id); ids.add(request.id); return structuredClone(v) as EnrollmentGrant;
  });
}
