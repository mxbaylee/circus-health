# Guided hosted passkey username experiment

The Operator follows one downward-moving sequence: **Create A → Verify A → Create B with the same username → Verify B → Create C with a changed username → Verify C → Recheck A/B/C → Download → explicitly clear**. This is the `abc-username-v1` protocol in the standalone [hosted checker](hosted-passkey-checker.md), not a change to production authentication.

## What stays the same

All three credentials use the same fictional account user handle. A and B use exactly the same native username. C changes only that username; its display name remains identical to A/B. A/B/C are interface/report aliases, not suffixes inserted into each native username. Requests record boolean username/display-name/user-handle relationships without exporting those references.

The default requests creation-time PRF evaluation, as the current application does. Advanced settings retain a separate enable-only creation experiment. Every run keeps its PRF mode and operator-entered browser/provider labels fixed after starting. Changing mode selects another saved run, never changes the current run's request policy. Select that same mode again after reload to resume it. Keep the actual provider unchanged: the checker cannot detect whether a native picker used another store.

Required resident credentials and user verification, known-credential exclusions, per-credential salts and strict 32-byte PRF decoding remain. C excludes every previously created credential that the checker retained, including an unconfirmed one. Removing exclusions or changing the underlying account ID is not part of this experiment. A provider's refusal with an exclusion present is not automatically classified as an expected duplicate; native `UnknownError` remains unresolved.

This improves naming fidelity but is not an exact production-authentication replay. The checker uses browser-generated challenges, separate explicit gestures and exact-one-credential assertions; the application uses server verification and its own enrollment/unlock flow. The final individual checks are not the application's multi-credential picker. Its PRF decoder is shared and unchanged. This shorter sequence provides one confirmation and one final fresh use per confirmed credential, not the old three-use qualification count.

## Progress, failures and retries

Each native operation starts synchronously from its button gesture before the first await. Double clicks, concurrent saves and mode switches cannot start a second in-flight ceremony. There are no automatic native retries. Verification of an unconfirmed credential retries its original credential and salt with a fresh challenge; it never enrolls another credential to hide the failure.

Failed and interrupted additional creation attempts each introduce checks of previously confirmed credentials directly below that problem. Each recovery links to the exact creation attempt, rather than borrowing an older recovery pass. An interrupted creation may have made a provider credential even if the checker never received or saved it; the outcome remains unknown. Retry or explicitly continue without that check. Continue records a skipped operation with no native request and no automatic pass. Failure or skipping B does not prevent C.

At the final checkpoint, request each confirmed original credential and decrypt its original retained ciphertext with a fresh PRF output. No new ciphertext is written to make a failing recheck pass. Earlier confirmations/recovery checks do not count as final checks, and a later enrollment invalidates older final evidence. Missing or unconfirmed credentials are explicitly unavailable. A recovery branch that never applied is not presented as an unfinished required test.

The existing native-error, wrong-credential, absent/invalid PRF, encryption/decryption and storage classifications remain. Wrong credentials are rejected before reading their PRF output. Changed PRF output fails decryption without replacing the original evidence. Native `NotAllowedError` still cannot distinguish cancellation, timeout and refusal. Error availability/counts remain metadata only: this iteration does not implement the outstanding original-message/stack/cause-content export request.

## Download, clear and historical evidence

The current report download appears at the bottom and remains available for partial/failed runs and storage errors. Save or discard any unfinished note first. A successful download *request* is not proof of a saved file. The operator must separately acknowledge **I have saved this report** before **Clear this run** is enabled. Any newly saved evidence invalidates that acknowledgement and requires a new download. A failed download does not clear data or enable clearing. A failed reset is reported, never described as successful.

Clear resets only the selected active run. It does not remove provider passkeys or touch prior-round databases. The collapsed **Previous results** section separately exports the original A/B database and both `2026-10-05` A/B mode databases. Missing or unreadable history is disclosed, not invented, silently migrated or deleted. Synced passkeys do not synchronize browser-local reports.

## Update and compatibility

Guided rounds use separate `circus-health-passkey-checker-abc-username-v1-<mode>` databases. The existing IndexedDB layout/version 1 retains changed-only attempt/observation rows; the guided header explicitly adds protocol/mode, with C, final/recovery steps and operator skips allowed only in the guided protocol. Legacy runs retain their original fields and are exported using the legacy report semantics. New report schema 4 identifies the guided experiment and supplies a chronological operation summary, per-attempt provenance, exact recovery linkage and final coverage. It does not relabel old reports or turn skipped work into a pass.

Reload the newly published build and verify its revision. No manual data reset is required for adoption. Older builds use their own namespaces and cannot resume the guided protocol. This changes no household archive, real authentication, server configuration or provider credential. The existing [automatic publication procedure](hosted-passkey-checker.md#build-and-publish) remains unchanged; merge is not successful deployment until build/publish/deploy and hosted revision are verified.

## Interpretation and validation

This is a sequential diagnostic experiment, not proof that a username alone caused a provider outcome. Credential-store state and the exclusion list may grow before C, while provider identity remains an operator observation. Reports retain partial successes and failures. An all-three result requires each original credential's qualifying final recheck; completing the walkthrough with skipped steps is not an all-three pass.

State/core tests cover both PRF modes, exact naming relationships and exclusions, synchronous invocation/double-click refusal, same-credential retries, wrong-ID refusal before extension access, missing PRF, changed PRF, failed B with per-failure recovery, continued C, interrupted reload and fixed labels. Mounted tests cover forward recovery placement, unavailable steps, download failure, clear acknowledgement and stale export receipts. The real-browser fixture uses controlled credential ports but real cryptography, IndexedDB close/reopen and an actual report download, checking C retention and old-round preservation after reset. Fixture success is not physical provider qualification.

CRS-236 stays open for report-driven investigation. The **CRS-236 → CRS-163 → CRS-088** hold and all actual installation/backend/session/recovery/private-access/locked-refusal/Compose-recreation requirements remain. No new physical success, provider diagnosis, production-auth change, ticket completion or grooming increment is implied.
