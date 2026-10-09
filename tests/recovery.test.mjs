import assert from 'node:assert/strict';
import test from 'node:test';
import {appendEvent,replayRun} from '../dist/protocol/index.js';
import {taskBinding} from '../dist/profiles.js';
import {qualifyRecovery} from '../dist/client/recovery.js';
function fixture(stage='verification') {
 const binding=taskBinding({repository:'zlpoot/future-ui',issue:90,branch:'codex/awh-task-90',source_sha:'a'.repeat(40),profile_ref:'future-ui/c1c-acceptance',profile_version:'v02-repeatable-v1',executor_id:'c1c-future-ui-windows',machine_id:'fixture-machine'});
 const next=taskBinding({...(({fingerprint,...data})=>data)(binding),source_sha:'b'.repeat(40)});
 const initial={schema_version:'1.0',kind:'run',id:'run-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',project_id:'future-ui',work_item_id:'fixture-work',executor_id:binding.executor_id,machine_id:binding.machine_id,source:{provider:'github',repository:binding.repository,sha:binding.source_sha,ref:binding.branch},profile:{ref:binding.profile_ref,version:binding.profile_version},state:'created',created_at:'2026-10-08T00:00:00.000Z',updated_at:'2026-10-08T00:00:00.000Z',started_at:null,completed_at:null};
 const checks=[{command:'git diff --check origin/main...HEAD',exit_code:2}],events=[];
 const emit=(type,data,extensions={})=>{const e={schema_version:'1.0',kind:'event',id:'fixture-event-'+(events.length+1),run_id:initial.id,sequence:events.length+1,type,occurred_at:initial.created_at,payload:{schema_version:'1.0',data,extensions:{task_binding:binding,...extensions}}};appendEvent(initial,events,e);events.push(e);};
 emit('RUN_STARTED',{source_sha:binding.source_sha});emit('STEP_STARTED',{step_id:'builder-preflight',name:'App preflight'});emit('STEP_COMPLETED',{step_id:'builder-preflight',exit_code:stage==='verification'?0:2});
 let evidence=null;if(stage==='verification'){emit('VERIFICATION_STARTED',{subject_sha:binding.source_sha});emit('VERIFICATION_FAILED',{subject_sha:binding.source_sha,checks,reason:'CR failure'});evidence={started_at:initial.created_at,before_sha:binding.source_sha,after_sha:binding.source_sha,logs:[{command:checks[0].command,exit_code:2,stdout:'CR failure',stderr:'',elapsed_ms:1}]};}else emit('RUN_FAILED',{reason:'Preflight stopped'},{builder_stage:'preflight'});
 return {initial,events,binding,next,pending:false,journal:{schema_version:'1.0',run_id:initial.id,source_sha:binding.source_sha,stage,disposition:'stopped',refs:{},task_binding:binding},evidence,cp:replayRun(initial,events).run,cpEvents:structuredClone(events)};
}
const qualify=f=>qualifyRecovery(f.initial,f.events,f.binding,f.pending,f.journal,f.evidence,f.next,f.cp,f.cpEvents);
for(const stage of ['preflight','verification'])test('recovery qualification accepts only the known '+stage+' pre-provider sequence',()=>qualify(fixture(stage)));
for(const drift of ['issue','branch','profile','executor','machine','same-sha','event-task','provider-refs-type','pending','cp-state','cp-events','evidence-checks'])test('recovery qualification refuses '+drift,()=>{
 const f=fixture();if(drift==='issue'){const {fingerprint,...v}=f.next;f.next=taskBinding({...v,issue:91,branch:'codex/awh-task-91'});}else if(drift==='same-sha')f.next=f.binding;else if(drift==='event-task')f.events[0].payload.extensions.task_binding={...f.binding,issue:91};else if(drift==='provider-refs-type')f.journal.refs=1;else if(drift==='pending')f.pending=true;else if(drift==='cp-state')f.cp={...f.cp,state:'completed'};else if(drift==='cp-events')f.cpEvents.pop();else if(drift==='evidence-checks')f.evidence.logs[0].exit_code=1;else {const key={branch:'branch',profile:'profile_version',executor:'executor_id',machine:'machine_id'}[drift];f.next={...f.next,[key]:'other'};}
 assert.throws(()=>qualify(f));
});
