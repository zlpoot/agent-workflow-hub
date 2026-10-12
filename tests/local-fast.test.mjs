import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LocalFast } from '../dist/workflow/local-fast.js';
import { localFastMain } from '../dist/workflow/local-fast-cli.js';
import { deliveryDependencies } from '../dist/client/deliver.js';
import { main } from '../dist/client/cli.js';

const repository = 'synthetic-org/local-fast';
const options = { title: 'Synthetic queued change', body: 'Ordinary Issue implementation.', message: 'Implement queued Issue' };
function harness(t) {
  const parent = join(process.cwd(), '.handoff', 'local-fast-tests'); mkdirSync(parent, { recursive: true });
  const base = mkdtempSync(join(parent, 'run-')), repo = join(base, 'repo'), remote = join(base, 'remote.git'); mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Synthetic Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' };
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(r.status, 0, `isolated Git failed: ${args.join(' ')} ${r.stderr}`); return r.stdout.trim();
  };
  git(['init', '-b', 'main']); writeFileSync(join(repo, 'code.txt'), 'baseline\n'); mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'tests/smoke.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('candidate works',()=>assert(readFileSync('code.txt','utf8').length > 0));\n");
  git(['add', '.']); git(['commit', '-m', 'Synthetic baseline']); git(['remote', 'add', 'origin', `https://github.com/${repository}.git`]); git(['clone', '--bare', repo, remote]);
  const initialMain = git(['rev-parse', 'HEAD']), calls = [], prs = [], reviews = new Map(), issueStates = new Map();
  let userId = 11, permission = true, failCheck = false, mutateCheck = false, loseCreateAck = false, failPush = false, nextPr = 10, rollup = [], interruptPrepare = false;
  const readRef = branch => git(['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`]);
  const refresh = p => { p.head.sha = readRef(p.head.ref); return p; };
  const deps = {
    platform: 'win32',
    run(command, args, cwd) {
      calls.push({ command, args: [...args], cwd });
      if (command === 'git') {
        const translated = [...args];
        if (['fetch', 'push', 'ls-remote'].includes(args[0])) {
          if (args[0] === 'push' && failPush) throw new Error('synthetic push failure');
          translated[translated.indexOf('origin')] = remote;
        }
        const output = git(translated, cwd);
        if (interruptPrepare && args[0] === 'worktree' && args[1] === 'add') { interruptPrepare = false; throw new Error('Synthetic interrupted preparation'); }
        return output;
      }
      const value = flag => args[args.indexOf(flag) + 1];
      if (args[0] === 'api') {
        const path = args.at(-1), pages = args.includes('--slurp'), wrap = data => JSON.stringify(pages ? [data] : data);
        if (path === 'user') return wrap({ login: 'synthetic-owner', id: userId, type: 'User' });
        if (path === `repos/${repository}`) return wrap({ id: 42, full_name: repository, default_branch: 'main', permissions: { push: permission } });
        const issue = /\/issues\/(\d+)$/.exec(path);
        if (issue) return wrap({ number: Number(issue[1]), title: `Ordinary Issue ${issue[1]}`, body: 'Synthetic only', state: issueStates.get(Number(issue[1])) ?? 'open' });
        const ref = /\/git\/ref\/heads\/(.+)$/.exec(path);
        if (ref) return wrap({ ref: `refs/heads/${ref[1]}`, object: { sha: readRef(ref[1]) } });
        const review = /\/pulls\/(\d+)\/reviews\?/.exec(path);
        if (review) return wrap(reviews.get(Number(review[1])) ?? []);
        const pull = /\/pulls\/(\d+)$/.exec(path);
        if (pull) return wrap(refresh(prs.find(p => p.number === Number(pull[1]))));
        if (path.includes('/pulls?')) {
          const branch = /head=synthetic-org:(.*?)&/.exec(path)[1];
          return wrap(prs.filter(p => p.head.ref === branch).map(refresh));
        }
        throw new Error(`Unexpected Provider read: ${path}`);
      }
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ statusCheckRollup: rollup });
      if (args[0] === 'pr' && args[1] === 'create') {
        assert(args.includes('--draft')); assert.equal(value('--repo'), repository); assert.equal(value('--base'), 'main');
        const branch = value('--head'), number = nextPr++;
        prs.push({ number, html_url: `https://github.com/${repository}/pull/${number}`, state: 'open', draft: true, merged_at: null,
          user: { id: 11, login: 'synthetic-owner' }, body: readFileSync(value('--body-file'), 'utf8'),
          head: { ref: branch, sha: readRef(branch), repo: { id: 42 } }, base: { ref: 'main', repo: { id: 42 } } });
        if (loseCreateAck) { loseCreateAck = false; throw new Error('Synthetic lost create ACK'); }
        return prs.at(-1).html_url;
      }
      if (args[0] === 'pr' && args[1] === 'edit') { prs.find(p => p.number === Number(args[2])).body = readFileSync(value('--body-file'), 'utf8'); return ''; }
      if (args[0] === 'pr' && args[1] === 'ready' && args.includes('--undo')) { prs.find(p => p.number === Number(args[2])).draft = true; return ''; }
      throw new Error('Unexpected Provider mutation; no Review/Merge/Evidence/Handoff/CP API is allowed');
    },
    async verify(command, cwd) {
      if (mutateCheck) writeFileSync(join(cwd, 'unexpected.txt'), 'changed during check');
      if (failCheck) return { command, exit_code: 1, stdout: 'Synthetic check failure', stderr: '', elapsed_ms: 0 };
      return deliveryDependencies.verify(command, cwd);
    }
  };
  const client = (cwd = repo) => new LocalFast(cwd, deps);
  const bind = () => client().bind(repository, '1,2,3', true, ['node --test tests/smoke.test.mjs']);
  const review = (number, state = 'APPROVED', owner = 22, head, body = '') => {
    const p = refresh(prs.find(p => p.number === number));
    const list = reviews.get(number) ?? []; list.push({ id: 100 + list.length, user: { id: owner }, commit_id: head ?? p.head.sha, state, body }); reviews.set(number, list);
  };
  // Human merge is simulated only against this fresh local bare remote; product never merges.
  const merge = number => { const p = refresh(prs.find(p => p.number === number)); git(['--git-dir', remote, 'update-ref', 'refs/heads/main', p.head.sha]); p.merged_at = '2026-10-12T00:00:00Z'; p.state = 'closed'; p.draft = false; };
  const statePath = join(repo, '.git', 'awh-local-fast', 'state.json');
  t.after(() => { const rel = relative(realpathSync(parent), realpathSync(base)); assert(rel && !rel.startsWith('..') && rel.startsWith('run-')); rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { repo, remote, initialMain, calls, prs, deps, client, bind, review, merge, git, readRef, statePath,
    permission(value) { permission = value; }, user(value) { userId = value; }, failCheck(value) { failCheck = value; }, mutateCheck(value) { mutateCheck = value; },
    loseCreateAck() { loseCreateAck = true; }, failPush(value) { failPush = value; }, closeIssue(n) { issueStates.set(n, 'closed'); },
    githubChecks(value) { rollup = value; }, interruptPrepare() { interruptPrepare = true; } };
}
const code = expected => error => error.code === expected;

describe('Local Fast isolated workflows', { concurrency: 4 }, () => {

test('one binding drives three ordinary Issues, same-PR revision and latest-main continuation without administrator inputs', { timeout: 180000 }, async t => {
  const h = harness(t); writeFileSync(join(h.repo, 'keep-owner-work.txt'), 'preserve original dirty worktree');
  assert.equal((await localFastMain(['bind', '--repo', repository, '--issues', '1,2,3', '--confirm', '--check', 'node --test tests/smoke.test.mjs'], h.repo, h.deps)).status, 'BOUND');
  const before = readFileSync(h.statePath, 'utf8'); assert.equal((await h.client().flow()).issue, 1); assert.equal(readFileSync(h.statePath, 'utf8'), before);
  let ready = await h.client().flow(true); assert.equal(ready.base_sha, h.initialMain); assert.equal(ready.issue, 1);
  let active = h.client(ready.worktree); assert.equal(active.prepare().issue_details.number, 1);
  writeFileSync(join(ready.worktree, 'code.txt'), 'feature one\n'); const first = await active.execute(options);
  assert.equal(first.next_action, 'AWAITING_INDEPENDENT_REVIEW'); assert.equal(first.mode, 'local-fast'); assert.equal(h.prs.length, 1);
  assert(!('evidence_urls' in first || 'handoff_url' in first || 'run_id' in first)); assert(!h.prs[0].body.includes('Builder evidence'));
  const pr = h.prs[0].number;
  h.review(pr, 'APPROVED', 11); assert.equal((await active.flow()).status, 'AWAITING_REVIEW');
  h.review(pr); assert.equal((await active.flow(true)).status, 'AWAITING_REVIEW');
  h.review(pr, 'CHANGES_REQUESTED'); assert.equal((await active.flow()).status, 'REQUEST_CHANGES');
  writeFileSync(join(ready.worktree, 'code.txt'), 'feature one repaired\n'); const revised = await active.execute(options);
  assert.equal(revised.pr_url, first.pr_url); assert.notEqual(revised.head, first.head); assert.equal(h.prs.length, 1); assert.equal((await active.flow()).status, 'AWAITING_REVIEW');
  h.review(pr); h.merge(pr);
  for (const issue of [2, 3]) {
    const latest = h.readRef('main'); ready = await active.flow(true);
    assert.equal(ready.issue, issue); assert.equal(ready.base_sha, latest); assert.equal(h.git(['rev-parse', 'HEAD'], ready.worktree), latest);
    active = h.client(ready.worktree); writeFileSync(join(ready.worktree, 'code.txt'), `feature ${issue}\n`);
    const candidate = await active.execute(options); assert.equal(candidate.status, 'awaiting_review');
    const number = h.prs.at(-1).number; assert.equal((await active.flow(true)).issue, issue); h.review(number); h.merge(number);
  }
  const complete = await active.flow(true); assert.equal(complete.status, 'QUEUE_COMPLETED'); assert.deepEqual(complete.completed, [1,2,3]); assert.equal(h.prs.length, 3);
  assert.equal(readFileSync(join(h.repo, 'keep-owner-work.txt'), 'utf8'), 'preserve original dirty worktree');
  assert.equal(h.git(['rev-parse', 'main']), h.initialMain, 'local original main was never reset');
  assert(h.calls.every(c => c.command !== 'gh' || !c.args.some(a => /app\/installations|approve|merge|comment/.test(a))));
  assert(!existsSync(join(h.repo, 'cp.sqlite')));
});

test('same-account COMMENTED Review drives three Issues, same-PR repair and fresh-head PASS only after Human merge', { timeout: 180000 }, async t => {
  const h = harness(t); await h.bind(); let ready = await h.client().flow(true), active = h.client(ready.worktree);
  const decision = (head, verdict) => `AWH-LOCAL-FAST-REVIEW v1\n\`\`\`json\n${JSON.stringify({ head, decision: verdict })}\n\`\`\``;
  writeFileSync(join(ready.worktree, 'code.txt'), 'same-account feature one\n'); const first = await active.execute(options), pr = h.prs[0].number;
  h.review(pr, 'COMMENTED', 11, first.head, 'PASS'); assert.equal((await active.flow()).review, undefined);
  h.review(pr, 'COMMENTED', 11, first.head, decision(ready.base_sha, 'PASS')); assert.equal((await active.flow()).review, undefined);
  h.review(pr, 'COMMENTED', 11, first.head, decision(first.head, 'APPROVED')); assert.equal((await active.flow()).review, undefined);
  h.review(pr, 'COMMENTED', 11, first.head, decision(first.head, 'REQUEST_CHANGES'));
  const requested = await active.flow(true); assert.equal(requested.status, 'REQUEST_CHANGES'); assert.equal(requested.pr_url, first.pr_url);
  assert.equal(requested.review.source, 'local-fast-commented-review'); assert.equal(requested.review.native_state, 'COMMENTED'); assert(requested.instructions[0].includes('same PR'));
  writeFileSync(join(ready.worktree, 'code.txt'), 'same-account feature one repaired\n'); const repaired = await active.execute(options);
  assert.equal(repaired.pr_url, first.pr_url); assert.notEqual(repaired.head, first.head); assert.equal(h.prs.length, 1);
  h.review(pr, 'COMMENTED', 11, first.head, decision(first.head, 'PASS')); assert.equal((await active.flow()).review, undefined, 'old HEAD PASS is not reusable');
  h.review(pr, 'COMMENTED', 11, repaired.head, decision(first.head, 'PASS')); assert.equal((await active.flow()).review, undefined, 'body HEAD must match native commit_id');
  h.review(pr, 'COMMENTED', 11, repaired.head, decision(repaired.head, 'PASS'));
  let passed = await active.flow(true); assert.equal(passed.issue, 1); assert.equal(passed.status, 'AWAITING_REVIEW');
  assert.equal(passed.review.decision, 'PASS'); assert.equal(passed.review.native_state, 'COMMENTED'); assert.equal(passed.review.source, 'local-fast-commented-review');
  assert.equal(JSON.parse(readFileSync(h.statePath)).tasks.length, 1, 'comment PASS alone cannot advance');
  // A later same-head REQUEST_CHANGES supersedes the comment PASS; a new PASS is required.
  h.review(pr, 'COMMENTED', 11, repaired.head, decision(repaired.head, 'REQUEST_CHANGES')); assert.equal((await active.flow()).status, 'REQUEST_CHANGES');
  h.review(pr, 'COMMENTED', 11, repaired.head, decision(repaired.head, 'PASS')); h.merge(pr);
  for (const issue of [2, 3]) {
    const latest = h.readRef('main'); ready = await active.flow(true); assert.equal(ready.issue, issue); assert.equal(ready.base_sha, latest);
    active = h.client(ready.worktree); writeFileSync(join(ready.worktree, 'code.txt'), `same-account feature ${issue}\n`);
    const candidate = await active.execute(options), number = h.prs.at(-1).number;
    h.review(number, 'COMMENTED', 11, candidate.head, decision(candidate.head, 'PASS'));
    passed = await active.flow(true); assert.equal(passed.issue, issue); assert.equal(passed.review.native_state, 'COMMENTED');
    assert.equal(passed.review.decision, 'PASS'); assert.equal(passed.review.source, 'local-fast-commented-review'); h.merge(number);
  }
  const complete = await active.flow(true); assert.equal(complete.status, 'QUEUE_COMPLETED'); assert.deepEqual(complete.completed, [1,2,3]); assert.equal(h.prs.length, 3);
  assert(!h.calls.some(c => c.command === 'gh' && c.args.some(a => a === 'merge' || a === 'review')));
});

test('bind checks write permission, exact repository/queue and ordinary Issues before retaining a binding', async t => {
  const h = harness(t); h.permission(false);
  await assert.rejects(h.bind(), code('local_fast_permission')); assert(!existsSync(h.statePath));
  h.permission(true); await assert.rejects(h.client().bind(repository, '1,1', true), code('flow_queue'));
  await assert.rejects(h.client().bind(repository, '1,2,3', false), code('local_fast_confirmation'));
  assert(!existsSync(join(h.repo, '.awh/flow.json'))); await h.bind(); assert.equal((await h.bind()).status, 'BOUND');
  await assert.rejects(h.client().bind(repository, '1,2,4', true), code('local_fast_binding_conflict'));
  writeFileSync(join(h.repo, '.awh/flow.json'), JSON.stringify({ schema_version: '1.0', issues: [1,2,4] }));
  await assert.rejects(h.client().flow(), code('local_fast_queue_scope'));
});

test('failed verification retains auto-Commit and raw failure, with zero Push or PR creation', async t => {
  const h = harness(t); await h.bind(); const ready = await h.client().flow(true); const active = h.client(ready.worktree);
  writeFileSync(join(ready.worktree, 'code.txt'), 'candidate\n'); h.failCheck(true);
  await assert.rejects(active.execute(options), code('local_fast_verification'));
  const head = h.git(['rev-parse', 'HEAD'], ready.worktree); assert.notEqual(head, ready.base_sha); assert.equal(h.git(['status', '--porcelain'], ready.worktree), '');
  const log = JSON.parse(readFileSync(join(h.repo, '.handoff/local-fast/checks', `1-${head}.json`)));
  assert.equal(log.logs[0].exit_code, 1); assert.equal(h.prs.length, 0); assert(!h.calls.some(c => c.command === 'git' && c.args[0] === 'push'));
  h.failCheck(false); assert.equal((await active.execute(options)).status, 'awaiting_review');
});

test('verification cannot alter the committed candidate and still publish', async t => {
  const h = harness(t); await h.bind(); const ready = await h.client().flow(true); h.mutateCheck(true);
  await assert.rejects(h.client(ready.worktree).execute(options), code('local_fast_exact_head')); assert.equal(h.prs.length, 0);
  assert(!h.calls.some(c => c.command === 'git' && c.args[0] === 'push'));
});

test('lost PR create ACK reconciles the same Draft PR and never creates another', async t => {
  const h = harness(t); await h.bind(); const ready = await h.client().flow(true); const active = h.client(ready.worktree);
  h.loseCreateAck(); await assert.rejects(active.execute(options), /lost create ACK/); assert.equal(h.prs.length, 1);
  assert.equal((await active.flow(true)).status, 'AWAITING_REVIEW'); const resumed = await active.execute(options);
  assert.equal(resumed.pr_url, h.prs[0].html_url); assert.equal(h.calls.filter(c => c.command === 'gh' && c.args[1] === 'create').length, 1);
});

test('interrupted Push can resume the same verified commit without losing the previous PR head', async t => {
  const h = harness(t); await h.bind(); const ready = await h.client().flow(true); const active = h.client(ready.worktree); await active.execute(options);
  writeFileSync(join(ready.worktree, 'code.txt'), 'revision\n'); h.failPush(true);
  await assert.rejects(active.execute(options), /push failure/); assert.equal((await active.flow()).status, 'PUBLISHING');
  h.failPush(false); const resumed = await active.execute(options); assert.equal(resumed.pr_url, h.prs[0].html_url); assert.equal(h.prs.length, 1);
});

test('merged candidate needs independent exact-head Review; closed Issue alone cannot skip the queue', async t => {
  const h = harness(t); await h.bind(); const ready = await h.client().flow(true); const active = h.client(ready.worktree); await active.execute(options);
  h.review(h.prs[0].number, 'APPROVED', 11); h.merge(h.prs[0].number); await assert.rejects(active.flow(true), code('local_fast_merge_gate'));
  assert.equal(JSON.parse(readFileSync(h.statePath)).tasks.length, 1);
});

test('native failing or pending checks block continuation after merge; successful checks allow the next Issue', async t => {
  const h = harness(t); await h.bind(); const ready = await h.client().flow(true); const active = h.client(ready.worktree); await active.execute(options);
  h.review(h.prs[0].number);
  const nativeHead = h.prs[0].head.sha;
  h.review(h.prs[0].number, 'COMMENTED', 11, nativeHead, `AWH-LOCAL-FAST-REVIEW v1\n\`\`\`json\n${JSON.stringify({ head: nativeHead, decision: 'REQUEST_CHANGES' })}\n\`\`\``);
  const nativePass = await active.flow(); assert.equal(nativePass.review.source, 'github-native-review');
  assert.equal(nativePass.review.native_state, 'APPROVED'); assert.equal(nativePass.review.decision, 'PASS', 'third-party native APPROVED retains priority');
  h.merge(h.prs[0].number);
  h.githubChecks([{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }]); await assert.rejects(active.flow(true), code('local_fast_merge_gate'));
  h.githubChecks([{ __typename: 'StatusContext', state: 'FAILURE' }]); await assert.rejects(active.flow(true), code('local_fast_merge_gate'));
  h.githubChecks([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]); assert.equal((await active.flow(true)).issue, 2);
});

test('interrupted creation of a complete reserved worktree resumes without another branch or manual SHA entry', async t => {
  const h = harness(t); await h.bind(); h.interruptPrepare(); await assert.rejects(h.client().flow(true), /interrupted preparation/);
  assert.equal((await h.client().flow()).status, 'PREPARING'); const ready = await h.client().flow(true);
  assert.equal(ready.issue, 1); assert.equal(ready.base_sha, h.initialMain);
  assert.equal(h.calls.filter(c => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add').length, 1);
});

test('effective Push URL and changed GitHub account cannot escape the first repository confirmation', async t => {
  const h = harness(t); await h.bind(); h.user(99); await assert.rejects(h.client().flow(), code('local_fast_permission')); h.user(11);
  h.git(['config', 'remote.origin.pushurl', 'https://github.com/other-org/other-repo.git']); await assert.rejects(h.client().flow(), code('local_fast_scope'));
  assert.equal(h.prs.length, 0);
});

test('Local Fast has a bounded Windows-only CLI and cannot impersonate Strict artifacts; Strict still requires its own trust', async t => {
  assert((await main(['--help'])).commands.some(c => c.startsWith('local-fast bind')));
  const denied = { platform: 'linux', run() { throw new Error('No subprocess expected'); } };
  for (const args of [['merge'], ['flow', 'next', '--approve'], ['bind', '--repo', repository, '--issues', '1,2,3'], ['stage', 'execute', '--merge']])
    await assert.rejects(localFastMain(args, process.cwd(), denied), code('arguments'));
  assert.throws(() => new LocalFast(process.cwd(), denied), code('local_fast_platform'));
  const h = harness(t); await h.bind(); const ready = await h.client().flow(true);
  await assert.rejects(h.client(ready.worktree).execute({ ...options, body: 'AWH-HANDOFF fabricated' }), code('local_fast_arguments'));
  await assert.rejects(h.client(ready.worktree).execute({ ...options, checks: ['gh pr merge 1'] }), code('local_fast_check'));
  await assert.rejects(main(['stage', 'prepare']), e => e.code === 'independent_trust_pin_required');
});
});
