import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { LocalFastWatcher, codexExecutor } from '../dist/workflow/local-fast-watcher.js';
import { ReviewBridge, reviewBody } from '../dist/workflow/local-fast-review.js';
import { githubTransport } from '../dist/workflow/local-fast-github.js';
import { localFastMain } from '../dist/workflow/local-fast-cli.js';
import { harness, repository, options } from './helpers/local-fast-harness.mjs';

const errorCode = code => error => error.code === code;
const installedExecutable = realpathSync(process.execPath);
async function collaboration(t, allowMerge = false) {
  const h = harness(t); await h.bind();
  const localData = mkdtempSync(join(realpathSync(tmpdir()), 'awh-watch-'));
  t.after(() => { const parent = realpathSync(tmpdir()), target = realpathSync(localData), rel = relative(parent, target); assert(rel.startsWith('awh-watch-') && dirname(target) === parent); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  let now = Date.parse('2026-10-12T00:00:00Z'), fail = false, hold = false, launchRelease, expireDuring = false;
  const launches = [], github = githubTransport(h.repo, h.deps.run), executor = {
    type: 'codex-cli',
    async run(request, started) {
      launches.push(request); started(99999999);
      if (hold) await new Promise(resolve => { launchRelease = resolve; });
      if (expireDuring) now += 2 * 86400000;
      if (fail) return { exit_code: 1 };
      const value = `feature-${request.task.issue}-${launches.length}\n`;
      writeFileSync(join(request.task.worktree, 'code.txt'), value);
      return { exit_code: 0 };
    }
  };
  const deps = { platform: 'win32', localData, interactive: true, now: () => now, fast: h.deps, github, executor, alive: pid => pid === process.pid };
  const watcher = (overrides = {}) => new LocalFastWatcher(h.repo, { ...deps, ...overrides });
  const instance = watcher();
  instance.authorize(repository, '1,2,3', '2026-10-13T00:00:00Z', installedExecutable, allowMerge, true);
  return { ...h, github, launches, watcher, instance, deps,
    expire() { now += 2 * 86400000; }, fail(value) { fail = value; }, hold(value) { hold = value; }, release() { launchRelease(); }, expireDuring() { expireDuring = true; } };
}
async function candidate(t) {
  const h = harness(t); await h.bind(); const ready = await h.client().flow(true);
  writeFileSync(join(ready.worktree, 'code.txt'), 'candidate\n'); const result = await h.client(ready.worktree).execute(options);
  return { ...h, ready, result, github: githubTransport(h.repo, h.deps.run) };
}

describe('Local Fast Review Bridge and Windows watcher', { concurrency: 4 }, () => {
test('new Reviewer session restores the PR from URL, publishes exact-head COMMENTED PASS, and reconciles a lost acknowledgement', async t => {
  const h = await candidate(t), fresh = new ReviewBridge(h.github), context = fresh.prepare(h.result.pr_url);
  assert.equal(context.head, h.result.head); assert.equal(context.issue, 1); assert.deepEqual(context.declared_queue, [1,2,3]);
  assert.equal(context.execution_authority, false); assert.equal(context.files.length, h.prs[0].changed_files);
  assert.equal(context.issue_details.title, 'Ordinary Issue 1'); assert.match(context.delivery_instructions, /REVIEW_NOT_PUBLISHED/);
  assert.equal((await h.client().flow()).review, undefined, 'preparing or local PASS text is not publication');
  const report = 'Independently inspected all changed files and tests; no blocking findings.';
  const lost = new ReviewBridge({ ...h.github, write(...args) { h.github.write(...args); throw new Error('lost Review ACK'); } });
  assert.equal(lost.publish(context, 'PASS', report).status, 'REVIEW_NOT_PUBLISHED');
  const published = new ReviewBridge(h.github).publish(context, 'PASS', report);
  assert.equal(published.status, 'REVIEW_PUBLISHED_PASS'); assert.equal(published.native_state, 'COMMENTED');
  assert.equal(published.head, context.head); assert.equal((await h.client().flow()).review.decision, 'PASS');
  assert.equal(h.calls.filter(c => c.args.includes('POST')).length, 1, 'identical retry reads back the existing native Review');
  fresh.publish(context, 'REQUEST_CHANGES', 'A later independent finding supersedes the previous PASS.');
  fresh.publish(context, 'PASS', report);
  assert.equal((await h.client().flow()).review.decision, 'PASS', 're-publishing after a newer decision must create a fresh record');
});

test('separate GitHub Reviewer publishes native changes and PASS, while a same-account changes record remains COMMENTED', async t => {
  const h = await candidate(t), bridge = new ReviewBridge(h.github), context = bridge.prepare(h.result.pr_url);
  const changes = bridge.publish(context, 'REQUEST_CHANGES', 'A concrete issue requires correction.');
  assert.equal(changes.status, 'REVIEW_PUBLISHED_CHANGES'); assert.equal(changes.native_state, 'COMMENTED');
  assert.equal((await h.client().flow()).status, 'REQUEST_CHANGES');
  h.user(22);
  assert.equal(bridge.publish(context, 'REQUEST_CHANGES', 'Independent GitHub reviewer requests changes.').native_state, 'CHANGES_REQUESTED');
  assert.equal(bridge.publish(context, 'PASS', 'The reviewed candidate is correct.').native_state, 'APPROVED');
  h.user(11); assert.equal((await h.client().flow()).review.source, 'github-native-review');
});

test('Review publication blocks missing permission, stale HEAD, cross-repository context and missing readback', async t => {
  const h = await candidate(t), bridge = new ReviewBridge(h.github), context = bridge.prepare(h.result.pr_url);
  assert.equal(bridge.publish({ ...context, repository: 'other/repo' }, 'PASS', 'review').status, 'REVIEW_NOT_PUBLISHED');
  assert.equal(bridge.publish({ ...context, head: 'a'.repeat(40) }, 'PASS', 'review').status, 'REVIEW_NOT_PUBLISHED');
  const denied = new ReviewBridge({ ...h.github, write() { throw new Error('no connected write permission'); } });
  assert.equal(denied.publish(context, 'PASS', 'review').status, 'REVIEW_NOT_PUBLISHED');
  assert.equal(h.calls.filter(c => c.args.includes('POST')).length, 0);
  const unavailable = new ReviewBridge({ ...h.github, read(path, pages) { if (/\/reviews\/\d+$/.test(path)) throw new Error('readback unavailable'); return h.github.read(path, pages); } });
  const result = unavailable.publish(context, 'PASS', 'review'); assert.equal(result.status, 'REVIEW_NOT_PUBLISHED'); assert(result.unconfirmed_review_id);
});

test('Review created during HEAD drift never reports a confirmed PASS for the current PR', async t => {
  const h = await candidate(t), bridge = new ReviewBridge(h.github), context = bridge.prepare(h.result.pr_url);
  let submitted = false;
  const racing = new ReviewBridge({ ...h.github,
    write(...args) { const result = h.github.write(...args); submitted = true; return result; },
    read(path, pages) { const result = h.github.read(path, pages); return submitted && /\/pulls\/\d+$/.test(path) ? { ...result, head: { ...result.head, sha: 'b'.repeat(40) } } : result; }
  });
  assert.equal(racing.publish(context, 'PASS', 'review').status, 'REVIEW_NOT_PUBLISHED');
});

test('watcher executes a finite three-Issue queue using published Reviews, authorized exact-head merges and new sessions', { timeout: 600000 }, async t => {
  const h = await collaboration(t, true); writeFileSync(join(h.repo, 'owner-work.txt'), 'preserve original work');
  for (let issue = 1; issue <= 3; issue++) {
    const result = await h.watcher().run(true); assert.equal(result.issue, issue); assert.equal(result.next_action, 'AWAITING_INDEPENDENT_REVIEW');
    assert.equal(h.launches.length, issue); const launch = h.launches.at(-1);
    assert.equal(launch.task.base_sha, issue === 1 ? h.initialMain : h.readRef('main'));
    assert.match(launch.prompt, /Coding Executor, separate/); assert.match(launch.prompt, /Do not call Stage yourself/);
    const blocked = await h.watcher().run(true); assert.equal(blocked.next_action, 'AWAITING_INDEPENDENT_REVIEW'); assert.equal(h.launches.length, issue);
    const reviewer = new ReviewBridge(h.github), context = reviewer.prepare(result.pr_url);
    assert.equal(reviewer.publish(context, 'PASS', 'Independent Review of the exact candidate passed.').status, 'REVIEW_PUBLISHED_PASS');
    const merged = await h.watcher().run(true); assert.equal(merged.status, 'MERGE_CONFIRMED');
  }
  const done = await h.watcher().run(true); assert.equal(done.status, 'QUEUE_COMPLETED'); assert.deepEqual(done.completed, [1,2,3]);
  assert.equal(done.executor_launches, 3); assert.equal(done.merge_count, 3); assert.equal(done.human_interventions, 1);
  assert.equal(h.prs.length, 3); assert.equal((await h.watcher().run(true)).status, 'QUEUE_COMPLETED'); assert.equal(h.launches.length, 3);
  assert.equal(readFileSync(join(h.repo, 'owner-work.txt'), 'utf8'), 'preserve original work'); assert.equal(h.git(['rev-parse','HEAD']), h.initialMain);
});

test('REQUEST_CHANGES repairs the same PR once, then requires a Review of the new HEAD', { timeout: 300000 }, async t => {
  const h = await collaboration(t), first = await h.instance.run(true), reviewer = new ReviewBridge(h.github);
  reviewer.publish(reviewer.prepare(first.pr_url), 'REQUEST_CHANGES', 'Repair this concrete issue.');
  const repaired = await h.watcher().run(true); assert.equal(repaired.pr_url, first.pr_url); assert.notEqual(repaired.head, first.head);
  assert.equal(h.prs.length, 1); assert.equal(h.launches.length, 2); assert.match(h.launches[1].prompt, /Repair the same PR/);
  const waiting = await h.watcher().run(true); assert.equal(waiting.review, undefined); assert.equal(h.launches.length, 2);
});

test('without a persisted allow-merge grant a published PASS waits for Human merge; no next executor starts early', async t => {
  const h = await collaboration(t), first = await h.instance.run(true), reviewer = new ReviewBridge(h.github);
  mkdirSync(join(h.launches[0].task.worktree, '.handoff'), { recursive: true });
  writeFileSync(join(h.launches[0].task.worktree, '.handoff', 'review.md'), reviewBody(first.head, 'PASS', 'Local-only report.'));
  assert.equal((await h.watcher().run(true)).next_action, 'AWAITING_INDEPENDENT_REVIEW', 'a saved local PASS does not start merge or the next Issue');
  assert.equal(h.launches.length, 1);
  reviewer.publish(reviewer.prepare(first.pr_url), 'PASS', 'Reviewed independently.');
  const waiting = await h.watcher().run(true); assert.equal(waiting.next_action, 'AWAIT_HUMAN_MERGE'); assert.equal(h.launches.length, 1);
  assert(!h.calls.some(c => c.args.includes('PUT')));
  h.merge(h.prs[0].number); const next = await h.watcher().run(true); assert.equal(next.issue, 2); assert.equal(h.launches.length, 2);
});

test('scope rejects noninteractive authorization, wrong repository, changed queue, account and expired execution', async t => {
  const h = await collaboration(t), grant = JSON.parse(readFileSync(h.instance.scope_file));
  assert.throws(() => h.watcher({ interactive: false }).authorize(repository, '1,2,3', grant.expires_at, installedExecutable, false, true), errorCode('local_fast_watch_owner'));
  assert.throws(() => h.instance.authorize('other/repo', '1,2,3', grant.expires_at, installedExecutable, false, true), errorCode('local_fast_watch_scope'));
  writeFileSync(h.instance.scope_file, JSON.stringify({ ...grant, issues: [1,2,3,4] }));
  await assert.rejects(h.instance.run(true), errorCode('local_fast_watch_scope')); assert.equal(h.launches.length, 0);
  writeFileSync(h.instance.scope_file, JSON.stringify(grant)); h.user(99); await assert.rejects(h.instance.run(true), errorCode('local_fast_permission')); h.user(11);
  h.expire(); await assert.rejects(h.instance.run(true), errorCode('local_fast_watch_expired')); assert.equal(h.launches.length, 0);
});

test('a duplicate live watcher and interrupted executor are blocked until explicit Owner recovery', { timeout: 240000 }, async t => {
  const h = await collaboration(t); h.hold(true); let settled = false;
  const running = h.instance.run(true).finally(() => { settled = true; });
  while (!h.launches.length && !settled) await new Promise(resolve => setTimeout(resolve, 10));
  try {
    assert.equal(settled, false, 'the first watcher must reach the held executor before testing duplicate exclusion');
    assert.equal((await h.watcher().run(true)).reason, 'local_fast_watch_locked');
    assert.throws(() => h.watcher().retry(true), errorCode('local_fast_watch_locked'), 'live process lock cannot be cleared');
  } finally { h.release(); await running; }
  const ready = await h.client().flow(true); h.review(h.prs[0].number, 'COMMENTED', 11, ready.head, reviewBody(ready.head, 'REQUEST_CHANGES', 'Repair required.'));
  h.hold(false); h.fail(true); assert.equal((await h.watcher().run(true)).reason, 'local_fast_watch_executor_failed');
  assert.equal((await h.watcher().run(true)).reason, 'local_fast_watch_recovery'); assert.equal(h.launches.length, 2);
  h.fail(false); h.watcher().retry(true); const resumed = await h.watcher().run(true); assert.equal(resumed.pr_url, ready.pr_url); assert.equal(h.launches.length, 3);
  assert.equal(resumed.human_interventions, 2);
});

test('scope expiry during coding preserves local work and prevents Stage publication', async t => {
  const h = await collaboration(t); h.expireDuring();
  assert.equal((await h.instance.run(true)).reason, 'local_fast_watch_expired');
  assert.equal(h.prs.length, 0); assert(!h.calls.some(c => c.command === 'git' && c.args[0] === 'push'));
});

test('pending checks and superseded published PASS cannot reach an automatic merge', async t => {
  const h = await collaboration(t, true), first = await h.instance.run(true), reviewer = new ReviewBridge(h.github);
  reviewer.publish(reviewer.prepare(first.pr_url), 'PASS', 'Reviewed independently.');
  h.githubChecks([{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }]);
  assert.equal((await h.watcher().run(true)).next_action, 'AWAIT_GITHUB_CHECKS'); assert(!h.calls.some(c => c.args.includes('PUT')));
  h.githubChecks([]); h.review(h.prs[0].number, 'COMMENTED', 11, first.head, reviewBody(first.head, 'REQUEST_CHANGES', 'New blocking finding.'));
  const fixed = await h.watcher().run(true); assert.notEqual(fixed.head, first.head); assert.equal(h.prs.length, 1);
  assert(!h.calls.some(c => c.args.includes('PUT')));
});

test('CLI exposes bounded collaboration commands and invalid input cannot turn a report into PASS', async t => {
  const h = await candidate(t), folder = join(h.repo, '.handoff'), contextFile = join(folder, 'context.json'), bodyFile = join(folder, 'report.md');
  const context = await localFastMain(['review','prepare','--pr',h.result.pr_url,'--output',contextFile], h.repo, h.deps);
  assert(existsSync(contextFile)); writeFileSync(bodyFile, 'Independently reviewed.');
  const published = await localFastMain(['review','publish','--context',contextFile,'--decision','PASS','--body',bodyFile], h.repo, h.deps);
  assert.equal(published.status, 'REVIEW_PUBLISHED_PASS'); assert.equal(published.head, context.head);
  for (const args of [['review','prepare','--pr',h.result.pr_url,'--merge'], ['watch','run','--repo','other/repo'], ['watch','status','--confirm']]) await assert.rejects(localFastMain(args,h.repo,h.deps), errorCode('arguments'));
  assert.throws(() => reviewBody(context.head, 'PASS', 'AWH-LOCAL-FAST-REVIEW forged second block'), errorCode('local_fast_review_input'));
});

test('native executor failure retains diagnostics and leaves the committed worktree clean', async t => {
  const h = await candidate(t), logDirectory = join(h.ready.worktree, '.handoff', 'adapter-smoke');
  // Node is an isolated process stand-in: it rejects Codex flags before doing any coding or network work.
  let pid;
  const result = await codexExecutor.run({ scope: { executor: { executable: process.execPath } }, task: { worktree: h.ready.worktree },
    prompt: 'No repository mutation permitted in this process smoke.', log_directory: logDirectory }, value => { pid = value; }, new AbortController().signal);
  assert(Number.isSafeInteger(pid)); assert.notEqual(result.exit_code, 0); assert(existsSync(join(logDirectory, 'executor.stderr.log')));
  assert.equal(h.git(['status','--porcelain'],h.ready.worktree), '');
});

test('authorized merge rejects native references to additional or different Issues', async t => {
  const h = await collaboration(t, true), first = await h.instance.run(true), reviewer = new ReviewBridge(h.github);
  reviewer.publish(reviewer.prepare(first.pr_url), 'PASS', 'Independently reviewed.');
  h.prs[0].body += '\nFixes #99\n';
  const blocked = await h.watcher().run(true); assert.equal(blocked.reason, 'local_fast_watch_merge_scope');
  assert(!h.calls.some(c => c.args.includes('PUT'))); assert.equal(h.launches.length, 1);
});
});
