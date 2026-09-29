# Processing experiments

Briefs for the experiments the [processing context proposal](processing-context-proposal.md)
requires before any processing design is selected. Created 2026-09-24. Each experiment has a
task in the [application work list](application-todo.md), which owns its status; this document
holds the design of each experiment and its dated results, not a second checklist.

Every experiment is a throwaway proof of concept or an analysis of existing data. None of them
ships. Any of them can fail, and a failure is a result: it removes or reshapes a candidate. The
theory numbers (T1–T22) match the proposal's theory tables.

## Rules for runners and verifiers

1. **Read the brief, the proposal sections it names and the code it cites before starting.** Verify
   cited code against the current tree; briefs can go stale.
2. **Predeclared criteria are fixed once a run starts.** A runner who thinks a criterion is wrong
   appends a new criterion with the date and reason, then reports against both. Never edit the
   original.
3. **Fictional data only,** per repository policy. T17 is the one exception: it runs on the
   owner's own library, on the owner's machine, only when the owner authorizes it, and records
   counts only, never names, values, dates, file names or paths.
4. **Raw artifacts stay out of Git.** Commit portable summaries: counts, sizes, timings, rates,
   parameter values and fixture generators. Scripts go in the repository only when a brief says
   the method is reusable; otherwise describe them well enough to rebuild them.
5. **Append results, never rewrite them.** Use the entry template below under the experiment's
   "Results" heading. A corrected result is a new entry that names the one it corrects.
6. **The runner does not verify their own result.** A verifier, human or agent, independent of
   the runner, re-derives the result from the runner's recorded commands and parameters, or reruns
   a reduced version. They append a verification entry that agrees, disagrees, or flags an oddity
   with the specific number or step in question. Outcomes are open until verified.
7. **Label every number** as measured (with its receipt), model (with the formula or the
   [cost model](../src/scripts/processing-cost-model.ts) parameters) or unknown.
8. **Live-spend experiments run only after the offline ones they depend on,** with an explicit
   experiment spend cap. That cap limits evaluation spending; it is not a product limit. They do
   not count toward provider acceptance gates (CRS-039, CRS-066).
   _Amended 2026-09-24 (owner decision):_ the spend cap is replaced by a **run plan and a stop
   rule**. Before a live run, list the fixture pages × strategies × repeats, and model each run's
   expected tokens with the [cost model](../src/scripts/processing-cost-model.ts). Stop any run
   that passes 2× its modeled tokens and record the overrun as a finding, not a failure: either the
   prototype misbehaves or the model is wrong. The app's per-job limits (20M tokens, 2,048
   requests) remain the last backstop. No run is skipped or cut short to save budget, because a
   budget that trips cuts the expensive baseline first and ruins the comparison. The owner's route
   is a ChatGPT subscription signed in with a device code, so extra dollars are zero and dollar
   figures are not reported. The scarce resource is the subscription's usage window: schedule live
   runs when the owner is not importing, and report tokens and requests.
9. **When done,** update the task's checkbox in the work list only after a verification entry
   agrees, and add a one-line outcome to the proposal's experiment registry.
10. **Prototypes live in their own git worktree,** one per prototype, created by the owner and never
    merged (owner decision 2026-09-24). Only results, and scripts a brief marks reusable, come back
    to the main checkout. Agents never write to git; they leave changes in the worktree's working
    tree.

### Result entry template

```markdown
#### Run YYYY-MM-DD — <runner>

- Commit and environment: <hash>, Node <version>, <host class>, <route or "scripted">
- Parameters and fixtures: <values, generator and seed>
- Commands: <exact commands, portable paths>
- Measurements: <table of numbers, each labeled measured / model / unknown>
- Against the criteria: <pass / fail / inconclusive, per predeclared criterion>
- Deviations and oddities: <anything unplanned>
- What it decides: <which candidate or theory this supports, rejects or leaves open>

#### Verification YYYY-MM-DD — <verifier>

- Method: <re-derived from recorded data / reduced rerun / full rerun>
- Agreement: <agree / disagree / oddity>, with the specific numbers compared
```

## Order

Run existing-data and offline experiments first; they cost no provider spend and can prune
candidates before any live run.

| Stage            | Experiments                                      | Needs                                       |
| ---------------- | ------------------------------------------------ | ------------------------------------------- |
| 1. Existing data | T2/T3, T17                                       | Counts-only exports                         |
| 2. Offline       | T1/T4, T5, T9, T12, T13, T14, T15, T18, T21, T22 | Scripted transport, fictional fixtures      |
| 3. Route reads   | T20                                              | Configuration reads and one fictional probe |
| 4. Small live    | T11, T10, T16, T6, T23, T7/T8                    | Stages 1–3, prototypes, run plan (rule 8)   |

T19 was withdrawn on 2026-09-24 before running; see its entry.

## Stage 1: existing data

### T2 and T3: what drives request latency

Task: [CRS-092](application-todo.md#crs-092).

- **Question.** Does a request's input size drive its wall time (T2), and does output length set a
  floor on multi-record processing time (T3)?
- **Proposal predicts.** Unknown for T2; the proposal treats context work as a token measure until
  this runs. For T3, output floor at 50–100 output tokens per second puts 800 dense pages at 2.9–5.8
  hours of decoding alone.
- **Inputs.** The 31 sequential provider-request spans in the 2026-09-23 live slice
  ([import performance](import-performance.md#observed-provider-slice-on-2026-09-23)). The
  per-request export is outside Git; ask the owner for counts-only rows: duration, input, cached
  and output tokens per request.
- **Method.** Fit duration against input, cached-input and output tokens by ordinary least squares.
  Report each slope with a 95% interval, R², and the residual plot's shape. The output slope's
  inverse is the implied decode rate. Apply it to the M200 and M800 output from the cost model.
- **Criteria (proposed).** T2 holds if the input slope's interval excludes zero and input explains
  at least 25% of variance beyond output. T3 holds if the implied decode rate puts M800 output
  above two hours.
- **Decides.** If T2 fails, context work saves tokens only, and time work must cut round trips,
  output or human waits. If T3 holds, multi-record time improves only through parallel workers or
  smaller record envelopes; otherwise parallelism stays shelved.
- **Caveat.** 31 points from one run, one route and one day; wall time includes the proxy and
  network. Report it as indicative.

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, prerequisite check only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; no experimental provider route used for this check.
- Parameters and fixtures: none executed. The owner-provided counts-only per-request export is unavailable. It was requested; no private directories were searched and no profile was opened.
- Commands: `git worktree list` (read-only); read this brief and its recorded prerequisite/trigger.
- Measurements: measured repository inventory contains one main worktree and zero prototype
  worktrees. No regression was run. Individual duration, input, cached-input and output rows, slopes, confidence intervals, R², residual shape and decode-rate estimates are unknown. The published aggregate slice totals cannot reconstruct the joint request-level observations.
- Against the criteria: inconclusive; a missing prerequisite is not a candidate pass or fail.
- Deviations and oddities: Git remains read-only. This entry records why the experiment did not
  run; it is not a simulated result or evidence from owner records.
- What it decides: T2/T3 and CRS-092 remain open. T9 also lacks the requested measured delay distribution.


#### Verification 2026-09-24 — independent verifier, T2/T3 prerequisites only

- Method: independently read the brief and rule 10, ran `git worktree list --porcelain`
  and inspected the changed-file inventory. Measured inventory: one main checkout and zero
  registered prototype worktrees; no private-directory discovery was performed.
- Agreement: **agree**, limited to the prerequisite/non-execution record. The public live-slice report has aggregate counts and duration, not the request-level joint observations needed for regression. No counts-only export was supplied in this session. Slopes, intervals and decode rate remain unknown.
  This is not a verified experimental outcome and does not close the experiment or its task.


### T17: library profile

Task: [CRS-099](application-todo.md#crs-099).

- **Question.** What does the real workload look like: source sizes and types, the share of pages
  with no text layer, and how much re-exports overlap earlier imports?
- **Proposal predicts.** Unknown. Missed assumption 7 says the workload mix decides whether small or
  large sources should drive the design.
- **Inputs.** The owner's own library, on the owner's machine, with the owner's authorization.
  **Counts only** leave the machine.
- **Method.** A local script over retained originals and plans that emits:
  - histograms of page counts and of type (PDF, image, ZIP, JSONL, other),
  - per PDF, pages whose text layer is empty or below 50 characters,
  - per pair of originals with similar names or sizes, the D1 exact-page match share and, if T12
    has produced a winnowing implementation, the D2 span-match share.

  The script must never print names, dates, values, file names or paths.

- **Criteria.** None; this is descriptive. Record counts with the date and library size.
- **Decides.** Whether OCR (T18) matters. If most large sources already have a text layer, it is a
  smaller priority. It also shows how much a re-export policy (candidate L) could save, and which
  scenario sizes deserve fixtures.
- **Updated 2026-09-24.** Re-exports are now always read in full, so the overlap counts size the
  reconciliation and batch-approve workload rather than a token saving.
- **Split into two parts (2026-09-24).** An agent writes the scripts; the owner does the two steps
  that need the unlocked profile, because agents never unlock it.
  - **Part A, no new app code.** The owner downloads **Download performance diagnostics** from
    Import (metadata only: no medical text, filenames or identity; the latest 100 imports) and
    saves it outside the repository. A script reduces it to counts: page-count histogram, share of
    pages with a zero or under-50-character text layer, tokens per page and requests per page. It
    prints counts only and never echoes identifiers from the file. Answers most of OI-10 and OI-20.
  - **Part B, later.** Type and size histograms over every retained original, and re-export page
    overlap, need a read-only, counts-only tool that runs inside the unlocked app. Built in a
    worktree (rule 10) and run by the owner.

#### Results

_None yet._

#### Run 2026-09-24 — runner subagent (Part A preparation only)

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node v24.19.0, macOS arm64, scripted fictional fixtures; no owner library accessed.
- Parameters and fixtures: reusable `src/scripts/processing-library-counts.ts`; independently fictional unit fixtures include observed counts 0 and 49, unknown and conflicting counts, and a source-wide null-page scope. No randomized seed.
- Commands: `node --test src/scripts/processing-library-counts.test.ts`; owner-authorized data command, not yet run: `node src/scripts/processing-library-counts.ts /absolute/external/owner-provided-diagnostics.json`. Errors emit a fixed message and never echo input data or filesystem paths.
- Measurements: measured implementation checks: 3 passing tests, 0 failures (the command above). Fixture expectations: 4 numbered scopes, 1 excluded source-wide scope, 2 observed text counts, zero share 0.5 and under-50 share 1 among observed counts; canonical requests/page = 6/4 = 1.5, input tokens/page = 400/4 = 100, output tokens/page = 80/4 = 20. These are fictional fixture values, not library observations. Real library counts remain unknown.
- Against the criteria: descriptive experiment remains incomplete pending owner-provided download. Part A script is ready; Part B has not run.
- Deviations and oddities: current export (`ImportDiagnosticsControl.tsx`, `index.ts` GET import-diagnostics, `intake-attribution.ts` exportImportAttribution) has retained numbered page scopes, not independently known original page totals, types, or sizes. The script labels its histogram accordingly; it cannot certify complete-library page counts. Observed-only text denominators exclude unknown/conflicting and source-wide rows. Canonical import request totals avoid summing nonadditive page exposures. Per-page ratios use only imports with complete history/request metadata, and token ratios additionally require complete reported usage; missing ratios are null. Export truncation remains explicit.
- What it decides: nothing about actual workload yet. Stop at Part A and ask the owner for the diagnostics download path; do not unlock a profile or discover private data. Independent verification is pending.

#### Verification 2026-09-24 — independent verifier, T17 Part A preparation

- Method: read the reducer and current export producer, reran
  `node --test src/scripts/processing-library-counts.test.ts`, and independently exercised a
  three-import fictional input via `node --input-type=module`. Complete-history import A had
  two numbered pages (observed text counts 0 and 50), one null-page scope, 8 requests, 800 input
  and 40 output tokens; truncated import B had two pages (observed 49 and conflicting),
  9 requests, 900 input and 45 output tokens; complete-history import C had one unknown-text
  page, 1 request, 3 input tokens and incomplete usage. Export was marked partial with
  2 omitted imports. These parameters independently reproduce the edge-case receipt.
- Agreement: **agree** with script readiness and all stated fixture arithmetic. The original
  tests measured 3 passes and 0 failures. The independent input measured 5 numbered scopes,
  1 excluded source-wide scope, 3 observed text counts, 1 zero, 2 under 50, 1 unknown and
  1 conflicting. Requests per retained scope were `(8 + 1) / (2 + 1) = 3`; complete-usage
  input/output ratios were `800 / 2 = 400` and `40 / 2 = 20`. The script excluded truncated
  history from those ratios and preserved partial-export and omission flags. Observed counts
  of exactly 50 were correctly excluded from under-50 totals. CLI privacy tests passed for
  malformed data and missing files. Actual library statistics, original page totals and Part B
  remain unknown; this verification does not complete T17 or CRS-099.

## Stage 2: offline

### T1 and T4: where the input characters go

Task: [CRS-091](application-todo.md#crs-091). Related: [CRS-079](application-todo.md#crs-079).

- **Question.** Which parts of each request make up the input: system prompt, tools, schema
  copies, seed, snapshots, receipts, evidence and residual history? How does that split change at
  1, 10, 200 and 800 pages?
- **Proposal predicts** (model): residual history is 87–93% of input for long sources. Fixed
  overhead (system, tools and one schema copy, about 70,000 characters) dominates one- and ten-page
  sources.
- **Inputs.** The controlled continuation harness
  ([intake-pdf-controlled](../src/server/test/intake-pdf-controlled.integration.test.ts)) with a
  scripted transport and fictional PDFs at 1, 10, 200 and 800 pages, U = 2 and U = 10.
- **Method.** Wrap the scripted fetch transport so each request body is decomposed before it
  "leaves": characters per message role, per tool result type, per field
  (`instructions`, `original.text`, intake snapshot, receipts), and exact versus compacted status.
  Emit one row per request.
- **Criteria.** Descriptive, with one check. The cost model's per-request predictions (`P + r·j`)
  must be within ±20% of the measured sizes. If not, refit `freshRequestChars` and the residual
  parameters, record the new values, and update the model's defaults in a separate change.
- **Decides.** Whether B's target (residual history) is the right one, and how much H can save.
  This recalibrates the cost model.

#### Results

_None yet._

#### Run 2026-09-24 — runner subagent (T1/T4 mixed fixtures)

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node v24.19.0, macOS arm64, scripted upstream, no provider inference. Read the brief, proposal “Model and calibration”, “What arithmetic settles”, “Assumptions the earlier analysis missed”, controlled integration test, fixture generator, transcript compaction/sizing, and reading limits before running.
- Parameters and fixtures: existing `writeFictionalBenchmarkPdf(path, N, 'mixed')`, no padding, deterministic page-number-seeded raster texture; N = 1, 10, 200, 800, requested U = 2 and 10, effective U = min(N, U). One existing fictional control-flow record per page, batch publication after each unit. Real host/tool execution, durable proposal creation, PDF delivery, automatic continuation and unchanged production guards. This is measurement instrumentation, not a candidate implementation. All harnesses, PDFs, logs and receipts remain in an external scratch directory.
- Commands: after reconstructing the external harness as described below, from the repository root run `EXPERIMENT_PAGES=200 EXPERIMENT_UNIT=2 EXPERIMENT_KIND=mixed HEALTH_PDF_CONTROLLED_REPORT="$EXPERIMENT_ROOT/n200-u2.json" node --test "$EXPERIMENT_ROOT/t1.test.ts"`, substituting each N/U pair. `EXPERIMENT_ROOT` is an owner-selected external scratch directory. Receipts are named `n1-u2.json`, `n1-u10.json`, `n10-u2.json`, `n10-u10.json`, `n200-u2.json`, `n200-u10.json`; failed uploads have `.log` receipts and no request rows. `node --input-type=module -e "import {intakeLimits} from './src/server/intake-files.ts'; console.log(intakeLimits().uploadBytes)"` records the configured upload limit.
- Measurements, all **measured** from those receipts unless explicitly labelled model/unknown:
  - N1, either requested U: 5 requests, 1 slice, 328,750 cumulative text characters, 92,354 peak. Both independent schedules complete; 1 page read/delivered and 1 ready record. Role totals: system 145,203; tools 68,130; user 17,947; assistant 3,910; tool-result messages 92,933; remaining wire framing 627. First-user seed contributions total 17,255. Inclusive field totals: exact schema instructions 45,938; exact original text 11,346; intake snapshots 5,848; receipt strings 0.
  - N10 U2: 18 requests, 1 slice, 2,385,415 cumulative characters, 204,189 peak; 10 pages read/delivered, 10 ready records, 5 proposals. Role totals: system 523,867; tools 245,268; user 99,876; assistant 96,074; tool messages 1,417,761; framing 2,569; seed 62,118. Inclusive fields: exact schema 551,256; exact text 56,796; snapshots 299,069; receipts 67,554.
  - N10 U10: 14 requests, 1 slice, 1,619,049 cumulative characters, 160,398 peak; 10 pages read/delivered, 10 ready records, 1 proposal. Role totals: system 407,355; tools 190,764; user 76,964; assistant 30,020; tool messages 912,005; framing 1,941; seed 48,314. Inclusive fields: exact schema 459,380; exact text 56,780; snapshots 191,295; receipts 49,830.
  - N200 U2: 307 requests in slices [64, 64, 64, 64, 51], 219,059,235 cumulative characters, 1,516,602 peak; all 200 pages read/delivered, 200 ready records, 100 proposals. Role totals: system 8,940,111; tools 4,183,182; user 7,344,154; assistant 7,283,546; tool messages 191,246,254; framing 61,988; seed 4,435,204. Tool-result types: plan 2,239,073; read 49,737,174; batch 139,270,007. Inclusive fields: exact schema 11,369,655; exact text 1,113,735; snapshots 24,930,480; receipts 6,274,368.
  - N200 U10: 226 requests in slices [64, 64, 64, 34], 74,197,598 cumulative characters, 607,262 peak; all 200 pages read/delivered, 200 ready records, 20 proposals. Role totals: system 6,581,180; tools 3,079,476; user 5,853,530; assistant 3,261,003; tool messages 55,375,902; framing 46,507; seed 3,040,108. Tool-result types: plan 805,757; read 46,357,776; batch 8,212,369. Inclusive fields: exact schema 9,555,104; exact text 1,130,435; snapshots 23,722,166; receipts 6,118,554.
  - N800, either requested U: upload rejected with HTTP 413 / `FILE_SIZE`, before any scripted request. The U10 regeneration records **measured** source size 180,642,382 bytes (179,731,780 embedded JPEG bytes), above **measured** configured limit 134,217,728 bytes. U2 failed before fixture metadata was recorded; its exact bytes are **unknown**, though the generator parameters are identical. These are failed admission attempts, not completed 800-page processing runs. The separate dense-fixture run below addresses the admitted 800-page workload without changing limits.
  - All six admitted runs ended `complete` / `reading_exhausted`, with empty tool-error arrays, contiguous unique page reads equal to the delivered-page sets, and actual original SHA-256 checks equal. Tokens and provider time are **unknown**: the scripted transport intentionally omits usage. Wall times are instrumented, concurrent-host observations, not performance conclusions.
- Against the criteria: **fail** the default per-request ±20% check on every admitted cell. **Model** predictions are `55,000 + r*j`, j zero-based within each actual slice, r = 13,300 for effective U1, 23,400 for U2, 11,100 for U10. Within ±20% of measured size: 3/5 for each N1 run, 1/18 for N10 U2, 11/14 for N10 U10, 243/307 for N200 U2, 132/226 for N200 U10. Maximum relative errors respectively 51.98%, 141.51%, 43.73%, 56.83%, 37.61%. A **model refit** with P equal to the mean measured j=0 request size, then `r_u = sum(j*(size-P))/sum(j*j)` within each effective U, gives P = 53,400.62; r1 = 8,442.03; r2 = 21,325.26; r10 = 8,981.52 characters. It puts 493/575 observed requests within ±20%, still not a calibrated universal model. These are provisional fixture-specific values; model defaults were not edited in this experiment. Any default update belongs in a separate change after independent verification and the consistent dense matrix.
- T4 interpretation: system+tools alone comprise **measured** 64.89% at N1, 32.24% at N10 U2, 36.94% at N10 U10. Adding at most one exact schema copy per request gives 78.87%, 46.69%, 52.55%; adding all exact copies gives 78.87%, 55.35%, 65.32%. Thus one-page fixed-overhead dominance holds; ten-page dominance depends on whether repeated schema copies count as fixed overhead. Do not silently mix those definitions.
- T1 interpretation: all tool-message characters minus exact schema and exact original text comprise **measured** 81.60% at N200 U2 and 60.23% at U10. These quantities include current snapshots and other retained tool-result fields; they are an inclusive retained-tool-context measure, **not an exact stale-history share**. The 87–93% claim is not established by this fixture. The particularly large batch-result contribution at U2 supports investigating bounded receipts; no extraction-quality conclusion follows.
- Deviations and oddities: mixed N800 exceeds upload admission. The harness preserves the original test's literal filenames, 100-page test title and “ten pages” explanatory strings to avoid changing request text beyond N/U; those labels are not measurement authority. Fixed-100 post-run assertions were replaced by inspecting recorded actual status, coverage, error arrays and hash checks, so a TAP pass alone does not certify completion. First mixed runs used 1,100-second polling / 1,200-second test wrappers; later runs use 2,000 / 2,100 seconds. No wrapper bound fired. The app's transcript, slice, request and token guards were never raised. New dense runs retain the predeclared criterion.
- What it decides: the current per-request cost model needs recalibration and a clearer fixed/schema/history partition; the exact 800-page comparison and a final refit remain open. Outcomes require the separate verifier entry.

Portable reconstruction of the external T1/T4 measurement harness (no prototype source is added to Git):

1. Copy `src/server/test/intake-pdf-controlled.integration.test.ts` outside the checkout. Resolve each relative import against the original `src/server/test` directory to an absolute module path. Keep all existing scripted payload strings and filenames. Add `N = Number(process.env.EXPERIMENT_PAGES)` and `U = Math.min(N, Number(process.env.EXPERIMENT_UNIT))`. Generate N pages with `EXPERIMENT_KIND` (default mixed). Use U for plan unit size, every original batch-array length 10 (clamped to pages so far), and every `nextPage - 10` offset. Enter batch phase at `page % U === 0 || page === N`; enter complete phase after `nextPage > N`.
2. Preserve the actual assistant, manager, bridge, tool acknowledgement and media-hash logic, `pollMs: 5`, `continuationDelayMs: 1`, transcript assertions and on-tool error collection. Disable the environment skip. Set only the outer test timeout to 2,100,000 ms and polling deadline to 2,000,000 ms; stop polling at complete, paused or failed. Replace the fixed-100 assertion block after fetching final state with report fields for N/U/kind, final status, errors, phase and request rows. Retain the original report's actual page, slice, reading and proposal counts. Recompute `originalSha256Unchanged` from the retained original rather than hardcoding it. Do not interpret inherited hardcoded `acceptedDocuments: 0` as a measured database query.
3. In `fetchImpl`, immediately after parsing the body and before choosing the scripted reply, append one row. j is the number of previously recorded requests in this slice. Use `proxyTranscriptSize(body)` for total text and media. For decomposition, clone the body and replace file-data/image-URL strings with empty strings exactly as that function does. Sum `JSON.stringify(message).length` by role and `JSON.stringify(body.tools).length` for tools. Track tool-call IDs to function names from assistant messages, then sum tool-message lengths by that name. Wire framing is total minus role sums minus tools. Seed is the first request's user-role size in each slice, counted once in each request of that slice.
4. Parse tool-message content as JSON. For a field value v, its escaped contribution inside that content string is `JSON.stringify(JSON.stringify(v)).length - 2`. Count `instructions`, `original.text`, and `intake`; classify exact versus compacted by the literal `HOST_TRANSCRIPT_RECEIPT` marker, also recording exact/compacted read counts. Recursively count marker-bearing strings as receipt contributions. These field counters are **inclusive and overlapping**: receipts include the compacted instructions/text contributions; do not sum them as a partition. Record j, slice and the default model prediction alongside each row. The role/tools/framing counts, unlike these field counters, form the complete partition.
5. Keep each receipt outside Git. Sum its rows to reproduce the counts above. For model error use `abs(predicted-measured)/measured`; do not compare only aggregate totals. Verify actual delivered/read sets and stop reasons separately from the test runner's exit status. Raw media bytes are removed from the decomposition clone and no request bodies are retained.

#### Verification 2026-09-24 — independent verifier, T1/T4 mixed fixtures

- Method: independently summed each of the six admitted per-request receipts and recomputed
  role/framing partitions, inclusive field counts, model errors and the recorded refit from
  its formulas. Inspected the failed N800 logs, U10 fixture metadata and current upload-limit
  function. Also ran the reduced check
  `EXPERIMENT_PAGES=1 EXPERIMENT_UNIT=2 HEALTH_PDF_CONTROLLED_REPORT=/tmp/processing-t1-verifier-n1-u2.json node --test /tmp/processing-t1-run/t1.test.ts`;
  the external harness is reconstructed by the runner's instructions above. The reduced
  receipt's entire request-row array exactly equaled the runner's N1/U2 array.
- Agreement: **agree** with the mixed-run measurements and scoped conclusions. Independently
  recovered cumulative characters 328,750 for each N1 schedule, 2,385,415 and 1,619,049 for
  N10/U2 and U10, and 219,059,235 and 74,197,598 for N200/U2 and U10. Request counts were
  5, 5, 18, 14, 307 and 226; all recorded read/delivery sets, final states and original hash
  checks agree. All published role, tool-type, inclusive field, seed, framing and peak counts
  re-derived exactly. Within-tolerance counts re-derived as 3, 3, 1, 11, 243 and 132;
  the ±20% criterion therefore fails in every admitted cell. Refit independently reproduced
  P 53,400.6154, r1 8,442.0282, r2 21,325.2637, r10 8,981.5184 and 493/575 within tolerance.
  The upload function returned 134,217,728 bytes; the U10 fixture receipt reports 180,642,382
  bytes, consistent with the two logged admission failures. No N800 processing result is
  inferred from those failures. Fixed-share and retained-tool-context percentages also agree;
  inclusive receipts are not an additive partition or a direct stale-history measurement.
  The mixed entry is verified, while the admitted 800-page comparison and final calibration
  remain open pending their separate results.


#### Run 2026-09-24 — runner subagent (T1/T4 dense matrix, unchanged guards)

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node v24.19.0, macOS arm64, scripted. Same source/citation reads and measurement method as the preceding mixed entry. No production changes or provider inference.
- Parameters and fixtures: `writeFictionalBenchmarkPdf(path, N, 'dense')`, N = 1, 10, 200, 800, requested U2/U10, effective U = min(N,U), deterministic and unpadded, one fictional record per page. Dense originals have **measured** sizes 1,999 / 17,343 / 342,466 / 1,371,930 bytes. N1 mixed and dense are byte-identical: both have SHA-256 `dda9546ca5d4c824da6e95a032e7ac1d9adb07824f64d7127a415a8aa60b9bae`; reuse the two existing N1 measurements explicitly, not as new runs. Larger dense cells are separately executed and never pooled with the mixed cells for the fit below.
- Commands: same reconstructed external T1 harness, e.g. `EXPERIMENT_PAGES=800 EXPERIMENT_UNIT=2 EXPERIMENT_KIND=dense HEALTH_PDF_CONTROLLED_REPORT="$EXPERIMENT_ROOT/n800-u2-dense.json" node --test "$EXPERIMENT_ROOT/t1.test.ts"`, substituting each larger N/U pair. Run bounds are 2,000 seconds polling / 2,100 seconds test; neither fires. At most two isolated fictional harness processes run concurrently, with separate temporary databases and receipt files; no host-performance claim is made. To reproduce N1 equivalence, generate a dense one-page fixture externally and compare the returned hash/byte size with `n1-u2.json`'s fixture metadata.
- Measurements: the following are **measured**, using receipt stems `nN-uU-dense.json` for larger fixtures and the earlier N1 stems. Text characters exclude media data strings. Role/tools/framing form a complete partition. Seed and nested-field/receipt counters are inclusive subsets, not extra addends.
  - N10 U2: 18 requests, 1 slices, 2,465,021 cumulative text characters, 209,891 peak; 10 pages read/delivered, 10 ready records, 5 proposals. Partition: system 523,867; tools 245,268; user 99,824; assistant 96,074; tool messages 1,497,419; framing 2,569. Seed 62,118. Inclusive fields: exact schema 551,256; exact original text 136,178; intake snapshots 299,069; receipt strings 67,710. Tool-result types: plan 130,009; read 1,137,127; batch 230,283.
  - N10 U10: 14 requests, 1 slices, 1,675,921 cumulative text characters, 166,100 peak; 10 pages read/delivered, 10 ready records, 1 proposals. Partition: system 407,355; tools 190,764; user 76,924; assistant 30,020; tool messages 968,917; framing 1,941. Seed 48,314. Inclusive fields: exact schema 459,380; exact original text 113,482; intake snapshots 191,295; receipt strings 49,950. Tool-result types: plan 84,617; read 877,506; batch 6,794.
  - N200 U2: 307 requests, 5 slices, 220,776,098 cumulative text characters, 1,522,418 peak; 200 pages read/delivered, 200 ready records, 100 proposals. Partition: system 8,940,111; tools 4,183,182; user 7,338,450; assistant 7,283,546; tool messages 192,968,821; framing 61,988. Seed 4,435,204. Inclusive fields: exact schema 11,369,655; exact original text 2,809,737; intake snapshots 24,930,480; receipt strings 6,291,480. Tool-result types: plan 2,239,073; read 51,459,741; batch 139,270,007.
  - N200 U10: 226 requests, 4 slices, 75,448,280 cumulative text characters, 613,127 peak; 200 pages read/delivered, 200 ready records, 20 proposals. Partition: system 6,581,180; tools 3,079,476; user 5,848,058; assistant 3,261,003; tool messages 56,632,056; framing 46,507. Seed 3,040,108. Inclusive fields: exact schema 9,555,104; exact original text 2,361,314; intake snapshots 23,722,166; receipt strings 6,134,970. Tool-result types: plan 805,757; read 47,613,930; batch 8,212,369.
  - N800 U2: 1,024 requests, 16 slices, 830,087,567 cumulative text characters, 1,532,547 peak; 671 pages read/delivered, 670 ready records, 335 proposals. Partition: system 29,820,080; tools 13,953,024; user 29,537,274; assistant 25,449,193; tool messages 731,118,139; framing 209,857. Seed 19,428,608. Inclusive fields: exact schema 38,151,509; exact original text 9,428,851; intake snapshots 87,454,332; receipt strings 21,955,800. Tool-result types: plan 3,218,301; read 178,113,187; batch 549,786,651.
  - N800 U10: 896 requests, 14 slices, 393,189,513 cumulative text characters, 822,130 peak; 800 pages read/delivered, 800 ready records, 80 proposals. Partition: system 26,092,570; tools 12,208,896; user 28,870,476; assistant 14,123,803; tool messages 311,703,326; framing 190,442. Seed 16,768,320. Inclusive fields: exact schema 38,243,385; exact original text 9,451,599; intake snapshots 104,500,376; receipt strings 26,543,430. Tool-result types: plan 2,033,357; read 203,939,276; batch 105,730,693.
  - N1 measurements and complete partition remain exactly those in the preceding mixed entry: each requested U has 5 requests and 328,750 cumulative characters. The two N1 runs contribute 10 measured rows to this matrix.
  - All eight cells have empty tool-error arrays, contiguous reads equal to delivered sets, and matching original hashes. N1/N10/N200 and N800 U10 reach `reading_exhausted`. **N800 U2 is partial:** the unchanged 16-slice limit stops after 1,024 requests, 671/800 pages read, 670 ready records, 335/400 units accounted, 65 units remaining, and one pending read window. Its outer batch status is `complete` while `finalReading.status` is `paused` and reason `job_limit`; outer status and TAP pass must not be treated as full processing. No budget extension or Resume was used. N800 U10 finishes all 800 pages in 896 requests / 14 slices. Token usage is **unknown**, not zero; the scripted provider omits usage.
- Against the criteria: **fail** the original default per-request ±20% check on every cell. Within tolerance: N1 each 3/5; N10 U2 1/18 and U10 11/14; N200 U2 241/307 and U10 142/226; N800 U2 943/1,024 observed requests and U10 713/896. This totals 2,057/2,495 measured requests. Do not extrapolate the partial U2 cell to unseen requests or compare its cumulative input as a completed 800-page run.
- **Model refit**, same declared estimator as the mixed entry: P = mean(size at j=0) = 58,905.23 characters; r1 = 6,607.16, r2 = 23,036.46, r10 = 11,150.57 from `sum(j*(size-P))/sum(j*j)` in each effective U. This yields only 2,079/2,495 requests within ±20%; changing defaults alone does not meet the criterion. Unconstrained joint least squares for one common P gives P = 98,358.45 and r1 = -6,543.92, r2 = 22,096.11, r10 = 10,209.54; the negative U1 residual is not an admissible cost-model default and shows the small/large-phase mismatch. Separate per-U descriptive fits give P/r/R² = 39,796.60 / 12,976.70 / 0.86788 at U1; 93,201.28 / 22,219.03 / 0.98438 at U2; 105,027.46 / 10,050.47 / 0.94291 at U10. These are fitted models, not measured token use. Default changes are deferred to a separate calibration change; no production defaults were edited.
- T4: **measured** system+tools shares are 64.89% at N1, 31.20% at N10 U2, 35.69% at N10 U10. Adding at most one exact schema per request gives 78.87%, 45.18%, 50.76%; counting every exact schema copy instead gives 78.87%, 53.57%, 63.10%. The one-page conclusion is stable; the ten-page conclusion is definition-sensitive, as in the mixed entry.
- T1: **measured** retained-tool-context shares after subtracting exact schema and exact original text are 80.98% / 59.27% at N200 U2/U10 and 82.35% / 67.15% in the observed N800 U2/U10 runs. Batch-result history is the largest contributor at U2; snapshots are a substantial contributor at U10. These totals still include the current tool context. The exact stale-history share is **unknown**, and the proposal's universal 87–93% statement is not established. Field-level eviction candidates remain worth testing, but an exact current-versus-stale partition and a better phase-aware model are outstanding.
- Deviations and oddities: this dense matrix was added after mixed800 hit upload admission, with the fixture-class change recorded before the runs and the criterion unchanged. None of the production size, media, round, slice, request or token guards changed. N800 U2 demonstrates that a batch-container terminal status does not certify full source processing. Its unobserved 129 pages remain unknown. These fixtures intentionally retain the original control-flow test's literal labels; they measure no clinical extraction fidelity.
- What it decides: all requested size/unit cells have now been exercised with an admissible consistent fixture class, including the natural U2 guard stop. The per-request cost model fails the fixed criterion; a simple default refit is insufficient, and exact stale-history attribution remains open. Separate independent verification is required, and CRS-091 remains open for those remaining method/calibration requirements.

#### Verification 2026-09-24 — independent verifier, T1/T4 dense matrix

- Method: independently recomputed all role/framing partitions, nested-field and tool-type
  totals, seed estimates, maxima and default errors from every dense request row, checking
  actual coverage and stop reasons separately. Re-derived the fixed-P refit and per-U OLS
  fits; solved the common-P fit by eliminating each slope analytically rather than using the
  runner's matrix solver. Regenerated the one-page dense PDF independently to check the
  explicit reuse of N1. The earlier T5 verification also reran N10/U2 dense and reproduced its
  baseline rows exactly.
- Agreement: **agree** with the measurements and failure conclusion. All reported character
  partitions, subset counters, peaks and fixture byte sizes re-derived exactly. The regenerated
  one-page source was 1,999 bytes with the recorded `dda9546c…b9bae` hash. Default tolerance
  counts total 2,057/2,495; fixed-P fit independently gives P 58,905.2326, r1 6,607.1558,
  r2 23,036.4561, r10 11,150.5746 and 2,079/2,495 within tolerance. Per-U intercepts,
  slopes and R² agree; analytic common-P fitting gives P 98,358.4531 and negative U1 residual
  -6,543.9177, confirming that fit is unsuitable as a default.
  N800/U2 has 1,024 requests and 830,087,567 characters but only 671 read/delivered pages,
  670 ready records, 65 remaining units and one pending window at `job_limit`. N800/U10 has
  896 requests, 393,189,513 characters and all 800 pages with no remaining units/windows.
  All receipts have `finalReading.status: paused`, including exhausted runs; reason plus
  coverage distinguishes the partial run, so neither outer `complete` nor inner `paused`
  alone certifies completeness. These results leave the outstanding calibration and exact
  stale-history partition requirements open, as the runner states.


#### Run plan 2026-09-24 — runner subagent (owner-authorized N800 U2 rerun plus Resume)

- The owner explicitly requested continuing beyond the displayed guard to obtain complete results, and preserving the first recording. The original stopped-run entry and raw `n800-u2-dense.json` remain unchanged. An exact additional copy is retained with this follow-up's external artifacts (original receipt SHA-256 `f85e21a2a46f70241219d4980d203b347ed993388fe7112d8e6435434fa7d5aa`). The first run's temporary database had already been deleted, so this is explicitly a **fresh deterministic rerun followed by Resume on that rerun's existing checkpoint**, not continuation of the old database.
- Predeclared plan: one dense fictional N800/U2 rerun using the same controlled harness schedule, fixture generator, record strings and request decomposition. At the first terminal reading `job_limit`, save the complete request-row prefix and both durable batch/checkpoint state and in-memory progress, call the existing `manager.resume(profileId, batchId)` exactly once, and record the immediate saved state after Resume. Do not mutate counters, plans, checkpoints, production guards or provider responses. If another unexpected stop occurs, retain it as a finding. Keep the new fictional runtime outside Git for later inspection.
- Before/after identity and continuity checks: same batch, intake, source hash, chat and plan; same already-produced proposal IDs; preserved cumulative request/slice/read/record counters; one increment to extensions and normal budget-offset movement from the existing Resume implementation. At completion require contiguous unique read and delivered page sets 1…800, 800 ready records, 400 accounted units, zero remaining units and pending windows, `reading_exhausted`, no tool errors, byte-identical retained original, and zero accepted documents measured directly from the fictional database. These are harness completion checks, not independent verification or clinical-quality criteria.
- Prediction, **model only**: the unchanged cost-model schedule has 1,202 executed calls, 20 slices and 1,222 physical requests. Actual request/character totals, original-stop prefix comparison and the Resume-only increment will be reported separately. The original per-request `P + r*j` ±20% criterion remains fixed; token use and model extraction quality remain unknown because transport is scripted.
- The isolated `t1-resume` worktree is based on `7dc23908299f5e79a0a324713d717f5df95f2778`. Outer harness bounds are declared now as 3,600 seconds polling / 3,700 seconds test, allowing the complete rerun plus Resume rather than cutting the follow-up at the earlier wrapper duration. The application's 16-slice allowance, request/token limits, 64-round bridge bound and two-hour active-work guard remain unchanged; Resume uses their existing explicit-extension mechanism. No live route or acceptance gate is exercised. Separate runner results and independent verifier entries will follow; previous recordings are retained.

#### Run 2026-09-24 — runner subagent (N800 U2 complete rerun plus Resume)

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node v24.19.0, macOS arm64, scripted transport in the isolated `t1-resume` worktree. Production code and all product guards are unchanged. This follows the preceding run plan; the earlier stopped recording is preserved separately.
- Parameters and fixtures: N800, U2, dense, deterministic `writeFictionalBenchmarkPdf`; same fictional request strings and decomposition as the original dense matrix. **Measured** original size 1,371,930 bytes and SHA-256 `e3511c30a46da330a858eadba4c78c4ccb3fe62783256dac7da5be1c5a2d34c7`. The prior database was deleted by its harness, so this is a new database and complete rerun, followed by Resume of the new run's checkpoint. It is not a continuation of the old database.
- Commands, from that worktree with a fresh external artifact directory: `EXPERIMENT_ARTIFACTS="$EXPERIMENT_ROOT" EXPERIMENT_PAGES=800 EXPERIMENT_UNIT=2 EXPERIMENT_KIND=dense HEALTH_PDF_CONTROLLED_REPORT="$EXPERIMENT_ROOT/resumed-full.json" node --test src/scripts/experiment-t1-resume.test.ts > "$EXPERIMENT_ROOT/run.log" 2>&1`; then `node "$EXPERIMENT_ROOT/analyze.mjs"`. The single test passes its explicit continuity and full-completion assertions. `npm run format:check` and `npm run typecheck` pass for the harness worktree. The wrapper's declared 3,600/3,700-second bounds do not fire; **measured** harness work duration is 446,335.74 ms, not an isolated host-performance benchmark.
- Portable reconstruction: start with the preceding T1 measurement method and original controlled integration test, retaining exactly the same scripted schedule and counters. Use an external `runtime/` directory and retain it after closing services. At the first terminal `job_limit`, write `{fixture, before, rows}` to `guard-boundary.json`, where `before` contains the saved batch/checkpoint, identity, existing proposal IDs, phase, next page and cumulative progress. Call `manager.resume(profileId, batchId)` once; read the saved state again and write the before/after pair to `resume-receipt.json`. Assert unchanged checkpoint, identity, proposal IDs and cumulative counters, plus one budget extension. Continue normal polling to the next terminal state. Save all request rows, both snapshots, final durable state, actual `SELECT COUNT(*) FROM documents` result and completion fields to `resumed-full.json` before asserting final coverage. Retain the fixture receipt, log, runtime and an exact copy of the original stopped receipt. Analysis sums row counters separately over the first 1,024 rows, remaining rows and full array; compare serialized row objects with the old receipt, and apply the already-declared per-request error and fresh-mean fit formulas.
- **Measured original stop versus new complete run:**
  - The preserved original is still 1,024 requests / 16 slices / 830,087,567 cumulative text characters, with 671 read/delivered pages, 670 ready records, 335 proposals, 65 remaining units and one pending read window at `job_limit`. Its receipt hash remains `f85e21a2a46f70241219d4980d203b347ed993388fe7112d8e6435434fa7d5aa`.
  - The new rerun's first 1,024 row objects serialize identically to every original measurement row: zero differing row indexes. It reaches the same measured guard boundary, including 830,087,567 characters and 1,532,547 peak request characters. This equivalence concerns the recorded request measurements, not whole runtime files with new timestamps and identities.
  - Resume adds **198 requests, four slices and 157,537,314 text characters**, with 1,530,756 peak request characters. It adds 129 read/delivered pages, 130 ready records and 65 proposals; the previously pending unit accounts for the difference between new reads and new ready records.
  - The complete rerun plus Resume totals **1,222 requests / 20 slices / 987,624,881 text characters**, with peak 1,532,547; slice lengths are nineteen times 64, then six. It reaches 800 unique contiguous read pages and 800 delivered pages, 800 ready records, 400 proposals and 400/400 accounted units, zero remaining units, zero pending windows and an empty error array. Both runner phase and outer batch are `complete`; reading is `paused` with reason `reading_exhausted`. The original remains byte-identical. Accepted documents are **measured zero by database query**, and the new fictional runtime is retained.
- **Measured Resume continuity:** before and immediately after the call, the batch/intake/source/chat/plan identity, saved checkpoint, already-produced proposal IDs, phase `read`, next page 672 and cumulative progress are unchanged. `extensions` changes 0→1; `budgetAtSlices` 0→16, `budgetAtTurns` 0→16, `budgetAtRequests` 0→1,024 and `budgetAtActiveMs` 0→319,623. `budgetAtTokens` remains zero because reported model usage is unavailable. Cumulative slices, requests and active time are not reset. Final cumulative active time is 444,388 ms; no second Resume is used. The final `readingJob.observed` guard sample still reports 798 records / 799 windows / 399 accounted units; final reading/plan/proposal state and actual read/delivery sets establish the complete 800/800/400 coverage.
- **Measured character decomposition:** role/tools/framing values are an additive partition; nested counters below are inclusive and overlapping, as before.
  - Full run: system 35,585,676; tools 16,650,972; user 36,167,152; assistant 30,261,194; tool messages 868,709,904; framing 249,983. Tool-result types: plan 3,218,301; read 211,904,581; batch 653,587,022. Inclusive fields: exact schema 45,478,620; compacted schema receipts 13,044,165; exact original text 11,239,740; compacted text receipts 13,044,165; intake snapshots 103,985,740; all receipt strings 26,088,330. Media data strings total 5,279,652 bytes across requests and are excluded from text characters.
  - Resume-only increment: system 5,765,596; tools 2,697,948; user 6,629,878; assistant 4,812,001; tool messages 137,591,765; framing 40,126. Tool-result types: plan 0; read 33,791,394; batch 103,800,371. Inclusive fields: exact schema 7,327,111; compacted schema receipts 2,066,265; exact original text 1,810,889; compacted text receipts 2,066,265; intake snapshots 16,531,408; all receipt strings 4,132,530. Additional media strings total 850,612 bytes.
- Against criteria: **pass** the predeclared continuity and complete-coverage checks; the schedule **model** prediction of 1,202 executed calls / 20 slices / 1,222 physical requests matches observed requests and slices. The unchanged default `P + r*j` character model still **fails** the fixed per-request ±20% criterion: original/prefix 943/1,024 within tolerance; Resume-only 175/198; full 1,118/1,222. Full maximum relative error is 56.83%; Resume-only maximum is 34.20%. Modeled cumulative characters are 811,110,400 for the prefix, 152,764,200 after Resume and 963,874,600 overall; aggregate closeness does not satisfy the per-request criterion.
- Descriptive **model refit**, not a default change: applying the existing fresh-mean estimator to this complete cell gives P = 62,386.05 and r2 = 23,454.2769 characters, with 1,173/1,222 requests within ±20%. Prefix-only fit gives P = 61,411.25 / r2 = 23,459.3332, with 984/1,024; Resume-only fit gives P = 66,285.25 / r2 = 23,457.7831, with 190/198. All still miss some requests. These cell-specific descriptive fits do not replace the earlier matrix calibration or establish a general model.
- Deviations and decision: none from the follow-up plan. Existing Resume can finish this scripted workload while preserving the saved checkpoint and earlier proposals; the original natural guard stop remains a separate valid observation. The completed U2 workload can now be compared with the previously completed U10 workload (896 requests / 393,189,513 text characters), while retaining both original and extended recordings. Tokens, clinical extraction quality and the exact stale-history share remain **unknown**; no production guards or defaults were changed. The remaining attribution/calibration requirements keep CRS-091 open pending further work and independent verification of this new entry.

#### Verification 2026-09-24 — independent verifier, N800 U2 rerun plus Resume

- Method: independently inspected the isolated harness and unchanged `manager.resume` /
  `extendReadingBudget` implementations before execution. Re-derived every request sum,
  decomposition, fixed-model tolerance count and fresh-mean fit from the new raw rows, without
  relying on the runner's analyzer. Compared all 1,024 boundary rows with the original receipt,
  checked before/after durable snapshots, and opened the retained fictional SQLite database
  read-only to inspect the final plan, proposals and accepted-document count. No provider or
  second full workload was run by the verifier.
- Agreement: **agree**. Both original U2/U10 receipt hashes remain unchanged; the copied U2
  receipt has the recorded hash. All 1,024 original request rows and fixture fields match the
  rerun prefix exactly. The preserved original remains the partial 671-page / 670-record /
  335-proposal observation at 16 slices. The new complete run has **1,222 requests, 20 slices
  and 987,624,881 text characters**; the Resume increment is **198 requests, four slices and
  157,537,314 characters**. Slice lengths independently sum to nineteen times 64 plus six.
- Continuity: identity, nonempty saved checkpoint, proposal IDs, phase `read`, next page 672,
  page sets and cumulative counters are identical immediately around Resume. The existing
  operation increments extensions 0→1 and sets all five budget offsets to the prior cumulative
  values, including 16 slices, 16 turns, 1,024 requests and 319,623 active milliseconds. It
  does not reset those cumulative values. The fresh runtime, rather than the deleted original
  database, is the checkpoint that was resumed.
- Completion: independently confirmed exactly pages 1…800 once each in the read list and
  delivered set, 800 ready records, 400 distinct unit receipts covering those pages, 400 saved
  proposals retaining all prior proposal IDs, and zero pending windows, remaining units or
  tool errors. The retained database independently contains 400 extracted plan units and 400
  batches, `imported = null`, and zero accepted documents. Hashing the actual retained original
  file reproduces the fixture hash. The final reading reason is `reading_exhausted`; the stale
  guard sample of 798/799/399 does not replace the final persisted coverage evidence.
- Character/model checks: all full and incremental role, tool, framing, nested-field and media
  sums agree. The additive full partition sums to 987,624,881; overlapping nested fields are
  not an additional partition. Using the unchanged error denominator (measured characters),
  the fixed model admits 943/1,024 prefix, 175/198 additional and **1,118/1,222 full** requests
  within ±20%; the maximum full error is 56.83%. The independent full fresh-mean fit gives
  P = 62,386.05 and r2 = 23,454.2769348436, admitting 1,173/1,222. Thus complete coverage
  passes while universal per-request model agreement still fails. Token usage, clinical
  extraction quality and exact stale-history attribution remain unknown; CRS-091 stays open.

### T5: prefix hygiene savings

Task: [CRS-093](application-todo.md#crs-093).

- **Question.** How much does candidate H save? H sends the schema once in the system prefix rather
  than in every read result, and sends conversion-only tools during intake.
- **Proposal predicts** (model): about 34,000 characters saved per non-first request; 800 pages at
  U = 2 falls from 241M to 231M tokens alone, or from 36.0M to 25.7M combined with B.
- **Inputs.** The T1 harness with the same scripted schedule.
- **Method.** Two branches of the request builder, one factor at a time: schema moved to the prefix,
  then tools filtered. Compare per-request characters for identical schedules. Confirm the model
  still receives every instruction it did before (diff the concatenated instruction text).
- **Criteria (proposed).** H is worth prototyping if it saves at least 20% of input at 10 pages and
  loses no instruction text.
- **Decides.** H's value, and whether it goes first as the lowest-risk change.

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, prerequisite check only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; no experimental provider route used for this check.
- Parameters and fixtures: none executed. Rule 10 requires an owner-created worktree for the request-builder prototype. Only the main checkout is registered; the requested worktree exception or owner-provided path has not arrived.
- Commands: `git worktree list` (read-only); read this brief and its recorded prerequisite/trigger.
- Measurements: measured repository inventory contains one main worktree and zero prototype
  worktrees. The modified request builder was not implemented or run. Per-factor savings and instruction-preservation results are unknown. T1/T4 baseline attribution alone cannot prove H preserves instructions.
- Against the criteria: inconclusive; a missing prerequisite is not a candidate pass or fail.
- Deviations and oddities: Git remains read-only. This entry records why the experiment did not
  run; it is not a simulated result or evidence from owner records.
- What it decides: T5 and CRS-093 remain open pending an isolated prototype worktree and T1 baseline receipts.


#### Verification 2026-09-24 — independent verifier, T5 prerequisites only

- Method: independently read the brief and rule 10, ran `git worktree list --porcelain`
  and inspected the changed-file inventory. Measured inventory: one main checkout and zero
  registered prototype worktrees; no private-directory discovery was performed.
- Agreement: **agree**, limited to the prerequisite/non-execution record. The brief requires modified request builders and an instruction-preservation comparison; current baseline attribution does not supply either result. Savings and preservation remain unknown.
  This is not a verified experimental outcome and does not close the experiment or its task.



#### Run 2026-09-24 — runner subagent (isolated T5 request-builder prototype)

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node v24.19.0, macOS arm64, scripted. The owner authorized the coordinator to create an isolated detached T5 worktree after the earlier prerequisite entry. Prototype files remain unmerged in that worktree; no application code changed in the main checkout. Read the T5 brief, candidate H and model/calibration proposal sections, `assistant.ts` tool registration and draft-repair filtering, `proxy-model-bridge.ts` request assembly, `intake-evidence.ts`, `intake-format.ts`, and the T1 harness before starting.
- Parameters and fixtures: deterministic dense 10-page fictional PDF, requested U2 and U10, same real host/scripted schedule as T1. For each observed request, compute five request-builder projections without changing the host schedule: baseline; schema in system prefix only; conversion-tool filtering only; schema plus filtering; and an additional preservation variant which appends removed tool descriptions to the system message. The extra variant was included before the runs, without changing the fixed 20% criterion. No live model or cache inference was performed.
- Commands, from the isolated worktree root: `EXPERIMENT_PAGES=10 EXPERIMENT_UNIT=2 EXPERIMENT_KIND=dense HEALTH_PDF_CONTROLLED_REPORT="$EXPERIMENT_ROOT/t5-n10-u2.json" node --test src/scripts/processing-prefix-hygiene-harness.test.ts`; repeat with U10 and output `t5-n10-u10.json`. `EXPERIMENT_ROOT` is external to every checkout. `npm run typecheck` and `npm run format:check` check the throwaway prototype. The same T1 reconstruction above supplies the host harness, with imports resolved against this worktree. Prototype source is `src/scripts/processing-prefix-hygiene-prototype.ts` in the unmerged T5 worktree, not in main.
- Measurements, all **measured** serialized text characters from per-request `hygiene` rows:
  - U2, 18 physical scripted requests: baseline 2,465,021; schema-only 2,324,093 (140,928 saved, 5.717%); tools-only 2,362,151 (102,870 saved, 4.173%); schema plus tools 2,221,223 (243,798 saved, 9.890%); preservation variant 2,247,485 (217,536 saved, 8.825%).
  - U10, 14 physical scripted requests: baseline 1,675,921; schema-only 1,535,661 (140,260 saved, 8.369%); tools-only 1,595,911 (80,010 saved, 4.774%); schema plus tools 1,455,651 (220,270 saved, 13.143%); preservation variant 1,476,077 (199,844 saved, 11.924%).
  - Current builder sends 15 tools; filtering retains 7 and removes 8, saving exactly 5,715 serialized characters/request. Retain `health_assistant_progress` and all six `health_intake_*` tools. This differs from the proposal's earlier 21-tool inventory and approximately 11,500-character tool saving.
  - The schema is 22,739 raw characters. Adding it to the first system message costs 22,820 serialized characters/request. Deleting one exact tool-result `instructions` field saves 22,987; hence schema-only adds cost before any read, saves only 167 with one exact copy, and saves 23,154 with two. Compacted instruction receipts remain unchanged. All 10 pages are read and delivered, and both baseline schedules finish `complete` with 10 ready records, no tool errors, and an unchanged original hash.
- Instruction-text diff: collect system-message text, every tool-result `instructions` string, and every function description; deduplicate whole fragments, concatenate candidate instruction fragments, and require each original fragment to remain an exact substring. This permits relocation and deduplication but no rewriting. Schema-only has zero missing fragments. Naive tool filtering, alone or combined, loses 8 complete description fragments totalling 1,443 raw characters on every request. Appending those exact descriptions to the system restores zero missing fragments, costing 1,459 serialized characters/request. This is a literal instruction-text check, not proof of equivalent model behavior or unchanged tool availability; removed functions and their argument schemas intentionally cease to be callable.
- Against the criteria: **fail** at both unit sizes: even the naive combined variant stays below the fixed 20% saving threshold. It also fails literal instruction preservation. The preservation variant passes the recorded text-preservation check but still saves only 8.825% / 11.924%, below 20%. Tokens, cache benefits, extraction quality, and behavior with unsupported general-tool references are **unknown**.
- Deviations and oddities: main-thread size measurements continue concurrently on this host, so no speed or contention claim is made. These are paired request-builder projections of a single acknowledged host schedule, not separate model-driven candidate schedules. Input generation, report filenames and media stay outside Git. Initial TypeScript checking found untyped annotations in the copied instrumentation harness; annotations were corrected without changing request text or the measured builder. Predeclared experiment criteria were not changed.
- What it decides: H alone does not earn priority under the predeclared 10-page threshold on the current tree. Its benefit combined with B, caching, or a different schedule remains open. A smaller tool list must consciously preserve any needed instructions instead of assuming tool-description removal is text-neutral. Independent verification is required before closing T5.

Portable reconstruction of the T5 builder: clone each T1 request body; append a newline plus the exported `INTAKE_SCHEMA_INSTRUCTIONS` to the first system content, including before the first read; for tool messages whose parsed `instructions` equals that exact constant, delete only that property and reserialize the content. Preserve compacted receipt instructions and all original text. For filtering, retain functions whose name starts `health_intake_` or equals `health_assistant_progress`, keeping definitions byte-identical; preserve original order. The preservation variant additionally appends a newline and the removed descriptions joined by newlines to the same system message. Size every projection with `proxyTranscriptSize`. For every baseline request, record projection size, removed schema/tool counts, retained tool count, original distinct instruction-fragment count, and missing-fragment/character counts as described above. Sum projection sizes over the identical request positions; savings are `(baseline - candidate) / baseline`.

#### Verification 2026-09-24 — independent verifier, T5 request-builder prototype

- Method: read the builder and host harness, independently summed both schedules' `hygiene`
  rows, and reran the N10/U2 command from the isolated T5 worktree with the separate external
  report `/tmp/t5-verifier-n10-u2.json`. The complete per-request row array, including all five
  builder projections, exactly equaled the runner's N10/U2 receipt. Independently recomputed
  savings and instruction-fragment counts for both U2 and U10.
- Agreement: **agree**. Combined savings are 243,798/2,465,021 = 9.890301% at U2 and
  220,270/1,675,921 = 13.143221% at U10; every other projection total and recorded difference
  also agrees exactly. Naive filtering loses 8 description fragments totaling 1,443 characters
  per request; the preservation variant reports zero missing fragments and savings 8.824915%
  and 11.924428%, respectively. The reduced rerun delivered all 10 pages, reached 10 ready
  records and `complete`, and retained the original hash. Neither combined variant reaches
  20%, so the declared criterion fails on both schedules. This verifies a paired structural
  comparison and its defined text-fragment check, not model behavior, caching or equivalence of
  the removed tool capabilities.


#### Run 2026-09-24 — runner subagent (T5 clarification)

- Correction to the isolated T5 prototype entry: “cease to be callable” refers only to the candidate's advertised wire tool catalog. The prototype compares request-builder projections and does not change the host bridge's registered tool dispatch set. It does not demonstrate that an unexpected call to an omitted function would be rejected. Host-side enforcement and autonomous model behavior remain unknown. This clarification changes no measured sizes, instruction-fragment counts, or threshold outcome.

#### Verification 2026-09-24 — independent verifier, T5 clarification

- Method: re-inspected `compareHygiene` and its harness call site.
- Agreement: **agree**. Filtering modifies only a cloned request whose size is measured;
  the host dispatch registry is untouched. The clarification correctly narrows the original
  wording, and the prior numerical verification remains valid.

### T9: parallel contention

Task: [CRS-094](application-todo.md#crs-094).

- **Question.** At what worker count does the local stack (app on two CPUs, proxy on one) stop
  scaling?
- **Proposal predicts.** The app is IO-bound (median 3.24% CPU in the live slice), so contention
  should come from the route's limits, not the host.
- **Inputs.** The Compose stack with a scripted provider that injects realistic delays (sample
  from T2's durations).
- **Method.** Step workers 1, 2, 4, 8 over the same fictional source. Record throughput, proxy and
  app CPU, event-loop delay and memory.
- **Criteria (proposed).** Throughput at 4 workers of at least 3× one worker means the host is not
  the limit.
- **Decides.** A worker cap, if candidate F is ever revived. Low priority while parallelism is
  shelved.

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, prerequisite check only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; no experimental provider route used for this check.
- Parameters and fixtures: none executed. The experiment lacks both its prototype worktree under rule 10 and the T2 measured duration rows used to sample provider delays.
- Commands: `git worktree list` (read-only); read this brief and its recorded prerequisite/trigger.
- Measurements: measured repository inventory contains one main worktree and zero prototype
  worktrees. No worker-count sweep was run. Throughput, app/proxy CPU, event-loop delay and memory under concurrent work are unknown; no host-capacity claim follows from the separate scripted continuation runs.
- Against the criteria: inconclusive; a missing prerequisite is not a candidate pass or fail.
- Deviations and oddities: Git remains read-only. This entry records why the experiment did not
  run; it is not a simulated result or evidence from owner records.
- What it decides: T9 and CRS-094 remain open. Do not substitute arbitrary delays or unconstrained host execution for the declared Compose experiment.


#### Verification 2026-09-24 — independent verifier, T9 prerequisites only

- Method: independently read the brief and rule 10, ran `git worktree list --porcelain`
  and inspected the changed-file inventory. Measured inventory: one main checkout and zero
  registered prototype worktrees; no private-directory discovery was performed.
- Agreement: **agree**, limited to the prerequisite/non-execution record. The brief requires a Compose worker sweep with delays sampled from T2. The absent request-duration rows cannot be replaced by the public aggregate; no contention metrics are established.
  This is not a verified experimental outcome and does not close the experiment or its task.


#### Run 2026-09-24 — coordinator, T9 prerequisite update

- Commit and environment: unchanged baseline; read-only repository inventory after the owner's
  explicit authorization to create isolated worktrees.
- Parameters and fixtures: no concurrency fixture executed. The owner requested proceeding
  without the missing historical diagnostics export.
- Commands: `git worktree list --porcelain`.
- Measurements: measured 9 registered worktrees, including the isolated T9 worktree.
  The worktree prerequisite is now resolved. The required per-request delay distribution from
  T2 is still unknown; no throughput, CPU, memory or event-loop measurements were fabricated.
- Against the criteria: inconclusive; the prescribed delay-sampled Compose sweep was not run.
- Deviations and oddities: this supersedes only the earlier missing-worktree prerequisite.
  Aggregate historical duration cannot reproduce a per-request latency distribution.
- What it decides: T9 and CRS-094 remain open while the independent fictional-data experiments
  proceed. No parallel-worker cap is selected.

#### Verification 2026-09-24 — independent verifier, T9 prerequisite update

- Method: independently reran `git worktree list --porcelain` and reread the declared T2
  duration-sampling dependency alongside the owner's instruction to proceed without the export.
- Agreement: **agree**. Nine worktrees are now registered, including T9, so the earlier
  workspace blocker is resolved. The historical per-request delays are still unavailable;
  no prescribed concurrency sweep or capacity result is established. T9 remains incomplete.

### T12: re-export fingerprinting

Task: [CRS-095](application-todo.md#crs-095).

**Updated 2026-09-24.** The owner decided re-exports are read in full, never skipped to save
tokens. Fingerprints now serve labeling ("matches your March import") and ordering (read new
pages first so new records reach review sooner), not skipping. The corrected-value criterion still
matters: a changed page must never be labeled as matching. Priority is lower.

- **Question.** Can D1 (normalized page hash) and D2 (shingling with winnowing) find the parts of a
  re-rendered export that match an earlier import?
- **Proposal predicts.** D1 works only for same-renderer copies. D2 finds spans regardless of
  pagination but breaks when reading order changes (multi-column layouts, tables).
- **Inputs.** Generated fictional charts, each rendered twice or more with changes:
  - other fonts, margins or page size (pagination changes),
  - new headers and footers ("Printed <date>, Page n of m"),
  - a year of new encounters appended, and sections reordered,
  - one corrected value inside an otherwise identical page (the case that must not be missed),
  - a two-column layout rendered both ways.
- **Method.** Implement D1 and D2 over the pdf.js text layer. Sweep `k` over 8–12 words and `w`
  over 4–8. Discount fingerprints that recur across unrelated spans. Report span-level precision
  and recall against the generator's ground truth, and whether the corrected value is flagged as
  changed.
- **Criteria (proposed).** D2 is viable if some (`k`, `w`) reaches span recall ≥ 0.95 and precision
  ≥ 0.99 across the render variants, **and** the corrected-value page is never reported as an exact
  match.
- **Decides.** Whether candidate L can rely on D2. It also sets default `k` and `w`.

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, prerequisite check only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; no experimental provider route used for this check.
- Parameters and fixtures: none executed. The D1/D2 prototype requires its own owner-created worktree under rule 10. No prototype worktree is registered and the requested exception or path is pending.
- Commands: `git worktree list` (read-only); read this brief and its recorded prerequisite/trigger.
- Measurements: measured repository inventory contains one main worktree and zero prototype
  worktrees. No fingerprint prototype, render-variant sweep, precision/recall measurement or corrected-value check was run. All candidate-quality results remain unknown.
- Against the criteria: inconclusive; a missing prerequisite is not a candidate pass or fail.
- Deviations and oddities: Git remains read-only. This entry records why the experiment did not
  run; it is not a simulated result or evidence from owner records.
- What it decides: T12 and CRS-095 remain open. Re-export skipping remains withdrawn regardless of future fingerprint results.


#### Verification 2026-09-24 — independent verifier, T12 prerequisites only

- Method: independently read the brief and rule 10, ran `git worktree list --porcelain`
  and inspected the changed-file inventory. Measured inventory: one main checkout and zero
  registered prototype worktrees; no private-directory discovery was performed.
- Agreement: **agree**, limited to the prerequisite/non-execution record. The brief requires a fingerprint implementation and rendered-variant ground truth. Neither a precision/recall result nor corrected-value detection is established by the prerequisite check.
  This is not a verified experimental outcome and does not close the experiment or its task.


#### Run 2026-09-24 — coordinator, D1/D2 fingerprint prototype

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64, existing pdf.js-backed `readPdfIdentityPageText`; offline.
  The owner explicitly authorized agent-created experiment worktrees for this session after the
  earlier prerequisite check. Prototype source is isolated in the T12 worktree; no commit or merge.
- Parameters and fixtures: 24 independently fictional encounter spans, plus 12 new spans for
  the appended-year case. Each span has a unique ordinal, a synthetic collection date (month
  `id % 12 + 1`, day 15, year 2024 for the first 24 and 2025 for the additions), value `5.4`,
  72 words selected from `amber birch cedar dune elm fern glade harbor iris juniper kelp lilac
  meadow north olive pine quartz river spruce tulip upland violet willow xeric yarrow zephyr`,
  and a repeated 21-word export legend. Word generator: unsigned 32-bit LCG, seed `1000 + id`,
  multiplier 1664525, increment 1013904223, dictionary index `state % 26`. The complete span
  text starts `Fictional encounter ${id+1}. Collected ${year}-${month}-15. Synthetic value 5.4 unit-X.`
  and ends `Fabricated test narrative without clinical meaning. This fictional printed export
  uses the same standard legend on every synthetic encounter and contains no actual patient information.`
  The corrected case changes only span id 7 from `5.4` to `5.7`.
- Commands: in the isolated worktree, `EXPERIMENT_ARTIFACTS=/tmp/circus-processing-t12-final
  node src/scripts/experiment-t12.ts`; `npm run typecheck:tools`; Prettier on that script.
  External `result.json`, `ground-truth.json`, generated PDFs and run log are the receipts.
  Reconstruction: emit standard Type1 text PDFs using Helvetica, 612×792 points, margin 40,
  9-point text, 13-point line spacing and 12 whitespace-delimited words per line; keep each
  encounter together. Add explicit span-boundary markers solely for the scoring oracle, a
  `Printed 2024-03-01` header and `Page n of m` footer. Variants: Courier/595×842/margin55/
  nine words per line; header date changed to 2026-09-24; append the additional year; rotate
  the two halves of the encounter sequence; the single corrected value; and six-word lines
  in two columns, emitted either column-first or row-first. Columns use 7-point text with
  left x=40 and right x=316. Extract through the current PDF worker, join pages, remove only
  known printed/page boilerplate and scoring markers, and normalize NFKC/case/whitespace.
  D1 hashes normalized page text. D2 hashes every k-word shingle with SHA-256, retains the
  rightmost minimum of each w-hash window, and discounts hashes present in at least four
  unrelated baseline spans. Digits and decimal points remain significant. Sweep k=8..12 and
  w=4..8, fixed before scoring; predict a whole encounter unchanged when at least 80% of its
  retained fingerprints match the best baseline encounter. Oracle encounter boundaries supply
  evaluation intervals, not matching features. Changed and newly appended encounters are negative
  ground truth; a wrong identity match counts both a false positive and a missed positive.
- Measurements (**measured**, final receipt): eight PDFs, page counts 6/8/6/9/6/6/6/6 in the
  order baseline/font-margin/headers/appended/reordered/corrected/column-first/row-first.
  D1 exact-page matches for the seven variants were respectively 0/8, 6/6, 6/9, 6/6, 5/6,
  6/6 and 0/6. The corrected-value page was never an exact D1 match. All 25 k/w pairs gave
  the same outcome: font/margin, header, appended-year, reorder and column-first variants had
  span precision 1 and recall 1; appended-year correctly rejected all 12 new spans. The
  corrected-value variant had 23 true matches and one false unchanged label: precision
  23/24 = 0.958333, recall 1 on its 23 unchanged spans. Row-first two-column extraction found
  zero of 24 unchanged spans: recall 0, precision undefined because there were no predictions.
  At k=10,w=6, five recurring fingerprints were discounted. Zero of 25 settings passed all bars.
- Against the criteria: **fail** D2's combined ≥0.95 recall / ≥0.99 precision requirement.
  **Pass** the narrower corrected-page-never-exact requirement for D1. No k/w default is
  selected. These results concern this whole-encounter matching definition; they do not rule
  out a finer span algorithm that explicitly marks changed subspans.
- Deviations and oddities: an initial fixture had no sufficiently long common boilerplate, so
  its discount filter was unexercised. A repeated legend was added and the complete fixed
  sweep rerun; the earlier external receipts remain separate. During implementation review,
  wrong-identity matches were corrected to count as false negatives as well as false positives;
  no threshold or predeclared criterion was relaxed. TypeScript's page-initialization annotation
  was also fixed. This small synthetic vocabulary and oracle segmentation do not establish
  performance on clinical documents, arbitrary segmentation, or unseen layouts. D1 page hashes
  can survive a whole-page reorder; they cannot survive changed pagination in this fixture.
- What it decides: do not use this D2 similarity threshold as authority that an encounter is
  unchanged. Reading order defeats recall, and a corrected numeric value survives the similarity
  threshold. D1 provides a useful exact-change guard in the tested rendering. Re-exports are
  still read in full; neither fingerprint authorizes skipping.

#### Verification 2026-09-24 — independent verifier, T12 fingerprints

- Method: fully reran the prototype with
  `EXPERIMENT_ARTIFACTS=/tmp/circus-processing-t12-verifier node src/scripts/experiment-t12.ts`
  from the isolated T12 worktree, then independently compared the entire result to the runner's
  receipt. Separately extracted all generated PDFs and recalculated D1 after explicitly removing
  both span-marker forms in addition to print/page boilerplate.
- Agreement: **agree with the numbers and failure outcome; method oddity flagged**. The full
  JSON reproduced exactly: all 25 settings fail; corrected-span precision is 23/24, row-order
  recall is zero, and the seven D1 counts are 0/6/6/6/5/6/0 with no exact corrected-page match.
  However, the recorded D1 `cleaned()` implementation retained `STARTSPAN`/`ENDSPAN` markers,
  contrary to the reconstruction's removal wording. The independent marker-free D1 calculation
  produces the same seven counts and corrected-page result, so this discrepancy does not change
  the observed outcome. D2 excludes marker text from fingerprints but uses oracle boundaries
  to define query/reference intervals as well as score truth; it is not an automatic segmentation
  test. The numerical failure is independently established within that bounded experiment.

#### Run 2026-09-24 — coordinator, correction to D1/D2 fingerprint prototype

- Commit and environment: unchanged from the preceding D1/D2 prototype run; the correction
  stays in the isolated T12 worktree.
- Parameters and fixtures: identical final PDFs, seed, thresholds and sweep. This corrects the
  earlier run's statement that scoring markers were removed before D1 hashing: the earlier
  implementation retained them. The normalizer now removes `STARTSPAN`/`ENDSPAN` plus their
  ordinal before hashing, with clinical-looking digits and decimal values still retained.
- Commands: `EXPERIMENT_ARTIFACTS=/tmp/circus-processing-t12-markerfree
  node src/scripts/experiment-t12.ts`, plus Prettier on the corrected script. The external
  result JSON is the correction receipt. Full worktree formatting and typechecking passed.
- Measurements: measured D1 exact-match counts remain 0/8, 6/6, 6/9, 6/6, 5/6, 6/6, 0/6;
  the corrected page remains nonmatching. D2 results remain unchanged, with zero of 25
  settings passing, corrected-span precision 23/24 and row-first-column recall 0.
- Against the criteria: unchanged **fail** for D2 and **pass** for the corrected-page exact-match
  safeguard. This correction does not select a fingerprint setting.
- Deviations and oddities: also clarify that D2 uses oracle-provided candidate intervals as well
  as scoring boundaries; it is an oracle-assisted matching test, not automatic segmentation.
  The prior claim that boundaries were solely for scoring was too broad. The repeated legend
  beginning `This fictional printed export` has 19 whitespace-separated words, not the earlier
  stated 21. Its exact text, generator and all resulting fixtures were already correct.
- What it decides: the negative result survives removal of artificial D1 markers. Preserve the
  earlier run and verifier's oddity entry as history; this entry corrects their specific scope.

#### Verification 2026-09-24 — independent verifier, T12 marker correction

- Method: inspected the corrected normalizer, compared `d1`, `rows`, `passing` and fixture
  metadata in the marker-free receipt with the prior receipt, and compared its D1 outcomes
  with the independent marker-free calculation recorded above. Counted the legend words.
- Agreement: **agree**. All numerical outcomes and fixture metadata are unchanged; the
  normalizer now strips artificial markers, the independent D1 counts match, and the legend
  has 19 words. The correction accurately narrows D2 to oracle-assisted candidate intervals.
  The failed D2 criterion and passing exact corrected-page safeguard are verified outcomes
  for this prototype; automatic segmentation remains outside the experiment.

### T13: date roles for cutoffs

Task: [CRS-096](application-todo.md#crs-096).

**Updated 2026-09-24.** Lower priority. A date filter now belongs in review, where extracted report
dates already exist, rather than deciding what to read. These rules would matter only for pre-AI
ordering or for T21's identity check.

- **Question.** Can cheap heuristics tell print dates from visit, collection, result and quoted
  prior-study dates well enough to support a person-chosen date cutoff?
- **Inputs.** Fictional pages with labeled dates, including:
  - a DEXA-style report that quotes prior results,
  - a page holding two encounters with different dates,
  - running print-date footers,
  - addenda and corrected results dated after the original report.
- **Method.** Rules only: repeated-position detection for headers and footers, and label proximity
  ("Printed", "Collected", "Visit", "Prior", "Addendum"). Score the role accuracy of each date and
  whether each report or encounter would be kept or skipped under a cutoff.
- **Criteria (proposed).** No report dated on or after the cutoff is skipped (zero false skips).
  Role accuracy ≥ 0.9 on everything else. Undetermined dates fail open.
- **Decides.** Whether date cutoffs (D4) need an AI classification step, or can run on rules.

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, prerequisite check only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; no experimental provider route used for this check.
- Parameters and fixtures: none executed. The date-role heuristic prototype requires its own owner-created worktree under rule 10. No prototype worktree is registered and the requested exception or path is pending.
- Commands: `git worktree list` (read-only); read this brief and its recorded prerequisite/trigger.
- Measurements: measured repository inventory contains one main worktree and zero prototype
  worktrees. No date-role prototype or cutoff fixture sweep was run. Role accuracy and false-skip counts remain unknown.
- Against the criteria: inconclusive; a missing prerequisite is not a candidate pass or fail.
- Deviations and oddities: Git remains read-only. This entry records why the experiment did not
  run; it is not a simulated result or evidence from owner records.
- What it decides: T13 and CRS-096 remain open; no date-cutoff behavior was changed.


#### Verification 2026-09-24 — independent verifier, T13 prerequisites only

- Method: independently read the brief and rule 10, ran `git worktree list --porcelain`
  and inspected the changed-file inventory. Measured inventory: one main checkout and zero
  registered prototype worktrees; no private-directory discovery was performed.
- Agreement: **agree**, limited to the prerequisite/non-execution record. The brief requires date-role rules and cutoff scoring over its fictional cases. No role accuracy or false-skip count is established by the prerequisite check.
  This is not a verified experimental outcome and does not close the experiment or its task.


#### Run 2026-09-24 — identity/date runner, date-role prototype

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, Darwin arm64, offline rules. The owner authorized agent-created worktrees after
  the prerequisite-only entry; code lives in the detached `t13` experimental worktree.
- Parameters and fixtures: cutoff `2025-01-01`; deterministic fictional text, no random seed.
  The 12 units are: DEXA (`Report: 2025-02-03`, `Prior: 2021-04-02`,
  `Previous: 2023-05-06`, `Printed: 2026-01-01`); old encounter (`Visit`, `Collected`,
  `Resulted` each `2024-12-31`, then `Printed: 2026-01-01`); boundary (`Visit: 01/01/2025`);
  addendum (`Report: 2023-01-01`, `Addendum: 2025-03-04`); corrected (`Report: 2024-01-01`,
  `Corrected: 2025-04-04`); late result (`Collected: 2024-12-30`, `Resulted: 2025-01-02`);
  running footers (page one `Report: 2025-05-05`, page two `Prior: 2020-01-01`, both ending
  `Printed: 2026-01-01`); unknown (`2025-07-03`, `Printed: 2026-01-01`); old plus unknown
  (`Visit: 2024-02-01`, `Signed 2025-01-03`); narrative comparison (`Report: 2025-05-02`,
  `Compared with examination of 2020-05-02`); and old/new encounters (`Encounter: 2024-01-01`,
  `Result: 2024-01-02`; `Encounter: 2025-01-01`, `Result: 2025-01-02`). Each quoted item is a
  separate line. A second input concatenates the last two encounters on one page and segments
  at line-start `Encounter:`. Expected roles follow their labels, except `Signed` and unlabeled
  dates are unknown and the narrative comparison is prior. Only the old encounter and old half
  of the two-encounter page should skip.
- Commands: from the `t13` worktree,
  `mkdir -p /tmp/circus-t13-20260924` and
  `node t13-prototype.ts > /tmp/circus-t13-20260924/result.json`.
  For OCR reuse, `node t13-prototype.ts <external-text-file>` classifies that text. Exports are
  `dateRoles(pages)`, `keepUnit(pages, cutoff)`, and `splitEncounters(text)`. Portable rule:
  find ISO or month/day/year dates, normalize to ISO, and use the nearest preceding label on
  the same line. Print/export labels map to print; visit/encounter/admission to visit;
  collected/collection to collection; result/resulted/report/reported to result;
  addendum/corrected to addendum; prior/previous to prior; otherwise unknown. Detect repeated
  first/last lines at the same position after replacing dates with `DATE`; only an explicit
  print/export label makes that repeated text print evidence. Keep the entire unit if no
  governing date exists, any date is unknown, or any visit/collection/result/addendum date is
  on/after cutoff; otherwise skip. Split multiple encounters at explicit `Encounter:` lines.
- Measurements (measured, receipt: command JSON): 29 dates across 12 units, 28 correct roles,
  role accuracy 0.965517; 0 false skips, 12 correct keep/skip decisions. The two-encounter
  single-page input yielded 2 segments, with the old segment skipped and new segment kept.
  The sole role error was the narrative comparison date, classified unknown instead of prior;
  the DEXA unit and its prior comparison dates were kept together. Both repeated footers were
  classified print. No timings or provider token estimates are claimed.
- Against the criteria: measured passes on these fixtures for zero false skips and role
  accuracy at least 0.9. Unknown dates fail open. This does not establish accuracy on unseen
  layouts or OCR; that remains **unknown** pending the separate T18 experiment.
- Deviations and oddities: this is a text-rule experiment, not a PDF-layout or production
  implementation. Repeated position is line position, not page geometry. Two encounters were
  first scored individually, then the required combined-page segmentation was added and the
  same fixed criteria rerun. Conservative selection admits false keeps, which this brief does
  not prohibit. There is no implemented general multi-column segmentation or calendar-invalid
  date recovery. The runner has not independently verified results.
- What it decides: these simple labeled fixtures support rules as a cautious ordering hint;
  they do not establish that date filtering is safe for arbitrary sources. The lower-priority
  review-filter direction and all open requirements remain unchanged pending verification.

#### Verification 2026-09-24 — independent verifier, T13 date-role prototype

- Method: read the prototype and proposal date-role rules, then independently imported
  `fixtures`, `dateRoles`, `keepUnit` and `splitEncounters` from the `t13` worktree in a Node
  module. Recomputed role agreement and cutoff decisions from each fixture's expected labels;
  separately reconstructed the combined two-encounter page.
- Agreement: **agree**. The independent count is 28 correct roles among 29 dates
  (`0.9655172414`), zero false skips and 12 correct unit decisions. The one role mismatch is
  the narrative comparison date, labeled unknown rather than prior; it remains included.
  The combined page splits into two units with decisions skip/keep, respectively. These pass
  the declared numerical criteria on the labeled text fixtures. Geometric layout handling,
  unseen text, invalid dates and OCR robustness remain unmeasured, as recorded by the runner.

### T14: grouped identity questions and remembered spellings

Task: [CRS-097](application-todo.md#crs-097). Depends on [CRS-090](application-todo.md#crs-090)
for the remembered-spelling half.

- **Question.** How many identity prompts does a person see for one multi-report file with a
  variant printed name? How many after grouping by spelling, and after one "this is me" that
  remembers the spelling?
- **Inputs.** A fictional 40-report chart with a Self name, a middle-initial variant, an
  initials-only variant, and one report for a different person with the same surname. Added
  2026-09-24 for the birth-date requirement in CRS-090: a report with Self's exact name and a
  different birth date (a same-name relative), and one with Self's exact name and no birth date.
- **Method.** Run identity assessment in the current code and count prompts. Prototype grouping by
  (original, canonical printed spelling) and count again. Then add the spelling to `knownNames`
  and count again, confirming that the other person's report still asks.
- **Criteria (proposed).** At most one prompt per distinct spelling per file. Zero prompts for a
  remembered spelling. The other person's report is still blocked or asks. Added 2026-09-24: a
  spelling is remembered only from a confirmation whose report printed a matching complete birth
  date; the same-name relative is blocked; the no-birth-date report never adds a known name.
  Added 2026-09-24 (seventh pass, OI-40): a report with Self's birth date and a different surname
  (a name change). Record whether current code blocks it; the proposed rule asks "another name?"
  and remembers the spelling on yes.
- **Decides.** The question-compaction design, and whether grouping is needed beyond remembered
  spellings.

#### Results

_None yet._

#### Run 2026-09-24 — identity runner, current-policy baseline only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, Darwin arm64, offline direct policy calls; no provider route.
- Parameters and fixtures: independently fictional, deterministic (no random seed), one logical
  original containing 40 reports. Self is `Iris Meadow`, birth date `1982-04-17`, version `1`,
  note ID `person-note:self`, and empty `knownNames`. Ordered cases are 12 reports named
  `Iris Meadow`, 12 named `Iris R. Meadow`, and 12 named `I. R. Meadow`, all with Self's birth
  date; then one `Oren Meadow` with `1979-11-02`, one `Iris Meadow` with `2001-04-17`, one
  `Iris Meadow` without a birth date, and one `Iris Brook` with Self's birth date. These are
  fixture parameters, not library measurements.
- Commands: from the repository root, `git rev-parse HEAD`, `node --version`, `uname -sm`,
  then `node /tmp/circus-t14-baseline-20260924/run.mjs > /tmp/circus-t14-baseline-20260924/result.json`.
  The throwaway script and raw JSON stay outside Git. Portable reconstruction: dynamically import
  `src/server/intake-identity-policy.ts` using `pathToFileURL(process.cwd() +
  '/src/server/intake-identity-policy.ts')`; expand the ordered cases above with
  `Array.from({length: count})`; for each call `assessIdentityPolicy` with that Self, evidence
  `{fullName, birthDate}` (omit absent birth date), and `group`, `groupVersionId`, and
  `originalFingerprint` all `null`, with no optional receipt/refusal/question inputs. Record
  report index, case label, `status`, `confidence`, `blocking`, and conflict field names; sum
  statuses and count `blocking === true`. This completely specifies the baseline receipt.
- Measurements (measured, receipt: the command's per-report JSON): 40 assessments; 13
  `evidenced_match`, 24 `confirmation_required`, 3 `conflict`; 27 blocking assessments.
  Exact-name matching-date reports account for 12 strong matches. Each variant spelling accounts
  for 12 possible-confidence confirmations. The other-person case conflicts on name and birth
  date; the same-name relative conflicts on birth date; the different-surname matching-date case
  conflicts on name. The no-birth-date exact-name report is the remaining match, with limited
  confidence. Confirmation-status counts are a policy-level prompt proxy; rendered prompts,
  user clicks, and extraction accuracy are **unknown**, not measured by this direct-function run.
- Against the criteria: the current-policy baseline has 12 confirmation-required assessments per
  repeated variant spelling (measured), so it does not itself achieve the proposed one-question
  grouping target. Both the other person and the same-name relative are blocked (measured).
  Matching birth date with a different surname still blocks (measured), confirming the OI-40
  current-behavior row. Grouped and remembered-spelling prototype counts, confirmation-triggered
  persistence, and the no-birth-date remembering guard are **unknown**; those criteria remain
  inconclusive. The exact-name no-birth-date pass agrees with the seventh-pass OI-33 decision,
  which supersedes the earlier proposal caveat.
- Deviations and oddities: this is a partial baseline, not a completed T14. Read the brief,
  proposal known-name and sixth/seventh-pass identity corrections, CRS-090/CRS-097,
  `src/shared/self-identity.ts`, `src/server/intake-identity-policy.ts`, the confirmation
  transaction in `src/server/intake-identity.ts`, and `src/server/test/self-identity.test.ts`
  before running. The initial source-search glob matched no files and was immediately replaced
  with `rg` over `docs` and `src`; it did not affect the fixture or measurements. Prototype work
  remains pending an owner-created worktree under rule 10. No `knownNames` injection is claimed
  as confirmation persistence, no profile was opened, and this runner has not verified its result.
- What it decides: confirms the repeated-variant baseline and the current name-change conflict;
  supports testing question grouping and the proposed name-change rule, but leaves CRS-090,
  T14 completion, and the question-compaction design open pending prototype and independent
  verification.

#### Verification 2026-09-24 — independent verifier, T14 baseline

- Method: reduced rerun independently reconstructed from the runner's ordered fixture matrix,
  using `node --input-type=module` from the repository root to import
  `assessIdentityPolicy` from `./src/server/intake-identity-policy.ts`. Called the policy once
  per distinct case with the recorded Self, evidence and null boundary arguments, then weighted
  each result by the recorded multiplicity (12, 12, 12, 1, 1, 1, 1). Read the brief, proposal
  identity corrections, canonical-name rules and policy implementation before rerunning.
- Agreement: **agree** with the partial baseline. The rerun measured 13 `evidenced_match`,
  24 `confirmation_required`, 3 `conflict`, and 27 blocking assessments across the modeled
  40-report fixture. Both repeated variants returned `possible` confidence; exact name and
  matching birth date returned `strong`; exact name without birth date returned `limited`.
  Conflict fields were name plus birth date for the other person, birth date for the same-name
  relative, and name for the different-surname matching-date case, exactly as recorded.
  This verifies policy outcomes only: rendered prompts, grouping, remembered-name persistence
  and the no-birth-date remembering guard remain unknown. T14 and CRS-097 remain incomplete.

#### Run 2026-09-24 — identity runner, existing known-name recognition

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, Darwin arm64, offline direct current-policy calls; no provider route.
- Parameters and fixtures: exactly the fictional 40-report fixture and policy-call arguments
  from the preceding current-policy baseline, with the only change that Self's `knownNames`
  is `['Iris R. Meadow', 'I. R. Meadow']`. This represents already-saved human assertions
  supplied to the existing policy API, not a confirmation transaction or a prototype.
- Commands: from the repository root, copy the preceding external script to
  `/tmp/circus-t14-baseline-20260924/run-known-names.mjs`, replace its literal `knownNames:[]`
  with `knownNames:['Iris R. Meadow','I. R. Meadow']`, then run
  `node /tmp/circus-t14-baseline-20260924/run-known-names.mjs > /tmp/circus-t14-baseline-20260924/result-known-names.json`.
  Reconstruct the base script from the preceding entry; the single replacement completely
  specifies this run. Scripts and JSON stay outside Git.
- Measurements (measured, receipt: the command's per-report JSON): 40 assessments, 37
  `evidenced_match`, 0 `confirmation_required`, 3 `conflict`, and 3 blocking assessments.
  The 24 variant-name reports now have strong evidenced matches; the original 12 exact-name
  reports remain strong matches and the no-birth-date exact-name report remains a limited match.
  The other-person same-surname report remains blocked on name and birth date, the same-name
  relative on birth date, and the different-surname matching-date report on name.
- Against the criteria: the existing policy has zero confirmation-required assessments for
  either already-saved variant spelling (measured); the other person and same-name relative
  remain blocked (measured). This establishes the existing alias-recognition half only.
  Grouping, confirmation-triggered durable remembering, matching-complete-birth-date gating
  of that write, and the prohibition on remembering from the no-birth-date report remain
  **unknown**. Rendered prompt counts and confirmation clicks also remain **unknown**.
- Deviations and oddities: this continuation makes no implementation change and runs no
  grouping or remembering prototype. It does not claim that adding strings to the assessment
  input demonstrates persistence or the CRS-090 transaction. The criteria that require such a
  transaction remain inconclusive; no task checkbox is closed and this runner has not verified
  either entry.
- What it decides: the existing policy can remove repeated confirmations once the two exact
  variant spellings are already saved, while preserving the measured conflict cases. It leaves
  the proposed remembering transaction and question grouping open.

#### Verification 2026-09-24 — independent verifier, T14 known-name recognition

- Method: independently reran the seven distinct baseline policy inputs, weighted by their
  recorded multiplicities, via `node --input-type=module`, changing only Self's `knownNames`
  to the two recorded variant spellings. This used the existing policy without profile access
  or a confirmation transaction.
- Agreement: **agree**. The independent measurement gives 37 evidenced matches, zero
  confirmation-required assessments and 3 blocking conflicts across the 40 fixture reports.
  All 24 variant-name cases become strong matches; the exact-name no-birth-date case remains
  limited, and all three conflict cases retain the same fields. This verifies recognition of
  already-saved aliases only; confirmation persistence, its birth-date guard, grouping and
  rendered prompts remain unmeasured. T14 and CRS-097 remain incomplete.

#### Run 2026-09-24 — identity runner, functional grouping/remembering prototype

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, Darwin arm64, offline. The owner subsequently authorized agent-created separate
  worktrees; this prototype lives only in the detached `t14` experimental worktree.
- Parameters and fixtures: the preceding deterministic 40-report chart and initial Self with no
  known names. Three additional guard inputs reuse the middle-initial report with absent birth
  date, partial birth date `1982-04`, and a declined remember choice, each from a fresh Self.
- Commands: `mkdir -p /tmp/circus-t14-prototype-20260924`; from the `t14` worktree,
  `node --experimental-strip-types t14-prototype.ts /tmp/circus-t14-prototype-20260924 > /tmp/circus-t14-prototype-20260924/result.json`.
  Portable reconstruction: wrap the existing `assessIdentityPolicy` with one proposed override:
  only a conflict containing exclusively `fullName` fields becomes `confirmation_required` when
  `validOnboardingBirthDate(printedDOB)` and printed DOB equals Self's complete DOB. Group only
  confirmation-required reports by JSON-encoded `[original, canonicalIdentityName(printedName)]`;
  assess each report before grouping, so conflicting DOBs never inherit a group's confirmation.
  Maintain a JSON file containing Self and receipts outside Git. For an explicit confirmation,
  reject any non-confirmation-required assessment; append the printed name only if remembering
  was chosen, the printed DOB is complete and exactly matches Self, and the canonical spelling
  is absent; increment Self version on addition and append a receipt. Read the file afresh for
  each operation and subsequent assessment. Run counts initially, after confirming the middle
  spelling, then after the initials spelling and changed surname. Attempt confirmation of both
  conflict cases and compare state bytes. Reset Self separately for each guard input.
- Measurements (measured, receipt: `result.json` from the command): before confirmation, 13
  matches, 25 confirmation-required reports, 3 spelling groups, and 2 conflicts. After one
  middle-spelling confirmation: 25 matches, 13 confirmation-required reports, 2 groups, and 2
  conflicts, with 1 saved known name. After confirming all three eligible spellings: 38 matches,
  0 confirmation-required reports, 0 groups, 2 conflicts, and 3 saved names. Both conflict
  confirmation attempts were rejected with unchanged state bytes. Each of the absent-DOB,
  partial-DOB, and declined-remember inputs added 0 names. All state counts came from rereading
  the external JSON file, not from changing assessment arguments alone.
- Against the criteria: the functional prototype produces at most 1 question group per eligible
  canonical spelling per original; remembered spellings produce 0 subsequent confirmation
  assessments. The other person and same-name wrong-DOB relative remain blocked. A different
  surname with matching complete DOB asks and can be remembered. No absent/partial-DOB input
  adds a name. These are measured passes for this fictional functional prototype; actual UI
  prompt/click counts and the production confirmation transaction remain **unknown**.
- Deviations and oddities: the prototype includes OI-40's proposed name-change behavior, explaining
  why its initial conflict count is 2 rather than the current-code baseline's 3. Persistence uses
  an isolated JSON state file, not the application's encrypted atomic transaction; crash recovery,
  concurrent Self version races, receipt replay, UI consent, and the 32-name limit are not tested.
  The missing-DOB guard uses a variant spelling because the brief's exact-name/no-DOB report
  already passes and never offers confirmation. This runner did not independently verify results.
- What it decides: supports the feasibility of grouping and complete-DOB-gated remembering for
  these fixtures, while preserving the production CRS-090 implementation and broader acceptance
  work. Independent verification is still required.

#### Verification 2026-09-24 — independent verifier, T14 functional prototype

- Method: read the isolated `t14-prototype.ts` against the recorded reconstruction and current
  identity policy, then fully reran it with
  `node ~/projects/circus-health-experiments/t14/t14-prototype.ts /tmp/circus-t14-verifier-20260924`
  using a separate external output directory and fresh state.
- Agreement: **agree** with all reported prototype counts. Initial match/confirmation/group/
  conflict counts were 13/25/3/2; after the middle spelling they were 25/13/2/2; after all
  eligible spellings they were 38/0/0/2, with 3 names saved across file-backed operations.
  Both conflicting confirmations rejected with unchanged state, and absent DOB, partial DOB
  and declined remembering each saved zero names. Group counts are computed distinct keys over
  eligible reports, not measured UI prompts; complete-DOB gating and conflict assessment happen
  before those keys are formed. The functional criteria agree on this fixture. Application
  transaction durability, races, replay, UI and broader identity acceptance remain outside this
  experiment and cannot be marked complete from this prototype.

### T15: unattended fault handling

Task: [CRS-098](application-todo.md#crs-098).

- **Question.** Does the proposed retry design finish a job without a person, parking only what
  genuinely failed?
- **Inputs.** Scripted transport with injected faults:
  - bursts of 503,
  - 429 with `Retry-After`,
  - a quota window that closes for a scripted hour (time compressed),
  - a malformed response,
  - one undecodable page.
- **Method.** Prototype the retry classes, backoff with jitter, per-unit remedy escalation and
  parking described in the proposal's unattended operation section. Run a 200-page fictional
  source through each fault mix.
- **Criteria (proposed).** Ends "finished with exceptions" with only the undecodable page parked.
  No human action is needed. Honors `Retry-After`. No request storm (no more than the backoff
  schedule allows).
- **Decides.** Whether the unattended design is sound before any real run.

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, prerequisite check only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; no experimental provider route used for this check.
- Parameters and fixtures: none executed. The proposed retry/parking prototype requires its own owner-created worktree under rule 10. No prototype worktree is registered and the requested exception or path is pending.
- Commands: `git worktree list` (read-only); read this brief and its recorded prerequisite/trigger.
- Measurements: measured repository inventory contains one main worktree and zero prototype
  worktrees. No proposed retry design was run. Completion, parking, Retry-After compliance and request-storm measurements remain unknown. Existing retry code is not evidence that the proposed design works.
- Against the criteria: inconclusive; a missing prerequisite is not a candidate pass or fail.
- Deviations and oddities: Git remains read-only. This entry records why the experiment did not
  run; it is not a simulated result or evidence from owner records.
- What it decides: T15 and CRS-098 remain open.


#### Verification 2026-09-24 — independent verifier, T15 prerequisites only

- Method: independently read the brief and rule 10, ran `git worktree list --porcelain`
  and inspected the changed-file inventory. Measured inventory: one main checkout and zero
  registered prototype worktrees; no private-directory discovery was performed.
- Agreement: **agree**, limited to the prerequisite/non-execution record. The proposed per-unit retry and parking behavior needs a prototype; current code retries only 503 with fixed waits and does not establish the proposed fault-mix outcome. Completion and parking remain unknown.
  This is not a verified experimental outcome and does not close the experiment or its task.


#### Run 2026-09-24 — coordinator, virtual-clock retry prototype

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; scripted Response objects and virtual time, no provider.
  The owner authorized creation of the isolated T15 worktree; no commit or merge.
- Parameters and fixtures: six runs over 200 fictional one-page units. Every run includes
  undecodable page 137, which fails both PDF and PNG representations. Additional fault mixes:
  page 7 returns three 503s; page 13 returns two 429s with Retry-After of two seconds then an
  HTTP date four seconds ahead; page 17 has a quota window closed until one scripted hour
  after epoch; page 23 returns two malformed JSON responses; decode-only; and all faults
  combined. Epoch `2026-01-01T00:00:00Z`; LCG seed 20260924, multiplier 1664525, increment
  1013904223, unsigned state divided by 2^32 for full jitter. Parameters are fictional/model
  time, not observed provider latency.
- Commands: in the worktree, `EXPERIMENT_ARTIFACTS=/tmp/circus-processing-t15-final
  node src/scripts/experiment-t15.ts`; `npm run typecheck:tools`; Prettier on the script.
  External per-mix JSON receipts retain every attempt, status, Retry-After, virtual timestamp,
  jitter draw and delay. Reconstruction: sequentially attempt each unit; transient waits are
  `max(Retry-After, floor(draw * min(30000, 1000 * 2^(attempt-1))))` milliseconds. A long
  Retry-After is a quota wait, not a stream of probes. Bound retries to eight attempts and
  quota waits to one virtual day. On malformed content, retry once, then change to verified
  fallback representation; units are already single-page, so further splitting is unavailable.
  Exhausted content/decoder remedies park only that unit. The supplied successful response
  must contain the requested page number and a fictional record string. A human-intervention
  callback is counted on permanent failure or exhausted route retry horizon.
- Measurements (**measured in the scripted simulation**): every mix completed 199 units and
  parked only page 137 after two decoder attempts, ending `finished_with_exceptions`, with
  zero human-intervention callback calls. Transport attempts for 503/429/quota/malformed/
  decode-only/combined were 202/201/200/201/199/207. Decoder attempts are separate from
  transport requests. Virtual durations were respectively 1,498/6,000/3,600,000/0/0/3,600,000 ms.
  The quota case sent no intervening request during its closed window. Host elapsed time,
  provider tokens and production throughput are **unknown/not tested** by this clock model.
- Against the criteria: **pass in this functional prototype** for terminal state, unit isolation,
  no requested human action, honoring both Retry-After forms, and following the declared wait
  schedule without extra transient attempts. The event receipts, rather than a wall-clock
  speedup claim, are the basis for independent schedule verification.
- Deviations and oddities: this is a retry state-machine experiment, not integration into the
  existing assistant or batch runner. Decoder failures and representation fallbacks are scripted;
  no real corrupted PDF is decoded. Restart recovery, Stop/lock races, actual timers, network
  cancellation and publication transactions remain untested. Per-unit records and receipts are
  retained as external fixture artifacts, not accepted records. An initially literal zero for
  human actions was replaced by a counted callback before the recorded final run.
- What it decides: the proposed separation of transient, quota and per-unit content failures can
  satisfy the scripted fault mix without parking healthy pages. Production implementation still
  needs integration and lifecycle tests; the current application retry behavior was not changed.

#### Verification 2026-09-24 — independent verifier, T15 virtual-clock faults

- Method: imported `runFaultMix` from the isolated T15 source and fully reran all six mixes.
  Compared JSON-normalized results to every retained per-mix receipt; independently regenerated
  the LCG draws, parsed both Retry-After forms and recalculated every scheduled delay and next
  attempt timestamp from the declared formula.
- Agreement: **agree**. Every serialized receipt reproduced exactly. Transport attempts were
  202/201/200/201/199/207 and virtual durations 1,498/6,000/3,600,000/0/0/3,600,000 ms in the
  recorded mix order. Every run completed 199 units, parked only page 137 and recorded zero
  human-callback invocations. Transient/quota wait counts were 3/2/1/0/0/6; each next attempt
  occurred exactly after its calculated wait, with no request inside a quota wait. The scripted
  functional criteria pass; actual timers, fallback decoding, cancellation, recovery and
  production integration are not established by this virtual-clock verification.


### T18: OCR for pages without a text layer

Task: [CRS-100](application-todo.md#crs-100).

- **Question.** Can a local OCR engine give scanned pages and photos a usable text index, at
  acceptable CPU cost, without sending anything off the machine?
- **Proposal predicts.** OCR helps indexing (fingerprints, date cutoffs, literal search, quote
  checks) more than reading. It turns a scan-heavy import from IO-bound to partly CPU-bound.
- **Inputs.** Fictional pages rendered to images at 200 and 300 dpi, with skew, blur, JPEG
  compression and a phone-photo perspective. Include tables, two columns and a handwritten-style
  annotation.
- **Method.** Candidate engines that fit the repository's TypeScript and Docker constraints:
  - the Tesseract command-line tool installed in the app image and called as a child process,
  - tesseract.js (WebAssembly, in process).

  Measure character error rate against ground truth, CPU seconds and peak memory per page on the
  Compose CPU limits, and image size added. Then feed the OCR text into T12's D1/D2 and T13's rules,
  and report how much each degrades against the clean text layer. Do not use a cloud OCR service,
  since it would send records off the machine. Record each engine's license.

- **Criteria (proposed).** Useful as an index if character error rate is ≤ 3% on 300-dpi scans,
  CPU is ≤ 5 seconds per page on one core, and D2 span recall on OCR text stays ≥ 0.9.
- **Decides.** Whether to add an OCR stage, which engine, and whether "Find the words in it" can be
  offered for images and scans.

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, prerequisite check only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; no experimental provider route used for this check.
- Parameters and fixtures: none executed. The OCR prototype requires an owner-created worktree under rule 10; none is registered. T12/T13 prototype outputs are also unavailable for the downstream degradation comparison.
- Commands: `git worktree list` (read-only); read this brief and its recorded prerequisite/trigger.
- Measurements: measured repository inventory contains one main worktree and zero prototype
  worktrees. No OCR engine or image-build benchmark was run. Character error rate, CPU/page, peak memory, image-size increase and D2 degradation remain unknown.
- Against the criteria: inconclusive; a missing prerequisite is not a candidate pass or fail.
- Deviations and oddities: Git remains read-only. This entry records why the experiment did not
  run; it is not a simulated result or evidence from owner records.
- What it decides: T18 and CRS-100 remain open. No OCR dependency or application stage was added.


#### Verification 2026-09-24 — independent verifier, T18 prerequisites only

- Method: independently read the brief and rule 10, ran `git worktree list --porcelain`
  and inspected the changed-file inventory. Measured inventory: one main checkout and zero
  registered prototype worktrees; no private-directory discovery was performed.
- Agreement: **agree**, limited to the prerequisite/non-execution record. OCR engine measurements and downstream T12/T13 comparisons are absent. No OCR stage or dependency was added in the working-tree changes inspected; OCR quality and CPU cost remain unknown.
  This is not a verified experimental outcome and does not close the experiment or its task.


#### Run 2026-09-24 — identity/date runner, local OCR comparison

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`; Node
  `v24.19.0`; Darwin arm64 host and Docker Linux arm64, Docker Engine `29.7.2`. The owner
  authorized a separate `t18` worktree after the prerequisite-only entry. Both experimental
  images derive from the repository's pinned Node Bookworm base. Tesseract CLI `5.3.0-2`
  (engine 5.3.0, Leptonica 1.82.0) and tesseract.js `7.0.0` with core `7.0.0` use the same
  Debian `tesseract-ocr-eng` `1:4.1.0-2` trained data. Tesseract, tesseract.js and that English
  data declare Apache-2.0 licenses in their installed copyright/license files. No cloud OCR.
- Predeclared plan: before recognition, the external `plan.json` fixed 3 layouts × 2 resolutions
  × 5 distortions × 2 engines × 1 repeat = 60 page runs. Each run gets a fresh process and
  container with `--cpus 1 --memory 1g --network none`, `OMP_THREAD_LIMIT=1`. A runtime receipt
  confirms cgroup `cpu.max` is `100000 100000`. This is the brief's one-core setting within the
  Compose CPU configuration, not a measurement of a concurrently importing application.
- Fixtures and portable generator: use `@napi-rs/canvas` 1.0.9 to draw fictional letter pages,
  612×792 logical points scaled by dpi/72 at 200 and 300 dpi. Body text is 11-point Arial;
  annotation is 15-point Bradley Hand (macOS font), rotated −0.04 radians. Header at (40,40)
  is `Fictional Harbor Clinic - synthetic document`, followed at y=62/80 by
  `Report: 2025-02-03` and `Prior: 2021-04-02`. Footer at (40,747) is
  `Printed: 2026-01-01`. Generate each span as `Fictional report section ID. ` followed by
  60 words and `. All values are invented for a software experiment.` Select each word with
  unsigned LCG state `(1664525 * state + 1013904223) mod 2^32`, initialized to `18024 + ID`,
  indexing modulo 25 into `amber birch cedar dune elm fern glade harbor iris juniper kelp lilac
  meadow north olive pine quartz river spruce tulip upland violet willow yarrow zephyr`.
  Two-column pages use IDs 10/11, x=40/325, y=118, width=240; table and annotation pages use
  IDs 20 and 30 respectively, x=40, y=115, width=525. Wrap at the last word that fits the
  canvas-measured width, with 16-point line spacing. Table rows follow 25 points after the last
  paragraph baseline at x=45, spacing 22: `Test Value Unit`, `Marker-A 5.4 unit-X`,
  `Marker-B 7.2 unit-Y`, `Marker-C 11.0 unit-Z`, `Collected: 2024-12-30`,
  `Resulted: 2025-01-02`, enclosed by a thin gray rectangle. Annotation instead says
  `Remember to bring fictional prior report.` at x=55, 53 points below the final paragraph
  baseline. Ground truth is the authored reading order, including all table and annotation text.
  Distortions independently applied to each base: none; 2-degree rotation around page center;
  canvas Gaussian blur radius `1.2 * dpi / 200` pixels; JPEG quality 35; and perspective-like
  trapezoid mapping each row from 85% page width at top to 100% at bottom. This last transform
  models horizontal perspective compression, not a full camera/lighting simulation.
- Commands: in `t18`, build `docker build -f Dockerfile.t18 --target cli -t
  circus-t18-cli:experiment .` and the corresponding `--target js -t circus-t18-js:experiment`.
  CLI installs only Debian `tesseract-ocr`, `tesseract-ocr-eng`, and `time`; JS installs the
  English data and `time`, then `npm init -y`, `npm pkg set type=module`, and
  `npm install --save-exact tesseract.js@7.0.0` under `/ocr`. Dependencies stay in experimental
  images. A Dockerfile-specific ignore file includes only the Dockerfile and JS runner.
  Run `node t18-generate.ts /tmp/circus-t18-20260924`,
  `node t18-run.ts /tmp/circus-t18-20260924`,
  `node t18-clean.ts /tmp/circus-t18-20260924`, and
  `node t18-score.ts /tmp/circus-t18-20260924`. The runner uses
  `docker run --rm --cpus 1 --memory 1g --network none -e OMP_THREAD_LIMIT=1 -v
  /tmp/circus-t18-20260924:/work <engine-image> /usr/bin/time -f '%U %S %M %e' -o
  /work/<page-engine>.time <engine-command>`.
  CLI command: `tesseract /work/<image> /work/<output> --dpi <dpi> -l eng --oem 1 --psm 3`.
  JS calls `createWorker('eng', 1, {langPath:'/usr/share/tesseract-ocr/5/tessdata',
  gzip:false, cacheMethod:'none'})`, sets PSM AUTO (`3`), recognizes the image, writes text,
  and terminates. JS uses its automatic image resolution handling. The actual argument arrays,
  text, images, CPU/RSS receipts, build logs and version/license receipts are outside Git.
- Scoring: CER is measured Levenshtein distance after NFKC normalization and whitespace collapse,
  retaining case, divided by ground-truth characters; aggregate CER weights by characters.
  Thus reading-order errors count, not only incorrectly recognized glyphs. Reuse T12's exact
  normalized page-text hash and `matchScore(ocrFullPage, groundTruthSpan, 10, 6)`; do not segment
  OCR with idealized markers. Primary span-detection threshold is the predeclared 0.9 fingerprint
  coverage. The coordinator supplied T12's 0.8 setting after recognition began; it is a separately
  reported secondary rescore, never a replacement criterion. Reuse unchanged T13 `dateRoles`
  and `keepUnit`, counting exact date-plus-role retention and false skips against clean input.
  Clean reference PDFs retain each layout's text coordinates and authored order (Helvetica in
  their text layer), then are actually extracted with the production PDF worker via T12's
  `extractPdf`. All 3 clean content baselines measured CER 0, exact D1 equality, all 4 ground-truth
  spans recovered and all 11 date roles retained. This does not cure T12's separate row-major
  multi-column fixture failure, nor claim that all structural failures originate in OCR.
- Measurements (all measured; receipts: `scores.json`, per-page `.time` files, and Docker image
  inspection): at 200 dpi, CLI CER 9.9201%, mean CPU 0.5293 seconds/page, maximum CPU 0.70,
  maximum process RSS 77,668 KiB; JS CER 10.0000%, mean CPU 1.5513, maximum CPU 2.61,
  maximum RSS 264,280 KiB. At 300 dpi, CLI CER 10.0177%, mean CPU 0.8073, maximum CPU 1.01,
  maximum RSS 137,092 KiB; JS CER 9.9734%, mean CPU 1.9347, maximum CPU 2.59, maximum RSS
  338,160 KiB. GNU time reports user+system CPU and the process high-water RSS, not sampled
  container memory; process initialization is included, Docker orchestration is excluded, and
  this is not the Compose stack's total memory. Every successful page has an individual receipt.
- Quality detail (measured): both engines recover 18/20 spans at each dpi, recall 0.9, at both
  detection thresholds. At 300 dpi the 3 clean-layout pages have aggregate CER 1.8634% CLI and
  1.8190% JS; the clean two-column page alone has CER 4.0363% because OCR inserts the footer
  between columns. The 2-degree-skew group recovers only 2/4 spans (0.5); both engines omit the
  long paragraph on the skewed table and annotation pages, and maximum page CER is 76.2144%.
  D1 exact page equality is CLI 5/15 and JS 5/15 at 200 dpi, CLI 4/15 and JS 5/15 at 300 dpi.
  T13 date-role retention is CLI 55/55 at both resolutions, JS 54/55 at 200 dpi and 55/55 at
  300 dpi, with 0 false skips. These are report/date labels, not OCR validation of patient DOBs.
- Sizes (measured): the 30 images total 9,080,375 bytes, range 80,053–735,595 bytes/page.
  Docker's uncompressed image size is 345,462,307 bytes CLI and 326,747,246 bytes JS versus
  247,548,142 bytes for the common pinned Node base: added size 97,914,165 and 79,199,104 bytes.
  These are prototype image additions including required runtime dependencies and `time`, not
  exact application-image increments or registry download sizes.
- Against the fixed criteria: **fail overall** for both engines because 300-dpi CER exceeds 3%
  across the declared scan matrix and on individual layouts. CPU passes the 5-second one-core
  threshold on every measured page. Aggregate D2 recall meets 0.9, but the skew subset fails it.
  Neither result supports unconditional OCR indexing or automatic skip/link decisions; a quality
  gate, layout handling or deskew treatment needs another experiment. Tesseract CLI costs less
  CPU/RSS here; this is not a production engine selection.
- Deviations and oddities: the first JS matrix exited before recognition because its experimental
  package lacked `type:module`; original status receipts and a representative error are retained.
  After fixing only package metadata, `node t18-run.ts /tmp/circus-t18-20260924 js` reran that
  engine, and all 60 final page runs succeeded. No quality parameter was tuned after seeing
  scores. Handwriting is a font simulation, not natural handwriting; perspective lacks shadows;
  the corpus is small and sparse; timings are one repeat and host-load variation is unknown.
  Prettier and a focused TypeScript check passed for all five scripts; the check uses Node
  types, repository `runtime-json.d.ts` and the experimental package's own types. An initial
  typecheck omitted explicit Node types and was corrected. This is runner validation, not
  independent result verification. No application OCR stage was added, so this prototype alone
  does not satisfy T22's trigger of adding such a stage to the app.
- What it decides: shows local OCR can fit the measured one-core CPU budget while exposing
  consequential quality and layout failures. It leaves OCR adoption, T22's product trigger,
  T21-on-OCR validation, and experiment closure open pending independent verification and design.

#### Run 2026-09-24 — OCR runner, matcher scope clarification

- This clarifies the preceding OCR comparison without changing its numbers: the measured
  span recall uses T12's exported fingerprint-containment function against known generator
  spans. It does not run T12's complete candidate selection or boilerplate-discount logic,
  and it measures neither span precision nor best-match identity. Those values are **unknown**
  here. The 0.9 and 0.8 values are fingerprint-coverage detection thresholds; the separate
  fixed acceptance criterion is recovered-span recall at least 0.9. Thus the measured 18/20
  recovery at both settings is a diagnostic transfer result, not full D2 acceptance.

#### Verification 2026-09-24 — independent verifier, T18 OCR and matcher clarification

- Method: independently rescored all 60 raw OCR texts with a separately implemented rolling
  Levenshtein calculation and independently constructed SHA-256/winnowing fingerprint sets.
  Recomputed D1 equality, date-role retention and cutoff outcomes; re-derived CPU/RSS summaries
  from each `.time` file. Checked image-file sizes and Docker image sizes, and read the retained
  version/license and CPU-quota receipts. Repeated the skewed 300-dpi table in both engine
  containers with the recorded one-core/network-disabled settings, read-only fixture input and
  separate `/tmp/circus-t18-verifier` outputs.
- Agreement: **agree** with the failed quality criterion and the scope clarification. Every
  per-page edit count and fingerprint score reproduced exactly. At 300 dpi the independently
  counted CERs are CLI `1129/11270 = 10.017746%` and JS `1124/11270 = 9.973381%`; at 200 dpi
  they are `1118/11270 = 9.920142%` and `1127/11270 = 10%`. Both engines recover 18/20 known
  spans at each resolution and either detection threshold. Date-role counts agree with
  55/55 except JS 200 dpi at 54/55, and no cutoff false skips. All D1 counts, clean-text
  baselines, CPU/RSS aggregates, 9,080,375 image bytes and image-size additions reproduce.
  The two reduced OCR runs produced byte-identical text; measured repeat CPU was 0.67 seconds
  CLI and 1.48 seconds JS, illustrating that exact timings need not repeat. The original
  per-page CPU receipts remain below five seconds. Fingerprint containment over known spans
  is not the full T12 candidate matcher or a precision measurement, exactly as the clarification
  states. The declared OCR matrix fails the CER bar; engine adoption, arbitrary-layout
  robustness, T21-on-OCR and production integration remain unqualified.

### T19: audited re-export skipping

Task: [CRS-101](application-todo.md#crs-101). Depends on T12.

**Withdrawn 2026-09-24 before running.** The owner decided re-exports are read in full and
reconciled, never skipped to save tokens: AI may only add to the app's standards, never lower them.
Nothing below should be run; it is kept as history.

- **Question.** If matched pages of a re-export are skipped but a random sample is still read, how
  likely is new content in the matched pages to be caught?
- **Proposal predicts** (model): if a fraction `f` of matched pages hides new content, a random audit
  of `n` pages misses all of it with probability `(1 − f)^n`. At `f = 10%`, 30 audited pages miss it
  4% of the time. A single corrected value on one page (`f` near zero) is **not** reliably caught,
  so page-level change detection (T12's corrected-value case) must carry that case.
- **Method.** Simulate over T12's fixtures. Plant new content in matched spans at several rates.
  Measure detection by audit sample size, and by audit plus D1/D2 change flags.
- **Criteria (proposed).** Audit plus change flags catch every planted change of one full record
  or more at the proposed 5% audit share, or the share needed is reported.
- **Decides.** Candidate L's audit share, and whether audited skipping is safe enough to offer.

#### Results

_None yet._

### T21: pre-AI identity check

Task: [CRS-108](application-todo.md#crs-108).

- **Question.** Can host rules, with no model, find a source's printed patient name and birth date
  well enough to stop a clearly wrong-person file before any tokens are spent or questions asked?
- **Why.** Owner requirement: fail fast when a file belongs to someone else, so the person can
  upload the right documents. The birth date is the deciding field (CRS-090).
- **Inputs.** Fictional PDFs with a text layer across several layouts: labeled headers ("Patient:",
  "DOB:", "Date of birth"), table-style demographics, running headers, a cover sheet for a
  different person, family members sharing a name with different birth dates, files with no birth
  date, and a mixed-person ZIP. Later, the same on OCR text from T18. Added 2026-09-24: pages
  that legitimately print someone else's birth date (insurance subscriber or guarantor, a parent
  on a child's record, an emergency contact), which must never stop a correct-person file.
- **Method.** Rules only: label proximity, date parsing that tolerates common formats, and
  canonical name comparison with `knownNames`. The PDF worker's `identity` page-text action is a
  candidate input. Classify each file as match, clear contradiction, or unknown. Only a clear
  contradiction (a printed birth date that differs from Self's) may stop a file; everything else
  proceeds to the existing identity review after extraction.
- **Criteria (proposed).** Zero false stops of correct-person files (no stop on missing or
  ambiguous data). At least 90% of wrong-birth-date files stopped on text-layer sources. Mixed-person
  ZIPs are judged per member.
- **Decides.** Whether a pre-AI identity gate is feasible, and what a stopped file should show:
  "This looks like a record for someone born <date>, not you. Upload the right file · Read it
  anyway". Other files in the same batch continue (R8).

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, prerequisite check only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; no experimental provider route used for this check.
- Parameters and fixtures: none executed. The pre-AI identity-rule prototype requires its own owner-created worktree under rule 10. No prototype worktree is registered and the requested exception or path is pending.
- Commands: `git worktree list` (read-only); read this brief and its recorded prerequisite/trigger.
- Measurements: measured repository inventory contains one main worktree and zero prototype
  worktrees. No pre-AI fixture sweep was run. False stops and wrong-birth-date detection rates remain unknown. T14's direct post-extraction identity-policy baseline does not test this gate.
- Against the criteria: inconclusive; a missing prerequisite is not a candidate pass or fail.
- Deviations and oddities: Git remains read-only. This entry records why the experiment did not
  run; it is not a simulated result or evidence from owner records.
- What it decides: T21 and CRS-108 remain open; CRS-111 is not enabled by T14's baseline.


#### Verification 2026-09-24 — independent verifier, T21 prerequisites only

- Method: independently read the brief and rule 10, ran `git worktree list --porcelain`
  and inspected the changed-file inventory. Measured inventory: one main checkout and zero
  registered prototype worktrees; no private-directory discovery was performed.
- Agreement: **agree**, limited to the prerequisite/non-execution record. The pre-AI gate and fictional PDF/ZIP sweep are distinct from the post-extraction T14 policy calls. False-stop and detection rates remain unknown.
  This is not a verified experimental outcome and does not close the experiment or its task.


#### Run 2026-09-24 — identity/date runner, PDF text-layer pre-AI prototype

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, Darwin arm64, offline production PDF worker `identity` action plus throwaway
  rules. The owner authorized separate agent-created worktrees after the prerequisite check;
  prototype code exists only in the detached `t21` experimental worktree.
- Parameters and fixtures: deterministic fictional Self `Iris Meadow`, known name `Iris Brook`,
  DOB `1982-04-17`. The 22 generated PDFs contain 9 correct-person files, 3 deliberately unknown
  files and 10 wrong-DOB files. Correct files: labeled ISO header; alias with `04/17/1982`;
  changed surname `Iris River` with `April 17, 1982`; missing DOB; subscriber before patient;
  guarantor after patient; parent-only DOB; emergency-contact DOB; and an other-person cover
  page followed by a Self page. Other-person blocks use `Oren Meadow`, `1979-11-02`.
  Unknown files have `03/04/1982` (locale ambiguous), an unlabeled `1979-11-02`, or invalid
  `1982-02-30`. Wrong files use Self's name with `2001-04-17`, `04/17/2001`, `17/04/2001`,
  or `April 17, 2001`; an inline `Patient: Oren Meadow; DOB: 1979-11-02`; an inline table
  `Patient name | Iris Meadow | Date of birth | 2001-04-17`; a two-page running patient/DOB
  header; `Patient DOB: 2001-04-17` alone; a two-line column table
  `Patient name | Date of birth` then `Iris Meadow | 2001-04-17`; and a split value with
  `Patient: Iris Meadow`, `Date of birth:`, `2001-04-17` on separate lines. Other fixtures use
  `Patient:` then `DOB:` on separate lines unless a format above specifies otherwise. A stored
  ZIP contains separate correct-header, missing-DOB, and wrong-ISO PDF members. PDFs use
  Helvetica at 11 points, page size 612×792, origin (45,750), 16-point line spacing; PDF objects,
  byte offsets, xref and trailer are generated directly in TypeScript, independently of labels.
- Commands: from `t21`, `mkdir -p /tmp/circus-t21-20260924` and
  `node t21-prototype.ts /tmp/circus-t21-20260924 > /tmp/circus-t21-20260924/result.json`.
  Portable reconstruction: generate the PDFs above, call `readPdfIdentityPageText` for every
  page using actual byte size and SHA-256 source hash, and feed only extracted strings to the
  classifier. Per page, `Patient:`/`Patient name |` starts patient context; subscriber, guarantor,
  parent/mother/father, emergency-contact and next-of-kin labels end it. Assessment/results/body
  section labels also end it. Collect explicitly labeled `DOB:`/`Date of birth:` values in
  patient context, or `Patient DOB:` anywhere. Parse complete ISO dates, unambiguous slash dates
  (first number above 12 means day-first; both numbers at most 12 but unequal means unknown),
  and English month-name dates. Reject invalid dates with `validOnboardingBirthDate`. Conflicting
  patient DOBs, no patient DOB, or an ambiguous patient DOB produce unknown. One unique valid DOB
  produces match or clear contradiction against Self; only contradiction stops. Canonical name
  comparison against Self/known names is reported separately and never overrides DOB. Create a
  stored-method ZIP with CRC32, inspect members using `yauzl`, write member bytes to external
  temporary files, and independently call the same PDF worker/classifier per member.
- Measurements (measured, receipt: command JSON including actual extracted page text): 22 PDF
  classifications; 0 false stops among 9 correct files; 0 stops among 3 unknown files; 8 of 10
  wrong-DOB files stopped (80%). Both misses were unknown: the separate-row column table and
  birth-date label/value on different lines. The mixed-person ZIP yielded 3 independent member
  decisions: correct header match, missing DOB unknown, wrong DOB contradiction. Both correct
  and missing-DOB members proceeded while the wrong member stopped. There were 0 provider
  requests. This was a text-layer experiment; OCR accuracy is **unknown** here.
- Against the criteria: pass for zero false stops on this corpus, pass for per-member ZIP
  isolation, **fail** for wrong-DOB sensitivity (80% measured, below the fixed 90% threshold).
  Third-party dates and the conflicting cover/body dates did not stop the correct-person files.
  This failure is retained; the detector was not tuned after seeing these misses.
- Deviations and oddities: this is a functional gate, not production upload integration. Patient
  context is line-based, so split-value and column layouts are the measured weakness. Corpus
  labels and expected person classification are never passed to the detector. Source text and
  PDFs remain outside Git. The three prototypes were formatted with Prettier and typechecked
  using `tsc --ignoreConfig --noEmit --allowImportingTsExtensions --module nodenext --target
  es2023 --strict --skipLibCheck`, listing the three worktree prototype files plus the main
  checkout's `src/server/runtime-json.d.ts`; the final check passed. Earlier standalone check
  invocations lacked `--ignoreConfig` or that repository declaration and failed on configuration
  or existing JSON-runtime types, before the corrected command passed. The existing focused
  `node --test src/server/test/self-identity.test.ts` also passed (4 tests, measured). Those checks
  are runner validation, not independent verification of these results.
- What it decides: this particular label-proximity gate does not meet the experiment's detection
  criterion and does not justify enabling CRS-111. Layout-aware patient-field association needs
  another independently verified experiment; permissive unknown handling preserved the measured
  safety criterion. Original criteria and open requirements remain intact.

#### Verification 2026-09-24 — independent verifier, T21 text-layer identity gate

- Method: read the fixture generator, classifier, PDF-worker input path and ZIP member loop,
  then fully reran
  `node ~/projects/circus-health-experiments/t21/t21-prototype.ts /tmp/circus-t21-verifier-20260924 > /tmp/circus-t21-verifier-20260924.json`.
  Independently compared the entire returned JSON with the runner's receipt, including actual
  extracted text and each member decision.
- Agreement: **agree**; all output rows were identical. The rerun measured zero false stops
  among 9 correct files, zero stops among 3 unknown files, and 8/10 wrong-DOB detections (80%).
  The separate-row demographics table and next-line DOB value are the two misses, both unknown.
  ZIP decisions again were match for the correct member, unknown for missing DOB and clear
  contradiction for the wrong DOB. This verifies failure of the fixed 90% detection criterion
  despite satisfying the corpus's false-stop criterion. It does not authorize or qualify the
  production CRS-111 gate, and OCR behavior remains unknown.

### T22: host CPU per page and responsiveness

Task: [CRS-109](application-todo.md#crs-109).

- **Question.** How much CPU does host-side work take per page (indexing, text, native extraction,
  rasterization, and OCR if added), and does a scan-heavy import slow the interface?
- **Current state (code).** PDF work already runs in a forked child process
  ([PDF session](../src/server/intake-pdf-session.ts)) behind one process-wide FIFO queue,
  recycled every 32 rendered pages, and reports `queueWaitMs`, `sessionSetupMs`, `textMs`,
  `renderMs` and `nativePdfMs`. The app container has two CPUs, the proxy one.
- **Method.** Run the existing PDF benchmark (`npm run benchmark:pdf`) for dense, scanned and mixed
  fictional sources, adding T18's OCR timings, under the Compose CPU limits. While it runs, measure
  API latency for ordinary review requests and event-loop delay. Repeat with 1, 2 and 4 concurrent
  host workers if a prototype allows it.
- **Criteria (proposed).** CPU work is "contained" if p95 API latency during a scan-heavy import
  stays within 2× idle and host work per page stays under 10% of the model's per-page wall time.
- **Decides.** Whether CPU work needs its own container or worker pool (OI-35), or whether the
  existing forked worker is enough.
- **Updated 2026-09-24.** The owner keeps the current worker until it breaks. Run this only when a
  [CRS-110](application-todo.md#crs-110) trigger appears or OCR is added.

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, prerequisite check only

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0`, macOS arm64; no experimental provider route used for this check.
- Parameters and fixtures: none executed. The brief limits this experiment to an observed CRS-110 trigger or added OCR. Neither has been established in this session; T18 has not added OCR.
- Commands: `git worktree list` (read-only); read this brief and its recorded prerequisite/trigger.
- Measurements: measured repository inventory contains one main worktree and zero prototype
  worktrees. The host-responsiveness experiment was not run. API p95, isolated host CPU/page and model-relative wall-time ratios remain unknown. T1/T4 harness timings are not substitutes for those measurements.
- Against the criteria: inconclusive; a missing prerequisite is not a candidate pass or fail.
- Deviations and oddities: Git remains read-only. This entry records why the experiment did not
  run; it is not a simulated result or evidence from owner records.
- What it decides: T22 and CRS-109 remain conditionally deferred under the owner's recorded decision, rather than treated as a failed performance criterion.


#### Verification 2026-09-24 — independent verifier, T22 prerequisites only

- Method: independently read the brief and rule 10, ran `git worktree list --porcelain`
  and inspected the changed-file inventory. Measured inventory: one main checkout and zero
  registered prototype worktrees; no private-directory discovery was performed.
- Agreement: **agree**, limited to the prerequisite/non-execution record. The brief and CRS-110 require an observed responsiveness/queue trigger, added OCR, or a selected hosted deployment. No such trigger was established in this session; this does not certify the absence of symptoms in unobserved imports. API and CPU criteria remain unknown.
  This is not a verified experimental outcome and does not close the experiment or its task.


## Stage 3: route reads

### T20: route limits and characters per token

Task: [CRS-107](application-todo.md#crs-107).

- **Question.** What are the configured route's context window, maximum output tokens, rate or
  usage-window limits, `cache_control` acceptance and real characters per token for this
  payload mix?
- **Proposal predicts.** 4 characters per token is an assumption. Result 3 says the current U = 2
  schedule's fixed overhead alone exceeds the 20M-token job limit below 4.30 characters per token.
- **Method.** Read LiteLLM and route configuration. Send one fictional request of known character
  counts per content type (system prompt, schema, page text, a tool call) and read the reported
  usage.
- **Criteria.** Descriptive. Update the cost model's `charsPerToken`, `outputCapTokens` and cache
  parameters in a separate change.
- **Decides.** The single-shot ceiling for candidate J, records per publication, and whether
  caching changes session-length choices.
- **Updated 2026-09-24.** The owner's route is a ChatGPT subscription signed in with a device code
  ([ChatGPT example config](../deploy/litellm/config.chatgpt.example.yaml)). Subscription usage
  windows are probably unpublished, so also record any rate-limit or usage headers the route
  returns and every 429 or usage-limit error, with timestamps and the tokens sent in the preceding
  hour. That is the only evidence for OI-39 and the cost model's `usageTokensPerHour`.

#### Results

_None yet._

#### Run 2026-09-24 — coordinator, route read and one fictional probe

- Commit and environment: `7dc23908299f5e79a0a324713d717f5df95f2778`, Node
  `v24.19.0` on macOS arm64 and in the disposable request container; configured
  `health-primary` alias maps to `chatgpt/gpt-6-astra` in Responses mode. The existing local
  proxy image ID was `sha256:b481cd8449c669793e4fe1a3c27f1d0e661a147f4173c366907b9558cd084125`;
  this operator image predates the checkout and is not a fresh build of its pinned Dockerfile.
- Parameters and fixtures: predeclared one fictional text page × one route-probe strategy ×
  one request, no random seed or retry. The schema was
  `{"type":"object","properties":{"status":{"type":"string","enum":["ok"]}},"required":["status"],"additionalProperties":false}`.
  System text was `This is a fictional transport experiment. No health data is present. Reply with only {"status":"ok"}. Output schema: ` followed by that schema.
  Generate 20 lines with index `i=0..19`, joined by LF:
  `Fictional page 1 row ${i+1}: synthetic item ${i+1}, quantity ${10+i}, unit arbitrary. This is invented test text.`
  The sole function tool was `fixture_marker`, description `Return the fictional page marker.`,
  with object parameters `page` (integer), required `page`, and `additionalProperties:false`.
  Messages were system text with ephemeral `cache_control`, user page text, assistant call
  `fictional-probe-call` to `fixture_marker` with arguments `{"page":1}`, its tool result
  `{"page":1,"marker":"fictional"}`, and user text `Return the specified JSON now.`
  Request options were `tool_choice:none`, `max_completion_tokens:128`,
  `reasoning_effort:low`, `stream:false`, with a 180-second client timeout.
- Commands: from the checkout, `node /tmp/circus-processing-t20/probe.mjs` wrote the pre-run
  plan, then `node /tmp/circus-processing-t20/probe.mjs --run`. This external throwaway script
  used `docker inspect` to read the configured proxy's mounts, environment and image without
  printing secrets; `python /opt/circus/configure.py check` inside an isolated, network-disabled
  proxy container read the route capabilities. To reproduce, start an isolated copy of the
  configured proxy with its existing config/auth/master-key mounts, current
  `deploy/litellm/entrypoint.sh` and `configure.py`, one CPU, a read-only root, no capabilities,
  and writable `/tmp`; mount no archive. Wait for `/health/liveliness`, then send the exact
  JSON fixture above once to `/v1/chat/completions` from a disposable Node container on its
  network, reading the master key from its secret mount. Retain only status, duration, usage,
  rate-limit headers and error classification; remove both disposable containers. External
  `plan.json`, `request.json`, and `receipt.json` accompany the script; none belongs in Git.
- Measurements: measured content characters were system 241 (including schema 124), page
  text 2,001, serialized tool definition 229, serialized tool call 111, all counted input
  content 2,643, and full serialized request 3,101. **Model**, using the cost model's
  `charsPerToken=4` and chosen output allowance 128: input 660.75 tokens, total 788.75,
  stop threshold 1,577.5. Measured at `2026-09-25T01:45:42.752Z`: one HTTP probe returned
  status 400 in 2,891 ms; zero returned rate-limit headers; usage absent. Error type was the
  string `None`, code `400`; the message indicated an unsupported parameter, did not mention
  `cache_control`, quota, or authentication, and was not retained verbatim. The exact rejected
  parameter is **unknown**. Physical upstream attempts, input/output/cache tokens, actual
  characters per token, output cap, context window and subscription allowance remain
  **unknown**. Pre-probe experiment requests in the preceding hour were measured as zero;
  other account traffic and preceding-hour account tokens are **unknown**.
- Against the criteria: descriptive probe executed but token calibration is inconclusive.
  Configuration did not declare context, output, rate or concurrency limits. Capability
  preflight reported images true, prompt caching false, and PDF false; these are configured
  capability readings, not observed provider support. The failed request establishes neither
  acceptance nor rejection of `cache_control`. Do not update cost-model defaults from this run.
- Deviations and oddities: the stopped existing container could not start because its source
  mounts referenced an earlier checkout location. The first disposable proxy did not become
  ready within the initial startup wait; a longer startup wait allowed the one actual probe.
  Neither startup attempt sent a model request. The original containers stayed stopped and the
  temporary containers were removed. The 2× check was post-response, not an in-flight token
  cancellation mechanism; the output-cap field's acceptance was not established. The fixture
  schema is much smaller than the application's schema, so even successful token usage would
  characterize this synthetic mix only. No profile was opened and no owner records were read.
- What it decides: route compatibility must be resolved before calibrating `charsPerToken` or
  cache parameters. T20 remains open; this is a reproducible unsuccessful probe, not a route
  qualification or a provider-limit measurement.

#### Verification 2026-09-24 — independent verifier, T20 unsuccessful probe

- Method: independently counted the retained `request.json` fields and re-derived the model
  arithmetic with Node. Read the runner's `probe.mjs`, `plan.json` and `receipt.json` without
  repeating the live request. Independently repeated the configuration preflight from
  `route-read.mjs` in a disposable `--network none` container with only the configuration and
  `configure.py` mounts; no credentials, owner records or provider connection were used.
  Read-only Docker inspection also confirmed both original containers were stopped and the
  named temporary proxy was absent.
- Agreement: **agree** with the recorded unsuccessful probe and its limitations. Character
  counts independently reproduced system 241, included schema 124, page 2,001, tools 229,
  tool call 111, total counted input 2,643 and serialized body 3,101. Model arithmetic was
  `2643 / 4 = 660.75`, plus 128 gives 788.75, and doubling gives 1,577.5. The receipt records
  HTTP 400, 2,891 ms, absent usage and no retained rate-limit headers; these are receipt
  observations rather than a second live measurement. Offline preflight again returned images
  true, prompt caching false and PDF false for the configured Responses route. The exact
  unsupported parameter and all token/provider limits remain unknown. The script permits one
  probe after readiness and no retry; its post-response overrun test cannot enforce an
  in-flight token stop. This verifies the failed run, not T20 completion or route acceptance.

#### Run 2026-09-24 — coordinator, additional offline route inspection

- Commit and environment: same checkout and local proxy image as the preceding T20 probe;
  network disabled, no authentication mounts or model requests.
- Parameters and fixtures: static inspection of the image's installed
  `litellm/llms/chatgpt/responses/transformation.py`, not an additional live probe.
- Commands: `node /tmp/circus-processing-t20/adapter-read.mjs`. Portable reconstruction:
  `docker run --rm --network none --entrypoint cat sha256:b481cd8449c669793e4fe1a3c27f1d0e661a147f4173c366907b9558cd084125 /app/.venv/lib/python3.13/site-packages/litellm/llms/chatgpt/responses/transformation.py`;
  inspect `ChatGPTResponsesAPIConfig.transform_responses_api_request` and its returned key filter.
- Measurements: measured source SHA-256
  `88b0f4e211f6a6be8268de931f2b02cbfe09b323945b461ae9de0836983a1959`.
  The final allowed keys are `model`, `input`, `instructions`, `stream`, `store`, `include`,
  `tools`, `tool_choice`, `reasoning`, `previous_response_id`, and `truncation`.
  `max_output_tokens` is absent; the function returns only allowed keys. The source also
  forces upstream streaming. This describes the installed adapter, not measured provider limits.
- Against the criteria: reinforces that the probe's requested output allowance is not an
  established upstream bound. Actual output/context/window limits and characters per token
  remain unknown.
- Deviations and oddities: this static finding does not identify which parameter caused the
  preceding HTTP 400; rejection could occur elsewhere before or after this transform. No second
  live request was sent and no adapter was changed.
- What it decides: a future live run cannot rely on this adapter forwarding an output-token
  cap. The earlier token plan was a model, not an enforced upstream limit. T20 remains open.

#### Verification 2026-09-24 — independent verifier, T20 installed adapter

- Method: independently reran the recorded `docker run --rm --network none --entrypoint cat`
  command against the immutable image ID, hashed the returned source using Node and inspected
  the complete request-transform method. No authentication mounts or model calls were used.
- Agreement: **agree**. The source hash again was
  `88b0f4e211f6a6be8268de931f2b02cbfe09b323945b461ae9de0836983a1959`;
  the final allowlist contains the 11 recorded keys, excludes `max_output_tokens`, and is
  applied to the returned request. The method explicitly sets `request["stream"] = True`.
  This independently confirms the static adapter behavior and the output-cap limitation,
  without identifying the HTTP 400 cause or measuring any provider limit.

## Stage 4: small live spend

These need a prototype of the candidate under test (throwaway, fictional fixtures only) and the
experiment spend cap. Predeclare margins before seeing results. Amended 2026-09-24: the cap is
now the run plan and 2× stop rule in rule 8.

### T11: media tokens

Task: [CRS-105](application-todo.md#crs-105). One fictional page with and without its attached
one-page PDF, repeated five times each. It decides whether media is a material share of tokens,
and so how much G's single exposure per page saves over the current two. Result: the cost model's
`mediaTokensPerPage`.

#### Results

_None yet._

### T10: caching

Task: [CRS-104](application-todo.md#crs-104). The qualification harness's paired cache mode on
the route, recording cached share per request. It decides whether the caching break-even (fresh
contexts win below about 46,000 characters of residual at a cached cost of 0.1) holds on this
route. Result: the cost model's `cachedTokenCost`.

#### Results

_None yet._

### T16: stage-one compactness for candidate K

Task: [CRS-106](application-todo.md#crs-106). Run K's stage one on dense fictional pages and
compare output tokens per page with the page's text. Criterion (proposed): stage-one output is
≤ 40% of page-text tokens. Otherwise K's saving disappears. Result: the cost model's
`stageOneFactTokensPerPage`.

#### Results

_None yet._

### T6: multi-record quality under host-pushed units

Task: [CRS-102](application-todo.md#crs-102).

- **Question.** Does G, with a working state, keep multi-record extraction at least as good as the
  current design?
- **Method.** Paired runs on the same fictional M10 fixtures, current versus G, alternating order,
  at least five pairs. Score recall, precision, duplicates and provenance against a literal oracle.
- **Criteria (proposed).** G is non-inferior if recall is within 2 percentage points, precision
  within 1 point, and duplicates no higher.
- **Decides.** Whether G proceeds for multi-record sources.

#### Results

_None yet._

### T23: model-chosen reading plan

Task: [CRS-113](application-todo.md#crs-113). Needs a prototype that indexes before planning.

- **Question.** Does a plan the model chooses from a table of contents beat the fixed default
  (two-page units) on accuracy, requests and tokens per document?
- **Current state (code).** The model can already set `unitSize` (1–50) and `overlap` when it
  calls `intake_plan create` ([assistant tools](../src/server/assistant.ts)), but indexing runs
  inside that call, so it picks before seeing the document.
- **Method.** The host indexes first and sends a table of contents: page count, per-page text-layer
  characters, no-text pages, repeated headers and encounter anchors (D3), and a menu of strategies
  that exist. The model returns a plan: spans, unit size per span, and which spans look like one
  report. The host validates that every page is covered and bounds hold, then runs it. Paired
  against the fixed default on fictional S10, M10 and S200-like fixtures with mixed density.
- **Criteria (proposed).** The model-chosen plan is non-inferior on record recall and association
  recall (within 2 points) and uses fewer requests or tokens per document. Also record the planning
  request's own cost.
- **Decides.** OI-12 (who chooses the strategy) and whether plan revision mid-job (OI-13) is worth
  prototyping.

#### Results

_None yet._

### T7 and T8: single-record associations and session length

Task: [CRS-103](application-todo.md#crs-103).

- **Question.** Do explicit working state and shorter sessions keep cross-page associations when
  identity appears early and findings late (T7)? Is there a session length below which quality
  drops (T8)?
- **Method.** Fictional S10 and S200-like fixtures with the identity on page 1 and findings spread
  to the end. Measure association recall. Current design versus the prototype; then the prototype
  at 4, 16 and 64 calls per session.
- **Criteria (proposed).** Association recall within 2 points of the current design. The knee is the
  shortest session length that stays within that margin.
- **Decides.** A, B, G and K for single-record sources, and I's session length.

#### Results

_None yet._
