# Agent Workflow Hub

Windows sequential Issue development: [M1 Fast Flow Quick Start](docs/windows-fast-flow.md). Use `awh flow init --issues 1,2,3`, then `awh flow next` under the existing protected project/task launcher.

AWH is a Human-gated development workflow toolkit. It connects repository identity, an approved Profile and Work Item, a local executor, Control Plane Run/Event records, and GitHub App delivery. GitHub remains the source of truth for code, Review and merge. Builder verification is not independent Review.

The Node.js 24+ / TypeScript / pnpm single package contains Protocol, SQLite Control Plane, Client/Resident, Dashboard/Viewer, Project Enrollment and an App-only Builder. Repository identity in a project manifest does not grant execution or Provider authority. There are no built-in business repositories, developer Issue mappings or machine defaults.

The [develop-to-pr Stage contract and Codex adapter](docs/develop-to-pr.md) provide one controlled entry through Draft PR, exact-head Evidence, confirmed Handoff and acknowledged CP Run/Event facts, then stop for independent Review. Managed same-PR revisions require a separate exact old/new HEAD authorization.

## Build and verify

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

The build removes its own previous dist output before compiling, so deleted modules cannot remain in packages. Tests use isolated synthetic projects and temporary databases. `pnpm dashboard:fixture` displays an explicitly labelled simulated dataset; it is not a deployment.

## Fresh installation

Start with a new external deployment directory, database, credentials, machine home and approved configuration. See [configuration](config/README.md), [Control Plane](docs/control-plane.md), [Client](docs/client.md), [Project Enrollment](docs/project-enrollment.md) and [Viewer](docs/windows-product.md). Normal startup requires the current schema and does not migrate or seed an existing database.

`pnpm release:pack --output <new-directory>` builds Client, Control Plane, Viewer and Builder Node tarballs plus the UI ZIP from one clean HEAD in one controlled build. The structured version map, Release Manifest, SHA256SUMS, archive verifier and PowerShell 5.1/7 installation/stop/recovery instructions are described in [Windows release kit](docs/release-windows.md). `pnpm release:validate <kit> --expected-head <sha>` verifies the actual archives; `pnpm release:smoke <kit> --expected-head <sha> --evidence <new-directory>` performs isolated Windows acceptance. These commands do not publish to a registry, install a service, create a GitHub Release or upgrade an existing deployment. The individual `client:pack`, `viewer:pack` and `ui:pack` commands remain available for component development; use the unified command for a release kit.

## Approved delivery

The administrator explicitly provisions a protected external Builder policy and its independent SHA-256 pin in the launcher environment. The loader has no repository discovery or policy fallback. CP and Builder policies must agree on version, repository, base, branch, ordered checks and executor/machine restrictions. See [Builder policy](docs/builder-policy.md), [delivery](docs/delivery.md), [repeatable tasks](docs/repeatable.md), [revision linking](docs/link-revision.md) and [publication recovery](docs/publication-recovery.md).

The Builder verifies live App/Installation identity, the complete approved selected repository set and a single-target least-privilege token. It can publish a Draft PR, exact-head evidence and a confirmed Handoff. It cannot approve, review, merge, close an Issue, mutate workflows or administer repositories. A read-only Handoff check grants none of those rights.

`pnpm admin` provides the [local administrator CLI](docs/administrator-cli.md): reusable project/workflow policies, separately approved work items and stages, inspection, comparison, revocation and local interruption recovery. It uses the external administrator trust boundary and existing Builder/Journal. The actual final HEAD is bound at delivery; preparation never grants authority or performs Provider writes.

## Product boundaries

[Architecture](docs/architecture.md), [Protocol](docs/protocol.md), [Dashboard API](docs/dashboard-api.md) and [UI](docs/dashboard-ui.md) describe implemented contracts. The external Observe/Develop policy catalog remains distinct from Deliver authority. A complete project-management UI, automatic executor orchestration, a new-repository live end-to-end workflow and cross-machine release validation are not implemented or established by this cleanup. Deployment and independent exact-head Review remain separate gates.
