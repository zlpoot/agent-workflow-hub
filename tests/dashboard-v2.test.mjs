import assert from "node:assert/strict";
import test from "node:test";
import { taskFixtures } from "./task-fixture.mjs";
import { filterTasks, taskFacts } from "../dashboard-v2/lib/task-model.mjs";
const now = Date.now(),
  tasks = taskFixtures(now);
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
