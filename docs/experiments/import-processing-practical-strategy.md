# Import processing: practical targets and human-assisted completion

Owner direction, 2026-09-26: consider practical limits and human augmentation without erasing the complete-text goal or historical failures. This is a prospective qualification framework and candidate workflow, not an implemented feature, a new experiment result or a list of approved requirement removals. It incorporates an independent feasibility assessment and is subject to separate review.

Read it alongside the [customer specification](../todo/CRS-126.md), [composed design](import-processing-design-review.md), [original test plan](import-processing-test-plan.md) and [execution results](composed-import-experiment-results.md). [CRS-115](../todo/CRS-115.md) remains open. No private user documents were inspected for this assessment. The realistic source descriptions below are expected classes, not claims about documents this owner supplied.

## Main finding

A practical composed importer remains plausible. Preserve evidence and permission invariants, qualify useful automatic routes on declared source strata, and expose unresolved text or clinical associations. What should be shelved is an unconditional promise of perfect automatic understanding of arbitrary uploads—not the complete/accurate text outcome aim, the obligation to retain originals, account for pages, keep readable partial work, or support correction. Deferring a universal automatic guarantee or narrowing rollout scope must not quietly drop a current customer outcome. Failed native/OCR/table prototypes establish limitations of those frozen variants on their tested inputs. They do not establish that a strategy family, visual model, human-assisted process or future composition is impossible.

The owner's human-augmentation direction is a first-class composed candidate: highlight unextracted or possibly useful regions, provide nondestructive rotate/zoom and neighboring/whole-page context, and let the person confirm, correct or type text. Distinguish “not text,” “unreadable,” and “later” from dismissing a clinical proposal. Skipping or deferring readable text cannot produce a silent complete status. Retain the machine version, the source-linked human revision and correction history; invalidate/re-review dependent clinical interpretations without overwriting accepted history. Region highlights alone miss confident unflagged errors, so the candidate also needs a whole-page coverage review affordance. This relaxes the fully automatic goal while keeping the complete/accurate outcome aim, without promising infallible human review. Scripted corrections can test mechanics; real human review of independently fictional sources is needed to measure discovery of errors and actual effort.

Three distinct categories must stay separate:

1. **Hard evidence, security and recovery invariants:** byte-exact originals after acknowledged commit; profile/session authorization; retain-only exclusions; no terminology leakage to lookup services; source-bound immutable text/proposal/accepted revisions; approval before acceptance; no destructive merge (reversible equivalence links and context reuse remain allowed); source-text review never changes medication taking status, which remains subject to the separate specified medication actions and approval; idempotent local publication; honest missing/corrupt-evidence reporting; recovery from durable evidence without AI reconstruction. These are architectural correctness obligations within a declared storage/fault model. Failure cannot be bought off with faster extraction or higher average recall.
2. **Bounded measurable automation goals:** literal retention and layout fidelity on specified document strata, clinical assertion/relationship recall, correct identity/date handling, useful reviewable output, unnecessary uncertainty, user repair effort, supported routing/fallbacks, authorized background continuation and measured resource consumption. These can receive scoped evidence and explicit limits. Passing a small fictional corpus does not certify an unseen upload.
3. **Universal claims that current evidence cannot substantiate:** every readable word or relationship from every arbitrary document, zero identity errors solely from printed attributes, certain recovery of missing/illegible information, guaranteed eventual completion under any provider outage, unlimited feasible work on finite resources, or recovery after loss of every authoritative copy. Some are impossible because information or resources are absent; others are merely unproven or not yet implemented. Do not label them all “impossible.”

Hard invariants do not guarantee the truth of the source or the correctness of every human-approved record. The system can enforce provenance and explicit approval; approval is not an infallible clinical verifier.

## Proposed source-review workflow

This is source-text review, distinct from accepting a clinical proposal. The person can open a highlighted region with neighboring and whole-page context, rotate or zoom the view, and confirm, correct or type a transcription. View transforms leave original bytes and canonical page/region coordinates unchanged. Retain the original machine output as unverified evidence; a correction creates a new source-bound revision and an attributable review event.

The actions have deliberately different meanings:

- **Confirm or correct text:** records the supplied wording and the exact source/revision reviewed. It is a human-reviewed transcription, not a universal correctness certificate.
- **Not text:** records an explicit region classification and reason while retaining the original. This is not a way to discard readable administrative text as irrelevant.
- **Unreadable:** records the located exception and permits a better scan or later retry. It does not fill the gap with a guess.
- **Later or skip:** preserves unfinished work and its source location. It cannot silently advance text to complete. Dismissing a clinical proposal is a separate decision.

A page-level coverage review is necessary alongside flagged crops: confident OCR errors and entirely missed regions may have no warning. Page acknowledgments and region actions bind to a text/source revision. A relevant edit invalidates stale acknowledgments and dependent draft interpretations; already accepted history remains unchanged and any proposed update receives its own review.

Distinguish transcription from additional information. If the person can read the source, their correction is a source-linked human transcription. If they supply something remembered or learned elsewhere because the source is unreadable or cropped, retain it as a separate user clarification with its own provenance; it does not make the missing source text extracted. A better image may resolve the original exception later.

Keep workflow state separate from accuracy: open, reviewed with exceptions and reviewed with no known exceptions describe recorded actions and outstanding work. They do not assert that no reviewer could have missed an error. A completed review can still leave the extraction incomplete. Independent source scoring measures actual correctness on test fixtures.

A prospective comparison should use the same frozen machine output with and without the augmentation workflow. Scripted corrections can test persistence, provenance, routing, revision invalidation and whether intended edits recover fixture content. They cannot estimate real human error detection, transcription accuracy, time, accessibility or fatigue. Those require people using independently fictional documents in a separate usability study. No real health records or a claim of human infallibility is required.

## Limit register: claims to constrain, not removed requirements

Each item below is a prospective limitation/deferral proposal. It does not silently change the specification or declare any existing criterion passed. Best-case inputs describe favorable conditions only; users must still be able to submit ordinary messy inputs and receive preserved evidence plus a truthful outcome.

### 1. Universal exact automatic text, handwriting and layout recovery (P17)

**Proposed disposition:** Defer an unconditional fully automatic guarantee. Retain complete durable text as the outcome aim, with explicit incomplete states and human-assisted completion.

- **Technical limit:** An engine cannot uniquely reconstruct information absent from the supplied bytes/pixels. Ambiguous glyphs, cropped words and irretrievably obscured text have multiple compatible readings. That is different from a legible phrase or continued-table relationship that the present adapter simply missed; the latter is a tool limitation, not impossibility. Complete automatic fidelity across all readable documents is unsubstantiated.
- **Practical limit:** Arbitrary handwriting, faint photographs, unfamiliar table schemas, marginal notes and cross-page continuation defeat simple confidence/geometry/phrase heuristics. Per-region verification and correction consume user effort; two engines agreeing can share the same error.
- **Best-case documents hoped for:** Full-resolution native PDFs with accurate text layers, clear annotations, explicit table headers, intact pages; clean scans and plainly legible notes.
- **Realistic documents expected:** Mixed native/scanned portal downloads, phone photos, fax artifacts, rotated/cropped pages, unfamiliar abbreviations, repeated footers, imperfect handwriting and partly missing pages. These are expected source classes, not observations of this user's records.
- **Fallback:** Keep exact originals and located partial text; preserve explicit uncertainty and history; use only independently qualified alternate readers; otherwise expose unresolved regions and offer the owner-proposed rotate/zoom/type/confirm/correct workflow, retry or a new image. Provide whole-page checking for unflagged omissions/confident mistakes. “Not text,” unreadable and deferred outcomes remain distinct; dismissal never converts unextracted readable content to complete. “Read it anyway” starts an attempt, not a promise of recovered words. Do not fabricate transcription from clinical plausibility.
- **Revisit criterion:** A frozen materially different extractor/route passes fresh independently authored strata, including genuine fictional handwritten samples rather than fonts, all required order/table relations and invented-text checks. A human-assisted composition additionally needs human testing of error discovery, remaining error, completion, accessibility and correction burden; scripted correction tests establish revision/invalidation mechanics only. This supports those strata, never a universal guarantee.

### 2. Automatic exhaustive clinical interpretation and every distant relationship

**Proposed disposition:** Qualify bounded automatic and human-assisted interpretation. Do not lower the requirement for source support or reviewed acceptance.

- **Technical limit:** When subject, event, specimen, date or qualifier association is absent or genuinely ambiguous, source evidence does not identify one correct interpretation. Where the association is present, failures of attention/context assembly are implementation limitations. Neither all words retained nor all pages dispatched proves all clinical meaning extracted.
- **Practical limit:** Long re-exports mix dates, amended findings, medication history, negatives and different people. Whole-document and bounded readers each have plausible failure modes; there is currently no completed W/B clinical comparison in this investigation.
- **Best-case documents hoped for:** One clearly identified person/event per report, full dates, explicit amendments, stable headers and unambiguous findings.
- **Realistic documents expected:** Multi-encounter packets, sparse actionable facts amid repeated material, remote footnotes, imported prior results, incomplete dates and corrections without clean event identifiers.
- **Fallback:** Retain all available source text; propose supported assertions; keep unresolved associations out of bulk approval; offer focused questions, correction and bounded reprocessing. Alternate context readers require their own qualification. Do not substitute summary retention or “no findings” for unread scope.
- **Revisit criterion:** Fresh relationship-challenge and end-to-end fixtures demonstrate useful source-supported recall, no unsafe escaped assertions, meaningful page disposition, and acceptable user repair effort under predeclared product actions. Clinical-ready may differ from text-ready; partial useful output is not full clinical completeness.

### 3. Guaranteed person identity from printed name/DOB and universal pre-AI screening

**Proposed disposition:** Retain the specified identity policy and its confirmation boundaries. Do not describe matching printed attributes as certain real-world authentication.

- **Technical limit:** Name/DOB is evidence, not a unique authentication secret: two people can share those attributes, a source can misprint them, and unlabeled/absent identity cannot establish ownership. For image-only input, reading identity itself requires some image interpretation; “before any AI” and “AI reads the only available identity” cannot both hold if no adequate local reader exists.
- **Practical limit:** Guarantor/parent DOB, scope changes within a packet, missing identifiers and mistaken source labels complicate early screening. The specification deliberately allows matching-name/no-DOB passage; that policy cannot simultaneously prove correct identity universally.
- **Best-case documents hoped for:** Correct, explicit patient labels with matching full DOB/name on every report and distinct section boundaries.
- **Realistic documents expected:** Unlabeled personal notes/photos, cropped headers, alias names, multiple family members, policyholder sections and inconsistent cover sheets.
- **Fallback:** Enforce early mismatch stop where available evidence supports it; restrict image identity work to the declared preflight boundary; mark unknown subject scope explicitly; require confirmation where specified and preserve other-person reference material separately. Full DOB is a helpful source condition, not a new prerequisite overriding the existing matching-name/no-DOB policy. “Read it anyway” never grants Self attribution.
- **Revisit criterion:** Product policy explicitly defines uncertain/mixed identity handling and approved name-only risk; candidate and application tests cover role confusion, later scope changes and cross-profile access. No finite identity corpus establishes perfect real-world identification.

### 4. Background work through sign-out/profile switch while preserving lock guarantees

**Proposed disposition:** Retain the background-processing outcome as open implementation work. Defer rollout until the authorization design is verified; do not label it technically impossible.

- **Technical limit:** Private work cannot simultaneously require a key that was destroyed on lock and continue decrypting afterward. A separately authorized, narrowly scoped background capability can resolve this design conflict; it is not information-theoretically impossible.
- **Practical limit:** Current tests explicitly expect `profile_locked` pauses. Safely introducing key lifetime, revocation, job scope and restart semantics requires security design and integrated testing; an unencrypted prototype with profile IDs supplies none of this proof.
- **Best-case documents hoped for:** Small supported jobs finish before a user leaves, with clear identity and few retries.
- **Realistic documents expected:** Large heterogeneous uploads still in flight when a user closes a tab, changes profile or restarts a computer; input quality affects duration but does not justify weakening security.
- **Fallback:** Preserve current lock/pause behavior and durable progress until reviewed background authorization exists; describe the limitation honestly. Never keep broad interactive access alive just to satisfy continuation. After process loss, require authorized unlock before resuming private work.
- **Revisit criterion:** CRS-081 decision plus application-level capability/isolation/revocation, Stop-race, restart and cross-profile tests. This is a deferrable implementation/security change, not an unattainable requirement.

### 5. No self-imposed limits and guaranteed provider recovery/finish

**Proposed disposition:** Retain durable waiting and resumability under stated availability assumptions. Do not promise finite completion through permanent external failure.

- **Technical limit:** Finite memory/storage/compute cannot handle unbounded concurrent work without admission/queue mechanisms. A permanently unavailable service, revoked credentials or exhausted external allocation cannot be made to succeed by retrying. Guaranteed finite completion is impossible without availability assumptions; a lack of arbitrary product usage caps is a different, potentially feasible policy.
- **Practical limit:** Retry storms, persistent invalid input and bills grow without improving evidence. Provider quota waiting, quality fallback exhaustion, authentication faults and user Stop need different states. Experimental budget stops are not product caps and should remain separate.
- **Best-case documents hoped for:** Modest clean packets whose finite work fits known resource/route capacity and whose provider waits resolve.
- **Realistic documents expected:** Hundreds of variable-density pages, repeated re-exports, large archives, isolated malformed members and intermittent or prolonged provider limits.
- **Fallback:** Durable queued/waiting states with backoff, bounded per-request resources and truthful capacity exceptions; user-resumable quality exceptions; non-promissory wait-aware estimates. Do not mark a quota wait as a content failure or repeatedly charge for a known-unsuccessful quality path. Preserve accounting uncertainty and do not silently reset an experimental allowance.
- **Revisit criterion:** Explicit availability/capacity policy distinguishes safety resource bounds from user usage caps, with wait/retry/Stop and exhausted-path tests plus representative workload measurements. Any latency promise must state its conditions.

### 6. “Interruptions lose nothing” under arbitrary failure and exactly-once provider work

**Proposed disposition:** Retain recovery from acknowledged durable evidence under a declared fault model. Do not promise recovery after loss of every authoritative copy or exactly-once remote execution without support.

- **Technical limit:** Recovery cannot reconstruct authoritative evidence when every durable copy is destroyed. After an upstream request is dispatched but acknowledgement/response is lost, the client cannot always determine completion or cost without provider cooperation/durable capture. Exactly-once local accepted publication is separate from exactly-once remote execution.
- **Practical limit:** Crash windows, partial filesystem publication, disk loss, response loss and capture-service failure require different fault models. The eight durable-text checks and ten mock transport checks do not cover every scheduler, encryption or power-loss case.
- **Best-case documents hoped for:** Fully uploaded valid files and small deterministic jobs with complete provider receipts.
- **Realistic documents expected:** Large uploads interrupted midway, flaky connections, long responses, restart between publication and acknowledgement and damaged/missing local artifacts; document content does not remove these faults.
- **Fallback:** Atomic acknowledged commits; immutable artifacts and receipts; rebuildable indexes; idempotent local revisions; detect corruption/missing authority; preserve unknown remote state/cost rather than redispatching blindly. Make backup/recovery assumptions explicit without treating a cache as authority.
- **Revisit criterion:** Declared fault model with integrated crash/restart/acknowledgement-gap tests and restoration from retained originals/accepted history/text. Do not promote a mock replay result into recovery from total durable-copy loss.

### 7. Automatic standard terminology, duplicate and correction resolution for every entry

**Proposed disposition:** Retain supported local mappings and reversible review. Defer unsupported automatic ambiguity resolution; never discard the printed source to make a match.

- **Technical limit:** Equal dates/values and similar names do not uniquely identify the same source event or clinical concept. Missing event identity or issuance order cannot be reconstructed with certainty. A vocabulary entry's existence does not prove the printed term means that entry.
- **Practical limit:** Ambiguous abbreviations, supplements, compound medications, differing specimen/method, rounding and unclear correction dates require user or source clarification. Coverage of bundled terminology and checked conversions is a tooling/product boundary.
- **Best-case documents hoped for:** Explicit valid codes, unique event IDs, complete units/specimen/method and clear issuance/amendment dates.
- **Realistic documents expected:** Local abbreviations, brands/free text, source-specific codes, truncated export columns, equal-valued distinct events and corrections without explicit links.
- **Fallback:** Preserve printed terms/values; use approved local mappings and conversions only; offer reversible equivalence decisions; link possible matches without destructive collapse; route ambiguous changes to side-by-side review. Preserve medication history without changing taking status.
- **Revisit criterion:** Fresh ambiguity/false-match fixtures and required source fields establish a narrower deterministic or reviewed mapping route; source event and correction policies explicitly cover missing evidence. Do not demand standardized exports as an admission prerequisite.

### 8. Structured exports, mixed-person archives and imaging-report packages

**Proposed disposition:** Qualify explicit formats and adapters incrementally. Unknown formats remain visible unsupported work; this is not a reason to discard the archive or reject all mixed input.

- **Technical limit:** These families are not inherently unattainable. Their unspecified schemas, extensions and person/member relationships make a blanket support claim undefined. An opaque unsupported object cannot be promised a lossless semantic parser before its format is known.
- **Practical limit:** Nested/broken archives, external references, unknown export fields, multiple patients and imaging/report linkage need explicit dispositions. Retain-only imaging/audio/video exclusions remain binding even when a parser fails.
- **Best-case documents hoped for:** Recognized well-formed export versions, self-contained members and explicit patient/report references.
- **Realistic documents expected:** Vendor-specific extensions, partial exports, duplicated filenames, broken references, mixed families and reports bundled with large noninterpretable media. These are design expectations, not tested private samples.
- **Fallback:** Retain archive and source/member identity; deterministic parsing only for declared supported schemas; preserve unknown content and readable narratives; isolate malformed members and other-person scope; keep prohibited media out of AI. Present unsupported members without losing the original.
- **Revisit criterion:** Write the missing scenarios/contracts first, then independently fictional format/version/member fixtures and routing/seam checks, including unknown fields and mixed identity. This is contract and adapter work, not evidence to abandon the composition.

### 9. Minimal questions/bulk review without a user ever approving an error

**Proposed disposition:** Include human review as part of the composed strategy and measure its effort and effectiveness. Approval is a recorded action, not a guarantee of infallibility.

- **Technical limit:** When source evidence cannot resolve a necessary date/identity/value, correctness and zero clarification cannot both be promised. Explicit human approval cannot guarantee the human noticed every error.
- **Practical limit:** A workflow that marks everything uncertain protects against automatic acceptance but imposes unreasonable review work. The exact bulk-review layout and late-amendment interaction are not established by extractor quality tests.
- **Best-case documents hoped for:** Complete unambiguous dates/identity, stable events and recognizable names with few conflicts.
- **Realistic documents expected:** Missing dates, inferred first-of-period proposals, contradictory sources and later pages changing already reviewed evidence.
- **Fallback:** Group questions, exclude unresolved/conflicting items from bulk action, bind approval to a revision, show the source and changed evidence, preserve accepted history. Preserve the current partial-date policy: propose the first day of the printed period with printed precision visible for approval; never demand complete dates in every source or silently infer a century. Keep the current default layout until comparative usability evidence exists; do not silently infer answers to reduce clicks.
- **Revisit criterion:** Fictional usability/review-race tests measure incorrect clearance first, then questions, corrections and time on a declared workload. The benefit must include useful approved outcomes, not merely fewer prompts produced by omission.

### 10. Universal optimal topology, linear scaling or stable speed/cost preference

**Proposed disposition:** Defer a universal topology or performance winner. Select useful compositions per source scope using actual comparable results and disclosed product priorities.

- **Technical limit:** No one topology must be fastest across arbitrary density, layout, dependencies and external wait states. Pages alone do not determine tokens/output/latency. Finite measurements cannot prove global optimality.
- **Practical limit:** Current W/B request failed in transport before a clinical result; unknown usage is not zero cost. Small sparse fictional text controls do not represent long-document distribution. Throughput work is premature before useful quality/recovery is established.
- **Best-case documents hoped for:** Uniform readable pages, modest output volume and known route capacity with short predictable waits.
- **Realistic documents expected:** Dense tables next to blank/repeated pages, output growth with facts, rare long-distance dependencies and bursty provider service.
- **Fallback:** Use the smallest maintained set of qualified components, serial orchestration initially, observed input-fit predicates, honest estimates and explicit unsupported states. Keep alternatives pending evidence; defer concurrency/scaling campaigns unless they resolve an actual bottleneck.
- **Revisit criterion:** Comparable completed useful workloads, fully accounted actual routes, fresh component/seam tests and separately declared length/throughput hypotheses. A failed extrapolation remains a failed model, not a license to refit the same outcome into a “pass.”

## Definition and scorer repairs to make prospectively

- **Separate product states:** Original committed; extraction partial; text complete for a defined inspected scope; clinical reading complete/incomplete; review eligible; accepted; waiting; stopped. “Done with exceptions” is terminal accounting, not a quality pass. No unresolved region may disappear because its words are clinically irrelevant.
- **Define readability and meaning:** Physical oracles need independent inspection, permitted alternate transcriptions/segmentations, ambiguous-region adjudication and clear meaningful-order/table criteria. Readability is not identical to current OCR confidence. Do not require a unique reading where the source supports multiple readings.
- **Fix completion semantics:** The historical `falseComplete` metric omitted order/grouping and invented-text conditions. Preserve its zero result as recorded; use a new full-contract completion endpoint prospectively. Historical appended adjudication identified false full-contract claims without changing the old metric.
- **Score information rather than object shape:** Equivalent adjacent split spans, inherited candidate-authored context, compound assertions and relevant multi-page citations should receive equivalent treatment. The documented split patient/DOB adjudication stays append-only; remaining misses and failed fixture gates do not vanish. A scorer must not infer candidate-missing associations from gold.
- **Keep denominators honest:** Count omissions and unnecessary uncertainty against readable/clinical recall; retain unsupported extras; report document-level gates and endpoints separately. Hundreds of table relations within two sources are correlated constraints, not hundreds of independent trials.
- **Distinguish semantics from transport:** `unexpected_model` after no response was a harness mislabel; the attempt is a failed transport with unknown usage, not a clinical-quality test or proof of a different model. Mock transport improvement does not recover the missing usage.
- **Define the support boundary before testing:** Finite format/stratum support is useful; a best-case-only corpus cannot establish general support. Favorable source descriptions must not turn into hidden user obligations. A new practical acceptance target requires its own version/declaration and cannot retroactively regrade old failures.

## Defensible practical-selection rule

1. **Reject unsafe compositions first.** Apply the non-negotiable evidence/authorization/review/recovery gates. Safe abstention can preserve eligibility for investigation, but never supplies a complete-text or clinical-quality pass.
2. **Declare useful source strata and product actions before results.** Keep expected messy-source coverage visible, including unsupported share and unresolved workload. Do not silently remove troublesome strata after seeing outcomes. Where full automation is not defensible, explicitly define a human-assisted prospective target while retaining the old full-automation result.
3. **Require positive useful work, not only caution.** On independent readable controls, require supported literal/relationship/clinical output and usable review actions. Count unanswered readable spans and missing facts against success; measure correction/questions/time per completed useful document. An all-abstaining system is a retention/triage fallback, never a winning automatic importer.
4. **Use a Pareto comparison within each stratum.** A candidate dominates only if it is no worse on prespecified fidelity, unsafe errors, useful coverage and user effort, and improves a relevant endpoint on comparable completed work. Efficiency cannot compensate for a safety failure. If quality/effort trade off, publish the tradeoff and make an explicit product-priority decision; do not invent weighted scores to force a winner.
5. **Select the simplest qualified composition when substantively tied.** Keep credible nondominated alternatives. Require observable routing predicates and exercised real fallback compatibility before adopting a branch. Unknown/unfinished clinical work cannot win on elapsed time or known-token subtotal.
6. **Use new tests only to resolve a named uncertainty.** Repair a demonstrated mechanism on exposed fixtures, then freeze a fresh falsification set. Preserve every historical score and cost. No mandatory exhaustive engine × reader × batch × concurrency matrix and no conclusion that “nothing works” merely because no current prototype meets the universal wording.

The present evidence supports retaining useful native/OCR outputs, explicit uncertainty and durable provenance while withholding full-text qualification for the tested E1/E2b source scope. It has not selected a visual fallback or clinical reader. The next useful design decision is which bounded automatic and human-assisted outcomes the product will claim, with all hard invariants intact—not whether to erase past failures or declare the entire composed approach impossible.

## Evidence from the detector-composition follow-up

The [detector and interaction study](import-processing-detection-experiments.md) now supplies a concrete candidate: confidence, visible-coverage, reader-disagreement and structural signals select source context, and the person may correct any part of that displayed context. Highlights guide attention; they do not impose a hard crop boundary on editing. The original crop-only model failed the complete finite floor even when all necessary source evidence was visible. Its eighty scores remain unchanged.

A separately declared seventy-outcome post-hoc extension, independently verified, passed six natural documents and four injected challenges under an assumed-perfect reader with this context-editable composition. It displayed less page area than full-source review but still visited every page. This is a promising interaction policy on sparse typed fictional sources, not fresh held-out qualification, measured human efficiency or a complete app implementation. Preserve full-source access and explicit unreadable exceptions. Fresh source qualification, actual user review and production integration remain open.
