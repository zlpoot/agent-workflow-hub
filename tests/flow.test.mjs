import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initFlow, readFlow, inspectFlow } from '../dist/workflow/flow.js';
import { developToPR } from '../dist/workflow/codex.js';
import { main } from '../dist/client/cli.js';
import { managedHarness } from './managed-workflow-fixture.mjs';

const declare = h => {initFlow(h.repo,'1,2,3');h.git(['add','.awh/flow.json']);h.git(['commit','-m','Declare queue']);};
const options={title:'Offline queue candidate',body:'SYNTHETIC ONLY; no live GitHub. Closes #1'};
const inspect = (h,advance=true) => inspectFlow(h.client,advance,{connect:h.connect});
test('queue declaration stores only order; malformed, duplicate and credential fields are refused',async t=>{
 const h=await managedHarness(t,{issues:[1,2,3]});declare(h);
 assert.deepEqual(readFlow(h.repo),{schema_version:'1.0',issues:[1,2,3]});
 for(const value of ['','0,1','1,1','1, 2','1,9007199254740992'])assert.throws(()=>initFlow(h.repo,value));
 assert.equal(initFlow(h.repo,'1,2,3').status,'QUEUE_INITIALIZED');assert.throws(()=>initFlow(h.repo,'2,1,3'));
 writeFileSync(join(h.repo,'.awh/flow.json'),JSON.stringify({schema_version:'1.0',issues:[1,2,3],credential:'forbidden'}));assert.throws(()=>readFlow(h.repo));
});
test('offline three Issue simulation: no Merge blocks #2; REQUEST_CHANGES reuses PR; sync advances #1 to #2 to #3 and ends', {timeout:180000},async t=>{
 const h=await managedHarness(t,{issues:[1,2,3]});declare(h);const trace=[];
 const record=async()=>{const r=await inspect(h);trace.push(r);return r;};
 let r=await record();assert.equal(r.status,'READY',JSON.stringify(r));assert.equal(r.issue,1);assert.equal(r.branch,'codex/code-1');
 const first=await developToPR(h.client,options,h.deps);assert.equal(first.next_action,'AWAITING_INDEPENDENT_REVIEW');assert(first.pr_url&&first.head&&first.handoff_url&&first.evidence_urls[0]&&first.run_id);
 const pr=Number(first.facts.outputs[0].id),writes={...h.counts};
 assert.equal((await record()).status,'AWAITING_REVIEW');h.review(pr,'APPROVED',899);assert.equal((await record()).status,'AWAITING_REVIEW');
 assert.equal(h.counts.pr,writes.pr);assert.equal(h.counts.push,writes.push);
 h.review(pr);r=await record();assert.equal(r.status,'REQUEST_CHANGES');assert.equal(r.issue,1);assert.equal(r.review_id,900);assert.equal(r.pr_url,first.pr_url);assert.equal(r.authorization_required.run_id,first.run_id);
 h.commit(10);h.revision(first.run_id,pr,first.head);const revised=await developToPR(h.client,options,h.deps);assert.equal(revised.next_action,'AWAITING_INDEPENDENT_REVIEW');assert.equal(revised.pr_url,first.pr_url);assert.equal(h.counts.pr,1);
 h.review(pr,'APPROVED',901);h.merge(pr);
 assert.equal((await inspect(h,false)).status,'SYNC_REQUIRED');r=await record();assert.equal(r.status,'APPROVAL_REQUIRED');assert.equal(r.request.issue,2);assert.equal(r.request.base_sha,h.git(['rev-parse','main']));assert(r.steps[0].includes('--stages observe,develop,deliver'));
 h.next(2);r=await record();assert.equal(r.status,'READY',JSON.stringify(r));assert.equal(r.issue,2);assert.equal(r.base_sha,h.git(['rev-parse','main']));
 const second=await developToPR(h.client,{...options,body:'Closes #2'},h.deps);assert.equal(second.next_action,'AWAITING_INDEPENDENT_REVIEW');const pr2=Number(second.facts.outputs[0].id);
 assert.equal((await record()).status,'AWAITING_REVIEW');h.review(pr2,'APPROVED',902);h.merge(pr2);r=await record();assert.equal(r.status,'APPROVAL_REQUIRED');assert.equal(r.request.issue,3);
 h.next(3);r=await record();assert.equal(r.status,'READY',JSON.stringify(r));assert.equal(r.issue,3);
 const third=await developToPR(h.client,{...options,body:'Closes #3'},h.deps);assert.equal(third.next_action,'AWAITING_INDEPENDENT_REVIEW');const pr3=Number(third.facts.outputs[0].id);h.review(pr3,'APPROVED',903);h.merge(pr3);
 r=await record();assert.equal(r.status,'QUEUE_COMPLETED',JSON.stringify(r));assert.deepEqual(r.completed,[1,2,3]);assert.equal(h.counts.pr,3);assert.equal(h.counts.push,4);
 const before={...h.counts};assert.equal((await record()).status,'QUEUE_COMPLETED');assert.deepEqual(h.counts,before);
 const folder=join(process.cwd(),'.handoff','flow');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'three-issues.json'),JSON.stringify({live_provider:false,trace},null,2));
});
test('missing independent trust never uses repository declarations for approval or accesses Provider',async t=>{
 const h=await managedHarness(t,{issues:[1,2,3]});declare(h);delete process.env.AWH_ADMIN_TRUST_SHA256;
 const r=await inspect(h);assert.equal(r.status,'APPROVAL_REQUIRED');assert.equal(h.tokens.length,0);assert.equal(h.counts.pr,0);
});
test('project observation reads private/native facts using metadata inspection and a single-repository read token; no writes',async t=>{
 const h=await managedHarness(t,{issues:[1,2,3]});declare(h);h.activate('project-v1');
 const r=await inspect(h);assert.equal(r.status,'READY',JSON.stringify(r));
 const observer=await h.connect({}, {profile:'code',workflow:'develop'},undefined,'queue');
 assert.equal((await observer.readFlowIssue(2)).issue,2);
 await assert.rejects(observer.push());await assert.rejects(observer.createPR('x','x'));await assert.rejects(observer.createComment(7,'x'));
 for(const token of h.tokens){if(!token.repositories)assert.deepEqual(token.permissions,{metadata:'read'});else{assert.deepEqual(token.repositories,['workflow-code']);assert.deepEqual(token.permissions,{contents:'read',issues:'read',pull_requests:'read'});}}
 assert.equal(h.counts.push,0);assert.equal(h.counts.pr,0);
});
test('pending delivery cannot select another Issue; dirty candidate is blocked',async t=>{
 const h=await managedHarness(t,{issues:[1,2,3]});declare(h);writeFileSync(join(h.repo,'code.ts'),'dirty');assert.equal((await inspect(h)).code,'flow_dirty_worktree');h.git(['checkout','--','code.ts']);
 h.cpFault('RUN_STARTED');assert.equal((await developToPR(h.client,options,h.deps)).status,'BLOCKED');assert.equal((await inspect(h)).code,'workflow_pending');assert.equal(h.counts.pr,0);
});
test('uncertain Journal and changed completed native facts block queue continuation',async t=>{
 const h=await managedHarness(t,{issues:[1,2,3]});declare(h);const result=await developToPR(h.client,options,h.deps),pr=Number(result.facts.outputs[0].id);
 h.review(pr,'APPROVED');h.merge(pr);await inspect(h);h.review(pr,'CHANGES_REQUESTED',901);assert.equal((await inspect(h)).code,'flow_closeout_changed');
 const file=h.session().replace('session.json',result.run_id+'.delivery.json'),j=JSON.parse(readFileSync(file));j.refs.pull_request=999;writeFileSync(file,JSON.stringify(j));assert.equal((await inspect(h)).code,'workflow_journal');
});
test('flow CLI has bounded grammar and is discoverable',async()=>{
 assert((await main(['--help'])).commands.includes('flow next'));
 for(const args of [['flow','next'],['flow','init'],['flow','init','--issues','1,2,3','--approve'],['flow','merge']])await assert.rejects(main(args));
});
