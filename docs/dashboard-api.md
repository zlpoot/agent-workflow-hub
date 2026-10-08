# Dashboard read API v1 — Hub #23

[OpenAPI 3.1](../contracts/dashboard-v1.openapi.json) is the machine-readable contract for #30. Control Plane/Protocol import no Future UI code or release; #30 can independently consume these REST/SSE shapes with frontend-only components pinned to a compatible version. #23 ships no Dashboard pages, onboarding/admin/pairing APIs, remote controls or delivery providers.

Every projection is `authority_verified=false`. GitHub remains authoritative for Issues, commits, PRs, independent native Review and Merge. Runtime `review_passed`, green checks and confirmed Handoff declarations cannot establish GitHub approval.

## Browser boundary and opt-in integration

Use a configurable logical same-origin `/dashboard/v1` endpoint, never a fixed machine IP or source-project path. Browser and Client auth are separate. CP Client/GitHub bearers, App keys/JWT, pairing secrets and trusted config values must never reach browser JS/storage/logs/JSON/SSE.

`createViewerAuthenticator` takes a closed trusted server-side `ViewerSession[]`: `id`, explicit `project_ids`, `session_sha256`, `expires_at`. It copies/freezes scopes and holds digests only. A trusted host/gateway provisions a random opaque session of at least 32 bytes with `Set-Cookie: awh_viewer=<opaque>; HttpOnly; SameSite=Strict; Path=/dashboard/v1` (plus `Secure` for a future HTTPS gateway). JS never receives its value. Session issuance/login/revocation management and distinct privileged operator write scope are deferred to #31; no issuance/admin route exists. Expiry is checked on requests and active streams; rebuilding the trusted authenticator is the host's explicit revocation boundary.

Opt in programmatically on the existing store:

```ts
const service = createControlPlaneServer({
  store: existingStore,
  authenticate: existingClientAuthenticator,
  dashboard: { authenticate: createViewerAuthenticator(trustedViewerSessions) },
});
```

Import the server from `src/control-plane/server.ts` and viewer authenticator from `src/dashboard/security.ts`. The supplied authenticator accepts only exact IPv4 loopback socket addresses/Host/port plus same-origin Origin/Fetch Metadata. Authorization headers, duplicate session cookies, wildcard scopes, cross-site fetch and rebinding Host fail. No CORS. It deliberately rejects LAN sockets; a future HTTPS/LAN gateway must explicitly preserve this independent viewer/same-origin/scope boundary, without requiring a third-party reverse proxy.

Gateway is default-disabled. This change adds no CLI startup/config/deployment mutation. The original live CP endpoint/SQLite/config/Windows/Mac credentials are untouched. #30 may mount the adapter over preserved real records after explicit integration/session provisioning. This PR does not claim live deployment or two-platform acceptance. Viewer sessions never authenticate existing `/v1` Client routes; all non-GET Dashboard methods reject before body parsing. They cannot mutate Project/Profile/credential/Run, execute commands or launch Codex.

## REST and facts

| GET path under `/dashboard/v1` | Query | Response |
| --- | --- | --- |
| `/snapshot` | none | consistent read-transaction cursor/Projects/Runs/Executors |
| `/projects` | limit/cursor/project_id | ProjectSummary page |
| `/projects/:id` | none | ProjectDetail (v1 same fields as summary) |
| `/runs` | limit/cursor/project_id/state/executor_id | RunSummary page |
| `/runs/:id` | none | RunDetail with diagnostics |
| `/runs/:id/timeline` | after/limit | global-cursor TimelineEvent page |
| `/executors` | limit/cursor/project_id | ExecutorSummary page |
| `/executors/:id` | none | ExecutorSummary detail |
| `/events/stream` | after OR Last-Event-ID; optional project_id/run_id | SSE |

Lists use ID-ascending live keyset order, default/max limit 100, no total count. Opaque REST cursors bind resource, sorted viewer scope and filters; they grant no authority. Unknown/repeated/empty parameters, unsupported states, malformed/reused cross-resource/scope/filter cursors fail. If a state filter changes so the cursor ID leaves the result set, 400 `invalid_cursor` requires restarting the list. Pages do not freeze Registry across requests; newly registered IDs before the last key appear on refresh. `snapshot_cursor` is the Event watermark, not a Registry/heartbeat revision. Each read transaction is consistent.

Project name/enabled are not stored and are null; last activity is the latest stored Run update. Multiple active Runs are arrays. Executor visibility requires an existing Run in a scoped project: old Registry has no persistent project/executor assignment, so unassigned Executors are omitted. Shared Executors expose only scoped current Runs regardless of Client owner; no owner/hash/session/config value is projected.

`last_seen` is actual server-recorded registration/heartbeat contact; existing DB cannot distinguish them, so `heartbeat_at=null` and provenance is `server_registration_or_heartbeat`. Online means contact at most 60s old; offline means older contact; invalid/future time is unknown. It does not prove process liveness. SSE heartbeat comments do not update Executor presence. Missing legacy type/machine name/arch is null. Presence includes server observed time and freshness threshold.

Run source is the exact stored SHA/ref. Verification subject SHA is separate and may identify a later candidate; it never replaces original source. Steps follow Event sequence, overlapping steps and terminal failure. Timeline has global cursor, per-Run sequence, project/run/executor/machine, timestamp/result and source SHA. Actor/unrecorded evidence is null; immutable Run executor attribution does not infer reviewer actor. Arbitrary extensions, reasons or URLs are never forwarded. Typed provider refs construct Issue/PR/commit URLs; comment/review identities have null URL where an owning PR cannot be inferred safely.

## Safe diagnostics

Comparisons contain `passed/blocked/not_checked`, observed/expected, provenance, action hint and false authority. Branch compares client source declaration with exact trusted Policy branch, not live Git. Checks compare the latest completed runtime verification against ordered trusted commands; a later verification start resets prior pass presentation. Policy version means a stored exact binding exists. Current Policy lacks per-Issue expected binding, so work item is `not_checked`. App/provider permissions stay `not_checked`, with null observations/expectations, until separately live-verified. #23 performs no new provider check. Hints request verification/approved Policy, never automatic switching/resetting active worktrees or bootstrap expansion.

## SSE boot, replay and refresh

1. Fetch REST snapshot at watermark W; first stream `after=W` observes commits after that transaction without a snapshot/stream race.
2. Persist last processed `timeline-event` cursor C. Its `id` is the global persistent SQLite cursor; gaps are normal and never renumbered. Dedupe by cursor.
3. On reconnect refresh REST current state, then stream after saved C to recover missed Timeline Events, **not** after refreshed W. First boot may start at W; `after=0` explicitly replays history. New/narrower sessions rebootstrap their scope. Conflicting header/query, malformed/negative/duplicate/future cursors fail before SSE headers.
4. `view-refresh` has no id: contract version/false authority/snapshot watermark only. It invalidates REST when Registry/heartbeat/presence/Run data changes. First connection emits a hint; hints are transient, not persisted/replayed, and never advance C. No synthetic Event is appended. Heartbeat comments every 15s only maintain transport.

History remains append-only/retained, no compaction/reset. Idempotent retries keep their original cursor and create no second Event. Both viewer and stream filters apply on every poll. Explicit foreign Project filter gives 403; foreign Run/Executor gives 404 to avoid disclosure. Expiry disconnects. Network frames may replay when sent but not processed, so consumers must dedupe. A cursor is not a grant.

Streams share the existing 64-connection limit, poll at most 100 Events per batch, pause on backpressure and disconnect beyond 128 KiB buffered or 15s stalled drain. After headers, errors/expiry close without exception/secret text. Reconnect only after successful REST/auth validation; no automatic product delivery retry.

## Bounds and verification

Synchronous SQLite view caps: 64 projects, 1000 Runs/Work Items/Executors, 256 Policy versions, 10000 Events. Exceeding a cap returns 503 `projection_limit` rather than truncating history. Reads do not migrate/rewrite original data. #30 shares SSE views per exact scope, detects own/external Registry commits with lightweight revisions, and bounds idle probes/presence refresh; cold refresh still scales with scoped retained history. P2 load evidence, full-history browser recovery, default-off sidecar and separate live/session gates are described in [Dashboard UI](dashboard-ui.md). Larger deployments need a separately designed query/index strategy.

Errors: 400 query/cursor/id, 401 missing/expired viewer session, 403 explicit foreign scope, 404 absent/foreign entity or disabled gateway, 405 mutation, 503 busy/projection/stream limit, generic 500 otherwise. OpenAPI includes negative auth/scope/cursor examples.

`tests/dashboard.test.mjs` validates DTOs against OpenAPI and covers Mac WebSkill/Windows Future UI fixtures, preserved SQLite Registry/owners/Run/Event/last-seen across restart, cross-Client read scopes, omitted secret/extensions, runtime authority, pagination/filters, same-origin/Host/expiry, mutation denial, snapshot/SSE replay and idempotency. Fixtures are not live acceptance and never inspect product worktrees. Existing CP/Client/TLS/Builder/Protocol/C0 tests remain in exact clean-head `pnpm check`.

Delivery remains an App-authored Draft PR with exact-head Builder evidence and pending→readback→confirmed Handoff, stopping for independent Review. Human explicitly approved fixed `hub/c1e`: repository `zlpoot/agent-workflow-hub`, base `main`, branch `codex/c1e-dashboard-api-contract`, work item Hub #23, verification `pnpm check`. This preserves App/exact-selected-set/single-repository/transport/exact-head Handoff gates; no #22/c1d or bootstrap authorization reuse. No Ready mutation, Review/Merge decision, Issue close, host migration or next task is implied.
