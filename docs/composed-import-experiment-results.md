# Composed import experiments: execution and independent verification

## Authorization and scope — 2026-09-26

The owner authorized runner subagents to execute the [composed-strategy test plan](import-processing-test-plan.md),
with separate independent result verification and additional discriminating tests where needed.
The goal is an evidence-supported set of compatible components and routing rules for declared
source types, not a forced universal winner. The [customer specification](import-scenarios.md)
and complete-text requirement remain fixed. This is a new investigation; the completed F1–F9
recordings, their deadlines, failures and unknown costs remain unchanged.

The initial implementation baseline is `d312320e378666c60a98c82d7683d96bf1981581`. Prototypes live
in a separate managed checkout; Git changes remain uncommitted and no prototype is merged or
deployed. Independently fictional inputs and external raw artifacts are mandatory. The main
checkout receives portable declarations, results and verification only.

Two runner roles divide work: clinical/scorer/router/durable-core construction and sole provider
operation; and text/fixture/recovery testing. A third agent independently reviews prerequisites
and verifies outputs. No runner verifies its own result. Model, OCR and recovery-model results
must be distinguished from current application integration and actual accepted-record behavior.

## Decision discipline

- Freeze each finite experiment's fixtures, code, oracle isolation, candidate compositions,
  endpoints, order, resource predictions and stop rules before execution. Provider work starts
  only after independent pre-use review and a concrete coordinator-approved declaration.
- Evaluate complete durable text, clinical correctness, recovery/review safeguards and efficiency
  separately. Correct clinical output does not compensate for missing text, and a small token
  count does not compensate for unfinished work.
- Scoring accepts equivalent valid durable representations. It must not infer missing candidate
  relationships from the oracle or require complete text inside each clinical proposal. Report
  provisional errors caught by a composition separately from incorrect results that escape it.
- A quality failure can eliminate that frozen prototype for its tested scope. It cannot establish
  that an entire strategy family is impossible. A successful competitor provides a scoped result,
  not proof of arbitrary-document correctness.
- When both candidates meet quality and recovery requirements, compare the same completed work.
  Additional independent fixtures or repeats must address a declared uncertainty before a stable
  performance preference is claimed. A tie or insufficient evidence remains unresolved; extra
  testing must not manufacture a winner through selective reporting.
- Amendments preserve every prior result and require new declarations. A failed heldout becomes
  regression evidence; repaired candidates need newly reserved heldouts. New tests must target
  an observed failure mechanism or unresolved decision, rather than expanding a parameter matrix
  without a decision it can resolve.
- Record all setup, failed and retried calls and cumulative costs. Unknown provider usage stays
  unknown. Follow the existing two-times-modeled-token experimental stop rule; no guard overrun
  becomes a cheap completed result and no interrupted run silently starts a new allowance.
- Router and fallback paths need their own compatibility evidence. A component pass or fake
  routing receipt alone does not qualify an end-to-end composition. Existing profile-lock
  behavior cannot be bypassed to simulate approved background authorization.

## Results

No new result is claimed by this execution declaration. Concrete stage declarations, measured
outcomes, independent verification and supported/falsified/unresolved composition decisions will
be appended here. The previous study's positive execution review is not evidence of a winner in
this investigation.

### Development review findings — 2026-09-26

Before freezing Stage 0, the independent verifier reproduced scorer defects involving overly
broad source citations, unsupported extra clinical fields and duplicate context identifiers,
and a race between concurrent writes to the same durable text revision. These are development
findings, not results from a frozen candidate comparison. The runner is repairing them; the
verifier must recheck both adversarial cases and equivalent valid representations before
clearance. Passing these controls alone cannot establish clinical quality.

Stage 1 is staged through its four development documents first. Native extraction and ordinary
full-page OCR provide baselines; neither is presumed to satisfy complete-text retention,
visible-region coverage or table relationships. A composed extraction candidate and its
limits must be frozen after development and before the eight reserved documents are scored.
All development attempts remain in the accounting. Recognizing cursive font text tests a
handwriting simulation, not real handwriting.

The current application's lock behavior revokes access and closes the vault. Any experiment
with a separately scoped background capability remains a proposed authorization-model test;
it cannot be reported as an application integration pass or permission to bypass locking.

### Independent pre-use verification — composed text development controls, 2026-09-26

The verifier authored the reviewed experimental plan but did not implement the extraction candidates, create these sources or run their OCR. Reviewed the current specification and runner rules, extraction/scoring code, development-only amendment, and exact source freeze. This clearance is limited to **four development PDFs, three pages each, one serial Tesseract invocation per page: 12 OCR calls maximum**. It does not clear heldout OCR, provider work or production adoption.

Independently inspected all 12 actual rendered pages against their literal source oracle. The visible annotation missing from native text, repeated administrative content, scan text, faint line, tilted line, synthetic pen-stroke exception, table cells and corrected values are present without observed clipping. Readable content is approximately 67–76 words per page; this is a small recognition-control corpus, not realistic long-document scaling evidence. Italic/cursive text is a handwriting simulation and supports no generalization to real handwriting. All four PDF checksums, 12 render checksums and four oracle hashes were pinned in the independent pre-use receipt.

Earlier review found that substring matching could incorrectly credit `4.2` inside `14.2`, lacked a reading-order endpoint, and could credit the same occurrence repeatedly. The runner corrected these before OCR. Independently executed eight literal-boundary controls against the revised scorer: exact numbers match; added digit, negative sign and decimal suffix do not; separate repeated words use distinct offsets; whole-word boundaries remain distinct. Read the revised one-use alignment, page/line geometry and adjacent-order scoring. Table topology and located-unreadable endpoints remain separate; bare native text or OCR does not receive those capabilities by assumption. Every OCR page is explicitly marked partial rather than certified visually complete. The finite exact-span score is a controlled diagnostic; unusual legitimate span segmentation may require independently recorded adjudication before any broader claim.

The five current source hashes match `stage1-dev-freeze-v2.json`. The pinned Docker image resolves to `sha256:8d784a58d02c25943b7c7b785d557b94827c493d22b6d29ee1f2dc0d511ed568`. The runner invokes English Tesseract PSM 3 on 144-dpi rendered pages, with one CPU/thread, 1 GiB memory, a 128 MiB temporary filesystem, read-only input, network disabled and a 120-second per-page process deadline. Only rendered images are mounted; the scoring oracle is unavailable to OCR. A nonzero OCR exit stops later dispatch and preserves its receipt; no implicit rerun is cleared. No provider calls are involved.

**Agree with the development-only execution scope.** The initial reserved corpus was not cleared as independent-template/seam qualification: most variants reused layout/content patterns, and the table did not actually split a row across pages. It remains unrun. A genuinely new heldout corpus and a plausible composed candidate require a separate freeze and review after development; the old fixtures and declarations stay preserved. A native-plus-visual composition, durable retrieval, and complete-text quality remain unqualified until actual results and independent verification establish those narrower claims.

Evidence: independent `stage1-dev-preuse-checks.json`, the development-only amendment, pinned source freeze, literal-control outputs, rendered-page review, and image digest. No OCR was run by this verifier during pre-use review. The separate checksummed-artifact concurrency and profile-read controls concern the isolated prototype, not production encryption or background authorization.

## Independent Stage 0 verification — 2026-09-26

**Agreement and scoped clearance.** The verifier independently executed the current 20 scorer, six identity and six routing controls. All 32 passed. The exact seven implementation hashes and receipt are recorded in `stage0-independent-v3.json`; the separate primary reproduction is retained alongside it. This clears this finite offline scaffold for subsequent declared experiments, not a general clinical-quality claim or permission to launch undeclared jobs.

Additional adversarial checks rejected a correct value with indiscriminate whole-document citations, an unsupported extra diagnosis field on an otherwise matched assertion, and duplicate conflicting authored-context IDs. A sufficient citation set supplemented by another explicitly relevant source span passed. Thus support is neither unrestricted locator resolution nor arbitrary exact-set equality. DICOM, MP4, MP3, WebM and WAV dispatch spies all made zero clinical calls after the runner repaired the audio/video family guard.

Earlier failed probes remain retained: the initial scorer admitted the three unsafe cases; the initial durable writer acknowledged two conflicting concurrent versions and lost one. After correction, an independent race probe saw one successful immutable publication and one rejected conflicting revision. Five independent physical-contract checks rejected semantic fields, semantic data hidden in table identifiers, invalid unresolved-region geometry and a cross-profile read. This prototype is a checksummed physical-text envelope, not production encryption or a background-session implementation.

No provider or OCR request was made for Stage 0 verification. Fake routing bounds exercise policy and restart bookkeeping only; actual provider fit, clinically exhaustive fixture oracles, realistic source content and live request/cost ceilings remain separate pre-use requirements. Source-specific clinical output must not be judged solely by the small schema controls.

## Independent Stage 1 development verification — 2026-09-26

**Agreement.** An independently written verifier re-derived both baseline scores from all eight durable envelopes and the four development oracles without importing the runner scorer. All envelope hashes, eleven aggregate endpoints per arm and fixture-gate counts agree. Native extraction retained 135/174 literal spans and 123/162 adjacent reading-order edges; rendered OCR retained 173/174 and 160/162. Both retained 0/36 declared table-cell relations and located 0/3 unreadable scribble regions; neither invented text in those regions. The finite fixture gate passed one native and two OCR documents out of four. These are development observations, not heldout qualification.

The single OCR literal error is the table document's page 1 potassium value: the source says `4.1`, while the OCR line says `Potassium 41 mmol/L`. This illustrates why near-complete text retention is insufficient to establish clinical safety. Original native and OCR artifacts and their failed endpoints are retained. Both baseline adapters explicitly remain partial; neither made a full-text completion claim.

Before execution, the verifier visually inspected all 12 rendered development pages against their physical-text oracles. Two independently repeated OCR calls—scan page 1 and table page 2—used the same pinned engine and parameters after the primary run terminated. Both exited zero and reproduced the primary TSV byte-for-byte. Their outputs and receipts are separate from the primary run.

Costs and work are kept distinct: primary OCR performed 12 serial local calls, all exit zero, totalling 8.061104460 seconds of subprocess time and 8.203960460 seconds of measured document-phase time. The two verification calls added 3.424435292 seconds. Provider requests, tokens and charges were zero; local infrastructure dollars were not priced. These figures exclude PDF creation/rendering and native preparation and must not be labelled total end-to-end cost. Two earlier native preparation failures remain recorded and are not successful OCR calls.

The fixtures have only approximately 67–76 words per page and synthetic font handwriting, so they establish neither realistic long-document scaling nor real-handwriting reliability. The initial same-template heldout set was not cleared for evaluation; newly designed heldouts and any composition must be frozen and independently reviewed before use. No full-text engine or composition is qualified by this baseline.

Reproduction evidence: `dev-score-rederive.ts` and `dev-score-rederived.json`; reduced OCR commands, render/output hashes and exact durations: `dev-ocr-reproduce.ts` and `dev-ocr-reproduction.json`. The frozen development scorer is retained separately from subsequent CLI-arm changes.

### Current application recovery baseline — runner recording, 2026-09-26

At the unchanged application baseline, one serial invocation of `node --test
--test-concurrency=1 --test-reporter=tap` ran `src/server/test/intake-batches.test.ts`,
`src/server/test/intake-batches-vault.test.ts`, `src/server/test/intake-workflow.test.ts`
and `src/server/test/intake-independent-acceptance.test.ts`. The independently reviewed
five-minute bound was not reached: all **38 tests passed**, with no failures, cancellations or
skips, in 16.575 seconds of measured command elapsed time. Existing fictional fixtures used
fake model/bridge transports and temporary profile roots. There were no provider or OCR calls.
Source hashes, declaration, TAP output, stderr and the terminal receipt are preserved externally.
Independent reduced result verification is pending this entry.

This is a regression baseline, not the proposed ten-case composed recovery experiment. It
exercises actual application journals, encrypted-profile recovery, Stop/reload, partial-proposal
retention and accepted-history safeguards. Tests expecting a persisted pause after lock or an
explicit resume after provider failure document current behavior; their success does **not**
satisfy the desired authorized background processing or automatic retry/resume requirements.
It also does not integrate the new durable-text prototype into the application's recovery path.

## Independent current-app recovery baseline verification — 2026-09-26

**Agreement.** The recorded unchanged-application regression run reports 38 tests passed, zero failed/skipped, exit zero. The verifier inspected temporary fictional fixtures, fake bridge/model setup and the lock-before-preflight-release test, then independently reran six relevant tests with the original application code: provider-timeout pause; final-file explicit resumability; profile-lock generation guard; encrypted HTTP queue restoration after lock and complete SQLite cache loss; and before-head/after-head publication failures preserving literals, truthful receipts and attribution after cache loss. All six passed, zero failed/skipped, exit zero. The reduced invocation took 2.907128042 seconds wall time and made no provider/OCR calls.

This verifies the tested current behavior. Profile lock pauses private work; the provider-failure path requires explicit resume. Those are gaps against the desired background continuation and automatic recovery contract, not successful demonstrations of those new capabilities. These regressions do not fulfill all ten proposed Stage 3 composed-pipeline fault cases, nor do they exercise a live provider or a new background authorization capability.

Separate evidence: `recovery-subset.ts`, `recovery-subset.tap`, `recovery-subset.stderr` and `recovery-subset.json`. The primary baseline receipt and TAP remain unchanged.

### Clinical diagnostic finite declaration — coordinator review, 2026-09-26

The coordinator approved the finite design and budget in principle, subject to independent
clearance of the exact source, oracle, code and route hashes before the first model call. Two
24-page development documents exercise W once and B once. W reads the complete physical
transcript in one request; B reads four contiguous six-page scopes and assembles their outputs
in a fifth request. Later scopes receive the printed cover text; assembly receives candidate
assertions and quoted unresolved dependencies. It does not secretly receive a complete source
transcript or gold relationships. This is a fixed bounded prototype, not a qualified general
structure-based splitter.

The initial reserved comparison is H1/H2 × W/B in the frozen order H1-W, H1-B, H2-B, H2-W.
Conditional H3/H4 cells follow only under the declared failure/continuation rules. Development
plus the initial comparison permits at most six jobs and 18 requests; including the conditional
cells permits at most ten jobs and 30 requests. The initial token forecast is 544,687; the full
forecast is 901,001, with a cumulative stop at 1,802,002 known tokens and separate two-times
limits per job. These are modeled quantities, not measured usage or prepaid allowances.
A single three-hour dispatch window begins with the first development job and never resets.
Each request has a ten-minute client deadline. Unknown usage, authentication failure or an
unsettled request after a process crash stops further dispatch. No retries or free model probes
are included. A requested output allowance is not an enforceable upstream token cap.

Both candidates use the same model route, substantive instructions, physical source text,
profile inputs and review boundary. These synthetic documents share a page skeleton and use
adjudicated physical text; they can test targeted clinical relationships, but cannot qualify
OCR, arbitrary hospital templates or application integration. Expected clinical assertions
remain inaccessible to runtime. A critical error at the completed composition rejects that
frozen arm; incomplete but safe output remains a quality failure. Every job is independently
scored before the next is enabled. A pass against a failed competitor supports only a scoped
capability preference. Single latency observations cannot establish a stable speed advantage;
additional repeats and fresh integration fixtures would need a separate declaration.

#### Run 2026-09-26 — composed strategy Stage 0 runner

- Baseline: d312320e378666c60a98c82d7683d96bf1981581 in an isolated managed prototype worktree; TypeScript/Node offline, fictional data only.
- Frozen method: 20 scorer fixtures (12 valid equivalent representations and eight invalid mutations), six identity cases and six router boundary cases, plus independent adversarial probes.
- Command: node src/scripts/composed-import/stage0.ts --run <external-artifact-root>/stage0.
- Measured result: 20/20 scorer controls, 6/6 identity controls, 6/6 router controls satisfy their declared expected results. Actual quality predictions remain unknown; these are fake/component boundary controls.
- Source-support scoring permits relevant-context supersets while rejecting undifferentiated whole-document references. Unmodeled candidate fields/novel supporting representations are held for independent adjudication rather than silently repaired.
- Known limitations: limited explicitly labeled local identity parser; synthetic byte routing boundary; no production authorization/encryption acceptance; no provider calls, OCR calls or clinical quality outcome. Provider tokens measured zero.
- Validation: tools TypeScript check passes. Independent verifier receipt must be linked separately before awarding verification.

## Independent clinical diagnostic pre-use review — 2026-09-26

**Scoped clearance: first development whole-document job only.** Exact execution plan SHA-256 `19fef9c1fe40515f4bfec04bdfefdb2dbd1170864a7b6685694e8cb8fcec564b`; final scoring declaration SHA-256 `e12ce43851cc593fbdbac0c46f8725155f6d15e74ee46f65a86d45d7b0ad31e7`. All final oracle, amendment, scorer and adapter hashes were independently checked. Later jobs require the declared review/continuation decisions; this is not clinical qualification.

The runtime receives only whitelisted physical text/layout, a fictional profile and candidate-authored drafts. Its Node permission boundary denied access to the separate oracle sentinel in the actual runtime. Semantic scoring is kept outside all runtime-readable output roots. Source, physical transcript, profile and code hashes are checked before requests. Independent PDF.js extraction matched all 144 physical pages, and five rendered pages covering the remote specimen note, amendment, family-member scope and partial-date addendum were independently inspected. Oracle counts cover 88, 88, 88, 89, 88 and 41 meaningful assertions, including all table rows and clinical/medication sentences. Valid alternate source supports were expanded before outputs existed; prior gold snapshots remain retained. Novel equivalent representations/supports still require blind adjudication rather than automatic unsafe labeling.

Five no-network probes exercised the actual runtime: valid usage settled 15 synthetic tokens; missing usage stopped as unknown; HTTP401 with no usage stopped with unknown accounting; a synthetic overrun retained 2,000,005 tokens and stopped; a preexisting pending attempt stopped before any dispatch and retained its unresolved status. Request intent is persisted before fetch; ambiguous interrupted attempts cannot silently reset cost. No provider or OCR call occurred in verification. An initial verifier harness path-permission error and a text-check harness parse/tool-availability error were corrected before these successful probes; none dispatched external work.

The token threshold is checked after each response. The 32,768-token output allowance is a prompt instruction, not an enforced provider cap, so it is not a guaranteed maximum expenditure. Unknown usage cannot be charged as zero. The shared study wall and request limits, source-only inputs, recorded raw attempts and independent final-composition scoring remain required.

The sources have roughly 4,332–4,751 words per 24-page packet and retain substantial repeated ordinary administrative prose. They are a small synthetic context-topology diagnostic, not evidence of performance on arbitrarily dense real records. The H4 addendum is typed native text and tests date/context handling; it is not an OCR handwriting result. Current app security and acceptance behavior remain unchanged.

Evidence: `clinical-final-freeze-check.json`, `clinical-physical-check.ts/json`, `runtime-fake-child.ts`, `runtime-fake-probes.ts/json`, and retained representative renders. The latter fake responses are verification-only bookkeeping inputs, never clinical candidate results.

## Independent Stage 1 reserved-corpus pre-use review — 2026-09-26

**Scoped clearance.** Freeze `heldout-freeze-relations-v4.json`, SHA-256 `e757650b558f2dbbeaac4e8619eda53675668ff7018a2845b38babfa68225ae2`, permits exactly 24 serial local OCR calls over eight new three-page fictional documents, followed by the fixed composition and scorer using those same OCR outputs. Source, oracle and six implementation hashes independently match. The OCR engine and container isolation/limits are unchanged from the verified development run. Any nonzero call halts future calls; no automatic retries or post-score tuning is authorized by this clearance.

The verifier inspected all 24 actual page renders. They contain distinct correspondence/form/scan/continuation/amendment layouts, genuine split rows with carried headers, repeated readable administrative text and synthetic unreadable strokes. No clipping was observed. These remain small synthetic fixtures; italic font simulation is not real handwriting.

Pre-use falsification found that exact numeric table indices ignored table identity and could penalize equivalent representations. The amended scorer retains that original count as a diagnostic, but tests explicit candidate-authored table/row/column relationships for qualification, including cross-page edges. The visible measurement-card grid was added to the oracle before execution. Positive-only relations were then found insufficient because a single collapsed row/column could pass. The final oracle includes inequality relations too. Independent probes accept consistent table renaming and row/column reindexing and reject collapsed all-cell groups on every table-bearing document. Prior oracle snapshots and amendments remain retained; no heldout output informed these repairs.

The fixed composition uses ordinary native text, OCR and pixels only. Its residual-ink heuristic can locate unresolved regions but does not prove every visible word was captured. Known page-local grouping and multicolumn-order limitations remain testable outcomes. Literal text, uncertainty, order, grouping and false-complete endpoints must be reported separately; successful execution alone cannot qualify full text or clinical quality.

Evidence: `heldout-preuse-check.ts/json`. No verifier OCR call was active at clearance.

### Fresh text holdout — runner recording, 2026-09-26

All 24 serial OCR calls completed once with exit zero under the independently cleared freeze.
Terminal checks found no frozen code or oracle changes. The summed OCR subprocess time was
10.334 seconds; document-level OCR phases totaled 10.512 seconds. These exclude preparation,
rendering, composition and independent verification. No provider requests were used.

Native extraction retained 259/349 readable spans; OCR retained 346/349; the composition retained
349/349. The composition nevertheless preserved only 322/325 reading-order edges and 216/1,161
table-grouping relations. All six unreadable regions were located, but three contained retained
OCR guesses. Six readable spans remained uncertain. Only 2/8 finite document gates passed.
The former 36-cell development metric remains a historical diagnostic; the heldout uses the
separately frozen relation metric, including both required links and required separations.

This frozen composition fails the complete-text contract. Complete word retention does not
compensate for incorrect table grouping, reading order or uncertain-region handling. These
outputs are preserved as regression evidence. A repair requires a new candidate declaration
and new heldouts; it cannot relabel these eight documents as successful new evidence.

### Shared durable-text subset — runner recording, 2026-09-26

Eight API-level checks passed: retry after missing acknowledgement, duplicate publication,
fresh-process retrieval/index reconstruction, corruption rejection, missing-evidence rejection,
profile/locator rejection, immutable correction revisions and missing-page rejection. No
provider or OCR was called. These are tests of the isolated text API, not completion of the
ten proposed scheduler/security/review fault cases.

## Independent durable-text recovery verification — 2026-09-26

**Agreement within the stated prototype scope.** The runner's eight tests all report success. The verifier read their implementation and independently re-derived the retained acknowledgement-gap and duplicate-publication artifact hashes and single-file counts; rejected the retained corrupted artifact, missing artifact, wrong profile and invalid locator through the actual read API; confirmed the old revision remains unchanged beside the corrected revision; and used another fresh Node process to reconstruct exactly the recorded 33-span index without OCR/model work. Earlier independent pre-use probes separately exercised conflicting concurrent publication, semantic/invalid physical contract rejection and immutable revision preservation.

These are checks of the shared durable-text API. An absent acknowledgement is represented by reading and retrying an already committed artifact, not an implemented scheduler crash. The API is an unencrypted fictional prototype; supplying a profile ID is not session/key isolation. A fresh read/rebuilt in-memory index is not full application SQLite recovery. The actual application regression baseline covers its own encrypted recovery separately.

Interrupted original upload, browser/sign-out/profile-switch background capability, provider quota recovery, Stop dispatch races, clinical amendment/approval races and real power-loss fault injection remain unmeasured by these eight cases. They cannot be marked complete because durable reads pass. All verification here used zero provider and OCR calls.

Evidence: `recovery-artifact-rederive.ts/json`, the unchanged runner recovery receipt and retained artifacts, and the earlier durable race/physical-contract verification receipts.

## Independent Stage 1 composition and reserved-corpus results — 2026-09-26

**Agreement with the recorded counts; full-text qualification fails.** Independent code re-derived all three arms from the 24 durable document envelopes and frozen physical oracles without importing the runner scorer. All aggregate endpoints and finite fixture gates agree. Native text retained 259/349 literal spans, rendered OCR 346/349, and their fixed composition 349/349. The composition preserved 322/325 adjacent order edges, grouped 18/54 table cells and preserved 216/1,161 table relationships. Neither baseline preserved any of those relationships. Each arm passed only two of eight complete fixture gates; these two were the typed amendment-letter packets.

The composition located all six unreadable regions, but retained three invented strings in the clinic-message scribbles: OCR produced `SEX` once on each of the three pages. All expected literal spans can therefore coexist with unsupported extra text. The composition also marked six legible spans uncertain. The native baseline located zero unreadable regions; OCR located three and had the same three inventions. Human-readable uncertainty is useful, but this version is not a complete or reliably faithful full-text adapter.

**Completion-claim oddity.** The frozen `falseComplete` metric tests only missing literal text and unlocated unreadable regions; its zero count is preserved. Independently comparing the candidate's complete claim with the full frozen fixture gate finds two false full-contract completion claims: both continued-table documents claim inspected/no unresolved regions while preserving only 108/459 physical relationships each. Of four documents claiming completion, two fail the full gate (2/8 of the corpus). This is an appended adjudication of the metric's limited scope, not a replacement score or a post-result criterion change. A pixel-coverage heuristic does not detect a lost cross-page relationship.

The separately checked development composition retained 174/174 literals and 162/162 order edges, preserved 36/36 original cell-index checks, and located 3/3 scribbles, with three readable spans uncertain and 3/4 finite fixture gates passed. That development result did not generalize to the reserved layouts. The initial native and OCR recordings and the composition's development/heldout failures remain intact.

All 24 primary heldout OCR calls exited zero. Their subprocess times total 10.334403541 seconds; measured document OCR phases total 10.512244959 seconds. Composition added 0.385942085 seconds in the heldout run and 0.202184209 seconds in development, reusing prior OCR outputs. There were no new provider calls/tokens/charges and no additional verifier OCR calls for the heldout stage. Local infrastructure dollars remain unpriced. These figures exclude source creation, rendering and native preparation, so they are not end-to-end pipeline costs. Two earlier development OCR reproductions are accounted for separately.

Evidence: `heldout-score-rederive.ts/json` and `dev-composed-score-rederive.ts/json`, the frozen receipts and raw artifacts. Candidate changes informed by these failures require a declared fresh falsification set; rerunning this exposed corpus would measure development, not a new heldout qualification.

### First clinical development attempt — failed transport, 2026-09-26

D1-W dispatched exactly one request at 17:36:39 UTC. After 301.079 seconds the client recorded
a transport `TypeError`, with no HTTP status, response artifact, candidate or usage receipt.
The study's unknown-accounting stop took effect; no second model request was authorized.
The ledger's zero known-token subtotal is **not** a zero-cost result. Read-only inspection
found no matching completion/usage capture in the existing proxy diagnostics.

The terminal label `unexpected_model` is a harness error: a missing-model check overwrote
the earlier transport/unknown reason. It is not evidence of a different model or authentication
failure. Independent review agrees with the raw attempt and this limitation. A roughly
five-minute header timeout is a possible explanation, not an established cause, because the
underlying transport error cause was not retained.

There is no clinical candidate to score and no W-versus-B outcome. The first development
attempt remains failed, with unknown usage. Clinical work remains stopped while a concrete
transport/capture repair is developed and reviewed offline. The original cumulative limits
and clock do not reset. Text-extraction experiments can continue without provider calls.

## Independent first clinical attempt verification — 2026-09-26

**Agreement with failure; no clinical result.** The first whole-document development attempt has one recorded request, a 301,079 ms attempt duration, no HTTP status, error class `TypeError`, and no response JSON, usage or candidate. The terminal duration is 301,102 ms. The ledger records one request, unknown usage, zero known tokens, no completed job and a global stop. Zero known tokens is not a zero total cost.

The recorded stop label `unexpected_model` is misleading. The runtime first records missing usage and the transport error, then its missing-response-model check overwrites that reason. Because no response model was received, this label establishes neither a model mismatch nor an authentication failure. The retained raw fields substantiate transport failure; they do not identify its underlying cause. A roughly five-minute duration alone cannot prove a particular timeout mechanism.

The failed attempt remains retained and is not an unattempted arm, completed clinical evaluation or quality failure. No future call is independently cleared from this result. Any later upstream response/usage must be matched to this exact attempt and appended; unknown usage cannot be waived or reset. A transport change needs an independently reviewed amendment and tests of interruption, late response, cancellation and cumulative accounting before another dispatch.

### Revised extraction adapter E2b — fresh failure, 2026-09-26

The revision was frozen before its implementer saw two independently authored three-page
documents. Six serial OCR calls completed under independent pre-use clearance; no additional
model calls were made. The frozen primary score was 80/82 readable spans, 72/76 order edges,
210/441 table relations, 18/30 grouped cells, one of two unreadable regions located, one
retained scribble guess and five unnecessarily uncertain readable spans. Both documents
failed: **0/2 finite gates**. Both were marked incomplete, with no false-complete claim.
Independent rederivation agrees. A split-span patient/DOB representation has a separately
identified scoring dispute; adjudication must preserve the raw score and cannot erase the
other failures.

A post-hoc comparison ran the original frozen composition against the **same inputs and OCR
outputs**, using the common full-contract scorer, with no extra OCR. It scored 80/82 spans,
70/76 order edges, 0/441 table relations and two scribble guesses, also 0/2 gates. Native and
raw-OCR controls retained 69/82 and 81/82 spans respectively. The comparison was requested
after E2b's primary result was exposed and is explicitly exploratory.

E2b improves some structural and uncertainty outcomes, but is not a qualified full-text
extractor or an end-to-end winner. Its header vocabulary and continuation phrases failed on
new wording, and high-confidence OCR still invented a string in an unreadable marking.
Further work should test a distinct visual-reading/fallback component or an explicitly
unsupported route, not repeatedly tune the same heuristic to regrade these failed sources.
The original and revised failures remain retained.

## Independent E2b fresh-source and paired-control verification — 2026-09-26

**Agreement with recorded results, plus a valid segmentation adjudication.** Independent code re-derived every aggregate endpoint for native text, raw OCR, E1 and E2b from the same six pages, raw retained envelopes and final oracles. E2b was frozen before its two fresh sources; the E1/native/OCR comparison was added after E2b outcomes were visible and is explicitly post hoc. No prespecified superiority claim follows.

Frozen literal-span counts are native 69/82, raw OCR 81/82, E1 80/82 and E2b 80/82. Frozen reading-order edges are respectively 61/76, 68/76, 70/76 and 72/76. Every arm passes zero of two full fixture gates. E2b preserves 210/441 table relations and groups 18/30 cells; all three controls preserve zero relations. Relation counts are constraints on two sources, not 441 independent samples.

**Append-only adjudication.** The patient/DOB line on the first chemistry page is preserved completely as two adjacent native spans: `Patient: Jamie Vale` and `DOB: 1988-07-19`. Their coordinates, literal concatenation and predecessor/successor reading order match the source. The frozen single-span matcher incorrectly penalizes equivalent segmentation. Without editing those scores, the adjudicated literal counts are native 70/82, E1 81/82 and E2b 81/82; raw OCR remains 81/82. Adjudicated order is native 63/76, E1 72/76 and E2b 74/76; raw OCR remains 68/76. The other E2b literal miss is the genuine `Asecond` versus `A second` transcription. Structural and unreadable-region failures remain, so all full fixture gates still fail.

Relative to E1 on identical inputs, E2b improves retained structural relations, reading order and guessed scribble text (one invented string instead of two). It also withdraws E1's false complete claim on the chemistry packet: E1 has one completion claim and that claim fails the full contract; E2b has no completion claims. This improved caution has a usability cost: five legible spans are marked uncertain rather than zero. Both compositions locate only one of two unreadable regions. E2b is a more promising component for these structural cases, but it neither dominates every endpoint nor qualifies as a complete full-text strategy. A route needing complete text still needs a separately qualified reader or an explicit unresolved outcome.

Six primary OCR calls all exited zero, using 2.402160625 seconds of subprocess time and 2.452422375 seconds of document OCR phases. E2b composition added 0.128549959 seconds. Controls reuse the same retained OCR outputs; there were no extra OCR/provider calls for verification. Provider tokens/charges are zero; local infrastructure dollars are unpriced. Source preparation, native preparation and rendering are excluded, so these are not total pipeline costs.

Evidence: `e2-primary-score-rederive.ts/json`, `e2-paired-score-rederive.ts/json`, and `e2-split-span-adjudication.ts/json`. All original recordings remain intact. The unresolved clinical transport failure is independent of this text-component result and remains a blocker to an overall completed execution assessment.

## Independent offline transport baseline verification — 2026-09-26

**Agreement within the local-mock scope.** The verifier read the broker and seven-case declaration, then independently ran the retained immutable source snapshot into a separate output directory. All seven cases passed. The reduced-scale HTTP mock received five requests; no provider/OCR request, credential refresh, existing proxy modification or original d1-ledger change occurred.

The tests exercised an actual caller process exiting after the broker acknowledged a request, later capture of that same response and usage, identical-ID replay without redispatch, conflicting-body rejection, distinct header/body-idle/overall deadlines, partial-body retention, and HTTP401 cause retention for its JSON body. Restart recovery used an injected persisted dispatch state; it did not kill the broker. The latter resumed as unknown without upstream redispatch.

Pre-integration review identified limits not covered by this baseline: a non-JSON HTTP error could be labelled a JSON parsing failure, and the `completed` field denoted known usage rather than a valid clinical response. A parseable JSON prefix also needs a complete HTTP-message boundary before usage can be trusted. The runner preserved this baseline and proposed a separate amended test set. A mock pass neither recovers the original unknown d1 cost nor authorizes another live request.

Evidence: `transport-repair-v1-reproduction/receipt.json` and the retained version-one source/primary receipts. These verification calls are local mock work, not billable provider attempts.

### Supported exclusions and unresolved choices — interim decision

For the tested mixed/native/scan inputs, native extraction alone omits visible text. Ordinary
full-page OCR alone loses structure and can invent text even with a high confidence score.
The tested native-plus-OCR union still cannot declare completeness from retained-word counts.
The tested vocabulary/phrase-based table adapters fail on independently authored wording.
These variants are unsuitable as the sole automatic complete-text route for this source scope.

This does not eliminate exact native retention, OCR as a component, geometric evidence,
format-specific adapters with verified eligibility, or truthful incomplete/unsupported states.
The evidence favors preserving those useful outputs while keeping completeness separate.
It has not selected a qualified automatic visual fallback, a general table adapter, or a
clinical W/B topology. The latter comparison has no clinical result because its first
development request failed in transport. No universal or end-to-end winner is claimed.

## Independent offline transport version-two result verification — 2026-09-26

**Agreement: 10/10 local tests pass.** The verifier reran the retained version-two broker and test snapshot in a separate fresh external directory. Its ten results agree with the primary run: each invocation made eight local mock upstream requests and zero provider/OCR requests. The verification mock requests are separate from the eight primary mocks and are not provider costs.

The run preserves a delayed response and its 12 input/7 output/3 cached-input synthetic token counts after an actual caller process exits; identical request replay does not dispatch again and a body collision is rejected. Explicit header, body-idle and overall deadlines remain distinguishable, and the one-byte partial body is retained. JSON and non-JSON HTTP401 both retain HTTP_401. A complete response with a wrong model retains known synthetic usage while remaining ineligible. Parseable JSON under truncated HTTP framing remains unknown and ineligible, with BODY_ABORTED recorded. Frozen alias acceptance and absence of the fictional Authorization secret from persisted capture files also pass. Injected interrupted dispatch state remains unknown after restart with no redispatch.

The restart case injects state rather than killing the broker; these tests do not prove provider cancellation, recovery after loss of the capture service, or real service latency. Their millisecond deadlines are mock timing parameters. The newly written captured clinical runtime/launcher are separate, unverified integration work and receive no clearance from this receipt.

The original d1 request remains unknown/stopped, with its existing deadline and costs retained. This result cannot reconstruct its unknown usage or waive the declared stop. No live continuation, auth action, provider/OCR run or production behavior is authorized or claimed by this verification.

Exact tested hashes remain broker `46145de0bea346330ce64132ab70ecaf749be2db2b8301f02293d820337fe715` and test `466012aa23fb6b37b7c674fadcf44e6d377c2a1d893ad969afa2cd1f9e6c9822`. Evidence: the unchanged primary receipt/source snapshot and `transport-repair-v2-reproduction/receipt.json` with its raw local capture artifacts.

## Independent captured-runtime offline version-two verification — 2026-09-26

The independent verifier reproduced all ten offline cases, agreeing with the primary ten outcomes. Each run made five loopback mock requests; neither made a provider/OCR request or read credentials. All five declared source hashes matched and the original failed live ledger remained byte-identical (`f725ad67a44e9689265d2aff22626ee94ee92a9a7a04a2995d8a75ec1e112dd3`).

The actual Node restricted-runtime child preserved the inherited clock/request count and a declared prior-unknown risk reservation; denied oracle access; retained known usage for a wrong-model response; stopped on new unknown usage; rejected expired clock, request/token reservations and pending attempts before dispatch; retained a post-response per-job overrun; and rejected approval before credential loading. After a child was killed, the surviving broker captured usage and an append-only reconciliation retained the earlier unknown without redispatch. The cumulative reservation control starts with zero known subtotal; it does not cover every accounting history.

These are transport/isolation mechanics, not clinical quality, production authorization or complete application recovery. Synthetic empty clinical output is not a quality result. The reservation cannot bound the original unknown cost. Live integration remains uncleared: scoring-manifest binding, placeholder owner-ID rejection, inherited-key sanitization and dispatch-versus-capture deadline semantics remain unresolved. No owner exception or live continuation was approved. Evidence: retained `captured-runtime-offline-v2` source/receipt and independent `captured-runtime-v2-result-verification.md`.

## Prospective human-assisted strategy extension — 2026-09-26

The owner proposed surfacing possibly missed regions with rotation and manual transcription or dismissal. The [practical qualification framework](import-processing-practical-strategy.md) declares this as a distinct composed candidate. Preserve originals, machine output and attributable source-linked corrections; distinguish not-text, unreadable and deferred work; bind page review to revisions; invalidate affected drafts while retaining accepted history. Whole-page review is needed for confident errors and omissions without a machine warning.

The forthcoming offline experiment is limited to scripted review mechanics. Known correct corrections and fault-injected gaps cannot prove real users discover or repair all errors. A deliberately wrong human correction must remain wrong in independent source scoring even if its review event is recorded. Existing automatic-only failures, unattempted clinical comparisons and unknown costs remain unchanged. No provider/OCR dispatch or production UI change is part of this extension.

## Independent practical-framework and human-review design clearance — 2026-09-26

The independent verifier gives a positive design review for the prospective framework and eleven-case mechanics declaration, not an empirical strategy winner. The framework preserves the complete-text outcome, original evidence, all-page accounting, uncertainty, corrections, authorization and clinical approval. Historical automatic failures and unknown costs remain unchanged. Source-text review cannot change medication taking status; separate specified medication decisions remain intact, as do reversible equivalence links and context reuse.

All seven source/core/oracle pins match. The declaration includes non-square forward and inverse rotation, correct and deliberately incorrect human transcription, explicit manual-entry/not-text fault injection, visible unreadable/deferred/skip outcomes, all-page acknowledgment, stale acknowledgment/draft invalidation, immutable replay/conflict, logical profile/source/revision rejection and interrupted projection recovery. Implementation and command require their own pre-use review. No provider/OCR/authentication, rendered UI or production mutation is included.

A not-text classification and a page acknowledgment record the person's action, not proof of truth. One hundred percent disposition accounting is not one hundred percent transcription accuracy. Scripted correction tests cannot establish real human discovery, accuracy, effort or accessibility; incorrect classification or missed text remains a source-scoring error even after review. The reducer must not receive the independent truth oracle.

Reviewed hashes: practical framework `da6de49695924e24728c3ae11125f8dc3955cdc48e94c1df0ffdcda312ee5170`; plan v3 `46980b94ffa049be6a06821400c438ef2478b36f64a118d7e94afe1233e88b24`. Evidence: `practical-strategy-v3-design-clearance.md`. This receipt qualifies the declared design for isolated implementation only.

### Independent framework clarification addendum

The verifier separately reviewed the added distinction between source transcription and remembered/external user clarification. Supplemental information retains separate provenance and cannot count as extraction of an unreadable or cropped source region. The updated framework hash is `3aa99f3b27e91dc2d3fbcff73e1e1b9731c7f13b815799dfe711b2eaeea55270`; the earlier reviewed version and its receipt remain recorded. This clarification adds no executed test or human-performance claim.

## Human-assisted source review: finite offline mechanics result — 2026-09-26

The operator run passed all eleven declared mechanics controls. The deliberately incorrect human transcription failed independent source accuracy, as intended. This result establishes behavior of the tested prototype state transitions; it does not show that real users discover errors, transcribe accurately, finish every page, or work within any particular time. No rendered UI or production integration was tested. Independent reproduction was pending when this entry was authored.

The controlling declaration is `human-review-mechanics-plan-v5.json`, SHA-256 `d3b42b7841fd386479012b496b6432471f479b9edf3ad86d237e6c378cf4c104`. Frozen prototype hashes are `0945dd60ed27e456ed8c3ce1639bf55112eea5ad7e868e9a46ee8fa692a1ce59` for `human-review-mechanics.ts` and `1bff53fe66582f27815af49c1853cccbe8b85740738036bd2d758164d116207d` for its test. The declaration includes all original-PDF, machine-artifact, source-oracle and reused-core hashes. Existing `commitText`, `readText`, and physical validation were reused without modification. The exact source/declaration snapshot is retained beside the raw receipt.

The primary invocation ran once from the isolated prototype checkout. In this portable rendering, `ARTIFACTS` denotes the external evidence root; filenames and argument order are unchanged:

```sh
node src/scripts/composed-import/human-review-mechanics.test.ts "$ARTIFACTS/declarations/human-review-mechanics-plan-v5.json" "$ARTIFACTS/human-review-mechanics-v2"
```

It exited 0. `npm run format:check` and `npm run typecheck` also exited 0. Raw evidence includes `receipt.json`, per-case original/machine/derived artifacts, immutable review-event envelopes, unchanged fixture medication-taking state and accepted history, `checks.json`, and the frozen source snapshot. No provider, OCR, auth, or production operation occurred.

Observed controls:

- R1 passed independently specified clockwise 90/270-degree forward rectangles on a non-square page and inverse checks at all four orientations. Source evidence stayed in canonical coordinates. This tests transformation math, not a rendered viewing interface.
- R2 retained the original machine typo and recorded a new durable correction with actor, time, source binding, region, before text and resulting text hash.
- R3 published manually supplied source text for an explicitly fault-injected omission. Other unresolved regions remained. This was not recovery of a newly measured extractor miss.
- R4 resolved only the explicitly classified, fault-injected blank-border region as not-text. Other exceptions remained visible.
- R5 kept unreadable, review-later and skipped regions as visible exceptions after page acknowledgments.
- R6 used a scripted known location to supersede unflagged machine text `=e` with an unreadable exception. The invented effective text disappeared; the original machine bytes and before-text provenance remained. Missing page acknowledgments kept review open; acknowledging every page produced reviewed-with-exceptions.
- R7 kept the byte content and matching acknowledgments of untouched pages with existing exceptions. Changing page 3 made its acknowledgment stale, invalidated a draft tied to the old text hash, and preserved fixture accepted history and medication-taking state. Reacknowledging page 3 restored reviewed-with-exceptions.
- R8 replayed an identical action once, rejected conflicting reuse of its ID, and rebuilt identical state from machine evidence plus events.
- R9 rejected cross-profile, cross-source, wrong-source-hash and stale-base inputs without new durable publication.
- R10 injected interruption after durable event publication but before derived-text publication. Rebuild recovered the new text version, and replay did not apply the correction twice. This was a declared injection boundary, not an operating-system crash experiment.
- R11 faithfully stored a deliberately wrong transcription and page review acknowledgments. A separate comparison against the previously frozen source-author literal returned accuracy failure. Review attestation therefore remained distinct from objective source accuracy.

Independent pre-use review found a real defect before the primary run: the first edit normalized unresolved-reason strings on all pages, needlessly invalidating acknowledgments on untouched pages. The old code/declaration remain preserved; the final version updates only the affected page, and R7 now checks untouched page bytes and current page hashes. No failed primary result was replaced.

The original E2 automatic full-contract failures remain failures. This workflow was not rescored as successful automatic extraction, and no untested visual fallback was assumed. The original D1 request remains unknown, with its ledger bytes verified unchanged. Review statuses are revision-bound attestations (`open`, `reviewed-with-exceptions`, `reviewed-no-known-exceptions`), not proofs that every mark was transcribed. Medication-taking and accepted-history assertions concern test fixtures only; production session authorization, encryption, clinical proposal regeneration, accessibility and user effort remain untested.

## Independent human-review mechanics result verification

AGREE within the declared offline scope. The verifier independently reran the exact v5 eleven-case command in a fresh external output directory. All eleven mechanics cases passed; the resulting receipt is structurally identical to the primary receipt. Zero provider, OCR or credential calls occurred. All declared source, oracle, core and prototype hashes still match. The original failed D1 ledger remains byte-identical.

A separate verifier script, importing neither the review reducer nor the runner's test scorer, also re-derived the primary result directly from original bytes, machine/derived envelopes and immutable events. It checked 24 event envelopes and 22 retained text versions across the eleven cases: checksums, sequential review revisions, base/after text-hash continuity, source/profile binding, actual correction before/after wording, superseded guess removal, unchanged unrelated pages, current acknowledgment digests, and unchanged fixture medication-taking state and accepted history. R9 retains zero events after the rejected inputs; R10 retains exactly one correction event and text revision 2 after recovery/replay.

The wrong-human control is intentionally an accuracy failure. The source says “A second copy remains with the records office.” The scripted reviewer instead entered “A second copy was destroyed by the records office.” The wrong wording and all three page acknowledgments persist, while separate source comparison returns false. The observed workflow state is reviewed-with-exceptions, not a claim of perfect text. Correctly recording an attestation does not prove the attestation true; not-text classifications and full-page acknowledgments have the same limitation.

The previously reported pre-use unrelated-page invalidation defect is repaired in the tested bytes. R7 now uses pages with existing exceptions, changes another page, and confirms unchanged page content and still-valid acknowledgment digests. The earlier source/declaration snapshot remains retained. No original or partial experimental result was replaced.

This validates finite source-review mechanics, not a rendered rotate/zoom UI, real human discovery/accuracy/effort, production authorization/encryption, automatic clinical regeneration, or complete extraction. Recovery uses a declared interruption injection and reconstruction from durable artifacts; it is not an operating-system power-loss experiment. Medication/accepted-history checks are fixture-level only. Existing E2 full-contract failures, untested visual fallback and the blocked clinical comparison remain unchanged.

Evidence: the frozen v5 declaration/source snapshot, primary receipt, independent human-review-v5-reproduction receipt, and human-review-independent-rederive.mjs with human-review-independent-rederived.json. Controlling plan SHA-256: `d3b42b7841fd386479012b496b6432471f479b9edf3ad86d237e6c378cf4c104`.

## Independent scoped completeness review of the owner steering

POSITIVE for the revised, bounded scope: document practical and technical limits, distinguish favorable from expected input classes, preserve requirements and historical failures, propose human source review, and execute independently checked finite mechanics tests. This is not a positive end-to-end importer qualification or completion of the original clinical campaign.

The public practical-strategy document supplies ten explicit limit assessments with disposition, technical/practical distinction, best-case/expected inputs, fallback and revisit criteria. It does not infer universal tool failure from failed prototypes, erase the complete-text outcome aim, confuse deferred security implementation with impossibility, or accept universal abstention as useful automation. Supplemental remembered information remains distinct from source transcription. The source-review proposal preserves originals and machine versions, located exceptions, human correction lineage, distinct not-text/unreadable/later actions, full-page acknowledgment and downstream revision invalidation. Source review cannot change medication-taking state.

The eleven-case prototype result has been independently reproduced and directly checked against raw event/version artifacts. A material acknowledgment invalidation defect was found and fixed before execution with the earlier package preserved. The deliberately wrong human correction correctly fails independent source truth despite valid recorded review actions. Thus the added experiment extends the evidence with recovery, correction and review-state mechanics without converting old automatic failures into successes. The current public primary entry accurately labels the original independent-verification-pending point and its later verification can be appended.

Remaining open work is material and explicit: actual human/UI discoverability, usability, accessibility, transcription accuracy and effort; production security/background/recovery integration; qualified visual fallback; useful clinical comparison; and accounted service execution. The old D1 request remains unknown and no live continuation is cleared. No objective universal or end-to-end strategy winner can be selected from this scoped result. Further tests should resolve a declared product decision rather than manufacture a positive overall grade.

## Detector composition study: owner authorization and prospective vetting — 2026-09-26

The owner authorized testing error detection followed by simulated perfect human repair, and using subagents to compose vetted components. The [detector study](import-processing-detection-experiments.md) records role-specific exclusions: the tested native-only, OCR-only, literal-union-complete and E1/E2b variants failed as sole complete-text routes on their tested sources. This does not retire useful native/OCR readings, disagreement signals, geometric evidence or correction mechanics. Confidence alone cannot certify completeness. No clinical topology is eliminated by the unrelated transport failure.

A candidate author and a separate fixture author proposed complementary combinations. The latter disclosed its prior brief/interface exposure and did not read the new detector implementation; this is independently reasoned advice, not a statistically independent or fully unanchored design. Their proposed comparison is a confidence baseline, a lean confidence/disagreement union, successive additions of uncovered-ink coverage, structural context and a correlated local reread, plus no-repair and full-source review controls. Exact admission awaits code/scorer/source review; no result is claimed by this declaration.

The prospective physical corpus is six new fictional two-page PDFs. It includes clean controls, raster and rotated type, image-only marginal annotations, decimal/negation detail, cross-page table associations and sources for separately injected shared-error challenges. The maximum proposed local OCR matrix is twelve pages at two settings, twenty-four serial calls total, using the previously pinned engine and image. Source, command and candidate freezes plus independent review must precede the sole operator's dispatch. A second setting is correlated OCR, not a qualified independent visual-model auditor. No provider request or old-clinical-run continuation is authorized by this offline declaration.

Natural errors and injected adversarial errors must remain separate. The detector commits edit targets and visible context before the scorer uses source truth. Perfect repair is confined to that scope, including sufficient visible evidence for relationship changes; it cannot repair unseen errors or invent absent source information. Report whole-document remaining errors and hypothetical false clearance after the queue is exhausted even if a candidate avoids making a completion claim. Charge the union of all displayed context, not only target crops. All prior recordings and unknown costs remain unchanged.

## Independent detector-study design and source review

The eight-composition design is a bounded prospective comparison of detectors over one fixed native-first/PSM3 candidate, with a conditional source-reader repair model. It does not compare every extraction-plus-review composition, qualify an independent visual model, prove real human accuracy/effort, or resume the clinical request. The six fresh two-page sources share 24 proposed local OCR invocations across all compositions. Implementation intent is acceptable; execution is not yet cleared.

Reviewed design hashes: plan-v3 `e7d0681ed32dfd80bafd0f83d9b1d4df79e52957c8f631fa8cf3131d309fe10f`; API-v3 `e7da77724e9472ebc61acffa6a4e5887592bbf222c365c58bd1b002823107d28`; fourteen-controls-v2 `ed0153c901ae1cbf4dead34b1662ec8ce9b71059965d75858e72bc687b34d215`. Material clarifications were made before implementation/scoring: physical word-level repair loci, segmentation/occurrence conservation, meaningful partial order, actual versus hypothetical clearance, explicit legitimate source exceptions, separate target/context unions, and role-specific retention of useful previously failed components.

All 12 actual rendered pages were visually inspected. They contain sparse, deliberately typed challenge/control material (101–146 words per two-page document), not a representative clinical population, long-document density test or handwriting study. Independent source/oracle audit finds 706 readable tokens in 121 logical spans, 119 acyclic meaningful-order edges, 264 complete positive/negative table constraints over 16 cells, one opaque unknowable area and one non-text mark. All 706 physical token loci contain rendered ink; decimal, negation, rotated text and raster-margin loci were inspected against images and drawing metrics. A pixel sanity check is not OCR or proof of perfect bounding boxes.

Pre-use source review corrected a generator-order mismatch and replaced arbitrary total table serialization with a partial-order graph. It also repaired relationship support sets that initially omitted relevant distinct-table evidence and required unrelated or oversized blank context bands. V5 truth uses source-specific visible loci and admissible local supports; earlier oracle versions remain retained. Support sets remain explicit operational assumptions, with append-only review required if an unforeseen source-sufficient alternative is demonstrated. Original PDFs/renders remain unchanged.

The independent structural audit is preserved as detector-source-preuse-audit.mjs/json; its initial local helper mistakenly overwrote a page-qualified ID during object spread, was corrected, and is retained as initial-parser-bug. This was a verifier helper error, not a source-oracle failure. Two prior one-line read-only inspection commands also had a syntax error and produced no measurement.

Candidate/scorer implementation still requires exact pre-use review and controls. Preliminary review identified a FULL baseline incorrectly depending on PSM11, nested manifest/observation contract gaps, within-line order/occurrence matching issues, literal-dependent structural false failures, and overbroad accounting of useful target area. No fresh scored result exists yet; fixing those before execution does not regrade an outcome. The OCR runner now records and verifies owned-container termination on failure rather than claiming the CLI timeout itself kills the engine. Final candidate/scorer hashes, matrix, oracle pins and root launch clearance remain required.

## Offline detector/conditional-repair control result

The frozen synthetic package passed fourteen controls plus nested physical-manifest rejection, OCR observation binding rejection, and a restricted Node oracle-sentinel denial. This tests scorer/scope mechanics, not fresh extraction quality, detector recall, actual correction, real human performance, clinical interpretation, or production UI/security.

The first declared run passed fourteen controls but failed its isolation-child output write because the initially nonexistent output directory needed an explicit descendant grant. That overall run was not passed; its partial receipt and stderr remain intact. Version 2 changes only that child write grant and the prospective runtime command template, then passes the whole package. No detector/scorer threshold changed from the pre-source freeze.

Controlling declaration: declarations/detection-repair-executable-v2.json SHA256 cef628ea67eec2237d5fa5c52f3bcc7aeae0eb61897573a853b9ae07792800d9. Its code/document pins and snapshots/detection-repair-candidate-v2 identify the exact implementation. Version 1 declaration and snapshots remain preserved.

Primary command from the isolated worktree (portable rendering: `ARTIFACTS` denotes the external evidence root):

`node src/scripts/composed-import/review-detection-controls.ts "$ARTIFACTS/declarations/detection-repair-executable-v2.json" "$ARTIFACTS/detection-repair-controls-v2"`

Terminal receipt: detection-repair-controls-v2/receipt.json SHA256 0d92316a457ebb4c6ea99a9b99a06e10fd157c1baee39822c2f82e1b0921309d. Fourteen cases passed; provider calls 0, OCR calls 0. Full npm format:check and npm run typecheck passed before the initial run; the v2 delta is one formatted launcher argument.

Per-case observed outcomes: T01 split/merge literal equivalence and token repair; T02 one-to-one repeated occurrences and duplicate extras; T03 wrong negation/decimal; T04 missing administrative wording; T05 extra guess; T06 correct unreadability versus guess; T07 six positive/negative table association types independent of table ID spelling; T08 meaningful partial order plus within-line sequence; T09 exact target/context unions and 0.99 unnecessary-area lower bound for one 0.01-area error in full-page review; T10 distant context containment; T11 context does not grant edit scope; T12 alternative complete support; T13 empty flags retain errors and an absent structural endpoint stays unresolved; T14 FULL source-visible repair bound with explicit unreadability, FULL without reread, and conservative parent-span target expansion.

Controls specifically exercise C/FULL and shared scope/repair mechanics. Utility of proposed V/D/S/L alarms is not established by these tests and awaits finite fresh outcomes. Whole native-span bounds for extras are conservative; unresolved physical dependencies cannot prove success or alone falsify a composition. Conditional constraint repair does not generate a verified corrected document.

Original D1 ledger remains SHA256 f725ad67a44e9689265d2aff22626ee94ee92a9a7a04a2995d8a75ec1e112dd3; this package neither waives nor resumes that unknown-usage stop. Fresh source/OCR/batch evaluation remains separately gated. Independent result verification is pending.

## Independent detector admission-control result

PASS within the declared synthetic-mechanics scope. The exact executable-v2 declaration, SHA-256 cef628ea67eec2237d5fa5c52f3bcc7aeae0eb61897573a853b9ae07792800d9, was independently rerun against the frozen code in a fresh verification directory. All fourteen controls and the nested-manifest, observation-binding, denied-oracle-access and partial-containment checks pass. Primary and independent receipts are deeply identical. No provider or OCR request was made.

The first v1 run is retained: fourteen scorer controls passed, then the restricted child could not write its receipt under the initially nonexistent output directory. The v2 amendment adds only the explicit fresh-output child write grant; it changes neither detector nor scorer. The failed v1 boundary was not called a pass.

A separate independent synthetic probe checks actual V/S/L wiring on the unchanged frozen detector: blank raster produces no V scope, one known ink patch produces one containing V scope; empty layout produces no S scope, a two-by-two grid produces one S scope with explicitly charged whole-page context; equal reread text produces no L scope, differing text produces L scopes, and absent audit observations report unavailable. Probe source and receipt are preserved. These checks establish physical dataflow and scope mechanics, not detection recall, real engine independence, fresh-source quality or human effectiveness.

All fourteen scoring controls use fictional synthetic content. Fresh OCR and the maximum eighty composition outcomes remain unexecuted at this receipt. The code is eligible for the prospective bounded fresh comparison after root approves its exact matrix and dispatch declaration. No global strategy winner, clinical completion, resolved D1 cost or production security change is implied.

## Independent final local OCR declaration review

The exact final OCR declaration v4, SHA-256 fb1b10757908fb3bea762b015c1a961e4326fc179c64802a23b6255b8e4b9167, is independently cleared for root approval. All 26 embedded path/hash pins and ten candidate code/document map pins match. The 24-command matrix is byte-for-byte unchanged from the reviewed v2 matrix: six fictional two-page sources, PSM3 and PSM11, one call per setting/page, serial, no retry. The candidate freeze binds executable-v2 and the independently passed control receipts. Reviewed physical sources/oracles, builder, recipes and owned-container failure handling remain pinned.

Only the designated fixture author may dispatch this matrix, after root supplies the exact approval file and launch message. Each process uses the pinned offline image, no network, render-only read mount and bounded resources. Any error stops further dispatch and requires terminal/unknown accounting of the owned container. A killed operator process is not claimed to be automatically recoverable. No provider, authentication, clinical D1 continuation or OCR verification rerun is authorized.

This is pre-use clearance, not an execution result. Independent verification will read all returned commands, exit states, raw TSV hashes, lineage and cumulative calls after terminal completion. Detection/scoring remains a separately frozen offline phase and may not revise candidate parameters from fresh outcomes.

Coordinator authorization: after reading this exact declaration and independent clearance, the coordinator approved only the twenty-four declared local OCR calls for the designated sole operator. Detector/scorer parameters remain frozen; this authorization is not a measured quality result.

## Primary detector-study OCR operation — 2026-09-26

The sole operator completed all **24 declared local OCR calls**, six fictional documents × two pages × PSM3/PSM11, with zero failures or retries. The controlling declaration remained `fb1b10757908fb3bea762b015c1a961e4326fc179c64802a23b6255b8e4b9167`. The run began at 20:00:28.597 UTC and ended at 20:00:39.594 UTC. Measured subprocess duration was 10.928336791 seconds; measured operator-run duration was 10.996313625 seconds. These exclude fixture creation, native extraction/render preparation, later detection/scoring and human work.

All calls used the pinned Tesseract image, `eng`, TSV output, 144-dpi input, serial execution, network disabled, one CPU/thread and 1 GiB memory. The declared 120-second per-call timeout was not reached. Provider calls/tokens for this operation are zero; local infrastructure dollars are unpriced. PSM11 remains a correlated same-engine reread. Exit zero establishes execution, not accurate text or effective error detection.

The raw manifest hash is `5805bc785b01cec7f7f6594443bc5f7e2a811f0d00ee0490aa24eef0acf8ef75`. Evidence: `detector-ocr-primary-terminal-v1.json`, all twenty-four immutable attempt/terminal receipts and raw TSV/stdout/stderr. Independent terminal verification and the separately gated offline comparison follow; no new strategy winner is claimed here.

# Independent local OCR result verification

PASS for the exact frozen local execution and observation conversion. All24 attempt commands match declaration-v4; each has exit0, no signal/error, a terminal engine receipt, and matching raw TSV/stderr hashes. The recorded intervals are serial. Exactly24 attempt files exist; no retry or verification OCR was run.

Independent raw TSV reconstruction agrees with all1,420 retained word observations:710 under PSM3 and710 under PSM11. Text, span IDs, normalized pixel geometry, order, confidence, line IDs and every below60 located exception match the published artifacts. These equal counts do not imply equal text or correctness. Source quality is assessed separately against the held source truth.

Summed subprocess elapsed time is10,928.336791ms and recorded OCR-run elapsed time is10,996.313625ms. Both exclude source construction, native/render preparation, later detector/scorer work and human effort. This offline matrix made zero provider calls; local compute dollars are unpriced. The original D1 unknown-cost ledger hash remains unchanged. Same-engine settings remain correlated evidence, not an independently qualified visual audit.

The independent audit source and cell-level receipt are preserved as detector-ocr-independent-audit.mjs/json. No OCR process was launched by the verifier.

### OCR reproduction details

The retained operator command, with the external evidence root rendered portably as `$ARTIFACTS`, was:

`node "$ARTIFACTS/detector-local-ocr-v3.ts" "$ARTIFACTS/detector-ocr-declaration-v4.json" "$ARTIFACTS/detector-ocr-root-launch-v1.json"`

Pinned engine image: `sha256:8d784a58d02c25943b7c7b785d557b94827c493d22b6d29ee1f2dc0d511ed568`; entrypoint `/usr/bin/tesseract`. Each call used the same 1224×1584 render, PSM3 then PSM11 per page, `OMP_THREAD_LIMIT=1`, read-only filesystem, 128 MiB temporary filesystem and render-only read mount. The output bound was 16 MiB. The natural physical-input manifest is `ee3430473e7868c378686b263e5bba733b31ae4ed183d290debb1a6a57804d47`. Full operator recording and per-call commands are retained as `detector-ocr-portable-primary-recording.md` and the immutable attempt receipts.

# Six-primary phase execution

All six restricted local primary jobs completed with exit0, no signal and no timeout. There were six dispatches and six terminal events, no retries, zero OCR and zero provider calls. This is an immutable common candidate handoff, not a source-quality result.

Normalized command from the isolated worktree:

`node src/scripts/composed-import/review-study-run.ts "$ARTIFACTS/declarations/detector-study-primary-v1.json"`

The actual artifact root is preserved in the exact declaration and raw dispatch journal. The declaration SHA256 is b4279437520bd76ac0bdb3e096b6be50e3fcb06d35ba426acc44ca5fb706dc5a; it binds frozen code, input, external sentinel, six jobs, fresh output and300000ms per-child cap. Candidate/scorer policy remains the pre-source freeze.

Input array SHA256 ee3430473e7868c378686b263e5bba733b31ae4ed183d290debb1a6a57804d47. Saved six-primary input array SHA256 6f3aecd2afb4c21ba7ab9c4234f83defea5e18de7b48950913151f40d662b462. Phase receipt SHA256 a9f9cadf199c559a0e3fac6bd9a23b7940016b388b770018dba3ec08c09c5c14; append-only attempt journal SHA256 b9944b2e69da03407cfb99db6e9b4fcd114d1236290389976f524e0ae16ec50c.

Measured child elapsed milliseconds in dispatch order: 639, 197, 191, 199, 174, 167. Sum 1567ms. These include local process startup and I/O and are not human review time or provider latency.

Each child required an oracle-sentinel access denial before reading physical input. Original D1 ledger remained unchanged by the phase. Exact child output and stderr receipts are preserved. This controlled harness test does not qualify a production privacy/security design.

The fixture author receives only the saved primary-input array for the separately pinned mutation builder. No source oracle or semantic quality scoring was opened in this phase. Next steps remain the author-only copies, every detector scope frozen, then a separately pinned scorer mapping and conditional constraint-repair model. Natural and injected results must remain distinct.

# Independent six-source primary verification

PASS for frozen P0 construction. An independent script, importing neither candidate nor scorer, reconstructed native-first selection, geometric native overlap, the confidence threshold, located uncertainty and ordering from the original physical inputs. All six reconstructed artifacts exactly match the six published P0 files and hashes.

The journal records six serial child attempts, all exit zero with no signal or timeout. All six children report denied access to the external oracle sentinel. The exact read grants contain physical inputs and frozen code/dependencies, not author oracles or mutation recipes. Raw stdout/stderr hashes match. Summed child elapsed time is 1,567 ms; this excludes preparation and later mutation/detection/scoring. Zero OCR/provider calls occurred.

This verifies the shared baseline, not its extraction quality. No source truth was used for this reconstruction. The direct audit source and per-source JSON receipt are preserved as detector-primary-independent-audit.mjs/json. All six natural artifacts remain immutable inputs to the separately declared copy-only adversarial construction.

## Preserved adversarial-construction invocation no-op

The first declared builder invocation exited zero with empty stdout and created neither runtime copies nor the private construction receipt. Node resolved the script through the canonical temporary-directory path, while the script's entrypoint guard compared the noncanonical argument path; the guard never invoked construction. This was not a successful construction, failed recipe, or quality result. The original command and no-op receipt are preserved.

A separately reviewed command-only v2 amendment uses the canonical script path. Builder, recipes, physical inputs and output paths remain unchanged; no recipe has been retried or selected from observed outcomes. The amended declaration is `db81975c48469a0e3fe1518a3def01da78f96ac2c629f626cc60c7170d863cd0`; the retained no-op receipt is `ee12cf073753642ffa10fcf926091f10f03c69b375685c71a5b495e1a7b3bace`. Terminal construction and independent verification follow separately.

## Primary adversarial construction terminal

The command-only v2 invocation completed all four predeclared challenges, with zero failed or inapplicable recipes. Together with six unchanged natural copies, it produced ten opaque runtime samples. Actual construction took 0.062108667 seconds; the earlier no-op's 0.136977416 seconds remains separate overhead. Neither invocation made OCR or provider calls.

Runtime-manifest SHA-256: `a4d49e012d71fdb6bce5b92a2c7174200d6a3d9b4657562ed662f2de24b95e2b`. Private lineage receipt: `0f157bf40a98a9940a52a9246eac945146c6b2ed9666af6877f19fbd1a8cd321`. Exact source identities and per-view mutations remain in the external immutable terminal record. This is construction accounting, not detection success.

# Independent adversarial construction verification

PASS for copy isolation and the four predeclared injected challenges. Independent replay of every private before/after lineage event, without importing or rerunning the builder, reproduces every delivered primary/native/OCR/confidence view exactly. All six natural copies remain identical. All four challenge statuses are constructed; none failed or was inapplicable. All 150 checked file pins match, and original PDF/render bytes remain unchanged.

The shared wrong-word case makes four replacements and no insertion. The shared omission removes five spans from each of P0, PSM3 and PSM11; native text already lacked that raster annotation. The wrong-table case changes two existing primary table metadata records. The invented-extra case adds one word per view, four total. These are explicitly injected challenges, not natural engine error frequencies. All other text, geometry, confidence and uncertainty changes are accounted in retained lineage.

The ten runtime inputs use the same physical-only schema and opaque artifact path scheme. Classification, recipes and private mutation lineage remain outside detector grants. No quality score or oracle relation is supplied to the detector.

The initial invocation exited zero without entering construction because its /tmp script-path comparison did not match Node's canonical /private/tmp path. It produced zero recipe attempts or outputs; its 0.136977416-second overhead is retained. The separately reviewed command-only correction invokes the unchanged builder at its canonical path, producing the four declared outcomes. No anchor, detector, scorer, recipe or input changed, and no construction outcome was retried. Zero OCR/provider calls occurred. Direct audit source and JSON are preserved as detector-mutation-independent-audit.mjs/json.

# Frozen detector scope execution

All ten restricted local detector jobs completed with exit0, no signal and no timeout. They produced exactly 80 frozen policy scope outputs (eight for each source/copy). There were ten dispatches and ten terminal events, no retries, zero OCR and zero provider calls. No source truth was opened or quality-scored in this phase.

Normalized command from the isolated worktree:

`node src/scripts/composed-import/review-study-run.ts "$ARTIFACTS/declarations/detector-study-scopes-v1.json"`

The exact declaration is SHA256 b9d47b455edf2331d709c0be674459fe983b28889133bdc9ff393e18bf1f1f6f. It binds the unchanged pre-source candidate/scorer/controller, opaque physical input a4d49e012d71fdb6bce5b92a2c7174200d6a3d9b4657562ed662f2de24b95e2b, ten jobs, fresh output, external sentinel, old D1 pin and300000ms child deadline.

Complete scope-freeze SHA256 a6a5310a94ea94f94244aaed6073bc076d0d015074a0ec2c8a879c13a65ffa9f; receipt 874bcd95374da8a5b2b6a8409e0c7572ccd1828978a36f64ef8fe70b148adeff; append-only dispatch/terminal journal e4a63bf7e2b5ae031e302f9fe3b5f53d0239e0a016f96067da4e47009397919d. Each scope-freeze entry pins common primary bytes and all eight detector outputs. These were saved before the separate scorer-only map was made available.

Measured child elapsed milliseconds in dispatch order: 396, 209, 197, 198, 209, 195, 200, 198, 195, 196. Sum 2193ms. This includes local startup/I/O and detector computation, not human time. Every child requires the external oracle-sentinel denial before physical input; native canvas is a trusted allowed addon, so this does not qualify production sandboxing.

Original D1 ledger remained unchanged. No policy or parameter changed from the source-blind freeze. Scope selection alone emits ready/unavailable, not an extraction-complete status. Detection recall, residual errors, conditional repair and review burden are unassessed here; the forthcoming one-child scorer must preserve all80 outcomes and separate natural from injected sources.

### Portable construction invocation

```sh
CANONICAL_BUILDER=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$ARTIFACTS/detector-adversarial-builder-v3.ts")
node "$CANONICAL_BUILDER" \
  "$ARTIFACTS/detector-study-primary-v1/primary-inputs.json" \
  "$ARTIFACTS/detector-physical-v2/author-only-v5/injected-recipes-v4.json" \
  "$ARTIFACTS/detector-study-runtime-v1" \
  "$ARTIFACTS/detector-physical-v2/author-only-v5/mutation-construction-receipt-v1.json"
```

This portable rendering resolves the same canonical script path used by the reviewed command; it is not an additional executed construction. The exact command remains in declaration-v2.

# Frozen detector and conditional-repair comparison — primary result

All80 predeclared outcomes completed in one scorer child, exit0 without retry, signal or timeout (1326ms). Zero OCR/provider calls in scoring; source acquisition was the separately recorded24 local OCR calls. The immutable source-blind policies and source truth were unchanged. Independent result verification is pending; this report records primary observations.

Only FULL meets the all-document finite source-visible fidelity floor in the original crop-restricted repair model. That is a conditional source-reading upper bound, not actual corrected artifacts or human success. Natural six-source P0 already meets the floor on one source with no repair. The best targeted ladder reaches3/6 natural and2/4 injected sources. CVD is useful prioritization; S adds repairs with much larger displayed context, and L adds burden without additional repaired constraints on these exposed sources. These are scoped role results, not global strategy exclusions.

The decisive limitation is target permission, not absent visible evidence: every CVDS residual is target-only, with a complete admissible support set already within displayed context. Natural residuals are3 literal,3 order and161 table constraints; injected residuals are1 literal and161 table constraints. All161 table misses occur on one natural source and its injected copy, with2 whole pages displayed but only~0.252 page-equivalents editable. A broader editable-page workflow is not rejected by these results. The original grades remain intact; testing context-editable scopes would be a separately declared exploratory composition.

This comparison holds deliberately limited P0 fixed and scores its absent relationships. It cannot establish the best full extractor+review system or reject useful partial structure from other components. Relation pairs are correlated constraints, not independent documents; literal substitution and extra-word categories can describe the same occurrence from different sides. No clinical safety outcome is inferred.

Natural results (six documents,12 pages), each showing finite-floor docs; residual docs; target/context union page-equivalents:

- NONE: 1/6; 5; 0.0000/0.0000.
- C: 1/6; 5; 0.0083/0.0415.
- CD: 2/6; 4; 0.2556/0.9590.
- CV: 1/6; 5; 0.5739/1.6021.
- CVD: 3/6; 3; 0.8169/2.4931.
- CVDS: 3/6; 3; 1.1029/8.6993.
- CVDSL: 3/6; 3; 1.1161/8.7010.
- FULL: 6/6; 0; 12.0000/12.0000.

Injected results (four copies,8 pages; deliberately artificial errors, never pooled into engine error rates):

- NONE: 0/4; 4; 0.0000/0.0000.
- C: 0/4; 4; 0.0008/0.0065.
- CD: 0/4; 4; 0.0592/0.2330.
- CV: 1/4; 3; 0.5311/1.4531.
- CVD: 2/4; 2; 0.5887/1.6751.
- CVDS: 2/4; 2; 0.7156/4.7034.
- CVDSL: 2/4; 2; 0.7204/4.7051.
- FULL: 4/4; 0; 8.0000/8.0000.

The complete endpoint/burden vectors are preserved in aggregate-endpoints-and-burden.json: initial/repairable/residual/unresolved constraints by type; target/context unions; full targeted/displayed pages; distinct context pages; exposed candidate-character upper bound; and correct/nontext target-area lower bound. Original per-error containment witnesses remain in scored/results.json. Only NONE/C/CD on one injected omission retain two unresolved order dependencies; these are not called demonstrated wrong order. All other remaining failures are explicit residual constraints. One genuine source exception is preserved in each cohort; FULL never invents unreadable wording or emits complete-extraction status.

HypotheticalFalseClearance counts equal residual document counts here, under the declared policy that resolving all selected review work permits readable-fidelity clearance with explicit exceptions. It is not an actual app status. Union page area is a review burden proxy, not human time. A page merely shown as context is not editable under this original protocol.

Normalized command: `node src/scripts/composed-import/review-study-run.ts "$ARTIFACTS/declarations/detector-study-score-v1.json"`. Controlling declaration SHA2564ed7147ca517fdc4fe37489ad7ffa238782151334d1cc9d2661a3012923ab39d binds exact scorer map14ad3ab0fe0e0738f1784ef0fe94b7f89269e09383bfc228faae740d8208425c, prior whole-scope freezea6a5310a94ea94f94244aaed6073bc076d0d015074a0ec2c8a879c13a65ffa9f and unchanged code/D1 pins. Raw results SHA256c02d47ff107e33c7543452da4e387e8f3397a91066bdcc95a951e1cbb97f7105; phase receiptb81792f79f543b949cf05f88af6a6bb03dbbc77fa734cc7330fe8f7f2ea6d296. Original D1 unknown remains unchanged and no live continuation occurred.

# Independent verification of the original 80 outcomes

PASS for execution and the declared target-only conditional-repair model, with a material interpretation limit. All 80 original outcomes are retained. Ten restricted detector children and one scorer child exited zero without retry; all detector sentinels denied oracle access. Independent in-process reproduction exactly matches all ten detector outputs, and a full independent scorer replay exactly matches all 80 results. Primary detector child elapsed time totals 2,193 ms; the scorer child took 1,326 ms. These exclude earlier preparation, OCR, P0, construction and verification work.

This review goes beyond replay. A separately written augmenting-path occurrence matcher agrees with every initial literal/extra count. Natural inputs contain seven unmatched source tokens and six extras; the native-first table baseline authors no table links, explaining its 264 unmet pairwise relationships. These relationships are correlated constraints on one document, not 264 independent clinical examples. An independent rectangle-subtraction implementation checks all 23,232 evaluated constraints, source-support visibility, edit containment, target/context union areas and aggregate counts. Same-P0 initial results agree across every arm, and the nested C → CV → CVD → CVDS → CVDSL masks, burden and modeled repair outcomes are monotonic.

The original finite quality-floor counts for NONE, C, CD, CV, CVD, CVDS, CVDSL and FULL are respectively 1, 1, 2, 1, 3, 3, 3, 6 of six natural documents; injected counts are 0, 0, 0, 1, 2, 2, 2, 4 of four challenges. FULL alone passes every source under this target-only model. CVDS and CVDSL have identical residual-quality counts; L adds review area without improving those endpoints on this corpus. This does not establish the same-engine reread's universal uselessness.

CVDS targets 1.102910 natural page-equivalents while displaying 8.699319; CVDSL targets 1.116059 while displaying 8.700999. FULL targets and displays 12. Injected figures remain separate. Areas are not measured human time, workload, number of page visits or clinical performance. Actual detector outputs say ready/unavailable, not complete. False clearance is hypothetical under the declared queue-exhausted policy.

Material limitation: every residual constraint under CVDSL already has sufficient source support in displayed context. Failure is edit-target containment. The three natural residual token boxes are covered by selected targets at 99.8234% (Telephone), 90.4256% (entrance.) and 97.7318% (amendment.). The injected No locus is 96.9393% covered: its missing left edge is exactly the source oracle's 0.5-point padding, while V selects the underlying native line. These frozen geometric failures must not be described as proof the detector never found the word or a human could not correct it. Three remaining natural order constraints likewise have sufficient displayed support but incomplete target coverage.

The 161 residual table constraints arise from six endpoint cells not fully targeted; both original pages are already displayed. They are failures of the declared edit-permission rule, not absent source evidence. The shared omission under NONE/C/CD also has two unresolved order dependencies because its physical endpoint is missing. Those dependencies are neither demonstrated wrong order nor successful repair. All original scores remain unchanged.

The independently exposed limitation supports a separately labeled post-hoc exploration that promotes existing displayed context to editable review, charging the entire promoted union. It does not justify silently regrading this experiment, changing oracle boxes or claiming a heldout winner. Real people, adaptive discovery, UI consistency, actual clinical assembly and universal optimality remain untested. Original D1 unknown accounting remains unchanged; all present verification used zero OCR/provider calls.

Portable evidence is backed by detector-scopes-independent-audit.ts/json, detector-source-score-independent-audit.mjs/json, detector-repair-independent-audit.mjs/json and the preserved full scorer reproduction. Source truth, frozen parameters, original masks and original results were not edited.

# Context-editable review exploration — primary result

CVDS_EDIT is the best supported scoped candidate among the tested context-editable compositions under the perfect-source-reader model on these exposed sources:6/6 natural and4/4 injected samples meet the finite readable-fidelity/exception-accounting floor. It combines confidence, raster coverage, native/OCR disagreement, structural review cues and permission to edit every displayed source region. CVDSL_EDIT meets the same floor but repairs no additional constraint while displaying slightly more area. This supports omitting L from the next candidate on this evidence, not a general rejection of correlated rereading.

This is a separately declared post-hoc interaction-policy experiment, not fresh heldout qualification, actual artifact correction, real human performance, implemented UI or a universal optimum. The unchanged scorer still uses the same conditional perfect-reader assumption and strict geometric containment. Original80 outcomes and all previous failure grades remain intact. A deterministic transformation promoted only already displayed context rectangles to editable targets; it added no source pixels and did not use source truth to choose regions. All70 masks were written/hash-frozen before scoring opened pinned oracles.

Natural six-document results (12 pages); each entry gives modeled finite-floor documents, editable/displayed union page-equivalents, distinct pages visited and candidate-character upper bound:

- NONE_EDIT: 1/6; 0.0000; 0 pages; 0 characters.
- C_EDIT: 1/6; 0.0415; 4 pages; 40 characters.
- CD_EDIT: 4/6; 0.9590; 6 pages; 1237 characters.
- CV_EDIT: 1/6; 1.6021; 12 pages; 2308 characters.
- CVD_EDIT: 5/6; 2.4931; 12 pages; 3454 characters.
- CVDS_EDIT: 6/6; 8.6993; 12 pages; 3780 characters.
- CVDSL_EDIT: 6/6; 8.7010; 12 pages; 3780 characters.

Injected four-copy results (8 pages), reported separately from real extraction error rates:

- NONE_EDIT: 0/4; 0.0000; 0 pages; 0 characters.
- C_EDIT: 0/4; 0.0065; 1 pages; 9 characters.
- CD_EDIT: 0/4; 0.2330; 1 pages; 300 characters.
- CV_EDIT: 2/4; 1.4531; 8 pages; 2013 characters.
- CVD_EDIT: 3/4; 1.6751; 8 pages; 2297 characters.
- CVDS_EDIT: 4/4; 4.7034; 8 pages; 2590 characters.
- CVDSL_EDIT: 4/4; 4.7051; 8 pages; 2590 characters.

CVDS_EDIT compared with the original FULL bound: natural editable/displayed area8.6993 versus12 page-equivalents, but both visit all12 pages;8 versus12 whole pages are displayed and3780 versus4073 candidate characters are exposed. Injected area4.7034 versus8, both visit all8 pages;4 versus8 whole pages and2590 versus2883 characters. Area reduction is a proxy, not measured review time or effort; character reduction is much smaller. This run shared all24 acquisition OCR calls across arms, so no actual acquisition-cost saving was measured by this comparison.

CVDS_EDIT and CVDSL_EDIT retain one genuine source exception per cohort, with no residual readable-content errors or unresolved dependencies under the model. They do not claim all source text is legible or fully transcribed. CVD_EDIT leaves one table-association source failing in each cohort (225 residual table constraints); CD_EDIT covers natural literal/order errors but leaves required table/unreadable-accounting work, and does not handle the injected shared-error cohort sufficiently. The complete category counts and burden vectors remain in aggregate-unverified.json; per-error containment witnesses are in results.json.

The practical composed candidate is editable original-source review with C/V/D highlights and S-driven broader context, reusable durable text/correction provenance and explicit unreadable exceptions. Highlights prioritize work and must not be the sole clearance rule. The prior11-case review-mechanics evidence supports event/revision/proposal invalidation mechanics only; this experiment does not implement or validate a production review page. No clinical acceptance or medication-taking state follows from text review.

The next discriminating checks are fresh independent sources using this frozen interaction policy; integration with useful existing partial table/order adapters rather than only the deliberately weak P0; and a rendered review workflow with real participants or a separately specified human study measuring discovery, correction accuracy, missed unflagged errors and actual burden. Scanned/handwritten visual audit, background privacy/session authorization and clinical source-association gates remain separate unqualified work. No new test runs beyond this declared exploration are implied here.

Four synthetic transformation controls passed and were independently reproduced: visible-context edit permission, off-context refusal, cross-page/header support containment, and exact union/status/immutability. Full npm format:check and npm run typecheck passed for the two new isolated files. The original scorer and detector files were unchanged. Normalized command: `node src/scripts/composed-import/review-context-edit-run.ts evaluate "$ARTIFACTS/declarations/context-edit-evaluate-v1.json"`. Exact declaration SHA2564e220dbfc1e3358bb8d4e44cc8aae1d26f70dcb2e7fc55bb68e801a17659f6af. One successful70-outcome run, zero OCR/provider calls, no retries.

Derived mask freeze SHA25652a4cf6ec37c80a6ec49c7799f7d0f7f7c63671b04dc58010dcc18af325840d6; result SHA256a9acd7d073b0e6477a8134d626d28a023e150bbdf4b97922693b40e3e2bde5cc; receipt SHA2564699731bb4cf27b0d93253e1a76c7b5ad59761704ea73dedd17a912e6db710e5. Post-run external hash check confirms original80resultsc02d47ff107e33c7543452da4e387e8f3397a91066bdcc95a951e1cbb97f7105 and old D1 ledgerf725ad67a44e9689265d2aff22626ee94ee92a9a7a04a2995d8a75ec1e112dd3 unchanged. The script itself checks original results before and D1 before/after; this external check supplies the original-results after check. Independent result verification is pending at this recording.

Execution accounting limitation: full process elapsed was not instrumented. Saved artifact timestamps span3551.626ms from controlling-declaration write through terminal receipt, including transformation/mask freeze and all70 evaluations; this excludes process import/initial pin checks and final postchecks. It is not a human-work measurement. Exact timestamp evidence is in execution-accounting.json.

Control reproduction command: `node src/scripts/composed-import/review-context-edit-run.ts controls "$ARTIFACTS/declarations/context-edit-controls-v1.json"`. The four-control receipt is `caf921bf2410c550d23b2ffda2439e42a75cbb96c663b59fc8a39624dba816f3`. Independent verification follows as a separate entry.

# Independent context-editable extension verification

PASS within this separately declared post-hoc model. Four controls independently reproduce the primary receipt exactly: visible context becomes editable, outside-context content remains ineligible, cross-page relationships require the displayed source support, and overlap/empty/unavailable behavior preserves input bytes. The verifier used the same pinned control declaration with only a fresh output destination. Evaluation declaration SHA-256 4e220dbfc1e3358bb8d4e44cc8aae1d26f70dcb2e7fc55bb68e801a17659f6af was independently cleared after these controls passed.

All 70 derived outcomes were independently re-derived without importing the derivative transformer or scorer. Every derived target is exactly an original displayed-context rectangle; each derived context is the same original union. Every source, P0, initial constraint and support alternative agrees with the preserved original. An independent rectangle-subtraction implementation checks 20,328 constraint evaluations and all target/context union areas. No source pixels, oracle-informed scope expansion, source-specific tuning or new engine output were added. Original 80-result SHA-256 remains c02d47ff107e33c7543452da4e387e8f3397a91066bdcc95a951e1cbb97f7105; the original D1 ledger hash remains unchanged.

Natural finite-floor counts for NONE_EDIT, C_EDIT, CD_EDIT, CV_EDIT, CVD_EDIT, CVDS_EDIT and CVDSL_EDIT are 1, 1, 4, 1, 5, 6 and 6 of six documents. Injected counts are 0, 0, 0, 2, 3, 4 and 4 of four challenges. Natural and injected results are not pooled into an engine error rate. Among the tested signal combinations, CVDS_EDIT is the simplest that passes every exposed sample with less union review area than FULL; adding L changes no qualifying outcome and increases area slightly. This is a scoped candidate choice, not proof of a universally optimal importer.

CVDS_EDIT reviews and permits correction across 8.699319 natural page-equivalents versus FULL's 12, approximately 27.5% less area. It still visits all 12 pages and reviews eight whole pages. The exposed candidate-character upper bound is 3,780 versus 4,073. Injected copies require 4.703378 of eight page-equivalents, visit all eight pages, and review four whole pages. These unchanged page visits and text counts prevent interpreting area savings as measured time or effort savings. Genuine unreadability remains a visible exception.

The difference from the original scores is entirely the interaction policy: source already shown to the assumed-perfect reviewer is now editable. Original crop-only failures remain recorded. The extension uses exposed sources, so its success is exploratory rather than heldout qualification. A future editable-source UI, independently fresh sources and real humans still need their own tests; production integration, clinical context assembly and security/background behavior remain unresolved.

Zero OCR/provider calls were made for the extension or independent verification. All 24 actual shared OCR calls remain in acquisition accounting, even though L is omitted from the preferred candidate. The recorded artifact interval is not a measured human duration or full process wall time; uninstrumented preparation and local-dollar costs remain explicitly unmeasured/unpriced. Prior control-package failure and construction no-op remain preserved. No further experimental run is required for this bounded original-plus-exploratory study.

Exact primary commands, with the external evidence root rendered portably, are:

- `node src/scripts/composed-import/review-context-edit-run.ts controls "$ARTIFACTS/declarations/context-edit-controls-v1.json"`
- `node src/scripts/composed-import/review-context-edit-run.ts evaluate "$ARTIFACTS/declarations/context-edit-evaluate-v1.json"`

Independent evidence is preserved in context-edit-controls-v1-reproduction/receipt.json and context-edit-independent-audit.mjs/json. The independent calculation uses original saved masks and constraint witnesses, not the runner's aggregate summary.

# Final independent bounded detector-study review

**Completeness: PASS. Extended investigation: PASS.** This positive review covers the owner-authorized finite detector/perfect-repair comparison and its separately declared context-editable exploration: 24 local OCR calls, six frozen natural P0 artifacts, four fixed injected variants, 80 original outcomes and 70 post-hoc derived outcomes. All declared outcomes have actual terminal evidence and independent verification. No further experiment is required to complete this bounded scope.

I reviewed the current public detection decision, practical strategy addition and execution ledger against source/control/command/terminal records. I independently inspected the physical sources and truth before use, reproduced the controls and detector outputs, reconstructed OCR and primary artifacts, replayed mutation lineage, and re-derived source occurrence counts, geometric containment, all burden unions and the original/derived outcome vectors. This includes 23,232 original and 20,328 derived constraint evaluations. Material pre-use scorer/isolation/geometry issues were addressed before quality execution. The subsequent strict crop-boundary issue was preserved and tested through a distinct, charged interaction policy, not silently regraded.

The scoped conclusion is supported: CVDS_EDIT is the simplest successful tested signal combination with less modeled union review area than FULL on these exposed sources. It combines candidate text, confidence, coverage, reader disagreement and structural context with correction anywhere in displayed source context. It passes six natural documents and four injected challenges under the unchanged perfect-reader model. The same-engine reread adds no measured quality improvement here. Useful components are retained by role; failed completion variants do not condemn entire engine or architecture families.

The evidence does not establish a universal winner, fresh heldout qualification of the derivative, real human detection/correction accuracy, reduced human time, production UI behavior, completed clinical interpretation or security/background capability. The sparse typed fictional corpus contains twelve natural pages and 706 source tokens; injected copies are separate challenges rather than additional independent natural documents. CVDS_EDIT still visits every page. Full-source access, explicit source exceptions and future independent-source/UI/human studies remain appropriate.

Original and partial recordings are retained: the initial control package's restricted-write failure, the builder's zero-construction path-guard no-op and its 0.136977416-second overhead, all old grades and the original 80 outcomes. Known phase durations are reported with exclusions; absent full-process timing and local-dollar prices are not represented as zero. All 24 shared OCR calls remain counted. No provider call was made by this bounded study or verification. The old clinical D1 unknown-cost ledger is unchanged and is not completed, waived or automatically resumed.

The current public interpretation acknowledges padded-box target failures, correlated table constraints, displayed-versus-editable scope, hypothetical rather than actual clearance, and area versus page visits/reading effort. No material unresolved finding prevents this scoped positive review. Historical prospective passages are read as declarations, not current uncompleted execution requirements. Stop this bounded experiment here; retain the openly unqualified work for separately authorized future testing.

Reviewed public document hashes before this verification entry is appended:

- docs/import-processing-detection-experiments.md ead66488465bc3203026d25e9e07561a01f653879bb111bff1ccb205c49ee21b
- docs/import-processing-practical-strategy.md adf5975d57a919ba3a37afa3cd7cccd6dbd15d9c4f836a8ead22b67c709506e2
- docs/composed-import-experiment-results.md 44200dab38ebc4d428335efe9dcadfe474c74dc3a9b0da8181688ec20ca6793e

The derivative result receipt is context-edit-result-verification.md. The original result receipt is detector-original-results-verification.md. Their referenced independent scripts/JSON and immutable terminal artifacts provide the detailed reproducible evidence. This verdict is an execution/completeness assessment, not a scientific guarantee or a positive grade for the broader interrupted clinical campaign.

## Final publication reread

Re-read the updated current-status/role-shortlist prose and the appended derivative verification. The prospective comparison is now explicitly labeled completed, and the original pre-use gates are stated as satisfied. The final bounded PASS verdict is unchanged; no material publication finding remains. Current hashes before this final review is appended:

- docs/import-processing-detection-experiments.md cbc44241f7696b20d3a6dd1a12f698ff5ab52eab0b14f501237027a07395e621
- docs/import-processing-practical-strategy.md adf5975d57a919ba3a37afa3cd7cccd6dbd15d9c4f836a8ead22b67c709506e2
- docs/composed-import-experiment-results.md 90f363d760e4ba6314bfd7c2633c9c12ac4e75e82ce4255965805c4f89d7f768


## Evidence archive size — inventory on 2026-09-27

The surviving external experiment evidence roots referenced by the experiment documents and runner handoff contain **15,743,122,194 logical bytes (15.74 GB)** across **81,875 files**. This excludes prototype Git worktrees and their dependencies and is an inventory of located archives, not proof that every historical temporary artifact survives. Five referenced temporary paths were absent.

PDF files account for 45,725,311 bytes across 3,607 files; raster images account for 2,234,277,170 bytes across 1,934 files. These include rendered outputs and repeated copies, so they are not counts of unique input fixtures. Other files include experiment outputs, logs and runtime artifacts. F1 unit experiments account for 10.82 GB, F3 OCR for 1.94 GB, and F2 live processing for 0.89 GB.

The ten experiment/design/result Markdown documents in this branch total 1,301,891 bytes before this inventory entry. They preserve portable methods, criteria, results, failures, modeled projections and independent verification; they are not the complete raw replay archive. Reproduction requires the relevant fictional fixtures, prototype scripts and receipts from the external collection. Raw collections must be reviewed for runtime credentials and private material before sharing; they are not suitable for wholesale inclusion in Git. Sizes were measured by recursively summing regular-file sizes without following symlinks or reading file contents, with each top-level evidence root counted once.
