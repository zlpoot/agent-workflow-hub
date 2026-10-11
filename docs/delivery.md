# GitHub App delivery

Deliver reuses the existing Builder and Run/Event state machine. It requires a clean exact HEAD, approved external Profile version, Work Item, branch, Executor/Machine and ordered verification commands. The CP Profile is compared to the administrator-pinned Builder policy; it cannot supply execution authority. Unknown or mismatching policy fails before Provider access.

`awh --config <external-client.json> deliver --title <title> --body-file <file> [--issue <approved-positive-Issue>] [--hold-draft]` executes the bounded stage. The executor prepares code and git commit beforehand; this entry performs App preflight, actual approved verification, push, Draft PR creation, evidence publication, pending→confirmed Handoff, readback and Run/Event observations. It verifies clean exact SHA throughout. A missing postcondition or uncertain Provider result is a failure/blocker, never success.

Preflight validates the real App ID/slug, Installation ID/account, selected scope, permissions and complete approved repository set with metadata-only inspection. Each write/revision/observation token requests and checks only the target repository at the operation's minimum permission. Credentials remain in the Builder closure and are stripped from Git/verification child environments and evidence. No personal PAT or gh login fallback exists.

Raw verification output, environment, timestamps, command order, exit codes, statistics and before/after SHA are retained in ignored .handoff and App-owned PR evidence comments. The Handoff is published pending, read back, updated confirmed, checked with accurate expected-head and read back again. Ready checks actual PR base/head and evidence identity; it is not Review or merge authority. Human acceptance can retain Draft.

The durable Journal and Event outbox retain uncertain operations and acknowledgements. Event-only retry resends identical declarations without repeating Provider effects. Recovery and same-PR revisions have separate receipt-bound flows; generic re-delivery cannot bypass consumed evidence or an uncertain PR/comment result.

`awh sync` reads actual GitHub lifecycle. Only approved independent native Review identities on exact HEAD can pass its Review Gate. Changes Requested blocks; dismissed, bot, unrelated and wrong-head approval cannot complete. Merge SHA and ordinary Issue closure must be observed before terminal completion. Sync never submits Review, approves, merges or closes Issues.

This implementation is not automatic agent wakeup, issue dispatch, code editing/commit orchestration, full project management or live new-repository E2E validation.
