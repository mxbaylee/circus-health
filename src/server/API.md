# Local API contract

Profile registry: GET `/api/profiles` returns `Profile[]`. Generated fictional profiles have `placebo: true`; private profiles do not. Every data endpoint below is relative to `/api/profiles/:profileId`, with **no unscoped fallback**. All returned asset/source content URLs already contain the selected profile. Each profile has its own database with verified `app_meta.owner_profile_id`; note links cannot cross databases. Originals and attachments retain their logical paths within the unlocked profile; durable profile files are encrypted beneath `CRS_DATA_DIR/profiles/<profile>/`. Legacy backup paths remain supported only for recovery. A profile switch is a local presentation boundary, not account authentication.

Envelope `{data, meta:{revision,total,complete,limit?,offset?,coverage?,durability?}}`. Errors `{error:{code,message}}`. Shared response types live in `../shared/api.ts`. JSON keys are camelCase. All lists use `q`, `limit` (default 50/max 200), `offset`. Accepted durable records and original evidence remain canonical; SQLite is a rebuildable projection in runtime tmpfs, outside `CRS_DATA_DIR`.

Clinical ownership is distinct from profile authorization. `/tests`, `/test-types`, `/trends`, `/medications`, `/procedures`, `/documents`, `/historical-notes`, `/historical-note-options`, and `/vision-prescriptions` accept `personId`, defaulting to `patient` (Self). Family IDs come from saved People `personId`, not the Person note ID. A trend or comparison only contains that owner's records. Observation, medication, procedure and historical-note details return `personId`; document details do too. Direct record IDs remain reachable independently of list filters. `/clinical-person/:personId` resolves `{personId,noteId,name}` for the owner banner and Person navigation. GET `/documents?personId=&q=&visibility=&limit=&offset=` lists accepted document summaries `{id,personId,title,date}`; default visibility is active and `visibility=all` includes inactive entries. People provides links to each owner-scoped collection and these documents. Current medication assertions apply to the selected owner's record, never to another person's prescription.

The assistant `query` tool exposes the same `personId` filter and a `documents` collection. It can first query/read People to obtain the established owner ID; omitting it retains Self defaults. New related-record searches, same-event decisions and confirmed clinical relationships cannot combine different owners. Print packets started from an authored note use that note’s immutable owner, including a family member. Packet identity, normalized clinical records, selected notes and test-series expansion must belong to that person; mixed-owner selections fail with `EXPORT_SUBJECT`. Direct family Person/provider-document packet starts remain unavailable.

## Direct accepted-record corrections

`POST /intakes/:intakeId/related-records` accepts `{proposalId,recordId,candidateVersionId,query?,cursor?,limit?}` for one current pending candidate. It returns ranked possible matches, bounded pagination/truncation metadata and exact incoming/saved version scopes. The default window is 20, maximum page 50, and maximum search window 200. Changed candidate or search state invalidates cursors. Similar codes, names, dates and values locate evidence; they never authorize a relationship. New relationship choices must echo the inspected scope. Retained stale or legacy choices remain visible but must be reviewed before acceptance.

`POST /clinical-review/correction-preview` accepts `RecordCorrectionRequest` from `shared/record-correction.ts`: `{kind,recordId,set,reason,supportingEvidence?}`. The supported kinds are observation, medication, procedure and document with an existing reviewed import mapping. The preview returns the current and proposed mappings, editable fields, permitted target kinds, saved evidence, resolved supporting originals, the proposed destination, and an exact `version`/`previewToken`. Subject and source identity are immutable; medication cross-kind changes remain unsupported. This preview does not accept or change an incoming candidate.

Optional supporting references (maximum eight) contain the exact `{intakeId,proposalId,recordId,candidateId,candidateVersionId,originalSourceFileId}`. The host validates the current candidate/proposal, same-profile retained bytes/hash, evidence linkage, and exact package-member occurrence where applicable. An outer ZIP or an equal-byte sibling does not establish member linkage. Resolved references include the original URL/hash and bounded occurrence metadata. Selecting support is an explicit human correction decision, not a host assertion that matching values prove clinical identity.

`POST /clinical-review/correction-apply` accepts the preview's unchanged `request` plus `{version,previewToken,operationId}`. Both endpoints require JSON and a maximum 256 KiB body within the existing authorized profile/session/origin boundary. Apply uses the existing accepted clinical-decision transaction and durable operation receipt. Changed previews fail with `CLINICAL_REVIEW_CHANGED`; conflicting reuse of an operation ID fails with `OPERATION_CONFLICT`. An exact replay returns the saved receipt even if the candidate was superseded or the corrected record later changed kind. `destination` points to the current actual clinical route; the receipt preserves the earlier before/after decision. Publication retry state is exposed as optional `durability`.

The supporting original, reason, and before/after mappings remain in the accepted correction history and exception journal, including after incoming review deferral, supersession, backup/rebuild or encrypted cache loss. The incoming draft and acceptance history remain unchanged. Supporting references add attribution to the correction history; they do not create accepted source records for the incoming candidate. `sourceUnchanged: true` means original bytes and raw source records remain unchanged.

## Clinical relationships and display preferences

`POST /clinical-relationships/preview` and `/clinical-relationships/apply` use the exact DTOs in `shared/clinical-relationships.ts`, bounded JSON bodies (256 KiB), and the existing authorized profile/session/origin boundary. Preview retains both literal sides and originals. Apply echoes `{request,scope,version,previewToken}` with a stable operation UUID. Provider amendment confirmation requires its own directed evidence/attestation; a separate display preference requires explicit same-recorded-event review. Neither matching values nor an old pair decision establishes those claims. Current sides for a new or stale comparison are read with `GET /clinical-relationships/pair?leftKind=&leftRecordId=&rightKind=&rightRecordId=`. The host resolves current assertions and verifies both originals; historical snapshots are not reused as current facts. Reads are `GET /clinical-relationships?kind=&recordId=`, `GET /clinical-relationships/operations/:operationId`, and paged `GET /clinical-relationships/history?kind=&recordId=&beforeSequence=&limit=` (default 20/max 50). See [relationship scope, history and recovery](../../docs/data/clinical-relationships.md).

Trend points retain every source assertion and include a compact optional `relationship` summary. Its display guidance is a rebuildable projection of explicit accepted decisions. Default charts honor a preferred assertion only if it is in the selected filters; the alternative remains in Recorded values with navigation to review. Show-both keeps both literals while counting one reviewed event. Stale, conflicting or undecided relationships preserve every assertion without event grouping. Raw list pagination/counts continue to count retained assertions, not inferred clinical events.

## Reviewed measurement semantics

`GET /clinical-review/measurement?kind=observation|procedure&recordId=...` returns the exact accepted literal, unit/comparator, source reference and current or stale/revoked semantic binding. It resolves the accepted assertion on the host and rechecks original evidence. Only accepted Self scalar observations/procedures with supported mapping evidence qualify; optical, medication and arbitrary client-supplied measurements are excluded.

`POST /clinical-review/measurement-preview` accepts `{kind,recordId,semantics,precision,reason}`. Complete reviewed semantics describe quantity, dimension, region, specimen, method and meaning; unknown fields do not imply compatibility. Precision is either null or an explicit supported rounding statement. Null semantics and precision revoke a mapping. The preview includes originals, exact reference, rules version, profile revision and token. `POST /clinical-review/measurement-apply` accepts the unchanged request plus `{reference,rulesVersion,version,previewToken,operationId}`. Both require JSON with a 256 KiB maximum. They use the same authenticated profile/origin boundary as corrections and append to the existing accepted journal. Exact retries return the retained decision; changes to the source assertion invalidate the binding. See [measurement rules and limits](../../docs/features/measurement-comparison.md).

## Public runtime readiness

`GET /api/runtime` and `GET /health/ready` return a top-level readiness object rather than the data envelope: `ready`, `outcome`, `phase`, `encrypted`, `buildId`, `revision`, `worktree`, and available startup metrics. They return 200 when ready and 503 while unavailable, with `Cache-Control: no-store`. These public probes neither unlock a profile nor invoke a model. Startup metrics can include profile count and elapsed time; readiness is not a statement about model availability or validation of every locked archive.

`buildId` is the UUID embedded in the production client bundle and `dist/build-info.json`. The server reads the manifest once at boot; restarting the same image preserves its ID. Missing or invalid manifests produce `null`, not a newly invented build. `revision` is the full Git object ID captured during the build; `worktree` is `clean`, `dirty`, or `unknown`. A dirty build includes changes beyond that revision and is not claimed to equal the commit. Missing Git metadata produces `revision: null` and `worktree: "unknown"`. No branch name, source path or diff is exposed. The browser checks this endpoint independently of profile reads and offers a guarded manual refresh when two known build IDs differ. See [connection behavior](../../docs/setup/connection-awareness.md).

## Import diagnostic instrumentation

`import-diagnostics.ts` provides a profile-partitioned instrumentation API. `run({profileId,requestId,clientRequestId,importId,batchId,runId,sliceId,turnId,providerRequestId}, operation)` carries opaque correlation identifiers across asynchronous work. Import and extraction owners can use `startActive(profileId, context)` and its idempotent `finish()` method to bound active work and enable process resource sampling. `record()` accepts only the fixed event-name union, finite numbers, booleans, nulls, and allowlisted short diagnostic codes. Payload structure is represented by counts, depth, and serialized byte size; raw values and property names are not retained. Because of that rule, the per-page sub-timing and count fields on `model.tool.completed` (see [INTAKE.md](INTAKE.md#sequential-reading-batches)) are numbers and booleans by design, never labels; a diagnostic value that needed to carry a label would have to fit the same short allowlisted-code shape, and `phase` on `import.phase.*` events does exactly that, reusing the existing allowlisted diagnostic-code pattern rather than a separate mechanism. The authorized `GET /api/profiles/:profileId/import-diagnostics` endpoint exports this bounded metadata for the selected open profile; it never returns private payload files.

The recorder is disabled by default. A controlled application process can opt in with `CRS_IMPORT_DIAGNOSTICS=true`, or tests can inject a recorder through `createApp({diagnostics})` and model-bridge options. Each profile keeps at most 10,000 events by default and construction-time capacity remains bounded from 10 through 10,000. `snapshot(profileId)` is an in-process profile view. `exportSnapshot(profileId)` returns the same bounded events with correlation IDs salted per export, so IDs remain joinable inside one export but not across exports. It also exposes a top-level `consoleScopeId`, an opaque process/profile scope shared with the controlled console envelope but not stored inside event objects; protected capture can therefore match the exact authorized profile without exposing its raw ID. Successfully retained private payloads use a separate random `traceEventId` in the protected trace entry and corresponding metadata event; that opaque join key does not replace or expose salted source/run identifiers.

Raw import payload capture remains a separate explicit opt-in through `CRS_IMPORT_PRIVATE_TRACE=contains-health-data`, an exact-profile reloadable grant and a protected external directory. Defaults are 512 MiB total uncompressed JSON, 24 MiB per entry and 8,192 entries. Operator environment caps and hard maxima are documented in [the intake contract](INTAKE.md#sequential-reading-batches). Invalid caps disable private capture with an explicit status reason and never stop import. Only private-trace status, counts and configured limits enter the metadata export. The current supported `compose.yaml` does not forward these diagnostic variables or mount the protected paths; that Make/Compose release wiring is still a deployment gate. A correctly configured separately controlled validation runtime must be evidenced on its own rather than inferred from this server capability.

Profile HTTP requests record start plus exactly one completed/aborted terminal event with method, status, elapsed time, declared request bytes when available, and response-body bytes for application-owned responses. Every dispatched profile response carries a fresh `X-Request-ID`; a syntactically valid UUID in `X-Client-Request-ID` is retained only as a correlation identifier. Query strings, route identifiers, profile IDs, other headers, bodies, filenames, and error messages are excluded. Process CPU, RSS/heap/external memory, and event-loop delay are labeled process-wide and sampled only while one or more active import scopes exist; they do not measure provider-side resources.

## Profile data

Self and People share established identity names (`person.fullName`, `person.knownNames`), separate from the note's display title. Report confirmation also returns server-owned `person.sourceKnownNames` with retained source provenance; ordinary person saves preserve these names and cannot author or remove their provenance. Exact comparison ignores case and repeated whitespace and recognizes the explicit `surname, given names` convention. It does not infer nicknames or reorder arbitrary words. Automatic import attribution requires one uniquely matching active owner across Self and all People, grounded in the current retained report subject. A shared name, contradictory DOB, DOB alone, unresolved refusal, or unverified model claim requires explicit choice. Archived People are unavailable to matching, the chooser, and new clinical acceptance until restored. See [retained person names](INTAKE.md#retained-person-names) for the confirmation and durability contract.

### Retained import text

All routes below inherit the unlocked, authorized profile boundary. `GET /intakes/:id/source-text` returns an explicit unavailable state or immutable current revision; `revisionId` selects history. It never starts extraction. `POST /intakes/:id/source-extract` takes `operationId` and `expectedRevisionId` (null only before first extraction), and advances at most two pending pages. `POST /intakes/:id/source-text` applies a shared `SourceTextReviewRequest` with source hash, expected revision and idempotency key; it cannot accept clinical records.

Extraction persists a started operation before worker dispatch and returns `extractionOperation` with its exact revision and `completed` or `interrupted` status. An identical retry joins active work or returns the original receipt; it cannot advance another pair of pages. Reusing a key with different arguments conflicts. An interrupted operation retains published partial evidence and requires a new explicit operation to continue; it is never silently replayed after restart.

`GET /intakes/:id/source-preview?page=…&revisionId=…` returns a bounded raster or literal original text, with a current-revision check. `source-passage` supports revision, page, span offset and character cursors; `source-history` exposes bounded immutable review history. `source-annotation` retrieves exact fragments of alternatives, issue text or review reasons/clarifications omitted from bounded summaries. `source-search` performs revision-pinned, case-sensitive literal search (at most 20 matches per response); it does not infer clinical facts. Follow returned cursors and explicit truncation references. The assistant's `health_intake_source_text` tool exposes the same evidence under its existing source/profile scope.

Original bytes, text review, clinical interpretation and acceptance have separate authority. Any new source revision conservatively invalidates older unaccepted interpretations; descendant changes invalidate ancestor package proposals too. Earlier accepted versions stay intact. A provider proposal must name the current source-text revision when one exists.

- GET `/overview` → Overview
- GET `/providers` → Provider[]
- GET `/tests` → Observation[]; filters `testTypeId`, `providerId`, `from`, `to`, `sort=oldest|newest`.
- GET `/tests/:id` → Observation including evidence/attachments.
- GET `/test-types` → TestType[]; `q` searches aliases too, filters `providerId`, `from`, `to`.
- GET `/trends?ids=id1,id2&from=&to=&providerId=` → Trend[]; **all rows in every selected series**, no pagination, includes text/comparator records so no false zero plotting. Up to 12 selected series. Optional `unit=` selects a supported comparison unit and returns `measurement` beside unchanged original point fields. This verifies at most 256 explicit accepted results in one request; larger converted selections fail without truncation. Missing/stale semantic review and incompatible units produce explicit non-conversion statuses. Omit `unit` for the ordinary full history.
- GET `/medications`, `/procedures` → typed lists; GET corresponding `/:id` for details.
- GET `/medications?status=current|archived|all` defaults to current (Active in the UI). Legacy `active` maps to current; `inactive`, `unknown` and `unreviewed` map to archived (Inactive). Search, provider filter, counts and pagination respect the selected status; direct IDs remain available regardless of status filters.
- GET `/sources` → SourceFile[]; filters `acquisitionProviderId` (immutable acquisition provider), `reviewedSourceProviderId` (mutable reviewed intake label), and `kind`. The compatibility `providerId` filter keeps its earlier effective-source behavior: reviewed source when present, otherwise acquisition. GET `/sources/:id` → SourceFile. The response's `providerId`/`provider` always mean acquisition attribution stored on the file; nullable `reviewedSourceProviderId`/`reviewedSource` expose the latest reviewed intake source separately and never rewrite acquisition. The Sources UI has search and visibility controls rather than a provider picker; search includes retained metadata, so a reviewed source label remains findable. GET `/sources/:id/content` → original bytes by ID.
- GET `/source-records/:id/resolved` → `{source,resolvedText,referenceCount,providerId,format,preservation}`. Explicit derived view of a factored archive capture/context; unchanged raw envelope stays in `source`. `resolvedText` retains exact numeric token spelling and array order/repetition. Only single-key `$health_archive_ref` markers expand; record/text pools are literal terminals, context pools recurse within the provider namespace. Missing references/cycles fail explicitly. Interactive size limits return an error instead of a silently partial reconstruction. `fileView=reference` explicitly replaces only the nested source-file details with typed references and on-demand metadata links; absent or `full` retains the legacy nested shape.
- GET `/source-records/:id/evidence?scope=clinical&limit=&offset=` → raw evidence rows `{id,entityType,entityId,sourceRecordId,role,locator}` for that exact source record and the four supported clinical kinds: observation, medication, procedure and document. The bounded list is ordered by stable evidence ID, preserves separate roles and locators, and does not hide inactive or missing clinical targets. It does not infer clinical correctness or source-file extraction completeness. Missing source records return 404; malformed scope or pagination fails rather than becoming an empty/default window.
- GET `/source-records` → SourceRecord[]; filters `sourceFileId`, `originalSourceFileId`, `providerId`, `kind`. Each record includes its record-level `providerId` and joined `provider` label. These describe that retained occurrence and remain distinct from acquisition or extraction attribution on nested files. `originalSourceFileId` includes direct records plus records from every retained intake proposal whose server-stored lineage names that exact original; a locator claim alone cannot establish the relationship. GET `/source-records/:id` → SourceRecord including the same joined record source, full source files and relationships. `fileView=reference` is an explicit compact projection: source-record raw/literal evidence and relationships remain unchanged, while `file`, `extractionFile`, `originalFile` and `ancestorFiles` become discriminated `SourceFileReference` objects without `details`; each includes immutable content and full-metadata URLs. Absent or `full` preserves the legacy response. Repeated or unsupported `fileView` values fail.
- GET `/notes` → Note[]; non-Person notes default to Self and accept `personId`. Use `kind=person` for the shared People directory. Other filters: `kind`, `typeLabel`, `status`, `tag`, `pinned=1`, `archived=1` (default unarchived); `filters` builder JSON is supported when `kind=person`.
- GET `/historical-notes` → HistoricalNote[]; combines personal historical notes and eligible provider clinician documents. Filters `q`, `typeLabel`, `source=all|personal|provider|<providerId>`, `status=all|draft|finished|provider`, `sort=newest|oldest`, `limit`, `offset`, plus `filters` builder JSON.
- GET `/historical-notes/:id` → HistoricalNote using the existing personal note or document ID; independent of list filters.
- GET `/historical-note-options` → `{sources:[{id,label,count}],types:string[],acquisitionSources:[{value,label}]}`; global eligible collection options, including all/personal/provider and individual issuing provider IDs.
- GET `/vision-prescriptions` → `VisionPrescriptionRecord[]` (see `../shared/vision.ts`); filters `documentId` (exact accepted entity), `q`, `providerId`, `from`, `to`, `sort=oldest|newest`, `visibility`, `limit`, `offset`. Reads only reviewed document mappings containing `opticalPrescription`, with optional exact source type/status text plus literal values and dates. Each evidence occurrence has its own `occurrenceId` and `sourceRecordId`; equal values/dates do not merge occurrences. The UI route is `/tests?view=vision`.
- GET `/documents/:id` → `{id,title,date,sourceRecordId,text,extra,attachments}`.
- GET `/notes/:id` → Note (links resolve current titles; backlinks point to their current source note).
- GET `/notes/:id/source-evidence?limit=&offset=` → distinct imported sources evidenced for that saved Person, with every accepted observation, medication, procedure or document evidenced by the same exact `source_record_id`. Pagination counts Person sources and never splits one source's entries across pages. Results resolve current clinical classifications and navigation while retaining missing/inactive state. This read-only relationship does not create `note_links` or infer a clinician, care-team or other role; file, report, date and name proximity are not joins.
- GET `/person-tags` → built-in suggestions plus used custom tags, excluding legacy Self tags.
- GET `/person-filter-options` → `{tags,relationship,lifeStatus}` lists of `{value,label}` from unarchived People in the selected profile; the UI adds explicit unknown choices.
- GET `/note-types` → string[] (Therapy, Primary care, Specialist plus used labels).
- POST `/notes` body NoteInput → Note; historical starts draft, other kinds editable. No fixture writes.
- PUT `/notes/:id` body NoteInput with mandatory `version` → Note. Replaces supplied fields; omitted links preserved. Finished content rejected.
- POST `/notes/:id/convert` body `{version,typeLabel?,eventDate?}` → same Note as historical draft.
- POST `/notes/:id/finish` body **full NoteInput with version** → Note; atomic save of intended body/metadata/links, then finalization. Never finish stale server content on save conflict. Completed uploads must be attached before finish.
- POST `/notes/:id/correction` body `{title?,content?}` → new historical draft with a `corrects` link. Original unchanged.
- GET `/link-targets?q=&type=&limit=` → LinkTarget[], filtered by note/person/observation/test_type/medication/procedure/source/document. A test_type is a whole measurement history; an observation is one result.
- GET `/link-target?type=&id=` → one resolved LinkTarget for prelinked comment creation.
- GET `/related-notes?targetType=&targetId=` → personal comments/backlinks, including complete content, saved `textFormats`, attachment counts and archived context.
- PATCH `/medications/:id/current-status` body `{status:current|not_current|unknown,version}` → Medication, updating only a personal assertion. `version=0` when no assertion exists; stale writes return `409 VERSION_CONFLICT`.
- GET `/storage` → current portable durability state. POST `/storage/flush` body `{}` retries the recovery copy. Saved SQLite edits and a pending/conflicted recovery copy are reported separately.
- POST `/assets` raw PDF/photo body (max 25 MiB), `Content-Type`, `X-Filename` (encodeURIComponent filename) → Asset. Supported PDF/PNG/JPEG/WebP/GIF, validates signatures. A subsequent attachment creates the association.
- GET `/assets/:id`, `/assets/:id/content` → Asset / original bytes.
- POST `/attachments` body AttachmentInput; only editable note/person owners are allowed and require expected note `version` → Attachment. This increments parent note version. Refresh note before another mutation.
- PATCH `/attachments/:id` body `{version,caption?,bodyLocation?,eventDate?,personId?}` → Attachment; DELETE same route with JSON `{version}` → `{deleted:true}`. Finished historical and imported clinical associations are read-only. Unlink does not delete bytes.
- GET `/attachments?ownerType=&ownerId=` → Attachment[].
- POST `/backups` body `{}` → receipt of consistent SQLite + all canonical sources and uploaded originals in a local private recovery directory. CLI `npm run backup` / `npm run restore -- <backup-directory> <empty-target-directory>` also provided. Restores never overwrite current archive.

The encrypted runtime validates Host and Origin before dispatch. Browser mutations require an exact allowed Origin and JSON content type (except binary upload); additional development origins are opt-in. Compose binds the published port to host loopback by default while the server listens on the container interface. See [deployment origins](../../docs/setup/deployment.md) and [request boundaries](../../docs/security/model.md). Schema bootstrap starts at `migrations/001-initial.sql` and applies supported migrations through schema 6 in an ownership-checked transaction. Clinical normalization remains reviewed work; explicit source intake indexing is separate.

## Recovery and operating notes

Run `CRS_DATA_DIR=/absolute/path/to/archive/data CRS_MODEL=health-primary CRS_LITELLM_CONFIG=/absolute/path/to/proxy/config/litellm.yaml CRS_STATE_DIR=/absolute/path/to/proxy/state npm run start` from the repository root. Docker serves the encrypted application on loopback port 3001 (override `CRS_PORT`). See [Getting started](../../docs/setup/installation.md). Contributor `npm run test:server` uses isolated fictional databases.

`npm run backup -- <profile-id>` uses SQLite's online backup API, then copies **only** original files referenced by that snapshot, validating each hash/size. The bundle includes a full portable JSON table export, schema version, stable IDs, notes/drafts/finished content, mappings, provenance and asset metadata, plus original bytes. Database-only copies are insufficient. Backups live under `data/backups/<profile>/`; keep these out of Git due to redundant originals.

`npm run restore -- /absolute/backup /absolute/new-empty-directory` validates checksums, foreign keys, integrity and all referenced files before restoring into a new directory. It never overwrites the active database. Restore output can replace live storage only after stopping the server and explicitly reviewing that separate operation. Original provider files remain canonical. No automatic import or synchronization is installed.

Attachment originals use immutable paths. Reusing the same original name/content reuses the asset; a changed original filename gets its own asset record to retain attribution. Unlinking removes only the association, never bytes. Failed DB attachment writes may leave an unreferenced uploaded file; no automatic destructive garbage collection runs. An uploaded file is not part of a note until its attachment command succeeds. Note version checks include attachment mutations, so stale draft finalization rolls back.

Historical-note immutability is enforced by SQLite triggers for the note body/metadata and stored link/attachment associations; dynamic backlinks and target titles remain current. Notes are archived through PUT, not deleted; finished historical notes remain immutable, including archive state.

## Combined historical reading

`HistoricalNote` has an explicit `origin: personal | provider` discriminant. Personal items embed their unchanged `note: Note` DTO and retain `status: draft | finished`; only finished personal items are read-only. Continue using the existing `/notes` endpoints for personal draft editing, conversion, finishing and linked corrections. The combined reading endpoints accept no writes. They do not create or finalize personal note copies of provider documents.

Provider items embed the original `extra`, body, `sourceRecordId`, document evidence and attachments. Their status is always `provider` and `readOnly` is always true. `sourceStatus` separately retains the source's status text (for example, `current`); this does not assert that a clinician finalized the document. `authors` retains source-listed author strings. `sourceId` refers to the attributed issuing provider and `sourceLabel` prefers the source's own issuing-provider label, falling back to its indexed provider name or an explicit missing-source label. Capture/acquisition attribution remains in the separate source-record and evidence links. A provider label does not establish who performed care or where it occurred.

Only the exact 24 clinician-document types listed in `historical-notes.ts` qualify, including Progress Notes, Telephone Encounter, discharge and patient instructions, staff notes, H&P, mental health, anesthesia and operative notes. Laboratory report, Pathology study, Diagnostic imaging study, unknown types and native files without an eligible structured source type are excluded from this reading collection; their records remain available in Sources and their existing domain views. This allowlist exposes existing records without inferring a clinical visit from free text or a filename. It does not claim a complete visit history or deduplicate distinct source documents.

The optional, manually reviewed `documents.extra_json.historicalNote` object may contain `title`, `typeLabel`, `eventDate`, `dateBasis`, `classificationBasis` and `presentationNote`. Nonempty strings override presentation only; the original `sourceType`, source fields, body and raw record stay available. Provider `eventDate` is null unless explicitly reviewed; `recordDate` always preserves the original document date. The selected `date` is reviewed event date if present, otherwise original record date, and `dateBasis` says which. A default provider record date must not be labeled as a visit or performed date. Personal date uses its supplied event date, otherwise its UTC creation timestamp. Invalid or absent dates sort after known dates; ties use origin and stable ID. Counts, pagination and completeness use the same combined filters. Search covers title, body, type, source label, provider authors and personal topics/raw thoughts.

The list and option counts exclude archived personal notes; existing direct links to archived personal historical notes still work. Direct links reject nonhistorical personal notes and ineligible provider documents. Options are global for the selected profile rather than narrowed to the current filter; reserved source IDs `all`, `personal` and `provider` include counts, followed by individual issuing providers. All responses and asset URLs use the same selected-profile boundary as other resources. These combined reading endpoints do not mutate sources or run automatic clinical imports. Schema 5 separately adds personal note text-format markers.

Optional client-generated `id` fields (`note:<UUID>` / `attachment:<UUID>`) make create retries idempotent within a profile. Reusing an ID with the same intended content returns the existing resource without changing note versions or database revision. Reusing it with different content returns `409 ID_CONFLICT`; reload the saved resource to edit. Corrections also accept a new stable note ID.

Medication, procedure and document detail responses include `evidence` and `attachments` arrays. GET `/evidence?entityType=...&entityId=...` also exposes all indexed associations for an observation, medication, procedure, report, document, note or person. Clinical values retain their primary `sourceRecordId` independently. These associations describe retained evidence, not inferred corroboration.

A stored note link with `targetType: "source"` may refer to either a source-file ID or a retained source-record ID. Resolution checks files first, then records, without rewriting stored target IDs. For a record target, the returned `NoteLink.sourceRecordId` identifies the Sources record route; otherwise use its file route. This compatibility preserves links in already finished imported notes. The normal picker continues to suggest source files.

App-managed note creation/update/finalization and asset/attachment upload timestamps are presented as explicit UTC ISO strings when the stored value has SQLite's `YYYY-MM-DD HH:MM:SS[.fraction]` shape. This presentation adapter does not rewrite stored metadata, including finished notes. Existing ISO timestamps, nulls, clinical source dates, note event dates and photo-taken dates are unchanged; no provider time zone is inferred.

## Note text formats (schema 5)

`Note.textFormats` and `NoteInput.textFormats` map `content`, `topics`, `rawThoughts` and `medicalHistory` to `plain-v1` or `markdown-v1`. `medicalHistory` describes `person.medicalHistory`; the other keys describe top-level note fields. Storage uses `notes.text_formats_json`; absent keys mean literal plaintext. Migration `005-note-text-formats.sql` adds the column with `{}` as its default without rewriting any old body, source file or finished note.

For example, a personal draft can send `{"content":"# Visit\n\nQuestions","textFormats":{"content":"markdown-v1"}}`. Omit `textFormats` to preserve existing markers; supplying it replaces the whole marker map, so include unrelated current markers when changing one field. Invalid keys/formats return `400 INVALID_INPUT`. New app drafts initialize Markdown markers; API callers that omit them create literal text. Idempotent creation compares markers as well as bodies. Finish saves the submitted latest body and formats atomically under the same mandatory version check.

The browser defaults to Formatted with an editable Markdown source tab. Personal editors, finished personal notes and comment cards interpret existing Markdown immediately, including bodies with absent or legacy plaintext markers, as requested in the follow-up. This is a presentation preference: opening a note or switching tabs does not rewrite its source or markers. A real text edit saves `markdown-v1`; previous versions remain available. Imported provider wording and saved-history previews still respect literal interpretation. Rich editing is available only when the supported structure safely round-trips. Unsupported Markdown is retained, safely previewed and edited in source mode. Tabs alone do not save or rewrite the body. Raw HTML/unsafe links stay inert and arbitrary Markdown images do not request remote bytes; original attachments remain separate.

Portable personal generations and rebuilds retain markers. Saved-history comparisons display each body's format; restoring a selected text field restores its format alongside the body and preserves unrelated fields' current markers. Older generations without markers restore as `plain-v1`.

## Collection filters

GET `/notes?kind=person` and `/historical-notes` accept `filters=<URL-encoded JSON array>`. Each row is `{field,operator,values:string[]}`. Predicates are allowlisted and parameterized; no browser-supplied SQL is evaluated. Complete rows combine with AND. The same conditions govern records, totals and pagination.

- People fields: `tags`, `relationship`, `lifeStatus`, `text`.
- Historical fields: `source` (issuing provider ID, `personal`, or the compatibility aggregate `provider`), `acquisitionSource` (capture provider ID or `personal`), `type`, `status`, `date` (listed date), `text`.
- Set fields use `any` or `none`. Tags also support `all`; `any` means any chosen tag, `all` requires every chosen tag, and `none` excludes any selected tag.
- Text uses `contains` or `notContains` with exactly one literal substring; `%` and `_` have no wildcard meaning here. Existing top-level `q` remains its separate search contract.
- Dates use `before`, `after` or inclusive `between`, with exact `YYYY-MM-DD` bounds. Missing, invalid and partial record dates do not become fabricated exact dates and cannot match bounded date predicates.
- `__unknown__` explicitly selects missing/unspecified values; for tags it means no nonempty text tags. Negative selections include unknown/untagged records unless `__unknown__` is itself excluded. Self always behaves as untagged regardless of legacy stored tags. Unknown life-status values match the unknown option.

For example, `[{"field":"source","operator":"any","values":["fictional-clinic-a","fictional-clinic-b"]},{"field":"type","operator":"any","values":["Primary care","Dermatology"]}]` matches either issuer AND either type; use IDs returned by the profile's options endpoint. This does not classify generic provider documents into those specialties.

Limits: at most 12 rows, 100 values per row, 500 characters per value and 24,000 characters in the decoded JSON parameter. Empty/incomplete rows are ignored; malformed JSON, unsupported fields/operators and invalid complete bounds fail with `400 INVALID_FILTER`. A valid but absent option is a literal match, not an instruction to discard the filter. Option catalogs remain profile-wide; they do not narrow to the current results. The UI retains unavailable selections visibly.

Legacy single-value query parameters remain supported. API requests containing both legacy and builder filters compose them; the UI upgrades legacy conditions to builder rows and removes their old keys. Routes retain filter state, Back/Forward and collapsed active summaries; filter changes reset pagination, and switching profiles clears profile-specific selections. The issuing and acquisition source fields remain distinct and change no author/provider attribution.

## Medication status views (schema 4)

`GET /medications?status=current|archived|all` provides Active and Inactive views. Current requires a personal `current` assertion and no archive event. Archived includes an archive event, a retained `not_current` assertion, or absent/explicit `unknown` preferences. There is no separate Not reviewed view. Legacy `active` maps to current; `inactive`, `unknown` and `unreviewed` map to archived. All preserves every order, dispense and reported-use representation; a separate `visibility` parameter does not narrow prescription lists. Provider `active`, `completed` and `discontinued` never decide personal current use. Reads retain earlier assertions unchanged. Direct detail links remain available outside the list filter.

Medication DTOs preserve original `status`, dose, route, frequency, dates and evidence. Personal fields are `currentStatus`, `currentStatusVersion`, `visibilityVersion`, `archived`, `currentStatusUpdatedAt` and `currentStatusAssertion`. `sourceRecordedDate` exposes literal retained `recordedDate`, independently of prescription start/end or personal confirmation dates.

`PATCH /medications/:id/current-status` accepts `{status: "current"|"not_current"|"unknown", version: currentStatusVersion, visibilityVersion}`. Both versions are required and checked in one transaction. Current clears archive; not_current archives. The retained API `unknown` value clears the archive flag and records an unknown personal assertion, which still appears in Inactive. Generic medication visibility PATCH accepts `{archived, version: visibilityVersion, currentStatusVersion}`: Archive records not_current and Restore records current in the same transaction. A stale version in either state rejects the entire operation with 409; failures roll back both changes. The UI uses an immediate positive Active switch, on for current and off for inactive, with history/details available.

Every intentional change retains prior personal assertions and archive events in the encrypted record journal. It changes no provider row or original bytes, does not imply clinician discontinuation, and does not automatically alter other orders for the same drug. Current-prescription print selections and summaries also exclude archived conflicts; broader provider history still retains those records with archive disclosure.

## Procedure classification (schema 2)

`Procedure.category` is required: `surgery`, `clinical_procedure`, `imaging`, `laboratory`, `pathology`, or `unspecified`. This is a reviewed presentation classification; it does not change the source label, source status, clinical date, provider attribution, raw payload or evidence. A record's attributed provider does not establish its performing clinician or location. Uncertain classification remains `unspecified`.

GET `/procedures` defaults to `category=clinical`, including surgery, clinical procedures, imaging and unspecified records. `category=tests` returns laboratory/pathology records; `category=all` returns every classification. Exact category filters are also supported. Search, provider filtering, pagination totals and completeness use the same selected category scope. A single-record GET `/procedures/:id` remains accessible irrespective of list filters. Medication requests ignore this procedure-specific filter. The Overview procedure count matches the default clinical collection.

Startup applies `migrations/002-procedure-categories.sql` to each opened schema-1 profile in a single ownership-checked transaction. That initial category change introduced schema 2; current bootstrap applies all supported migrations through schema 6. Existing rows get `unspecified`; no automatic clinical classification or import runs, and stored source fields/frozen notes are untouched. A failed migration rolls back its schema changes and closes the connection. Reviewed data classification is a separate manual batch with its own data revision and reconciliation notes. Backups/portable exports report the snapshot's actual schema version; old version-1 backups remain recoverable and upgrade when explicitly opened by this application.

## Self and personal dates (schema 3)

`GET /notes/person-note%3Aself` returns the canonical Person with `personId='patient'` and `isSelf=true`. Self has patient details, attachments and incoming annotations. Saving outgoing links or archiving Self is rejected. Self cannot be assigned role/custom tags: ordinary saves and assistant proposals reject nonempty tag assignments with `SELF_PROFILE`. Reads hide legacy Self tags; a later ordinary save removes them from current storage while preserving prior personal generations. Historical tag values can be inspected but are not restorable. Positive tag filters exclude Self; negative/unknown filters treat it as untagged. The Self identity badge is independent of roles. People fields include `fullName`, `pronouns`, `birthDate`, `deathDate` and `lifeStatus`. Dates may be blank/unknown, YYYY, YYYY-MM or YYYY-MM-DD. The UI shows native pickers at the chosen precision; date of death is shown only when deceased, without deleting a hidden value. Original nested personal-source information is retained.

Startup applies all supported migrations sequentially. The [portable contract](PORTABLE.md) covers full replacement snapshots, curation exports, staged rebuilds, older schema generations and recovery conflicts. SQL Explorer and its HTTP endpoint are retired.

The UI shows Scheduling URL and its opening link only for non-Self People tagged Professional or Primary Care Provider. Either role qualifies; phone/email are independent. Removing a qualifying role hides the URL without deleting it, and restoring the role reveals it. This presentation rule does not infer roles from relationships or past visits.

### Canonical Self display name

The profile registry contains fixed IDs and placebo flags; names come from the existing Self person row (`people.id = 'patient'`, `people.display_name`). GET `/api/profiles` returns `{id,name,placebo,nameVersion}` for each available profile. Each scoped JSON response includes the same selected-profile projection in `meta.profile`; `nameVersion` is the Self note's current CAS version. A successful Self save therefore refreshes navigation and profile selection immediately. Clients ignore older name versions and update names without treating them as a profile switch.

Self remains the existing `person_id='patient'` / `person-note:self` identity, independently of its display name. GET `/notes/:id`, note lists/search, and linked target titles project the canonical display name even when a legacy stored note title says `Self`. Reads do not modify those legacy fields or any source records. Saving Self uses the editable `person.name` (with `title` as an input alias when `person.name` is absent), trims and requires a nonempty name, then synchronizes `people.display_name`, `person.name`, and the personal note's title in the existing version-checked transaction. `person.fullName` remains a separate legal/full name; pronouns, other profile fields, IDs, attachments, and links are unchanged. Self still cannot be archived or create outgoing links. Renaming a different person to `Self` grants none of these identity semantics.

The explicit registry is shared by API, storage and recovery code. Each profile's originals and uploads stay under its own profile directory. Normal app startup requires every registered profile's prepared database with its matching `owner_profile_id`. A missing profile fails before opening other stores; copying a SQLite checkpoint requires the correct profile's original files and portable state as described in [PORTABLE.md](PORTABLE.md). Adding a registry entry does not clone or alter patient data. Self supplies the editable display name.

Uploads with optional source attribution and reviewed JSONL intake use `/intakes`; see [the intake contract](INTAKE.md). Uploaded originals and conversion proposals are preserved separately. Importing source envelopes does not automatically create clinical results. The profile-scoped report queue at `GET /intakes/report-queue` and `GET /intakes/report-queue/:groupId` exposes stable report selection, exact current candidate/proposal blocks, deferred work and independent history counts; see [report queue semantics](INTAKE.md#report-review-queue). `GET /intakes/import-feed` supplies the dedicated Import page's bounded global clinical record window, populated kind/state counts, reading activity and independent People discovery; exact `/import?group=…&intake=…&proposal=…&record=…` links use report-queue detail plus the ordinary review/draft/question, related-record, correction, People, original and acceptance APIs. Historical `/sources?view=import` client URLs redirect to that page with their remaining selection parameters unchanged; Sources itself remains the evidence/provenance browser. `GET /import-diagnostics` supplies bounded metadata-only browser/server trace downloads and does not expose retained private payloads. `POST /intakes/report-acceptance` accepts an explicitly counted selection across exact proposal blocks atomically; `GET /intakes/report-acceptance/:operationId` retrieves its durable replay receipt. See [global feed semantics](INTAKE.md#global-import-feed) and [counted acceptance](INTAKE.md#counted-report-acceptance).

Named clinician and relative suggestions use `GET /intakes/people/:groupId`, `POST /intakes/people-disposition` and `POST /intakes/people-apply` within the same profile authorization boundary. They have separate pending/deferred counts and explicit add/update operations; clinical acceptance does not create People. See [named People review](INTAKE.md#named-people-review) for evidence requirements, current-version matching, replay receipts and personal-entry durability.

### Human-authored source review drafts

`POST /intakes/:id/source-records` creates one pending clinical review draft from a retained source, including sources with no model proposals. Its shared contract is `ManualSourceRecordRequest`: `version`, stable `operationId`, `sourceHash`, current `sourceTextRevisionId`, `scope:{page,box?}`, explicit `person:{kind:"self",expectedVersion}` or `{kind:"person",noteId,expectedVersion}`, `literalText`, and supported `clinical` mapping fields. The page must exist in retained source text inventory; normalized regions are optional. Package members must be selected as retained child intakes. Retain-only media cannot create clinical drafts. Existing People are supported; this operation never creates a Person or retains a printed alias.

The host validates the original, source revision, person visibility/version and clinical mapping, then retains a human-authored proposal through the existing intake journal. `manualSourceRecord` is host-owned proposal metadata, never authority copied from JSONL or client-supplied clinical fields. There is no model run identity. The response contains `intake`, `proposalId`, `recordId`, `groupId`, `reviewUrl`, and `replayed`. Retrying the same operation returns the existing draft; different content with that operation rejects with `OPERATION_CONFLICT`. Stale intake/person versions reject with `VERSION_CONFLICT`, changed originals with `SOURCE_CHANGED`, changed text with `SOURCE_TEXT_CHANGED`, and invalid fields/pages with `MANUAL_SOURCE_RECORD`.

Creation does not accept a clinical record, mark a page inspected, resolve a source issue, or change original bytes. Normal review, edits and explicit acceptance apply. Accepted ownership and source-region authorship survive journal reconstruction. Source corrections retain the manual draft but make its old source dependency stale; acceptance requires fresh review rather than silently reusing old evidence.

### Personal visibility and current use

`GET /visibility/:targetType/:targetId` returns `{ targetType, targetId, archived,
version, protected, history }`. `PATCH` at the same route accepts only
`{ archived: boolean, version: number }`; medication targets additionally require
`currentStatusVersion` as described above. A stale version is a 409. Supported
identities are `note`, `person`, `document`, `medication`, `procedure`,
`observation`, `test_type`, `source` (source record), and `source_file` (file).
Person notes canonicalize to their Person ID; both addresses agree. Self is
protected through either address. A same-state request retains the existing
visibility version. Every change appends a personal event with timestamp and
actor. Source rows, finished note content/version, originals, and link IDs stay
unchanged. There is no Delete, Trash, or purge API.

Notes, historical notes, procedures, tests, test types, sources and
source records accept `visibility=visible|archived|all` (default `visible`). The
legacy notes `archived=1` filter still means archived. Direct record/link reads
ignore list filters and expose the archived badge. Test charts always include
retained archived observations, explicitly disclosed in the UI; archiving a
measurement does not remove its history. Source-file visibility does not cascade
to contained source records. Overview counts describe all retained records.

Personal snapshots own `visibility_events`; older schemas rebuild with an empty
event table and preserve legacy note archive values as the baseline. Restore adds
a new event overriding that baseline. Changing an existing note's `archived`
property through ordinary note writes is rejected: use the separate versioned
visibility route so an old note form cannot reverse a newer visibility choice.

Medication personal assertions remain `current|not_current|unknown`; the Current
switch and medication visibility route coordinate both personal states atomically,
as described above. Actor
metadata is added to new personal assertions; original assertions and nested
prior assertions remain literal. The compact UI's accessible details dialog
shows selection times, recorded actors (unknown when absent), retained assertion
history, and an optional linked note for rationale or original attachments.

## Moxie conversations

Assistant routes remain scoped to the unlocked profile. `GET /assistant/chats`
lists saved chats; `POST /assistant/chats` creates one with `{message, context?}`.
`GET /assistant/chats/:id` returns the full chat. `POST` to its `/messages`
subroute adds `{message, context?}`; `/cancel` stops the active attempt and `/retry`
starts another attempt without duplicating the user message. Only one attempt
runs in a profile at a time. `/apply` accepts an explicitly reviewed proposal by
`proposalId`; conversation text and working status do not authorize acceptance.

`messages` retains individual user and assistant items. New assistant items have
an application `id`, the original provider `itemId`, the attempt's `runId`, and
its bridge `generation`. The host matches stream updates within that run and
generation, so reused provider item IDs cannot overwrite earlier attempts.
The UI groups adjacent assistant items with the same explicit `runId` into one
response, retaining each item's text and source links. Older messages without
that identity keep their original boundaries. Tool-associated text is not
classified as disposable progress or deduplicated by wording.

A completed provider item remains `streaming` while the overall response is
running. Successful completion marks its items `complete`; cancellation, failure
or recovery of an interrupted attempt marks partial response items `interrupted`,
including items that completed before a later tool failure. Retries retain the
previous attempt separately. The first-response greeting context is overridden
on each proxy tool continuation so it does not request another opening greeting.

The scoped `health_assistant_progress` tool accepts `{text}` containing 1–300
characters of nonblank activity text. It only updates the current run's
`progress: {text, at}` and appends a journal operation retaining the exact input.
The latest status appears as plain text while working. Findings, source links,
uncertainty, questions and answers belong in normal assistant text. Progress
neither creates a proposal nor changes accepted archive records.

Visible stream deltas checkpoint through the existing journal writer at most
once per second; tool/item checkpoints and terminal paths also flush the latest
text. Profile close uses the terminal path before locking. A hard process crash
can lose text buffered since the last checkpoint, normally up to one second
(subject to event-loop and storage delays). This is not token-level crash
durability. Journal failures stop the response with a visible error; text still
in memory must not be treated as durably saved. Reopening retained running work
marks it interrupted and does not automatically start a model request.


Report source defaults: clinical acceptance uses an exact linked, non-mixed report-context label when no explicit source choice covers that occurrence. Accepted reviewedSource provenance includes basis suggested_report_label for this derived default; no human reportSourceConfirmations receipt is invented. Explicit scoped labels continue to take precedence, and original acquisition/issuer provenance remains unchanged.

Identity previews include selfBirthDateConflict and defaultPerson (self/new). The identity-scope mutation rejects this_is_me for an evidenced DOB conflicting with Self. Saving a clinical review draft does not require resolved ownership; accepting it still does. A matching grounded name preview also refreshes import-feed eligibility, not only a prior human confirmation.

Import-feed links may specify intakeId, groupId and recordId to locate an exact profile-local record without opening a separate clinical review page. These selectors are included in cursor scope; unrelated reports do not appear in the scoped feed.

Import review draft updates accept optional correctionReason (nonempty, at most 10000 characters). The server derives corrections with operationId, at, reason, before and after from actual field changes; clients cannot supply that history. Retained draft corrections survive subsequent partial updates and are copied into accepted import provenance. Changed date fields are validated before draft publication; unchanged legacy invalid values do not prevent correcting another field.

## Clinical view ownership

GET `/record-owner?type=&id=` resolves `{personId}` from a saved note, Person, historical note, observation, medication, procedure or document, including recorded clinical reclassifications. Shared source/source-file/test-type references return null. Missing entries return 404; arbitrary types are rejected. This endpoint uses the same profile authorization as all clinical reads. The client hides unresolved content rather than displaying a guessed owner.

Notes expose `ownerPersonId`; new ordinary/Historical Note requests may supply an existing person ID, defaulting to `patient`. It is stored in the existing versioned JSON metadata, independently from Person-note `personId`. Absence in old metadata means Self and does not trigger a historical rewrite. The server owns this metadata key and rejects owner reassignment of a saved note. Conversions and correction drafts preserve it.

Assistant conversations opened in a person-scoped clinical view retain that subject. Host clinical queries inject the owner, direct reads/history and proposals check ownership, and changing the subject on an existing conversation returns `PERSON_SCOPE`; start a new conversation instead. Raw original sources and People remain shared context within the authorized profile, not assertions of clinical ownership. The model context distinguishes the profile owner from the record subject.

### Person selection and display identity

`GET /clinical-people` returns lightweight options for every active non-Self person (`personId`, `noteId`, display `name`, `birthDate`, `icon`) within the authorized profile. It avoids truncating a person's filter choices to one notes page. Self is a fixed client option. Clinical collection URLs select exactly one person; sidebar navigation starts again at Self. Direct record links resolve their owner before displaying data.

Creating a person without an icon randomly selects and persists a catalog icon, excluding existing identical display-name/icon pairs. Creation retries retain that choice. Create/update reject `DUPLICATE_PERSON_DISPLAY` (409) when the pair matches another person, including Self. Name comparison normalizes whitespace, case and Unicode; legacy and curated Lucide aliases compare as the same icon. The same name with a different icon is allowed. Legacy duplicate pairs remain editable when unchanged; accepted history is not rewritten.

Profile picker display pairs are also checked across profiles, separately from People within one archive. New profile setup, completion (including concurrent setup attempts), and Self name/icon edits reject `DUPLICATE_PROFILE_DISPLAY` (409) for a normalized duplicate display-name/icon pair. Locked profile cards participate in this check; the same name with a different icon is allowed. Existing legacy duplicate pairs are not rewritten and can be edited without changing the pair. A conflicting edit fails before saving Self. Recovery history remains unchanged.

Identity original grounding also retains bounded, ephemeral labelled DOB facts keyed to original bytes/member and exact report/subject scope, including whether a recognized DOB label printed a value that is not one complete date. Such an unreadable DOB makes `/identity-review` blocking `confirmation_required`, even with a matching name. `/identity-review` compares these with Self even if the model emitted no `selfSuggestion`. Scope confirmation and record acceptance enforce the same facts. Conflicting DOBs reject Self; ambiguous dates remain blocking evidence disagreements. Legacy confirmations without DOB evidence require an original recheck before reuse after loss of the ephemeral proof. The response and record identity review can also include optional `warnings` with `kind: "model_birth_date_mismatch"`, `modelBirthDate`, `savedBirthDate` and `personName`. These unverified model readings are advisory: they do not block acceptance or override original evidence, and the person can change the report assignment. No extracted page text is added to diagnostic downloads or stored by this cache.


Accepted intake uploads atomically retain processing intent and wake the authorized server coordinator. A wake failure after retention does not turn the upload response into a failure; reconciliation later replays the saved intent. Batch create responses include `scheduled`, indicating whether new reading work was started. Batch Stop/Resume and located-exception retry endpoints, durable provider waits and recovery authority are documented in [INTAKE.md](INTAKE.md#sequential-reading-batches) and [automatic recovery](../../docs/import/automatic-recovery.md). A GET or open browser tab is not required to dispatch eligible work.
