// SYNTHETIC ONLY: ephemeral administrator, Git repository, SQLite CP and GitHub App.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {proposeProject,prepareGrant,prepareApproval,approveProposal} from '../dist/admin/operations.js';
import {digest,encode} from '../dist/admin/registry.js';
import {connectBuilder} from '../dist/builder.js';
import {policyFor} from './workflow-fixture.mjs';
import {AwhClient} from '../dist/client/client.js';
import {ControlPlaneStore} from '../dist/control-plane/store.js';
export async function managedHarness(t) {
 const keys=['AWH_ADMIN_TRUST_FILE','AWH_ADMIN_TRUST_SHA256','AWH_ADMIN_APPROVAL_FILE','AWH_ADMIN_APPROVAL_SHA256','AWH_ADMIN_VERSION','AWH_ADMIN_EXECUTOR_ID','AWH_ADMIN_MACHINE_ID','AWH_BUILDER_POLICY_FILE','AWH_BUILDER_POLICY_SHA256'];
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));keys.forEach(k=>delete process.env[k]);
 const base=mkdtempSync(join(tmpdir(),'awh-stage-synthetic-')),repo=join(base,'repo'),registry=join(base,'registry'),state=join(base,'state');[repo,registry,state].forEach(p=>mkdirSync(p,{mode:0o700}));
 const git=args=>{const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(k)));const r=spawnSync('git',['-c','commit.gpgsign=false','-c','core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null'),...args],{cwd:repo,env:{...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'},encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 const repository='example-org/workflow-code';git(['init','-b','main']);git(['config','user.name','Synthetic']);git(['config','user.email','fixture@example.invalid']);git(['remote','add','origin','https://github.com/'+repository+'.git']);
 mkdirSync(join(repo,'.awh'));writeFileSync(join(repo,'.awh/project.yaml'),'apiVersion: awh/v1\nproject:\n  id: workflow-code\n  repository: '+repository+'\nprofile:\n  ref: code/develop\n');writeFileSync(join(repo,'.gitignore'),'.handoff/\n');writeFileSync(join(repo,'code.ts'),'export const value = 0;\n');git(['add','.']);git(['commit','-m','base']);const baseSha=git(['rev-parse','HEAD']);git(['update-ref','refs/remotes/origin/main',baseSha]);git(['switch','-c','codex/code-90']);
 const commit=(v)=>{writeFileSync(join(repo,'code.ts'),'export const value = '+v+';\n');git(['add','.']);git(['commit','-m','code '+v]);return git(['rev-parse','HEAD']);};commit(1);
 const policy=JSON.parse(readFileSync(new URL('./fixtures/builder-policy.json',import.meta.url))),installation=policy.installation;
 installation.selected_repository_sets=[[repository, 'example-org/other-installed']];installation.reviewers=[{login:'reviewer',id:321}];
 policy.default_selection={profile:'code',workflow:'develop'};policy.profiles=[{id:'code',repository,base:'main',workflows:[{id:'develop',version:'template-v1',branch_mode:'issue_prefix',branch:'codex/code-',work_item:{repo:repository,issue:0},bootstrap_paths:null,verification_commands:['pnpm typecheck','pnpm build'],executor_restrictions:{executor_ids:['codex-fixture'],machine_ids:['stage-machine']}}]}];
 const project={builder_policy:policy,stages:['observe','develop','deliver'],permissions:{contents:'write',issues:'read',pull_requests:'write'}},trust={schema_version:'1.0',kind:'admin_trust',registry_root:registry,operator:{login:'fixture-admin',id:987},installation_sha256:digest(encode(installation)),host:hostname()};
 const tf=join(base,'trust.json');writeFileSync(tf,encode(trust),{mode:0o600});process.env.AWH_ADMIN_TRUST_FILE=tf;process.env.AWH_ADMIN_TRUST_SHA256=digest(encode(trust));
 const approve=path=>{const v=JSON.parse(readFileSync(path)).version,rf=join(base,v+'.approval.json');prepareApproval(path,'receipt-'+v,'Synthetic test approval only',rf);process.env.AWH_ADMIN_APPROVAL_FILE=rf;process.env.AWH_ADMIN_APPROVAL_SHA256=digest(readFileSync(rf));approveProposal(path);};
 const pp=join(base,'project.json');proposeProject(project,'project-v1',pp);approve(pp);
 const task={repository,issue:90,branch:'codex/code-90',base_sha:baseSha,head_sha:null,profile:'code',workflow:'develop',executor_id:'codex-fixture',machine_id:'stage-machine',expires_at:new Date(Date.now()+86400000).toISOString(),stages:['observe','develop','deliver'],provider_operations:['push','draft_pr','evidence','handoff']};
 const activate=v=>{process.env.AWH_ADMIN_VERSION=v;process.env.AWH_ADMIN_EXECUTOR_ID=task.executor_id;process.env.AWH_ADMIN_MACHINE_ID=task.machine_id;};
 const grant=(v,changed=task)=>{const p=join(base,v+'.proposal.json');prepareGrant('project-v1',v,changed,p);approve(p);activate(v);return p;};
 grant('task-90');const p90=policyFor('code','develop');grant('task-91',{...task,issue:91,branch:'codex/code-91'});const p91=policyFor('code','develop');activate('task-90');
 const credential=join(base,'cp-token'),configPath=join(base,'client.json'),config={schema_version:'1.0',endpoint:'http://127.0.0.1:4310',credential_file:credential,state_directory:state,executor_id:task.executor_id,executor_type:'codex',profile_version:'task-90'};writeFileSync(credential,'awh_cp_'+randomBytes(32).toString('base64url'),{mode:0o600});writeFileSync(configPath,encode(config));writeFileSync(join(state,'machine.json'),encode({schema_version:'1.0',id:task.machine_id,name:'synthetic-machine',platform:process.platform==='win32'?'windows':'linux',arch:process.arch}));
 const p91Fresh={...p91,version:'task-91-current'};
 const client=new AwhClient(configPath,repo),principal={id:'test-client',project_ids:['workflow-code'],executor_ids:[task.executor_id]},store=new ControlPlaneStore(join(base,'cp.sqlite'),[p90,p91,p91Fresh],undefined,'initialize');let cpFault=null;const attempts=[];
 client.request=async(c,path,method='GET',data)=>{const u=new URL(path,'http://fixture'),parts=u.pathname.split('/');let v;
  if(path==='/v1/workflow-capabilities')v={develop_to_pr:'stage-v1',managed_revision:'exact-grant-v1'};
  else if(path==='/v1/capabilities')v={revision_linking:'revision-link-v1',database_version:2};
  else if(path==='/v1/projects/register')v=store.registerProject(principal,data);
  else if(path==='/v1/executors/register')v=store.registerExecutor(principal,data.executor,data.client);
  else if(parts.at(-1)==='heartbeat')v=store.heartbeat(principal,parts[3]);
  else if(path==='/v1/executors')v={executors:store.listExecutors(principal)};
  else if(parts[2]==='projects')v={project:store.getProject(principal,parts[3])};
  else if(parts[2]==='profiles')v={profiles:store.listProfiles(principal,u.searchParams.get('project_id'))};
  else if(path==='/v1/work-items/register')v=store.registerWorkItem(principal,data);
  else if(path==='/v1/runs')v=store.createRun(principal,data);
  else if(parts.at(-1)==='events'&&method==='POST'){attempts.push(structuredClone(data));v=store.append(principal,parts[3],data);if(cpFault===data.type){cpFault=null;throw Error('Synthetic CP ACK lost');}}
  else if(parts.at(-1)==='events')v={events:store.listEvents(principal,parts[3],Number(u.searchParams.get('after')),100)};
  else if(parts[2]==='runs')v={run:store.getRun(principal,parts[3])};else throw Error('Unexpected CP route '+path);return {...v,authority_verified:false};};
 await client.register();
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),actor=installation.app_slug+'[bot]',branches=new Map(),prs=new Map(),comments=new Map(),tokens=[],transports=[],counts={push:0,pr:0,comment:0,patch:0,verify:0};let providerFault=null,currentBase=baseSha,verifyExit=0,nextPR=7,nextComment=100;
 const rawPR=p=>({number:p.number,user:{login:actor,type:'Bot'},head:{sha:branches.get(p.branch),ref:p.branch,repo:{full_name:repository}},base:{sha:p.base,ref:'main',repo:{full_name:repository}},draft:true,state:p.merged?'closed':'open',merged:p.merged,merge_commit_sha:p.merged?currentBase:null,node_id:'PR_fixture'});
 const rawComment=(id)=>{const c=comments.get(id);return{id,user:{login:actor,type:'Bot'},issue_url:'https://api.github.com/repos/'+repository+'/issues/'+c.pr,body:c.body};};
 const builderDeps={cwd:()=>repo,realpath:async p=>p===join(base,'ephemeral.pem')?p:realpathSync(p),env:{AWH_GITHUB_APP_ID:String(installation.app_id),AWH_GITHUB_APP_PRIVATE_KEY_PATH:join(base,'ephemeral.pem')},read:async()=>privateKey.export({type:'pkcs8',format:'pem'}),
  stat:async p=>{if(p===join(repo,'.git'))return{isDirectory:()=>true,isFile:()=>false};throw Object.assign(Error(),{code:'ENOENT'});},
  spawn:(file,args,opts)=>{if(args.includes('ls-remote')||args.includes('push')){transports.push(args);if(args.includes('push')&&!args.includes('--dry-run')){counts.push++;branches.set(git(['branch','--show-current']),git(['rev-parse','HEAD']));if(providerFault==='push'){providerFault=null;return{status:1,stdout:'',stderr:'Synthetic ACK lost'};}}return{status:0,stdout:'',stderr:''};}return spawnSync(file,args,{...opts,windowsHide:true});},
  fetch:async(url,opts)=>{const path=new URL(url).pathname,body=opts.body?JSON.parse(opts.body):null,method=opts.method;let data;
   if(path==='/app')data={id:installation.app_id,slug:installation.app_slug};
   else if(path.endsWith('/installation'))data={id:installation.installation_id,app_id:installation.app_id,account:{login:installation.account_login},repository_selection:'selected',suspended_at:null,permissions:{contents:'write',issues:'write',pull_requests:'write',metadata:'read'}};
   else if(path.endsWith('/access_tokens')){tokens.push(body);data={token:'synthetic-installation-'+tokens.length,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{...body.permissions,metadata:'read'},repositories:(body.repositories?[repository]:installation.selected_repository_sets[0]).map(full_name=>({full_name}))};}
   else if(path==='/installation/repositories')data={total_count:2,repositories:installation.selected_repository_sets[0].map(full_name=>({full_name}))};
   else if(path.endsWith('/git/ref/heads/main'))data={object:{sha:currentBase}};
   else if(path.includes('/git/ref/heads/codex/')){const branch=path.split('/git/ref/heads/')[1],head=branches.get(branch);if(!head)return new Response('{}',{status:404});data={ref:'refs/heads/'+branch,url:url.replace('/git/ref/','/git/refs/'),object:{type:'commit',sha:head,url:'https://api.github.com/repos/'+repository+'/git/commits/'+head}};}
   else if(/\/pulls\/\d+\/reviews$/.test(path)){const p=prs.get(Number(path.split('/').at(-2)));data=p.reviews;}
   else if(path.endsWith('/pulls')&&method==='POST'){const n=nextPR++;counts.pr++;prs.set(n,{number:n,branch:body.head,base:currentBase,issue:Number(body.head.split('-').at(-1)),merged:false,reviews:[]});data=rawPR(prs.get(n));if(providerFault==='pr'){providerFault=null;throw Error('Synthetic PR ACK lost');}}
   else if(path.endsWith('/pulls')&&method==='GET'){const branch=new URL(url).searchParams.get('head')?.split(':')[1];data=[...prs.values()].filter(p=>p.branch===branch).map(rawPR);}
   else if(/\/pulls\/\d+$/.test(path))data=rawPR(prs.get(Number(path.split('/').at(-1))));
   else if(/\/issues\/\d+$/.test(path)){const n=Number(path.split('/').at(-1)),p=[...prs.values()].find(p=>p.issue===n);data={number:n,state:p?.merged?'closed':'open',html_url:'https://github.com/'+repository+'/issues/'+n};}
   else if(/\/issues\/\d+\/comments$/.test(path)){const n=Number(path.split('/').at(-2));if(method==='POST'){counts.comment++;const id=nextComment++;comments.set(id,{pr:n,body:body.body});data=rawComment(id);if(providerFault==='evidence'&&body.body.startsWith('Builder evidence')){providerFault=null;throw Error('Synthetic Evidence ACK lost');}}else data=[...comments].filter(([_,v])=>v.pr===n).map(([id])=>rawComment(id));}
   else if(/\/issues\/comments\/\d+$/.test(path)){const id=Number(path.split('/').at(-1));if(method==='PATCH'){counts.patch++;comments.get(id).body=body.body;}data=rawComment(id);}
   else throw Error('Unexpected Provider route '+path);return new Response(JSON.stringify(data));}};
 const connect=async(o,selection,binding,mode,adoption)=>connectBuilder({...builderDeps,...o},selection,binding,mode,adoption),deps={connect,verify:async command=>{counts.verify++;return{command,exit_code:verifyExit,stdout:'SYNTHETIC verifier only\n# tests 1\n# pass '+(verifyExit?0:1)+'\n# fail '+(verifyExit?1:0),stderr:verifyExit?'synthetic failure':'',elapsed_ms:1};}};
 const session=()=>join(state,readdirSync(state).find(n=>/^[a-f0-9]{64}$/.test(n)),'session.json');
 const revision=(run,pr,previous,version='revision-90')=>grant(version,{...task,head_sha:git(['rev-parse','HEAD']),provider_operations:['push','evidence','handoff'],revision:{original_version:'task-90',run_id:run,pull_request:pr,previous_head:previous,review_id:900}});
 t.after(()=>{const evidence=join(process.cwd(),'.handoff','scenarios');mkdirSync(evidence,{recursive:true});
  writeFileSync(join(evidence,base.split(/[\\/]/).at(-1)+'.json'),encode({kind:'synthetic_workflow_trace',live_provider:false,test:t.name,counts,token_requests:tokens,transports,
   runs:store.listRuns(principal,'workflow-code').map(run=>({run,events:store.listEvents(principal,run.id)})),comments:[...comments],branches:[...branches],
   local_audit:readdirSync(dirname(session())).filter(n=>n==='session.json'||n.endsWith('.delivery.json')||n.endsWith('.recovery.json')).map(n=>({name:n,record:JSON.parse(readFileSync(join(dirname(session()),n),'utf8'))})),
   verification:readdirSync(join(repo,'.handoff')).filter(n=>n.startsWith('run-')).flatMap(n=>{const p=join(repo,'.handoff',n,'verification.json');try{return[{run:n,record:JSON.parse(readFileSync(p,'utf8'))}];}catch{return[];}})}));
  store.close();for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}assert.equal(dirname(base),tmpdir());assert(base.startsWith(join(tmpdir(),'awh-stage-synthetic-')));rmSync(base,{recursive:true,force:true});});
 return {repo,base,git,commit,task,grant,activate,client,store,counts,deps,connect,comments,prs,branches,tokens,transports,session,revision,attempts,events:id=>store.listEvents(principal,id).map(v=>v.event),
  review:(pr,state='CHANGES_REQUESTED',id=900)=>prs.get(pr).reviews.push({id,commit_id:branches.get(prs.get(pr).branch),state,user:{login:'reviewer',id:321,type:'User'}}),
  merge:pr=>{prs.get(pr).merged=true;const branch=git(['branch','--show-current']);git(['switch','main']);git(['merge','--no-ff',branch,'-m','Synthetic Human merge']);currentBase=git(['rev-parse','HEAD']);git(['update-ref','refs/remotes/origin/main',currentBase]);git(['switch',branch]);},fault:v=>providerFault=v,cpFault:v=>cpFault=v,failVerify:()=>verifyExit=1,passVerify:()=>verifyExit=0,
  next:()=>{git(['switch','-c','codex/code-91','main']);commit(91);grant('task-91-current',{...task,issue:91,branch:'codex/code-91',base_sha:currentBase});config.profile_version='task-91-current';writeFileSync(configPath,encode(config));}};
}
