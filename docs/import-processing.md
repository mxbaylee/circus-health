# Import processing: implementation specification

Implementation decision, 2026-09-26. The initial specification was committed before implementation. The owner subsequently authorized application work on this feature branch. This document consolidates the design, evidence, implementation sequence and remaining qualification work; it does not claim universal extraction accuracy or production qualification of every source stratum.

Work is on `codex/import-processing-spec`. The specification was committed before implementation; the feature was subsequently squashed for review, while its experimental documents remain in this tree. A later documentation cleanup must follow the preservation procedure at the end of this document; the implementation does not remove historical evidence.

### Implemented application baseline

The feature branch integrates immutable source text with the existing encrypted record journal, local extraction with the import coordinator, and source review with Import and the clinical review workspace. Text, alternatives, located exceptions and relationships survive projection loss; copied profiles rebind ownership while preserving provenance. Native text is published before bounded local OCR. Human corrections protect reviewed pages while remaining pages can continue. A material source revision conservatively invalidates dependent unaccepted proposals, including ancestor package proposals, without rewriting accepted history. Identical clinical JSON derived from changed evidence receives a new candidate review version.

The source panel is available before a clinical proposal or provider connection. It supports actual-original comparison, editable page context, relationships, rotation/zoom, explicit exception actions, external clarification, immutable history and conflict recovery. The assistant has revision-pinned bounded retrieval of this evidence. Text inspection and clinical acceptance remain separate.

New reading jobs use progress windows rather than a lifetime product quota; existing configured/legacy jobs retain their saved policy and all counters. Provider dispatch receipts are published before requests, terminal outcomes and unknown usage are retained, and only classified rejected requests qualify for timed automatic retries. Unknown outcomes block blind replay. These host mechanics are exercised with fictional sources and controlled transports, not represented as real-provider or human-accuracy qualification.

The starting OCR route is local English Tesseract with explicit uncertainty. Unsupported formats, unreadability, decoder/worker limits and unresolved structures remain visible. Whole-document clinical routing and a calibrated token/output-fit policy remain unqualified. The existing bounded clinical route and two-page plan fallback remain in use. Background work survives tab closure while authorization remains active; lock, sign-out and profile switch still revoke the current runtime. Job-scoped unattended authority (CRS-081) is **not implemented or claimed**. Human accuracy, difficult scan strata, provider quality and deployment qualification remain release checks in the work list.

Pre-AI patient identity screening (CRS-111) and richer clinical context/section routing (CRS-086) also remain implementation work, not merely empirical qualification. Existing identity review and bounded plans remain the authority in those paths. The baseline is a usable source extraction/review and durable execution layer, not completion of every requirement in this specification.

### Implementation validation, 2026-09-26

The final server run (`node --test --test-concurrency=4 src/server/test/*.test.ts`) passed 1,205 tests with seven optional checks skipped. The complete UI suite passed 554 tests and the Chromium browser suite passed 27 journeys, including source correction, original viewing, immutable history and stale-tab recovery against the encrypted runtime. State, tooling, deployment-command and controlled continuation suites also passed. Formatting, all TypeScript checks and `npm run image:build` passed. The packaged English OCR engine passed its fictional raster test in a read-only container with networking disabled; run it with `CRS_SOURCE_OCR_REAL=1` inside the built image.

Independent code/test review identified and resolved stale-proposal queue readiness, corrected evidence pins and streamed renamed-media detection defects. The final scoped review was positive. These checks exercise storage, routing, review and execution mechanics; they do not substitute for real-human accuracy, real-provider qualification, full Compose performance or the open implementation items above. No private source data or live provider campaign was used for this implementation validation.

### Testing and iteration

Run the feature through the supported npm → Docker Compose → LiteLLM setup in [installation](installation.md), using a separate archive and independently fictional documents. Local text extraction and source review work even when clinical model reading is unavailable. A configured model is needed to generate new clinical proposals; its failure must preserve the original and any completed source extraction.

1. Upload a text document, PDF or PNG/JPEG scan. Open Import → **Needs attention**, expand the file’s Review control, then **Review source text**. The selected original in Sources → Files offers the same compact review control. Extract locally if necessary; a larger document can continue with **Extract next pages locally**. Originals remain available independently of extraction.
2. Compare the original and transcription. Raster previews fit the available width by default; test manual zoom, rotation and a narrow viewport. Save a correction, inspect the page separately, and check the immutable history. Confirm that no clinical record was accepted by either action.
3. Open the same source in another tab, correct it there, then save an older draft in the first tab. The conflict must retain the draft. **Load latest saved revision** refreshes a clean editor or shows the latest saved version alongside an unsaved draft. Keep the saved version only when ready to discard that local draft.
4. From Needs attention or an existing report, open its source review inline in Import and choose **Read source for clinical review** after saving corrections. Sources text edits alone do not dispatch clinical reading. It uses the existing reading queue; a package member queues its original delivery. Active work and unconfirmed earlier requests block duplicate dispatch. Review any resulting proposal before accepting records. Old interpretations remain stale, and accepted history remains unchanged. Sources also allows **Add record from this section**; after creating a draft, choose **Review the new record** to open its Import accordion. Creating the draft does not accept it.
5. Try a retain-only input and an unreadable or unsupported document. Check that exceptions remain visible, original bytes remain accessible, and no acceptance or complete-text claim appears merely because there are no clinical proposals.

Direct original/member reads may append at most two locally extracted pages before returning evidence. Such host-owned progress renews only the model's change-detection pin; proposing still requires reading the latest retained passage. Human corrections before or after that progress continue to invalidate stale model work. JSON package-member navigation follows the same durable extraction and retain-only policy.

For this iteration, browser journeys cover the clinical-reading handoff, safe refresh and rendered source review. Screenshot evidence uses only independently fictional content and stays outside the source tree for attachment to the pull request. Separate source-stratum, real-human, real-provider, early-identity and job-scoped authorization work remains visible above; this testable feature does not claim those gates are complete.

Iteration validation passed 1,211 server tests (seven optional checks skipped), 565 UI tests and 27 browser journeys, plus formatting, TypeScript checks and the Compose image build. Two UI cases timed out during a concurrent Docker build; the complete suite passed when rerun without that build load. Manual testing against Compose exercised actual local OCR, retained originals after provider unavailability, correction history, stale-draft recovery, explicit inspection and disabled clinical reading for retain-only media. The test archive and all screenshot content were fictional. The browser's viewport override did not take effect, so the captures demonstrate desktop states; narrow-device visual verification remains a review check.

## 1. Purpose, authority and implementation decision

Build an importer that preserves exactly what a person supplied, retains complete located text, produces source-supported clinical proposals, and lets the person correct and approve the result without losing earlier work. Administrative text, repeated text and apparently unimportant annotations are part of the source; clinical relevance is not an extraction filter.

The chosen starting composition is:

1. Receive and inventory exact originals and package members.
2. Apply format and identity policy; select compatible extraction adapters.
3. Extract and persist located text, relationships, alternatives and explicit exceptions.
4. Use confidence, visible coverage, reader disagreement and structural signals to prioritize source review. Permit correction anywhere in the displayed source context and access to the full original.
5. Interpret retained evidence in bounded clinical work units, with report context and document-level reconciliation. Keep a whole-document clinical reader as a replaceable, separately qualified route.
6. Present version-bound proposals for explicit acceptance; retain correction and acceptance history.
7. Resume durable unfinished work and rebuild projections without repeating completed extraction.

The initial implementation uses the existing application coordinator, encrypted storage and worker boundaries. It does not introduce a broker, separate processing service, parallel clinical workers or a second acceptance system. Use TypeScript for application and host tooling, and the supported npm → Docker Compose → LiteLLM deployment path.

The [customer import specification](import-scenarios.md) remains the authority for outcomes. [Data contracts](data-model-contracts.md), [security](security.md), [profile storage and rebuild](profile-storage-and-rebuild.md), [record versions](record-version-storage.md) and [reconciliation](import-reconciliation.md) remain maintained contracts. This document defines the proposed implementation and qualification of those outcomes rather than replacing all repository documentation.

[CRS-115](application-todo.md#crs-115) owns complete durable text. Related open work includes CRS-086 context handling, CRS-081 background authorization and CRS-111 pre-reading identity checks. CRS-100 records an OCR experiment, not shipped OCR support. Preserve the existing work list and its open acceptance requirements. An experiment-completeness PASS does not close a feature or release gate.

### Decision classes

- **Required:** original preservation, profile isolation, complete source accounting, durable evidence, explicit uncertainty, non-destructive versions and reviewed clinical acceptance.
- **Selected starting design:** replaceable adapters, a durable text layer, serial clinical orchestration, source-based review with editable context, explicit dependency reconciliation and a versioned deterministic scheduler.
- **Provisional parameters:** extraction engine, signal thresholds, request-fit margins, clinical unit size, context expansion and retry timing. Pin these per plan; qualify changes with comparable evidence.
- **Unqualified capabilities:** a universal completeness detector, flawless human review, arbitrary handwriting/scans, the clinical reader comparison and unrestricted background processing after session termination. Build their seams without advertising unsupported capabilities.

## 2. What the experiments establish

These findings motivate the design; they are not proof of current application behavior.

- Native text alone omitted visible content. Ordinary OCR introduced transcription and structural errors. A literal union did not establish reading order, table associations or absence of invented text. Retain these components as evidence producers, not sole completeness authorities.
- The E1/E2b compositions failed their fresh complete-extraction gates. E2b improved some structure and reduced some guesses while retaining other failures. Preserve useful components; do not reject an entire engine family because one composition failed.
- Eleven finite human-review mechanics controls supported source-bound corrections, immutable versions, stale-review invalidation and recovery mechanics. They did not demonstrate that people discover every unknown error or that a production UI works.
- The detector study executed 24 local OCR calls on six independently fictional two-page sources, then compared eight policies on those sources and four deliberately injected variants: **80 original outcomes**. Only full-source perfect review passed every sample under the original rule that edits were restricted to selected target boxes.
- Independent review found that the strongest targeted policy already displayed sufficient source support for its remaining errors. Some failures were tiny target-boundary/padding gaps; others were table endpoints outside editable boxes on pages already displayed. This was not proof that a human could not see the errors.
- A separately declared **70-outcome post-hoc exploration** made all already displayed context editable without adding source pixels. Confidence + coverage + native/OCR disagreement + structural context, called **CVDS_EDIT** in the records, passed the finite model on **6/6 natural sources and 4/4 injected challenges**. Adding the second same-engine OCR setting supplied no additional quality benefit in that corpus.
- CVDS_EDIT displayed 8.6993 of 12 natural page-equivalents versus 12 for full-source review, about 27.5% less area. It still touched all 12 pages, displayed eight in full, and exposed a candidate-character upper bound of 3,780 versus 4,073. This is not a measured reduction in human time, effort or errors. Genuine unreadability remained an explicit exception.
- The new interaction rule was evaluated on already exposed sources and assumed perfect reading and repair. No actual corrected-document artifact, real-human study or clinical outcome was established by that calculation. The natural corpus was sparse typed material: 12 pages and 706 readable source tokens. Injected copies are adversarial challenges, not additional independent natural observations.
- In the older scripted 800-page workload, unit sizes 10/15/20 produced 896/870/856 requests. U20 reduced serialized text by about 18.1% relative to U10 but delayed the first proposal. Live outcomes were inconsistent across unit sizes. Neither universal linear latency nor a universally optimal 10-, 15- or 20-page batch follows from this evidence.
- The rereading-remedy prototypes supported source availability as a mechanism, but did not qualify the complete importer. Reading every page and retaining six clinical findings did not establish durable complete text: the F9 output retained seven full page texts from a forty-page source. A separate durable text layer resolves that architectural responsibility without requiring the entire text in every clinical proposal.

Independent reviewers gave the bounded detector study positive execution/completeness and extended-investigation reviews. Original failures, partial runs and accounting limitations remain valid. The interrupted clinical D1 comparison has unknown usage and no usable clinical result; this specification neither resumes it nor counts it as evidence for a clinical topology.

The implementation choice is therefore **editable source review with multiple prioritization signals**, supported by durable evidence. It is the best-supported candidate from this finite investigation, not proof of a globally optimal importer.

## 3. Existing code and intended integration

Baseline inspected for this draft: commit `d312320e378666c60a98c82d7683d96bf1981581`. Inspect current code and tests again when implementing; filenames below are integration points, not claims that the proposed features already exist.

- **Receive, inventory and bounds:** extend [intake upload](../src/server/intake-upload.ts), [package inspection](../src/server/intake-package-inspector.ts), [package handling](../src/server/intake-package.ts) and existing file limits. Preserve exact originals and bounded ZIP traversal. Format recognition does not override retain-only policy.
- **Physical source access:** reuse [PDF sessions](../src/server/intake-pdf-session.ts), [PDF workers](../src/server/intake-pdf-worker.ts), [native PDF delivery](../src/server/intake-pdf-native.ts) and [image handling](../src/server/intake-image.ts). Native PDF delivery concerns scoped original-page transport; do not confuse it with proof of complete text extraction. Add the OCR adapter behind the existing bounded host-work boundary.
- **Plans and context:** extend [intake plans](../src/server/intake-plan.ts), [navigation](../src/server/intake-navigation.ts), [model context](../src/server/intake-model-context.ts) and [continuation](../src/server/intake-continuation.ts). Preserve existing source/version pins and exact evidence retrieval. Summaries are navigation aids, never substitute source evidence.
- **Durable work and accounting:** extend [batch journals](../src/server/intake-batch-journal.ts), [reading budgets](../src/server/intake-reading-budget.ts), [workflow](../src/server/intake-workflow.ts), [shared batch contracts](../src/shared/intake-batch.ts) and [reading accounting](../src/shared/intake-reading-accounting.ts). Source accounting and clinical truth must remain separate.
- **Identity and proposals:** reuse [identity policy](../src/server/intake-identity-policy.ts), [identity grounding](../src/server/intake-identity-grounding.ts), [clinical imports](../src/server/clinical-import.ts), [report groups](../src/server/intake-report-groups.ts) and [report acceptance](../src/server/intake-report-acceptance.ts). Do not add a competing record acceptance or deduplication path.
- **Review UI:** extend [ImportPage](../src/app/features/import/ImportPage.tsx), [ImportDetailReview](../src/app/features/import/ImportDetailReview.tsx), [ReviewWorkspace](../src/app/features/intake/ReviewWorkspace.tsx), [review drafts](../src/app/features/intake/useReviewDrafts.ts) and existing batch/review adapters. Reuse existing components, tokens, navigation and save-status behavior.
- **Public boundaries and observability:** extend [shared intake types](../src/shared/intake.ts), [intake routes](../src/server/intake-routes.ts), [performance](../src/server/import-performance.ts) and [diagnostics](../src/server/import-diagnostics.ts). Update [INTAKE.md](../src/server/INTAKE.md) and the [server API](../src/server/API.md) only as actual behavior changes.

At the inspected baseline, `extractionUnits` defaults PDF plans to two pages and zero overlap, and accepts configured unit sizes from 1 to 50. Reading-budget code has operational guards and explicit extension accounting. These are existing behaviors, not optimal values selected by this specification. Existing saved plans must not silently change when new policy is introduced.

## 4. Source routing and eligibility

Inventory the actual source before selecting an adapter: detected format, retained byte identity, member/page counts, dimensions, native text amount, image regions and available structural evidence. Treat filenames, extensions and model classifications as hints. Persist the observed eligibility decision, selected adapter/version and fallback reason.

### Native-text documents

Extract native text and geometry, retain meaningful order and available structure, and reconcile visible content against the text layer. A nonempty text layer does not establish complete coverage. Image-only annotations, margin notes, signatures and raster tables may require local OCR or explicit source review. Keep competing readings with provenance rather than silently taking the most confident string.

### Scans, photographs and image documents

Use a bounded local image/OCR adapter and source review. Preserve original pixels and canonical coordinates through rotation, deskewing or resizing; derived views are disposable and must map back to the original. Record uncertain regions rather than inventing wording. Engine/installation choices require the source-stratum checks below; prior OCR experiments alone do not qualify handwriting, HEIC decoding or multi-page TIFF support. No cloud OCR service is introduced by this specification.

### Mixed documents

Route per page or region while keeping a document-wide source identity and coverage ledger. Prevent duplicated or omitted text at native/OCR boundaries. Retain remote headers, continuations and report/person boundaries. An adapter change must not erase uncertainty, transform an unknown association into a fact or change source ownership.

### Recognized structured exports

Prefer deterministic parsing for supported schemas. Preserve original field values, narrative text, unknown fields and references. A schema match does not prove clinical identity or permit direct acceptance. Unsupported fields remain retained source evidence with an explicit interpretation disposition. Do not invoke an LLM merely to give all formats the same processing path.

### Packages and retain-only inputs

Retain the package and account for every member occurrence. Reuse byte-identical storage where allowed, without treating repeated bytes as clinical identity or permission to skip required accounting. Keep unsafe paths, encrypted/unreadable members, excessive expansion and unresolved references explicit; never execute supplied HTML or follow external links automatically.

DICOM, audio and video stay retain-only under the customer contract. A readable report inside an imaging package takes its own route; the images do not enter an AI fallback. Unsupported types remain retained and discoverable. Generic “Read it anyway” actions must not bypass format exclusions or profile/identity authorization.

### Identity and dependency boundaries

Owner revision, 2026-09-27: a printed name or birth date that differs from Self does not reject or stop reading. Retain the report and its proposals, then ask who they belong to: Self, an existing person in People, or a new person. Keep patient evidence distinct from guarantors, parents and contacts. A person choice authorizes attribution of the displayed report scope, not clinical acceptance. Family records must remain attached to the selected person and excluded from Self's clinical lists and trends.

Confirming **This is me** adds the supported printed name to Self's known names in the same durable transaction, including when the primary name is already populated. It does not replace the primary name or existing birth date. An existing-person choice similarly retains the report name with that person. Preserve scope/version checks, idempotency and accepted identity history. An import does not override what the person has confirmed, including medication-taking status. Grouping by report, patient and date must carry evidence and unresolved dependencies, not just a guessed display label.

## 5. Durable evidence and state contracts

Define shared, versioned TypeScript contracts by extending the current intake domain. The names below describe required logical objects; implementation may reuse existing representations that satisfy the same responsibilities.

### Evidence objects

- **Source reference:** profile ID, original hash and durable reference, intake/source version, member identity where applicable, page or logical source locator, and canonical region/coordinate basis. All downstream objects bind to this reference.
- **Text revision:** immutable revision ID and parent, adapter/instruction versions, source hash, literal spans and their locations, reading-order and table relationships, explicit uncertain/unreadable regions, available alternatives and per-scope extraction dispositions. Preserve punctuation, negation, numbers, units and repeated occurrences.
- **Review event:** operation ID, authenticated actor, expected text/source revision, action, affected source scope, supplied correction or exception reason, and resulting revision. Distinguish machine output, human transcription and external user clarification.
- **Clinical task:** stable task ID, pinned text/source revisions, owned target scope, context/dependency references, selected route, limits, attempts, progress, unresolved dependencies and proposal references.
- **Proposal dependency:** candidate/version, supporting source locations and text revisions, identity/report/date evidence and review state. A change to any material dependency invalidates stale unaccepted interpretation or approval.
- **Attempt receipt:** durable dispatch identity before a provider call, attempt/route identity, timestamps, terminal/unknown status, supplied scope, usage when available and checkpoint/publication references. Missing usage remains unknown.

Do not make SQLite, cached renders, model responses or conversational history the only recovery authority. Store authoritative immutable evidence using the existing encrypted profile publication/recovery conventions, with checksums, schema versions and durable publication receipts. Exact on-disk representation must be reviewed against those conventions in the first implementation slice; do not create an unreviewed parallel vault format.

Publish evidence before marking its projection complete. A crash between durable publication and indexing must rebuild deterministically. A checksum failure or missing authoritative object is an integrity exception, not an invitation to recreate “equivalent” evidence with AI. Search indexes, queues and display projections may be rebuilt from retained objects without a provider call.

### Separate progress dimensions

Expose independent dimensions rather than one boolean `complete`:

- Original: receiving, committed, integrity exception.
- Extraction: pending, active, partial, accounted with exceptions, or accounted with no known extraction gaps.
- Source review: not reviewed, in progress, reviewed with exceptions, or reviewed with no known exceptions, bound to an exact revision and inspected scope.
- Clinical processing: pending, active, waiting for a dependency, proposals available, or accounted with explicit unresolved work.
- Acceptance: unaccepted, partially accepted or accepted for exact proposal versions.
- Execution: runnable, active, waiting for provider, awaiting authorized unlock/worker capability, stopped by user, or blocked by a named exception.

“Accounted” means every enumerated scope has a disposition; it does not prove semantic correctness. “Reviewed” records the person's action; it is not an infallibility certificate. An empty warning queue, model confidence, reader agreement, complete page traversal or a successful HTTP response cannot alone produce a complete-text or complete-clinical claim.

The customer-facing “Done, with exceptions” must list unresolved work and retain useful completed work. It must not present omitted readable text as complete. Full-source review remains available even when no detector flags exist.

### Mutation, stale writes and recovery

Apply review actions with expected source/text revisions and an idempotency key. Identical retries return the original receipt; a reused key with different content or a stale expected revision is rejected with recoverable conflict information. Two tabs cannot silently overwrite each other.

A correction creates a new text revision. Invalidate affected page acknowledgments, review drafts and unaccepted clinical outputs; preserve unaffected acknowledgments where dependencies demonstrably do not change. When dependency coverage is uncertain, conservatively invalidate the affected report's unaccepted interpretation. Never rewrite accepted clinical history. Any change to an accepted record requires a separate reviewable version or correction proposal.

Serialize publication for a source/revision boundary. A late model response for an old revision is retained/accounted as an attempt, but cannot silently replace current text or current proposals. Cancellation and publication must be checked at the same version/operation boundary.

Legacy imports without durable text must show that text is unavailable or not yet extracted. Do not infer completeness from retained originals or accepted findings. Backfill uses explicit authorized work, preserves accepted history and records new evidence revisions. An upgrade must not silently trigger a large provider campaign.

## 6. Batching, context and execution policy

Keep three units separate: physical extraction work, clinical interpretation work and proposal publication. A two-page extraction unit does not have to become one clinical record; a twenty-page clinical context does not justify duplicating twenty page transcriptions into every proposal.

### Initial scheduling policy

Use deterministic, versioned scheduling and one active clinical provider request per profile, subject to existing host-wide capacity controls. Use bounded local extraction workers and preserve UI responsiveness. Start from the existing worker arrangement; a separate processing container or parallel clinical workers require measured need and their own security/interaction review.

For the first vertical slice, retain existing plan defaults as a compatibility fallback rather than installing an unproven ten- or twenty-page default. New clinical units prefer evidenced section/report boundaries within actual request-fit limits. Every source region has one owned target disposition; overlapping context is allowed but must not create duplicate ownership, records or coverage credit. If one physical page exceeds a limit, create located sub-page units with explicit parent coverage, or an exception if that representation cannot be preserved.

Do not skip first/middle/last pages, “administrative” pages, repeated pages or matched re-export fragments. Fingerprints may support exact storage reuse or reconciliation candidates; they are not authority to omit reading, decide clinical identity or collapse differing assertions.

### Request-fit calculation

Before dispatch, assemble the actual proposed request and account for system/tool overhead, selected source text, contextual evidence, images and a reserved output allowance. Use the route's measured capability and counting method. Persist the estimate, method/version, route limits and safety margin; do not treat a character count as exact provider usage.

A request must fit both the route's input/context constraints and its output/media limits. The output reserve must reflect expected proposal volume, not pages alone. When a trustworthy estimator or route limit is unavailable, use a conservatively qualified bounded route or remain explicitly unsupported; never silently truncate text, tools or images.

Pin the resolved limits and policy in the plan. Configuration changes apply to new plans or an explicit versioned replacement of unfinished work, preserving completed tasks and cumulative costs. Do not regenerate saved unit IDs on resume because defaults changed.

### Bounded clinical reading and assembly

Supply owned verbatim source passages, necessary visuals and source-bound report/person/date/header context. Provide bounded navigation to other retained locations and explicit unresolved dependency requests. Carry references to durable prior findings rather than repeatedly resending the entire intake snapshot. A working summary or notebook may help navigation but cannot be cited as original text.

Reconcile across the document before claiming the relevant clinical scope is fully processed. Exercise split tables, later corrections, remote negation/qualifiers, multiple people and repeated events. A missing header or unresolved date relationship remains unresolved; the assembler may not invent it from a convenient nearby record. Preserve all required clinical dispositions independently of full-text retention.

Whole-document clinical reading uses the same evidence, review and accounting contracts. Enable it only where request fit and source-stratum quality have been demonstrated. Until the paired route comparison succeeds, it is an experimental alternative rather than an automatic fallback. If no qualified clinical route fits, retain/extract/review source text and show the clinical limitation explicitly.

### Waits, failures and limits

Preserve the customer requirement that productive imports are not abandoned because of an arbitrary total page or usage allowance. Distinguish per-request memory/context/time bounds and unproductive-loop protection from a terminal job-wide product quota. Keep cumulative accounting across slices and resumes; changing a guard must not erase costs or coverage gaps. Historical experiment token/time caps remain historical experiment controls, not proposed product limits.

Provider quota and transient availability failures become durable waits with classified retry timing and bounded backoff. A known rejected request may be retried under the recorded policy. A timeout/disconnect after dispatch has an unknown outcome until reconciled: do not blindly resend potentially billable work or claim exactly-once upstream execution. Persist attempt identity, recover late completions where the route supports it, and prevent duplicate local publication. An unresolved outcome stays visible and may require intervention; it is not zero cost or a completed unit.

Authentication failures, invalid output, unsupported formats and source integrity errors need distinct handling rather than one retry loop. Stop unproductive repeated reads, attempts without new coverage and recurrent validation failures as named exceptions. Continue independent files where authorized. Retry or user Resume must retain completed evidence and attempt history.

### Background authorization and cancellation

The customer asks imports to continue after tab close, sign-out and profile switching. Current session/key lifetime does not itself prove that capability. CRS-081 is a required design/security gate for that behavior, not permission to retain a general unlocked profile indefinitely.

The intended worker authority is an explicitly authorized, profile-and-job-scoped capability restricted to named sources, necessary evidence writes and the configured provider route. It cannot accept clinical records, browse another profile or inherit broad interactive privileges. Its key handling, revocation, process teardown, export/recovery behavior and sign-out semantics require review before enabling unattended continuation. Do not create a new key wrapping scheme without the existing vault/security review.

Until that capability exists, preserve the current lock boundary and report waiting-for-unlock honestly; the desired background requirement remains unmet. After a crash, resume authorized work after unlock as specified. “Stop imports” prevents new dispatch, requests cancellation, preserves checkpoints and treats any late response through the same stale-version/accounting rules. Stopping is not deletion.

## 7. Source-review experience

Present the original source alongside the current transcript and its alternatives. Begin with useful flagged regions, while allowing neighboring pages and full-source navigation. Confidence, uncovered ink, reader disagreement and structural warnings explain why review is suggested; they do not assert that everything else is correct.

Permit correction anywhere the person is inspecting, including adding omitted text, removing invented text and correcting order or table associations. Highlights are attention cues, not edit fences. Source expansion must be available without dismissing the existing issue. Reuse canonical source coordinates through nondestructive rotate/zoom; non-square rotations, multiple pages and keyboard navigation need real UI tests.

Offer distinct actions:

- **Confirm/correct:** save a source-linked transcription revision and the exact inspected scope.
- **Not text:** classify the source region with a reason; this cannot discard readable text because it is clinically irrelevant.
- **Unreadable:** keep a located exception, retain other readable text and permit a better source or later attempt.
- **Later:** leave the task unfinished without a completion claim.
- **User clarification:** store information supplied from memory or another source with its own provenance; it does not turn illegible source text into extracted wording.

Keep source-text review distinct from accepting clinical records, dismissing a clinical proposal, identity confirmation and changing medication-taking status. Bulk actions must target an explicit current revision and exclude unresolved identity, content and other required questions. A blank warning queue is not bulk approval.

Explain corrections' downstream effects before applying them: affected draft interpretations need rereading or review; already accepted versions stay intact. Save state visibly and recover from navigation, reload and conflicts. Provide a page-level coverage review affordance for confident unflagged errors, without labeling a checkbox a guarantee of perfect transcription.

Group questions by meaningful report/source context, avoid duplicate prompts and preserve unanswered items. Support keyboard use, screen readers, readable zoom and mobile access. Human review must be evaluated for actual discovery, accuracy and fatigue; the perfect-reader experiment does not qualify these behaviors.

## 8. Retrieval, privacy and diagnostics

Search and authorized assistant retrieval use the durable text revision, source locator, identity boundary and review status. Return bounded passages with provenance; do not require a new model reading to retrieve retained text. Uncertain transcription and user clarification must remain distinguishable from accepted clinical facts. A source labeled as another person is not evidence about Self merely because it lives in the current import.

Treat document contents as untrusted data, including instructions embedded in PDFs, HTML, structured fields and OCR output. Imported instructions cannot change routing, access credentials, fetch remote resources, override identity rules or cause acceptance. Keep external lookup prohibitions and profile authorization at the host boundary.

Keep plaintext source content, health terms, names, paths, credentials and raw model output out of general telemetry. Diagnostics should provide counts, phases, redacted failure classes and measured/unknown usage. Optional detailed tracing remains profile-scoped and governed by the existing private diagnostics contract; fictional data is required for public tests and reports.

Measure upload, inventory, extraction, OCR, queue wait, provider-request wall time, reconciliation, review and publication separately. Nested spans are not additive. Record actual input/output/cache counts where supplied; cached input is a subset of input, not an extra charge. Label estimates and unknowns. Report time to first useful reviewable result as well as total accounted work, retries and failures.

Progress estimates use observed comparable work, distinguish provider waiting from active processing and show a range or “Estimating…” when evidence is weak. Do not extrapolate sparse page throughput to dense tables or guarantee linear long-document completion.

## 9. Implementation slices and reviewable completion

Each slice updates the maintained API/storage documentation only when its behavior lands and retains open work-list requirements until their acceptance is demonstrated. Use focused tests during development plus repository formatting/type checks and applicable complete suites before delivery. Do not copy throwaway experimental code wholesale into production.

1. **Contracts and durable text vertical slice.** Select the existing publication mechanism, define shared source/text/review contracts, implement fictional native-text intake → durable text → located retrieval → reload/rebuild. Test failure between publication and projection, stale revision rejection and legacy unavailable-text status. No new provider call is needed for this slice.
2. **Adapter coverage and uncertainty.** Integrate bounded local OCR and mixed-region reconciliation; account for every page/member and preserve alternatives/order/table evidence. Verify source hashes and coordinate transforms. Format support is enabled only with its actual decoder/route tests, not MIME declarations.
3. **Editable source review.** Build original/transcript navigation, correction and exception actions, immutable history and dependency invalidation using existing review components. Exercise actual rendered UI and concurrent tabs. Confirm that text review cannot accept a clinical record.
4. **Clinical work units and reconciliation.** Feed durable text to the existing clinical route through bounded, pinned tasks; add source-bound context retrieval and explicit dependencies. Test output normalization and cross-unit relationships before choosing new batch defaults. Keep whole-document routing experimental until qualified.
5. **Durable scheduling and recovery.** Integrate attempt receipts, waits, idempotent publication, cancellation and meaningful progress. Test late responses, restarts, duplicate delivery, provider windows and unknown outcomes. Do not treat mock transport success as real-provider acceptance.
6. **Background capability and rollout.** Resolve CRS-081 with security review, then test tab close, sign-out, profile switch, lock/revocation, crash/unlock and multiple jobs. Expose only qualified behavior. Roll out source strata and clinical routes incrementally with honest unsupported/exception states.

These are dependency-ordered slices. The owner authorized implementation after the documentation checkpoint. Documentation consolidation remains separate from each code slice and must not remove tests or existing live runtime paths merely because their filenames resemble experiments.

## 10. Acceptance, human review and data-driven changes

### Deterministic implementation checks

Require the following applicable checks before calling a slice complete:

- Byte-exact original/member retention; no lost readable administrative text; explicit unsupported and unreadable scope accounting.
- Literal values, negation, decimal spelling, meaningful order and table relations survive extraction, corrections, retrieval and recovery. Accept equivalent valid representations rather than exact oracle object shapes or arbitrary box padding.
- Correct native/OCR seam ownership, duplicate occurrence handling and source coordinate mapping, including non-square rotations and multi-page sources.
- Profile isolation, patient versus guarantor identity, conflicting and missing identity, stale authorization and retain-only exclusions.
- Source-review actions cannot write accepted records; dismissal does not delete source evidence; medication status and accepted history remain unchanged.
- Expected-revision/idempotency checks, two-tab races, source replacement, corrections during active clinical work and stale late responses.
- Crash after evidence publication but before projection, database loss, missing/corrupt authoritative objects, restart and no-AI reconstruction of retained evidence.
- Bounded requests with no silent truncation; oversized single items; split table headers, remote qualifiers and document-wide dependency accounting.
- Provider rejection versus unknown outcome, retry backoff, quota waiting, user stop, auth failure and retained cumulative costs.
- Accessible rendered review, full-source expansion, save feedback, skip/unreadable/not-text distinctions and no false “complete” from an empty queue.

Use the repository's independently fictional sources and current test patterns. Add fresh adversarial fixtures for a named failure mechanism. Include clean controls and wrong human corrections, not only scripted successful repairs. Checks of mock adapters prove host behavior only; separately qualify the actual route through the application coordinator and supported deployment.

### Fresh source and human qualification

Freeze candidate versions, defaults, corpus strata and endpoints before seeing held-out results. Include native text, scanned text, mixed annotations, multi-column/table layouts, repeated/administrative pages, dense reports, rotated/faint/cropped images and supported structured exports. Test handwriting as its own stratum; do not infer its support from typed fixtures. Keep genuine unreadability distinct from an engine's low confidence.

Independent source review must establish permitted transcription/relationship alternatives and identify unknowable regions. Report original extraction errors, omissions, extras, meaningful relationships, remaining exceptions and document-level outcomes separately. Adjudicate scorer defects without erasing original grades or tuning the candidate on the same held-out result. Do not pool correlated relation pairs or injected copies into a natural-document success rate.

For the real UI, recruit consenting reviewers using fictional documents first. Compare prioritized editable-context review with full-source review on comparable workloads. Measure missed errors, correct and incorrect corrections, false clearance, source-region discovery, completion/abandonment, questions, accessibility problems and actual elapsed review time. Distinguish a participant who cannot decipher the source from a UI that failed to present it. Counterbalance repeated-document exposure or use independent sets so memory does not masquerade as interface quality.

The product owner must approve the supported source strata and acceptable human-work burden before rollout. Predeclare the human-study quality criterion and sample plan; do not invent a favorable cutoff after results arrive. Zero observed errors in a small study is not a universal guarantee. If required behavior is not achievable for a stratum, disclose the technical limit, practical limit, favorable source examples, expected messy inputs and available correction/better-source path. Do not quietly remove the complete-text requirement.

### Changes driven by findings

- **Missed confident or shared errors:** broaden inspected source context or introduce a separately qualified audit signal; retain full-source review. Re-run held-out detection and human discovery checks before narrowing review again.
- **Review fatigue or abandonment:** improve grouping, navigation and question deduplication. Demonstrate that reduced effort does not come from suppressing readable text or unresolved issues.
- **Dense output overflows or cross-unit errors:** reduce owned scope, reserve more output, expand evidenced context or improve reconciliation. Compare complete useful workloads with the same source/quality gates; do not choose a batch solely from request count.
- **Poor first-result latency with adequate quality:** test smaller publication units or pipelining without changing source ownership. Measure total cost and completed quality as well as time to first proposal.
- **Unnecessary OCR or review work:** test an observable eligibility predicate on fresh mixed/annotated controls. Reader agreement or a nonempty text layer alone cannot justify bypassing coverage checks.
- **Repeated reads or growing request history:** inspect source availability, progress ledger and bounded context projections before increasing batch sizes. Preserve evidence references when compacting operational state.
- **UI/API slowdown during local extraction:** measure host/queue time and API responsiveness under Compose limits; follow CRS-109/110 before adding a separate service or worker pool.
- **Real document distribution differs from fictional strata:** with separate owner consent, use local counts-only profiling or a governed evaluation set. Do not silently upload private records or put them in Git. Report unsupported workload rather than claiming a best-case benchmark is representative.
- **Provider/model changes:** invalidate relevant capability/quality qualification, retain existing plan provenance and test the new route. Do not retroactively relabel historical measurements or unknown costs.

Record each change as a decision with its triggering evidence, expected benefit, affected contract and predeclared check. A component pass does not establish a composed-route pass. No weighted speed/cost score may conceal an original-loss, wrong-person, unsupported clinical assertion or authorization failure.

## 11. Review questions that must remain visible

Before approving implementation details, reviewers should resolve or explicitly retain:

- Does the durable representation preserve all required text and relationships across SQLite loss, and can the assistant retrieve it without AI rereading?
- Is every completion label about source accounting, inspected text, clinical processing or acceptance unambiguous? Could unknown content disappear behind “Done”?
- Are editable source scope and displayed context aligned in the real UI, with full-source expansion and sufficient relation-editing controls?
- Is the chosen OCR/decoder actually available and bounded in Compose? Which source strata remain unqualified?
- What exact request-fit counting method, output reserve and margin will the first qualified route use? Are those parameters explicit and versioned before provider tests?
- Can section/report boundaries and remote dependencies be preserved with the chosen unit policy? Is any page being skipped through relevance or fingerprint logic?
- Can a correction or late response race acceptance, resume or a second tab? Is conservative invalidation sufficient when dependencies are incomplete?
- Does the background design satisfy session/key revocation rules and the customer's continuation expectation? If not, is that requirement still visibly open rather than claimed complete?
- Are provider usage and uncertain attempt outcomes fully accounted? Are apparent performance improvements actually omissions, stopped runs, reduced review scope or unpriced work?
- Are whole-document versus bounded clinical routes compared with equivalent source support and output semantics, rather than whichever object shape the scorer prefers?
- Are the real-human burden and source-quality limitations understandable to the person, including better-source requests and external clarification provenance?

These questions are implementation/release review work. This specification does not answer unknowns by commissioning an unbounded experiment matrix, silently selecting new provider budgets or extending prior stopped campaigns.

## 12. Evidence references and later documentation cleanup

The implementation rationale above is self-contained. Detailed experiment recordings remain historical evidence; they need not all remain in the final working tree. **No files are deleted by this specification commit.**

Tracked historical evidence is retrievable at the inspected baseline:

- [Original experiment briefs and results](https://github.com/mxbaylee/circus-health/blob/d312320e378666c60a98c82d7683d96bf1981581/docs/processing-experiments.md).
- [Follow-up experiments and verification](https://github.com/mxbaylee/circus-health/blob/d312320e378666c60a98c82d7683d96bf1981581/docs/processing-follow-up-experiments.md).
- [Measured and extrapolated batch results](https://github.com/mxbaylee/circus-health/blob/d312320e378666c60a98c82d7683d96bf1981581/docs/processing-extrapolated-results.md).

These baseline references do not preserve later uncommitted edits or newly created documents. In particular, the composed and detector-study reports require their own reviewed documentary checkpoint before deletion. Their filenames below identify the source material; until archived, they are not promised as durable Git-history links.

Candidate temporary documents for a later cleanup are:

- `processing-context-proposal.md`
- `processing-experiments.md`
- `processing-follow-up-experiments.md`
- `processing-extrapolated-results.md`
- `processing-ocr-follow-up-strata.md`
- `import-processing-design-review.md`
- `import-processing-test-plan.md`
- `import-processing-practical-strategy.md`
- `import-processing-detection-experiments.md`
- `composed-import-experiment-results.md`

The later cleanup procedure is:

1. Inventory tracked, modified and untracked candidates; preserve original and partial findings, independent reviews and evidence limitations. Review portable reports for private paths/content before committing them. Do not add raw logs, health records, credentials, screenshots or runtime databases.
2. Commit the portable documentary checkpoint and retain an archive reference that will survive feature-branch deletion and the repository's squash-merge workflow. A commit that exists only on a later-deleted feature branch is insufficient. Verify each referenced path using the archived revision before deletion; record the real immutable revision here rather than a placeholder or assumed commit.
3. Carry every enduring requirement and unresolved release condition into its maintained contract or existing CRS work-list entry. Preserve failed/unattempted distinctions; document removal does not make a requirement complete.
4. Replace live links from the documentation index, work list and maintained contracts with this spec or exact archived evidence references. Delete only superseded temporary documents after this mapping is verified. Maintain the customer use cases and security/storage/API contracts unless separately consolidating them without loss of requirements.
5. Check links, formatting and references, and review the staged deletion list. Do not remove production code, reusable tests, opt-in checks, migrations or runtime tools as incidental documentation cleanup. Any later dead-code cleanup requires its own reachability evidence and checks.

The original documentation-only checkpoint preceded the subsequently authorized implementation. Evidence archival/deletion, new live provider experiments, publishing and merging remain separate actions.

### Integrated source review: bounded capture and issue lists

Import batches perform one local source-capture operation (at most two pages or text sections) before starting a new clinical conversion. Pending source pages do not require waiting for whole-document OCR before useful clinical work. Model-owned source reads can continue local capture. A terminal conversion with no retained proposal can drain additional local steps, subject to a provisional automatic allowance of ten total steps and 120 seconds of cumulative extraction time. These are admission ceilings: an already admitted operation retains its existing worker timeout and may finish after the time ceiling. Initial capture counts against the same allowance. The batch journal retains step count, elapsed time, outstanding operation identity and allowance boundaries across restart. Explicit source continuation grants a new allowance while retaining cumulative accounting; reload does not. A cap or unresolved operation leaves the file needing source review and allows unrelated files to continue.

Existing reviewable or accepted interpretations are checked before starting local capture. Automatic terminal capture does not revise source text beneath an existing proposal: remaining source capture stays incomplete and visible for explicit continuation/reinterpretation. This deliberately preserves existing global proposal/source revision gates. An extraction pass never attests human inspection or 100% detection of missed text. Protected human-reviewed pages remain unchanged. A failed PDF inventory retains a file-level operation exception with unknown page count; no synthetic page is invented.

The profile-authorized `GET /intakes/:id/source-issues` returns at most 50 unresolved issue projections, with each explanation limited to 1,200 characters. New source revisions retain an immutable issue index in the encrypted journal, allowing the feed to fetch counts and issue chunks without loading all retained page text. Legacy revisions are scanned one page blob at a time without mutating evidence on GET. `offset`/`limit` pagination requires the current `revisionId` after the first page; stale pagination is rejected. Page-only coverage and structure caveats are classified as “not inspected,” distinct from located reader disagreement, low confidence, ink/coverage mismatches and processing failures. Resolved issues are excluded; unreadable/deferred exceptions remain visible. A failed inventory is separately exposed as `extractionFailure` with file scope and a bounded reason code.

The same response includes independently labeled `readerCoverage`: active-plan pending/partial units and reader coverage notes, including context-only or unreadable observations when there are zero clinical records. `readerOffset`/`readerLimit` (maximum 50) uses exact `readerVersion` pagination; notes are bounded to 1,200 characters, locators to 240 characters and page lists to 20 entries with explicit truncation. A unit’s prior coverage is explicitly marked stale when its corresponding proposal no longer matches current source-text dependency pins; old observations stay inspectable and are excluded from current unreadable/context counts. Reader coverage is not OCR evidence, human inspection or an accuracy/completeness certificate. Its source plan remains the authority. The full source-text revision is fetched for compact section previews and by the full page editor; the bounded feed index does not yet make every editing operation independent of whole-revision size.

The defaults above remain provisional. Representative document evaluation, detector miss rates, multicolumn/table fidelity, human review usability and bounded editing at large-document scale remain open requirements. Fictional regressions verify zero-proposal local draining, allowance persistence and unrelated-file progress, file-level inventory failures, context-only reader observations, 800-page issue pagination and encrypted cache-loss recovery.

### Focused record corrections

Pending records open a compact inline correction view: the original at its evidenced page, **Update**, and **Close review**. Test results always expose Test name, Result, Unit and Date, plus any additional explicitly scoped correction fields; an optional date warning must never hide a missing result. Other record kinds show their scoped correction fields or primary field. Report person/source settings remain in their report controls. Typing does not persist a correction. Update writes the existing exact-version review draft and field-scoped issue resolutions, then returns to the table; it never accepts a clinical record or confirms identity. Blank fields are omitted from partial updates and remain unresolved; incomplete numeric readings cannot be submitted. Update can save one verified field while other fields remain blank. A record with remaining blocking uncertainties cannot be confirmed or accepted. Other unresolved blockers remain authoritative, and stale-source/conflict checks still apply. Close review discards unsent inputs; failed updates remain visible for retry. Accepted-record correction retains its existing separate workflow.

For legacy evidence without a page fragment, one unambiguous page mention attached to the same authorized original is a navigation hint. Conflicting or foreign-original hints do not select a page; out-of-range pages retain an explicit fallback notice. Page navigation does not establish region geometry, so the UI does not draw an invented highlight. The compact preview omits extracted-text controls; transcription review remains available through the report's source issues. Missing observation values display **Value to review**, never the report status such as `final`.


### Import review corrections — 2026-09-27

Clinical Review and Open review use the same inline accordion. Report ownership and source changes stay in the compact report-header sidebar. The standalone clinical review page is no longer an import navigation destination; historical record links select the matching row in the import view. Value correction drafts can be saved while report ownership remains unresolved; clinical acceptance still requires ownership and every blocking field to be resolved. Failed draft saves offer an explicit discard-and-close path.

The source pill displays the report label and Change, with no unapplied-suggestion warning. A source suggestion from the exact linked, non-mixed report context is the default for its member records when accepted; explicit source choices take precedence. The original acquisition source and issuer are unchanged. Accepted provenance distinguishes a derived default (suggested_report_label) from a human source confirmation. Existing accepted versions are not relabeled retroactively. Saved test results show Modified during import when a retained record correction exists.

Unique grounded saved-name matches (including Doe, Cookie versus Cookie Doe) with compatible or absent DOB permit acceptance without another ownership question. A report with a differing evidenced DOB cannot be confirmed as Self; its sidebar defaults to adding another person. A matching DOB with an unfamiliar name allows explicit Self confirmation, retaining that alias. Missing DOB preselects Self, with another-person selection available; an unfamiliar name still requires that explicit ownership decision. Shared names, contradictory source identity and ungrounded evidence require review. Correcting a test value never answers an ownership question.

### First-upload report identity grouping

Separate extraction groups at the same report anchor are not themselves conflicting patient evidence. A context-only header with no printed subject, identical subject text at different locators, canonical-equivalent name ordering, and self/unknown role tags do not invalidate neighboring groups. Differing printed subject claims within the same original/member/report remain conflicts. This is a read-time policy for retained proposals; originals, group IDs, accepted versions and confirmation receipts are unchanged. Each group still requires its own original grounding or exact human receipt. Confirming one group never assigns a separately proposed other-person group.

The regression starts with a new profile and its first fictional original, publishes one proposal containing a header and two results in separate groups, grounds identity and accepts the records. It requires neither earlier uploads nor model compaction. Identity blocker actions open the report person sidebar, while value blockers open the inline correction. When no valid identity decision scope exists, the sidebar explains that editing a result cannot repair processing's identity conflict; it does not offer a value update as approval.


### Import field correction validation and reasons

Missing required fields and unresolved readings are highlighted independently. Unknown dates remain optional; do not infer a result's date solely from another row. Calendar dates use a picker and the same calendar validation as the server; existing year/month/timestamp precision is preserved. Updating a supplied field or explicitly verifying its existing reading resolves only that field. Blank fields are omitted from a partial update, untouched suggestions remain unconfirmed, and clinical acceptance still validates the complete record.

A changed field requires an editable correction reason in the inline form, initially “Correction of imported data.” The host retains each supplied reason with the exact operation, timestamp and before/after changed fields on the version-bound draft, and carries that history into accepted record provenance. Replays do not duplicate entries. Test result details display the retained reasons. Legacy draft callers may omit the new optional reason field; no reasons are invented retroactively for older edits.


### Review type recovery and successful-save cleanup

The compact and full field editors share one mapping-field definition. Every compact editor keeps its primary content fields visible alongside scoped warnings; a date warning never replaces the main content. The Record type control allows an explicit, reasoned draft correction of a document or unclassified proposal into a test result before acceptance. Changing type does not create a clinical record or supply missing measurements. A clearly identifiable lab row with an unreadable value should be proposed as an observation with an empty value and a field-specific uncertainty, not downgraded solely because that field is unknown.

The row action is Review. A confirmed successful save removes the entire row and open accordion, including while the displayed feed is catching up. A failed or uncertain save retains the editor; ordinary background removal of a superseded version still preserves unfinished edits for conflict review.

Diagnostics downloads include at most 50 deduplicated reviewEditors snapshots: record/mapping/editor kind, visible field keys, missing-name/result/unit flags, date precision/validity, and issue kind/field/blocking/resolved metadata. Enum allowlists exclude arbitrary model strings, medical values, dates, names, filenames and prompt text. These snapshots are in-memory observations, not acceptance authority; older exports cannot be backfilled.

### Visible correction provenance

Test results distinguish **Modified during import** from **Corrected after import** with pills beside the record name. A record edited at both stages shows one **Corrections** pill; the history still distinguishes both stages. Correction history displays the retained field-level before/after values and each reason in result details and under the chart's Recorded values. Those edits are versions of the same measurement, not extra chart observations. Empty original readings display as “Not recorded.” Legacy edit flags without retained before/after evidence still show the indicator; the UI does not invent missing history. Originals remain unchanged.

### Early reading estimates and coverage reconciliation

The reading UI replaces indefinite “Calculating remaining time” with a **Rough estimate** after 15 seconds of active work once the current plan size is known. This is an explicit provisional heuristic, not a calibrated confidence interval: elapsed active time and accounted sections inform pace; read windows receive half-weight because reading alone does not finish extraction. The remaining-work estimate has a threefold uncertainty range and a 30-second minimum; it updates as work proceeds and may increase. Page-render time is never treated as model throughput. Multi-file queues label the estimate for the current file only. Provider/capacity waits retain their actionable status instead, and fully accounted plans say “Finishing up.” Page density and large packages still require future empirical calibration.

If a model turn ends without progress after reading all known windows and retaining candidates, but units remain unaccounted, the host allows one directed coverage-reconciliation turn within the same authorized run. This retains every time, token, version, source and acceptance guard. It requests missing records or an evidence-supported disposition; it never declares coverage itself. A second unproductive turn pauses honestly. The bounded recovery is included as `reconcile_coverage` in metadata diagnostics. A completed, fully accounted run is not mislabeled stalled merely because its last turn added no new records.

### Inline related-record review

The compact record accordion retains a collapsed related-record section for comparing a proposed record with saved evidence and correcting a saved counterpart. Unresolved relationship decisions can open it for attention. It shares its editor with compatibility review rendering, rather than depending on the retired standalone navigation. Unsaved field edits disable relationship actions until updated or closed. A correction to a saved counterpart does not accept or change the incoming proposal.

### Source attention and identity follow-up — 2026-09-28

Import includes a **Needs attention** tab alongside record kinds, even for sources with no clinical proposals. It displays compact page-section rows with retained text previews and a per-file count of unreviewed sections. **Review** opens the original at that page beside editable transcription; **Approve section**, or the shared **Select all shown → Approve text sections** action, explicitly trusts unchanged OCR. Text approval never accepts clinical records or claims that all clinical information was extracted. Approval removes resolved rows. Unreadable, unsupported, empty and pending-extraction sections cannot be bulk approved. Advanced source actions and **Add a missing clinical record** remain available inside review. Bulk operations serialize exact-revision writes, stop on conflicts and retain partial successes; they never silently retry against changed text. Original files are paginated separately. The row count represents page sections, not flagged words or missed records.

Unchanged-text confirmation writes a durable inspection receipt but preserves the material source dependency and intake version. It does not stale proposals or restart an active model response. Actual transcription edits, clarification, dispositions and explicit unreadability resolution still invalidate interpretation. A text update remains separate from section approval and clinical acceptance. The full source editor and reader observations remain available through Sources. Calibrated missed-record detection remains future work.

Sources no longer has a second original-file inventory or “New Import Source” banner. Its selected file retains the compact source review controls beside the original viewer. Dirty-source guards also apply when switching Import tabs.

Identity review derives labelled DOB facts directly from the retained original near the exact printed subject/report header, independently of model-generated identity questions. These facts participate in the chooser, confirmation and final acceptance policy. Unambiguous labelled dates are compared with Self; conflicting or ambiguous dates are not guessed. Neighboring patient/relative headers bound discovery. Facts are an ephemeral, bounded cache keyed to original bytes, member and printed report/subject scope; candidate growth does not erase them, while changed evidence and cold restarts require re-reading. A legacy confirmation without a DOB cannot bypass that recheck. This is not a universal DOB extractor: unsupported layouts, birthdays outside the scoped header and image-only originals remain limitations. Already accepted records are not silently reassigned.

Default Self collection navigation does not briefly render an ownership-check banner merely to normalize the URL. Actual unresolved record ownership still hides clinical content until it is verified.


### Attention queue counts and completion

Import displays unresolved source sections in both All and Needs attention. The attention badge counts distinct page sections across visible retained originals and package members; All includes these sections in addition to clinical records. Section counts come from durable source indexes, including compatible read-only fallback for older revisions, rather than counting only the current file page. Uncaptured originals have no identified source sections yet and remain available in Sources. Completed originals are excluded before pagination. One shared Select all shown control covers loaded clinical rows and approvable source sections in the active tab, across the displayed files; hidden tabs and unloaded pages are excluded. The selected count and indeterminate state include both kinds of item, with separate actions for clinical saves and transcription approvals. A file disappears when its final section is resolved. The attention tab disappears at zero, and an emptied attention or clinical-kind tab returns to All in the same review-status view after pending edits/saves are resolved. This redirect requires settled results for the requested filters: a loading feed is not treated as empty.
