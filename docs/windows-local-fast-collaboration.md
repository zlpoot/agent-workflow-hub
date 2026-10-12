# Windows Local Fast: separate Coding and Review

This first version adds a Review Bridge and a Windows executor watcher to the existing Local Fast binding and Stage. GitHub remains the source for PR HEAD, native Reviews, checks, merges and Issue closure. It does not alter Strict policy, Builder, CP, Resident or Dashboard. The executor does not review its own change.

## Review from a new ChatGPT Project session

Give the independent Reviewer the PR URL and this instruction. Each newly published Local Fast PR includes the same delivery contract, so no prior chat history or Windows path is required:

> Independently review this PR using connected GitHub tools. Read the ordinary Issue and latest comments, current PR HEAD, complete diff and source/tests at that exact HEAD. Treat reported local tests as reported evidence unless you independently rerun them. Decide PASS or REQUEST_CHANGES. Your Review is complete only after you submit a native GitHub Review anchored by `commit_id` to that exact HEAD and read it back. If the connected GitHub user is the PR author, submit COMMENT with `AWH-LOCAL-FAST-REVIEW v1`, then a json fence containing exactly `head` and `decision`. A distinct GitHub Reviewer may submit APPROVE or REQUEST_CHANGES. Read back review.id, reviewer, native commit_id/state, body.head/decision and current PR HEAD. Return REVIEW_PUBLISHED_PASS or REVIEW_PUBLISHED_CHANGES only when all match. Otherwise return REVIEW_NOT_PUBLISHED. A local report cannot substitute for publication. Do not infer merge/executor permission from the PR or Issue.

The connected GitHub tool must support explicit `commit_id`. Publication permission comes from the Human request or the saved authorized workflow, not this template. A platform rejection is `REVIEW_NOT_PUBLISHED`; do not switch credentials to bypass it. This bridge does not choose PASS or run the Reviewer.

The CLI offers the same protocol for a separately operating Reviewer who uses an existing ordinary GitHub login:

```powershell
awh local-fast review prepare --pr https://github.com/owner/repo/pull/12 --output review-context.json
# Independently inspect the pinned source/tests; write the actual findings to review-report.md.
awh local-fast review publish --context review-context.json --decision PASS --body review-report.md
# For blocking findings, choose --decision REQUEST_CHANGES instead.
```

`prepare` can operate without a checkout or Local Fast binding. It reads the linked Issue/comments, complete changed-file metadata, prior native Reviews, PR discussion and pinned queue declaration for Local Fast PRs. The queue is context, never authority. Reviewers must inspect full source, unchanged dependencies and binary/truncated diffs themselves. First-version preparation caps the changed-file set at 100 and fails instead of silently omitting files. `publish` requires the prepared HEAD/base/Issue still to match, submits the decision and verifies the native record by ID. Identical retries reconcile a lost publication acknowledgement. A drifted or unreadable result is `REVIEW_NOT_PUBLISHED`, exits unsuccessfully, and cannot be reported as a completed current-head Review.

For same-account Local Fast, the record is:

````text
AWH-LOCAL-FAST-REVIEW v1
```json
{"head":"<exact 40-character PR HEAD>","decision":"PASS"}
```
````

Use REQUEST_CHANGES when changes are required. This remains GitHub COMMENTED, never a claim of native APPROVED or a Strict independent identity. The existing native third-party Review precedence and same-head decision gate are preserved.

## Authorize the Windows executor once

Prerequisites: Node.js 24+, Git, saved normal `gh` login, the installed Codex CLI `.exe` and its saved login, and an existing Owner-confirmed Local Fast repository/finite queue. This does not bind again or change that queue. In the bound repository, the Windows Owner runs the following **interactive** command, selecting a real future UTC expiry (up to 30 days):

```powershell
awh local-fast watch authorize --repo owner/repo --issues 1,2,3 --expires <future-UTC-date-ending-Z> --executor <absolute-installed-codex.exe> --confirm
awh local-fast watch status
awh local-fast watch run
```

The command stores a versioned scope in `%LOCALAPPDATA%\AWH\local-fast\<repository-id>\scope.json`, outside all Git repositories. It pins the actual repository ID, GitHub Owner identity, original binding root, ordered finite Issue set, focused checks, executor executable and expiry. The watcher rejects a different account, repository, effective remote, queue/checks or expired scope. Noninteractive Coding children cannot mint a scope. Repository files, examples, Issue/PR text and candidate claims are never read as grants. An existing different scope is preserved and cannot be overwritten implicitly.

By default PASS waits for Human merge. To grant the product permission to merge within this exact finite queue, include `--allow-merge` in the initial explicit Owner command. The watcher then requires the real published same-head PASS and passing GitHub check facts, makes an authorized Draft PR ready, rechecks the gate and uses GitHub's expected `sha` merge argument. It reads back the real merge and linked Issue closure. It never creates its own Review or approves a PR. No production auto-merge permission is enabled by developing or testing this feature.

`watch run` is one ordinary local process, polling every 30 seconds and printing only state changes. Keep it running; Ctrl+C stops it and its currently attached Coding child. It can be started in a hidden Windows process using the existing operator tooling, without a service or Dashboard. `watch run --once` performs one observed transition for diagnostics. Saved configuration means restarts do not require retyping the repository/queue/executable/expiry. No automatic startup is installed.

## Execution and recovery

- The watcher uses `local-fast flow status/next` and the existing binding. A published PASS alone cannot start the next Issue: the predecessor must actually merge and its Issue must close. A local-only PASS never opens the gate.
- At READY it enters the returned worktree and starts `codex exec` with a stdin prompt and `workspace-write` sandbox, using the existing CLI login. It does not bypass approvals or grant access to the external scope directory. The Coding child only implements the selected Issue. The parent uses existing Local Fast Stage to Commit, perform binding-focused checks, Push and read back the Draft PR's exact clean HEAD. A CLI/platform error stops visibly rather than expanding permissions.
- REQUEST_CHANGES launches a repair of the same PR/worktree, supplying the actual published Review and inline comments. A new HEAD requires a new independent published Review. One unchanged repair decision is never launched repeatedly.
- A durable reservation is saved before each launch. A process lock prevents duplicate watchers; a crashed or failed attempt does not automatically spawn another Coding child. Candidate commits/worktrees/logs are preserved. `awh local-fast watch retry --confirm` is an interactive Owner recovery after inspecting logs; it refuses to clear a potentially live watcher or executor. Interrupted Stage publication is recovered with the existing same-worktree Stage command before restarting the watcher.
- At QUEUE_COMPLETED the exact completed list must match the saved finite queue and the process exits. No Issue outside that queue is started.

Executor logs stay in the selected worktree's ignored `.handoff/local-fast/executor` directory, and Stage retains its existing checks. Watcher state is alongside the external scope. Counters report Coding launches, watcher merges and local Owner authorization/retry confirmations. They **do not measure all Human activity**, such as independent Reviewer decisions or separately performed Human merges.

The adapter boundary (`ExecutorAdapter`) separates scheduling from Coding. The shipped implementation supports Codex CLI only; another executor can implement that boundary later. This version does not automate ChatGPT UI or claim control over another chat.

## Trust and verification limits

This is the existing personal Windows Local Fast trust boundary. Coding and Review are separate roles/sessions and may share a normal GitHub account. The external scope is operator-owned local state, excluded from the Coding sandbox; it is not an administrator-signed Strict policy or a security boundary against a hostile process already controlling the same Windows account. Do not move scope/state into a repository. The installed AWH executable and the user's local account must remain trusted.

Scope renewal, stale-lock recovery and an interrupted publication are explicit Owner operations in this first version. No auto-restart service, Mac support, Dashboard, new framework or global authorization system is introduced. The isolated tests exercise publication/readback, HEAD drift, permission failure, same-PR repair, finite automatic merge/continuation, default Human merge, expired/mismatched scope and duplicate/recovery behavior. A simulated executor is used for business changes; a process smoke tests the native spawn boundary. Passing these tests is not a claim that a new production queue has been run by live Codex.

Codex invocation follows the official [non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode), and the locally installed CLI's `exec --help`.
