# AWH Protocol 1.0 (C1-A)

Issue [#19](https://github.com/zlpoot/agent-workflow-hub/issues/19), under
[#18](https://github.com/zlpoot/agent-workflow-hub/issues/18), defines data shared by
future Client, Control Plane and Dashboard consumers. This module has no HTTP
service, database, scheduler, project checkout discovery or UI. It remains part of
the existing Node.js/TypeScript/pnpm single package. Import `dist/protocol/index.js`
after `pnpm build`; standalone schema is `src/protocol/schema.json` (copied to
`dist/protocol/schema.json`). The module does not import fixed Builder Profiles,
machine paths, credentials or specific projects.

## Versioning and Entities

The standalone JSON Schema uses draft 2020-12, ID `urn:awh:protocol:1.0` and local
`$defs` references. Entity envelopes and payload envelopes require
`schema_version: "1.0"`. A minimal project manifest instead uses `apiVersion:
"awh/v1"`. Unsupported versions and unknown envelope/domain fields fail closed.
Changes to required fields, domain payloads, enums or transition rules need a new
protocol version; consumers must explicitly select the supported schema.

| Model | Identity and meaning |
| --- | --- |
| Project Manifest | Project ID, repository, Profile reference, stored in the project |
| Project | Registry project ID, repository and Profile reference |
| Profile Policy | Registry reference and immutable version; repository, base, fixed branch, ordered verification commands, App, review, delivery and optional executor restrictions |
| Executor | Executor ID, display name and machine ID/platform, separate from Profile |
| Work Item | ID and project ID; minimal GitHub Issue reference, which may belong to another repository |
| Run | ID, project/work item/executor/machine IDs, immutable starting source SHA/ref, exact Profile version, runtime state and timestamps |
| Event | ID, Run ID, contiguous sequence, type, timestamp and versioned payload envelope |

IDs are nonblank bounded ASCII identifiers. GitHub references contain only
provider, repository, kind and number, or provider, repository, SHA and ref.
SHAs use 40 lowercase hex characters. Timestamps use UTC
`YYYY-MM-DDTHH:mm:ss.sssZ`; they must be valid date-times. Numbers used for IDs,
sequences and exit codes must be safe integers. Whole GitHub Issue/PR bodies,
arbitrary API URLs and machine roots do not belong in the protocol.

## Manifest and Registry Policy

A project manifest is an identity binding, for example:

```yaml
apiVersion: awh/v1
project:
  id: webskill
  repository: zlpoot/webskill
profile:
  ref: webskill/default
```

`validateEntity('manifest', parsedValue)` operates on parsed JSON-compatible data.
YAML loading and installation of project files belong to C1-C. Policy fields,
commands, credentials and embedded Policy objects are rejected in the manifest.
The Control Plane must resolve the Profile reference from its trusted Registry;
accepting a caller's Policy as trusted would defeat this boundary.

`validateBindings` checks the manifest against Project and Profile identity, the
exact Run Profile version, Project/Work Item/Run links, executor/machine links and
optional restrictions. A Work Item can reference Hub #8 while its Project is
WebSkill. Policy has no default machine or Agent binding. A non-null restriction
requires membership in both non-empty executor and machine lists.

These functions check data consistency; they do not authorize execution. Profile
commands are declaration data and are never executed. In C1-A they cannot replace
or extend the existing Builder's fixed Profiles/workflows. App identity,
metadata-only selected-set inspection, one-repository write tokens, exact-head
evidence, independently verified Review and Human gates remain external gates.
The Policy describes single-repository installation identity, exact selected-set
checking, independent exact-head Review, Draft delivery and confirmed v0.1
Handoff; it contains neither credentials nor a dynamic permission-grant API.

## Run States and Events

`validateEntity` checks the schema without coercion, defaults or input mutation.
It also checks Run timestamp/state consistency. Schema validity does not imply a
valid transition or a trusted Registry binding. `replayRun(initial, history)`
requires an initial `created` Run and derives a new frozen projection from the
complete accepted history. Source identity and Profile version never change.

| Event | Allowed state | Result and requirements |
| --- | --- | --- |
| `RUN_STARTED` | created | running; source SHA matches Run; records started_at |
| `STEP_STARTED` | running | unique step ID opens a step |
| `STEP_COMPLETED` | running | matching open step closes with its exit code |
| `VERIFICATION_STARTED` | running, awaiting_review | verifying; all steps successfully closed; records subject SHA; clears prior candidate/Handoff/reviewer projection |
| `VERIFICATION_PASSED` | verifying | awaiting_review; SHA matches verification start and all checks exit 0 |
| `VERIFICATION_FAILED` | verifying | failed; SHA matches verification start; preserves checks and reason |
| `GITHUB_PUSH_COMPLETED` | running, awaiting_review | same project repository; in awaiting_review, SHA matches verified head |
| `GITHUB_PR_CREATED` | awaiting_review | one candidate per verification cycle; repository and head match verified project |
| `HANDOFF_PUBLISHED` | awaiting_review | records pending/confirmed/failed declaration, matching PR/base/head/subject and project comment reference; publication updates use the same comment |
| `REVIEW_STARTED` | awaiting_review | reviewing; matching candidate SHA, confirmed Handoff declaration, reviewer ID differs from Builder |
| `REVIEW_PASSED` | reviewing | review_passed; matching PR/SHA/reviewer and project review reference |
| `RUN_COMPLETED` | review_passed | completed; declared pass outcome |
| `RUN_FAILED` | any nonterminal state | failed; reason recorded |

Only `completed` and `failed` are terminal; new events after either are rejected.
Failure may occur before Run start, so failed Runs may have null started_at.
Nonterminal completion timestamps are null. Terminal completed_at equals
updated_at. Event timestamps are nondecreasing and cannot precede Run creation.
Clock-skewed input must be corrected by its producer, not silently reordered.

Builder delivery ends at `awaiting_review`, not `completed`. Reverification
before Review clears old candidate/publication claims. A changed candidate after
Review starts needs a new Run. This MVP defines no remote pause/resume/cancel or
merge state. A runtime `review_passed`/`completed` projection does not authorize
GitHub approval, merge, Issue closure or the next task.

## Append-Only and Idempotency

Every stored history starts with sequence 1 and increases by exactly 1. Duplicate
IDs, duplicate sequences, gaps, out-of-order delivery, cross-Run events and
invalid transitions are rejected. Event ID uniqueness is scoped to one Run.
`appendEvent(initial, history, incoming)` validates the existing history first:

- New ID and next sequence: append one frozen copy, return `appended`.
- Existing ID and identical complete JSON value: retain one copy, return
  `idempotent`, even for a late retry after Run termination.
- Existing ID with changed sequence, timestamp, type, payload or extensions:
  reject with `idempotency` conflict. Object key order is immaterial; array order
  and every value are significant.
- New ID with an old, reused or skipped sequence: reject with `sequence` conflict.

Inputs are not mutated and returned projections/history are recursively frozen.
This is an in-memory contract, not persistence or authentication. C1-B must
enforce per-Run atomic append and uniqueness in its Event Store transaction;
separately replaying two concurrent requests is not an atomic store operation.
Old facts stay in history; a new verification/publication event supersedes the
current projection without editing those facts.

Payload envelope is `{schema_version, data, extensions}`. `data` is closed and
validated for each Event type; `extensions` accepts finite JSON for namespaced
domain additions. Unsupported Event types fail closed. Extensions cannot affect
state transitions or confer authority, even when named `approved`. Undefined,
functions, BigInt, non-finite numbers, accessors, sparse arrays, cycles and class
instances are rejected rather than silently stripped. Keep credentials out of
all protocol records, including extensions.

## Runtime Truth and GitHub Truth

Run states and Event order describe runtime observations. GitHub remains the
durable source for Issue, commit, branch, PR, evidence, Handoff, Review and merge.
Recorded provider references and Review declarations are not proof that those
objects exist or still refer to the same SHA. Ingestion must establish its
authenticated producer; live provider reads and independent Review remain
required before acting on durable facts. Every validation/replay/mapping result
returns `authority_verified: false`. No API in this module writes GitHub,
executes verification commands, approves reviews or merges anything.

## v0.1 Handoff Compatibility

The C0 `BuilderHandoff`, validator and read-only CLI stay unchanged. Protocol 1.0
is a separate schema, not a replacement for `AWH-HANDOFF v0.1`.
`mapHandoffV01(record, expectedHead, context)` calls the original validator,
requires the producer Run ID and exact candidate head to match context, and
creates only `HANDOFF_PUBLISHED`. Context supplies the delivery repository and
published comment ID, because v0.1 stores the Work Item repository, which can be
different from the delivery repository. Context is data requiring live external
verification; the mapper cannot infer PR ownership or comment identity.

The mapper preserves pending/failed publication as facts. A confirmed record
requires the original completed/pass/all-zero/subject-SHA/expected-head Ready
claim. It normalizes accepted v0.1 uppercase SHAs to the protocol's lowercase
representation, returns the original validation result, and never creates a
Review PASS or authorization. Commands/evidence URLs remain in the original
durable Handoff/evidence comments instead of being executed or duplicated as
provider truth.

## Fixtures and Checks

`examples/protocol/webskill.json` and `future-ui.json` contain minimal parsed
Manifest, Registry Project/Policy, Executor, Work Item and initial Run fixtures.
All executor/machine/version/SHA values are artificial. `*/default` references
are proposed protocol bindings, not installed Registry records or replacement
Builder Profiles. The fixtures do not modify external projects or grant their
bootstrap permission. No live WebSkill/Future UI acceptance is claimed.

`pnpm check` covers strict schema/negative cases, binding consistency, every
required Event type, basic transitions, sequence/idempotency, immutable snapshots,
failed verification, exact-head matching, pending-to-confirmed mapping and
side-effect denial. Existing Builder/C0 tests continue to cover selected sets,
scoped token responses and transport/Ready boundaries. Ajv validates the
[draft 2020-12 schema](https://ajv.js.org/json-schema.html) and
[date-time format](https://ajv.js.org/guide/formats.html) locally; no remote schema
fetch is performed.
