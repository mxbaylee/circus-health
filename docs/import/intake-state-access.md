# Intake operational-state access

`src/server/intake-state-access.ts` centralizes the current intake storage boundary. Production persistence still keeps the complete intake object in `source_files.details_json`; the [incremental state primitive](../data/intake-state-storage.md) is not activated. This refactor changes access paths, not recovery authority, clinical acceptance, public DTOs or durable growth.

## Current views and writes

The module owns the complete server `IntakeDetails` type. Row-based readers carry the database and source row; ID-based reads carry the database and source ID. This context permits a later storage cutover without adding an ambient database or migrating operational consumers again.

`storedIntakeDetails` and `readStoredIntakeDetails` expose the stored operational view. They deliberately retain the row's version and legacy source-pin fields: assistant retry proofs and existing ownership/People consumers compare this view. Missing ordinary non-intake metadata may have no intake view. An actual `intake_original` with no intake object, a malformed intake object or a malformed present workflow fails explicitly. A legitimately absent workflow remains absent. Readers do not construct an empty workflow to disguise an omitted storage lookup.

`intakeDetails` supplies the effective intake view used by DTO construction, stale-version checks and ordinary intake mutations. It overlays the separate source pin exactly as before. The effective public version is the stored intake version plus the material source-pin version. Confirmation-only source-text bookkeeping does not become a material intake change. Existing sticky interpretation requirements remain effective.

`writeIntakeDetails` preserves the surrounding source envelope. For an effective view, it subtracts the separate pin version and retains the row's original pin fields rather than copying current pin state back into the growing row. Direct operational writers use `updateStoredIntakeDetails` or the explicit stored-view option to preserve their existing raw version semantics. Duplicate-review questions still increment the stored version and update review state; the atomic report-acceptance writer still retains the exact receipt without introducing another version increment.

`registerIntakeFile` owns initial source-file insertion for roots, extracted children and proposals. Original hashing, row columns and serialized details remain unchanged. Registration and subsequent writes run in their caller's existing publication transaction. The module opens no independent transaction and creates no second authority. The later cutover must stage initial operational state for both roots and children within that same transaction.

## Field partition for the later cutover

The current full server type is inventoried as follows; none of these fields is moved by this refactor.

- Compact source identity and attribution: `originalName`, `createdAt`, `acquisition`, `receivedMimeType`, `parentSourceFileId`, `locator`, `derivative` and current `metadata`. Current metadata contains `source`, `sourceProviderId`, `careArea`, `documentType` and `topics`; it does not include its history.
- Operational state: stored `version`, `state`, `validation`, `proposals`, `acceptedProposalId`, `imported`, `metadataHistory`, `importHistory`, `conversionChatId`, `lastDecisionFingerprint`, `lastReviewToken` and the complete `workflow`.
- Separate material source pins: revision ID, dependency token, interpretation requirement and the pin's version remain in existing `intake_source_pin:v1:` records. The corresponding legacy fields `sourceTextRevisionId`, `sourceTextDependencyToken` and `sourceTextRequiresInterpretation` in the stored view retain their current compatibility/sticky semantics; the cutover must preserve them when reconstructing the effective view.

Proposal objects include their existing source pins, model identity, review/version history and manual-source receipts. Workflow includes its format, questions and answers, candidates and candidate versions, plans/inventory/units/attempts/batches, decisions, review drafts, report groups and versions, identity confirmations, source confirmations and atomic acceptance receipts. Server extensions include operation fingerprints, decision evidence and People drafts/dispositions. These arrays and histories belong to operational state, not compact source attribution. Unknown surrounding envelope fields and exact absent/null/empty values remain intact.

## Operational consumer inventory

The shared boundary serves intake details, version checks, DTO/review construction, proposal publication and workflow mutations. Additional writers are duplicate-review questions and atomic acceptance receipts. Additional readers are:

- People proposal queues and dispositions; ownership identity blockers, corrected review, report contributions and source-name support.
- Packet report disclosure and note-export reading gaps; clinical import report-context groups and source-scope plan/inventory validation.
- Assistant continuation ownership and frozen/disjoint acceptance retry proofs. These retain stored-versus-effective version comparisons.
- Package-role dependency hashes, material source-text lookup and dependency invalidation; HTML navigation's parent package-plan inventory.

All these consumers access the operational view through the module. Domain functions may intentionally create a workflow during a mutation or treat an absent pre-workflow view as having no groups; the storage boundary itself does neither. Decoding remains detached from persisted rows, so local normalization does not mutate authority or a shared cache.

## SQL discovery, receipts and public source APIs

Report discovery uses `maximumReportDiscoveryOrder`, preserving the global maximum integer discovery order over original intake report groups. New-group stamping and its caller transaction remain unchanged. `retainedReportAcceptance` preserves the original-scoped `json_each` operation lookup and exact receipt identity/idempotent replay. `intakeIdentityConfirmations` preserves the existing global identity-confirmation scan used by ownership name support. These adapters keep their current SQL semantics; they do not hydrate every intake to perform a scoped lookup.

Source-file details DTOs currently expose the complete envelope, including operational intake state. `sourceFileDetails` receives the database and selected source row. Source-list search also matches the complete details JSON. `sourceDetailsSearch` returns a predicate, joins and bound parameters consumed by both count and page queries. It preserves existing `LIKE` behavior, ordering and pagination. These contracts are broader than stable source metadata and must survive the later cutover through selected-row reconstruction and a scoped search/index strategy.

## Remaining direct source metadata reads

The remaining direct `details_json` consumers concern these stable fields or non-intake envelopes:

- Intake listing, repeat-upload identity and source-text listing use original name, parent and creation time. Intake version diagnostics inspect the current raw publication solely for diagnostic evidence. Cached source context reads a proposal's top-level validation, not an intake workflow.
- Package ancestry/member identity, intake identity, reading-accounting source bindings and proposal dependency relationship checks use parent and locator alongside original SHA-256. HTML navigation's own/sibling names and parent pointers use those same fields; its operational parent plan is read through the boundary.
- Clinical-import ancestry and asset presentation use parent/locator. Clinical source-scope rows carry raw details into the shared operational reader rather than parsing a workflow independently.
- Record corrections use parent, locator and original name. Intake-plan source attribution uses current reviewed metadata.
- Source reference/filter SQL uses current source/provider metadata and parent. Proposal source relations use the top-level `originalSourceFileId`. Note export follows that non-intake proposal pointer before using the shared operational view.
- Synthetic placebo sources write independently fictional non-intake metadata; they do not contain intake workflow state.

Source-file row types and SQL selections may still carry the raw column for the shared decoder or diagnostic receipt. Carrying the column is not an independent operational parse. Full public details and search are handled by their explicit adapters above, not classified as metadata-only reads.

Current regression coverage exercises real intake review, People, ownership, package/source pins, duplicate and acceptance/replay consumers. This boundary alone does not reduce durable write amplification or establish large-import qualification; production activation and actual mutation-growth qualification remain open work.
