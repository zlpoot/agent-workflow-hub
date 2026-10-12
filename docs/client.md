# Client and Resident

[Windows Local Fast](windows-local-fast.md) uses `awh local-fast bind`, `local-fast flow next|status` and `local-fast stage prepare|execute` with existing personal Git/GitHub authentication. It is separate from the Strict configuration, CP and administrator grants described below.

[Windows M1 Fast Flow Quick Start](windows-fast-flow.md) covers new project setup, `flow init --issues 1,2,3`, `flow status`, `flow next` and sequential Codex delivery through independent Review.

The standalone `@zlpoot/awh-client` package exposes `awh`. Its component identity and version come from src/client/version.ts. Node.js 24+ and Git are required. Install a verified tarball into a fresh external directory; package installation does not create a CP, approve a Profile or run a business task.

The Client validates the real canonical Git root, local origin, HEAD/ref and minimal .awh/project.yaml identity. It rejects credential URLs, URL rewrites, unsafe includes/configuration, redirected paths and identity conflicts. The manifest contains apiVersion=awh/v1, project.id, project.repository and profile.ref only. A repository manifest grants no commands or Provider permissions.

Use explicit external configuration and a dedicated CP credential. The configuration binds schema_version=1.0, endpoint, credential_file, state_directory, executor_id, executor_type and an approved profile_version for delivery; optional public CA material enables verified HTTPS. The endpoint cannot contain credentials, paths, query or fragments. Loopback HTTP and verified HTTPS have no insecure fallback. A matching AWH_CLIENT_CONFIG is an alternative to --config; conflicting sources fail.

```powershell
awh --config '<external client.json>' register
awh --config '<external client.json>' status
awh --config '<external client.json>' resident start
awh --config '<external client.json>' resident status
awh --config '<external client.json>' resident stop
```

Machine identity is created once in the new external state directory. Executor/Project/endpoint namespaces keep distinct Sessions and Journals; normal restart and registration preserve identities. There is no old-installation identity import or database migration command.

Explicit start/event/finish commands write only approved runtime declarations. They do not create GitHub Issues or execute repository code. Deliver is a separate approved operation: [delivery](delivery.md). Event outboxes, locks, durable Journals, original exact source SHA and consumed Provider receipts protect retries and recovery. Do not reset a namespace to bypass an uncertain operation.

[Enrollment](project-enrollment.md) provides administrator-approved Observe/Develop setup without Provider authority. [Doctor](doctor.md) reads local facts by default; an explicit CP probe adds bounded authenticated reads. It is not verification evidence or independent Review.
