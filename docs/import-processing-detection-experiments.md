# Detecting source errors for human-assisted import

Owner-authorized follow-up, 2026-09-26. This investigation follows the [practical strategy proposal](import-processing-practical-strategy.md) and the independently verified correction mechanics in the [execution ledger](composed-import-experiment-results.md). The owner asks for vetted components, useful compositions and an objective comparison under the assumption that humans correctly repair what they can inspect. This is an experiment, not a production feature or a claim that real humans are infallible.

## Decision and admission rules

Retire a frozen variant from the role and source scope it demonstrably failed. Preserve the recording and useful components; do not eliminate an entire engine or strategy family because one implementation failed. Add a new candidate only after its source access, output contract, expected failure modes and discriminating test are explicit. A design review admits a candidate to testing, not to production or to a list of proven solutions.

The current evidence excludes these tested variants as the sole complete-text route for their tested mixed-document scope:

- Native extraction alone: omitted visible source content.
- Ordinary full-page OCR alone: transcription and structural failures, including invented text.
- A native/OCR union whose completeness claim rests on literal retention: retained words do not establish table associations, reading order or absence of inventions.
- The frozen E1/E2b vocabulary and geometry compositions as complete extractors: failed independently authored held-out documents. Their native/OCR outputs and improved structural handling remain useful candidate inputs.
- Confidence alone as a completeness certificate: confident wrong text occurred. Confidence may still be one review-trigger signal.

These exclusions do not settle whether a component helps identify errors for a person. Detection and extraction are different roles and need different endpoints. Human review mechanics are supported by eleven finite controls; automatic error discovery, actual human effort and production integration were not established by those controls. Clinical context strategies remain unresolved rather than being eliminated by an extraction or transport failure.

## Question to resolve

Can a composition identify all source-text and structural errors on a fresh declared corpus while showing the assumed-perfect reviewer less material than a full-source review?

The alternative is not limited to one extractor. Candidate signals include confidence/explicit uncertainty, visible coverage gaps, disagreement between available readings and structural checks. A second local OCR configuration is a correlated reread, not an independent engine or a qualified visual model. An actual independent visual-model audit remains a separate unqualified component until its own execution and accounting prerequisites are met. This offline study does not restart the earlier clinical run or waive its unknown usage.

## Fair comparison under the perfect-human assumption

Freeze candidate code before disclosing fresh source outputs. Freeze the physical sources, independently authored truth, candidate list, parameters, budget and scorer before execution. The detector sees ordinary source/extraction evidence only. It commits its selected edit targets and visible source context before the repair evaluator receives truth.

Perfect repair may correct only selected targets supported by the charged visible source context. It cannot use the answer key to repair an unflagged region or a distant table/header relationship that the reviewer was never shown. Sources with truly absent or ambiguous information retain that limitation. Compare the entire resulting document, not just the corrected crops.

Report actual extraction errors separately from explicitly injected candidate-output errors. Injection can test confident wrong text, shared mistakes or omitted relationships even when a small corpus does not naturally produce them; it does not estimate their real-world frequency. Include clean controls to measure unnecessary review. Preserve segmentation-equivalent text and meaningful relation equivalence in scoring.

Primary outcomes are residual literal/structural errors, unflagged errors, document-level false-complete claims and correctly retained useful content. Review burden includes the union of displayed page area, pages opened and required neighboring/cross-page context. Region count alone is insufficient; a large crop or whole document cannot masquerade as one cheap question. Area and page counts are workload proxies, not measured human time or usability.

Use a no-repair baseline and a full-source perfect-review baseline. Admit fewer-review compositions only when their residual errors meet the same declared gate. If quality and review burden trade off, report the tradeoff. A finite pass supports the tested scope, not universal reliability. Fresh failures become regression evidence; a revised detector requires new held-out evidence rather than regrading the same inputs.

## Execution status

The finite primary comparison has finished: twenty-four local OCR calls, six common primary artifacts, four separately constructed adversarial variants and eighty policy outcomes. Independent source, containment and result verification passed for the original comparison and the subsequent seventy-outcome exploratory extension. All original and partial recordings are retained in the [execution ledger](composed-import-experiment-results.md). This offline study made no provider calls or production changes.

## Original declared comparison (now completed)

After independent design review, the prospective comparison holds one native-first/PSM3 text candidate fixed and tests eight policies: no repair; confidence alone; confidence plus native/OCR disagreement; confidence plus visible coverage; those three signals together; that union plus structural context; that union plus a PSM11 reread; and full-source review. The primary deliberately does not infer table links. This isolates review detection; it does not compare every useful extraction-plus-review composition or establish that earlier partial table reconstruction has no value.

Six natural two-page sources and four separately labelled adversarial variants yield at most eighty offline policy outcomes, sharing the same twenty-four planned OCR calls. Fourteen finite controls check scoring, scope containment and burden accounting before fresh outcomes. These include token-level repair location, equivalent split/merged text, repeated-token and duplicate-extra handling, meaningful partial reading order, positive and negative table relations, visible support alternatives and the prohibition on answer-key repair outside the selected scope. Exact software, parameters and source hashes received independent pre-use clearance before execution. All eighty outcomes and twenty-four OCR calls are now recorded; the preceding counts describe the original prospective bounds.

The repair endpoint is a **model**: a correct source reader can repair an error only when the frozen target and displayed context contain the required evidence. The test computes that conditional repairability; it does not emit or validate a fully corrected application document. Actual detector masks, initial source errors and displayed area are recorded separately from modeled post-repair fidelity. Genuine unreadability remains visible even when the finite fidelity gate passes. The prior eleven mechanics tests supply separate correction/history evidence, not end-to-end qualification of this model.

## Separately declared adaptive interaction comparison

The primary results exposed a restriction worth testing separately: all residual constraints in CVDS had their supporting source visible, but some required edits lay outside the selected target rectangles. In particular, displaying a whole page as context did not authorize edits to the whole page. This is a property of the declared interaction model, not evidence that a perfect reader cannot see or correct those errors. Some strict containment failures also involve padding at a target boundary. Original scores and criteria remain unchanged.

A new, **post-hoc exploratory** composition promotes the existing displayed context to editable review scope. The transformation must use only saved detector output, add no source pixels and charge the entire promoted union as editable area. It is applied uniformly to seven non-FULL policies on the same ten exposed samples, at most seventy modeled outcomes. Unchanged FULL remains the source-visible reference. This does not create new held-out evidence, tune source-specific rectangles, demonstrate real-human performance or qualify a production system. Independent admission and result verification are required before interpreting this extension.

## Current strategy decision

The original eight-policy comparison is independently verified. Its strict crop-editing protocol passed the finite modeled floor across all ten samples only with full-source perfect review. Independent inspection found that CVDS already displayed sufficient source support for every remaining constraint; selected edit bounds, including small geometric padding gaps, caused the remaining failures. This rejects the tested crop-only sufficiency rule, not the usefulness of coverage detection or a person's ability to read the displayed source.

The separately recorded context-editable extension has completed seventy exploratory outcomes with independent verification. Its result favors **native/OCR candidate text + confidence, visible coverage, reader disagreement and structural review signals + correction anywhere in the displayed source context** (CVDS_EDIT). It meets the finite modeled floor on six of six natural documents and four of four deliberately injected challenges. Adding the same-engine PSM11 signal does not improve these quality endpoints and adds a small amount of review area; leave it out of this simplest candidate, without declaring rereading universally useless.

The candidate displays and permits edits to 8.6993 of twelve natural page-equivalents, versus twelve for full-source review: about 27.5% less area. It still touches all twelve pages and displays eight in full. Exposed candidate-character upper bounds are 3,780 versus 4,073, so the area reduction must not be called a 27.5% reduction in reading time or effort. Injected results remain separate: 4.7034 of eight page-equivalents, all eight pages touched, four displayed in full. Genuine unreadability remains an explicit exception, not invented wording.

This selects a **candidate for the next implementation test**, not an objectively optimal complete importer. The extension used already exposed sources and an assumed-perfect reader. It establishes no general detection guarantee, human accuracy/time, production UI behavior, security integration or clinical interpretation result. Original failures and all eighty initial scores remain intact.

The useful next tests are a fresh source set with this interaction rule frozen in advance; an actual editable-source UI with source-linked revisions and stale-proposal invalidation; and a human study measuring missed errors and review time, including confident shared mistakes. New table layouts, dense pages, handwriting, faint/cropped scans and nontext marks need their own declared strata. Full-source review must remain available; a review queue being empty does not itself certify complete extraction.

## Updated role shortlist

- **Retire as sufficient completion routes for this tested scope:** the original targeted crop-only policies; confidence-only review; and the tested context-editable policies that omit the needed combination of coverage, disagreement and structural context. Each leaves a demonstrated readable-content or structural failure in at least one declared sample. This does not remove its signals from useful larger compositions.
- **Retain as the simplest successful exploratory candidate:** CVDS_EDIT, with the full displayed source context editable. Preserve native/OCR alternatives, original evidence, durable correction history and explicit exceptions. These surrounding application obligations are not newly qualified by this detector test.
- **Omit from this candidate for lack of demonstrated incremental benefit:** the additional PSM11 signal. CVDSL_EDIT ties the tested quality floor while displaying slightly more area; this is a scoped simplification, not proof that all second readers are useless.
- **Retain as reference and accessible fallback:** full-source review. Its perfect-reader model passes, but actual human accuracy, time and implementation remain unmeasured.
- **Keep unresolved rather than call failed:** independent visual-model audit, broader extractor-plus-review compositions, handwriting/dense-source support and clinical interpretation topology. No completed applicable test here settles them.
