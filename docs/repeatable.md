# Windows repeatable delivery MVP

Current main includes the v0.2 repeatable workflow and Client 0.4.4. Hub #42 is merged, #41 is closed, and Future UI #90/#92 has completed its real delivery chain. The immutable template remains `v02-repeatable-v1` under `future-ui/c1c-acceptance`. Later revision/recovery capabilities are described in [publication recovery](publication-recovery.md).

All delivery writes use the fixed App Builder. Existing CP, Client, state, identity and endpoint are preserved. Setup, production installation, seeding and a new delivery require explicit authorization; the historical acceptance is not a standing command. [Deployment configuration](../config/README.md) explains the policy/config boundary.

Historical / Legacy: commands below illustrate the original #41/#90 workflow. Client 0.4.1 references describe that version; for a current separately authorized install use the reviewed 0.4.4 artifact. Do not rerun old seed/delivery/recovery operations merely because they appear here.

## One-time setup

Use Node 24+ and the provided tarball. Preserve the existing external Client config, dedicated credential, state directory, endpoint, machine identity, Project and Executor. Do not initialize another Project or namespace.

```powershell
npm install --prefix '<existing-external-client-install>' --offline --ignore-scripts --no-audit --no-fund '<zlpoot-awh-client-0.4.1.tgz>'
& '<existing-external-client-install>/node_modules/.bin/awh.cmd' --version
```

The new template uses `branch.mode=issue_prefix`, prefix `codex/awh-task-`, and the existing `c1c-future-ui-windows` executor with one existing Windows machine restriction. Old `mode=fixed` policies retain their behavior. CP v2 database tables/schema and old Run/Event records are unchanged. This additive Protocol declaration requires compatible runtime validation. If the running CP validator rejects it, stop at the Hub RC review/deployment dependency. Do not implicitly restart, replace, migrate or seed the original CP. Client 0.4.1 recovery needs no further CP/schema/Profile change when the reviewed compatible runtime is already running.

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

Each Run freezes repository, Issue, branch, SHA, Profile version, executor and machine in its Task fingerprint. Journal, Events, Builder evidence and confirmed Handoff retain it plus the new PR. `status` exposes current Task, prior Run and historical Run identifiers; `timeline --run <archived-run-id>` reads an archived Run in the same namespace. A consumed branch cannot be reused through ordinary delivery; the explicit one-shot pre-provider verification recovery below is the sole exception.

## Review, completion and recovery

Delivery yields `awaiting_review`, including when held Draft. ChatGPT independently reviews the exact GitHub head; Human separately authorizes native merge and Issue close. A native GitHub User approval is a provider observation, not proof of a ChatGPT session: `authority_verified=false` remains explicit. Builder tests are not independent Review.

After those real facts exist, explicitly synchronize from the original clean delivery worktree:

```powershell
& '<existing-external-client-install>/node_modules/.bin/awh.cmd' --config '<existing-external-client.json>' sync
```

`sync` checks the App-owned PR, branch/repository/exact head, effective native User approval, absence of effective change requests, actual merge SHA and the same closed Issue. Dismissed, stale, bot or foreign-App facts cannot complete a Run. Only then is its Journal `completed`. Starting a different Issue archives the old Session bytes without moving/rewriting its Journal; all old CP Events and cursors stay intact.

For lost Event acknowledgments, `deliver --retry` resends only retained Event IDs/sequences and never repeats push/PR. A lost initial `RUN_STARTED` acknowledgment can resume the same Task before Journal/provider writes. Stopped, ambiguous, in-progress, pending or missing Journals block a new Task and require explicit reconciliation. Do not delete/rename Journals, clear sessions, change namespace or repeat provider operations to bypass the block.

Live #90 acceptance must preserve #88's completed Run/13 Events and the earlier six Runs/24 Events. Fixtures do not replace it. Its final `completed` claim requires independent Review, Human-authorized merge/close and original-worktree sync. This RC stops at unified ChatGPT Independent Review; no automatic closeout or next task follows.

## Client 0.4.1 verification recovery candidate

[PR #42 recovery design](https://github.com/zlpoot/agent-workflow-hub/pull/42#issuecomment-6061749616) authorizes implementation and isolated testing only. The new patch requires independent exact-head Review and a separate Human decision before any real recovery or Future UI provider write. Keep the deployed reviewed CP/Client and real stopped Journal intact while reviewing this candidate.

After those gates, upgrade the Client patch once in its original installation and register the new version through the original identity. No new CP, namespace, Profile or credentials are needed. From the same canonical Issue branch, commit a different clean docs-only source HEAD, retain the original `.handoff/<failed-run-id>/verification.json`, then explicitly name its predecessor:

```powershell
& '<existing-external-client-install>/node_modules/.bin/awh.cmd' --config '<existing-external-client.json>' deliver --issue 90 --recover-from-run '<failed-run-id>' --title '<title>' --body '<utf8-pr-body-file>' --hold-draft
```

The current predecessor must have no pending Event/outbox, a CP-confirmed failed replay identical to local history, and an unchanged stopped Journal with empty provider refs. Only a known preflight failure or the exact five-Event verification-failure sequence qualifies; verification evidence must match both original SHA and CP-recorded checks. Repository, Issue, canonical branch, Profile, Executor, machine and namespace stay bound. The patch refuses any post-push, unknown, ambiguous, missing or mismatched history.

Before consuming the attempt, App metadata-only selected-set inspection and a single-repository **read-only** token check the ordinary open Issue, main baseline, docs-only paths, absent canonical remote ref and absence of any same-branch PR in all states. Failure or uncertainty leaves the original Session intact and creates no attempt/Run/provider write. Normal Builder delivery still enforces its existing verification, ref checks and single-repository write scope afterward.

The Client writes `<failed-run-id>.recovery.json` once with exclusive creation in the original state namespace. It binds predecessor/new source and fingerprints, original Session/Journal/evidence hashes, CP Event digest, read-only inspection and a preallocated successor Run ID. It then archives the old Session **as original bytes**, creates the new Session/Run/Journal and links all new Events, Builder evidence and Handoff to the failed predecessor. Old Run/Event/cursor rows and the stopped Journal remain unchanged. A receipt grants only its fixed successor; it does not turn any failed Journal into completed. After the successor completes, its predecessor remains readable through archived timeline and the receipt permits normal later Issues.

Duplicate recovery, receipt reuse, identity/HEAD drift and an incomplete receipt/session transition fail closed. A crash after receipt consumption can require further explicit reconciliation; the Client never allocates a second successor to work around it. If only the successor creation/initial Event acknowledgment was lost, the existing initial-Run resume path uses its same recorded ID and exact source; it never starts another recovery or repeats provider writes. `deliver --retry` remains Event-only and cannot rerun verification. Preserve all attempt files and failure logs; never delete/rename Journal/Session or change namespace to continue.
