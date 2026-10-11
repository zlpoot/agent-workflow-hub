# Fresh Windows Client and Viewer installation

Use Node.js 24+, Git and independently verified Client/Viewer tarballs. Install into new external directories with npm --offline --ignore-scripts --no-audit --no-fund. Protect deployment configuration, identity, machine home and credentials with administrator/owner ACLs. Initialize a new external CP database using the [canonical runtime configuration](control-plane.md); do not test this candidate against an existing production installation.

Run `awh setup --machine-config <new-external-file> --home <new-private-home> --endpoint <approved-CP> --project-root <approved-root> [--ca <public-CA>] [--policy-trust <external-anchor>]`. Setup refuses to overwrite its configuration. It creates a new Machine identity and does not import an old machine state or approve business execution.

The sole Viewer entry is `awh-viewer --config <external-viewer.json> [--owner-config <external-owner.json>]`. It reads the current CP SQLite database without writes and binds IPv4 loopback. The optional local administrator confirmation is part of the same entry; it is not a second service. Assets come from the installed package, never a configured arbitrary directory.

Open its printed /dashboard URL through the local browser. Document navigation creates a one-hour HttpOnly SameSite=Strict Viewer cookie scoped to /dashboard. API/asset requests, cross-origin requests and CP credentials cannot bootstrap this session. “重新进入 Dashboard” performs explicit same-origin document navigation after expiry.

Overview, Projects, Executors, Runs and Timeline display CP observations. “添加项目” uses the current Enrollment flow. Select an administrator-approved local directory, inspect the actual repository/branch, and confirm the request. An Observe grant permits registration and presence only. The optional “管理员批准并接入…” requires separately provisioned administrator configuration and native Human confirmation. It cannot grant GitHub delivery or start a business task.

Resident sends the current dedicated Client heartbeat and preserves identity on stop/restart. Online presence and business workflow readiness are separate facts. Doctor diagnoses; explicit repair has its own confirmation and preserves conflicting state. Fixture previews always display “模拟数据”; the installed Viewer contains no seeded fixture records.

The cleanup's isolated installation tests do not establish production cutover, native Human acceptance, cross-machine behavior, macOS validation or a new-repository live delivery E2E. Independent exact-head Review and explicit deployment gates remain required.
