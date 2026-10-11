# Repeatable approved Work Items

An administrator-approved issue_prefix workflow binds repository, base, version, branch prefix, ordered checks, allowed changed paths and Executor/Machine restrictions. A positive safe Issue number produces the exact canonical branch prefix+Issue. A frozen Task binding includes repository, Issue, branch, source SHA, Profile/version, Executor/Machine and a SHA-256 fingerprint. Arbitrary repository/base/branch/command overrides fail closed.

Deliver validates the open ordinary Issue with single-repository read scope before minting write authority, inspects the approved diff path allowlist and refuses a consumed branch/PR. Successful delivery keeps the original source, Journal, Evidence and confirmed Handoff. Consecutive Tasks reuse approved identity but retain distinct Run/Work Item/branch histories. A completed predecessor requires actual lifecycle reconciliation, not a CP self-report.

Verification-failure recovery retains the predecessor failed Run and byte-identical original history. It requires an unambiguous absent remote branch and same-branch PR with read-only inspection before the new exact candidate can proceed. It never deletes/reset-cleans original state. Publication uncertainty uses [publication recovery](publication-recovery.md), while updated candidates use [revision linking](link-revision.md).
