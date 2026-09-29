# Import processing: architecture hypotheses and discriminating tests

Design review, 2026-09-26, after the owner's complete-text decision. This is a proposed
implementation direction and experiment design, not a measured winner, implemented feature or
authorization for additional live tests. The [import specification](import-scenarios.md) defines
required behavior; [CRS-115](application-todo.md#crs-115) owns complete-text implementation and
verification status. Prior [experiment results](processing-follow-up-experiments.md) remain intact.

The subsequent [practical qualification and human-review proposal](import-processing-practical-strategy.md)
extends this composition with source-linked correction and explicit exceptions. It preserves the
complete-text aim and historical automatic-extraction failures; it does not select an implemented UI.

## Decision: a composed strategy set with clear shared contracts

The owner clarified that the result should be a composed strategy set: adapters and compatible
components selected for a source, not one universal winning strategy. The design below follows
that direction. Testing must establish component eligibility, compatibility, routing and fallback
behavior as well as individual component quality.

The requirements do not select a unique extraction engine, clinical context policy, batch size,
worker count or storage layout. Those choices are partly empirical and partly engineering
judgment. More independent agreement on a design is not experimental proof.

The requirements do strongly constrain the logical boundaries:

- Keep exact originals and source identity.
- Retain complete, located text durably, with explicit uncertainty and correction history.
- Keep machine interpretations and clinical proposals distinct from literal source evidence.
- Accept clinical records only through the person's review, preserving versions and receipts.
- Recover retained text and completed work without new AI extraction; operational caches and
  model conversations cannot be the recovery authority.
- Account separately for source inventory, text coverage, clinical interpretation and acceptance.

These are logical responsibilities, not a requirement for separate services, a particular number
of files, one giant transcript in every request, or a new parallel persistence framework.

## Independent brainstorm method

Three designers received the same task with fresh conversation contexts. They could read only the repository
guidance and customer specification for their initial proposals, not the prior strategy list,
experiment outcomes, source implementation or each other's reports. They propose a preferred
architecture, its strongest alternative, assumptions, failure modes and evidence that would change
their preference. All three independently reported reading only those two files, without source
inspection or external research. Their reports were completed before being shared with the test
designer; none received another designer's proposal before finishing.

This removes anchoring on the previous architecture proposals, but does not make the designers
statistically independent: they share requirements and model capabilities. Agreement is a useful
design signal, not an estimate of correctness. The coordinator separately checks integration seams
and previous findings after the initial proposals are written. The owner's explicit composition
clarification was added after the initial designs, and is binding on the synthesis and test plan.

### What the independent designers proposed

- **Designer one:** a durable evidence pipeline, bounded source scopes and a final document audit;
  whole-document multimodal clinical reading is the strongest alternative. Emphasizes replaceable
  extraction components, field-level source evidence and independent recovery authority.
- **Designer two:** complete text archive, bounded clinical tasks and document-level assembly;
  whole-document clinical context shares the same archive and safeguards. Emphasizes source
  assertions separate from record entities, table relationships and revision-aware review.
- **Designer three:** a durable evidence ledger with explicit semantic dependencies; a document
  actor with broad context and a working notebook is the strongest alternative. Emphasizes which
  evidence revisions each field depends on and targeted recomputation after later information.

All three favor similar shared boundaries. They differ most in how explicitly to model semantic
dependencies and how to assemble clinical context. This convergence supports a baseline to test,
not a declaration that a dependency graph or bounded clinical reader is objectively superior.

## Components and proposed adapter compositions

Keep these responsibilities independently testable and composable:

- **Source adapter:** inventory native documents, images, structured exports or package members;
  preserve original identity and enforce retain-only exclusions.
- **Text extraction and verification:** native extraction, qualified image transcription, or a
  mixed-page combination; commit complete located text and explicit unresolved regions.
- **Clinical context assembly:** a whole report when eligible, or bounded source scopes with
  report context and document-level dependency resolution. Both use the same retained evidence.
- **Execution policy:** serial or qualified parallel work, bounded requests, durable checkpoints,
  provider-wait handling and source-scoped retry. Context size and worker count are separate knobs.
- **Shared reconciliation and review:** source/identity checks, approved equivalence and conversion
  rules, immutable proposals/acceptance history and version-bound human approval.

Here, qualification means evidence on a declared corpus, not a certificate that an extractor
recognizes every readable word. Partial text can be committed while unresolved regions remain
visible; those regions prevent a complete-text status. Neither engine agreement nor confidence
alone closes them.

Initial compositions to qualify are:

1. **Native-text document:** native text plus visible-content/annotation reconciliation, additional
   image-region transcription where needed, durable text, then an eligible clinical context path.
2. **Scanned or handwritten document:** image transcription plus source-based verification and
   located uncertainty, the same durable text contract, then an eligible clinical context path.
3. **Mixed document:** choose extraction paths per page or region, combine their source-bound text
   without duplicated or missing coverage, and retain report context across those adapter seams.
4. **Recognized structured export:** deterministic parsing and validated proposals where supported,
   retaining source fields, narrative text and references through the shared evidence/review
   contracts. Unknown fields cannot silently disappear. No LLM is required merely for symmetry.
5. **Package:** retain the archive, route supported members through the above compositions, and
   preserve member/report/person scope. Unsupported and retain-only members receive explicit
   dispositions; no excluded format enters an AI reader as a fallback.

Routing records must explain their observed source characteristics, component versions, eligibility
checks and fallbacks. A source is not assigned to Self merely because an adapter recognized its
format. A failed quality check may escalate to another qualified extraction path or a located
exception; it cannot silently downgrade to summary-only retention. A changed transcript revision
must invalidate or re-review dependent interpretations without erasing accepted history.

Start with serial orchestration and the smallest qualified component inventory, while preserving
these adapter boundaries. Add alternate engines, clinical context policies and concurrency based
on demonstrated value. This is an incremental implementation order for a composed architecture,
not a request to choose one monolithic pipeline or benchmark every possible combination.

## Preferred starting hypothesis

Build a durable evidence pipeline whose clinical reader can be replaced without changing the
original, transcript, review or recovery contracts.

1. **Receive and inventory.** Commit exact originals, checksums and package membership. Inventory
   pages and visible source regions. Enforce format and identity boundaries, preserving exceptions
   while independent work continues. Check patient-labeled name and birth date before broad AI
   clinical reading wherever native/local text permits. A contradictory patient birth date blocks
   that file while others continue; a guarantor's date cannot substitute for the patient's.
2. **Extract and retain text.** Use native text or deterministic structured parsing where adequate;
   reconcile visible content and annotations, and use a qualified image-reading path where needed.
   Retain literal text, reading order and table relationships with source locations. Administrative
   text is included even when it yields no clinical record.
3. **Interpret source evidence.** Give the clinical reader verbatim passages and necessary images,
   evidenced report/person/date context and access to other source locations. Propose supported
   fields and unresolved associations. Do not ask it to reproduce the complete transcript merely
   to demonstrate retention.
4. **Reconcile and review.** Validate references and apply approved vocabulary/equivalence rules.
   Preserve source assertions and version relationships. Human approval targets a fixed proposal
   revision; later pages cannot silently rewrite an accepted record.
5. **Resume and retrieve.** Persist task results and publication receipts atomically. Resume
   unfinished work idempotently. Search and authorized assistant retrieval use retained text with
   its identity/review status, without presenting another person's evidence as facts about Self.

Ready source scopes can enter clinical interpretation before the entire document's text extraction
finishes. A final reconciliation must address dependencies on later pages. Pipelining is a choice
to test, not permission to accept unresolved clinical associations.

Every supported page needs an explicit clinical-reading disposition independently of text retention.
Selecting context cannot become a relevance filter that leaves administrative or repeated pages
unexamined. Deterministic interpretation is allowed for supported structured inputs; one model call
per page is not required. A region that could not be read remains an exception rather than a
fabricated no-findings outcome.

## Competing clinical readers

**Bounded scopes plus document assembly** is the starting preference. Read source scopes with
explicit neighboring/header context, record unresolved dependencies and reconcile across the
document. This offers small retry units and bounded inputs. Its main risk is a remote qualifier,
identity change or correction that no local reader knows to request. A final audit is another
fallible stage, not a completeness guarantee.

**Whole-document clinical context** is a credible competitor when the document fits the actual
route. It uses the same independently retained transcript and approval rules, but gives the reader
the whole report and necessary visuals. It may preserve distant relationships with fewer handoffs.
Attention failures, output limits, retries and large-context cost may offset that advantage.
Silently truncating a document or substituting a summary does not count as this arm completing.

**A routed combination** is part of the intended strategy set: use whole-report context where its
quality and actual route capacity are qualified, and bounded assembly for the scopes where that
path is qualified. The routing policy itself needs testing. Do not choose a page threshold before
measuring text density, visual complexity, output volume and association quality. If only one path
is qualified initially, the other remains unavailable rather than becoming an untested fallback.

Complete text retention does not require clinical understanding to be correct, and complete text
alone does not establish clinical completeness. Both layers need independent acceptance tests.

## What earlier evidence contributes

The F8/F9 retention prototype traversed twenty and forty pages without rereading and preserved all
six authored findings. That supports testing source availability as a mechanism; it does not select
an engine, context policy or production architecture. F9 emitted only seven full page texts into
proposal evidence. Under the clarified requirement, original retention and temporary model history
are insufficient, but a separate durable transcript is an acceptable representation.

Four F9 diagnostic flags were independently identified as evaluator false positives involving
valid inherited context and host display-label mapping. New tests must accept equivalent valid
representations while still rejecting real omissions. Earlier OCR and matching failures are useful
regression fixtures; used fixtures cannot become fresh held-out evidence. The old 120-cell campaign,
failed criteria, unknown usage and unattempted arms are not restarted or regraded here.

## Integration constraints and unresolved product details

Extend the existing source/hash/page readers, proposal/context references, accepted-history and
recovery mechanisms where possible. The coordinator inspected `intake-evidence.ts`,
`intake-continuation.ts`, the shared intake contracts and report-context/group entry points; these
provide integration seams, not proof that durable complete-text retention is already implemented.
Audit storage/recovery compatibility before selecting a transcript representation or migration.

The customer requirement to continue after sign-out/profile switching differs from the current
one-unlocked-profile and lock-stops-private-work contract. A scoped background job authority is a
design proposal requiring the existing [CRS-081](application-todo.md#crs-081) security review.
It must not preserve general interactive access, share keys across profiles or store an unwrapped
unlock secret. Process loss still requires authorized unlock before private work resumes. Do not
quietly bypass the current lock behavior to make a benchmark pass.

Mixed-person packages and structured-export edge cases remain partly unspecified. An early-approved
record changed by later evidence must retain its approved version and present a reviewable change;
the exact correction/review interaction should be settled before claiming end-to-end acceptance.
Rendering every region or obtaining agreement between two OCR engines cannot prove that every
word was recognized. Tests need independent source truth and must penalize both silent omissions
and needless abstention on readable content.

## How to turn the hypotheses into a decision

The [proposed test plan](import-processing-test-plan.md) was written by a separate agent after
reading the frozen independent designs, then reviewed for comparability and composition failures.
It distinguishes four outcomes: retained text, clinical meaning, recovery/review correctness and
efficiency. A success in one cannot compensate for failure in another.

Start with representation/scorer controls and fake routing/identity checks. Test complete-text
adapters and durable retrieval separately from clinical interpretation. The first proposed live
comparison uses two fresh challenging reports and two clinical readers over the same complete
source text: four jobs. This isolates context handling while preserving the rest of the composition.
Further clinical, end-to-end fallback, length and concurrency checks are conditional stages, not
an exhaustive product of every engine, batch size and worker count.

The result should be a versioned component/compatibility register: which extraction adapters work
on which source strata, which clinical context policies are eligible, which combinations and
fallbacks have passed, and which remain unresolved. It should include routing predicates, reasons,
quality limits and observed resource costs. A failed combination may leave a component useful in
another qualified combination. A component pass alone cannot qualify its consumers or fallbacks.

Score the complete composed clinical output, with separate checks for any unsafe intermediate
escape into review eligibility, acceptance or confirmed-fact presentation. Retain intermediate
errors and corrections in diagnostics. A validator catching a provisional assertion is useful
behavior; a silent unsupported assertion surviving the composition is a failure. The same rule
applies to all compared designs.

If multiple compositions meet the gates, choose among them for the declared source stratum using
measured quality, user effort, latency and maintenance complexity. Preserve credible alternatives
rather than forcing a universal winner. Small tests can falsify a bad implementation; they cannot
prove arbitrary-document correctness. All counts, margins and formulas in the linked plan are
proposed and must be frozen in an actual run declaration before execution.

No new import, OCR, provider or fault-injection experiment was run for this brainstorm. The existing
experiment scores and completed-study boundaries remain unchanged.

## Independent design review and status

A designer independently reviewed the synthesis after its original unanchored report was frozen. The synthesis was clarified to require an explicit clinical-reading disposition for every supported page, early patient-role identity preflight where local text permits, and a distinction between corpus qualification and proof of complete recognition.

Another designer independently reviewed the separate test designer's plan. Five material findings were corrected: the continuation branch when exactly one clinical arm fails; actual fallback-path quality rather than fake routing alone; exclusion of gold clinical relationships from diagnostic transcript inputs; source-support checks beyond resolvable or overly broad citations; and safety scoring at the completed composition or earlier unsafe escape rather than an intermediate draft that its validator rejects. The reviewer rechecked the amended plan and found no remaining material issue against those findings. The reviewed portable plan has SHA-256 `beda50e97a535a4df8445512d1b9568ce9463e96a96fd0038c8a493fa455eaf5`.

The coordinator also required an explicit12→48-page prediction formula declared before calibration:4× the measured12-page metric as a simple proportional hypothesis, with fixed setup included, its bias disclosed and no single-point power fit. This is a proposed diagnostic, not evidence that real processing is linear.

The deliverable is a composed architecture hypothesis and independently reviewed test design. No prototype, engine, router, fallback or composition has been newly qualified by this document review, and no new experiment has run. Historical result files and their criteria are unchanged.
