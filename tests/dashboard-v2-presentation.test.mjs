import './trusted-policy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { taskFixtures } from './task-fixture.mjs';
import { TASK_STATES } from '../dist/dashboard/tasks.js';

const bundle = await build({ stdin: { contents: `export * from './dashboard/v2/presentation.ts'; export * from './dashboard/v2/semantics.ts'; export * from './dashboard/v2/selectors.ts';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { presentTasks, presentTask, presentDetail, presentationState, taskCategory, TASK_CATEGORIES, overviewMetrics, nextActionGroups, isAwaitingReview, searchText } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const now = Date.parse('2026-10-13T12:00:00Z');
const tasks = taskFixtures(now);
const state = (phase='live', cursor=10, events=[]) => ({ phase, factsUnavailable: phase === 'refreshing', snapshot: { cursor, tasks, projects: [], executors: [], runs: [] }, events, error: null, lastRefresh: now });
function degraded(items) {
  for (const item of items) {
    assert.equal(item.factsCurrent, false); assert.equal(item.state, 'unknown');
    assert.equal(item.active_actor, null); assert.equal(item.waiting_for, null);
    assert.equal(item.executor, null); assert.equal(item.machine, null);
    assert.equal(item.watcher.running, null); assert.equal(item.watcher.executor_running, null);
    assert.equal(item.watcher.status, 'UNKNOWN'); assert.equal(item.owner_scope.allow_merge, null);
    assert.equal(item.next_action, '等待重新读取并核验当前任务事实');
  }
}

test('all TaskState values have exactly one classification, regardless of incidental actors/blockers', () => {
  assert.deepEqual(Object.keys(TASK_CATEGORIES).sort(), [...TASK_STATES].sort());
  const expected = ['pending','pending','active','active','review','pending','pending','pending','active','completed','pending','unknown'];
  TASK_STATES.forEach((value, i) => {
    const task = { ...tasks[0], state: value, waiting_for: { role: 'reviewer', name: 'Reviewer' }, blockers: ['incidental'] };
    assert.equal(taskCategory(task), expected[i], value);
    assert.equal(isAwaitingReview(task), value === 'awaiting_review', value);
  });
});
test('complete fixture metrics and responsibility groups are consistent and never duplicate tasks', () => {
  const presented = presentTasks(state(), now), metrics = overviewMetrics(state().snapshot, presented);
  assert.deepEqual([metrics.developing, metrics.awaitingReview, metrics.blocked, metrics.completed, metrics.unknown], [3,1,7,1,1]);
  assert.equal(metrics.developing+metrics.awaitingReview+metrics.blocked+metrics.completed+metrics.unknown, tasks.length);
  assert.deepEqual(presented.filter(isAwaitingReview).map(t=>t.id), ['fixture:task:3']);
  const groups = nextActionGroups(presented), ids = groups.flatMap(g=>g.tasks.map(t=>t.id));
  assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, tasks.length-1);
  assert.equal(groups.find(g=>g.role==='reviewer').count, 1);
  assert(groups.find(g=>g.role==='watcher').tasks.some(t=>t.state==='awaiting_merge'));
  assert(groups.find(g=>g.role==='watcher').tasks.some(t=>t.state==='review_passed'));
  // Waiting responsibility takes precedence over an active observer.
  assert.equal(nextActionGroups([{...presented[2],active_actor:{role:'watcher',name:'Watcher'}}])[0].role,'reviewer');
});
for (const phase of ['offline','outdated','error','partial','refreshing']) test(`${phase} safely degrades every fixture and retains historical evidence without mutating input`, () => {
  const before=structuredClone(tasks), items=presentTasks(state(phase),now); degraded(items);
  degraded([presentDetail({item:tasks[4],loading:false,error:null},state(phase),now).item]);
  items.forEach((item,i)=>{assert.deepEqual(item.review,tasks[i].review);assert.deepEqual(item.checks,tasks[i].checks);assert.equal(item.source_head,tasks[i].source_head);});
  const metrics=overviewMetrics(state().snapshot,items);assert.equal(metrics.unknown,tasks.length);assert.equal(metrics.awaitingReview+metrics.blocked+metrics.developing+metrics.completed,0);
  assert.equal(nextActionGroups(items)[0].role,'unknown');assert.equal(nextActionGroups(items)[0].count,tasks.length);
  assert(!searchText(items[0]).includes('codex 模拟执行器'));assert(!items.some(item=>item.state==='developing'));assert.deepEqual(tasks,before);
});
test('partial -> refreshing -> snapshot catch-up preserves event high-water mark and then restores facts', () => {
  const events=[{cursor:11}];
  for(const phase of ['partial','refreshing','live','connecting']) degraded(presentTasks(state(phase,10,events),now));
  assert.equal(presentTasks(state('live',11,events),now)[0].state,'developing');
  assert.equal(presentTasks(state('connecting',11,events),now)[4].state,'awaiting_merge');
});
test('existing local and GitHub freshness rules degrade elapsed/future observations even while connected', () => {
  degraded([presentTask(tasks[0],state(),now+45001)]);
  const future=structuredClone(tasks[0]);future.observations[0].observed_at=new Date(now+1).toISOString();degraded([presentTask(future,state(),now)]);
  const oldGitHub=structuredClone(tasks[4]);oldGitHub.observations.find(o=>o.source==='github').freshness='stale';degraded([presentTask(oldGitHub,state(),now)]);
  assert.equal(presentTask(tasks[5],state(),now).factsCurrent,true);
});
test('drawer pending/failed/removed tasks degrade; newer snapshot wins over cached successful detail', () => {
  const item=tasks[4];
  for(const detail of [{item,loading:true,error:null},{item,loading:false,error:'failed'}]) degraded([presentDetail(detail,state(),now).item]);
  const old={...item,updated_at:new Date(now-1).toISOString(),state:'awaiting_review'};
  assert.equal(presentDetail({item:old,loading:false,error:null},state(),now).item.state,'awaiting_merge');
  const removed=state();removed.snapshot={...removed.snapshot,tasks:[]};degraded([presentDetail({item,loading:false,error:null},removed,now).item]);
});

test('ordinary refreshing retains fresh facts, but failure invalidation persists until successful snapshot', () => {
  const live = state(), refreshing = presentationState(live, { ...state('refreshing'), factsUnavailable: undefined });
  assert.equal(presentTasks(refreshing, now)[0].state, 'developing');
  for (const phase of ['offline','outdated','error','partial']) {
    const invalid = presentationState(live, state(phase));
    const pending = presentationState(invalid, { ...state('refreshing'), factsUnavailable: undefined });
    degraded(presentTasks(pending, now));
    assert.equal(presentTasks(presentationState(pending, state()), now)[0].state, 'developing');
  }
});
