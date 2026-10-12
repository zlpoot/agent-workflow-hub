# Windows Local Fast GitHub App delivery

`personal-gh` remains the default Local Fast provider. `github-app` is an explicit delivery option for an Owner-confirmed single repository and finite Issue queue. Coding Executor, App Delivery Actor, trusted personal Reviewer and Owner Merge Actor are separate. This connection cannot grant Strict Builder authority, change a completed queue, create a repository, change an installation or authorize merge.

## Owner connects once

Use the App settings to obtain the numeric **App ID** and slug. A PEM cannot supply the App ID. Install that App on **selected repositories** with Contents: write, Pull requests: write and Metadata: read. AWH checks the complete selected set (all pages, maximum 128); `--repos` must name that exact set. Only those saved repositories may use this connection. The CLI discovers the installation ID and verifies its App ID, slug, account, active status and permissions through GitHub.

On Windows, create `%LOCALAPPDATA%\AWH\github-app` outside Git and provision its ACL for the current Windows Owner, SYSTEM and Administrators only. Place the existing RSA PEM in an equally protected directory outside every Git checkout; do not copy it into a worktree. Owner can provision **a new directory** in PowerShell:

```powershell
$appDirectory = Join-Path $env:LOCALAPPDATA 'AWH\github-app'
New-Item -ItemType Directory -Path $appDirectory
$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $appDirectory /inheritance:r /grant:r "*${ownerSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
# Obtain/place the existing App PEM outside Git and protect its directory/file.
# Replace all placeholders with facts from App settings and the selected installation:
awh github-app connect --app-id <numeric-App-ID> --slug zlpoot-awh-builder --key 'C:\OwnerSecrets\builder.pem' --repos owner/private-sandbox --reviewer zlpoot --confirm
awh github-app status
awh github-app preflight --repo owner/private-sandbox
```

The CLI inspects ACL ownership and allowed principals on the configuration/key; it does not change the key ACL. Unix test/development environments require owner-only file permissions. Redirected paths, paths inside Git, invalid keys, missing credentials, wrong installations, scope drift, unavailable GitHub facts and excess/expired token permissions fail closed. `status` is local only (`CONNECTED_LOCAL` is **not** a live PASS). `preflight` uses metadata/read calls and ephemeral token issuance; it performs no branch/PR writes and never changes installations.

The saved file is `%LOCALAPPDATA%\AWH\github-app\connection.json`. It contains App ID/slug, discovered installation ID, selected repository names/IDs, verified Bot and trusted personal Reviewer id/login/type, and an external PEM path. It contains no PEM, JWT or Installation Token. Existing connections are never silently overwritten. Keep the file and directory under Owner control; reconnecting a different App requires an explicit Owner decision, and existing queue bindings refuse changed identities. There is no configuration in `.awh/flow.json`, ordinary Git settings, CP or source. Later queues reuse this file without credential input.

## Bind and deliver

From a new repository queue, use the existing Local Fast commands:

```powershell
awh local-fast bind --repo owner/private-sandbox --issues 1,2 --provider github-app --confirm --check 'pnpm typecheck'
awh local-fast flow next
Set-Location '<returned worktree>'
# Codex CLI edits source; AWH Stage owns Commit, focused verification and delivery.
awh local-fast stage execute --title 'Implement Issue #1' --body '<UTF8-description-file>' --message 'Implement Issue #1'
```

An existing personal binding, including a completed historical queue, cannot be converted by this command. It refuses to overwrite state. Stage records `coding_executor` and `delivery_actor` independently, without changing Git commit authors. The regular Owner `gh` login still reads queue/check facts and, only within the saved Watcher scope, performs authorized merge. **App mode exclusively uses App Installation Tokens for push, Draft PR create/update and delivery readback.** App failure never invokes a personal write fallback.

Each operation mints a fresh short-lived token restricted to one saved repository ID. Push asks only for Contents: write; PR writes ask only for Pull requests: write; PR readback asks only for Pull requests: read (Metadata: read is included by GitHub). Complete installation inspection uses metadata-only access. Responses must match the requested exact permission set, repository ID/name and valid expiry. Git sends a temporary authorization header in the Git subprocess environment to a fixed GitHub HTTPS URL; no token is put in arguments, saved remotes, helpers, environment files or logs. Transport disables inherited global/system config, interactive prompts, credential helpers and hooks; unsafe local/worktree transport or process-launch configuration is rejected. Git errors and HTTP response diagnostics are suppressed.

PEM and JWT remain in the trusted Provider closure. The Codex child environment strips App/GitHub credential variables; its prompt and logs contain no credential references. Verification children also strip credential variables. This is not strong isolation between processes running as the same Windows OS user: that user can read their own protected files. Use distinct OS identities if stronger isolation is required.

## Bot readback and independent Review

AWH authenticates `/app`, discovers `/repos/{owner}/{repo}/installation`, completely inspects the selected set, then resolves `/users/{slug}[bot]`. The returned **Bot user ID** is saved separately from App ID and installation ID. Every accepted PR must have the saved Bot `user.id`, exact login and `type: Bot`, same repository IDs, issue branch, main base, marker and exact candidate HEAD. Both the App transport and Stage confirm native branch/PR readback; a create response alone does not mean delivery passed.

App mode accepts only the saved trusted personal Reviewer's `user.id/login/type: User`. The latest effective native `APPROVED` or `CHANGES_REQUESTED` decision must have `commit_id` equal to the current PR HEAD. Author/Bot reviews, other accounts, `COMMENTED`, dismissed reviews and stale HEADs do not open PASS. A changes request repairs the same PR; Stage can return a ready PR to Draft through one fixed GraphQL mutation. Every new HEAD needs a fresh native Review. The personal provider retains its existing comment compatibility.

The optional Watcher uses the existing separately confirmed external scope, expiry, exact finite queue, `allow_merge`, GitHub checks and single native closing Issue. It rechecks Review and HEAD before merge and advances only after native merge/Issue closure readback. This connection adds no merge authority. Independent ChatGPT Review can use the native GitHub UI/connector as the saved personal account; the local Review Bridge also checks that account when an App binding is available.

## Interrupted operations and acceptance boundaries

Failed push, network failure or missing readback retains the committed candidate and local logs. Stage retries use the same branch/PR and never force push. Before PR creation Stage persists a create-attempt marker; after any uncertain ACK it searches the exact branch and reconciles one valid PR. If none is visible, it reports `local_fast_pr_ack_unknown` and refuses automatic recreation. Preserve state, inspect GitHub and restore read access; do not delete the marker to replay a write. Multiple, wrong-author, closed or unexpected-head PRs block recovery.

Offline injected tests cover the provider and Stage path. A missing local connection means live preflight is **NOTRUN / OWNER_CONNECT_ONCE**, not PASS. Creating a real private Sandbox, changing App installation scope and first Bot write E2E require explicit Owner authorization naming that repository. Product code Draft PR publication is separate from Sandbox E2E and production deployment. Stop product delivery at `AWAITING_INDEPENDENT_REVIEW`.

GitHub references: [installation token scope and expiry](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [App identity and installation APIs](https://docs.github.com/en/rest/apps/apps), [native PR Reviews](https://docs.github.com/en/rest/pulls/reviews).
