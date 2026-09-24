# Repository scope and handoffs

This repository must contain the information needed to understand the application, review changes and reproduce its controlled checks without access to private notes or another computer’s filesystem.

## Included and excluded content

The repository owns the [single application work list](application-todo.md), stable `CRS-###` identifiers, approved designs, maintained product and operational contracts, application source and independently fictional reproducible tests. Update the relevant reference with each contract change. Preserve open acceptance gates even when implementation is complete.

Health records, medical originals, credentials, OAuth state, recovery material, generated runtime databases, raw logs, screenshots containing private content and personal coordination journals are excluded. Fictional tests can still generate sensitive authentication or recovery artifacts. Review and redact evidence before including a concise finding in documentation or a contribution; do not copy raw evidence collections into the repository.

Dated reports preserve what was observed. Historical plans, failed runs and old assertions must not silently become current requirements or passing evidence. Keep enduring, nonprivate conclusions in the relevant maintained reference.

## Cross-computer handoff

Use an independent checkout on each computer and the normal reviewed Git transfer workflow. Uncommitted edits, ignored files and application credentials do not travel with a commit. Inspect source and destination working trees before switching; do not discard local changes or rewrite history merely to move work between computers.

Use repository-relative file paths and `CRS-###` identifiers in portable handoffs. Verify that the referenced files and prerequisites exist. Matching folder names do not establish identical source or state. Do not include personal absolute paths in public handoffs.

A useful handoff records:

- Application commit and relevant uncommitted changes; a built image or artifact identifier when that is what was tested.
- Task identifiers, resulting behavior, unresolved findings and the next concrete step, linking to the authoritative requirement rather than copying another status checklist.
- Toolchain, exact commands, date, fixture/provider scope and pass/fail/skip counts.
- Whether evidence is included, independently reproducible or unavailable to the reviewer. Do not treat unavailable evidence as a passing check.
- Interventions, cancellations and invalid test assumptions. Correcting a harness does not retroactively repair a failed run; a later valid run adds evidence.

Verify the current execution environment. Contributor checks use the Node version in [.nvmrc](../.nvmrc) and require qpdf for native-PDF checks; the supported application deployment remains npm → Compose → LiteLLM. Follow [installation](installation.md) for operator-configured data, credential and runtime boundaries.

## Validation decisions worth carrying forward

The following are maintained contracts, with detailed implementation and acceptance in the linked references:

- [PDF delivery](import-performance.md) prefers bounded original PDF pages after runtime proof for the exact route; same-page lossless PNG is the compatibility fallback. Static metadata and a successful text/tool request do not prove PDF capability.
- [Performance attribution](import-performance.md#observed-provider-slice-on-2026-09-23) separates upload, host work, provider-request waiting and review. Provider-request wall time includes proxy/network/upstream work and does not isolate model compute or establish that a desktop upgrade or different model will fix latency. Nested spans are not additive; partial measurements do not certify a complete import or causal cache savings.
- [Identity and reconciliation](import-reconciliation.md) refuse unsafe collisions while persisted-key migration and cross-member equivalence remain explicit open work. A controlled safety fix does not itself complete consolidation or reproduce a representative source-attribution complaint.
- [Provider acceptance](model-providers.md#completion-gates) distinguishes route capability, scripted continuation, autonomous whole-file extraction, explicit reviewed acceptance and recovery. Test through the actual application coordinator when qualifying automatic continuation. Keep fixture ground truth independent and retain protected failure evidence; do not weaken an oracle to improve a grade.

Current work is tracked in the [application work list](application-todo.md). This document creates no new provider-run authorization, deployment, migration or cleanup task.

## Publication and cleanup

Check uncommitted, untracked and ignored files before preparing a contribution. A byte count does not establish that an artifact is safe to publish or delete. Preserve accepted history and recovery authority; generated files can still contain unique evidence.

Publication must separately satisfy the existing history-cleanliness and release requirements in the [application work list](application-todo.md). This document does not authorize history rewriting, publication, data migration or cleanup.
