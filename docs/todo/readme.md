# TODOs

This is the single work list. Keep ordinary items to an ID and a short description here. Add a separate CRS file when an item needs more room: its specification, proposal, owner decisions, open questions and review findings belong there. Fold review feedback into the items it concerns.

Numbers are stable identifiers, not priority. Never renumber or reuse an ID. The next unused number is CRS-129. When a ticket's work lands, delete its entry and CRS file in the same change and describe the result in the maintained documentation. If only part landed, delete it anyway and open a new ticket for the rest, with context scoped to that remainder. Entries under Closed identifiers predate this practice; they preserve prior status and do not certify today's code. Research items retain their status pending a separate discussion; listing them does not authorize runs, paid inference or deployment.

Application documentation describes implemented behavior and current limitations; future work, its specifications and its plans live here. Before deleting a ticket, carry its unmet requirements, owner decisions and open questions into a new or existing item.

The detailed work list and design documents that preceded this index are archived at `2ae9a0f`: the [earlier work list](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/application-todo.md), [processing context proposal](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/processing-context-proposal.md), [import processing implementation specification](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/import-processing.md) and [integrated evidence review draft](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/import-evidence-review-draft.md). The deployment designs are linked from [CRS-083](CRS-083.md). They are history; the CRS items below are authoritative.

## Product and maintenance

- [ ] <a id="crs-033"></a> **CRS-033** — Finish Import inbox acceptance after real-use regressions: native drop, accurate long-run activity, and repeated complete-file review.
- [ ] <a id="crs-037"></a> **CRS-037** — Verify native file drop and truthful indexing, reading, provider-wait and completion states, including multi-file estimates and long runs.
- [ ] <a id="crs-038"></a> **CRS-038** — Validate bounded, privacy-safe diagnostics against representative real-provider complaints and complete import lifecycles.
- [ ] <a id="crs-039"></a> [CRS-039](CRS-039.md) — Continue productive imports automatically; replace total capture cutoffs and manual transient-error recovery with checkpointed backoff and stall detection.
- [ ] <a id="crs-040"></a> **CRS-040** — Finish scoped identity confirmation and contradictory-source recovery; retain explicit clinical acceptance. Blank-Self-field filling is superseded by CRS-112.
- [ ] <a id="crs-041"></a> **CRS-041** — Finish encrypted and real-file parity checks for the self-contained Import route and historical Sources redirects.
- [ ] <a id="crs-042"></a> **CRS-042** — Explain report splits and preserve report/person/date/header relationships without merging equal-looking clinical events.
- [ ] <a id="crs-043"></a> **CRS-043** — Verify whole-ingest storage, memory and latency on representative files, with truthful upload limits and progress.
- [ ] <a id="crs-045"></a> **CRS-045** — Verify the confirmed source on every eligible accepted result, including reuse, late pages, bulk acceptance and cache rebuild.
- [ ] <a id="crs-046"></a> **CRS-046** — Finish subject/member-safe clinical identity and persisted-key migration qualification; never merge records across people.
- [ ] <a id="crs-079"></a> **CRS-079** — Measure current complete-import request context and end-to-end latency; separate host time, provider waiting, retries and output cost.
- [ ] <a id="crs-080"></a> **CRS-080** — Add test-only extraction capture/replay for fictional downstream regressions; fresh quality and speed measurements must bypass replay.
- [ ] <a id="crs-081"></a> [CRS-081](CRS-081.md) — Allow specifically authorized imports to continue after lock/logout while general profile access is revoked.
- [ ] <a id="crs-084"></a> [CRS-084](CRS-084.md) — Prioritize unresolved security risks and mitigations without describing proposed controls as existing protection.
- [ ] <a id="crs-086"></a> [CRS-086](CRS-086.md) — Implement model-agnostic async artifact processing with bounded context, shared extraction, adaptive concurrency and reviewable aggregation.
- [ ] <a id="crs-088"></a> [CRS-088](CRS-088.md) — Reduce passkey re-entry to an authenticator gesture while retaining origin checks, profile isolation and locked state after restart.
- [ ] <a id="crs-090"></a> **CRS-090** — Qualify confirmed-name remembering on ambiguous and representative files, preserving primary identity and historical receipts.
- [ ] <a id="crs-111"></a> [CRS-111](CRS-111.md) — Use early original identity evidence for scoped person assignment; mismatches ask who a report belongs to and never reject the upload.
- [ ] <a id="crs-112"></a> **CRS-112** — Remove blank-Self-field filling from import confirmation; use normal profile editing/setup and keep old receipts readable.
- [ ] <a id="crs-114"></a> [CRS-114](CRS-114.md) — Remove the repository inventory checker and separately verified dead code, preserving live dynamic, worker, deployment and test entry points.
- [ ] <a id="crs-115"></a> [CRS-115](CRS-115.md) — Qualify complete durable source text, located uncertainty, reading order, tables, search and no-AI recovery across difficult document strata.
- [ ] <a id="crs-116"></a> [CRS-116](CRS-116.md) — Improve evidence review, omission detection, issue dependencies, bounded editing and measured human review burden.
- [ ] <a id="crs-128"></a> [CRS-128](CRS-128.md) — Verify each retained original without a full synchronous hash after every restart: keep verification across restarts and move any full hash that remains off the request path.
- [ ] <a id="crs-118"></a> [CRS-118](CRS-118.md) — Invalidate only affected unaccepted interpretations using all consumed evidence, including headers, dates and amendments.
- [ ] <a id="crs-119"></a> [CRS-119](CRS-119.md) — Add audited reassignment of accepted records and removal of confirmed aliases while preserving prior versions and attribution.
- [ ] <a id="crs-120"></a> [CRS-120](CRS-120.md) — Resolve reported bulk-save, draft, person-picker, stale-source and accessibility defects without weakening acceptance guards.
- [ ] <a id="crs-121"></a> **CRS-121** — Verify additive medication imports, explicit medication-taking status, partial-date precision and private offline terminology/unit checks, as decided in [CRS-126](CRS-126.md#dates), [medications](CRS-126.md#medications) and [standard vocabularies](CRS-126.md#standard-vocabularies).
- [ ] <a id="crs-122"></a> [CRS-122](CRS-122.md) — Resolve reported test gaps in identity, real-process restart, OCR, write growth, automatic continuation and legacy environment handling.
- [ ] <a id="crs-123"></a> **CRS-123** — Review broad legacy-variable rejection, inconsistent proxy diagnostics, noisy diagnostics routes and the unused CI integration flag (reliability R46–R50: `deploy/run.ts:388-413`, `environment.md:78`/`compose.yaml`/`configure.py:110-115`, `index.ts:891`, `code-checks.yml:21`); correct `import/import-performance.md:3`, which still describes pre-branch diagnostics behavior (R48); review unrelated configuration changes separately (R52).
- [ ] <a id="crs-124"></a> **CRS-124** — Validate non-Self distinction, long/identical names, keyboard/narrow layouts, interrupted saves and useful prescription/procedure summaries with the owner.
- [ ] <a id="crs-125"></a> **CRS-125** — Review duplicated calendar validation, DTO/form contracts, server-safe formatting, filter/modal shells and HTTP/error primitives when touching those boundaries.
- [ ] <a id="crs-126"></a> [CRS-126](CRS-126.md) — Meet the import specification: never drop a record, other people's records welcome, no size or time limits, waits are backoffs, writes scale with change.
- [ ] <a id="crs-127"></a> **CRS-127** — Read HEIC and multi-page TIFF uploads automatically, as [CRS-126](CRS-126.md#receiving-and-formats) requires; today they are unsupported (`intake-source-extraction.ts:197`, `shared/intake-source-policy.ts:8`; reliability R36).

## Release and usability checks

- [ ] <a id="crs-014"></a> **CRS-014** — Verify actual browser-tab and home-screen icons, small-size readability, and live System/Light/Dark changes.
- [ ] <a id="crs-055"></a> **CRS-055** — Verify phone Files/Photos, virtual keyboard, assistive technology, zoom and rotation on physical devices.
- [ ] <a id="crs-056"></a> **CRS-056** — Verify phone upload interruption, background return, lock recovery and reachable HTTPS/passkey configuration.
- [ ] <a id="crs-058"></a> **CRS-058** — Validate independently fictional complete imports against exact fields, dates, units, ownership, provenance and rebuilt accepted records.
- [ ] <a id="crs-060"></a> **CRS-060** — Complete layered server, mounted, encrypted browser and real-provider validation without substituting one layer for another.
- [ ] <a id="crs-061"></a> **CRS-061** — Finish real-provider, device, filesystem and printed-output release acceptance.
- [ ] <a id="crs-062"></a> **CRS-062** — Complete repeated full-file Import journeys without manual hidden repair, missing source attribution or silently incomplete extraction.
- [ ] <a id="crs-063"></a> **CRS-063** — Verify live OAuth expiry/refresh and credential persistence for every adopted route; narrow sign-in/recreation checks are already recorded.
- [ ] <a id="crs-064"></a> **CRS-064** — Verify tools, images, native PDF, model identity and supported workflows for each adopted hosted and Ollama route.
- [ ] <a id="crs-065"></a> **CRS-065** — Verify inference routing, credential isolation and proxy retention/logging; never silently change providers or weaken local-only settings.
- [ ] <a id="crs-066"></a> **CRS-066** — Validate each supported route through chat, full import, questions, explicit acceptance, correction, original access and recreation/rebuild, including failures.
- [ ] <a id="crs-067"></a> **CRS-067** — Qualify interpretation of representative fictional formats, literal fields, orders versus performed events, categories and clinician relationships.
- [ ] <a id="crs-068"></a> **CRS-068** — Complete a supported-size takeout through upload, overlapping reading, interruption, retained questions, acceptance and original reopening.
- [ ] <a id="crs-069"></a> **CRS-069** — Qualify overlapping PDF/HTML/package evidence, attachments, duplicates and interrupted extraction without lost originals or false merges.
- [ ] <a id="crs-070"></a> **CRS-070** — Verify later evidence updates pending candidates or proposes reviewed versions of accepted records, retaining decisions through restart.
- [ ] <a id="crs-071"></a> **CRS-071** — Verify the intended deployment drive, filesystem semantics, mounts, provider persistence and actual import workflows.
- [ ] <a id="crs-072"></a> **CRS-072** — Verify physical passkey/PRF enrollment, repeated unlock and recovery on intended browsers, authenticators and origins.
- [ ] <a id="crs-073"></a> **CRS-073** — Inspect final printed visit briefs, provider packets and companion originals on the release build.
- [ ] <a id="crs-076"></a> **CRS-076** — Qualify native PDF and same-page image fallback on supported real routes, including unsupported media and truthful coverage.
- [ ] <a id="crs-077"></a> **CRS-077** — Verify unavailable-provider recovery and explicit model changes without silent fallback, lost proposals or duplicate acceptance.
- [ ] <a id="crs-078"></a> **CRS-078** — Complete opt-in live provider coverage alongside controlled tests; credentials or unavailable routes remain explicit gaps.

## Deferred options

- [ ] <a id="crs-082"></a> **CRS-082** — Explore additional formats, including DICOM, structured exports and media; preserve originals and make unsupported interpretation explicit.
- [ ] <a id="crs-083"></a> [CRS-083](CRS-083.md) — Explore private home/cloud placement and hosted readiness without changing the supported local Compose installation or provisioning services.
- [ ] <a id="crs-085"></a> **CRS-085** — Decide whether Conditions or a separate Visit entity is needed; preserve unsupported evidence without forcing it into another clinical kind.
- [ ] <a id="crs-089"></a> **CRS-089** — Evaluate Bifrost as a possible LiteLLM replacement for compatibility, overhead, credentials and supported deployment; no replacement is selected; the [earlier evaluation](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/bifrost-evaluation.md) is archived.
- [ ] <a id="crs-110"></a> **CRS-110** — Consider a separate processing service only if measured CPU contention or a chosen hosted deployment justifies it; retain profile-key isolation.

## Experiment-related items — pending review

The [experiment material](../experiments/README.md) is retained separately. No broad new study is a prerequisite for CRS-086.

- [ ] <a id="crs-044"></a> **CRS-044** — Measure actual zero-yield pages during complete provider imports against independent ground truth; do not use sparse text as permission to skip.
- [ ] <a id="crs-087"></a> **CRS-087** — Assess whether PDF text-layer headings can support bounded report/table context; do not change page-skipping policy.
- [ ] <a id="crs-091"></a> **CRS-091** — Attribute request input by field and page count; compare the processing cost model with measured payloads.
- [ ] <a id="crs-092"></a> **CRS-092** — Analyze how input and output tokens relate to observed request latency, keeping correlation separate from causation.
- [ ] <a id="crs-094"></a> **CRS-094** — Measure local-stack parallel contention. The historical worker sweep remains unexecuted and is not a prerequisite for CRS-086.
- [ ] <a id="crs-099"></a> **CRS-099** — With separate owner authorization, profile the private library using counts only; never publish names, values, dates, filenames or paths.
- [ ] <a id="crs-102"></a> **CRS-102** — Compare multi-record quality under bounded host-pushed units on paired fictional documents.
- [ ] <a id="crs-103"></a> **CRS-103** — Compare cross-page associations and session lengths on paired fictional documents.
- [ ] <a id="crs-104"></a> **CRS-104** — Measure achieved provider cache share rather than assuming cached-token savings.
- [ ] <a id="crs-105"></a> **CRS-105** — Measure attached-media token cost per fictional page.
- [ ] <a id="crs-106"></a> **CRS-106** — Measure page-reading output size and whether compaction preserves useful evidence.
- [ ] <a id="crs-107"></a> **CRS-107** — Verify route limits and measure token estimation on representative content types; model claims are not account-limit evidence.
- [ ] <a id="crs-109"></a> **CRS-109** — Measure extraction/OCR CPU, queue wait and API responsiveness when worker contention is observed.
- [ ] <a id="crs-113"></a> **CRS-113** — Compare model-suggested reading scope with validated defaults; preserve the historical experiment as unresolved, not an implementation prerequisite.

## Closed identifiers

- [x] <a id="crs-001"></a> **CRS-001** — Product README.
- [x] <a id="crs-002"></a> **CRS-002** — Installation and deployment guides.
- [x] <a id="crs-003"></a> **CRS-003** — Curate permanent documentation.
- [x] <a id="crs-004"></a> **CRS-004** — Remove obsolete skills carefully.
- [x] <a id="crs-005"></a> **CRS-005** — Maintainer entry points.
- [x] <a id="crs-006"></a> **CRS-006** — Complete JavaScript-to-TypeScript migration in one coordinated effort.
- [x] <a id="crs-007"></a> **CRS-007** — MIT and public repository checks.
- [x] <a id="crs-008"></a> **CRS-008** — Audit buttons and implement shared variants.
- [x] <a id="crs-009"></a> **CRS-009** — Contextual help.
- [x] <a id="crs-010"></a> **CRS-010** — Shared Moxie diagnostics dialog.
- [x] <a id="crs-011"></a> **CRS-011** — Preserve the approved visual foundation.
- [x] <a id="crs-012"></a> **CRS-012** — One editable logo source.
- [x] <a id="crs-013"></a> **CRS-013** — Reproducible icon exports and head metadata.
- [x] <a id="crs-015"></a> **CRS-015** — Curated icon search vocabulary.
- [x] <a id="crs-016"></a> **CRS-016** — Readable starter suggestions.
- [x] <a id="crs-017"></a> **CRS-017** — Correct conversation context.
- [x] <a id="crs-018"></a> **CRS-018** — One coherent assistant response.
- [x] <a id="crs-019"></a> **CRS-019** — Useful message time.
- [x] <a id="crs-020"></a> **CRS-020** — Profile actions in three clear groups (superseded layout; see CRS-021).
- [x] <a id="crs-021"></a> **CRS-021** — Consistent profile button hierarchy (approved follow-up).
- [x] <a id="crs-022"></a> **CRS-022** — Welcoming front page.
- [x] <a id="crs-023"></a> **CRS-023** — Entry and activity.
- [x] <a id="crs-024"></a> **CRS-024** — Durable report groups.
- [x] <a id="crs-025"></a> **CRS-025** — Stable review queue.
- [x] <a id="crs-026"></a> **CRS-026** — Review common facts once.
- [x] <a id="crs-027"></a> **CRS-027** — Compact clinical review.
- [x] <a id="crs-028"></a> **CRS-028** — Original evidence on demand.
- [x] <a id="crs-029"></a> **CRS-029** — Explicit counted acceptance.
- [x] <a id="crs-030"></a> **CRS-030** — Clear completion and controls.
- [x] <a id="crs-031"></a> **CRS-031** — Bounded complete reading.
- [x] <a id="crs-032"></a> **CRS-032** — Extraction and projection correctness.
- [x] <a id="crs-034"></a> **CRS-034** — Connect retained shared context to review proposals.
- [x] <a id="crs-035"></a> **CRS-035** — Explain and verify background recovery.
- [x] <a id="crs-036"></a> **CRS-036** — Reviewed imports for named People (approved).
- [x] <a id="crs-047"></a> **CRS-047** — Container hardening fallout on existing consumers.
- [x] <a id="crs-048"></a> **CRS-048** — Surface possible related saved records.
- [x] <a id="crs-049"></a> **CRS-049** — Explicit relationship decisions.
- [x] <a id="crs-050"></a> **CRS-050** — Correct either side.
- [x] <a id="crs-051"></a> **CRS-051** — Source amendments and downstream visibility.
- [x] <a id="crs-052"></a> **CRS-052** — Derived normalization model.
- [x] <a id="crs-053"></a> **CRS-053** — Rounding and uncertainty.
- [x] <a id="crs-054"></a> **CRS-054** — Consistent comparisons and charts.
- [x] <a id="crs-057"></a> **CRS-057** — Independent agent iteration.
- [x] <a id="crs-059"></a> **CRS-059** — Recovery and version tests.
- [x] <a id="crs-074"></a> **CRS-074** — Controlled proxy topology.
- [x] <a id="crs-075"></a> **CRS-075** — Verified account sign-in and reuse.
- [x] <a id="crs-093"></a> **CRS-093** — Measure prefix hygiene savings.
- [x] <a id="crs-095"></a> **CRS-095** — Test re-export fingerprinting on re-rendered fictional charts.
- [x] <a id="crs-096"></a> **CRS-096** — Classify date roles for date cutoffs without AI.
- [x] <a id="crs-097"></a> **CRS-097** — Count identity prompts with grouping and remembered spellings.
- [x] <a id="crs-098"></a> **CRS-098** — Inject faults to test unattended completion.
- [x] <a id="crs-100"></a> **CRS-100** — Evaluate local OCR for scans and photos.
- [x] <a id="crs-101"></a> **CRS-101** — Withdrawn: matched re-export skipping experiment; never executed.
- [x] <a id="crs-108"></a> **CRS-108** — Test a pre-AI identity check from printed name and birth date.

## Legacy IDs

The aliases below refer to the old backlog namespace. They are separate from security risk IDs and the later reliability review’s R1–R52 labels, which are recorded in the CRS files that took them over (CRS-039, 086, 111, 117–120, 122, 123, 126 and 127).

- `R1` → [CRS-001](#crs-001); `R2` → [CRS-002](#crs-002); `R3` → [CRS-003](#crs-003); `R4` → [CRS-004](#crs-004); `R5` → [CRS-005](#crs-005); `R6` → [CRS-006](#crs-006); `R7` → [CRS-007](#crs-007).
- `U1` → [CRS-008](#crs-008); `U2` → [CRS-009](#crs-009); `U3` → [CRS-010](#crs-010); `U4` → [CRS-011](#crs-011); `U5` → [CRS-012](#crs-012); `U6` → [CRS-013](#crs-013); `U7` → [CRS-014](#crs-014); `U8` → [CRS-015](#crs-015).
- `M1` → [CRS-016](#crs-016); `M2` → [CRS-017](#crs-017); `M3` → [CRS-018](#crs-018); `M4` → [CRS-019](#crs-019).
- `P1` → [CRS-020](#crs-020); `P3` → [CRS-021](#crs-021); `P2` → [CRS-022](#crs-022).
- `I1` → [CRS-023](#crs-023); `I2` → [CRS-024](#crs-024); `I3` → [CRS-025](#crs-025); `I4` → [CRS-026](#crs-026); `I5` → [CRS-027](#crs-027); `I6` → [CRS-028](#crs-028); `I7` → [CRS-029](#crs-029); `I8` → [CRS-030](#crs-030); `I9` → [CRS-031](#crs-031); `I10` → [CRS-032](#crs-032); `I11` → [CRS-033](#crs-033); `I12` → [CRS-034](#crs-034); `I13` → [CRS-035](#crs-035); `I14` → [CRS-036](#crs-036); `I15` → [CRS-037](#crs-037); `I16` → [CRS-038](#crs-038); `I17` → [CRS-039](#crs-039); `I18` → [CRS-040](#crs-040); `I19` → [CRS-041](#crs-041); `I20` → [CRS-042](#crs-042); `I22` → [CRS-043](#crs-043); `I23` → [CRS-044](#crs-044); `I21` → [CRS-045](#crs-045); `I24` → [CRS-046](#crs-046); `I25` → [CRS-047](#crs-047).
- `C1` → [CRS-048](#crs-048); `C2` → [CRS-049](#crs-049); `C3` → [CRS-050](#crs-050); `C4` → [CRS-051](#crs-051).
- `N1` → [CRS-052](#crs-052); `N2` → [CRS-053](#crs-053); `N3` → [CRS-054](#crs-054).
- `T1` → [CRS-055](#crs-055); `T2` → [CRS-056](#crs-056); `T3` → [CRS-057](#crs-057); `T4` → [CRS-058](#crs-058); `T5` → [CRS-059](#crs-059); `T6` → [CRS-060](#crs-060); `T7` → [CRS-061](#crs-061); `T8` → [CRS-062](#crs-062).
