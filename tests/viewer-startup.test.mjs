import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { createHash } from 'node:crypto';

// A packaged test root allows the same startup regression on native Linux.
// Platform overrides are child-test-only, never Viewer config/REST options.
const runtime = resolve(process.env.AWH_VIEWER_TEST_ROOT ?? '.');
const { ControlPlaneStore } = await import(pathToFileURL(join(runtime,'dist/control-plane/store.js')));
const profile = JSON.parse(readFileSync(new URL('../examples/protocol/project-alpha.json',import.meta.url))).profile_policy;
const bootstrap = `
  if (process.env.AWH_TEST_PLATFORM) Object.defineProperty(process, 'platform', { value: process.env.AWH_TEST_PLATFORM });
  const { main } = await import(process.env.AWH_TEST_VIEWER_ENTRY);
  await main(JSON.parse(process.env.AWH_TEST_VIEWER_ARGS)).catch(e => { console.error(JSON.stringify({code:e.code})); process.exitCode=2; });
`;
async function setup(t, platform, localData, ownerPolicy=false) {
  const directory = mkdtempSync(join(tmpdir(),'awh-viewer-startup-'));
  const database = join(directory,'fixture.sqlite'), config = join(directory,'viewer.json');
  const writer = new ControlPlaneStore(database,[profile],undefined,'initialize');writer.close();
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  writeFileSync(config,JSON.stringify({schema_version:'1.0',mode:'local_browser_direct',database,port,viewer:{id:'fixture-viewer',project_ids:['project-alpha']},local_bindings:[]}));
  const before=createHash('sha256').update(readFileSync(database)).digest('hex');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=> !/^(GIT_|GH_|GITHUB_|AWH_|NODE_|LOCALAPPDATA$)/i.test(key)));
  if(localData)env.LOCALAPPDATA=directory;
  Object.assign(env,{AWH_TEST_VIEWER_ENTRY:pathToFileURL(join(runtime,'dist/dashboard-cli.js')).href,AWH_TEST_VIEWER_ARGS:JSON.stringify(['--config',config,...(ownerPolicy?['--github-app-owner-config',join(directory,'unprovisioned-owner.json')]:[])])});
  if(platform)env.AWH_TEST_PLATFORM=platform;
  const child=spawn(process.execPath,['--input-type=module','-e',bootstrap],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exit=new Promise(r=>child.once('exit',r));let errors='';child.stderr.on('data',c=>{if(errors.length<4096)errors+=c;});
  t.after(async()=>{if(child.exitCode===null)child.kill();await exit;assert.equal(createHash('sha256').update(readFileSync(database)).digest('hex'),before);const target=realpathSync(directory);assert.equal(dirname(target),realpathSync(tmpdir()));assert(basename(target).startsWith('awh-viewer-startup-'));rmSync(target,{recursive:true,force:true});});
  return {child,exit,errors:()=>errors,port};
}
async function ready(h) {
  return new Promise((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>reject(new Error('Isolated Viewer startup timed out')),10000);
    h.child.once('exit',()=>{clearTimeout(timer);reject(new Error('Viewer exited before listening: '+h.errors()));});
    h.child.stdout.on('data',chunk=>{text+=chunk;for(const line of text.split('\n')){try{const v=JSON.parse(line);if(v.url){clearTimeout(timer);resolve(v);}}catch{}}});
  });
}
function get(port,path,headers={},method='GET',body) {
  return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method,headers},res=>{let text='';res.on('data',c=>text+=c);res.once('end',()=>resolve({status:res.statusCode,headers:res.headers,body:text.startsWith('{')?JSON.parse(text):null}));});req.once('error',reject);req.end(body);});
}
async function verify(h, appAvailable) {
  const value=await ready(h);assert.equal(value.access,'explicit_local_os_user');assert.equal(value.database,'existing_v2_readonly');
  const doc=await get(h.port,'/dashboard',{'sec-fetch-site':'none','sec-fetch-mode':'navigate','sec-fetch-dest':'document'});assert.equal(doc.status,200);const cookie=doc.headers['set-cookie'][0].split(';')[0];
  const snapshot=await get(h.port,'/dashboard/v1/snapshot',{cookie});assert.equal(snapshot.status,200);assert.equal(snapshot.body.authority_verified,false);assert.deepEqual(snapshot.body.projects,[]);
  assert.equal((await get(h.port,'/dashboard/v1/projects',{cookie,'content-type':'application/json'},'POST','{}')).status,405);
  const app=await get(h.port,'/dashboard/github-app/v1/status',{cookie});assert.equal(app.status,appAvailable?200:404);
  if(appAvailable){assert.equal(app.body.item.status,'NOT_CONNECTED');assert.equal(app.body.item.management_enabled,false);assert.equal((await get(h.port,'/dashboard/github-app/v1/connect',{cookie,origin:`http://127.0.0.1:${h.port}`,'sec-fetch-site':'same-origin','content-type':'application/json','x-awh-csrf':app.body.item.csrf},'POST','{}')).status,403);}
  assert.equal(h.child.exitCode,null);
}
for(const platform of ['darwin','linux'])test(`${platform} startup branch: no LOCALAPPDATA/no Owner policy still listens and serves read-only routes`,{timeout:15000},async t=>{await verify(await setup(t,platform,false),false);});
test(`native ${process.platform} startup with isolated environment serves ordinary Viewer`,{timeout:15000},async t=>{await verify(await setup(t,undefined,process.platform==='win32'),process.platform==='win32');});
test('Windows startup without App environment preserves ordinary read-only Viewer',{timeout:15000},async t=>{await verify(await setup(t,'win32',false),false);});
test('non-Windows explicitly requested App Owner policy fails closed without reading the Windows configuration',{timeout:15000},async t=>{const h=await setup(t,'linux',false,true);assert.equal(await h.exit,2);assert.equal(JSON.parse(h.errors().trim()).code,'app_owner_configuration');});
