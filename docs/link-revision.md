# Same-PR revision linking

Revision linking preserves the original Run source, Events, Session and Journal and adds a bounded verified candidate overlay for the same PR. Both the full approved-base→new-head diff and prior-head→new-head diff must remain inside the approved path scope. Exact approved Task/Executor/Machine bindings remain fixed.

The revision Provider mode has single-repository contents/Issue read plus PR-comment write scope. It cannot push, create/update a PR, mark Ready, submit Review, merge or edit old comments. The executor prepares the code commit and approved publication separately. A new revision receipt binds the actual remote ref, original/current candidate, exact evidence and confirmed Handoff.

An interrupted or uncertain publication consumes its receipt and blocks ordinary replay. Event ACK loss only retries the same Event. Revision Sync uses the effective new SHA and actual approved native Review, merge and Issue facts; an original-SHA approval cannot authorize the revised candidate. Retained records must not be replaced to bypass reconciliation.
