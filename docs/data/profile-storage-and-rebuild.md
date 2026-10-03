# Profiles, durable versions, and deterministic rebuilds

The default Node and Docker runtimes now use encrypted profiles. Startup reads minimal public profile cards. Clinical data opens only after recovery-key verification or a usable passkey unlock. The older plaintext runtime remains for isolated fixtures and legacy recovery tooling; it is not the default application's storage contract.

## One owner per profile

Each profile has an opaque ID, independently generated encryption and recovery keys, its own database, and its own retained evidence. Copies receive new keys. Placebo generation uses fictional records but fresh cryptographic keys. Requests, assets, assistant work and mutations require the selected profile to be unlocked in the requesting browser session.

A durable data directory contains:

```text
data/
  profiles.json                    # minimal public cards
  profiles/<opaque-id>/
    keyring.json                   # wrapped keys and unlock metadata
    vault/
      manifest.enc                 # authenticated current head
      indices/<id>.enc             # encrypted original-file indexes
      objects/<id>.enc             # original files and private auxiliary files
      versions/<id>.enc            # committed record segments and metadata
    cache/
      sqlite.enc                   # disposable encrypted projection
      metadata.enc                 # cache validation metadata
```

Filenames, source attribution, original bytes, reviewed mappings, clinical data, personal notes, relationships and retained version history are private. Only minimal profile-card and unlock metadata are public. The user's explicit downloaded recovery kit is a separate secret; it does not belong beside the archive.

After unlock, a separate private runtime directory holds working SQLite, required metadata and any originals opened during the session. Source and attachment originals are authenticated during unlock but remain encrypted on disk until an authorized consumer needs the individual file. This preserves corruption detection while avoiding a plaintext copy of the whole archive; it does not eliminate whole-archive authentication work. Other metadata is materialized eagerly. Unlock checks reported free space against that workspace, database planning headroom and one configured upload allowance; original access performs its own capacity check. Files opened during the session remain in the workspace until lock. Locking closes access and removes that working directory. Docker uses transient runtime storage. User-managed backups of the durable directory remain separate from runtime files and caches. Ciphertext access is per file, not byte-range seeking, and missing plaintext originals are never interpreted as archive deletions during publication.

## Canonical state

Original uploaded artifacts and accepted record versions are authoritative. SQLite indexes current records and their history. Original artifacts alone cannot reproduce AI extraction decisions, reviewed mappings or app-authored notes. Rebuilding from accepted versions does not invoke AI.

Personal state includes People, notes, links, attachments, visibility changes and current medication-use assertions. Clinical state includes providers, deliveries, source records, observations, medications, procedures, documents and evidence. An edit appends complete versions of the changed records and affected relationships, rather than another snapshot of every table. Returning a value to an earlier value retains both changes.

## Writes and publication

Versioned operations check revisions and publish authenticated transaction boundaries before acknowledging success. A retry uses the same operation identity. Interrupted or invalid segments do not become accepted state; missing history or original evidence fails explicitly. See [record versions](record-version-storage.md).

Byte-identical originals can share a physical encrypted object **within one profile**, after hash/size screening and complete byte comparison. Delivery occurrences, names, attribution and locators remain distinct. Similar PDFs and clinically similar records are not byte-identical originals.

## Unlock and rebuild

Unlock validates the encrypted cache against the profile, projection schema and committed history. A valid cache can be reused and brought up to date. Missing, invalid or incompatible caches trigger deterministic reconstruction of current records and searchable history from accepted versions, with evidence and database integrity checks. A corrupt authoritative input is an error, not a reason to silently discard data.

The same accepted versions and projection schema yield the same logical records and relationships. SQLite file bytes and execution timing need not match. Rebuild/cache timings are recorded so future optimization can be based on actual cost. Startup no longer rebuilds every profile.

## Recovery and validation

Import source text uses the same encrypted record journal transaction authority as existing profile state. Immutable revision headers reference checksummed, content-addressed page and relationship objects in the journaled projection. Publication records source ownership/hash, adapter version, human review events and downstream invalidation atomically. The SQLite projection is not the only authority; rebuilding restores these objects without OCR or a provider call. Missing or corrupt referenced objects fail explicitly. Copying a profile rebinds validated revision headers to the new owner and records origin provenance before publishing the copied vault; it does not change the original profile.

Source text uses partitioned immutable page/list storage rather than a document-wide page/span/revision-byte allowance. Individual decoder, raster and request limits remain; unresolved scopes retain exceptions and their originals. Full-revision editing still has memory costs proportional to document size. Source-review events are inspection/correction history, not accepted clinical versions.

Keep a consistent copy of the encrypted durable directory and the recovery kit separately. Default encrypted HTTP routes reject the legacy plaintext backup/copy routes. The npm backup/restore aliases have been removed, and the retired recovery CLI refuses operations before reading archive inputs or changing a destination. Use the [complete encrypted-directory procedure](../setup/deployment.md#backup-and-recovery); access recovery, archive restore, cache reconstruction and portable export are distinct operations.

Synthetic backend and container tests cover cache loss, integrity failures, interrupted publication, profile/session isolation, selective history restoration, and recovery. Real-device WebAuthn PRF and real configured model-provider checks remain release gates; these tests do not establish them.

## Contributor private-copy retention

The isolated contributor `profile-lifecycle` facility uses a [filesystem accepted-record journal](contributor-record-authority.md), with explicit portable snapshot artifacts. Its private copy takes current accepted state and originals; prior application generations and chats are not copied. It is a private real-data copy, not anonymization. The default encrypted HTTP routes still reject legacy plaintext copy routes, and the supported npm → Compose setup is unchanged.

Contributor callers generate a lowercase UUIDv4 `operationId` before requesting a copy and retain it for retries. The ID is bound to the normalized requested display name, source and one target; reusing it for different inputs refuses. Operation intent lives under `data/operations/profile-copies/`, and unpublished staging under `data/operations/profile-staging/`. These private operation artifacts belong with external untracked profile storage, not in Git. Blank and placebo creation require no new copy identity.

While holding the source writer lease, the implementation checks the source and backup against an independent reconstruction from selected record authority. It rejects dirty/conflicted or invalid evidence without publishing unacknowledged source changes, before rebinding owner/path/source-text state and installing fresh target intake evidence. Original files are retained and verified. Portable artifacts include exact staged intake, pins and retained source receipts, with bounded validation during load/rebuild; subsequent runtime writes use the target journal. See [intake copy and receipt details](intake-state-storage.md#contributor-private-copy-publication-and-retry).

The staged journal is validated before final directory rename publishes the destination; registry publication and runtime activation follow. Unpublished-stage cleanup does not erase a published destination. Automatic re-preparation requires that no ambiguous publication marker remains. A retry with the same operation can recover that destination even if the source has changed or is absent. Before first registration, selected destination heads and name must equal the pinned preparation. After completed registration, recovery preserves later accepted destination edits, its current name and current head, including after complete SQLite cache loss. Active-target retries still verify durable readiness. Corrupt or missing selected evidence fails explicitly. A valid earlier accepted SQLite cache may catch up from the published head; conflicting or unacknowledged SQL changes refuse rather than being silently accepted or erased. A persisted published/attempted-publication intent with missing final storage requires explicit recovery, not a new copy under the old operation ID. A crash after saving the attempted marker but before rename also takes that conservative refusal path: preserve intent and any archive/stage evidence because restart cannot prove nonpublication. Only a live caught failure with its original stage still present and no final destination can clear the marker safely.

Normal contributor runtime intake reads and writes use genuine accepted-record readiness, including intake contributions and clinical acceptance in one transaction. Whole-state comparison on existing-profile opening, backup, original copy, validation and explicit portable export retain costs proportional to retained state. [Application mutation and recovery qualification](intake-mutation-qualification.md) separates those costs and verifies selected coherent backup/reconstruction; this integration makes no broad capacity or heavy-import claim.

## Repository boundary

Profile originals, notes, chats, exports and receipts belong in external untracked data storage. Contributor documentation and tests use placeholders or invented examples. The user's designated backup is preserved. Old Git history and independently retained plaintext backups are not retroactively encrypted by the new runtime.

Historical packet ownership is reconstructed from retained explicit subject evidence, never inferred from missing person fields or raw names. The [historical evidence inventory](../../src/server/NOTE-EXPORTS.md#historical-raw-assertion-ownership) documents current formats and unsupported restoration. Source-only rebuild preserves mixed-family subject evidence and unresolved omissions; it does not manufacture ownership or run an AI backfill.
