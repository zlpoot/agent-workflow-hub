import test from 'node:test';
import assert from 'node:assert/strict';
import { validQueue, canStart, ownerCommand, recovery } from '../dashboard-v2/lib/local-fast-model.mjs';
test('V2 finite ordered queue rejects duplicate, malformed, unsafe and excessive Issue numbers',()=>{
  assert(validQueue('12,15,18'));
  for(const queue of ['', '0','01','-1','1,1','1, 2','1,','1.2','9007199254740992',Array.from({length:129},(_,i)=>i+1).join(',')])assert.equal(validQueue(queue),false,queue);
});
test('V2 cannot offer start after status expiry, stale observation, lock, GUI duplicate or completed queue',()=>{
  const now=Date.now(),status={status:'WATCHING',observedAt:now,expires_at:new Date(now+60000).toISOString(),gui_status:'IDLE'};
  assert(canStart(status,now));
  for(const delta of [{observedAt:now-15000},{observedAt:now+1},{expires_at:new Date(now).toISOString()},{watcher_running:true},{stale_lock:true},{gui_status:'RUNNING'},{gui_status:'STOPPING'},{status:'QUEUE_COMPLETED'},{status:'BLOCKED'}])assert.equal(canStart({...status,...delta},now),false);
  assert.equal(canStart(null,now),false);
});
test('Owner terminal command preserves exact repository and order, quotes PowerShell literals and never grants via GUI',()=>{
  const preview={bound:true,repository:'example/project',directory:"C:\\Owner's repo",issues:[12,15,18]},expires='2026-10-15T01:00:00Z';
  const command=ownerCommand(preview,expires,"C:\\tools\\Owner's codex.exe",false);
  assert(command.includes("Set-Location -LiteralPath 'C:\\Owner''s repo'"));assert(command.includes("--issues '12,15,18'"));
  assert(!command.includes('--allow-merge'));assert(ownerCommand(preview,expires,'C:\\codex.exe',true).endsWith('--confirm --allow-merge'));
  assert.equal(ownerCommand({...preview,bound:false},expires,'C:\\codex.exe',true),null);
  assert.equal(ownerCommand(preview,expires,'C:\\codex.exe\nwhoami',true),null);
  assert.equal(ownerCommand(preview,expires,'codex.exe',true),null);
  for(const code of ['directory_missing','local_fast_binding_conflict','local_fast_watch_expired','local_fast_permission','local_fast_busy','network'])assert(recovery(code).length>10);
});
