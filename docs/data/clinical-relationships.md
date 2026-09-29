# Reviewed clinical relationships

CRS-051 relationship review is an explicit accepted-record operation. It retains every assertion, clinical literal, original file, and earlier decision. It never edits a clinical record, interprets an app transcription correction as a provider amendment, or upgrades an existing `changed_version` / `same_event` decision into new authority. Those older pair decisions remain readable historical or unresolved context.

## Service and integration contract

The cross-runtime DTOs are in `src/shared/clinical-relationships.ts`; the implementation is `src/server/clinical-relationships.ts`. Route callers must use the authenticated session's database, profile ID and storage root. This service does not perform session authentication itself.

- `previewClinicalRelationship(db, root, profileId, request)` returns the submitted request, exact pair `scope`, current global `version`, `previewToken`, both literal mappings with original links and navigation, and the proposed effect.
- `applyClinicalRelationship(db, root, profileId, input)` accepts only `{operationId, request, scope, version, previewToken}`. The operation is a stable UUID v4. Echo the exact preview fields; do not silently refresh them after a conflict.
- `getClinicalRelationshipReceipt(db, profileId, operationId)` returns the immutable accepted receipt and current projections. An exact apply retry returns the same receipt after later decisions; changed request/scope content with that UUID conflicts.
- `clinicalRelationshipProjection(db, profileId, {kind, recordId})` returns current pair decisions, historical pair context, and display/counting guidance. `clinicalRelationshipProjections(db, profileId, records)` shares one graph read across a list or chart response.
- `clinicalRelationshipHistory(db, profileId, record, {beforeSequence?, limit?})` returns immutable decision entries, `currentDecision`, and `nextBeforeSequence`. Default page size is 20, maximum 50. The cursor is the last sequence returned; history is newest first.

The authenticated profile route handler mounts POST `/clinical-relationships/preview`, POST `/clinical-relationships/apply`, GET `/clinical-relationships/operations/:operationId`, GET `/clinical-relationships?kind=…&recordId=…`, and GET `/clinical-relationships/history?kind=…&recordId=…&beforeSequence=…&limit=…`.

Every request names `left` and `right` as `{kind, recordId}` and supplies a nonempty `reason` of at most 4,000 characters. Both records belong to the same profile. Confirmations require the same current clinical kind, the same established person, and retained original evidence. For documents, the accepted subject must be Self. The preview follows a journal-proven kind reclassification for the stable ID; its returned side and scope name the current kind.

## Provider amendments

Use `action: 'provider_amendment'`, `mode: 'confirm'`, and `direction: 'left_to_right' | 'right_to_left'`. The direction means the first assertion is superseded by the second. Confirmation requires `attestation: 'reviewed_provider_amendment'` and `evidence: {sourceFileId, locator, quote}`. The evidence original must belong to the amended assertion (the destination side); its actual bytes are verified against retained length and SHA-256. The location and quote are the user's explicit original review, not an automated semantic or PDF quotation match.

A provider amendment does not choose a display preference or establish measurement equivalence. A separate display review is required. Directed cycles are rejected. Changing an existing direction requires an explicit withdrawal first. Withdrawal uses `mode: 'withdraw'` with the prior direction and appends a new decision linked to its predecessor; it never deletes the amendment or changes a separate display decision.

## Display preference and event counting

Use `action: 'display_preference'`. Modes `prefer_left`, `prefer_right`, and `show_both` require `attestation: 'same_recorded_event'`: the user has explicitly reviewed that these two assertions describe one recorded event. The backend does not infer this from dates, labels, codes, matching values, amendment links, or conversion rules.

A current explicit pair shares `display.countGroupId` and has `oneReviewedEvent: true`. For `prefer_left` or `prefer_right`, only the chosen side has `visibleByDefault: true`; retain the other side's accessible detail, original, and comparison navigation. For `show_both`, both literal assertions remain visible and the pair still contributes one reviewed event. A chart or count consumer must honor both visibility and grouping, not remove the second literal under `show_both` or count it as an independent event.

Only disjoint active display pairs are supported. A-B and B-C cannot form an implicit transitive group; the earlier overlapping pair must be withdrawn or explicitly marked undecided first. Stale pairs also reserve their former members until deliberately resolved. `undecided` preserves an explicit unresolved decision; `withdraw` reverses the earlier choice. Both restore literal visibility and remove that pair's event grouping.

An independently accepted later assertion has its own stable ID and receives no preference, amendment, or count group from an earlier pair, even if it has the same imported identity. It remains visible independently until reviewed. The service never selects the newest value or averages alternatives.

## Scope, uncertainty and recovery

Each immutable decision also retains `reviewed.left` and `reviewed.right` literal/mapping snapshots, original links, source file IDs, byte lengths and SHA-256 hashes. Current navigation is separate so the history never silently rebinds its reviewed facts. The scope records the profile ID, both exact accepted record IDs/kinds, imported identities and versions, complete accepted state hashes, evidence/original metadata hashes, and preceding decision ID. Actual original bytes are checked during preview and apply. Global revision plus the exact preview token blocks races with other accepted changes. A correction followed by a return to the old literal still has changed accepted history and invalidates the earlier scope. Projection checks current accepted state and original metadata; physical bytes are checked at confirmation, not repeatedly for every chart row.

Stale, conflicting, or undecided current decisions require review. Both sides remain visible and lose event grouping; uncertainty touching the other side of a display pair also prevents suppression. Every result provides navigation for both sides. `relationships` contains latest decisions for this record; `legacyPairs` retains bounded older pair context. A bounded graph reads at most 1,000 latest pair decisions. If exceeded, projections report `truncated`, preserve visibility and decline grouping, while new writes reject with `RELATIONSHIP_LIMIT`. Legacy context returns up to 50 rows; complete new relationship history is separately paged.

Decisions and immutable receipts are appended as `manual_batches` entries titled `Clinical relationship review` through the existing accepted transaction and record-version journal. SQLite is a rebuildable projection; no parallel file or durability authority is introduced. A failure before head publication has no accepted receipt after recovery; a failure after publication is recovered with its exact receipt, and replay does not append twice. Existing recovery-required protection prevents a cache behind accepted durable history from claiming a false result. The response reports pending durability errors rather than fabricating completion.

Fictional contributor tests cover original-preserving amendment review, explicit same-event preference, show-both counting, reversal/history paging, cycle and overlap rejection, app-correction invalidation, later source versions, old journals, connected uncertainty, profile/person/original mismatches, idempotency, immutable objects, all-original cache rebuild, and failures on both sides of durable head publication. Controlled encrypted HTTP tests additionally cover mounted route authorization, immutable receipt retrieval and trend DTOs. Charts retain all original values while applying reviewed visibility/count grouping, with filtered-counterpart fallback. Clinical detail/browser integration and real-provider amendment interpretation remain separate gates until exercised in the work list.
