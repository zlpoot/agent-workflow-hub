# Control Plane

The CP stores trusted Profiles, Projects, Executors, Work Items, Runs and append-only Events in SQLite. GitHub remains the source of code, PR, Review and merge facts. CP declarations cannot approve Provider actions.

## New database and startup

Use Node.js 24+ and an administrator-protected external deployment directory. Provision a runtime JSON with schema_version=1.0, database, trusted_config_file, port and optional https_config_file. Provision dedicated Client credential hashes and approved Profile policies in the separate trusted file.

```powershell
pnpm control-plane init --runtime-config '<new external runtime.json>'
pnpm control-plane serve --runtime-config '<same external runtime.json>'
```

Init exclusively creates a new empty file and exits without a listener. Failure retains its artifact for inspection. Serve requires an existing current v2 schema, exact schema definitions, immutable Profile versions and consistent Project identities. It never initializes, migrates or adds Profile versions. Unsupported databases fail closed. Test new versions in a separate fresh directory; preserve existing installations until an explicitly approved cutover.

HTTP binds only 127.0.0.1. Optional native HTTPS uses a separately configured private IPv4, current leaf IP SAN, matching key and TLS 1.2 or later. Paths are bounded regular external files without redirected ancestors. Listener startup failure closes all listeners and the store.

## Runtime API and invariants

The existing /v1 API provides scoped Project/Executor registration and reads, heartbeat, immutable Work Item registration, Run creation, Run/Event reads, append and SSE. Enrollment has separate dedicated grants and cannot write business Work Items, Runs or Events. The authenticated capabilities read declares current revision linking support without mutating the database.

Transactions use BEGIN IMMEDIATE, foreign keys, STRICT tables, full synchronization and append-only/identity triggers. Run creation checks Profile/Project/Work Item/Executor/Machine/source bindings. Event append writes the Event and derived Run state atomically. Sequence gaps, conflicting IDs, illegal states, timestamps and failed verification claims are rejected. Canonical identical retries are idempotent. Restart and durable SSE cursors recover committed history.

Read-only Dashboard snapshots use bounded scope projections and consistent SQLite reads; browser and Client credentials are separate. No API grants Review, merge or unrestricted execution. See [Protocol](protocol.md) and [Dashboard contract](dashboard-api.md).
