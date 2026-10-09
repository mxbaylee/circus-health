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

Native record-text streaming shares one authenticated collection read within each
synchronous iterator advancement. The private cursor returns the existing exact
lexical chunk only after its source, accepted-HEAD authority, selected collection,
SQL/TEMP witness, registry and read epoch checks close. No active read certificate
or tree-access port survives a yielded chunk. Existing bounded lexical and order
buffers remain unchanged, as does the 128-node collection cache; this does not
prefetch later chunks or introduce a whole-record or whole-history cache.
The consuming operation still owns its original-file lease and physical checks.

Unchanged logical selections can continue after derived maintenance under a new
read admission. Transactions, custom readers and replaced reader methods keep
the checked point-read path. Once a cursor takes that fallback, its buffered
state cannot re-enter the native authenticated path. Reentrant advancement and
failed admission close the native cursor without exposing its pending chunk.

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

Queue refresh may reuse the effects of an exact selected logical transition
chain. Missing or cyclic disposable transition rows select complete preparation
instead; cycle detection retains constant additional memory without a history
length cap. Equal roots have no changed effects. The effect iterator refuses a
database write between chain validation and iteration, and its recursive query
is bounded by the validated chain length. These temporary rows remain an
optimization, never accepted evidence or recovery authority.

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
invalidate only the affected proposal/unit observations. Dirty keys coalesce
without relying on conflict policies inherited from an outer UPSERT; every
actual change still advances the generation, and rollback restores both.
An unrecognized logical transition, changed database connection or missing trigger requires
explicit complete preparation; cancelled work never exposes partial totals.
The index is a cache, not reading or acceptance authority. Tests cover exact
occurrence pagination, unrelated versus dependent hash changes, cross-source
dependencies, sparse native batches and direct-plan replacement.

Native continuation has an explicit v2 checkpoint with scalar counters and a
source, session, plan and unit ledger reference. Seen windows, pending windows,
read scopes, complete JSON ancestors and deferred acknowledgments live in
authenticated auxiliary maps. No unloaded legacy checkpoint arrays are invented.
One acknowledged read forks the affected ledger and selects its new state and
session totals atomically. Concurrent ledger publications for the same database,
source and session are serialized, including imported target preparation and
deferred acknowledgments. Source reads remain concurrent. Queue admission
rechecks cancellation, authorization and the selected source/plan capability;
the queue retains no idle session keys and does not certify changed evidence.
A cancelled preparation leaves the old selected state
intact; cache recovery follows the accepted auxiliary graph. Ledger writes do not
advance the clinical version. Source or plan changes require reopening the unit
capability under current pins.

A manual conversation can read a retained descendant original directly without
creating a child plan. Before source I/O, the host obtains an opaque capability
for the issuing database, root, session, parent plan/unit, child original hash
and complete retained ancestry. Publication rechecks that ancestry and the
parent's exact logical/domain authority; source capture may advance the separate
material-text pin without changing this original-byte authority. Each queued
receipt still checks its current effective version and authorization. The pinned
child route survives deferred acknowledgment and cache loss, and reuses its
parent unit even after another unit is displayed. Child reads never count as
parent reads or manufacture extraction coverage. Automatic dispatch and package
member reads retain their existing unit and occurrence restrictions. Focused
tests cover concurrent reads, Stop, foreign sessions, changed ancestry/originals
and parent-domain changes, plus actual manual reading and retained plan history.

Literal progress totals (retained candidate versions and submitted batches) bind
to the complete logical workflow index. Source-text or mapping changes leave
those historical totals intact while classified review and remaining-work
summaries still require their current source and policy bindings.
Native proposal publication maintains a separate literal reading projection when
classification is pending. It shares a verified complete prior index and updates
only the compiler's appended candidate/version, content-digest and batch scope;
occurrence-only updates do not add versions. Its exact prospective logical
binding is selected with the proposal. Missing or stale proof remains pending
until explicit cold preparation, and this projection cannot establish clinical
readiness. Cancelled preparation does not select its counters.
The in-process effect capability is issued by the existing native proposal and
batch compiler, with immutable affected occurrences and exact before/after roots.
New mutation composition families need their own complete effect proof.

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
Decoded assistant headers retain at most 32 entries and 256 KiB of encoded
headers, source bindings and keys per database. Reuse requires unchanged exact
SQLite, collection-registry and policy epochs, current profile/source and
logical/material pins, and a fresh physical accepted-authority check. Transaction
reads clear and bypass this memo; missing or pending plan headers are not cached.
Values are frozen, and cache disposal, rollback or authority failure requires a
fresh selected read. Progress presentation reuses its selected scope while
keeping the first pending unit's label separate from a manually selected resume
unit; it does not resolve the same unit again through historical plan lookup.
Within one synchronous model-event callback, continuation and progress decisions
share one complete reading projection. A write or asynchronous boundary requires
a fresh projection; repeated scalar checks do not reopen the same reading scope.
Retained expanded plans additionally reuse at most two positive unit scopes per
database under the same exact SQL/registry and current-authority checks. Their
256 KiB admission budget charges captured source, version and root metadata,
selected unit/address data and a conservative allowance for bounded reader heads.
The fixed reader/page-provider references hold point-lookup prefixes and counts,
not unit or page history arrays; shared storage caches retain their own limits.
Aggregate pressure evicts scopes, and oversized contexts use the complete cold
path. Pending-unit and explicit-unit keys remain distinct. Transactions, source
changes, cache disposal, failed authority checks and database closure discard
reuse; consumers still perform their normal admission and post-yield checks.
Direct and inventory-recipe package scopes continue through their existing readers.

Progress reuse checks count node lookups (raw node reads plus authenticated cache
hits) and SQL authority queries separately. Both must strictly decrease when a
pending work unit exists, while raw node reads must not increase. A fully warm
direct plan can legitimately make zero raw node reads on both paths; that is not
a regression. A no-reuse control must still fail these counted checks.

The coordinator's current-interpretation check retains at most eight scalar
results per database, without materializing proposal IDs. Reuse requires the
same owner, source/version pins, collection-cache generation and SQLite
change/data/schema versions. Transactions discard prior results and never
populate the cache; rolled-back dependency repairs therefore cannot leave a
positive interpretation witness. Returned results are detached from the cache.

Assistant startup prepares native plan and reading capabilities before provider
dispatch, including retained conversions whose source still uses the legacy
envelope. This preparation imports existing reading evidence before the first
model context. A retained ZIP plan also prepares its source-bound inventory
compatibility before native member reads, including pre-upgrade checkpoints.
A pending retained-plan index is prepared before deciding that
no active plan exists; prior superseded plans remain unchanged when a current
plan is created. A malformed proposal cannot change the checkpoint representation
while returning its repairable validation error. Explicit unit/member reads in
a manual conversation select that unit's ledger; automatic processing retains
its dispatched unit boundary.
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

Package inventory reads acquire their plan selection after successful inventory
preparation and any retained failure resolution. Resolving a failure can advance
the source's logical version; a plan selection captured before it remains stale
and must not supply the returned member states. A failed or cancelled inventory
preparation does not acquire a new plan selection.

The package browser's Previous members action follows the actual visited page
starts, since the response byte budget can produce fewer than 50 members. It
retains at most eight recent scalar offsets and no earlier member payloads, so
navigation metadata stays bounded independently of the number of visited pages.
After the retained history is exhausted, Previous members is unavailable and an
explicit message directs the user to First members. First members returns to the
start and clears recent history; it also remains available after a later page
fails to load. Profile, source and version changes reset navigation, and results
from an earlier scope cannot replace the current page. Returning through more
than eight earlier pages requires starting again; no guessed fixed-size backward
window skips or duplicates occurrences.

Host-selected package evidence reads use a compact source header and literal
window API. They do not construct an intake workflow to read a retained child.
Source-text capture finishes before the returned pins are selected; retain-only
sources keep the same interpretation restriction. Direct PDF reads, package PDF
fallback, page rendering, and embedded-asset behavior retain their existing
policies. An unconverted source returns an explicit pending model scope and does
not migrate as a side effect of a read.

For a selected native PDF, one evidence result can reuse its bounded model
summary and previously completed validation of its current source-text revision
during the same read. The private receipt follows that actual result. It retains
an encoded model summary of at most 16 KiB and fixed source, profile, mapping,
revision and accepted-head bindings; it retains no text graph, page history,
iterator or review session. Each model emission, including a later raster
fallback, receives freshly parsed values. The per-result bound does not bound
the number of live caller results.

The required source and model checks still run before worker I/O. A reusable text
receipt additionally requires completed validation of the current source-text
revision before worker I/O. Reuse rechecks cancellation, source and mapping
bindings, retained-original integrity and current accepted physical authority,
then the original raw database witness. A changed witness found before selecting
reuse takes the existing fresh path; failed verification or drift after selection
refuses the operation. No failed guard becomes a cache miss. A source-text capture
cannot certify its newly published revision using an earlier read. Legacy,
pending, unavailable and ineligible results retain their existing validation
paths and literal page, parent and embedded-child routing.

The `sourceTextReadCalls` work counter records entry into the public full
source-text reader, including unavailable and rejected attempts. It records an
attempt, not a completed graph validation. Same-database reconstruction keeps
its existing attribution, and a nested read for another database restores the
outer attribution before returning.

Matched fictional 4- and 16-page reads reduced native model-summary construction
from 8 to 4 and 32 to 16, and complete source-text validation from 8 to 4 and 32
to 16. PDF worker reads remained 4 and 16. These measured spans include evidence
reading and its actual post-read validation; they exclude setup and surrounding
assistant transport and plan work. Added binding hashes, raw witnesses, original
metadata checks, serialization and fresh parsing remain required work. These
counts establish a reduction in the named reads, not whole-import latency,
physical disk cost, recovery or provider qualification.

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
last duplicate intake object, parent binding and filename properties. Candidate
selection and the checked metadata must agree on both parent and name before
returning a sibling. They then consult a complete selected package name
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

Native clinical source-collision checks select every retained record exception
for each exact issuing identity through a disposable, checked decision index.
Dependency preparation builds that index cooperatively before selecting earlier
sources; subsequent lookups visit matching exception pointers rather than
rereading unrelated exception history per proposal entry. A previously prepared
index that loses its authority refuses selection; callers without a prepared
index retain the complete synchronous journal scan. This does not change the
broader cross-intake mapping, exception-selection and saved-record catalog
boundary in [CRS-235](../todo/CRS-235.md).

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
Native preparation checkpoints inside witness indexing and canonical traversal,
including skipped historical entries; yielding only after a draft is built would
leave the cold index construction synchronous.
The displayed history remains independently pageable. Saving another answer
appends only its new resolution; it does not copy prior witnesses into the new
draft. A single oversized resolution still requires the existing fragment view.

Within one selected clinical review, the mapping stage transfers its complete
draft to the policy stage through a one-use association with the actual record.
Both the original read and consumption require the same exact selected-source,
SQL, registry and grounding proof. A changed or unavailable proof uses the normal
fresh indexed read. This preserves registered history and canonical providers;
it neither clones their presentation references nor retains answers across
sessions. The association is private, is removed on consumption, and is released
when the scope closes. `reviewDraftReconstructions` counts actual selected draft
decodes and `reviewDraftHandoffs` counts successful transfers. This avoids a second
decode for a record even when the proposal contains more than 32 drafts; it does
not eliminate the complete historical policy and token reads.

Draft headers resolve each named field once and stream its exact selected lexical
bytes, including raw numbers, unknown nested fields and fragmented strings.
Missing fields remain distinct from JSON null. Traversal still checks the current
selected storage proof; it retains no decoded field values. Within that same live
scope, proposal source revisions use a separate memo bounded to 32 entries and
256 KiB including keys, preserving their exact null or absent state. Exact proof
drift, transactions, failed reads and scope close discard it. The first retained
proposal and existing dependency-token
fallback remain authoritative; candidate bodies and version hashes are always
computed afresh. `reviewProposalRevisionReads` and `reviewProposalRevisionHits`
count these metadata selections separately from complete policy reads.

The revision and durable-status readers reuse their prepared SQL statements per
database connection. They execute every original SELECT, retain both separate
revision observations and check the current storage's accepted head on every
status call. Reentrant SQL callbacks use a fresh statement; successful connection
close clears the retained statements. This is statement reuse, not a cached
authority result. The focused 25-status-call comparison eliminates 75 warm
statement preparations while retaining 75 SQL executions and 25 accepted-head
reads. It does not establish a complete clinical-workflow latency improvement.

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
Final inline issue selection and complete issue-token hashing use indexed point
reads with work checkpoints, including when the inline byte budget is exhausted.
Already-inline and empty policies also checkpoint so a long record sequence cannot
skip host turns.
During this finalization, no scratch SQL iterator remains open across a host turn;
cancellation or source invalidation refuses the attempt before publishing a partial
issue token or list.

Read-only record sections and their fragments share the existing one-session
public review cache with record and review pages. They select the exact record
and candidate version from its complete policy, render a bounded response
synchronously, and detach that response before rechecking consumed physical
evidence and current authority. A caller receives no session or mutable policy
alias. Failed rendering or a cancelled result handoff discards the matching
cached attempt; mutation preparation continues to own its separate session.
The first cold request still constructs the complete selected review.

Cold native clinical preparation for retained-intake histories shares generator
implementations with the transaction-bound synchronous policy. Native reads and prepublication preparation
run at most 16 yielded work units before a real event-loop turn. These units include
retained question/issue processing, source-scope evidence, report membership and
receipt checks, and complete canonical review and selection-token inputs. A
resolved promise alone is not a yield. Every asynchronous gap retains a connection
authority proof and checks the current owner and caller cancellation guard before
resuming. A changed proof refuses the attempt; closing or aborting the generator
releases its private policy scratch.

Grouped native acceptance and single native import prepare their final complete
original-source discovery digest outside the publication transaction. The scan
uses exact rowid pagination and yields after at most 64 sources, retaining no
live iterator across a turn. Its one-use admission binds the original raw
database and TEMP proof, current physical accepted HEAD, profile, clinical
operation, and disposable generations; the transaction rechecks that proof
after its existing selected-source publication guards and before the first
accepted change. Any intervening application transaction, local or peer write,
authority change, cancellation, or failed proof discards admission. This moves the final
full-frontier traversal out of the transaction; it does not reduce its total
source visits, replace selected original-file checks, or make other cold
preparation changed-source-only.

Lookup-index preparation also pages its initial source traversal by exact rowid,
yielding after 64 originals, including already prepared and legacy sources.
After maintenance, the certified path combines final selected-index validation
and the discovery digest in one paged traversal. Its original read proof must
survive every turn, and its complete digest must match the initial traversal;
source insertion, removal or reordering cannot turn a partial pass into a
complete certificate. This removes one redundant final source scan, not the
remaining complete-source work. The uncertified compatibility fallback remains
synchronous and grants no read token. The separate private catalog traversal
still owns its existing iterator and checkpoints.

An eligible native acceptance can extend the private receipt address catalog
with only its newly appended lookup keys, including a coupled approval across
distinct originals. The workflow compiler issues a one-use proof only after
completely validating each source's append contributions; a changed original
with no new receipt needs an explicit completed empty proof. The acceptance
owner binds every final prepared logical root and one successful durable group
outcome with the complete journal receipt before installing an atomic,
operation-scoped hint. Fresh preparation still validates the complete current
source frontier, checks every new selected lookup address, and creates a new
global read proof. No prior global proof receives credit for the owner's writes.
Existing receipt rows join the freshly validated source head instead of being
rewritten when that head changes. Detached hints are bounded to 64 keys per
source, at most 100 sources and 1 MiB of retained string data per operation.
An unsupported, incomplete, over-budget or mismatched batch uses complete
derivation. These are optimization bounds, not acceptance limits. Readers and
authority capabilities are not retained in detached hint metadata. Grouped
approvals do not mint the separate single-source batch-revalidation capability.

Grounded source-scope checks retain a lazy, ordered verified prefix on the opened
collection scope. Each new row still reads the original group and current version
before comparing boundaries, preserving duplicate order, version selection and
refusal of corruption reached by the original traversal. An early match does not
inspect an otherwise unvisited suffix. Signed rows and a private frontier bind
completeness and order in owned SQL scratch; matching candidates reconstruct the
checked native group/version and run the original grounding and occurrence rules.
The original owner, raw database generation, selected view and consumed physical
files remain pinned. Missing proof and fresh transaction callers use the original
traversal; a previously pinned proof cannot be revived by fallback. Valid oversized
metadata also uses the original traversal without introducing a new refusal limit.

The verified prefix belongs to read preparation. Clinical projection copies the
same checked source-scope adapter without the optional prefix, performing the
complete original traversal after its own derived maintenance and inside
speculative transactions. Source, view, grounding, physical artifact-union and
plan-current guards remain required, including rechecks against earlier block
writes. This neither refreshes a failed prefix proof nor grants SQL-change credit.
Projection retains the original traversal cost.

Repeated handles share one prefix while evaluating their own grounding proofs.
Interleaved work uses independent original traversal; changed scratch triggers a
new complete, stable authenticated pass before cached traversal resumes. The
scheduling marker grants no SQL-change credit. Closing the collection scope or a
failed prefix owner invalidates retained prefix use. Metadata stays in SQL rather
than a per-group JavaScript map, but complete signed scans remain
O(incoming entries × verified prefix rows), with corresponding scratch, HMAC,
parsing and serialization costs.

A 2026-10-04 matched fictional 4/16-record first-review diagnostic completed on
both versions. At 4 records, native version calls fell from 29 to 13;
at 16, from 497 to 61. The complete 16-record HTTP response read 305,185,742 native
logical bytes before the change and 201,941,504 afterward, with 10,275,478 added
scratch text bytes read, 139,764 written and 5,023 scratch witness queries. Total
counted hash and parse bytes fell, while serialization rose from 19,176 to 14,524,369
bytes. These counters do not measure physical filesystem/WAL bytes or every CPU
cost. The HTTP oracle checks success, scope references, complete competing counts
and scratch cleanup; focused policy/authority tests separately check policy parity
and refusal. Neither measurement establishes full wire/replay equivalence,
corpus-independent cost or whole-import recovery performance.

Derived reader and source-attention caches use fixed synchronous TEMP statements.
Those statements receive neutral credits only after
canonical table/index validation and restrictive SQLite authorization establish
that they changed their owned disposable objects. Callbacks, dependency reads,
awaits, failed or partial statements and transaction-bound writes receive no
credit. Exact integer accounting preserves every other SQL change, external data
version, main schema, registry and grounding generation, including real writes
followed by rollback. Ordinary cache admission still uses the unadjusted SQL stamp;
neutral maintenance cannot relabel a previously cached result as current. A fresh
read checks its preparation proof through completion before retaining its final
raw stamp. Borrowed immutable providers and multi-row feed reads keep their own
preparation proof while later cache admission remains conservative.

Participating clinical reads, identity preparation and mutation preflight acquire
one exclusive operation slot per database before preparing dependencies or
capturing a proof. The slot covers the complete feed window, record page or
ownership preparation through its final checks and detached response. This keeps
another participating request's real snapshot checkpoint outside that interval;
it does not credit persistent writes as neutral or replace any authority check.
Trusted nested calls pass an active owner explicitly and run sequentially. Stale
owners, parallel children and admission inside a main-database transaction are
refused. Detached children finish cleanup before the next operation enters.
If cancellation rejects a newly prepared session, queue lease or plan before
handoff, its producer disposes that result before admitting the next operation.
Uncoordinated writes, including rolled-back writes, still invalidate held proofs.

Source-attention list preparation joins this operation slot, including its dirty
count reconciliation. A concurrent attention GET waits for native conversion
instead of changing its raw SQL witness between checkpoints. Trusted nested
attention reads retain their active owner, and inherited cancellation or database
closure prevents later reconciliation work. This leaves attention results and
maintenance credits unchanged; the conversion proof still refuses uncoordinated
SQL, including changes followed by rollback.

Package inventory GETs acquire this slot before selecting the native or legacy
path. Compatibility preparation, accepted inventory checkpoints, failure
resolution and the final current-plan selection stay within the same owner.
Disconnecting the HTTP response removes a waiting request or cancels active
verification through the existing worker checks. A final liveness check runs
before invoking the response callback. Completed immutable checkpoints remain
retained, so a later request can resume the same inventory attempt. Source,
physical-authority and plan checks remain in force. Cold inventory holds the
slot through worker completion; unrelated HTTP remains responsive while other
participating clinical work waits. This prevents the demonstrated package-read
interference with conversion, without claiming that every writer is coordinated.

Package-member HTTP and the shared package inventory producer also coordinate
compatibility preparation, inventory checkpoints, child publication, and located
failure creation or resolution. Package metadata requests join the slot because
they can reconstruct inventory or resolve its retained failure. Selected-member
worker staging runs outside admission unless the caller already owns the slot;
the completed stage and original physical lease survive the publication wait.
Admission checks the original source and current child/native state, preserving
exact occurrence reuse without refreshing another operation's captured proof.
Completed inventory readers are selected under the caller's lifecycle and must
match the completed inventory's exact identity and source binding. Deferred PDF
readers retain that caller lifecycle rather than a closed producer lease. See
[streamed package originals](streamed-package-originals.md).

Thirteen focused producer cases use fictional authority with actual HTTP, ZIP
workers and retained files. A paused real selected-member ACK establishes worker
completion before queued publication. They cover live publication and exact
retry, waiting cancellation, closed ownership, same-byte physical replacement,
stage failure and stale/canceled failure publication, immediate-owner nesting,
cold inventory overlap, deferred PDF fallback and all three JSON structure
failure/resolution paths. The cold inventory case exercises the shared producer,
not the assistant tool dispatcher. These cases do not establish full application
authorization, encrypted recovery or physical-device qualification.

Five focused real HTTP cases and six existing compatibility cases cover live
conversion overlap, waiting and active disconnects, retained-prefix resume,
legacy results, immediate-owner route nesting, current-plan selection and stale
reference refusal. These use fictional immutable authority and actual ZIP
workers; they do not establish full application authorization, encrypted recovery
or browser qualification. The nested-route case starts from an already converted
source and does not separately qualify compatibility-to-build nesting.

Native conversion and staged-upload publication use the same operation slot.
Readiness is checked after admission, so two callers converting the same source
do not repeat the build. Network reception happens before admission. Background
source extraction holds the slot only for admission, initial evidence selection,
publication and its terminal receipt; PDF, OCR and model work run outside it.
Every publication retains the original source and revision pins. Starting or
joining extraction from an active clinical owner is refused, preventing an owner
from waiting on a worker that needs its slot. Batch stall and retry updates also
select the current representation after admission, while preserving the captured
semantic version and exact operation-replay rules. This coordinates participating
writers; other changes still invalidate the original proof.

Native identity previews can share preparation across external callers. A
disconnected HTTP response cancels only its subscriber; preparation stops when
the last subscriber leaves. Cancellation is checked at cooperative boundaries
and before snapshot publication. A nested identity lookup runs under its current
owner rather than waiting on a shared request queued behind that owner. Ordinary
request-body completion is not a disconnect. These operation slots are admission
queues, not long-lived SQL transactions or a server-wide HTTP lock.

Identity preparation can borrow a complete clinical policy already retained by
an idle report-queue owner for the exact database, root, profile, intake and
proposal. It pins that existing owner against eviction, checks its original
revision, source, raw SQL and complete physical proof, and checks the selected
owner again across cooperative work. Borrowing neither constructs a queue nor
refreshes its proof. An unavailable owner takes the ordinary preparation path;
a failed check after selection refuses the request. Releasing a borrow releases
only its pin. Closing, clearing or replacing the owner invalidates the borrow.
Grounding changes still require the second complete policy construction.

Within one preview request, the first complete build and its private scratch rows
can survive the context reopen only while the exact pre-build SQL/registry
witness, request key and grounding generation remain unchanged. The reopened
context still verifies the complete required artifact set and freshly reads the
original evidence; every original-evidence field must match before reuse. An
unavailable or changed proof discards the derived rows and performs the second
complete build. This does not refresh an earlier proof after writes, retain a
policy across requests, or bypass artifact checks before snapshot work and at
completion.
The [native build-reuse regression](../../src/server/test/intake-identity-native-build-reuse.test.ts)
counts two builds for cold grounding, one for an unchanged request and zero for
an already retained response, while preserving the complete response.

The controlled four- and 16-record HTTP flows each add four questions, then use one borrow and one fresh
post-grounding policy, and return the same complete identity response as cache
disposal and reconstruction. A separate comparison under unchanged authority
preserves complete policy and tokens: borrowing performs zero uncached collection-node
reads, with 40 and 136 node-cache hits, versus 6,089 and 41,028 uncached reads
for fresh policy construction. It still performs 180 and 612
SQL witness queries, and hashes 4,120 and 14,008 input bytes. Binding hashes,
borrow hits and misses are counted explicitly. These are bounded fixture
results, not whole-request cost comparisons or full encrypted recovery evidence;
the fixtures do not cover long answer or draft histories.

Participating requests against the same database wait for one another, so a live
large review can delay another clinical page. Cooperative yields still allow
unrelated host and source-transport work to run. This coordination does not
establish concurrent same-database clinical reads or a latency bound.

This cooperation does not cover every clinical lookup. The preexisting
`activeMappingRules`, `latestRecordException` and saved-record `previous` helpers
still synchronously read, match or sort global decision catalogs and per-identity
clinical history. Their complete output and legacy ordering need a separate
catalog/API change, tracked in [CRS-235](../todo/CRS-235.md). Clinical preparation
therefore has no universal bounded-latency or history-independent-work guarantee.
The retained-intake checkpoints do not remove that limitation.

Selected questions reuse the complete workflow dependency index and restore its
retained question ordinals in session-owned SQLite. Separate indexed unpinned and
exact-version selections preserve legacy ordering without rereading every
unrelated candidate's questions. When that auxiliary index is not ready, one
complete cooperative traversal of the retained questions builds the private
selection instead; a valid review gains no new preparation prerequisite. A
malformed completed index is refused. The scratch rows are disposable and cannot
supply an answer or create acceptance authority.

Prepared reviews also retain authenticated lexical question recipes in that
session's scratch database. Each borrow checks the original source, profile,
logical view and physical authority, parses a fresh detached value, and attaches
its checked canonical history provider. Recipes retain the complete question for
zero or one answer, or the header and latest answer for longer histories; the
canonical provider still supplies the complete retained history. A recipe admits
at most 256 KiB of lexical input. Larger hydrated lexical values keep the existing read path
and budget behavior. This is a per-question bound, not a total heap or disk bound.

Raw SQL, peer, TEMP-schema and rollback changes during a borrow refuse. A changed
cache epoch can discard recipes but cannot refresh the review's original proof.
Present corrupt rows refuse; missing rows may be reconstructed under that proof.
Closing or replacing the review invalidates its providers and releases its
scratch. Evicting a source scope does not extend the review's lifetime. Epoch
invalidation deletes all cached recipe rows synchronously and counts discarded
rows; that counter does not measure all SQLite disk work.

A controlled comparison uses four complete policy-like traversals and three repeat borrows:

| Question count | Native hydrations, uncached → recipes | Native node reads, uncached → recipes | Unchanged parsed bytes | Added scratch read / write bytes | MAC input bytes |
| -------------: | ------------------------------------: | ------------------------------------: | ---------------------: | -------------------------------: | --------------: |
|              8 |                                35 → 8 |                        15,242 → 5,408 |                 92,548 |                  76,335 / 22,618 |         123,873 |
|             32 |                              131 → 32 |                       90,143 → 35,151 |                346,636 |                 280,077 / 90,532 |         464,012 |

These stable cases have 27 and 99 recipe hits and no discarded rows. They show
fewer repeated native value reads alongside added scratch and authentication
work, not lower total cost or latency. Separate regressions cover exact numeric
text and history, detached nested values, physical changes and rollback after a
hit, disposal, and actual review replacement. These results do not rerun or
replace the full 140-question or encrypted 64-record qualifications.

The complete fictional 140-question qualification retains exact question ordering, tokens, late-blocker refusal, answer persistence, cache-loss recovery and final acceptance. Its 2026-10-04 controlled run passes that full oracle; it does not establish interactive performance. Through the matching pre-acceptance boundary, shared sections reduce repeated policy rows from 700 to 560 and warm collection-node reads from about 4.21 GB to 3.55 GB, while physical-head reads rise from 729,818 to 742,761. The complete run counts about 4.82 GB of warm node reads, 0.67 GB of reconstruction node reads and 1,031,782 physical-head reads. These logical counters are not physical disk traffic or a total-work reduction. The retained-record and larger-import qualifications remain separate.

Report-source preparation checkpoints retained references, group/version history,
extension matching and complete membership hashing. Later duplicate-group
precedence and the legacy canonical confirmation hash remain unchanged. Within
one owned session, a memo retains only completed suggested-source hashes, with at
most 32 entries and 256 KiB of encoded keys and digests. Exact authority changes
or transaction entry discard that reuse; an interrupted hash is never cached.
The source-hash, member-hash and reuse counters distinguish complete hashing from
repeated selection. This avoids rehashing the same shared report for every record;
it does not eliminate its cold history traversal.

Cold file verification yields between 256 KiB hash chunks. The session retains
verified physical identities for every source dependency and the selected
proposal in its private scratch, independently of the bounded open-source cache.
Publication and later projection admission compare those original identities;
a changed file refuses the review rather than causing a final synchronous
rehash. The final identity check remains a synchronous metadata sweep proportional
to the number of consumed artifacts, so this is not a history-independent latency
claim. A focused fictional single-record fixture with 96 retained questions
checks exact synchronous/cooperative policy and token parity, an unrelated HTTP
response during cold preparation, and scratch cleanup after cancellation or
rolled-back SQL drift. It does not qualify the complete large-provider or
physical release journeys.

Identity previews apply the same cooperative work boundary to complete retained
membership, including historical, empty and duplicate proposal occurrences, and
to payload hash chunks after file-cache eviction. Each verified identity is
retained in signed owned scratch using the identity returned by verification; a
later pass cannot replace an earlier baseline. A warm preview verifies this
complete set once, detaches its response, then checks the retained identities
and current authority again. That final metadata sweep does not rehash file
payloads. Cancelling the last subscriber closes both the verifier and its
scratch. `identityPreviewArtifactOccurrences` counts inspected occurrences,
including duplicates, separately from unique artifact verification and byte
hashing. The file cache remains bounded at 256 entries; eviction requires
authentication without making the resulting hash work synchronous.

The complete fictional 257-proposal fixture verifies 449 historical and duplicate
occurrences through the public membership API. Its controlled 2026-10-04 run
passes exact warm-preview parity, unrelated HTTP progress inside verification,
last-subscriber cancellation, scratch cleanup and refusal of an earlier file
replaced with identical bytes. Warm verification reads and hashes 8,860,193
payload bytes; its final physical-identity check performs no second payload hash.
The complete fixture took about 412 seconds under its existing 450-second host
hang guard. This is correctness evidence, not acceptable interaction timing or
storage-cost qualification: native history preparation wrote about 600 MB of
logical node data, and SQLite reached about 4.27 GB before normal cleanup.
Logical node counters exclude database and recovery-storage overhead.

Report and feed reads serialize use of a shared review session, detach the
bounded response before releasing it, and close sessions replaced by another
proposal. Reset and close invalidate waiting readers; releasing an unrelated
reader does not close a session still in use. Multi-source pages and ownership
preparations copy host-verified artifact identities into owned scratch before
closing each session, then check the complete set before returning or applying
the result. These rows carry process-local integrity signatures and an expected
count, so changed or missing disposable rows cannot certify current evidence.
The identities are never refreshed to accept a replacement observed during a
wait. Final checks still scale with the consumed artifact count.

Grouped clinical projection owns a copy of every member's verified artifact proof
before speculative writes begin. A later member can consume evidence attached by
an earlier member only when that source already belongs to the verified union.
Temporary consumption tracking is restored after preparation, so repeated
preparation preserves the original sessions. The plan's signed physical proof
survives disposable review-cache cleanup after a failed publication; replacement
files, unknown consumed sources, closed sessions and changed logical authority
still refuse reuse. Disposing the plan releases its proof storage.

An ordinary failed-transaction cache reset closes cache-owned sessions while
preserving independently caller-owned review scratch. A retry therefore checks
the original logical and physical evidence rather than refreshing its baseline.
Explicit cache teardown and database close still release all review scratch;
callers must close the sessions they own. Retaining scratch does not make a
changed source or a closed session reusable.

Original-grounding proofs also have a disposable semantic generation: publishing
different facts, clearing them or evicting a scope invalidates held clinical
sessions and feed cursors even when SQLite has not changed. Repeating the same
complete facts preserves this generation. Native proof iterables stage in
isolated, unpublished scratch rows and cooperatively stream their deduplicated,
ordered fingerprint before replacing the prior complete scope. Staging performs
no main-database writes across asynchronous gaps; final publication may remove
superseded legacy temporary proof rows and therefore invalidate SQL read stamps.
Cancelled or invalidated staging leaves the previous complete scope selected.
Validation checkpoints both complete raw version chunks and every inspected
competing header, including nonmatches; partial hashes are never retained as
completed proofs. Scope eviction and database closure release owned proof stores.

Report summaries, member facts and feeds record the retained-source dependencies
actually opened by clinical review in indexed scratch tables. They check those
dependencies lazily and rebuild the affected source scope, including off-page
dependencies, while reusing unchanged sources. Publishing a grounding proof does
not eagerly traverse the installation. These certificates and indexes remain
disposable; retained accepted identity evidence keeps its existing policy and
does not become unreviewed solely because the original-grounding cache is cleared.

Native report-member preparation yields after at most 64 structural work units,
including retained groups and versions, fallback candidates, ownership rows,
group callbacks and members that do not produce a visible result. Scratch
indexes exist before ingestion; ordered traversal does not defer a full source
sort or distinct-membership copy until the first result. A separate retained-only
membership index preserves duplicate-candidate fallback and report-anchor
precedence without admitting later fallback rows into that baseline.

Each full-scan consumer holds the existing verified-original descriptor through
the entire traversal. New internal turns recheck the current operation, selected
source, SQL witness and cache generation before continuing; the physical lease
rejects path or inode replacement. A consumer may perform ordinary derived
preparation between emitted members, but must still retain the same selected
source and original physical identity. Indexed record-page windows keep their
existing bounded path rather than acquiring a new full-scan lease. Cancellation
or changed authority discards the private scratch and preserves the callers'
final response and publication checks.

People index preparation and native pointer consumers also cooperate after at
most 64 structural work units, including metadata that produces no Person,
duplicate occurrences, filtered pointers and rows beyond the requested page.
The membership index exists before ingestion and streams every occurrence in
retained order; first-match deduplication does not bypass member-binding refusal.
Counts and cursors still describe the complete selected scope, not just the
visible page.

Preparation holds the original descriptor throughout and checks the active
parsed proposal's verified physical identity across turns and derived writes.
Completed index pointers are not approval or retained raw People values: using
one re-verifies its selected source and exact identity/version. A returned People
page additionally rechecks the sources of its rendered values before returning,
with proof storage bounded by the existing page limit of at most 100 people.
This avoids an accumulated all-proposal proof scan at every turn. New internal
turns preserve the current source, SQL, registry and operation checks; ordinary
derived writer commits are not mistaken for foreign source changes. The complete
index marker remains last, and interrupted partial preparation is not a complete
People scope.

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

Native common-identity GET previews may retain at most 32 detached response wires,
with a combined 256 KiB budget including their binding keys. Reuse requires exact
connection SQL/registry, source, profile, request and clinical-policy equality;
transactions never reuse or retain previews. Complete retained group membership
is traversed to verify its original and every required proposal before and after
returning a warm preview. Physical byte verification retains its existing exact
file-identity guard and rehashes changed files. The memo retains no policy session
or provider and clears on lock, rollback, disposal and actual database close.

Native identity evidence commitments stream the complete current scope, excluding
only its intake version, together with the verified original source hash and
ordered advisory warnings.
They allow one unchanged-action retry after a definite version conflict; they do
not replace version-specific scope or receipt authority. Current overflow warning
references bind immutable content independently of the main scope, so a saved
Person edit can select new warnings without overwriting historical scope rows.
See the [identity API](../../src/server/INTAKE.md#common-report-identity-review)
for proof, warning-selector and logical confirmation boundaries.

Native ownership identity snapshot preparation fills its private issue-hash sort
through indexed reads of the complete current issue policy. Matching and skipped
issues both count toward host turns, with current source and operation checks after
each turn and before using the sorted result. The prepared sort can be replayed
for source membership and report union without refilling the policy or holding a
SQLite iterator across those turns. Referenced policies keep a mutation witness
through replay, including same-count edits; native private issue scratch also
refuses an intervening SQL write. Native inline policies receive a synchronous
complete canonical check within the existing 128 KiB allowance after maintenance
and before source snapshot handoff. Manually supplied inline arrays retain the
legacy synchronous full-array compatibility cost. The legacy hash grammar and
SQL ordering remain:
the synchronous selector preserves duplicate hashes, while native snapshot
membership skips them with an indexed distinct seek. Published snapshots still
require the source catalog's complete membership and current-authority checks.

The snapshot owner authenticates a complete-evidence alias and source/group
locator in the existing build report catalog. Fresh complete evidence remains
required before an accepted alias can reuse retained rows. First certification
performs two bounded retained traversals: exact namespace certification against
an independent fresh-producer seal, then complete primary-evidence and warning
commitment reconstruction. Changed evidence generates the full desired primary
and derived key set in owned scratch, compares complete retained values in bounded
chunks, publishes differences and deletes obsolete tails. Stable row positions
can retain unchanged cells; ordinal insertion or deletion may affect many cells.
Content, schema and physical scratch guards cover the entire operation, including
cleanup, and fixed row budgets yield through unchanged comparisons. Logical
confirmation can borrow exact source-bound build references under both captured
catalog bindings; it cannot move or refresh the build-only locator or use a
missing target from another selected area. Historical receipt lookup stays
logical-only.

Fragmented text retains the existing byte format. Owner-branded prior references
permit comparison of fixed surrogate-safe UTF-16 leaves, reuse of equal aligned
leaves, publication of differing/appended leaves and removal of obsolete trailing
leaves. Prior branded references are adopted before asynchronous generation.
Tiny replacements return to inline storage with no byte-leaf changes or deletes,
but still incur the constant adoption and mapping changes. Character insertion or
deletion can resegment the changed scalar's suffix; there is no arbitrary minimal-edit
locality guarantee. Complete final count, bytes, order and streamed hash remain
checked. Read/hash work, changed keys, changed byte leaves and durable
tree/contributor publication are separate costs; reuse does not imply zero
physical writes.

The [native giant-question cases](../../src/server/test/intake-identity-native-giant.test.ts)
exercise the supported competing-subject question path. The
[native route cases](../../src/server/test/intake-identity-native-routes.test.ts)
cover aligned question edits. Giant warning inputs in the
[byte-owner cases](../../src/server/test/intake-report-snapshot-bytes.test.ts)
and giant `$scope` inputs in the
[alias-owner cases](../../src/server/test/intake-identity-snapshot-alias.test.ts)
are synthetic owner fixtures; they do not establish a native policy/model path.

Current identity fragment consumers use source- and snapshot-bound authenticated continuation positions over the existing variable-length byte leaves. Their total leaf-read work scales with the full traversal plus bounded page-boundary lookahead, rather than rereading every preceding fragment. Byte counters include decoded lookahead leaves. Page reference sizing uses authenticated item lengths, while full question digest construction yields with current source and artifact checks. Numeric-only compatibility calls preserve arbitrary byte-offset semantics through a cooperative prefix scan; they retain the cumulative reread cost and are not a bounded-per-page access guarantee. A verified-original descriptor remains held through fragment work, and cancellation or same-byte physical replacement invalidates a resumed read.

A cold preview that publishes a snapshot cannot certify its earlier response.
Only a fresh full reconstruction captured before reopening its context, with an
unchanged proof through physical checks, serialization and owned-session cleanup,
can seed this memo. The first cold read may therefore remain uncached; a subsequent
stable reconstruction enables warm repeats. Lifecycle clearing invalidates pending
retention attempts. Confirmation and other mutations always rebuild current policy
and verify their artifacts independently of the presentation memo.

A live selected clinical scope also avoids repeated native v2 identity receipt
header decoding and snapshot opening. Receipt headers and complete common scope
providers share a private budget of at most 32 entries and 256 KiB of encoded
header/reference/key data, accounting for references captured by providers and
fixed wrapper overhead. Common providers are keyed by the entire encoded accepted
scope reference; different receipt headers and supersession checks remain
independent. Each lookup authenticates the selected view and requires the exact
host authority proof. Headers and
nested reference metadata are detached; complete collection providers have
immutable counts and guarded traversal, including nested occurrence, issue and
question proofs. Observed drift, transactions and scope close invalidate retained
providers through a generation token. Receipt supersession remains a live check
on every complete ordered traversal; confirmation decisions retain the existing
policy semantics.

The same live scope retains a receipt locator namespace only after a complete
traversal of at most 32 entries. Cancelled traversal, an oversized address budget
or a larger history retains no partial namespace. A separate LRU of at most 32
membership-provider resolutions shares a 256 KiB structural budget with those
locators, accounting encoded addresses, group keys, captured member references
and fixed provider overhead. Resolution reuse authenticates the current selected
view and the exact host proof; each membership check still verifies every prior
member, section and occurrence. Immutable providers refuse use after observed
drift, transaction entry, refused authority or scope close, including after a
rollback restores the earlier SQL state. First retained duplicate selection and
later-version fallback remain unchanged. Work counters are attributed explicitly
by both production scope hosts, including reads outside a global accounting
scope.

The forward latest-receipt selectors still traverse the complete history. Many
receipts sharing one exact accepted scope can reuse that complete provider even
as older headers leave the memo. Entry or byte-budget pressure and oversized
values fall back to reconstruction; this makes no history-independent warm-cost
claim. Separate counters report receipt-header reconstruction and common-scope
opening/reuse. Native identity hosts enable this scope reuse independently of
draft and membership caches. Legacy inline receipt readers keep their existing
behavior.

These memos do not eliminate repeated complete header scans. In the 2026-10-04
fictional 70-retained-receipt confirmation/replay qualification, the full setup and
public workflow reconstructed 1,653 headers and counted about 5.50 billion bytes
of collection reads. Counted reads include repeated logical lookups and are not
a measurement of physical disk traffic. Receipt-local field traversal reduced
the selected 71-header comparison from about 176.86 million to 150.71 million
counted bytes while preserving all headers. Complete confirmation and replay
passed; these measurements establish neither constant history cost nor a host
responsiveness guarantee. Cooperative host-work qualification remains separate.

Native identity review prepares each proposal's required metadata and clinical
session before acquiring its receipt selection. That preparation can publish
real retained metadata, so an earlier selection is discarded and a fresh complete
history is read after source, clinical, grounding and physical evidence checks.
This does not extend an old proof across publication. A scope with no current
occurrences still inspects its retained receipt history.

Competing identity claims retain every report-group occurrence, including repeated
public group IDs, with that occurrence's own latest version. Their canonical
order is the legacy stable `localeCompare` order by group ID; equal IDs retain
source occurrence order. Bounded scratch runs and a merge preserve this order
without collecting the entire group scope. Repair compares and consumes one
retained claim per current occurrence, so an identical claim cannot satisfy a
second occurrence. A namespace inspection, claim comparison and merge step are
cooperative work checkpoints under the current authority proof.

Complete name-evidence collection also checkpoints while ingesting claims and
reading distinct names. Records without a matching group or identity issue still
produce inspection checkpoints. The canonical conflict provider emits empty
byte chunks during scratch ingestion; these checkpoints change no canonical
bytes, legacy hashes or unknown-claim semantics. Synchronous legacy callers drain
the same work implementation, while native clinical preparation checks the exact
current boundary between event-loop turns and closes incomplete scratch readers.

Advisory warning preparation checkpoints every inspected issue, including
unrelated issues and compatible birth-date hints. It hashes and deduplicates the
complete ordered candidates in private policy rows before publishing a counted
warning reference. Inline warnings are only a presentation limit. Legacy
synchronous callers drain the same implementation, preserving canonical IDs and
ordering. Interrupted preparation publishes no completed reference; closing the
owning scope disposes partial rows and invalidates retained warning readers.
