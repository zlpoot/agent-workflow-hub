import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LocalFast } from '../../dist/workflow/local-fast.js';
import { deliveryDependencies } from '../../dist/client/deliver.js';

export const repository = 'synthetic-org/local-fast';
export const options = { title: 'Synthetic queued change', body: 'Ordinary Issue implementation.', message: 'Implement queued Issue' };
export function harness(t) {
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
    run(command, args, cwd, input) {
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
        if (args[1] === 'graphql') {
          const number = Number(args.find(a => a.startsWith('number=')).split('=')[1]), p = prs.find(p => p.number === number);
          const closing = [...p.body.matchAll(/(?:Closes|Fixes|Resolves) #(\d+)/gi)].map(match => ({ number: Number(match[1]), repository: { nameWithOwner: repository } }));
          return JSON.stringify({ data: { repository: { pullRequest: { closingIssuesReferences: { totalCount: closing.length, nodes: closing.slice(0,2) } } } } });
        }
        const path = args.at(-1), pages = args.includes('--slurp'), wrap = data => JSON.stringify(pages ? [data] : data);
        if (path === 'user') return wrap({ login: 'synthetic-owner', id: userId, type: 'User' });
        if (path === `repos/${repository}`) return wrap({ id: 42, full_name: repository, default_branch: 'main', permissions: { push: permission } });
        if (path.startsWith(`repos/${repository}/contents/.awh/flow.json?ref=`)) {
          const head = path.split('=')[1]; return wrap({ encoding: 'base64', content: Buffer.from(git(['show', `${head}:.awh/flow.json`])).toString('base64') });
        }
        if (/\/issues\/\d+\/comments\?/.test(path)) return wrap([]);
        if (/\/reviews\/\d+\/comments\?/.test(path)) return wrap([]);
        const reviewWrite = /\/pulls\/(\d+)\/reviews$/.exec(path);
        if (reviewWrite && args.includes('POST')) {
          const payload = JSON.parse(input), list = reviews.get(Number(reviewWrite[1])) ?? [];
          const review = { id: 100 + list.length, user: { id: userId }, commit_id: payload.commit_id,
            state: payload.event === 'COMMENT' ? 'COMMENTED' : payload.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED', body: payload.body };
          list.push(review); reviews.set(Number(reviewWrite[1]), list); return wrap(review);
        }
        const reviewId = /\/pulls\/(\d+)\/reviews\/(\d+)$/.exec(path);
        if (reviewId) return wrap((reviews.get(Number(reviewId[1])) ?? []).find(r => r.id === Number(reviewId[2])));
        const mergeWrite = /\/pulls\/(\d+)\/merge$/.exec(path);
        if (mergeWrite && args.includes('PUT')) {
          const p = refresh(prs.find(p => p.number === Number(mergeWrite[1])));
          assert.equal(JSON.parse(input).sha, p.head.sha); assert.equal(p.draft, false); merge(p.number); return wrap({ merged: true });
        }
        const files = /\/pulls\/(\d+)\/files\?/.exec(path);
        if (files) {
          const p = refresh(prs.find(p => p.number === Number(files[1])));
          return wrap(git(['diff', '--name-only', `${p.base.sha}...${p.head.sha}`]).split('\n').filter(Boolean).map(filename => ({ filename, status: 'modified', patch: 'synthetic patch' })));
        }
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
          head: { ref: branch, sha: readRef(branch), repo: { id: 42 } }, base: { ref: 'main', sha: readRef('main'), repo: { id: 42 } },
          changed_files: git(['diff', '--name-only', `${readRef('main')}...${readRef(branch)}`], cwd).split('\n').filter(Boolean).length });
        if (loseCreateAck) { loseCreateAck = false; throw new Error('Synthetic lost create ACK'); }
        return prs.at(-1).html_url;
      }
      if (args[0] === 'pr' && args[1] === 'edit') { prs.find(p => p.number === Number(args[2])).body = readFileSync(value('--body-file'), 'utf8'); return ''; }
      if (args[0] === 'pr' && args[1] === 'ready' && args.includes('--undo')) { prs.find(p => p.number === Number(args[2])).draft = true; return ''; }
      if (args[0] === 'pr' && args[1] === 'ready' && !args.includes('--undo')) { prs.find(p => p.number === Number(args[2])).draft = false; return ''; }
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
  // Simulated provider merges only update this fresh local bare remote.
  const merge = number => { const p = refresh(prs.find(p => p.number === number)); git(['--git-dir', remote, 'update-ref', 'refs/heads/main', p.head.sha]); p.merged_at = '2026-10-12T00:00:00Z'; p.state = 'closed'; p.draft = false; issueStates.set(Number(/^Closes #(\d+)$/m.exec(p.body)[1]), 'closed'); };
  const statePath = join(repo, '.git', 'awh-local-fast', 'state.json');
  t.after(() => { const rel = relative(realpathSync(parent), realpathSync(base)); assert(rel && !rel.startsWith('..') && rel.startsWith('run-')); rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { repo, remote, initialMain, calls, prs, deps, client, bind, review, merge, git, readRef, statePath,
    permission(value) { permission = value; }, user(value) { userId = value; }, failCheck(value) { failCheck = value; }, mutateCheck(value) { mutateCheck = value; },
    loseCreateAck() { loseCreateAck = true; }, failPush(value) { failPush = value; }, closeIssue(n) { issueStates.set(n, 'closed'); },
    githubChecks(value) { rollup = value; }, interruptPrepare() { interruptPrepare = true; } };
}
