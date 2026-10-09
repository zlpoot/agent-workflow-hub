import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ControlPlaneStore, DATABASE_VERSION } from './control-plane/store.js';
import { selectWorkflow, REPEATABLE_VERSION, TASK_PREFIX } from './profiles.js';
import type { ProfilePolicy } from './protocol/index.js';

export const MVP_PROFILE_VERSION = 'v01-mvp-docs-v1';
export function mvpPolicy(): ProfilePolicy {
  const fixed = selectWorkflow({ profile: 'future-ui', workflow: 'mvp-docs' });
  return { schema_version: '1.0', kind: 'profile_policy', ref: 'future-ui/c1c-acceptance', version: MVP_PROFILE_VERSION,
    repository: fixed.profile.repository, base: fixed.profile.base, branch: { mode: 'fixed', ref: fixed.workflow.branch },
    verification: { commands: [...fixed.workflow.verification_commands] },
    github_app: { identity: 'installation', repository_scope: 'single', selected_set_policy: 'exact', permissions: { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' } },
    review: { mode: 'independent_exact_head', builder_is_reviewer: false },
    delivery: { draft_pr: true, handoff_version: '0.1', confirmed_publication_required: true, exact_head_required: true }, executor_restrictions: null };
}
// One explicit static version, using the existing immutable Profile seed transaction.
// Does not load trusted Client config, rotate credentials, migrate schema or restart CP.
export function seedMvpProfile(database: string) {
  const path = realpathSync(database);
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (existsSync(join(parent, '.git'))) throw new Error('Database must be repository-external');
    if (dirname(parent) === parent) break;
  }
  const read = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try { if (Number(read.prepare('PRAGMA user_version').get()!.user_version) !== DATABASE_VERSION) throw new Error('Existing CP v2 is required; no migrations'); }
  finally { read.close(); }
  const policy = mvpPolicy(), store = new ControlPlaneStore(path, [policy]); store.close();
  return { seeded: { ref: policy.ref, version: policy.version }, database_version: DATABASE_VERSION, existing_identities_preserved: true, authority_verified: false };
}
export function repeatablePolicy(machineId: string): ProfilePolicy {
  const fixed = selectWorkflow({ profile: 'future-ui', workflow: 'repeatable-docs' });
  return { ...mvpPolicy(), version: REPEATABLE_VERSION, branch: { mode: 'issue_prefix', ref: TASK_PREFIX },
    verification: { commands: [...fixed.workflow.verification_commands] },
    executor_restrictions: { executor_ids: ['c1c-future-ui-windows'], machine_ids: [machineId] } };
}
export function seedRepeatableProfile(database: string) {
  const path = realpathSync(database);
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (existsSync(join(parent, '.git'))) throw new Error('Database must be repository-external');
    if (dirname(parent) === parent) break;
  }
  const read = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  let machineId: string;
  try {
    if (Number(read.prepare('PRAGMA user_version').get()!.user_version) !== DATABASE_VERSION) throw new Error('Existing CP v2 required');
    const row = read.prepare('SELECT record FROM executors WHERE id = ?').get('c1c-future-ui-windows');
    if (!row) throw new Error('Existing Windows executor required');
    const executor = JSON.parse(String(row.record));
    if (executor.machine.platform !== 'windows') throw new Error('Expected Windows machine');
    machineId = executor.machine.id;
    const project = read.prepare('SELECT record FROM projects WHERE id = ?').get('future-ui');
    if (!project || JSON.parse(String(project.record)).profile_ref !== 'future-ui/c1c-acceptance') throw new Error('Existing Project ref required');
  } finally { read.close(); }
  const policy = repeatablePolicy(machineId), store = new ControlPlaneStore(path, [policy]); store.close();
  return { seeded: { ref: policy.ref, version: policy.version }, database_version: DATABASE_VERSION, existing_identities_preserved: true, authority_verified: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 3 || !['seed-profile','seed-repeatable'].includes(args[0]!) || args[1] !== '--database' || !args[2]) throw new Error('Use seed-profile --database <existing-external-cp-v2>');
    console.log(JSON.stringify(args[0] === 'seed-repeatable' ? seedRepeatableProfile(args[2]) : seedMvpProfile(args[2])));
  } catch { console.error('Static MVP Profile seed failed; existing config and credentials unchanged (details suppressed)'); process.exitCode = 2; }
}
