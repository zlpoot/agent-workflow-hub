# Windows repeatable delivery MVP

Hub #41 adds Client 0.4.0 and one immutable `v02-repeatable-v1` version under `future-ui/c1c-acceptance`. The current user-authorized task is #41/#90; old #8/#21/#31/#39 task restrictions are superseded for this request. Old PR #28, #31 candidates, fixed Profiles and Future UI's active product worktrees are preserved. All delivery writes use the existing GitHub App Builder; there is no approve, merge, close, credential fallback or arbitrary shell/repository/URL execution.

## One-time setup

Use Node 24+ and the provided tarball. Preserve the existing external Client config, dedicated credential, state directory, endpoint, machine identity, Project and Executor. Do not initialize another Project or namespace.

```powershell
npm install --prefix '<existing-external-client-install>' --offline --ignore-scripts --no-audit --no-fund '<zlpoot-awh-client-0.4.0.tgz>'
& '<existing-external-client-install>/node_modules/.bin/awh.cmd' --version
```

The new template uses `branch.mode=issue_prefix`, prefix `codex/awh-task-`, and the existing `c1c-future-ui-windows` executor with one existing Windows machine restriction. Old `mode=fixed` policies retain their behavior. CP v2 database tables/schema and old Run/Event records are unchanged. This additive Protocol declaration requires compatible runtime validation. The original Windows CP validator rejects it: stop at the Hub RC review/deployment dependency. Do not implicitly restart, replace, migrate or seed the original CP.

Only after compatible runtime loading has explicit authorization, append the static version once:

```powershell
node '<reviewed-hub-install>/dist/mvp-cli.js' seed-repeatable --database '<existing-external-cp-v2.sqlite>'
```

The seed reads the existing Project and Windows executor/machine and uses the immutable Profile transaction. Missing databases, unsupported schemas and missing identities fail closed. It does not rotate credentials or mutate old records. Select `profile_version: v02-repeatable-v1` once in the existing external Client config, preserving all other fields; register upgraded Client metadata through the same identity:

```powershell
& '<existing-external-client-install>/node_modules/.bin/awh.cmd' --config '<existing-external-client.json>' register
```

These are setup steps, not per-Issue steps. Keep secrets outside repositories, logs, PR bodies, Events and chat.

## Each new Issue

Use a new clean, committed worktree from current App-authenticated `origin/main`, retaining the same minimal Manifest. Its real Git branch must exactly be `codex/awh-task-<positive Issue number>`. The Client reads branch/HEAD; it never switches branches, commits or edits product files.

This initial docs-only template permits only:

- `docs/management/awh-repeatable-workflow.md`
- `docs/management/awh-v01-acceptance.md`

App metadata-only inspection checks the exact allowed installation selected-set. A single-repository read-only token verifies the ordinary Issue, current main baseline and changed paths before any write token or verification. The literal check is `git diff --check origin/main...HEAD`. Product changes, arbitrary prefixes/repositories/commands and machine drift fail closed. Existing product/bootstrap policies retain their required `pnpm lint`, `pnpm typecheck`, `pnpm test` commands; docs-only checks cannot substitute for product verification.

```powershell
Set-Location '<new-task-worktree>'
& '<existing-external-client-install>/node_modules/.bin/awh.cmd' --config '<existing-external-client.json>' deliver --issue 90 --title 'Document repeatable Windows delivery' --body '<utf8-pr-body-file>' --hold-draft
& '<existing-external-client-install>/node_modules/.bin/awh.cmd' --config '<existing-external-client.json>' status
& '<existing-external-client-install>/node_modules/.bin/awh.cmd' --config '<existing-external-client.json>' timeline
```

Each Run freezes repository, Issue, branch, SHA, Profile version, executor and machine in its Task fingerprint. Journal, Events, Builder evidence and confirmed Handoff retain it plus the new PR. `status` exposes current Task, prior Run and historical Run identifiers; `timeline --run <archived-run-id>` reads an archived Run in the same namespace. A consumed branch cannot be reused, even at another SHA.

## Review, completion and recovery

Delivery yields `awaiting_review`, including when held Draft. ChatGPT independently reviews the exact GitHub head; Human separately authorizes native merge and Issue close. A native GitHub User approval is a provider observation, not proof of a ChatGPT session: `authority_verified=false` remains explicit. Builder tests are not independent Review.

After those real facts exist, explicitly synchronize from the original clean delivery worktree:

```powershell
& '<existing-external-client-install>/node_modules/.bin/awh.cmd' --config '<existing-external-client.json>' sync
```

`sync` checks the App-owned PR, branch/repository/exact head, effective native User approval, absence of effective change requests, actual merge SHA and the same closed Issue. Dismissed, stale, bot or foreign-App facts cannot complete a Run. Only then is its Journal `completed`. Starting a different Issue archives the old Session bytes without moving/rewriting its Journal; all old CP Events and cursors stay intact.

For lost Event acknowledgments, `deliver --retry` resends only retained Event IDs/sequences and never repeats push/PR. A lost initial `RUN_STARTED` acknowledgment can resume the same Task before Journal/provider writes. Stopped, ambiguous, in-progress, pending or missing Journals block a new Task and require explicit reconciliation. Do not delete/rename Journals, clear sessions, change namespace or repeat provider operations to bypass the block.

Live #90 acceptance must preserve #88's completed Run/13 Events and the earlier six Runs/24 Events. Fixtures do not replace it. Its final `completed` claim requires independent Review, Human-authorized merge/close and original-worktree sync. This RC stops at unified ChatGPT Independent Review; no automatic closeout or next task follows.
