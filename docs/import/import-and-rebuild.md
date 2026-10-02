# Uploading office records and rebuilding SQLite

This reference describes the current import, evidence, review, and rebuild contracts.

## Why SQLite is rebuildable

The external `CRS_DATA_DIR` is the durable archive. SQLite is a disposable query index, built in the runtime directory. A container replacement, lost database, or application update must not make SQLite the only copy of accepted data.

The encrypted runtime reads public profile cards at startup and loads private data only after session-authorized unlock. Unlock validates the encrypted SQLite cache against its schema and committed sequence, or rebuilds current rows and searchable history from retained encrypted record versions. Cache loss never requires AI to reinterpret originals. Load/cache timings are measured separately from public startup.

The same accepted inputs and projection implementation produce the same logical rows and relationships. Database file bytes, temporary paths and operational receipts need not match. AI extraction is a separate, nondeterministic step.

Entry points: `src/server/dev.ts` and `runtime.ts` require an explicit data directory and default to `vault-app.ts`. `encrypted-profiles.ts`, `vault-store.ts` and `record-versions.ts` validate and load encrypted profiles. `startup-worker.ts`/`startup-rebuild.ts` remain legacy fixture/recovery helpers, not the default profile loader. See [the storage contract](../data/profile-storage-and-rebuild.md) and [recovery commands](../../src/server/PORTABLE.md).

## What a rebuild needs

- Unchanged original sources and attachments.
- Accepted personal record versions: People, notes, links and personal choices.
- Accepted clinical record versions: structured clinical assertions, evidence, source indexes and the complete mapping-decision journal.
- Retained mapping and attribution files, including human-readable rule mirrors.

**Raw PDFs plus mapping files alone are insufficient.** The accepted extraction and curation are required inputs. Acceptance fixes the reviewed AI output as durable data, so future rebuilds never need the model to reinterpret a PDF. Newly created profiles start empty and require no other patient's archive.

## Upload → convert → review → accept

1. Upload the office artifact; source attribution is optional and can be reviewed later. The host retains its original bytes and checksum. Prepared JSONL is supported but optional.
2. Choose **Read file with Moxie**. The connection is preflighted automatically with fictional content before private conversion; PDF/image conversion also requires image capability. Larger extractions can use multiple separately reviewed proposals (up to one million characters per tool call); each states its part/page range and remaining coverage. The host starts a profile-scoped conversation with the selected delivery. Conversion can inspect bounded text, PDF page renders and text layers, images, embedded files and ZIP members. Progress, cancellation and retry appear in the intake page. It never accepts its own proposal.
3. Review the proposed records, their original-source links, attachment references, uncertainties and coverage gaps. Correct supported labels, dates, values and classifications, or skip entries. A skipped or unsupported item remains in the original and retained proposal.
4. Accept the reviewed selection. You can later convert or review the same original again to recover skipped information; import history and earlier accepted assertions remain retained. The host verifies the proposal version, archive revision, source bytes and asset ownership. Ordinary adapters project observations/test concepts, medication assertions, procedures and documents, with evidence and asset associations. Accepted curation is durably published; a publication problem remains visible and retryable.

Review issues distinguish identity, date, uncertain reading and information, with text anchors and page/member links where supplied. Candidate-version-scoped drafts retain edits, answers and resolutions. **Review later** saves encrypted metadata without modifying the original; **Keep original only** closes that candidate version without accepting clinical data. Reopening the delivery preserves earlier accepted groups and outstanding work. **Remove from review** uses personal archive visibility and is reversible; physical file deletion is not implemented.

Sources keeps the retained original/proposal and any saved-record linkage visible as the primary state. Immutable retention-time coverage and review labels appear separately under **Historical extraction details**: an original or proposal receipt does not prove that every region was read, and an old `unreviewed` or `partial` snapshot does not override a later reviewed Import decision. The historical section links to Import for current reading progress, questions, drafts, dispositions and acceptance history.

Optical prescriptions are accepted document mappings, preserving literal eye-side labels, SPH/CYL/axis/add/prism/PD and contact-lens fields, units and date text without inferred values. **Test results → Vision** reads these reviewed mappings; each evidence occurrence remains visible even when accepted assertions reuse a document. Equal dates or optical values do not collapse source occurrences.

Conversion sends requested source text and relevant images through the private LiteLLM Proxy to the exact configured model alias. Provider choice is defined in operator-owned proxy configuration. A local Ollama upstream stays local only when the complete proxy route and Ollama server prohibit cloud fallback; hosted providers receive only explicitly scoped evidence. The application exposes scoped health tools, with filesystem and shell access unavailable. Records are untrusted evidence. The assistant journal retains visible messages and operation summaries, never hidden reasoning. The UI displays measured token usage when the proxy reports it; unavailable usage is not zero and no unsupported cost estimate is shown.

### Evidence and format limits

The [resumable intake contract](../../src/server/INTAKE.md#zip-inventory-and-resumable-extraction) provides bounded streaming delivery, PDF/HTML/ZIP-wide indexing, optionally overlapping extraction windows, stable candidates and durable progress/coverage tracking. Newly created PDF plans use non-overlapping two-page target units by default; explicit overlap remains available when the source requires it. A plan pins source hashes, model/instruction identity and mappings. Its serialized units and IDs survive restart and SQLite loss rather than being regenerated from later defaults; changed configuration requires an explicit replacement plan.

Model-facing plan state is a bounded structured projection rather than the complete review object. Plan-pin, unit, candidate-version, occurrence, report-scope, question, prior-answer, proposal, decision, batch, operation, acceptance/import-history, mapping-rule and missing-asset sections expose exact counts and explicit offsets; the converter follows `nextOffset` to exhaustion or reads one exact unit by ID. Every page is bound to the intake version and mapping-rule version; a change requires discarding partial chunks and restarting that section at offset zero. Oversized logical items are explicit ordered JSON chunks rather than opaque prefixes. Candidate pages retain bounded clinical match keys, stable IDs and recent locators, while exhaustive occurrence/report pages preserve distinct source events; equal values never auto-merge records. Page/image reads retain the exact current evidence, source hash, locator and version while full candidate payloads and accepted review views remain in the durable review authority instead of being repeated in every model request.

PDF pages are rendered for visual review as well as exact page-text extraction. The server verifies a retained PDF once through the same open file descriptor used by one isolated, profile/source-hash-scoped PDF.js range session; indexing and later page reads reuse that bounded session instead of loading and reopening the complete original for every page. Individual parser allocations, page reads, text windows, pixels, PNG output, attachments, worker heap and operation wall time remain bounded. Productive reading has no total page allowance; see [automatic recovery](automatic-recovery.md). Stop, profile teardown, source change, error and idle expiry dispose parser state. Page previews are transient: the unchanged PDF is the durable attachment, avoiding one duplicate PNG and archive snapshot per page. Embedded files retain their own bytes and locations. Visible photos/diagrams remain available in the original PDF; a page render is not a recovered original photograph. Image previews may be scaled; originals are unchanged.

Streaming uploads default to 128 MiB per original, configurable with `CRS_INTAKE_UPLOAD_MIB` up to 1 GiB; non-PDF whole-document extraction defaults to 64 MiB (`CRS_INTAKE_EXTRACTION_MIB`, up to 256 MiB). A PDF within the upload limit is not rejected merely because it exceeds that whole-document memory gate; its isolated range session applies the independent PDF bounds above. JSONL rows remain limited to 2 MiB and 50,000 rows per validated proposal. ZIP extraction rejects unsafe paths, duplicate names, symbolic links and encrypted members; limits are 10,000 total entries, 5,000 files, 100 MiB expanded bytes and 25 MiB per member. Names are bounded to 2,000 characters each and 2 MiB of UTF-8 names in aggregate. Inventory streams each file to verify its hash and actual expanded size against declared sizes and byte limits. Nested archives require separate explicit inspection rather than automatic recursion. Empty/unreadable members stay explicit pending work and their original ZIP bytes remain retained. The model must inspect every relevant page/member and report unreadable or omitted regions; a successful tool read alone does not prove complete clinical extraction.

ZIP processing begins with a local inventory of member IDs, hashes, byte counts and exact-byte duplicates. Inventory reports `coverage: inventory_only` and `complete: false`. Bounded member inspection reads literal text, JSON structure or PDF pages; model-proposed clinical/context/attachment/historical/unknown/nonclinical roles carry evidence reasons and supplied or missing references. Role decisions do not mark extraction complete. Plan units separately track pending/partial/completed processing and inspected/extracted/context/unreadable coverage. Every occurrence and unresolved section must be accounted for; queue exhaustion and duplicate bytes do not prove chart completeness or clinical identity.

Literal values, comparators, numeric spelling, units and partial date precision survive acceptance. A medication's recorded/order date is distinct from an explicitly supplied start/end date. A provider's old `active` flag never establishes personally confirmed current use. Family findings do not become the patient's observations: supported clinical mappings require an explicit Self subject, including documents. Other or unknown subjects remain retained source evidence until explicitly reviewed.

## Repeated deliveries and changed assertions

An identical upload is idempotent. A clinical assertion is automatically reused only when identity is supported by the same issuing-system/record ID, or the same original hash, locator and envelope ID, **and** its structured assertion matches. Cross-provider copies retain every source occurrence through evidence. Equal dates or values alone do not establish a match.

A changed assertion under the same source identity receives a separate version and source-version relationship. Both remain available; the importer does not infer which is current. Uncertain identities stay separate for review. Entire original files and proposal text remain retained; clinical deduplication does not mean deleting source evidence or claiming every retained byte is novel.

Import receipts record retained rows, exact repetitions, earlier raw matches, clinical additions, reused assertions, retained-only items, changed versions and applied rules. Paired-evidence review records same-event, changed-version, distinct or unresolved decisions. Every assertion and original remains; a relationship never chooses among conflicting values. Intake offers up to 12 accepted same-label candidates for review; the assistant can preview any two accepted records of the same clinical kind by stable ID. Labels only find candidates. Byte-identical original reuse is per profile; fragment factoring across distinct files remains out of scope.

## Mapping feedback

The reviewed source, or acquisition source when no reviewed source exists, supplies that profile's accepted exact-label rules to conversion/review. Source attribution does not prove the record's authoring organization. Reviewed source, care area, document type and topics are versioned metadata; original acquisition ownership, filename, bytes and hash remain unchanged.

Report-source review shows one exact current record set and source value before confirmation. Its durable authority is per occurrence and immutable report/context reference, so one deliberate choice can cover records introduced across multiple report pages without treating a later cumulative group label as earlier authority. Compatible future members extend only under the same exact report/person/source/context scope. Changed context does not inherit, accepted Unknown history is not rewritten, and current versus saved effective coverage remains separately visible.

In intake review, **Use this mapping for matching labels from this source** saves a narrow rule. Rules may rename a test, medication, procedure or document, or classify a procedure category. They never copy patient values, dates or doses into future records. Latest decisions for the same exact source/kind/label supersede earlier active rules, while history remains retained.

For existing data, ask the assistant to review a source mapping. `health_mapping_review` previews affected count and before/after examples, then creates a proposal. Apply rejects stale previews and updates the derived rows with stable IDs, unchanged originals, an auditable prior value and a durable idempotency receipt. Repeat delivery matching respects the corrected assertion. The UI reloads after acceptance. Small rule applications run in one transaction; startup reconstructs the same accepted result without AI.

The complete decision history lives in the versioned `manual_batches` projection; `mappings/import-rules/` contains profile-private mirrors. These are declarative data, not executable scripts. `health_record_correction_review` previews individual observation, medication, procedure or document corrections with source evidence. Explicit exceptions take precedence over later exact-label rules and repeated deliveries. `health_duplicate_review` previews paired decisions. The UI shows before/after or both evidence panels before Apply; retry identity and revision checks prevent silent replacement. Unresolved questions remain attached to the original delivery.

Classifications include event kind (order, performed, historical mention or unknown), procedure category, observation/document category and document visit-specialty metadata. There is no separate visit entity. These are reviewed proposals grounded in literal section/code/author evidence; richer provider interpretation instructions do not establish the accuracy of a real model extraction.

## Navigating supplied evidence

`intake_plan` supports read/create/read_unit/search/follow. The scoped HTTP equivalent exposes plan/unit reads and `GET .../intakes/:id/navigate?action=search&query=...` or `action=follow&referenceId=...`. ZIP units pin a retained member ID/hash. PDF links resolve only supplied internal destinations; HTML indexes headings, tables, anchors and sibling file references. Search returns bounded literal text snippets, not OCR or clinical conclusions. Missing/remote dependencies are reported without network fetches, and HTML is never executed. Navigation does not mark extraction coverage complete.

## Profiles, private documentation and assistance

Create profile builds an empty Self. **Private copy** preserves current accepted real data and originals and changes only the new profile's identity/storage ownership; it is not anonymization. **Create Placebo account** independently generates fictional clinical and personal data without reading another profile. Whole-profile deletion requires the current full display name and version. Individual accepted entries remain append-only and use archive/restore.

Contributor documentation and tests use generic or independently fictional examples. Private source archives, development notes, credentials, model output, and local validation artifacts stay outside Git.

The assistant has current profile/page context, warm first greetings, Markdown replies, measured usage, note proposals, explicit attachment associations, field-level historical restoration, and source-mapping proposals. All changes require review/apply. It cannot edit application code, contact providers or activate a rebuild through a shell.

## Verification

Synthetic server tests cover PDF text/render and ZIP bounds, original preservation, profile boundaries, duplicate/version behavior, stale review rejection, rule replacement, receipt conflicts, publication retry and deterministic rebuild. A full HTTP test runs an empty profile through upload, injected-model conversion, review, acceptance, clinical lookup, mapping correction and database-loss recovery. Mounted React tests exercise the intake flow and profile controls. These tests verify the host workflow; they do not certify the accuracy of every future model extraction.

Component, backend, browser, and encrypted Docker checks cover fictional import and cache-loss reconstruction paths. Real-provider and OAuth workflows, representative image/PDF extraction, large-ZIP end-to-end behavior, physical passkeys, and printing remain unverified release checks. Controlled fixtures do not close those gates.

## Intake state access

The [operational intake access boundary](intake-state-access.md) centralizes current views, publication, discovery and receipt lookup while preserving the existing source-row representation. The incremental primitive is not yet the production intake authority.
