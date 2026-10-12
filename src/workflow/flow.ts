import { mkdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AwhClient } from '../client/client.js';
import { clientFail, inspectRepository, readManifest, readJson, same, ClientError } from '../client/local.js';
import { AdminError, projectObservationContext, snapshot, managedContext } from '../admin/registry.js';
import { validateBuilderPolicy, selectWorkflow } from '../profiles.js';
import { connectBuilder } from '../builder.js';
import { prepareCodexStage } from './codex.js';

export interface IssueQueue { schema_version: '1.0'; issues: number[] }
function queue(value: unknown): IssueQueue {
  const q = value as IssueQueue;
  if (!q || Object.keys(q).sort().join(',') !== 'issues,schema_version' || q.schema_version !== '1.0' || !Array.isArray(q.issues) ||
      !q.issues.length || q.issues.length > 128 || new Set(q.issues).size !== q.issues.length || q.issues.some(n => !Number.isSafeInteger(n) || n < 1))
    clientFail('flow_queue','Queue requires 1–128 distinct positive safe Issue numbers; only order is stored');
  return q;
}
function path(cwd: string, create = false): string {
  const identity = inspectRepository(cwd), directory = join(identity.root,'.awh');
  if (create) mkdirSync(directory,{recursive:true});
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) clientFail('flow_queue','Queue directory cannot be redirected');
  return join(directory,'flow.json');
}
export function initFlow(cwd: string, issues: string) {
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(issues)) clientFail('flow_queue','Use --issues 1,2,3');
  const q = queue({schema_version:'1.0',issues:issues.split(',').map(Number)}), file = path(cwd,true);
  try { writeFileSync(file,JSON.stringify(q,null,2)+'\n',{flag:'wx'}); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (!same(readJson(file,4096),q)) clientFail('flow_queue','Existing queue differs; preserve history and explicitly edit the declaration'); }
  return {status:'QUEUE_INITIALIZED',queue:q,authority_verified:false};
}
export const readFlow = (cwd: string): IssueQueue => queue(readJson(path(cwd),4096));
export interface FlowDependencies { connect: typeof connectBuilder }
/** Selection only. Human starts Codex; the existing Stage remains the only delivery entry. */
export async function inspectFlow(client: AwhClient, advance = false, deps: FlowDependencies = {connect:connectBuilder}): Promise<Record<string,unknown>> {
  const identity = inspectRepository(client.cwd), q = readFlow(client.cwd), manifest = readManifest(identity);
  const common = {repository:identity.repository,queue:q.issues,authority_verified:false};
  const blocked = (code:string) => ({...common,status:'BLOCKED',code,recovery:'Preserve Session/Journal/Receipt and worktrees; reconcile from the original clean candidate and protected launcher.'});
  let issue = q.issues[0]!;
  try {
    const context = projectObservationContext(), policy = validateBuilderPolicy(context.project.builder_policy,true);
    const [profileId,workflowId,extra] = manifest.profile.ref.split('/');
    if (!profileId || !workflowId || extra) return blocked('flow_profile');
    const selection = {profile:profileId,workflow:workflowId}, {profile,workflow} = selectWorkflow(selection,policy);
    if (profile.repository !== identity.repository || profile.base !== 'main') return blocked('flow_project');
    const observer = await deps.connect({cwd:()=>identity.root},selection,undefined,'queue');
    const runs = await client.workflowRuns();
    if (runs.some(r => !q.issues.includes(r.issue) && !['completed','failed'].includes(r.run.state))) return blocked('flow_other_active_issue');
    const completed:number[] = [];
    for (const [index,n] of q.issues.entries()) {
      issue = n;
      const attempts = runs.filter(r => r.issue === n), run = attempts.find(r => r.current) ?? attempts.find(r => r.run.state !== 'failed') ?? attempts.at(-1);
      if (!run) {
        if (q.issues.slice(index+1).some(later => runs.some(r => r.issue === later))) return blocked('flow_out_of_order');
        const native = await observer.readFlowIssue(n);
        if (native.state !== 'open') return blocked('flow_closed_without_confirmed_run');
        return await ready(native.base_sha,n,completed);
      }
      if (attempts.some(r => r !== run && r.run.state !== 'failed')) return blocked('flow_conflicting_runs');
      if (!run.candidate || !run.head) return {...common,status:run.run.state === 'failed' ? 'BLOCKED' : 'DEVELOPMENT_IN_PROGRESS',issue:n,run_id:run.run.id,
        recovery:'Continue the existing Issue with stage prepare/execute; retain failed verification for existing Recovery. Do not start the next Issue.'};
      const facts = await observer.readLifecycle(run.candidate.pull_request.number,run.head,{issue:n,branch:run.run.source.ref});
      const details = {issue:n,branch:run.run.source.ref,base_sha:run.candidate.base_sha,head:run.head,run_id:run.run.id,
        pr_url:`https://github.com/${identity.repository}/pull/${facts.pull_request}`};
      if (facts.changes_requested) {
        if (run.run.state === 'completed' || facts.merged) return blocked('flow_closeout_changed');
        if (!facts.changes_review?.id) return blocked('flow_review_missing');
        return {...common,...details,status:'REQUEST_CHANGES',review_id:facts.changes_review?.id,
          authorization_required:{policy_version:context.version,profile_ref:run.run.profile.ref,repository:identity.repository,
            executor_id:run.run.executor_id,machine_id:run.run.machine_id,original_version:run.run.profile.version,run_id:run.run.id,pull_request:facts.pull_request,previous_head:run.head,review_id:facts.changes_review?.id,
            head_sha:'Commit the fix, then independently approve its exact new HEAD',stages:['observe','develop','deliver'],operations:['push','evidence','handoff']},
          instructions:'Fix this same branch and PR. Obtain the separate exact-head revision grant using the Windows Quick Start, then run stage execute.'};
      }
      if (!facts.merged || !facts.issue_closed || !facts.review) {
        if (run.run.state === 'completed' || facts.state === 'closed' && !facts.merged) return blocked('flow_closeout_changed');
        return {...common,...details,status:'AWAITING_REVIEW',completed};
      }
      if (run.run.state !== 'completed') {
        if (!advance) return {...common,...details,status:'SYNC_REQUIRED',instructions:'Run flow next from this confirmed clean candidate under its original protected launcher.'};
        if (!run.current) return blocked('flow_archived_unfinished');
        const synced = await client.syncDelivery(deps.connect);
        if (synced.run.state !== 'completed') return blocked('flow_sync_incomplete');
      }
      completed.push(n);
    }
    return {...common,status:'QUEUE_COMPLETED',completed};

    async function ready(base:string,n:number,completed:number[]) {
      const branch = workflow.branch_mode === 'issue_prefix' ? workflow.branch+n : workflow.work_item.issue === n ? workflow.branch : null;
      if (!branch) return blocked('flow_branch_scope');
      const status = await client.status(), {state} = snapshot(context.trust), grants = [];
      for (const entry of state.entries.filter(e => e.action === 'grant')) {
        let c;
        try { c = managedContext({...process.env,AWH_ADMIN_VERSION:entry.version}); }
        catch (e) { if (e instanceof AdminError && ['unapproved_or_revoked','task_expired','project_unapproved_or_revoked'].includes(e.code)) continue; throw e; }
        const t = c?.proposed.task;
        if (t && !t.revision && !t.verification_recovery && c!.proposed.policy_version === context.version && t.repository === identity.repository && t.issue === n && t.branch === branch && t.base_sha === base &&
            t.profile === profile.id && t.workflow === workflow.id && t.executor_id === status.executor.id && t.machine_id === status.executor.machine.id &&
            ['observe','develop','deliver'].every(s => t.stages.includes(s as any)) && ['push','draft_pr','evidence','handoff'].every(o => t.provider_operations.includes(o as any))) grants.push(c!);
      }
      const selected = grants.find(g => g.version === process.env.AWH_ADMIN_VERSION) ?? (grants.length === 1 ? grants[0] : undefined);
      const request = {policy_version:context.version,profile:profile.id,workflow:workflow.id,repository:identity.repository,issue:n,branch,base_sha:base,
        executor_id:status.executor.id,machine_id:status.executor.machine.id,stages:['observe','develop','deliver'],operations:['push','draft_pr','evidence','handoff']};
      if (!selected) return {...common,status:'APPROVAL_REQUIRED',completed,request,steps:approvalSteps(request)};
      if (identity.dirty) return blocked('flow_dirty_worktree');
      return {...common,status:'READY',issue:n,issue_url:`https://github.com/${identity.repository}/issues/${n}`,branch,base_sha:base,completed,authorization_version:selected.version,
        head_sha:selected.proposed.task!.head_sha,executor_id:status.executor.id,machine_id:status.executor.machine.id,
        verification_commands:workflow.verification_commands,allowed_paths:workflow.bootstrap_paths,delivery_entry:'awh --config <external-client.json> stage execute --title <title> --body <UTF8-file>',
        ...(identity.ref === branch && process.env.AWH_ADMIN_VERSION === selected.version ? {stage:prepareCodexStage(identity.root)} : {}),
        instructions:[`Fetch and verify origin/main equals ${base}; create an independent ${branch} worktree from that exact SHA.`,
          `Use the protected launcher for ${selected.version} and provision its exact immutable CP Profile/Client version using existing administrator controls.`,
          'Read the Issue, run stage prepare, implement, test and Commit. Run stage execute in the same Codex task; it publishes Draft PR, Evidence and confirmed Handoff.',
          'Stop at AWAITING_INDEPENDENT_REVIEW. Human owns Review/Merge; on continuation run flow next from the confirmed candidate before switching authorization.']};
    }
  } catch (e) {
    if (e instanceof AdminError) return {...common,status:'APPROVAL_REQUIRED',issue,code:e.code,
      steps:['In the protected administrator session: node $admin inspect; node $admin diagnose.',
        'Select an independently approved Project Policy or existing Work Item with AWH_ADMIN_VERSION in the protected launcher, and its original external trust/pin.',
        'Run flow next again for exact native main and the copyable Work Item proposal. See docs/windows-fast-flow.md.']};
    return blocked(e instanceof ClientError ? e.code : 'flow_provider_or_state');
  }
}
function approvalSteps(r: Record<string,unknown>): string[] {
  return [`node $admin propose --policy-version ${r.policy_version} --profile ${r.profile} --workflow ${r.workflow} --repo ${r.repository} --issue ${r.issue} --branch ${r.branch} --base-sha ${r.base_sha} --executor ${r.executor_id} --machine ${r.machine_id} --stages observe,develop,deliver --operations push,draft_pr,evidence,handoff --expires-at $expires --version $version --out $proposal`,
    'node $admin validate --proposal $proposal',
    'node $admin approval-prepare --proposal $proposal --receipt $receipt --reason "Approve queued Issue through independent Review" --out $receiptProposal',
    'Administrator independently reviews and provisions approved receipt/pin in the protected session; preparation is not approval.',
    'node $admin approve --proposal $proposal --confirm',
    'node $admin validate --version $version --stage observe; node $admin validate --version $version --stage develop; node $admin validate --version $version --stage deliver',
    'node $admin preflight --version $version'];
}
