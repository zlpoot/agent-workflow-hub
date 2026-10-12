import { mkdirSync, existsSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { managedContext, deny, digest, encode } from '../admin/registry.js';
import { selectWorkflow } from '../profiles.js';
import { AwhClient } from '../client/client.js';
import { deliver, deliveryDependencies, type DeliveryDependencies, type VerificationLog } from '../client/deliver.js';
import { inspectRepository, ignoredDeliveryLogs, same, clientFail } from '../client/local.js';
import { exclusiveRecoveryFile } from '../client/recovery.js';
import { inspectRevision, parseRevisionEvidence } from '../client/revision.js';
import { validateHandoff } from '../validator.js';
import { safeData } from '../shared/security.js';
import { executeStage, type ExecutorAdapter, type WorkflowStage, type StageFacts } from './contract.js';

export interface StageOptions { title: string; body: string }
/** Copyable instructions are the Executor interface; implementation and Commit remain model work. */
export function prepareCodexStage(cwd: string): WorkflowStage & { instructions: string[] } {
  const c = managedContext(); if (!c) deny('independent_trust_pin_required');
  const t = c.proposed.task!, identity = inspectRepository(cwd);
  if (!t.stages.includes('develop') || process.env.AWH_ADMIN_EXECUTOR_ID !== t.executor_id || process.env.AWH_ADMIN_MACHINE_ID !== t.machine_id ||
      identity.repository !== t.repository || identity.ref !== t.branch) deny('stage_scope');
  return {contract_version:'1.0',workflow:'develop-to-pr',stage:t.revision ? 'revise' : 'develop',
    project:{source:'administrator',kind:'project-version',id:c.proposed.policy_version!},
    work_item:{source:'github',kind:'issue',id:t.repository+'#'+t.issue},executor:{source:'administrator',kind:'executor',id:t.executor_id},
    machine:{source:'administrator',kind:'machine',id:t.machine_id},
    authorization:{source:'protected-external-independent-pin',subject:{source:'administrator',kind:'work-item-version',id:c.version},digest:c.approved.proposal_sha256},
    inputs:[{source:'git',kind:'base',id:t.base_sha},{source:'git',kind:'branch',id:t.branch}],
    next_gate:{id:'independent-review',role:'independent-reviewer',disposition:'pending',provenance:[]},
    instructions:[`Implement ${t.repository}#${t.issue} on ${t.branch}, preserving other worktrees.`,
      'Use the approved verification commands, fix failures, and create a local Git Commit.',
      'Run the stage execute CLI from the exact clean candidate with the existing external Client config and administrator launcher.',
      'The existing Builder publishes a Draft PR, Evidence and confirmed Handoff. Stop at awaiting_review; Human owns Merge.']};
}

export class CodexExecutorAdapter implements ExecutorAdapter {
  private deps: DeliveryDependencies;
  constructor(readonly client: AwhClient, readonly options: StageOptions, overrides: Partial<DeliveryDependencies> = {}) {
    this.deps = {...deliveryDependencies,...overrides};
  }
  async preflight(): Promise<WorkflowStage> {
    safeData(this.options);
    if (Object.keys(this.options).sort().join(',') !== 'body,title' || typeof this.options.title !== 'string' || !this.options.title.trim() || this.options.title.length > 256 || typeof this.options.body !== 'string' || this.options.body.length > 16000) deny('arguments');
    const {instructions:_instructions,...contract} = prepareCodexStage(this.client.cwd), c = managedContext()!, t = c.proposed.task!, i = inspectRepository(this.client.cwd);
    if (i.dirty || i.sha === t.base_sha || t.head_sha !== null && i.sha !== t.head_sha || !t.stages.includes('deliver') || !t.stages.includes('observe') ||
        !(t.revision ? ['push','evidence','handoff'] : ['push','draft_pr','evidence','handoff']).every(o => t.provider_operations.includes(o as any))) deny('stage_preflight');
    // Existing Session must agree with the external executor/machine and CP; no auto-registration.
    const status = await this.client.status();
    await this.client.workflowCapabilities();
    if (status.executor.id !== t.executor_id || status.executor.machine.id !== t.machine_id) deny('stage_identity');
    return contract;
  }
  async execute(_contract: WorkflowStage) {
    const c = managedContext()!, t = c.proposed.task!, status = await this.client.status(), head = inspectRepository(this.client.cwd).sha;
    if (status.pending_delivery_events && status.pending_event?.type !== 'RUN_STARTED') {
      if (status.pending_event?.type === 'PR_REVISION_LINKED') await this.client.retryRevision();
      else await this.client.retryDelivery();
    }
    const current = await this.client.status();
    if (current.run?.state === 'awaiting_review' && current.effective_candidate_head === head) return;
    if (t.revision) await this.revise();
    else await deliver(this.client,{...this.options,issue:t.issue,holdDraft:true,
      ...(t.verification_recovery && current.run?.id === t.verification_recovery.run_id ? {recoverFromRun:t.verification_recovery.run_id} :
        current.run?.state === 'failed' && current.run.source.sha !== head && t.head_sha === null ? {recoverFromRun:current.run.id} : {})},this.deps);
  }
  private async revise() {
    const c = managedContext()!, t = c.proposed.task!, r = t.revision!, identity = inspectRepository(this.client.cwd), fixed = selectWorkflow();
    const timeline = await this.client.timeline(r.run_id);
    // timeline.run is a projection; original source and effective candidate are retained by timeline.
    if (!['awaiting_review','reviewing','review_passed'].includes(timeline.run.state) || timeline.effective_candidate_head !== r.previous_head || timeline.run.source.ref !== t.branch || timeline.run.profile.version !== r.original_version)
      deny('revision_run_binding');
    const events = timeline.events.map(e => e.event), original = timeline.run.source.sha;
    const candidate = events.find(e => e.type === 'GITHUB_PR_CREATED');
    if (candidate?.type !== 'GITHUB_PR_CREATED' || candidate.payload.data.pull_request.number !== r.pull_request || candidate.payload.data.base_sha !== t.base_sha) deny('revision_run_binding');
    inspectRevision(identity.root,original,r.previous_head,identity.sha,t.base_sha,fixed.workflow.bootstrap_paths,fixed.profile.base);
    ignoredDeliveryLogs(identity);
    const stages = join(identity.root,'.handoff','stages'), directory = join(stages,c.version);
    for (const p of [join(identity.root,'.handoff'),stages,directory]) {
      mkdirSync(p,{recursive:true});
      if (!lstatSync(p).isDirectory() || lstatSync(p).isSymbolicLink() || realpathSync(p) !== p) deny('revision_journal_path');
    }
    const file = (name:string) => join(directory,name+'.json');
    const save = (name:string,v:unknown) => exclusiveRecoveryFile(file(name),encode(v));
    const load = (name:string) => JSON.parse(readFileSync(file(name),'utf8'));
    const intent = {authorization:c.version,authorization_sha256:c.approved.proposal_sha256,run:r.run_id,pr:r.pull_request,previous:r.previous_head,head:identity.sha};
    if (existsSync(file('intent'))) { if (!same(load('intent'),intent)) deny('revision_journal_conflict'); } else save('intent',intent);
    const exact = () => {if (!same(inspectRepository(this.client.cwd),identity) || identity.dirty) deny('exact_head');};
    // Worktree logs are audit data, never authority to skip execution, including on recovery.
    const attempt = 'verification-attempt-'+randomUUID(), logs: VerificationLog[] = [], started = new Date().toISOString();
    for (const command of fixed.workflow.verification_commands) {
      exact(); const log = await this.deps.verify(command,identity.root); safeData(log); logs.push(log);
      if (log.command !== command || log.exit_code !== 0) {
        save(attempt,{head:identity.sha,started_at:started,finished_at:new Date().toISOString(),logs,outcome:'fail'});
        clientFail('verification','Revision verification failed; raw logs retained');
      }
      exact();
    }
    exact(); const verified = {actor:'',base_sha:t.base_sha,before_sha:identity.sha,after_sha:identity.sha,clean_before:true,clean_after:true,
      environment:{platform:process.platform,arch:process.arch,node:process.version},started_at:started,finished_at:new Date().toISOString(),logs};
    save(attempt,verified);
    if (!existsSync(file('verification'))) save('verification',verified);
    const observer = await this.deps.connect({cwd:()=>identity.root},undefined,undefined,'observe'), actor = observer.preflight().actor;
    let body = 'Builder evidence\n'+JSON.stringify({...verified,actor,run_id:r.run_id,authorization_version:c.version},null,2);
    safeData(body);
    parseRevisionEvidence(body,actor,identity.sha,t.base_sha,fixed.workflow.verification_commands);
    if (!existsSync(file('push-intent'))) {
      save('push-intent',intent); exact();
      const builder = await this.deps.connect({cwd:()=>identity.root},undefined,undefined,'revise'); await builder.push();
    }
    // A lost transport ACK is recovered by exact native observations, never by replaying Push.
    if (await observer.readRevisionRef() !== identity.sha || (await observer.readPR(r.pull_request)).head !== identity.sha) deny('revision_push_uncertain');
    let evidence: {id:number;url:string;body:string};
    if (existsSync(file('evidence'))) evidence = load('evidence');
    else if (existsSync(file('evidence-intent'))) {
      const intent = load('evidence-intent');
      const comments = await observer.listComments(r.pull_request), matches = comments.filter(v => v.actor === actor && v.actor_type === 'Bot' && digest(v.body) === intent.body_sha256);
      if (matches.length !== 1) deny('revision_evidence_uncertain');
      evidence = matches[0]!; save('evidence',evidence);
    } else {
      save('evidence-intent',{body_sha256:digest(body)}); exact();
      const publisher = await this.deps.connect({cwd:()=>identity.root},undefined,undefined,'revision');
      evidence = await publisher.createComment(r.pull_request,body); save('evidence',evidence);
    }
    // Preserve an acknowledged App comment after an interruption; fresh execution above gates Handoff.
    const record = await observer.readComment(r.pull_request,evidence.id);
    if (record.actor !== actor || record.body !== evidence.body) deny('revision_evidence_readback');
    body = record.body; safeData(body);
    parseRevisionEvidence(body,actor,identity.sha,t.base_sha,fixed.workflow.verification_commands);
    const metadata = JSON.parse(body.slice('Builder evidence\n'.length));
    if (metadata.run_id !== r.run_id || metadata.authorization_version !== c.version) deny('revision_evidence_readback');
    exact(); await this.client.linkRevision({run:r.run_id,pr:r.pull_request,head:identity.sha,evidenceComment:evidence.id},this.deps.connect);
  }
  async postcondition(_contract:WorkflowStage): Promise<StageFacts> {
    const c = managedContext()!, t = c.proposed.task!, identity = inspectRepository(this.client.cwd), status = await this.client.status();
    if (c.version !== _contract.authorization.subject.id || c.approved.proposal_sha256 !== _contract.authorization.digest) deny('stage_authorization_changed');
    if (!status.run || status.run.state !== 'awaiting_review' || status.pending_delivery_events || status.interrupted_revisions.length || status.effective_candidate_head !== identity.sha || identity.dirty) deny('stage_postcondition');
    const timeline = await this.client.timeline(status.run.id), events = timeline.events.map(e => e.event);
    const local = this.client.workflowObservation();
    if (!same(local.events,events) || !same(local.projection.run,timeline.run)) deny('stage_history');
    const first = events.find(e => e.type === 'GITHUB_PR_CREATED'), revision = [...events].reverse().find(e => e.type === 'PR_REVISION_LINKED');
    const published = [...events].reverse().find(e => e.type === 'HANDOFF_PUBLISHED' && e.payload.data.publication === 'confirmed');
    if (first?.type !== 'GITHUB_PR_CREATED' || published?.type !== 'HANDOFF_PUBLISHED' || !events.some(e => e.type === 'GITHUB_PUSH_COMPLETED') || !events.some(e => e.type === 'VERIFICATION_PASSED') ||
        !same(timeline.run,status.run) || timeline.effective_candidate_head !== identity.sha) deny('stage_postcondition');
    const pr = first.payload.data.pull_request.number, comment = revision?.type === 'PR_REVISION_LINKED' ? revision.payload.data.handoff.comment.number : published.payload.data.comment.number;
    if (t.revision && (pr !== t.revision.pull_request || status.run.id !== t.revision.run_id) || status.run.source.repository !== t.repository || status.run.source.ref !== t.branch) deny('stage_postcondition');
    const builder = await this.deps.connect({cwd:()=>identity.root},undefined,undefined,'observe'), remote = await builder.readPR(pr), record = await builder.readComment(pr,comment);
    let handoff:any;
    try {handoff = JSON.parse(/AWH-HANDOFF v0\.1\n```json\n([\s\S]+?)\n```/.exec(record.body)?.[1] ?? 'null');} catch {deny('stage_handoff');}
    if (!remote.draft || remote.head !== identity.sha || remote.base !== t.base_sha || record.actor !== builder.preflight().actor || !validateHandoff(handoff,identity.sha).ready_claim_valid ||
        handoff.producer.run_id !== status.run.id || handoff.producer.executor !== t.executor_id || handoff.candidate.pr !== pr || handoff.work_item.repo !== t.repository || handoff.work_item.issue !== t.issue ||
        !same(handoff.verification.checks,fixedChecks()) || !handoff.verification.evidence_refs.length) deny('stage_handoff');
    const evidence = [], bodies:string[] = [];
    for (const url of handoff.verification.evidence_refs) {
      const prefix = `https://github.com/${t.repository}/pull/${pr}#issuecomment-`, n = Number(url.slice(prefix.length));
      if (!url.startsWith(prefix) || !Number.isSafeInteger(n) || n < 1) deny('stage_evidence');
      const e = await builder.readComment(pr,n);
      if (e.actor !== record.actor || !e.body.startsWith('Builder evidence\n')) deny('stage_evidence');
      bodies.push(e.body);
      evidence.push({source:'github',subject:{source:'github',kind:'evidence',id:String(n),uri:url},digest:digest(e.body)});
    }
    if (revision?.type === 'PR_REVISION_LINKED') {
      if (bodies.length !== 1 || digest(bodies[0]!) !== revision.payload.data.evidence.sha256 || String(revision.payload.data.evidence.comment.number) !== evidence[0]!.subject.id)
        deny('stage_evidence');
      parseRevisionEvidence(bodies[0]!,record.actor,identity.sha,t.base_sha,selectWorkflow().workflow.verification_commands);
      if (JSON.parse(bodies[0]!.slice('Builder evidence\n'.length)).run_id !== status.run.id) deny('stage_evidence');
    } else {
      let metadata:any, raw = '';
      for (const [i,body] of bodies.entries()) {
        const match = /^Builder evidence\n([\s\S]+?)\nRaw verification output part (\d+)\/(\d+)\n([\s\S]+)$/.exec(body);
        if (!match || Number(match[2]) !== i+1 || Number(match[3]) !== bodies.length) deny('stage_evidence');
        const m = JSON.parse(match[1]!);
        if (metadata && !same(metadata,m) || m.run_id !== status.run.id || m.actor !== record.actor || m.before_sha !== identity.sha || m.after_sha !== identity.sha ||
            m.clean_before !== true || m.clean_after !== true || !same(m.checks,fixedChecks()) || !same(m.command_order,selectWorkflow().workflow.verification_commands)) deny('stage_evidence');
        metadata = m; raw += match[4]!;
      }
      const logs = JSON.parse(raw);
      if (!Array.isArray(logs) || !same(logs.map(l=>({command:l.command,exit_code:l.exit_code})),fixedChecks()) || logs.some(l=>typeof l.stdout !== 'string' || typeof l.stderr !== 'string')) deny('stage_evidence');
    }
    if (!same(inspectRepository(this.client.cwd),identity)) deny('exact_head');
    return {run:{source:'cp',kind:'run',id:status.run.id},events:events.map(e=>({source:'cp',kind:'event',id:e.id})),
      outputs:[{source:'github',kind:'draft-pr',id:String(pr),uri:remote.url},{source:'git',kind:'head',id:identity.sha},{source:'github',kind:'confirmed-handoff',id:String(comment),uri:record.url}],
      evidence,next_gate:{id:'independent-review',role:'independent-reviewer',disposition:'pending',provenance:[]}};
    function fixedChecks() {return selectWorkflow().workflow.verification_commands.map(command=>({command,exit_code:0}));}
  }
}
export async function developToPR(client:AwhClient,options:StageOptions,deps:Partial<DeliveryDependencies> = {}) {
  const result = await executeStage(new CodexExecutorAdapter(client,options,deps));
  if (result.status === 'BLOCKED') return result;
  const output = (kind:string) => result.facts.outputs.find(v => v.kind === kind);
  return {...result,issue:result.contract.work_item.id,pr_url:output('draft-pr')!.uri,head:output('head')!.id,
    evidence_urls:result.facts.evidence.map(e => e.subject.uri),handoff_url:output('confirmed-handoff')!.uri,
    run_id:result.facts.run.id,next_action:'AWAITING_INDEPENDENT_REVIEW' as const};
}
