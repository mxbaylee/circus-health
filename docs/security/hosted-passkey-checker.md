# Hosted passkey compatibility checker

The [Operator](../design/personas.md#operate-and-recover) can use the [hosted checker](https://mxbaylee.github.io/circus-health/) to collect browser, operating-system and passkey-provider observations with fictional material. The static site is published through the reviewed procedure below. It runs entirely in the browser and needs no Circus Health server, Docker, LiteLLM, model configuration or health profile.

## Use the checker

1. Open the link manually in the actual browser being tested. Confirm the displayed origin and build revision. The page requires a valid HTTPS secure context for credential operations.
2. Check the browser and operating-system names and versions. Enter the authenticator or password-manager name and version where known. Browser-reported labels are observations, not proof of an exact version; unknown values remain unknown. Review the provider label again before switching providers or testing the second passkey.
3. Create test passkey A, confirm it with another real prompt, then complete three subsequent uses. Creating a credential alone does not prove PRF compatibility. Confirmation must receive valid PRF output and establish encrypted fictional material; each later use must receive fresh PRF output and decrypt and compare that material.
4. If available, create distinct passkey B and repeat its confirmation and three uses independently. New registrations include A/B in their native account labels while both retain the same fictional profile identity. Providers may group or ignore these labels, and existing passkeys are not renamed. A provider already holding A may refuse B because existing credentials are excluded; choose another available authenticator rather than deleting A. A synced copy or a renamed label does not establish an independent authenticator. Record unavailable combinations as Couldn't test.
5. Once B has been created, explicitly use A again with a fresh prompt, even if B cannot confirm. This separate step must receive fresh PRF output, decrypt and compare A’s retained fictional material. A’s earlier successes do not complete this check.
6. Add Worked, Failed or Couldn't test observations and optional notes. These are labeled human observations and never override an automatic result. Keep notes free of secrets and real health information.
7. Download the Markdown report even if the test is incomplete or failed. Earlier failures and retries remain visible. Give this report to a person or another LLM to help update [CRS-163](../todo/CRS-163.md), preserving its remaining installation checks.

The tool uses native credential prompts. Physical qualification must not use a virtual authenticator, a credential API override or a TLS bypass. Open each browser yourself; there is no automatic browser/device matrix or paid device-cloud requirement.

## What the evidence establishes

| Evidence                | Meaning                                                                                                                                                      | Remaining boundary                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic hosted result | A returned credential matched the requested credential; its actual PRF output was valid and the fictional value was decrypted on the recorded subsequent use | No production backend signature/challenge/origin verification or session authorization                                                            |
| Human observation       | The operator's provider/version labels, prompt observations and Worked/Failed/Couldn't test choice                                                           | Does not replace automatic PRF/decryption evidence or verify unobserved application behavior                                                      |
| Real installation check | The separate localhost release-build qualification in CRS-163                                                                                                | Actual profile recovery, private/original access after unlock, locked access refusal and retained access after Compose recreation remain required |

The relying-party domain is `mxbaylee.github.io`, not `localhost`. A `/circus-health/` project path is not a separate origin or relying-party boundary from other projects on that hostname. Changing the hostname requires new enrollment. Testing a phone or another operating system through the hosted link does not adopt remote household deployment or make remote-phone access a release requirement.

CRS-163 remains open and still precedes [CRS-088](../todo/CRS-088.md). The latter's future username-less flow and salt migration retain their own feature-specific physical requalification. A local report is an operator's observation record, not a signed or tamper-proof attestation. Browser, OS and provider updates can change behavior after a recorded result.

## Production reuse and deliberate differences

The checker imports the production browser helpers [`withBinaryPrf` and `prfFrom`](../../src/app/components/passkey-prf.ts), including strict 32-byte PRF decoding and the plain-byte-array compatibility case. Credential requests retain required resident credentials, required user verification, no attestation, exclusion of known credentials, supported native transport hints, a per-credential salt and confirmation restricted to the newly created credential. Both fictional credentials share the run’s stable fictional `user.id`, corresponding to adding another credential for one profile; their native account names/display names include their A/B alias. Known-credential exclusions remain enforced. Labels improve identification but are not evidence that a provider’s reported selection problem is fixed.

The production [enrollment](../../src/app/components/passkey-enrollment.ts) and [unlock](../../src/app/components/passkey-unlock.ts) orchestrators use server endpoints and are not reused as standalone flows. The checker calls native browser credential operations with browser-generated challenges. It selects each credential explicitly for its separate tests; production unlock can offer all of a profile's allowed credentials with credential-specific salts. Registration also matches the production resident-key compatibility flag, credential-properties request, supported public-key algorithms and request timeout. Transport hints are optional, bounded and used only as browser request hints; they do not identify a provider. Creation-time PRF output is not sufficient confirmation.

The checker derives a transient, nonextractable AES-GCM key from fresh PRF output using HKDF-SHA-256 and binds fictional ciphertext to its run, origin and credential alias. Production [passkey wrapping](../../src/server/profile-passkeys.ts) and vault encryption use the application's server verification, session and recovery contracts. Fictional browser encryption is not a simulation that qualifies those contracts. No production profile or recovery phrase is created by the checker.

## Browser-local progress and reports

The versioned IndexedDB representation stores a bounded run header, public credential references and salts, fictional ciphertext, and individual attempt and observation rows. Adding an attempt does not rewrite a growing history document. Raw PRF output and decryption keys are transient and are not persisted. Each attempt retains its own date, build and environment labels; later label edits do not relabel earlier outcomes. Reloading refreshes current browser-reported hints while preserving operator corrections and historical attempts. The interface distinguishes the running tool build from the build that started a resumed run.

A reload restores available progress. A pending prompt interrupted by reload remains unfinished. Unavailable storage, incompatible state and conflicting tab updates are explained; they are not silently replaced with an empty successful run. When continuing without saving, export the available report before leaving. Clearing or evicting browser storage, or ending a private session, can lose progress even when the exact reason cannot be determined. Local progress does not automatically follow a synced passkey to another browser or device. Deliberately resetting checker progress does not delete credentials from their provider.

Report/tool version 2 adds narrowly scoped diagnostics to new attempts: request mode, input/output type and length, extension/result presence, and whether the returned credential matched. New attempts distinguish absent PRF output from a rejected representation; strict 32-byte decoding and exact-credential refusal remain in force. The shared production PRF helper is unchanged. Legacy attempts keep their combined missing/invalid error and lack of diagnostics; the tool does not infer a missing historical shape or relabel old outcomes. Diagnostics are saved with each attempt and retain its original build/environment labels across reload and report export.

Reports use an allowlist of safe fields: report/tool version, build revision, dates, tested origin and relying-party scope, environment labels and provenance, per-step outcomes, sanitized error codes, human observations and unfinished checks. Diagnostics contain no IDs, salts, PRF bytes, ciphertext, keys, full native responses or arbitrary error messages. Reports use aliases A/B rather than credential IDs and contain no raw WebAuthn response, PRF output, private/decryption key or recovery secret. Known local credential identifiers are redacted from free-text fields. Notes remain operator-supplied observations. A `NotAllowedError` can mean cancellation, timeout or refusal; it is not reported as a proven cancellation.

### Update and compatibility

Reload the page to use the new checker build and confirm the displayed revision before targeted verification. Report/tool version 2 is separate from storage: IndexedDB and run format remain version 1 with additive optional per-attempt fields and the new return-to-A step. The new build reads legacy saved runs unchanged, preserving prior rows, progress and original classifications. Older builds cannot read the new shapes and must report explicit incompatibility rather than resetting progress. Export the available report before rolling back to an older build; resume with a supporting build to retain the newer state. Do not reset progress as an update procedure. This checker update changes no household archive format or operator configuration.

The original five mobile reports remain an incomplete checkpoint. [CRS-230](../todo/CRS-230.md) retains physical diagnosis, reproduction, disposition and verification, including the unanswered exact Proton “input format” observation. The owner’s hold is **CRS-230 → CRS-163 → CRS-088**: broader CRS-163 testing remains paused; targeted diagnosis and fix verification are allowed. Software tests do not lift this hold or demonstrate a physical provider fix.

The page does not upload results. Its content security policy disallows application network connections; static page/assets are fetched from GitHub Pages. A passkey provider's own synchronization is governed by that provider, not by the checker.

## Build and publish

Source lives in [`src/app/passkey-checker/`](../../src/app/passkey-checker/) with a separate [`Vite configuration`](../../vite.passkey-checker.config.ts). After installing the repository's pinned Node dependencies:

```sh
npm run build:passkey-checker
```

The independent build writes ignored `dist/passkey-checker/` assets and includes deterministic `build-info.json` provenance from the source revision and worktree state. It does not copy the application's public directory or import its server, data adapters or application root. Allowed source modules and generated filenames are checked explicitly. Development or dirty builds must not be represented as a reviewed release publication.

After the implementation is reviewed, merged and its required checks pass, manually run the [checker publication workflow](../../.github/workflows/passkey-checker.yml) on `main`. It builds the selected main revision, commits only generated site assets to `gh-pages` without force-pushing history, uploads the files from that generated commit as the Pages artifact, and deploys that artifact. Source stays in the normal reviewed codebase. The existing GitHub Pages Actions configuration is used; no production health application is deployed.

Check the workflow's successful deployment and compare the hosted page's revision with `build-info.json` and the reviewed main commit before collecting physical observations. A failed publication or unavailable URL is not a successful hosted run. Rebuilding the same clean source with the same pinned dependencies produces the same static assets.

## Development checks

Focused tests exercise request semantics, PRF decoding, fictional encryption/decryption, credential mismatch and missing-PRF refusal, local-state recovery and conflicts, report redaction, manual/automatic outcome separation, and static publication boundaries. Controlled test ports or mocked component states are development evidence only. They do not qualify the physical browser, OS, authenticator or password-manager combinations.

For the actual household installation, follow the separate [physical passkey qualification procedure](profile-encryption.md#physical-passkey-qualification). Keep raw private installation evidence outside Git. The hosted report does not close that release gate.
