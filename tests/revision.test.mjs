import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { replayRun, appendEvent } from '../dist/protocol/index.js';
import { ControlPlaneStore } from '../dist/control-plane/store.js';
import { parseRevisionEvidence, inspectRevision, RevisionReceipt, REVISION_COMMAND } from '../dist/client/revision.js';
import { deliver } from '../dist/client/deliver.js';
import { main } from '../dist/client/cli.js';
import { harness } from './fixtures/revision-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/revision-pr92-history.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const comments = JSON.parse(readFileSync(new URL('./fixtures/revision-pr92-comments.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const current = fixture.tables.runs.at(-1), initial = JSON.parse(current.initial), originalEvents = fixture.tables.events.filter(e => e.run_id === current.id).map(e => JSON.parse(e.record));
const head = fixture.provenance.head, projection = replayRun(initial, originalEvents);
const revision = (previous = initial.source.sha, next = head, seq = 11, previousHandoff = projection.publication.comment.number) => ({
  schema_version: '1.0', kind: 'event', id: 'event-revision-' + seq, run_id: initial.id, sequence: seq,
  occurred_at: '2026-10-09T01:00:00.000Z', type: 'PR_REVISION_LINKED', payload: { schema_version: '1.0', extensions: {}, data: {
    revision_id: 'revision-' + String(seq).padStart(64,'0'), source_sha: initial.source.sha, previous_head: previous, new_head: next,
    base_sha: projection.candidate.base_sha, ref: initial.source.ref, pull_request: structuredClone(projection.candidate.pull_request),
    previous_handoff: { ...projection.publication.comment, number: previousHandoff },
    evidence: { comment: { ...projection.publication.comment, number: 6071713660 }, sha256: 'a'.repeat(64) },
    handoff: { comment: { ...projection.publication.comment, number: 8000 + seq }, sha256: 'b'.repeat(64) }, checks: [{ command: REVISION_COMMAND, exit_code: 0 }],
  } },
});
test('real PR92 original 10 Events replay unchanged; revision chain projects effective SHA without replacing source', () => {
  assert.equal(projection.run.state,'awaiting_review'); assert.equal(projection.effective_candidate_head,initial.source.sha);
  const first = revision(), second = revision(head, 'e'.repeat(40),12,8011), result = replayRun(initial,[...originalEvents,first,second]);
  assert.equal(result.run.source.sha,initial.source.sha); assert.equal(result.run.id,initial.id); assert.equal(result.effective_candidate_head,'e'.repeat(40));
  assert.equal(result.run.state,'awaiting_review'); assert.equal(result.revisions.length,2); assert.deepEqual(result.events.slice(0,10),originalEvents);
  assert.equal(appendEvent(initial,[...originalEvents,first],first).disposition,'idempotent');
});
for (const [name, mutate] of Object.entries({ previous:d=>d.previous_head=head, source:d=>d.source_sha=head, same:d=>d.new_head=initial.source.sha,
  pr:d=>d.pull_request.number++, repository:d=>d.pull_request.repository='zlpoot/webskill', ref:d=>d.ref='codex/awh-task-91', base:d=>d.base_sha=head,
  handoff:d=>d.previous_handoff.number++, reused_comment:d=>d.handoff.comment=d.previous_handoff,
  check:d=>d.checks[0].command='pnpm check', exit:d=>d.checks[0].exit_code=1, extension:d=>d.arbitrary=true }))
  test('revision replay rejects '+name+' mismatch',()=>{const e=revision();mutate(e.payload.data);assert.throws(()=>replayRun(initial,[...originalEvents,e]));});
test('new candidate cannot be reviewed using original SHA or duplicated revision ID',()=>{
  const e=revision(), next=revision(head,'e'.repeat(40),12,8011); next.payload.data.revision_id=e.payload.data.revision_id;
  assert.throws(()=>replayRun(initial,[...originalEvents,e,next]));
  const review={...e,id:'event-review',sequence:12,type:'REVIEW_STARTED',payload:{schema_version:'1.0',extensions:{},data:{pull_request:e.payload.data.pull_request,subject_sha:initial.source.sha,reviewer_executor_id:'github:reviewer'}}};
  assert.throws(()=>replayRun(initial,[...originalEvents,e,review]));review.payload.data.subject_sha=head;
  assert.equal(replayRun(initial,[...originalEvents,e,review]).run.state,'reviewing');
  const late=revision(head,'e'.repeat(40),13,8011);assert.throws(()=>replayRun(initial,[...originalEvents,e,review,late]));
  const failed={...e,type:'RUN_FAILED',payload:{schema_version:'1.0',extensions:{},data:{reason:'fixture'}}};
  assert.throws(()=>replayRun(initial,[...originalEvents,failed,revision(initial.source.sha,head,12)]));
  assert.throws(()=>replayRun(initial,[...originalEvents.slice(0,4),revision(initial.source.sha,head,5)]));
});
test('offline actual 9/52 fixture -> 9/53: CP v2 tables, all old Events and immutable Run identities retained',t=>{
  const dir=mkdtempSync(join(tmpdir(),'awh-revision-history-')),path=join(dir,'fixture.sqlite'),policies=fixture.tables.profiles.map(p=>JSON.parse(p.record));
  const store=new ControlPlaneStore(path,policies), db=new DatabaseSync(path);t.after(()=>{db.close();store.close();rmSync(dir,{recursive:true,force:true})});
  for(const [table,rows] of Object.entries(fixture.tables))for(const row of rows){if(table==='profiles')continue;const keys=Object.keys(row);db.prepare('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));}
  const snap=()=>Object.fromEntries(['projects','executors','executor_clients','work_items','runs','events'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])), before=snap();
  const principal={id:current.client_id,project_ids:[initial.project_id],executor_ids:[initial.executor_id]},e=revision();assert.equal(store.append(principal,initial.id,e).cursor,53);
  const after=snap();assert.equal(after.runs.length,9);assert.equal(after.events.length,53);assert.deepEqual(after.events.slice(0,52),before.events);
  for(const table of ['projects','executors','executor_clients','work_items'])assert.deepEqual(after[table],before[table]);
  for(const row of before.runs){const a=after.runs.find(v=>v.id===row.id);assert.deepEqual({...a,record:row.record},{...row});if(row.id!==initial.id)assert.deepEqual(a,row);}
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);assert.equal(store.append(principal,initial.id,e).disposition,'idempotent');
  for(const row of before.runs)assert.deepEqual(replayRun(JSON.parse(row.initial),before.events.filter(e=>e.run_id===row.id).map(e=>JSON.parse(e.record))).run,JSON.parse(row.record));
});
test('existing real exact-head App evidence can be reused; docs-review Handoff is not the real Run',()=>{
  const evidence=comments.find(c=>c.id===6071713660);assert.equal(parseRevisionEvidence(evidence.body,evidence.actor,head,projection.candidate.base_sha).stdout,'');
  const local=comments.find(c=>c.id===6071714260);assert(local.body.includes('docs-review-d87adfd443a1'));assert(!local.body.includes('"run_id": "'+initial.id+'"'));
  for(const change of [s=>s.replace('"exit_code": 0','"exit_code": 1'),s=>s.replace('"command_runs": 1','"command_runs": 2'),s=>s.replace('Raw stdout: ""','Raw stdout: "forged"'),s=>s.replace('"clean_before": true','"clean_before": false'),s=>s.replaceAll(head,'f'.repeat(40)),s=>s.replace('"actor": "zlpoot-awh-builder[bot]"','"actor": "user"'),s=>s.replace('git diff --check origin/main...HEAD','pnpm check'),s=>s.replace('"node": "v24.21.0"','"node": null')])
    assert.throws(()=>parseRevisionEvidence(change(evidence.body),evidence.actor,head,projection.candidate.base_sha));
});

const windows={timeout:60000,skip:process.platform!=='win32'&&'Windows repeatable policy is fixed; protocol fixtures are portable'};
async function ready(t) {
  const h=await harness(t),route=h.client.request;
  h.client.request=async(c,path,...rest)=>path==='/v1/capabilities'?{revision_linking:'v021-docs-v1',database_version:2,authority_verified:false}:route(c,path,...rest);
  const result=await deliver(h.client,{title:'Fixture 90',body:'Refs #90',holdDraft:true,issue:90},h.deps),original=readFileSync(h.session()),journal=join(dirname(h.session()),result.run_id+'.delivery.json'),journalBytes=readFileSync(journal),oldEvents=h.events(result.run_id);
  let serial=0;const revise=(path='docs/management/awh-repeatable-workflow.md')=>{writeFileSync(join(h.repo,path),'revision '+(++serial)+'\n');h.git(h.repo,['add','.']);h.git(h.repo,['commit','-m','revision']);return h.git(h.repo,['rev-parse','HEAD'])};
  const evidence=()=>{const sha=h.git(h.repo,['rev-parse','HEAD']),data={actor:'zlpoot-awh-builder[bot]',verification:{command:REVISION_COMMAND,command_runs:1,exit_code:0,before_sha:sha,after_sha:sha,base_sha:h.baseline,clean_before:true,clean_after:true,environment:{platform:'win32',arch:'x64',node:'fixture',git:'fixture'},started_at:'2026-10-09T00:00:00.000Z',finished_at:'2026-10-09T00:00:01.000Z',stdout:'',stderr:''}};const id=10000+serial;h.comments.set(id,'Builder evidence — documentation review correction\n```json\n'+JSON.stringify(data)+'\n```\nRaw stdout: ""\nRaw stderr: ""');return id};
  const link=()=>h.client.linkRevision({run:result.run_id,pr:result.pr.number,head:h.git(h.repo,['rev-parse','HEAD']),evidenceComment:evidence()},h.connect);
  const bytes=()=>{assert(original.equals(readFileSync(h.session())));assert(journalBytes.equals(readFileSync(journal)));assert.deepEqual(h.events(result.run_id).slice(0,10),oldEvents)};
  return {...h,result,original,journal,journalBytes,oldEvents,revise,evidence,link,bytes};
}
test('Client single/two revisions preserve original Session/Journal, add one Event each; new-head Sync completes and next Issue archives original bytes',windows,async t=>{
  const h=await ready(t);h.revise();const one=await h.link();h.bytes();assert.equal(one.event.type,'PR_REVISION_LINKED');assert.equal(h.events(h.result.run_id).length,11);
  const oldComments=new Map(h.comments);h.revise();await h.link();h.bytes();assert.equal(h.events(h.result.run_id).length,12);
  for(const [id,body]of oldComments)assert.equal(h.comments.get(id),body);const status=await h.client.status();assert.equal(status.run.source.sha,h.result.task.source_sha);assert.equal(status.revisions.length,2);assert.equal(status.effective_candidate_head,h.git(h.repo,['rev-parse','HEAD']));
  const synced=await h.client.syncDelivery(h.connect);assert.equal(synced.run.state,'completed');h.bytes();h.change(91);await deliver(h.client,{title:'next',body:'Refs #91',holdDraft:true,issue:91},h.deps);
  assert(h.original.equals(readFileSync(join(dirname(h.session()),h.result.run_id+'.json'))));assert(h.journalBytes.equals(readFileSync(h.journal)));assert.equal((await h.client.timeline(h.result.run_id)).run.state,'completed');
  assert.equal(h.counts.push,2);assert.equal(h.counts.pr,2);
});
test('revision ACK loss repeats only identical Event; no new Handoff/Run/PR/push',windows,async t=>{
  const h=await ready(t);h.revise();h.fault('PR_REVISION_LINKED');await assert.rejects(h.link());const count=h.comments.size,connects=h.counts.connect;
  await assert.rejects(h.client.syncDelivery(h.connect));await assert.rejects(h.link());await h.client.retryRevision();h.bytes();
  assert.equal(h.comments.size,count);assert.equal(h.counts.connect,connects);assert.equal(h.events(h.result.run_id).length,11);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
  const attempts=h.attempts.filter(e=>e.type==='PR_REVISION_LINKED');assert.deepEqual(attempts[0],attempts[1]);await assert.rejects(h.client.retryRevision());
});
for(const [name,setup]of Object.entries({dirty:h=>writeFileSync(join(h.repo,'docs/management/awh-repeatable-workflow.md'),'dirty'),same:()=>{},code:h=>h.revise('.gitignore'),
  wrong_base:h=>{h.revise();const read=h.builder.readPR;h.builder.readPR=async n=>({...await read(n),base:'f'.repeat(40)})},
  not_draft:h=>{h.revise();const read=h.builder.readPR;h.builder.readPR=async n=>({...await read(n),draft:false})},
  wrong_head:h=>{h.revise();const read=h.builder.readPR;h.builder.readPR=async n=>({...await read(n),head:'f'.repeat(40)})},
  wrong_actor:h=>{h.revise();const read=h.builder.readPR;h.builder.readPR=async n=>({...await read(n),actor:'other[bot]'})},
  old_cp:h=>{h.revise();h.client.request=async()=>({})},
  completed:async h=>{await h.client.syncDelivery(h.connect);h.revise()},
  missing_handoff:h=>{h.revise();const id=JSON.parse(readFileSync(h.journal)).refs.handoff_comment;h.comments.set(id,comments.find(c=>c.id===6071714260).body)},
  delete:h=>{h.git(h.repo,['rm','docs/management/awh-repeatable-workflow.md']);h.git(h.repo,['commit','-m','delete'])},
  rename:h=>{h.git(h.repo,['mv','docs/management/awh-repeatable-workflow.md','docs/management/awh-v01-acceptance.md']);h.git(h.repo,['commit','-m','rename'])},
  branch:h=>{h.revise();h.git(h.repo,['switch','-c','codex/awh-task-91'])} }))
  test('Client refuses '+name+' before lifecycle linkage',windows,async t=>{const h=await ready(t);await setup(h);const count=h.comments.size;await assert.rejects(h.link());assert.equal(h.comments.size,count+1);assert.equal(h.events(h.result.run_id).filter(e=>e.type==='PR_REVISION_LINKED').length,0);});
test('uncertain Handoff publication is a consumed receipt and cannot be repeated or bypassed by retry/start',windows,async t=>{
  const h=await ready(t);h.revise();const create=h.builder.createComment;h.builder.createComment=async(...args)=>{await create(...args);throw Error('unknown publication')};await assert.rejects(h.link());const count=h.comments.size;
  await assert.rejects(h.link());await assert.rejects(h.client.retryRevision());await assert.rejects(h.client.start(91));assert.equal(h.comments.size,count);h.bytes();
});
test('original Session/Journal modification after linking invalidates overlay; stale review cannot complete revised candidate',windows,async t=>{
  const h=await ready(t);h.revise();await h.link();const lifecycle=h.builder.readLifecycle;h.builder.readLifecycle=async(...args)=>({...await lifecycle(...args),review:{id:1,login:'reviewer',subject_sha:h.result.task.source_sha}});
  await assert.rejects(h.client.syncDelivery(h.connect));h.bytes();writeFileSync(h.journal,Buffer.concat([h.journalBytes,Buffer.from(' ')]));await assert.rejects(h.client.status());
});
test('both diffs are required: an unchanged out-of-scope ancestor change blocks the otherwise docs-only last step',windows,async t=>{
  const h=await ready(t);const original=h.git(h.repo,['rev-parse','HEAD']),previous=h.revise('.gitignore'),next=h.revise();
  assert.throws(()=>inspectRevision(h.repo,original,previous,next,h.baseline,['docs/management/awh-repeatable-workflow.md']),/allowlisted/);
  assert.throws(()=>inspectRevision(h.repo,next,previous,original,h.baseline,['docs/management/awh-repeatable-workflow.md']));
});
test('copy detection and source identity drift fail before publication',windows,async t=>{
  const h=await ready(t);writeFileSync(join(h.repo,'docs/management/awh-v01-acceptance.md'),readFileSync(join(h.repo,'docs/management/awh-repeatable-workflow.md')));h.git(h.repo,['add','.']);h.git(h.repo,['commit','-m','copy']);
  await assert.rejects(h.link(),/allowlisted/);
  const s=JSON.parse(h.original);s.task_binding.issue=91;writeFileSync(h.session(),JSON.stringify(s));await assert.rejects(h.link());
});
test('post-publication remote ref drift and unconfirmed Handoff stop without an Event or provider replay',windows,async t=>{
  const h=await ready(t);h.revise();let reads=0;const read=h.builder.readRevisionRef;h.builder.readRevisionRef=async()=>++reads>=4?'f'.repeat(40):read();
  await assert.rejects(h.link());const count=h.comments.size;await assert.rejects(h.client.retryRevision());await assert.rejects(h.link());
  assert.equal(h.comments.size,count);assert.equal(h.events(h.result.run_id).length,10);h.bytes();
});
test('pending Handoff never links and interrupted confirmation cannot be retried',windows,async t=>{
  const h=await ready(t);h.revise();h.builder.editComment=async()=>({});await assert.rejects(h.link(),/Confirmed Handoff readback/);
  const count=h.comments.size;await assert.rejects(h.client.retryRevision());await assert.rejects(h.link());assert.equal(h.comments.size,count);h.bytes();
});
test('receipt corruption is not repaired by retry; original state stays untouched',windows,async t=>{
  const h=await ready(t);h.revise();h.fault('PR_REVISION_LINKED');await assert.rejects(h.link());
  const dir=dirname(h.session()),file=readdirSync(dir).find(n=>n.endsWith('.revision.0.json'));writeFileSync(join(dir,file),Buffer.concat([readFileSync(join(dir,file)),Buffer.from(' ')]));
  await assert.rejects(h.client.retryRevision());assert(h.original.equals(readFileSync(h.session())));assert(h.journalBytes.equals(readFileSync(h.journal)));
});
test('revision Sync requires effective native approval and uses sidecar for lost completion ACK',windows,async t=>{
  const h=await ready(t);h.revise();await h.link();const read=h.builder.readLifecycle;
  for(const patch of [{review:null},{changes_requested:true}]){h.builder.readLifecycle=async(...a)=>({...await read(...a),...patch});assert.equal((await h.client.syncDelivery(h.connect)).run.state,'awaiting_review');}
  h.builder.readLifecycle=read;h.fault('RUN_COMPLETED');await assert.rejects(h.client.syncDelivery(h.connect));await h.client.retryDelivery();assert.equal((await h.client.syncDelivery(h.connect)).run.state,'completed');h.bytes();
});
test('CLI rejects generic revision injection, arbitrary URL/repo and incomplete/mixed retry options',async()=>{
  for(const args of [['link-revision','--repo','zlpoot/future-ui'],['link-revision','--retry','--head',head],['event','--type','PR_REVISION_LINKED','--data','unused'],['link-revision','--head',head]])
    await assert.rejects(main(['--config','unused',...args]));
});
test('CP-declared revision copied into original Session cannot bypass missing receipt/sidecar',windows,async t=>{
  const h=await ready(t);h.revise();const s=JSON.parse(h.original),p=replayRun(s.initial,s.events),e=revision();
  e.run_id=s.initial.id;e.occurred_at=new Date().toISOString();Object.assign(e.payload.data,{source_sha:s.initial.source.sha,previous_head:p.effective_candidate_head,
    new_head:h.git(h.repo,['rev-parse','HEAD']),base_sha:p.candidate.base_sha,ref:s.initial.source.ref,pull_request:p.candidate.pull_request,
    previous_handoff:p.publication.comment,evidence:{comment:{...p.publication.comment,number:90001},sha256:'a'.repeat(64)},handoff:{comment:{...p.publication.comment,number:90002},sha256:'b'.repeat(64)}});
  h.store.append(h.principal,s.initial.id,e);s.events.push(e);writeFileSync(h.session(),JSON.stringify(s));
  const connects=h.counts.connect;await assert.rejects(h.client.syncDelivery(h.connect),/receipt and sidecar/);await assert.rejects(h.client.status(),/receipt and sidecar/);
  assert.equal(h.counts.connect,connects);assert(h.journalBytes.equals(readFileSync(h.journal)));
});
