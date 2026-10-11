import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readExternalFile } from '../shared/external-files.js';
import { enrollmentGrants, type EnrollmentGrant } from '../shared/enrollment.js';
import { clientFail, same, type ClientConfig, type Machine, type RepositoryIdentity } from './local.js';
import type { ProjectManifest } from '../protocol/index.js';

/** Read-only Enrollment comparison; never selects or grants a Deliver workflow. */
export function observationPolicy(configPath: string, config: ClientConfig, identity: RepositoryIdentity,
  manifest: ProjectManifest, machine: Machine): EnrollmentGrant {
  const directory = dirname(configPath);
  const request = JSON.parse(readExternalFile(join(directory, 'request.json'), 16384).toString('utf8'));
  const grant = enrollmentGrants([JSON.parse(readExternalFile(join(directory, 'approved.json'), 16384).toString('utf8'))])[0]!;
  const worktree = 'worktree-' + createHash('sha256').update(identity.root).digest('hex').slice(0, 32);
  if (!same(grant.request, request) || !same(grant.manifest, manifest) || grant.request.mode !== 'observe' ||
      manifest.profile.ref !== 'observe/' + manifest.project.id || grant.request.profile_ref !== manifest.profile.ref ||
      grant.request.repository !== identity.repository || grant.request.worktree_id !== worktree ||
      grant.request.executor_id !== config.executor_id || !same(grant.request.machine, { id: machine.id, platform: machine.platform }))
    clientFail('enrollment_binding', 'Observe Enrollment differs from the current repository, Manifest or Machine');
  return grant;
}

export function compareObservedPolicy(value: unknown, approved: EnrollmentGrant): void {
  const observed = enrollmentGrants([value])[0]!;
  if (!same(observed, approved)) clientFail('enrollment_binding', 'CP Observe Enrollment differs from the retained approval');
}
