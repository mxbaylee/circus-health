# Processing context and unattended continuation proposal

Review addendum dated 2026-09-24. Status: design for independent review; no processing behavior
changed. [CRS-039](application-todo.md#crs-039) and [CRS-086](application-todo.md#crs-086) own the
requirements and status. This is not a second backlog or a completed provider qualification.
The earlier CRS-086 text and deployment options remain as historical rationale; the corrections
below supersede their unsupported premises, not the evidence-preservation requirements.

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
