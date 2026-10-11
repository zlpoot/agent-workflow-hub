# Client Doctor prototype — Hub #32

For R1-D machine/project diagnosis and explicit repair, see [project enrollment](project-enrollment.md). The legacy Doctor below remains read-only and preserves its historical comparisons; it does not silently initialize or rebind a project.

Client candidate **0.4.6** extends the independently installed package structure with read-only diagnosis. It needs Node 24+ and Git, and runs inside a real product worktree without a Hub checkout. This prototype has offline fixture coverage on the recorded Builder OS; it does not claim macOS or production acceptance.

## Run offline first

Use the actual installed `awh` (`awh.cmd` on Windows):

```sh
awh doctor
awh --config /absolute/external/client.json doctor
awh --config /absolute/external/client.json doctor --json
awh doctor --help
```

Only an explicit absolute `--config` before the command or the existing `AWH_CLIENT_CONFIG` selects external configuration. Doctor does not discover, initialize, repair or overwrite files. No config still produces local Git/Manifest/Profile diagnosis and reports a configuration blocker. JSON and text render the same ordered DTO. Each check carries `status`, fixed `code`, `source`, and `safe_next_step`. `blocked` exits 2; a report with only `passed`/`not_checked` exits 0. Exit 0 is not delivery readiness or authority. `authority_verified` is always false.

The offline path inspects canonical Git root/origin, exact HEAD/current branch and dirty boolean, the minimal Manifest, static checked-in Profile mapping, existing machine/executor identity, original session binding and pending Events. It does not read the credential contents. Config values, machine UUID/name, endpoint, CA path, state paths, raw remote bodies and Event payloads are omitted. Comparison details include bounded branch/Profile identity, expected/recorded command names and Work Item references; unregistered command text is suppressed, and commands are never executed.

Manifest and local session/config are observations, not permission approval. An unavailable effective approved Profile/version remains `not_checked`; configured version does not imply approval. A missing machine, namespace or session blocks state diagnosis and is never recreated. Retained delivery journals, revision attempts, recovery records or locks conservatively require separate inspection: Doctor does not declare a completed provider operation from local receipt existence. It does not perform receipt reconciliation or ACK retries.

For `future-ui/c1c-acceptance`, the report shows its current static mapping and separately explains the old `future-ui/bootstrap` branch/check mapping. A branch, Work Item or recorded check conflict advises **request an approved new Profile/version and Work Item through Hub #34**. Preserve the existing worktree; do not checkout/reset/clean/overwrite it to silence Doctor. No new policy is loaded from project JSON.

App selected-set/permissions, GitHub remote state, independent Review and tarball digest provenance stay `not_checked`. A supplied tarball's SHA-256 must be verified through a trusted distribution channel; local package metadata is only a version/entry-point comparison.

## Manual trusted installation/configuration

Ask the owner for the reviewed tarball and its SHA-256 through an authenticated channel. Install into an external tool directory, leaving the product package.json/lockfile unchanged:

```sh
npm install --prefix /absolute/external/awh-client --offline --ignore-scripts --no-audit --no-fund /absolute/zlpoot-awh-client-0.4.6.tgz
/absolute/external/awh-client/node_modules/.bin/awh --version
```

On Windows use an absolute drive path and the prefix's `node_modules\.bin\awh.cmd`. On macOS use absolute POSIX paths and the `awh` bin. For example, these placeholders show syntax only:

```powershell
& 'C:\external\awh-client\node_modules\.bin\awh.cmd' --config 'C:\external\awh\client.json' doctor --json
```

```sh
/absolute/external/awh-client/node_modules/.bin/awh --config /absolute/external/awh/client.json doctor --json
```

For an existing Client, keep its approved config, endpoint, CA, dedicated credential, executor ID, state directory and namespace. Request operator assistance on conflicts. For a separately authorized new installation, the owner provisions config/state and a dedicated scoped CP credential **outside every Git repository**; never paste a credential into argv, a Manifest, Dashboard, GitHub comment or this guide. Unix private credentials must be owner-only; Windows needs owner-only NTFS ACLs. Verify the public CA fingerprint through a trusted channel. No automated `awh connect`, invitation, credential issuance or rotation is included.

External config retains the existing closed Client schema: `schema_version`, `endpoint`, `credential_file`, `state_directory`, `executor_id`, `executor_type`, optional `profile_version` and `ca_certificate_file`. Use the owner-provided original values. The minimal Manifest is identity only; existing Manifest conflicts require owner diagnosis. The existing `init`/`register`/`status` commands are separate operations with their own write/network effects and authorization; Doctor does not call them.

## Optional original CP read probe

Only after a separate bounded live authorization for the actual CP:

```sh
awh --config /absolute/external/client.json doctor --probe-cp --json
```

This explicitly reads the existing dedicated credential and issues at most three GETs: bound Project, Profile Registry and Executor Registry. It never sends GitHub requests, registration, heartbeat, Events, Run writes or delivery operations. Each request has a 3-second total deadline and 64 KiB response bound, with no automatic retry, redirects, proxies or identity/endpoint fallback. HTTPS uses the original explicit CA (or Node's default trust), strict certificate/hostname verification and no TLS bypass. Numeric loopback HTTP is only the already-supported local transport. CP errors retain fixed categories such as `authentication`, `tls`, `network`, `timeout`, `response_schema` and `response_binding`; sensitive values and raw errors are suppressed. A CP GET PASS only means that particular bound observation succeeded.

The #32 implementation/testing scope is Hub code, temporary fixtures, standalone packaging and one offline scratch smoke. Full `pnpm check`, Actions, dual-machine/production acceptance, actual CP/SQLite/Client changes, pairing, #34 approval, Ready and Merge remain outside this round. A new App publishing mapping requires explicit Human authorization before publishing a Draft PR.
## Versioned offline comparison

Issue #34 adds optional `--policy-trust`, `--work-item`, `--work-item-version` and `--observations` arguments. These read an operator-owned external pinned snapshot and compare bounded declarations with actual Git/Manifest/config/retained facts. They cannot grant execution or Deliver authority and cannot be combined with `--probe-cp`. See [versioned-profile.md](versioned-profile.md) for exact closed DTOs, trust-root limitations and the library-only Develop declaration/report API.

Hub #33 corrects unavailable dynamic expected Issues to `null` / `dynamic_issue_unavailable` while retaining observed historical Issues separately. Original #35 0.4.5 evidence and 9/4/9 remain unchanged. Dashboard Wizard documentation is available in the Hub repository; this standalone guide requires no Hub checkout.
