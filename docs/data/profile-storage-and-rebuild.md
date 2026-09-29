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

Source text has explicit representation bounds (10,000 enumerated pages, 100,000 spans and 32 MiB per validated revision). Reaching a bound retains earlier progress and originals and reports an exception; it never means a document is complete. Large-scope segmentation beyond those bounds remains qualification work. Source-review events are inspection/correction history, not accepted clinical versions.

Keep a consistent copy of the encrypted durable directory and the recovery kit separately. Default encrypted HTTP routes reject the legacy plaintext backup/copy routes. The legacy recovery CLI's portable snapshot format must not be mistaken for a current encrypted-vault backup command.

Synthetic backend and container tests cover cache loss, integrity failures, interrupted publication, profile/session isolation, selective history restoration, and recovery. Real-device WebAuthn PRF and real configured model-provider checks remain release gates; these tests do not establish them.

## Repository boundary

Profile originals, notes, chats, exports and receipts belong in external untracked data storage. Contributor documentation and tests use placeholders or invented examples. The user's designated backup is preserved. Old Git history and independently retained plaintext backups are not retroactively encrypted by the new runtime.
