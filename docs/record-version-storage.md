# Append-only record versions

Status: implemented in the default encrypted runtime, with synthetic durability, rebuild and history tests. This replaces full personal/clinical snapshots after each edit and the earlier proposal to move old operations out of normal use after compaction. [Encrypted profiles](profile-encryption.md) and [original-file reuse](storage-accounting.md) are integrated with the version store.

## Storage contract

Keep original uploaded artifacts unchanged. Store new accepted versions of individual records in an append-only logical JSONL stream. Editing a person appends that person's new version, not a copy of every person, note and clinical table. Reviewed imports append versions for new or changed records and retain acquisition/source occurrences according to the existing reconciliation rules.

Each version contains its stable profile ID, entity kind and record ID, unique version ID, previous-version reference, transaction/operation ID, schema version, commit sequence, recorded timestamp, known actor/action origin, complete record contents, and applicable evidence/correction references. Preserve all literal fields and distinctions such as absent versus null, exact versus partial dates, and original source status. Do not invent actor identity or confuse when the app recorded a change with the clinical event date.

Use complete versions of changed records rather than patches that require rerunning old application business logic to determine their contents. Large original documents and attachment bytes remain shared immutable objects referenced by records. No update writes another complete archive snapshot merely to make the changed record durable.

Relationships must have explicit versioned semantics too. Removing a link creates a new version showing the association as removed; it does not erase the old association. Archive/restore records visibility changes without deleting evidence. Version storage does not grant permission to edit imported originals or finished historical notes: existing source/finished-note restrictions still apply, including creating a linked correction note when required. Ordinary links retain the existing behavior of resolving the target's current version; an audit entry can identify the specific versions involved in an edit.

## Current data and searchable history

SQLite is a disposable, indexed projection containing both current records and retained version history. The current view selects the latest accepted version in committed order. Record history is a normal query, not an offline backup-restoration workflow. Index by profile, entity/record, version/sequence and time, with a field-change index or equivalent for queries such as **When did I change my birthday?**

Both changes in A → B → A remain searchable. Returning to an earlier value does not deduplicate away the intervening edit. A network retry of the same operation must not create a second version; a distinct accepted edit is a different operation even if some contents repeat. Changed-field summaries can be derived from adjacent versions but must retain links to their full contents and attribution.

Restoration appends a new version referencing the selected prior version or versions; it does not rewrite the past or remove newer history. The history UI groups editing sessions and previews selected fields and removed associations before restoring them through revision-checked operations.

The working database and its encrypted persistent cache include current data and history indexes. Validate the schema/projection version and last committed sequence on reuse, and catch up subsequent committed versions atomically. Ordinary history lookup must not scan/replay the whole archive. Losing every derived index requires a one-time deterministic rebuild of current and historical projections from the durable versions; no AI is needed. Be explicit that history occupies storage and a complete rebuild costs time.

## Durability and encryption

Maintain the single-writer boundary and optimistic revision checks. Stage new versions and referenced objects, verify their bytes, then durably publish an authenticated transaction boundary before acknowledgment. Cross-record changes, evidence relationships and their history must become visible together. Reconcile an interrupted database update from committed durable versions without accepting partial transactions or silently dropping an acknowledged version.

Retries use a stable operation ID. A partial final append or an uncommitted segment cannot become accepted state. Refuse unexplained gaps, invalid version references, wrong profile ownership or unsupported schema rather than substituting another snapshot. Pin and test deterministic record/schema decoding across supported versions. JSONL by itself does not supply transactions, concurrency control or safe multi-machine writes.

JSONL is the logical representation after decryption. Durable storage uses bounded authenticated encrypted segments/objects and commit metadata inside the vault. Segment rotation bounds file size and recovery work; it does not discard old versions or remove them from queries. Keep keys and credential changes outside the medical record history, with the secret-handling constraints in the encryption specification.

## No initial compaction feature

Do not build compaction scheduling, edit-to-content thresholds, historical log offloading or periodic full-archive checkpoints in the initial delivery. Retain the complete version history, reuse the encrypted SQLite cache, and measure actual stored bytes and rebuild/indexing time. This is explicitly outside initial release scope, not another deferred task.

The app may replace derived SQLite caches without preserving every previous cache. Authoritative versions and originals remain intact. Any future lossless compression or repacking must preserve every record version, audit query and source relationship. A future checkpoint could speed reconstruction but cannot make old history unavailable in the normal database. Revisit such work only through a new measured requirement.

## Validation and compatibility

Use fresh fictional profiles for storage experiments. Existing accepted versions and originals remain authoritative during ordinary operation and recovery; a development test reset is not a migration strategy or permission to discard an operator's archive.

Verify with fictional fixtures:

- One person or clinical-record edit appends only the changed record(s) and small transaction metadata, not a full-table/corpus snapshot.
- A birthday change and A → B → A remain queryable with timestamps, previous/new values and known attribution, after cache reuse and after complete SQLite loss.
- Current rows and full history reproduce deterministically; invalid or missing accepted versions fail explicitly.
- Retries do not duplicate versions; stale edits fail; partial writes, crashes and multi-record transactions never expose half an accepted change.
- Removed/re-added links, archival changes and restored values retain their past states. Finished-note and immutable-source restrictions still hold.
- All original artifacts, source occurrences and attribution survive acceptance, backup/restore and reimport. Near-identical medical records are not collapsed by the storage layer.
- Encryption/profile boundaries cover history indexes and model history queries as well as current records. Locked profiles expose no history.
- Fresh encrypted profile creation, in-app provider imports, reviewed corrections, personal edits and container/cache loss exercise the complete supported workflow.
