# C1-D fixed Builder delivery

Installed Client 0.2.0 exposes `awh deliver` using the preserved GitHub App Builder and checked-in policies. No Hub source checkout is required by a consumer. CP observes runtime with `authority_verified=false`; GitHub remains the development source of truth. Existing Builder commands and C0 validator stay compatible.

Supported Manifest refs: `hub/c1d`, `webskill/bootstrap`, `future-ui/bootstrap`, and the existing C1-C `webskill/default` / `future-ui/default` refs. The latter retain their identity and map to the same exact checked-in bootstrap policy, without editing Manifest or changing endpoint. All bind the fixed repository, main base, feature branch, work item, command order and bootstrap paths. CP must independently provide one exact trusted Profile version matching those values. Its command strings are comparison data, not execution authorization. Hub/c1d binds Hub #22, `codex/c1d-builder-adapter`, `pnpm check`. No arbitrary repository/base/branch/URL/API/shell/Git/gh passthrough is exposed.

Use the existing external CP config/credential and repository-external App credential. Register project/executor and prepare a clean committed candidate on the fixed branch. The minimal Manifest must already be committed or ignored under authorized project setup; `.handoff/` must be ignored. Client never switches branches, commits, resets, cleans or edits product files.

```text
awh --config <external-client.json> register
awh --config <external-client.json> deliver --title <title> --body <utf8-pr-body-file> --hold-draft
awh --config <external-client.json> status
awh --config <external-client.json> deliver --retry
```

`--hold-draft` publishes evidence and confirmed Handoff while preserving Draft for pending acceptance. Without it, the existing Ready gate runs and the Builder waits for independent Review. Actual project acceptance and Human gates remain prerequisites for the caller. CP projections and fixtures cannot replace them.

Verification executes only literal checked-in commands: Hub `pnpm check`; WebSkill `pnpm check:foundations`, `pnpm lint`, `pnpm typecheck`; Future UI `pnpm lint`, `pnpm typecheck`, `pnpm test`. Product execution requires actual Human authorization and correct fixed scope. Verification strips App/Client/GitHub environment variables, bounds time/output and rejects credential-bearing output before persistence. Other Client commands still treat policy commands as declarations.

## Mapping within unchanged C1-A 1.0

| Actual operation | Event |
| --- | --- |
| App preflight | STEP_STARTED / STEP_COMPLETED |
| Exact clean-head verification | VERIFICATION_STARTED / PASSED / FAILED with original SHA/exit codes |
| Successful original push | GITHUB_PUSH_COMPLETED with original commit/ref |
| Successful Draft PR creation | GITHUB_PR_CREATED with original PR/base/head |
| Evidence and pending Handoff readback | HANDOFF_PUBLISHED pending, evidence comment refs in extensions |
| Same comment confirmed and read back | HANDOFF_PUBLISHED confirmed |
| Ready readback or explicit hold Draft | HANDOFF_PUBLISHED confirmed plus documented waiting milestone |
| Builder failure | RUN_FAILED with fixed reason/stage; preflight also completes its Step nonzero |

No new event vocabulary/projection is added. Evidence/Ready/waiting milestones use `builder_milestone` extensions on the same confirmed Handoff reference; they do not assert independent Review or Run completion. Builder cannot emit REVIEW_STARTED/PASSED/RUN_COMPLETED. Events never copy evidence bodies. No watcher is added.

Bootstrap Work Items preserve their original Hub #8/#6 references while Run source/PR/commit stays in the product repository. C1-A already supports this topology. Ordinary `start --issue` still uses the project repository; only fixed delivery creates the Builder cross-repository Work Item.

## Durability and failure

Existing endpoint/project/executor namespaces and exclusive session lock remain. Delivery adds an optional local `outbox`; legacy sessions without it still load. Acknowledged, pending and queued Events share the 256 limit. Each Event is validated and atomically saved with stable ID/sequence/timestamp/payload before a bounded request. ACK must match exact Event and expected Run; committed-but-lost/malformed ACK remains pending. Explicit retry drains in order with CP idempotency and never repeats GitHub writes. `status` reports outstanding Events.

An external per-Run `.delivery.json` journal saves the stage before an operation and safe provider refs afterward. Duplicate active delivery is refused. Before terminal Run archival, fixed delivery checks all retained journals in the existing namespace under the session lock. A terminal or previously archived delivery journal causes `delivery_reconciliation`, including after Event retry or a change of HEAD. No Run, Journal or Handoff is replaced by this rejection. Ordinary C1-C `start` keeps its existing archival behavior, but an archived delivery journal still blocks subsequent fixed delivery.

Crash/stale-lock/uncertain side effects require explicit provider reconciliation and Human approval of a fresh candidate, preserving journal/history. There is no automatic reconciliation or approval command in this release; terminal runtime state is not proof that provider writes were reconciled. Retry cannot recreate PRs/comments, rerun push/Ready or resume operations. Do not delete journals or change namespaces/endpoints to bypass this gate.

If the initial `RUN_STARTED` ACK is lost, no delivery journal or GitHub operation exists yet. `deliver --retry` reports `delivery_state` in that state. Repeat the original fixed `deliver` invocation to resend the same persisted `RUN_STARTED` idempotently and continue the same Run. Once a journal exists, use `deliver --retry` only to drain Events; it never resumes Builder operations.

CP loss stops subsequent GitHub operations. Original sanitized Builder errors/categories/stages remain authoritative even when failure emission also fails. Failure Events stay durable for explicit retry. Failed verification retains original nonzero checks/logs and emits VERIFICATION_FAILED without another fabricated terminal Event. If observation fails after Ready, Adapter attempts exact-head Draft restoration/readback; unconfirmed restoration is explicit and never reported as successful delivery.

Raw logs live in ignored `.handoff/<run-id>/`, then bounded App comments on the same PR with environment, before/after SHA, clean status, command order, exit codes, elapsed time and available test statistics. Large logs split into ordered evidence comments, all referenced by Handoff. Pending/confirmed JSON and C0 results are also saved locally. All provider writes/readbacks use the existing single-target App Builder closure.

## Actual acceptance

Package 0.2.0 bundles runtime dependencies and fixed Builder/policy, without source/tests/credentials/CP server/Builder CLI. Compatibility uses the preserved #21 CP SQLite DB and original loopback/verified LAN HTTPS endpoints, retaining credentials, machine UUID, session namespaces and history. Endpoint rebind/source-host migration are outside this feature.

Actual provenance records package SHA-256/version, platform/arch, root/origin/branch/HEAD/status before/after, selected-set/single-repository App preflight, CP Run/Event IDs and original GitHub refs. Mac WebSkill is first, Windows Future UI second. Fixtures, old 0.1.0 acceptance and configuration declarations are not 0.2.0 delivery PASS.

Human reports both products currently have active development tasks. This implementation keeps their worktrees untouched and delivers Hub as Draft; actual product delivery acceptance stays pending. Final exact clean-head `pnpm check`, failure history and confirmed v0.1 Handoff use App comments. Missing acceptance keeps Draft; independent Review and Ready remain pending.
