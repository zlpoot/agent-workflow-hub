import { selectWorkflow } from '../dist/profiles.js';
import { allowMachine } from './trusted-policy-fixture.mjs';
export function policyFor(profile,workflow) {
 const f=selectWorkflow({profile,workflow});
 return {schema_version:'1.0',kind:'profile_policy',ref:profile+'/'+workflow,version:f.workflow.version,repository:f.profile.repository,base:f.profile.base,
 branch:{mode:f.workflow.branch_mode,ref:f.workflow.branch},verification:{commands:[...f.workflow.verification_commands]},
 github_app:{identity:'installation',repository_scope:'single',selected_set_policy:'exact',permissions:{contents:'write',issues:'write',metadata:'read',pull_requests:'write'}},
 review:{mode:'independent_exact_head',builder_is_reviewer:false},delivery:{draft_pr:true,handoff_version:'0.1',confirmed_publication_required:true,exact_head_required:true},executor_restrictions:structuredClone(f.workflow.executor_restrictions)};
}
export const fixedPolicy=()=>policyFor('project-alpha','docs');
export function repeatablePolicy(machineId){allowMachine(machineId);return policyFor('project-alpha','repeatable');}
