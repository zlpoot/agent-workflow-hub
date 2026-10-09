import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ControlPlaneStore } from '../dist/control-plane/store.js';
import { replayRun } from '../dist/protocol/index.js';
import { deliver } from '../dist/client/deliver.js';
import { RevisionReceipt, REVISION_COMMAND, digest } from '../dist/client/revision.js';
import { publicationBodies, publicationObservation, publicationScope, parsePublicationAuthorization } from '../dist/client/publication.js';
import { harness } from './fixtures/revision-harness.mjs';
import { main } from '../dist/client/cli.js';

const windows={timeout:60000,skip:process.platform!=='win32'&&'Original Windows policy'};
test('publication CLI is closed; typed Builder diagnostics survive real executable error handling',async()=>{
 for(const args of [['reconcile-publication'],['resume-publication','--revision','revision-'+'a'.repeat(64)],['resume-publication','--retry'],['reconcile-publication','--revision','revision-'+'a'.repeat(64),'--repo','other/repo'],['resume-publication','--revision','revision-'+'a'.repeat(64),'--authorization-comment','0']])await assert.rejects(main(['--config','ignored',...args]),e=>e.code==='arguments');
 const cli=fileURLToPath(new URL('../dist/client/cli.js',import.meta.url)),code=`import{AwhClient}from${JSON.stringify(new URL('../dist/client/client.js',import.meta.url).href)};import{BuilderError}from${JSON.stringify(new URL('../dist/builder.js',import.meta.url).href)};AwhClient.prototype.reconcilePublication=async()=>{throw new BuilderError('sensitive raw body',undefined,undefined,undefined,{stage:'revision.comment-post',category:'permission_or_policy',http_status:403,github_request_id:'ABC:123'});};process.argv=['node',${JSON.stringify(cli)},'--config','ignored','reconcile-publication','revision'];process.argv[5]='--revision';process.argv.push('revision-'+'a'.repeat(64));await import(${JSON.stringify(new URL('../dist/client/cli.js',import.meta.url).href)});`;
 const r=spawnSync(process.execPath,['--input-type=module','--eval',code],{encoding:'utf8',windowsHide:true,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(AWH_|GH_|GITHUB_|NODE_OPTIONS$)/i.test(k)))});
 assert.equal(r.status,2);assert.equal(r.stdout,'');assert.deepEqual(JSON.parse(r.stderr),{error:{code:'github_revision',message:'Revision GitHub operation failed',diagnostic:{stage:'revision.comment-post',category:'permission_or_policy',http_status:403,github_request_id:'ABC:123'}},authority_verified:false});
});
test('original PR92 phase 0/1 bytes reconcile offline against actual 9/52 history; controlled publication links same ID at cursor 53',t=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/revision-pr92-history.json',import.meta.url),'utf8').replace(/^\uFEFF/,'')),frozen=JSON.parse(readFileSync(new URL('./fixtures/publication-pr92-phases.json',import.meta.url),'utf8'));
 const directory=mkdtempSync(join(tmpdir(),'awh-publication-history-')),receipt=new RevisionReceipt(directory,frozen.provenance.revision_id);
 const path=join(directory,'fixture.sqlite'),store=new ControlPlaneStore(path,fixture.tables.profiles.map(p=>JSON.parse(p.record))),db=new DatabaseSync(path);t.after(()=>{db.close();store.close();rmSync(directory,{recursive:true,force:true});});
 frozen.bytes.forEach((body,i)=>{assert.equal(digest(body),frozen.provenance.sha256[i]);writeFileSync(receipt.file(i),body,{flag:'wx'});});
 const phases=receipt.phases(),p=phases[0].value,bodies=publicationBodies(p,phases[1].value.body),row=fixture.tables.runs.find(r=>r.id===p.run_id),initial=JSON.parse(row.initial),events=fixture.tables.events.filter(e=>e.run_id===p.run_id).map(e=>JSON.parse(e.record)),projection=replayRun(initial,events);
 assert.equal(p.cp_events_sha256,digest(JSON.stringify(events)));assert.equal(p.source_sha,initial.source.sha);assert.equal(p.previous_head,projection.effective_candidate_head);assert.equal(p.new_head,fixture.provenance.head);assert.equal(p.pull_request.number,92);
 const comments=JSON.parse(readFileSync(new URL('./fixtures/revision-pr92-comments.json',import.meta.url),'utf8').replace(/^\uFEFF/,'' )).map(c=>({...c,actor_type:'Bot'}));
 const docs=comments.find(c=>c.id===6071714260);assert(docs.body.includes(p.run_id)&&docs.body.includes(p.new_head));assert(!docs.body.includes(p.revision_id));
 const observation=publicationObservation(p,bodies,comments),oldBody=comments.find(c=>c.id===p.previous_handoff.number).body,scope=publicationScope(receipt,p,'a'.repeat(64),oldBody,observation);
 assert.equal(observation.kind,'negative_observation');assert.equal(observation.first_post_not_submitted_proven,false);
 assert.throws(()=>parsePublicationAuthorization('',scope));
 assert.equal(observation.automatic_repost_authorized,false);assert.equal(receipt.phases().length,2);
 const a={schema_version:'1.0',kind:'revision_publication_resume',decision:'authorize_once',revision_id:receipt.id,run_id:p.run_id,pr:92,new_head:p.new_head,scope_sha256:digest(JSON.stringify(scope)),action:'post_once',comment_id:null,ambiguity_decision:'accept_bounded_duplicate_risk'};
 assert.equal(parsePublicationAuthorization('AWH-PUBLICATION-RESUME v0.2.1-R1\n```json\n'+JSON.stringify(a)+'\n```',scope).action,'post_once');
 for(const [table,rows]of Object.entries(fixture.tables))for(const row of rows){if(table==='profiles')continue;const keys=Object.keys(row);db.prepare('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));}
 const snapshot=()=>Object.fromEntries(Object.keys(fixture.tables).map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])),before=snapshot();let posts=0,patches=0;const comment={id:800001,actor:p.actor,actor_type:'Bot',body:bodies.pending};posts++;
 receipt.append({stage:'pending_handoff_created',comment,body:bodies.pending});receipt.append({stage:'confirming_handoff',comment_id:comment.id,body:bodies.confirmed});comment.body=bodies.confirmed;patches++;
 assert.equal(publicationObservation(p,bodies,[comment]).publication,'confirmed');
 const event={schema_version:'1.0',kind:'event',id:'event-offline-publication-recovery',run_id:p.run_id,sequence:11,occurred_at:'2026-10-09T03:00:00.000Z',type:'PR_REVISION_LINKED',payload:{schema_version:'1.0',extensions:{},data:{revision_id:receipt.id,source_sha:p.source_sha,previous_head:p.previous_head,new_head:p.new_head,base_sha:p.base_sha,ref:p.task.branch,pull_request:p.pull_request,previous_handoff:p.previous_handoff,evidence:p.evidence,handoff:{comment:{provider:'github',repository:p.task.repository,kind:'issue_comment',number:comment.id},sha256:digest(comment.body)},checks:bodies.handoff.verification.checks}}};
 receipt.append({stage:'event_ready',event,event_sha256:digest(JSON.stringify(event)),handoff_body:comment.body});const principal={id:row.client_id,project_ids:[initial.project_id],executor_ids:[initial.executor_id]},ack=store.append(principal,p.run_id,event);assert.equal(ack.cursor,53);receipt.append({stage:'acknowledged',event_id:event.id,ack});
 const after=snapshot();assert.equal(after.runs.length,9);assert.equal(after.events.length,53);assert.deepEqual(after.events.slice(0,52),before.events);
 for(const [table,rows]of Object.entries(before)){if(table==='events')continue;if(table==='runs'){for(const r of rows){const next=after.runs.find(x=>x.id===r.id);assert.equal(next.initial,r.initial);if(r.id!==p.run_id)assert.deepEqual(next,r);}}else assert.deepEqual(after[table],rows);}
 frozen.bytes.forEach((body,i)=>assert.equal(readFileSync(receipt.file(i),'utf8'),body));assert.equal(posts,1);assert.equal(patches,1);assert.equal(store.append(principal,p.run_id,event).disposition,'idempotent');assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);
});
function realPublication() {
 const frozen=JSON.parse(readFileSync(new URL('./fixtures/publication-pr92-phases.json',import.meta.url),'utf8'));
 const p=JSON.parse(frozen.bytes[0]).value,bodies=publicationBodies(p,JSON.parse(frozen.bytes[1]).value.body);
 const comments=JSON.parse(readFileSync(new URL('./fixtures/revision-pr92-comments.json',import.meta.url),'utf8').replace(/^\uFEFF/,'')).map(c=>({...c,actor_type:'Bot'}));
 const comment=body=>({id:800002,actor:p.actor,actor_type:'Bot',body});
 const encode=(h,r)=>'AWH-HANDOFF v0.1\n```json\n'+JSON.stringify(h,null,2)+'\n```'+(r?'\nAWH-REVISION v0.2.1\n```json\n'+JSON.stringify(r,null,2)+'\n```':'');
 const sections=body=>[...body.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m=>JSON.parse(m[1]));
 return {p,bodies,comments,comment,encode,sections};
}
for(const publication of ['pending','confirmed'])test('real PR92 prose-only document Handoff stays separate from exact '+publication+' revision',()=>{
 const {p,bodies,comments,comment}=realPublication(),before=JSON.stringify(comments);
 const q=publicationObservation(p,bodies,[...comments,comment(bodies[publication])]);assert.equal(q.kind,'existing');assert.equal(q.publication,publication);assert.equal(q.comment_id,800002);assert.equal(JSON.stringify(comments),before);
 assert.throws(()=>publicationObservation(p,bodies,[...comments,comment(bodies[publication]),{...comment(bodies[publication]),id:800003}]),e=>e.code==='publication_conflict');
});
const corruptions={
 'malformed Revision JSON':({bodies})=>bodies.pending.replace('"revision_id":','"revision_id" invalid:'),
 'missing Revision fence':({bodies})=>bodies.pending.slice(0,-3),
 'unsupported Revision marker':({bodies})=>bodies.pending.replace('AWH-REVISION v0.2.1','AWH-REVISION v9'),
 'duplicate Revision section':({bodies})=>bodies.pending+'\nAWH-REVISION v0.2.1\n```json\n{}\n```',
 'Revision without Handoff':({bodies})=>bodies.pending.slice(bodies.pending.indexOf('AWH-REVISION')),
 'current ID in unexpected ordinary prose':({p})=>'Publication reference '+p.revision_id,
 'current ID in unrelated Handoff prose':({p,comments})=>comments.find(c=>c.id===6071714260).body+'\n'+p.revision_id,
 'malformed Handoff JSON':({bodies})=>bodies.pending.replace('"schema_version":','"schema_version" invalid:'),
 'structured real Run target without Revision':({bodies,sections,encode})=>encode(sections(bodies.pending)[0]),
 'different revision ID claims same Run and target':({bodies,sections,encode})=>{const[h,r]=sections(bodies.pending);r.revision_id='revision-'+'f'.repeat(64);return encode(h,r);},
 'contradictory Run metadata':({bodies,sections,encode})=>{const[h,r]=sections(bodies.pending);r.run_id='other';return encode(h,r);},
 'contradictory HEAD metadata':({bodies,sections,encode})=>{const[h,r]=sections(bodies.pending);r.new_head='f'.repeat(40);return encode(h,r);},
 'other revision contradicts original source':({bodies,sections,encode})=>{const[h,r]=sections(bodies.pending);h.candidate.head_sha='a'.repeat(40);h.verification.subject_sha=h.candidate.head_sha;r.new_head=h.candidate.head_sha;r.revision_id='revision-'+'f'.repeat(64);r.original_head='f'.repeat(40);return encode(h,r);},
 'other revision contradicts PR identity':({bodies,sections,encode})=>{const[h,r]=sections(bodies.pending);h.candidate.head_sha='a'.repeat(40);h.verification.subject_sha=h.candidate.head_sha;r.new_head=h.candidate.head_sha;r.revision_id='revision-'+'f'.repeat(64);h.candidate.base_sha='f'.repeat(40);return encode(h,r);},
 'unknown metadata':({bodies,sections,encode})=>{const[h,r]=sections(bodies.pending);r.extra=true;return encode(h,r);},
 'contradictory comment reference':({bodies,sections,encode})=>{const[h,r]=sections(bodies.pending);r.previous_handoff+='#issuecomment-1';return encode(h,r);},
 'current ID in prefixed envelope':({bodies})=>'Prose\n'+bodies.pending,
 'unbounded protocol body':({bodies})=>bodies.pending+' '.repeat(65536),
};
for(const[name,mutate]of Object.entries(corruptions))test('bounded publication classification fails closed: '+name,()=>{
 const f=realPublication();assert.throws(()=>publicationObservation(f.p,f.bodies,[...f.comments,f.comment(mutate(f))]),e=>e.code==='publication_conflict');
});
test('only a complete consistent other revision is separated; malformed metadata and wrong actor remain conflicts',()=>{
 const f=realPublication(),[h,r]=f.sections(f.bodies.confirmed);h.candidate.head_sha='a'.repeat(40);h.verification.subject_sha=h.candidate.head_sha;r.new_head=h.candidate.head_sha;r.revision_id='revision-'+'f'.repeat(64);
 const other=f.comment(f.encode(h,r));assert.equal(publicationObservation(f.p,f.bodies,[...f.comments,other]).kind,'negative_observation');
 assert.throws(()=>publicationObservation(f.p,f.bodies,[{...other,actor:'other[bot]'}]),e=>e.code==='publication_conflict');
 delete r.evidence_sha256;assert.throws(()=>publicationObservation(f.p,f.bodies,[f.comment(f.encode(h,r))]),e=>e.code==='publication_conflict');
});
test('ordinary Run/HEAD prose and structured Human resume proposal confer no publication authority',()=>{
 const f=realPublication(),a={schema_version:'1.0',kind:'revision_publication_resume',revision_id:f.p.revision_id};
 const comments=[...f.comments,f.comment('References '+f.p.run_id+' '+f.p.new_head),f.comment('AWH-PUBLICATION-RESUME v0.2.1-R1\n```json\n'+JSON.stringify(a)+'\n```')];
 const q=publicationObservation(f.p,f.bodies,comments);assert.equal(q.kind,'negative_observation');assert.equal(q.first_post_not_submitted_proven,false);assert.equal(q.automatic_repost_authorized,false);
 assert.throws(()=>parsePublicationAuthorization(comments.at(-1).body,{revision_id:f.p.revision_id,observation:q}));
});
async function failed(t,{existing=null,recovered=false}={}) {
 const h=await harness(t),route=h.client.request;
 h.client.request=async(c,path,...args)=>path==='/v1/capabilities'?{revision_linking:'v021-docs-v1',database_version:2,authority_verified:false}:route(c,path,...args);
 let predecessor;
 if(recovered){await assert.rejects(deliver(h.client,{title:'Fixture',body:'Refs #90',holdDraft:true,issue:90},{...h.deps,verify:async command=>({command,exit_code:2,stdout:'known offline failure',stderr:'',elapsed_ms:1})}));predecessor=JSON.parse(readFileSync(h.session())).initial.id;writeFileSync(join(h.repo,'docs/management/awh-repeatable-workflow.md'),'recovery fix\n');h.git(h.repo,['add','.']);h.git(h.repo,['commit','-m','recovery fixture']);}
 const result=await deliver(h.client,{title:'Fixture',body:'Refs #90',holdDraft:true,issue:90,...(predecessor?{recoverFromRun:predecessor}:{})},h.deps);
 const sessionBytes=readFileSync(h.session()),journal=join(dirname(h.session()),result.run_id+'.delivery.json'),journalBytes=readFileSync(journal),oldEvents=h.events(result.run_id);
 writeFileSync(join(h.repo,'docs/management/awh-repeatable-workflow.md'),'revision\n');h.git(h.repo,['add','.']);h.git(h.repo,['commit','-m','docs revision']);
 const head=h.git(h.repo,['rev-parse','HEAD']),data={actor:'zlpoot-awh-builder[bot]',verification:{command:REVISION_COMMAND,command_runs:1,exit_code:0,before_sha:head,after_sha:head,base_sha:h.baseline,clean_before:true,clean_after:true,environment:{platform:'win32',arch:'x64',node:'fixture',git:'fixture'},started_at:'2026-10-09T00:00:00.000Z',finished_at:'2026-10-09T00:00:01.000Z',stdout:'',stderr:''}};
 h.comments.set(10000,'Builder evidence — documentation review correction\n```json\n'+JSON.stringify(data)+'\n```\nRaw stdout: ""\nRaw stderr: ""');
 const create=h.builder.createComment,edit=h.builder.editComment;let posts=0,patches=0;
 h.builder.createComment=async(...args)=>{if(existing){await create(...args);}throw Error('Original result unknown');};
 await assert.rejects(h.client.linkRevision({run:result.run_id,pr:result.pr.number,head,evidenceComment:10000},h.connect));
 const directory=dirname(h.session()),name=readdirSync(directory).find(n=>n.endsWith('.revision.0.json')),id=name.split('.')[0],receipt=new RevisionReceipt(directory,id),phases=receipt.phases(),bodies=publicationBodies(phases[0].value,phases[1].value.body);
 const oldComments=new Map(h.comments),phase0=readFileSync(receipt.file(0)),phase1=readFileSync(receipt.file(1));
 const archives=new Map(readdirSync(directory).filter(n=>n.startsWith(predecessor??'never-match')).map(n=>[n,readFileSync(join(directory,n))]));
 if(existing==='confirmed'){const row=[...h.comments].find(([,body])=>body===bodies.pending);h.comments.set(row[0],bodies.confirmed);}
 h.builder.createComment=async(...args)=>{posts++;return create(...args);};h.builder.editComment=async(...args)=>{patches++;return edit(...args);};
 const connect=async(...args)=>{const b=await h.connect(...args),adoption=args[4];return {...b,adoptComment:async()=>{assert(adoption);const body=h.comments.get(adoption.comment);assert.equal(digest(body),adoption.body_sha256);return b.readComment(adoption.pr,adoption.comment);}}};
 const reconcile=()=>h.client.reconcilePublication(id,connect);
 const authorize=async(mutate=()=>{})=>{const q=await reconcile(),existing=q.observation.kind==='existing',a={schema_version:'1.0',kind:'revision_publication_resume',decision:'authorize_once',revision_id:id,run_id:result.run_id,pr:result.pr.number,new_head:head,scope_sha256:q.scope_sha256,action:existing?'adopt':'post_once',comment_id:existing?q.observation.comment_id:null,ambiguity_decision:existing?'adopt_exact_existing_comment':'accept_bounded_duplicate_risk'};mutate(a);h.comments.set(20000,'AWH-PUBLICATION-RESUME v0.2.1-R1\n```json\n'+JSON.stringify(a,null,2)+'\n```');return a;};
 const resume=()=>h.client.resumePublication({revision:id,authorizationComment:20000},connect);
 const preserved=()=>{assert.deepEqual(readFileSync(h.session()),sessionBytes);assert.deepEqual(readFileSync(journal),journalBytes);assert.deepEqual(readFileSync(receipt.file(0)),phase0);assert.deepEqual(readFileSync(receipt.file(1)),phase1);assert.deepEqual(h.events(result.run_id).slice(0,10),oldEvents);for(const [n,b]of oldComments)if(b!==bodies.pending)assert.equal(h.comments.get(n),b);for(const [n,b]of archives)assert.deepEqual(readFileSync(join(directory,n)),b);};
 return {...h,result,receipt,id,bodies,head,reconcile,authorize,resume,preserved,connect,predecessor,archives,posts:()=>posts,patches:()=>patches,intent:join(directory,id+'.publication-resume.json')};
}
test('publication recovery validates and retains verification-recovery receipt plus predecessor archives',windows,async t=>{
 const h=await failed(t,{recovered:true});const q=await h.reconcile();assert.equal(q.scope.recovery_receipt_sha256,digest(readFileSync(join(dirname(h.session()),h.predecessor+'.recovery.json'))));await h.authorize();await h.resume();h.preserved();assert.equal(h.events(h.predecessor).length,5);assert.equal(h.events(h.result.run_id).length,11);
});
test('verification-recovery receipt drift fails reconciliation before publication',windows,async t=>{
 const h=await failed(t,{recovered:true}),path=join(dirname(h.session()),h.predecessor+'.recovery.json'),r=JSON.parse(readFileSync(path));r.hashes.session='f'.repeat(64);writeFileSync(path,JSON.stringify(r));await assert.rejects(h.reconcile());assert.equal(h.posts(),0);assert(!existsSync(h.intent));
});
test('phase 0/1 reconciliation is read-only: missing comment is not no-submit proof or permission',windows,async t=>{
 const h=await failed(t),before=readdirSync(dirname(h.session()));const q=await h.reconcile();
 assert.equal(q.observation.kind,'negative_observation');assert.equal(q.first_post_not_submitted_proven,false);assert.equal(q.observation.automatic_repost_authorized,false);
 assert.equal(q.provider_writes,0);assert.deepEqual(readdirSync(dirname(h.session())),before);assert.equal(h.posts(),0);h.preserved();
 await assert.rejects(h.client.retryRevision());await assert.rejects(h.resume());assert(!existsSync(h.intent));
});
test('complete offline Client excludes public docs-review prose, preserves the comment, and still requires explicit one-shot authorization',windows,async t=>{
 const h=await failed(t),f=realPublication(),docs=f.comments.find(c=>c.id===6071714260).body.replaceAll(f.p.run_id,h.result.run_id).replaceAll(f.p.new_head,h.head);h.comments.set(30000,docs);
 const before=readdirSync(dirname(h.session())),q=await h.reconcile();assert.equal(q.observation.kind,'negative_observation');assert.equal(q.provider_writes,0);assert.equal(q.human_authorization_required,true);assert.equal(q.first_post_not_submitted_proven,false);assert.deepEqual(readdirSync(dirname(h.session())),before);assert.equal(h.posts(),0);await assert.rejects(h.resume());assert(!existsSync(h.intent));
 await h.authorize();await h.resume();assert.equal(h.posts(),1);assert.equal(h.events(h.result.run_id).length,11);assert.equal(h.comments.get(30000),docs);h.preserved();
});
test('read-only reconciliation refuses a missing namespace without creating it',windows,async t=>{
 const h=await failed(t),configPath=h.client.configPath,c=JSON.parse(readFileSync(configPath)),before=readdirSync(c.state_directory);writeFileSync(configPath,JSON.stringify({...c,endpoint:'http://127.0.0.1:4311'}));
 await assert.rejects(h.reconcile(),e=>e.code==='state');assert.deepEqual(readdirSync(c.state_directory),before);assert.equal(h.posts(),0);writeFileSync(configPath,JSON.stringify(c));h.preserved();
});
for(const existing of [null,'pending','confirmed'])test('one-shot '+(existing??'explicit-risk POST')+' continues same revision, preserves history and links only one Event',windows,async t=>{
 const h=await failed(t,{existing});await h.authorize();const r=await h.resume();h.preserved();
 assert.equal(r.revision_id,h.id);assert.equal(h.receipt.phases().length,6);assert.equal(h.events(h.result.run_id).length,11);assert.equal(h.posts(),existing?0:1);assert.equal(h.patches(),existing==='confirmed'?0:1);
 const intent=readFileSync(h.intent);await assert.rejects(h.resume());await assert.rejects(h.client.retryRevision());assert.deepEqual(readFileSync(h.intent),intent);assert.equal(h.events(h.result.run_id).filter(e=>e.type==='PR_REVISION_LINKED').length,1);
});
test('lost resume POST response consumes immutable intent: reconcile may observe, neither resume nor ACK retry can POST again',windows,async t=>{
 const h=await failed(t);await h.authorize();const create=h.builder.createComment;h.builder.createComment=async(...args)=>{await create(...args);throw Error('lost response');};
 await assert.rejects(h.resume());assert(existsSync(h.intent));assert.equal(h.receipt.phases().length,2);assert.equal((await h.reconcile()).observation.kind,'existing');
 await assert.rejects(h.resume());await assert.rejects(h.client.retryRevision());assert.equal(h.posts(),1);assert.equal(h.events(h.result.run_id).length,10);h.preserved();
});
test('confirmation interruption stops at phase 3 and forbids provider replay',windows,async t=>{
 const h=await failed(t);await h.authorize();h.builder.editComment=async()=>{throw Error('confirmation unknown');};
 await assert.rejects(h.resume());assert.equal(h.receipt.phases().length,4);await assert.rejects(h.resume());await assert.rejects(h.client.retryRevision());assert.equal(h.posts(),1);assert.equal(h.events(h.result.run_id).length,10);h.preserved();
});
test('duplicate arriving after the one-shot POST stops linkage and never sends another POST',windows,async t=>{
 const h=await failed(t);await h.authorize();const create=h.builder.createComment;h.builder.createComment=async(...args)=>{const c=await create(...args);h.comments.set(30000,h.bodies.pending);return c;};await assert.rejects(h.resume());assert.equal(h.posts(),1);assert.equal(h.events(h.result.run_id).length,10);await assert.rejects(h.resume());h.preserved();
});
test('phase 4 ACK loss uses only fixed Event retry, with no further connect/POST/PATCH',windows,async t=>{
 const h=await failed(t);await h.authorize();h.fault('PR_REVISION_LINKED');await assert.rejects(h.resume());assert.equal(h.receipt.phases().length,5);
 const calls=h.counts.connect;await h.client.retryRevision();assert.equal(h.counts.connect,calls);assert.equal(h.posts(),1);assert.equal(h.patches(),1);assert.equal(h.events(h.result.run_id).length,11);h.preserved();
 const a=h.attempts.filter(e=>e.type==='PR_REVISION_LINKED');assert.deepEqual(a[0],a[1]);
});
for(const [name,mutate]of Object.entries({revision:a=>a.revision_id='revision-'+'f'.repeat(64),run:a=>a.run_id='different',scope:a=>a.scope_sha256='f'.repeat(64),risk:a=>a.ambiguity_decision='no_comment_means_safe',unknown:a=>a.arbitrary=true,action:a=>a.action='adopt',comment:a=>a.comment_id=1}))
 test('Human authorization refuses '+name+' before creating intent or minting publication capability',windows,async t=>{
 const h=await failed(t);await h.authorize(mutate);await assert.rejects(h.resume());assert(!existsSync(h.intent));assert.equal(h.posts(),0);h.preserved();
 });
for(const [name,mutate]of Object.entries({duplicate:h=>h.comments.set(30000,h.bodies.pending),actor:h=>{const list=h.builder.listComments;h.builder.listComments=async(...a)=>(await list(...a)).map(c=>c.body===h.bodies.pending?{...c,actor:'different[bot]'}:c);},body:h=>{const [n,b]=[...h.comments].find(([,b])=>b===h.bodies.pending);h.comments.set(n,b+' ');}}))
 test('existing publication '+name+' conflict stops read-only reconciliation',windows,async t=>{const h=await failed(t,{existing:'pending'});mutate(h);await assert.rejects(h.reconcile());assert(!existsSync(h.intent));assert.equal(h.posts(),0);});
for(const [name,mutate]of Object.entries({session:h=>writeFileSync(h.session(),readFileSync(h.session())+' '),phase0:h=>writeFileSync(h.receipt.file(0),readFileSync(h.receipt.file(0))+' '),draft:h=>{const read=h.builder.readPR;h.builder.readPR=async n=>({...await read(n),draft:false});},head:h=>{h.builder.readRevisionRef=async()=> 'f'.repeat(40);},actor:h=>{h.builder.preflight=()=>({actor:'different[bot]',issue_state:'open'});},pages:h=>{let n=0;const list=h.builder.listComments;h.builder.listComments=async(...a)=>[...await list(...a),{id:40000+(n++),actor:'user',actor_type:'User',body:'changing page'}];}}))
 test('frozen '+name+' drift stops without intent or writes',windows,async t=>{const h=await failed(t);mutate(h);await assert.rejects(h.reconcile());assert(!existsSync(h.intent));assert.equal(h.posts(),0);});
test('post-intent identity change consumes capability and stops before POST',windows,async t=>{
 const h=await failed(t);await h.authorize();const connect=async(...args)=>{const b=await h.connect(...args);return args[3]==='revision'?{...b,preflight:()=>({actor:'other[bot]'})}:b;};
 await assert.rejects(h.client.resumePublication({revision:h.id,authorizationComment:20000},connect));assert(existsSync(h.intent));assert.equal(h.posts(),0);await assert.rejects(h.resume());h.preserved();
});
