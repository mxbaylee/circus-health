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
