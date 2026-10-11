# Approved Observe/Develop catalog

The separate external catalog provides immutable versioned Profile templates and Work Items for Observe/Develop comparison and Enrollment. An explicit administrator trust anchor pins fixed sibling profiles.json and approvals.json bytes and binds operator/source, timestamps, versions, fingerprints and supersession. It is outside every repository, bounded and protected by the administrator.

Each approval must match its exact immutable object fingerprint; unknown versions, conflicts, duplicated/missing approval entries, source/pin mismatch, expired Work Items and out-of-template facts are rejected. Templates constrain repository/base/branch prefix, Executor and checks. Ordinary project configuration, CP observations and manifest/Issue declarations cannot become approvals.

Doctor and Enrollment compare current facts and report blocked/not_checked where authority cannot be established. This catalog supports Observe/Develop only. It does not grant Deliver or Provider writes. The pinned Builder policy is the separate Deliver trust source and Client requires exact agreement with its CP Profile. A unified cross-component administration/version-distribution system and persistent anti-rollback service remain future work.
