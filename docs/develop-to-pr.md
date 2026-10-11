# Human-gated develop-to-pr (M1-C)

One authorized instruction can cover implementation, verification, Commit and delivery through the next independent Review gate. The Executor implements code and commits locally; the existing GitHub App Builder owns all Provider writes. CP does not wake a model. Merge remains a separate Human action.

## Contract and entry point

`src/workflow/contract.ts` defines source-neutral Project, Work Item, Stage, Executor, Machine, Human Gate, Evidence, Provenance and StageResult envelopes. An ExecutorAdapter supplies preflight, execute and postcondition. The kernel has no GitHub writer or model-specific request format. Codex is the first adapter; another executor can implement the same interface.

The external administrator launcher supplies the existing approved trust/pin, Work Item version and Executor/Machine binding. The external Client config must refer to an already registered, isolated or explicitly provisioned CP Session with the exact immutable Profile version. A repository manifest, CP response, instruction, fixture or prepared approval receipt grants no authority.

```powershell
awh stage prepare
# Codex implements the Issue, runs approved checks, fixes failures and creates a local Commit.
awh --config <external-client.json> stage execute --title <PR-title> --body <UTF8-body-file>
```

`prepare` returns copyable model instructions and a descriptive contract without credentials. `execute` requires an approved develop/deliver/observe task, exact controlled branch, clean Commit, allowed executor/machine and necessary operations. It invokes existing `deliver` with `holdDraft`; exact-head verification is performed again on the committed candidate. It then checks original Session/Journal, acknowledged CP Run/Event history, native App-owned Draft PR, Evidence and confirmed Handoff. Any missing or mismatched fact yields BLOCKED. No Agent declaration can substitute for this check.

The authenticated read-only `/v1/workflow-capabilities` endpoint must advertise `stage-v1` and `exact-grant-v1` before stage Provider operations. Old CP runtimes block before Push. Existing `/v1/capabilities` remains compatible; no database migration or production upgrade is performed by the stage.

Successful output is `awaiting_review` with PR, HEAD, Evidence digests, confirmed Handoff and CP Run/Event references. It does not emit Review, approve, merge, close an Issue or mark Run completed. Native Review and Human merge/Issue close are read through existing `sync` reconciliation.

## Managed code revision on the same PR

A separate independently approved Work Item grant binds:

- original approved Work Item version and immutable project version;
- original Run, target PR, exact previous HEAD and exact new committed HEAD;
- native REQUEST_CHANGES review ID, repository, Issue, branch, executor and machine;
- expiry and only push/evidence/handoff operations (no draft_pr).

Prepare this through the existing administrator CLI, using all ordinary task flags plus:

```powershell
awh-admin propose <ordinary-exact-task-flags> --head-sha <new-head> --original-version <first-task-version> --run <original-run> --pr <same-pr> --previous-head <effective-old-head> --review <native-review-id> --operations push,evidence,handoff
# Existing approval-prepare -> independent administrator pin -> approve workflow applies.
```

The new grant materializes the original Profile version so the original CP Run remains bound to its immutable policy. The grant itself has a separate version, receipt, expiry and revocation. It cannot alter the original task, project, stage or identity scope. A reusable project may explicitly approve all repository code paths; a legacy unbounded issue-prefix policy is still rejected.

Builder `revise` is distinct from first publication. It reads the exact old remote ref and same App-owned Draft PR, checks the pinned native changes-request is still effective, proves strict local ancestry and runs a dry-run. Push uses an exact old-ref lease after checking ancestry and requalifying native facts. It does not permit arbitrary force Push, PR creation or edits to old Handoff comments. First-publication `deliver` still rejects any existing managed branch before write-token minting or transport.

The stage runs every approved verification command on the new HEAD and publishes new App Evidence. Existing `linkRevision` then produces a fresh pending-to-confirmed Handoff and `PR_REVISION_LINKED` using the existing Receipt and overlay. The original Session, delivery Journal, Handoff comments and Event prefix remain unchanged. Subsequent revisions use the effective candidate HEAD and another independent grant; native approval must refer to the new HEAD.

## Recovery and consecutive work

Existing Session, Journal, Outbox and Receipt remain authoritative. The revision stage adds bounded operation intents and verification logs under ignored `.handoff/stages/<authorization-version>/`; it does not replace the Run state machine. An interrupted Push is observed with native ref/PR reads. Exactly matching accepted new HEAD is adopted without another Push. Lost Evidence ACK is adopted only when a complete App comment listing has one exact body match. Missing or conflicting observations block. Interrupted Handoff publication uses existing `reconcile-publication` / independently authorized `resume-publication`; confirmed revision CP ACK loss retries only the original immutable Event.

First-publication uncertainty remains BLOCKED with its original failure and Journal; repeating `stage execute` never blindly repeats Provider effects. A read-only Builder observation and Journal inspection is required for diagnosis. This release does not introduce an automatic first-publication partial-PR repair mechanism.

For a failed pre-Provider verification with a new clean Commit under the same approved task whose final HEAD was not pre-pinned, the stage invokes the existing one-shot verification recovery. It proves unchanged failed CP history/Journal, an absent remote branch and absent PR before creating a linked successor Run. Failures after uncertain Provider effects are ineligible; old failures and their raw logs remain retained.

When the failed task pinned its final HEAD, grant a new immutable version with a different exact HEAD and `verification_recovery: { original_version, run_id, previous_head }`. The existing administrator CLI accepts `--recovery-from-version`, `--recovery-run` and `--recovery-previous-head` together with ordinary task flags. Independent approval must bind the original task and policy, failed Run, old/new HEAD, repository, Issue, branch, executor and machine without expanding stages or operations. Same-HEAD retries, absent grants, mixed revision/recovery and wrong bindings block. Provision the new fixed Profile version in the same isolated CP through administrator controls, retaining old profiles, Run/Event and Client namespace. Recovery archives the exact predecessor Session and preserves Journal/logs, then appends a one-shot receipt and linked successor Run. Lost successor ACK retries its original Event; repeating delivery does not mint another Run or replay Provider writes.

The protected verification runtime needs the complete approved toolchain. Copying Node alone is insufficient when a check creates or installs offline Client packages: npm and its dependency closure must be available beside the protected Node executable or via a fixed protected PATH. Pin those files in the administrator runtime seal. A missing toolchain component is a verification failure, never a reason to skip a check or reset CP/Session history. `stage_verification_failed` identifies that stop; raw logs remain under `.handoff/<Run>/verification.json` and bounded recovery accepts evidence up to 64 KiB.

After native Review and Human merge reconcile the prior Run to completed, the administrator grants the next Issue and a new branch on the newly verified main baseline. Provision its new fixed Profile version in CP and the external Client configuration through existing administrator deployment/enrollment controls. Historical fixed Task bindings are read from original immutable approved registry records, allowing archival without reinterpreting them as the next task.

## Verification boundary

`tests/workflow-stage.test.mjs` uses ephemeral administrator trust, isolated Git and SQLite CP, real Client/Builder orchestration and a synthetic Provider. Synthetic PASS proves bounded implementation scenarios, not live GitHub business E2E. New Sandbox E2E, Mac, production cutover, independent product Review and formal Release remain NOTRUN until separately authorized and actually performed.
