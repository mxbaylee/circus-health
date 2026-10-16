# Append-only record versions

The default encrypted runtime stores append-only record versions and has synthetic durability, rebuild and history tests. [Encrypted profiles](../security/profile-encryption.md) and [original-file reuse](storage-accounting.md) are integrated with the version store.

## Storage contract

Keep original uploaded artifacts unchanged. Store new accepted versions of individual records in an append-only logical JSONL stream. Editing a person appends that person's new version, not a copy of every person, note and clinical table. Reviewed imports append versions for new or changed records and retain acquisition/source occurrences according to the existing reconciliation rules.

Each version contains its stable profile ID, entity kind and record ID, unique version ID, previous-version reference, transaction/operation ID, schema version, commit sequence, recorded timestamp, known actor/action origin, complete record contents, and applicable evidence/correction references. Preserve all literal fields and distinctions such as absent versus null, exact versus partial dates, and original source status. Do not invent actor identity or confuse when the app recorded a change with the clinical event date.

Use complete versions of changed records rather than patches that require rerunning old application business logic to determine their contents. Large original documents and attachment bytes remain shared immutable objects referenced by records. No update writes another complete archive snapshot merely to make the changed record durable.

Relationships must have explicit versioned semantics too. Removing a link creates a new version showing the association as removed; it does not erase the old association. Archive/restore records visibility changes without deleting evidence. Version storage does not grant permission to edit imported originals or finished historical notes: existing source/finished-note restrictions still apply, including creating a linked correction note when required. Ordinary links retain the existing behavior of resolving the target's current version; an audit entry can identify the specific versions involved in an edit.

## Bounded transaction manifests

New accepted transactions use commit format `health-record-versions-v2`. Their complete changed-record JSONL envelopes remain `health-record-versions-v1`; the change is how the commit names its segments. A small `health-record-segment-index-v1` descriptor holds the total segment count and the final immutable manifest-page reference. Each `health-record-segment-page-v1` page contains at most 64 segment references, its first segment ordinal, the previous page reference, and the exact profile, schema, sequence and operation binding. Pages are limited to 32 KiB by this producer-controlled format.

The writer verifies each segment and manifest page before publishing the small commit and then the existing accepted head. One transaction remains one atomic acceptance, regardless of its segment count; there is no operation-size cap or silent split. Failure or cancellation before head publication leaves the prior accepted state intact. A complete authenticated single-page manifest replays its at-most-64 references directly. Multiple pages use a temporary SQLite ordering index; both forms are disposable work and never recovery authority. Recovery checks every page's hash, byte length, binding, contiguous ordinals and total count before yielding references. Repeated links, missing pages and inconsistent counts refuse recovery. `segmentOrderingScratchOpened` counts ordering-index path entries separately from logical references spooled and replayed. Segment payload authentication and complete version validation are unchanged.

Readers retain compatibility with v1 commits whose segment references are an inline array. Existing historical monolithic commit objects and individual legacy record values retain their existing whole-object decoding boundary; this format does not retroactively make those encrypted objects streamable or change their contents. New manifests keep the writer and reader's segment-reference windows bounded. Complete changed record values, transaction results and attribution remain the domain's responsibility; a domain must return a small receipt rather than a complete report in the transaction result.

Older application builds refuse v2 accepted commits. Before the first candidate write, retain the checked pre-update backup and prior build described in [installation updates](../setup/release-updates.md). Recover that separate backup with the prior build if needed; do not remove new heads or manifest pages to force a downgrade. SQLite schemas and encrypted object framing are unchanged by the manifest format.

Fictional journal tests cover hundreds of segments, exact forward row order, v1 compatibility, bounded reference counts, invalid page links/counts/profile/operation bindings, cancellation and interrupted publication. They do not qualify arbitrary installation capacity or remove the historical per-object decoding limit.

## Prepared publication backing

The private original-backed prepared-write path can retain authenticated vault
version certificates across its own accepted writes. A cold preparation verifies
the existing history. Subsequent preparations reuse that history only through the
exact committed transaction's one-use grant, retaining the original namespace
and physical identities plus that transaction's checked immutable additions.
The successor is captured during HEAD installation, before outcome observers;
a later filesystem state cannot become the reuse baseline. Uncertain or failed
staging invalidates reuse. These certificates are disposable, never recovery
authority, and ordinary full-record certificates do not authorize compact
metadata-only publication.

The two-write fictional regression checks exact accepted values and HEAD changes,
business execution once per write, a cold first traversal and zero historical
version decoding on the second. Complete physical verification still runs.
This private-path result does not establish public ownership, prerequisite or
group integration, nor changed-only physical verification or general capacity.

Contributor and vault backing workers load recovery modules only for cold
preparation. Later physical-only checks do not load the application database,
storage adapter or record replay modules. Both complete signed physical passes,
membership checks and owner checkpoints remain unchanged; this reduces worker
initialization work, not the number of originals verified.

Cold backing workers construct derivative certificate trees in batches of at most
64 certificates. Each certificate retains its exact entity/key, version, tombstone,
preimage and field digests; only final reachable shared tree paths are inserted for
each batch. Cold preparation orders fixed-size certificate keys, version digests
and current-row pointers in a disk-backed, bounded-cache SQLite temporary roster,
then reads and digests each complete current version individually in key order.
The roster rejects a changed key or version pointer and never stores complete
version contents. Earlier roots remain immutable. The temporary tree shape may differ
from per-key construction, but membership, absence and certificate contents do not.
Vault quoted-string and contributor raw-document predecessor digests remain distinct.
This reduces private tree page work without widening compact certificate scope,
skipping accepted-history replay or removing complete physical verification. It
does not bound the native SQLite column values read before digest construction.

Incremental contributor and vault replay append the changed certificate batches
inside one private SQLite transaction, rather than committing each tree page
separately. Retained scratch continuity is checked before commit; failure rolls
back the transaction and discards reuse. This changes only disposable index work,
not accepted publication, predecessor checks or original physical verification.
Contributor replay checks the retained owner, including the original HEAD,
selection marker and physical parents, before and after each synchronous
certificate lookup or at-most-64-certificate insert window, while checking the
pinned scratch and write witness during tree page work.
An interrupted window cannot supply a predecessor or new root to the retained
proof. The worker, terminal and publication checks remain unchanged; these
windows do not create an atomic cross-process filesystem snapshot.

Changed-key predecessor preparation appends its private prior rows in one SQLite
transaction, then commits before a cooperative seal verifies the exact signed
membership. The seal checks the selected parent authority around each work
quantum of at most 16 KiB or 64 signing pieces; cancellation or changed state
refuses and disposes the transport. It does not skip the newest-first accepted
history walk. Individual SQLite TEXT reads, JSON decoding, and append or match
signing still run synchronously; this is not whole-value transport closure.

Prepared changed-row scratch storage retains each complete JSON row as signed,
ordered UTF-8 BLOB pieces rather than one SQLite TEXT column. Preparation reads
one piece at a time by its exact row and part key; the row cannot be trusted or
published until its complete HMAC and membership checks finish. Malformed
UTF-16 input, changed membership and abandoned streams refuse and dispose the
scratch. The private typed-statement index likewise stores fixed argument
metadata and at most 16 KiB BLOB pieces instead of one whole scratch scalar.
It snapshots mutable BLOB input before yielding and validates immutable text.
Small immutable arguments share text-scan and staging work quanta instead of
repeating caller/authority checks for each scalar. Staging yields before exceeding
16 KiB of scalar pieces or after 64 arguments; caller and scratch checks still
bracket every host yield and completion. Signing, readback and final physical
publication checks are unchanged. Private native argument reads do not invoke
application callbacks. Physical scratch checks bracket each signing quantum
and each complete synchronous decoded row, rather than each small argument;
generator resumption checks still reject replacement between exposed rows.
Stored values are signed cooperatively, then reconstructed one typed argument at
a time for final replay.
These are disposable host transports, not accepted formats or recovery authority.
Tentative row capture and mutable BLOB snapshots still run synchronously, and
complete values are still materialized by some SQLite source reads and final
terminal bindings. This work does not establish a whole-value native memory bound.

For encrypted vault and contributor-backed compact metadata-only publications,
the old `source_files.details_json` and selected old
`__record_versions.contents_json` preimage are read from a separate, pinned
read-only snapshot of the committed managed SQLite file in at most 16 KiB
pieces. The source row's other columns remain scalar reads. Preparation
compares the exact serialized old source row to the selected prior. Vault
preparation derives the accepted certificate's quoted-string and field digests;
contributor preparation derives its distinct raw-document preimage digest and
requires the complete signed accepted-original worker proof before admitting
the selected predecessor. Its final worker checks complete original membership,
physical identities and exact owned immutable additions before the fixed
publication consumes its one-use grant. After an ordinary accepted contributor
HEAD is published and read back, a clean, idle derivative may queue a bounded,
factory-issued receipt of that exact HEAD transition and its newly created
objects' physical identities. These provisional receipts do not authorize
reads or writes. Before reuse, the next capture reconciles the whole namespace
against the original signed roster and exact receipted additions; the worker
then verifies the complete recorded commit chain and all added objects.
Unexplained changes, missing or replaced objects, receipt overflow or failed
reconciliation discard the derivative and require a cold proof. The full
namespace observation occurs at capture, not after every intervening ordinary
publication; no provisional proof can be consumed between them. Poisoned or
active derivatives are never silently renewed. The read-only
snapshot and retained worker roster are transports, not authority: accepted
versions, managed SQL policy, method and write epochs, source/head pins,
physical backing and final publication checks remain required. Changed or
unavailable witnesses refuse publication. The snapshot is a second node:sqlite
connection to the same file; no other SQLite library or raw descriptor opens
the live database, WAL or `-shm`, because POSIX locks are per process and a
second library copy (or closing a raw descriptor) would silently drop or bypass
node:sqlite's locks. node:sqlite has no incremental BLOB API, so SQLite loads
each read value once, whole, in its own memory and the host receives bounded
16 KiB slices of that one value: the host pieces are bounded, the SQLite-side
materialization is not. A newly written giant target, other whole-column reads,
complete record encoding and final SQL bindings retain their separate
whole-value limits.

One contributor backing worker belongs to a retained staging proof. Serialized
prepare, advance and verify jobs use monotonically increasing IDs; checkpoints,
certificate chunks and terminal replies must belong to the active job. Reuse
amortizes worker startup and module loading only. Each job opens and closes its
own required handles, resets its work state and checks the original physical
roster. Prepare reconstructs accepted history; advance verifies the exact own
chain; verify retains its complete physical checks. Each job clears its cloned
signing key before replying. No previous job's open handles or physical scan
result authorize the next job.
Within one job, the common physical-member signer shares one private native
secret-key representation. Every entry still computes its own signature over the same
bytes; both complete physical sweeps and their membership checks remain.
Completion or refusal drops that native-key reference and wipes the cloned
input buffer before replying. This avoids repeated key conversion, not HMACs,
physical reads or proof checks. Dropping a native reference is not a guarantee
of immediate native-memory zeroization.
Each dispatched job preserves its initiating async-local operation context
through checkpoint, certificate and terminal callbacks; worker reuse does not
reuse the first job's operation context.
Stale or repeated replies, refusal, cancellation and owner closure revoke the
session. The final publication callback remains synchronous in the terminal
reply turn and cannot be invoked twice by a reentrant reply. Disposal revokes
the proof immediately, then waits for worker exit before removing scratch;
cleanup failures emit a sanitized warning rather than silently disappearing.

The committed reader still refuses any change in database, WAL or shared-memory
file identity. Before a consumer starts, the accepted-source coordinator may
discard a refused scope and acquire a fresh complete proof when only the
shared-memory timestamps moved and every other physical, SQL, method and policy
witness remains identical. This spends the existing four-attempt unexplained
retry budget and clears the retained format cache. It never rebases a live
reader or retries this reason after consumer entry, including idempotent
consumers. Structural changes, concurrent policy changes and cancellation still
refuse; direct committed-reader callers receive the original refusal.

An internal, read-only accepted-source proof can pair one requested
`source_files` version with the `app_meta` V4 HEAD version from the same
validated record commit during a complete vault or contributor original-worker
replay. The private, nonce-signed result retains only bounded descriptor and
HEAD bytes, version IDs and the latest accepted source version ID under a
current accepted-HEAD read owner. A separate current-descriptor read requires
that latest version to match the requested version and compares the selected
current pointer, source ID/hash/kind and exact bounded `details_json` under the
same managed SQL and original interval. Historical pairs remain readable after
a later legitimate source version but cannot pass that current check. This
proves only the descriptor and named selected fields, not the remaining source
row columns. The existing filename-fragment POST can read an internally issued,
current V3 filename reference in at most 16 KiB of UTF-8 text per response,
using the accepted historical V4 cell and signed filename facts. `GET
/intakes/:id` issues that reference in the public V3 summary, together with
accepted current `metadata` and `acquisition` read through bounded current
fields: a field over the budget leaves `metadataState` or `acquisition`
`unloaded` rather than refusing, and an absent acquisition stays `unloaded`
because its provider-row fallback is not proven by the scope. Review counts,
the active plan and the provider name remain `pending`/`unloaded`. The intake
list and the plan, read, package-failures, source-text and source-issues GETs
read a V3 row under their own accepted proof, binding presented source facts
(the literal window's path, bytes, hash and MIME type, the package-failure
pins, the source-text hash) to it; the list merges V3 summaries into the legacy
SQL order with one proof per listed V3 row. Review and reader coverage depend
on selections outside the accepted scope and are refused or omitted. No
production path yet writes a V3 descriptor, and the existing v1
filename-reference branch is unchanged. The existing accepted format
and recovery behavior are unchanged. Each independent HTTP request acquires a
fresh accepted read scope; there is no cross-request authority cache. Cold proof
still replays complete accepted history, and SQLite may process a whole
malformed derivative scalar internally while evaluating bounded-prefix
equality. Neither that cold work nor whole-native-value closure is claimed
bounded by this internal capability.

Contributor optional pair selection can reuse a worker-signed receipt for the
exact request and selected HEAD, including an explicitly signed absence. Reuse
requires the same continuously retained, idle replay derivative, unchanged
owner and scratch witnesses, no pending own publications, and fresh complete
physical sweeps before and after verification. Missing signatures, replacement,
sidecar residue or changed selection require cold reconstruction. A required
pair never accepts an optional absence. This avoids repeating worker selection
and replay for an unchanged request; the receipt does not replace originals,
fresh physical verification or the final publication proof.

Vault readers can retain a previously worker-verified positive source pair for
the exact request, HEAD and binding kind. Reuse pins the original sealed replay
through fresh physical verification and closing owner/scratch checks; it does
not reseal a changed derivative. Own publications, unfinished staged changes,
different requests and replay replacement or sidecar residue prevent reuse.
Optional absence is not cached, and a caller without a pair clears the selected
pair. Original worker signatures still authenticate the pair; the private
selection is not a new recovery authority.

Main-thread certificate lookups on factory-owned scratch connections without
authorizers or user-defined functions use one synchronous native read span.
The owner proof opens and closes that span, including on refusal; every tree
page, source binding and certificate payload is still authenticated. Caller
inputs are detached before admission. Custom statement preparation falls back
to per-page checks, as do generic codec callers and worker checkpoints.
Certificate writes are unchanged.

Retained contributor advances can batch predecessor reads for at most 64
detached keys under one pinned certificate root. Native batches reuse at most
128 authenticated tree pages only within that synchronous invocation. Scratch
and complete retained-owner proofs close before any result is consumed; the
private read capability expires on success or refusal. Raw certificate digest,
identity, absence and tree source-binding checks remain required. Custom
statement preparation keeps the original per-record opening and closing full
owner checks. No read cache survives a batch, yield, write or root change;
certificate insertion and transaction rollback are unchanged.

After verified incremental contributor replay, final certificates for touched
records are ordered by fixed-size membership hash in a disposable disk-backed
roster before entering the existing signed chunks. The roster retains only
keys, current-row pointers, first changed sequences and version digests, not
record payloads. Repeated changes retain the first predecessor and final current
version, including deletion and resurrection. Replay chronology, source-pair
folding, signature protocol, chunk bounds and closing physical proofs are unchanged.
Original replay and roster witnesses must remain valid through cleanup before
the result can be adopted. Ordering reduces repeated tree-page writes across
chunks; it does not remove full cold replay, and the touched-key query can still
inspect earlier profile history under the existing index. This is not a claim
that every examined row or verification cost scales only with changed records.

Fixed-path HEAD witnesses retain open file descriptors and pin every canonical
ancestor through the filesystem root. Each hot check brackets full endpoint
identity checks with two deduplicated ancestor sweeps; capture also closes with
an all-file and ancestor check. Replacing or changing an ancestor refuses the
witness, including ancestors above the explicit storage parents. Unrelated
sibling writes remain allowed. These separate filesystem observations are not
atomic path confinement or a new mount-namespace or network-filesystem guarantee.
Ordinary HEAD stat checks still include every explicit parent's inode and mode;
only canonical-path resolution is shared by nested parents. Accepted-read
checks retain their native SQL interval and opening/closing owner proofs.

The internal referenced-envelope scope requires an explicit current or historical
selection. It resolves only the original-name and source-label fields through
the authenticated historical V4 schema, checking its mode even when a field is
absent. Bounded field parts retain the original accepted-head and physical
witnesses rather than repeating cold replay for every part. Cancellation,
between-part physical changes and final-close changes refuse the scope; closing
also expires its private handle. This is preparatory read support, not a public
V3 summary or permission to trust a descriptor's preview text.

Preparatory recipes record both literal SQL and genuine native changeset effects,
including their exact write counts. Before final physical verification, every
retained literal replay statement is compiled again under the installed policy.
The native changeset's recorded authorization sequence receives fresh policy
evaluation before its final execution. If SQLite
expires that bytecode during changeset application, final execution accepts only
the same native statement's complete recorded authorization sequence; it does
not call external policy or business callbacks inside publication. Changed
methods, schemas, observer membership or authorization events refuse replay.
The business callback runs only in preparation, which rolls back; the final
transaction recreates its frozen effects. Disposal releases unused statement
authorization receipts. This does not make arbitrary SQL enrollable. Changeset
authorization observers run during preparation, and changes to their membership
refuse replay; their mutable closure behavior is not freshly reevaluated during
changeset preflight or final replay.

The same private path supports verified plain intake-maintenance publications.
It retains the exact preparatory capability across only its genuine rollback,
then requires a distinct issuer-bound final token, unchanged source bindings and
the frozen write roster. General revision advances while clinical-review
revision stays unchanged. Explicit invalidation, lock and unrelated rollback
still revoke retained preparations. Compact-metadata and legacy representation
bridges retain their specialized paths.

Native ownership commits capture the selected parent originals before prerequisite
snapshot publication. Snapshot checkpoints and final adoption use that same
capability. Each approved child executes its business intent in preparation once;
final publication replays the frozen effects. Private one-use grants bind the
parent, group, operation, reviewed choices and destination. Later children reuse
the destination identity and version returned by the preceding accepted child,
not a newly observed destination version. Fictional checks cover a single unit,
two independent groups with an existing destination, and two groups creating one
new destination. They do not qualify every clinical, name, link or report-selection
combination, nor remove complete physical verification.

Within one ownership preparation, fresh records with no prior issue authority use
the existing inline `[]` representation after complete current policy inspection
and unchanged-policy checks prove their issue set empty. A fresh empty report
union uses the same representation. Original source and logical-envelope guards
remain retained and checked; no empty catalog snapshot or prerequisite publication
is needed. Nonempty sets and prior issue authority, including a prior inline empty
set, retain their authenticated snapshot preparation paths. The accepted receipt
retains the exact empty issue evidence; this avoids unused snapshot writes, not
source evidence verification or final physical checks.

Initial ownership preview construction forwards each host-verified clinical review
context through a private one-use handoff, bound to its original session, database,
profile, method epoch and SQL read interval. It avoids only the immediate duplicate
per-session physical pass. Construction still copies the original artifact identities
and verifies their complete union before the preview escapes. Later snapshot
preparation retains its existing per-session checks and prerequisite-publication
closures; cancellation or changed authority cannot recapture a newer proof.

Ownership name-evidence hashing preserves the complete canonical order and
membership while yielding at bounded piece and byte intervals. Individual hash
updates retain surrogate pairs and consume at most 4,097 UTF-16 units; each digest
interval consumes at most 64 KiB. Original plan and source guards run before and
after each yield, and cancellation disposes the unpublished scratch plan. This
does not remove final physical checks or bound every name-rendering operation.

## Current data and searchable history

SQLite is a disposable, indexed projection containing both current records and retained version history. The current view selects the latest accepted version in committed order. Record history is a normal query, not an offline backup-restoration workflow. Index by profile, entity/record, version/sequence and time, with a field-change index or equivalent for queries such as **When did I change my birthday?**

Association-owner history indexes contain only link or attachment versions, including their removal versions. Unrelated record versions add no entries to these two indexes. Attaching an older cache rebuilds these disposable indexes once without changing accepted objects, projected versions or the profile revision; this upgrade still scans retained versions. Subsequent attachment reuses the matching definitions.

Both changes in A → B → A remain searchable. Returning to an earlier value does not deduplicate away the intervening edit. A network retry of the same operation must not create a second version; a distinct accepted edit is a different operation even if some contents repeat. Changed-field summaries can be derived from adjacent versions but must retain links to their full contents and attribution.

Restoration appends a new version referencing the selected prior version or versions; it does not rewrite the past or remove newer history. The history UI groups editing sessions and previews selected fields and removed associations before restoring them through revision-checked operations.

The working database and its encrypted persistent cache include current data and history indexes. Validate the schema/projection version and last committed sequence on reuse, and catch up subsequent committed versions atomically. Ordinary history lookup must not scan/replay the whole archive. Losing every derived index requires a one-time deterministic rebuild of current and historical projections from the durable versions; no AI is needed. Be explicit that history occupies storage and a complete rebuild costs time.

### Compact history projection

Projection 3 stores each indexed version's complete contents once. Its separate envelope contains attribution and identities without another contents copy. Changed-field rows contain the field name, predecessor version reference and before/after presence flags; they do not retain serialized before/after subtrees. In particular, a nested JSON edit does not copy its complete parent objects into every ancestor field-change row.

An initial, nondeleted `app_meta` version containing exactly string `key` and `value` fields needs no stored field-reference rows: both creation changes are reconstructed from its validated complete version, with absent-before and present-after flags. Selected history still requires its stored reference set to be empty; unexpected references refuse. Updates, tombstones, reinsertion after deletion and other content shapes retain ordinary exact field references. Key/value filtering includes initial metadata versions under the same profile, record and pagination predicates. Full versions, current pointers and accepted journal bytes remain unchanged.

History pagination selects at most the requested page of versions plus one identifier indicating whether another page exists. Only selected versions and their immediate predecessors are loaded to reconstruct envelopes and changed-field values. Field filtering remains indexed. Responses preserve absent versus null, nested `_json` fields, complete array values, object ancestors, deletion/tombstones and the existing dotted-name traversal. Invalid JSON text remains literal for decoding; this does not relax current record validation. Selected-version lookup for restoration uses the same validated envelope reconstruction.

The index is built atomically from committed versions and belongs to the authenticated encrypted cache. Selected history validates metadata against indexed identities, predecessor ownership/order and the exact changed-field reference set. Missing or inconsistent selected references fail explicitly. This is not a detector for arbitrary modifications to an unlocked SQLite file before a filtered query. Unsupported projection schemas, including projection 2, require a fresh cache rebuild; they are not relabeled or migrated in place. Encrypted unlock reconstructs an incompatible cache from authenticated accepted history. Direct contributor attachment refuses the old projection; its explicit staged recovery builds a new target while preserving the source, as described in [contributor authority](contributor-record-authority.md#runtime-writes-and-reconstruction). Immutable accepted-record envelopes and originals are unchanged, and remain the recovery authority.

A fictional regression makes 300 actual source-file edits to a growing structured value. At 100, 200 and 300 edits, indexed contents occupy 566,950, 2,198,800 and 4,900,650 bytes; version metadata occupies 43,308, 86,308 and 129,308 bytes; changed-field reference metadata occupies 51,572, 102,072 and 152,572 bytes. SQLite allocation was 1,601,536, 3,944,448 and 7,417,856 bytes on the measured projection-2 setup; projection 3 leaves the source-file field representation unchanged, but these allocation measurements are not a new-cache measurement. These counts distinguish the remaining complete-version contents from metadata that follows changed paths and edit counts. A seven-entry filtered page selects eight identifiers and reads only its seven versions and seven predecessors, without archive reads. They are scoped fixture measurements, not installation capacity targets.

The remaining contents copy still grows with the size of each retained record version. Production intake uses [selected contribution-backed envelopes](intake-envelope-authority.md) instead of repeatedly versioning its complete source row. [Application mutation qualification](intake-mutation-qualification.md) separates changed writes from retained contents and host work; broader capacity qualification remains open in pending [PR #35](https://github.com/mxbaylee/circus-health/pull/35). The separate [incremental encrypted vault index](../security/vault-index.md) publishes changed bindings and new object metadata rather than whole file/object maps. No historical versions are pruned, and no runtime-capacity increase is part of these changes.

## Durability and encryption

Maintain the single-writer boundary and optimistic revision checks. Stage new versions and referenced objects, verify their bytes, then durably publish an authenticated transaction boundary before acknowledgment. Cross-record changes, evidence relationships and their history must become visible together. Reconcile an interrupted database update from committed durable versions without accepting partial transactions or silently dropping an acknowledged version.

Retries use a stable operation ID. A partial final append or an uncommitted segment cannot become accepted state. Refuse unexplained gaps, invalid version references, wrong profile ownership or unsupported schema rather than substituting another snapshot. Pin and test deterministic record/schema decoding across supported versions. JSONL by itself does not supply transactions, concurrency control or safe multi-machine writes.

JSONL is the logical representation after decryption. Durable storage uses bounded authenticated encrypted segments/objects and commit metadata inside the vault. Segment rotation bounds file size and recovery work; it does not discard old versions or remove them from queries. Keep keys and credential changes outside the medical record history, with the secret-handling constraints in the encryption reference.

### Rebuildable SQLite commit policy

After accepted-record durability has successfully attached and its physical head matches the projection, WAL connections use `synchronous=NORMAL` and a 32,768-page automatic checkpoint threshold. Opening a database, a failed attachment, or a non-WAL connection does not select either policy. Earlier 1,000- and 8,192-page policies caused more repeated checkpoint work during changed-record publication; the larger threshold lets the disposable WAL retain more frames before an automatic PASSIVE checkpoint. Its file can grow beyond 32,768 pages when one transaction crosses the threshold or readers delay a complete checkpoint. This is a runtime disk-headroom and recovery-read tradeoff, not a fixed WAL file-size guarantee. The accepted journal owner still verifies and fsyncs immutable objects and the accepted head before the SQLite commit; encryption, exact operation replay, writer ownership and refusal of divergent authority are unchanged.

SQLite can lose a recent NORMAL-mode WAL tail after an operating-system crash or power loss. That is a cache-loss case, not permission to lose acknowledged records: supported startup catches up or rebuilds the complete projection from the durable accepted history. A cache alone is never a backup. The [SQLite synchronous contract](https://www.sqlite.org/pragma.html#pragma_synchronous) distinguishes WAL consistency from per-commit cache durability. Restart into the reviewed build to use the new connection-local checkpoint threshold; no operator tuning, accepted-record migration or cache schema change is needed. An earlier compatible build retains its own connection policy and reads the same history.

On 2026-10-08, the small fictional 4/8-artifact [diagnostic run](https://github.com/mxbaylee/circus-health/actions/runs/37823841607) on pre-policy revision `8f3ea3c` compared 1,000 and 8,192 pages sequentially on one Linux CI host, with a setup WAL drain and final explicit checkpoint included in whole-probe work. For the eight-artifact case, new-node counts differed by 1.4%, while process-reported write units per new node fell from 126.984 to 99.137; the four-artifact case fell from 116.144 to 87.011. The candidate's sampled WAL reached about 40.9 MB versus 14.4 MB at baseline, and both ended with a zero-length WAL after the final drain. A later [same-host diagnostic](https://github.com/mxbaylee/circus-health/actions/runs/37839356183) on revision `8946a2a` compared 8,192 and 32,768 pages with the same 16/32-artifact fixtures and final drain. Changed-batch counts and commit counts matched exactly; process-reported write units per new node, including the drain, fell from 117.590 to 98.145 at 16 and from 141.613 to 117.852 at 32. Sampled WAL peaks rose from about 48/52 MB to 150/151 MB. These kernel write units are process-wide, not attributable device bytes or a universal product bound. Counted regressions observe fewer actual WAL resets from the documented header salts, then check drained current contents and accepted-history rebuild. The original full retained-history and encrypted recovery gates remain required; the small diagnostics do not replace them.

Record-version duplicate detection keeps its private disk-backed identity index in one explicit transaction for the lifetime of that validation scope. Its existing bounded page cache can spill to disk, and closing always discards the complete scratch index. Neither these scratch bytes nor a scratch commit become recovery evidence. Writer and recovery still inspect every version and reject duplicate identities and invalid predecessor references.

Fictional regressions distinguish unattached and rejected/non-WAL attachment, failure before accepted-head publication, interruption after the durable head but before cache commit, complete replay and exact retry. Controlled interruption is not a physical power-loss test. The complete encrypted acceptance/cache-loss journey remains a separate required oracle.

## Source-text write amplification

Bytes written for one operation must be proportional to what that operation changed (owner decision 2026-09-28; `AGENTS.md` states the same rule for all durable writes). Anything else is incorrect behavior, not a tuning choice.

- **Incorrect:** a write that copies the complete current document, revision, table or corpus into the journal, a transaction result, an operation receipt or a cache entry, so that storage grows with document size times the number of writes.
- **Correct:** store the changed records or blobs plus a small receipt (identifiers, hashes, counts). Readers fetch content by reference. The same rule applies to repeated reads and hashing: work per operation scales with the change, not with the whole original on every call.

Each ordinary edit journals only the changed record and two small profile metadata scalars: global `revision` and `clinical_review_revision`. Source-text-only writes advance the global revision without advancing clinical review authority. Legacy portable personal generations include the current clinical-review scalar in their generation header so rebuilding after later personal edits preserves exact review tokens; a pre-scalar generation rebuild uses its global revision conservatively.

Source text follows the rule for its own records:

- **Transaction result.** A mutation journals a receipt holding the revision id, its parent and the changed page numbers. A replayed operation rebuilds the full response from the stored revision. Results journaled before this change hold the complete response and are replayed as stored. The receipt deliberately omits page hashes: replay rebuilds from the revision, which already records every page's hash, and nothing else reads the receipt's pages.
- **Revision envelope.** Page text lives in content-addressed page blobs. The envelope lists them through fixed chunks of 64 page refs, so a one-page change writes the page blob, one chunk and the envelope. Relations and the issue index are split into content-defined chunks (a boundary wherever the item id's hash falls in the lowest 1/16, at most 64 or 50 items), and the chunk lists are chunked again, so an insertion changes a few chunks rather than every later one. Revisions written in the earlier inline layout remain readable, and later revisions build on them.
- **Source pin.** An intake's source-text pin (current material revision, dependency token, "requires interpretation" flag, and a count of material source revisions) is kept in its own small record, `intake_source_pin:v1:<intake>`, instead of the intake's `source_files.details_json` row. A material revision updates that record for the intake and each ancestor, and leaves the rows, which hold proposals and history, untouched. Readers see the intake with the pin applied. Its public version is the row version plus the revision count, so tabs opened before a source change still conflict. Intakes written earlier keep their pin fields in the row until their next material revision, which continues their dependency chain in the new record.
- **Measured dependencies.** Material revisions update `intake_source_page_hash:v1:<intake>:<page>` for changed pages and related neighbours, and `intake_source_span_hash:v1:<intake>:<span>` only when an affected span's content or structural context changes. Linked amendments propagate across both ends of a relation. A measured proposal stores one small `intake_proposal_dependencies:v1:<proposal>` record with hashes of pages and bounded spans exposed to its model response. Review and acceptance compare those hashes; unknown coverage keeps the broad pin. A source revision never rewrites proposal rows. Issue resolutions store small field and located-page fingerprints with their review draft, so editing one field reopens its own issue; an unmeasured historical answer cannot authorize acceptance. Exact, independently validated report-identity receipts can still authorize their original target. An explicit Unknown or other-person response remains a blocker even when its field fingerprint is stale; it does not authorize an assignment.
- **Original verification.** Retained originals are rehashed only when their device, inode, size, modification time or change time differ from the last successful check in the running process (`verifyIntakeFileHash`). This covers source-text reads and writes, intake original verification, clinical import assets, duplicate review, People proposals and record corrections. The cache is not persisted, so the first check of each file after start still reads the whole file synchronously ([CRS-128](../todo/CRS-128.md)).
- **Historical measurement.** In fictional fixtures that capture one page per write, journal bytes per write were 64.6 KB at 30 pages and 221.9 KB at 120 pages before the change, and 16.5 KB, 19.5 KB and 19.7 KB at 30, 120 and 480 pages after it. With 400 fictional proposals (about 214 KB) on the intake, a capture at 120 pages wrote 264 KB before the pin moved and approximately 19.5 KB after that change. These figures have not been re-measured for consumed-source dependencies; current fictional regressions check counted journal growth instead. Archives written before the change keep their larger history; nothing is compacted (see [History retention](#history-retention)).

Every new durable write path needs a fictional-fixture test asserting that journal growth stays linear in the number of changes, at two document sizes. A test that only checks correctness does not catch this.

### Replay SQL reuse and the short debugging loop

Cold reconstruction retains the original complete-version validation, reference verification, delete-before-insert ordering, historical indexing and final integrity checks. Within each replayed transaction, it prepares each touched table's delete/insert statement at most once per phase and executes that statement for every applicable record. The statement maps are local to that call and bounded by the configured table set; no records, authorization results or prepared statements are reused across replay calls or connections. Durable formats, encryption, accepted publication and cache compatibility are unchanged.

Replay keeps decoded versions privately only after a transaction's complete first
pass, including every segment's hash and length and the final record count. The
retained prefix is bounded by 4,096 versions and 8 MiB of authenticated segment
bytes (`REPLAY_DECODE_REUSE_RECORDS`, `REPLAY_DECODE_REUSE_BYTES`). A transaction
within both budgets reuses its complete decode. A larger transaction still
rereads, authenticates and frames every segment on later passes; only small
records in the retained prefix skip repeated JSON parsing. Giant records in a
partial prefix retain their ordinary spool and decode path. Validation, reference
verification, both application passes and historical indexing still run their
own checks on every version. Reference-verification callbacks receive detached
copies, so they cannot alter cached accepted values used by subsequent passes.
Nothing is reused across transactions, replay calls or connections. The
`decodedVersions` and `replayDecodedVersionReuses` counters distinguish decoding
from reuse; `replayDecodeReuseOverBudget` counts byte-budget crossings while
the prefix is still collecting, not record-budget exhaustion. The focused regression is
`node --test src/server/test/record-replay-decode-reuse.test.ts`. The callback
copy is not a bound on giant-value materialization.

Cold intake schema validation likewise prepares its ten fixed scratch SQL
statements once per traversal. It still executes every property, ancestry,
membership and descriptor check, including fresh source checks across cooperative
yields. The statements belong only to the disposable validation database; normal
completion, refusal and generator cancellation discard that database. Fictional
four- and sixteen-candidate regressions retain 583 and 1,951 scratch executions
while requiring ten compilations each. This reduces SQL compilation work, not
authenticated reads or durable writes, and does not establish an unlock latency.

Publication now also prepares a changed-row SELECT once per touched table within
one collection traversal. Every changed identity still executes that SELECT and
reads its current predecessor; no row, result or authorization is cached. The
statement map is limited to the configured schema and discarded after that
traversal, including early termination.

The derived field-history index groups up to 32 changed-field rows from one
complete validated version in one INSERT statement. It preserves field order,
predecessor references and absent/null distinctions, flushes before the next
version, and retains at most 32 statement shapes for that indexing call. The
bounded parameter list contains references and presence metadata, not copies of
record contents. Every required stored field row still executes; the initial
metadata exception is described in [compact history projection](#compact-history-projection).
The accepted version, segment
and commit bytes, validation/readback order, transaction boundaries and SQLite
projection format are unchanged by batching itself. A failure after a real field batch rolls back
the entire publication before accepted HEAD advances. Replay uses the same
indexer and reconstructs the exact current and historical rows.

The publication regression uses four and 64 changed people plus nested source
fields across inserts, updates and deletion. It checks actual SQL executions,
exact operation replay, empty field deltas, interruption and two fresh rebuilds.
For its 64-person insertion, row-SELECT compilation falls from 64 to one for the
people table, retaining all 64 row reads; 342 field rows use 69 rather than 342
INSERT calls. This trades a bounded set of statement shapes for fewer execution
calls; it does not reduce field rows, authenticated journal reads or durable
bytes, or establish a full import/identity latency improvement.

The fictional replay-only regression rebuilds the same accepted archive into two fresh databases at both four and 64 people, preserving updates, tombstones, predecessor/field history and exact current/history index rows. For the 64-person history, SQL preparation falls from 130 deletes and 129 inserts to four deletes and three inserts, while all 259 corresponding row executions remain. Complete-version validation counts and archive bytes remain unchanged. These are scoped work counts, not an unlock latency or full HTTP acceptance claim.

Ancestry and V2 segment-reference ordering indexes also keep their inserts in one
private transaction per traversal, rather than an implicit pager transaction per
reference. Their existing 2 MiB SQLite page cache and file-backed temporary storage
remain unchanged. The transaction is discarded with the scratch connection on
normal completion, refusal or iterator termination; it is never committed as
recovery evidence. Every selected commit, manifest page and segment is still read
from the original journal and authenticated in the same order. V1 decoding and
accepted-database transaction boundaries are unchanged. The replay regression
observes the actual scratch inserts inside a transaction, reconciles their counts
with the existing replay counters, and verifies that the scratch files and
connections are gone afterward.

Run this checkpoint without repeating the import/review setup:

```sh
node --test src/server/test/record-replay-sql.test.ts
```

Then run the complete record-version and affected recovery tests. The separate `npm run test:acceptance` and `npm run test:continuation` scenarios still establish their end-to-end outcomes; this short regression does not replace either one.

## History retention

There is no history compaction scheduler or historical-version offloading. Authoritative versions and originals remain available; derived SQLite caches can be replaced and rebuilt. History occupies storage, and complete cache loss requires replaying retained versions.

Do not build compaction scheduling, edit-to-content thresholds, historical log offloading or periodic full-archive checkpoints for the initial release (owner decision). Any future lossless compression or repacking must preserve every record version, audit query and source relationship; a checkpoint could speed reconstruction but cannot make old history unavailable in the normal database. Revisit only through a new measured requirement.

## Validation and compatibility

Use fresh fictional profiles for storage experiments. Existing accepted versions and originals remain authoritative during ordinary operation and recovery; a development test reset is not a migration strategy or permission to discard an operator's archive.

Verify with fictional fixtures:

- One person or clinical-record edit appends only the changed record(s) and small transaction metadata, not a full-table/corpus snapshot.
- A birthday change and A → B → A remain queryable with timestamps, previous/new values and known attribution, after cache reuse and after complete SQLite loss.
- Current rows and full history reproduce deterministically; invalid or missing accepted versions fail explicitly.
- Retries do not duplicate versions; stale edits fail; partial writes, crashes and multi-record transactions never expose half an accepted change.
- Removed/re-added links, archival changes and restored values retain their past states. Finished-note and immutable-source restrictions still hold.
- All original artifacts, source occurrences and attribution survive acceptance, backup/restore and reimport. Near-identical medical records are not collapsed by the storage layer.
- Encryption/profile boundaries cover history indexes and model history queries as well as current records. Locked profiles expose no history.
- Fresh encrypted profile creation, in-app provider imports, reviewed corrections, personal edits and container/cache loss exercise the complete supported workflow.

## Diagnostic chunk storage boundary

`Vault.diagnosticChunks()` exposes a separate, lazy, single-writer encrypted store under `diagnostics/events/`. The opt-in detailed recorder attaches after profile unlock and the authorized download reads retained metadata across lock/restart and SQLite/cache loss. It is not clinical evidence, a medical-record journal, or recovery authority. Full-size retention and complaint reconstruction remain unqualified; see the [download contract](../import/import-performance.md#retained-event-archive).

Each append carries a positive safe-integer sequence and at most 64 KiB of bytes. Authenticated encryption binds the profile and exact sequence; filenames are fixed 16-digit sequences. A still-retained identical retry returns replayed without rewriting ciphertext, a conflicting retry fails, and an evicted sequence cannot be re-appended. A new append writes only the new chunk, without changing the medical manifest, record head or earlier chunk payloads. The writer inventories filenames once and retains only bounded index metadata. It never rereads prior payloads during ordinary append; an explicit replay reads only its retained chunk to verify equality.

Retention limits are 256 chunks and 16 MiB of ciphertext. Oldest chunks are removed after atomic publication. Recovery permits one extra published chunk and one recognized interrupted temporary file, then applies retention and removes that temporary file before new appends. A cleanup failure blocks further growth. Files outside this fixed recovery allowance, malformed identities, non-files and oversized ciphertext fail explicitly. Each decrypted read is also capped at 64 KiB; authentication, missing-file and truncation failures propagate to the caller. Callers must validate the recovered metadata schema before exposing it. The vault guards every operation after lock/close.

Inventory reports retained encrypted bytes, internal sequence gaps and an unknown earlier-omission count (`null`), with completeness always `not_established`. It cannot distinguish removed early history from a newly created store, or prove a complete run. Backups may preserve older ciphertext. The primitive's work counters count index scans, chunk payload reads/writes, plaintext bytes written and evictions within that writer lifetime; they are not provider/model performance measurements. Tests compare append work at two corpus sizes and verify unchanged medical authority, profile/sequence authentication, replay, corruption and retention recovery using fictional metadata.

The recorder's `circus-import-events-v3` envelope includes a fixed cumulative observed/persisted/dropped/oversized/write-failure checkpoint and immutable attachment origin per archive window in each new chunk. The origin is included in the bounded envelope prefix; a 512-byte reserve keeps checkpoint metadata within the existing plaintext limit. Enabled attachment attempts one bounded zero-event origin/checkpoint write; disabled attachment writes nothing. Complete bytes freeze before the first publication attempt; subsequent failures cannot change retry bytes. Changed loss accounting is coalesced into a checkpoint-only append after recovery or when no events can be retained. Unchanged flush/export/close writes nothing. Only new bounded chunks are written; earlier payloads are not copied or rewritten. Export validates exact keys, consistent origins and conservative safe-integer accounting, returns retained readable origins and the latest retained checkpoint per window, and reserves their metadata within its output budget. Unsupported envelopes are rejected explicitly, without a legacy decoder or reset. Known retained losses and origins survive reopen, but failed final publication and entirely evicted windows remain unknown. See [retained window checkpoints](../import/import-performance.md#retained-window-checkpoints) and [encrypted collection origins](../import/import-performance.md#encrypted-collection-origins) for export and failure semantics.

## Condition storage schema boundary

Schema 7 adds the condition-occurrence table. Current-schema occurrences use the existing changed-record journal and preserve earlier versions, original evidence and attribution on replay. The journal still requires an exact schema match; this change does not decode older journal schemas. No legacy journal, encrypted-cache or portable snapshot compatibility is provided for this addition (owner scope decision, 2026-10-01, before production use). Unsupported archives fail explicitly; the app does not discard or silently reset them. Current-schema encrypted restart/cache-loss and portable recovery are covered by fictional fixtures.

## Personal packet choices

Packet withholding and manually applied record tags are personal metadata in `app_meta`, under `packet_preference:v1:`. The payload records the selected person, stable record reference, withholding flag, bounded tags, version and profile-user timestamp. They do not alter clinical rows, accepted clinical versions or original files. The [packet procedure](../features/selective-packets.md) explains the sharing boundary and its limits.

Ordinary accepted-journal mutations append only changed preference records plus the existing revision scalars. An unchanged save opens no transaction. Optimistic versions prevent stale edits, and an operation ID cannot be reused with different choices. Clinical reclassification resolves the original stable identity; accepted ownership redirects retain the restrictive choice rather than silently making the record shareable. Joined preferences combine withholding conservatively. An explicit save reconciles the affected preference rows while accepted history retains their earlier values; former-owner tags are not disclosed to the newly selected person.

Whole-profile export and recovery retain these preferences. Explicit portable personal generations carry a separate `packetPreferences` field so a later personal choice can supersede an older curation snapshot; a generation lacking the field retains the earlier curation values. This is separate from the normal changed-record journal. Earlier application builds do not enforce packet preferences even if their archive reader retains the metadata.

## Conversation writes

Conversation recovery uses its own [linked changed-content journal](conversation-journal.md). Each save adds changed values and small generation metadata, including incremental array items and text splices. It preserves history without copying the growing chat, operations or request-attempt arrays into every event. The encrypted wrapper retains this journal; originals and accepted-record authority remain separate. Older conversation snapshot envelopes are explicitly unsupported.

## Incremental intake state primitive

The [incremental intake state owner](intake-state-storage.md) stores operational evidence in immutable source-scoped `app_meta` contributions through the existing accepted-record transaction and compact history projection. Production intake uses its selected envelope authority. Retained V3 envelopes use changed-content frames; V4 envelopes use authenticated maps, sequences and chunked values with separate logical, receipt, history and incomplete-build roots. Selected V4 envelopes refuse whole-workflow hydration: consumers use explicit summaries, selected records, pages and fragments. The supported V3 bridge preserves exact retained evidence and public identities; it is counted cold compatibility work, not a constant-cost mutation. See the [bounded views contract](intake-bounded-views.md) for consumer and qualification boundaries.
