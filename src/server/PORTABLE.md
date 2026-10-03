# Profile sources and rebuilds

Durable profile inputs live under `data/profiles/<profileId>/sources/<provider>/`, `personal/`, `curation/`, `mappings/`, `chats/` and `attachments/`. Normal application startup projects working SQLite into a separate runtime directory; it does not open retained `db/` checkpoints. `profile-storage.ts` still defines `db/database.sqlite` for standalone rebuild/restore outputs and staging. `existingProfileDatabase` locates an existing current or legacy database for explicit recovery use, never creating an empty database when an expected one is missing. Portable backup/rebuild helpers remain contributor internals; the retired recovery CLI now refuses all commands before accessing archives or destinations. The helper's path must not be mistaken for the running app's database. See [runtime storage](../../docs/setup/docker-runtime.md) for the implemented lifecycle and [encrypted profiles](../../docs/security/profile-encryption.md) for the current encrypted lifecycle.

Normal contributor startup selects the [contributor accepted-record journal](../../docs/data/contributor-record-authority.md) when either `record-authority.json` or its sibling `records/` directory exists. The marker binds format and profile; `records/` retains the selected head, immutable objects and writer lock. Missing or corrupt selected evidence refuses without falling back to SQLite or older portable generations. Fresh initialization and unpublished copy staging are the only journal creation paths; an existing portable archive is not silently converted.

The following personal/curation generation details describe explicit portable export and recovery artifacts, including the opt-in `portableSnapshots: true` facility. They are not the default contributor mutation format. The canonical provider files remain unchanged in `sources`. Reviewed clinical mappings and metadata are explicitly exported into `curation`. Personal edits are complete snapshots of `people`, `notes`, `note_links`, `assets`, `attachments` and note/person `evidence`. Every SQL column is preserved, including unknown fields inside JSON strings. All assets remain indexed even when no note currently links them. A newer personal generation replaces the whole owned table set, so removed notes or attachment/link associations cannot reappear from an older snapshot. Previous generations remain on disk for recovery; no automatic cleanup runs.

`personal/current.json` and `curation/current.json` point to immutable, versioned `snapshots/*.json` files and include their SHA-256, length, profile and revision. A generation is written and fsynced before an atomic rename and directory fsync publishes its pointer. Readers verify the pointer and exact bytes. A failed pointer publication leaves the old generation authoritative; unpublished generation files do not silently become current.

Current personal snapshots also include `packetPreferences`: validated, separate `packet_preference:v1:` metadata rows for withholding and person-applied record tags. When present, this field replaces the older curation snapshot's packet preferences, including an explicitly empty set; older personal generations without it retain curation values. Ordinary runtime edits use the accepted-record journal, not recurring full preference snapshots. Earlier app builds do not enforce packet withholding. Use a build supporting the [packet choices contract](../../docs/features/selective-packets.md) before sharing recovered records.

## Application hooks

`attachPersonalDurability(db, {root, profileId})` selects contributor record durability by default. Supplying `recordStorage` attaches the injected accepted-record backend used by the encrypted runtime. Ordinary transactions append changed record versions and selected intake contributions; the accepted head publishes before SQLite COMMIT. A published head wins over a later rollback or ambiguous completion, and stale live state refuses further mutations until recovery. Original upload bytes must be durable before their accepting transaction. Startup and total cache-loss reconstruction use the selected journal, with original-reference verification and substantive state comparison; unacknowledged SQL changes cannot become authority.

`attachPersonalDurability(db, {root, profileId, portableSnapshots: true})` explicitly selects the retained portable-format transaction hook only when no record authority or record-history projection is selected. In this mode, the transaction marks `personal_dirty=1`, and post-commit `flushPersonal` captures complete personal tables under a new `BEGIN IMMEDIATE` lock. Publication failures after SQL commit are reported through `personalDurabilityStatus`; they cannot be presented as rolled-back edits. The dirty marker survives connection loss and supports retry. This mode cannot serve as fallback after journal failure.

In explicit portable mode, a selected portable revision newer than SQLite creates a sticky conflict. Autosave or export cannot replace that pointer merely because later edits increment the older database's revision. Rebuild or explicitly reconcile the selected generations first. These portable conflict and dirty-marker rules do not replace the journal's accepted-head recovery boundary.

## Reviewed clinical export

With record durability attached, `exportCuration` uses the journal and does not publish recurring complete personal/clinical snapshots. In explicit portable mode, call `exportCuration(db, root, profileId)` after each manually reviewed clinical import or curation change. It holds a SQLite write lock while saving a personal snapshot and a matching clinical snapshot. This explicit operation can take longer than a normal note save because it checks original source hashes and captures every retained clinical table. Ordinary note and asset saves never rewrite this corpus. Manual SQL edits that bypass the application must be followed by this export; they are not automatic provider imports.

Source-record IDs, acquisition attribution, source locators, clinical mapping tables, evidence, relationships, reports, source manifests, provider metadata and manual batch receipts remain intact. An exact matching JSONL line (including handling CRLF line boundaries) or complete original JSON file can replace `source_records.raw_json` in the portable generation with a checked byte-range reference. Rebuild reconstructs the identical UTF-8 string, retaining numeric spelling, large integers and literal archive-reference markers. If no exact source span matches, the generation retains `raw_json` verbatim. No canonical field is parsed and reserialized for this substitution. A hash mismatch fails explicitly.

`writePortableSources(db, sourceRoot, profileId, outputRoot)` writes matching personal and curation generations from an already consistent database snapshot without modifying that database or the live profile. Backups use it against SQLite's completed online backup snapshot. Other callers must supply their own stable snapshot or lock.

## Staged rebuild and recovery commands

`rebuildProfile(sourceRoot, profileId, newEmptyTargetRoot)` selects journal reconstruction when contributor authority is present. It retains the sibling selector and complete journal, verifies the selected head and originals, and creates a fresh SQLite projection without reading the old cache. It also retains explicit portable artifacts and auxiliary histories; their presence cannot override journal selection. Missing selected journal evidence refuses rather than invoking portable recovery.

For an archive with no selected contributor journal, the retained portable-format rebuild requires canonical source files, current curation/personal generations and referenced attachment originals. The old SQLite database is never read. Personal revision must be at least the curated revision. The function verifies generation/source hashes, table completeness and ownership, raw byte-range hashes, schema support, original file containment, ordinary foreign keys, polymorphic note/attachment/evidence targets (including whole test-series links), and SQLite integrity. It restores frozen notes with their original metadata and associations, then reinstates their immutable-note triggers. Unknown columns or tables fail rather than disappear.

All construction happens in a sibling staging directory. Only a fully verified rebuild is renamed into the new or empty destination. Failed work is removed; the source tree and active database remain untouched. Replacing active storage remains a separate reviewed action with the server stopped. No wipe-live-first operation exists.

These functions are retained for contributor fixtures and code-level recovery tests; they are not a supported operator CLI. The npm backup/restore aliases are removed. Direct `node src/server/recovery-cli.ts` invocation fails without reading an archive or writing a destination and directs the operator to [encrypted backup and recovery](../../docs/setup/deployment.md#backup-and-recovery).

Current contributor backups verify the source cache against selected journal authority, pin its head, and retain both `record-authority.json` and the complete `records/` tree alongside originals and auxiliary artifacts. Restore verifies their checksums; subsequent startup and rebuild select that journal, preserving its accepted history.

The retained `recovery.ts` helper's portable backup v2 stores the consistent SQLite snapshot, full portable table export, originals and matching rebuild generations in the symmetric layout. Restoring v2 can itself be rebuilt after deleting its restored database. Backup v1 remains restorable into its legacy layout, with original file paths intact; opening an older supported database applies sequential schema upgrades. Current backup code also retains the personal/curation history and mappings described below; older packages may have narrower coverage. Inspect and verify a package rather than assuming its age or presence proves complete recovery coverage. Existing packages are read only by explicit restoration, not normal app startup.

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

Backups and staged rebuilds also preserve every regular file under the selected profile’s `mappings/`, including nested rules and receipts, byte for byte. Backup manifests checksum these files and restore verifies them; symbolic links are rejected rather than following another profile or external path. Keeping a mapping file does not execute it or imply its acceptance. For portable-only archives, reviewed curation remains the projection input; selected contributor journals reconstruct accepted records from their own head. Older backup packages may lack standalone mappings, so keep a new verified backup before relying on one as the complete profile recovery copy.
