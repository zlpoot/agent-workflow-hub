import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { AwhClient } from '../dist/client/client.js';
import { inspectRepository, initManifest } from '../dist/client/local.js';
import { deliver, DeliveryError, deliveryDiagnostic } from '../dist/client/deliver.js';
import { BuilderError } from '../dist/builder.js';
import { createAuthenticator, createControlPlaneServer, ControlPlaneStore } from '../dist/control-plane/index.js';
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/protocol/${name}.json`,import.meta.url)));
const git = (cwd,args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(k)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
  const r = spawnSync('git',['-c','commit.gpgsign=false','-c','core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null'),...args],{cwd,env,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,'Fixture Git operation failed');return r.stdout.trim();
};
async function harness(t, { profile='webskill', policyChanges={}, legacyRef=false }={}) {
  const base=mkdtempSync(join(tmpdir(),'awh-c1d-')),repo=join(base,'consumer');mkdirSync(repo);
  git(repo,['init','-b',profile==='hub'?'codex/c1d-builder-adapter':profile==='webskill'?'codex/awh-c07-webskill-bootstrap':'codex/awh-c06-bootstrap']);
  git(repo,['config','user.name','Test']);git(repo,['config','user.email','test@example.invalid']);git(repo,['remote','add','origin','https://github.com/zlpoot/'+(profile==='hub'?'agent-workflow-hub':profile)+'.git']);
  writeFileSync(join(repo,'.gitignore'),'.handoff/\n');writeFileSync(join(repo,'source.txt'),'controlled fixture\n');git(repo,['add','.']);git(repo,['commit','-m','fixture']);
  const ref=profile==='hub'?'hub/c1d':profile+(legacyRef?'/default':'/bootstrap');initManifest(inspectRepository(repo),profile,ref);git(repo,['add','.awh/project.yaml']);git(repo,['commit','-m','identity']);
  const policy={...fixture(profile==='hub'?'webskill':profile).profile_policy,ref,repository:inspectRepository(repo).repository,
    branch:{mode:'fixed',ref:inspectRepository(repo).ref},verification:{commands:profile==='hub'?['pnpm check']:profile==='webskill'?['pnpm check:foundations','pnpm lint','pnpm typecheck']:['pnpm lint','pnpm typecheck','pnpm test']},...policyChanges};
  const principal={id:'delivery-client',project_ids:[profile],executor_ids:['delivery-executor']},token='awh_cp_'+randomBytes(32).toString('base64url');
  const store=new ControlPlaneStore(join(base,'runtime.sqlite'),[policy]),service=createControlPlaneServer({store,authenticate:createAuthenticator([{...principal,token_sha256:createHash('sha256').update(token).digest('hex')}])});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const cp='http://127.0.0.1:'+service.server.address().port;
  let fault=null;const attempts=[];
  const proxy=createServer(async(req,res)=>{try{let body='';for await(const chunk of req)body+=chunk;const event=req.url.endsWith('/events')&&req.method==='POST'?JSON.parse(body):null;if(event)attempts.push(event);
    const upstream=await fetch(cp+req.url,{method:req.method,headers:{authorization:req.headers.authorization,...(body?{'content-type':'application/json'}:{})},...(body?{body}:{})});const value=await upstream.json();
    if(event&&fault&&(event.type===fault.type||event.payload.extensions.builder_milestone===fault.type)){const saved=fault;fault=null;if(saved.kind==='lost'){res.destroy();return;}value.cursor=0;}
    res.writeHead(upstream.status,{'content-type':'application/json'});res.end(JSON.stringify(value));}catch{res.destroy();}});
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const configPath=join(base,'client.json'),state=join(base,'state'),credential=join(base,'client.credential');writeFileSync(credential,token,{mode:0o600});
  writeFileSync(configPath,JSON.stringify({schema_version:'1.0',endpoint:'http://127.0.0.1:'+proxy.address().port,credential_file:credential,state_directory:state,executor_id:'delivery-executor',executor_type:'codex',profile_version:policy.version}));
  const client=new AwhClient(configPath,repo);await client.register();const counts={connect:0,verify:0,push:0,pr:0,ready:0,restore:0},comments=new Map();let draft=true;
  const sha=inspectRepository(repo).sha,summary=()=>({number:31,url:'https://github.com/'+policy.repository+'/pull/31',actor:'zlpoot-awh-builder[bot]',head:sha,base:'1'.repeat(40),draft,node_id:'fixed'});
  const comment=(id,body)=>({id,actor:'zlpoot-awh-builder[bot]',url:'https://github.com/'+policy.repository+'/pull/31#issuecomment-'+id,body});
  const builder={preflight:()=>({actor:'zlpoot-awh-builder[bot]'}),push:async()=>{counts.push++;return{pushed:policy.branch.ref,actor:'zlpoot-awh-builder[bot]'};},
    createPR:async()=>{counts.pr++;return summary();},readPR:async()=>summary(),createComment:async(n,body)=>{const id=101+comments.size;comments.set(id,body);return comment(id,body);},
    readComment:async(n,id)=>comment(id,comments.get(id)),editComment:async(n,id,body)=>{comments.set(id,body);return comment(id,body);},
    ready:async()=>{counts.ready++;draft=false;return summary();},restoreDraft:async()=>{counts.restore++;draft=true;return summary();}};
  const deps={connect:async(overrides,selection)=>{counts.connect++;assert.equal(overrides.cwd(),repo);assert.deepEqual(selection,{profile,workflow:profile==='hub'?'c1d':'bootstrap'});return builder;},
    verify:async command=>{counts.verify++;return{command,exit_code:0,stdout:'controlled fixture verification\n# tests 1\n# pass 1\n# fail 0\n',stderr:'',elapsed_ms:1};}};
  const events=run=>store.listEvents(principal,run).map(x=>x.event),sessionPath=()=>join(state,readdirSync(state).find(n=>/^[a-f0-9]{64}$/.test(n)),'session.json');
  t.after(async()=>{await new Promise(r=>{proxy.close(r);proxy.closeAllConnections();});await service.close();store.close();assert(dirname(base)===tmpdir()&&base.startsWith(join(tmpdir(),'awh-c1d-')));rmSync(base,{recursive:true,force:true});});
  return{base,repo,client,builder,counts,comments,deps,policy,sha,events,sessionPath,attempts,fault(type,kind='lost'){fault={type,kind};},isDraft:()=>draft};
}
const options={title:'Controlled fixture delivery',body:'References Hub task; fixture only.'};
async function assertReconciliationGate(h) {
  const snapshot=dir=>Object.fromEntries(readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const path=join(e.parentPath,e.name);return[path,readFileSync(path).toString('base64')];}));
  const state=snapshot(dirname(h.sessionPath())),logs=snapshot(join(h.repo,'.handoff')),counts={...h.counts},comments=[...h.comments],run=await h.client.status(),events=h.events(run.run.id);
  await assert.rejects(deliver(h.client,options,h.deps),e=>e.code==='delivery_reconciliation');
  assert.deepEqual(h.counts,counts);assert.deepEqual([...h.comments],comments);assert.deepEqual(snapshot(dirname(h.sessionPath())),state);assert.deepEqual(snapshot(join(h.repo,'.handoff')),logs);
  assert.deepEqual(await h.client.status(),run);assert.deepEqual(h.events(run.run.id),events);
}
test('terminal delivery after post-push ACK retry refuses ordinary deliver without provider replay',async t=>{
  const h=await harness(t);h.fault('GITHUB_PUSH_COMPLETED');await assert.rejects(deliver(h.client,options,h.deps));
  const r=await h.client.retryDelivery();assert.equal(r.run.state,'failed');assert.equal(h.counts.push,1);assert.equal(h.counts.pr,0);await assertReconciliationGate(h);
});
test('ambiguous post-PR outcome requires reconciliation before ordinary deliver',async t=>{
  const h=await harness(t),create=h.builder.createPR;h.builder.createPR=async(...args)=>{await create(...args);throw new BuilderError('PR response unavailable','api');};
  await assert.rejects(deliver(h.client,options,h.deps));assert.equal((await h.client.status()).run.state,'failed');assert.equal(h.counts.pr,1);await assertReconciliationGate(h);
});
test('terminal delivery after confirmed Handoff preserves all records and refuses provider replay',async t=>{
  const h=await harness(t);h.fault('pr_ready_waiting_for_independent_review');await assert.rejects(deliver(h.client,options,h.deps));
  const r=await h.client.retryDelivery();assert.equal(r.run.state,'failed');assert(h.isDraft());assert(readFileSync(join(h.repo,'.handoff',r.run.id,'handoff.confirmed.json')));await assertReconciliationGate(h);
});
test('ordinary C1-C start preserves compatibility but cannot bypass an archived delivery journal',async t=>{
  const h=await harness(t);h.fault('GITHUB_PUSH_COMPLETED');await assert.rejects(deliver(h.client,options,h.deps));const old=await h.client.retryDelivery();
  const journal=join(dirname(h.sessionPath()),old.run.id+'.delivery.json'),before=readFileSync(journal);const fresh=await h.client.start(8);assert.notEqual(fresh.run.id,old.run.id);
  await assertReconciliationGate(h);assert(before.equals(readFileSync(journal)));
});
test('initial RUN_STARTED lost ACK resumes only the same fixed deliver before journal creation',async t=>{
  const h=await harness(t);h.fault('RUN_STARTED');await assert.rejects(deliver(h.client,options,h.deps));const s=JSON.parse(readFileSync(h.sessionPath())),pending=s.pending;
  await assert.rejects(h.client.retryDelivery(),e=>e.code==='delivery_state');assert.equal(h.counts.connect,0);
  const r=await deliver(h.client,{...options,holdDraft:true},h.deps);assert.equal(r.run_id,s.initial.id);assert.deepEqual(h.attempts.filter(e=>e.id===pending.id),[pending,pending]);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
});
for(const profile of ['webskill','future-ui','hub'])test(`fixed ${profile} delivery preserves Work Item/PR references and waits for independent Review`,async t=>{
  const h=await harness(t,{profile}),before=git(h.repo,['status','--porcelain']),result=await deliver(h.client,options,h.deps),events=h.events(result.run_id);
  assert.equal(result.authority_verified,false);assert.equal(result.disposition,'waiting_for_independent_review');assert.equal(h.counts.ready,1);
  assert.deepEqual(events.map(e=>e.type),['RUN_STARTED','STEP_STARTED','STEP_COMPLETED','VERIFICATION_STARTED','VERIFICATION_PASSED','GITHUB_PUSH_COMPLETED','GITHUB_PR_CREATED','HANDOFF_PUBLISHED','HANDOFF_PUBLISHED','HANDOFF_PUBLISHED']);
  assert.deepEqual(events.map(e=>e.sequence),Array.from({length:10},(_,i)=>i+1));assert.equal((await h.client.status()).run.state,'awaiting_review');
  assert.equal(JSON.parse(readFileSync(h.sessionPath())).work_item.reference.repository,'zlpoot/agent-workflow-hub');
  assert.equal(JSON.parse(readFileSync(h.sessionPath())).work_item.reference.number,profile==='hub'?22:profile==='webskill'?8:6);
  const handoffs=events.filter(e=>e.type==='HANDOFF_PUBLISHED');assert.deepEqual(handoffs.map(e=>e.payload.data.publication),['pending','confirmed','confirmed']);
  assert.equal(handoffs[0].payload.data.comment.number,handoffs[1].payload.data.comment.number);assert(handoffs[1].payload.extensions.evidence.length>0);
  assert(!JSON.stringify(events).includes('controlled fixture verification'));assert(!events.some(e=>/REVIEW|RUN_COMPLETED/.test(e.type)));
  assert.equal(git(h.repo,['status','--porcelain']),before);assert.equal(git(h.repo,['rev-parse','HEAD']),h.sha);
  await assert.rejects(h.client.finish(),e=>e.code==='review_gate');await assert.rejects(deliver(h.client,options,h.deps),e=>e.code==='delivery_state');assert.equal(h.counts.push,1);
});
test('hold Draft publishes confirmed Handoff but leaves acceptance and Review pending',async t=>{const h=await harness(t),r=await deliver(h.client,{...options,holdDraft:true},h.deps);assert.equal(h.counts.ready,0);assert(h.isDraft());assert.equal(h.events(r.run_id).at(-1).payload.extensions.builder_milestone,'waiting_for_human_acceptance');});
for(const profile of ['webskill','future-ui'])test(`C1-C ${profile}/default identity, old session and preserved DB coexist with new delivery`,async t=>{
  const h=await harness(t,{profile,legacyRef:true}),old=await h.client.start(21);await h.client.finish(true,{reason:'Controlled old runtime session; no delivery'});
  const oldEvents=h.events(old.run.id),oldSession=JSON.parse(readFileSync(h.sessionPath())),manifest=readFileSync(join(h.repo,'.awh/project.yaml'));
  assert.equal(oldSession.outbox,undefined);const r=await deliver(h.client,{...options,holdDraft:true},h.deps);
  assert.notEqual(r.run_id,old.run.id);assert.deepEqual(h.events(old.run.id),oldEvents);assert.deepEqual(JSON.parse(readFileSync(join(dirname(h.sessionPath()),old.run.id+'.json'))),oldSession);
  assert(manifest.equals(readFileSync(join(h.repo,'.awh/project.yaml'))));assert.equal((await h.client.status()).run.profile.ref,profile+'/default');
});
for(const kind of ['lost','malformed'])test(`post-push ${kind} ACK retains identical Event plus failure; explicit retry never repeats GitHub`,async t=>{
  const h=await harness(t);h.fault('GITHUB_PUSH_COMPLETED',kind);let error;try{await deliver(h.client,options,h.deps);}catch(e){error=e;}
  assert(error instanceof DeliveryError);assert.equal(error.stage,'push');assert.equal(h.counts.push,1);assert.equal(h.counts.pr,0);
  const state=JSON.parse(readFileSync(h.sessionPath())),pending=state.pending;assert.equal(pending.type,'GITHUB_PUSH_COMPLETED');assert.equal(state.outbox[0].type,'RUN_FAILED');
  const retried=await h.client.retryDelivery();assert.equal(retried.run.state,'failed');assert.equal(retried.github_operations_repeated,false);
  assert.deepEqual(h.attempts.filter(e=>e.id===pending.id),[pending,pending]);assert.equal(h.events(retried.run.id).filter(e=>e.type==='GITHUB_PUSH_COMPLETED').length,1);assert.equal(h.counts.push,1);
});
test('original sanitized Builder failure is authoritative even when its failure ACK is lost',async t=>{
  const h=await harness(t),original=new BuilderError('App HTTPS Git push failed','git_authentication','push',['known_installation_token']);h.builder.push=async()=>{throw original;};h.fault('RUN_FAILED');
  await assert.rejects(deliver(h.client,options,h.deps),e=>{assert.equal(e.original,original);assert.equal(deliveryDiagnostic(e).original.category,'git_authentication');return true;});
  const r=await h.client.retryDelivery();assert.equal(r.run.state,'failed');assert.equal(h.counts.pr,0);assert.equal(h.events(r.run.id).at(-1).payload.extensions.builder_stage,'push');
});
test('failed verification preserves nonzero original checks/logs and cannot reach push',async t=>{
  const h=await harness(t);h.deps.verify=async command=>({command,exit_code:7,stdout:'original failure output',stderr:'original failure diagnostic',elapsed_ms:1});
  await assert.rejects(deliver(h.client,options,h.deps),e=>e.original instanceof BuilderError);const s=await h.client.status(),events=h.events(s.run.id);assert.equal(events.at(-1).type,'VERIFICATION_FAILED');assert.equal(events.at(-1).payload.data.checks[0].exit_code,7);
  const log=JSON.parse(readFileSync(join(h.repo,'.handoff',s.run.id,'verification.json')));assert.equal(log.logs[0].stderr,'original failure diagnostic');assert.equal(h.counts.push,0);
});
test('lost verification-failure ACK keeps original nonzero Builder failure and identical pending result',async t=>{
  const h=await harness(t);h.deps.verify=async command=>({command,exit_code:9,stdout:'original failed output',stderr:'',elapsed_ms:1});h.fault('VERIFICATION_FAILED');
  await assert.rejects(deliver(h.client,options,h.deps),e=>e.original instanceof BuilderError&&e.original.message.includes('exit code 9'));
  const pending=JSON.parse(readFileSync(h.sessionPath())).pending;assert.equal(pending.type,'VERIFICATION_FAILED');assert.equal(pending.payload.data.checks[0].exit_code,9);
  const r=await h.client.retryDelivery();assert.equal(r.run.state,'failed');assert.deepEqual(h.attempts.filter(e=>e.id===pending.id),[pending,pending]);assert.equal(h.counts.push,0);
});
test('unignored evidence directory is rejected before Run or Builder creation',async t=>{
  const h=await harness(t);writeFileSync(join(h.repo,'.gitignore'),'');git(h.repo,['add','.gitignore']);git(h.repo,['commit','-m','remove ignore in fixture']);
  await assert.rejects(deliver(h.client,options,h.deps),e=>e.code==='delivery_logs');assert.equal(h.counts.connect,0);assert.equal((await h.client.status()).run,null);
});
test('credential-bearing verification output fails closed and is not persisted or published',async t=>{
  const h=await harness(t),secret='github_pat_fixture_secret';h.deps.verify=async command=>({command,exit_code:0,stdout:secret,stderr:'',elapsed_ms:1});
  await assert.rejects(deliver(h.client,options,h.deps));const s=await h.client.status();assert.equal(s.run.state,'failed');assert(!readFileSync(join(h.repo,'.handoff',s.run.id,'verification.json'),'utf8').includes(secret));assert.equal(h.counts.push,0);
});
test('exact-head change during verification prevents push and emits RUN_FAILED without a false pass',async t=>{
  const h=await harness(t);h.deps.verify=async command=>{writeFileSync(join(h.repo,'source.txt'),'changed');return{command,exit_code:0,stdout:'',stderr:'',elapsed_ms:1};};await assert.rejects(deliver(h.client,options,h.deps));
  const s=await h.client.status();assert.equal(s.run.state,'failed');assert.equal(h.counts.push,0);assert(!h.events(s.run.id).some(e=>e.type==='VERIFICATION_PASSED'));
});
test('CP command/ref mismatch fails before Builder credential access or verification',async t=>{
  const h=await harness(t,{policyChanges:{verification:{commands:['arbitrary shell command']}}});await assert.rejects(deliver(h.client,options,h.deps),e=>e.code==='delivery_policy');assert.deepEqual(h.counts,{connect:0,verify:0,push:0,pr:0,ready:0,restore:0});
});
test('lost post-Ready observation restores Draft and leaves an explicit stopped Run',async t=>{
  const h=await harness(t);h.fault('pr_ready_waiting_for_independent_review');await assert.rejects(deliver(h.client,options,h.deps));assert.equal(h.counts.ready,1);assert.equal(h.counts.restore,1);assert(h.isDraft());
  const r=await h.client.retryDelivery();assert.equal(r.run.state,'failed');assert.equal(h.counts.ready,1);
});
test('long raw logs publish bounded separate App evidence comments, references only in Events',async t=>{
  const h=await harness(t);h.deps.verify=async command=>({command,exit_code:0,stdout:'log '.repeat(30000),stderr:'',elapsed_ms:1});const r=await deliver(h.client,{...options,holdDraft:true},h.deps);
  const evidence=[...h.comments.values()].filter(body=>body.startsWith('Builder evidence\n'));assert(evidence.length>1);assert(evidence.every(body=>body.length<60000));
  assert.equal(h.events(r.run_id).find(e=>e.type==='HANDOFF_PUBLISHED').payload.extensions.evidence.length,evidence.length);
});


const observed = h => ({ repository:h.policy.repository,pull_request:31,head_sha:h.sha,state:'open',merged:false,merge_sha:null,issue:8,issue_repository:'zlpoot/agent-workflow-hub',issue_closed:false,review:null,changes_requested:false,authority_verified:false });
test('MVP sync records native exact-head Review, waits for merge/close then completes once; Timeline agrees',async t=>{
  const h=await harness(t);const result=await deliver(h.client,{...options,holdDraft:true},h.deps);let facts=observed(h);
  const connect=async()=>({...h.builder,readLifecycle:async()=>facts});
  assert.equal((await h.client.syncDelivery(connect)).run.state,'awaiting_review');assert.equal(h.events(result.run_id).length,10);
  facts={...facts,review:{id:901,login:'chatgpt-reviewer',subject_sha:h.sha,url:'https://github.com/zlpoot/webskill/pull/31#pullrequestreview-901'}};
  assert.equal((await h.client.syncDelivery(connect)).run.state,'review_passed');
  facts={...facts,merged:true,merge_sha:'c'.repeat(40),state:'closed'};assert.equal((await h.client.syncDelivery(connect)).run.state,'review_passed');
  facts={...facts,issue_closed:true};assert.equal((await h.client.syncDelivery(connect)).run.state,'completed');
  const events=h.events(result.run_id),timeline=await h.client.timeline();assert.deepEqual(timeline.events.map(x=>x.event),events);
  assert.deepEqual(events.slice(-3).map(x=>x.type),['REVIEW_STARTED','REVIEW_PASSED','RUN_COMPLETED']);
  await h.client.syncDelivery(connect);assert.deepEqual(h.events(result.run_id),events);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
});
for(const type of ['REVIEW_STARTED','REVIEW_PASSED','RUN_COMPLETED'])test('MVP '+type+' lost ACK retries the same Event without GitHub writes',async t=>{
  const h=await harness(t);const r=await deliver(h.client,{...options,holdDraft:true},h.deps);
  const facts={...observed(h),review:{id:901,login:'chatgpt-reviewer',subject_sha:h.sha,url:'https://github.com/zlpoot/webskill/pull/31#pullrequestreview-901'},merged:true,merge_sha:'c'.repeat(40),state:'closed',issue_closed:true};
  const connect=async()=>({...h.builder,readLifecycle:async()=>facts});h.fault(type);
  await assert.rejects(h.client.syncDelivery(connect));const pending=JSON.parse(readFileSync(h.sessionPath())).pending;assert.equal(pending.type,type);
  await h.client.retryDelivery();await h.client.syncDelivery(connect);
  assert.equal((await h.client.status()).run.state,'completed');assert.deepEqual(h.attempts.filter(e=>e.id===pending.id),[pending,pending]);
  assert.equal(h.events(r.run_id).filter(e=>e.type===type).length,1);assert.equal(h.counts.push,1);assert.equal(h.counts.pr,1);
});
test('MVP pending/blocked Review never manufactures completion and changed local source prevents sync',async t=>{
  const h=await harness(t);await deliver(h.client,{...options,holdDraft:true},h.deps);
  const facts={...observed(h),merged:true,issue_closed:true,changes_requested:true};const connect=async()=>({...h.builder,readLifecycle:async()=>facts});
  assert.equal((await h.client.syncDelivery(connect)).run.state,'awaiting_review');
  writeFileSync(join(h.repo,'source.txt'),'new source');await assert.rejects(h.client.syncDelivery(connect),e=>e.code==='exact_head');
});
