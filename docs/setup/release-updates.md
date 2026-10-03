# Update an installation and recover from a failed candidate

This procedure serves the Operator's [operate and recover](../design/personas.md#operate-and-recover) job on the supported localhost npm → Docker Compose → LiteLLM installation. It covers a checked update from supported authority and recovery from a failed candidate using a separately retained backup. Review the limits before updating: recovery returns the backup's state, so writes made after that backup are not recovered by this procedure. General downgrade compatibility and rollback prevention are not provided.

## Identify the current and candidate builds

Record the current checkout's exact revision and the running build's `buildId`, `revision` and `worktree` from `http://localhost:3001/api/runtime` (use your configured port). Record the application image ID and tag from that archive's specific Compose project. Retain the prior checkout/revision and dependencies needed to build it again; a mutable image tag alone is not a retained release. Keep receipts outside Git and omit credentials, recovery phrases, private source paths and health content from shared diagnostics.

Select the intended candidate checkout and review its [release, configuration and format notes](#release-configuration-and-format-notes) against the prior checkout. `npm run image:build` can build it without opening an archive. `npm run start` builds from the invoking checkout; `CRS_IMAGE` selects the tag used for that build, not an immutable prebuilt release. Record the resulting candidate image/build identity after starting. Distinct production builds have distinct build IDs; restarting one image retains its ID. An unknown identity stays unknown, and a dirty worktree cannot be claimed to equal its recorded revision. See the [readiness API](../../src/server/API.md#public-runtime-readiness) and [connection behavior](connection-awareness.md).

Keep these identities separate:

| Identity                                                                                   | What it establishes                                                    |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| App build ID, source revision/worktree and image ID                                        | Which application artifact ran; not whether it understands the archive |
| Registry, keyring, encrypted framing, vault index/head and accepted-history formats/schema | The durable authority that must remain readable and intact             |
| Encrypted SQLite cache/projection schema                                                   | A disposable projection that can rebuild only from supported authority |

Readiness confirms process startup, not the readability of every locked profile or model availability. Unlock and check the retained state before declaring the update usable.

## Prepare the checked way back

1. Save the current explicit operator environment outside Git: archive path, proxy YAML and selected alias, provider credential-file selection, proxy state directory, public origin/port and any resource or capability overrides. Protect secrets separately; record safe configuration hashes or sanitized settings in receipts rather than credential values.
2. Record the exact state to check: original and attachment hashes, accepted current records and person attribution, prior accepted versions, correction actor/time/source, pending unaccepted review and explicit Stop. Check each profile you need to recover. Matching counts alone do not prove matching state.
3. Stop the foreground `npm run start` with Ctrl-C and wait for Compose cleanup. Ensure it is the sole writer and no old process remains in this archive's specific Compose project. Never bypass the writer lock/domain or use global Docker pruning.
4. Follow [independent encrypted archive restore](archive-restore.md) to copy the complete stopped `CRS_DATA_DIR` into a fresh protected external backup, compare inventories and SHA-256 hashes, and retain matching usable recovery kits independently. Verify a separate restored copy with those kits. Never start or alter the retained backup itself. A kit contains an unlock secret, not records; a cache rebuild and a restart do not prove an independent backup.

Keep the source stopped throughout copy verification. Complete the backup and independent restore checks before starting the candidate against the active archive. Preserve the backup inventory and its build/format identity, with the expected-state record in protected external storage.

## Start and verify the candidate

Start from the candidate checkout with the same explicit archive and proxy configuration. For example, after replacing these paths and alias with the saved settings:

```sh
CRS_DATA_DIR=/absolute/installation/data \
CRS_MODEL=health-primary \
CRS_LITELLM_CONFIG=/absolute/installation/proxy/litellm.yaml \
CRS_STATE_DIR=/absolute/installation/proxy/state npm run start
```

Also retain your explicit credential-file selection, origin/port and overrides; the abbreviated example does not replace the saved environment. Run only one app version against this archive. Refresh the browser when the [build-change notice](connection-awareness.md) offers it; a stale browser bundle is not verification of the candidate.

Unlock each covered profile and compare against the pre-backup record: download and hash originals/attachments; inspect accepted values, attribution, relationships, corrections and earlier history; verify pending proposals stay unaccepted and explicit Stop stays stopped. Lock and confirm private access is refused. Supported authority can reconstruct missing or incompatible disposable caches without OCR or model calls. An unsupported accepted-history schema is authority incompatibility, even if SQLite also needs a rebuild; deleting the cache cannot make that authority supported.

Retain the actual candidate result, identities and checked scope. A successful readiness response, unchanged record count or an older qualification receipt is insufficient. Avoid new record writes until these checks succeed; any later writes remain outside the pre-update recovery point.

## Refusal or failed startup

An unsupported or invalid authority format must fail explicitly; it is not permission to create an empty replacement archive, reset the profile, discard accepted history, edit format identifiers or invent a conversion. Record which scope failed, whether startup or profile unlock refused, and the operator action reported. Profile authority checks occur at unlock and when referenced originals are materialized; readiness does not validate every locked profile or reread all retained history. Preserve its originals, accepted versions, index, registry and key material. Incompatible disposable caches may rebuild only when the underlying authority is supported.

Stop the failed candidate cleanly, ensure its writer has exited, and preserve its archive and private diagnostics as candidate evidence. Keep the untouched pre-update backup and kits separate. Do not run the prior app against the archive the candidate used: the candidate may already have made valid writes before the failure. Do not damage an important archive to test refusal; use protected, disposable fictional copies for such checks.

## Recover with the prior app and a fresh backup copy

Follow the [isolated restore procedure](archive-restore.md#restore-into-an-isolated-installation), copying the untouched verified backup into a third fresh external directory ending in `data`. Select the retained prior checkout/revision and build it with `npm run start` against that copy. Use separate proxy state/configuration and an isolated browser session with no source cookies or stored keys; different localhost ports share a cookie namespace. Keep the failed candidate stopped and never start the retained backup.

Unlock with the independently retained matching kit and repeat the exact original/hash, accepted state/history, correction, pending-review, Stop and private-access checks. Record the recovered build/format identity and scope. Recovering an untouched backup with the prior app does not establish that the prior app can read candidate-modified authority. Post-backup writes require separate assessment; this procedure does not merge them or promise their recovery. Authenticated old copies can still unlock, so this procedure does not prevent rollback or revoke old backups after a passkey/profile change.

## Release, configuration and format notes

This section and its linked maintained contracts are the durable place to check update-relevant changes. Contributors update these notes and the owning contract in the same change when build selection, operator settings, authority formats or cache compatibility changes. Describe the implemented behavior, required operator action and compatibility limit; keep proposed migrations and unfinished requirements in the [work list](../todo/readme.md). Operators compare the notes in both chosen checkouts, including the linked contract changes, before opening the archive with the candidate. There is no automatic updater, image promotion or general migration policy implied by this process.

| Current boundary                | Contract and operator consequence                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build provenance and selection  | [Build identity](connection-awareness.md) and [environment](environment.md): launcher builds the invoking checkout; a tag does not select a retained immutable release.                                                                                                                                                                                                                                                                     |
| Explicit launcher configuration | [Environment reference](environment.md): app-owned settings use `CRS_`; old prefixes are not persistent aliases. Keep archive/proxy/state settings explicit and separate.                                                                                                                                                                                                                                                                   |
| Encrypted authority             | [Vault format](../security/vault-format.md) and [vault index](../security/vault-index.md): encrypted-object framing is v1; current index/head is v2. Older full-map indexes have no decoder or migration.                                                                                                                                                                                                                                   |
| Accepted history and projection | [Record versions](../data/record-version-storage.md#condition-storage-schema-boundary): current schema is 7, including condition occurrences. Accepted journal schemas require an exact match; no legacy journal/cache/portable-snapshot compatibility is provided for that addition. A disposable cache's reconstruction does not convert older authority.                                                                                 |
| Personal packet preferences     | [Selective packets](../features/selective-packets.md#saved-preferences-and-recovery): changed-only `packet_preference:v1:` metadata uses existing schema 7 authority. Explicit personal portable snapshots add an optional `packetPreferences` overlay; earlier snapshots remain readable. Earlier app builds do not enforce these choices, so use a supporting build before sharing recovered data. No operator configuration is required. |
| Independent recovery            | [Archive restore](archive-restore.md): complete stopped-copy backup plus independently retained usable kits; old copies retain their clinical/key state.                                                                                                                                                                                                                                                                                    |

These describe current contracts, not proof that a selected pair of releases passed a drill. If the candidate needs a new authority migration, resolve that requirement before use; this procedure supplies neither a decoder nor automatic conversion.

## Repeatable fictional release qualification

Run from a frozen candidate checkout with Docker and the contributor Node/browser prerequisites available. Choose an exact locally available prior commit and a fresh absolute external output directory outside Git:

```sh
CRS_RELEASE_UPDATE_TEST=1 \
CRS_UPDATE_PRIOR_REVISION=<exact-prior-commit> \
CRS_UPDATE_OUTPUT_DIR=/absolute/fresh/external/directory \
npm run qualify:release-update
```

The drill builds distinct prior and candidate application artifacts, uses a small independently fictional fixture and explicit local proxy configuration, and requires no provider, paid inference or heavy import. The prior commit must be locally available and the two source trees must differ; keep the candidate checkout unchanged throughout the run. This bounded drill requires unchanged supported authority/cache formats. It verifies a separate backup copy with the prior app and retained kit before opening the candidate, then checks retained state, incompatible-cache reconstruction, protected-copy startup/index refusals and prior-app recovery from another fresh copy of the untouched backup. Focused storage tests additionally cover unsupported key and accepted-history formats. Kits, archives, full inventories and raw diagnostics stay outside Git. Retain the actual receipt, including both build/image identities, authority/cache identities, configuration checks, refusal scopes and recovery result, before claiming that release pair passed.

A passing fictional run covers the observed release pair and local environment. It does not establish general downgrade compatibility, rollback prevention, lossless post-backup recovery, power-loss durability, every filesystem, physical passkeys, a live provider or remote deployment. A command's existence is not a successful qualification receipt.

## Observed release-pair evidence

On 2026-10-03, the fictional cloud drill passed for clean prior revision `b5f6347e43a9a93a7a597e78d57891cb554f9258` and clean candidate revision `5def4db7367cb5dfc89b93e276994aeec88cf582`. It verified the separate backup copy and independently retained kit before candidate startup, distinct built artifacts, exact originals and accepted state/history, correction attribution, pending review and Stop. The authenticated future disposable-cache schema `999999` rebuilt from supported authority. Future/missing registry startup and future encrypted-manifest unlock refused on protected copies without changing their bytes. Prior-app recovery from another fresh untouched-backup copy passed; source and retained backup remained unchanged, with zero model requests. Both releases used accepted-history and disposable-cache schema 7.

The run used reviewed environment-only compact Docker build overrides to fit the cloud filesystem. The pinned base, lockfile-driven application build, qpdf/OCR/Chromium prerequisites, runtime allowlist, nonroot user, command and health probe matched the repository build contracts; the exact recipes and hashes were retained with the external evidence. This qualifies that observed pair and equivalent application/runtime configuration, rather than an unmodified stock-image build or other releases/filesystems. Focused storage tests separately cover unsupported key, accepted-history and eager/deferred encrypted-original framing. Public readiness does not establish exhaustive history validation. Future release qualification still needs current build-scoped evidence with the limitations above.
