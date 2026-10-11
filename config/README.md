# Canonical configuration

All examples are inert fictional data. Nothing in this directory is automatically loaded. Real configuration, SQLite, identity, journal and credential files belong in an administrator-controlled directory outside every Git repository. Provision owner-only ACLs on Windows and owner-only modes on Unix. A project manifest is identity data only.

| Component | Approved source / entry |
| --- | --- |
| CP | `control-plane init` or `control-plane serve --runtime-config <external-runtime.json>`; explicit schema_version, database, trusted_config_file, port and optional https_config_file |
| CP trust | Protected external clients/profiles and enrollment grants; Profile versions are immutable and startup cannot add or replace them |
| Client | Explicit `--config` or one matching AWH_CLIENT_CONFIG; dedicated CP credential and external state directory |
| Enrollment | `awh setup --machine-config …`, administrator-approved root scope; Observe grants registration and presence only |
| Viewer | `viewer --config <external-viewer.json> [--owner-config <external-owner.json>]`; current CP database read-only, explicit local browser scope |
| Builder | AWH_BUILDER_POLICY_FILE plus independently approved AWH_BUILDER_POLICY_SHA256 in the protected launcher; separate AWH_GITHUB_APP_ID / private key path |
| Handoff | `handoff:check <file> --expected-head <40-character-SHA>`; read-only declaration validation |

CP `init` exclusively reserves a new database file and initializes the current schema in one transaction. `serve` checks the exact schema, immutable Profile versions and Project identity before writable startup. Historical flags, static seed tools and schema migrations are absent. The existing database check does not prove that an operator-controlled replacement database is authentic; protect the deployment directory.

Deployment paths reject relative/dot traversal paths, symlinks and repository ancestors. HTTP is IPv4 loopback only; optional native HTTPS uses an explicit private IPv4 interface, current IP SAN and matching private key. Client endpoint and CA checks have no insecure fallback. Viewer browser cookies are separate from CP Client credentials.

The Builder has no built-in repository, branch, Issue, Executor, Machine or selected-set whitelist. All such grants come from the separately approved policy; an unknown repository or changed pin fails closed. Its Provider methods remain bounded regardless of policy content. See [policy schema and provisioning](../docs/builder-policy.md).

JSON schemas under schemas/ describe the canonical shapes. The runtime additionally validates paths, byte limits, identities, duplicates, fingerprints, policy agreement and live Provider permissions. Examples do not grant authorization.
