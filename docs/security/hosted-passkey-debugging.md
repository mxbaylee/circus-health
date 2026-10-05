# Debugging hosted passkey reports

This supplements the [hosted checker contract](hosted-passkey-checker.md). It concerns the fictional GitHub Pages checker only. Real Circus Health enrollment, unlock, server verification and the shared production PRF helper are unchanged.

## What this iteration supplies

The downloaded report still uses schema 3 and per-attempt build/environment snapshots. In addition to native name/code, operation, stage, PRF shapes and lengths, credential-match booleans, focus/activation and timing categories, native failure diagnostics describe:

- Whether `message` and `stack` were absent, text, non-text, or inaccessible; available text has an exact JavaScript character count.
- Whether a cause value was present, absent or inaccessible. Cause contents and relationships are not inferred.

These are **availability indicators, not the original message, stack or cause**. A text stack with a nonzero count means the browser supplied text that this report does not include; it must not be diagnosed as a browser lacking stacks. Missing new diagnostic fields on an older attempt mean unobserved, not false. Error property inspection cannot replace the original exception or invoke arbitrary object serialization.

The browser parser retains advertised Android, iOS/iPadOS, macOS and Windows NT version tokens where available. Every OS-version value visibly says it is a user-agent hint that may be frozen. NT 10.0 is not labelled Windows 10 or Windows 11. Desktop-mode iPad identification and exact device releases are not inferred. An operator correction takes precedence under the existing snapshot rules. Password-manager name/version remain operator-supplied; browser attachment and capability flags do not identify a manager.

The checker build now includes JavaScript source maps with source content and the existing `build-info.json` revision. Publication validates map/script pairing and the same public source scope used by the bundle. Unrelated source files, local reports, runtime state, symlinks, external source roots and orphan maps remain refused. Source maps describe public code, not browser errors, credentials or runtime state.

## Investigate an uploaded report

Start with the failing attempt's exact build, operation, stage, default/experimental request mode and recorded browser/OS/provider labels. Do not substitute the report's final labels for an earlier attempt with unknown or different labels.

| Report boundary | Next code/evidence to inspect |
| --- | --- |
| Native create throws/rejects | `core.ts` creation options, exclusion count, required resident key/verification, native error category, invocation context and known prior A. Duplicate refusal remains a hypothesis unless established. |
| Native get throws/rejects | Confirmation versus fresh-use request, selected credential restriction and transport hints; distinguish native refusal from later validation. |
| Returned credential mismatch | Exact allowed-ID construction and returned-ID comparison. Never make B pass by accepting A. |
| PRF absent or invalid | The exact stage/validation rule, extension/results presence and output representation/length. Missing bytes are not a decoder representation. |
| Fictional decryption fails | Retained credential/salt/ciphertext associations and changed PRF output, without assuming successful registration established compatibility. |

Use the revision's source maps to map an independently available generated JavaScript location to its source file and line. Match the map to the exact script filename and build revision; the currently hosted map may belong to a later deployment. Generated `gh-pages` history retains past published assets. Source maps do not reconstruct an exception whose text/location was never captured.

## Deliberately not shipped

The owner's earlier request for all browser-exposed objects was narrowed to the best independently deliverable improvements after report-integration writes were blocked. This iteration does not export original error messages, stacks, cause chains, invocation stacks, raw credential/request bodies, PRF bytes, keys, or general page-event recordings. The unused broad serializer was removed rather than merged as though integrated. Original-error export remains an explicit unresolved diagnostic gap, not a privacy requirement newly imposed by the owner and not proof that the current report will explain every failure.

No automatic password-manager detection, recovery of browser/provider-internal stacks, or unsupported-provider verdict is promised. The useful next work is driven by a report's concrete missing signal, not speculative capture of everything on the page.

## Update, testing and continuation

After merge, run the existing reviewed-main Pages publication workflow and verify its displayed revision before physical tests. Merge and build validation alone are not publication. Reload retains the current round and earlier attempt labels; it does not retrospectively add observations. Existing old records remain readable by the new build. Older checkouts may reject rows containing new optional diagnostics and must not silently replace them with an empty run. Export before rollback or deliberate reset. Provider passkeys are unchanged.

Focused regressions cover scalar error inspection, hostile getters and original exception identity, synchronous invocation, report output and OS hints, plus source-map pairing, module scope and deterministic real builds. Existing real-browser storage/controller tests remain required; controlled credentials do not establish physical provider compatibility.

[CRS-236](../todo/CRS-236.md) stays open. Inspect new reports, fix evidenced checker defects or improve a specific missing signal, and preserve unresolved physical findings. Do not repeatedly loop on processed reports or blocked original-error export when no supported in-scope work remains; proceed to the next eligible backlog item. The separate CRS-163 and CRS-088 qualification holds remain.
