import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfflineOnboardingApi, OfflineOnboardingStore, OfflineAdmission, OFFLINE_LIMITS, boundedRequest,
  MockFixtureTransport, createOfflineFixture, destroyOfflineFixture, fixtureDatabase, mockOperator } from '../dist/onboarding/index.js';
import { ControlPlaneStore } from '../dist/control-plane/index.js';
const sample=JSON.parse(readFileSync(new URL('../examples/protocol/future-ui.json',import.meta.url)));
const START=Date.parse('2026-10-08T00:00:00Z');
function setup(t) {
  const fixture=createOfflineFixture(), identity=mockOperator('b0-owner','operator',['zlpoot/future-ui'],START+3600000);
  const config={service:{service_id:'b0-fixture',endpoint:'http://127.0.0.1:48103',ca_sha256:null,operator_origin:'http://127.0.0.1:48104'},
    operators:[identity.session],profiles:[sample.profile_policy],reserved_projects:[],reserved_clients:[]};
  const clock={value:START}, store=new OfflineOnboardingStore(fixture,config,()=>clock.value), transport=new MockFixtureTransport();
  const api=new OfflineOnboardingApi(store,transport), channel=transport.operator(config.service.operator_origin);
  const stores=[store];
  t.after(()=>{for(const s of stores)try{s.close();}catch{} destroyOfflineFixture(fixture);});
  const headers={host:'127.0.0.1:48104',cookie:'awh_operator='+identity.cookie,origin:config.service.operator_origin};
  const get=(path='/onboarding/v1/nonce',changes={})=>api.handle({method:'GET',path,headers:{...headers,...changes}},channel);
  const raw=()=>new DatabaseSync(fixtureDatabase(fixture),{allowExtension:false});
  const rows=()=>{const d=raw();try{return Number(d.prepare('SELECT COUNT(*) AS n FROM audit').get().n);}finally{d.close();}};
  const sizes=()=>['','-wal','-shm'].map(s=>{try{return statSync(fixtureDatabase(fixture)+s).size;}catch{return 0;}});
  const reopen=()=>{const s=new OfflineOnboardingStore(fixture,config,()=>clock.value);stores.push(s);return new OfflineOnboardingApi(s,transport);};
  return {fixture,config,clock,store,api,transport,channel,headers,get,raw,rows,sizes,reopen,identity};
}
test('B0 anonymous multi-channel flood aggregates in bounded memory with zero DB/WAL/audit writes',async t=>{
  const f=setup(t), before=f.sizes(), audit=f.rows();
  const bytes=()=>['','-wal'].map(s=>createHash('sha256').update(readFileSync(fixtureDatabase(f.fixture)+s)).digest('hex'));
  const beforeBytes=bytes();
  for(let i=0;i<10000;i++){
    const r=await f.api.handle({method:'GET',path:'/onboarding/v1/nonce',headers:{}},Object.freeze({}));
    assert([401,429].includes(r.status)); assert.equal(r.body.authority_verified,false);
  }
  assert.deepEqual(f.sizes(),before); assert.equal(f.rows(),audit);
  assert.deepEqual(bytes(),beforeBytes);
  const dto=f.api.safetyDiagnostics();
  assert(dto.lanes.anonymous.requests<=64); assert.equal(dto.lanes.anonymous.identities,0);
  assert.equal(dto.lanes.anonymous.inflight,0); assert.equal(dto.state,'not_checked');
  assert(!JSON.stringify(dto).includes(f.identity.cookie));
  // Independent Operator budget still works after anonymous exhaustion.
  assert.equal((await f.get()).status,200);
  for(let i=0;i<1000;i++)f.store.recordDenied('attacker-controlled-secret-'+i);
  assert.equal(f.rows(),audit+1); assert(!JSON.stringify(f.api.safetyDiagnostics()).includes('attacker-controlled'));
});
test('B0 invalid Origin, missing Cookie, giant/complex/accessor/Unicode bodies and headers never write DB',async t=>{
  const f=setup(t), before=f.sizes(), n=f.rows();
  const evil={};Object.defineProperty(evil,'x',{enumerable:true,get(){throw Error('must not execute');}});
  const cookieArray=[f.headers.cookie];Object.defineProperty(cookieArray,'toString',{get(){throw Error('must not execute');}});
  for(const request of [
    {method:'POST',path:'/onboarding/v1/requests',headers:{...f.headers,origin:'http://evil.invalid'},body:{}},
    {method:'GET',path:'/onboarding/v1/nonce',headers:{host:'127.0.0.1:48104'}},
    {method:'GET',path:'/onboarding/v1/nonce',headers:{...f.headers,cookie:cookieArray}},
    {method:'POST',path:'/onboarding/v1/requests',headers:f.headers,body:{x:'z'.repeat(1000000)}},
    {method:'POST',path:'/onboarding/v1/requests',headers:f.headers,body:{x:'\u0001'.repeat(20000)}},
    {method:'POST',path:'/onboarding/v1/requests',headers:f.headers,body:{x:'😀'.repeat(17000)}},
    {method:'POST',path:'/onboarding/v1/requests',headers:f.headers,body:{x:Array(1500).fill(0)}},
    {method:'POST',path:'/onboarding/v1/requests',headers:f.headers,body:evil},
    {method:'GET',path:'/onboarding/v1/nonce',headers:{...f.headers,x:Array(50000).fill('x')}},
    {method:'GET',path:'/onboarding/v1/nonce',headers:Object.fromEntries(Array.from({length:65},(_,i)=>['x'+i,'x']))}
  ]){
    const r=await f.api.handle(request,f.channel);assert(r.status>=400);
    assert.equal(JSON.stringify(r).includes('evil.invalid'),false);
  }
  assert.deepEqual(f.sizes(),before);assert.equal(f.rows(),n);
  const circular={};circular.x=circular;assert.throws(()=>boundedRequest({method:'POST',path:'/',headers:{},body:circular}));
});
test('B0 shared store admission survives multiple dispatcher instances; per-session errors retain fail-closed',async t=>{
  const f=setup(t), second=new OfflineOnboardingApi(f.store,f.transport), before=f.rows();
  for(let i=0;i<64;i++)assert.equal((await (i%2?second:f.api).handle({method:'GET',path:'/onboarding/v1/audit',headers:f.headers},f.channel)).status,200);
  assert.equal((await f.get('/onboarding/v1/audit')).status,429);assert.equal(f.rows(),before);
});
test('B0 admission rejects high concurrency, identity hopping, backward/invalid clocks and caps aggregate cardinality',()=>{
  let clock=1000;const gate=new OfflineAdmission(()=>clock), holds=[];
  for(let i=0;i<8;i++)holds.push(gate.enter('operator','known'));
  assert.throws(()=>gate.enter('operator','other'),e=>e.status===429);
  for(const done of holds){done();done();}
  for(let i=0;i<64;i++){const done=gate.enter('pairing','trusted-'+i);done();}
  assert.throws(()=>gate.enter('pairing','65th'),e=>e.status===429);
  const before=JSON.stringify(gate.snapshot());clock=999;assert.throws(()=>gate.enter('anonymous'),e=>e.status===500);
  clock=NaN;assert.throws(()=>gate.enter('anonymous'),e=>e.status===500);assert.equal(JSON.stringify(gate.snapshot()),before);
  for(let i=0;i<1000010;i++)gate.denied('anonymous',403);
  assert.equal(gate.snapshot().lanes.anonymous.denied.access,1000000);
  clock=2000;gate.enter('pairing','new')();assert.equal(gate.snapshot().lanes.pairing.identities,1);
  assert.equal(gate.snapshot().lanes.operator.inflight,0);
});
test('B0 SQLite busy fails within bounded timeout; anonymous requests never wait for locked writer',async t=>{
  const f=setup(t), db=f.raw();db.exec('BEGIN IMMEDIATE');
  try{
    const started=performance.now();const r=await f.get();assert.equal(r.status,503);assert(performance.now()-started<500);
    const begin=performance.now();
    for(let i=0;i<1000;i++)assert((await f.api.handle({method:'GET',path:'/no-route',headers:{}},{})).status>=400);
    assert(performance.now()-begin<1000);assert.equal(f.rows(),0);
  }finally{db.exec('ROLLBACK');db.close();}
  assert.equal((await f.get()).status,200);
});
test('B0 audit quota is persistent, immutable and transactional at saturation including restart',async t=>{
  const f=setup(t), db=f.raw();
  db.exec('BEGIN IMMEDIATE');
  const insert=db.prepare("INSERT INTO audit(at,actor,action,target,project_id,repository,result,code) VALUES(?, 'b0-seed','fixture_seed','fixture',NULL,NULL,'accepted','ok')");
  for(let i=0;i<OFFLINE_LIMITS.audit_rows;i++)insert.run(new Date(START).toISOString());
  db.exec('COMMIT');
  assert.throws(()=>db.exec('DELETE FROM audit'));assert.throws(()=>db.exec("UPDATE audit SET code='removed'"));
  db.close();
  const r=await f.get();assert.equal(r.status,503);assert.equal(r.body.error.code,'audit_limit');
  assert.equal(f.rows(),8192);
  const probe=f.raw();assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM nonces').get().n,0);probe.close();
  const before=f.sizes(),path=fixtureDatabase(f.fixture);
  const bytesBefore=['','-wal'].map(s=>createHash('sha256').update(readFileSync(path+s)).digest('hex'));
  f.clock.value+=1000;
  for(let attempt=0;attempt<3;attempt++)assert.throws(()=>f.reopen(),e=>e.status===503 && e.code==='audit_limit');
  assert.deepEqual(f.sizes(),before);
  assert.deepEqual(['','-wal'].map(s=>createHash('sha256').update(readFileSync(path+s)).digest('hex')),bytesBefore);
  const restartProbe=f.raw();assert.equal(restartProbe.prepare('SELECT clock FROM fixture_metadata WHERE id=1').get().clock,START);restartProbe.close();
  assert.equal(f.rows(),8192);
});
test('B0 transaction rolls back business state when mandatory audit cannot fit',async t=>{
  const f=setup(t), db=f.raw();
  db.exec('BEGIN IMMEDIATE');
  const insert=db.prepare("INSERT INTO audit(at,actor,action,target,result,code) VALUES(?,'seed','fixture_seed','fixture','accepted','ok')");
  for(let i=0;i<OFFLINE_LIMITS.audit_rows-1;i++)insert.run(new Date(START).toISOString());
  db.exec('COMMIT');db.close();
  // Last audit slot is consumed by nonce; following mutation is closed, never unaudited.
  const nonce=await f.get();assert.equal(nonce.status,200);
  const result=await f.api.handle({method:'POST',path:'/onboarding/v1/requests',headers:{...f.headers,'content-type':'application/json','x-awh-nonce':nonce.body.nonce},
    body:{project_id:'b0-project',repository:'zlpoot/future-ui',profile_ref:sample.profile_policy.ref,profile_version:sample.profile_policy.version}},f.channel);
  assert.equal(result.status,503);const probe=f.raw();assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM requests').get().n,0);probe.close();
});
test('B0 synthetic CP Event cursor/latency remain independent during 10000 anonymous denials',async t=>{
  const f=setup(t), cpFixture=createOfflineFixture();
  const path=join(cpFixture.directory,'b0-cp-v2.sqlite'), config=join(cpFixture.directory,'b0-cp-trusted.json');
  let cp;t.after(()=>{cp?.close();destroyOfflineFixture(cpFixture);});
  writeFileSync(config,JSON.stringify({profiles:[sample.profile_policy],clients:[{
    id:'b0-synthetic',token_sha256:'a'.repeat(64),project_ids:[sample.project.id],executor_ids:[sample.executor.id]
  }]}));
  const initialized=spawnSync(process.execPath,[fileURLToPath(new URL('../dist/control-plane-cli.js',import.meta.url)),
    'init','--database',path,'--config',config],{encoding:'utf8',timeout:10000});
  assert.equal(initialized.status,0,initialized.stderr);assert.match(initialized.stdout,/no listener started/);
  cp=new ControlPlaneStore(path,[sample.profile_policy],undefined,'existing');
  const principal={id:'b0-synthetic',project_ids:[sample.project.id],executor_ids:[sample.executor.id]};
  cp.registerProject(principal,sample.manifest);cp.registerExecutor(principal,sample.executor);cp.registerWorkItem(principal,sample.work_item);cp.createRun(principal,sample.run);
  const latency=[],baseline=[],before=f.sizes();
  const append=sequence=>{
    const event={schema_version:'1.0',kind:'event',id:'b0-event-'+sequence,run_id:sample.run.id,sequence,
      type:sequence===1?'RUN_STARTED':'STEP_STARTED',occurred_at:new Date(START+sequence*1000).toISOString(),
      payload:{schema_version:'1.0',data:sequence===1?{source_sha:sample.run.source.sha}:{step_id:'b0-step-'+sequence,name:'fixture'},extensions:{}}};
    const start=performance.now();cp.append(principal,sample.run.id,event);return performance.now()-start;
  };
  for(let sequence=1;sequence<=5;sequence++)baseline.push(append(sequence));
  for(let batch=1;batch<=25;batch++){
    await Promise.all(Array.from({length:400},()=>f.api.handle({method:'GET',path:'/unknown',headers:{}},{})));
    latency.push(append(batch+5));
  }
  assert.equal(cp.listEvents(principal,sample.run.id).length,30);
  assert(latency.every(ms=>Number.isFinite(ms)&&ms>=0));
  assert.deepEqual(f.sizes(),before);assert.equal(f.rows(),0);
  console.log(JSON.stringify({source:'synthetic_fixture',event_count:30,last_cursor:cp.listEvents(principal,sample.run.id).at(-1).cursor,
    baseline_write_max_ms:Math.max(...baseline),baseline_write_mean_ms:baseline.reduce((a,b)=>a+b)/5,
    event_write_max_ms:Math.max(...latency),event_write_mean_ms:latency.reduce((a,b)=>a+b)/25,
    latency_disposition:'OBSERVED_ONLY_NO_PRODUCTION_SLA',real_cp:'NOT_RUN'}));
});

test('B0 physical journal/storage bound blocks new writes without truncating existing state',async t=>{
  const f=setup(t), path=fixtureDatabase(f.fixture)+'-journal', db=f.raw();
  const pages=db.prepare('PRAGMA page_count').get().page_count, pageSize=db.prepare('PRAGMA page_size').get().page_size;
  db.close();assert(pages*pageSize<OFFLINE_LIMITS.storage_bytes);
  writeFileSync(path,Buffer.alloc(OFFLINE_LIMITS.storage_bytes));
  try{
    const result=await f.get();assert.equal(result.status,503);assert.equal(result.body.error.code,'storage_limit');
    assert.equal(statSync(path).size,OFFLINE_LIMITS.storage_bytes);
  }finally{unlinkSync(path);}
  assert.equal(f.rows(),0);assert.equal((await f.get()).status,200);
});

test('B0 in-process authentication expiry resists rollback; persisted fixture clock floor survives restart',async t=>{
  const f=setup(t);
  f.clock.value+=3600000;
  assert.equal((await f.get()).status,401);
  f.clock.value=START;
  assert.equal((await f.get()).status,401);
  // Internal fixture operation persists the already-observed floor; it does not authenticate a session.
  f.clock.value=START+3500000;
  f.store.nonce({...f.identity.session});
  f.store.close();f.clock.value=START;
  const restored=f.reopen();
  assert.equal(f.clock.value,START);
  assert.equal((await restored.handle({method:'GET',path:'/onboarding/v1/nonce',headers:f.headers},f.channel)).status,401);
});

test('B0 two SQLite workers compete for the final immutable audit slot with exactly one transaction admitted',async t=>{
  const f=setup(t), db=f.raw();
  const insert=db.prepare("INSERT INTO audit(at,actor,action,target,result,code) VALUES(?,'seed','fixture_seed','fixture','accepted','ok')");
  db.exec('BEGIN IMMEDIATE');for(let i=0;i<OFFLINE_LIMITS.audit_rows-1;i++)insert.run(new Date(START).toISOString());db.exec('COMMIT');db.close();
  const barrier=new SharedArrayBuffer(4);
  const workers=Array.from({length:2},()=>new Worker(new URL('./fixtures/onboarding-b0-quota-worker.mjs',import.meta.url),
    {workerData:{fixture:f.fixture,config:f.config,now:START,barrier,headers:f.headers}}));
  try{
    await Promise.all(workers.map(w=>once(w,'message')));
    const results=workers.map(w=>once(w,'message').then(([value])=>value.status));
    Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0,2);
    assert.deepEqual((await Promise.all(results)).sort(),[200,503]);assert.equal(f.rows(),8192);
    const probe=f.raw();assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM nonces').get().n,1);probe.close();
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
});

test('B0 review: sparse/huge arrays are blocked before own-key walking or later serialization',async t=>{
  const f=setup(t), before=f.sizes(), sparse=[];
  sparse.length=0xffffffff;
  // Prove the length gate runs before Reflect.ownKeys/serialization.
  let walked=0;const huge=new Proxy(sparse,{ownKeys(){walked++;throw Error('must not walk');}});
  for(const array of [huge,Array(2),[,1],Object.assign([1],{extra:2})]){
    assert.throws(()=>boundedRequest({method:'POST',path:'/onboarding/v1/requests',headers:f.headers,body:{array}}),
      e=>e.status===400);
    const r=await f.api.handle({method:'POST',path:'/onboarding/v1/requests',headers:f.headers,body:{array}},f.channel);
    assert.equal(r.status,400);
  }
  assert.equal(walked,0);assert.deepEqual(f.sizes(),before);assert.equal(f.rows(),0);
  assert.doesNotThrow(()=>boundedRequest({method:'POST',path:'/',headers:{},body:{array:[null,1,true,'fixture']}}));
});

test('B0 review: anonymous admission stops traversal and authentication before over-limit input',async t=>{
  const f=setup(t);
  let authCalls=0,walks=0;
  const original=f.store.authenticationTime.bind(f.store);
  f.store.authenticationTime=()=>{authCalls++;return original();};
  for(let i=0;i<64;i++)assert.equal((await f.api.handle({method:'GET',path:'/onboarding/v1/nonce',headers:{}},f.channel)).status,401);
  const atLimit=authCalls,body=new Proxy({},{ownKeys(){walks++;throw Error('must not walk');}});
  for(let i=0;i<1000;i++){
    const r=await f.api.handle({method:'POST',path:'/onboarding/v1/requests',headers:{},body},f.channel);
    assert.equal(r.status,429);assert.equal(r.body.error.code,'admission_limit');
  }
  assert.equal(walks,0);assert.equal(authCalls,atLimit);assert.equal(f.rows(),0);
  // Authenticated Operator and trusted Pairing channel do not use exhausted anonymous quota.
  assert.equal((await f.get()).status,200);
  const scope={project_id:'b0-project',repository:sample.profile_policy.repository,profile_ref:sample.profile_policy.ref,profile_version:sample.profile_policy.version,
    client_id:'b0-client',executor_id:'b0-executor',executor_type:'codex',machine_id:'b0-machine',platform:'windows',
    service_id:f.config.service.service_id,endpoint:f.config.service.endpoint,ca_sha256:null};
  const client=f.transport.client(scope,'pre-admission-pairing');
  const pairing=await f.api.handle({method:'POST',path:'/pairing/v1/claim',headers:{}},client.channel);
  assert.equal(pairing.status,400); // content-type rejected by normal security checks, not anonymous admission
  assert.equal(f.api.safetyDiagnostics().lanes.pairing.requests,1);
});

test('B0 review: operator and pairing lane exhaustion also precede traversal/expensive authentication',async t=>{
  const f=setup(t);
  for(let i=0;i<256;i++)f.store.admission.enter('operator')();
  let walks=0,authCalls=0;
  f.store.authenticationTime=()=>{authCalls++;throw Error('must not authenticate');};
  const body=new Proxy({},{ownKeys(){walks++;throw Error('must not traverse');}});
  assert.equal((await f.api.handle({method:'POST',path:'/onboarding/v1/requests',headers:f.headers,body},f.channel)).status,429);
  assert.equal(authCalls,0);assert.equal(walks,0);
});

test('B0 review: unknown Operator-shaped cookies stay anonymous; per-identity quota blocks full authentication',async t=>{
  const f=setup(t);
  for(let i=0;i<64;i++)assert.equal((await f.get('/onboarding/v1/audit',{cookie:'awh_operator=awh_op_'+randomBytes(32).toString('base64url')})).status,401);
  assert.equal((await f.get('/onboarding/v1/audit')).status,200);
  let authenticated=0,walked=0;const original=f.store.authenticationTime.bind(f.store);
  f.store.authenticationTime=()=>{authenticated++;return original();};
  for(let i=0;i<63;i++)assert.equal((await f.get('/onboarding/v1/audit')).status,200);
  const atLimit=authenticated,body=new Proxy({},{ownKeys(){walked++;throw Error('must not traverse');}});
  assert.equal((await f.api.handle({method:'POST',path:'/onboarding/v1/requests',headers:f.headers,body},f.channel)).status,429);
  assert.equal(authenticated,atLimit);assert.equal(walked,0);
});

test('B0 review: near storage quota is checked under the writer lock while a concurrent connection is blocked',async t=>{
  const f=setup(t), journal=fixtureDatabase(f.fixture)+'-journal', barrier=new SharedArrayBuffer(4), probeBarrier=new SharedArrayBuffer(4);
  writeFileSync(journal,Buffer.alloc(OFFLINE_LIMITS.storage_bytes-1));
  const worker=new Worker(new URL('./fixtures/onboarding-b0-quota-worker.mjs',import.meta.url),
    {workerData:{fixture:f.fixture,config:f.config,now:START,barrier,headers:f.headers,storage_probe:probeBarrier}});
  try{
    const [ready]=await once(worker,'message');assert.equal(ready.ready,true);
    const probing=once(worker,'message');
    Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0);
    const [probe]=await probing;assert.equal(probe.storage_probe,true);
    const db=f.raw();
    try {assert.throws(()=>db.exec('BEGIN IMMEDIATE'),e=>e.errcode===5);}
    finally {try{db.exec('ROLLBACK');}catch{} db.close();}
    // This changes the synthetic journal while the worker owns SQLite's write lock, before its stat.
    writeFileSync(journal,Buffer.alloc(OFFLINE_LIMITS.storage_bytes));
    const result=once(worker,'message');
    Atomics.store(new Int32Array(probeBarrier),0,1);Atomics.notify(new Int32Array(probeBarrier),0);
    const [r]=await result;assert.equal(r.status,503);assert.equal(r.code,'storage_limit');
    assert.equal(f.rows(),0);
  }finally{
    Atomics.store(new Int32Array(probeBarrier),0,1);Atomics.notify(new Int32Array(probeBarrier),0);
    await worker.terminate();unlinkSync(journal);
  }
});

test('B0 review: storage-saturated restarts fail before metadata writes and preserve existing DB/WAL',t=>{
  const f=setup(t), path=fixtureDatabase(f.fixture),journal=path+'-journal';
  const before=['','-wal'].map(s=>createHash('sha256').update(readFileSync(path+s)).digest('hex'));
  writeFileSync(journal,Buffer.alloc(OFFLINE_LIMITS.storage_bytes));
  f.clock.value+=60000;
  try{
    for(let i=0;i<3;i++)assert.throws(()=>f.reopen(),e=>e.status===503 && e.code==='storage_limit');
    assert.deepEqual(['','-wal'].map(s=>createHash('sha256').update(readFileSync(path+s)).digest('hex')),before);
  }finally{unlinkSync(journal);}
  const db=f.raw();assert.equal(db.prepare('SELECT clock FROM fixture_metadata WHERE id=1').get().clock,START);db.close();
});
