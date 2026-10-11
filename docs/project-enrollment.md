# Project Enrollment

Enrollment connects an actual local Git worktree to an approved CP Project/Executor identity. Setup declares protected machine home, installed Client digest, approved project roots, endpoint and optional Observe/Develop policy trust. It creates a new Machine identity; configuration conflicts are never overwritten.

The current Viewer “添加项目” flow browses only approved roots, inspects repository identity, previews the request and requires Human confirmation. The request creates dedicated external credential/request material, not a business Run or GitHub task. Observe is the default; Develop requires a separately approved Work Item in the external catalog. Empty or mismatching policy lists cannot authorize Develop.

CP-owner approval uses the explicit local entry:

```powershell
pnpm control-plane approve-project --request '<external request>' --database '<current CP.sqlite>' --config '<protected CP trust.json>'
# After the administrator reviews the preview:
pnpm control-plane approve-project --request '<same request>' --database '<same CP.sqlite>' --config '<same trust.json>' --confirm
```

The optional local Viewer owner-config invokes the same bounded approval with native confirmation. Both approve an immutable dedicated enrollment grant and single Project/Executor scope. They do not write SQLite, widen an existing credential, grant Deliver or start a business Run/Event. The CP revalidates its protected enrollment snapshot before use while Workflow policies remain fixed during service startup.

Completion validates grant/request/credential agreement, creates missing minimal manifest and external project configuration, registers Project/Executor and starts presence. Conflicts preserve original files and identity. Repeated completion is bounded and idempotent. Each worktree has separate Executor/Client scope; shared repository identity does not collapse machine or credential boundaries.

Doctor is read-only by default; explicit CP probe is authenticated GET only. Repair first presents a bounded plan and requires separate confirmation; it can recover missing enrollment files and registration/presence without deleting business history or retrying Provider operations. See [Viewer guide](windows-product.md) and [Doctor](doctor.md).
