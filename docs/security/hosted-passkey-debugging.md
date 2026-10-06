# Debugging hosted passkey reports

This supplements the [hosted checker contract](hosted-passkey-checker.md). It concerns the fictional GitHub Pages checker only. Real Circus Health enrollment, unlock, server verification and the shared production PRF helper are unchanged.

## What each report supplies

Legacy A/B reports retain schema 3 and their original per-attempt build/environment snapshots. New [guided A/B/C](guided-passkey-checker.md) reports use schema 4 and an explicit `abc-v1` flow marker. Both retain native name/code, operation, stage, PRF shapes and lengths, credential-match booleans, focus/activation and timing categories. Native failure metadata describes:

- Whether `message` and `stack` were absent, text, non-text, or inaccessible; available text has an exact JavaScript character count.
- Whether a cause value was present, absent or inaccessible. Cause contents and relationships are not inferred.

The scalar fields are **availability indicators, not the original message, stack or cause**. A text stack with a nonzero count means the browser supplied text that this report does not include; it must not be diagnosed as a browser lacking stacks. A text stack of length zero is an empty string. Missing new diagnostic fields on an older attempt mean unobserved, not false. Error property inspection cannot replace the original exception or invoke arbitrary object serialization.

New guided native-create/get failures additionally preserve a bounded message excerpt through `message.ts`, the controller's changed-attempt save, strict IndexedDB validation/reload and the actual downloaded report. Only the named message property is read, with a 1,024-character maximum, original length and explicit redaction/truncation flags. Absent, non-text, inaccessible and empty text remain distinct. Known run/credential references, salts/ciphertext encodings, URLs, byte arrays, long opaque strings, controls and bidi characters are removed or replaced. Export revalidates and redacts again. This is a transformed excerpt, not complete or byte-for-byte native error preservation. It is not a guarantee of perfect de-identification of arbitrary text; review excerpts before sharing. No native credential/request payload, PRF output, key, ciphertext, stack text or cause graph is serialized. Older reports are not retroactively assigned missing text.

The browser parser retains advertised Android, iOS/iPadOS, macOS and Windows NT version tokens where available. Every OS-version value visibly says it is a user-agent hint that may be frozen. NT 10.0 is not labelled Windows 10 or Windows 11. Desktop-mode iPad identification and exact device releases are not inferred. An operator correction takes precedence under the existing snapshot rules. Guided runs collect labels before the first attempt and retain them for that run; a different provider should be tested in a separate run. Password-manager name/version remain operator-supplied; browser attachment and capability flags do not identify a manager.

The checker build includes JavaScript source maps with source content and the existing `build-info.json` revision. Publication validates map/script pairing and the same public source scope used by the bundle. Unrelated source files, local reports, runtime state, symlinks, external source roots and orphan maps remain refused. Source maps describe public code, not browser errors, credentials or runtime state.

## Investigate an uploaded report

Start with the failing attempt's exact build, flow, operation, stage, default/experimental request mode and recorded browser/OS/provider labels. Do not substitute the report's final labels for an earlier attempt with unknown or different labels. In guided runs A/B share a username and C changes it, while the user handle and display name stay constant. A sequential C success does not isolate naming as the cause: exclusions and provider state may differ by that point.

| Report boundary | Next code/evidence to inspect |
| --- | --- |
| Native create throws/rejects | `core.ts` creation options, exclusion count, required resident key/verification, native error category, bounded message if present, invocation context and earlier confirmed credentials. Duplicate refusal remains a hypothesis unless established. |
| Native get throws/rejects | Confirmation versus fresh-use request, selected credential restriction and transport hints; distinguish native refusal from later validation. |
| Returned credential mismatch | Exact allowed-ID construction and returned-ID comparison. Never make B or C pass by accepting A. |
| PRF absent or invalid | The exact stage/validation rule, extension/results presence and output representation/length. Missing bytes are not a decoder representation. |
| Fictional decryption fails | Retained credential/salt/ciphertext associations and changed PRF output, without assuming successful registration established compatibility. |
| Interrupted prompt | A native result was not retained. The provider might have created a credential whose reference never reached the checker; do not invent its identity or a successful enrollment. |
| Skipped or unavailable guided step | Preserve the operator skip separately from native failures. Missing credential prerequisites are not applicable, not passes. Check exact failure linkage and post-enrollment chronology before accepting recovery/final verification. |
| Download or local-storage failure | Retain the available report and storage warning. A download request does not prove a file was saved; another tab's state must not be overwritten or cleared. |

Use the revision's source maps to map an independently available generated JavaScript location to its source file and line. Match the map to the exact script filename and build revision; the currently hosted map may belong to a later deployment. Generated `gh-pages` history retains past published assets. Source maps do not reconstruct an exception whose text/location was never captured.

## Deliberately not shipped

The owner's earlier request for all browser-exposed objects was narrowed to independently deliverable improvements after report-integration writes were blocked. The guided flow now supplies bounded native-message excerpts, but does not export complete original errors, stacks, cause chains, invocation stacks, raw credential/request bodies, PRF bytes, keys, or general page-event recordings. The unused broad serializer was removed rather than merged as though integrated. Full original-error export remains an explicit unresolved diagnostic gap, not a privacy requirement newly imposed by the owner and not proof that the current report will explain every failure.

No automatic password-manager detection, recovery of browser/provider-internal stacks, or unsupported-provider verdict is promised. The useful next work is driven by a report's concrete missing signal, not speculative capture of everything on the page. A native UnknownError remains unresolved unless its evidence supports a more specific cause; an exclusion count or message length alone is insufficient.

## Update, testing and continuation

After a reviewed merge, the existing main-push Pages publication workflow starts automatically. Verify successful deployment and its displayed revision before physical tests; merge and build validation alone are not publication. Follow the [guided update and compatibility procedure](guided-passkey-checker.md#update-and-compatibility): new guided namespaces leave all earlier rounds intact, and reload resumes the current guided mode without retrospectively adding observations. Older checkouts cannot interpret guided rows and must not silently replace an incompatible store with an empty run. Export before rollback or deliberate reset. Provider passkeys are unchanged.

Focused regressions cover scalar error inspection, hostile getters and original exception identity, synchronous invocation, report output and OS hints, plus source-map pairing, module scope and deterministic real builds. Guided regressions add naming relationships, retained-ciphertext checks, repeated-failure linkage, skip/interruption handling and bounded messages. The controlled-browser guided journey checks actual IndexedDB reload, downloaded report bytes, failed-download refusal and export-before-clear behavior. Existing real-browser storage/controller and legacy tests remain required; controlled credentials do not establish physical provider compatibility.

[CRS-236](../todo/CRS-236.md) stays open. Inspect new reports, fix evidenced checker defects or improve a specific missing signal, and preserve unresolved physical findings. Do not repeatedly loop on processed reports or blocked original-error export when no supported in-scope work remains; proceed to the next eligible backlog item. The separate CRS-163 and CRS-088 qualification holds remain.
