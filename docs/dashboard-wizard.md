# Dashboard Wizard prototype — Hub #33

## #58 current implementation

Client / Viewer 0.4.7 adds an explicit scoped local-browser entry and opt-in installed-Client offline diagnosis. The default selection uses the current Reader or asks for a source; history is selected explicitly. Operator-owned external bindings supply exact worktree/repository, pinned installed Client entry, existing config and optional approved Work Item. The browser selects only a scoped binding ID and never supplies an executable/config/permission. Current installation, configuration, Doctor checks and approved-version comparison are timestamped; missing observations remain not_checked. See [Windows installation and operation](windows-product.md). The following #33 account is retained as historical prototype behavior and evidence, not the current feature definition.

Open **添加项目向导** in the existing Dashboard. Four steps support direct selection and previous/next navigation: select an existing scoped project or explicitly labeled historical sample; review independent Client/manual configuration instructions; inspect Doctor/Policy observations; return to Project, Executor, Run and Timeline views. The Wizard remains available without a Viewer snapshot; Reader destinations are unavailable until the project is in its protected scope.

React 19, Radix Themes 3.3.0 and the existing `DashboardReader` same-origin GET/SSE contract remain unchanged. No browser approval, file/config/Doctor upload, filesystem scan, command execution, provider write or new server API. Copy copies a placeholder command template only. Reuse existing installs, Machine/Executor/endpoint/CA/credential/state. Config placeholders illustrate structure; they are not usable real configuration or approval.

## Sources and limitations

The **#35 historical offline sample** comes from the [App report](https://github.com/zlpoot/agent-workflow-hub/issues/35#issuecomment-6080926077). Original 9 passed / 4 blocked / 9 not_checked and original Work Item conflict are retained. Dirty product branch, three retained journals, recovery record and historical Issue #90 are observations, not a new Run failure or current authorization. Raw #35 evidence is not rewritten.

**Reader snapshot** means validated scoped stored projections. Fixture data is labeled synthetic even when the stream is connected. Cursor, lastRefresh and offline/outdated state remain visible. Profile versions, branches and Issues from Runs are observations; this read DTO does not carry an operator-approved Work Item. Approved-effective policy, local configuration, current local Doctor and App scope remain `not_checked`. No stored Run/Event grants GitHub authority.

**Unverified** means no actual observation was supplied. The browser cannot run Doctor or validate an artifact, trust root or actual CP. A new task needs a pre-approved external Profile/Work Item version and separate execution/live gates; do not change a product branch to remove a diagnostic conflict.

## Client package and Doctor correction

Source candidate: **@zlpoot/awh-client 0.4.6**. Its actual built source SHA and tarball digest belong in candidate PR evidence; the browser leaves new provenance `not_checked`. The #35 historical **0.4.5** sample is tied only to source `1e507c35f0cd908bcd8b226417ff471a505d677b` and SHA-256 `a8e9a771a5a17e55b5797ef3c31c8ee1aa56813e850a088c3796b0b9921c257c`. Never apply it to 0.4.6 or unknown tarballs.

Doctor displays an unavailable dynamic expected Issue as `null`, with `work_item: not_checked / dynamic_issue_unavailable`, separately showing the retained Issue. Only a legal `codex/awh-task-<positive safe integer>` branch supplies the comparison's expected Issue; invalid branches stay blocked. Fixed `repeatable-docs` sentinel semantics and Client Deliver policy are unchanged. This is diagnostic data with `authority_verified=false`.

## Local validation and stop

From a clean candidate head run in order:

1. `pnpm build`
2. `pnpm typecheck`
3. `node --test tests/dashboard-ui.test.mjs tests/dashboard-wizard.test.mjs tests/doctor.test.mjs`

Run `pnpm dashboard:smoke` once against its synthetic in-memory loopback fixture. Use an existing browser via `AWH_DASHBOARD_TEST_BROWSER` if necessary; no downloads, real Viewer, original CP/SQLite or product Client access. Screenshots/raw outputs belong in ignored `.handoff/`, with safe evidence on the Draft PR. The fixed `hub/c1j` mapping is for #33 code publication only, not Client Deliver authority.

The original #30 `PHASE_C_ACCEPTED_WITH_EXCEPTION` remains intact. #33 fixture usability is not #35 full acceptance, production certification, Ready or merge. Stop at Draft + confirmed exact-head Handoff for independent ChatGPT Review. Real CP/Viewer observation, #35 Timeline acceptance, #31 Pairing/Operator and credential issuance remain separately gated.
