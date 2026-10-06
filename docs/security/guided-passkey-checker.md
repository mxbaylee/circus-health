# Guided A/B/C passkey diagnostics

The [Operator](../design/personas.md#operate-and-recover) follows one downward sequence in the [hosted checker](hosted-passkey-checker.md): create A, verify A, create B with the same username, verify B, create C with a changed username, verify C, then recheck each original credential before downloading and clearing. This is a fictional compatibility experiment, not application release qualification.

## Names and request scope

A and B send the same native `user.name`, `fictional-<run>`. C sends `fictional-<run>-renamed`. All three retain the same opaque `user.id` and the same native `displayName`, `Fictional compatibility test`. A/B/C are interface/report aliases, not three different accounts. Only the username relationship changes; the run ID itself stays out of the report.

The default creation request uses `prf.eval`, matching the app's current creation-time PRF choice. The collapsed advanced option retains the enable-only experiment, `prf: {}`, in its own saved run. Both modes still use `eval` for exact-credential confirmation and `evalByCredential` for fresh use. Exclusions, required resident credentials, required user verification, strict 32-byte decoding and exact returned-credential refusal remain. The unchanged production PRF helper is reused.

This is not complete app-request parity: the checker uses its hosted origin, fictional labels and client-generated challenges, and requests one exact credential for each check. The app has backend challenge/signature verification, profile sessions, key wrapping and a multiple-credential unlock picker. None are simulated into a physical pass here. A changed profile label is not a changed user handle. The specification distinguishes these fields in the [WebAuthn user entity](https://www.w3.org/TR/webauthn-3/#dictdef-publickeycredentialuserentity).

Keep the browser, provider and creation mode consistent within a run. Environment labels are entered before the first attempt and retained per attempt; unknown versions stay unknown. Switching advanced mode resumes a different saved run, never combines credentials from different runs into one pass. Provider synchronization and storage are not detected by an attachment hint.

C is a sequential naming experiment, not a controlled proof that names caused success or failure: by its creation, the provider's state and exclusion list may have changed. A duplicate refusal is a possibility, not an automatic explanation for UnknownError. No exclusion is removed to obtain a green result, and a distinct credential does not prove an independent authenticator.

## One forward path, including failures

Each native action requires its own button click. The next action receives focus after its predecessor and save finish; no automatic native prompt is started. Completed rows stay above the next step. New operations are refused while a prompt or save is active. A failed confirmation retries the existing credential and salt, never silently creates a replacement.

Creation alone does not pass encryption compatibility. Verify obtains fresh PRF output for the exact credential and encrypts/decrypts a fictional value. Final rechecks happen after the complete enrollment sequence and decrypt each credential's original retained ciphertext, rather than replacing it with a newly encrypted value. This shortened sequence establishes confirmation and a final fresh use, not the earlier three-fresh-use protocol or any real release gate.

When B or C creation/confirmation fails or is interrupted, fresh checks of previously confirmed credentials appear immediately below that failure. They are linked to that exact failed attempt. A later failure requires new checks; old recovery cannot pass it. The operator can retry or explicitly continue after recording a skipped check. B failure does not block trying C. A credential that was not created or confirmed has an explicit unavailable prerequisite, never a pass disguised as completion.

Reloaded pending operations are marked interrupted. A provider might have created a credential before its reference reached the page; the checker cannot invent that reference or claim enrollment succeeded. Retrying is a new attempt. Wrong-credential replies stop before PRF extraction, unusable PRF representations remain refused, and capability flags alone never pass encryption.

The complete attempt history retains failures and skips even after a retry succeeds. Skipped is an operator decision, not a native success. An unused failure-recovery branch is not applicable, rather than a misleading unfinished requirement. Storage conflicts stop testing and clearing; download available evidence before reloading. Unavailable or incompatible storage offers explicit unsaved testing without erasing the unreadable store.

## Native failure messages

For new guided native-create/get failures, the controller retains a bounded message excerpt through changed-row storage, reload and the actual report export. Only the named message property is read; no native payload, arbitrary serializer, cause graph or stack contents are traversed. The excerpt is limited to 1,024 JavaScript characters and reports its original length, absent/non-text/inaccessible state, and redaction/truncation flags. An empty string is distinct from a missing message.

Known run/credential references, salts and ciphertext encodings, URLs, byte arrays, long opaque strings, controls and bidi characters are removed or replaced. The export repeats validation and redaction. This is a transformed diagnostic excerpt, not byte-for-byte original-error preservation or a promise that arbitrary text can be perfectly de-identified. Review excerpts and notes before sharing; do not put health information or secrets in them. PRF output, keys, native credential/request objects and actual ciphertext stay outside reports and Git. Existing name/code/stage/focus/timing metadata remains; messages do not establish a provider cause by themselves. Legacy reports are not retroactively given missing text. See the [debugging guide](hosted-passkey-debugging.md).

## Download, acknowledge, clear

The bottom section has one current-run download button. It can export partial evidence; unsaved notes must first be saved. Previous results live in a separate collapsed section with explicit original/default/enable-only round choices. A previous-round download never satisfies the current-run clear gate.

Download requests do not establish that a file reached disk. After checking the saved report, the operator acknowledges it and explicitly clicks Clear this run. Any changed attempt or saved observation invalidates that exported snapshot and requires another download/acknowledgment. A failed download, in-progress operation/save, conflict or unsaved note cannot enable clearing. Reset failure preserves available evidence and displays a storage warning.

Clear resets only the selected mode's guided run. In unsaved mode it clears only that tab's memory, not an unreadable persisted run. It never deletes prior-round databases, another mode's results, previously downloaded files or passkeys from the provider. Provider deletion remains a separate manual action.

## Update and compatibility

Reload and verify the deployed source revision. Guided stores append `-abc-v1` to the existing mode-specific round database name. The original database and the October 5 default/enable-only databases remain untouched and separately exportable. Guided run headers carry `flow: abc-v1` and their fixed creation mode; they retain IndexedDB/run format 1 with additional strictly validated fields. Guided reports use schema 4, while legacy exports retain schema 3. Tool build version 3 is unchanged; use source revision, flow and report schema together.

New code reads legacy runs without inferring C, skips, username relationships, final rechecks or native excerpts. An older build cannot interpret guided shapes and uses its prior namespace. Rollback does not merge histories or make the new run readable by older code. Export before a deliberate clear or rollback; normal browser eviction/private-session limits still apply. No household archive, production authentication or operator configuration changes are made.

## Validation and remaining evidence

`guided.ts` supplies the ordered controller/UI/report contract. `passkey-checker-guided.test.ts` covers both PRF modes, equal A/B and changed C names with stable identity/displayName, exclusions, synchronous invocation, original ciphertext, failure/retry/skip linkage, interruption, wrong IDs, strict PRF validation and bounded messages. `browser/passkey-checker-guided.test.ts` uses the actual UI, IndexedDB, cryptography and downloaded file in a narrow Chromium viewport with an explicitly fictional credential port; it verifies reload, failed downloads, stale-export refusal, clear acknowledgment and preserved previous-round data. Those controlled fixtures are not physical observations.

Complementary `passkey-checker-guided-consolidation.test.ts` regressions cover duplicate clicks, locked labels, wrong-ID/missing-PRF confirmation retries with fresh challenges, changed-output decryption refusal, stale final/recovery evidence and interrupted B reload. The mounted guided tests cover forward recovery focus, download failure, acknowledgment invalidation and unsaved-note mode guards. Browser fixtures load the real styles with native stylesheet links and mount explicitly without the Vite development client; assertions require styles before and after reload, no development-client requests or WebSockets, and no page errors. Download checks exclude both raw and Markdown-escaped credential material.

Existing legacy, source-map, publication, store and real-build checks remain required. The reviewed-main publication workflow continues to deploy automatically after merge; a branch update or passing fixture is not a successful Pages deployment. Verify the deploy job and hosted revision before another physical run.

[CRS-236](../todo/CRS-236.md) remains open for new reports and exact missing signals. The CRS-236 → CRS-163 → CRS-088 hold, actual localhost enrollment/unlock/recovery/private-access/locked-refusal/Compose-recreation checks, and later sign-in/salt-migration qualification remain unchanged. No Google/Proton cause or new physical-provider fix is claimed by this flow change.
