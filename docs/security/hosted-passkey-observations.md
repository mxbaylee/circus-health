# Hosted passkey observations

This register contains source-reviewed summaries of editable operator reports, not signed attestations or a universal compatibility matrix. Each observation is scoped to its actual build, origin, environment labels and completed steps. Raw reports and credential material remain outside Git. Earlier mobile findings remain in [CRS-236](../todo/CRS-236.md) and its historical evidence references.

## 2026-10-05 — Firefox / Android / Google Password Manager — mixed

Observation reference: `20261005-184144-226d398328d5`.

Source: owner-supplied `01-passkey-checker-report.md`, 13,928 bytes; SHA-256 `226d398328d5f8089a601bf69742154e329f9d7ee8b996fff1dd3bd4ac37451b`. This entry is a summary, not a copy of the original report. Run started `2026-10-05T18:41:44.446Z`.

The report records schema/tool version 3 and clean source revision `fc495cc1146824769e1e07af7881eda6771e8c11` on every attempt. Recorded origin is `https://mxbaylee.github.io`, RP is `mxbaylee.github.io`, and secure context was observed. Firefox 157.0 and Android are browser-reported hints. Google Password Manager is an operator label on every attempt; Android and provider versions remain unknown. Creation/confirmation use `eval`; fresh uses use `evalByCredential`. This predates the newer default/enable-only round selection.

### Automatic outcomes

All times below are on 2026-10-05 and in UTC; they are reported operation times, not independently verified timestamps.

- A was created at 18:42:03.673. Creation alone is not PRF qualification.
- A confirmation completed at 18:42:08.214, followed by three verified fresh uses at 18:42:11.807, 18:42:15.254 and 18:42:18.998. Each assertion matched the selected credential and returned a supported 32-byte PRF value; confirmation established fictional encryption/decryption and later uses decrypted the retained fictional value.
- B creation attempt 1 ran 18:42:34.149–18:42:36.343; attempt 2 ran 18:42:43.559–18:42:45.708. Both failed at `native-create`, with native name `UnknownError`, category `dom-name`, application code `unknown-error`, one excluded credential, 32-byte profile reference, and required resident credential/user verification. The PRF request input was a 32-byte array buffer. The report does not contain the native message, stack, cause, numeric error code or invocation-outcome/focus metadata.
- The fresh-A recovery check at 18:42:49.516–18:42:51.600 is explicitly linked to B creation attempt 2. It matched A, obtained fresh 32-byte PRF output, and decrypted A's original fictional value. There is no separate recorded recovery check linked to B attempt 1.

B confirmation and all three B fresh uses remain unfinished. A-after-successful-B is also unfinished because B was never created. The separate manual observation at 18:43:05.230 is Couldn't test, with the note “It wouldn't let me create a second key”; it does not supply a native error message or override automatic results.

**Disposition: mixed / partial.** A's confirmation, three fresh uses and retained access after the latest B failure are positive hosted observations. This is not a two-credential pass. A native `UnknownError` does not establish duplicate exclusion, cancellation, a decoder defect, universal provider incompatibility or a successful fix.

### Build comparison and continuation

At intake, inspected main was `39c4d919efd1f63f781869c0efdd761a9bc6fb8f`, three commits after the tested revision. The latest successful [checker publication run](https://github.com/mxbaylee/circus-health/actions/runs/37216613630) and the read-back `gh-pages/build-info.json` identify the tested `fc495cc1` revision. Direct hosted HTTP retrieval was unavailable in the intake environment; branch/deployment metadata is not a claimed independent browser visit.

Newer merged instrumentation includes invocation context, error-property availability/counts and source maps, but still does not export original exception contents. This report cannot be treated as a test of those later changes or the enable-only experiment. It adds a new run to the existing Firefox/Google finding, not a newly established root cause or a duplicate of the original schema-1 report.

[CRS-236](../todo/CRS-236.md#new-report-2026-10-05) owns the next engineering action, missing signal and targeted retest. Preserve previous reports and provider credentials. The separate **CRS-236 → CRS-163 → CRS-088** hold remains: this hosted observation does not qualify localhost enrollment/unlock, production backend/session verification, real profile recovery, private/original access, locked refusal or Compose recreation.
