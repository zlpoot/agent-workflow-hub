# Doctor

Doctor reports passed, blocked and not_checked with bounded source provenance. It defaults to offline read-only diagnosis of the installed Client, actual Git origin/root/HEAD/ref, manifest, external configuration, machine identity, retained Session, pending Events and Journals. It neither runs verification commands nor claims delivery or independent Review PASS.

```powershell
awh --config '<external client.json>' doctor --json
awh --config '<same client.json>' doctor --json --probe-cp
awh doctor --machine-config '<external machine.json>' --directory '<real worktree>' --json
```

An explicit probe adds scoped authenticated CP GETs only. It does not heartbeat, repair, retry Events, rotate credentials or use a GitHub token. Installation metadata is comparison data; an independently supplied tarball digest remains a separate provenance check.

Approved Builder profiles come only from the administrator-pinned external policy. The separate approved Observe/Develop catalog can provide offline Work Item comparisons. Neither observations nor declarations elevate delivery authority. Missing source, policy/version/command/executor/machine disagreement or unsupported origin stays blocked/not_checked. Untrusted commands, secret contents, credential paths and upstream bodies are suppressed.

Doctor preserves retained source and pending state. Recovery or repair requires its own bounded operation and approval; diagnosis never resets or replaces identity to make a result pass.
