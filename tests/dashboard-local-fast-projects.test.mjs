import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, repository } from './helpers/local-fast-harness.mjs';
import { createLocalFastProjects } from '../dist/dashboard/local-fast-projects.js';
import { LocalFastWatcher } from '../dist/workflow/local-fast-watcher.js';
import { githubTransport } from '../dist/workflow/local-fast-github.js';
const code=expected=>e=>e.code===expected;
function setup(t) {
  const h=harness(t),external=mkdtempSync(join(tmpdir(),'awh-gui-test-')),state=join(external,'state');mkdirSync(state);
  const executable=join(external,'codex.exe');writeFileSync(executable,'synthetic executor');
  const watch={platform:'win32',interactive:true,localData:external,fast:h.deps,github:githubTransport(h.repo,h.deps.run)};
  const config={project_roots:[h.repo],state_directory:state},overrides={fast:h.deps,watch};
  const gui=createLocalFastProjects(config,overrides);t.after(()=>gui.close());
  return {h,gui,config,overrides,watch,executable,state};
}
test('GUI binds exact queue, cancels without writes, rejects overrides/conflict, attaches idempotently and restores without CP',async t=>{
  const {h,gui,config,overrides,state}=setup(t),directory=h.repo;
  assert.equal((await gui.handle('inspect',{directory})).bound,false);
  await assert.rejects(gui.handle('bind',{directory,issues:'1,2,3',checks:[],provider:'personal-gh',confirm:false}),code('local_fast_confirmation'));
  assert(!existsSync(h.statePath));
  await assert.rejects(gui.handle('bind',{directory,issues:'1,2',checks:['gh api repos/x/y'],provider:'personal-gh',confirm:true}),code('local_fast_check'));
  const result=await gui.handle('bind',{directory,issues:'1,2,3',checks:[],provider:'personal-gh',confirm:true});assert(result.bound);assert.deepEqual(result.issues,[1,2,3]);
  const before=readFileSync(h.statePath,'utf8');
  const same=await gui.handle('attach',{directory,confirm:true});assert.equal(same.project_id,result.project_id);assert.equal(gui.configs.length,1);assert.equal(readFileSync(h.statePath,'utf8'),before);
  await assert.rejects(gui.handle('bind',{directory,issues:'1,2',checks:[],provider:'personal-gh',confirm:true}),code('local_fast_binding_conflict'));assert.equal(readFileSync(h.statePath,'utf8'),before);
  await assert.rejects(gui.handle('attach',{directory,confirm:true,watcher_directory:state}),code('local_fast_input'));
  const restored=createLocalFastProjects(config,overrides);assert.deepEqual(restored.configs,gui.configs);await restored.close();
  const moved=directory+'-disconnected';renameSync(directory,moved);
  try{const disconnected=createLocalFastProjects(config,overrides);assert.equal(disconnected.configs[0].repository,repository);assert.deepEqual(disconnected.projectIds(),gui.projectIds());await disconnected.close();}finally{renameSync(moved,directory);}
  assert(!h.calls.some(c=>c.command==='gh'&&c.args[0]!=='api'));
  assert(!existsSync(join(h.repo,'cp.sqlite')));
});
test('GUI never creates Owner authorization: missing, cancelled, expired, lock and completed states block start',async t=>{
  const {h,gui,watch,executable}=setup(t),directory=h.repo;await h.bind();await gui.handle('attach',{directory,confirm:true});
  assert.equal((await gui.handle('status',{directory})).owner_confirmation,'GUI_OWNER_CONFIRMATION_NOT_INTEGRATED');
  await assert.rejects(gui.handle('authorize',{directory,confirm:true}),code('local_fast_input'));
  await assert.rejects(gui.handle('start',{directory,confirm:false}),code('local_fast_confirmation'));
  await assert.rejects(gui.handle('start',{directory,confirm:true}));
  const watcher=new LocalFastWatcher(directory,watch);assert(!existsSync(watcher.scope_file));
  watcher.authorize(repository,'1,2,3',new Date(Date.now()+3600000).toISOString(),executable,false,true);
  const scope=JSON.parse(readFileSync(watcher.scope_file));
  const wd=join(watch.localData,'AWH','local-fast','42');
  writeFileSync(join(wd,'watcher.lock'),JSON.stringify({scope_version:scope.scope_version,pid:process.pid}));
  await assert.rejects(gui.handle('start',{directory,confirm:true}),code('local_fast_watch_unavailable'));
  unlinkSync(join(wd,'watcher.lock'));
  writeFileSync(join(wd,'watcher.json'),JSON.stringify({scope_version:scope.scope_version,attempts:[],executor_launches:0,merge_count:0,human_interventions:1,status:'QUEUE_COMPLETED'}));
  await assert.rejects(gui.handle('start',{directory,confirm:true}),code('local_fast_watch_unavailable'));
  h.user(99);assert.equal((await gui.handle('status',{directory})).reason,'local_fast_permission');h.user(11);
  // Scope expiry is simulated only in a new isolated state; no production mutation.
  scope.expires_at=new Date(Date.now()-1000).toISOString();writeFileSync(watcher.scope_file,JSON.stringify(scope));
  assert.equal((await gui.handle('status',{directory})).reason,'local_fast_watch_expired');
  await assert.rejects(gui.handle('start',{directory,confirm:true}),code('local_fast_watch_expired'));
});
test('GUI start uses existing Watcher, duplicate clicks launch once, stop/exit abort only owned process',{timeout:120000},async t=>{
  const {h,gui,watch,executable,overrides,config}=setup(t),directory=h.repo;await h.bind();await gui.handle('attach',{directory,confirm:true});
  let launches=0,started;const ready=new Promise(r=>started=r);
  overrides.watch.executor={type:'codex-cli',run:async(_request,_started,signal)=>{launches++;started();await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener('abort',r,{once:true});});return {exit_code:2};}};
  const owned=createLocalFastProjects(config,overrides);t.after(()=>owned.close());
  const watcher=new LocalFastWatcher(directory,watch);watcher.authorize(repository,'1,2,3',new Date(Date.now()+3600000).toISOString(),executable,false,true);
  await owned.handle('start',{directory,confirm:true});await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Simulated executor did not start')),10000);timer.unref();})]);
  await owned.handle('start',{directory,confirm:true});assert.equal(launches,1);
  assert.equal((await owned.handle('stop',{directory})).gui_status,'STOPPING');await owned.close();
  assert.equal(launches,1);assert(!existsSync(join(watch.localData,'AWH','local-fast','42','watcher.lock')));
  assert(existsSync(watcher.scope_file));
});
