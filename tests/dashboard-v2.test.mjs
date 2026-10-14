import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { taskFixtures } from "./task-fixture.mjs";
import {
  filterTasks,
  overviewCounts,
  taskFacts,
  taskSnapshotUnreliable,
  localFastReviewInstruction,
} from "../dashboard-v2/lib/task-model.mjs";
import { selectReview, reviewBody } from '../dist/workflow/local-fast-review.js';
import { TASK_STATES, taskBase } from "../dist/dashboard/tasks.js";
const now = Date.now(),
  tasks = taskFixtures(now);

test('personal-gh same-account GUI instruction recommends the COMMENTED decision accepted by selectReview',()=>{
  const head='a'.repeat(40),author={id:11,login:'owner',type:'User'};
  const task={...taskBase('lf:p:1','p','example-org/project',1),workflow:'local-fast',pr:{number:3},source_head:head};
  const instruction=localFastReviewInstruction(task);
  assert.match(instruction,/先读取 GitHub 原生 PR 作者.*Review Bridge prepare/);
  assert.match(instruction,/personal-gh（Reviewer 与个人 PR 作者同账号）：提交原生 COMMENTED（API event: COMMENT）/);
  assert.match(instruction,/AWH-LOCAL-FAST-REVIEW v1.*恰好 head 和 decision/);
  assert(instruction.includes(head));assert(instruction.includes('https://github.com/example-org/project/pull/3'));
  for(const decision of ['PASS','REQUEST_CHANGES']){
    const review={id:1,user:author,state:'COMMENTED',commit_id:head,body:reviewBody(head,decision,'Independent report')};
    assert.equal(selectReview([review],author.id,head)?.decision,decision);
    assert.equal(selectReview([{...review,state:'APPROVED'}],author.id,head),undefined);
    assert.equal(selectReview([review],author.id,'b'.repeat(40)),undefined);
  }
});

test('github-app Bot GUI instruction recommends trusted native Review and rejects personal COMMENTED PASS',()=>{
  const head='a'.repeat(40),bot={id:9,login:'builder[bot]',type:'Bot'},reviewer={id:11,login:'reviewer',type:'User'};
  const task={...taskBase('lf:p:1','p','example-org/project',1),workflow:'local-fast',pr:{number:3},github_head:head};
  const instruction=localFastReviewInstruction(task);
  assert.match(instruction,/github-app（Bot 作者）：由已绑定的独立个人 Reviewer 提交原生 APPROVED（API event: APPROVE）或 CHANGES_REQUESTED（API event: REQUEST_CHANGES）/);
  assert.match(instruction,/COMMENTED \+ PASS 不会打开 Bot PR 的 Review Gate/);
  assert.match(instruction,/native commit_id 必须等于实际当前 HEAD/);
  const comment={id:1,user:reviewer,state:'COMMENTED',commit_id:head,body:reviewBody(head,'PASS','Independent report')};
  assert.equal(selectReview([comment],bot.id,head,reviewer),undefined);
  for(const [state,decision] of [['APPROVED','PASS'],['CHANGES_REQUESTED','REQUEST_CHANGES']]){
    const review={...comment,state};assert.equal(selectReview([review],bot.id,head,reviewer)?.decision,decision);
    assert.equal(selectReview([review],bot.id,'b'.repeat(40),reviewer),undefined);
    assert.equal(selectReview([{...review,user:{...reviewer,id:12}}],bot.id,head,reviewer),undefined);
  }
});

test('V1 and V2 build the shared App lifecycle without importing V1 Themes or server/fixture code into V2',()=>{
  const v1=JSON.parse(readFileSync(new URL('../dist/dashboard-ui/build-inputs.json',import.meta.url)));
  const v2=JSON.parse(readFileSync(new URL('../dist/dashboard-v2/build-report.json',import.meta.url))).inputs;
  assert(v1.includes('dashboard/use-github-app.ts'));assert(v2.includes('dashboard/use-github-app.ts'));
  assert(v2.every(path=>!/@radix-ui\/themes|antd|^(?:src|tests|scripts|examples)\/|^node:/.test(path)));
});

test("Overview partitions every TaskState exactly once, including queued and post-Review stages", () => {
  const expected = {
    queued: "pending",
    ready: "pending",
    developing: "developing",
    verifying: "developing",
    awaiting_review: "awaiting_review",
    changes_requested: "pending",
    review_passed: "pending",
    awaiting_merge: "pending",
    merging: "developing",
    completed: "completed",
    blocked: "pending",
    unknown: "pending",
  };
  assert.deepEqual(Object.keys(expected).sort(), [...TASK_STATES].sort());
  for (const state of TASK_STATES) {
    const task = {
      ...taskBase("test", "project", "example-org/project", 1),
      state,
    };
    assert.deepEqual(
      overviewCounts([task], false, now),
      {
        developing: Number(expected[state] === "developing"),
        awaiting_review: Number(expected[state] === "awaiting_review"),
        pending: Number(expected[state] === "pending"),
        completed: Number(expected[state] === "completed"),
      },
      state,
    );
  }
  assert.equal(
    Object.values(overviewCounts(tasks, false, now)).reduce((a, b) => a + b, 0),
    tasks.length,
  );
  assert.deepEqual(overviewCounts(tasks, true, now), {
    developing: 0,
    awaiting_review: 0,
    pending: tasks.length,
    completed: 0,
  });
});

test("SSE-ahead partial snapshots downgrade all task facts and stage/role filtering", () => {
  const unreliable = taskSnapshotUnreliable("partial");
  assert.equal(unreliable, true);
  for (const task of tasks) {
    const facts = taskFacts(task, unreliable, now);
    assert.equal(facts.state, "unknown");
    assert.equal(facts.actor, "未知 / 已过期");
    assert.equal(facts.waiting, "重新核验");
    assert.equal(facts.action, "恢复读取并重新核验来源");
  }
  const filters = {
    project: "all",
    stage: "developing",
    role: "all",
    machine: "all",
    search: "",
  };
  assert.equal(filterTasks(tasks, filters, unreliable, now).length, 0);
  assert.equal(
    filterTasks(tasks, { ...filters, stage: "unknown" }, unreliable, now)
      .length,
    tasks.length,
  );
  assert.equal(
    filterTasks(
      tasks,
      { ...filters, stage: "all", role: "coding_executor" },
      unreliable,
      now,
    ).length,
    0,
  );
  assert.equal(taskSnapshotUnreliable("live"), false);
  assert.equal(
    taskFacts(tasks[0], taskSnapshotUnreliable("live"), now).state,
    "developing",
  );
  const ahead = [{ cursor: 6 }];
  const syncing = taskSnapshotUnreliable("refreshing", 5, ahead);
  assert.equal(
    syncing,
    true,
    "queued refresh cannot make the old snapshot current again",
  );
  assert.equal(taskFacts(tasks[0], syncing, now).state, "unknown");
  assert.equal(
    taskSnapshotUnreliable("live", 6, ahead),
    false,
    "snapshot must reach the SSE watermark before restoring facts",
  );
});
test("disconnected facts cannot claim current executor, Review stage or next action", () => {
  for (const task of tasks) {
    const facts = taskFacts(task, true, now);
    assert.equal(facts.state, "unknown");
    assert.equal(facts.actor, "未知 / 已过期");
    assert.equal(facts.waiting, "重新核验");
    assert(!facts.action.includes("已开始"));
  }
});
test("local actor expires independently of previously accepted snapshot", () => {
  assert.equal(taskFacts(tasks[0], false, now).state, "developing");
  const expired = taskFacts(tasks[0], false, now + 46000);
  assert.equal(expired.state, "unknown");
  assert.equal(expired.actor, "未知 / 已过期");
});
test("combined filters use downgraded stage and retain project / machine bindings", () => {
  const filters = {
    project: "project-alpha",
    stage: "awaiting_review",
    role: "reviewer",
    machine: "fixture-windows",
    search: "等待 ChatGPT Review",
  };
  assert.equal(filterTasks(tasks, filters, false, now).length, 1);
  assert.equal(filterTasks(tasks, filters, true, now).length, 0);
  assert.equal(
    filterTasks(tasks, { ...filters, stage: "unknown", role: "all" }, true, now)
      .length,
    1,
  );
});
