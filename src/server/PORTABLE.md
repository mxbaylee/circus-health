# Profile sources and rebuilds

Durable profile inputs live under `data/profiles/<profileId>/sources/<provider>/`, `personal/`, `curation/`, `mappings/`, `chats/` and `attachments/`. Normal application startup projects working SQLite into a separate runtime directory; it does not open retained `db/` checkpoints. `profile-storage.ts` still defines `db/database.sqlite` for standalone rebuild/restore outputs and staging. `existingProfileDatabase` locates an existing current or legacy database for explicit recovery use, never creating an empty database when an expected one is missing. The active recovery CLI rebuilds from portable inputs before making a backup. The helper's path must not be mistaken for the running app's database. See [runtime storage](../../docs/docker-runtime.md) for the implemented lifecycle and [encrypted profiles](../../docs/profile-encryption.md) for planned changes.

The canonical provider files remain unchanged in `sources`. Reviewed clinical mappings and metadata are explicitly exported into `curation`. Personal edits are complete snapshots of `people`, `notes`, `note_links`, `assets`, `attachments` and note/person `evidence`. Every SQL column is preserved, including unknown fields inside JSON strings. All assets remain indexed even when no note currently links them. A newer personal generation replaces the whole owned table set, so removed notes or attachment/link associations cannot reappear from an older snapshot. Previous generations remain on disk for recovery; no automatic cleanup runs.

`personal/current.json` and `curation/current.json` point to immutable, versioned `snapshots/*.json` files and include their SHA-256, length, profile and revision. A generation is written and fsynced before an atomic rename and directory fsync publishes its pointer. Readers verify the pointer and exact bytes. A failed pointer publication leaves the old generation authoritative; unpublished generation files do not silently become current.

## Application hooks

`attachPersonalDurability(db, {root, profileId})` enables the transaction hook and retries pending work at startup. Injected test databases may leave durability disabled. The ordinary `transaction` helper marks `personal_dirty=1` in the same transaction as the user edit. After the SQLite commit, it calls `flushPersonal(db)`, which captures all personal tables and publishes their generation under a new `BEGIN IMMEDIATE` lock. Other database writers cannot interleave changes during capture or publication.

File-write failure after a successful SQLite commit must not be presented as a rolled-back edit. `flushPersonal` returns `personalDurabilityStatus(db)` with `configured`, `dirty`, `revision`, `persistedRevision`, `conflicted` and `lastError`. The API should return the saved resource plus this status, display a durability problem, and offer a retry. The dirty marker and error survive connection loss. The original upload bytes must be durably written before the asset's database transaction; snapshots store asset identity and metadata rather than rewriting its bytes.

An existing portable personal revision newer than SQLite creates a sticky conflict. No subsequent autosave or export may replace that pointer merely because more edits incremented the older database's revision. Rebuild from the newer source generation or explicitly reconcile the two histories first. A staged rebuild clears the marker only after restoring the selected portable state. A conflicted database cannot create a misleading database-based backup that would replace the newer portable state.

## Reviewed clinical export

Call `exportCuration(db, root, profileId)` after each manually reviewed clinical import or curation change. It holds a SQLite write lock while saving a personal snapshot and a matching clinical snapshot. This explicit operation can take longer than a normal note save because it checks original source hashes and captures every retained clinical table. Ordinary note and asset saves never rewrite this corpus. Manual SQL edits that bypass the application must be followed by this export; they are not automatic provider imports.

Source-record IDs, acquisition attribution, source locators, clinical mapping tables, evidence, relationships, reports, source manifests, provider metadata and manual batch receipts remain intact. An exact matching JSONL line (including handling CRLF line boundaries) or complete original JSON file can replace `source_records.raw_json` in the portable generation with a checked byte-range reference. Rebuild reconstructs the identical UTF-8 string, retaining numeric spelling, large integers and literal archive-reference markers. If no exact source span matches, the generation retains `raw_json` verbatim. No canonical field is parsed and reserialized for this substitution. A hash mismatch fails explicitly.

`writePortableSources(db, sourceRoot, profileId, outputRoot)` writes matching personal and curation generations from an already consistent database snapshot without modifying that database or the live profile. Backups use it against SQLite's completed online backup snapshot. Other callers must supply their own stable snapshot or lock.

## Staged rebuild and recovery commands

`rebuildProfile(sourceRoot, profileId, newEmptyTargetRoot)` requires only canonical source files, current curation/personal generations and referenced attachment originals. The old SQLite database is never read. Personal revision must be at least the curated revision. The function verifies generation/source hashes, table completeness and ownership, raw byte-range hashes, schema support, original file containment, ordinary foreign keys, polymorphic note/attachment/evidence targets (including whole test-series links), and SQLite integrity. It restores frozen notes with their original metadata and associations, then reinstates their immutable-note triggers. Unknown columns or tables fail rather than disappear.

All construction happens in a sibling staging directory. Only a fully verified rebuild is renamed into the new or empty destination. Failed work is removed; the source tree and active database remain untouched. Replacing active storage remains a separate reviewed action with the server stopped. No wipe-live-first operation exists.

From `src` with Node 24.19+:

```sh
node server/recovery-cli.ts export-sources <profile-id>
node server/recovery-cli.ts rebuild <profile-id> /absolute/new-empty-target
node server/recovery-cli.ts backup <profile-id>
node server/recovery-cli.ts restore /absolute/backup /absolute/new-empty-target
```

Backup v2 stores the consistent SQLite snapshot, full portable table export, originals and matching rebuild generations in the symmetric layout. Restoring v2 can itself be rebuilt after deleting its restored database. Backup v1 remains restorable into its legacy layout, with original file paths intact; opening an older supported database applies sequential schema upgrades. Current backup code also retains the personal/curation history and mappings described below; older packages may have narrower coverage. Inspect and verify a package rather than assuming its age or presence proves complete recovery coverage. Existing packages are read only by explicit restoration, not normal app startup.

Schema 3 adds whole-measurement note links and Self profile details. Fresh bootstrap sets the profile's patient name before this migration creates Self. Rebuild keeps supported original migration timestamps and applies the current schema's constraints and protection triggers.


Backup, export and rebuild accept profile IDs from the explicit registry. Every profile uses the same symmetric storage and owner checks. A database-only fixture backup restores to `data/profiles/<profile-id>/db/database.sqlite`; modern backups also retain personal and curation generations. Restoration and startup never fall back to another profile's working database. Unknown profile IDs are rejected.

### Retained curation candidates in backups and full rebuilds

Full profile backups and `rebuildProfile` preserve every regular file under the
profile's curation directory byte-for-byte, including older snapshots, retained
pointers, and opaque candidates. The source `current.json` is additionally saved
under `curation/retained-pointers/<sha256>.json`; the output's active pointer still
comes only from the explicitly selected generation or consistent backup snapshot.
No loose candidate is promoted, and a candidate's existence is not evidence that
it was accepted.

Each copy writes an immutable `curation/history-receipts/` receipt with the source
path, retained path, exact byte count, SHA-256, and `acceptance: not-inferred`.
Existing receipts remain retained too. Available originals referenced only by
historical curation candidates are verified against their recorded hashes and
copied; backups include them in their checksummed original-file inventory. A
missing, invalid, mismatched or foreign-profile historical reference is marked
`unavailable` in the history receipt, while its candidate bytes remain preserved.
Validation of the active generation and its originals remains strict. Symlinks
and nonregular entries in the retained curation tree are rejected.

`writePortableSources` returns the paths of all copied portable files and any
additional historical originals. These are classified separately in backup
manifests so historical originals receive the same checksum verification on
restore as current originals. Runtime startup reconstructs SQLite in place and
does not copy or remove durable curation history.

## Standalone mapping files

Backups and staged rebuilds also preserve every regular file under the selected profile’s `mappings/`, including nested rules and receipts, byte for byte. Backup manifests checksum these files and restore verifies them; symbolic links are rejected rather than following another profile or external path. Keeping a mapping file does not execute it or imply its acceptance. The reviewed curation remains the projection input. Older backup packages may lack standalone mappings, so keep a new verified backup before relying on one as the complete profile recovery copy.
