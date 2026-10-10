# Incremental intake state primitive

The internal `createIntakeStateStorage` API stores JSON state using changed-content contributions in ordinary durable `app_meta` records. Production intake uses it through the [selected envelope authority](intake-envelope-authority.md) and [operational access boundary](../import/intake-state-access.md). The source row retains validated compact metadata; selected accepted evidence owns the complete envelope. The owner supports the retained V3 codec and the V4 collection representation described below. This primitive does not establish large-import qualification.

## Authority and identity

The API requires a configured, current [accepted-record projection](record-version-storage.md), the database's verified profile owner, an existing `intake_original` source ID and its original SHA-256. It does not create or modify originals, source identity or clinical accepted records. Caller authorization and the existing single-writer profile lease remain application responsibilities.

The reserved namespace is `intake_state_v1:<identity-hash>:`. The hash binds the profile, source ID and original hash in a fixed field order. `frame:<UUID>` and `operation:<UUID>` keys are insert-only; an existing identical value can be verified, while conflicting values cannot replace it. These keys participate in ordinary accepted-record commits and are not excluded as personal cache metadata. V4 adds content-addressed `node:<SHA-256>` rows in the same namespace. Only the `head` key changes in place. Recovery follows that committed head, not arbitrary staged rows or retained immutable objects.

Frames contain linked references, exact identity and format, sequence, logical operation version, operation ID, order-sensitive result fingerprint, payload hash and chunk coordinates. The retained whole-value codec uses `health-intake-state-v3` authority in the existing `intake_state_v1:` namespace. The namespace suffix is not a format decoder: retained earlier authority, including v2, is refused explicitly, without migration or reset. Conversation-journal semantics are unchanged. Initial state is a root insertion; later contributions encode changed values, validated key and array moves, array splices and string splices. Large initial values and changes are serialized into UTF-8 JSON, split into at most 32 KiB raw chunks and encoded as bounded base64 frames. Each complete serialized frame is at most 64 KiB. Head and operation receipt are each at most 4 KiB. The head has one tip reference and cumulative counters; it has no growing reference array. Receipts contain a fingerprint and small result, never the reconstructed state.

Cold reads validate exact schemas, primitive identities, hashes, predecessor sequences, chunk grouping, canonical base64, UTF-8, source/profile scope, operation receipts and cumulative counters. A receipt's changed flag must agree with the decoded operation. Missing heads with retained namespace evidence fail explicitly. Unselected orphan contributions cannot advance the state. Unsupported formats are rejected. The explicit V3-to-V4 bridge below does not authorize decoding earlier unsupported formats or an automatic reset.

## V4 collections and selected publication

The same owner exposes `.collections`; this is an extension of intake-state storage, not a second authority. A `health-intake-state-v4` head binds identity, storage sequence, logical root/domain version, receipts root, history root and incomplete-build root. Roots are fixed-size authenticated references. Domain version retains the existing public intake version meaning. Storage sequence advances for a new receipt, including a semantic no-op or auxiliary checkpoint; auxiliary churn does not change logical cursors or clinical review pins. V3 receipt/result versions retain their original interpretation.

Immutable AVL nodes authenticate their exact identity, key/value, children, ordered bounds, height and safe counts. A node is at most 32 KiB. Ordinary values at most 8 KiB stay inline; larger text uses checked 4 KiB byte chunks and an immutable attachment reference. These are representation units, not limits on a legal filename or record. Map point/rank/predecessor reads and path-local writes traverse authenticated paths. Sequence ranges and byte ranges have explicit item/byte budgets. Corrupt, foreign, missing and stale references refuse rather than becoming empty data.

Typed nested collection values capture an existing checked map, sequence or byte descriptor. Their parent byte accounting includes the descriptor, not recursively copied content. Ordinary string/byte readers refuse such values; separate opaque reference readers traverse them. References are bound to the owner/source and selected logical root and expire on logical changes or cache disposal. Auxiliary-only checkpoints preserve their logical binding. No caller-provided hash constitutes a reference capability. Collection views are weakly held opaque handles: opening unrelated views does not expire a live reader. Every read still checks its selected logical/build root, owner and current authority; cache disposal invalidates all prior handles. Cold validation follows every typed reference, and copy rebinds descendants to the target identity using disk work queues rather than a fixed nested-depth frontier.

A preparation contains at most 64 primitive changes, 4,096 changed rows and 8 MiB of encoded writes. Retained preparations are capped at eight and 16 MiB together; the page cache holds 128 pages and byte/collection reference registries are bounded. Large commands checkpoint private incomplete builds in smaller batches and yield to the event loop, then select a fixed number of roots. They do not publish partial domain changes. Opaque preparations are source/head bound, disposable and transaction scoped; replay is resolved before issuing a new one-use maintenance capability. Existing identical immutable rows do not enlarge the allowed changed set.

Identity snapshot inline deltas coalesce at most 64 entries or 64 KiB of key/value
bytes per checkpoint, while retaining checked host yields every 16 desired rows.
Text-leaf writes and suffix deletion retain their 16-change batches. Workflow
summary builds flush at 60 pending changes, leaving room for a two-change ranked
contribution and its progress marker within the owner's 64-change ceiling.
Separate checked yields retain the earlier 15-change cooperation cadence. An
empty workflow checkpoint omits publication only after freshly reading an exact
matching authenticated progress marker; its callback, host yield and subsequent
authority check still run. These reduce repeated path-copy writes without
changing final snapshot certification or granting authority across host turns.

Adjacent inline puts to the same map now share one bounded tree preparation. All
inputs are validated, including values later overwritten in the same batch; the
last put to a key wins. At most the existing 64 changes are sorted and partitioned
along shared authenticated paths, and the collection directory is updated once
for that run instead of once per key. Deletes, adoption, byte/collection references
and changes to another map end the run, preserving their original ordering and
intermediate reference snapshots. Untouched subtrees and exact no-op roots are
reused; the prior immutable history is not rewritten.

The temporary sorted input and prior-value map are confined to one synchronous
preparation and each contain at most 64 entries. Existing page, encoded-preparation,
write-set and registry limits remain; this is not a new retained cache or a larger
checkpoint. Different balanced shapes are permitted for newly written nodes in
the unchanged format. The collection tests count cumulative prepared bytes at two
retained sizes and verify exact values, no-op receipts, reference snapshots and
accepted-journal rebuild. These are logical allocation/serialization measurements,
not physical I/O, durable-write reduction or full-import latency qualification.

Unchanged reads reuse authentication of the four selected roots only while the exact head, SQLite local-write counter, external data version, main and TEMP schema versions, and disposable registry remain unchanged. Source/profile ownership, accepted-authority readiness and the physical accepted head are checked on every collection call. These memos cover the SQLite projection, not external artifact validation.

Bounded synchronous collection reads can also reuse authenticated pages from the existing 128-page cache. A private per-call certificate captures the unadjusted SQLite witness and registry generation before reading, then seals the pages only after the final witness still matches. Every hit checks the complete authenticated reference and source identity; a miss uses the ordinary SQL read with its 32 KiB UTF-8 limit and node authentication. A changed witness refuses the whole result rather than blessing partially stale output. The certificate retains only scalar witness data and generation identities, with no visited-page list or result references. Returned values are detached or opaque owner-bound capabilities.

Transactions neither skip raw page reads nor certify pages: observing a transaction rotates the private read epoch, so a rolled-back repair or DDL change cannot leave a trusted page. Mutation and staging invalidate that epoch. Bounded synchronous collection preparation starts its own fresh epoch and can reuse retained pages only within its private certificate; it never borrows its caller's proof. It checks physical authority again before returning, and the closing SQL/registry witness must still match the entry snapshot. Input callbacks that change that authority or start nested preparation invalidate the whole result, including provisional preparation capabilities. No certificate authorizes publication, skips the existing stage checks, or spans a checkpoint or yield. Nested reads have separate lexical certificates; a nested mutator invalidates its enclosing read. Main and TEMP schema checks remain distinct because a TEMP table or view can shadow an already prepared unqualified node query. Promises and escaping iterators cannot be returned by this synchronous boundary. Cache disposal, source changes, refusal and closure require fresh authentication.

Snapshot catalog checks read their logical binding and selected descriptor, plus
the same-name build descriptor when required, through one fixed synchronous
owner operation. It returns detached metadata, not an authority capability or a
retained cache. The existing source-row check remains separate; the owner checks
physical accepted HEAD at entry and completion and seals the exact SQL, registry
and read-epoch witness. Transactions retain the separate raw point operations.
The counted catalog regression reduces five physical HEAD reads and 22 witness
queries to three and four respectively; it does not establish whole-history
latency or change any publication, checkpoint or cancellation boundary.

Transaction-bound preparation keeps the raw-page fallback but also seals its
entry read epoch, registry generation, transaction identity and exact SQL witness
before returning a capability. A callback cannot clear the registry or start a
nested preparation and then register an old candidate in the replacement
registry. Refusal poisons the enclosing application transaction and invalidates
provisional capabilities; a fresh preparation is required after rollback.

For a bounded 32-change preparation over 64 selected entries, the counted regression
observes 35 rather than 70 retained-node SQL reads, or 38 rather than 75 with 80
unrelated entries. Each visited node fits in the unchanged 128-page cache in those
fixtures. Transaction-bound preparation deliberately retains repeated raw reads.
These are logical query counts, not a guarantee of one read for arbitrary larger
traversals, a physical I/O measurement, or a full history-test timing result.

The same per-database registry retains at most 32 resolved schema headers, with a combined 256 KiB encoded budget across readers and subtrees. Entries bind the exact selected logical collection, schema root, first/last field selection, record address and current raw authority. Cold resolution checks the complete original ancestry. The fixed synchronous resolver shares its private per-call certificate for the selected collection and inline header/ancestry reads, instead of opening a nested collection call for every cell. It still checks physical accepted HEAD at entry and completion, and seals only after the final exact SQL/registry witness. Fragmented headers keep their checked byte-reference path; transactions retain the original point operations. No certificate is exposed to callers or retained across a yield. A hit returns detached header primitives after fresh physical-head and final SQL/registry checks; it retains no lexical payload or generator. Named-field resolution uses the same private fixed operation to read its authenticated header/ancestry, first-or-last ordinal, order entry and complete lexical field name under one per-call certificate. The selected field descriptor must still agree with the order entry and the name hash. Missing fields and scalar `value` follow the same header and final-proof checks. Fragmented names stream through the existing checked byte reader; no name, field payload or iterator is added to the memo. Both source/handle checks and subsequent field-value reads remain outside this shared field-target scope. Only the original registered store and owner methods participate. Custom or replaced readers use the uncached path. Transactions, witness changes and explicit cache disposal clear retained headers; readers that outlive disposal cannot repopulate an old registry. Reuse avoids intermediate ancestry reads, but its owner checks can add physical-head observations for shallow records. It does not establish detection of a physical change that appears and disappears entirely between those observations.

The eight-record lexical-field fixture now counts 1,212 physical accepted-head
reads over two warm inspections, down from 1,620 before named-field scope reuse
(earlier owner-resolution measurements were 1,734 and 1,506). Each inspection
contains 49 present named-field resolutions: 24 lexical values, 24 field-list
validations and one giant scalar. It also checks eight missing fields. Sharing
four field-cell checks for each present field and one failed point lookup for
each absent field removes exactly 2 × (49 × 4 + 8) = 408 observations. Every
entry/final field proof, source check and payload/generator check remains, as do
both complete lexical inspections and their original exact-output assertions.

A focused named-field fixture at zero and 40 unrelated records reads the same
six items (four field witnesses and both original payload reads), with six
physical HEAD observations instead of ten and 24 SQL witness queries instead of 48. The existing source/handle checks, fixed field entry/final proofs and two
payload-read checks account for all six. These are counted reductions in these
fixtures, not whole-workflow speedups or installation latency guarantees. Field
scope regressions reject local/peer corruption, deletion, rollback-only repairs,
final physical-head loss, committed local/peer ABA, TEMP schema changes and
registry disposal. Complete fragmented escaped names retain the custom-reader
fallback's output, and returned targets are detached.

Staged envelope readers use the same fixed schema resolver for their selected
`builds` collection. Its memo key includes the collection area and name, exact
build-directory root, logical head, schema root and descriptor. Each operation
still checks the live source, current authority, complete ancestry and final
SQL/registry witness. A checkpoint refreshes the reader's view; an explicitly
retained pre-checkpoint build view refuses as stale. No staged selection is
silently read from the published `envelope.data`, and two builds cannot share a
header merely because their record addresses match. Transactions keep the checked
point-read fallback, and byte/name streams retain their existing validation.
This is an in-memory read optimization: stored formats, durable publication and
recovery authority are unchanged.

The small staged-reader regression compares identical published and staged data
with zero and 40 unrelated records. Before staged owner registration, a warm
record-header resolution used nine physical HEAD observations, 48 SQL witness
queries and seven cell reads. It now matches the published reader's four HEAD
observations, 10 witness queries and zero repeated header/ancestry cell reads.
A named-field read falls from nine/48/seven to six/22/six respectively, retaining
both payload reads and exact values. These measured operations do not establish
whole-workflow latency or a complete continuation/recovery pass.

The fixed synchronous schema resolver reuses its private read certificate's entry
SQL witness for the selected-root binding instead of sampling an extra mid-read
baseline. It still samples the closing SQL witness after its final physical HEAD
check, and refuses local/peer ABA, schema changes, registry disposal or an expired
read epoch. General collection reads, transactions and custom readers keep their
existing checked paths. No certificate or newly admitted schema result survives
an unsuccessful seal or is borrowed across a yield.

The direct warm header/field regression counts four rather than six witness
queries, with both physical HEAD checks unchanged, for published and staged data
at zero and 40 unrelated records. Header reuse still reads no repeated ancestry
cells; field resolution retains all four first/last ordinal, order and lexical-name
cell reads. These are logical SQL-query counts, not physical I/O measurements.
Mutation regressions inject local/peer ABA, TEMP schema changes and registry
disposal immediately after the entry snapshot, in addition to the existing
final-proof and transaction/rollback refusal tests.

For the short debugging loop, run the counted and entry-mutation regressions directly:

```sh
node --test --test-name-pattern='staged schema reads share|fixed schema reads seal|schema witness reuse refuses' src/server/test/intake-schema-resolution-authority.test.ts
```

The remaining staged tests in that file cover build isolation, checked checkpoint
refresh, stale views, local/peer corruption and deletion, duplicate selection,
rollback-only repairs, final physical-head loss, SQL ABA, TEMP schema changes and
registry disposal. Run the complete schema/collection regression files after a
change, followed by the unchanged `npm run test:continuation` and
`npm run test:acceptance` scenarios before claiming both workflows complete. A short
fixture does not replace either full scenario or turn their existing AI stubs
into live-provider qualification.

A cold inline ancestry regression now counts two physical HEAD proofs and four witness queries at two fixture sizes, and explicitly rejects final-proof physical-head loss and local/peer SQL ABA. These counts cover the resolver operation, not the whole workflow.

The [fictional resolved-header fixture](../../src/server/test/intake-schema-resolution-benefit.test.ts) preserves exact lexical output across 288 repeated resolutions. In a matched 2026-10-04 comparison with only this memo disabled, point-item reads fell from 2,016 to zero, tree visits from 18,848 to 576 and witness queries from 13,824 to 4,608. Both runs already had a warm node cache and read zero raw node bytes. Physical-head observations fell from 2,592 to 1,440; every resolution still checked current physical authority. These overlapping work counts describe this fixture, not complete workflow cost or an installation latency guarantee.

Selected envelope consumers reuse at most 32 storage handles per database after freshly checking profile/source/hash and head bindings; cache disposal, profile lock and reopening discard that reuse. Small report-member metadata and its occurrence metadata each share one bounded checkpoint, while oversized or historical lexical fields retain the streaming path. Within a native clinical review, up to 32 report headers and 32 unique report/version lookups per opened source may be reused after the current source/view check, while local writes, external commits, schema changes or registry disposal invalidate reuse. These scoped caches also clear and bypass reuse inside SQLite transactions. Complete competing-identity traversal and historical duplicate-group precedence remain unchanged.

Ordinary domain publication retains the existing accepted-record transaction and clinical revision behavior. Maintenance publication is narrower: a private host capability binds exact before/after heads, source details/pins, intended result and changed rows. The database verifies the captured write set and readback. It permits auxiliary changes or a separately certified representation transition, never a caller Boolean authorizing clinical-revision suppression. A derived projection may prepare against the exact prospective logical descriptor, checkpoint auxiliary work, then reprepare against the latest auxiliary head. The final owner verifies that its logical descriptor is unchanged and its added changes are auxiliary only.

Collection-node staging uses one 32 KiB-bounded immutable collision read to
determine whether a node was newly inserted, followed by the separate bounded
readback. The insertion result also drives the written-node counters. It does
not change the accepted transaction, collision refusal, durable journal or
recovery authority; it removes a duplicate metadata lookup for each staged node.

Maintenance metadata checks reuse at most two lazily prepared SQL statements within
one synchronous preparation, transaction-entry or readback invocation. They still
execute the separate length and value reads in their original order for every
selected key, with the original byte limits, immutable-collision checks, source
bindings, captured write-set and final-head verification. No metadata value,
authority result or statement is retained across those phases, a nested public
invocation or another connection. A failed preparation cannot seed later reuse.
This changes SQL compilation work only, not accepted rows, checkpoint frequency,
archive formats, durability, or the operator update procedure.

The maintenance regression at four and 48 changed entries retains respectively
28 and 116 length-check executions while reducing compilation of that query from
28/116 statements to three (one for each validation phase). It verifies every
actual write and its independent journal reconstruction, later immutable
collisions, nested preparation and TEMP-view rebinding. The host-only
`intake-acceptance-work.test.ts` fixture separately measures original/proposal setup,
schema preparation, membership, complete review, acceptance and receipt replay
at two/eight fictional documents. Its real acceptance path preserves exact titles,
receipts and original bytes while checking that SQL compilation is not repeated
for each metadata read. It uses the existing fictional in-memory journal backend;
it is not an HTTP, encrypted-storage or whole-workflow latency qualification.

Run the narrow regression first, then the acceptance-stage fixture:

```sh
node --test --test-name-pattern='maintenance metadata SQL' src/server/test/intake-state-maintenance.test.ts
node --test src/server/test/intake-acceptance-work.test.ts
```

The complete maintenance, grouped-acceptance and recovery suites remain required,
as do the original HTTP acceptance/cache-loss and 100-page continuation gates.

Ownership split audit membership uses the same graph's `ownership.snapshots` catalog in the auxiliary area. Once referenced by accepted clinical evidence, these snapshots are retained authority, not disposable unfinished builds. A preparation streams exact ordered source IDs, reconciles additions/removals against the previous immutable membership, and forks changed paths for the moving and remaining contributions. The ordinary clinical transaction selects one catalog root per custodian together with its clinical rows. This audit selection preserves the intake's public version; the clinical transaction still advances clinical review revision. Source/logical/catalog guards reject competing preparations. The reference stores custodian source ID/hash, snapshot ID, count and exact ordered-JSON digest; profile graph copy preserves those public identities and rebinds its authenticated nodes. Paged reads and cache recovery do not depend on retained SQLite historical version IDs. Cold construction, full membership hashing and changed writes have separate counters.

Duplicate audit evidence can use the auxiliary `duplicate.snapshots` catalog under a stable intake custodian. Each immutable snapshot shares unchanged evidence values by a hash of the exact evidence-row ID, retaining the complete ID separately without imposing a new ID-length limit. The ordered evidence-array digest preserves SQLite BINARY order, including non-ASCII identifiers. Preparing a changed snapshot counts its complete comparison/digest pass and disposable membership scratch separately from changed-row durable writes; an unchanged snapshot reuses its existing reference without writing. Historical export cold-sorts only scalar IDs in disposable SQLite and streams authenticated values in that order. Final catalog changes compose into an existing intake acceptance preparation, or select with a separate custodian in the same ordinary clinical transaction. A helper fixture changing three rows at history sizes 8 and 128 records 319,559 and 446,631 newly added immutable journal-object bytes respectively, with 27 new objects in each case. Those measurements exclude the overwritten selected head and are not total transaction bytes. This helper measurement establishes snapshot locality; separate public acceptance fixtures exercise compound attachment, exact replay and cache-loss reconstruction.

Cold recovery and profile-copy validation retain a prepared source-row SELECT
for each owned manifest or graph traversal. Each lookup still reads its current
retained row and performs the same reference, hash, historical-coverage and schema
checks. Statement reuse does not cache evidence values, bypass cold validation
or survive disposal of the private manifest.

The cold historical-graph walk also prepares its fixed scratch membership, visited-row, receipt, history and sequence-summary statements once per graph invocation, after creating its private tables. It still decodes every incoming reference before checking the visited index and executes every lookup, disagreement check and write. No evidence value, validation result or cursor is cached by the statement set; another namespace or invocation uses a new set. The existing 4/16-record recovery fixture separately counts statement compilation and actual graph executions, then verifies the complete source snapshot, lexical representation, accepted replay and lookup preparation. These small host tests do not replace the full HTTP acceptance/encrypted recovery scenario.

### Prefix-scoped lexical order reads

Native schema record traversal passes its existing order-key prefix to the selected
collection range. The authenticated range stops at the first key outside that
prefix before charging the page's item/byte budget or returning unrelated values.
The exclusive cursor must belong to the prefix; `complete` is scoped to that
namespace, while `count` remains the whole collection's authenticated count.
Unscoped callers retain their previous behavior. Original schema record-count,
order-key, lexical-value and depth checks still run, including duplicate properties
and occurrences. The first boundary node and every visited node remain checked.

This removes unrelated order-entry materialization during retained-artifact and
receipt traversal. It does not filter clinical history, skip superseded receipt
validation, cache complete records or increase page/cache limits. Custom cell
readers may continue to ignore the optional hint and use the checked fallback.
The same synchronous SQL/registry seal and physical-source checks apply; no
certificate is extended across a generator yield. Storage formats and recovery
authority are unchanged.

## V3 bridge and schema-directed envelopes

Conversion first verifies the complete supported V3 chain and current compact/raw agreement once, retaining the existing V3 per-value limits for that explicit compatibility operation. It selects a tagged legacy edge and a fixed legacy control marker without discarding old receipts or changing the public domain version. Interrupted builds continue to read the exact selected legacy value. Bounded auxiliary checkpoints do not repeatedly decode or serialize the whole old value.

The final schema build must reproduce the exact retained raw or normalized export and agree with compact source metadata. A private representation proof binds that equivalence, exact heads, source pins and exact writes before atomic adoption. Recovery validates both the retained V3 edge and V4 graph. A private copy creates target-bound bootstrap/bridge history and fresh target internal replay history; public payload IDs and exact raw evidence remain unchanged.

When no V3-to-V4 bridge publication is needed, the build reuses its original checked source view across its private preparation and validates it at later checkpoints. A V3 bridge changes the accepted record HEAD, so subsequent build work still uses the full selected-source checks; the earlier read witness is not renewed across that publication. Within an admitted post-bridge resume, its writer reuses that resume's selected collection handle instead of fetching the full source column again. The final exact export remains separately checked. This reuse alone does not qualify the giant V3 cold-conversion bound.

New compatibility builds use a deterministic identity bound to the exact retained legacy text, logical authority, source/profile, compact metadata, source pin and codec. Each checkpoint publishes at most 63 data changes together with an authenticated operation count and transcript digest in the existing accepted build area. Retry reconstructs parser-local duplicate/precedence facts in disposable disk scratch, checks the retained transcript prefix and skips its already published writes before continuing. This replays decoding, reads and hashes from the beginning; it does not restore a parser cursor. Missing, changed or inconsistent progress refuses before a new prefix is published. Final exact-export and owner certification still precede selection, and scratch closes on success, refusal or cancellation. Earlier randomly named incomplete builds remain retained history and are not reclaimed or retroactively resumed by this protocol.

Concurrent [source search](source-details-search.md#request-lifetime-and-limits) uses checked read-only authority while this preparation retains its original SQL witness. It defers disposable projection writes instead of refreshing the witness after an arbitrary callback. Upfront source validation, complete text matching and original mutation/physical-authority refusal remain required. This adds source-inventory and compatibility-read work during conversion; it does not change retained progress or grant unrelated writes a publication exemption.

For contributor storage, the legacy bridge also retains its original record-store
owner, accepted HEAD and immutable-write sequence. A known journal write outside
that store does not invalidate conversion. Record-store writes (including
idempotent attempts), unknown paths, aliases into that store, preexisting hardlinks and an
overflowed write history still refuse. Source, SQL, method and transaction-owner
checks remain required; the bridge cannot adopt a later baseline. Vault and
unsupported adapters retain the global physical-write guard. This scoped bridge
check is not a substitute for final consumed-artifact verification at an ordinary
accepted-write boundary.

The [conversion recovery fixture](../../src/server/test/intake-envelope-build-resume.test.ts) interrupts raw and normalized builds, deletes their disposable SQLite database, reconstructs accepted authority and verifies that retry adds no duplicate prefix writes. It also refuses concurrent, malformed and changed-and-restored progress, including changes observed during the final physical checks before publication. In one 2026-10-04 run, four versus 24 fictional history entries wrote 920 versus 7,574 collection nodes and about 1.6 versus 13.2 MB of accepted journal data during cold conversion. A fixed version edit then wrote 18 nodes and three journal records at either size. Tree shape affects exact counts; these small fixtures establish the distinction between cold conversion and a changed-scope edit, not acceptable large-fixture capacity or linear total conversion cost.

A separate 2026-10-04 qualification used raw fictional envelopes with 16 and 64
candidate histories, including escaped Unicode, and genuine contributor accepted
storage. It measured cold conversion separately from the same version-only 7→8
edit, including that edit's preparation and publication:

| Measured work                     | 16 histories | 64 histories |
| --------------------------------- | -----------: | -----------: |
| Raw input bytes                   |      133,184 |      532,304 |
| Cold collection nodes             |        4,832 |       25,458 |
| Cold encoded node bytes           |    4,453,329 |   24,266,680 |
| Cold immutable journal bytes      |    8,521,064 |   45,535,942 |
| Warm edit collection nodes        |           20 |           23 |
| Warm edit encoded node bytes      |       24,943 |       30,653 |
| Warm edit immutable journal bytes |       47,355 |       56,101 |

Each warm edit published three immutable objects and one accepted head. Cold
journal amplification rose from about 64 to 86 times the input: roughly four
times the input required 5.34 times the journal bytes. This is substantial,
growing cold amplification, not evidence of linear total conversion cost or
acceptable installation capacity. SQLite logical page-file size grew by about
30.89 and 166.31 MB. Node, journal and SQL history measurements overlap and must not be
added as disjoint storage categories or described as physical I/O.

At both sizes, an interruption after three real progress callbacks survived
deletion and reconstruction of disposable SQLite. The retained prefixes contained
113 and 142 operations; a callback can flush a partial batch, so its count does
not imply a fixed number of operations. Stopping after verified prefix replay
wrote zero new nodes, immutable bytes or accepted heads. Final retry preserved
the exact raw export and repeated completion wrote nothing. Retry still reads
and hashes the source and replays its transcript from the beginning. Rebuild read
about 2.67 and 6.31 MB of accepted storage and published nothing. Storage and
journal counters include temporary reconstruction plus reopening, validation
and attachment. Native counters start on the reopened database and cannot
measure the temporary reconstruction connection; oracle overhead is separate.
These contributor fixtures do not establish
encrypted-profile recovery, original-file preservation, whole-import performance
or complete clinical acceptance.

An older schema can retain metadata history or workflow People drafts as one lexical cell. Its explicit upgrade spools checked text into a private disk span index, splits known records through bounded byte checkpoints, and preserves duplicate properties, whitespace, escape spelling and unknown fields. Final format-only certification streams both complete exports with cooperative cancellation, requires unchanged public version/source metadata, and verifies that every other logical collection is unchanged. Cancellation leaves the prior selected field readable; an already structured field requires no reconstruction. Dedicated counters record equivalence hash bytes, chunks and yields separately from lexical scratch reads/writes. This is counted cold compatibility work, not an interactive whole-history read. The lexical input buffer bound excludes the verifier's depth stack and SQLite's bounded page cache.

The fictional [large-count encrypted qualification](../../src/server/test/intake-package-count-qualification.test.ts) exercises 5,001 files, 10,002 ZIP entries and 2,478,276 filename hash bytes. It interrupts after 24 verified records, resumes those exact occurrences, selects an implicit plan, reads its last bounded page, replays the same operation without rehashing unit IDs, saves a selected role, then locks the profile and deletes its encrypted SQLite cache. Unlock reconstructs the same distinct occurrences, plan and role from encrypted originals and accepted authority. The resumed inventory uses at most 56 edits and 25,984 encoded metadata bytes per checkpoint; its largest transport record is 1,421 bytes. These are observed fixture counts, not installation capacity or timing targets, and do not independently qualify every downstream consumer or authorize removal of remaining admission safeguards.

The schema map separates record headers, ordered occurrences, selected first/last fields, parent links, scalar cells, known growing child arrays/dictionaries and checked identity indexes. Unknown JSON remains exact lexical cells. Operational access follows the last duplicate property, while SQLite-compatible consumers can select the first ancestor occurrence and then use a last-property subtree reader. Public identity lookup preserves first-match semantics; explicit last-match indexes support consumers whose legacy behavior differs. Cold disk-backed joins reject phantom indexes, duplicate/shared live records, invalid parent/order edges and omitted operational fields before accepting export.

Readers obtain checked record handles, point fields, child pages or explicit fragments. They cannot hydrate a completed V4 envelope through the legacy whole-value API. Whole logical export remains an explicit complete traversal. Field names larger than a presentation page have authenticated hashed addresses and separate JSON-string fragments, so a model cursor never embeds a giant name. The cursor distinguishes addressed fields and name fragments from older name-key cursors. Fragment pages honor their byte budget and can resume across an arbitrary primitive UTF-8 chunk boundary by rereading at most the boundary chunk; a continuation does not replay the entire value from byte zero.

The lazy compact-metadata projector shares the cold validator's selection rules. It preserves raw known-property occurrences and key spelling, and reads only the selected compact fields under a caller-supplied byte budget. A metadata command must stage its envelope and update the compact source row in one normal transaction; changing only the selected envelope would leave recovery-invalid source metadata.

Compact-only metadata certification requires identical authenticated logical
descriptors before and after preparation. It does not hash both unchanged exports
again. Complete graph, JSON, source-projection and publication checks still run;
actual schema adoption retains both export-equivalence hashes. Successful
compaction also reuses already-valid filename and locator facts instead of
publishing an unchanged facts collection. Missing or stale facts retain the
existing preparation or refusal behavior.

The retained-plan adapter keeps pre-inventory-version-1 expanded units as addressed evidence, with their exact source bindings, ordered attempts, roles and receipt-backed dispositions. It does not substitute the current member-unit recipe. Explicit cold preparation builds complete source/logical-bound first-active and first-retained unit selectors, with separately counted plan headers, units and coverage receipts. Warm point reads and metadata fragments consume those checked selectors. Repeating preparation for the same logical selection after cache loss reuses the completed selected index. Closed proposal/question/link impacts share that checked index through the final auxiliary adoption without rescanning plans. Bounded batch and role impacts additionally verify the appended receipt scope and the corresponding final decision-root publication. Unsupported structural plan changes leave the new selected index explicitly pending; they do not silently run a cold scan on every interactive read. Direct V2 recipe plans have their own checked historical unit pointers; they are never interpreted as empty expanded plans or ZIP evidence. Their cold selector pass reads unit identities without decoding coverage or metadata. A new or structurally replaced plan requires complete selector preparation.

## Native proposals and report snapshots

Native proposal persistence appends or updates addressed candidates, versions, occurrences, questions and report versions and composes the final selection with the host's original-file/dependency/batch transaction. It does not construct a partial workflow and pass it to a legacy whole-workflow mutator. Complete package membership/context lookups remain required; presentation windows cannot establish negative evidence.

Report V2 versions contain an explicit immutable member snapshot descriptor, not an unloaded V1 array. One selected `report.snapshots` catalog captures nested member and confirmation partitions, permitting any number of changed snapshots to be selected through one catalog adoption. Member discovery order and retained duplicate identities remain literal; first-member joins and ordinal joins have distinct APIs. Canonical section access is independent of cumulative occurrence content. Whole canonical occurrence equality and the four-field source-coverage identity are separate indexes.

Candidate, contribution and report-version IDs preserve existing recipes. A genuinely new cumulative report version streams the complete canonical member input once for the old SHA-256 recipe; this is counted linear hashing work even when only changed member paths are written. Legacy report member conversion uses a private disk-backed JSON parser/sorter to preserve unknown fields, duplicate-key semantics and JavaScript number/string serialization without loading the old member array. That scratch database never supplies authority. Historical source-coverage exclusion includes every prior report version, including noncumulative retained history; its warm update adds only newly contributed occurrence identities.

The counters distinguish proposal entries, cumulative report hash items/bytes, changed snapshot checkpoint operations, tree reads/writes, explicit canonicalization work and legacy reconstruction. Scratch byte counters cover controlled spool I/O, and SQLite-call counts do not claim physical SQLite I/O or RSS. The implemented package inventory and retained-intake paths have [package qualification and work accounting](streamed-package-originals.md#qualification-and-work-accounting) and [complete clinical-review qualification](intake-bounded-views.md#selected-clinical-review-and-projection). Those results do not establish storage-only admission or qualify every import consumer: [CRS-232](../todo/CRS-232.md) retains text/JSONL and embedded-file consumers, and [CRS-233](../todo/CRS-233.md) retains storage admission and its unanswered owner choices.

## Native report source authority

Native source confirmations retain explicit member and coverage snapshot references in the selected report catalog. They do not represent unloaded members as empty arrays. Automatic compatible extensions append addressed evidence and update the checked confirmation index in the same final envelope/catalog selection. Cold preparation indexes retained confirmations once; absent or stale indexes refuse selected resolution rather than implying no source authority. Resolution preserves reverse confirmation order, original coverage before reverse extensions, exact occurrence qualifiers and historical provider eligibility. The logical confirmation hash expands native references to the original complete confirmation grammar, preserving unknown retained fields.

Explicit source review prepares the complete selected scope in disposable SQLite, including off-page members, first-introducing report references, historical contexts and source evidence. It preserves the existing full-scope token and uses bounded external sorting; this is counted whole-scope work, not a summary-read fallback. The V2 presentation contract returns separate exact counts and pages for targets, source coverage and source evidence. Cursors bind the full scope and logical selection. Long evidence uses previews with explicit truncation and exact UTF-8-safe JSON fragments; a preview never replaces source authority.

Source review reuses complete report-owner and exact review-draft routing for the same profile, original hash and selected logical root. This disposable connection-local SQL index preserves anchored-report precedence, the last historical owner and exact occurrence draft identity. At most 32 private source certificates are retained; eviction causes preparation, never a product count limit. Certificates bind SQLite changes (including rolled-back writes), peer changes, schemas and the collection registry identity. Unknown writes, cache damage or a changed selection invalidate them; an editable SQL readiness flag cannot establish completeness. Preparation runs outside transactions, publishes a certificate only after the full checked scan, and cooperatively yields in bounded windows. Routing rows/builds/reuses are counted separately from complete per-report scope hashing and sorting, which still run. These reuse rules do not make an arbitrary changed intake an incremental source-scope update.

Source-confirmation preparation checks exact retry receipts before requiring the old mutable version again. A new command composes its confirmation, source index, operation receipt and catalog selection in one envelope preparation. The host must retain original verification, the writer lease and the ordinary final transaction, including any new provider row. Module fixtures cover legacy hash/token parity, duplicate historical members, giant context/locator fields, replay, fragments and publication isolation. They do not by themselves qualify the complete HTTP presentation or installation capacity.

## Draft-history growth qualification

The fictional [draft-history regression](../../src/server/test/intake-draft-history-growth.test.ts) starts with 8 or 128 retained corrections, converts the selected legacy draft, and measures the next native autosave separately from upload, bridge construction and the first native history conversion. Both native saves hydrate no whole envelope or source DTO. The second save retains all earlier corrections and the previous immutable snapshot; rebuilding SQLite from the selected accepted journal reconstructs both snapshots exactly. Replaying the same command writes no accepted journal bytes.

| Measured second autosave          | 8 earlier corrections | 128 earlier corrections |
| --------------------------------- | --------------------: | ----------------------: |
| All accepted immutable/head bytes |             3,656,003 |               4,487,781 |
| Accepted immutable objects        |                   107 |                     109 |
| Accepted head publications        |                    34 |                      34 |
| Collection nodes written          |                 1,773 |                   2,176 |
| Collection node bytes             |             2,035,410 |               2,530,354 |
| Catalog checkpoint changes        |                     5 |                       5 |
| Existing inline path-cell bytes   |                15,247 |                  70,758 |

These measurements were refreshed on 2026-10-04 after batching small history entries. Authenticated tree path copies can carry existing separator values, each bounded by the 8 KiB encoded inline codec. These runs copied 7 and 33 such cells, containing 6 and 25 distinct earlier correction reasons; they did not write old native history byte leaves again. The counts establish growth behavior for these fixtures, not zero copying of every retained scalar or an absolute capacity target. Timestamp- and UUID-derived tree paths cause count variation. Cold upload/seed/bridge writes were 9,430,875 and 84,648,262 bytes, and the first native history conversion wrote 3,475,798 and 5,643,095 bytes; these are separate from warm mutation costs. Small history entries and their policy indexes use batches of at most 16 entries or 64 KiB; a text value uses one inline checkpoint only when its encoded wrapper fits the 8 KiB codec. Larger or heavily escaped values retain streamed leaves.

The journal fixture uses genuine accepted transactions and reconstruction with a memory-backed storage adapter. It does not measure physical encrypted writes, filesystem capacity or wall-clock performance. A companion Unicode fixture checks the same 20,027 UTF-16-unit value supplied in single-unit pieces or one whole string, including split surrogate pairs, bounded coalesced leaves, immutable publication and cache disposal. Batched current-selection checks retain exact text without a selected-tree traversal for every producer fragment.

## Exact serialization domain

Stored evidence decoding checks the same encoded UTF-8 byte limit before JSON parsing. It rejects literal unpaired UTF-16 surrogates without a temporary UTF-8 buffer round trip; it parses the original text, never a repaired string. Escaped JSON surrogate sequences retain their previous parsing semantics. Exact metadata schemas compare literal own enumerable key sets without sorting or mutating the expected names. A key containing NUL cannot impersonate several required fields through delimiter concatenation. These checks do not broaden the normalized value domain below or change the supported evidence format.

The native acceptance participant prepares the existing clinical SQL projection under a rollback-only savepoint and retains its exact changed-row plan. Verified auxiliary intake checkpoints may occur during envelope preparation; only the transaction owner's checked maintenance outcome can refresh that plan's metadata guard. An ordinary policy/source change still invalidates it. Final publication applies clinical rows first and selects the prepared envelope in the same ordinary transaction. A failed transaction requires a fresh envelope preparation for retry.

Acceptance archives the former `imported` receipt by moving its authenticated parent edge into `importHistory`; its existing clinical record descendants keep their addresses. New clinical records, decisions, selected candidate statuses and question resolutions scale with the approved scope. Exact workflow facts determine `imported` versus `needs_review`; a state-only second preparation rebinds derived roots without replaying proposal writes. Source-only JSONL acceptance preserves repeated rows and does not invent a clinical review token or clinical receipt.

Native draft correction history stays in immutable `review.snapshots`. Acceptance verifies the exact selected draft, candidate version and source-bound history before retaining its reference in the existing accepted-contribution decision. A clinical row stores only a constant `correctionHistorySource` marker when retained import corrections exist; it does not copy growing correction arrays or contribution-reference lists. Existing inline legacy corrections remain unchanged. The profile-authorized `/api/record-import-corrections` endpoint joins accepted contributions through the clinical record's current primary and evidence sources, pages their bounded history headers, and uses the review-history page/fragment endpoints for complete entries. Page cursors bind the profile, clinical record and review revision. Profile graph copy preserves these source identities, contribution decisions and immutable histories; neither reads nor copy depend on disposable SQLite record-version identifiers.

The assistant's native acceptance-only retry proof is an opaque, bounded, in-memory witness over the captured source/logical selection, verified auxiliary publications, the actual committed atomic receipt and accepted transaction. A private projection-and-envelope interval captures application changesets including metadata and touched record identities; the transaction owner compares these again before publication bookkeeping. Extra writes, including a changed-and-restored unrelated row, deny certification without altering acceptance durability. It does not substitute for request-context or physical-source checks. Its currently certified subset requires existing pending candidate versions, all touched versions accepted, and no changed question/comparison scope; other transitions refuse automatic revalidation. This optimization does not grant recovery authority to the in-memory witness or broaden coupled report acceptance policy.

The input root is a plain object (ordinary or null prototype). Its supported data recursively consists of such objects with own enumerable data members, arrays, strings, finite numbers, booleans and null, with JSON normalization of undefined: undefined object members are omitted, while undefined array positions and holes become null. Absent and null remain distinct. Non-finite numbers, bigint, functions, symbols, cycles, custom prototypes and the keys `__proto__`, `prototype` and `constructor` are outside this data domain. Callers must supply plain data without accessor properties, symbol-keyed members, proxies or custom `toJSON` behavior. A bounded descriptor preflight rejects participating accessor properties before the unchanged shared cloner reads values; custom serialization behavior is outside the data domain. This is not an arbitrary JavaScript object serialization API.

Within this domain, reconstruction preserves exactly `JSON.stringify` of the normalized input. Non-index object keys retain insertion order at every nesting level; JavaScript integer-index keys (canonical integer strings from `0` through `4294967294`) retain numeric enumeration order, distinct from ordinary integer-like strings such as leading-zero names. Arrays retain their positions; native number serialization also normalizes negative zero to `0`. Standard JSON escaping applies to keys and values, including quote/backslash/control characters, non-BMP Unicode and well-formed escaping of lone surrogates. No Unicode normalization or alternate escape spelling is promised.

Order-only edits, mixed reorder/value edits, middle insertions and deletion/reinsertion are durable changes. The codec plans key moves through a longest-increasing-subsequence basis and records individual changed-order evidence rather than resending all unchanged values or a complete growing key-order list. Nested objects follow the same rule. Array and string contributions preserve this same serialization domain; their matching rules and measured locality are described below.

This is an exact normalized JSON serialization contract, not arbitrary raw-text preservation. The [selected envelope authority](intake-envelope-authority.md) separately preserves untouched raw envelopes as exact strings until the first authorized rewrite. The V3 whole-envelope rewrite normalizes raw input; V4 addressed changes retain raw lexical templates and change only their selected cells. Its normalized root and private-copy bootstrap preserve complete outer-envelope member order and the intake slot's position, as well as the nested operational state. Reconstructing an equivalent object with a newly sorted or appended intake slot would change source-search behavior. The production access adapter selects the representation and integrates this primitive with application persistence.

## Array and string contributions

The v3 array operations have exact schemas. `array-splice` contains `path`, `offset`, `remove` and `values`; it removes a contiguous range and inserts only the supplied changed values. `array-move` contains `path`, `from` and `to`; it relocates one retained item, with `to` interpreted after removal. Moves retain child values and carry only scalar positions. The decoder validates paths, integral coordinates, target types, result lengths and insertion depth before mutation. Inserted values consume the shared node budget, while moves and splices charge array shifting work to the shared operation budget. These operations do not store an array snapshot or a growing list of retained references.

Planning first pairs exact ordered JSON values through occurrence queues, preserving duplicate array elements. For edited items it matches unique unchanged leaf paths and fixed UTF-16 content windows, weighting retained content rather than privileging an application-specific ID field. The next-side window scan streams its candidates; each unique signature identifies at most one old item, avoiding an all-pairs candidate comparison. A longest-increasing-subsequence basis retains array order where possible, and recursive deltas update the matched items. These transient indexes and matching serializations never become contribution or receipt payloads. Matching is deterministic but heuristic: the measured insertion, deletion, rotation and mixed-edit cases do not establish globally minimal array edits or guarantee that arbitrary ambiguous arrays can always be matched cheaply.

Strings use exact UTF-16 coordinates, including lone surrogates. Multiple splices are applied at descending original offsets, so unchanged text between distant edits need not appear in evidence. Bounded Myers alignment precedes exact 32-unit anchors and a monotone anchor subsequence. Repeated or misleading anchors cannot justify an unrestricted replacement: emitted text must stay within a fixed allowance derived from provably new character inventory or disjoint windows absent at every old offset. Otherwise the planner attempts further exact alignment within the same work allowance and refuses explicitly if it cannot resolve the match. Genuinely large changed text remains valid; there is no fallback that silently republishes an unresolved growing middle.

Per string, planning allows at most 100,000,000 comparison/scan units, 4,194,304 trace cells and 8,388,608 alignment steps. Prefix/suffix scans, anchor/window work and repeated alignment attempts share their respective allowances; failed work remains counted. These planning limits are separate from cumulative authority decoding limits. Complex string moves can exhaust planning work even when the input is valid JSON. Such refusal occurs before evidence publication; it does not change the supported serialization domain, migrate an old format, prune history or increase runtime capacity. The [mutation qualification](intake-mutation-qualification.md) distinguishes measured behavior from remaining capacity and full-view computation work.

## Transactions and private state

`mutate(next, operationId)` owns an application `database.transaction`. `stage(next, operationId)` requires that existing transaction and reuses it; nested `BEGIN` and savepoints are unsupported. Both return only a bounded result containing intake ID, logical version, operation ID and whether the patch changed state. `read()` returns a detached disposable JSON view. `readSerialized()` returns the exact normalized `JSON.stringify` representation of the supplied state, including object-member order; callers need not serialize a detached view to obtain authoritative search bytes. Neither view nor serialized result becomes another durable authority.

Operation IDs are UUIDs. A replay is bound to the normalized intended state fingerprint, including source scope and serialization order. Equal values with different supported object-member order are different intended states. Reusing an ID for different content fails. Replaying an older staged operation after later changes returns its original small result without rewinding current state. A no-op stores a bounded empty patch and receipt so its operation identity remains recoverable.

The internal materialization retains privately owned immutable state, exact serialized text, byte count and fingerprint for a verified selected basis. Internal readers can reuse it; public `read()` remains detached and mutable. Opaque process-local prepared intents normalize intended input once; arbitrary frozen objects or fabricated tokens cannot establish trust. Checked replay uses isolated copy-on-write ancestors and mutation targets, retaining immutable untouched children, and independently compares exact candidate text against intended text. Complete ordered SHA-256 fingerprints and logical decoder node/depth, array-shift and key-order charges remain unchanged. See [verified intake work reuse](intake-processing-work.md). Candidates use a separate private basis. Multiple staged mutations can read their tentative state in the same outer transaction; committed cached state advances only after successful SQLite commit, durability flush and release. Memory-only outcome observers also work when first registered inside the transaction. They do not change accepted-record publication ordering. A failed staged mutation marks its outer transaction rejected even if the caller catches the exception. Rollback, rejected publication, ambiguous flush or release clears disposable state. Accepted publication can survive a later exception: a stale SQLite projection then refuses reads and writes until ordinary accepted-record recovery restores it. An exception is not fabricated into a successful acknowledgement.

Cold reconstruction happens once per head/cache loss; ordinary successful writes do not reread ancestor payloads. The public profile lock, failed activation and application close paths clear this cache. Internal callers must close their storage handle or call `clearIntakeStateCache(db)` before disposing a separately managed database. Cache ownership is weakly tied to the database and never becomes recovery authority.

## Unpublished-target bootstrap

`src/server/intake-state-bootstrap.ts` prepares fresh target-bound intake evidence before a copy's first accepted publication. Both the encrypted and contributor private-copy callers integrate this primitive as described below. Production wrappers additionally validate complete original-to-chain coverage and the [selected representation](intake-envelope-authority.md), including compact metadata agreement and raw versus normalized roots.

`prepareIntakeStateCopySnapshot(snapshot, targetProfileId)` validates detached evidence. The snapshot contains the source profile, all original intake source rows with their raw details/source-pin values and preserved columns, and retained intake namespace rows. It validates current-format identities, source kind/ID/hash, head/frame/receipt chains and complete inventory, including malformed, headless, unknown-owner and unselected contributions. This pure validator does not certify that the caller captured a current selected publication or retained the original files correctly.

`prepareIntakeStateCopy(db, sourceProfileId, targetProfileId)` is the real-source wrapper. It requires an open database outside an application transaction, verifies the source owner and current accepted-record durability, captures a coherent read snapshot before owner/path changes, and checks selected durability again. The caller remains responsible for session authorization, the exclusive profile lease and the physical original files; a detached SQL snapshot or supplied hash alone does not prove those files exist or match.

Both return an opaque process-local `IntakeStateCopyPlan`, exposing profile identities and safe work counters while retaining validated source/prepared rows privately. A fabricated or deserialized plan is refused. Preparation validates and rebinds the supported selected graph and its retained history to the destination profile/source/hash identity. Retained V3 frames preserve every logical version and exact payload while minting fresh target-private frame and operation UUIDs. Internal operation receipts retain their fields apart from the rebound operation UUID; owner and predecessor references are rebound with newly checked hashes. V4 graph history and retained legacy edges are likewise preserved rather than collapsed into only the latest value. Public proposal/review/operation/acceptance receipts, stored intake/effective pin state and other state values retain their exact representation. These target-bound intake contributions do not authorize source accepted-record transactions. This is copy preparation, not old-format migration.

`stageIntakeStateCopy(db, plan, publication)` stages only in the caller's existing application transaction. The target must already have the target owner and intended source path rebinding, matching raw source details, original identity/hash/columns and source-pin values. Its copied intake inventory must match the captured inventory exactly. The target must have no attached transaction/record durability and no `__record_*` schema objects. The required `IntakeCopyPublicationReader` must identify that target and return `null` from the actual backend's `readSelectedHead()`; the caller must bind it to the intended backend under the exclusive target lease. A dummy reader is not evidence that a destination is unpublished.

Installation replaces only the captured source-owned intake namespace rows with prepared target rows, rechecks inventory and unpublished status, and returns bounded namespace/row counts. It does not rewrite raw `details_json`, source pins, originals or clinical rows. Unrelated metadata remains intact. Complete outer-envelope order/intake-slot position and untouched raw whitespace, duplicate-property spelling and escape spelling are retained because raw details are not reserialized. Caller-owned profile/path/Self-display and source-text rebinding must preserve their respective contracts.

A conflicting/partial target, published backend, attached durability, retained source record authority, invalid plan or mismatched original/inventory is an explicit error. A staging error rejects the outer application transaction even if caught. Transaction rollback removes tentative rows. Only a successfully committed installation transaction may proceed to genuine durability attachment and first accepted publication. Preparation does not permit runtime `createIntakeStateStorage` to bypass its normal configured-current-durability guards. The encrypted and contributor callers supply their respective publication/retry and activation boundaries described below; the primitive alone does not establish physical original retention or real-copy recovery.

Preparation has aggregate caps of 10,000 namespaces, 200,000 source-plus-prepared rows and 256 MiB of source-plus-prepared encoded bytes, with aggregate decode caps of 1,000,000 nodes, 1,000,000 operations/path steps and 100,000,000 string-copy units. Each source chain decodes under the remaining aggregate allowance, not a fresh default budget; understated head counters do not permit excess decoder work. Options may lower caps, never raise them. Counters separate source rows/bytes, reconstructed bytes, bootstrap root-clone volume, decoded work and prepared frame/head/receipt bytes. `sourceRows` counts captured original entries plus reserved namespace entries, not every SQL SELECT. `sourceBytes` counts JSON-encoded original entries including raw pins/details plus UTF-8 namespace key/value bytes. The shared cold decoder also collects a bounded consumed-key set for namespace inventory, including during ordinary runtime cold reconstruction; this allocation does not change runtime orphan-selection semantics. One-time validation, reconstruction and framing scale with copied state; subsequent ordinary attached-state mutations use changed evidence. No capacity or large-import qualification follows from this bootstrap API.

## Encrypted private-copy publication and retry

The encrypted `open(copyState)` path prepares selected source intake evidence before changing owner or path. In one destination transaction it rebinds the profile owner, source/asset paths and source-text revision authority, removes copied accepted-record projections, and stages fresh target intake evidence using the real target vault's selected-head reader. Raw source details and source-pin values remain exact. Original source ciphertext and its selected manifest are read for the copy; plaintext source workspace changes are not synced back into source authority as a side effect.

The caller then copies retained sources, attachments and mappings through authenticated source objects into independently encrypted target objects. Actual original references are checked before first accepted-record publication through the genuine target backend. The first head selects destination-bound state only. Current accepted clinical rows and pending state remain equal except intentional destination profile/path/Self-display rebinding; fresh internal bootstrap IDs do not replace retained public receipts, review identities or versions. This is a new independent copy, not restoration of the source's internal frame namespace or operation transaction authority.

Until a target accepted head exists, completing copy setup requires both the target's matching recovery proof and the requesting HTTP session's current source access. A globally unlocked source in another session, a stale source grant or client-supplied authorization flag is insufficient. An unpublished retry prepares a currently authorized coherent source snapshot. Physical files, source text and selected intake evidence must remain consistent; missing/corrupt/unsupported scope is an error, not an empty replacement.

Once any target accepted head exists, including after a publication followed by an exception or ambiguous completion, it wins. Verification, retry and restart open/rebuild that selected target state from its own recovery kit without recopying an advanced source or requiring source re-unlock. A failed request is not reported as successful merely because publication survived; recovery checks the retained target before completing activation.

A pending runtime open is installed in the opened-profile map only after recovery verification and registry activation. Registry activation follows the selected target's initial durable publication. Failure disposes its database/resolvers, clears private intake/lookup/chat caches and key buffers, and removes its runtime workspace while retaining any published target authority. Pre-activation failures leave setup unlisted. If diagnostics installation or the final response fails after keyring and registry activation succeeded, a visible locked target may remain and can recover normally; cleanup does not erase its activated registry entry or published authority. A partially written active keyring alone does not grant HTTP access to an unlisted setup. Before publication a retry may rebuild from the authorized source; after publication it must preserve and recover the target. Successful activation follows the existing one-unlocked-profile/session-revocation rule.

Preparation, original copy and initial publication perform one-time work proportional to retained state. Later attached intake mutations use changed evidence through the selected envelope authority. Encrypted and contributor runtimes both provide genuine accepted-record readiness. These mechanics do not establish installation capacity, large-import performance, physical-device behavior or power-loss guarantees.

The fictional encrypted integration and publication faults are exercised in [`encrypted-intake-copy.test.ts`](../../src/server/test/encrypted-intake-copy.test.ts), browser-session authorization in [`vault-copy-authorization.test.ts`](../../src/server/test/vault-copy-authorization.test.ts), and partial activation/unlock cleanup in [`encrypted-profile-activation-cleanup.test.ts`](../../src/server/test/encrypted-profile-activation-cleanup.test.ts). They use real encrypted storage and recovery without inference.

## Contributor private-copy publication and retry

The contributor-only `profile-lifecycle` copy path publishes staged intake through its genuine [filesystem accepted-record journal](contributor-record-authority.md). Portable personal/curation generations are explicit snapshot artifacts rather than the runtime publisher. This remains separate from encrypted product setup. A copy request requires a caller-generated lowercase UUIDv4 `operationId` before the request; retries reuse that ID with the same normalized display name and source profile. Persisted intent binds the operation to one target profile. Blank-profile and placebo creation are unchanged. See the [contributor lifecycle and recovery contract](profile-storage-and-rebuild.md#contributor-private-copy-retention).

Under the source writer lease, `preparePortableIntakeCopy` certifies that both the source SQLite view and its backup substantively match an independent reconstruction from the selected journal, then invokes detached bootstrap preparation before owner or path changes. It refuses dirty or conflicted sources before a readiness flush; it cannot publish unacknowledged source edits to make a stale view appear current. Missing, corrupt or mismatched evidence also refuses the copy. In the destination transaction, owner and paths are rebound, validated source-text revision authority is rebound, copied `__record_*` projections are removed and fresh target-bound intake is staged. Genuine target durability attaches after this transaction. Unrelated metadata, original bytes/hashes and accepted clinical state remain preserved except intentional profile/path/Self-display rebinding.

Contributor lifecycle preparation uses the asynchronous step driver while the existing synchronous preparation APIs retain their behavior. Original admission, complete receipt hashing, canonical row comparison, envelope projection, graph traversal and framing use bounded pieces and disposable disk work queues. Original source columns are retained directly, not hidden inside a serialized scratch row. Full receipt hashes include unknown fields even when eligibility uses a field projection. Raw whitespace, duplicate keys, number spelling and normalized member order retain their existing comparison rules; a projection alone cannot validate the original. Manifest fingerprints discriminate every preserved scalar column, including null and value type. Physical proposal validation retains its existing file and row limits.

Supported V3 history uses private disk replay instead of constructing a whole historical JavaScript value. It implements the same seven operations (`set`, `remove`, `truncate`, string `splice`, `move-key`, `array-splice` and `array-move`), validates every version's complete order-sensitive fingerprint and receipt, and retains the original node, path, array-order and string-work charges. Source frames remain bounded to 64 KiB and payload chunks to 32 KiB; replayed scalars are read in bounded pieces. The existing aggregate preparation caps and remaining allowance apply across all copied namespaces, including retained legacy edges; understated usage counters do not buy a larger decoder budget. Scratch databases and scalar files are disposable computation, never recovery authority, and are removed on refusal, cancellation or disposal.

The opaque contributor certificate binds the original database/profile/root/selected head, original physical roster and read owner, and independently rebuilt private selected scratch. Source, selected scratch and backup read intervals retain their original total-change, main/TEMP schema, data-version, owner, native-method and managed-method-epoch witnesses across asynchronous preparation; they are not refreshed after callbacks. Comparison and capture read genuine native SQL rows rather than mutable public statement or iterator results. Compilation still invokes the installed SQL policy, while cached native execution runs under the existing callback barrier. Callback writes, registration changes, TEMP shadowing and rollback ABA changes refuse rather than establishing a new baseline. The exact backup interval is consumed before authorized target rewrites, not compared against a later target baseline. A bounded, explicitly disposed physical-scope lease accounts for every managed mutation against the original root before event-ring eviction; unknown or intersecting events invalidate it permanently. Exact target-only portable mutation paths do not invalidate that source lease. Precision attribution requires string operands and single-link existing files; hard-linked aliases and unproven directory removal remain unknown. Unretained scopes retain their overflow refusal, and retaining a changed scope cannot renew it.

Source proof remains retained through target staging, attachment, export and publication callbacks. After the final callback-capable target checks and attempted-publication intent write, a worker verifies the same original complete physical roster again. Its host checkpoints use only retained native read intervals, the original read-owner identity and physical scope. Function entry still performs a genuine policy-authorized preflight before this terminal worker phase. The worker returns a private exact-certificate, one-use publication seal; its immediate owner-controlled consume is callback-free and followed by the directory rename without an intervening application or SQL-policy callback. It is not a transferable freshness promise across arbitrary later asynchronous work. Published-target activation and retry continue to use the target's own accepted proofs independently of a subsequently advanced or absent source.

This boundary does not make all copy work cooperative or all buffers fixed-size. Selected-table equality, original capture and manifest access still receive complete SQLite TEXT/BLOB columns on the host before processing them in pieces. Chunked hashing avoids another giant encoded-row buffer, and bounded intake projection avoids a giant parsed JSON object, but neither claim bounds the original native column string or byte array. Source-text validation still fully hydrates its value inside the worker; worker containment is not a bounded-buffer claim for that decoder. Source/attachment tree copying, target SQL installation, target durability attachment and portable export remain synchronous. Legacy replay's bulk SQLite deletion and ordering operations can also perform work up to the admitted collection size in one native VM call. Cooperative preparation steps and bounded processing pieces do not qualify these remaining phases, encrypted-copy responsiveness, installation capacity or the whole large-import workflow.

Portable export, load and rebuild retain exact `app_meta` values and raw source strings. Their readers validate reserved intake inventory, selected chains, original bindings, source pins and source-text chain ownership under bounded validation. Source-text validation caps encoded metadata and cumulative decoder reads at 256 MiB, counting references through retained history; exhausted budgets refuse explicitly and do not constitute capacity qualification. Pending views retain stored intake and effective source-pin versions, proposal/review identities and public operation/acceptance receipts. Complete normalized envelope/member order remains exact; untouched raw `details_json` whitespace, duplicate-property spelling and escape spelling are not rewritten by the copy.

Receipt handling distinguishes live accepted People from operations whose supporting history is not copied. Accepted intake People receipts stored under `personal_assistant_*` remain active after profile rebinding, retaining their public proposal, person, note and version identities. Source `personal_assistant_*` and `personal_restore_*` receipt strings are also retained exactly under `private_copy_source_receipt:v1:<sourceProfileId>:<originalKey>` in `app_meta`. Generic assistant/restore receipts depending on uncopied chats or historical generations are removed from active target replay; their archived strings remain source evidence. A shared key prefix alone does not make an accepted People receipt disposable.

The staged journal is independently validated before final profile-directory rename publishes the target. Before attempted publication is recorded, a failed unpublished stage can be cleaned up and preparation retried only against a currently available coherent source. Persisted intent pins the initial target record head and portable artifacts before publication and marks `publicationAttempted` before rename. After publication, the same operation recovers the final destination independently of an advanced or absent source. A never-registered target must match its pinned initial heads and requested name before activation. A registered completed target instead retains its current selected head, later accepted edits and current name, even if the source advanced or disappeared. An already active target retry checks durable readiness. Missing SQLite caches reconstruct from selected journal evidence. A valid earlier accepted cache can catch up from a published head, while conflicting or unacknowledged SQL changes refuse. A process crash between saving `publicationAttempted` and rename can leave an unpublished stage but no final target. Restart cannot distinguish that case from a deleted published survivor, so missing final storage with published or ambiguous intent refuses automatic recopy; retain the intent and available archive/stage evidence for explicit operator recovery. Only the live failing operation can clear an attempted-publication marker when its surviving stage and absent final directory prove that rename did not publish.

Physical original copying and hash checks, SQLite backup, full selected-table comparison, bounded intake decoding/cloning/framing, portable export and rebuild scale with retained state. Existing contributor-profile opening also performs independent journal reconstruction and comparison; bounded mutation rows do not imply changed-only opening or copy computation. Contributor `attachPersonalDurability` now supplies the same accepted-record transaction boundary for intake `app_meta`, source metadata and clinical state. These mechanics do not establish capacity, large-import, provider, physical-device or power-loss qualification. The fictional contributor lifecycle and failure matrix in [`contributor-intake-copy.test.ts`](../../src/server/test/contributor-intake-copy.test.ts), alongside [`profile-lifecycle.test.ts`](../../src/server/test/profile-lifecycle.test.ts), exercises retry, source preservation, original verification and rebuild boundaries.

## Bounds and measured work

Default cumulative limits are 256 MiB of selected frame and receipt bytes, 100,000 frames, 1,000,000 decoded nodes, 1,000,000 decoded operations/path steps and 100,000,000 string-copy units. Writer candidates and cold reconstruction share the same decoder budget. Candidate limits are checked before staging SQL rows; cold reconstruction checks each receipt addition before processing another logical operation. Internal test options can lower these limits, never raise them. An exhausted history is rejected explicitly; rotation or compaction is not implemented by this primitive.

Counters distinguish ancestor reads/cold reconstructions, attempted frame writes/bytes and emitted patch operations. `normalizedStateBytes` measures normalized serialized input volume; the legacy whole-candidate clone counters, including `candidateCopyBytes`, measure full candidate cloning and remain zero on the isolated replay path. `candidatePathCopies` and `candidateCopiedMembers` separately count copied ancestor objects and their members. `readCopies` and `readCopyBytes` measure detached `read()` clones, while `serializedReadBytes` measures complete `readSerialized()` output volume. The serialization helper accepts an already-normalized object and does not perform another hidden clone. Generic mutable-input normalization includes a bounded descriptor-validation traversal followed by an ownership-copy traversal. Already owned immutable trees can be reused while retaining the prescribed logical node/depth budget charges. Generic mutable inputs retain validation and ownership-copy costs. Full-state order-sensitive hashing, diff traversal, longest-increasing-subsequence order planning and public detached reads still scale with the in-memory view; internal immutable reuse and isolated candidate copies avoid repeated full descendant clones. A key move charges target-object member enumeration to the cumulative operation budget; bounded durable move evidence does not make host replay work constant. Serialized volume is evidence about copied data, not an exact count of object visits or CPU work. Incremental durable writes do not imply incremental host computation.

`intakeWorkCounters(db)` aggregates internally created production handles and attributes logical host work separately to warm operation and reconstruction phases. It counts normalization validation/clone nodes, validated string units, trusted copies, immutable reuse, candidate ancestor copies, serialization/hash/parse volumes, diff visits, array matching serializations/items and string alignment steps/trace cells; logical decoder charges remain separate from avoided physical copies. It also separates envelope hydration and complete source DTO serialization from compact source-row bytes. `collectionNodeReads` and `collectionReadBytes` count raw page reads; `collectionNodeCacheHits` counts avoided raw page reads, and `collectionReadWitnessQueries` separately counts the SQL queries needed to certify reuse. A simple selected collection read currently uses six witness queries even when both page reads hit the cache. Fewer raw bytes therefore do not establish less total SQLite work or faster execution. The `schemaBuild*` counters distinguish emitted and replayed primitive operations, input/transcript/export hash bytes, scratch reads/writes and cooperative replay/export turns. Actual new collection nodes and accepted-journal bytes remain separately measured; replaying input without new prefix writes is not zero work. Counters retain no source values or identities, survive disposable-cache invalidation for the connection, and include failed work. Initial registration, first raw-to-normalized conversion, opening/reconstruction and warm mutations must be sampled separately. These activity counts overlap and do not measure JavaScript allocation, every runtime string operation, SQLite VM/index work or total CPU instructions. In particular, `normalizeValidatedStringUnits` measures visited string content, not physical copies of immutable JavaScript strings.

## Selected-authority locality measurements

The historical pre-reuse fictional [`intake-mutation-locality.test.ts`](../../src/server/test/intake-mutation-locality.test.ts) exercises real `writeIntakeDetails` and `stageIntakeEnvelope` calls with warm lookup/search projections at 20, 80 and 160 report groups. Each size performs front insertion, deletion, rotation, simultaneous retained-item edits and rotation, and distant string edits with misleading repeated anchors. Independently constructed expected envelopes are compared exactly after each mutation and after rebuilding the entire SQLite cache from selected accepted authority. Transaction callbacks discard the writers' full serialization return, so transaction results do not accidentally journal that view.

| Report groups | Initial normalization accepted bytes | Largest later delta bytes | Largest later frame bytes | Largest later accepted bytes | Largest source-text projection bytes |
| ------------- | ------------------------------------ | ------------------------- | ------------------------- | ---------------------------- | ------------------------------------ |
| 20            | 158,312                              | 328                       | 1,095                     | 5,514                        | 4,150                                |
| 80            | 619,091                              | 328                       | 1,095                     | 5,524                        | 4,094                                |
| 160           | 1,240,850                            | 331                       | 1,100                     | 5,532                        | 4,115                                |

Every measured later mutation emitted one contribution frame, one intake head and one operation receipt, plus two accepted immutable objects and one accepted-head publication. It updated no compact source row. Search projection content writes stayed at most 163 bytes; mixed item edits and rotation wrote eight occurrence rows and ten link rows at each size. The projection byte column counts logical changed-row payloads, not physical SQLite allocation. No unchanged growing array values, string middles or complete retained-reference lists were written in these cases.

In that historical pre-reuse measurement, lookup ordinal metadata had a separate cost: front insertion wrote 22/82/162 lookup rows and 1,986/5,830/11,235 bytes at the three sizes; deletion and rotation likewise shifted ordinal rows. Those small metadata rows do not contain the growing operational payload, but their write count is not constant. These earlier measurements establish locality of their contribution/content paths, not current format-2 lookup costs or universal bounded work. Current lookup references preserve identity occurrences through linked ordering without renumbering later ordinals; see [verified intake work reuse](intake-processing-work.md). The [combined mutation qualification](intake-mutation-qualification.md) reports this cost alongside actual batch/review growth and recovery evidence.

The accompanying [`intake-state-codec.test.ts`](../../src/server/test/intake-state-codec.test.ts) covers duplicate elements, nested order, edited-and-moved strings/items, numeric-index members, Unicode and lone surrogates. Four distant edits in a 1,260,000-unit periodic string emit exactly their 11 inserted units; four distant 100-unit replacements emit 400 units. Separate cases retain genuinely large changed text and explicitly refuse exhausted matching work. These are supported-pattern regressions, not an optimal-edit proof or installation capacity qualification.

## Historical order-preserving fixture measurements

The retained order measurements below were collected with the earlier v2 primitive, separately from the scalar-update baseline. They are historical evidence for those bounded fixtures, not a rerun of current v3 production qualification. They count all accepted immutable authority (record segments, commits and head), SQLite history/projection allocation, and primitive frame/head/operation-receipt values. They are not installation capacity targets or production intake qualification.

Single-key moves in both directions emitted at most 64 payload bytes and 739 serialized mutation-frame bytes for a 103-byte state, a 144,086-byte state with unchanged large payload, and a 9,247-byte object with 512 equal-valued siblings. Each move uses one changed-order operation; unchanged payload size and sibling count do not add a complete value or growing order manifest to the durable patch. The large-payload scenario measured:

| Mutations | Total frame bytes | Head bytes | Total operation-receipt bytes | Accepted authority bytes | SQLite allocated bytes |
| --------- | ----------------- | ---------- | ----------------------------- | ------------------------ | ---------------------- |
| 0         | 195,259           | 413        | 246                           | 209,612                  | 765,952                |
| 100       | 268,455           | 421        | 24,940                        | 741,435                  | 2,478,080              |
| 200       | 341,955           | 422        | 49,740                        | 1,275,069                | 4,214,784              |
| 300       | 415,455           | 422        | 74,540                        | 1,808,769                | 5,947,392              |

A separate 129,045-byte initial state received 300 individual middle-key insertions, ending with 303 keys. At 100/200/300 mutations, each sampled patch had 118 payload bytes and an 811-byte mutation frame. Each insertion emits the changed value plus one bounded placement operation; cumulative patch-operation counts including initialization were 201/401/601. Its measurements were:

| Mutations | Total frame bytes | Head bytes | Total operation-receipt bytes | Accepted authority bytes | SQLite allocated bytes |
| --------- | ----------------- | ---------- | ----------------------------- | ------------------------ | ---------------------- |
| 0         | 174,558           | 413        | 246                           | 188,191                  | 724,992                |
| 100       | 255,346           | 424        | 24,940                        | 727,772                  | 2,420,736              |
| 200       | 336,446           | 425        | 49,740                        | 1,269,337                | 4,186,112              |
| 300       | 417,546           | 425        | 74,540                        | 1,810,937                | 5,910,528              |

Across these order fixtures, individual operation receipts stayed at most 248 bytes and heads at most 426 bytes. The large initial state required multiple frames; the largest initial frame was 44,337 bytes. Warm mutations performed zero ancestor payload reads and zero cold reconstructions. Separate accepted-record storage reads were 16 initially and 1,016/2,016/3,016 at 100/200/300 mutations; zero primitive ancestor reads does not mean the surrounding journal performed no reads. Accepted transaction results stayed at most 156 bytes.

At 300 large-payload moves, normalization processed 43,369,886 serialized bytes, 300 candidate clones represented 43,225,800 bytes, and serialized reads returned 43,225,800 bytes. For middle insertions those counts were 39,745,545, 39,610,500 and 39,616,500 bytes respectively, with 300 candidate clones. These fixture paths used `readSerialized()` rather than detached `read()` clones, so their detached-read counters were zero. Full traversal, hashing, diff/order planning and shallow move enumeration remain host costs; these byte counters do not count every object visit.

The [current mutation qualification](intake-mutation-qualification.md) counts the existing record projection and accepted storage as well as primitive contributions, separately from SQLite allocation and host work. These historical primitive fixtures do not prove actual batch/review storage growth, model performance or large-import completion.

Native feed rows can reuse a completed review only while its original, per-row source, request, queue, SQLite change/data/schema (main and TEMP), and storage-registry pins remain current outside a transaction. A private key per disposable feed signs the exact cached row, member, group, ordering and certificate bytes; modified scratch rows fail instead of becoming clinical authority. The host rechecks every emitted certificate immediately before returning, and still verifies retained original/proposal files. A mismatch performs a fresh complete review; no final stamp blesses earlier rows. Signature calls and bytes are counted separately. Review issue policy uses a bounded private SQLite scratch connection per session, shared by its source scopes, so read-side policy construction does not mutate the authority connection. Refusal, cache clearing and session closure release that scratch; scalar resource counters expose actual live databases, scopes and rows for lifecycle checks.

Public clinical page, selected-record and fragment reads retain at most one completed, read-only proposal session per database connection. Its source/proposal key and captured owner, source, request, SQLite and registry pins must still match; retained original and proposal files are verified on every request. Only bounded page/record/fragment requests can use this path, and returned wire values are detached from private policy while preserving literal number spelling. Mutation preparation remains separate. Overlapping unchanged reads can complete; a superseded read cannot replace or discard a newer cached session. Preparation runs before proof capture, and there is no asynchronous work while a retained session is borrowed. A changed proof, refusal, replacement, cache clear or profile lock disposes the applicable session. Transactions neither reuse nor seed it and retain existing readiness refusals. Complete public-review constructions have their own work counter. Within each complete review, exact group/version lookup first checks the indexed first retained group and falls back to the complete ordered search when a later duplicate version may qualify. Results share the existing bounded, current-state-checked 32-entry cache discipline, preserving duplicate-group/version and fallback ordering.

A successful feed window may retain one completed proposal review within its existing queue cache (at most four queues globally). Later windows refresh only emitted stale rows from that exact current review; they do not rewrite all unchanged rows after an edit. Queue review results expose detached record transport, original record byte counts and complete precomputed policy facts, never mutable sessions or provider aliases. Every reuse checks current owner/source/request/queue and SQLite/registry state; files are verified before emission. Failed opens, failed reads, transactions, replacement, cache clearing, profile lock and actual database closure dispose retained policy. Capacity is rechecked after asynchronous cold preparation, so concurrent opens cannot exceed the bound.
