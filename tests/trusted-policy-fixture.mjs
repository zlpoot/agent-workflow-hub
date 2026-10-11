// TEST ONLY: isolated synthetic authority outside every Git worktree. Never shipped.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const catalog = JSON.parse(readFileSync(new URL('./fixtures/builder-policy.json',import.meta.url)));
const dir=mkdtempSync(join(tmpdir(),'awh-test-policy-')),file=join(dir,'policy.json');
export function refreshPolicy() {
  const bytes=JSON.stringify(catalog);writeFileSync(file,bytes,{mode:0o600});
  process.env.AWH_BUILDER_POLICY_FILE=file;process.env.AWH_BUILDER_POLICY_SHA256=createHash('sha256').update(bytes).digest('hex');
}
export function allowMachine(machineId, executorId='alpha-executor') {
  for(const p of catalog.profiles)for(const w of p.workflows){if(!w.executor_restrictions.machine_ids.includes(machineId))w.executor_restrictions.machine_ids.push(machineId);if(!w.executor_restrictions.executor_ids.includes(executorId))w.executor_restrictions.executor_ids.push(executorId);}
  refreshPolicy();
}
refreshPolicy();process.once('exit',()=>rmSync(dir,{recursive:true,force:true}));
const freeze = v => { if(v && typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v; };
export const PROFILES=freeze(structuredClone(catalog.profiles)),DEFAULT_SELECTION=freeze(structuredClone(catalog.default_selection));
export const REPEATABLE_VERSION='repeatable-v1';
export const CORE_REPO='example-org/workflow-core',ALPHA_REPO='example-org/project-alpha',BETA_REPO='example-org/project-beta';
export const REPO=CORE_REPO,BRANCH=PROFILES.find(p=>p.id===DEFAULT_SELECTION.profile).workflows.find(w=>w.id===DEFAULT_SELECTION.workflow).branch;
