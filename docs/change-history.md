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
[RECORD-VERSIONS.md](../src/server/RECORD-VERSIONS.md). Legacy snapshot-history
helpers remain covered by existing development tests; encrypted-profile runtime
history uses the record indexes described here. No development-data migration is
required and no Git history rewrite is part of restoration.

## Verification

Fictional backend, API and mounted-component tests cover grouped A → B → A saves,
individual expansion, selected-field preservation, link and attachment recovery,
original-byte reuse, preview invalidation, concurrent edits, immutable entries,
profile isolation, retry idempotency and reconstruction of restoration receipts
and prior versions. No real medical data is embedded in tests or documentation.
