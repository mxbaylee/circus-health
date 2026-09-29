# Integrated import evidence review — implementation draft

Status: the initial integrated review implementation is available on the feature branch; section 11 distinguishes delivered behavior from open work. This draft records the intended behavior and recommended defaults; it does not close existing extraction requirements or certify detector accuracy. All examples are independently fictional and use Cookie Doe. The accompanying interactive mock is illustrative and performs no real extraction or persistence.

## 1. Outcome

Import processing produces both clinical proposals and source-linked review items for unresolved material. The Import review is the primary entry point for reviewing proposed records and their originals. The standalone **Browse imported source text** control is removed. Sources → Files → **Originals and source review** also provides text review and manual record creation, including sources that produced no clinical proposals.

Every original has an import section even when it has no clinical proposals. A zero-record result must not hide extraction problems or be described as “all reports reviewed.” A warning-free document is not necessarily complete or accurate. Full text, including administrative and repeated content, remains retained separately from clinical records.

The desired benefit is fewer consequential omissions with a manageable human review burden. Producing fewer warnings by suppressing unknown material is not success.

## 2. Review experience

### Report section

Keep the compact, themed report heading: original filename, report title, source control, and person control. Existing source-label and person-assignment policies are unchanged by this feature. Unknown ownership is handled inside the shared review experience; a name mismatch never discards a source.

Under the heading, show a collapsed summary such as **2 areas need verification · Review**. Expanding it reveals grouped source issues, each with a concrete reason, page/location, and Review action. This area is present without clinical records. Problems affecting an existing record also appear inline on that record; they reference the same underlying issue and do not create duplicate work.

Each record has a visible **Review / edit** action and its source location. Ordinary eligible records retain **Confirm & save**. A record with an unresolved material value, unit, identity, date, or evidence-association problem requires review before acceptance; unrelated records remain savable. Batch acceptance selects only eligible records and reports excluded items explicitly.

Example uncertain record: **Bone mineral content · 5.8 · Unit needs verification · Page 2**. Do not fill the unknown unit with a guess or display a model score as an accuracy percentage.

Example recordless issue: **Handwritten addition · Page 3 · Writing could not be reliably read · Review**. It is a source issue, not a fabricated empty clinical record.

### Shared evidence accordion

Expand review directly beneath the selected record or source issue. On narrow screens, original evidence and fields stack inside that same accordion. On desktop, place original evidence beside the editor. Reserve sidebars for report-wide source and person settings. Include:

- Original/member name, page navigation, zoom, rotation, and location highlights when supported. Default to the referenced region but retain access to surrounding context and every page.
- Specific issue reasons, reader alternatives, and whether the location is precise or page-only. Never draw a guessed bounding box as verified evidence.
- A type-appropriate clinical editor, including person, label, date, value/unit, and other supported fields. Reuse current validation and accepted-record correction flows.
- An expandable **Extracted text** area for literal transcription corrections. This replaces the standalone source browser without deleting its retained-text functionality.
- **Add record from this section** for omissions, including unflagged omissions discovered by the user. Multiple records can refer to the same region.
- Explicit dispositions: confirm reading, correct text, no clinical record needed, not text, cannot read, and review later. Distinguish them internally and in history.

Saving a draft does not accept a record or resolve an issue. Confirming unchanged content records human verification without setting `manuallyEdited`. Changing clinical fields sets the existing edited indicator. A new manually authored record has human provenance, not invented model provenance. Successful save returns to the review list with the affected item updated. Closing preserves a durable draft; navigation prompts only if the latest edit has not been saved.

Accepted records open through the existing correction preview/apply workflow. They are never silently mutated by a text correction or a new model pass.

### Outcomes and copy

- **Needs verification**: a specific detected problem, with its reason.
- **Not fully inspected**: coverage has not been established; not synonymous with detected low accuracy.
- **Reviewed by you**: explicit scope-specific human confirmation.
- **Edited by you**: clinical fields changed by a human.
- **Unreadable / review later**: unresolved exceptions, preserved across reload.
- **No clinical record needed**: a disposition for record extraction; readable text is still retained.

Use **Reading finished · 3 records proposed · 2 areas need verification**, or **Reading finished · No clinical records proposed · 1 area needs verification**. If processing failed or stopped, say so; do not label it finished. If no issues were detected, say **No issues flagged**, not “complete” or “100% accurate.” Reading completion, text coverage, human inspection, and clinical acceptance remain separate states.

## 3. Processing pipeline

1. **Inventory and retain.** Preserve the original, source hash, package ancestry, page/logical-section inventory, and extraction status. Inventory may begin page-level and refine to regions; it must not depend on having clinical proposals.
2. **Extract durable text.** Run supported native/OCR/structured adapters automatically as part of processing. Retain text, coordinates, reading order, alternatives, issues, and revision provenance. Continue in bounded, checkpointed operations. Adapter failure or unsupported content becomes a located exception; it is not empty success. Avoid introducing an unlimited whole-document OCR prerequisite: preserve current readiness checks and permit processing of ready, unaffected portions.
3. **Propose records with evidence.** Require evidence locations and the source-text revision used. Preserve separate fields for literal source wording and clinical interpretation. Model-supplied coordinates and references must be validated against current, authorized source evidence.
4. **Audit omissions.** Independently inspect source content and proposal/evidence coverage. Look for potentially relevant tables, changes, annotations, or assertions not represented by proposals. The audit cannot operate solely on the first reader's summary. A separate pass is another check, not proof of independent errors or completeness.
5. **Repair locally and within limits.** A suspicious region may trigger rotation, a better rendering, another qualified adapter, or retrieval of nearby headings/pages. Record inputs, results, budget, and stop reason. No unlimited retries. Agreement is evidence, not certainty. Preserve unresolved issues when budget or provider access runs out.
6. **Reconcile and group.** Match section outcomes to proposals, existing evidence, or explicit context/repetition dispositions. Group related warnings without discarding occurrences or hiding clinically different information.
7. **Publish incrementally.** Show records and review items as they become available. The host reconciles issue identity and human decisions; model output cannot mark a human-reviewed scope complete.

Each audited scope records one or more outcomes: represented by linked records; contextual text; repeated material linked to its occurrences; unresolved; or not yet assessed. “No proposals” alone is not a rationale. Audit dispositions describe what processing concluded and remain inspectable; they do not prove that all clinically relevant information was captured.

## 4. Warning quality and large documents

Separate **reading uncertainty**, **interpretation uncertainty**, **coverage unknown**, and **processing failure**. Each issue must identify evidence, location precision, what is uncertain, and a useful next action. Keep numeric reader scores internal until calibration supports meaningful user-facing interpretation.

Prioritize specific, potentially consequential problems over generic coverage caveats. If text is too unreadable to assess relevance, retain “importance unknown”; do not infer low importance from missing keywords. Score/rank may order the queue but must not silently resolve an issue.

For an 800-page document:

- Paginate the inventory and issue feed and render previews on demand. Preserve resumable work and per-operation budgets.
- Group exact recurring source material conservatively. Similar layout or matching headings alone do not establish redundant content. Compare values, dates, negation, people, annotations, and revisions before proposing equivalence.
- Keep occurrence counts and navigation within each group. A grouped resolution applies only to the explicit, previewed scope and supporting evidence; different readings remain separate.
- Collapse retained contextual/administrative content instead of asking for dismissal. Keep it searchable and inspectable through the report's original/text view.
- Do not count the same issue twice when it appears both beside a record and in the report summary.
- Offer low-priority and deferred issues without making them disappear. Avoid an arbitrary top-N cutoff that silently drops the rest.

No product promise of perfect detection or zero false alarms. Evaluate detection and user burden together before selecting thresholds and group policies.

## 5. Shared contracts and durable state

Extend existing contracts rather than create a second review database. Exact field names are implementation choices; required information is:

**Evidence reference:** profile-scoped original/member ID and hash, extraction revision ID when applicable, one-based page/logical section, optional normalized region, optional span IDs/text offsets, and precision (`region`, `page`, or `section`). A record can have many references; a region can support many records. Coordinates use the existing canonical display frame after intrinsic rotation, before user rotation. Highlight transforms must preserve that distinction.

**Review issue:** stable ID, source references, detector/version, category and concrete reason, suggested priority with rationale, related candidate/version IDs (possibly empty), grouping/occurrence references, state, and revision dependencies. Reuse `SourceTextIssue` for extraction issues; extend or reference it for record-level interpretation rather than copying its lifecycle. Map existing `IntakeReviewIssue` entries to the shared projection.

**Scope assessment:** source scope/revision, assessment status, proposed disposition, supporting record/occurrence links, producing operation, and human supersession if present. Page summaries aggregate scopes without implying that a partially inspected page is fully inspected.

**Review event:** actor, operation ID, expected issue/source/candidate versions, explicit scope, action, before/after references, timestamp, reason where needed, and accepted-record dependencies. Resolve specific issue IDs explicitly; an edit alone is not resolution. `later` and `unreadable` remain exceptions, not success.

Originals, extraction revisions, human events, and accepted versions are durable evidence. SQLite/indexes and queue summaries remain rebuildable. Model responses and transient jobs are not the recovery authority.

## 6. Writes, reprocessing, and consistency

Recommended default: uncertainty blocks only affected acceptance; unrelated processing and acceptance continue. Human overrides require a scoped explicit decision and preserve the original warning. Never bypass person authorization, unsupported type constraints, or record schema validation.

Source corrections create a new text revision. They invalidate dependent proposals for fresh review while preserving human drafts and accepted records. Offer **Re-read this section** explicitly, with the required surrounding context. If dependency scope is uncertain, broaden invalidation conservatively and explain it. Re-reading does not automatically save clinical changes or overwrite user edits.

Manual creation from a section uses a host-owned reviewed-draft path that does not require a model candidate. Validate evidence and person assignment; keep the source link through acceptance and recovery. Reconcile later model proposals as possible duplicates, never automatically erase the manual record.

All mutations are profile/session authorized, idempotent, and version checked. A retry with the same operation ID returns the prior receipt. On a version conflict, retain the local draft, refresh dependencies, and present a comparison/review step if the source changed; do not silently replay an old decision against new evidence. Guard acceptance against a newly discovered material issue racing the save.

Old unlocated records remain reviewable with honest original/page fallback. Old extraction issues and source-review revisions are projected into the new UI. Do not fabricate coordinates, audit completion, or human verification during migration.

## 7. Repository implementation map

- `src/shared/intake-source-text.ts`: preserve region/span/revision/review semantics; add references and issue information only where required.
- `src/shared/intake.ts`: extend clinical evidence and review/feed contracts for related issues, source-only sections, and scoped review state.
- `src/server/intake-source-extraction.ts`, `intake-source-extraction-operation.ts`, `intake-source-ocr.ts`: automatic bounded extraction, explicit adapter exceptions, and region repair hooks. General coverage/structure caveats must not masquerade as specific detected errors.
- `src/server/intake-batches.ts`, `intake-batch-journal.ts`, `proposal-source-text-handoff.ts`, `intake-source-text-dependencies.ts`: scheduling, resumability, current evidence pins, and dependency invalidation. Add audit consumption beside the existing processing consumer after tracing its actual call path.
- `src/server/intake-source-text.ts`, `intake-source-routes.ts`: reuse durable transcription corrections and authorized page previews; extend scoped issue actions as needed.
- `src/server/intake-review.ts`, `intake-report-queue.ts`, `clinical-review-routes.ts`: source-only feed items, shared issue projection, reviewed manual drafts, existing accepted-record correction policy, and acceptance guards.
- `src/app/features/import/ImportPage.tsx`, `ImportReviewPresentation.tsx`, `ImportDetailReview.tsx`: integrated report/issue/record feed, shared evidence accordion, visible editing, and accurate status copy.
- `src/app/features/intake/SourceTextReview.tsx`: reuse text correction and review behaviors within the accordion. Retire `ImportSourceTextBrowser.tsx` as a standalone entry point only when all its necessary capabilities have replacements.
- Update maintained import scenarios, performance, storage/recovery documentation, and `docs/application-todo.md` with remaining qualification gates when implementation begins. This draft alone does not mark them complete.

Routes should extend existing intake/source/review APIs where possible. Required operations are paginated source/issue reads, scoped draft save, explicit issue disposition, manual source-linked proposal creation, bounded re-read, and existing acceptance/correction. Document final request/response types and conflict codes with the implementation; no endpoint in this draft is claimed to exist.

## 8. Diagnostics and performance

Extend the diagnostics download with counts and sanitized reason codes: extraction adapter/version and failures, page/scope coverage states, issue counts by type/state, groups and occurrence counts, repair attempts/time/token usage, audit completion, re-read/dependency conflicts, and acceptance rejections. Preserve exact operational errors in sanitized form. Do not export raw source wording, patient names, credentials, images, or model response content by default. Include deployed build identifiers.

Separate elapsed time for extraction, model reading, audits, automatic repair, and waiting for a person. Do not present human waiting as provider work or fabricate remaining-time estimates. Define and record per-document/operation limits before live tests; tune numeric defaults with measured latency and review value.

## 9. Acceptance and evaluation

Deterministic behavior tests must cover:

- Zero clinical proposals plus unresolved source issues: file and review actions remain visible; no misleading “all reviewed” message.
- Clear, uncertain, unreadable, unsupported, and context-only sections; concrete warnings versus generic unverified coverage.
- Visible edit action for all record kinds; unchanged verification versus edited fields; manual source-linked creation without model output.
- One record/many regions and one region/many records; multi-page headings/footnotes; region highlighting at rotation/zoom, page-only fallback, and package-member navigation.
- Correcting literal text versus changing a clinical interpretation; no accidental mutation of accepted records; dependency invalidation and explicit re-reading.
- Background extraction concurrent with drafts/acceptance; stale revisions, lost responses, retries, reload, session/profile switches, and reconstruction from durable evidence.
- Grouped repeats with one changed number, date, person, negation, or annotation; nonidentical evidence must not be silently suppressed.
- An 800-page fictional fixture: bounded reads, pagination, no full-document client payload, persistent exceptions, and no required dismissal per boilerplate occurrence.
- Keyboard focus/return, screen-reader labels, visible issue reasons, mobile layout, zoom/rotation controls, draft preservation, and no inaccessible hidden-only actions.
- No standalone source-browser button after replacement; every former required capability remains reachable through report or record review.

Detection evaluation requires labeled, held-out documents, not merely schema tests. Include both artificial defects and representative owner-authorized documents evaluated outside Git: native/scanned/mixed PDFs, tables, handwriting, multilingual content, repeated administration, negative statements, and important changes surrounded by boilerplate. Score by document family to avoid template leakage.

Measure important defects flagged, important defects missed without warning, unnecessary review requests, justified but unresolvable requests, review time, and grouping errors. Independently review ground truth and adjudicate disagreements. Report sample sizes, uncertainty, and results by document category. Do not choose a numerical accuracy target without an agreed definition of important defects and measured baselines.

## 10. Delivery sequence and decisions

1. Freeze issue/evidence/action contracts and acceptance semantics with focused tests.
2. Ship source-only feed visibility and the shared accordion over existing evidence. Preserve old entry points until equivalent access is verified.
3. Add the reviewed manual-creation path and scoped correction/re-read integration. Verify recovery and concurrency before retiring the standalone browser.
4. Add automatic extraction/auditing/repair in bounded operations; qualify grouping and warning policies on held-out fixtures. Detector improvements can follow without changing the user's review workflow.
5. Test real user review with owner-authorized documents, adjust copy/prioritization, and retain explicit open limits. Obtain independent implementation review before describing the feature as complete.

Proposed defaults for owner review: only affected records are blocked; re-reading is explicit; full-page inspection is optional and tracked separately; unreadable/deferred material remains visible as an exception; grouped decisions require a previewed scope. Thresholds, repair budgets, supported-language expansion, and ranking weights require measured calibration. The UI can be implemented before perfect detection exists, but cannot advertise completeness that the processing has not demonstrated.

## 11. Initial implementation and remaining work

The initial implementation removes the standalone source-browser control. Records expose **Review / edit** in an inline accordion with original evidence and the existing clinical editor. Explicit PDF page references open that page; unavailable references show a page-one fallback notice. The preview supports rotation and zoom. Open drafts survive a background feed update, and unsaved source corrections prevent closing or changing review context until addressed.

Report sections expose bounded source issues, with separate disclosures for general uninspected coverage and retained reader observations. Originals without proposals remain reachable in the import list. Reader observations are processing claims, not a second omission audit; corrections mark dependent old observations as historical. Issue inventory is paginated; opening the transcription editor still loads its full revision.

**Add record from this section** creates a host-authored, source-linked review draft for Self or an existing person. It opens in the same record accordion. Creation neither accepts a clinical record nor resolves a source warning. Existing source correction and explicit disposition history remain durable; accepted records remain unchanged. The source API and extraction budget details are maintained in [import processing](import-processing.md) and the [API reference](../src/server/API.md).

Automatic retained-text capture starts with a bounded step and continues during selected reads. Terminal zero-proposal sources receive additional bounded capture, so a lack of proposals does not hide their source-review path. This does not silently replace source revisions under existing proposals. Cumulative limits and explicit continuation remain visible exceptions.

The following draft requirements remain open under CRS-116 and the existing extraction qualification requirements:

- Independent omission-audit passes, calibrated importance ranking, and qualified automatic alternative-adapter repair.
- Precise links from individual clinical fields to extraction issues and corresponding new acceptance guards. Existing clinical review blockers remain; this slice does not claim that every unresolved OCR issue blocks exactly its dependent records.
- A distinct durable **No clinical record needed** disposition, conservative semantic repeat grouping across pages, and duplicate reconciliation between later model proposals and manual drafts.
- Region-only model re-reading with sufficient surrounding context, field-level evidence highlighting where trustworthy geometry exists, and paginated editing of very large text revisions. Current re-reading uses the existing source/batch path.
- Extended diagnostics for future audit/repair stages, held-out detector qualification, and actual human usability review. Fictional browser and regression tests establish mechanics, not the ability to find every important omission.

## 12. Owner refinement: focused correction accordion

The pending-record accordion now narrows section 2's broad editor: show the source at the referenced page, the field or fields actually needing correction, **Update**, and **Close review**. Do not repeat identity questions, transcription controls, all clinical metadata fields, or acceptance/defer/exclude actions inside it. Update saves the supplied verified fields and resolves only their explicitly associated issues, then closes the accordion. Blank fields are omitted from that partial update and keep their existing unresolved state. Partial corrections are durable but do not make a record with remaining blocking uncertainties eligible for approval. Clinical acceptance stays on the table row; unrelated blockers remain. Close discards unsent input, while failed writes preserve it. Report-wide settings and separate source-issue transcription review remain available in their own contexts. Region cropping/highlighting still requires trustworthy evidence geometry; the current fallback is the indicated full page.
