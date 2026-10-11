import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { npmEntry, npmEnv } from './npm-tool.mjs';
import { specs, sha256, tree } from './release-lib.mjs';
import { readZip } from './release-archive.mjs';
import { validateRelease } from './release-validate.mjs';

const args=process.argv.slice(2);
assert(args.length===5&&args[1]==='--expected-head'&&args[3]==='--evidence','release-smoke <kit> --expected-head <sha> --evidence <new-dir>');
assert.equal(process.platform,'win32','This acceptance is Windows only; other platforms remain NOTRUN');
const kit=realpathSync(args[0]), head=args[2], evidence=resolve(args[4]);
mkdirSync(evidence); const audit=validateRelease(kit,head), manifest=JSON.parse(readFileSync(join(kit,'release-manifest.json')));
const scratch=mkdtempSync(join(tmpdir(),'awh-m1-b1-离仓 space-')), install=join(scratch,'install'),cache=join(scratch,'empty-cache'),repo=join(scratch,'consumer');
mkdirSync(install); mkdirSync(repo);
const env=npmEnv(cache); delete env.NODE_PATH; delete env.NODE_EXTRA_CA_CERTS;
const children=new Set(),checks={archive_audit:'PASS'},commands=[],powershell=[];
const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
const run=(file,argv,{cwd=scratch,status=0,allowed=[status],label='command',channel='stdout'}={})=>{
  const r=spawnSync(file,argv,{cwd,env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
  commands.push({label,exit_code:r.status,expected:allowed});
  // CLI output is already sanitized; no external credentials/config bytes are logged.
  writeFileSync(join(evidence,'commands.log'),`\n${label}: exit=${r.status}\n${r.stdout??''}${r.stderr??''}`,{flag:'a'});
  assert(allowed.includes(r.status),label+' failed: '+r.stderr); return r[channel].trim();
};
const node=(argv,options)=>run(process.execPath,argv,options);
const modulePath=(id,path)=>join(install,'node_modules','@zlpoot',id,path);
const entry=id=>modulePath(id,Object.values(specs[id].bin)[0]);
const port=async()=>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const p=server.address().port;await new Promise(done=>server.close(done));return p;};
const launcher=join(scratch,'launch.mjs');
writeFileSync(launcher,"process.on('message',m=>{if(m==='stop'){process.disconnect();process.emit('SIGTERM');}});const {main}=await import(process.argv[2]);await main(JSON.parse(process.argv[3]));\n");
const start=async(id,argv,installedEntry=entry(id))=>{
  const child=fork(launcher,[pathToFileURL(installedEntry).href,JSON.stringify(argv)],{cwd:scratch,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  children.add(child); let output='',error='';
  child.stdout.on('data',b=>{output+=b;writeFileSync(join(evidence,id+'-server.log'),b,{flag:'a'});});
  child.stderr.on('data',b=>{error+=b;writeFileSync(join(evidence,id+'-server.log'),b,{flag:'a'});});
  const until=Date.now()+15000;
  while(!output.includes(id==='awh-viewer'?'existing_v2_readonly':'listening at')){assert.equal(child.exitCode,null,error);assert(Date.now()<until,'Startup timeout');await delay(50);}
  return child;
};
const stop=async child=>{
  const exited=once(child,'exit');child.send('stop');const timer=setTimeout(()=>child.kill(),15000);
  try{const [code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);}finally{clearTimeout(timer);children.delete(child);}
};
const installAll=()=>node([npmEntry(),'install','--prefix',install,'--offline','--ignore-scripts','--no-audit','--no-fund',...manifest.artifacts.filter(a=>a.target==='universal').map(a=>join(kit,a.filename))],{label:'empty-cache offline install'});
let failure=null;
try {
  installAll();checks.offline_install='PASS';
  for(const id of Object.keys(specs).filter(id=>specs[id].name)) {
    const pkg=JSON.parse(readFileSync(modulePath(id,'package.json')));assert.equal(pkg.version,specs[id].version);
    for(const bin of Object.values(specs[id].bin))assert(readFileSync(modulePath(id,bin),'utf8').startsWith('#!/usr/bin/env node'));
  }
  for(const shell of [join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),'pwsh.exe']) {
    powershell.push(run(shell,['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()'],{label:'PowerShell runtime '+shell}));
    const shim=join(install,'node_modules/.bin/awh.cmd').replaceAll("'","''");
    const version=run(shell,['-NoProfile','-NonInteractive','-Command',`& '${shim}' --version; exit $LASTEXITCODE`],{label:'installed .cmd via '+shell});
    assert.equal(JSON.parse(version).version,specs['awh-client'].version);
  }checks.powershell_51_7='PASS';
  // This is a synthetic isolated Git consumer, never an approved Provider target.
  const git=argv=>run('git',['-c','commit.gpgsign=false','-c','core.hooksPath=NUL',...argv],{cwd:repo,label:'isolated Git '+argv[0]});
  git(['init','-b','main']);git(['config','user.name','Isolated smoke']);git(['config','user.email','smoke@example.invalid']);
  git(['remote','add','origin','https://github.com/example-org/release-smoke.git']);writeFileSync(join(repo,'source.txt'),'synthetic isolated Observe consumer\n');writeFileSync(join(repo,'.gitignore'),'.handoff/\n');
  git(['add','source.txt','.gitignore']);git(['commit','-m','synthetic Observe source']);
  const cpPort=await port(), viewerPort=await port(), endpoint='http://127.0.0.1:'+cpPort;
  assert.notEqual(cpPort,viewerPort);
  const home=join(scratch,'external-home'),machine=join(scratch,'machine-config.json');mkdirSync(home);
  const client=entry('awh-client'),cpEntry=entry('awh-control-plane');
  node([client,'setup','--machine-config',machine,'--home',home,'--endpoint',endpoint,'--project-root',repo],{cwd:repo,label:'installed Client setup'});
  const preview=JSON.parse(node([client,'init','--machine-config',machine,'--directory',repo,'--confirm'],{cwd:repo,label:'Observe request'}));
  const trusted=join(scratch,'trusted.json'),database=join(scratch,'new.sqlite'),runtime=join(scratch,'cp-runtime.json');
  const policy={schema_version:'1.0',kind:'profile_policy',ref:'smoke/unused',version:'synthetic-v1',repository:'example-org/release-smoke',base:'main',branch:{mode:'fixed',ref:'codex/smoke'},verification:{commands:['git diff --check origin/main...HEAD']},github_app:{identity:'installation',repository_scope:'single',selected_set_policy:'exact',permissions:{contents:'write',issues:'write',metadata:'read',pull_requests:'write'}},review:{mode:'independent_exact_head',builder_is_reviewer:false},delivery:{draft_pr:true,handoff_version:'0.1',confirmed_publication_required:true,exact_head_required:true},executor_restrictions:null};
  write(trusted,{clients:[{id:'synthetic-unused',project_ids:['synthetic-unused'],executor_ids:['synthetic-unused'],token_sha256:sha256(randomBytes(32))}],profiles:[policy]});write(runtime,{schema_version:'1.0',database,trusted_config_file:trusted,port:cpPort});
  node([cpEntry,'init','--runtime-config',runtime],{label:'CP new database init'});
  const beforeInit=sha256(readFileSync(database));node([cpEntry,'init','--runtime-config',runtime],{status:1,label:'CP repeated init refuses'});assert.equal(sha256(readFileSync(database)),beforeInit);
  const approved=JSON.parse(node([cpEntry,'approve-project','--request',preview.request_file,'--config',trusted,'--database',database,'--confirm'],{label:'synthetic local Observe approval'}));assert.equal(approved.capability,'register_presence');
  const cp=await start('awh-control-plane',['serve','--runtime-config',runtime]);checks.cp_start='PASS';
  const completed=JSON.parse(node([client,'init','--machine-config',machine,'--directory',repo,'--complete','--confirm'],{cwd:repo,label:'Observe complete'}));assert.equal(completed.status,'registered');
  const config=completed.config_file,state=JSON.parse(readFileSync(config)).state_directory;
  const session=join(state,readdirSync(state).find(n=>/^[a-f0-9]{64}$/.test(n)),'session.json'),initial=readFileSync(session);
  const identity=readFileSync(join(state,'machine.json'));
  node([client,'--config',config,'register'],{cwd:repo,label:'repeat register'});assert.deepEqual(readFileSync(session),initial);checks.client_session='PASS';
  const doctor=JSON.parse(node([client,'--config',config,'doctor','--json','--probe-cp'],{cwd:repo,allowed:[0,2],label:'installed Doctor CP GET probe'}));
  for(const id of ['installation','profile','client_state','cp_connection','cp_profile','cp_executor'])assert.equal(doctor.checks.find(c=>c.id===id)?.status,'passed',id);
  assert.equal(doctor.authority_verified,false);checks.observe_doctor='PASS';
  writeFileSync(join(scratch,'pr-body.md'),'synthetic denied Deliver\n');
  const denied=JSON.parse(node([client,'--config',config,'deliver','--title','must refuse','--body',join(scratch,'pr-body.md'),'--hold-draft'],{cwd:repo,status:2,label:'Observe cannot Deliver',channel:'stderr'}));
  assert(['http','profile','delivery_policy','enrollment_binding'].includes(denied.error?.code),'Must reject for authorization, not an unrelated setup error');
  assert.deepEqual(readFileSync(session),initial);checks.unauthorized_deliver='PASS';
  node([entry('awh-builder'),'preflight'],{cwd:repo,status:2,label:'Builder missing external authorization'});checks.builder_fail_closed='PASS';
  for(const id of ['awh-client','awh-viewer']) {
    const result=node(['--input-type=module','-e',`const {managedContext}=await import(${JSON.stringify(pathToFileURL(modulePath(id,'dist/admin/registry.js')).href)});if(managedContext({})!==null)process.exit(1);console.log('read-only loader PASS');`],{label:id+' read-only loader'});assert(result.includes('PASS'));
    assert(!Object.keys(tree(modulePath(id,'dist'))).some(p=>p==='admin-cli.js'||p==='admin/operations.js'));
  }checks.readonly_loaders='PASS';
  await stop(cp);checks.cp_stop='PASS'; const dbBefore=sha256(readFileSync(database));
  const viewerConfig=join(scratch,'viewer.json');
  write(viewerConfig,{schema_version:'1.0',mode:'local_browser_direct',database,port:viewerPort,viewer:{id:'smoke-viewer',project_ids:[completed.project_id]},local_bindings:[]});
  const viewer=await start('awh-viewer',['--config',viewerConfig]),origin='http://127.0.0.1:'+viewerPort;
  assert.equal((await fetch(origin+'/dashboard')).status,401);
  // Fetch overrides Sec-Fetch-Mode; use HTTP to send the same explicit navigation as a browser.
  const navigation=await new Promise((done,reject)=>{
    const req=request(origin+'/dashboard',{headers:{'Sec-Fetch-Site':'none','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>done({status:res.statusCode,cookie:res.headers['set-cookie']?.[0],body}));});req.on('error',reject);req.end();
  });assert.equal(navigation.status,200);
  const cookie=navigation.cookie.split(';')[0];assert(navigation.body.includes('AWH'));
  for(const path of ['/dashboard/app.js','/dashboard/app.css','/dashboard/v1/snapshot']) {
    const response=await fetch(origin+path,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert(response.headers.get('content-security-policy'));
    if(path.endsWith('snapshot')){const snapshot=await response.json();write(join(evidence,'viewer-snapshot.json'),snapshot);assert(JSON.stringify(snapshot).includes(completed.project_id));}else await response.arrayBuffer();
  }
  const ui=manifest.artifacts.find(a=>a.target==='static'),assets=readZip(readFileSync(join(kit,ui.filename)));
  const uiDir=join(scratch,'unpacked-ui');mkdirSync(uiDir);
  for(const [name,body] of assets){const path=join(uiDir,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,body);}
  for(const name of ['index.html','app.js','app.css','validators.cjs'])assert.deepEqual(readFileSync(modulePath('awh-viewer','dist/dashboard-ui/'+name)),readFileSync(join(uiDir,name)));
  await stop(viewer);assert.equal(sha256(readFileSync(database)),dbBefore);checks.viewer_display_readonly='PASS';checks.ui_unpacked='PASS';
  const restarted=await start('awh-control-plane',['serve','--runtime-config',runtime]);
  const status=JSON.parse(node([client,'--config',config,'status'],{cwd:repo,label:'CP restart retained Client'}));assert.equal(status.authority_verified,false);
  await stop(restarted);checks.restart='PASS';
  const reinstall=join(scratch,'reinstall'),cache2=join(scratch,'second-empty-cache');mkdirSync(reinstall);
  const env2=npmEnv(cache2),r=spawnSync(process.execPath,[npmEntry(),'install','--prefix',reinstall,'--offline','--ignore-scripts','--no-audit','--no-fund',...manifest.artifacts.filter(a=>a.target==='universal').map(a=>join(kit,a.filename))],{cwd:scratch,env:env2,encoding:'utf8',windowsHide:true,timeout:60000});
  writeFileSync(join(evidence,'reinstall.log'),(r.stdout??'')+(r.stderr??''));assert.equal(r.status,0);
  const reClient=join(reinstall,'node_modules/@zlpoot/awh-client/dist/client/cli.js');assert.equal(JSON.parse(node([reClient,'--version'],{label:'reinstalled version'})).version,specs['awh-client'].version);
  const reCP=await start('awh-control-plane',['serve','--runtime-config',runtime],join(reinstall,'node_modules/@zlpoot/awh-control-plane/dist/control-plane-cli.js'));
  node([reClient,'--config',config,'register'],{cwd:repo,label:'reinstalled Client retained identity and Session'});await stop(reCP);
  assert.deepEqual(readFileSync(session),initial);assert.deepEqual(readFileSync(join(state,'machine.json')),identity);checks.reinstall='PASS';
  for(const p of [cpPort,viewerPort]){const server=createServer();server.listen(p,'127.0.0.1');await once(server,'listening');await new Promise(done=>server.close(done));}checks.ports_released='PASS';
} catch(error) {
  failure={name:error.name,message:error.message,stack:error.stack};write(join(evidence,'failure.json'),failure);process.exitCode=1;
} finally {
  await Promise.allSettled([...children].map(async child=>{const exited=once(child,'exit');child.kill();await exited;}));
  const result={schema_version:'1.0',kind:'awh_windows_package_smoke',source_commit:head,status:failure?'BLOCKED':'PASS',environment:{os:process.platform,cpu:process.arch,node:process.version,powershell},artifacts:manifest.artifacts.map(({component,filename,sha256})=>({component,filename,sha256})),audit,checks,commands,failure,scratch_retained:scratch,production_touched:false,provider_writes:0,fixture_provenance:'synthetic isolated Observe consumer; no business E2E claim',browser_full_flow:'NOTRUN',mac:'NOTRUN'};
  write(join(evidence,'result.json'),result);console.log(JSON.stringify(result));
}
