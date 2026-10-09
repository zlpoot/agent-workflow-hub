# Versioned Profile / Work Item offline prototype

Issue #34 introduces operator-approved data for Observe and Develop without adding a fixed business-task mapping to `src/profiles.ts`. The `hub/c1k` mapping is a separate one-time permission to publish #34's code as a Hub Draft PR. It is not a dynamic delivery grant. Existing fixed Profiles, default selection, Client Sessions, CP schemas, Provider journals and receipts are unchanged.

## Trust root and immutable versions

The operator supplies an explicit absolute **external** trust-anchor path to `loadApprovedWorkItem`. Doctor accepts the equivalent `--policy-trust` flag. There is no project/config/environment discovery. The anchor directory and every ancestor must be outside Git repositories and must not traverse symlinks or redirected paths. Bounded regular UTF-8 JSON files are read only.

The trust anchor has exactly `schema_version="1.0"`, `kind="policy_trust"`, `operator`, `source`, `catalog_sha256` and `approvals_sha256`. The two digests pin the exact bytes of the fixed sibling files `profiles.json` and `approvals.json`; arbitrary filenames, repository URLs and API endpoints are not accepted. No connection parameters or credentials belong in these files.

This is an **OS-protected local operator trust root**, not cryptographic authentication of an operator. The Human must supply and protect the anchor independently of project authors and compare the approval source through their trusted channel. An attacker able to replace the anchor and both siblings can replace this trust root. The prototype does not inspect Windows ACLs, issue signatures, persist a rollback ledger, provide an approval API, or claim production authentication. A project Manifest/Issue/PR/body or a Client deployment file is never an approval source. Tests create synthetic approval fixtures outside their scratch repository; they do not approve a real business Issue.

`profiles.json` has exactly `schema_version="1.0"`, `kind="versioned_profiles"`, `profiles` and `work_items`. Each template has exactly:

- `ref`, `version`, `repository`, `base`, `branch_prefix`, `executors`, `checks`, `stages`.
- `branch_prefix` ends with `-` or `/`; Work Items bind a longer exact branch below it.
- Stages contain only `observe` and/or `develop`. Checks are ordered, bounded, printable declaration strings. No command is executed.

Each Work Item has exactly `id`, `repository`, `issue_repository`, positive `issue`, `base`, exact `branch`, one `executor`, ordered `checks`, `profile_ref`, `profile_version`, `work_item_version`, `expires_at` (canonical UTC or null), and `stages`. Repository/base must equal the approved template, executor must belong to its approved set, branch must fit its prefix, stages may only narrow, and checks must exactly equal the approved order. The separately approved Work Item fingerprint binds the Issue repository/number. A new business Work Item can be added as approved data without changing source.

`approvals.json` has exactly `schema_version="1.0"`, `kind="policy_approvals"` and `entries`. Each entry has exactly `kind` (`profile` or `work_item`), `id`, `version`, `fingerprint`, `operator`, `source`, `approved_at`, `reason`, and `supersedes` (prior fingerprint or null). Fingerprints use `policyFingerprint`: SHA-256 of JSON with object keys sorted recursively and array order retained. Actor/source must match the external anchor. Approval times cannot be future-dated. Every catalog version needs one matching approval; duplicate identities/versions, altered fingerprints, extra approvals and invalid/cyclic predecessor links fail closed.

To revise scope, the operator reviews the old/new definitions and their readable preflight diff, explicitly approves new template and Work Item versions with a reason/source/time, and pins a new catalog/approval snapshot. Preserve old records and use `supersedes` to reference the predecessor; never reuse a version with different bytes. The loader does not write or approve revisions. Retain old approved records/anchors for historical Runs. In-memory loaded snapshots are deeply frozen and cannot be forged by copying JSON; serialized Runs retain template, Work Item and approval fingerprints. A report must match its original loaded version, not a replacement version. Bounded process-local conflict memory refuses changed definition or approval fingerprints for an already loaded version at the same canonical trust path (128 roots, 4096 retained version identities per root). The loader validates the whole snapshot before recording anything. This integrity is relative to the externally pinned snapshot; cross-process immutable archival storage and anti-rollback enforcement are deferred.

## Observe and Doctor

`approvedRevisionDiff(previous, next)` returns the changed template/Work Item fields, both fingerprints and approval records for archival alongside the operator's prior approval decision. It does not approve proposed data. The ordinary `comparePolicy` DTO can also display an old definition against a proposed declaration before approval; that diagnostic function has no trust or execution capability.

`versionedPreflight(approved, observations)` and `formatPreflight` share the same DTO with Doctor. It lists approved-effective vs observed repository, Issue repository/number, base, branch, executor, ordered checks and both versions. Missing facts are `not_checked`; mismatches are `blocked`. `provider_scope` stays `not_checked`, `deliver` stays `blocked`, and `authority_verified` stays false.

```text
awh --config <existing-external-client-config> doctor --json --policy-trust <external-trust.json> --work-item <id> --work-item-version <version> --observations <observation.json>
```

The observations file is optional, bounded untrusted JSON containing only fields of the comparison DTO. It may declare Issue/base/check/version facts for a task with no existing Session. Actual Git repository/branch, Manifest ref, existing config executor/Profile version, and retained Session Issue/check facts take precedence. Conflicting supplied declarations also produce a separate blocked check, so they cannot hide behind that precedence. Doctor does not attest that declared checks ran or that the declared base is the current remote base. Missing original machine/session/config, dirty worktree and other Doctor findings retain their own status. This prototype never initializes them. Omit `--json` for readable differences.

Versioned diagnosis is offline only; combining it with `--probe-cp` blocks before any CP request. No policy input is routed into `AwhClient.start/event`, production CP registration, GitHub Builder or Deliver. `init` and existing CP/Client execution continue to use their original contracts; dynamic registration is deferred.

For existing static Profiles, the CP mock-tested observation path now uses `observationPolicy` / `compareObservedPolicy`, independent of Deliver's restricted allowlist. Thus `hub/c1i` can compare successfully without a Deliver grant. Unknown refs and repository/base/branch/ordered-check mismatches still block. Static mapping has no approved dynamic version: CP observed version remains comparison data and the shared DTO leaves approved version absent / `not_checked`. Repeatable template branch mode and executor/machine restrictions remain checked. The original `deliveryPolicy` / `matchDeliveryPolicy` allowlist and guards are unchanged.

## Develop reports

The exported library functions `declareDevelop` and `reportDevelop` return immutable, validated data. They have no filesystem writes, network, shell, Git/GitHub provider, Codex, token issuance or CP operations. A complete matching preflight and approved `develop` stage are required. Source SHA is a declaration, not independently verified execution evidence. The optional clock argument is for trusted offline harnesses; no CLI or project input controls the clock.

`declareDevelop` binds a Run ID/exact declared source SHA to its approved policy, Work Item and approval fingerprints. `reportDevelop` checks the complete retained history and accepts only `started` → `checks_reported` → `completed`/`failed`, or `started` → `failed`, with contiguous sequences. Check commands must match the approved order; exit codes are bounded integers. Completion after a reported nonzero check is refused. Unknown payloads, forged bindings, terminal append/replay or reordered checks are refused. Output remains `execution="declarations_only"`, `provider_scope="not_checked"`, `deliver="blocked"`, `authority_verified=false`. The prototype does not attest reported outcomes, persist events, register Runs, or implement distributed idempotency.

## Validation and stop

Run only the authorized build, targeted versioned-profile/Doctor tests and one local offline scratch smoke. The smoke copies synthetic files outside a scratch Git repository, loads a new Issue fixture, compares Doctor JSON/text, reports a bounded Develop lifecycle and confirms scratch bytes stay unchanged. It neither creates a fixed source mapping for that task nor touches real product worktrees or production CP.

Code delivery: exact clean HEAD, App installation identity, Hub-only write scope, Draft PR, preserved raw targeted evidence and pending→confirmed exact-head Handoff. Stop for ChatGPT independent Review. No Ready, merge, close, real Deliver, App installation changes, production policy/credentials/endpoint mutation, full suite, Actions, cross-host validation, model/paid flow or next task is authorized by this prototype.
