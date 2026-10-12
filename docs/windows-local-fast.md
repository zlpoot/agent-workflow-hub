# Windows Local Fast

Local Fast is an explicit personal mode for one Windows machine, one repository and an Owner-confirmed ordered Issue queue. It uses existing Git and GitHub CLI authentication. It needs no administrator Policy, Work Item approval, SHA entry, digest, launcher, CP database or Enrollment. The default commands still use Strict authorization; a missing Strict approval never switches modes.

Install Node.js 24+, Git, GitHub CLI and the AWH Client. Sign in normally with `gh auth login` if needed. The repository must already have a committed `main` on GitHub and a canonical GitHub `origin`. The signed-in normal GitHub user must have repository write permission. Local Fast checks the real account, repository ID and effective Git fetch/push URLs on each operation. It does not administer repositories or create initial GitHub Issues.

## Confirm once

From the project's existing checkout:

```powershell
awh local-fast bind --repo owner/project --issues 1,2,3 --confirm
# Optionally declare the project's necessary focused checks once:
# awh local-fast bind --repo owner/project --issues 1,2,3 --confirm --check 'pnpm typecheck' --check 'pnpm build'
awh local-fast flow status
awh local-fast flow next
```

Use the actual repository and ordinary open Issue numbers. The binding stores the queue and ordinary account identity in the repository's common Git directory, shared by its worktrees. `.awh/flow.json` remains the existing minimal queue declaration. Its Issue list must match the confirmed local scope; editing a queue does not add authority. Repeating the same binding preserves all progress; a different binding fails rather than overwriting history.

`flow status` reads local state and native GitHub facts without advancing or creating worktrees. `flow next` fetches and rechecks the actual latest `main`, then creates `codex/local-fast-<issue>` in a separate `.handoff/local-fast/issue-<issue>` worktree. It preserves the original checkout, dirty work and local `main`. `.handoff/` is added to the common local Git exclusions. The queue declaration is copied into each Issue worktree when absent; it can be committed with the first Issue, without a separate main bootstrap publication or administrator step.

## Codex develops and publishes

Tell Codex:

> Use AWH Local Fast for this confirmed repository and queue. Run flow next, enter the returned worktree, read the Issue, implement only its scope, and run necessary focused checks. Use local-fast stage execute to Commit, Push and publish a Draft PR. Stop for ChatGPT independent Review. After Request Changes, repair this same PR; after Human merge, run flow next to select the next Issue from current main. Never approve or merge a PR.

Codex uses the returned worktree:

```powershell
Set-Location '<worktree returned by flow next>'
awh local-fast stage prepare
# Implement the Issue. Save the ordinary PR description to a UTF-8 file.
awh local-fast stage execute --title 'Implement Issue #1' --body '<UTF8-file>' --message 'Implement Issue #1'
# A necessary Issue-specific test may be added without an administrator approval:
# awh local-fast stage execute ... --check 'node --test tests/feature.test.mjs'
```

Stage automatically stages and commits changed files, runs the main diff check plus configured/extra focused checks, verifies the same clean final HEAD, pushes the Issue branch without force, creates a Draft PR and confirms its actual remote HEAD. Already committed changes are accepted. Checks accept bounded pnpm scripts, `node --test tests/<files>.mjs` and the main diff check; arbitrary shell, API or merge commands are unavailable.

The result identifies `mode: local-fast`, the Issue, PR and HEAD, local verification log path and `next_action: AWAITING_INDEPENDENT_REVIEW`. The ordinary PR identifies Local Fast and includes `Closes #<issue>`. Raw verification logs stay in ignored `.handoff/local-fast/checks`. Local Fast never publishes formal Builder Evidence, Handoff, CP Runs or CP Events, and its local check result does not count as independent Review.

## Same PR, then the next Issue

```powershell
awh local-fast flow status
awh local-fast flow next
# REQUEST_CHANGES: fix in the returned same worktree, then execute Stage again.
# After independent approval and Human merge: flow next automatically
# records completion and creates the next worktree from the latest remote main.
```

An open PR, even when approved, blocks the next Issue. Independent native approval must name the exact current candidate HEAD; the PR author's own approval does not satisfy the gate. A new commit requires a fresh independent Review. Stage updates the same PR and returns it to Draft if it was made ready. It cannot create a replacement for a closed unmerged PR.

Continuation checks native merge, independent exact-head approval and GitHub status checks. It does not require manual Issue closing or a new per-Issue administrator approval. After Issue #3 it returns `QUEUE_COMPLETED`. No command auto-merges. Flow advances when invoked by Codex after the Human merge; this version has no background watcher or autonomous model scheduler.

Verification failure preserves the local Commit and raw failure without Push. A failed/uncertain publication keeps the same candidate; retry Stage reads back the branch and searches the exact Issue PR before resuming. `flow next` can reconcile a lost PR-create acknowledgement or resume an interrupted preparation when the reserved worktree exactly matches its original branch/base. An interrupted lock/incomplete worktree, unexpected remote HEAD, changed account or conflicting branch/PR fails visibly and preserves state; do not delete history or force-push to bypass it.

Local Fast is distinct from Strict. Continue using the existing Strict commands and protected App/administrator policy for formal delivery. Neither Local Fast bindings nor ordinary PRs authorize a Strict Builder operation.
