# Selected intake views

The schema collection reader exposes records, ordered child scopes, point joins,
and addressed JSON fragments. A child page is never a complete workflow. Public
candidate, version, plan, member, and record IDs keep their existing spelling;
internal occurrence addresses distinguish retained duplicate occurrences.

These APIs apply to an intake whose selected envelope has been converted to the
schema collection representation. Legacy materialized readers remain separate.
The reader checks the selected source and logical root and rejects detached or
stale addresses. Auxiliary progress, operation receipts, and derived indexes do not change
the logical root or clinical review version.

## Workflow counts and joins

`readVerifiedWorkflowSummary` returns exact counts only when the selected summary
manifest matches current source, logical, effective-version, mapping, and count
policy pins. It also checks the authenticated contribution map root and count.
Otherwise the result is pending with `counts: null`. It does not rebuild counts
on an interactive read or treat a missing index as an empty workflow.

`buildVerifiedWorkflowSummary` is explicit cold maintenance. It streams complete
candidate/version, question, plan/unit, and failure scopes. It writes bounded
checkpoints and yields between batches, including within long version and attempt
histories. Contribution facts are retained per candidate, question, and plan;
implicit package units accumulate into the plan fact instead of creating a
derived row for every inventory member. The implicit provider must return the
complete declared unit count and verify batch/attempt receipts. A role assignment
alone is not an accounted unit.

The cold build also retains complete reverse joins from public version and
candidate IDs to their addressed occurrences and questions. Per-version facts
retain each candidate's pending-version aggregate. These proofs let the native
proposal participant update one version without rereading that candidate's
history. A changed latest version reevaluates every dependent question, including
questions beyond the current UI page. Duplicate public IDs retain their exact
first/last occurrence semantics. Additional source-context dependency changes
are supplied as a complete streamed set of affected version IDs.

Semantic indexes are selected atomically after their complete build. Their
manifest binds the logical root and index policy. Joins preserve retained
first/last selection rules, including empty assignment target lists, latest
version questions, receipt precedence, and duplicate public IDs. Unit accounting
uses the exact plan and unit occurrence, its own attempt membership, and a
matching retained coverage receipt. SQL-compatible source lookup indexes use a
separate first-property reader for retained raw JSON; ordinary workflow reads
use JavaScript-compatible last-property selection.

Saved-record destination lookup checks both the requested attribution group and
unscoped records. It selects current import records first, then import history
from latest to oldest, and retains forward record order within a receipt. It
returns at most one destination for each requested record ID. Incomplete indexes
raise an unavailable result rather than asserting that no destination exists.

The dependency recount reducer accepts a checked, complete affected-key closure.
It exposes exact totals only after all contiguous closure pages have been applied
and the target binding still matches. A domain change makes older facts pending;
the caller must publish the corresponding checked closure or explicitly schedule
cold maintenance. The native proposal participant forks the selected immutable
fact and semantic-index maps, stages bounded changes and disk-backed affected
question scopes, then returns the auxiliary selections to the host's final
domain transaction. A package batch supplies the change in verified unit
accounting for at most fifty coverage entries. SQL-compatible discovery indexes
update from newly appended groups. This participant is specific to the owned
proposal and package-batch mutation family; it is not an arbitrary mutation
retagging API. Without the prior complete dependency proof, a new domain remains
pending. An interrupted preparation keeps the old selected counts unchanged.
The cold builders retain unselected checkpoint evidence after
interruption; a new cold invocation starts a new build, and completed matching
builds are reused.

## Model context protocol

The selected model API has its own `health-intake-model-context-request-v2`
discriminator. A fresh request uses `freshStart: true`; continuation uses the
returned cursor with the exact effective version and mapping version. Legacy v1
offsets retain their original meaning and are not accepted as v2 cursors.

Each cursor binds source, logical domain, source-text pin, mapping policy, section,
and addressed scope. Auxiliary maintenance does not invalidate it. A changed
binding, wrong section, or detached address is rejected. Section indexes preserve
ordered logical entries and checked totals. Nested records expose their own
explicit complete child scopes; large values use directly addressed UTF-8-safe
JSON fragments. Record fragments are not obtained by rebuilding and skipping an
entire section.

Responses stay within a fixed byte envelope. Section and child pages request at
most eight entries, field fragments request 4 KiB, and the whole context response
is checked against 40 KiB. A section without a matching complete index reports
`logicalTotal: null` and pending state. Current units and external mapping rules
also need their checked providers; unloaded scopes are never represented by
empty legacy arrays. The implicit package unit provider derives at most eight
ordinal units from the verified inventory and returns explicit metadata
references within a 10 KiB page budget. Its total comes from the selected
inventory descriptor; it creates no per-unit model section index. Actual retained
batches use the checked ordered section map; missing-asset scopes still require
their own checked provider. Legacy schema
plans retain their explicit ordered child collections.

Selected v3 section manifests point to immutable maps ordered by retained
ancestry ordinals. Appending a version or answer beneath an earlier parent does
not renumber later entries. Typed proposal, question, metadata and acceptance
participants share unchanged entries, add the changed addresses and retag the
complete manifests in the same final domain transaction. Dictionary failure
entries use JavaScript integer-key and first-insertion order. The explicit async
model preparation entrypoint performs a cold rebuild only when these proofs are
absent; a normal section read does no preparation. Old v2 sequence manifests
remain readable but need explicit preparation before using the warm map updater.

## Selected reading progress

Native manual source-record creation uses the selected source header and an
operation-to-first-proposal index. Historical duplicate operation IDs retain
the first matching receipt's replay semantics. Publication rechecks the chosen
person and source-text revision, and the result opens the selected clinical
review without accepting a record. Copy/rebuild tests retain the historical
manual author receipt, including one receipt larger than a display page's byte
budget; that existing single-value decode boundary is independent of package
history cardinality. Literal source previews read the original window directly
without hydrating the workflow.

Native assistant draft-repair chats retain at most eight selected rows and
prepare their clinical dependencies before provider dispatch, including after
cache loss. Tool calls remain restricted to the selected original windows and
supported draft fields. Applying the reviewed repair uses an asynchronous
facade and an addressed operation receipt; exact replay does not repeat the
mutation. Synchronous legacy repair calls remain supported. The production
assistant regression covers native startup, retry, continued conversation,
original-evidence reading, preview, apply and replay.

Source-reader observations retain exact active-plan occurrence order, including
historical duplicate unit IDs. A disposable index maintains pending, partial,
context, unreadable and stale totals and selects bounded relevant-unit pages.
Native recipe plans use implicit pending defaults; selected receipt decisions
alone create unit entries. Changed batches update their exact units, and plan
replacement changes the affected plan totals. Dependency receipts retain
reverse joins to observed page/span hashes, source pins, member source metadata
and package roles. Transactional temporary triggers and role-publication hooks
invalidate only the affected proposal/unit observations. An unrecognized
logical transition, changed database connection or missing trigger requires
explicit complete preparation; cancelled work never exposes partial totals.
The index is a cache, not reading or acceptance authority. Tests cover exact
occurrence pagination, unrelated versus dependent hash changes, cross-source
dependencies, sparse native batches and direct-plan replacement.

Native continuation has an explicit v2 checkpoint with scalar counters and a
source, session, plan and unit ledger reference. Seen windows, pending windows,
read scopes, complete JSON ancestors and deferred acknowledgments live in
authenticated auxiliary maps. No unloaded legacy checkpoint arrays are invented.
One acknowledged read forks the affected ledger and selects its new state and
session totals atomically. A cancelled preparation leaves the old selected state
intact; cache recovery follows the accepted auxiliary graph. Ledger writes do not
advance the clinical version. Source or plan changes require reopening the unit
capability under current pins.

Manual child-source batches select the child's actual plan and source pins while
checking acknowledged reads in the parent's conversation ledger. Child PDF
pages and pending windows are checked separately from the package-member
coverage; a child receipt does not complete its parent. A disposable pending
window index supports exact source/page, unit and text-range checks. Its cold
preparation yields in bounded batches, and acknowledged reads update only their
changed windows. Cache loss rebuilds from native and imported legacy ledgers;
an interrupted preparation cannot establish an empty scope. Package inventory
metadata does not count as a literal member read.
Acknowledged child reads also retain a source-hash-bound pointer to their parent
unit in the session map, so switching units or rebuilding the cache does not
substitute another unit's reading evidence.
A legacy parent conversation can also open a native child plan: coverage uses
that actual child's selected units against the retained legacy read checkpoint,
without synthesizing a parent plan or treating old completion IDs as evidence.
Child text and HTML coverage require an acknowledged direct child read or the
exact selected child-unit read, with its required continuation windows exhausted.
An unread child does not become complete just because only its parent member has
pending windows. Cold pending-index cleanup and rebuilding both yield in bounded
batches; an interrupted or superseded preparation cannot publish a partial index.

Resuming a migrated chat explicitly imports its retained checkpoint before the
provider starts. Creating a native plan during an already running legacy turn
uses the same import before another read or completion; usage and progress
callbacks then share the native checkpoint. The import preserves seen and read-scope hashes, complete JSON
scope evidence, supplied JSON descriptors, pending windows, ordering and scalar
model counters. Old completed/accounted unit IDs remain historical metadata;
they do not create extraction coverage. A complete cold routing pass assigns
each pending window to the actual selected plan occurrences using the old
coverage predicate. Unmatched windows remain visibly pending. Cancellation
leaves the prior selected session intact, and retry recognizes the completed
source/session import without rehashing its history.

Replacing a plan extends those target indexes from the retained hashes and
windows before the new unit can resume. It preserves session totals and prior
targets, and publishes the added targets atomically. A missing target index is
an explicit preparation requirement, never an empty reading history. The last
displayed window is retained separately and can supply resume context; it does
not establish that the model consumed the window.

Selected session headers provide exact seen-window and distinct-read totals.
New headers also maintain pending-window totals atomically with unit receipts;
older headers without that field expose an explicit unavailable total until
complete preparation. A session aggregate does not assert an all-session intake
total.

Resume responses expose at most twelve pending windows within an 8 KiB window
budget. Larger request metadata has an addressed reference. Deferred results do
not count as consumed evidence until acknowledgment. Extracted coverage checks
the selected ledger for each of at most fifty explicitly claimed units; reading
alone never supplies a terminal extraction receipt. Retained direct PDF units
use a prepared unique-page index and ranked read membership, preserving duplicate
page semantics without queuing every document page. Their complete metadata uses
an addressed model record cursor. Embedded assets require a retained source/hash
grant from the acknowledged parent evidence.

Direct-source recipe plans participate in the same exact workflow counts,
ordinal model unit pages, per-unit ledgers, and batch scopes as package recipes.
Their bounded decoded plan headers use at most 32 cached lookup keys per database.
Reuse requires the exact source and owner, unchanged SQLite change/data/schema
versions before and after reading, and the same disposable collection-cache
generation. Cache loss or any projection change rebuilds the header; reads inside
transactions neither reuse nor populate it, so a rolled-back temporary repair
cannot establish authority. Cached headers and exposed reader objects are frozen;
accessed collection pages continue through their existing authority checks.
Their fixed unit metadata carries a direct-source reference; shared headings and
the original source index remain explicit scopes. The selected direct plan
pointer avoids scanning historical plan headers on ordinary reads. Cold recipe
preparation and complete count rebuilds remain explicit asynchronous operations.

Mapping policy values can use external fragment cursors within the version 2
model context protocol. These cursors bind the same source, logical, and mapping
pins as record cursors, and resolve through the selected policy provider rather
than asserting authority over an envelope record.

Internal assistant events use an explicit selected source header containing
source/version pins, bounded filename, provider, active plan, candidate count and
durability. They do not reconstruct public collection-summary counts on each
model event, and the smaller header does not represent omitted collections as
empty. The public source summary remains a separate projection.
Within one synchronous model-event callback, continuation and progress decisions
share one complete reading projection. A write or asynchronous boundary requires
a fresh projection; repeated scalar checks do not reopen the same reading scope.

The coordinator's current-interpretation check retains at most eight scalar
results per database, without materializing proposal IDs. Reuse requires the
same owner, source/version pins, collection-cache generation and SQLite
change/data/schema versions. Transactions discard prior results and never
populate the cache; rolled-back dependency repairs therefore cannot leave a
positive interpretation witness. Returned results are detached from the cache.

Assistant startup prepares native plan and reading capabilities before provider
dispatch. Explicit unit/member reads in a manual conversation select that
unit's ledger; automatic processing retains its dispatched unit boundary.
Standalone proposals and extraction batches use the same native publication
path and return a summary with selected-page links. Neither response fabricates
legacy workflow collections.

Attribution counters use addressed auxiliary entries. Migrated chats retain
their earlier totals, per-scope measurements, omitted-count metadata and repeat
read counters. The diagnostic export includes at most 4,096 scopes with explicit
omission counts, while its totals remain complete. These measurements do not
grant reading coverage or acceptance. Its source metadata uses a separate
diagnostic interface with lazy, sized collections, including actual implicit
package units. The export shares a 50,000-item work budget across joins and page
associations. Native projections also limit scalar fields to 8 KiB and projected
metadata to 8 MiB. Oversized fields, missing prepared plan capabilities or an
exhausted budget mark yield and scope completeness unknown; an omitted history
is never presented as an exact zero. The legacy yield oracle and a real native
package diagnostic HTTP export exercise the same counter and association logic.

A package remains one root delivery in a
processing batch regardless of its member count. Processing batches can still
grow through repeated appends of separate root deliveries; the selected batch
response retains that existing whole-item-list boundary. The per-request
100-root selection limit is not a total batch-size limit.

Processing exceptions suppress automatic reading without changing pending-work
counts or claiming coverage. A plan-addressed logical catalog selects nested
exception and skipped-unit maps; these remain disjoint from terminal accounted
units. Explicit retry streams all active retained units, deletes their exception
fields and selects empty map references through one catalog adoption and one
domain version, including when more than 64 plans are active. Empty references
prevent old fallback state from reappearing after cache recovery.

Acceptance preparation updates exact decision joins and complete dependent
candidate/question scopes before exposing new counts. The old current import
receipt moves intact to the end of history, retaining descendant addresses and
its precedence rank; only newly imported records need destination-index writes.
Coupled blocks retain each intermediate receipt at its actual history ordinal,
with the final block as current, so scoped and unscoped destination precedence
matches the complete historical reader.
Exact resulting review state may require a second preparation of the same
changed dependency closure. This does not repeat the clinical projector or scan
unaffected history, and only the final domain and proof roots are published.

An in-flight native model batch can retry its unchanged payload after one
disjoint counted acceptance only with the opaque acceptance-transition proof.
The proof covers the exact owned SQL changes, selected source and domain roots,
the accepted receipt's original journal sequence, and the host request's model,
generation, source and reading bindings. Verified auxiliary acknowledgments may
follow that acceptance without replacing its receipt sequence. An unrelated
ordinary write, overlapping candidate, changed source or changed request refuses
the retry. Focused fictional assistant tests exercise deferred-read acknowledgment
after public approval, successful unchanged retry and replay, and refusal when an
unrelated write occurs at the final retry callback. These tests do not replace
the separate large-history, encrypted recovery or physical release qualifications.

## Original evidence and navigation

The public plan endpoint returns the existing `IntakeSummaryV2` for selected
native sources, including its exact or pending active-plan header and collection
counts. It does not expose a partial legacy workflow. The literal read endpoint
returns that same intake summary beside the requested original window. Package
inventory and member endpoints select their existing version 2 responses, with
bounded member metadata and addressed references; migrated legacy package plans
prepare their source-bound compatibility indexes before these reads. Sources
that still use legacy authority retain their original response contracts.

Host-selected package evidence reads use a compact source header and literal
window API. They do not construct an intake workflow to read a retained child.
Source-text capture finishes before the returned pins are selected; retain-only
sources keep the same interpretation restriction. Direct PDF reads, package PDF
fallback, page rendering, and embedded-asset behavior retain their existing
policies. An unconverted source returns an explicit pending model scope and does
not migrate as a side effect of a read.

Native navigation uses a separate cursor bound to the source and selected index.
Both the public navigation endpoint and assistant search/follow dispatch use
this contract for native sources. Continue a search with `nextCursor` as `cursor`,
without a legacy offset; a changed query or source/index selection rejects the
old cursor.
Search inspects at most eight indexed sections or source transitions per page;
a partial page can contain no matches without claiming complete absence. PDF
search extracts only the requested indexed page under the existing per-page
text budget. Following a reference requires checked reference/owner membership,
and duplicate anchors remain ambiguous. External references are never fetched.
Local HTML targets preserve the first retained sibling match and JavaScript's
last duplicate filename property, then consult a complete selected package name
index. Missing native indexes report pending rather than scanning a workflow.

Public streamed uploads and plan/proposal creation select native authority
before new processing. Native HTTP evidence, package, navigation, model and
review readers dispatch to these bounded contracts. Complete-object legacy
adapters retain their compatibility limits. Focused consumer checks and
[storage qualification](intake-state-storage.md) cover the named paths; they do
not establish installation capacity or replace the physical and supported
[release update](../setup/release-updates.md) qualifications.

## Selected clinical review and projection

The native clinical host authenticates the retained original and complete bounded
JSONL proposal before selecting historical candidate, report, draft, decision,
identity and source-confirmation evidence. It uses the existing clinical and
identity decision logic through complete selected providers. A display page is
never the clinical scope. Legacy JSONL proposal limits remain unchanged.

Prepared report membership uses complete per-version immutable maps. First
member and first introducing-version precedence remain distinct from union
occurrence membership across duplicate historical members. Native cumulative
versions share the predecessor map and add only the compiler's changed
occurrences. The complete prospective proof is selected with the domain command;
missing prior preparation remains pending rather than triggering a read-side
history walk. Older membership proof policies require explicit cold preparation.

`health-intake-clinical-review-page-v2` pages records, source context or coverage
gaps with the exact review and record selection tokens. A page contains at most
100 items and requests at most 256 KiB of item data. Large records retain an
addressed reference; fragment reads return exact bytes as base64 so splitting a
Unicode character does not change the evidence. Missing native preparation and
oversized policy metadata remain explicit unavailable/fragment results rather
than partially populated legacy workflows. Naturally large identity receipt
target lists use complete selected membership reads without decoding the whole
receipt.

Native question review carries the latest complete answer as its policy witness
and an explicit answer-history count and source-bound fragment reference. Prior
answers remain inspectable through bounded evidence windows, including unknown
fields and numeric spelling. The native review token preserves the legacy
canonical recipe: it streams the complete answer history without collecting it
in the selected record. This hash still reads historical bytes; the
`reviewQuestionTokenBytes` counter records that work separately. Preparation
stores each immutable canonical answer once, and an answer command adds only its
new tail while selecting the new question state with the domain mutation.
Display history is never substituted for an answer or a decision authority.

Draft resolution policy likewise reads all latest, last-known and last-Self
witnesses from the selected immutable history. A large witness set has an explicit
`resolutionsReference` count instead of an incomplete inline array. Exact ordinal
deduplication and sorting use private disposable SQLite; each iterator closes its
scratch database on completion or abandonment. Current issue lookups read the
source-bound policy index directly. The legacy review-token recipe streams the
complete ordered witnesses, including retained unknown fields and literal values.
The displayed history remains independently pageable. Saving another answer
appends only its new resolution; it does not copy prior witnesses into the new
draft. A single oversized resolution still requires the existing fragment view.

An accumulated question list has an explicit complete selection reference when
its inline representation exceeds the display budget. Policy iterates that
selection; it does not substitute the first page or an empty list. Derived issues
use connection-local indexed rows with exact order and issue-ID lookup. Resolution
and identity transformations update individual scratch rows, and stale question
answer resets use indexed flags rather than retaining one closure per issue.
The selected-record API exposes bounded `questions` and `issues` sections and
routes large scopes through the reference controls. The complete last-page
blockers remain part of acceptance and the legacy review-token recipe.

Each held clinical session has its own issue scratch run and an explicit close
operation. Concurrent sessions cannot rewrite each other's policy. Closing a
session releases only its run; authority changes invalidate old generations,
and missing scratch is refused instead of treated as no blockers. The issue
row/read/write and peak-value counters distinguish this disposable policy work
from durable writes. The derived issue collection is never recovery authority.

The host can prepare clinical projection as an opaque changed-row plan. It runs
the existing projector synchronously inside a SQLite savepoint, captures the
exact result and row changes, then rolls back before asynchronous envelope
preparation. This stage publishes no clinical writes. The final ordinary
transaction checks the selected review and application dependencies, applies the
captured changes with conflict abort, then publishes the corresponding envelope
and accepted journal result. Only a verified auxiliary-maintenance outcome can
advance the preparation baseline; a caller-supplied actor label cannot do so.
The plan must be disposed after application or abandonment. SQLite remains a
disposable staging surface, not recovery authority.

`health-intake-report-record-page-v2` currently provides a per-intake clinical
record slice with complete historical membership, queue state and selection
authority. It does not assert that people, reading activity or report-wide
actions are fully represented by that page. The native client uses separate
People, reading, report and selected-record APIs. Large clinical values expose
exact fragments and sparse question, mapping and relationship commands;
approval retains the selected complete decision under both current review
tokens. Retrying an uncertain command reuses its exact operation and request.
