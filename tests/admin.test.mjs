import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { approveProposal, prepareApproval, prepareRevoke, prepareGrant, proposeProject, inspectRegistry, launcherDescriptor, inspectProposal, compareProposals, diagnoseRegistry } from '../dist/admin/operations.js';
import { digest, encode, managedContext } from '../dist/admin/registry.js';
import { loadTrustedPolicy } from '../dist/profiles.js';
import { connectBuilder } from '../dist/builder.js';
const originalPolicy = JSON.parse(readFileSync(new URL('./fixtures/builder-policy.json',import.meta.url)));
const envKeys = ['AWH_ADMIN_TRUST_FILE','AWH_ADMIN_TRUST_SHA256','AWH_ADMIN_APPROVAL_FILE','AWH_ADMIN_APPROVAL_SHA256','AWH_ADMIN_VERSION','AWH_ADMIN_EXECUTOR_ID','AWH_ADMIN_MACHINE_ID','AWH_BUILDER_POLICY_FILE','AWH_BUILDER_POLICY_SHA256'];
function fixture(t) {
 const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));envKeys.forEach(key=>delete process.env[key]);
 const directory=mkdtempSync(join(tmpdir(),'awh-admin-b0-')),root=join(directory,'registry');mkdirSync(root,{mode:0o700});
 t.after(()=>{for(const key of envKeys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
  assert.equal(resolve(directory),join(tmpdir(),directory.split(/[\\/]/).at(-1)));rmSync(directory,{recursive:true,force:true});});
 const policy=structuredClone(originalPolicy),p=policy.profiles[0],w=p.workflows[0],repository=policy.installation.account_login+'/new-project';
 policy.installation.selected_repository_sets=[[repository]];policy.profiles=[{...p,repository,workflows:[{...w,branch_mode:'issue_prefix',branch:'codex/task-',work_item:{repo:repository,issue:0},bootstrap_paths:['README.md'],verification_commands:['pnpm typecheck'],executor_restrictions:{executor_ids:['test-executor'],machine_ids:['test-machine']}}]}];
 policy.default_selection={profile:p.id,workflow:w.id};
 const project={builder_policy:policy,stages:['observe','develop','deliver'],permissions:{contents:'write',issues:'read',pull_requests:'write'}};
 const task={repository,issue:90,branch:'codex/task-90',base_sha:'b'.repeat(40),head_sha:null,profile:p.id,workflow:w.id,executor_id:'test-executor',machine_id:'test-machine',expires_at:new Date(Date.now()+86400000).toISOString(),stages:['develop','deliver'],provider_operations:['push','draft_pr','evidence','handoff']};
 const trust={schema_version:'1.0',kind:'admin_trust',registry_root:root,operator:{login:'test-admin',id:12345},installation_sha256:digest(encode(policy.installation)),host:hostname()};
 const file=name=>join(directory,name),trustFile=file('trust.json');writeFileSync(trustFile,encode(trust),{mode:0o600});
 process.env.AWH_ADMIN_TRUST_FILE=trustFile;process.env.AWH_ADMIN_TRUST_SHA256=digest(encode(trust));
 const pin=(path,receiptId='receipt-'+JSON.parse(readFileSync(path)).version)=>{const receipt=file(receiptId+'.json');prepareApproval(path,receiptId,'Synthetic isolated administrator approval',receipt);process.env.AWH_ADMIN_APPROVAL_FILE=receipt;process.env.AWH_ADMIN_APPROVAL_SHA256=digest(readFileSync(receipt));return receipt;};
 const register=(version='project-v1',changed=project)=>{const path=file(version+'.json');proposeProject(changed,version,path);pin(path);approveProposal(path);return path;};
 const prepare=(version='task-v1',changed=task,policyVersion='project-v1')=>{const path=file(version+'.json');prepareGrant(policyVersion,version,{...changed},path);return path;};
 const activate=(version='task-v1')=>{process.env.AWH_ADMIN_VERSION=version;process.env.AWH_ADMIN_EXECUTOR_ID=task.executor_id;process.env.AWH_ADMIN_MACHINE_ID=task.machine_id;};
 const grant=(version='task-v1',changed=task)=>{const path=prepare(version,changed);pin(path);approveProposal(path);activate(version);return path;};
 return {root,project,policy,task,trustFile,file,pin,register,prepare,activate,grant};
}
test('unapproved templates, proposals and self-prepared receipts confer no authority',async t=>{
 const f=fixture(t),path=f.file('unapproved.json');proposeProject(f.project,'project-v1',path);
 assert.equal(inspectProposal(path).authority_verified,false);assert.throws(()=>approveProposal(path),/independent_approval_pin_required/);
 assert.throws(()=>f.prepare(),/project_unapproved/);f.pin(path);delete process.env.AWH_ADMIN_APPROVAL_SHA256;assert.throws(()=>approveProposal(path),/independent_approval_pin_required/);
 process.env.AWH_ADMIN_APPROVAL_SHA256='0'.repeat(64);assert.throws(()=>approveProposal(path),/approval_digest/);
 f.activate();let calls=0;const blocked=()=>{calls++;throw Error('No Provider access');};await assert.rejects(connectBuilder({read:blocked,fetch:blocked,spawn:blocked,realpath:blocked,stat:blocked,cwd:blocked}));assert.equal(calls,0);assert(!existsSync(join(f.root,'state.json')));
});
test('new repository, two consecutive issues reuse one approved project; final HEAD is not invented at approval',t=>{
 const f=fixture(t);f.register();f.grant();
 assert.equal(managedContext().proposed.task.head_sha,null);const old=readFileSync(join(f.root,'task-v1.policy.json'));
 f.grant('task-v2',{...f.task,issue:91,branch:'codex/task-91'});assert.equal(inspectRegistry().entries.length,3);
 f.activate();assert.equal(loadTrustedPolicy().profiles[0].workflows[0].version,'task-v1');assert.deepEqual(readFileSync(join(f.root,'task-v1.policy.json')),old);
 const status=launcherDescriptor('task-v2');assert.equal(status.task.issue,91);assert.equal(status.provider_scope,'NOTRUN');
 assert(!JSON.stringify(status).includes('TRUST_'));assert(!JSON.stringify(status).includes(f.root));assert(!('environment' in status));
});
test('project versions are immutable; work items never float to newer permissions or checks',t=>{
 const f=fixture(t);f.register();f.grant();const changed=structuredClone(f.project);changed.builder_policy.profiles[0].workflows[0].verification_commands=['pnpm lint'];
 f.register('project-v2',changed);assert.deepEqual(loadTrustedPolicy().profiles[0].workflows[0].verification_commands,['pnpm typecheck']);
 const path=f.prepare('task-v2',f.task,'project-v2');f.pin(path);approveProposal(path);f.activate('task-v2');assert.deepEqual(loadTrustedPolicy().profiles[0].workflows[0].verification_commands,['pnpm lint']);
 assert.equal(approveProposal(path).status,'ALREADY_COMMITTED');
});
test('a reusable general code template explicitly allows repository changes; legacy unbounded prefix Tasks stay rejected',t=>{
 const f=fixture(t),general=structuredClone(f.project);general.builder_policy.profiles[0].workflows[0].bootstrap_paths=null;f.register('project-v1',general);f.grant();
 const view=loadTrustedPolicy();assert.equal(view.profiles[0].workflows[0].branch_mode,'fixed');assert.equal(view.profiles[0].workflows[0].bootstrap_paths,null);
 const legacy=f.file('unsafe-legacy.json');writeFileSync(legacy,encode(general.builder_policy),{mode:0o600});for(const key of ['AWH_ADMIN_TRUST_FILE','AWH_ADMIN_TRUST_SHA256','AWH_ADMIN_VERSION'])delete process.env[key];process.env.AWH_BUILDER_POLICY_FILE=legacy;process.env.AWH_BUILDER_POLICY_SHA256=digest(readFileSync(legacy));assert.throws(()=>loadTrustedPolicy(),/approved Builder policy/);
});
test('wrong repository, branch, machine, executor, future head schema and invalid stages are refused',t=>{
 const f=fixture(t);f.register();
 for(const changed of [{repository:'example-org/elsewhere'},{branch:'codex/task-91'},{machine_id:'wrong'},{executor_id:'wrong'},{head_sha:'not-produced'},{stages:['review']},{stages:['observe'],provider_operations:['push']}])
  assert.throws(()=>f.prepare('wrong-'+Object.keys(changed)[0],{...f.task,...changed}));
 assert.equal(inspectRegistry().generation,1);
});
test('command injection, unsupported commands, permission expansion and changed installation fail closed',t=>{
 const f=fixture(t);
 for(const command of ['pnpm typecheck; curl evil','node arbitrary-script.js','node --test tests/../evil.mjs','git diff --check origin/main...HEAD | cat']){
  const changed=structuredClone(f.project);changed.builder_policy.profiles[0].workflows[0].verification_commands=[command];assert.throws(()=>f.register('bad',changed));}
 const expanded=structuredClone(f.project);expanded.builder_policy.installation.selected_repository_sets[0].push('example-org/extra');
 const path=f.file('expanded.json');proposeProject(expanded,'expanded',path);f.pin(path);assert.throws(()=>approveProposal(path),/installation_or_expiry/);
 const narrow=structuredClone(f.project);narrow.permissions.contents='read';narrow.permissions.pull_requests='read';f.register('project-v1',narrow);assert.throws(()=>f.prepare(),/task_scope/);
});
test('Observe, Develop and Deliver are independent; legal Observe diagnoses normally without a write token',async t=>{
 const f=fixture(t);f.register();f.grant('observe-only',{...f.task,stages:['observe'],provider_operations:[]});
 assert.equal(diagnoseRegistry('observe-only').status,'INSPECTED');
 const fake=fakeBuilder(f);await assert.rejects(connectBuilder(fake.deps),/stage/);assert.equal(fake.counts().keyReads,0);
 const builder=await connectBuilder(fake.deps,undefined,undefined,'observe');assert.equal(builder.preflight().administrator_binding.stages[0],'observe');assert.equal(fake.counts().writeTokens,0);
 await assert.rejects(builder.push());assert.equal(fake.counts().writeTokens,0);
 const cli=spawnSync(process.execPath,['dist/admin-cli.js','validate','--version','observe-only','--stage','deliver'],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(cli.status,2);assert.match(cli.stderr,/stage_not_authorized/);
});
test('revoke a work item or its parent policy; active Builder stops before further requests; history is preserved',async t=>{
 const f=fixture(t);f.register();f.grant();const fake=fakeBuilder(f),builder=await connectBuilder(fake.deps),before=fake.counts();
 const path=f.file('revoke.json');prepareRevoke('revoke-v1','project-v1',path);f.pin(path);approveProposal(path);
 await assert.rejects(builder.push(),/revoked/);assert.deepEqual(fake.counts(),before);assert.throws(()=>builder.preflight(),/revoked/);
 assert.equal(inspectRegistry().generation,3);assert(existsSync(join(f.root,'task-v1.approval.json')));assert.throws(()=>f.prepare('later'),/revoked/);
});
test('wrong pin, real host, approval actor, expiry and changed historical bytes are refused',t=>{
 const f=fixture(t);f.register();const path=f.prepare(),receipt=f.pin(path),value=JSON.parse(readFileSync(receipt));value.operator.id++;writeFileSync(receipt,encode(value));process.env.AWH_ADMIN_APPROVAL_SHA256=digest(readFileSync(receipt));assert.throws(()=>approveProposal(path),/approval/);
 process.env.AWH_ADMIN_TRUST_SHA256='0'.repeat(64);assert.equal(diagnoseRegistry().code,'trust_digest');
 const trust=JSON.parse(readFileSync(f.trustFile));trust.host='other-host';writeFileSync(f.trustFile,encode(trust));process.env.AWH_ADMIN_TRUST_SHA256=digest(readFileSync(f.trustFile));assert.equal(diagnoseRegistry().code,'host_binding');
 trust.host=hostname();writeFileSync(f.trustFile,encode(trust));process.env.AWH_ADMIN_TRUST_SHA256=digest(readFileSync(f.trustFile));
 writeFileSync(join(f.root,'project-v1.policy.json'),'{}');assert.equal(diagnoseRegistry().code,'policy_digest');
});
test('stale proposal and receipt replay cannot change the state; exact duplicate is read-only idempotent',t=>{
 const f=fixture(t);f.register();const first=f.prepare(),stale=f.prepare('stale');f.pin(first);approveProposal(first);const state=readFileSync(join(f.root,'state.json'));
 assert.equal(approveProposal(first).status,'ALREADY_COMMITTED');assert.deepEqual(readFileSync(join(f.root,'state.json')),state);
 f.pin(stale);assert.throws(()=>approveProposal(stale),/stale_approval/);assert.deepEqual(readFileSync(join(f.root,'state.json')),state);
});
test('concurrent approvals have at most one successful state transition and no partial published generation',async t=>{
 const f=fixture(t);f.register();const path=f.prepare();f.pin(path);
 const run=()=>spawn(process.execPath,['dist/admin-cli.js','approve','--proposal',path,'--confirm'],{env:process.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 const children=[run(),run()],outputs=children.map(()=>''),exits=await Promise.all(children.map((child,index)=>{child.stdout.on('data',d=>outputs[index]+=d);child.stderr.resume();return once(child,'exit');}));
 assert(exits.some(([code])=>code===0));assert.equal(outputs.filter(o=>o.includes('"status":"APPROVED"')).length,1);assert.equal(inspectRegistry().generation,2);assert.equal(diagnoseRegistry().status,'INSPECTED');
});
test('actual process interruption leaves immutable evidence; pinned recovery completes only exact local bytes',t=>{
 const f=fixture(t);f.register();const path=f.prepare();f.pin(path);
 const operations=new URL('../dist/admin/operations.js',import.meta.url).href;
 const code="import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';let exitAfter=process.argv[2];const original=fs.writeFileSync;fs.writeFileSync=function(path,...args){original.call(this,path,...args);if(typeof path==='number')return;};const originalOpen=fs.openSync;const handles=new Map;fs.openSync=function(path,...args){const fd=originalOpen.call(this,path,...args);handles.set(fd,path);return fd;};const originalFsync=fs.fsyncSync;fs.fsyncSync=function(fd){originalFsync.call(this,fd);if(String(handles.get(fd)).endsWith(exitAfter))process.exit(73);};syncBuiltinESMExports();const {approveProposal}=await import("+JSON.stringify(operations)+");approveProposal(process.argv[1]);";
 const interrupted=spawnSync(process.execPath,['--input-type=module','-e',code,path,'state.pending.json'],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(interrupted.status,73,interrupted.stderr);
 assert.equal(inspectRegistry().generation,1);assert.equal(diagnoseRegistry().status,'BLOCKED');assert(existsSync(join(f.root,'admin.lock')));assert(existsSync(join(f.root,'state.pending.json')));
 assert.equal(approveProposal(path,true).status,'APPROVED');assert.equal(inspectRegistry().generation,2);assert.equal(diagnoseRegistry().status,'INSPECTED');assert(readdirSync(f.root).some(name=>name.startsWith('task-v1.recovered-lock-')));
});
test('recovery conflicts preserve evidence and do not overwrite files or steal live locks',t=>{
 const f=fixture(t);f.register();const path=f.prepare();f.pin(path);
 const proposed=JSON.parse(readFileSync(path));writeFileSync(join(f.root,'task-v1.transaction.json'),encode({proposal_sha256:digest(readFileSync(path)),approval_sha256:process.env.AWH_ADMIN_APPROVAL_SHA256,expected_state_sha256:proposed.expected_state_sha256}),{mode:0o600});writeFileSync(join(f.root,'task-v1.proposal.json'),'conflicting evidence',{mode:0o600});
 assert.throws(()=>approveProposal(path,true),/recovery_conflict/);assert.equal(readFileSync(join(f.root,'task-v1.proposal.json'),'utf8'),'conflicting evidence');assert.equal(inspectRegistry().generation,1);
 writeFileSync(join(f.root,'admin.lock'),encode({pid:process.pid,proposal_sha256:digest(readFileSync(path)),approval_sha256:process.env.AWH_ADMIN_APPROVAL_SHA256}),{mode:0o600});assert.throws(()=>approveProposal(path,true),/alive_or_unknown/);assert(existsSync(join(f.root,'admin.lock')));
});
test('real CLI registers, proposes, validates, approves and revokes without requiring an unproduced HEAD',t=>{
 const f=fixture(t),template=f.file('project.json');writeFileSync(template,encode(f.project),{mode:0o600});
 const run=(args,expected=0)=>{const result=spawnSync(process.execPath,['dist/admin-cli.js',...args],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(result.status,expected,result.stderr);return JSON.parse(result.stdout);};
 const pp=f.file('project-cli.json');assert.equal(run(['register','--policy',template,'--version','project-v1','--out',pp]).status,'PROPOSED');f.pin(pp);run(['approve','--proposal',pp,'--confirm']);
 const wp=f.file('work-cli.json'),task=f.task;run(['propose','--policy-version','project-v1','--profile',task.profile,'--workflow',task.workflow,'--repo',task.repository,'--issue','90','--branch',task.branch,'--base-sha',task.base_sha,'--executor',task.executor_id,'--machine',task.machine_id,'--expires-at',task.expires_at,'--version','task-v1','--out',wp]);
 assert.equal(run(['validate','--proposal',wp]).proposal.task.head_sha,null);f.pin(wp);run(['approve','--proposal',wp,'--confirm']);assert.equal(run(['validate','--version','task-v1','--stage','develop']).status,'LOCAL_STAGE_VALID');
 assert.deepEqual(run(['preflight','--version','task-v1']).task.provider_operations,[]);const revoke=f.file('cli-revoke.json');run(['revoke','--target','task-v1','--version','revocation','--out',revoke]);f.pin(revoke);run(['approve','--proposal',revoke,'--confirm']);assert.equal(run(['diagnose','--version','task-v1'],2).status,'BLOCKED');
});
test('CLI rejects duplicates, unexpected keys, arbitrary verbs and project-local sources',t=>{
 const f=fixture(t);
 for(const args of [['merge'],['approve','--confirm'],['diagnose','--confirm'],['inspect','--proposal',f.trustFile,'--proposal',f.trustFile],['register','--policy',resolve('tests/fixtures/builder-policy.json'),'--version','unsafe','--out',f.file('unsafe.json')]])
  assert.equal(spawnSync(process.execPath,['dist/admin-cli.js',...args],{env:process.env,encoding:'utf8',windowsHide:true}).status,2);
 assert(!existsSync(join(f.root,'state.json')));
});
test('proposal comparison, orphan diagnosis and inspect are read-only',t=>{
 const f=fixture(t),one=f.register();f.grant();const two=f.prepare('later');assert(compareProposals(one,two).changes.some(v=>v.field==='action'));
 const before=Object.fromEntries(readdirSync(f.root).map(name=>[name,digest(readFileSync(join(f.root,name)))]));inspectRegistry();launcherDescriptor('task-v1');assert.deepEqual(Object.fromEntries(readdirSync(f.root).map(name=>[name,digest(readFileSync(join(f.root,name)))])),before);
 writeFileSync(join(f.root,'orphan.policy.json'),'{}',{mode:0o600});assert.equal(diagnoseRegistry().status,'BLOCKED');assert(existsSync(join(f.root,'orphan.policy.json')));
});
function fakeBuilder(f,overrides={}) {
 const root=resolve('.'),{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),task=f.task,app=f.policy.installation;let keyReads=0,requests=0,writeTokens=0,head=overrides.head??'a'.repeat(40),remote=overrides.remote??null,commentBody='',mutations=0;const tokenRequests=[],transports=[];
 const response=value=>new Response(JSON.stringify(value));
 const pr=()=>({number:5,user:{login:app.app_slug+'[bot]',type:'Bot'},head:{sha:head,ref:task.branch,repo:{full_name:task.repository}},base:{sha:task.base_sha,ref:'main',repo:{full_name:task.repository}},draft:true,state:'open',node_id:'PR_synthetic'});
 const deps={env:{AWH_GITHUB_APP_ID:String(app.app_id),AWH_GITHUB_APP_PRIVATE_KEY_PATH:join(tmpdir(),'awh-ephemeral.pem')},cwd:()=>root,realpath:async p=>resolve(p),
  stat:async p=>{if(resolve(p)===join(root,'.git'))return {isDirectory:()=>true,isFile:()=>false};throw Object.assign(Error(),{code:'ENOENT'});},
  read:async()=>{keyReads++;return privateKey.export({type:'pkcs8',format:'pem'});},
  spawn:(_file,args)=>{let stdout='';if(args.includes('ls-remote')||args.includes('push'))transports.push([...args]);if(args[0]==='rev-parse')stdout=args[1]==='HEAD'?head:root;else if(args[0]==='config'&&!args.includes('--name-only'))stdout='https://github.com/'+task.repository+'.git';else if(args[0]==='branch')stdout=task.branch;else if(args[0]==='diff')stdout='README.md\0';else if(args.includes('push')&&!args.includes('--dry-run')){remote=head;if(overrides.uncertainPush)return {status:1,stdout:'',stderr:'Synthetic response lost after remote accepted Push'};}return {status:0,stdout,stderr:''};},
  fetch:async(url,options)=>{requests++;let data;const body=options.body?JSON.parse(options.body):null;
   if(url.endsWith('/app'))data={id:app.app_id,slug:app.app_slug};
   else if(url.endsWith('/installation'))data={id:app.installation_id,app_id:app.app_id,account:{login:app.account_login},repository_selection:'selected',suspended_at:null,permissions:{contents:'write',issues:'write',pull_requests:'write',metadata:'read'}};
   else if(url.endsWith('/access_tokens')){tokenRequests.push(body);if(Object.values(body.permissions).includes('write'))writeTokens++;data={token:'synthetic-secret-'+requests,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{...body.permissions,metadata:'read'},repositories:(body.repositories?[task.repository]:app.selected_repository_sets[0]).map(full_name=>({full_name}))};}
   else if(url.includes('/installation/repositories'))data={total_count:app.selected_repository_sets[0].length,repositories:app.selected_repository_sets[0].map(full_name=>({full_name}))};
   else if(url.endsWith('/git/ref/heads/main'))data={object:{sha:overrides.base??task.base_sha}};
   else if(url.includes('/git/ref/heads/codex/')){if(remote===null)return new Response('{}',{status:404});data={ref:'refs/heads/'+task.branch,url:url.replace('/git/ref/','/git/refs/'),object:{type:'commit',sha:remote,url:'https://api.github.com/repos/'+task.repository+'/git/commits/'+remote}};}
   else if(url.endsWith('/issues/'+task.issue))data={number:task.issue,state:'open',html_url:'https://github.com/'+task.repository+'/issues/'+task.issue};
   else if(url.includes('/compare/'))data={status:'ahead',files:[{filename:'README.md',status:'modified'}]};
   else if(url.endsWith('/pulls')||url.endsWith('/pulls/5')){if(options.method!=='GET'){mutations++;if(overrides.uncertainPR)throw Error('Response lost after Provider mutation');}data=pr();}
   else if(url.endsWith('/comments')||url.endsWith('/issues/comments/9')){if(body){mutations++;commentBody=body.body;}data={id:9,user:{login:app.app_slug+'[bot]',type:'Bot'},issue_url:'https://api.github.com/repos/'+task.repository+'/issues/5',body:commentBody};}
   else throw Error('Unexpected synthetic request '+url);
   return response(data);
  }};
 return {deps,counts:()=>({keyReads,requests,writeTokens,mutations}),tokenRequests,transports,setHead:v=>head=v,remoteHead:()=>remote,setRemote:v=>remote=v};
}

test('managed repeat Push rejects same-instance H1 and fresh H1/H2 connections before write tokens or transport',async t=>{
 const f=fixture(t);f.register();f.grant();assert.equal(loadTrustedPolicy().profiles[0].workflows[0].branch_mode,'fixed');assert.equal(managedContext().proposed.task.head_sha,null);
 const h1='a'.repeat(40),h2='c'.repeat(40),first=fakeBuilder(f),builder=await connectBuilder(first.deps);
 assert.equal(builder.preflight().task_binding,undefined);await builder.push();await builder.createPR('Draft','H1 candidate');assert.equal(first.remoteHead(),h1);
 const writes=first.counts().writeTokens,transports=first.transports.length;
 await assert.rejects(builder.push(),/already consumed/);assert.equal(first.counts().writeTokens,writes);assert.equal(first.transports.length,transports);assert.equal(first.remoteHead(),h1);
 for(const head of [h1,h2]){
  const fresh=fakeBuilder(f,{head,remote:first.remoteHead()}),next=await connectBuilder(fresh.deps);assert.equal(next.preflight().administrator_binding.head_sha,head);assert.equal(next.preflight().administrator_binding.authorization_version,'task-v1');
  await assert.rejects(next.push(),/already consumed/);assert.equal(fresh.counts().writeTokens,0);assert.deepEqual(fresh.transports,[]);assert.equal(fresh.remoteHead(),h1);
 }
});

test('managed repeat Push after a lost successful Push ACK permits only read-only ref reconciliation',async t=>{
 const f=fixture(t);f.register();f.grant();const first=fakeBuilder(f,{uncertainPush:true}),builder=await connectBuilder(first.deps);
 await assert.rejects(builder.push(),/App HTTPS Git push failed/);assert.equal(first.remoteHead(),'a'.repeat(40));
 const writes=first.counts().writeTokens,transports=first.transports.length;await assert.rejects(builder.push(),/Journal reconciliation/);assert.equal(first.counts().writeTokens,writes);assert.equal(first.transports.length,transports);
 const fresh=fakeBuilder(f,{head:'c'.repeat(40),remote:first.remoteHead()});await assert.rejects((await connectBuilder(fresh.deps)).push(),/already consumed/);assert.equal(fresh.counts().writeTokens,0);assert.deepEqual(fresh.transports,[]);assert.equal(fresh.remoteHead(),'a'.repeat(40));
});

for(const failure of ['network','malformed','foreign-head'])test('managed repeat Push fail-closed before write mint: '+failure,async t=>{
 const f=fixture(t);f.register();f.grant();const fake=fakeBuilder(f,{remote:failure==='foreign-head'?'d'.repeat(40):null}),fetch=fake.deps.fetch;
 fake.deps.fetch=async(url,options)=>{if(url.includes('/git/ref/heads/codex/')&&failure!=='foreign-head'){if(failure==='network')throw Error('Synthetic ref observation unavailable');return new Response(JSON.stringify({object:{sha:'invalid'}}));}return fetch(url,options);};
 const builder=await connectBuilder(fake.deps);await assert.rejects(builder.push(),failure==='foreign-head'?/already consumed/:/fixed feature ref/i);assert.equal(fake.counts().writeTokens,0);assert.deepEqual(fake.transports,[]);assert.equal(fake.remoteHead(),failure==='foreign-head'?'d'.repeat(40):null);
});

test('managed repeat Push retains the post-dry-run ref race gate',async t=>{
 const f=fixture(t);f.register();f.grant();const fake=fakeBuilder(f),spawn=fake.deps.spawn;
 fake.deps.spawn=(file,args,options)=>{const result=spawn(file,args,options);if(args.includes('--dry-run'))fake.setRemote('d'.repeat(40));return result;};
 await assert.rejects((await connectBuilder(fake.deps)).push(),/ref changed during receive-pack dry-run/);assert.equal(fake.counts().writeTokens,1);assert.equal(fake.transports.filter(args=>args.includes('push')&&!args.includes('--dry-run')).length,0);assert.equal(fake.remoteHead(),'d'.repeat(40));
});
test('existing Builder binds the actual final clean HEAD, uses minimum tokens, records identity and fails closed on changed candidate',async t=>{
 const f=fixture(t);f.register();f.grant();const fake=fakeBuilder(f),builder=await connectBuilder(fake.deps),binding=builder.preflight().administrator_binding;
 assert.equal(binding.head_sha,'a'.repeat(40));assert.equal(binding.authorization_version,'task-v1');assert.equal(fake.counts().writeTokens,0);
 await builder.push();const pr=await builder.createPR('Draft','Controlled task');assert(pr.draft);await builder.createComment(5,'Builder evidence\n'+binding.head_sha);await builder.createComment(5,'AWH-HANDOFF v0.1\npending');await builder.editComment(5,9,'AWH-HANDOFF v0.1\nconfirmed');
 const writes=fake.tokenRequests.filter(request=>Object.values(request.permissions).includes('write'));assert(writes.some(r=>r.permissions.contents==='write'));assert(writes.every(r=>Object.keys(r.permissions).length===1&&r.repositories.length===1));
 assert(!JSON.stringify(binding).includes('TRUST_'));await assert.rejects(builder.ready(5,binding.head_sha,{},9),/Review/);
 const before=fake.counts();fake.setHead('c'.repeat(40));await assert.rejects(builder.push(),/exact clean/);assert.deepEqual(fake.counts(),before);
});
test('known exact #65-style HEAD, identity and remote baseline mismatch fail before write tokens',async t=>{
 const f=fixture(t);f.register();f.grant('task-v1',{...f.task,head_sha:'a'.repeat(40)});
 for(const field of ['AWH_ADMIN_EXECUTOR_ID','AWH_ADMIN_MACHINE_ID']){const saved=process.env[field];process.env[field]='wrong';const fake=fakeBuilder(f);await assert.rejects(connectBuilder(fake.deps));assert.equal(fake.counts().keyReads,0);process.env[field]=saved;}
 const wrong=fakeBuilder(f,{head:'c'.repeat(40)});await assert.rejects(connectBuilder(wrong.deps),/exact clean/);assert.equal(wrong.counts().keyReads,0);
 const base=fakeBuilder(f,{base:'c'.repeat(40)});await assert.rejects(connectBuilder(base.deps),/remote base/);assert.equal(base.counts().writeTokens,0);
});
test('a narrower work-item operation set cannot inherit parent writes; uncertain PR creation is not automatically retried',async t=>{
 const f=fixture(t);f.register();f.grant('task-v1',{...f.task,provider_operations:['push']});const denied=fakeBuilder(f),builder=await connectBuilder(denied.deps);await builder.push();const before=denied.counts().mutations;await assert.rejects(builder.createPR('Draft','Scope'),/not authorized/);assert.equal(denied.counts().mutations,before);
 f.grant('task-v2');const uncertain=fakeBuilder(f,{uncertainPR:true}),next=await connectBuilder(uncertain.deps);await next.push();await assert.rejects(next.createPR('Draft','Uncertain'),/network/);assert.equal(uncertain.counts().mutations,1);
 await assert.rejects(next.createPR('Draft','Do not replay'),/Journal/);assert.equal(uncertain.counts().mutations,1);
});
test('expired tasks, expired approval windows and malformed managed trust cannot fall back to a legacy pin',t=>{
 const f=fixture(t);f.register();assert.throws(()=>f.prepare('expired',{...f.task,expires_at:new Date(Date.now()-1000).toISOString()}),/expired/);
 const path=f.prepare(),receipt=f.pin(path),value=JSON.parse(readFileSync(receipt));value.approved_at=new Date(Date.now()-3600000).toISOString();value.expires_at=new Date(Date.now()-1000).toISOString();writeFileSync(receipt,encode(value));process.env.AWH_ADMIN_APPROVAL_SHA256=digest(readFileSync(receipt));assert.throws(()=>approveProposal(path),/approval/);
 const legacy=f.file('legacy.json');writeFileSync(legacy,encode(f.policy),{mode:0o600});process.env.AWH_BUILDER_POLICY_FILE=legacy;process.env.AWH_BUILDER_POLICY_SHA256=digest(readFileSync(legacy));process.env.AWH_ADMIN_TRUST_SHA256='0'.repeat(64);assert.throws(()=>loadTrustedPolicy(),/approved Builder policy/);
});
test('complete selected-set inspection pages metadata only before any single-repository write token',async t=>{
 const f=fixture(t);f.policy.installation.selected_repository_sets[0].push(...Array.from({length:100},(_,i)=>f.policy.installation.account_login+'/extra-'+i));
 const trust=JSON.parse(readFileSync(f.trustFile));trust.installation_sha256=digest(encode(f.policy.installation));writeFileSync(f.trustFile,encode(trust));process.env.AWH_ADMIN_TRUST_SHA256=digest(readFileSync(f.trustFile));f.register();f.grant();
 const fake=fakeBuilder(f),original=fake.deps.fetch,pages=[];fake.deps.fetch=async(url,options)=>{const response=await original(url,options);if(!url.includes('/installation/repositories'))return response;pages.push(url);const value=await response.json(),page=Number(new URL(url).searchParams.get('page')??1);return new Response(JSON.stringify({...value,repositories:value.repositories.slice((page-1)*100,page*100)}));};
 const builder=await connectBuilder(fake.deps);assert.equal(pages.length,2);assert.equal(builder.preflight().repositories.length,101);assert.equal(fake.counts().writeTokens,0);assert.deepEqual(fake.tokenRequests[0].permissions,{metadata:'read'});
});
test('interruption immediately after atomic switch recovers the dead lock without replaying the generation',t=>{
 const f=fixture(t);f.register();const path=f.prepare();f.pin(path);
 const operations=new URL('../dist/admin/operations.js',import.meta.url).href;
 const code="import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.renameSync;fs.renameSync=function(...args){original(...args);process.exit(73);};syncBuiltinESMExports();const {approveProposal}=await import("+JSON.stringify(operations)+");approveProposal(process.argv[1]);";
 const interrupted=spawnSync(process.execPath,['--input-type=module','-e',code,path],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(interrupted.status,73);const committed=readFileSync(join(f.root,'state.json'));assert.equal(inspectRegistry().generation,2);
 assert.equal(approveProposal(path,true).status,'ALREADY_COMMITTED');assert.deepEqual(readFileSync(join(f.root,'state.json')),committed);assert.equal(diagnoseRegistry().status,'INSPECTED');
});
