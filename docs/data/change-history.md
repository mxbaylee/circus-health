# Reviewing changes and restoring selected values

Encrypted profiles retain complete versions of changed records in their vault.
SQLite indexes both the current view and every accepted version. Opening History
reads those indexes; it does not replay the archive or consult Git. The profile
must be unlocked. Rebuilding SQLite reproduces the original changes and later
restorations without rerunning historical application operations.

## Review and editing sessions

Notes, historical drafts, finished personal notes and People expose **Review saved
history**. Pending editor changes and uploads must finish or be resolved first.
The history dialog shows saved time, entry version and profile revision. It groups
related autosaves by an explicit editing-session ID created when the editor
mounts. Every individual save remains expandable and selectable. Intervening
sessions stay separate, including when an earlier session resumes. A → B → A
retains both transitions. Saves without session metadata remain individual changes;
there is no invented actor, time-based session inference or “since last visit” baseline.

Each saved version shows what that save changed and compares its restorable values
with the current entry. Absence, null, empty text and empty lists remain distinct.
History pages contain up to 30 entry versions by default, with a maximum of 100.
Sessions may continue onto another page; grouping never removes older versions.

## Preview and restoration

1. Choose an individual save, including one inside an editing session.
2. Select editable fields and any removed links or attachment associations to
   restore. Other current fields and associations stay as they are.
3. **Preview restoration** resolves the exact old values and association identities
   on the server. The preview shows current and proposed values, retained-original
   metadata, the current entry version and the current profile revision.
4. **Restore selected changes** revalidates that preview and both versions. A
   concurrent change anywhere in the profile requires refreshing the comparison.
   The server never substitutes a full-note or full-profile restoration.
5. The application saves a new note version, selected associations and the
   restoration receipt in one journal transaction, referencing the exact selected
   note/link/attachment versions. A retry keeps the same operation ID and request.

Recovering an attachment association reuses its original asset and bytes. The
server verifies retained bytes, checksum, profile ownership and any linked person
before accepting the preview. Removed links require a current valid target. An
association already present is not added a second time. Restoration cannot change
an association's owner or rewrite an original upload.

Ordinary notes allow content, title and pin state. Historical drafts additionally
allow type, event date, topics and raw thoughts. People allow content, pin state
and known name, demographic, tag and contact fields. Unknown profile fields are
preserved. Self retains its stable identity and special relationship; restoration
cannot add outgoing Self links or change Self's tag/relationship rules.

Finished historical notes remain inspectable and immutable. Corrections use a new
linked entry. Provider assertions, source metadata, status and archive state are
outside this restoration operation. Archive/Restore continues to use its separate
visibility operation. Restoring a value does not reverse an external action.

## API

- `GET /api/profiles/:profile/notes/:id/history?cursor=<versionId>&limit=30`
  returns indexed entry versions, current comparisons, individual-save changes,
  explicit session groups and removed-association choices. `generationId` retains
  its existing response property name but contains the accepted record version UUID.
- `POST /api/profiles/:profile/notes/:id/restore-preview` accepts `generationId`,
  `fields`, optional `associations: {links: [id], attachments: [id]}`, expected note
  `version`, and optional `expectedRevision`. It returns exact changes,
  `expectedRevision` and a comparison `previewToken`. Inspection is read-only.
- `POST /api/profiles/:profile/notes/:id/restore` accepts the identical selection,
  note `version`, `expectedRevision`, `previewToken`, a stable UUID `operationId`
  and optional request text. The server resolves stored values; callers cannot
  submit replacement contents, file paths or SQL.

The restoration receipt and operation fingerprint survive cache loss and rebuild.
Conflicting reuse of an operation ID fails. The assistant's field-restoration
proposal retains the same concrete preview and revision before user approval.
Association restoration is currently offered through the history dialog; assistant
restoration tools retain their existing field-only scope.

The underlying journal API and vault callback contract are documented in
[RECORD-VERSIONS.md](../../src/server/RECORD-VERSIONS.md). Legacy snapshot-history
helpers remain covered by existing development tests; encrypted-profile runtime
history uses the record indexes described here. No development-data migration is
required and no Git history rewrite is part of restoration.

## Verification

Fictional backend, API and mounted-component tests cover grouped A → B → A saves,
individual expansion, selected-field preservation, link and attachment recovery,
original-byte reuse, preview invalidation, concurrent edits, immutable entries,
profile isolation, retry idempotency and reconstruction of restoration receipts
and prior versions. No real medical data is embedded in tests or documentation.

## Ownership evidence and correction scope

Clinical history and current person ownership are separate facts. Earlier accepted
versions and receipts describe the decision made at the time; a later correction must
append evidence of the new decision instead of rewriting that history. Original files
remain profile-owned evidence. Historical attribution must not perpetually authorize
future matching to a person whose assignment has been corrected; see
[historical attribution and current name authority](../import/identity-review.md#historical-attribution-and-current-name-authority).

A report contribution and a whole saved record are different scopes. Two reports can
support one canonical record after a reviewed occurrence attachment. Correcting one
report cannot move the other report's valid contribution or copy clinical values that
only the other report supports. Selecting the whole saved record instead includes all
its current sources. This distinction preserves the assembler's source provenance while
making the caregiver's correction predictable. Similarly, one report's assignment,
clinical records and applicable name effects form one coupled correction: publishing
only its header or part of its records would misrepresent current ownership. Independent
clinical approvals do not impose that same coupling.

A medication-taking assertion belongs to its person. Transferring source evidence
cannot authorize current use by another person or erase a destination person's own
independent activity decision. Equal-looking destination records also do not establish
one event; linking evidence requires a separate reviewed matching decision.

Ownership corrections publish current clinical rows, changed source/person links, name
support decisions and (for report scope) the standing report assignment together. A
whole report is one atomic group. Selected saved records from unrelated reports publish
as independent displayed groups; shared report, name, relationship and explicit link
dependencies coalesce their records. Selected records that could become destination
matches for each other also publish together, preserving the exact displayed choice. A parent operation retains small group manifests
with the first committed group. A later failure preserves earlier receipts and returns
exact saved and needs-review outcomes. Repeating the parent returns those original
outcomes; unsaved groups require a new preview. A new Person is created once, together
with the first successful group. The existing logical record
journal stages changed complete versions into bounded segments and publishes one head;
prepublication failure exposes no part of the correction. Preparation and segment
verification stream records rather than assembling a second whole-transaction payload.
Earlier versions, original bytes, acceptance receipts and attachment decisions remain
available after a SQLite rebuild.

The profile-scoped API provides `POST /record-ownership/preview`,
`POST /record-ownership`, `GET /record-ownership/:operationId` and
`GET /record-ownership/people` below `/api/profiles/:profileId`.
It runs behind the existing unlocked-profile, session and origin boundary. The commit
recomputes the preview under the durable transaction and requires its exact version and
scope token. Same-ID, same-input retry returns the original outcome; conflicting reuse
fails. The transaction/group receipt contains counts and references. Per-record events
retain the affected IDs, prior-version fingerprint and owner transition; response
outcomes are reconstructed from those events instead of copied into the durable receipt.

A source-occurrence authority records the retained source identity, original/envelope
fingerprints, reviewed mapping and destination version reference. Reimport follows that
corrected contribution, including after a split or explicit link, rather than reviving
an old attachment. Changed destination contents or source evidence require current
review. An old linked-record address explains the ownership correction before offering the
chosen current destination. Historical note links keep their stored tuples and visibly
identify that destination; backlinks retain the note’s own person and historical context;
record history still queries the former stable ID and shows its accepted versions.
Navigation composes each identity’s classification history with ownership links, so
bookmarks and note backlinks remain valid across corrections on either side of a link.
Clinical edits and ownership corrections reuse the existing projection adapters.
Split current metadata is reconstructed from each side’s original occurrence and the
explicitly reviewed mapping. Merged correction/identity/source arrays are not attributed
to either side without source support; the ownership review points to the preserved prior
version. Provider attachments follow their occurrences with captions, dates and body
locations intact, and their current person attribution follows the reviewed destination.
Personal attachments remain on the retained record, or follow its explicit whole-record
link. Same-owner confirmation records only an idempotent no-op receipt, without granting
new source, report or name authority. When a partial correction challenges an existing
report default, a small versioned hold references that exact default operation. It is
published with the affected group; a failed group cannot revoke unrelated authority.
The hold survives replay and permits a new explicit valid confirmation after review.

Remembered-name support is recorded per confirmation before the legacy display list
can deduplicate a spelling. Manual name edits, primary names, remaining confirmation
support and unknown legacy provenance are assessed separately. Current matching filters
superseded supporting receipts while preserving them for audit and exact operation replay.
The earlier rule that historical linkage alone permanently protected a learned alias
was superseded: keeping that mistaken authority active would repeat the original error.
See the [correction workflow and current limitations](../import/identity-review.md#correcting-accepted-person-assignments).
