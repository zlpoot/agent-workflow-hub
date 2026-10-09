import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {AwhClient} from '../dist/client/client.js';
import {deliver} from '../dist/client/deliver.js';
import {ControlPlaneStore} from '../dist/control-plane/store.js';
import {mvpPolicy,repeatablePolicy,seedRepeatableProfile} from '../dist/mvp-cli.js';
import {REPEATABLE_VERSION,taskBinding,bindWorkflow} from '../dist/profiles.js';
import {validateEntity,validateBindings} from '../dist/protocol/index.js';
const git=(cwd,args)=>{const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(k)));Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});const r=spawnSync('git',['-c','core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null'),'-c','commit.gpgsign=false',...args],{cwd,env,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
async function harness(t,{legacy=false}={}) {
 const base=mkdtempSync(join(tmpdir(),'awh-v02-')),repo=join(base,'repo'),state=join(base,'state');mkdirSync(repo);mkdirSync(state);
 git(repo,['init','-b',legacy?'codex/awh-v01-acceptance':'codex/awh-task-90']);git(repo,['config','user.name','Fixture']);git(repo,['config','user.email','fixture@example.invalid']);git(repo,['remote','add','origin','https://github.com/zlpoot/future-ui.git']);
 mkdirSync(join(repo,'.awh'));mkdirSync(join(repo,'docs/management'),{recursive:true});writeFileSync(join(repo,'.awh/project.yaml'),'apiVersion: awh/v1\nproject:\n  id: future-ui\n  repository: zlpoot/future-ui\nprofile:\n  ref: future-ui/c1c-acceptance\n');writeFileSync(join(repo,'.gitignore'),'.handoff/\n');writeFileSync(join(repo,'docs/management/awh-repeatable-workflow.md'),'fixture\n');git(repo,['add','.']);git(repo,['commit','-m','fixture']);
 const credential=join(base,'credential'),configPath=join(base,'client.json');writeFileSync(credential,'awh_cp_'+randomBytes(32).toString('base64url'),{mode:0o600});
 const config={schema_version:'1.0',endpoint:'http://127.0.0.1:4310',credential_file:credential,state_directory:state,executor_id:'c1c-future-ui-windows',executor_type:'codex',profile_version:legacy?'v01-mvp-docs-v1':REPEATABLE_VERSION};writeFileSync(configPath,JSON.stringify(config));
 const client=new AwhClient(configPath,repo),context=client.context(true),principal={id:'fixture-client',project_ids:['future-ui'],executor_ids:[config.executor_id]};
 const database=join(base,'runtime.sqlite'),store=new ControlPlaneStore(database,[mvpPolicy(),repeatablePolicy(context.machine.id)]);
 let fault=null;const attempts=[];
 client.request=async(c,path,method='GET',data)=>{let v;const u=new URL(path,'http://fixture');const parts=u.pathname.split('/');
  if(path==='/v1/projects/register')v=store.registerProject(principal,data);
  else if(path==='/v1/executors/register')v=store.registerExecutor(principal,data.executor,data.client);
  else if(parts.at(-1)==='heartbeat')v=store.heartbeat(principal,parts[3]);
  else if(path==='/v1/executors')v={executors:store.listExecutors(principal)};
  else if(parts[2]==='projects')v={project:store.getProject(principal,parts[3])};
  else if(parts[2]==='profiles')v={profiles:store.listProfiles(principal,u.searchParams.get('project_id'))};
  else if(path==='/v1/work-items/register')v=store.registerWorkItem(principal,data);
  else if(path==='/v1/runs')v=store.createRun(principal,data);
  else if(parts.at(-1)==='events'&&method==='POST'){attempts.push(structuredClone(data));v=store.append(principal,parts[3],data);if(data.type===fault){fault=null;throw Error('Fixture ACK lost');}}
  else if(parts.at(-1)==='events')v={events:store.listEvents(principal,parts[3],Number(u.searchParams.get('after')),100)};
  else if(parts[2]==='runs')v={run:store.getRun(principal,parts[3])};else throw Error('Unexpected fixture route');
  return {...v,authority_verified:false};
 };
 await client.register();const counts={connect:0,push:0,pr:0},comments=new Map();let binding,mode,pr=30;
 const summary=()=>({number:pr,url:'https://github.com/zlpoot/future-ui/pull/'+pr,actor:'zlpoot-awh-builder[bot]',head:git(repo,['rev-parse','HEAD']),base:'a'.repeat(40),draft:true,node_id:'fixture'});
 const comment=(id,body)=>({id,url:'https://github.com/zlpoot/future-ui/pull/'+pr+'#issuecomment-'+id,body,actor:'zlpoot-awh-builder[bot]'});
 const builder={preflight:()=>({actor:'zlpoot-awh-builder[bot]',issue_state:'open',task_binding:binding,repo:'zlpoot/future-ui',app_id:123,permissions:{contents:mode==='recover'?'read':'write'},...(mode==='recover'?{recovery_inspection:{remote_branch_absent:true,same_branch_pr_absent:true}}:{})}),push:async()=>{counts.push++;},createPR:async()=>{counts.pr++;pr++;return summary();},readPR:async()=>summary(),createComment:async(n,body)=>{const id=comments.size+101;comments.set(id,body);return comment(id,body);},editComment:async(n,id,body)=>{comments.set(id,body);return comment(id,body);},readComment:async(n,id)=>comment(id,comments.get(id)),readLifecycle:async(n,head)=>({repository:'zlpoot/future-ui',pull_request:n,head_sha:head,issue:binding?.issue??88,issue_repository:'zlpoot/future-ui',review:{id:900+n,login:'reviewer',subject_sha:head,url:'https://github.com/zlpoot/future-ui/pull/'+n+'#pullrequestreview-'+(900+n)},changes_requested:false,state:'closed',merged:true,merge_sha:'b'.repeat(40),issue_closed:true,authority_verified:false})};
 const connect=async(o,selection,b,m)=>{counts.connect++;binding=b;mode=m;assert.equal(o.cwd(),repo);assert.deepEqual(selection,{profile:'future-ui',workflow:b?'repeatable-docs':'mvp-docs'});return builder;};
 const deps={connect,verify:async command=>({command,exit_code:0,stdout:'fixture only',stderr:'',elapsed_ms:1})};
 const session=()=>join(state,readdirSync(state).find(n=>/^[a-f0-9]{64}$/.test(n)),'session.json');const events=id=>store.listEvents(principal,id).map(x=>x.event);
 const change=issue=>{git(repo,['switch','-c','codex/awh-task-'+issue]);writeFileSync(join(repo,'docs/management/awh-repeatable-workflow.md'),'Issue '+issue+'\n');git(repo,['add','.']);git(repo,['commit','-m','Issue '+issue]);};
 const upgrade=()=>{config.profile_version=REPEATABLE_VERSION;writeFileSync(configPath,JSON.stringify(config));};
 t.after(()=>{store.close();assert.equal(dirname(base),tmpdir());assert(base.startsWith(join(tmpdir(),'awh-v02-')));rmSync(base,{recursive:true,force:true});});
 return {repo,base,client,store,database,principal,counts,deps,connect,session,events,change,upgrade,attempts,fault(type){fault=type;},builder};
}
const options=issue=>({title:'Fixture issue '+issue,body:'Refs #'+issue,holdDraft:true,issue});
const windows={timeout:60000,skip:process.platform!=='win32'&&'Windows-only trusted template; platform refusal covered below'};
test('v0.2 two consecutive Issues preserve completed Run, Journal bytes and original Events; branch reuse blocks writes',windows,async t=>{
 const h=await harness(t),first=await deliver(h.client,options(90),h.deps);assert.equal((await h.client.syncDelivery(h.connect)).run.state,'completed');
 const before=readFileSync(h.session()),journal=join(dirname(h.session()),first.run_id+'.delivery.json'),journalBytes=readFileSync(journal),oldEvents=h.events(first.run_id);assert.equal(oldEvents.length,13);
 h.change(91);const second=await deliver(h.client,options(91),h.deps);assert.notEqual(second.run_id,first.run_id);assert.equal(second.task.issue,91);assert.equal(second.task.branch,'codex/awh-task-91');
 assert(before.equals(readFileSync(join(dirname(h.session()),first.run_id+'.json'))));assert(journalBytes.equals(readFileSync(journal)));assert.deepEqual(h.events(first.run_id),oldEvents);
 assert.equal((await h.client.status()).previous_run,first.run_id);assert.deepEqual((await h.client.timeline(first.run_id)).events.map(e=>e.event),oldEvents);
 assert.equal((await h.client.syncDelivery(h.connect)).run.state,'completed');assert.equal(h.counts.push,2);assert.equal(h.counts.pr,2);
 await assert.rejects(deliver(h.client,options(91),h.deps),/consumed/);assert.equal(h.counts.push,2);
});
test('v0.1 #88 completed Journal safely precedes v0.2 #90 in the same namespace and identity',windows,async t=>{
 const h=await harness(t,{legacy:true}),old=await deliver(h.client,{title:'Legacy 88',body:'Refs #88',holdDraft:true},h.deps);await h.client.syncDelivery(h.connect);
 const before=readFileSync(h.session()),oldEvents=h.events(old.run_id);h.upgrade();h.change(90);const fresh=await deliver(h.client,options(90),h.deps);
 assert.notEqual(fresh.run_id,old.run_id);assert(before.equals(readFileSync(join(dirname(h.session()),old.run_id+'.json'))));assert.deepEqual(h.events(old.run_id),oldEvents);assert.equal(oldEvents.length,13);assert.equal((await h.client.status()).history[0].issue,88);
});
for(const type of ['RUN_STARTED','GITHUB_PUSH_COMPLETED','HANDOFF_PUBLISHED','RUN_COMPLETED'])test('v0.2 '+type+' lost ACK preserves Event ID/sequence; no repeat provider writes',windows,async t=>{
 const h=await harness(t);h.fault(type);if(type==='RUN_COMPLETED'){await deliver(h.client,options(90),h.deps);await assert.rejects(h.client.syncDelivery(h.connect));await h.client.retryDelivery();await h.client.syncDelivery(h.connect);}
 else {await assert.rejects(deliver(h.client,options(90),h.deps));if(type==='RUN_STARTED')await deliver(h.client,options(90),h.deps);else await h.client.retryDelivery();}
 const duplicates=h.attempts.filter((e,i,a)=>a.findIndex(v=>v.id===e.id)!==i);assert(duplicates.length>=1);for(const e of duplicates)assert.deepEqual(e,h.attempts.find(v=>v.id===e.id));assert.equal(h.counts.push,1);
 if(type!=='RUN_STARTED'&&type!=='RUN_COMPLETED'){h.change(91);await assert.rejects(deliver(h.client,options(91),h.deps),/Journal/);assert.equal(h.counts.push,1);}
});
for(const disposition of ['stopped','in_progress','waiting_for_independent_review','draft_waiting_for_acceptance'])test('v0.2 '+disposition+' Journal refuses next Task without state replacement',windows,async t=>{
 const h=await harness(t),r=await deliver(h.client,options(90),h.deps);await h.client.syncDelivery(h.connect);const journal=join(dirname(h.session()),r.run_id+'.delivery.json'),j=JSON.parse(readFileSync(journal));j.disposition=disposition;writeFileSync(journal,JSON.stringify(j));const before=readFileSync(h.session());h.change(91);
 await assert.rejects(deliver(h.client,options(91),h.deps),/Journal/);assert(before.equals(readFileSync(h.session())));assert.equal(h.counts.push,1);
});
test('v0.2 missing/renamed completed Journal cannot bypass provider reconciliation',windows,async t=>{
 const h=await harness(t),r=await deliver(h.client,options(90),h.deps);await h.client.syncDelivery(h.connect);renameSync(join(dirname(h.session()),r.run_id+'.delivery.json'),join(dirname(h.session()),r.run_id+'.retained.json'));h.change(91);
 await assert.rejects(deliver(h.client,options(91),h.deps),/Journal is missing/);assert.equal(h.counts.push,1);
});
test('v0.2 refuses missing Issue, branch mismatch, unsafe number and machine drift before provider access',windows,async t=>{
 const h=await harness(t);for(const issue of [undefined,91,0,Number.MAX_SAFE_INTEGER+1])await assert.rejects(deliver(h.client,options(issue),h.deps));assert.equal(h.counts.connect,0);assert.equal(h.counts.push,0);
});
test('v0.2 lifecycle refuses wrong Issue, repo, HEAD, PR and merge SHA',windows,async t=>{
 const h=await harness(t);await deliver(h.client,options(90),h.deps);const read=h.builder.readLifecycle;
 for(const drift of [{issue:91},{issue_repository:'zlpoot/webskill'},{repository:'zlpoot/webskill'},{head_sha:'c'.repeat(40)},{pull_request:999},{merge_sha:null}]){h.builder.readLifecycle=async(...args)=>({...await read(...args),...drift});await assert.rejects(h.client.syncDelivery(h.connect),e=>e.code==='provider_binding');}
 assert.equal((await h.client.status()).run.state,'awaiting_review');
});
test('immutable v0.2 seed preserves CP v2 identities, old profiles and all events; idempotent repeat',windows,async t=>{
 const h=await harness(t,{legacy:true}),read=new DatabaseSync(h.database,{readOnly:true}),tables=['projects','executors','executor_clients','work_items','runs','events'];
 const snap=()=>Object.fromEntries(tables.map(table=>[table,read.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));const before=snap(),profiles=read.prepare('SELECT * FROM profiles ORDER BY version').all();seedRepeatableProfile(h.database);seedRepeatableProfile(h.database);assert.deepEqual(snap(),before);assert.deepEqual(read.prepare('SELECT * FROM profiles ORDER BY version').all(),profiles);assert.equal(read.prepare('PRAGMA user_version').get().user_version,2);read.close();
});
test('Task template rejects arbitrary repository, base/prefix policy, branch, Profile, executor and fingerprint',()=>{
 const value={repository:'zlpoot/future-ui',issue:90,branch:'codex/awh-task-90',source_sha:'a'.repeat(40),profile_ref:'future-ui/c1c-acceptance',profile_version:REPEATABLE_VERSION,executor_id:'c1c-future-ui-windows',machine_id:'fixture-machine'};
 const binding=taskBinding(value);assert.equal(bindWorkflow({profile:'future-ui',workflow:'repeatable-docs'},binding).workflow.work_item.issue,90);
 for(const drift of [{repository:'zlpoot/webskill'},{issue:0},{branch:'codex/awh-task-90/shell'},{branch:'codex/awh-task-091'},{executor_id:'other'},{profile_version:'other'},{profile_ref:'future-ui/other'},{source_sha:'b'.repeat(41)},{api:'evil'}])assert.throws(()=>taskBinding({...value,...drift}));
 assert.throws(()=>bindWorkflow({profile:'future-ui',workflow:'repeatable-docs'},{...binding,fingerprint:'0'.repeat(64)}));assert.throws(()=>bindWorkflow({profile:'future-ui',workflow:'mvp-docs'},binding));
 const policy=repeatablePolicy('fixture-machine');assert(validateEntity('profile_policy',policy).valid);for(const drift of [{base:'evil'},{branch:{mode:'issue_prefix',ref:'codex/arbitrary-'}},{repository:'evil/repo'},{executor_restrictions:null}])assert(!validateEntity('profile_policy',{...policy,...drift}).valid);
 const f=JSON.parse(readFileSync(new URL('../examples/protocol/future-ui.json',import.meta.url)));f.profile_policy=policy;f.work_item.reference.repository='zlpoot/future-ui';f.project.profile_ref=policy.ref;f.manifest.profile.ref=policy.ref;f.executor.id='c1c-future-ui-windows';f.executor.machine={id:'fixture-machine',platform:'windows'};f.run.executor_id=f.executor.id;f.run.machine_id=f.executor.machine.id;f.run.profile={ref:policy.ref,version:policy.version};f.run.source.ref='codex/awh-task-'+f.work_item.reference.number;assert(validateBindings(f).valid);
 for(const drift of [{ref:'codex/awh-task-999'},{repository:'zlpoot/webskill'}])assert(!validateBindings({...f,run:{...f.run,source:{...f.run.source,...drift}}}).valid);
});

const correction = h => { writeFileSync(join(h.repo,'docs/management/awh-repeatable-workflow.md'),'Corrected guide\n');git(h.repo,['add','.']);git(h.repo,['commit','-m','correct guide']); };
async function failedVerification(h) {
 await assert.rejects(deliver(h.client,options(90),{...h.deps,verify:async command=>({command,exit_code:2,stdout:'fixture diff-check CR failure',stderr:'',elapsed_ms:1})}));
 const status=await h.client.status();assert.equal(status.run.state,'failed');assert.equal(h.events(status.run.id).length,5);return status.run.id;
}
const recoverOptions=id=>({...options(90),recoverFromRun:id});
const snapshot=h=>{const d=new DatabaseSync(h.database,{readOnly:true});try{return Object.fromEntries(['projects','profiles','work_items','runs','events'].map(t=>[t,d.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));}finally{d.close();}};
test('0.4.1 one-shot #90 recovery preserves original six Runs/24 Events, #88/13 and failed #90/5 byte for byte',windows,async t=>{
 const h=await harness(t,{legacy:true});
 for(let i=0;i<6;i++){await h.client.start(21);await h.client.event('STEP_STARTED',{step_id:'fixture-check',name:'Historical fixture'});await h.client.event('STEP_COMPLETED',{step_id:'fixture-check',exit_code:2});await h.client.finish(true,{reason:'Historical fixture failure'});}
 const legacy=await deliver(h.client,{title:'Legacy 88',body:'Refs #88',holdDraft:true},h.deps);await h.client.syncDelivery(h.connect);assert.equal(snapshot(h).events.length,37);
 const legacyBytes=readFileSync(h.session()),legacyJournal=readFileSync(join(dirname(h.session()),legacy.run_id+'.delivery.json'));h.upgrade();h.change(90);const old=await failedVerification(h),before=snapshot(h),raw=readFileSync(h.session()),journal=join(dirname(h.session()),old+'.delivery.json'),rawJournal=readFileSync(journal);correction(h);
 const r=await deliver(h.client,recoverOptions(old),h.deps);assert.notEqual(r.run_id,old);assert.equal((await h.client.status()).run.state,'awaiting_review');assert.equal(h.events(r.run_id).length,10);
 assert(raw.equals(readFileSync(join(dirname(h.session()),old+'.json'))));assert(rawJournal.equals(readFileSync(journal)));assert(legacyBytes.equals(readFileSync(join(dirname(h.session()),legacy.run_id+'.json'))));assert(legacyJournal.equals(readFileSync(join(dirname(h.session()),legacy.run_id+'.delivery.json'))));
 const after=snapshot(h);for(const table of ['projects','profiles','work_items'])assert.deepEqual(after[table],before[table]);for(const table of ['runs','events'])assert.deepEqual(after[table].slice(0,before[table].length),before[table]);assert.equal(after.runs.length,9);assert.equal(after.events.length,52);
 const receipt=JSON.parse(readFileSync(join(dirname(h.session()),old+'.recovery.json')));assert.equal(receipt.successor_run_id,r.run_id);assert.equal(receipt.link.predecessor_run_id,old);assert.equal(receipt.inspection.contents_permission,'read');assert.equal(h.events(r.run_id)[0].payload.extensions.verification_recovery.attempt_id,receipt.link.attempt_id);
 assert.equal(JSON.parse(readFileSync(join(dirname(h.session()),r.run_id+'.delivery.json'))).recovery.attempt_id,receipt.link.attempt_id);const comments=[...readdirSync(join(h.repo,'.handoff',r.run_id))];assert(comments.includes('handoff.confirmed.json'));
 const writes={push:h.counts.push,pr:h.counts.pr};await assert.rejects(deliver(h.client,recoverOptions(old),h.deps),/consumed|not current/);assert.equal(h.counts.push,writes.push);assert.equal(h.counts.pr,writes.pr);
 await h.client.syncDelivery(h.connect);h.change(91);await deliver(h.client,options(91),h.deps);assert(rawJournal.equals(readFileSync(journal)));assert.equal((await h.client.timeline(old)).run.state,'failed');
});
for(const drift of ['unknown-stage','provider-refs','wrong-evidence-sha','missing-journal','same-head','cross-issue','remote-ref','remote-pr','tampered-failed-cp-history'])test('0.4.1 recovery rejects '+drift+' before attempt consumption/provider writes',windows,async t=>{
 const h=await harness(t),id=await failedVerification(h),journal=join(dirname(h.session()),id+'.delivery.json'),bytes=readFileSync(h.session());if(drift!=='same-head')correction(h);
 if(drift==='unknown-stage'||drift==='provider-refs'){const j=JSON.parse(readFileSync(journal));if(drift==='unknown-stage')j.stage='unknown';else j.refs={push:true};writeFileSync(journal,JSON.stringify(j));}
 if(drift==='wrong-evidence-sha'){const path=join(h.repo,'.handoff',id,'verification.json'),v=JSON.parse(readFileSync(path));v.before_sha='b'.repeat(40);writeFileSync(path,JSON.stringify(v));}
 if(drift==='missing-journal')unlinkSync(journal);
 if(drift==='remote-ref'||drift==='remote-pr')h.deps.connect=async(...args)=>{if(args[3]==='recover')throw Error('Fixture remote ref/PR exists');return h.connect(...args);};
 if(drift==='tampered-failed-cp-history'){const req=h.client.request;h.client.request=async(...args)=>{const r=await req(...args);if(args[1].includes('/events?'))return {...r,events:r.events.slice(0,-1)};return r;};}
 await assert.rejects(deliver(h.client,{...recoverOptions(id),...(drift==='cross-issue'?{issue:91}:{})},h.deps));assert(bytes.equals(readFileSync(h.session())));assert(!existsSync(join(dirname(h.session()),id+'.recovery.json')));assert.equal(h.counts.push,0);assert.equal(h.counts.pr,0);
});
test('0.4.1 pending verification ACK/outbox cannot consume recovery attempt',windows,async t=>{
 const h=await harness(t);h.fault('VERIFICATION_FAILED');const id=await failedVerification(h).catch(async()=>JSON.parse(readFileSync(h.session())).initial.id);correction(h);const before=readFileSync(h.session());await assert.rejects(deliver(h.client,recoverOptions(id),h.deps));assert(before.equals(readFileSync(h.session())));assert(!existsSync(join(dirname(h.session()),id+'.recovery.json')));assert.equal(h.counts.push,0);
});
test('0.4.1 even a hand-edited stopped Journal cannot conceal CP-confirmed post-push failure',windows,async t=>{
 const h=await harness(t);h.builder.createPR=async()=>{throw Error('Fixture post-push failure');};await assert.rejects(deliver(h.client,options(90),h.deps));const id=(await h.client.status()).run.id,journal=join(dirname(h.session()),id+'.delivery.json'),j=JSON.parse(readFileSync(journal));j.stage='verification';j.refs={};writeFileSync(journal,JSON.stringify(j));correction(h);await assert.rejects(deliver(h.client,recoverOptions(id),h.deps));assert.equal(h.counts.push,1);assert.equal(h.counts.pr,0);
});
test('0.4.1 concurrent recovery invocations consume one receipt and one successor/provider attempt',windows,async t=>{
 const h=await harness(t),id=await failedVerification(h);correction(h);const result=await Promise.allSettled([deliver(h.client,recoverOptions(id),h.deps),deliver(h.client,recoverOptions(id),h.deps)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(snapshot(h).runs.length,2);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
});
test('0.4.1 interrupted receipt/session transition fails closed without a second Run',windows,async t=>{
 const h=await harness(t),id=await failedVerification(h);correction(h);const save=h.client.save.bind(h.client);h.client.save=(c,s)=>{if(s.recovery)throw Error('Fixture crash after receipt/archive');return save(c,s);};await assert.rejects(deliver(h.client,recoverOptions(id),h.deps));h.client.save=save;
 assert(existsSync(join(dirname(h.session()),id+'.recovery.json')));await assert.rejects(deliver(h.client,recoverOptions(id),h.deps));await assert.rejects(deliver(h.client,options(90),h.deps));assert.equal(snapshot(h).runs.length,1);assert.equal(h.counts.push,0);
});
test('0.4.1 successor create ACK loss resumes its fixed ID without repeating the recovery receipt or provider writes',windows,async t=>{
 const h=await harness(t),id=await failedVerification(h);correction(h);const request=h.client.request;let lost=true;h.client.request=async(...args)=>{const r=await request(...args);if(args[1]==='/v1/runs'&&lost){lost=false;throw Error('Fixture successor create ACK lost');}return r;};await assert.rejects(deliver(h.client,recoverOptions(id),h.deps));const next=JSON.parse(readFileSync(h.session())).initial.id;await assert.rejects(deliver(h.client,recoverOptions(id),h.deps));const r=await deliver(h.client,options(90),h.deps);assert.equal(r.run_id,next);assert.equal(snapshot(h).runs.length,2);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
});
