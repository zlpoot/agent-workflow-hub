import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { join, dirname, relative, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, fork } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { npmEntry, npmEnv } from './npm-tool.mjs';
import { ids, specs, sha256, checkCandidate, checkArtifact } from './release-lib.mjs';
import { readZip } from './release-archive.mjs';

const args=process.argv.slice(2);assert((args.length===1||args.length===3&&args[1]==='--ui-from'),'release-smoke <candidate-dir> [--ui-from <candidate-dir>]');
const root=dirname(dirname(fileURLToPath(import.meta.url))), candidateDir=realpathSync(args[0]), candidate=JSON.parse(readFileSync(join(candidateDir,'candidate-index.json'))), target=process.platform+'-'+process.arch;
checkCandidate(candidate,name=>readFileSync(join(candidateDir,name)));assert.equal(candidate.target,target,'Smoke requires actual target hardware');
let uiArtifact=candidate.artifacts.find(a=>a.component==='awh-dashboard-ui'),uiDir=candidateDir;
if(args[2]){uiDir=realpathSync(args[2]);const other=JSON.parse(readFileSync(join(uiDir,'candidate-index.json')));checkCandidate(other,name=>readFileSync(join(uiDir,name)));assert.equal(other.source_commit,candidate.source_commit);uiArtifact=other.artifacts.find(a=>a.component==='awh-dashboard-ui');}
checkArtifact(readFileSync(join(uiDir,uiArtifact.filename)),uiArtifact,candidate.source_commit);
const evidenceName=`package-smoke-${target}.json`;assert(!existsSync(join(candidateDir,evidenceName)),'Do not replace existing smoke evidence');
const scratch=mkdtempSync(join(tmpdir(),'awh-rc-离仓 space-')), install=join(scratch,'install 空目录'), cache=join(scratch,'empty-cache'), assets=join(scratch,'ui 资源');mkdirSync(install);mkdirSync(assets);
const env=npmEnv(cache);env.PATH=dirname(process.execPath)+(process.platform==='win32'?delimiter+join(process.env.SystemRoot,'System32')+delimiter+join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0'):'');delete env.NODE_PATH;delete env.AWH_CLIENT_CONFIG;
const entries=ids.filter(id=>id!=='awh-dashboard-ui'), children=new Set();
const run=(argv,status=0)=>{const r=spawnSync(process.execPath,argv,{cwd:scratch,env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,windowsHide:true});assert.equal(r.status,status,'Installed command failed: '+r.stderr);return r.stdout.trim();};
const safeDelete=path=>{const real=realpathSync(path),base=realpathSync(scratch),rel=relative(base,real);assert(rel && !rel.startsWith('..')&&dirname(real)===base && !lstatSync(path).isSymbolicLink());rmSync(real,{recursive:true,force:true});};
const freePort=async()=>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(done=>server.close(done));return port;};
const modulePath=(component,path)=>join(install,'node_modules','@zlpoot',component,path);
const installAll=()=>run([npmEntry(),'install','--prefix',install,'--offline','--ignore-scripts','--no-audit','--no-fund',...entries.map(id=>join(candidateDir,candidate.artifacts.find(a=>a.component===id).filename))]);
const checks={};
try {
  assert.equal(Object.keys(env).filter(k=>/^npm_config_/.test(k)).includes('npm_config_offline'),true);
  installAll();checks.empty_cache_install='PASS';
  for(const id of entries)for(const [command,bin] of Object.entries(specs[id].bin)) {
    run([modulePath(id,bin),'--help']);const version=run([modulePath(id,bin),'--version']);assert(version.includes(specs[id].version));
    const shim=join(install,'node_modules/.bin',command);
    if(process.platform==='win32') {
      const cmd=spawnSync(join(process.env.SystemRoot,'System32/cmd.exe'),['/d','/s','/c',`""${shim}.cmd" --version"`],{cwd:scratch,env,encoding:'utf8',timeout:15000,windowsHide:true});assert.equal(cmd.status,0,cmd.stderr);assert(cmd.stdout.includes(specs[id].version));
      const ps=spawnSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',shim+'.ps1','--version'],{cwd:scratch,env,encoding:'utf8',timeout:15000,windowsHide:true});assert.equal(ps.status,0,ps.stderr);assert(ps.stdout.includes(specs[id].version));
    }else{assert(lstatSync(modulePath(id,bin)).mode&0o111);const r=spawnSync(shim,['--version'],{cwd:scratch,env,encoding:'utf8',timeout:15000});assert.equal(r.status,0);assert(r.stdout.includes(specs[id].version));}
  }checks.shims='PASS';
  const doctor=JSON.parse(run([modulePath('awh-client','dist/client/cli.js'),'doctor','--json'],2));assert.equal(doctor.mode,'offline');assert.equal(doctor.authority_verified,false);assert(doctor.checks.some(c=>c.id==='installation'&&c.status==='passed'));checks.client_doctor='PASS';
  const handoff=join(scratch,'handoff.json'),sha=candidate.source_commit;
  writeFileSync(handoff,JSON.stringify({schema_version:'0.1',kind:'builder_handoff',work_item:{repo:'zlpoot/agent-workflow-hub',issue:56},candidate:{pr:1,base_sha:sha,head_sha:sha},producer:{executor:'codex',run_id:'package-smoke'},verification:{subject_sha:sha,lifecycle:'completed',outcome:'pass',checks:[{command:'package smoke fixture',exit_code:0}],evidence_refs:['https://github.com/zlpoot/agent-workflow-hub/issues/56']},handoff:{next_step:'review',publication:'confirmed'}}));
  const offline=JSON.parse(run([modulePath('awh-builder','dist/cli.js'),handoff,'--expected-head',sha]));assert.equal(offline.schema_valid,true);assert.equal(offline.authority_verified,false);
  const bad=JSON.parse(run([modulePath('awh-builder','dist/builder-cli.js'),'--repo','untrusted'],2));assert(bad.error);checks.builder_offline='PASS';
  for(const [name,bytes] of readZip(readFileSync(join(uiDir,uiArtifact.filename)))){const path=join(assets,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);}
  const fixture=JSON.parse(readFileSync(join(root,'examples/protocol/future-ui.json'))),bearer='awh_cp_'+randomBytes(32).toString('base64url'),secret=randomBytes(32).toString('base64url');
  const trusted=join(scratch,'trusted.json'),database=join(scratch,'scratch.sqlite');
  writeFileSync(trusted,JSON.stringify({profiles:[fixture.profile_policy],clients:[{id:'scratch-client',project_ids:[fixture.project.id],executor_ids:[fixture.executor.id],token_sha256:sha256(bearer)}]}),{mode:0o600});
  run([modulePath('awh-control-plane','dist/control-plane-cli.js'),'init','--database',database,'--config',trusted]);
  // IPC only delivers the same SIGTERM handlers on Windows where kill() otherwise force-terminates.
  // The module/config/runtime are all installed bytes; no checkout runtime is imported.
  const launcher=join(scratch,'launch.mjs');writeFileSync(launcher,"process.on('message',m=>{if(m==='stop'){process.disconnect();process.emit('SIGTERM');}});const {main}=await import(process.argv[2]);await main(JSON.parse(process.argv[3]));\n");
  const start=async(component,args)=>{
    const child=fork(launcher,[pathToFileURL(modulePath(component,Object.values(specs[component].bin)[0])).href,JSON.stringify(args)],{cwd:scratch,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});children.add(child);let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
    const until=Date.now()+15000;while(!output.includes('listening at')){assert(child.exitCode===null,'Installed server startup failed: '+errors);assert(Date.now()<until,'Startup timeout');await new Promise(done=>setTimeout(done,50));}return child;
  };
  const stop=async child=>{const closed=once(child,'exit');child.send('stop');const timer=setTimeout(()=>child.kill(),15000);try{const [code,signal]=await closed;assert.equal(code,0);assert.equal(signal,null);}finally{clearTimeout(timer);children.delete(child);}};
  const cpPort=await freePort(), cp=await start('awh-control-plane',['serve','--database',database,'--config',trusted,'--port',String(cpPort)]);
  const health=await fetch(`http://127.0.0.1:${cpPort}/v1/capabilities`,{headers:{Authorization:'Bearer '+bearer},signal:AbortSignal.timeout(5000)});assert.equal(health.status,200);await health.arrayBuffer();await stop(cp);const dbBefore=sha256(readFileSync(database));checks.cp_scratch='PASS';
  const sessions=join(scratch,'sessions.json'),viewerConfig=join(scratch,'viewer.json'),viewerPort=await freePort();
  writeFileSync(sessions,JSON.stringify([{id:'scratch-viewer',project_ids:[fixture.project.id],session_sha256:sha256(secret),expires_at:new Date(Date.now()+60000).toISOString()}]),{mode:0o600});
  writeFileSync(viewerConfig,JSON.stringify({schema_version:'1.0',database,sessions_file:sessions,assets,port:viewerPort}),{mode:0o600});
  const viewer=await start('awh-viewer',['--enable','--config',viewerConfig]),origin=`http://127.0.0.1:${viewerPort}`;
  assert.equal((await fetch(origin+'/dashboard')).status,401);
  assert.equal((await fetch(origin+'/dashboard/session',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:'A'.repeat(43)})).status,401);
  const exchange=await fetch(origin+'/dashboard/session',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:secret});assert.equal(exchange.status,204);const cookie=exchange.headers.get('set-cookie');assert(cookie.includes('HttpOnly; SameSite=Strict; Path=/dashboard'));assert.equal(await exchange.text(),'');
  const headers={Cookie:cookie.split(';')[0]};for(const path of ['/dashboard','/dashboard/app.js','/dashboard/app.css','/dashboard/v1/snapshot']){const r=await fetch(origin+path,{headers});assert.equal(r.status,200);assert(r.headers.get('content-security-policy'));await r.arrayBuffer();}
  assert.equal((await fetch(origin+'/dashboard/v1/snapshot',{method:'POST',headers})).status,405);assert.equal((await fetch(origin+'/dashboard',{headers:{...headers,Origin:'https://evil.invalid'}})).status,401);
  await stop(viewer);assert.equal(sha256(readFileSync(database)),dbBefore,'Viewer must not modify SQLite bytes');checks.viewer_ui='PASS';
  safeDelete(install);safeDelete(cache);mkdirSync(install);installAll();for(const id of entries)for(const bin of Object.values(specs[id].bin))run([modulePath(id,bin),'--version']);checks.reinstall='PASS';
  const artifacts=candidate.artifacts.map(a=>a.component==='awh-dashboard-ui'?uiArtifact:a).map(a=>({component:a.component,sha256:a.sha256}));
  const result={schema_version:'1.0',kind:'awh_package_smoke',source_commit:candidate.source_commit,target,status:'PASS',artifacts,checks,model_calls:0,production_touched:false};
  writeFileSync(join(candidateDir,evidenceName),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
} finally {
  for(const child of children)child.kill();
  // Preserve the isolated scratch on failure for diagnosis; never touch external production state.
  console.log(JSON.stringify({scratch_retained:true,scope:'generated temporary package-smoke directory',credentials_uploaded:false}));
}
