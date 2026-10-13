import assert from "node:assert/strict";
import test from "node:test";
import { taskFixtures } from "./task-fixture.mjs";
import {
  filterTasks,
  overviewCounts,
  taskFacts,
  taskSnapshotUnreliable,
} from "../dashboard-v2/lib/task-model.mjs";
import { TASK_STATES, taskBase } from "../dist/dashboard/tasks.js";
const now = Date.now(),
  tasks = taskFixtures(now);

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
