import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,readdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {developToPR,prepareCodexStage,CodexExecutorAdapter} from '../dist/workflow/codex.js';
import {executeStage} from '../dist/workflow/contract.js';
import {managedHarness} from './managed-workflow-fixture.mjs';
import {connectBuilder} from '../dist/builder.js';
import {main} from '../dist/client/cli.js';
const options={title:'Synthetic code candidate',body:'Synthetic Provider only. Refs #90'};
const published=r=>{assert.equal(r.status,'awaiting_review',JSON.stringify(r));assert.equal(r.facts.next_gate.disposition,'pending');return{run:r.facts.run.id,pr:Number(r.facts.outputs[0].id),head:r.facts.outputs[1].id};};
const writes=h=>({...h.counts});
test('generic envelope works with a non-code source and a non-Codex Executor; missing facts cannot claim success',async()=>{
 const contract={contract_version:'1.0',workflow:'document-review',stage:'draft',project:{source:'documents',kind:'project',id:'x'},work_item:{source:'documents',kind:'work',id:'y'},executor:{source:'executor',kind:'model',id:'doubao'},machine:{source:'machine',kind:'host',id:'m'},authorization:{source:'administrator',subject:{source:'administrator',kind:'grant',id:'g'}},inputs:[],next_gate:{id:'review',role:'human',disposition:'pending',provenance:[]}};
 const facts={run:{source:'cp',kind:'run',id:'r'},events:[{source:'cp',kind:'event',id:'e'}],outputs:[{source:'documents',kind:'draft',id:'d'}],evidence:[contract.authorization],next_gate:contract.next_gate};
 const adapter={preflight:async()=>contract,execute:async()=>{},postcondition:async()=>facts};assert.equal((await executeStage(adapter)).status,'awaiting_review');
 for(const key of ['events','outputs','evidence'])assert.equal((await executeStage({...adapter,postcondition:async()=>({...facts,[key]:[]})})).status,'BLOCKED');
});
test('managed general code delivers once, revisions update the same PR and append history, native Review/Merge reconcile, then second Issue', {timeout:180000},async t=>{
 const h=await managedHarness(t),prepared=prepareCodexStage(h.repo);assert.equal(prepared.stage,'develop');assert(!JSON.stringify(prepared).includes('TRUST_FILE'));
 const first=published(await developToPR(h.client,options,h.deps));
 const before=writes(h);published(await developToPR(h.client,options,h.deps));assert.deepEqual(writes(h),before);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
 h.review(first.pr,'APPROVED',899);assert.equal((await h.client.syncDelivery(h.connect)).run.state,'review_passed');
 h.review(first.pr);const refused=await h.client.syncDelivery(h.connect);assert.equal(refused.observation.changes_requested,true);
 const oldSession=readFileSync(h.session()),journal=join(dirname(h.session()),first.run+'.delivery.json'),oldJournal=readFileSync(journal),oldEvents=h.events(first.run),oldComments=new Map([...h.comments].map(([id,c])=>[id,c.body]));
 h.commit(2);h.revision(first.run,first.pr,first.head);assert.equal(prepareCodexStage(h.repo).stage,'revise');
 const revised=published(await developToPR(h.client,options,h.deps));assert.equal(revised.pr,first.pr);assert.equal(revised.run,first.run);assert.notEqual(revised.head,first.head);
 assert.deepEqual(readFileSync(h.session()),oldSession);assert.deepEqual(readFileSync(journal),oldJournal);assert.deepEqual(h.events(first.run).slice(0,oldEvents.length),oldEvents);
 for(const[id,body]of oldComments)assert.equal(h.comments.get(id).body,body);
 assert.equal(h.events(first.run).at(-1).type,'PR_REVISION_LINKED');assert.equal(h.counts.pr,1);assert.equal(h.counts.push,2);
 assert(h.transports.filter(a=>a.includes('push')&&!a.includes('--dry-run')).at(-1).includes('--force-with-lease=refs/heads/codex/code-90:'+first.head));
 const writeTokens=h.tokens.filter(v=>Object.values(v.permissions).includes('write'));assert(writeTokens.length);for(const token of writeTokens){assert.deepEqual(token.repositories,['workflow-code']);assert.deepEqual(Object.keys(token.permissions),[token.permissions.contents==='write'?'contents':'pull_requests']);}
 assert(h.tokens.some(v=>!v.repositories&&JSON.stringify(v.permissions)==='{"metadata":"read"}'));
 h.review(first.pr,'APPROVED',901);assert.equal((await h.client.syncDelivery(h.connect)).run.state,'review_passed');h.merge(first.pr);assert.equal((await h.client.syncDelivery(h.connect)).run.state,'completed');
 assert.deepEqual(readFileSync(h.session()),oldSession);assert.deepEqual(readFileSync(journal),oldJournal);
 h.next();const second=published(await developToPR(h.client,options,h.deps));assert.notEqual(second.run,first.run);assert.notEqual(second.pr,first.pr);
 assert.equal(h.counts.push,3);assert.equal(h.counts.pr,2);assert.deepEqual(readFileSync(join(dirname(h.session()),first.run+'.json')),oldSession);assert.deepEqual(readFileSync(journal),oldJournal);
});
test('same repository two separately approved Issues execute consecutively after real CP/native fake closeout', {timeout:180000},async t=>{
 const h=await managedHarness(t),first=published(await developToPR(h.client,options,h.deps));h.review(first.pr,'APPROVED',901);
 h.merge(first.pr);await h.client.syncDelivery(h.connect);h.next();
 published(await developToPR(h.client,options,h.deps));assert.equal(h.counts.pr,2);
});
test('missing independent pin and wrong Executor stop before Provider or verification',async t=>{
 const h=await managedHarness(t),pin=process.env.AWH_ADMIN_TRUST_SHA256;delete process.env.AWH_ADMIN_TRUST_SHA256;assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.equal(h.counts.push,0);assert.equal(h.tokens.length,0);
 process.env.AWH_ADMIN_TRUST_SHA256=pin;process.env.AWH_ADMIN_EXECUTOR_ID='wrong';assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.equal(h.tokens.length,0);
});
test('old CP capabilities block before any Provider connection or write',async t=>{
 const h=await managedHarness(t),request=h.client.request;h.client.request=async(...args)=>args[1]==='/v1/workflow-capabilities'?{develop_to_pr:'old'}:request(...args);
 const result=await developToPR(h.client,options,h.deps);assert.equal(result.status,'BLOCKED');assert.equal(result.code,'workflow_upgrade');assert.equal(h.tokens.length,0);
});
test('validation failure is retained and cannot be replayed as a new delivery',async t=>{
 const h=await managedHarness(t);h.failVerify();assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.equal(h.counts.push,0);assert.equal(h.counts.pr,0);const n=h.counts.verify;
 assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.equal(h.counts.verify,n);const s=JSON.parse(readFileSync(h.session()));assert.equal(h.events(s.initial.id).at(-1).type,'VERIFICATION_FAILED');
});
test('managed pre-provider verification recovery qualifies a new commit and preserves the failed Run',{timeout:180000},async t=>{
 const h=await managedHarness(t);h.failVerify();assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');
 const bytes=readFileSync(h.session()),old=JSON.parse(bytes).initial.id,journal=join(dirname(h.session()),old+'.delivery.json'),oldJournal=readFileSync(journal);
 h.passVerify();h.commit(2);const result=published(await developToPR(h.client,options,h.deps));assert.notEqual(result.run,old);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
 assert.deepEqual(readFileSync(join(dirname(h.session()),old+'.json')),bytes);assert.deepEqual(readFileSync(journal),oldJournal);assert.equal((await h.client.timeline(old)).run.state,'failed');
});
for (const lostAck of [false,true]) test('fixed HEAD failure recovers only through an exact new independently approved version'+(lostAck?' with lost successor ACK':''),{timeout:180000},async t=>{
 const h=await managedHarness(t,{fixedHead:true}),large={...h.deps,verify:async command=>({command,exit_code:1,stdout:'Synthetic failure '.repeat(1500),stderr:'synthetic toolchain incomplete',elapsed_ms:1})};
 const failed=await developToPR(h.client,options,large);assert.equal(failed.code,'stage_verification_failed');assert.equal(h.counts.push,0);
 const bytes=readFileSync(h.session()),old=JSON.parse(bytes).initial.id,journal=join(dirname(h.session()),old+'.delivery.json'),oldJournal=readFileSync(journal),events=h.events(old);
 const evidence=join(h.repo,'.handoff',old,'verification.json'),oldEvidence=readFileSync(evidence);assert(oldEvidence.length>16*1024);
 const head=h.commit(2),recovery={original_version:'task-90',run_id:old,previous_head:h.task.head_sha};
 assert.throws(()=>h.grant('same-head-refused',{...h.task,verification_recovery:recovery}),/verification_recovery_scope/);
 assert.throws(()=>h.grant('wrong-original-refused',{...h.task,head_sha:head,verification_recovery:{...recovery,previous_head:'f'.repeat(40)}}),/verification_recovery_original/);
 h.grant('task-90-recovery',{...h.task,head_sha:head,verification_recovery:recovery});h.selectVersion('task-90-recovery');
 if(lostAck){h.cpFault('RUN_STARTED');assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.equal(h.counts.push,0);}
 const result=published(await developToPR(h.client,options,h.deps));assert.notEqual(result.run,old);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
 assert.deepEqual(readFileSync(join(dirname(h.session()),old+'.json')),bytes);assert.deepEqual(readFileSync(journal),oldJournal);assert.deepEqual(readFileSync(evidence),oldEvidence);assert.deepEqual(h.events(old),events);
 const timeline=await h.client.timeline();assert.equal(timeline.run.profile.version,'task-90-recovery');assert.equal(timeline.events[0].event.payload.extensions.verification_recovery.predecessor_run_id,old);
 const before=writes(h);published(await developToPR(h.client,options,h.deps));assert.deepEqual(writes(h),before);
});
for(const grant of ['missing-recovery','wrong-run'])test('fixed HEAD failure rejects '+grant+' successor before Provider writes',async t=>{
 const h=await managedHarness(t,{fixedHead:true});h.failVerify();assert.equal((await developToPR(h.client,options,h.deps)).code,'stage_verification_failed');
 const bytes=readFileSync(h.session()),head=h.commit(2);
 h.grant('task-90-recovery',{...h.task,head_sha:head,...(grant==='wrong-run'?{verification_recovery:{original_version:'task-90',run_id:'run-'+ '0'.repeat(8)+'-'+ '0'.repeat(4)+'-'+ '0'.repeat(4)+'-'+ '0'.repeat(4)+'-'+ '0'.repeat(12),previous_head:h.task.head_sha}}:{})});h.selectVersion('task-90-recovery');h.passVerify();
 assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.equal(h.counts.push,0);assert.equal(h.counts.pr,0);assert.deepEqual(readFileSync(h.session()),bytes);
});
test('initial PR ACK loss preserves uncertain Journal; repeating stage never replays Provider writes',async t=>{
 const h=await managedHarness(t);h.fault('pr');assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');const before=writes(h);
 assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.deepEqual(writes(h),before);assert.equal(h.prs.size,1);
});
test('initial CP RUN_STARTED ACK loss resumes the same stage without a second Run or Provider delivery',{timeout:180000},async t=>{
 const h=await managedHarness(t);h.cpFault('RUN_STARTED');assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');
 const s=JSON.parse(readFileSync(h.session())),result=published(await developToPR(h.client,options,h.deps));assert.equal(result.run,s.initial.id);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
 const attempts=h.attempts.filter(e=>e.type==='RUN_STARTED');assert.deepEqual(attempts[0],attempts[1]);
});
for(const fault of ['push','evidence'])test('revision '+fault+' ACK loss recovers via observations without repeating writes',{timeout:180000},async t=>{
 const h=await managedHarness(t),first=published(await developToPR(h.client,options,h.deps));h.review(first.pr);h.commit(2);h.revision(first.run,first.pr,first.head);h.fault(fault);
 assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');const pushes=h.counts.push,comments=h.counts.comment;
 published(await developToPR(h.client,options,h.deps));assert.equal(h.counts.push,pushes);if(fault==='evidence')assert.equal(h.counts.comment,comments+1);assert.equal(h.counts.pr,1);
});
test('revision CP ACK loss repeats only original Event, keeps Provider and initial audit unchanged',{timeout:180000},async t=>{
 const h=await managedHarness(t),first=published(await developToPR(h.client,options,h.deps)),bytes=readFileSync(h.session());h.review(first.pr);h.commit(2);h.revision(first.run,first.pr,first.head);h.cpFault('PR_REVISION_LINKED');
 assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');const before=writes(h);published(await developToPR(h.client,options,h.deps));assert.deepEqual(writes(h),before);assert.deepEqual(readFileSync(h.session()),bytes);
 const attempts=h.attempts.filter(e=>e.type==='PR_REVISION_LINKED');assert.deepEqual(attempts[0],attempts[1]);
});
test('revision requires native exact-head REQUEST_CHANGES; normal managed repeat Push protection survives',{timeout:180000},async t=>{
 const h=await managedHarness(t),first=published(await developToPR(h.client,options,h.deps)),builder=await h.connect({cwd:()=>h.repo});const writesBefore=h.tokens.filter(v=>Object.values(v.permissions).includes('write')).length;
 await assert.rejects(builder.push(),/consumed/);assert.equal(h.tokens.filter(v=>Object.values(v.permissions).includes('write')).length,writesBefore);
 h.commit(2);h.revision(first.run,first.pr,first.head);assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
});
test('postcondition fails closed on missing Journal, missing Evidence or stale Handoff',{timeout:180000},async t=>{
 const h=await managedHarness(t),first=published(await developToPR(h.client,options,h.deps)),adapter=new CodexExecutorAdapter(h.client,options,h.deps),contract=await adapter.preflight();
 const id=[...h.comments].find(([_,v])=>v.body.startsWith('Builder evidence'))[0],body=h.comments.get(id).body;h.comments.get(id).body='missing';await assert.rejects(adapter.postcondition(contract));h.comments.get(id).body=body;
 const journal=join(dirname(h.session()),first.run+'.delivery.json'),bytes=readFileSync(journal);unlinkSync(journal);await assert.rejects(adapter.postcondition(contract));writeFileSync(journal,bytes);
 const handoff=[...h.comments].find(([_,v])=>v.body.startsWith('AWH-HANDOFF'))[1];handoff.body=handoff.body.replaceAll(first.head,'0'.repeat(40));await assert.rejects(adapter.postcondition(contract));
});
test('stage CLI accepts only the controlled command grammar',async()=>{for(const args of [['stage','execute'],['stage','prepare','--approve'],['stage','merge']])await assert.rejects(main(args));});

const providerWrites=h=>Object.fromEntries(Object.entries(h.counts).filter(([k])=>k!=='verify'));
async function cacheRevision(t) {
 const h=await managedHarness(t),first=published(await developToPR(h.client,options,h.deps));
 h.review(first.pr);const head=h.commit(2);h.revision(first.run,first.pr,first.head);
 const directory=join(h.repo,'.handoff','stages','revision-90');mkdirSync(directory,{recursive:true});
 const cache=join(directory,'verification.json'),forged={actor:'',base_sha:h.task.base_sha,before_sha:head,after_sha:head,clean_before:true,clean_after:true,
  environment:{platform:process.platform,arch:process.arch,node:process.version},started_at:'2026-01-01T00:00:00.000Z',finished_at:'2026-01-01T00:00:00.001Z',
  logs:['pnpm typecheck','pnpm build'].map(command=>({command,exit_code:0,stdout:'FORGED SUCCESS CACHE',stderr:'',elapsed_ms:1}))};
 return{h,first,directory,cache,forged};
}

test('revision rejects forged successful verification cache when the real verifier fails',{timeout:180000},async t=>{
 const {h,first,directory,cache,forged}=await cacheRevision(t);writeFileSync(cache,JSON.stringify(forged));const bytes=readFileSync(cache),events=h.events(first.run),before=providerWrites(h),calls=h.counts.verify;
 const session=readFileSync(h.session()),journal=join(dirname(h.session()),first.run+'.delivery.json'),journalBytes=readFileSync(journal);
 h.failVerify();const result=await developToPR(h.client,options,h.deps);
 assert.equal(result.status,'BLOCKED');assert.equal(result.code,'verification');assert.equal(h.counts.verify,calls+1);
 assert.deepEqual(providerWrites(h),before);assert.deepEqual(h.events(first.run),events);assert.deepEqual(readFileSync(cache),bytes);
 assert.deepEqual(readFileSync(h.session()),session);assert.deepEqual(readFileSync(journal),journalBytes);
 const attempt=readdirSync(directory).find(n=>n.startsWith('verification-attempt-'));assert.equal(JSON.parse(readFileSync(join(directory,attempt))).outcome,'fail');
});

test('revision publishes fresh executed results despite a correctly shaped forged success cache',{timeout:180000},async t=>{
 const {h,cache,forged}=await cacheRevision(t);writeFileSync(cache,JSON.stringify(forged));const bytes=readFileSync(cache),calls=h.counts.verify;
 published(await developToPR(h.client,options,h.deps));assert.equal(h.counts.verify,calls+2);assert.deepEqual(readFileSync(cache),bytes);
 const evidence=[...h.comments.values()].filter(v=>v.body.startsWith('Builder evidence')).at(-1).body;
 assert(!evidence.includes('FORGED SUCCESS CACHE'));assert(evidence.includes('SYNTHETIC verifier only'));
});

for(const fault of ['push','evidence'])test('revision '+fault+' interruption rejects tampered cache then resumes with real checks and original audit',{timeout:180000},async t=>{
 const {h,first,directory,cache,forged}=await cacheRevision(t),session=readFileSync(h.session()),journal=join(dirname(h.session()),first.run+'.delivery.json'),journalBytes=readFileSync(journal),initialEvents=h.events(first.run);
 h.fault(fault);assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');
 const oldAttempt=readdirSync(directory).find(n=>n.startsWith('verification-attempt-')),oldBytes=readFileSync(join(directory,oldAttempt)),intent=readFileSync(join(directory,'push-intent.json'));
 const interruptedComments=new Map([...h.comments].map(([id,v])=>[id,v.body]));writeFileSync(cache,JSON.stringify(forged));const cacheBytes=readFileSync(cache),before=providerWrites(h),calls=h.counts.verify;
 h.failVerify();assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.equal(h.counts.verify,calls+1);
 assert.deepEqual(providerWrites(h),before);assert.deepEqual(h.events(first.run),initialEvents);
 h.passVerify();const resumeCalls=h.counts.verify,result=published(await developToPR(h.client,options,h.deps));assert.equal(result.run,first.run);assert.equal(result.pr,first.pr);assert.equal(h.counts.verify,resumeCalls+2);
 assert.equal(h.counts.push,before.push);assert.equal(h.counts.pr,1);assert.equal(h.counts.comment,before.comment+(fault==='evidence'?1:2));
 for(const[id,body]of interruptedComments)assert.equal(h.comments.get(id).body,body);
 assert.deepEqual(readFileSync(cache),cacheBytes);assert.deepEqual(readFileSync(join(directory,oldAttempt)),oldBytes);assert.deepEqual(readFileSync(join(directory,'push-intent.json')),intent);
 assert.deepEqual(readFileSync(h.session()),session);assert.deepEqual(readFileSync(journal),journalBytes);assert.deepEqual(h.events(first.run).slice(0,initialEvents.length),initialEvents);assert.equal(h.events(first.run).at(-1).type,'PR_REVISION_LINKED');
});

test('revision checks the clean exact HEAD after each actual command before any Provider write',{timeout:180000},async t=>{
 const {h,first}=await cacheRevision(t),before=providerWrites(h),deps={...h.deps,verify:async command=>{const log=await h.deps.verify(command);writeFileSync(join(h.repo,'code.ts'),'changed during verification\n');return log;}};
 const result=await developToPR(h.client,options,deps);assert.equal(result.status,'BLOCKED');assert.equal(result.code,'exact_head');assert.deepEqual(providerWrites(h),before);assert(!h.events(first.run).some(e=>e.type==='PR_REVISION_LINKED'));
});
