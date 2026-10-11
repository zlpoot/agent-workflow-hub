# Dashboard API

All browser projections declare authority_verified=false. GitHub remains the source for native Review, PR HEAD and merge facts. The read API is scoped by an independent Viewer session, never a Client/GitHub bearer.

GET /dashboard/v1/snapshot reads a consistent Projects/Executors/Runs snapshot. projects, executors and runs provide bounded keyset pages and individual details. runs/:id/timeline provides global-cursor Events. events/stream provides scoped SSE. Unknown or repeated query fields, foreign scope, invalid cursors and mutation attempts fail closed. Typed provider references reconstruct links without forwarding arbitrary URLs, extensions, evidence bodies or secrets.

The first snapshot supplies a persistent Event watermark. Timeline replay and cursor deduplication preserve gaps and order. A view-refresh hint invalidates snapshots when Registry, heartbeat or presence changes without advancing the persistent Event cursor or creating an Event. Expiry, backpressure and bounded connection limits disconnect safely. See contracts/dashboard-v1.openapi.json and tests/dashboard.test.mjs for closed DTOs and behavioral checks.

The loopback gateway requires exact Host/Origin/Fetch Metadata, scoped HttpOnly SameSite=Strict cookies and empty browser credential storage. It denies Authorization headers, cross-site requests and rebinding. Static assets and Viewer reads do not expose filesystem or SQLite operations to the browser.

Enrollment uses separate bounded POST /dashboard/enrollment/v1 actions: browse, inspect, policies, request, connect, bindings, doctor, plan and repair. An optional owner approval helper requires its external pinned administrator configuration and explicit native confirmation. No request grants itself a Profile, token, task execution or delivery permission. Without machine settings the feature reports unavailable. The retained /dashboard/onboarding/v1 routes only inspect explicitly configured local bindings and installed Doctor data; they do not provide the removed offline pairing prototype.

The gateway and integration are opt-in. Production session provisioning, network deployment and independent Review require separate deployment authorization. Tests use synthetic isolated state only.
