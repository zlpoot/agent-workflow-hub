# Client 0.4.4 publication reconciliation (Issue #45)

Current main includes this Client 0.4.4 / v0.2.1-R1 implementation: #46 is merged and #45 is closed. The Future UI #90/#92 delivery and recovery chain has closed. This describes supported code and a completed historical recovery, not a reusable production authorization. Every new install, registration or one-shot resume requires its own explicit Human authorization and frozen scope; the existing CP/history/receipt bytes remain immutable.

Historical / Legacy: Phase A Client 0.4.3 installation and its publication_conflict were retained as evidence, followed by the separately authorized Client 0.4.4 recovery. The original PR92 9 Run / 52 Event fixture remains unchanged; it is not the current live history count. The offline evidence section below retains its original test conclusions. See [configuration](../config/README.md).

## Read-only reconciliation

```sh
awh --config <original-external-config> reconcile-publication --revision <original-revision-id>
```

This command requires exactly the retained phase 0/1, the original namespace, immutable Run/Issue/task/branch/base/source, clean descendant candidate HEAD, both allowlisted document diffs, unchanged exact-head evidence, original confirmed real-Run Handoff, Session/Journal and CP timeline. Existing verification recovery receipts and predecessor archives are also qualified through the existing recovery validator. It reads with a single-repository read-only App token. It does not create a lock, intent, receipt phase, comment, Event or new revision ID.

Conversation comments are read in pages of 100, up to ten pages, twice. Malformed or missing pages, a full tenth page, contradictory continuation headers, changing snapshots, multiple matching Handoffs, or conflicting actor/body/identity stop reconciliation. Only one exact App-owned frozen pending or confirmed body can be proposed for adoption.

Publication identity is classified from bounded Handoff and Revision JSON sections. Existing PR92 document-review Handoff #6071714260 has a different structured producer and no Revision section; references to the real Run and target HEAD in its prose do not make it a revision candidate. Structured same-Run/target claims, unexpected current revision identifiers, malformed or contradictory Revision metadata, wrong actors and duplicate candidates still stop. A separate, structured Human resume decision is read as an authorization proposal; its presence does not authorize publication. Original comment and receipt bytes are retained.

The output contains an authorization `scope` and `scope_sha256`. The scope binds original phase bytes, pending body, evidence and previous Handoff, Session, Journal, CP Event prefix and recovery receipt hashes to the same revision/Run/PR/HEAD. A `negative_observation` explicitly reports `first_post_not_submitted_proven=false` and `automatic_repost_authorized=false`. Absence in the observed pages cannot prove that an earlier POST was not accepted.

## Explicit one-shot Human decision

The repository Human owner must publish a **new** authorization comment on the same Draft PR. Its complete body must have this format (use the actual reconciliation values):

````text
AWH-PUBLICATION-RESUME v0.2.1-R1
```json
{
  "schema_version": "1.0",
  "kind": "revision_publication_resume",
  "decision": "authorize_once",
  "revision_id": "<original-revision-id>",
  "run_id": "<original-run-id>",
  "pr": 92,
  "new_head": "<frozen-candidate-head>",
  "scope_sha256": "<reconciliation-scope-sha256>",
  "action": "post_once",
  "comment_id": null,
  "ambiguity_decision": "accept_bounded_duplicate_risk"
}
```
````

For a unique existing comment, use `action="adopt"`, its exact numeric `comment_id`, and `ambiguity_decision="adopt_exact_existing_comment"`. Reconciliation alone does not authorize either action. This MVP supports the explicit bounded duplicate-risk decision for negative observations; it does not infer no-submit proof from old logs, a 403, or missing comments. Human should resolve provider ambiguity before deciding whether to accept that risk.

```sh
awh --config <original-external-config> resume-publication --revision <original-revision-id> --authorization-comment <new-human-comment-id>
```

The command re-reads the owner identity, exact authorization body and observation before creating an exclusive, immutable `<revision-id>.publication-resume.json` intent. That intent consumes the single recovery attempt before publisher connection or any comment write. Any uncertain provider outcome, drift, timeout, conflict or readback failure stops; there is no automatic second POST and no deletion/reset of an intent.

A negative observation permits at most one frozen-body POST; adoption permits no POST and only the explicitly authorized existing comment can be confirmed. The revision token requests and validates exactly `contents:read / issues:read / pull_requests:write` plus implicit `metadata:read`, on the trusted task's single repository. The adapter remains closed: no push, PR creation/update, Ready, merge, close or arbitrary API mutation. Existing-comment PATCH is available only through the explicit receipt-bound adoption context; ordinary revision publication can edit only the comment it just created.

Successful exact readbacks append original receipt phases 2–5 and one `PR_REVISION_LINKED` Event through the existing overlay. Original phase 0/1, Session, Journal, prior Handoff and recovery archives remain unchanged. Confirmation interruption (phase 2/3) stops for independent reconciliation. `link-revision --retry` remains **ACK-only**, exclusively for phase 4 with the already fixed Event and confirmed Handoff; it does not restore phase 0/1 or perform GitHub writes.

## Diagnostics and offline evidence

CLI errors can identify PR read, compare read, comment POST, response parse, confirmation PATCH and readback. They expose only typed stage/category, actual HTTP status when available, and bounded whitelisted GitHub request ID/accepted-permissions headers. Keys, tokens, other headers, remote bodies and raw exception text are omitted. A status or diagnostic never authorizes retry.

`tests/publication.test.mjs` combines the original PR92 phase 0/1 bytes and real 9/52 history with isolated publication/replay acceptance at cursor 53. Separate complete Client integration scenarios use temporary Git repositories, namespaces, SQLite databases and mock providers to exercise one-shot POST/adoption, interruption, duplicates, drift and ACK-only retry. These offline fixtures are not a production recovery PASS.
