# Windows project enrollment (R1-D)

This implementation adds a bounded local initialization flow to the installed Client and Viewer. It does not authorize deployment to an existing CP, production enrollment, business Runs/Events, Provider writes, Deliver, Mac changes or Release. Client/Viewer candidate version: 0.4.8. CP SQLite remains v2; historical ProfilePolicy contracts remain unchanged.

## User flow

Open Dashboard → Add project → choose Current machine / a Git directory → confirm the detected repository, branch, Project, Machine and Worktree → choose Observe or trusted development preparation → submit the request → obtain CP-owner approval → confirm connection. The Viewer invokes its pinned installed Client in a hidden child process; it does not manipulate another browser or mouse.

Observe accepts local modifications and ordinary business branches. It requires no business Issue, GitHub credential or GitHub write permission. Development preparation selects an existing approved Work Item from the machine's pinned #34 catalog. No approved matching item means BLOCKED; history never fills in authorization. Even development enrollment grants only registration/presence. Dynamic task execution and Deliver remain outside this change and retain the old independent gates.

The new project flow is separate from the retained existing-project/historical diagnosis wizard. An unmatched old-wizard worktree clears its previous project selection and cannot advance using another project's facts.

## One-time installation / machine setup

An administrator installs a verified standalone Client and Viewer outside Git, creates a private machine home outside Git, and supplies the trusted CP endpoint and any public CA. The installed `awh setup` hashes its own entry point; users do not calculate this hash for each project.

```powershell
awh setup --machine-config C:\AWH\machine.json --home C:\AWH\machine-home --endpoint https://<trusted-private-CP>:8443 --ca C:\AWH\public-ca.pem --project-root E:\projects
```

`--policy-trust <absolute-external-anchor>` is optional and only needed for development preparation. The anchor, fixed sibling catalog and approvals must already be operator-approved and OS-protected; setup does not approve them. Home and parent directories must already exist. Setup creates one local Machine identity and refuses to overwrite existing setup. For an already initialized device, an administrator may explicitly choose `--reuse-machine-state <existing-external-state-directory>`: setup reads and preserves that Machine identity, copying only its metadata into the new home; it does not copy or mutate old Sessions/Journals. No identity is discovered or reused implicitly. Using this option on a production device remains an explicit installation/deployment gate.

Add optional `machine_config_file` to the external Viewer configuration once. An enrollment-enabled local Viewer may begin with `viewer.project_ids: []`; it initially exposes no CP projects. Approved local bindings add only their own Project IDs, survive Viewer restart, and supply the Project/Executor association needed before any Run exists. Without machine setup, the Viewer stays in its previous read-only mode and explains the missing prerequisite.

```json
{
  "schema_version": "1.0",
  "mode": "local_browser_direct",
  "database": "C:\\AWH\\cp\\runtime.sqlite",
  "port": 4311,
  "viewer": { "id": "windows-owner", "project_ids": [] },
  "local_bindings": [],
  "machine_config_file": "C:\\AWH\\machine.json"
}
```

The Viewer database is still local and read-only. This does not implement remote Dashboard hosting or share SQLite across machines. Directory browsing stays within explicit machine project roots, lists directories only, and rejects redirection. Browser inputs cannot select a Client executable, endpoint, CA, config file, command or permission set.

## CP-owner approval

Submitting a request creates a dedicated credential and a non-secret request under the machine home. It creates no Manifest, CP Project, Executor, Run or Event. Dashboard identifies the request file for the CP administrator; users never copy credentials or edit JSON.

On the **CP host**, the administrator previews the fixed approval operation:

```powershell
node <CP-install>\dist\control-plane-cli.js approve-project --request <external-request.json> --database <existing-v2.sqlite> --config <CP-owner-trusted.json>
```

After reviewing repository, Machine, Executor, mode and exact scope, repeat with `--confirm`. Development preparation additionally requires `--policy-trust <CP-owner-approved-anchor>` and the exact requested Work Item/version. There is no browser/network administrator endpoint or generic Operator platform.

Approval resolves an existing Project by canonical repository identity, or assigns an owner-qualified repository-derived ID. Local paths never become Project IDs. Multiple retained Project identities for one repository are BLOCKED for owner resolution. Existing Projects and immutable legacy Profile versions are preserved. New Projects use an observation Profile reference; the separately approved business Profile/Work Item stays development preparation, not a production workflow policy.

The approval command only appends a single-project, single-executor Client scope and an immutable enrollment record to the existing external trust configuration. Existing Client scopes cannot be expanded or borrowed. It uses an exclusive local approval lock and an atomic validated file replacement; it makes no SQLite writes. An updated CP revalidates this owner-controlled snapshot before authenticating requests, so approval does not require restarting CP. Legacy workflow policies cannot change through this activation path. Invalid snapshots fail closed. Deploying the updated CP binary itself remains a separate production authorization.

Only then may Client complete: verify the returned grant against its dedicated credential/request, preserve conflicting Manifest/config, generate missing files, register Project/Executor and heartbeat. A recoverable partial failure is not online PASS. Repeating approval or completion is idempotent. Viewer starts only its new installed Resident; normal Viewer shutdown asks that Resident to stop, preserving other processes.

## CLI and Doctor use the same flow

```powershell
awh init --machine-config <machine.json> --directory <Git-root>
awh init --machine-config <machine.json> --directory <Git-root> --mode observe --confirm
# After CP-owner approval:
awh init --machine-config <machine.json> --directory <Git-root> --complete --confirm
awh doctor --machine-config <machine.json> --directory <Git-root> --json
awh doctor --machine-config <machine.json> --directory <Git-root> --repair
awh doctor --machine-config <machine.json> --directory <Git-root> --repair --confirm
```

Preview and ordinary Doctor are read-only. `--probe-cp` adds only the explicit authenticated GET of the enrollment record. Repair reuses completion and can restore missing Manifest/config; it never overwrites a mismatching identity, accepts an unknown CA, changes a credential/endpoint, clears a Session/Journal, retries pending Events, or switches branches. A development branch mismatch blocks development readiness while retaining Observe diagnostics. Retained history is shown as requiring separate inspection, not current-task approval or a new failure.

CLI completion registers and sends one heartbeat; use the existing `awh --config <generated-client.json> resident start` for continuing presence. Dashboard completion starts this foreground Resident on the user's behalf, bounded by the Viewer lifecycle. There is no automatic task execution or OS startup installation.

## Reader, identity and session behavior

Project is global; Machine is the installed device identity; Worktree is a local binding; Executor/Client are dedicated per binding. The same repository on two worktrees or machines reuses its CP Project and isolates Executor credentials/state namespaces. CP does not inspect the submitted machine's local path. Doctor and directory inspection execute on the Client machine. Remote machine transport and live Mac acceptance are still unimplemented/unverified.

Scoped approval bindings make new Executors visible without synthetic Runs. Optional `project_ids` and `worktrees` in Executor DTOs support project filters and local path display, without exposing Client owners, token hashes or config/credential paths. Online/offline is the server's Executor registration/heartbeat TTL; it is not proof that the whole physical Machine is reachable, nor a Project business-run status.

Viewer API cookies still expire after one hour. Explicit same-origin document navigation through “重新进入 Dashboard” renews an expired local session and invalidates the old cookie, without restarting Viewer. APIs and foreign origins cannot bootstrap a session. This is renewable local use, not an uninterrupted 24-hour live-session claim.

## Validation and remaining gates

Use existing tests, not a new test framework: enrollment tests cover installed Client/Viewer, CP approval/restart, run-free presence, business-write denial, two-worktree identity, development preparation, repair/conflicts, session renewal and headless UI. Targeted existing CP, startup, TLS, Client/Doctor, Viewer and Builder checks retain compatibility. Temporary resources are stopped and isolated; no mock result counts as a real second-project PASS.

Real agent-desktop enrollment remains a separate Human Live Gate with exact file/identity/heartbeat writes and Future UI reconciliation. Independent exact-head Review, deployment, Ready, merge and Release remain separate gates. A completed isolated installation test does not satisfy them.
