# Record journal foundation

`record-versions.ts` provides the approved append-only record format behind an
injected unlocked vault interface. This is the accepted-record format used by the encrypted runtime and the default
contributor durability backend; it does not itself implement encryption, credential
management, filesystem locking, backups, or the history/restoration HTTP API.

## Vault interface

All calls are synchronous, matching the existing SQLite transaction boundary:

- `read(name)` returns decrypted authenticated `Buffer`, or `null` if absent.
- `writeImmutable(name, bytes)` encrypts and durably publishes a new object without
  replacing an existing object. Names are `objects/<UUID>`.
- `publishHead(bytes)` authenticates, encrypts, atomically replaces and fsyncs the
  head (`read('head')`). This is the transaction acceptance boundary. The vault
  must durably publish referenced originals before accepting this head.

The caller owns the profile key, unlocked lifetime and exclusive writer lock.
No plaintext journal is written by this module. Logical JSONL streams use bounded
256 KiB objects by default; records may span objects, including UTF-8 boundaries.
Immutable commit objects list every segment and reference their previous commit.
Only the head's verified ancestry is accepted. Loose staged objects are ignored.

## Lifecycle and app hooks

`attachRecordDurability(db, {profileId, storage, verifyReferences?})` seeds the
initial database once or catches up an existing indexed SQLite projection.
`verifyReferences(versions)` is called before acceptance and during reconstruction;
the coordinator uses it to verify each changed source/asset's bytes and ownership.
`rebuildRecordDatabase(newDatabasePath, {profileId, storage, verifyReferences?})`
reconstructs all current records and full indexed history into a new SQLite file.
The callback must have access to retained original bytes during reconstruction.

The compatibility entrypoint is
`attachPersonalDurability(db, {root, profileId, recordStorage: storage, verifyReferences})`.
Its status and `exportCuration` use the journal without publishing personal or
clinical snapshots. Without `recordStorage`, this entrypoint selects the
[contributor filesystem journal](../../docs/data/contributor-record-authority.md)
by default. Contributor startup, backup and rebuild retain and select its head,
immutable objects and sibling `record-authority.json` selector; missing selected
authority cannot fall back to old portable generations. Explicit
`portableSnapshots: true` retains the separate portable-format facility only
when no record authority/history is selected. Portable-only archive recovery
continues to require its supported original format inputs; it is not an
automatic journal migration or fallback. The encrypted runtime uses the record
lifecycle above.

Every existing `transaction(db, fn)` captures changed row identities with temporary
SQLite triggers, then appends complete versions for only those records plus the
profile revision. Tombstones retain removed associations' complete previous row.
The durable commit precedes SQLite COMMIT; if SQLite is lost or rolled back after
head acceptance, reopening catches up the entire transaction atomically. A writer
whose cache trails the head refuses another mutation until reopening. Direct SQL
writes outside the transaction helper are rejected while hooks are attached.

Optional operation metadata uses
`transaction(db, fn, {operationId, fingerprint, expectedRevision, actor, origin, references})`.
A supplied UUID requires a stable request fingerprint. Repeated operations return
the persisted result without running `fn`; changed requests with the same UUID
and stale profile revisions fail. Existing callers without an operation ID get a
new ID per accepted operation and retain their existing record version checks.
Unknown actors/origins stay null. New HTTP-level retry IDs must be plumbed by the
HTTP owner; this foundation does not invent per-request provenance.

## Queries and reconstruction

`queryRecordHistory(db, {profileId, entity, recordId, field?, beforeSequence?, limit?})`
returns complete versions and field summaries, with explicit presence flags for
absent versus null values. For example, a person's birthday lives on their note
as `entity: 'notes', field: 'profile_json.birthDate'`. `recordId` is the literal
single primary key or an array of composite keys. Querying uses SQLite indexes
and never reads the vault. The supplied database must be attached to its unlocked
owning profile. Close it when locking; no history API exists for locked profiles.

SQLite projection 3 derives the two creation changes for an initial, nondeleted
`app_meta` version with exactly string `key` and `value` contents from its complete
validated version. It stores no field-reference rows for that case and refuses
unexpected references. Other versions retain exact stored field references.
Older projections require fresh reconstruction, not in-place relabeling. The
encrypted unlock owner rebuilds an incompatible cache from authenticated history;
direct contributor attachment refuses it and explicit staged recovery creates a
new target. This changes no accepted journal or original format.

The format pins the current application schema and projection version. Unsupported
schemas, revision/sequence gaps, broken ancestry, corrupt/missing committed bytes,
invalid previous versions, partial transactions and wrong owners fail explicitly.
Reconstruction applies complete rows without rerunning historical app mutations,
then verifies SQLite, foreign keys and polymorphic targets. Domain restrictions
such as finished-note immutability remain active on ordinary app transactions.

The fictional test suite covers bounded app edits amid 1,500 unrelated people,
A → B → A birthdays, absent/null, retry replay, optimistic conflicts, interrupted
publication, accepted-head/SQLite crash recovery, removed/re-added links, archive
events, finished-note restrictions, Unicode segment boundaries, and in-app source
intake with literal source values and separate acquisition occurrences.
