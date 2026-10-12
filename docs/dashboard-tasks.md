# Task visibility v1

The existing Dashboard now has Overview task counts, Tasks filters (project, state, active/waiting role and machine), project-to-task entry points and task details. It continues to serve Projects, Executors, Runs, Timeline and Enrollment. Task states are derived display values; Protocol Run states and CP events are unchanged.

`src/dashboard/tasks.ts` is the shared DTO/projection boundary. CP registered Work Items appear even without Runs. CP runtime completion and Review declarations remain declarations. A separate `REVIEW_STARTED` event plus live reviewer presence can identify active review; a waiting Review Gate cannot. Running Coding/Stage actors require start/presence or observed process evidence. Machine/executor labels from explicit Local Fast config are configured identities, not independent proof of agent type.

## Explicit local Viewer configuration

Keep the existing external Viewer JSON and add only the adapters needed. No adapter scans other directories, discovers arbitrary GitHub Issues, imports Local Fast tasks into CP, changes state/locks, starts executors, or merges PRs. Browser configuration and tokens are not accepted.

```json
{
  "local_fast_observations": [
    {
      "project_id": "approved-local-project",
      "repository": "owner/repository",
      "root": "E:/approved/repository",
      "watcher_directory": "C:/Users/OWNER/AppData/Local/AWH/local-fast/REPOSITORY_ID",
      "machine": { "id": "machine-1", "name": "Owner workstation", "platform": "windows" },
      "executor_name": "Coding Executor"
    }
  ],
  "github_observations": [
    {
      "project_id": "approved-cp-project",
      "repository": "owner/other-repository",
      "root": "E:/approved/other-repository"
    }
  ]
}
```

These are optional fields of the existing `schema_version: "1.0"` Viewer config, alongside database/port/viewer/local_bindings. Every `project_id` must be in `viewer.project_ids`. The repository root must exist with the configured origin. `watcher_directory` is optional, explicitly named, outside Git and unredirected. It reads only scope.json, watcher.json and watcher.lock. Configured observation-only projects appear in the UI with their Local Fast provenance; this does not register them in CP. `github_observations` verifies only CP-managed tasks from the configured project/repository. Without this opt-in, CP tasks retain GitHub `not_checked`.

The server uses the installed `gh` CLI for **GET-only** reads through its existing login (no token export). This is observation and confers no GitHub write/Strict Builder authority. GH_TOKEN/GITHUB_TOKEN/AWH overrides are stripped from children. Local Fast's repository ID is checked against native repository metadata. Reads cover Issue, PR, exact HEAD, fully paginated native Reviews, check runs/status and PR HEAD readback. Failures produce UNKNOWN/permission_denied instead of reusing old PASS. Structured author COMMENTED PASS is accepted only for Local Fast; standard workflows require independent native APPROVED/CHANGES_REQUESTED. Completed requires native Merge plus Issue CLOSED. Empty reported checks are displayed as zero, without inventing CI.

Local observation files and Stage check logs are bounded and read-only, and redirected file ancestors are refused. Browser DTOs contain no local root, scope path, executable, raw stdout/stderr, tokens or authorization file content. Stage checks expose safe command labels and exit results at the recorded HEAD. Some original Local Fast phase/Watcher records have no timestamps: history marks their occurrence time unknown and separately provides observation time. Record-file modification time is supplementary history, not proof of a process starting.

CP SSE remains CP-only. Task observations refresh through REST every 15 seconds; cached native reads have a 15 second lifetime. UI observations older than 45 seconds, disconnected sessions and failed detail refreshes show current state unknown and suppress claims of active execution. Cache failure replaces facts; it never returns stale cached PASS as fresh. Direct URLs are assembled from typed repository/number/SHA, and API mutations remain rejected.

## Read API

- `GET /dashboard/v1/snapshot` adds optional `tasks` (closed Task DTO schema).
- `GET /dashboard/v1/tasks?project_id=...&state=...&role=...&machine_id=...&limit=100&offset=0` returns a scoped page. `next_offset` means another page is available. Role matches active actor or waiting party.
- `GET /dashboard/v1/tasks/{id}` returns a freshly observed/cached task detail and rejects unknown/out-of-scope identities.

The OpenAPI schemas generate browser validators; extra nested fields or incompatible responses fail closed. CP and Local Fast stay separate task identities, even if both happen to refer to the same Issue.

## Focused verification

```powershell
pnpm typecheck
pnpm build
node --test tests/dashboard-tasks.test.mjs tests/dashboard.test.mjs tests/dashboard-ui.test.mjs tests/dashboard-gateway.test.mjs
$env:AWH_DASHBOARD_TEST_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node scripts/dashboard-smoke.mjs
node scripts/dashboard-task-smoke.mjs
```

Fixtures run only on a separate synthetic in-memory host, with dataset and per-task labels. They cover developing, Stage, waiting Review, REQUEST_CHANGES, pending checks, authorized merge waiting, merged/closed, denied permissions, HEAD drift, stopped Watcher, blocked and other display states. For the already completed #79 queue, configure an isolated external Viewer with a fresh empty CP registry and **only** `zlpoot/awh-local-fast-e2e`; then run `node scripts/dashboard-task-smoke.mjs --real http://127.0.0.1:PORT/dashboard`. This checks the two exact real HEADs/native Reviews/Merges, desktop and 390px layout, keyboard, empty filter results, offline recovery and hashes of original Local Fast state/scope/Watcher files. Do not rerun that queue. Smoke screenshots/results stay in gitignored `.handoff/`.

Cross-host aggregation, remote process attestation, automatic Reviewer launch, browser Review/merge writes and reconstruction of missing historical phase timestamps are outside v1. Native merge-in-progress cannot be claimed without a start observation; the DTO includes that state for future adapters. The browser can inspect/copy a standard independent Review instruction but does not execute it. Delivery stops at independent Review.
