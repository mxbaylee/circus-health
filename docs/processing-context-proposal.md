# Processing context and unattended continuation proposal

Review addendum dated 2026-09-24. Status: design for independent review; no processing behavior
changed. [CRS-039](application-todo.md#crs-039) and [CRS-086](application-todo.md#crs-086) own the
requirements and status. This is not a second backlog or a completed provider qualification.
The earlier CRS-086 text and deployment options remain as historical rationale; the corrections
below supersede their unsupported premises, not the evidence-preservation requirements.
A second 2026-09-24 pass appends a [scenario matrix and dominance review](#scenario-matrix-and-dominance-review):
eight document scenarios iterated across every candidate, example wire payloads, which claims
arithmetic can settle, missed assumptions, elimination experiments, a source-shape adapter
candidate and a [decision-readiness](#decision-readiness) split. A third pass adds
[goals, unattended operation and deduplication](#goals-unattended-operation-and-deduplication),
including the open decisions. Neither pass removes an earlier theory. A fourth pass records the
owner's decisions and a [review protocol](#review-protocol-for-later-passes); a fifth adds
[requirements, re-exports and OCR](#requirements-re-exports-ocr-and-the-open-issues-register) and the
[open-issues register](#open-issues-register), the one canonical list of what remains open.

## Decision requested

Choose how to reduce repeated model context and support unattended large-document processing.
Do not approve adaptive boundaries or parallel workers on a claimed speedup: neither is built
or proved better. The user has clarified the desired behavior: a productive server-side import
should continue in the background without a person periodically pressing Resume because an
arbitrary cumulative slice, time or request allowance expired. Long-running work is acceptable
when it is making useful progress.

This means an indefinitely continuable job, not an infinitely growing model conversation.
Retain bounded requests, model context limits and fresh sessions. This proposal does not replace
the unwanted Resume gate with another mandatory aggregate allowance that produces the same
routine interruption. Operator-selected spending limits can be an optional control; their UX
and defaults are undecided. Genuine failures, non-progress, cancellation, authentication and
profile lock are separate from an arbitrary productive-job allowance.

## Current implementation, verified before this addendum

The [proxy bridge](../src/server/proxy-model-bridge.ts) caps a session at 64 provider rounds and
does not dispatch new tools on its final round. The final response can acknowledge previously
delivered results. The [transcript projection](../src/server/proxy-transcript.ts) separately
limits serialized text to 3 × 1024 × 1024 characters and media URLs to 16 MiB. A provider may
have a lower effective context limit; characters are not a model tokenizer or a context guarantee.

Older consumed page text, schema instructions, visual payloads and large successful mutation
arguments are replaced with receipts after a valid subsequent response. Recent exact evidence
is retained. Surrounding tool metadata and historical receipts remain in the session. A productive
time/context-limited slice can automatically start another session with a retained checkpoint.
Page 800 therefore need not inherit all earlier page payloads in one context.

The distinct [whole-job budget](../src/server/intake-reading-budget.ts) is two active hours,
16 slices, 256 counted model turns, 2,048 physical requests or 20 million reported input-plus-output
tokens, whichever binds first. Automatic continuation does not reset these counters. The
[batch Resume handler](../src/server/intake-batches.ts) grants another allowance at `job_limit`
by moving budget baselines and incrementing extensions; lifetime counters remain. It retains
the chat/checkpoint and proposals, rather than intentionally starting the source again.
This is an application policy, not a PDF, provider or context-window necessity.

The [continuation context](../src/server/intake-continuation.ts) already bounds pending pointers:
up to 12 next read windows, eight remaining units, 50 recent candidate references and ten proposal
IDs. However, the outer [assistant context](../src/server/assistant.ts) also includes the last
30 messages, all chat proposals and the last 20 operations. Count bounds alone do not establish
a byte/token bound for variable-size entries.

## What is repeatedly sent

“Metadata” is shorthand here, not a claim that all the content is harmless bookkeeping or that
it excludes health information. In real use these scoped requests can contain health evidence.

- System instructions and tool definitions describe extraction, schema, uncertainty and tool use.
- Read results include schema instructions, original page text/locators and a scoped intake snapshot.
- The [intake context](../src/server/intake-model-context.ts) includes source ID/hash/version,
  plan and unit counts, recent candidate versions, questions, proposal references, mapping rules,
  section counts and a bounded page of requested state. It is not the entire archive.
- Earlier tool calls/results and eviction receipts remain in the conversation and are resent.
- New sessions receive the continuation and outer conversation state described above.

Individual snapshots can be bounded while their repeated copies still consume substantial input.
Compacting `instructions` and `original.text` leaves the read's other fields, including its intake
snapshot, intact. Receipts themselves also occupy space. Growing source state, repeated snapshots
within a session and restart seeds are distinct effects and should be measured separately.

Additional raw-field counters in the 200-page offline run accumulated approximately 21.9 million
characters under `intake`, 12.5 million under `instructions` and 9.4 million under `original`
across tool messages sent. These include retained exact content and replacement receipts, where
applicable. They are not unique source sizes, billed tokens, or an exact additive partition of
serialized request characters. The two 800-page runs predate these extra field counters; do not
extrapolate their proportions to those runs.

## New offline evidence

Five sequential 2026-09-24 runs used the actual assistant, PDF reader, proxy bridge and Import
coordinator with unchanged production limits. An external adaptation of the existing
[controlled integration test](../src/server/test/intake-pdf-controlled.integration.test.ts)
generated dense fictional PDFs, scripted one page read per tool response and published one
synthetic record per page at a configurable batch size. No real provider was called.

- One page, one-page batch: complete synthetic coverage; five requests, one slice; 328,750
  cumulative serialized text characters; 92,354 maximum per request; about 1.2 local seconds.
- 20 pages, ten-page batches: complete synthetic coverage; 25 requests, one slice; 4,096,171
  cumulative characters; 249,100 maximum; about 2.6 local seconds.
- 200 pages, ten-page batches: complete synthetic coverage; 226 requests, four slices; 75,448,280
  cumulative characters; 613,127 maximum; about 28.7 local seconds.
- 800 pages, ten-page batches: all 800 pages delivered and accounted across 80 units; 896 requests,
  14 slices; 393,189,513 cumulative characters; 822,130 maximum; about 302.6 local seconds.
- 800 pages, default two-page batches: `job_limit` after 671 delivered pages and 670 accounted
  pages across 335 units; 65 units remain; 1,024 requests, 16 slices; 830,087,567 cumulative
  characters; 1,532,547 maximum; about 756.8 local seconds. The outer batch status was `complete`,
  but the item reason and reading checkpoint reported the pause. It is not complete coverage.

Every run retained the original hash, accepted no records and used no budget extension. Checks
verified exact sequential delivered/accounted prefixes, unique unit IDs, no reported errors and
the sum of request characters. The 800-page ten-page run had at most two PDF parts per request;
fresh-session first requests were approximately 46,000–65,000 characters, while last requests
were approximately 690,000–822,000.

Limitations: the fake model kept perfect progress in a JavaScript closure and manufactured records
from page numbers, rather than extracting them. Usage was explicitly incomplete; no actual token
budget was exercised. Local timings measure host work with immediate fake replies, not provider
latency, production deployment performance or statistically established speedups. The smaller
runs used separately generated files. The incomplete two-page run is not an equal-completion
timing comparison with the ten-page run. No adaptive implementation was tested.

An independent reviewer checked both 800-page receipts and graded the scoped offline proof A.
That grade is not a grade for model accuracy, the proposed architecture or production readiness.

Follow-up, 2026-09-24: the owner requested completing the two-page experiment while retaining
the original stopped recording. A fresh deterministic rerun reproduced all 1,024 original
request-measurement rows exactly, then used the existing Resume action once on that rerun's
saved checkpoint. Independent verification confirmed unchanged identity, proposals and cumulative
counters at Resume, with the normal budget-offset extension. Both recordings are separately
documented in [T1/T4 results](processing-experiments.md#t1-and-t4-where-the-input-characters-go):

- **Original allowance only:** 671 pages read, 670 ready records, 335 accounted units,
  1,024 requests and 16 sessions; 830,087,567 cumulative serialized text characters.
- **Rerun plus one Resume:** all 800 pages read, 800 ready records, 400 accounted units,
  1,222 requests and 20 sessions; 987,624,881 cumulative serialized text characters.
  Resume added 198 requests and 157,537,314 characters, with zero remaining units or pending
  windows. The retained original is unchanged, no tool errors occurred, and no records were accepted.

The completed two-page schedule can now be compared with the completed ten-page schedule's
896 requests and 393,189,513 characters. These are scripted control-flow and serialized-text
measurements, not measured provider tokens, latency or extraction quality. The original guard
finding remains valid; the separate follow-up establishes completion after an explicit extension.
The fixed per-request cost model still fails: only 1,118 of 1,222 requests meet its ±20% tolerance.

## Mathematical claims and their limits

For the measured scripted schedule let N be source pages and U be pages per publication:

    executed tool calls C = N + ceil(N / U) + 2 setup calls
    sessions S = ceil(C / 63)
    provider requests R = C + S

For N=800 and U=10, C=882, S=14 and R=896, matching observation. For U=2, C=1,202,
S=20 and R=1,222 would be needed; the initial 16-slice allowance stops first. One additional
allowance has enough slice capacity for the roughly four remaining sessions if the same schedule
continues and no other limit binds. That resumed run was not performed. Setup, retries, rereads,
multi-tool responses and real model choices can change these equations; they are not universal
lower bounds. Resume cannot itself repair lost associations or reduce repeated input.

The follow-up above subsequently measured the predicted 20 sessions and 1,222 requests after
one Resume. The original stopped run and its mathematical prediction remain recorded separately.

Under the current single allowance, 800 pages require averages no greater than 25,000 reported
input-plus-output tokens, nine active seconds and 2.56 physical requests per page, plus compliance
with the turn/slice limits. These are necessary budget conditions, not model-performance estimates.
If fixed lifetime allowances are removed for productive work, they cease to be completion gates;
the same totals remain useful diagnostics.

An illustrative history model explains repetition. If every interaction leaves h characters and
all prior additions are resent for m requests, their cumulative contribution is h × m(m+1)/2.
With h=10,000 and m=60 this is 18.3 million characters. A fixed 10,000-character working summary
over 60 requests contributes 600,000: 30.5 times less for that component only. Current contexts
are already bounded; do not model all 800 pages as one quadratic conversation. More generally,
sum each session's fixed prefix, seed, current evidence and residual history separately. If those
sizes and the session length stay bounded, total input can grow roughly linearly with work;
growing seeds, snapshots, rereads or records per page can violate those assumptions.

The historical pre-eviction rate extrapolates to approximately 98.86 million reported tokens and
10.27 hours of provider-request time for 800 pages. Conditional on those rates still applying,
fitting one current allowance would need about 79.8% fewer tokens and more than fivefold faster
processing. These are historical targets, not forecasts or bounds on today's implementation.
See the [corrected deployment analysis](remote-deployment-design.md#what-an-800-page-import-must-achieve).

Neither raw math nor these scripted tests establishes extraction quality or a live speedup.
Three workers offer at most threefold ideal parallel speedup for identical independent work at
unchanged per-request speed, before serial overhead and contention. Boundary discovery and rereads
add work. Bisection does not make required document reading logarithmic.

## Earlier ideas: corrections and dispositions

1. **One growing conversation makes 800 pages impossible — withdrawn.** Existing session changes
   and evidence eviction already prevent that baseline. Current code traversed 800 scripted pages.
   Real-model feasibility remains open; repeated context is still measured and worth reducing.
2. **Old token projections prove the new design is necessary or faster — withdrawn.** They precede
   eviction and cannot establish current rates. Retain them only as labeled sensitivity examples.
3. **PDF headings are a straightforward extension of HTML heading extraction — unproven.** Keep
   CRS-087's feasibility investigation. Text-layer order, scanned pages, tables and repeated headers
   may require more than plumbing. Text-layer/OCR signals are advisory, never permission to skip.
4. **Always start at first/middle/last and recursively bisect — candidate, not selected default.**
   It could expose independent sections sooner, but also duplicates boundary reads and starts
   workers mid-report. Tiny documents may be slower. First compare simpler bounded sequential
   processing and fixed windows. Do not assume backward-reading quality equals forward reading.
5. **“Page 2, line 5” is sufficient ownership — insufficient as stated.** Use stable source-hash,
   page and block/region locators. Text extraction order can change; scans may have no usable lines.
   Partial-page ownership and multi-page tables need explicit contracts before parallel work.
6. **Larger batches solve extraction efficiency — only a scheduling result so far.** Ten-page
   scripted batching fits the slice allowance; no evidence says it preserves all real associations
   or beats smaller batches for dense documents. Keep batch size an experimental variable.
7. **Every additional job allowance should require Resume — superseded by the user requirement.**
   Continue productive work without routine manual renewal. Retain lifetime diagnostics rather
   than pretending each continuation is a new zero-cost job. Do not partition files solely to
   evade accounting. Removing a pause removes waiting for a human, not model inference time.
8. **A mandatory upfront total budget is the replacement UX — not selected.** It could recreate
   the same artificial interruption. Optional operator limits may be useful; they must be explicit
   rather than silently substituted for the requested unattended behavior.
9. **Remove all limits or allow one endless transcript — not recommended.** The requested long job
   can consist of bounded fresh sessions. Keep per-request payload/context bounds, cancellation,
   finite retry/backoff and semantic loop detection. Progress checks must recognize real new
   evidence or retained findings, not fresh timestamps, cosmetic proposals or repeated calls.

## Revised design candidates

First isolate context efficiency from scheduling. Let the host retain the full ledger and exact
evidence. Send a compact current unit, unresolved cross-page associations, relevant stable IDs,
recent exact evidence and narrowly requested prior details. Replace obsolete state snapshots
instead of accumulating each revision. Bound receipts and restart seeds by size as well as count.
Summaries are navigation/working state, never source evidence; exact claims require original
locators and re-readable source windows. Preserve PDF-first delivery and verified same-page PNG
fallback. Do not introduce lossy evidence transformations or automatic acceptance.

Separately revise whole-job continuation: productive work schedules another bounded session
without requiring a human because a fixed lifetime allowance expired. Keep cumulative usage,
active time, source coverage, candidate yield and repeated-work diagnostics. Use durable
checkpoints and idempotent scheduling; Stop must prevent further work, including delayed retries.
Pause with an actionable explanation for genuine non-progress, unrecoverable errors or missing
authentication. Lock still clears keys and stops private work. Continuing across a locked profile
or process restart needs a separate authorization/key-lifetime design; unattended while the
server/profile remain available does not imply storing an unlock key or bypassing lock.

Then evaluate adaptive coherent spans. A worker starts in an unowned region and requests adjacent
context until it can account for a cohesive span, bounded even if the document is one long report.
The host validates exact ownership, gaps and overlaps; reading/acknowledgment, proposed coverage
and accepted records are separate states. Context reads may overlap, extraction ownership may not
silently overlap or disappear. A long coherent report needs bounded handoffs, not one giant session.

Parallel first/middle/last discovery remains an optional comparison. Recurse into remaining gaps
only after ownership is resolved. Cap worker concurrency against measured provider/host capacity.
Use one coordinator for durable publication: current version pins and single-writer semantics do
not make naive concurrent mutation safe. Cross-worker identity and report associations must be
reconciled before claiming completeness. Do not build page triage under this proposal.

## Independent evaluation before selecting an implementation

Reviewers should first audit the code and equations above. The public controlled test is a starting
point, not a checked-in reproduction of all five runs. Reproduce with an external parameterized
harness: vary pages and publication size, keep actual budgets/bridge/coordinator, inject a scripted
fetch transport, record every request envelope size and exact coverage receipt, and label absent
usage unknown. Publish portable summaries rather than private paths, logs or credentials. Keep
source version/hashes with receipts and disclose fake-model state outside the conversation.

Compare the current implementation against bounded sequential context first, then fixed versus
adaptive units, then one versus two/three workers. Change one factor at a time; keep gateway,
model, source, media representation and cache conditions controlled. Treat automatic allowance
renewal as a separate scheduling variable, not a context/token optimization. Do not confuse a
partial baseline stopped by policy with a complete candidate run when reporting speedup.

The offline corpus should cover 1, 20, 200 and 800 pages, dense and sparse/scanned documents,
one very long report, many short reports, split tables, mid-page boundaries, mixed identities,
overlapping reads and ambiguous ownership. Measure cumulative/peak request size, request counts,
repeated snapshots, seed size, rereads, pending versus accounted coverage, duplicates, missing
spans, host resource use and checkpoint/retry behavior. Scripted boundaries test orchestration;
they do not establish the model's ability to discover boundaries. Test real progress followed by
a loop, new records within one page, Stop/lock during continuation, stale worker results and recovery.

Only after offline correctness, perform small paired autonomous model tests on fictional sources
with an explicit experiment spend cap. That cap limits evaluation expenditure, not the proposed
product's routine continuation. Measure actual tokens/cache usage and latency along with exact
record/provenance recall, precision, duplicate rate, cross-page associations and honest unresolved
coverage. Repeat enough to disclose variability; predeclare acceptable quality and performance
criteria before seeing candidate results. Expand only promising cases. Do not spend on a full
800-page baseline merely to confirm an already demonstrated policy stop.

A proposal passes review only if it states which savings are measured, predicted or unknown,
preserves evidence and user control, and identifies the smallest experiment that could refute it.
The current evidence supports investigating repeated-context reduction and removing routine
manual allowance renewal. It does not yet select adaptive bisection or prove it superior for
large documents, small documents or extraction accuracy. All real-provider/document gates remain open.

## Scenario matrix and dominance review

Second-pass review dated 2026-09-24. Status: analysis only; no processing behavior changed and
no provider was called. Every earlier idea above stays on the list. This section adds candidates,
iterates all of them across eight document scenarios, and separates claims that arithmetic can
settle from claims that need an experiment. Numbers marked _model_ come from the formulas below,
calibrated to the five offline receipts; they are not measurements of the candidate designs.

### Objectives and the Pareto question

Two costs matter: reported tokens (input and output, with cached input tracked separately) and
end-user time to reviewable results. End-user time is the sum of sequential provider requests,
host work and any wait for a person to press Resume. The two objectives only truly compete where
a change buys time by spending tokens. A change that lowers one without raising the other
_dominates_ the design it replaces. The useful question is therefore whether the current design
already sits on the tradeoff frontier. The dominance results below show it does not, **provided
extraction quality is unchanged**. Arithmetic cannot establish that proviso; experiments must.

### The eight scenarios

Record shape is interpreted as follows; the offline receipts used a third shape (exactly one
synthetic record per page), so neither scenario below has been measured directly.

- **Single record:** one logical report spans the whole document, such as one long report whose
  identity, dates and headings appear early and whose findings continue across pages. Output is
  tiny; every page can matter to one association.
- **Multi record:** many independent records, assumed four per page, like the long qualification
  fixture's 400 records across 100 pages. Output is large; associations are mostly local, apart
  from split tables and mid-page boundaries.

| Scenario | Pages | Records | Record output tokens¹ | Minimum publications² |
| -------- | ----: | ------: | --------------------: | --------------------: |
| S1       |     1 |       1 |                  ~330 |                     1 |
| M1       |     1 |       4 |                 ~1.3k |                     1 |
| S10      |    10 |       1 |                  ~330 |                     1 |
| M10      |    10 |      40 |                  ~13k |                     1 |
| S200     |   200 |       1 |                  ~330 |                     1 |
| M200     |   200 |     800 |                 ~263k |                    16 |
| S800     |   800 |       1 |                  ~330 |                     1 |
| M800     |   800 |   3,200 |                ~1.05M |                    64 |

¹ At 329 output tokens per record: 26,294 output tokens over 80 proposals in the 2026-09-23 live
slice, including tool-call overhead. ² At the instructed ceiling of 50 records per publication.

### What one request actually contains today

Verified against the code for this review; character counts were measured by loading the modules.

- `POST /v1/chat/completions` with `tools`, `tool_choice: "auto"`, `stream: false` and
  `disable_fallbacks: true` ([bridge](../src/server/proxy-model-bridge.ts), request construction).
- System message: [assistant instructions](../src/server/assistant-instructions.md), 28,250
  characters, plus a ~440-character continuation notice after round zero. `cache_control` is added
  only when the optional prompt-cache capability is on; it is off by default.
- Tools: all 21 registered tools, 19,379 serialized characters, on every conversion request. The
  seven intake-relevant tools are about 7,900 characters.
- Every `health_intake_read` result carries the full 22,739-character schema block
  (`INTAKE_SCHEMA_INSTRUCTIONS`), the page text (at most 24,000 characters), locators and an intake
  snapshot of roughly 2,600 characters or more. The page itself follows as a one-page native PDF
  `file` part, or a PNG `image_url` after a verified PDF rejection.
- Compaction keeps one consumed item per class exact, so each request carries the two newest read
  results, media messages and mutation arguments verbatim. Older reads keep their snapshot,
  metadata and receipts; only schema text, page text, media and large `jsonlText` are replaced.
- A fresh session starts with one user message: the conversation context (last 30 messages, all
  chat proposals, last 20 operations) and the bounded continuation checkpoint.

A mid-session request for page 9 of a two-page-unit plan therefore looks like this, abbreviated.
All values are fictional:

```jsonc
{
  "model": "health-primary",
  "tool_choice": "auto",
  "stream": false,
  "disable_fallbacks": true,
  "tools": [/* 21 function tools, 19,379 chars */],
  "messages": [
    {
      "role": "system",
      "content": "<assistant-instructions.md 28,250 chars><continuation notice>",
    },
    {
      "role": "user",
      "content": "Continue the authorized intake conversion… {\"messages\":[/*≤30*/],\"proposals\":[/*all*/],\"operations\":[/*≤20*/],\"conversion\":{\"nextReadWindows\":[/*≤12*/],\"remainingUnits\":[/*≤8*/],\"retainedCandidates\":[/*≤50*/],\"proposalIds\":[/*≤10*/]}}",
    },
    // one compacted group per earlier call in this session (pages 1–7, publications):
    {
      "role": "assistant",
      "tool_calls": [
        {
          "id": "c7",
          "type": "function",
          "function": {
            "name": "health_intake_read",
            "arguments": "{\"id\":\"intake-demo\",\"page\":7}",
          },
        },
      ],
    },
    {
      "role": "tool",
      "tool_call_id": "c7",
      "content": "{\"instructions\":\"[HOST_TRANSCRIPT_RECEIPT: … instructionCharacters=22739 …]\",\"mappingRules\":{…},\"intake\":{/* full snapshot, kept */},\"original\":{\"page\":7,\"text\":\"[HOST_TRANSCRIPT_RECEIPT: … pageTextSha256=… ]\",\"assets\":[…],\"coverage\":\"…\"}}",
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "[HOST_TRANSCRIPT_RECEIPT: 1 visual evidence data URL was removed … pdf1Sha256=…]",
        },
      ],
    },
    // page 8, still exact because it was the most recently consumed read:
    { "role": "assistant", "tool_calls": [/* health_intake_read page 8 */] },
    {
      "role": "tool",
      "content": "{\"instructions\":\"<22,739-char schema>\",\"intake\":{…},\"original\":{\"text\":\"<page 8 text>\",…}}",
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "The immediately preceding scoped tool results include…" },
        {
          "type": "file",
          "file": { "filename": "scoped-page.pdf", "file_data": "data:application/pdf;base64,…" },
        },
      ],
    },
    // page 9, the current read: same shape as page 8
  ],
}
```

The model answers with the next read or a publication. A publication is one call whose records
are JSONL lines inside one string, so single- and multi-record pages differ only in line count:

```jsonc
{
  "name": "health_intake_batch",
  "arguments": {
    "id": "intake-demo",
    "version": 37,
    "planId": "plan-demo",
    "operationId": "op-demo-5",
    "jsonlText": "{\"format\":\"health-record-v1\",\"id\":\"demo-p9-1\",\"kind\":\"observation\",…,\"provenance\":{\"locator\":\"page 9\",…}}\n…",
    "summary": "…",
    "coverage": [{ "unitId": "unit-5", "kind": "extracted", "notes": "…" }],
  },
}
```

### Candidates iterated

Existing candidates keep their earlier labels in prose; letters are added for the tables. New
candidates added by this review are marked **new**.

| Id  | Candidate                                                   | Source                                                                 |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0   | Current code, default two-page units                        | Measured                                                               |
| 0b  | Current code, ten-page units (earlier idea 6)               | Measured                                                               |
| A   | Original CRS-086: fresh bounded context per unit            | CRS-086 text                                                           |
| B   | Bounded sequential context: host ledger, no snapshot copies | Revised design                                                         |
| C   | Unattended continuation (scheduling only)                   | Revised design                                                         |
| D   | Adaptive coherent spans                                     | Revised design                                                         |
| E   | Parallel first/middle/last with recursive bisection         | Earlier idea 4                                                         |
| F   | Fixed windows with two or three workers                     | Revised design                                                         |
| G   | Host-pushed units: no read round trip                       | **new**                                                                |
| H   | Fixed-prefix hygiene and prompt caching (overlay)           | **new**                                                                |
| I   | Session length as an explicit variable                      | **new**                                                                |
| J   | Processing adapters selected by source shape                | **new**; see [below](#candidate-j-processing-adapters-by-source-shape) |

Raising allowances, partitioning the source and page triage (deployment design section E, CRS-044)
remain recorded options. They change authorization or coverage rather than per-page work, so they
are not modeled separately here; triage stays withheld.

**0 / 0b — current.** The model drives one scoped read per response, publishes each unit, and the
bridge starts a fresh session after 63 executed calls. Payload: as above. Work per job:
`C = N + ceil(N/U) + 2` calls, `S = ceil(C/63)` sessions, `R = C + S` requests.

**A — fresh bounded context per unit.** Each unit gets a new session seeded with shared headings
and a small typed working state instead of prior history. Reads within the unit are still
model-driven, so requests per unit are `U + 2` (reads, publication, acknowledgment). Payload
difference: the seed replaces conversation history, for example
`"workingState": {"format": "intake-working-state-v1", "notEvidence": true, "openAssociations":
[{"candidateId": "cand-demo-12", "openedAt": "page 41", "awaiting": "result rows continue"}],
"sharedHeadings": [{"text": "Test | Result | Units | Reference", "fromPage": 41}]}`.

**B — bounded sequential context.** Same schedule as 0, but only the newest read carries the full
intake snapshot. Older results keep a version reference (`"intake": {"snapshotVersion": 37,
"superseded": true}`), and receipts and seeds are bounded by size. The model's per-call residual
falls from the fitted 11,100–23,400 characters to an assumed ~2,000.

**C — unattended continuation.** No payload change. It removes human wait at `job_limit` and
changes no token or request count.

**D — adaptive coherent spans.** Like A or G, plus an explicit way to request adjacent context
and claim a span. Tokens depend on span sizes and the reads spent finding boundaries. For single
record documents it degenerates to one span with bounded handoffs, which makes it A or G carrying
working state.

**E — first/middle/last bisection.** Three workers start at pages 1, N/2 and N, each with a
payload like 0 or G. Seams add context-only reads, and cross-worker reconciliation adds
coordinator work.

**F — fixed-window workers.** Disjoint contiguous windows assigned to two or three workers, each
running 0, A or G. One coordinator publishes.

**G — host-pushed units (new).** The host already knows the plan, so it sends each unit's pages
in the user message and the model's only required response is the publication. Rereads and
adjacent context remain available through the existing scoped read tool. One request per unit
replaces `U` read round trips plus an acknowledgment:

```jsonc
{
  "model": "health-primary",
  "tool_choice": "auto",
  "tools": [
    /* health_intake_read (reread/adjacent only), health_intake_batch, health_intake_question */
  ],
  "messages": [
    { "role": "system", "content": "<conversion instructions + schema block once>" },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "{\"unit\":{\"id\":\"unit-41\",\"pages\":[81,82],\"sourceHash\":\"…\"},\"workingState\":{…},\"pages\":[{\"page\":81,\"text\":\"…\",\"locators\":[…]},{\"page\":82,…}]}",
        },
        {
          "type": "file",
          "file": { "filename": "page-81.pdf", "file_data": "data:application/pdf;base64,…" },
        },
        {
          "type": "file",
          "file": { "filename": "page-82.pdf", "file_data": "data:application/pdf;base64,…" },
        },
      ],
    },
  ],
}
```

**H — fixed-prefix hygiene and prompt caching (new overlay).** Send the schema block once in the
system prefix rather than in every read result. Send only conversion tools, as draft repair
already filters tools. Keep the prefix byte-stable and enable `cache_control` where the route
accepts it. Composable with every other candidate. Estimated saving before caching: about 34,000
characters per non-initial request (11,500 of tools plus one of the two exact schema copies).

**I — session length as a variable (new).** The 64-round cap is a safety bound, not a derived
optimum. The formulas below show total input grows with session length `m`, so `m` belongs in the
experiment matrix rather than being fixed at 64.

### Model and calibration

For a session of `m` requests with first-request size `P` and residual `r` left by each executed
call, request `j` carries about `P + r·j` characters. Summing over sessions:

    total input ≈ C · (P + r·m/2)                 (bounded sessions: linear in C)
    single conversation ≈ C·P + r·C(C−1)/2          (quadratic in C)

Fitted to the receipts: `P ≈ 55,000` characters (observed 46,000–65,000), `r ≈ 11,100` at ten-page
units and `r ≈ 23,400` at two-page units (from the largest requests). The model reproduces the
800-page runs within 8% (363M versus 393M characters) and 2% (811M versus 830M over the 16
completed sessions); it overstates the 200-page run by 14% and the one-page run by 24%, where
fresh-session size was smaller. Tokens below use 4 characters per token, a stated assumption:
the one live anchor is a first request of 11,446 tokens, but its character count was not
recorded. Media tokens are excluded throughout and are counted separately.

_Model_ requests on the critical path and cumulative input tokens, excluding media. These are
the same for single- and multi-record scenarios to first order. Multi-record documents add
larger publications and receipts, which raises `r` somewhat:

| Candidate                    | 1 page      | 10 pages   | 200 pages  | 800 pages    |
| ---------------------------- | ----------- | ---------- | ---------- | ------------ |
| 0 current, U=2               | 5 / 0.10M   | 18 / 1.1M  | 307 / 59M  | 1,222 / 241M |
| 0b current, U=10             | 5 / 0.10M   | 14 / 0.45M | 226 / 21M  | 896 / 91M    |
| A per-unit context, U=2      | 3 / 0.05M   | 20 / 0.45M | 400 / 9.0M | 1,600 / 36M  |
| B bounded sequential, U=2    | 5 / 0.07M   | 18 / 0.32M | 307 / 8.9M | 1,222 / 36M  |
| B + H                        | 5 / 0.04M   | 18 / 0.18M | 307 / 6.3M | 1,222 / 26M  |
| G host-pushed, U=2           | 1 / 0.02M   | 5 / 0.09M  | 100 / 1.8M | 400 / 7.2M   |
| G host-pushed, U=10          | 1 / 0.02M   | 1 / 0.03M  | 20 / 0.52M | 80 / 2.1M    |
| F three workers over G, U=10 | 1 / 0.02M   | 1 / 0.03M  | 8 / 0.55M  | 28 / 2.1M    |
| E first/middle/last over 0   | dup. reads³ | 7 / 1.2M   | 104 / 59M  | 409 / 241M   |

Cells are critical-path requests / cumulative input tokens. ³ A one-page first/middle/last reads
the same page three times. G assumes 3,000 characters of text and 1,000 of locators per dense
page and a 10,000-character seed; G and F assume one publication fits one response, which M200
and M800 contradict at U=10 (see the output-cap result below). Parallel rows add one prefix and
one seam page per extra worker. None of these rows has been run.

### What arithmetic settles

Each result holds under the assumptions stated with it. None of them establishes extraction
quality.

1. **The earlier "pure math" claim is true, but only for a single appended conversation.** One
   conversation supports at most `floor((X − P)/r)` calls under a context bound of `X`
   characters. The application's own 3 × 1024 × 1024-character cap allows 132 calls at
   `r = 23,400` and 278 calls at `r = 11,100`; a 1M-token provider window at 4 characters per
   token allows 168–355. An 800-page job needs 882 calls at U=10 or 1,202 at U=2, and its final request would carry
   about 9.8 or 28 million characters respectively. So a single growing conversation provably cannot process 800 pages.
   The same bound applies to any document needing more than roughly 130–280 calls. Current code
   does not use that design, which is why earlier idea 1 stays withdrawn as a statement about
   today's pipeline.
2. **Bounded sessions make total input linear, but the coefficient is mostly waste.** Per call,
   `r·m/2` is 355,000 characters at U=10 and 749,000 at U=2, against `P ≈ 55,000`. Under the fit,
   residual history is 87–93% of input for long documents. Without caching, total input increases
   monotonically in both `r` and `m`. Any change that lowers either without adding calls lowers
   input: B and I dominate 0 on tokens, other things equal.
3. **Fixed overhead alone nearly exhausts the default token allowance.** System prompt, all tools
   and one schema copy total 70,368 characters per request. Multiplied by the 1,222 requests that
   default two-page units need for 800 pages, that is 86.0 million characters: 20 million tokens
   exactly at 4.30 characters per token. (Session-opening requests carry no schema copy, but most
   requests carry two, so the figure is conservative.) The default schedule cannot fit one allowance on fixed
   overhead alone unless tokenization exceeds 4.30 characters per token, even with perfect
   eviction and before page text, media, snapshots or output. At ten-page units the threshold is
   3.15. This result stands independently of the slice-count stop already documented. It
   motivates H regardless of which scheduler is chosen.
4. **Round trips.** Model-driven single-page reads need at least `N + ceil(N/U) + 2` executed
   calls. Host-pushed units need `ceil(N/U)` plus any rereads. Per-request fixed latency and fixed
   prefix are paid `R` times, so G reduces both by roughly `U + 1` for the same unit size. G
   dominates 0 on tokens and on round-trip latency, other things equal. It shifts work into
   larger individual requests and outputs, so its time advantage depends on result 6.
5. **Parallelism never reduces tokens.** Each worker pays its own prefix and seed, and seams add
   context reads, so summed tokens are at least the single-worker total for the same units.
   Parallelism can only cut the critical path, to no less than `R/W` plus coordination. E and F
   are therefore the only candidates on the genuine tokens-for-time frontier. Every other
   candidate either dominates the current design or is dominated by it on both axes.
6. **Output is a latency floor that input work cannot move.** Serial time is at least
   `O / v`, where `O` is output tokens (including any hidden reasoning) and `v` the route's decode
   rate. M800 needs about 1.05 million record-output tokens; at an assumed 50–100 tokens per
   second that is 2.9–5.8 hours serial before any input is processed. Only parallel workers or
   smaller record envelopes move this floor. S800 has negligible output, so its time is governed
   by round trips and prefill. **The best design can therefore differ by record density**, and a
   single winner across all eight scenarios should not be expected.
7. **Output caps bound unit size for dense pages.** Records per publication are limited to
   `min(50, O_max / 329)`. At four records per page, a unit holds at most 12 pages under the
   instructed ceiling, regardless of context room. Single-record documents have no such bound.
8. **Small documents eliminate splitting.** When `N ≤ U`, one request can hold the whole document;
   every split adds at least one prefix and cannot shorten a one-request critical path. E, F and
   D are strictly worse for S1, M1 and S10, and for M10 whenever its output fits one response.
9. **Caching changes the session-length break-even; it does not remove it.** With perfect prefix
   caching at relative cached price `c`, a session of length `m` costs per call about
   `(r + E) + c·(P + r(m−1)/2)`. A fresh context per unit with a cacheable prefix costs about
   `s + E + c·P`, where `s` is its uncached seed. Fresh contexts win when
   `s < r + c·r(m−1)/2`. With `c = 0.1`, `r = 11,100` and `m = 64` that threshold is about 46,000
   characters; without caching (`c = 1`, today's default) it is about 360,000. A working state
   must therefore stay well under ~46,000 characters for A or G to remain cheaper once caching is
   enabled. Compaction rewrites the group two positions back on each round, so the cacheable
   prefix of the current design ends there; the reported cached-input share on the route must
   confirm any caching assumption.

The combined conclusion: **the current design is not at the tradeoff wall.** B, H, G and I lower
tokens without adding requests, and G also lowers requests. Only E and F trade tokens for time.
The statement is conditional on each change preserving extraction quality, especially
cross-page associations. That condition, not the arithmetic, is what remains to eliminate.

### Scenario-by-scenario reading

| Scenario | Dominant cost term                                        | Eliminated by arithmetic                       | Candidates worth testing              | Main quality risk                           |
| -------- | --------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| S1       | Fixed prefix × 5 requests                                 | D, E, F                                        | G, H                                  | None cross-page                             |
| M1       | Fixed prefix; small output                                | D, E, F                                        | G, H                                  | Mid-page record boundaries                  |
| S10      | Fixed prefix and residual; 18 requests at U=2             | D, E, F                                        | G (U=10, whole document), H           | Association within one request is best case |
| M10      | Output ~13k tokens in one response                        | E, D                                           | G (U=5–10), H; F only if output-bound | Output cap may force two publications       |
| S200     | Residual history; 4–5 sessions today                      | Single conversation (result 1)                 | B, G + working state, H, I            | Association across units rests on the seed  |
| M200     | Residual (0); output floor ~0.7–1.5 h serial              | Single conversation                            | G (U≤12), F over G, H                 | Split tables at unit seams                  |
| S800     | Residual; default U=2 stops at the slice allowance        | Single conversation; 0 at U=2 in one allowance | B, G + working state, C, H, I         | One association crosses 13–19 boundaries    |
| M800     | Output floor ~2.9–5.8 h serial; fixed overhead (result 3) | Single conversation; 0 at U=2 in one allowance | G, F over G, C, H                     | Seams, duplicates across workers            |

For single-record documents the current design has one genuine advantage: within a session, the
model's own history carries the association. Across its 3–19 session boundaries, however, only the
seed does, and the seed carries candidate references rather than their content. A, B, D and G make
that working state explicit rather than incidental. Whether an explicit state loses less than
today's incidental one is the core empirical question for S200 and S800.

### Assumptions the earlier analysis missed

1. **Residual per call is not a constant.** The fitted residual doubles from U=10 to U=2 (11,100
   to 23,400 characters). It depends on unit size and progress, probably through repeated
   snapshots and mutation receipts. The linear-with-bounded-sessions statement survives; the
   coefficient is where the waste is and must be attributed by field.
2. **The schema block rides in tool results, not the system prompt.** At 22,739 characters it
   appears in up to two exact reads per request and sits outside any cacheable system prefix.
3. **Every conversion request sends all 21 tools.** Roughly 11,500 of the 19,379 characters
   describe tools conversion does not use.
4. **Fixed overhead scales with requests, not pages** (result 3). Request count is itself a
   token lever, independent of eviction.
5. **Each page's media is exposed in about two requests.** The retain-one policy keeps the previous
   page's PDF exact. Media is outside the 3 MiB text cap and outside every character figure here,
   and its provider token cost is unmeasured. G exposes each page once plus any overlap.
6. **The output side was ignored.** Record output sets a latency floor (result 6) and a unit-size
   cap (result 7). Once input is optimized, output may become the dominant cost for multi-record
   documents, because output tokens are usually priced higher; the 329-token record envelope is
   then a lever in its own right.
7. **The workload mix matters.** An average-page objective hides small documents, which are
   likely common and are dominated by fixed overhead: one page costs five requests today and
   would cost one under G. Weight results by the real document-size distribution, which is not
   yet recorded.
8. **Retry cost scales with request size.** A transient failure late in a 64-request session
   resends 0.75–1.5 million characters; a bounded unit caps the retry at one unit.
9. **Single-record association already crosses session boundaries today.** It is not a new risk
   introduced by bounded designs.
10. **Human wait may dominate end-user time for large documents.** At 800 pages with default
    units the job stops for Resume, so C is likely the largest end-user time lever there, with no
    token effect.
11. **Route limits are unrecorded.** Context window, maximum output tokens, tokens- and
    requests-per-minute and the one-CPU proxy bound parallel speedup and unit size. They are
    specific to the configured route.
12. **Real models may batch reads.** The bridge accepts up to 32 tool calls per response, while the
    scripted runs used one. The 2026-09-23 live slice (31 requests for 20 pages) is consistent with
    about one read per response, so the scripted schedule is a fair baseline for that route only.

### Theories and how to eliminate them

Ordered cheapest first. Each names what would refute it, and none requires the full 800-page
live baseline the earlier section already rules out.

| #   | Theory                                                           | Refuting observation                                                                                             | Cost             |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| T1  | Snapshot and receipt residual is most of the input (87–93%)      | Offline rerun with per-field, per-position counters puts residual under ~50%                                     | Offline          |
| T2  | Input size drives request latency                                | Regressing the retained 31 request spans on input, cached and output tokens gives an input slope near zero       | Existing receipt |
| T3  | Output decode floors multi-record time                           | The output-token slope from T2 implies a decode rate at which M800 output takes under an hour                    | Existing receipt |
| T4  | Fixed overhead dominates small documents                         | Offline one- and ten-page receipts show fixed prefix under half of input                                         | Offline          |
| T5  | H saves ~34,000 characters per request with no behavior change   | Offline A/B of the same scripted schedule differs by less                                                        | Offline          |
| T6  | G preserves multi-record extraction                              | Paired fictional M10 run: G recall, precision or duplicates worse than 0 beyond the predeclared margin           | Small live spend |
| T7  | Explicit working state preserves single-record association       | Paired fictional S10 and S200-like fixture with identity on page 1 and findings late: association recall below 0 | Small live spend |
| T8  | Session length has a quality knee below 64                       | Same fixture at `m` = 4, 16 and 64 shows no quality difference, making I a pure token win                        | Small live spend |
| T9  | Parallel speedup is bounded by route limits, not coordination    | Offline scripted provider with injected delays reaches near-W speedup through the one-CPU proxy                  | Offline          |
| T10 | Caching favors long sessions only above a ~46,000-character seed | Paired cache off/on run (the harness's `paired` mode) reports cached share or cost inconsistent with result 9    | Small live spend |
| T11 | Media is a material share of tokens                              | Paired one-page probe with and without the PDF part shows a small input difference                               | Small live spend |

T2, T3 and T4 split the space before any new spend. If input size barely affects latency (T2
refuted), context work is a token and cost measure only, and time work must reduce round trips,
output or human waits. If output dominates (T3 holds), multi-record time can only improve through
parallelism or smaller envelopes. T6 and T7 are the quality gates that would turn the conditional
dominance results into a selection. Predeclare their margins, per the evaluation section above.

This review does not select G, B, H or I. It shows that they are not tradeoffs against the current
design on the two stated objectives, identifies which scenario each serves, and names the
experiment that could reject each.

### Candidate J: processing adapters by source shape

**New.** The math above implies no single strategy wins across all eight scenarios. Small
documents are dominated by fixed overhead, single-record documents by round trips and
association, and dense multi-record documents by output. An adapter layer would choose the
processing strategy per source from properties the host knows **before** model work. Every
adapter would share one contract: exact original retention, the plan/unit ledger, coverage
accounting, reviewable proposals and no automatic acceptance.

Part of this already exists. [`extractionUnits`](../src/server/intake-plan.ts) branches on index
kind (`pdf`, `image`, `html`/`text`, `zip`, `unsupported`), and valid prepared JSONL already
records candidate versions without a model ([intake](../src/server/intake.ts), upload path). What
is missing is a single place that also picks delivery, context policy, parallelism and whether AI
may run at all.

| Adapter               | Selected when (known before model work)                      | Strategy                                                                       |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Deterministic, no AI  | Prepared `health-record-v1` JSONL; future structured exports | Validate and propose directly (exists for JSONL)                               |
| Retain and index only | DICOM and other imaging; unknown binaries                    | Metadata index, inert preview, unchanged download; never sent to AI by default |
| Single-shot           | Whole source fits one request: one image, `N ≤ U_max`        | G with `U = N`: one request, one publication                                   |
| Sequential bounded    | Larger than one request                                      | B or G with explicit working state; optional H                                 |
| Parallel windowed     | Large and output-bound (only if T3 holds and T6 passes)      | F over G, one coordinator                                                      |
| Package               | ZIP                                                          | Dispatch each member to its own adapter under one job ledger                   |

`U_max` follows from results 7 and 8. It is the smallest of the route's context room, the output
cap (`50/ρ` pages at the instructed ceiling) and the 16 MiB media envelope.

Design constraints that would make or break it:

- **Choose how to read, never whether to read.** Text-layer density, file type or page count may
  select a strategy; they must not skip pages. CRS-044's triage prohibition applies unchanged.
- **Record density is unknown in advance.** Page count and format are known upfront. Records per
  page are not. Either start sequential and allow a switch after the first units' observed yield
  (a mid-job strategy change that must keep the ledger consistent), or ask the user. The switch is
  itself an untested mechanism.
- **Key on units, not file extensions.** A JPEG is one image unit, but it can be a photo of two
  pages or a long screenshot. A ZIP of 800 JPEGs is an 800-unit source with no guaranteed page
  order: filename order does not establish adjacency, so single-record association across images
  is weaker than across PDF pages.
- **Each adapter multiplies the qualification matrix.** Every strategy needs its own fixtures and
  gates, so start with the fewest that the arithmetic justifies. Single-shot and sequential cover
  all eight scenarios. Retain-only needs no model qualification. Add parallel only when T3 shows an
  output floor worth breaking.

**DICOM today.** No rule currently routes DICOM, but DICOM pixels cannot reach the model either,
by omission. The magic-byte sniffer does not check the `DICM` preamble at byte 128, so such a file
is typed `application/octet-stream`. Strict UTF-8 decoding then fails, and the evidence index
reports `unsupported` / `unreadable_binary` ([evidence](../src/server/intake-evidence.ts)). A
top-level plan is refused, and a ZIP member becomes an explicit `unsupported` unit. An explicit
retain-and-index adapter would turn that accident into a rule, as CRS-082 already directs: study
and series grouping, bounded non-diagnostic previews and nothing sent to AI by default. CRS-082
considers structured reports separately. Documents encapsulated inside DICOM (for example an
embedded PDF) could later be routed to the PDF adapter after deterministic extraction; that is
an open design question, not a recommendation here.

### Decision readiness

Whether a reader can decide from this document depends on the decision. Every claim above falls
into one of three groups.

**Decidable now, from existing evidence and arithmetic:**

- Abandon any design that relies on one growing conversation (result 1).
- Unattended continuation (C) is the required direction under CRS-039; its UX and optional
  operator limits remain open.
- Splitting, bisection and parallel workers are excluded for sources that fit one request
  (result 8).
- The default two-page schedule cannot complete 800 pages in one allowance (measured). Its fixed
  overhead nearly consumes the token allowance on its own (result 3).
- Candidate order for experiments, since the dominance results rank candidates conditionally on
  quality.

**Verifiable before building anything that ships.** These take offline runs, configuration
reads, existing receipts or small fictional probes:

- **Targets, the largest gap.** The document ranks candidates but states no acceptable wait or
  token spend per source size. Without targets a reader can say what is better, not what is good
  enough, and cannot tell whether a candidate is needed at all. Suggested form, values for the
  owner to set:

  | Size class            | Acceptable time to reviewable results | Acceptable tokens (or cost) |
  | --------------------- | ------------------------------------- | --------------------------- |
  | Single image / 1 page | _to decide_                           | _to decide_                 |
  | Up to ~10 pages       | _to decide_                           | _to decide_                 |
  | ~200 pages            | _to decide_                           | _to decide_                 |
  | ~800 pages            | _to decide_                           | _to decide_                 |

- **Workload mix.** The real distribution of source sizes and types, which decides whether small
  documents or large ones should drive the choice (missed assumption 7). Counts of plan sizes are
  enough; no clinical content is needed.
- **Route limits.** Context window, maximum output tokens, tokens- and requests-per-minute,
  `cache_control` acceptance and a characters-per-token measurement on the configured route
  (missed assumption 11). These are configuration reads and one fictional probe. The 4.30
  characters-per-token threshold in result 3 makes the last one decisive.
- **Latency decomposition.** T2 and T3 from the retained 2026-09-23 receipt. They decide whether
  context work saves time or only tokens, and whether multi-record output needs parallelism.
- **Residual attribution and hygiene savings.** T1, T4, T5 and T9, all offline with the existing
  harness.

**Knowable only after implementing at least a prototype:**

- **Extraction quality under a new strategy** (T6, T7, T8). Whether host-pushed units, explicit
  working state or shorter sessions preserve records and cross-page associations is model
  behavior. It can be measured only by running a real model against a working prototype. A
  throwaway prototype on fictional fixtures is enough to decide; production code is not.
- **Model behavior the prototype changes.** Examples: whether the model asks for rereads when the
  host pushes pages, how it uses a working state, and how reliably it finds boundaries (D, E).
  Scripted runs cannot answer these.
- **Achieved cache share under the rewritten prefix** (T10). It depends on the route's cache
  behavior with the real byte sequence.
- **Parallel contention in the deployed stack.** Offline delay injection bounds it; only the
  deployment shows it.
- **Quality on real charts.** Fixtures are fictional by policy, so real-document quality is never
  proved in advance; it can only be sampled after release through review outcomes. That remains a
  standing limit of any choice, including keeping the current design.

**Net reading:** a reader can decide now what to stop pursuing and what to test next. A reader
cannot yet choose which scheduler to ship: that needs the owner's targets, the cheap
verifications above, and one prototype comparison (T6/T7) that no amount of analysis replaces.
The smallest path to a shipping decision is to set targets, run T1–T5 and T9 offline, read the
route limits, then prototype G with a working state against the current design on paired
fictional S10, M10 and S200-like fixtures.

## Goals, unattended operation and deduplication

Third-pass review dated 2026-09-24, from a design discussion with the owner. Status: analysis and
proposals; no behavior changed. Values marked _proposed_ are suggestions awaiting the owner's
decision. Earlier sections stay as written. Where this section revises a framing above, it says so.

### Ranked goals

Earlier sections treated tokens and wall time as co-equal objectives. The owner's clarification
reorders them. Large imports run while the person is away, so hours of processing are human time
("upload and come back later"), not a cost worth trading accuracy or tokens for.

1. **Accuracy and evidence integrity.** No silent loss: every page is accounted for or explicitly
   flagged, every record carries original provenance, nothing is accepted without review.
2. **Token efficiency.** Measured as an overhead ratio (below), so it means the same thing at any
   size and on metered or subscription routes.
3. **Unattended completion.** No routine human interaction between upload and review.
4. **Wall time, as constraints rather than an objective.** Small deltas stay interactive; backfills
   finish within an overnight window.

The consequence for the candidates: result 6 puts the worst serial output floor (M800) at
2.9–5.8 hours, inside an overnight window. Parallel workers (E, F) buy only time, so they drop out
of the first iteration unless measurement shows the overnight constraint is missed. They are kept,
not withdrawn.

### SLA and SLO

| Kind | Commitment                                                                    | _Proposed_ value                         |
| ---- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| SLA  | No silent loss: pages are covered, parked with a reason, or refused           | Always                                   |
| SLA  | Unattended completion: no human action for allowances, outages or rate limits | Always                                   |
| SLA  | Token cost ceiling per page                                                   | Owner to set from route pricing or quota |
| SLO  | Token overhead ratio (below)                                                  | ≤ 3×                                     |
| SLO  | Small delta (1–10 pages): first reviewable record                             | ≤ 2 minutes                              |
| SLO  | Backfill (200–800 pages): finished                                            | ≤ 8 hours in ≥ 95% of runs               |
| SLO  | Parked units after automatic remedies                                         | Owner to set                             |

The time rows and the token-ceiling row are superseded by the
[owner decisions](#owner-decisions-and-corrections) below; the table is kept as the record of the
earlier proposal.

**Overhead ratio** = total tokens ÷ (tokens to show every page once + record output tokens). The
denominator is the unavoidable floor; the ratio measures everything else. Under the calculator's
assumptions the current 800-page default sits two orders of magnitude above 3×, while G is within
single digits. Both figures are _model_ estimates.

**System limits set floors, not targets.** For any design,

    wall time ≥ max( total tokens / route tokens-per-minute,
                     output tokens / (workers × decode rate),
                     sequential requests × time per request )

A target below that floor is unreachable on the route; a target far above it is slack.

### Workload modes

The real size distribution is unknown. The owner expects three modes rather than one mix:

- **Backfill.** A few 800–900-page exports from earlier providers, imported once. Total tokens
  and unattended completion dominate.
- **Deltas.** Frequent small uploads after a visit. Time to first reviewable record dominates.
  Likely the most common by count.
- **Re-exports.** A full dataset requested to obtain one new period, because providers rarely
  export by date. Mostly duplicates of an earlier import; probably the largest avoidable cost.
  See [deduplication strategies](#deduplication-strategies-and-caveats).

This replaces "document mix unknown" (missed assumption 7) as the planning basis. Counts of plan
sizes from real use would still confirm it.

### Revised framing: isolation versus context

This revises the tokens-versus-time framing in the dominance review. Once work is isolated per
unit, parallelism costs little extra in tokens (one prefix per worker plus seam context). The
real tradeoff is **isolation versus context**: isolated units are cheap and parallel, while
carried context (overlap, working state, a long session) is what preserves cross-page
associations.

Parallelism's losses are not mainly tokens:

- **Quota burn rate.** The configured route is a ChatGPT-login route, so the binding limit is
  likely a subscription usage window rather than per-token billing. The same tokens spent faster
  can exhaust the window and block the person's other use.
- **Runaway speed.** A looping defect spends `W` times faster before any check notices.
- **Local resources, minor.** Processing is IO-bound, correcting the earlier emphasis. The live
  slice spent 923.9 of 931.2 seconds in provider-request spans with a median app CPU sample of
  3.24% ([import performance](import-performance.md#observed-provider-slice-on-2026-09-23)). The
  offline 800-page run spent about 0.34 seconds of host work per request with instant replies,
  against roughly 30 seconds per live request. CPU bursts come from PNG rasterization and from
  serializing multi-megabyte bodies, which the one-CPU LiteLLM proxy re-parses in Python
  ([Compose](../compose.yaml) sets `LITELLM_CPUS` default 1, app `HEALTH_CPUS` default 2). These
  matter only at high worker counts (T9).

The knobs, each scalable in both directions:

| Knob            | Turned up                           | Turned down                         |
| --------------- | ----------------------------------- | ----------------------------------- |
| Workers `W`     | Less wall time                      | Slower quota burn, safer runaway    |
| Unit size `U`   | Fewer requests, less fixed overhead | Smaller outputs, narrower attention |
| Carried context | Better cross-page association       | Fewer tokens, more parallelism      |
| Model per stage | Higher quality                      | Lower cost and latency              |

### Unattended operation

**Current behavior, verified in code:**

- Only HTTP 503 `transient_availability` responses are retried, twice, after one and two seconds
  ([bridge](../src/server/proxy-model-bridge.ts), transient retry loop). `Retry-After` is not read.
- HTTP 429 is not retried. It fails the request as "LiteLLM Proxy rate limit reached. Retry
  later." The batch runner then pauses the **whole batch** as `model_unavailable`
  ([batch runner](../src/server/intake-batches.ts), slice completion). An overnight rate limit
  therefore produces a morning "paused" state with no input required.
- The whole-job allowance pauses at `job_limit`, as described earlier.
- Automatic slice continuation requires progress. A slice without progress ends the item.
- No per-unit attempt limit or per-unit failure isolation was found in the reading path: the model
  drives the whole document, so a unit it cannot finish affects the job rather than being parked.
- No concurrency limit is configured anywhere, and none is needed today. Each conversion is
  sequential, the batch runner processes one item at a time, and each profile allows one running
  batch. The example LiteLLM configurations set no rate or parallelism limits.

**Proposed retry and failure-isolation design:**

| Class        | Examples                                                  | Response                                                                      | Human?                    |
| ------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------- |
| Transient    | 503, short 429, network error, timeout                    | Exponential backoff with full jitter, honoring `Retry-After`, capped per wait | No                        |
| Quota window | 429 with a long `Retry-After` or a usage-cap message      | Sleep until the reset, then continue                                          | No                        |
| Content      | PDF rejected, page will not decode, schema-invalid output | Per-unit remedy escalation (below)                                            | Only if all remedies fail |
| Permanent    | 400 invalid request, 401/403, 404 model                   | Stop the job with an actionable reason                                        | Yes                       |
| Route down   | Transient failures continuing past the backoff horizon    | Pause the job, probe on a schedule, resume on success                         | Only after a deadline     |

- **Per-unit remedy escalation.** Retry the same request; then the verified PNG fallback or split
  the unit to single pages; then **park** the unit with its reason and continue with the rest.
  Parked is a new host-assigned state. It is distinct from the model's `unreadable` disposition and
  does not count as accounted coverage.
- **Loop closure.** Park a unit when it is attempted `K` times without new coverage, when the model
  repeats identical tool calls, or when its tokens exceed a multiple of the job's median per-unit
  spend. These replace fixed whole-job allowances with checks of actual behavior; productive work
  never trips them.
- **Runaway guard, not an allowance.** One job ceiling remains, set as a multiple (_proposed_ 3×) of
  the projected cost for this source's size. Normal runs never reach it. This is compatible with
  earlier idea 8: it is not an upfront budget that interrupts productive work.
- **Adaptive concurrency, if workers are ever used.** Halve `W` on a 429 and add one after a run of
  successes, capped by configuration. The route's own limits then choose the scale.
- **Stop and lock.** Stop cancels pending and delayed retries. Lock stops private work, as before.

**Terminal state and human touchpoints.** A job ends **finished** or **finished with exceptions**,
never paused with doable work remaining. The morning view lists what completed and each parked
unit with actions, for example: "798 of 800 pages processed. Page 12 never decoded: Retry · View
original · Mark unreadable." A human is involved only for:

1. Reviewing and accepting proposals (always, by design).
2. Parked units after automatic remedies.
3. Compacted questions (below), answered after the run rather than blocking it.
4. Conditions only a person can fix: authentication, a locked profile, a changed source, a tripped
   runaway guard.

A human is never needed to renew an allowance, outlast an outage or wait out a rate limit.

### Question compaction

Questions must be recorded and deferred, **and** compacted. A person named "Baylee Schmeisser" whose
900-page chart prints "Baylee F Schmeisser" on every report should face one decision, not hundreds.

Current contract: identity confirmation receipts are exact per original, report group and printed
subject ([INTAKE.md](../src/server/INTAKE.md#common-report-identity-review)). Compatible additions
within a group inherit an existing confirmation, but a different report group needs its own. A
long chart with many report groups can therefore produce one confirmation per report group whose
printed subject differs from the Self record. The actual count for a real 900-page chart is
unmeasured.

Proposed direction, preserving the exact-target rule:

- **Group questions by answer, not by occurrence.** "'Baylee F Schmeisser', date of birth matching,
  appears as the subject of 312 reports in this original. Is this you?" One action creates one
  receipt that **enumerates every covered report group**. It remains exact and is never broadened
  later; a new original or a changed subject asks again.
- **Apply the same grouping to model ambiguity questions** (`health_intake_question`): cluster
  equivalent questions and show counts with examples.
- **Open decision: a durable name-variant alias.** "This spelling is me" as a reusable identity rule
  would reduce questions across future originals too. Current policy deliberately gives no
  individual decision identity authority over other incoming records, so an alias is a policy
  change, not an optimization. It is not recommended here without the owner's decision.

### Candidate K: page read, then compaction

**New,** from the owner. Stage one reads each page in isolation and returns compact, located
content. Stage two combines a few pages' stage-one output, for example three pages, into records
plus an explicit "incomplete" carry that feeds the next step. The pipeline becomes text layer or
visual read → AI page read → AI compaction.

- There is **no OCR engine** in the application. Text comes from the PDF text layer, and scanned
  pages have none, so the model's visual read is the OCR ([INTAKE.md](../src/server/INTAKE.md)
  states search and follow perform no OCR). Pages with a usable text layer could skip stage one and
  pass their text straight to stage two, a per-page adapter choice.
- **Strengths.** Stage one is fully isolated, which is where parallelism is genuinely cheap. Its
  output can be cached by fingerprint and reused across re-exports. Stage two works on compact text,
  and its carry is the bounded working state of A and G; result 9 says to keep it well under
  ~46,000 characters.
- **Costs.** Stage-one output is output tokens, which are slower and usually priced higher. A full
  transcription roughly doubles output, so stage one should emit compact facts with locators, not a
  transcript. Stage two sees an interpretation rather than the evidence. Records must therefore cite
  original page and block locators, and review remains against the original, since summaries are
  never evidence.
- **Tests.** T16 measures stage-one output size per page; T7's association fixture applies to stage
  two unchanged.

**Push the predictable, pull the exceptional.** The model can already pull: reread any page, search
and follow the plan, query and read accepted records (`health_query`, `health_read`), and ask the
person (`health_intake_question`). Stage two could check accepted records before proposing a
duplicate, which helps re-exports. Every pull is a round trip, though, and today's high request
count comes from the model pulling every page. The host should push what the plan already knows.

### Candidate J revised: code enforces, the model chooses

This refines candidate J. Parallel processing is composition: split, per-unit adapter, merge. The
owner asked whether the model should choose strategies rather than codifying them. It already
partly does: it chooses `unitSize` (1–50) when creating a plan, and the offline runs show how much
that single choice matters.

_Proposed_ hybrid:

- **Code owns invariants and facts.** Never send DICOM or unknown binaries to AI; never skip pages
  without an explicit user decision; enforce worker, retry and runaway caps. File type, page count
  and text-layer presence are free and reliable in code.
- **Code lists the allowed strategies; the model picks.** One small planning request receives the
  file list, page counts, per-page text-layer sizes and each page's first lines, and chooses among
  qualified strategies, possibly proposing report boundaries.
- **Why not unconstrained model choice.** A model-chosen strategy varies between runs and cannot be
  qualified in advance. Every selectable strategy must already be a qualified one.

**Images the text layer cannot read already go to AI.** PNG, JPEG and WEBP are image units read
visually, and scanned PDF pages are sent as PDF or PNG. **Gap found:** the upload sniffer recognizes
only PDF, PNG, JPEG, WEBP, ZIP and JSON/JSONL by content or name ([intake](../src/server/intake.ts),
`mime`). HEIC (the iPhone camera default) and TIFF (common for faxes and scans) become
`application/octet-stream` and reach no model, although a model could read them. DICOM also lands
there and should stay out of AI, but by explicit rule rather than by accident.

### Deduplication strategies and caveats

Policy for every strategy: **fail open**. A fingerprint may order work (new content first) or
propose "these spans match an earlier import; skip them?" with samples for the person to check.
It may never skip silently. A person-confirmed skip is an open decision under CRS-044. It differs
from density triage because its evidence is prior processing of matching content from a retained
original, not a guess that a page is empty.

| Level | Strategy                               | Exists? | Survives re-rendering? | Main caveat                  |
| ----- | -------------------------------------- | ------- | ---------------------- | ---------------------------- |
| D0    | Whole-file SHA-256                     | Yes     | No                     | Any byte change defeats it   |
| D1    | Normalized page-text hash              | No      | No                     | Page breaks move             |
| D2    | Shingles with winnowing                | No      | Mostly                 | Reading order, boilerplate   |
| D3    | Structural anchors (encounter headers) | No      | Yes                    | Formats vary by provider     |
| D4    | Date cutoff                            | No      | Yes                    | Date roles are semantic      |
| D5    | Perceptual image hash (scans)          | No      | Weakly                 | Resolution, crop, re-scan    |
| D6    | Record-level keys                      | Partly  | Yes                    | Exists only after extraction |

**D0: whole-file hash, exists.** Uploads are hashed and a byte-identical re-upload is recognized
as `repeatedUpload` without a new intake ([intake](../src/server/intake.ts), upload path). ZIP
inventories mark byte-identical members `duplicateOf`, and byte reuse never establishes clinical
identity. Shortcomings: a fresh export differs in bytes even when the content is identical, because
of export timestamps, metadata, ordering or renderer. So D0 catches only literal re-uploads, and a
re-export is fully reprocessed today.

**D1: normalized page-text hash.** Hash each page's text layer after removing running headers and
footers ("Printed 09/24/2026, Page 12 of 800") and collapsing whitespace. It is cheap, but it
breaks whenever fonts, margins or page size move page breaks. Useful only for same-renderer copies.

**D2: shingling with winnowing, the pagination-independent "subset fingerprint."**

- Join the whole document's normalized text into one word stream, removing page breaks and running
  headers and footers. Normalize Unicode (NFKC), case and whitespace, but **keep digits and decimal
  points**: "5.4" and "5.7" must never match.
- **Shingles overlap by construction.** Hash every run of `k` consecutive words, starting at every
  position. A 10-word stream with `k = 3` yields exactly eight shingles: words 1–3, 2–4, …, 8–10.
  Overlap prevents arbitrary cut-offs, because a match is found wherever it starts.
- **Winnowing thins them without losing the guarantee.** Slide a window over `w` consecutive shingle
  hashes and keep the minimum in each window. Any shared passage of at least `t = w + k − 1` words is
  guaranteed a common fingerprint, nothing shorter than `k` words can match, and roughly
  `2/(w + 1)` of shingles are kept. This is the standard document-fingerprinting method (Schleimer,
  Wilkerson and Aiken, 2003).
- _Proposed_ starting values: `k` of 8–12 words and `w` of 4–8, so `t` is 11–19 words. Shorter `k`
  matches boilerplate everywhere. Discount fingerprints that recur across many unrelated spans
  (legends, disclaimers, reference-range notes), as plagiarism detectors ignore common code.
- Output: span maps ("new pages 40–97 match old pages 38–95") with a similarity score, independent
  of page numbers.
- Caveats: renderers can emit multi-column layouts and tables in different reading orders, which
  breaks shingles; section reordering is tolerated, because matching is by span. D2 needs a text
  layer.

**D3: structural anchors.** Encounter and report headers such as "07/27/2020 - admission
(discharged) in OHSU 4A (continued)" can be found with patterns in the text layer, without AI. They
yield keys like (date, encounter type, location). They segment a document into encounters, which
D2 spans and D4 cutoffs can then attach to. Header formats vary by provider, so patterns are
per-source heuristics, and "(continued)" markers must join rather than duplicate segments.

**D4: date cutoff.** A person-selected rule such as "only reports on or after 2025-01-01."

- **It is not an OCR problem for text-layer PDFs.** The text is already extracted; OCR is needed
  only for scans. The hard part is **date roles**: print or export date, visit, admission and
  discharge, specimen collection, result, signature, addendum, and prior-study dates quoted in a
  comparison.
- Cheap signals: a date repeated at the same position on every page is a running header or footer,
  almost always a print date. Label proximity ("Printed", "Collected", "Visit", "Admit",
  "Resulted", "Prior") classifies many others. A small planning request can classify the rest.
- **Several records with different dates on one page** require segmentation below the page:
  block or region locators, the same requirement earlier idea 5 records for ownership.
- **A cutoff selects reports or encounters, never individual values.** The DEXA case is the
  required test. A new scan's report compares against prior results and quotes old values. The
  report's date is new, so it is kept whole, including its comparison table. Extraction must then
  distinguish a quoted prior value from the original measurement: equal values can still be
  distinct evidence ([related-record discovery](import-reconciliation.md#related-record-discovery-and-exact-pair-review)).
- Addenda and corrected results dated after the cutoff attach to earlier reports. Late results
  have a collection date before a result date. The rule must name which date governs; _proposed_:
  the report or encounter date, with later addenda and corrections always included.
- Undetermined dates fail open: process.

**D5: perceptual image hash.** The only fingerprint for pages without text. It tolerates
compression, not reflow, re-scan skew or different crops. Treat it as an ordering hint only; scans
are processed.

**D6: record-level keys.** Date, test, value and unit identify duplicates finally, but only after
extraction. The existing related-record cue matches literal value, unit and known date **within the
same retained original** only, and it is a review link rather than a merge. A re-export is a
different original, so the cue does not reach across it. A cross-original cue for re-exports, still
never an automatic merge, is a gap.

**How they compose.** D0 at upload; D3 and D4 segment and filter by date where the person chose a
cutoff; D2 maps remaining spans against earlier originals; D5 hints for scans; D6 flags duplicates
among whatever is extracted. The cheapest evaluation in this proposal is D1 to D4: text layer only,
offline, no provider spend (T12, T13).

### Additional theories

Continuing the elimination table above.

| #   | Theory                                                                      | Refuting observation                                                                                                                                                                  | Cost             |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| T12 | D2 matches re-rendered spans reliably                                       | Fictional fixtures re-rendered with other fonts, margins, pagination, headers and footers, reordered sections and an added year show span recall or precision below a predeclared bar | Offline          |
| T13 | Date roles can be classified cheaply for cutoffs                            | Pattern and label heuristics misclassify print, visit and prior-comparison dates on fixtures, including a DEXA-style comparison                                                       | Offline          |
| T14 | Grouped questions reduce identity prompts to about one per subject spelling | A fictional multi-report chart with a variant name still yields one prompt per report group after grouping                                                                            | Offline          |
| T15 | The retry design completes unattended through faults                        | Scripted fault injection (503 bursts, 429 with `Retry-After`, a quota window, one undecodable page) leaves the job paused or parks more than the injected page                        | Offline          |
| T16 | Stage-one compact output stays small per page                               | Stage-one output exceeds a set fraction of page text on dense fixtures, erasing K's saving                                                                                            | Small live spend |

### Open decisions for the owner

Superseded by the [open-issues register](#open-issues-register); kept as history.

1. Time windows: _proposed_ ≤ 2 minutes to a first record for deltas, ≤ 8 hours for backfills.
2. Token SLA: a per-page ceiling, which depends on the route's pricing or quota window.
3. Whether a person-confirmed skip of matched spans or pre-cutoff reports is acceptable under
   CRS-044.
4. The date that governs a cutoff: _proposed_ report or encounter date, with addenda and corrections
   always included.
5. Whether to allow a durable name-variant identity alias, or only per-original grouped receipts.
6. The runaway guard multiple (_proposed_ 3× projected cost), the attempts `K` before parking, and an
   acceptable parked-unit rate.
7. Whether HEIC and TIFF should become supported image inputs, and whether DICOM gets an explicit
   retain-and-index rule (CRS-082).
8. Which of G, B, H, I and K to prototype first. This review suggests H (no behavior risk) and G
   with a working state, compared with the current design on paired fictional fixtures.

## Review protocol for later passes

This proposal is refined by successive reviewers, human and agent, before any design is chosen.
The owner intends several independent agents to critique and extend it, then to select a design
only when they agree. To keep the document usable for that, every pass follows these rules:

1. **Append, never delete.** Add a dated section. Withdraw or qualify an earlier claim by saying
   so in the new section, or with a short forward pointer at the old claim. Never remove it.
2. **Label every quantitative claim** as _measured_ (with its receipt), _model_ (with its formula
   and parameters) or _unknown_. Code facts cite a file.
3. **Use the existing identifiers.** Candidates continue the letter sequence (next: L), theories
   and experiments continue the T numbers (next: T17), open decisions stay in the latest list.
4. **Record disagreement explicitly.** A reviewer who disputes an earlier conclusion adds a
   "Disputed" entry naming the claim, the argument and the experiment that would settle it.
5. **No selection without the experiments.** A pass may recommend; selection waits for the
   experiments in the registry below that the chosen candidate depends on.
6. **Fictional data only.** No real records, names, paths or credentials, per repository policy.

## Owner decisions and corrections

Fourth pass dated 2026-09-24, recording the owner's answers to the open decisions above.
Where they revise the third pass, this section governs.

### Wall time is observed, not targeted

The proposed time windows are withdrawn. Once the pipeline is unattended and backs off correctly,
the difference between, say, eight and ten hours is mostly the model's speed and the route's
limits, which the code does not control. What the code does control:

- **Sequential requests per page.** A one-page upload costs five requests today and one under G,
  so the code's share of a small upload's wait is real and measurable.
- **Input size per request,** if T2 shows prefill affects latency.
- **Output size,** through record-envelope verbosity.
- **Human waits,** which the unattended design sets to zero.
- **Parallelism,** now deprioritized.

Replacement measures, all code-controlled: **requests per page**, the **overhead ratio**, and
**human interventions per job** (target zero, apart from review and genuine exceptions). Model and
provider time stays in diagnostics as an observation, not a commitment. Small uploads still benefit
most from fewer requests, but no minute target is set.

### No per-page token ceiling

The proposed token SLA is withdrawn. Refusing to import a family's records because a budget ran out
is not acceptable for home use. Token efficiency remains goal 2, measured by the overhead ratio.

The runaway guard stays, but as a **fault detector, not a budget**. When it trips, the job pauses
with an explanation and a choice, for example: "This import has used about three times what a
document this size normally needs, which may mean something is stuck. Continue · View progress ·
Stop." A subscription quota window is handled by waiting for its reset, never by refusing. A
metered API key may justify an optional spending cap chosen by the operator. That remains the
optional control described in earlier idea 8, off by default.

### Guard values are arbitrary starting points

Accepted: runaway guard at 3× projected cost, park a unit after `K = 3` failed attempts, and
record the parked-unit rate without a target. **These values are arbitrary.** 3× leaves room for
real variation (dense pages, rereads, a retried unit) while still catching a loop long before it
costs an order of magnitude more. Three attempts matches the remedy ladder: retry, fallback or
split, then park. No measurement supports either number yet. Revise both once real runs record
per-job cost relative to projection, and per-unit attempts before success.

### Known names already exist on the profile

The Self record already stores `knownNames`, up to 32 names, documented as explicit human
assertions and never inferred from imports ([self identity](../src/shared/self-identity.ts)).
Identity review already uses them ([identity policy](../src/server/intake-identity-policy.ts)):

- An exact match (after Unicode, whitespace and case normalization) against the Self name or any
  known name yields `evidenced_match`, which does not block.
- "Baylee F Schmeisser" against a saved "Baylee Schmeisser" is only a _possible_ name. It yields
  `confirmation_required`, and the prompt tells the person to add another known name in Self only
  if they have used it.

So the owner's alias array is the existing mechanism. Adding the printed spelling to `knownNames`
makes later reports with that exact spelling non-blocking, in this file and in future files.
Because the person makes the assertion explicitly, this stays within current policy. The earlier
"durable alias" open decision is therefore resolved: it is not a policy change.

**Gap** (now requirement R3, [CRS-090](application-todo.md#crs-090)): as far as this review can see, the confirmation action offers only to fill blank Self
fields. Adding a known name is a separate edit in Self. _Proposed_: offer "Yes, this is me, and
remember this spelling" in the confirmation itself. Grouped per-file confirmations are still
useful for spellings the person does not want to save.

**Caveat:** an exact name match alone, without a birth date, is enough for `evidenced_match`.
Families can share names across generations (a "Jr." whose suffix a record omits), so a saved
spelling can admit a relative's report. That is existing behavior, noted because remembered
spellings make it more frequent.

### Accept every format; decide processing separately

Every upload is already accepted and its original retained. Unknown types are stored as
`application/octet-stream`, and only planning refuses them: "This format has no resumable
text/page index yet. Originals remain available." The owner's rule: **accept anything**, because
providers hand out unusual formats, and make the rules about **how** a file is processed.

_Proposed_ processing choice, shown only when the app has no default for the type. Wording for a
non-technical person, with the technical meaning in parentheses:

| Option shown to the person                          | Technical meaning                                          |
| --------------------------------------------------- | ---------------------------------------------------------- |
| "Just keep this file"                               | Retain and index only; never sent to AI                    |
| "Find the words in it"                              | Text extraction (text layer, or local OCR if added); no AI |
| "Read it and pull out health information (uses AI)" | Extraction plus AI reading, then reviewable proposals      |

- Known types get defaults without asking. JSONL goes to deterministic import, PDF and images to
  AI reading, DICOM to "just keep" (per CRS-082).
- HEIC and TIFF, including multi-page TIFF, should become supported images, converted to page
  images for reading.
- **There is no OCR engine today.** "Find the words" for an image or scan would need a local OCR
  component, which is new work. Until then that option exists only where a text layer exists.
- The choice must be revisitable: a kept file can be processed later, and the choice never deletes
  or alters the original.

### Pending: what "confirmed skip" means

Deduplication (D2) and date cutoffs (D4) can identify pages that probably need no processing. The
open question is whether the person may tell the app not to send those pages to the model.

**The existing rule.** CRS-044 withholds page triage: the app may not skip pages on its own
judgment, such as "this page has little text, so it is probably administrative." A skipped page
that did contain a record would be lost silently.

**The question.** A different kind of skip: the app says "780 of these 800 pages match what you
imported in March. Skip them?" or "Only import reports from 2025 onward?", and the person agrees.
The person decides, not the app, and the evidence is a previous import rather than a guess.
Should that be allowed?

- **Never skip, only reorder.** Process new-looking content first, but still process everything.
  Safe; saves no tokens.
- **Person-confirmed skip.** Skipped pages are marked "skipped by your choice", stay visible, and
  can be processed later with one action. Large token savings on re-exports. Risk: a fingerprint or
  date false positive hides a genuinely new record, such as a corrected value inside a matched span,
  until someone processes it.
- **Automatic skip.** Not recommended; this is the triage CRS-044 withholds.

## Necessary experiments

Briefs, task IDs and results now live in [processing experiments](processing-experiments.md); see
[experiments are now tasks](#experiments-are-now-tasks).

The [follow-up experiment proposal](processing-follow-up-experiments.md) uses the completed
two-page Resume comparison and the OCR/fingerprint failures to propose the next tests. It
distinguishes unit-size arithmetic from live extraction quality and preserves the original
results and criteria; its designs have not run and do not change task approvals.

Execution update, 2026-09-25: the owner subsequently authorized these follow-ups.
[F1's completed sweep](processing-follow-up-experiments.md#f1-results--completed-unit-size-sweep)
is independently verified: at 800 pages U15/U20 reduce serialized text by 15.261%/18.120%
versus U10, with complete coverage and later first proposals. At 200 pages their gains are
4.981%/7.570%. F4/F5's separately frozen extensions pass their new unchanged-text matching
corpora, while broad segmentation and historical within-encounter columns remain failures.
Those results and independent verifications are appended in the follow-up document; F2 live
quality and the OCR/integration follow-ups are still in progress. No production default,
automatic skip or acceptance gate changes.

The independently verified F7 identity follow-up subsequently repaired both old layout misses.
Its first larger cohort contained duplicate PDFs and did not qualify after deduplication. A
separately reserved 240-source holdout, with no duplicate bytes, detected 90/100 wrong-DOB
files and made zero false stops on 100 correct and 40 unknown files; ambiguous mixed-role
cases still abstain. This is a bounded text-layer result, not production identity validation;
see the preserved [F7 recordings](processing-follow-up-experiments.md#f7-results--preserved-primary-cohort-and-corpus-correction).

F3's independently checked development results select deskew alone: CER 1.016% and maximum
CPU 4.83 seconds/page. Its five historical pages above 3% CER and twelve unrecovered exact
negation-clause occurrences remain recorded; lower-error combined preprocessing exceeds the
development CPU target. Held-out timing/quality and F6 integration remain unfinished; see
[F3's interim results](processing-follow-up-experiments.md#f3-results--completed-development-and-regression-measurements)
and the [current execution snapshot](processing-follow-up-experiments.md#execution-status--2026-09-25-update).

Subsequent F3 held-out execution and independent verification are complete: deskew reaches
3.025% CER, while combined geometry/order repair reaches 0.673% but exceeds five CPU seconds
on 170/180 cold and 153/180 warm runs. No arm meets every original criterion. Four introduced
annotation errors change `values` to `velues`; earlier exact negation-sentence failures retain
their negation wording and do not establish polarity reversal. The
[full F3 verification](processing-follow-up-experiments.md#independent-verification--completed-f3-held-out-matrix)
and [complete strata](processing-ocr-follow-up-strata.md) preserve those distinctions. F6 proceeds
as the separately declared diagnostic extension, not as adoption of a qualified OCR component.

F6's full diagnostic matrix is now independently verified and fails its original gates:
native unchanged recall is 80%; the experimental image index is usable on 4/20 held-out
documents, with 12 strict correction-recovery failures among 16 accepted indexes despite
literal critical fields surviving. See the [complete F6 verification](processing-follow-up-experiments.md#independent-verification--complete-f6-diagnostic-matrix).
F2's first U15 cell completed with 160/160 literal matches and 3,152,735 tokens; its U20 cell
was externally interrupted with unknown failed-request usage. The remaining 116 cells and
finalization diagnostic remain unexecuted, so overall execution approval is withheld. See the
[current execution status](processing-follow-up-experiments.md#execution-status--verified-offline-completion-and-unresolved-live-accounting).

The owner subsequently approved the documented one-request accounting exception. After
independent implementation review and a preserved CLI-startup correction, the same U20 run
has resumed successfully. Its missing cost remains unknown; the approximately 27,500-token
input reconstruction is an estimate, not recovered usage. The remaining matrix, finalization
diagnostic and final execution review are still pending; see the
[resumed execution status](processing-follow-up-experiments.md#execution-status--live-continuation-resumed).

The U20 supplemental outcome is now independently verified: 160/160 literal records recovered,
42 reads covering all 40 pages, 3,502,207 known tokens and 47.075 minutes of active processing.
It still ends at `time_limit`, with unresolved original usage and unconfirmed identities.
The original primary result remains intact; the next planned cell is running. See the
[U20 verification](processing-follow-up-experiments.md#independent-verification--preserved-u20-supplemental-outcome).

The experiments that must run before a design is selected. Each is a throwaway proof of concept
or an analysis of existing data, not production code. Any of them can fail, and a failure is
informative: it removes or reshapes a candidate. IDs match the theory tables above; methods are
technical starting points for whoever runs them.

| ID  | Question                                            | Method                                                                                                                                                                                                          | Kind             | Decides                            |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------- |
| T1  | Where does current input go?                        | Extend the controlled harness to count serialized characters per field and per position (exact versus compacted) for each request; rerun 200 pages at U=2 and U=10                                              | Offline          | Whether B's target is right        |
| T2  | Does input size drive latency?                      | Regress the 31 request durations in the 2026-09-23 receipt on input, cached and output tokens; report slopes with intervals                                                                                     | Existing data    | Whether context work saves time    |
| T3  | Is there an output floor?                           | Same regression's output slope gives an implied decode rate; apply it to M200 and M800 output                                                                                                                   | Existing data    | Whether parallelism is ever needed |
| T4  | Does fixed overhead dominate small documents?       | Harness receipts for 1- and 10-page fixtures, split into system, tools, schema, seed, evidence and residual                                                                                                     | Offline          | Priority of H and G for deltas     |
| T5  | What does H save?                                   | Same scripted schedule with the schema moved to the system prefix and conversion-only tools; compare per-request characters                                                                                     | Offline          | H's value                          |
| T9  | Where does parallel contention start?               | Scripted provider with injected delays through the Compose stack; step workers 1–8 and record throughput and proxy CPU                                                                                          | Offline          | Worker cap, if F is revived        |
| T12 | Does winnowing survive re-rendering?                | Generate fictional charts, re-render with other fonts, margins, page sizes, headers and footers, reordered sections and an added year; measure span-match precision and recall for D1 and D2 across `k` and `w` | Offline          | Whether D2 is viable               |
| T13 | Can date roles be classified cheaply?               | Label dates in the same fixtures (print, visit, collection, result, prior comparison, including a DEXA-style comparison); score pattern and label heuristics                                                    | Offline          | Whether D4 needs AI                |
| T14 | Do grouped questions and known names cut prompts?   | Fictional multi-report chart with a variant name; count identity prompts before and after grouping and after one remembered spelling                                                                            | Offline          | Question-compaction design         |
| T15 | Does the retry design finish unattended?            | Scripted faults: 503 bursts, 429 with `Retry-After`, a quota window, one undecodable page; check the job ends "finished with exceptions" with only that page parked                                             | Offline          | Unattended-operation design        |
| T6  | Does G keep multi-record extraction?                | Paired fictional M10 runs, current versus G; recall, precision, duplicates and provenance against a literal oracle; predeclared margins                                                                         | Small live spend | G for multi-record                 |
| T7  | Does working state keep single-record associations? | Paired fictional S10 and S200-like fixtures with identity early and findings late; association recall                                                                                                           | Small live spend | A, B, G, K for single-record       |
| T8  | Is there a session-length quality knee?             | T7's fixture at `m` = 4, 16, 64                                                                                                                                                                                 | Small live spend | I                                  |
| T10 | Does caching change the break-even?                 | The harness's paired cache mode on the route, recording cached share                                                                                                                                            | Small live spend | Session length with caching        |
| T11 | Are media tokens material?                          | Paired one-page probe with and without the PDF part                                                                                                                                                             | Small live spend | Media policy, G's exposure saving  |
| T16 | Is stage one compact?                               | K's stage one on dense fixtures; output tokens per page against page text                                                                                                                                       | Small live spend | K                                  |

Offline and existing-data experiments come first; they cost no provider spend and prune candidates
before any live run. Live runs use fictional sources and an explicit experiment spend cap, as the
evaluation section requires.

Recorded outcomes, 2026-09-24; measurements, reconstruction instructions, limitations and independent
verification are in [the experiment results](processing-experiments.md). Completed experiment tasks
do not approve production features. Later owner amendments in the briefs govern live-run stop rules.

- **T1/T4 — measured, still open:** the original 800-page U=2 run stops at the guard; a verified
  rerun plus one Resume completes all 800 pages in 1,222 requests, with both recordings retained.
  The cost model still fails its ±20% criterion, and exact stale-history attribution remains unknown.
- **T2/T3 — not run:** the historical per-request rows are unavailable; the owner chose to continue
  without them, so latency slopes and the output floor remain unknown.
- **T5 — verified failure:** preserving tool instructions yields 8.82%/11.92% savings at U=2/U=10,
  below the 20% criterion.
- **T9 — not run:** worktrees are available, but the required T2 delay distribution is missing;
  no measured worker cap is selected.
- **T12 — verified failure:** no swept setting meets all criteria; a corrected value is falsely
  matched and row-major columns lose all span recall, even with oracle-assisted candidate intervals.
- **T13 — verified bounded pass:** 28/29 date roles correct, with zero false skips on the fictional
  corpus; the missed narrative comparison remains unknown and is kept for review.
- **T14 — verified functional pass:** grouping reduces variant questions to three; remembering
  all three spellings removes those questions while conflicts stay blocked; production integration is untested.
- **T15 — verified functional pass:** every virtual-clock fault mix finishes 199/200 pages with only
  the undecodable page parked and zero human callbacks; production timing and lifecycle remain untested.
- **T17 — preparation only:** the reusable counts reducer and tests are independently verified;
  no owner export was processed, and library statistics remain unknown.
- **T18 — verified failure:** both local engines exceed 3% character error
  across the 300-dpi stress matrix while every page meets the one-core CPU criterion; no OCR stage ships.
- **T20 — verified inconclusive attempt:** the sole provider-path probe returns HTTP 400 without
  usage; adapter inspection shows the requested output cap is not forwarded, leaving calibration open.
- **T21 — verified failure:** zero correct-person false stops, but only 8/10 wrong-DOB files stopped,
  below the 90% criterion; this does not enable the pre-AI identity feature.
- **T22 — conditionally deferred:** no application OCR stage or measured host-responsiveness trigger
  was introduced by these isolated prototypes.
- **T19 remains withdrawn; stage 4 (T6–T8, T10–T11 and T16) was excluded by the owner.**

### Open decisions, updated

This supersedes the third-pass list. Both are superseded by the
[open-issues register](#open-issues-register), which also restores three items this list dropped.

1. Whether a person-confirmed skip is allowed, or only reordering (above).
2. Question-compaction details (grouped per-file confirmation, and "remember this spelling" in the
   confirmation action), to be designed after T14.
3. Who chooses the processing strategy: code, the model, or the hybrid in revised candidate J.
4. Whether K's stage one emits compact located facts rather than a transcript, and whether
   text-layer pages bypass stage one.
5. Whether parallel workers stay shelved until measurement shows a need.
6. Whether to add a local OCR component, which "Find the words" for images would require.

Resolved in this pass: time windows (withdrawn), token ceiling (withdrawn), name alias (existing
`knownNames`), guard values (arbitrary starting points), format acceptance (accept all; choose
processing).

## Requirements, re-exports, OCR and the open-issues register

Fifth pass dated 2026-09-24, from the owner's follow-up. It adds cross-cutting requirements, a
re-export candidate (L), a view on OCR, a generalized cost model, experiment tasks and one canonical
register of open issues. Nothing earlier is removed.

### Requirements every candidate must meet

Owner-stated or carried from existing policy. A candidate that cannot meet one is rejected, not
traded off.

| ID  | Requirement                                                                                                       | Source                                        |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| R1  | Originals retained unchanged; model output stays reviewable before any accepted write                             | Repository policy                             |
| R2  | Productive work continues unattended; the job ends "finished" or "finished with exceptions", never "press Resume" | CRS-039, owner                                |
| R3  | "This is me" remembers the confirmed printed spelling in Self `knownNames`                                        | Owner; [CRS-090](application-todo.md#crs-090) |
| R4  | No page is silently left unread; anything not read is visible, labeled with why, and readable later in one action | CRS-044                                       |
| R5  | Every deduplication or cutoff signal fails open: when unsure, read                                                | Third pass                                    |
| R6  | Every format is accepted and retained; the processing choice is separate                                          | Owner, fourth pass                            |
| R7  | Identity questions are grouped; a person never answers the same spelling repeatedly                               | Owner, third pass                             |
| R8  | A failed unit is isolated and parked; it never stops the rest of the job                                          | Owner, third pass                             |

R3 is independent of every processing strategy and can ship on its own. Today it is not
implemented: the confirmation's optional `selfUpdate` accepts only still-blank `fullName` and
`birthDate` values ([intake identity](../src/server/intake-identity.ts), verified in the current
tree).

### Re-exports: skipping, dismissing, and what medical systems do

The owner asked whether matched pages could be batch-dismissed as already imported, and how a
medical-grade system handles this. Two separate burdens are tangled in the question:

- **Question burden.** 780 prompts for records the person already has. This can be solved without
  skipping anything.
- **Token burden.** Reading 780 pages again. Only skipping reduces it.

**What certified health record systems do.** The US certification criterion for clinical
information reconciliation (45 CFR 170.315(b)(2),
[ONC test method](https://www.healthit.gov/test-method/clinical-information-reconciliation-and-incorporation))
requires a system to:

- match a received document to the correct patient,
- show the incoming and existing data in one view, with each item's source and last-modified date,
- let the user build a single reconciled list, and
- have the user review and validate the final set before it is incorporated.

The pattern is: ingest and retain everything, attribute every item to its source, deduplicate at
the level of individual data items, and have a human validate the final list. Nothing received is
silently discarded. That criterion covers medications, allergies and problems exchanged as
structured documents. **Its key difference from this app:** a structured document costs nothing to
parse again, so those systems never face the token question. Here, "reading" is the expensive
step, which is the only reason skipping is on the table. (How particular vendors present
reconciliation is outside this review and unverified.)

**What that suggests here.** Follow the same principles (retain, attribute, reconcile at the item
level, human validates) for the question burden. Treat skipping as a separate, visible,
reversible optimization that needs evidence, not judgment.

### Candidate L: re-export linking with audit

Tiers 2 and 3 were withdrawn in the sixth pass; see
[candidate L revised](#candidate-l-revised-reconcile-dont-skip).

**New.** Tiers, each failing open (R5):

1. **Whole-file match (D0).** Already exists: a repeated upload is recognized by hash.
2. **Exact page match.** The normalized page text (D1) **and** the rendered page image hash both
   equal those of a page in an earlier original whose reading completed. The page is linked to
   the earlier results and shown as "Matched your import of <date>", not read. No information
   judgment is made: the same bytes were already read and reviewed. Whether this may happen
   without asking is open issue OI-02.
3. **Near match (D2 spans).** Pages inside matched spans are candidates to skip. With the person's
   confirmation (OI-01), they are skipped, **except** a random audit share (_proposed_ 5%, and at
   least 10 pages) that is read anyway. If the audit or a page change flag finds anything not
   already in the archive, all matched pages are read automatically, and the summary says why.
4. **Everything else** is read normally. Any extracted record that equals an accepted record goes
   to a collapsed **"Already in your records (N)"** group with **"Dismiss all as already
   imported"**; new or changed records form a separate group. This is the owner's batch-dismiss
   idea, and it applies whether or not tier 3 is enabled. It needs the cross-original
   related-record cue that D6 identified as a gap (OI-27).

What the person would see, as one summary rather than per-page prompts: "This looks like a newer
copy of your March export. 780 of 800 pages match what you already imported; 20 look new. Read
only the new pages (we'll spot-check the rest) · Read everything again."

- **Cost model.** On a multi-record 800-page source with 90% matched and a 5% audit: 12 requests
  and about 0.31M input tokens, against 80 requests and 2.1M for G10. The saving is proportional
  to the matched share.
- **The risk it cannot remove.** A single corrected value on an otherwise identical page is caught
  only by page change detection (T12's corrected-value case), not by random audit (T19). That is
  why an exact page match needs the text **and** the image to match, and why a near-match skip
  needs confirmation.
- **The guess to test.** A person importing yearly re-exports probably wants the one-summary
  default with the spot-check, and never 780 prompts. T17 shows how much re-exports actually
  overlap; T12 and T19 show whether the matching is trustworthy.

### Text for pages without a text layer (OCR)

The terms, since they are easy to mix up:

- **PDF text layer.** Text a PDF already carries, placed there by the software that made it. The
  app reads it with pdf.js. That is extraction, not recognition: exact, free and instant.
- **OCR (optical character recognition).** Recognizing characters from pixels. The app has no OCR
  today. A photo, a JPEG, or a scanned PDF (a PDF whose pages are pictures) has no text layer, so
  the only thing that reads it now is the model, which sees the page image directly.

**Would an OCR layer help images and scans? Probably yes, as an index, not as the reader.** Most
of this proposal's cheap mechanisms need text and so silently stop working on scans:

| Mechanism                           | With a text layer  | Scan or photo today   | With local OCR                         |
| ----------------------------------- | ------------------ | --------------------- | -------------------------------------- |
| D1/D2 re-export fingerprints        | Works              | Unavailable (D5 only) | Works, degraded by OCR errors (T18)    |
| D3 anchors, D4 date cutoffs         | Works              | Unavailable           | Works, degraded                        |
| Literal search and navigation       | Works              | Unavailable           | Works                                  |
| Quote checks for identity (CRS-040) | Literal text       | Visual-original mode  | A literal cross-check becomes possible |
| K's stage one                       | Text exists        | The model transcribes | OCR could replace part of stage one    |
| Choosing a strategy (J)             | Text density known | Unknown               | Known                                  |

The opinion, stated as such: OCR text should be **derived and advisory**. It is labeled
machine-read, regenerable from the original, and never the recovery authority or evidence
stronger than the page image. The model and the person still read the image for extraction and
review. Using OCR text _instead of_ the image to save media tokens is a separate idea that needs
T11 and a T6-style quality comparison first.

Costs and constraints:

- **CPU.** OCR is compute-heavy, so a scan-heavy import stops being purely IO-bound. Per-page cost
  is unmeasured here (T18). Even at several seconds per page, it is small next to hours of model
  time, but it competes with the app's two CPUs.
- **Fit with the repository's rules.** Tesseract as a command-line tool in the app image, or
  tesseract.js in process, fit the TypeScript and Docker constraints. OCRmyPDF is Python, which
  the repository confines to the LiteLLM proxy. Cloud OCR would send records to another service
  and is excluded. Apple's Vision framework does not run in the Linux container.
- **Quality.** Handwriting, skew, low resolution and tables degrade OCR. It fails open: poor OCR
  text only disables the cheap mechanisms for that page, and the model still reads it.
- **Where it would sit.** In the existing indexing stage, beside the pdf.js text layer, cached as
  derived output keyed by the original's hash.

T17 decides whether it matters (the share of pages with no text layer), and T18 whether it works.

### Generalized cost model

The scratchpad calculator is now [processing-cost-model.ts](../src/scripts/processing-cost-model.ts).
It covers every candidate (0, 0b, A–L, and B+H), with a test that pins it to the figures published
above. Run it with:

```bash
npm run model:processing -- --pages 1,10,200,800 --shape both --format markdown
```

Override any parameter with `--set name=value`, for example `--set charsPerToken=3.5` or
`--set cachedTokenCost=0.1`. It is a model (label: _model_), calibrated to the offline receipts.
Experiments T1, T10, T11, T16 and T20 replace its assumed parameters with measured ones.

Selected output at default parameters:

| Scenario | Strategy        | Requests | Critical path | Input tokens | Output tokens | Resumes under current limits |
| -------- | --------------- | -------- | ------------- | ------------ | ------------- | ---------------------------- |
| S1       | 0               | 5        | 5             | 102k         | 1k            | 0                            |
| S1       | B+H             | 5        | 5             | 40k          | 1k            | 0                            |
| S1       | G10 / J         | 1        | 1             | 17k          | 0.5k          | 0                            |
| M10      | 0               | 18       | 18            | 1.1M         | 16k           | 0                            |
| M10      | B               | 18       | 18            | 324k         | 16k           | 0                            |
| M10      | K               | 14       | 14            | 86k          | 17k           | 0                            |
| M10      | G10 / J         | 1        | 1             | 26k          | 13k           | 0                            |
| M800     | 0               | 1,222    | 1,222         | 241M         | 1.2M          | 12                           |
| M800     | 0b              | 896      | 896           | 90.6M        | 1.2M          | 4                            |
| M800     | D               | 1,059    | 1,059         | 156M         | 1.2M          | 7                            |
| M800     | B               | 1,222    | 1,222         | 36.0M        | 1.2M          | 1                            |
| M800     | B+H             | 1,222    | 1,222         | 25.7M        | 1.2M          | 1                            |
| M800     | K               | 1,067    | 1,067         | 6.2M         | 1.3M          | 1                            |
| M800     | G10             | 80       | 80            | 2.1M         | 1.1M          | 0                            |
| M800     | F (3×G10)       | 82       | 28            | 2.1M         | 1.1M          | 0                            |
| M800     | L (90% matched) | 12       | 12            | 0.31M        | 0.15M         | 0                            |

Readings:

- **The strategies are not about the same.** At 800 pages, input spans about 100× between the
  current U = 2 schedule and host-pushed units. The ranking follows from structure: how many times
  each page and the fixed prefix are resent. It survives any plausible parameter change. The
  magnitudes do not.
- **Once input is fixed, output matters.** For G10 on dense multi-record sources, output (1.1M) is
  about a third of all tokens and the same under every strategy. Only smaller record envelopes
  reduce it, and only parallel workers shorten its wall time (T3).
- **Small sources.** One request instead of five: the round-trip count, not tokens, is what a
  person waiting on a one-page upload feels.
- **Resume clicks.** The last column counts the pauses the current job limits (2,048 requests, 20M
  tokens, 16 slices) would demand when the route reports usage. Candidate C removes them for any
  strategy. Scripted runs report no usage, which is why the scripted U = 10 run completed without
  hitting the token limit. The slice count is approximated as fresh sessions, which overstates
  short-session strategies (A, I).
- **Caching narrows but does not close the gap.** With cached tokens at 0.1 of the price, the
  current schedule's effective input on S800 falls from 241M to about 31M, against about 0.94M
  for G10.
- **What the model omits.** Quality, rereads the model chooses to make, retries, media tokens
  (unknown until T11; parameter `mediaTokensPerPage`) and route rate limits.

### Experiments are now tasks

Each experiment in the [necessary experiments](#necessary-experiments) registry, plus four new
ones, has a task in the work list and a brief in [processing experiments](processing-experiments.md).
Runners append results there, and an independent verifier appends a verification entry before the
task closes.

| Theory | Task                                   | Stage         |
| ------ | -------------------------------------- | ------------- |
| T1, T4 | [CRS-091](application-todo.md#crs-091) | Offline       |
| T2, T3 | [CRS-092](application-todo.md#crs-092) | Existing data |
| T5     | [CRS-093](application-todo.md#crs-093) | Offline       |
| T9     | [CRS-094](application-todo.md#crs-094) | Offline       |
| T12    | [CRS-095](application-todo.md#crs-095) | Offline       |
| T13    | [CRS-096](application-todo.md#crs-096) | Offline       |
| T14    | [CRS-097](application-todo.md#crs-097) | Offline       |
| T15    | [CRS-098](application-todo.md#crs-098) | Offline       |
| T17    | [CRS-099](application-todo.md#crs-099) | Existing data |
| T18    | [CRS-100](application-todo.md#crs-100) | Offline       |
| T19    | [CRS-101](application-todo.md#crs-101) | Offline       |
| T6     | [CRS-102](application-todo.md#crs-102) | Small live    |
| T7, T8 | [CRS-103](application-todo.md#crs-103) | Small live    |
| T10    | [CRS-104](application-todo.md#crs-104) | Small live    |
| T11    | [CRS-105](application-todo.md#crs-105) | Small live    |
| T16    | [CRS-106](application-todo.md#crs-106) | Small live    |
| T20    | [CRS-107](application-todo.md#crs-107) | Route reads   |

New theories, continuing the tables above:

| #   | Theory                                                                                   | Refuting observation                                                                      | Cost          |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------- |
| T17 | Most large sources carry a text layer, and yearly re-exports mostly repeat earlier pages | A counts-only profile shows many image-only pages or little re-export overlap             | Existing data |
| T18 | Local OCR is accurate and cheap enough to index scans                                    | Character error rate, CPU per page, or fingerprint recall on OCR text misses its bar      | Offline       |
| T19 | An audit sample plus page change flags make near-match skipping safe                     | Planted changes in matched spans escape detection at a practical audit share              | Offline       |
| T20 | The route's limits and characters per token match the model's assumptions                | Configuration reads or a probe show a smaller context, output cap or characters per token | Route reads   |

### Protocol amendment

Rule 3 of the [review protocol](#review-protocol-for-later-passes) said open decisions stay in the
latest list. That failed: the fourth-pass list silently dropped three third-pass items (the
governing cutoff date, HEIC/TIFF and DICOM, and which candidate to prototype first). From this pass
on, the **open-issues register below is the one list**. Later passes change a row's status and
add rows; they never remove a row or start a new list. The next free identifiers are candidate M,
theory T21 and issue OI-33.

### Open-issues register

Canonical and living: later passes update statuses in place and add rows (latest: eighth pass). It supersedes the third-pass [open decisions](#open-decisions-for-the-owner), the
fourth-pass [updated list](#open-decisions-updated) and the open items in
[decision readiness](#decision-readiness), all kept above as history. Statuses: **open** (needs a
decision or result), **requirement** (decided; must be designed and built), **resolved** (decided;
where noted), **existing task** (owned by a work-list item), **standing limit** (cannot be closed
in advance).

| ID    | Issue                                                                                                                                           | Origin                       | Status             | Next step                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| OI-01 | May a person confirm skipping near-matched re-export pages or pre-cutoff reports, or only reorder?                                              | Third #3, fourth #1          | Resolved           | Sixth: no skipping to save tokens; read in full and reconcile                                |
| OI-02 | May exact page matches (text and image) link to earlier results without asking?                                                                 | Fifth                        | Resolved           | Sixth: not pursued; fingerprints label and order only                                        |
| OI-03 | Which date governs a cutoff (_proposed_: report or encounter date; addenda always included)                                                     | Third #4 (dropped in fourth) | Open (reframed)    | Sixth: now a review filter over extracted report dates, not a reading rule                   |
| OI-04 | Remember a confirmed name spelling                                                                                                              | Third #5, fourth             | Requirement        | [CRS-090](application-todo.md#crs-090), with birth-date agreement (OI-05)                    |
| OI-05 | Must a printed birth date agree before a spelling is remembered? Household same-name risk                                                       | Fourth, fifth                | Resolved           | Sixth: yes, a complete printed birth date equal to Self's; none printed, nothing remembered  |
| OI-06 | Grouping of identity questions beyond remembered spellings                                                                                      | Third, fourth #2             | Open               | T14                                                                                          |
| OI-07 | Runaway multiple, attempts before parking, parked-unit rate                                                                                     | Third #6                     | Resolved           | Arbitrary starting values; revise with data                                                  |
| OI-08 | Support HEIC and TIFF as images; explicit retain-and-index rule for DICOM                                                                       | Third #7 (dropped in fourth) | Open (recommended) | Seventh: convert HEIC/TIFF to page images; DICOM kept only; choose a conversion library      |
| OI-09 | Wording and defaults of the processing choice for unknown formats                                                                               | Fourth                       | Open (recommended) | Seventh: no upfront prompt; unknown types kept and listed as exceptions; choices as override |
| OI-10 | Add a local OCR index stage; which engine; offer "Find the words" for images                                                                    | Fourth #6, fifth             | Open               | T17, T18                                                                                     |
| OI-11 | Which candidates to prototype first (suggested H, then G with working state)                                                                    | Third #8 (dropped in fourth) | Open               | After stage 1–2 experiments                                                                  |
| OI-12 | Who chooses the processing strategy: code, the model, or the hybrid in revised J                                                                | Fourth #3                    | Open               | Seventh: model chooses from a table of contents and menu; T23, CRS-113                       |
| OI-13 | Switching strategy mid-job once record density becomes known                                                                                    | Candidate J                  | Open               | Seventh: revise remaining pages at checkpoints; T23, CRS-113                                 |
| OI-14 | K's stage one: compact located facts or a transcript; do text-layer pages bypass it?                                                            | Fourth #4                    | Open               | T16                                                                                          |
| OI-15 | Parallel workers stay shelved until measurement shows a need                                                                                    | Fourth #5                    | Open               | T2/T3, T9                                                                                    |
| OI-16 | Optional operator spending cap for metered keys: UX and defaults                                                                                | Decision requested, fourth   | Resolved           | Seventh: dropped; report controllable measures instead                                       |
| OI-17 | Time targets                                                                                                                                    | Third #1, decision readiness | Resolved           | Withdrawn; code-controlled measures instead                                                  |
| OI-18 | Per-page token ceiling                                                                                                                          | Third #2                     | Resolved           | Withdrawn; runaway guard as fault detector                                                   |
| OI-19 | Which formats to accept                                                                                                                         | Fourth                       | Resolved           | Accept all (R6)                                                                              |
| OI-20 | Real workload mix: sizes, types, scans, re-export overlap                                                                                       | Decision readiness           | Open               | T17                                                                                          |
| OI-21 | Route limits and characters per token                                                                                                           | Decision readiness           | Open               | T20                                                                                          |
| OI-22 | What drives latency: input, output, or round trips                                                                                              | Decision readiness           | Open               | T2/T3                                                                                        |
| OI-23 | Residual attribution and hygiene savings                                                                                                        | Decision readiness           | Open               | T1/T4, T5                                                                                    |
| OI-24 | Extraction quality under a new strategy                                                                                                         | Decision readiness           | Open               | T6, T7/T8 (prototype needed)                                                                 |
| OI-25 | Achieved cache share, and media tokens per page                                                                                                 | Decision readiness           | Open               | T10, T11                                                                                     |
| OI-26 | Quality on real charts                                                                                                                          | Decision readiness           | Standing limit     | Sampled after release through review outcomes                                                |
| OI-27 | A related-record cue across originals, for re-exports; never an automatic merge                                                                 | Third (D6)                   | Open (central)     | Sixth: needed for the "matches a saved record" review filter                                 |
| OI-28 | Route documents encapsulated in DICOM (for example an embedded PDF) to their own adapter                                                        | Candidate J                  | Open               | Design; CRS-082                                                                              |
| OI-29 | Whether PDF shared headings are plumbing or a parsing problem                                                                                   | Earlier idea 3               | Existing task      | [CRS-087](application-todo.md#crs-087)                                                       |
| OI-30 | Stable block or region locators below the page, for ownership and multi-record pages                                                            | Earlier idea 5, D4           | Open               | Design before parallel work or sub-page cutoffs                                              |
| OI-31 | Continuing an import across lock, logout or restart                                                                                             | Revised design candidates    | Existing task      | [CRS-081](application-todo.md#crs-081)                                                       |
| OI-32 | Real-model feasibility and quality at 800 pages                                                                                                 | Earlier idea 1               | Existing task      | CRS-039 and CRS-066 provider gates                                                           |
| OI-33 | Should an exact name match with no printed birth date still pass without asking? Today name **or** birth date matching yields `evidenced_match` | Sixth                        | Resolved           | Seventh: passes silently; birth date is the anchor                                           |
| OI-34 | Build a pre-AI identity check that stops a clearly wrong-person file before reading? What does a stopped file show?                             | Sixth                        | Open               | Seventh: wanted; T21 with false-stop cases, then CRS-111                                     |
| OI-35 | Where CPU work runs: the existing forked worker, a stateless processing container, or a queue with a worker fleet                               | Sixth                        | Resolved           | Seventh: keep the forked worker; CRS-110 deferred with triggers                              |
| OI-36 | Which review filters and batch actions to add for reconciliation                                                                                | Sixth                        | Resolved           | Seventh: filters are the mechanism; ready-made buckets proposed                              |
| OI-37 | "Already saved" dismissal attaches the new original as extra source evidence to the saved record rather than discarding it                      | Sixth                        | Open (proposed)    | Owner; design with OI-27                                                                     |
| OI-38 | Retire the blank-field Self fill in "This is me" once no older profiles need it                                                                 | Sixth                        | Resolved           | Seventh: retire it; CRS-112                                                                  |
| OI-39 | Do subscription usage or rate windows stretch a backfill past overnight?                                                                        | Sixth                        | Open               | T20 (ChatGPT subscription route; record rate-limit evidence), then `usageTokensPerHour`      |
| OI-40 | Birth date matches but the name differs: ask "another name?" instead of blocking; remember on yes                                               | Seventh                      | Open (proposed)    | Design with CRS-040 and CRS-090                                                              |
| OI-41 | Ready-made review buckets (already saved, new and ready, differ, need an answer)                                                                | Seventh                      | Open (proposed)    | Owner review; needs OI-27                                                                    |
| OI-42 | Index before planning so the model sees a table of contents in the first reading prompt                                                         | Seventh                      | Open (proposed)    | T23, CRS-113                                                                                 |
| OI-43 | Keep a profile with background work open after sign-out or profile switch                                                                       | Eighth                       | Open (decided)     | Security review; design with CRS-081                                                         |
| OI-44 | Semantic test equivalence, standard display names and a per-profile alias index; shared list licensing                                          | Eighth                       | Open (proposed)    | LOINC terms checked (eighth-pass addendum); owner review of OI-51                            |
| OI-45 | Page progress and time estimate on Import                                                                                                       | Eighth                       | Open (decided)     | Design; estimate method from T2/T3 data                                                      |
| OI-46 | Relative's records filed as reference with a People note per referring document                                                                 | Eighth                       | Open (decided)     | Design with CRS-085                                                                          |
| OI-47 | Required dates for clinical records; partial dates                                                                                              | Eighth                       | Open (decided)     | Design; answered in eighth-pass addendum 2                                                   |
| OI-48 | Imported clinician notes appear in Notes                                                                                                        | Eighth                       | Open (decided)     | Design                                                                                       |
| OI-49 | Bulk-review layout usability test on fictional fixtures (T24)                                                                                   | Eighth                       | Deferred           | Default decided (eighth-pass addendum); layout test after OI-27                              |
| OI-50 | Additive medication approval: list only medications not already on the person's list, matched brand ↔ generic                                   | Eighth                       | Open (decided)     | Design; matching needs OI-51                                                                 |
| OI-51 | Bundle LOINC and RxNorm subsets for offline lookup so health terms never leave the server                                                       | Eighth                       | Open (proposed)    | Owner review; size and update cadence                                                        |
| OI-52 | Stop imports button on Import, with resume from where it stopped                                                                                | Eighth                       | Open (decided)     | Design with OI-43                                                                            |

## Reconciliation, identity and architecture

Sixth pass dated 2026-09-24, from the owner's answers to the fifth pass. The register above carries
the resulting status changes and new issues OI-33 to OI-39.

### Owner decisions

- **AI is additive only.** AI may add capability; it never replaces a safeguard or lowers a
  standard to save tokens. If importing to a medical-grade standard takes many tokens, the app
  accepts that cost, and models will get cheaper. The aim is a product a medical professional
  would recommend.
- **Reconciliation follows the certified-record-system pattern** described in the fifth pass:
  retain everything received, attribute every item to its source, show incoming records beside
  saved ones, and have the person validate the final list.
- **Token spend is not a constraint.** No pages are skipped to save tokens (OI-01 and OI-02
  resolved); re-exports are read in full. Tokens still matter in two indirect ways:
  - **Context limits.** Every request must fit the route's window.
  - **Usage and rate windows turn tokens into time** (OI-39). As a model illustration only, with a
    hypothetical window of 5M tokens per hour, M800 needs about 48 window-hours on the current
    U = 2 schedule and under one hour for G10 (`--set usageTokensPerHour=5000000`). The real
    window is unknown until T20.

  So the efficiency candidates stay, reclassified as throughput work. Each must still pass
  non-inferior quality (T6, T7) before it can replace the current design.

- **Ranked goals, revised** (supersedes the third-pass [ranked goals](#ranked-goals)):
  1. Accuracy, to a medical-grade standard.
  2. Human effort: fewer, grouped and batchable questions.
  3. Unattended completion.
  4. Throughput within the route's windows.

  Token cost is observed, not a goal.

### Requirements added

Continuing the requirements table in the fifth pass.

| ID  | Requirement                                                                                                                                                                         | Source         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| R9  | AI is additive only: no design trades accuracy or a safeguard for fewer tokens, and every token-saving candidate passes non-inferiority (T6, T7)                                    | Owner          |
| R10 | Incoming records are reconciled: shown beside saved records with both sources; duplicates are linked, never silently dropped; the person validates                                  | Owner          |
| R11 | Identity fails fast: a printed birth date that differs from Self's stops that file or report as early as possible; spellings are remembered only with a matching printed birth date | Owner; CRS-090 |

### Candidate L revised: reconcile, don't skip

Fifth-pass tiers 2 and 3 (linking and audited skipping) are withdrawn, and so is experiment T19.
L now means:

1. **Read every page.**
2. **Fingerprints label and order, never skip.** D1 and D2 mark matched spans ("matches your March
   import") and let the scheduler read new-looking pages first, so new records reach review sooner.
   That is a throughput gain with no page left unread.
3. **Classify each extracted record against saved records:** new, matches a saved record, or
   differs from a saved record. This needs the cross-original cue in OI-27.
4. **Review filters and batch actions** (below) carry the question burden.

The cost model's `L` row keeps the withdrawn skip variant for comparison only. The revised L costs
the same tokens as whichever reading strategy it runs on.

### Batch approval and review filters

What exists (verified in [ImportPage](../src/app/features/import/ImportPage.tsx) and
[ImportReviewPresentation](../src/app/features/import/ImportReviewPresentation.tsx)):

- views Review, Later, Saved and Kept original,
- a kind filter (Test results, Prescriptions, Vision, Procedures, Documents, People),
- search, and a "Manually edited" filter,
- "Select all shown", then **Save _N_ ready records** (records that need review are counted and
  left out), **Later**, and **Correct selected fields**.

_Proposed_ additions (OI-36):

| Filter                | Values                                                     | Needs                                  |
| --------------------- | ---------------------------------------------------------- | -------------------------------------- |
| Reconciliation status | New · Matches a saved record · Differs from a saved record | OI-27 cross-original cue               |
| Source file           | Each uploaded original, with its upload date               | Data exists                            |
| Report date           | A date range; replaces the earlier reading cutoff (OI-03)  | Extracted report dates                 |
| Needs attention       | Ready · Has a question · Identity to confirm · Conflict    | Readiness already computed             |
| Care area or test     | From reviewed mappings and classifications                 | Partly exists                          |
| Issuer                | Issuing organization from provenance                       | Partly exists; verify before designing |

_Proposed_ batch actions:

- **Save _N_ ready** (exists). It never includes a record with a question or a conflict.
- **Mark _N_ as already saved**, for records that match a saved record. It attaches the new
  original to the saved record as additional source evidence (OI-37). Nothing is deleted, and the
  original stays retained. CRS-042 already requires verifying source attribution when acceptance
  reuses an existing result.
- **Differs from a saved record** is never batch-saved. It opens side by side with the saved value
  and both sources, which is the reconciliation view itself.

This stays medical grade because the person validates what is saved, each batch acts on a visible,
filtered and counted set, and each batch writes a receipt.

### Identity: the birth date decides, and earlier

Verified in the current tree:

- **Onboarding requires a real name and a complete birth date** for new profiles
  ([profile onboarding](../src/server/profile-onboarding.ts)). The blank-field Self fill in
  "This is me" therefore reaches only older profiles, copies and Placebo seeds. Whether to retire it
  is OI-38.
- **A printed birth date that differs from Self's is already a blocking conflict**, but only after
  extraction ([identity policy](../src/server/intake-identity-policy.ts)).
- **An exact name match alone passes.** Name _or_ birth-date agreement yields a non-blocking
  `evidenced_match`, so a same-name relative whose report prints no birth date passes silently.
  Whether that should ask instead is OI-33.

Decided: CRS-090 remembers a spelling only when the report prints a complete birth date equal to
Self's.

Proposed (OI-34, experiment T21): **check identity before any model reading.** The text layer
exists before the first model call. Host rules can look for a labeled birth date and printed name.
Only a clear contradiction stops the file: "This looks like a record for someone born <date>, not
you. Upload the right file · Read it anyway." Anything unknown proceeds to the normal identity
review after extraction. The question arrives at upload time, when the person is present, and in a
batch the stopped file waits while the others continue (R8). Scans need OCR (T18) for this to work.

### Architecture: where CPU work runs

The owner asked whether OCR, PNG rendering and PDF splitting should move to containers, with a web
app and a worker queue, so CPU work can scale separately from the IO-bound app.

**Current state, verified:**

- **PDF work is already off the web server's event loop.** Indexing, text extraction, single-page
  PDF extraction and rasterization run in a forked child process
  ([PDF session](../src/server/intake-pdf-session.ts), [PDF worker](../src/server/intake-pdf-worker.ts)).
  It sits behind one process-wide FIFO queue, so one page operation runs at a time, and is recycled
  every 32 rendered pages.
- **Containers:** the app gets two CPUs and the LiteLLM proxy one ([compose](../compose.yaml)).
- **PNG creation is rare.** It happens only after a verified PDF rejection.
- **Measured:** host page reads have a median of 101 ms, and app CPU a median of 3.24%. Provider
  spans took 99% of the live slice. CPU is not the bottleneck today. More CPU would not finish an
  import sooner while the model reads one request at a time.

**What OCR changes.** OCR costs seconds of CPU per page (unmeasured; T18), so scan-heavy imports
become partly CPU-bound for the first time.

| Option                                 | What it is                                                                                                                                      | For                                                                                                                                                   | Against                                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Extend the forked worker            | Add OCR to the existing child process; Tesseract in the app image                                                                               | Simplest; no new trust boundary                                                                                                                       | Shares the app's two CPUs and one queue; larger app image                                                                                                                                                                                                     |
| B. Stateless processing container      | The app pushes page bytes over the internal Compose network; the container returns text, images or split pages; it holds no keys and no volumes | Own CPU limit and replicas; crash and parser isolation (CRS-084 lists parser isolation); the interface never competes; OCR can run ahead of the model | Plaintext page bytes cross a container boundary (internal network, never disk), which needs security review; one more image to update                                                                                                                         |
| C. Web app, job queue and worker fleet | A broker such as Redis, with workers pulling jobs                                                                                               | Scales across hosts; the standard hosted pattern                                                                                                      | Workers that pull jobs must read encrypted originals and so need profile keys, which today exist only in the app process (CRS-081, CRS-088). A broker is another stateful service. The app's durable batch ledger already acts as the queue for one household |

**Recommendation (opinion):**

- **Keep A until T22 shows contention.**
- **Move to B when OCR lands or T22 fails.** Rule for B: workers never hold keys or storage; the
  app pushes bytes and pulls results.
- **Reserve C for a hosted or multi-household deployment (CRS-083),** and only after a key-scoping
  design.

B's benefit is isolation and pipelining, not throughput. While the model is the bottleneck, extra
CPU helps only by preparing pages ahead, so the model never waits on the host.

### Identifiers

Next free: candidate M, theory T23, issue OI-40.

## Seventh pass: decisions on the remaining questions

Added 2026-09-24 after the owner answered the sixth pass's open questions. Earlier sections stay as
history; the [register](#open-issues-register) statuses are updated in place.

### Owner decisions

- **Keep the current worker until it breaks** (OI-35). This is personal use, so one person briefly
  throttling the server is acceptable. The separate container becomes a deferred first-class item
  with performance triggers, [CRS-110](application-todo.md#crs-110).
- **An exact name match with no printed birth date passes silently** (OI-33). The owner's words:
  "People change names, not birthdays." Nothing suggests the person is someone else.
- **A pre-AI identity check is wanted for fail-fast** (OI-34), subject to the false-stop
  experiment below.
- **Filters are the batch mechanism** (OI-36): filter, select all shown, then act.
- **Retire the blank-field Self fill** (OI-38), [CRS-112](application-todo.md#crs-112).
- **The metered spending cap does not matter** (OI-16). Work on what can be controlled: tokens
  per document for the same document, accuracy per strategy, and overhead.
- **Formats:** do what a person would expect (OI-08, OI-09); the recommendation is below.
- **Strategy:** can the model pick it, given a table of contents in the first prompt? (OI-12,
  OI-13) The proposal is below.

### Identity: the birth date is the anchor

"People change names, not birthdays" turns the identity rule into an asymmetry:

| Printed on the report            | Today ([identity policy](../src/server/intake-identity-policy.ts)) | Proposed                                                                             |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Name matches, no birth date      | Passes (`evidenced_match`)                                         | Passes silently (OI-33, decided)                                                     |
| Name matches, birth date matches | Passes                                                             | Passes                                                                               |
| Birth date matches, name differs | Blocking conflict when no possible-name hint                       | Asks "Is this you under another name?"; on yes, the spelling is remembered (CRS-090) |
| Birth date differs               | Blocking conflict                                                  | Blocking conflict, and earliest possible (pre-AI check, CRS-111)                     |
| Neither printed                  | Confirmation                                                       | Unchanged                                                                            |

The third row is the only change and matches CRS-040's open finding that a differing name with a
matching birth date should ask rather than hard-block. A name change (marriage, divorce,
transition, transliteration) is exactly the case where remembering the spelling pays off. A
matching birth date together with a differing name is the one row where the evidence supports the
real user.

### Why the pre-AI check is an experiment first (OI-34)

The sixth pass asked two things: whether to build the check, and what a stopped file shows. The
owner answered the first. The risk behind the second is a **false stop**, meaning a correct-person
file stopped because it prints someone else's birth date for a legitimate reason:

- an insurance subscriber or guarantor block (a spouse or parent who holds the policy),
- a parent on a child's record, or a child on a parent's form,
- an emergency contact or next-of-kin section.

A host rule that finds "a birth date on page 1 that isn't Self's" would stop these. The rule must
therefore trust only a birth date **labeled as the patient's**, and treat everything else as
unknown, which proceeds. T21 ([CRS-108](application-todo.md#crs-108)) now includes these cases. The
feature is [CRS-111](application-todo.md#crs-111), built only if T21 shows no false stops of
correct-person fixtures.

What a stopped file shows is unchanged from the sixth pass: the printed birth date, then "Upload
the right file" or "Read it anyway". "Read it anyway" continues into the normal identity review,
which stays the authority. The other files in a batch continue.

### Filters are the batch mechanism (OI-36)

The sixth pass's question was which filters to add, not whether filters are for batch actions.
They are: the existing bar already works as "filter, select all shown, act". The proposal is
**ready-made buckets**, so the common case takes one click instead of building a filter:

| Bucket shown after reading                   | One action                                                 | Never                            |
| -------------------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| "_N_ already saved (same values, same date)" | **Mark all as already saved** (attaches the source; OI-37) | Deletes anything                 |
| "_N_ new and ready"                          | **Save all** (exists as Save _N_ ready)                    | Includes a question or conflict  |
| "_N_ differ from a saved record"             | Opens side by side, one at a time                          | Batch saved                      |
| "_N_ need an answer" (identity, questions)   | Opens the question list                                    | Answered in bulk without viewing |

Each bucket is a preset of the filters in the sixth-pass table. It is not a new mechanism, so each
bucket still acts on a visible, counted set and writes a receipt. The "already saved" and "differ"
buckets need the cross-original cue (OI-27).

### Retiring the blank-field Self fill (OI-38)

Recorded in [CRS-112](application-todo.md#crs-112):

- Remove the optional fill of a blank name or birth date from "This is me".
- An older profile missing either field completes Self through Self editing, never from a
  document.
- Historical receipts that recorded a fill stay readable.
- The confirmation transaction that now remembers a known name (CRS-090) is the only Self write
  left in that path.

This also removes a way for a document to set the birth date that every later identity check
anchors on. That fits the rule that the birth date decides.

### Measures that replace the spending cap (OI-16)

The owner dropped the metered cap. The measures every experiment and candidate should report, all
controllable:

| Measure                            | Definition                                                                  | Source                             |
| ---------------------------------- | --------------------------------------------------------------------------- | ---------------------------------- |
| Tokens per document, same document | Input plus output tokens to finish one fixed fictional source, per strategy | Cost model, then T2/T3 and T6      |
| Accuracy per strategy              | Record recall and precision, association recall, against a fixed answer key | T6, T7/T8, T23                     |
| Overhead ratio                     | Fixed prompt, tools, schema and history tokens divided by source tokens     | Cost model; T1/T4, T5              |
| Requests per page                  | Provider requests divided by pages                                          | Cost model; live usage rows        |
| Human interventions per document   | Resume clicks, questions asked, identity prompts                            | T14; unattended mode (candidate C) |

The cost model ([`npm run model:processing`](../src/scripts/processing-cost-model.ts)) already
reports the first, third and fourth for every strategy. Live runs would fill in the rest.

### Formats: what a person would expect (OI-08, OI-09)

The fourth pass proposed a three-choice prompt for unknown formats. Asked what a user would
expect, the recommendation is **no upfront question in the normal case**. People expect three
things. Files that obviously contain health information get read. Files that obviously don't get
kept without fuss. The app says plainly what it couldn't do, afterward, without making them decide
things they can't judge ("what codec is this?").

| Kind                                                                   | Default                                           | What the person sees                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Readable documents: PDF, PNG, JPEG, WEBP, JSON/JSONL (supported today) | Processed automatically                           | Normal import                                                                     |
| Readable once converted: HEIC, TIFF including multi-page (not yet)     | Converted to page images, then processed (OI-08)  | Normal import                                                                     |
| Probably readable: plain text, HTML, email (not yet)                   | Processed once an adapter exists; kept until then | "Saved. Circus Health can't read this type yet."                                  |
| Known non-document: DICOM imaging, video, audio                        | Kept only, never sent to AI (CRS-082)             | "Saved as a medical image. Images are kept, not interpreted."                     |
| Unknown binary                                                         | Kept only                                         | Listed afterward as an exception: "Saved, but we don't recognize this file type." |

- The exception list is the same "finished with exceptions" summary as unattended operation. It
  appears once, at the end, beside the Kept original view that already exists.
- **The three choices survive as an override, not a gate.** "Just keep", "Find the words" and
  "Read it" remain available on any kept file, from the Kept original view. They cover the person
  who knows an odd file matters, without asking everyone else.
- DICOM with an encapsulated document (OI-28) is the exception within the exception: route the
  embedded PDF to the PDF path and keep the imaging.
- **Open:** which conversion library for HEIC and TIFF, and whether it runs in the forked worker.
  Probably yes, under CRS-110's "until it breaks".

This supersedes the fourth-pass prompt as the default. The prompt stays above as history.

### Strategy: the model chooses from a table of contents (OI-12, OI-13)

The model already picks part of the strategy. `intake_plan` `create` accepts `unitSize` (1–50) and
`overlap` ([assistant tools](../src/server/assistant.ts)), and code falls back to two pages for
PDFs and 25 rows otherwise ([plan](../src/server/intake-plan.ts)). The model chooses **blind**,
though: indexing happens inside that same create call (the reading phase is `indexing_source`), so
the choice is made before any page count or text-layer size is known.

_Proposed_, extending [revised J](#candidate-j-revised-code-enforces-the-model-chooses) with the
owner's idea of putting it in the first prompt:

1. **The host indexes before the model plans.** It builds a table of contents from facts that are
   free in code: page count, per-page text-layer characters, pages without text (scans), repeated
   headers, encounter anchors and dates (D3), and file type.
2. **The first reading prompt carries the table of contents and a strategy menu.** The menu lists
   only strategies that exist and have been qualified, for example "two-page units", "ten-page
   units for sparse text", "one report per span between anchors" and "visual read for scanned
   pages". The model returns a plan: spans, a unit size per span, and which spans look like one
   report.
3. **Code validates and enforces.** Every page is covered, bounds hold, deterministic lanes (JSONL,
   DICOM, kept-only) are not overridable, and runaway caps apply. An invalid plan falls back to the
   default rather than failing the import.
4. **Revision at checkpoints (OI-13).** At each checkpoint the model may revise the plan for the
   remaining pages, once record density is known. Pages already read are never re-planned. Each
   revision is recorded in the plan receipt, so a run stays explainable even though model choices
   vary.

**Cost.** One planning request with the table of contents. At 800 pages, one short line per page
is roughly 800 × 60 characters, about 13k tokens: a small fraction of any 800-page strategy in the
cost model, and paid once. **Risk.** Model-chosen plans vary between runs, which the sixth pass
flagged. Restricting the menu to qualified strategies bounds the variance, and T23
([CRS-113](application-todo.md#crs-113)) measures whether choosing beats the fixed default on
accuracy and tokens per document.

### Register changes in this pass

- **Resolved:** OI-16 (dropped), OI-33 (pass silently), OI-35 (keep the worker; CRS-110 deferred),
  OI-36 (filters are the mechanism; buckets proposed), OI-38 (CRS-112).
- **Moved to experiment and task:** OI-34 (T21 with the false-stop cases, then CRS-111), OI-12 and
  OI-13 (T23, CRS-113).
- **Recommendation awaiting review:** OI-08, OI-09.
- **New:** OI-40 to OI-42.

### Addendum: experiment budget and the owner's route

Owner decisions after the seventh pass:

- **No dollar cap for experiments.** Each live run is planned in pages × strategies × repeats,
  modeled first, and stopped at 2× its modeled tokens. An overrun is recorded as a finding
  ([experiment rule 8](processing-experiments.md#rules-for-runners-and-verifiers)).
- **The route is a ChatGPT subscription** signed in with a device code. Extra dollars per import
  are zero, which is consistent with the owner's position that token spend is not the constraint.
  The real limit is the subscription's usage window (OI-39). A long backfill or an experiment
  competes with the owner's own use of the same window, and nobody knows the window's size (T20
  now records rate-limit evidence). This makes tokens per document matter after all, as time to
  finish rather than cost: every token saved leaves more of the window for other imports.

### Identifiers (seventh pass)

Next free: candidate M, theory T24, issue OI-43. CRS-110 to CRS-113 are used.

## Bounded follow-up evidence update — 2026-09-25

The owner shortened F2 after fourteen original primary attempts: six strictly complete and eight incomplete. The original 120-cell comparison, confidence intervals, quality noninferiority claim and full-matrix finalization remain incomplete/superseded. The [independently checked extrapolation register](processing-extrapolated-results.md) preserves every original cell: fourteen measured attempts, thirty-two conditional dense cost scenarios and seventy-four unsupported empirical completion forecasts, with the original structural estimates separate. Unattempted cells remain unattempted.

New scripted N400 checks validate the frozen N200/N800 character interpolation at U10 and U20 with signed errors of −0.326920% and +0.024569%. That does not validate live token or latency scaling. The completed dense1 four-arm observation does not show monotonic benefit from larger units; all six attempted mixed-document cases failed to complete. Their retained evidence points to context retention and provenance/association problems that unit-size arithmetic cannot resolve.

The six offline follow-ups F1/F3/F4/F5/F6/F7 have independently verified outcomes, including their failed criteria. The owner authorized three separate live length anchors within approximately ninety minutes of dispatch allowances to test the extrapolation assumptions. After a preserved authentication interruption and independently reviewed same-state continuation, those anchors are running. Final bounded execution review remains pending; no production unit size, OCR adoption, automatic skipping or open acceptance gate is selected by these results.

## Final bounded follow-up disposition — 2026-09-26

The bounded execution and review request is complete: the independent reviewer rates completeness **9/10** and extendedness **9/10** with no unresolved material gap requiring another live/OCR run within that scope. The three live anchors consumed 26.507860 active minutes. Dense20 recovered all eighty observations after authentication repair but retains unknown original usage and identity-pending records; single20 and single80 failed under the unchanged progress guard. The latter do not calibrate successful long-report cost or latency. The N400 checks support the fixed scripted interpolation, and all original/partial recordings and forecasts remain preserved.

The [final independent review](processing-follow-up-experiments.md#final-independent-review--bounded-follow-up-closure) and [extrapolation register](processing-extrapolated-results.md) separate this execution closure from scientific success. The original 120-cell confidence/noninferiority study and gated finalization remain incomplete/superseded, with 106 cells unattempted; standalone open T/CRS experiments and production/provider gates remain open. No universal unit-size winner or tested context-retention remedy is selected. The completed recurring follow-up is being stopped.

## Rereading-remedy evidence update — 2026-09-26

F8/F9 isolate exact text retention and acknowledged-evidence replay. Offline context-turnover checks passed; new20/40-page live attempts read all pages once and preserved all six fictional clinical findings. F8 failed the fixed complete-document requirement; separately declared F9 failed full literal proposal transcription (7/40pages;33 omitted administrative pages retained in the original). Independent review found no lost authored clinical fact and identified four evaluator false positives caused by valid context inheritance/display-label mapping. The true all-page criterion still fails. Eighty-page validation remains unattempted and successful long-report scaling remains NOT_ESTIMABLE. See the [four-hour synthesis](processing-follow-up-experiments.md#four-hour-investigation-synthesis--2026-09-26). This is a tested mechanism candidate, not production selection or closure of existing acceptance gates; final execution review is pending.

## Final four-hour investigation disposition

Independent review gives completeness **9/10** and extendedness **8/10**, positive for the bounded F8/F9 investigation with no material execution/reporting gap requiring more runs. The source-retention candidate traversed20/40-page fixtures without rereading and preserved all six findings, but both declared output gates failed. Eighty-page validation and successful scaling remain unsupported; no production default or existing gate is approved. The [final review](processing-follow-up-experiments.md#four-hour-investigation-final-independent-closure) records all limitations and closes this follow-up within its shared four-hour allowance.

## Eighth pass: gaps between the import specification and the current tree

Added 2026-09-25. The owner turned the user scenarios into an implementation-independent
[import specification](import-scenarios.md): it states expected behavior only, so a builder with no
access to this codebase could implement it. The comparison with the current tree, first drafted
inside those scenarios, lives here instead so none of it is lost. Everything under "Today" was
verified in the tree on 2026-09-25.

### Owner decisions recorded in the specification

Answered 2026-09-25, in addition to the seventh pass:

- Supported types start reading automatically after upload.
- Reading shows progress and a time estimate.
- The app imposes no usage window or budget of its own; provider limits are waited out with backoff
  and the estimate is updated.
- Signing out, or switching to another profile (for example a managed child's), never stops an
  upload or import. After a crash, reading resumes automatically once the person unlocks.
- Reviewing while reading continues is allowed but not required, provided accuracy holds.
- Bulk review must be easy (import all, discard all, filters beneath the kind filters); the exact
  shape is to be tested.
- "Already saved" needs the same test, matched semantically (a standard code or a confirmed
  equivalence, with abbreviations such as Hgb matching Hemoglobin), the same date, and equal values
  after unit conversion at the printed precision.
- A correction shows the later-issued version on charts; the older one is marked outdated, off the
  trend line or hidden, and listed below. When confident, this happens automatically.
- A relative's records are kept as reference: no clinical results for Self, a People entry, a note
  for each document that refers to the person, and no prompt for the optional relationship.
- Clinical records need a date (supplied by the person if not printed) or are dismissed; dismissing
  keeps the original. People records need no date.
- Imported clinician notes appear in Notes.
- Every file the person chose to upload is read and kept.

### Gaps

| Specification area            | Today (verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Gap                                                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic reading             | Reading is an explicit "Read file with Moxie" step after upload ([import and rebuild](import-and-rebuild.md))                                                                                                                                                                                                                                                                                                                                                                                             | Start automatically for supported types                                                                                                                                                                                   |
| Progress and estimate         | Import shows sections accounted for (plan units, not pages), entries found, windows read, the recent page interval and time since last progress ([reading activity](../src/app/features/import/ImportReadingActivity.tsx)). Page timing is typed "never an ETA" ([batch types](../src/shared/intake-batch.ts))                                                                                                                                                                                            | Add page progress and a time estimate; `remainingUnits` exists but is not shown on Import                                                                                                                                 |
| Provider limits               | No backoff design; T15 is the brief                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Backoff, retry and estimate update                                                                                                                                                                                        |
| Leaving is not stopping       | Browser close or session loss does not stop reading. Unlocking another profile locks all others ([vault app](../src/server/vault-app.ts)); locking zeroes the key, closes the app and pauses the batch ([encrypted profiles](../src/server/encrypted-profiles.ts), [intake batches](../src/server/intake-batches.ts)). The data key exists only in memory; stored copies are wrapped by passkey or recovery secret ([profile encryption](profile-encryption.md)). There is no sign-out distinct from lock | Keep a profile with background work open after switching; needs a security review because two decrypted profiles would be open unattended ([security](security.md) states one-at-a-time as intentional). Overlaps CRS-081 |
| Automatic resume after unlock | After a crash, the batch is paused as interrupted and model work never restarts without explicit Resume                                                                                                                                                                                                                                                                                                                                                                                                   | Resume on unlock                                                                                                                                                                                                          |
| Unattended finishing          | Time and context limits pause reading; about 12 Resume clicks are modeled for 800 pages                                                                                                                                                                                                                                                                                                                                                                                                                   | R2, R8 (candidate C)                                                                                                                                                                                                      |
| Already-saved matching        | No test-name equivalence: series are keyed by exact code system, code, label, category, unit, specimen and method ([clinical import](../src/server/clinical-import.ts)). Related-record discovery ranks by exact code, label and shared words ([related records](../src/server/related-records.ts)). Mapping rules rename by exact label only                                                                                                                                                             | Semantic test match with confirmed equivalence rules, standard display names, alias search index; cross-original cue (OI-27) and buckets (OI-41)                                                                          |
| Unit conversion               | Same-dimension conversion for unambiguous codes only; bare "oz" is ambiguous; no mg/dL↔mmol/L ([measurement units](../src/shared/measurement-units.ts)); conversion changes chart display only                                                                                                                                                                                                                                                                                                            | Conversion used for matching; per-analyte factors for a short list (open)                                                                                                                                                 |
| Corrections on charts         | Both versions plotted unless a pair-review display preference hides one; the server never picks the newest ([comparisons](../src/app/data/comparisons.ts))                                                                                                                                                                                                                                                                                                                                                | Later-issued version displayed automatically when confident; older marked outdated                                                                                                                                        |
| Relative's records            | Clinical rows about another person are blocked and stay pending ([intake workflow](../src/server/intake-workflow.ts)). People proposals need a passage naming the person; relationship is optional; relative lab values are not turned into history ([People format](../src/server/intake-people-format.ts))                                                                                                                                                                                              | File as reference automatically; summarize into the person's history; one note per referring document                                                                                                                     |
| Dates                         | A missing date raises a non-blocking question with "Keep unconfirmed"; undated records can be saved ([intake review](../src/server/intake-review.ts)); undated and partial-date points are not plotted. An unreachable "Resolve the date question before saving" message remains ([Import page](../src/app/features/import/ImportPage.tsx))                                                                                                                                                               | Require a date for clinical records or dismiss; remove the dead message                                                                                                                                                   |
| Clinician notes in Notes      | Clinician notes become Document records under Sources; Notes' history view includes only 24 structured document types ([historical notes](../src/server/historical-notes.ts))                                                                                                                                                                                                                                                                                                                             | Show imported clinician notes in Notes                                                                                                                                                                                    |
| Medications                   | Imported medications start Inactive; the person activates what they take; personal choice is never overwritten ([medication preferences](../src/server/medication-preferences.ts))                                                                                                                                                                                                                                                                                                                        | None, if the owner keeps it; optionally list only newly imported medications in the activation prompt                                                                                                                     |
| Formats                       | PDF, PNG, JPEG, WEBP, ZIP, JSON/JSONL recognized; others stored as generic binary                                                                                                                                                                                                                                                                                                                                                                                                                         | OI-08, OI-09                                                                                                                                                                                                              |
| Identity                      | Birth-date mismatch blocks after extraction; name-only match passes; differing name with no hint blocks                                                                                                                                                                                                                                                                                                                                                                                                   | CRS-111, OI-40, CRS-090                                                                                                                                                                                                   |

### New open issues

| ID    | Issue                                                                                                  | Status          | Next step                               |
| ----- | ------------------------------------------------------------------------------------------------------ | --------------- | --------------------------------------- |
| OI-43 | Keep a profile with background work open after sign-out or profile switch                              | Open (decided)  | Security review; design with CRS-081    |
| OI-44 | Semantic test equivalence, standard display names and a per-profile alias index; shared list licensing | Open (proposed) | Owner review; check LOINC terms         |
| OI-45 | Page progress and time estimate on Import                                                              | Open (decided)  | Design; estimate method from T2/T3 data |
| OI-46 | Relative's records filed as reference with a People note per referring document                        | Open (decided)  | Design with CRS-085                     |
| OI-47 | Required dates for clinical records; partial dates                                                     | Open (decided)  | Owner answer on partial dates; design   |
| OI-48 | Imported clinician notes appear in Notes                                                               | Open (decided)  | Design                                  |
| OI-49 | Bulk-review layout usability test on fictional fixtures (T24)                                          | Open (proposed) | After OI-27                             |

### Identifiers (eighth pass)

Next free: candidate M, theory T25 (T24 is the proposed bulk-review test), issue OI-50.

### Addendum: second round of owner answers and vocabulary research

Answered 2026-09-25, after the gaps above were written. The specification carries the requirements;
this records what they change here.

- **Stopping.** Signing out never stops imports. The only stop is a **Stop imports** button on the
  Import page, and a stopped import resumes where it stopped (OI-52). This settles the
  specification's "lock now" question: nothing stops reading except that button. OI-43 is unchanged
  and still needs its security review.
- **Estimate.** "Estimating…" until a few pages finish, then a range such as "about 2–4 hours" from
  the measured pace, recalculated after every wait (OI-45).
- **Medications are additive.** After an import, the approval list shows only medications not
  already on the person's list, matched brand ↔ generic. Those switched on join the list; those left
  off stay as history, not taking. A new document never removes or deactivates anything. The
  owner's example: with Advil and valacyclovir on the list, a document listing B12 and D3 shows only
  B12 and D3; switching on B12 yields Advil, valacyclovir and B12 (OI-50).
- **Bulk review default.** Within each kind (notes, people, test results and so on): "Select all",
  then Approve or Dismiss. Layout beyond that default waits for T24 (OI-49, now deferred).

**Medications gap, corrected.** The gaps table row above says "None, if the owner keeps it". That no
longer holds. "Activate prescriptions" sets the Prescriptions filter to every Inactive prescription
([clinical records](../src/app/pages/ClinicalRecords.tsx) `startActivation`), so a medication the
person left off after one import reappears after the next, and nothing in the tree matches a brand
to its generic (no RxNorm or equivalent). Verified in the tree on 2026-09-25.

**Standard vocabularies exist, are free, and can be bundled (OI-44).** Checked 2026-09-25 against the
publishers' own pages:

| Source                                                                                                  | Covers                                                                               | Access                                              | Terms                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [LOINC](https://loinc.org/downloads/)                                                                   | Lab tests and observations, with short, long and consumer names                      | Full table download with a free account             | [Free, redistributable with attribution](https://loinc.org/kb/license/); core fields unmodified |
| [LOINC Top 2000+ Lab Observations](https://loinc.org/usage/obs/)                                        | The tests behind about 98% of US lab result volume; US and SI unit versions          | Free spreadsheet                                    | LOINC license                                                                                   |
| [NLM Clinical Tables LOINC API](https://clinicaltables.nlm.nih.gov/apidoc/loinc/v3/doc.html)            | LOINC search including consumer names                                                | Free web API, no key                                | NLM terms                                                                                       |
| [RxNorm Current Prescribable Content](https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html) | Drugs prescribable in the US, including many over-the-counter; brand ↔ generic links | Monthly download, no UMLS license needed            | NLM terms                                                                                       |
| [RxNav APIs](https://lhncbc.nlm.nih.gov/RxNav/TermsofService.html)                                      | RxNorm lookups                                                                       | Free web API, no key, 20 requests per second per IP | Attribution required                                                                            |

Supplements such as B12 and D3 may be missing from the prescribable subset; that is unverified and
should be checked against the download before OI-50 relies on it. The online APIs would send the
person's test and medication names to a third party, which is why OI-51 proposes bundling the
downloadable subsets and looking them up locally.

### Identifiers (eighth-pass addendum)

Next free: candidate M, theory T25, issue OI-53.

### Addendum 2: remaining specification questions settled

Answered 2026-09-25. The specification is now one compact document with no open questions; only the
bulk-review layout (OI-49) stays deferred.

- **Per-substance units.** Convert mg/dL ↔ mmol/L only for a checked list: glucose, total, HDL and
  LDL cholesterol, triglycerides, creatinine. Others in differing unit systems stay separate.
- **Partial dates (OI-47).** A full date is required. A year-only or month-and-year date is proposed
  as the first day of its period ("2019" as 1 January 2019) for the person to approve or change,
  with the printed date shown as printed.
- **Vocabularies (OI-51).** Bundled offline. The AI reader may suggest a standard name; it counts
  only if found in the bundled list. The specification adds principle P16: health terms are never
  sent to a lookup service.
- **Stopped medications (OI-50).** An explicit stop in a document offers "mark as not taking?" for a
  medication on the list; nothing changes without approval.

## Owner decision — complete text extraction, 2026-09-26

Complete text extraction is required, including administrative and repeated text that creates no structured clinical record. See the [product contract](import-scenarios.md#complete-text-extraction) and open [CRS-115](application-todo.md#crs-115). Preserved originals, successful page reads, temporary model exposure and correct clinical findings are individually insufficient: readable text must be durably retained, source-located and available to authorized search/assistant retrieval without new AI extraction. Unreadable regions remain explicit exceptions, never invented text.

This settles the completeness question left open by the four-hour investigation. F9's thirty-three administrative pages omitted from proposal text now identify a relevant unmet requirement, not an acceptable omission simply because their clinical yield is zero. The measured endpoint examined proposal payloads; it does not mandate that all text live inside clinical proposals. A separate durable complete-text representation can satisfy the product requirement and support bounded model requests. Historical F8/F9 scores remain unchanged; no new implementation or verification is claimed.

A/B/G may compact working context only while preserving and retrieving complete durable source text. K may use compact facts as an intermediate working representation, but cannot make them the sole retained extraction. J's adapter choice must cover all readable text, including visible text missing from a PDF text layer, while respecting retain-only format exclusions. H may remove redundant instruction copies without deleting document content. Revised L may label repeated passages but must preserve complete text coverage for each distinct imported original. Strategy qualification must test durable text completeness separately from clinical accuracy, context size and page traversal.
