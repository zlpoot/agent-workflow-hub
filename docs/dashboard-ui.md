# C1-G read-only Dashboard

Issue [#30](https://github.com/zlpoot/agent-workflow-hub/issues/30), [kickoff](https://github.com/zlpoot/agent-workflow-hub/issues/30#issuecomment-6053320500), and [P2 idle gate](https://github.com/zlpoot/agent-workflow-hub/issues/30#issuecomment-6053110396) govern this implementation. Baseline is merged #23 main `04f7b4373de6238e44e2a43c92c5d9726af0090d`. Original Windows CP, SQLite, trusted config, project identities, Mac/Windows clients and product worktrees are preserved.

## Frontend and semantic boundary

The independent `dashboard/` browser entry uses pinned React/React DOM 19.3.0 and [Radix Themes 3.3.0](https://www.radix-ui.com/themes/docs/overview/getting-started), with accessible Tabs, Select, Table, TextField and Dialog implementations. Dependencies live in the Hub's existing single pnpm package as build/test dependencies; they do not enter the independently packed Client or CP runtime. Browser artifacts are separate `dist/dashboard-ui/` files. `pnpm check` includes frontend TypeScript, deterministic browser build and targeted Node tests; browser smoke and load measurement are explicit separate checks. No new Actions/workflow mutation is required.

Future UI is an existing-library semantic/adapter/Profile layer, not a released independent component library. Its [current direction](https://github.com/zlpoot/future-ui/blob/main/README.md) does not promise an available third-party adapter release. `dashboard/semantics.json` records the actual pinned component mapping, visible states, close behavior, token choices and limitations. It is a local integration seam, not a claimed upstream adapter or conformance PASS. No Future UI R1 branch, API, dependency or lockfile is modified.

Overview exposes counts with Registry/Event provenance and refresh watermark. Projects show repository/Profile, unknown name/enabled, last activity and active Runs. Executors show recorded machine identity/platform/type/contact and truthful online/offline/unknown presence. Runs expose work item, source SHA/ref, state, executor/machine, steps, local search and Project/state filters. Details show #23 safe diagnostics without promoting a runtime pass to provider authority. Timeline is ascending by persistent global cursor; clocks can be out of chronological order. Unknown actor/evidence remains unknown. Typed Issue/PR/source identities reconstruct safe GitHub links, ignoring untrusted URL fields.

Loading/empty/error/connecting/partial/offline/outdated states are distinct. A failed refresh retains the last good snapshot and its refresh timestamp. Executor presence becomes unknown while the snapshot is offline/outdated. Connected appears only after SSE actually opens. Detail close remains visible and Escape/keyboard navigation are supported. No mutation, pairing, admin, credential/Profile edit, Codex launch, deliver, Review or merge action exists.

The default interface is Simplified Chinese (`zh-CN`), including navigation, statuses, search/filter labels, details, policy diagnostics, timestamps and safe error messages. Chinese status/event search matches translated presentation labels; protocol states, identifiers, source references, commands and recorded facts remain unchanged. Unknown diagnostics fall back to their recorded value, while unknown errors use a fixed safe Chinese message. The browser smoke also checks the Chinese document/title and searches by Chinese status.

## Browser contract and recovery

Only fixed same-origin GET `/dashboard/v1` endpoints are reachable from the adapter. Fetch uses same-origin cookies, no-store and redirect:error; EventSource uses the fixed same-origin stream. No bearer/config/URL/API passthrough, filesystem/SQLite or server imports, browser storage, cookie reads, third-party resources, telemetry or evidence bodies are present. Contract validators are generated at build time from `contracts/dashboard-v1.openapi.json`; browser runtime needs no eval. Incompatible or secret-shaped extra fields fail closed; error bodies/exception input are not reflected into UI.

Bootstrap captures snapshot watermark W, pages every scoped Run's persisted Timeline, and retains only cursors <= W before opening SSE after W. Subsequent Events merge by global cursor, preserving legitimate gaps and detecting conflicting replay. Hints invalidate REST without advancing a persistent cursor. Refresh keeps a healthy stream and buffers Events beyond the newly captured W; a single transient initial hint cannot create a reconnect/refresh loop. On disconnect, a new consistent snapshot plus complete bounded history backfills missed Events through its W before reconnecting after W. This is the full-history recovery alternative to replaying from saved C; it never skips the missing history by switching to a newer W alone. Cursor/history are retained in memory for the viewer session and rebootstrap on page reload; no sensitive browser storage is introduced. Stop aborts outstanding requests and suppresses stale callbacks. 401/403/default-off 404 require explicit intervention rather than automatic authentication retry.

## P2 idle SSE gate

`DashboardStreamCache` is store-local, keyed by sorted exact Project scope, bounded to 64 entries with inactive expiry. Changed data is read once per active scope, shared across viewers; scopes cannot share Registry or Event content accidentally. SQLite `data_version` detects other connections' commits; an in-process transaction revision detects the CP's own commits, including cursor-constant registration/heartbeat. A global cursor probe also guards replay watermark. Initial connection forces a fresh revision probe so a just-fetched snapshot cursor cannot be rejected by a stale cache. Idle polling performs at most four cheap probes/second across connections. Presence/fingerprint recomputation is bounded to once per second per scope, and cached event lookup uses binary cursor search plus indexed Run history. Event, Registry and time-based presence changes still invalidate the view. No synthetic persistent Event or schema migration is added.

The existing 64-stream cap, scope/filter validation, expiry check each poll, 100-event batches, 15s transport heartbeat, 128KiB buffer limit and 15s drain timeout remain. REST DTOs and OpenAPI 1.0 shapes are unchanged; normal reads are consistent SQLite transactions. Cold refresh cost is still bounded by #23's caps, not a scalability claim for larger deployments. A scope exceeding 1000 Runs/10000 Events fails with 503 rather than truncating history.

`pnpm dashboard:load` compares the exact merged #23 projection serializer and two original 64-viewer poll batches against the shared cache, then opens 64 real HTTP SSE streams, measures a 1.1s idle window, writes five CP HTTP heartbeats and appends a legal persisted Event over HTTP. Small (2 Runs/4 Events) and near-cap (1000/9999, reaching the 10000-Event cap with that append) data are entirely synthetic in temporary SQLite files. Poll comparison includes explicitly measured heartbeat-triggered refreshes; strictly idle actual connections must perform zero full projection reads, <=5 cheap probes/window, and heartbeat/append HTTP max latency <1s. Evidence includes CPU, wall time, delayed callbacks and write latency. CPU resolution on Windows can report zero for very short intervals; timings characterize this host/run only. The baseline Git object must be locally available.

## Hosting and live-data gate

`createDashboardGateway()` is default OFF. Opt-in requires an explicit DashboardStore, viewer authenticator and closed built-asset directory. `DashboardReadStore` opens an existing **v2** SQLite database with `readOnly:true`, performs no migrations/policy seeds/history/config writes, and exposes no writer methods. It can act as a separate sidecar without restarting, rebinding or modifying the original CP. No existing listener/CLI deployment behavior changes.

Every static asset and API is protected by separate viewer authentication plus exact IPv4 loopback socket/Host/port, same-origin Origin/Fetch Metadata, Authorization rejection, no CORS and closed asset paths. No arbitrary proxy, LAN/DNS alias, file serving or public credential/session endpoint is present. CSP permits only self scripts/connections; inline styles are required by Radix's style properties, not scripts. Responses use no-store, nosniff, no-referrer, same-origin CORP/COOP, frame-ancestors:none and restricted permissions. A trusted host must separately provision random opaque HttpOnly/SameSite=Strict viewer cookies with Path=/dashboard (API-only #23 sessions have Path=/dashboard/v1 and cannot load these assets). A future HTTPS host must additionally use Secure cookies and a reviewed HTTPS-origin authenticator; the supplied boundary deliberately accepts only exact loopback HTTP. No LAN or Mac browser hosting is claimed.

**P2 fixture PASS does not enable the live viewer.** Real original Windows CP inspection/hosting, session provisioning, address/HTTPS deployment and Phase C Windows/Mac historical-data observation require their separate Human/security gates. The implementation ships no automatic issuer and does not read CP credential/trusted configuration. No real CP DB is opened by fixture/smoke/load scripts. This preserves the existing CP and avoids a second writable or shadow history.

## Reproduce locally

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dashboard:fixture
```

The last command accepts no arguments, creates only an in-memory synthetic store, binds an ephemeral 127.0.0.1 port, prints a fixture URL, provisions an HttpOnly fixture-only cookie and expires after one hour. It never accepts a real DB, CP URL/config or provider credential. The synthetic-data banner is always visible. Stop this preview with Ctrl+C. This is a local development fixture host, not the live gateway/session provisioner.

```sh
node --test tests/dashboard.test.mjs tests/dashboard-ui.test.mjs tests/dashboard-gateway.test.mjs
pnpm exec playwright install chromium
pnpm dashboard:smoke
pnpm dashboard:load
```

Smoke launches its own fixture process and headless Chromium, verifies all five views/search/Run diagnostics/keyboard/visible-close/Escape/offline/reconnect/mobile, inspects same-origin GET-only network requests, HttpOnly cookie flags and empty DOM/browser storage, and saves screenshots plus redacted observations in gitignored `.handoff/dashboard-smoke/`. An existing Chromium can be selected with the test-only `AWH_DASHBOARD_TEST_BROWSER` executable path; evidence reports actual browser version. Load evidence is in `.handoff/dashboard-load/`. Neither check touches a product worktree or original CP. Final exact clean-head `pnpm check` is Builder verification, followed by App Evidence and confirmed Handoff only after Human authorizes fixed hub/c1g delivery. Keep the PR Draft for independent Review; no approve/merge/Issue closure/next task follows automatically.
