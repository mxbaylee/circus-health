# Hosted passkey compatibility checker

The [Operator](../design/personas.md#operate-and-recover) uses the [hosted checker](https://mxbaylee.github.io/circus-health/) to collect browser, operating-system and passkey-provider observations with fictional material. The standalone static site runs entirely in the browser, without a Circus Health server, Docker, LiteLLM or health profile. Its reviewed publication procedure is below.

## Use the checker

1. Open the page manually in the actual browser being tested. Reload and verify its displayed revision before collecting results. Native operations require valid HTTPS and a secure context.
2. Review browser/OS names and versions and enter the actual provider/version where known. Browser hints are not proof of provider identity; unknown stays unknown. Check labels again before switching authenticators.
3. Use **Existing request (default)** first. Create A, confirm it with a separate native prompt, then complete three fresh uses. After failed confirmation, retry confirmation of that same created credential rather than creating it again. Each attempt preserves its failure or success.
4. Create distinct B with another available authenticator where appropriate, confirm it and complete three uses. A/B share the fictional profile's stable user ID; their native display labels differ. A provider already holding A may reject B because A is excluded. Keep A rather than dropping exclusions or deleting a working credential. Synced copies and different labels do not establish independent authenticators.
5. Use **Use A after B creation fails** after each failed B creation. After B is actually created, use **Use A after B is created**, even when B cannot confirm. These are fresh PRF/decryption checks; earlier A results do not complete them.
6. For a targeted compatibility investigation, explicitly select **Experiment: enable PRF, evaluate at confirmation**. This uses a separate saved fictional run, not another credential for the baseline profile. Test A and B within that mode and export each mode separately. This experiment is not an established Proton or other provider fix.
7. Download the report even if incomplete or failed and upload it for investigation under [CRS-236](../todo/CRS-236.md). Add secret-free manual observations, including the screen/field and expected versus actual format for visible format errors. Manual Worked never overrides automatic failure or unfinished coverage.

No virtual authenticator, credential API override, paid device cloud or TLS bypass constitutes physical qualification. Controlled development fixtures remain separate. The page does not upload reports: its content security policy forbids application network connections, while static assets are fetched from Pages. Provider synchronization is controlled by the provider.

## What the evidence establishes

Automatic hosted success means the returned credential matched the requested credential, actual PRF output was a supported 32-byte value, and the fictional value was encrypted/decrypted and compared. Each later use obtains fresh PRF output and decrypts the retained ciphertext. Creation, capability flags and signatures alone are not PRF compatibility. There is no backend challenge/signature/origin verification or profile/session authorization in this checker.

The RP domain is `mxbaylee.github.io`, not localhost. The project path `/circus-health/` is not an independent origin/RP boundary from other projects on that host. Changing hostname requires new enrollment. Hosted observations do not adopt remote household deployment or establish actual installation access.

[CRS-236](../todo/CRS-236.md) retains report intake and unresolved physical/provider findings; the operator will supply additional combinations and results. Builders debug new errors or improve the missing safe evidence. Once actionable engineering is exhausted and no unprocessed reports exist, they skip this ticket while awaiting new results. Historical ambiguity is not a provider disposition. The separate **CRS-236 → CRS-163 → CRS-088** qualification hold remains: localhost enrollment/unlocks, backend verification, sessions, real recovery, private/original access, locked refusal, Compose recreation and each available credential independently unlocking the same real fictional profile still need their own evidence. CRS-088 also retains later sign-in and salt-migration requalification.

## Production reuse and deliberate differences

The checker imports the unchanged production [`withBinaryPrf` and `prfFrom`](../../src/app/components/passkey-prf.ts). Strict 32-byte buffers/views, canonical base64url and complete plain-byte-array handling remain, including the working 1Password accommodation. Missing output cannot be fixed by permissive decoding. A mismatched credential is rejected before accessing its PRF output.

Both modes retain required resident credentials, required user verification, no attestation, known-credential exclusions, bounded optional transport hints, per-credential salts and exact selected-credential confirmation. The default creation request still supplies `prf.eval`. The opt-in experiment supplies `prf: {}` during creation, enabling the extension without asking for the optional creation evaluation. WebAuthn specifies optional creation inputs and mandatory separate authentication when outputs are unavailable; see [PRF extension](https://www.w3.org/TR/webauthn-3/#prf-extension). Confirmation in both modes still uses `eval`; fresh uses still use `evalByCredential`. No flag alone substitutes for successful encryption/decryption.

The experiment is a bounded hypothesis about request compatibility, not a diagnosis of the original Proton failures. Those failures occurred during `eval` confirmation and cannot establish an `evalByCredential` defect. The original wrong-ID and missing/invalid-PRF errors remain distinct. Changing mode does not prove a provider fix or permit mixing two different fictional profiles into a two-credential pass.

`RoundApp.tsx` binds the selected mode to the existing controller's native create operation; it does not override `navigator.credentials` or inject synthetic physical results. The production [enrollment](../../src/app/components/passkey-enrollment.ts), [unlock](../../src/app/components/passkey-unlock.ts) and [server wrapping](../../src/server/profile-passkeys.ts) flows are unchanged. Browser-generated checker challenges and HKDF-SHA-256/AES-GCM fictional encryption do not qualify their server/session/recovery contracts.

## Browser-local progress and reports

The IndexedDB/run representation stays version 1 with separate changed-only attempt/observation rows. Public references, salts and fictional ciphertext stay local; PRF bytes and derived keys are transient. Each attempt preserves its own build, date, sequence and environment snapshot. Reloaded pending operations are interrupted, not assumed successful. Current browser hints refresh without rewriting historical labels. Cross-tab conflicts and unavailable/incompatible storage are surfaced, not replaced with a successful empty run; explicit unsaved mode remains available.

Reports retain schema 3 with additive optional diagnostics; identify this iteration by the exact build revision and the separately named diagnostic round, not schema alone. The new diagnostic round is `2026-10-05`. Existing fields distinguish native create/get, preflight, credential mismatch, extension reading, exact PRF validation rule and fictional crypto failure. Additional evidence records observed PRF enabled flag/shape, resident credential flag, returned ID-text/raw-ID agreement, bounded attachment hint, activation/focus/visibility/top-level state at native invocation, synchronous throw versus promise rejection versus returned result, a coarse native-duration bucket and a bounded numeric native error code.

Only safe booleans, enums, names, categories and bounded lengths/codes are stored/exported. Optional metadata failures never veto successful PRF decoding or replace the original operation error. Native invocation remains synchronous before the first await so instrumentation does not consume the user gesture. PRF `enabled` is registration metadata, not proof of usable decryption; absent fields remain unobserved/not provided, not inferred false. Attachment hints are not provider identity. Timing and focus facts are diagnostic observations, not performance gates or proof of cancellation/timeout.

`NotAllowedError` remains ambiguous between cancellation, timeout and refusal. `InvalidStateError` with exclusions is consistent with duplicate refusal, not proof of that cause in a run. Firefox's original unclassified second-registration failure is not silently assigned Chrome's diagnosis. No arbitrary native message, stack, response, ID, salt, PRF bytes, key or ciphertext enters the report. Known local credential identifiers are redacted from free text. Human notes remain bounded, escaped, explicitly unverified statements; do not include secrets or health information.

### Update and compatibility

Reload the reviewed build and verify its revision. **The owner's requested result reset is implemented as fresh active round namespaces**, separately for the default and experimental mode. Previous `circus-health-passkey-checker-v1` storage is not deleted or rewritten; **Export previous-round report** reads it separately. Missing or unreadable prior storage is reported, not treated as a recovered report. Credentials in password managers/authenticators are never deleted. Mode switching resumes each mode's own run and is disabled during a native operation or queued save.

This explicitly supersedes the previous iteration's instruction to resume the old run as the active update procedure. Within the new round, reload resumes current results; manual Reset affects only the selected mode's active store and still requires the existing deliberate UI action. Export before manually clearing progress or using unsaved mode. Browser eviction/private-session limits can lose local data, and sync of a passkey does not sync these reports.

Older builds continue to use their prior namespace and cannot interpret newer diagnostics in an imported/current-round store; incompatibility must remain explicit. A rollback does not restore the new active round to an older build. No household auth, archive format, operator configuration or server deployment changes are included.

## Build and publish

Source is [`src/app/passkey-checker/`](../../src/app/passkey-checker/) with its independent [Vite configuration](../../vite.passkey-checker.config.ts). With pinned contributor dependencies installed, run `npm run build:passkey-checker`. Ignored `dist/passkey-checker/` contains only checked static assets and deterministic `build-info.json` provenance. No application root, server, data adapter, health content or public-directory payload is bundled.

After independent review, required CI and squash merge, manually run the [publication workflow](../../.github/workflows/passkey-checker.yml) on reviewed `main`. It creates a generated-assets commit on `gh-pages` without force-pushing history and deploys that artifact through Pages. Do not publish a dirty feature-branch build or equate PR creation with deployment. Verify successful deployment and the hosted revision against the reviewed main commit before operator testing. Same clean source and pinned dependencies produce the same static assets.

## Development checks

Existing core/state/report, mounted, real-browser storage/encryption and publication-boundary fixtures remain required. `src/tests/passkey-checker-round.test.ts` adds default/enable-only parity, synchronous native invocation, same-credential retry with fresh challenge, retained A after successful/failed B, strict supported representations, optional-metadata isolation, bounded native diagnostics and report projection, and independent round namespaces. These controlled cases do not establish any physical provider success.

Use the separate [physical passkey qualification procedure](profile-encryption.md#physical-passkey-qualification) for the household installation. Raw private qualification evidence stays outside Git; a checker report does not close that gate.
