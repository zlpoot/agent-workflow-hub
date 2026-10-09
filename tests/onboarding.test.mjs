import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, readdirSync, linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createAuthenticator, ControlPlaneStore, DashboardReadStore } from '../dist/control-plane/index.js';
import { OfflineOnboardingApi, OfflineOnboardingStore, MockFixtureTransport, createOfflineFixture, destroyOfflineFixture, fixtureDatabase, mockOperator, canonical, doctorDiagnosticContract } from '../dist/onboarding/index.js';
const example = name => JSON.parse(readFileSync(new URL('../examples/protocol/'+name+'.json',import.meta.url)));
const future = example('future-ui'), webskill = example('webskill');
const START = Date.parse('2026-10-08T08:00:00.000Z');
const binding = {project_id:'fixture-onboard-future',repository:'zlpoot/future-ui',profile_ref:'future-ui/default',profile_version:'fixture-v1'};
const service = {service_id:'fixture-service',endpoint:'https://cp.fixture.invalid',ca_sha256:'a'.repeat(64),operator_origin:'http://127.0.0.1:47831'};
const scope = {...binding,client_id:'fixture-new-client',executor_id:'fixture-new-executor',executor_type:'codex',machine_id:'fixture-new-machine',platform:'windows',service_id:service.service_id,endpoint:service.endpoint,ca_sha256:service.ca_sha256};
function setup(t, changes={}) {
  const fixture=createOfflineFixture(), time={value:START};
  const owner=mockOperator('fixture-operator','operator',['zlpoot/future-ui','zlpoot/webskill'],START+3_600_000);
  const requester=mockOperator('fixture-requester','requester',['zlpoot/future-ui'],START+3_600_000);
  const narrow=mockOperator('fixture-narrow','operator',['zlpoot/webskill'],START+3_600_000);
  const config={service,profiles:[future.profile_policy,webskill.profile_policy],operators:[owner.session,requester.session,narrow.session],reserved_projects:[],reserved_clients:[],...changes};
  const stores=[], cleanup=[], open=()=>{ const s=new OfflineOnboardingStore(fixture,config,()=>time.value);stores.push(s);return s; };
  const transport=new MockFixtureTransport(), operatorChannel=transport.operator(service.operator_origin);
  const store=open(), api=new OfflineOnboardingApi(store,transport);
  t.after(async()=>{for(const close of cleanup.reverse())await close();for(const s of stores)try{s.close();}catch{} destroyOfflineFixture(fixture);});
  const headers=(identity=owner)=>({host:new URL(service.operator_origin).host,cookie:'awh_operator='+identity.cookie,origin:service.operator_origin,'sec-fetch-site':'same-origin'});
  const get=(path,identity=owner,extra={},channel=operatorChannel,instance=api)=>instance.handle({method:'GET',path,headers:{...headers(identity),...extra}},channel);
  const post=async(path,body,identity=owner,extra={},channel=operatorChannel,instance=api)=>{
    const nonce=await get('/onboarding/v1/nonce',identity,{},operatorChannel,instance);assert.equal(nonce.status,200);
    return instance.handle({method:'POST',path,body,headers:{...headers(identity),'content-type':'application/json','x-awh-nonce':nonce.body.nonce,...extra}},channel);
  };
  const apply=async(requested=binding,identity=requester)=>{const r=await post('/onboarding/v1/requests',requested,identity);assert.equal(r.status,200);return r.body;};
  const approve=async(requested=binding)=>{const r=await apply(requested);const decision=await post('/onboarding/v1/requests/'+r.id+'/decision',{decision:'approve'});assert.equal(decision.status,200);return decision.body;};
  let deliveryNumber=0;
  const invite=async(scoped=scope,options={})=>{const delivery_id='delivery-'+(++deliveryNumber),client=transport.client(scoped,delivery_id,options);
    const result=await post('/onboarding/v1/invitations',{...scoped,delivery_id});return {client,result};};
  const raw=()=>new DatabaseSync(fixtureDatabase(fixture),{allowExtension:false});
  const count=table=>{const db=raw();try{return Number(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n);}finally{db.close();}};
  return {fixture,time,config,owner,requester,narrow,store,api,open,transport,operatorChannel,headers,get,post,apply,approve,invite,raw,count,cleanup};
}
const blocked=(result,status)=>{assert.equal(result.status,status);assert.equal(result.body.authority_verified,false);assert.equal(result.body.source,'offline_fixture');assert.equal(typeof result.body.error.code,'string');};

test('B0 doctor DTO projects only fixed states, sources and safe steps; never claims live authority',async t=>{
  const f=setup(t);await f.apply();
  const pending=await f.get('/onboarding/v1/projects/'+binding.project_id+'/diagnostics');assert.equal(pending.status,200);
  const dto=doctorDiagnosticContract(pending.body);
  assert.deepEqual(Object.keys(dto).sort(),['authority_verified','checks','source','state']);
  assert.equal(dto.state,'blocked');assert.equal(dto.checks.enrollment.safe_next_step,'request_operator_enrollment');
  for(const check of Object.values(dto.checks)){
    assert.equal(check.source,'offline_fixture');assert.equal(check.authority_verified,false);
    assert.deepEqual(Object.keys(check).sort(),['authority_verified','code','safe_next_step','source','state']);
  }
  for(const value of [binding.project_id,binding.repository,service.endpoint,f.owner.cookie,future.profile_policy.branch.ref])
    assert.equal(JSON.stringify(dto).includes(value),false);
  await f.approve();const {client,result}=await f.invite();assert.equal(result.status,200);assert.equal((await client.claim(f.api)).status,200);
  const active=doctorDiagnosticContract((await client.diagnostics(f.api)).body);
  assert.equal(active.state,'not_checked');assert.equal(active.checks.enrollment.state,'passed');
  assert.equal(active.checks.client.safe_next_step,'none');
  for(const name of ['git_identity','branch_verification','provider_app_permissions'])assert.equal(active.checks[name].state,'not_checked');
  const forged=structuredClone(pending.body);forged.checks.provider_app_permissions={state:'passed',code:'no_live_preflight'};
  assert.throws(()=>doctorDiagnosticContract(forged),e=>e.code==='diagnostic_projection');
  forged.checks.provider_app_permissions={state:'not_checked',code:'attacker_controlled'};
  assert.throws(()=>doctorDiagnosticContract(forged),e=>e.code==='diagnostic_projection');
  assert.throws(()=>doctorDiagnosticContract({...pending.body,source:'live'}));
  assert.throws(()=>doctorDiagnosticContract({...pending.body,token:'forbidden'}));
  blocked(await f.get('/onboarding/v1/projects/'+binding.project_id+'/diagnostics',f.narrow),403);
});

test('offline vertical slice: request → approval → private invitation → one-use claim → persisted trusted scope → safe diagnostics',async t=>{
  const f=setup(t), requested=await f.apply();assert.equal(requested.state,'pending');
  const before=await f.get('/onboarding/v1/projects/'+binding.project_id+'/diagnostics');assert.equal(before.body.state,'blocked');assert.equal(f.count('project_bindings'),0);
  const approved=await f.post('/onboarding/v1/requests/'+requested.id+'/decision',{decision:'approve'});assert.equal(approved.body.state,'approved');
  const {client,result}=await f.invite();assert.equal(result.status,200);assert.equal(result.body.state,'active');
  assert.deepEqual(Object.keys(result.body).sort(),['attempts_remaining','authority_verified','expires_at','id','project_id','source','state']);
  assert.equal(client.containsSecret(JSON.stringify(result)),false);
  const claim=await client.claim(f.api);assert.equal(claim.status,200);assert.equal(claim.body.git_identity,'client_local_claim');assert.equal(f.count('clients'),1);
  const diagnostic=await client.diagnostics(f.api);assert.equal(diagnostic.status,200);assert.equal(diagnostic.body.state,'not_checked');
  assert.equal(diagnostic.body.checks.provider_app_permissions.state,'not_checked');assert.equal(diagnostic.body.checks.branch_verification.state,'not_checked');
  assert.equal(diagnostic.body.checks.git_identity.state,'not_checked');assert.equal(diagnostic.body.policy.branch,future.profile_policy.branch.ref);
  assert.equal(client.containsSecret(JSON.stringify(diagnostic)),false);
  const registry=f.store.clientRegistry();assert.equal(registry.length,1);assert.deepEqual(registry[0].project_ids,[binding.project_id]);assert.deepEqual(registry[0].executor_ids,[scope.executor_id]);
  const principal=client.authenticateWith(createAuthenticator(registry));assert.equal(principal.id,scope.client_id);assert.deepEqual(principal.project_ids,[binding.project_id]);
  f.store.close();const restored=new OfflineOnboardingApi(f.open(),f.transport);assert.equal((await client.diagnostics(restored)).status,200);blocked(await client.claim(restored),410);
});

test('Operator identity is separate: missing/Viewer/Client/mixed cookies/bearers never grant write authority',async t=>{
  const f=setup(t), candidates=[{}, {cookie:'awh_viewer='+randomBytes(32).toString('base64url')},
    {cookie:'awh_operator='+randomBytes(32).toString('base64url')},{authorization:'Bearer awh_cp_'+randomBytes(32).toString('base64url')},
    {...f.headers(),authorization:'Bearer awh_cp_'+randomBytes(32).toString('base64url')},
    {...f.headers(),cookie:f.headers().cookie+'; awh_viewer=unrelated'},
    {...f.headers(),cookie:[f.headers().cookie,f.headers().cookie]}];
  for(const headers of candidates)blocked(await f.api.handle({method:'GET',path:'/onboarding/v1/nonce',headers},f.operatorChannel),Array.isArray(headers.cookie)?400:401);
  assert.equal(f.count('requests'),0);assert.equal(f.count('project_bindings'),0);
  const fake={kind:'operator',verified:true};blocked(await f.api.handle({method:'GET',path:'/onboarding/v1/nonce',headers:f.headers()},fake),401);
});

test('exact loopback Host/Origin/peer and CSRF deny cross-site, LAN, forwarding and duplicate headers before enrollment',async t=>{
  const f=setup(t);
  for(const extra of [{origin:'http://evil.invalid'},{origin:undefined},{host:'localhost:47831'},{host:['127.0.0.1:47831','evil.invalid']},
    {'sec-fetch-site':'cross-site'},{forwarded:'host=evil.invalid'},{'x-forwarded-host':new URL(service.operator_origin).host},
    {'x-forwarded-proto':'https'},{'x-forwarded-for':'127.0.0.1'},{Origin:service.operator_origin}]){
    const clean={...f.headers(),...extra};for(const k of Object.keys(clean))if(clean[k]===undefined)delete clean[k];
    const nonce=(await f.get('/onboarding/v1/nonce')).body.nonce;
    const result=await f.api.handle({method:'POST',path:'/onboarding/v1/requests',body:binding,headers:{...clean,'content-type':'application/json','x-awh-nonce':nonce}},f.operatorChannel);
    assert(result.status>=400);
  }
  for(const changes of [{remote_address:'192.0.2.1'},{local_address:'0.0.0.0'},{origin:'https://other.invalid'},{verified:false}]){
    const channel=f.transport.operator(service.operator_origin,changes);blocked(await f.get('/onboarding/v1/nonce',f.owner,{},channel),401);
  }
  assert.equal(f.count('requests'),0);
});

test('nonce binding, expiry and semantic-denial consumption survive restart; malformed input never consumes nonce',async t=>{
  const f=setup(t), nonce=(await f.get('/onboarding/v1/nonce')).body.nonce;
  const envelope={method:'POST',path:'/onboarding/v1/requests',body:binding,headers:{...f.headers(),'content-type':'application/json','x-awh-nonce':nonce}};
  blocked(await f.api.handle({...envelope,headers:{...envelope.headers,...f.headers(f.requester)}},f.operatorChannel),403);
  assert.equal((await f.api.handle(envelope,f.operatorChannel)).status,200);blocked(await f.api.handle(envelope,f.operatorChannel),403);
  f.store.close();const restored=new OfflineOnboardingApi(f.open(),f.transport);blocked(await restored.handle(envelope,f.operatorChannel),403);
  const failedNonce=(await f.get('/onboarding/v1/nonce',f.owner,{},f.operatorChannel,restored)).body.nonce;
  const failedEnvelope={...envelope,headers:{...envelope.headers,'x-awh-nonce':failedNonce}};
  blocked(await restored.handle({...failedEnvelope,body:{...binding,role:'operator'}},f.operatorChannel),400);
  assert.equal((await restored.handle(failedEnvelope,f.operatorChannel)).status,200);
  blocked(await restored.handle(failedEnvelope,f.operatorChannel),403);
  const deniedNonce=(await f.get('/onboarding/v1/nonce',f.owner,{},f.operatorChannel,restored)).body.nonce;
  const deniedEnvelope={...envelope,headers:{...envelope.headers,'x-awh-nonce':deniedNonce}};
  blocked(await restored.handle({...deniedEnvelope,path:'/onboarding/v1/requests/missing/decision',body:{decision:'approve'}},f.operatorChannel),404);
  blocked(await restored.handle(deniedEnvelope,f.operatorChannel),403);
  const fresh=(await f.get('/onboarding/v1/nonce',f.owner,{},f.operatorChannel,restored)).body.nonce;f.time.value+=60_000;
  blocked(await restored.handle({...envelope,headers:{...envelope.headers,'x-awh-nonce':fresh}},f.operatorChannel),403);
  f.time.value=START+3_600_000;blocked(await f.get('/onboarding/v1/nonce',f.owner,{},f.operatorChannel,restored),401);
});

test('B0 R1 authenticated cross-scope decision is attributable and immutable; anonymous/malformed refusals write nothing',async t=>{
  const f=setup(t), requested=await f.apply();
  const bytes=()=>['','-wal'].map(s=>createHash('sha256').update(readFileSync(fixtureDatabase(f.fixture)+s)).digest('hex'));
  const before=bytes(),rows=f.count('audit');
  for(let i=0;i<10000;i++){
    const result=await f.api.handle({method:'POST',path:'/onboarding/v1/requests/'+requested.id+'/decision',headers:{},body:{decision:'approve'}},f.operatorChannel);
    assert([401,429].includes(result.status));
  }
  assert.deepEqual(bytes(),before);assert.equal(f.count('audit'),rows);
  blocked(await f.post('/onboarding/v1/requests/'+requested.id+'/decision',{decision:'approve'},f.narrow),403);
  const db=f.raw();try{
    const denial=db.prepare("SELECT * FROM audit WHERE action='project_approve_denied'").all();assert.equal(denial.length,1);
    assert.equal(denial[0].actor,f.narrow.session.id);assert.equal(denial[0].target,requested.id);
    assert.equal(denial[0].project_id,binding.project_id);assert.equal(denial[0].repository,binding.repository);
    assert.equal(denial[0].result,'denied');assert.equal(denial[0].code,'operator_scope');
    assert.equal(JSON.stringify(denial).includes(f.narrow.cookie),false);
    assert.equal(db.prepare('SELECT state FROM requests WHERE id=?').get(requested.id).state,'pending');
    assert.equal(f.count('project_bindings'),0);assert.equal(f.count('clients'),0);
    assert.throws(()=>db.exec("UPDATE audit SET code='hidden'"));assert.throws(()=>db.exec('DELETE FROM audit'));
  }finally{db.close();}
  const nonce=(await f.get('/onboarding/v1/nonce')).body.nonce,clean=bytes(),count=f.count('audit');
  for(const changes of [{headers:{origin:'http://evil.invalid'}},{body:{decision:'approve',unexpected:'malformed'}}]){
    const result=await f.api.handle({method:'POST',path:'/onboarding/v1/requests/'+requested.id+'/decision',
      headers:{...f.headers(),'content-type':'application/json','x-awh-nonce':nonce,...changes.headers},body:changes.body??{decision:'approve'}},f.operatorChannel);
    assert([400,403].includes(result.status));
  }
  assert.deepEqual(bytes(),clean);assert.equal(f.count('audit'),count);
});

test('B0 R1 expired known cookies stay anonymous; invalid clock cannot enter Operator lane',async t=>{
  const expired=Array.from({length:6},(_,i)=>mockOperator('expired-'+i,'operator',['zlpoot/future-ui'],START));
  const active=mockOperator('active-owner','operator',['zlpoot/future-ui'],START+3600000);
  const f=setup(t,{operators:[...expired.map(s=>s.session),active.session]});
  const bytes=()=>['','-wal'].map(s=>createHash('sha256').update(readFileSync(fixtureDatabase(f.fixture)+s)).digest('hex'));
  const before=bytes(),rows=f.count('audit');
  for(let i=0;i<10000;i++)assert([401,429].includes((await f.get('/onboarding/v1/nonce',expired[i%expired.length])).status));
  assert.deepEqual(bytes(),before);assert.equal(f.count('audit'),rows);
  let lanes=f.api.safetyDiagnostics().lanes;assert.equal(lanes.operator.requests,0);assert.equal(lanes.operator.identities,0);
  assert.equal((await f.get('/onboarding/v1/nonce',active)).status,200);
  lanes=f.api.safetyDiagnostics().lanes;assert.equal(lanes.operator.requests,1);assert.equal(lanes.operator.identities,1);
  const after=bytes(),n=f.count('audit'),admitted=lanes.operator.requests;f.time.value=NaN;
  blocked(await f.get('/onboarding/v1/nonce',active),500);
  assert.equal(f.api.safetyDiagnostics().lanes.operator.requests,admitted);assert.deepEqual(bytes(),after);assert.equal(f.count('audit'),n);
});

test('B0 R1 mandatory denial audit fails closed on audit outage, persistent quota, storage and SQLite busy',async t=>{
  for(const mode of ['audit_outage','audit_quota','storage','busy']){
    const f=setup(t),requested=await f.apply(),nonce=(await f.get('/onboarding/v1/nonce',f.narrow)).body.nonce,db=f.raw();
    const journal=fixtureDatabase(f.fixture)+'-journal';
    try{
      if(mode==='audit_outage')db.exec("CREATE TRIGGER fixture_denial_outage BEFORE INSERT ON audit WHEN NEW.action='project_approve_denied' BEGIN SELECT RAISE(ABORT,'fixture denial outage'); END");
      if(mode==='audit_quota'){
        const count=f.count('audit'),seed=db.prepare("INSERT INTO audit(at,actor,action,target,result,code) VALUES(?,'fixture','fixture_seed','fixture','accepted','ok')");
        db.exec('BEGIN IMMEDIATE');for(let i=count;i<8191;i++)seed.run(new Date(START).toISOString());db.exec('COMMIT');
      }
      if(mode==='storage')writeFileSync(journal,Buffer.alloc(8*1024*1024));
      if(mode==='busy')db.exec('BEGIN IMMEDIATE');
      const before=f.count('audit');
      blocked(await f.api.handle({method:'POST',path:'/onboarding/v1/requests/'+requested.id+'/decision',
        headers:{...f.headers(f.narrow),'content-type':'application/json','x-awh-nonce':nonce},body:{decision:'approve'}},f.operatorChannel),mode==='audit_outage'?500:503);
      assert.equal(db.prepare('SELECT state FROM requests WHERE id=?').get(requested.id).state,'pending');
      assert.equal(f.count('project_bindings'),0);assert.equal(f.count('clients'),0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='project_approve_denied'").get().n,0);
      assert.equal(f.count('audit'),before+(mode==='audit_outage'||mode==='audit_quota'?1:0));
    }finally{
      if(mode==='busy')db.exec('ROLLBACK');db.close();if(mode==='storage')unlinkSync(journal);
    }
  }
});

test('B0 R1 private pairing denial keeps fixed peer attribution with no material or credential in audit',async t=>{
  const f=setup(t);await f.approve();const {client,result}=await f.invite();assert.equal(result.status,200);
  const wrong='awh_pair_'+randomBytes(32).toString('base64url');blocked(await client.claim(f.api,{},wrong),403);
  const db=f.raw();try{
    const rows=db.prepare("SELECT * FROM audit WHERE action='claim_denied'").all();assert.equal(rows.length,1);
    assert.equal(rows[0].actor,scope.client_id);assert.equal(rows[0].target,result.body.id);
    assert.equal(rows[0].result,'denied');assert.equal(rows[0].code,'pairing_denied');
    assert.equal(JSON.stringify(rows).includes(wrong),false);assert.equal(client.containsSecret(JSON.stringify(rows)),false);
    assert.equal(f.count('clients'),0);assert.equal(db.prepare('SELECT attempts FROM invitations WHERE id=?').get(result.body.id).attempts,1);
  }finally{db.close();}
});

test('requester is owner-scoped; narrow Operator cannot decide or inspect another repository',async t=>{
  const f=setup(t), r=await f.apply();
  blocked(await f.post('/onboarding/v1/requests/'+r.id+'/decision',{decision:'approve'},f.requester),403);
  blocked(await f.post('/onboarding/v1/requests/'+r.id+'/decision',{decision:'approve'},f.narrow),403);
  blocked(await f.get('/onboarding/v1/requests/'+r.id,f.narrow),403);blocked(await f.get('/onboarding/v1/audit',f.requester),403);
  assert.equal((await f.get('/onboarding/v1/requests/'+r.id,f.requester)).body.state,'pending');assert.equal(f.count('project_bindings'),0);
});

test('unknown repository stays Pending; wrong Profile/ref/version and supplied policy/permissions cannot be approved',async t=>{
  const f=setup(t);
  for(const [i,change]of [{repository:'evil/unknown'},{profile_ref:'webskill/default'},{profile_version:'missing-version'},{profile_ref:'future-ui/unknown'}].entries()){
    const r=await f.apply({...binding,project_id:'unknown-'+i,...change});blocked(await f.post('/onboarding/v1/requests/'+r.id+'/decision',{decision:'approve'}),403);
    assert.equal((await f.get('/onboarding/v1/requests/'+r.id,f.requester)).body.state,'pending');
  }
  for(const field of ['role','permissions','policy','token','admin','operator','endpoint','executor_ids'])blocked(await f.post('/onboarding/v1/requests',{...binding,[field]:field==='permissions'?{contents:'admin'}:'untrusted'}),400);
  assert.equal(f.count('project_bindings'),0);
});

test('exact binding is idempotent; rejection is terminal; project/repository/version conflicts never rewrite trust',async t=>{
  const f=setup(t), foreign=await f.apply({...binding,repository:'zlpoot/webskill',profile_ref:'webskill/default'},f.owner), r=await f.approve();
  assert.equal((await f.post('/onboarding/v1/requests/'+r.id+'/decision',{decision:'approve'})).status,200);
  assert.equal(f.count('project_bindings'),1);blocked(await f.post('/onboarding/v1/requests',{...binding,repository:'zlpoot/webskill'}),409);
  blocked(await f.post('/onboarding/v1/requests/'+foreign.id+'/decision',{decision:'approve'}),409);
  blocked(await f.post('/onboarding/v1/requests/'+r.id+'/decision',{decision:'reject'}),409);
  const pending=await f.apply({...binding,project_id:'rejected-project'});assert.equal((await f.post('/onboarding/v1/requests/'+pending.id+'/decision',{decision:'reject'})).body.state,'rejected');
  blocked(await f.post('/onboarding/v1/requests/'+pending.id+'/decision',{decision:'approve'}),409);
});

test('invitation requires approved exact binding and matching trusted Client delivery sink; caller rights stay fixed',async t=>{
  const f=setup(t), before=await f.invite();blocked(before.result,409);assert.equal(f.count('invitations'),0);
  await f.approve();
  const client=f.transport.client(scope,'closed-delivery');
  for(const change of [{profile_ref:'webskill/default'},{profile_version:'unknown'},{repository:'zlpoot/webskill'},{executor_id:'other-executor'},
    {endpoint:'https://wrong.fixture.invalid'},{service_id:'other-service'},{ca_sha256:'b'.repeat(64)}]) {
    const response=await f.post('/onboarding/v1/invitations',{...scope,...change,delivery_id:'closed-delivery'});assert(response.status>=400);
  }
  blocked(await f.post('/onboarding/v1/invitations',{...scope,delivery_id:'missing-delivery'}),403);
  for(const change of [{permissions:['admin']},{ttl_seconds:999999},{attempt_limit:999},{profile_policy:future.profile_policy}])blocked(await f.post('/onboarding/v1/invitations',{...scope,delivery_id:'closed-delivery',...change}),400);
  assert.equal(f.count('invitations'),0);assert.equal(client.containsSecret(JSON.stringify(await f.get('/onboarding/v1/audit'))),false);
});

test('Profile executor/machine restrictions remain enforced without editing the fixed policy',async t=>{
  const policy=structuredClone(future.profile_policy);policy.executor_restrictions={executor_ids:['allowed-executor'],machine_ids:['allowed-machine']};
  const f=setup(t,{profiles:[policy,webskill.profile_policy]});await f.approve();blocked((await f.invite()).result,403);
  const allowed=await f.invite({...scope,executor_id:'allowed-executor',machine_id:'allowed-machine'});assert.equal(allowed.result.status,200);
});

test('expired invitations, rollback of the clock and cross-restart replay never revive pairing material',async t=>{
  const f=setup(t);await f.approve();const {client}=await f.invite();f.time.value+=300_000;blocked(await client.claim(f.api),410);
  f.time.value=START;blocked(await client.claim(f.api),410);assert.equal(f.count('clients'),0);
  f.store.close();const restored=new OfflineOnboardingApi(f.open(),f.transport);blocked(await client.claim(restored),410);
});

test('three bad-material attempts persist; correct material cannot recover a locked invitation',async t=>{
  const f=setup(t);await f.approve();const {client}=await f.invite(), bad='awh_pair_'+randomBytes(32).toString('base64url');
  for(let i=0;i<3;i++)blocked(await client.claim(f.api,{},bad),403);
  blocked(await client.claim(f.api),410);assert.equal(f.count('clients'),0);
  f.store.close();const restored=new OfflineOnboardingApi(f.open(),f.transport);blocked(await client.claim(restored),410);
});

test('revocation and duplicate claim are terminal; Client cannot revoke or write via Operator API',async t=>{
  const f=setup(t);await f.approve();const first=await f.invite();assert.equal((await f.post('/onboarding/v1/invitations/'+first.result.body.id+'/revoke',{})).body.state,'revoked');
  blocked(await first.client.claim(f.api),410);
  const second=await f.invite();assert.equal((await second.client.claim(f.api)).status,200);blocked(await second.client.claim(f.api),410);
  blocked(await f.post('/onboarding/v1/invitations/'+second.result.body.id+'/revoke',{}),409);
  blocked(await f.api.handle({method:'GET',path:'/onboarding/v1/nonce',headers:f.headers()},second.client.channel),401);
});

test('wrong repo/profile/version/project/executor/machine/platform/client cannot claim or escalate scopes',async t=>{
  const changes=[{repository:'zlpoot/webskill'},{profile_ref:'webskill/default'},{profile_version:'unknown'},{project_id:'foreign-project'},
    {executor_id:'foreign-executor'},{machine_id:'foreign-machine'},{platform:'macos'},{client_id:'foreign-client'},{executor_type:'other'}];
  for(const [i,change]of changes.entries()) {
    const f=setup(t);await f.approve();const {client}=await f.invite();blocked(await client.claim(f.api,change),403);assert.equal(f.count('clients'),0,'case '+i);
  }
});

test('claim requires local Git check and human confirmation; permission/verified fields and browser-shaped requests are denied',async t=>{
  const f=setup(t);await f.approve();const {client}=await f.invite();
  for(const change of [{git_root_verified:false},{user_confirmed:false},{permissions:['admin']},{verified:true},{token:'hidden'},{git_root:'private-root'}])blocked(await client.claim(f.api,change),400);
  for(const headers of [{cookie:'awh_viewer=fixture'},{origin:service.operator_origin},{'sec-fetch-site':'same-origin'},{'sec-fetch-mode':'cors'}]){
    const envelope=client.workerClaimEnvelope();blocked(await f.api.handle({...envelope,headers:{...envelope.headers,...headers}},client.channel),403);
  }
  assert.equal(f.count('clients'),0);assert.equal((await client.claim(f.api)).status,200);
});

test('unverified transport, wrong endpoint/service/CA and fake channel are rejected before trust mutation',async t=>{
  const f=setup(t);await f.approve();const target=await f.invite();
  for(const [i,change]of [{endpoint:'https://wrong.fixture.invalid'},{service_id:'wrong-service'},{ca_sha256:'b'.repeat(64)}].entries()){
    const rogue=f.transport.client({...scope,...change},'rogue-'+i);rogue.borrowInvitationFrom(target.client);blocked(await rogue.claim(f.api),403);
  }
  const unverified=f.transport.client(scope,'unverified',{verified:false});unverified.borrowInvitationFrom(target.client);blocked(await unverified.claim(f.api),401);
  blocked(await f.api.handle(target.client.workerClaimEnvelope(),{kind:'client',verified:true,scope}),401);
  assert.equal(f.count('clients'),0);assert.equal((await target.client.claim(f.api)).status,200);
});

test('existing Project and Client/executor/machine ownership is reserved; exact adoption never rewrites old identity',async t=>{
  const old={...binding}, reserved={client_id:'old-client',executor_id:'old-executor',machine_id:'old-machine',project_id:binding.project_id};
  const f=setup(t,{reserved_projects:[old],reserved_clients:[reserved]});await f.approve();
  for(const change of [{client_id:reserved.client_id},{executor_id:reserved.executor_id},{machine_id:reserved.machine_id}])blocked((await f.invite({...scope,...change})).result,409);
  const db=f.raw();try{assert.equal(canonical(JSON.parse(db.prepare('SELECT record FROM reserved_projects').get().record)),canonical(old));assert.equal(canonical(JSON.parse(db.prepare('SELECT record FROM reserved_clients').get().record)),canonical(reserved));}finally{db.close();}
  blocked(await f.post('/onboarding/v1/requests',{...binding,repository:'zlpoot/webskill',profile_ref:'webskill/default'},f.owner),409);
});

test('active invitation reservations and previously claimed Client identities prevent conflicting enrollment',async t=>{
  const f=setup(t);await f.approve();const first=await f.invite();blocked((await f.invite()).result,409);
  for(const change of [{client_id:'different-client'},{executor_id:'different-executor'},{machine_id:'different-machine'}])blocked((await f.invite({...scope,...change})).result,409);
  assert.equal((await first.client.claim(f.api)).status,200);blocked((await f.invite()).result,409);
});

test('two parallel SQLite connections race for one invitation: exactly one Client credential is activated',async t=>{
  const f=setup(t);await f.approve();const {client}=await f.invite(), barrier=new SharedArrayBuffer(4);
  const workers=Array.from({length:2},()=>new Worker(new URL('./fixtures/onboarding-claim-worker.mjs',import.meta.url),{workerData:{fixture:f.fixture,config:f.config,scope,envelope:client.workerClaimEnvelope(),barrier,now:f.time.value}}));
  f.cleanup.push(async()=>{await Promise.all(workers.map(w=>w.terminate()));});
  await Promise.all(workers.map(async w=>{const [ready]=await once(w,'message');assert.equal(ready.ready,true);}));
  const pending=workers.map(async w=>{const [result]=await once(w,'message');return result;});
  Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0,2);
  const results=await Promise.all(pending);
  assert.equal(results.filter(r=>r.status===200).length,1);
  const rejected=results.find(r=>r.status!==200);
  // B0 bounds SQLite wait: a loser may time out before observing the committed terminal invite.
  assert(rejected.status===410 && rejected.code==='invitation_unavailable' ||
    rejected.status===503 && rejected.code==='busy');
  assert.equal(f.count('clients'),1);assert.equal(f.store.clientRegistry().length,1);
  const db=f.raw();try{assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='client_activated'").get().n,1);}finally{db.close();}
});

test('bounded SQLite busy during claim grants no credential; unlocked retry still consumes invitation only once',async t=>{
  const f=setup(t);await f.approve();const {client}=await f.invite(),db=f.raw();
  db.exec('BEGIN IMMEDIATE');
  try {
    const denied=await client.claim(f.api);blocked(denied,503);assert.equal(denied.body.error.code,'busy');
    assert.equal(f.count('clients'),0);assert.equal(f.store.clientRegistry().length,0);
  }finally{db.exec('ROLLBACK');db.close();}
  assert.equal((await client.claim(f.api)).status,200);blocked(await client.claim(f.api),410);
  assert.equal(f.count('clients'),1);assert.equal(f.store.clientRegistry().length,1);
});

test('Client diagnostics require its own credential and exact scope; requester cannot read other projects',async t=>{
  const f=setup(t);await f.approve();const {client}=await f.invite();assert.equal((await client.claim(f.api)).status,200);
  blocked(await client.diagnostics(f.api,'foreign-project'),403);
  const other=f.transport.client({...scope,client_id:'other-client',project_id:'other-project'},'other-diagnostic');blocked(await other.diagnostics(f.api),401);
  blocked(await f.get('/onboarding/v1/projects/'+binding.project_id+'/diagnostics',f.requester),403);
  blocked(await f.get('/onboarding/v1/projects/'+binding.project_id+'/diagnostics',f.narrow),403);
});

test('failed invitation/credential delivery never activates material, and repeated claim cannot retry delivery',async t=>{
  const f=setup(t);await f.approve();const badInvite=await f.invite(scope,{fail_invitation:true});blocked(badInvite.result,500);
  assert.equal(f.store.clientRegistry().length,0);
  const badCredential=await f.invite(scope,{fail_credential:true});assert.equal(badCredential.result.status,200);blocked(await badCredential.client.claim(f.api),500);
  assert.equal(f.store.clientRegistry().length,0);blocked(await badCredential.client.diagnostics(f.api),401);blocked(await badCredential.client.claim(f.api),410);
  const db=f.raw();try{assert.equal(db.prepare('SELECT state FROM clients').get().state,'revoked');assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='credential_delivery_failed'").get().n,1);}finally{db.close();}
});

test('audit transaction failure rolls back approval and claim; pending delivery does not grant authentication after storage failure',async t=>{
  const f=setup(t), pending=await f.apply();let db=f.raw();db.exec("CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON audit WHEN NEW.action='project_approved' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");db.close();
  blocked(await f.post('/onboarding/v1/requests/'+pending.id+'/decision',{decision:'approve'}),500);assert.equal(f.count('project_bindings'),0);
  assert.equal((await f.get('/onboarding/v1/requests/'+pending.id,f.requester)).body.state,'pending');
  db=f.raw();db.exec('DROP TRIGGER fixture_fail_audit');db.close();assert.equal((await f.post('/onboarding/v1/requests/'+pending.id+'/decision',{decision:'approve'})).status,200);
  const {client}=await f.invite();db=f.raw();db.exec("CREATE TRIGGER fixture_fail_claim BEFORE INSERT ON audit WHEN NEW.action='claim_consumed' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");db.close();
  blocked(await client.claim(f.api),500);assert.equal(f.count('clients'),0);
  db=f.raw();assert.equal(db.prepare('SELECT state FROM invitations').get().state,'active');db.exec('DROP TRIGGER fixture_fail_claim');db.exec("CREATE TRIGGER fixture_fail_delivery BEFORE INSERT ON audit WHEN NEW.action IN ('client_activated','credential_delivery_failed') BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");db.close();
  blocked(await client.claim(f.api),500);assert.equal(f.store.clientRegistry().length,0);blocked(await client.diagnostics(f.api),401);
  db=f.raw();assert.equal(db.prepare('SELECT state FROM clients').get().state,'pending_delivery');db.exec('DROP TRIGGER fixture_fail_delivery');db.close();
  f.store.close();const restored=new OfflineOnboardingApi(f.open(),f.transport);blocked(await client.diagnostics(restored),401);blocked(await client.claim(restored),410);
});

test('delivery interrupted by terminal-state change cannot falsely report activation or authenticate the captured credential',async t=>{
  const f=setup(t);await f.approve();const {client}=await f.invite();
  const injected={peer(channel){const peer=f.transport.peer(channel);if(peer?.kind!=='client')return peer;
    return {...peer,provisionCredential(credential){peer.provisionCredential(credential);const db=f.raw();try{db.exec("UPDATE clients SET state='revoked'");}finally{db.close();}}};},delivery:id=>f.transport.delivery(id)};
  const api=new OfflineOnboardingApi(f.store,injected);blocked(await client.claim(api),500);
  assert.equal(f.store.clientRegistry().length,0);blocked(await client.diagnostics(api),401);
  const db=f.raw();try{assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='client_activated'").get().n,0);}finally{db.close();}
});

test('invitation delivery/activation audit outage leaves material unusable until explicit revocation; no restart activation',async t=>{
  const f=setup(t);await f.approve();const db=f.raw();db.exec("CREATE TRIGGER fixture_invite_outage BEFORE INSERT ON audit WHEN NEW.action IN ('invitation_delivered','delivery_failed') BEGIN SELECT RAISE(ABORT,'fixture outage'); END;");db.close();
  const {client,result}=await f.invite();blocked(result,500);blocked(await client.claim(f.api),410);assert.equal(f.store.clientRegistry().length,0);
  const check=f.raw();const id=check.prepare('SELECT id FROM invitations').get().id;assert.equal(check.prepare('SELECT state FROM invitations').get().state,'pending_delivery');check.exec('DROP TRIGGER fixture_invite_outage');check.close();
  f.store.close();const restored=new OfflineOnboardingApi(f.open(),f.transport);blocked(await client.claim(restored),410);
  assert.equal((await f.post('/onboarding/v1/invitations/'+id+'/revoke',{},f.owner,{},f.operatorChannel,restored)).body.state,'revoked');
});

test('secret injection is rejected; SQLite/WAL, audit, safe responses and serialized mock Client contain no raw credential',async t=>{
  const f=setup(t);for(const value of ['awh_cp_'+randomBytes(32).toString('base64url'),'awh_pair_'+randomBytes(32).toString('base64url'),'awh_op_'+randomBytes(32).toString('base64url'),'github_pat_fixture_forbidden','-----BEGIN PRIVATE KEY-----']){
    blocked(await f.post('/onboarding/v1/requests',{...binding,project_id:value}),400);
  }
  await f.approve();const {client,result}=await f.invite();assert.equal((await client.claim(f.api)).status,200);
  const responses=[result,await client.diagnostics(f.api),await f.get('/onboarding/v1/audit')];
  for(const response of responses){assert.equal(client.containsSecret(JSON.stringify(response)),false);assert(!/awh_(?:cp|pair|op)_[A-Za-z0-9_-]+/.test(JSON.stringify(response)));}
  assert.equal(client.containsSecret(JSON.stringify(client)),false);assert.deepEqual(JSON.parse(JSON.stringify(client)),{});
  for(const file of readdirSync(f.fixture.directory))assert.equal(client.containsSecret(readFileSync(join(f.fixture.directory,file)).toString('latin1')),false,'fixture storage scan');
  const db=f.raw();try{assert.match(db.prepare('SELECT token_sha256 FROM clients').get().token_sha256,/^[a-f0-9]{64}$/);assert.match(db.prepare('SELECT secret_sha256 FROM invitations').get().secret_sha256,/^[a-f0-9]{64}$/);}finally{db.close();}
});

test('immutable audit/profile/reservation/identity and trusted-config pinning persist; API inputs cannot mutate configuration',async t=>{
  const f=setup(t);await f.approve();const {client}=await f.invite();await client.claim(f.api);
  const db=f.raw();try{
    for(const sql of ['DELETE FROM audit','UPDATE audit SET actor=\'changed\'','UPDATE trusted_profiles SET record=\'{}\'','DELETE FROM trusted_profiles','UPDATE project_bindings SET record=\'{}\'','DELETE FROM clients','UPDATE clients SET executor_id=\'changed\'','UPDATE invitations SET state=\'active\''])assert.throws(()=>db.exec(sql));
  }finally{db.close();}
  const config=f.store.config;config.profiles[0].verification.commands=['untrusted'];config.service.endpoint='https://wrong.invalid';assert.equal(f.store.config.profiles[0].verification.commands[0],future.profile_policy.verification.commands[0]);
  assert.throws(()=>new OfflineOnboardingStore(f.fixture,{...f.config,profiles:[{...future.profile_policy,base:'changed'},webskill.profile_policy]},()=>START),e=>e.code==='trusted_config_conflict');
});

test('fixture boundary refuses arbitrary roots, wrong marker, ordinary CP v2 and foreign schemas before mutation',t=>{
  const f=setup(t);assert.throws(()=>new OfflineOnboardingStore({...f.fixture,directory:process.cwd()},f.config),e=>e.code==='fixture_boundary');
  assert.throws(()=>new OfflineOnboardingStore({...f.fixture,fixture_id:'0'.repeat(36)},f.config),e=>e.code==='fixture_boundary');
  f.store.close();let db=f.raw();db.exec('PRAGMA user_version=2');db.close();
  assert.throws(()=>f.open(),e=>e.code==='fixture_boundary');db=f.raw();assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);db.close();
});

test('fixture file/sidecar hardlinks cannot redirect SQLite access outside the fixture boundary',t=>{
  const f=setup(t);f.store.close();const path=fixtureDatabase(f.fixture), backup=join(f.fixture.directory,'fixture-backup');
  linkSync(path,backup);assert.throws(()=>f.open(),e=>e.code==='fixture_boundary');unlinkSync(backup);
  writeFileSync(backup,'SYNTHETIC SIDECAR HARDLINK TARGET; NOT SQLITE');
  for(const suffix of ['-wal','-shm','-journal']){const sidecar=path+suffix;linkSync(backup,sidecar);assert.throws(()=>f.open(),e=>e.code==='fixture_boundary');unlinkSync(sidecar);}
  unlinkSync(backup);
  const restored=f.open();restored.close();
});

test('legacy CP v2 and Dashboard histories remain byte-equivalent in a separate temporary fixture',async t=>{
  const reserved={project_id:future.project.id,repository:future.project.repository,profile_ref:future.project.profile_ref,profile_version:future.profile_policy.version};
  const oldClient={client_id:'fixture-old-client',executor_id:future.executor.id,machine_id:future.executor.machine.id,project_id:future.project.id};
  const f=setup(t,{reserved_projects:[reserved],reserved_clients:[oldClient]}), runtime=join(f.fixture.directory,'legacy-runtime.sqlite');
  const principal={id:oldClient.client_id,project_ids:[future.project.id],executor_ids:[future.executor.id]};
  const cp=new ControlPlaneStore(runtime,[future.profile_policy]);f.cleanup.push(()=>cp.close());
  cp.registerProject(principal,future.manifest);cp.registerExecutor(principal,future.executor);cp.registerWorkItem(principal,future.work_item);cp.createRun(principal,future.run);
  const event={schema_version:'1.0',kind:'event',id:'fixture-legacy-event',run_id:future.run.id,sequence:1,type:'RUN_STARTED',occurred_at:future.run.created_at,
    payload:{schema_version:'1.0',data:{source_sha:future.run.source.sha},extensions:{}}};cp.append(principal,future.run.id,event);
  const snapshot=()=>{const raw=new DatabaseSync(runtime,{readOnly:true});try{return canonical({version:raw.prepare('PRAGMA user_version').get(),tables:Object.fromEntries(['profiles','projects','executors','executor_clients','work_items','runs','events'].map(name=>[name,raw.prepare('SELECT * FROM '+name+' ORDER BY 1').all()]))});}finally{raw.close();}};
  const before=snapshot(), reader=new DashboardReadStore(runtime);try{
    const dashboard=reader.dashboardReadView(principal);await f.approve(reserved);const paired=await f.invite({...scope,...reserved});assert.equal((await paired.client.claim(f.api)).status,200);
    assert.equal(snapshot(),before);assert.deepEqual(reader.dashboardReadView(principal),dashboard);assert.equal(cp.latestCursor(),1);
    assert.deepEqual(cp.getRun(principal,future.run.id).profile,future.run.profile);assert.deepEqual(cp.listProfiles(principal,future.project.id),[future.profile_policy]);
  }finally{reader.close();}
});

test('closed routes/headers/schema, complexity bounds and content types fail without input/error echo',async t=>{
  const f=setup(t);
  for(const path of ['/onboarding/v1/requests?admin=true','/onboarding/v1/requests/%2F','/onboarding/v1/audit?after=1&after=2','/onboarding/v1/audit?after=-1','/pairing/v1/claim?secret=fixture']){
    const result=await f.get(path);assert(result.status>=400);assert.equal(JSON.stringify(result).includes(path),false);
  }
  for(const extra of [{'content-type':'text/plain'},{'content-type':['application/json','application/json']},{'content-encoding':'gzip'},{'x-awh-nonce':['a','b']}]){
    const result=await f.post('/onboarding/v1/requests',binding,f.owner,extra);assert(result.status>=400);
  }
  blocked(await f.api.handle({method:'DELETE',path:'/onboarding/v1/requests',headers:f.headers()},f.operatorChannel),405);
  const deep={};let cursor=deep;for(let i=0;i<40;i++){cursor.child={};cursor=cursor.child;}blocked(await f.post('/onboarding/v1/requests',deep),400);
  blocked(await f.post('/onboarding/v1/requests',{...binding,unknown:'x'.repeat(70_000)}),413);
  assert.equal(f.count('requests'),0);
});

test('OpenAPI and runtime validation schema are identical; no production entry imports onboarding',()=>{
  const openapi=JSON.parse(readFileSync(new URL('../contracts/onboarding-v1.openapi.json',import.meta.url)));
  const schema=JSON.parse(readFileSync(new URL('../src/onboarding/schema.json',import.meta.url)));
  assert.deepEqual(openapi.components.schemas,JSON.parse(JSON.stringify(schema.$defs).replaceAll('#/$defs/','#/components/schemas/')));
  assert.equal(Object.keys(openapi.paths).length,10);
  for(const file of ['src/control-plane-cli.ts','src/control-plane/server.ts','src/control-plane/store.ts','src/client/cli.ts','src/dashboard/gateway.ts','src/builder.ts'])assert(!readFileSync(new URL('../'+file,import.meta.url),'utf8').includes('onboarding/'));
});
