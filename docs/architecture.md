# Modules and dependency boundaries

| Module | Role and authority |
| --- | --- |
| protocol | Closed structural entities, identity bindings, Run/Event state machine, replay and Handoff conversion; declarations grant no Provider rights |
| shared | External-file, data/credential guards, enrollment and pure policy comparison |
| control-plane | Canonical empty initialization, strict current SQLite schema, scoped authentication, atomic Run/Event persistence, SSE and bounded read models |
| client | Manifest/origin identity, dedicated CP configuration, Enrollment, Resident, Doctor, event outboxes, durable delivery/revision/recovery Journals |
| profiles | Minimal administrator-pinned external Builder authority; no shipped repository/Issue/machine defaults |
| builder | App JWT and live Installation preflight, complete selected-set inspection, single-repository scoped Provider/Git operations, exact-head evidence/Handoff and read-only lifecycle |
| dashboard | Loopback/browser security, separate Viewer sessions, read projection/cache, current Enrollment and opt-in local owner approval |
| dashboard UI | React/Radix browser reader and Enrollment UI; generated contract validators; no server modules, secrets or Builder imports in browser bundle |

The sole CP entry is control-plane-cli.js with init/serve --runtime-config, plus bounded local approve-project. The sole Viewer entry is dashboard-cli.js with optional --owner-config. Client CLI and Builder CLI remain separate authority surfaces. The read-only Handoff validator checks declaration shape and accurate expected SHA; it cannot approve or merge.

Build cleans only its resolved local dist directory. Standalone Client/Viewer packages copy current runtime closure and bundled dependencies; no test/fixture/config/history data or obsolete seed/sidecar modules ship. UI ZIP contains static assets and validators only. No package is a release/deployment authorization.

CP and Builder exact policy comparison preserves approved repository/base/branch/checks/identity; administrator-protected external sources remain distinct from ordinary project declarations and Enrollment. GitHub native Review/merge/Issue facts remain independent from author verification and CP records. Missing/uncertain postconditions preserve blockers and original recovery history.

Future work includes a coherent administrator registration/distribution system, general agent stage orchestration through a unified task entry, work-item/review/next-action Dashboard views, new-repository live E2E, persistent versioned-catalog rollback prevention and cross-machine release engineering. These are not implemented by source cleanup.
