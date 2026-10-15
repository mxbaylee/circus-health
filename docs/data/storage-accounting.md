# File reuse and profile storage

Current implementation: per-profile locked totals, unlocked physical-byte breakdown, archive-wide backup/legacy totals, runtime totals and byte-identical object reuse exist. The picker uses decimal MB/GB and preserves Storage intent when switching profiles. Selected uploads show qualified original/staging-space estimates. The [current TODO audit](../todo/readme.md) separates implementation from external release verification.

Status: accounting and UI implementation complete, with synthetic accounting/isolation tests. It complements the implemented [encrypted profiles](../security/profile-encryption.md) and [append-only record versions](record-version-storage.md). The user’s separate backup remains outside development resets. Older plaintext recovery packages have a different layout from the default encrypted runtime.

`GET /api/storage/archive` exposes only aggregate filesystem metadata: active profile directories, other archive files and separately measured runtime files. It reads no private content and does not follow links or scan external copies. Orphaned legacy profile directories count toward other archive files. Inaccessible or changing trees produce a partial lower-bound measurement. `GET /api/profiles/:id/storage/import-estimate?bytes=N` requires unlock and separates original encryption allowance from two runtime original copies plus one extraction/ZIP allowance. Derivatives, record/index growth, nested or multiple archives can require more. Filesystem-reported availability never establishes a mount or cloud quota; unknown remains unknown.

The [streamed package member path](streamed-package-originals.md) retains large ZIP members without whole-member payload buffers. Its stages and expanded children still consume runtime and archive capacity. The existing upload/extraction configuration and conservative admission estimate remain; [CRS-233](../todo/CRS-233.md) owns the unfinished storage-only rule and operator decisions.

Paged intake nodes, operation receipts and retained review snapshots are accepted evidence and count in durable history, even when a checkpoint has not yet selected a domain-visible inventory or plan. Disposable inventory, search and policy indexes occupy runtime SQLite space and can be reconstructed. Do not count an immutable node again for each snapshot that references it. The [intake state contract](intake-state-storage.md#draft-history-growth-qualification) separates cold construction, warm changed-path writes and exact replay measurements; bounded buffers do not imply negligible disk growth or a qualified installation capacity.

## Original files and reuse

Store byte-identical originals once within each profile. Retain each delivery occurrence, original filename, issuing/acquisition source, timestamp and evidence locator independently. If two distinct PDFs contain the same clinical record, preserve both original PDFs and let the reconciled record reference both occurrences. Clinical deduplication never rewrites or discards a distinct original artifact.

Look up potential duplicates by size and a cryptographic digest, then establish byte identity before reusing an existing object. Keep the plaintext-content index within encrypted metadata and perform lookup only after unlock. Randomized encryption need not produce matching ciphertext for duplicate plaintext: reuse the already encrypted object after verification instead of weakening encryption to make deduplication possible. No sharing of objects or keys between profiles, including private copies and Placebo accounts.

Preserve every historical reference and record occurrence; no user-facing deletion of individual accepted evidence is introduced. Test repeated uploads, different filenames/providers for identical bytes, near-identical PDFs, interrupted writes, concurrent attempts and complete backup/restore. Original downloads must reconstruct the exact uploaded bytes under the retained delivery filename.

Factoring overlapping fragments inside distinct PDFs/ZIPs and elaborate storage-history charts are outside this release. They are not left as ambiguous deferred tasks.

## Profile modal

Use a compact **Storage** column beside each selectable profile row, showing a readable MB/GB total. This fits the existing name/icon, selected-row distinction and separate ellipsis. Totals are attributable to one opaque profile ID, never averaged across profiles. An empty or newly generated Placebo account may be much smaller than an imported archive.

The row measures stored file bytes within that profile's durable directory, including encrypted objects, historical generations, manifests and disposable encrypted cache. Count each stored object once, irrespective of how many records/providers link to it. Do not sum referenced clinical-document sizes, which would count shared originals repeatedly. Use explicit consistent decimal units (MB/GB); this is a portable stored-byte measure, not a promise about allocated filesystem blocks or cloud billing.

Stored totals can be measured while a profile is locked without inspecting content. No medical counts, provider names or content-derived categories should be exposed before unlock. After unlock, a **Storage details** action in the row's menu can show originals, attachments, accepted data/history, personal notes/history, chats, database cache and other/legacy files. Define non-overlapping accounting so categories sum to the row total even when one object has multiple uses. Show when measurements are pending or stale rather than displaying zero.

Backups or old checkpoints outside profile directories are a separate archive-level total, not charged again to the profile row. The modal can show **Backups and other archive files** beneath the rows with a details explanation. A backup of a deleted profile still occupies space and must not disappear from that aggregate. Runtime temporary space and external downloads/backups are outside the durable-directory total and must be labeled separately when measured. Do not expose private contents merely to classify legacy backups while profiles are locked.

## Existing files and cleanup boundaries

The encrypted product backup is a consistent copy of the complete durable `CRS_DATA_DIR` while its writer is stopped or through a suitable filesystem snapshot. Legacy portable backup/recovery helpers and standalone rebuild outputs are contributor or compatibility tools, not the encrypted product backup path. Retained backups can multiply storage, and the app has no automatic backup retention policy. Do not add automatic full backups on every import, save, or startup as part of this feature.

Current `profiles/<id>/db/` files and top-level checkpoints may be old rebuild/recovery outputs. Normal startup builds working SQLite in a separate runtime directory. Verify the running process, committed generations and recovery coverage before declaring a particular old file disposable. Current format helpers and recovery outputs still use `db/database.sqlite`; its presence is not proof the live application reads it.

Backup retention is separate from logical record history. Removing an external backup never authorizes dropping versions from an active profile. Use the documented backup/recovery workflow and preserve the chosen recovery source before any explicitly requested archive reset.

## Capacity and curation overhead

`curation` is durable reviewed clinical state: source-record identities/locators, normalized observations, medications, procedures, reports/documents, attribution/evidence, relationships and accepted mapping/import decisions. The app uses it to recreate SQLite without AI. It is not a disposable database cache. Raw JSON already stored verbatim in a source may be represented by a checked byte-range reference instead of another embedded copy.

In the former plaintext implementation, each curation generation was a complete, formatted JSON snapshot of the retained clinical table set. Distinct generations can repeat almost all their data without being byte-identical files. `current.json` selects the current version; older files preserve history or retained candidates, and are not silently promoted to accepted state. Ordinary personal note saves write personal generations and do not rewrite the whole clinical corpus unless clinical state also changed.

The default encrypted runtime now appends versions of individual changed records and keeps all versions searchable, rather than exporting the whole dataset for each change. Original PDFs remain unchanged. The legacy snapshot description above is relevant only to older fixtures/recovery packages. See [current profile storage](profile-storage-and-rebuild.md).

### Current runtime: append-only record versions

Follow [append-only record versions](record-version-storage.md) for the full contract. Each accepted edit appends the complete new version of the changed record, with stable identity, version/transaction metadata, time and evidence. Explicit versioned associations handle removed links and archival changes. Full snapshots are not required for concurrency; writer serialization and durable transaction boundaries remain necessary.

SQLite indexes both the current version and all retained history. A field-history question must be answerable by a normal query, without scanning old backups or replaying all records. Returning a value from A → B → A preserves both edits. Restoring older state appends another version; it does not erase intervening versions.

Retain original files and version history as authority, with an encrypted SQLite cache for fast reuse and deterministic indexing after cache loss. JSONL is the decrypted logical stream; physical files are authenticated encrypted segments/objects. Segment rotation is not history deletion. Small edits must not rewrite every personal or clinical table.

Compaction scheduling, old-history offloading and periodic full-archive checkpoints are outside the initial release. Measure version growth and rebuild/indexing time; lossless compression or repacking can be considered only as a later, separately justified requirement. No optimization may remove historical versions from ordinary queries.

Treat roughly 2 GB per profile as an initial planning allowance for comparable text/PDF archives, not a universal requirement or guaranteed capacity. Large scans, imaging/video, full backup copies and an indefinitely growing version history can need much more. Document archive storage separately from Docker/image size, local model weights and temporary import/rebuild space. Import preparation should estimate additional bytes and required staging space; report capacity as unknown when the filesystem/mount cannot provide a meaningful answer. Do not assume an S3 mount's reported free bytes equal its quota.

## Acceptance checks

- Exact-file reuse preserves all delivery occurrences and downloadable bytes; different PDFs remain distinct and one clinical record can reference both.
- Per-profile totals count unique stored files once, match non-overlapping detail categories, and reconcile with separately reported archive overhead.
- Locked rows expose only agreed public metadata and stored totals; detailed content classification requires authorized unlock.
- In-progress uploads, cache replacement, stale measurements, inaccessible files and zero-byte profiles receive honest totals/status.
- Capacity guidance separates retained archive, backup copies and temporary/runtime/model requirements; no fixed quota claim follows from one example archive.
- Use generated fixtures with Placebo account wording and canonical `placebo` classification in data and APIs. Verify the rename throughout serialization and profile operations; no obsolete profile-format compatibility is required.
