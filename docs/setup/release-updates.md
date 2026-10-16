# Update an installation and recover from a failed candidate

Restart into the reviewed build before adding files while an encrypted profile's
earlier reading batch is running. Batch and conversation journal continuations,
including public batch and chat controls, now publish through the profile's
host-operation queue, preserving the
upload's original bridge proof while model and extraction waits remain outside
the queue. Prior builds can spuriously return an internal upload error when one
of those publications overlaps proof preparation. Genuine authority changes
still refuse; retain originals and accepted history for recovery. This changes
no encrypted archive, cache format, provider setting or operator configuration
and requires no migration. See the
[encrypted upload coordination contract](../data/intake-state-storage.md#v3-bridge-and-schema-directed-envelopes).

Restart into the reviewed build before correcting the person on accepted native
report records. This build reads their retained member snapshot references and
supports checked previews with the returned record versions. Prior builds can
return an internal error for a valid first preview or reject versioned selections.
Pre-save checks of changed scope or destination evidence now return a
review-required conflict before the atomic group publishes. No archive format,
cache migration or operator setting changes; originals and accepted history
remain authoritative. See
[accepted person corrections](../import/identity-review.md#correcting-accepted-person-assignments).

Restart into the reviewed build to apply the internal intake-reader freshness
checks. A retained V4 byte capability or started native field/record text stream now refuses
after its logical generation changes, cache disposal or profile closure, including
when the next fragment was already buffered. Reload/reopen the detail rather than
resuming that iterator. Auxiliary-only checkpoints preserve unchanged logical
bindings, and a reusable reader may start a fresh traversal after cache disposal.
Prior builds could consume an old registered byte value even when its descriptor
binding refused it. This changes no authority format, originals, accepted history
or provider settings and needs no migration. See the
[reader consumption contract](../data/intake-state-storage.md#v4-collections-and-selected-publication).

The optional [fictional deployment qualification](docker-runtime.md#fictional-deployment-qualification)
now joins the existing provider oracle with the drive probe, fresh-container
authentication and accepted-record/cache-loss reconstruction checks. Set
`CRS_DEPLOYMENT_QUALIFICATION=1` and choose an external output directory on the
intended installation drive before running `npm run qualify:deployment` with the
adopted proxy configuration/state. The drive driver also accepts Linux with a
nonce-proven UID 1000 scratch subtree and scoped cleanup. These tools add no
archive format, migration or provider-setting change; each installation still
needs its own actual receipt. They do not qualify an unavailable host or physical
power loss, and do not replace the checked backup/update drill below.

On 2026-10-16 the clean `b1ec6dada33b0879b87dd749ceda1db963dafd5c` build passed the complete fictional deployment procedure on one local macOS Docker Desktop filesystem using the supported npm → Compose → LiteLLM route with ChatGPT OAuth and alias `health-primary` configured as `chatgpt/gpt-6-astra`. Four exact observations were reviewed and explicitly accepted, with receipt replay. Both fresh-container stages retained the original bytes, exact accepted values and nonempty histories, including after disposable-cache deletion and reconstruction. Image/build, master-key bytes, provider configuration and observed model/backend matched; real authenticated tool challenges passed, and all 825 accepted-vault files remained unchanged. The protected receipt qualifies that build and small fixture, not every installation or later release. Repeat the procedure for the candidate and intended drive; [CRS-271](../todo/CRS-271.md) retains actual native Linux host qualification. Physical power loss, removable/network drives and natural OAuth refresh are outside this receipt. See the [observed deployment evidence and retained failure limits](docker-runtime.md#fictional-deployment-qualification).

Restart into the reviewed build before creating or resuming an encrypted setup.
Setup now reuses checked chunked file copying and retains its prepared manifest
handle across worker handoff, publication and activation. This addresses observed
copy and released-inode behavior on one UID-mapped Docker Desktop mount while
retaining exact physical identity, digest and replacement-refusal checks. It adds
no archive format, recovery or configuration migration. Prior builds retain the
earlier setup copy/handoff behavior; do not treat a drive-probe receipt alone as
proof of successful setup or provider import. See the
[setup resource contract](../security/profile-encryption.md#encrypted-private-copy-setup).

New model proposals now explicitly separate grounded identity questions from independent clinical uncertainties. Restart into the reviewed build to use that instruction; existing proposals are preserved. The qualification fixture uses separate unpunctuated patient and DOB labels. Its reading gate inspects all version/source-pinned reader exception pages and the exact active plan, while preserving the native feed’s unknown extraction status and referenced accounting. This bounded known-answer fixture proof does not implement a general clinical-completeness aggregate.

Restart into the reviewed build to recheck report identity quotes that differ only in horizontal whitespace introduced by PDF text extraction. Grounding now uses whitespace-equivalent matches with original text positions, preserving line, role, report/member/page, name, punctuation and DOB conflict checks. Retained proposals, original bytes, source/identity keys and accepted history are unchanged; there is no migration. Prior builds can still refuse these otherwise literal quotes. See [original identity grounding](../import/identity-review.md).

## Updating from `main` to this candidate

Restart into the reviewed build before beginning a passkey unlock or setup.
Authentication and setup now claim a valid request before the activation queue;
their original expiry does not interrupt admitted work. Expired requests still
refuse entry, and cancellation, disconnect, lock, credential/keyring changes and
other authority changes still stop queued or active work. Enrollment expiry is
unchanged. This changes only in-memory admission ownership: no archive, keyring,
recovery-file or provider configuration migration is needed. A restart needs a
new challenge or recovered setup session. Recovery inspection alone does not
replace another setup: replacement occurs at session- and source-authorized
admission, so a target-kit holder without source access cannot cancel an
authorized copy. Existing committed-head setup recovery
is preserved; this update adds neither verified unpublished-stage continuation
nor crash-leftover cleanup. See
[unlock and setup admission](../security/profile-encryption.md#unlock-and-setup-admission).

Acceptance receipt checking now certifies native absence in mixed legacy/native
profiles and unprepared compatibility reads. Restart into the reviewed build;
accepted receipts, operation IDs and archive formats need no migration. A damaged
derived operation key refuses checking or exact replay rather than reporting a
completed save absent. This adds no automatic repair for corrupt native builds
that still claim completeness: restart or lookup-cache clearing may still refuse
them. Retain the exact original request, operation ID and accepted authority for
diagnosis or recovery. Unprepared compatibility reads scan native acceptance
headers; prepared native and mixed reads reuse their complete certificate. Prior
builds can report an accepted operation absent when a native working key is
missing on mixed or unprepared reads. See the current
[checked lookup contract](../data/intake-lookup-projection.md).

The owner accepted the existing passkey compatibility baseline on 2026-10-15
after reporting completed testing. The hosted checker and its GitHub Pages
publication remain available for future tests. See the
[acceptance boundary](../security/profile-encryption.md#owner-accepted-passkey-baseline)
for the scope of that owner statement; the separate username-less sign-in feature
remains open. Unlock and setup now use the separate
[admission contract](../security/profile-encryption.md#unlock-and-setup-admission).

New passkey enrollment now enables PRF at creation (`prf: {}`) and evaluates its
per-credential salt only in the separate exact-credential confirmation. This ports
the owner's successful Proton Pass checker mode. Restart into the reviewed build
and reload the browser before enrolling another passkey. Existing passkeys,
salts and wrapped keys need no migration or re-enrollment; ordinary unlock still
uses `evalByCredential`. Prior builds retain their creation-time evaluation
request, so the new enrollment compatibility does not apply to them. No archive
format or operator setting changes. See the
[enrollment contract](../security/profile-encryption.md#keys-and-passkeys).

This candidate changes durable authority, so it is not a restart-only update.
The paragraphs below describe individual changes; read this summary first.

- **One-way intake upgrade.** Retained V3 intake envelopes are bridged to
  [V4 collections](../data/intake-state-storage.md#v4-collections-and-selected-publication)
  on first use, including ordinary reads such as opening a package inventory.
  Builds that understand only V3 cannot open an upgraded intake, and deleting
  the disposable cache does not undo the upgrade. The same preparation indexes
  an intake's retained report-source confirmations once, at its unchanged public
  version. Failed index publication leaves those confirmations pending and is
  retried by the next preparation; no intake edit or database restart is needed.
- **Newer journal and queue formats.** Accepted commits use v2 segment manifests
  and processing queues use v3 events; older builds refuse both (see
  [format notes](#release-configuration-and-format-notes)).
- **Back up before the first start.** Take and check the
  [pre-update backup](#prepare-the-checked-way-back) before starting the
  candidate. There is no downgrade path: returning to the prior build means
  restoring that untouched backup, and writes made after it are not recovered.
- **Known limitations.** Exact source search has no aggregate work limit and can
  stall other requests on very large
  profiles ([CRS-247](../todo/CRS-247.md)). Disposable scratch databases use the
  128 MiB `/tmp` tmpfs in Compose, so very large profiles can exhaust it during
  copy, compaction or replay ([CRS-246](../todo/CRS-246.md)).

Collection approval now binds to the values actually displayed by its editor;
background refresh cannot silently replace them, and native ownership split
acknowledgements preserve reviewed edits. Restart into the reviewed build and
reload open review pages before approving records. Portable staging also preserves
nonzero row ordinals across empty personal tables. This change adds no operator
configuration; the authority upgrade and backup requirement above still apply. See [review reliability](../import/review-reliability.md) and the
[portable contract](../../src/server/PORTABLE.md). Open internal-integrity and
cleanup limitations remain explicit in [the backlog](../todo/readme.md).

Fresh one-entry proposal indexes now combine map construction and immutable
catalog attachment in one verified publication. Callback-driven callers retain
their eager checkpoints. Native assistant pre-tool no-progress counters also
share one synchronous, call-local reading projection; later calls still read
fresh evidence. Restart into the reviewed build; retained formats, accepted
authority, recovery compatibility and operator configuration are unchanged.
No migration or reset is required. See the [bounded intake contract](../data/intake-bounded-views.md).

Ordinary native reading updates now combine the initial temporary ledger fork
with an existing bounded publication where it fits, including native ledgers
within imported sessions and the native caller's explicitly opted-in imported
writer. Imported PDF next-page lookup also avoids publishing unrelated native
ledger changes solely to read page rank. The explicitly opted-in imported writer
also overlays its bounded pending page flags on fresh persisted membership,
retaining both cooperative yield boundaries and rejecting a changed window.
Default imported-helper callers, callback barriers and
overflow flushes are unchanged. Restart into the reviewed build;
there is no ledger-format or recovery migration. See the [bounded intake contract](../data/intake-bounded-views.md).

Assistant read acknowledgments now skip intake authority reads when none of the
event's call IDs has a pending receipt. Matching receipts retain their existing
validation and publication checks. Restart into the reviewed build; no checkpoint,
ledger or recovery migration is required. See the [bounded intake contract](../data/intake-bounded-views.md).

Processing queue journals now use native path resolution when it returns the
exact requested path, retaining the existing resolver for aliases, filename-case
differences and native errors. Restart into the reviewed build; no queue-format,
recovery, configuration or data migration is required. All authority and
durability checks remain. See the [queue journal contract](../data/intake-batch-journal.md).

Contributor physical-proof jobs and private envelope candidates now reuse their
own native signing-key representation while computing every existing HMAC and
retaining all source, scratch and physical checks. Restart into the reviewed
build; accepted formats, scratch signature bytes, recovery compatibility and
operator settings are unchanged. No migration or data reset is needed. See the
[record storage](../data/record-version-storage.md) and
[intake state](../data/intake-state-storage.md) contracts for key-lifetime limits.

Portable backup digests now use one fresh source check at each resumed read,
removing an adjacent duplicate check without retaining authority across yields.
The 64 KiB read windows, complete hashing and final file identity checks are
unchanged. Restart into the reviewed build; accepted and backup formats,
recovery compatibility and operator settings are unchanged. See the
[portable recovery contract](../../src/server/PORTABLE.md).

Native child lookup now combines the selected field and complete child-header
authentication under one synchronous closing proof. Restart into the reviewed
build to use it; accepted formats, recovery compatibility and operator settings
are unchanged. Custom-reader and transaction fallbacks remain supported. See the
[collection read contract](../data/intake-state-storage.md).

Selected continuation and assistant-header reads now decode bounded field groups
under one synchronous native proof, retaining fresh opening/closing authority
checks. Custom readers and transaction reads keep their point-read behavior.
Restart into the reviewed build to use this read optimization; accepted formats,
public responses, recovery compatibility and operator settings are unchanged.
See the [collection read contract](../data/intake-state-storage.md).

Encrypted setup's finish worker now loads only its physical-witness and
publication helpers. Inspection and preparation retain their existing vault and
profile checks. Restart into the reviewed build to use this startup optimization;
there is no accepted-format, recovery, cryptography or configuration change. See
the [encrypted-profile contract](../security/profile-encryption.md).

Contributor retained staging now reuses one verification worker across serialized
jobs, while each job reopens its required handles and performs fresh original
physical checks. Restart into the reviewed build to use this disposable-runtime change;
accepted formats, recovery compatibility and operator settings are unchanged.
Each job preserves its own operation context through verification and final
publication callbacks, including jobs dispatched after the worker's first use.
Revocation is immediate, but private scratch cleanup waits for worker exit.
Cleanup failures produce the sanitized `CONTRIBUTOR_BACKING_CLEANUP` warning;
they do not restore a revoked proof. See the [record storage contract](../data/record-version-storage.md).

Legacy-history replay can project one exact, shape-bounded delta of at most
128 KiB in memory, avoiding disposable parser scratch for that delta. Larger
or non-round-tripping payloads keep the streaming path; full history and result
fingerprints remain required. Restart into the reviewed build to use the
optimization. No accepted format, migration, input limit or operator setting
changes; see [intake state storage](../data/intake-state-storage.md).

Legacy disk replay now indexes object traversal order and preserves existing
array entries on pure appends. Restart into the reviewed build to use these
scratch-only optimizations; no migration or operator setting changes. The index
uses additional disposable disk space, and every historical fingerprint remains
required. These changes alone do not qualify complete copy latency; see the
[private-copy contract](../data/intake-state-storage.md#contributor-private-copy-publication-and-retry).

Cold report and People queue initialization now waits for an independent
accepted-source proof on the same connection, as Import-feed initialization
already does. Shared fragment, coverage and record queue preparation follows
the same clinical-then-accepted order. Restart into the reviewed build; this is
a disposable-cache coordination repair, with no authority-format migration,
public API or operator setting change. Broader vault accepted-source routing
remains a separate limitation in the [bounded views contract](../data/intake-bounded-views.md).

Contributor retained proofs now coalesce namespace reconciliation across a
bounded sequence of their own ordinary publications. Genuine factory receipts
retain each new object's original physical identity; queued receipts cannot
authorize a read until the full namespace and accepted-chain checks finish.
Transient orphan files removed before that check are not an event-history
guarantee. Restart into the reviewed build to use this disposable-cache change;
no accepted-format migration, public API or operator setting changes. Retain
the checked pre-update backup as usual. See the [record storage contract](../data/record-version-storage.md).

Bounded assistant attribution updates now publish their existing addressed
counters once instead of staging and adopting a separate scratch collection.
Wider updates retain the previous writer path and its value limits. Restart
into the reviewed build; no accepted-format migration, operator setting or
client change is required. This reduces measured publication work but does not
by itself qualify complete import throughput.

Referenced V3 intake summaries now read their synchronous structural fields
under one opening and closing accepted-current selection. Individual collection
cells retain their existing page and SQL checks; asynchronous source, metadata,
acquisition and filename reads keep separate proofs. Restart into the reviewed
build to use this private read optimization. It changes no public response,
accepted format, cache schema or operator setting, and does not by itself
qualify the remaining integrated throughput checks.

Evidence decoding and private historical-graph validation now avoid redundant UTF-8 buffer copies, schema-key sorting and repeated scratch-query compilation. Supported evidence versions, encoded-byte limits, original JSON parsing and accepted-head checks are unchanged; no data migration or configuration change is required. Updating to a reviewed build also tightens exact metadata-schema validation: delimiter-containing keys can no longer impersonate multiple required names. Malformed metadata is refused rather than repaired or reset. This does not change ordinary user-text handling or claim that a prior build's successful read qualified malformed evidence.

This procedure serves the Operator's [operate and recover](../design/personas.md#operate-and-recover) job on the supported localhost npm → Docker Compose → LiteLLM installation. It covers a checked update from supported authority and recovery from a failed candidate using a separately retained backup. Review the limits before updating: recovery returns the backup's state, so writes made after that backup are not recovered by this procedure. General downgrade compatibility and rollback prevention are not provided.

Cold schema-envelope builds now stage their changes in private scratch and
publish them in sorted key order, writing about a third of the earlier
authenticated nodes and journal bytes. The selected envelope format, keys,
readers and recovery are unchanged, so a prior checkout reads envelopes built by
this one. Build progress is recorded as `health-intake-envelope-build-resume-v2`;
an interrupted build without that progress record is rebuilt from the beginning,
leaving the partial build unselected. No operator
action or configuration is required.

Package inventory HTTP reads, direct member reads and generic assistant package
tools now prepare retained legacy ZIP sources for the same version 2 paged
responses used by new uploads. Existing selected plan IDs, roles and public
versions survive compatibility preparation; opening the inventory first is not
required. Invalid member arguments are refused before preparation. Reload open Import views after
updating; external clients must follow `nextOffset` and support bounded member
metadata references instead of expecting a complete legacy inventory response.
The upgrade preserves original evidence and occurrence identities. No operator
configuration is required; use the checked pre-update backup for prior-build
recovery rather than assuming the upgraded runtime is downgrade compatible.

Large native filenames now have checked, versioned derivative facts and pinned
exact-fragment reads. Restart into the reviewed build and reload open Import
views so shortened names use the current references. Complete older native
envelopes prepare missing facts cooperatively before HTTP or assistant
presentation; original bytes, selected envelope syntax and public/domain version
remain unchanged. Interrupted builder transcripts use a new recipe discriminator
and do not reuse an older partial transcript as a matching prefix. Keep the
checked pre-update backup for prior-build recovery; this is not a general
downgrade qualification. Large native original names and child locators now
prepare an explicit v2 compact metadata projection before presentation. Reload
open views to obtain current pinned `metadata-fragment` references; exact source
syntax remains in the selected envelope, not its shortened labels. Complete
older native envelopes upgrade cooperatively without changing public/domain
versions or requiring operator configuration. A prior checkout that supports
only v1 projections can refuse the updated runtime state: use the separate
checked pre-update backup for prior-build recovery, not the candidate's working
runtime. Arbitrary older acquisition and other metadata remain outside this
two-field contraction; broader referenced presentation remains open in
[CRS-238](../todo/CRS-238.md).
The existing filename-fragment POST also accepts an internally issued V3
reference and returns at most 16 KiB of authenticated UTF-8 text per page.
Public summaries still emit only the existing v1 reference, so current clients
need no change. No V3 producer, accepted-format migration or operator setting is
enabled by this read branch; reload open Import views after updating and retain
the checked pre-update backup for prior-build recovery.
The candidate's encrypted compatibility publication also verifies the actual
accepted backing and stages only changed immutable objects before its fixed
transaction. Its private retained certificate frontier advances only through
exact owned source publications; an unknown mutation or changed owner discards
it and requires a new authenticated cold proof. The frontier is disposable and
does not change accepted formats or require an operator setting. Complete
physical namespace sweeps, metadata-only integration and repeated-source release
qualification remain gates, not a permitted authority downgrade.
Its final compact publication now uses a private finite statement inventory
authorized by the installed prepare-time policy before original physical
verification. Unknown callback-only owner conditions, SQL, method replacement
or reprepare refuse rather than bypass that policy. Package-source leases also
retain their original FD/path and structural parent identity in that worker,
including the no-workspace adapter path. Existing in-root aliases must remain
the same original alias; cold vault and full-workspace symlink rules are unchanged.
These checks need no operator setting or accepted-format
migration; integrated compatibility and release validation remain open.
Contributor and portable compatibility writes also check their source preimage
against immutable accepted history, not mutually matching cache rows. A refused
altered cache must be reconstructed from its unchanged accepted record storage;
do not modify that storage to make a cache agree. This adds no record limit or
configuration setting and does not qualify warm ancestry-proof reuse.
Contributor private-copy certification now keeps one worker per attempt while
performing fresh complete physical scans at each existing callback boundary.
Restart into the reviewed build; there is no archive, accepted-format, cache or
operator-setting migration. A refused unpublished copy still needs a new coherent
source proof on retry, and published-target retry rules are unchanged.
The isolated contributor backup helper now shares its verified backup-row
comparison stream with portable JSON output for canonical private snapshots.
It retains exact row multiplicity, bookkeeping output, independent selected
reconstruction and source/snapshot proofs. Final output uses no-clobber
installation and verified retained ownership; conflicting output names refuse.
Restart into the reviewed build; archive and accepted formats, prior-build
readability and operator settings are unchanged. This is not a new supported
operator backup command or a general copy/recovery performance qualification.
See [contributor copy and retry](../data/contributor-record-authority.md#copy-and-retry).
Contributor selected-table equality, asynchronous copy source capture and
worker source-text validation use private, pinned SQLite backups and
incremental native TEXT/BLOB reads. Plain-copy source-text validation runs in a
dedicated worker against its completed backup; an empty revision inventory skips
that worker. Source-text rebind and intake-state target staging now use one
private 16 KiB-piece transfer with exact preimage/inventory checks in the
unpublished transaction. Source and attachment tree copy and flush use bounded
file chunks with source and private-stage file/directory identity checks.
Private equality and portable-export row reads also retrieve eligible small
TEXT/BLOB cells as raw bytes, capped at 16 KiB total per row. Large cells and
columns with declared defaults keep the existing native streaming path;
encoding, virtual-default refusal and early-close identity checks remain.
Restart into the reviewed build; this changes no accepted or portable format,
operator setting or native-library requirement. Prior-build readability is
unchanged. See [contributor copy](../data/contributor-record-authority.md#copy-and-retry).
The supported Compose image installs `libsqlite3-0`; direct Linux runtimes must
provide `libsqlite3.so.0`, and macOS runtimes need `libsqlite3.dylib`. Missing
libraries and unsupported tables or malformed native text refuse preparation
before publication. The copy and portable export transports now use pinned
N-API FFI packages; rebuild the application image rather than retaining an older
`node_modules` directory. The dependency stage supplies native build tools, while
direct contributors need the [documented toolchain](../../CONTRIBUTING.md#before-you-start)
for `npm ci`. This replaces only those transport bindings, not every native
facility. Restart into the reviewed build; no accepted-format or
operator-setting migration is required. The isolated plaintext backup helper now streams its existing portable table JSON from the completed private SQLite backup, with unchanged manifest/restore formats. It explicitly refuses nonordinary main-table shapes such as `WITHOUT ROWID` or hidden columns; supported application tables are unchanged. Native SQLite target statements can
still materialize whole values; target durability attachment and rebuild retain whole-value or synchronous phases, and portable restore is still a whole-value parser. This does not qualify a
general downgrade path, installation capacity or arbitrary same-user pathname
swaps during copy.
The contributor startup worker's portable-format projection now stages rows and
original inventories with bounded transfers and checks an independent reference
projection before activation. It retains complete original verification and a
final physical check after activation progress callbacks. Restart into the new
build; no archive-format migration or operator setting is required. The prior
build can still read the unchanged portable format, but this is not downgrade
qualification. Synchronous rebuild and recovery helpers retain their separate
whole-value or synchronous phases. This contributor-internal path neither enables
normal mutation of journal-less archives nor changes encrypted Compose recovery.
Special `updatedAt` conversion still materializes a scalar for `Date.parse`;
bounded transport is not an all-field or all-native-operation memory guarantee.
See the [portable rebuild contract](../../src/server/PORTABLE.md#staged-rebuild-and-recovery-commands).
Encrypted and contributor-backed compact-metadata upgrades read committed
predecessors through a second read-only `node:sqlite` connection and deliver
them to the host in 16 KiB pieces. SQLite still materializes each value whole
internally; this is not a giant-value native-memory bound. The system SQLite
binding used here remains limited to private copy and portable-export
transports, and must not open a live profile database or its WAL. Restart into
the updated build; there is no accepted-format migration or new operator setting.
Contributor upgrades require their complete accepted-original worker
proof and use a raw-document predecessor digest, distinct from the encrypted
vault's quoted-string certificate. A clean, idle contributor backing derivative
advances across exact own publications and rebuilds after unexplained or foreign
HEAD changes; a poisoned or active one is not adopted. Original accepted backing
and final physical checks still authorize
publication. Giant new target values, other whole-column paths and final SQL
bindings retain separate whole-value limits.
Contributor incremental certificate updates now check complete owner and physical
continuity around each synchronous lookup or batch of at most 64 certificates,
while retaining scratch and writer checks inside those operations. Results are
not adopted until the closing check succeeds; final publication proofs are
unchanged. Restart into the updated build to use this disposable-cache change;
there is no accepted-format migration or new operator setting.
Optional contributor source-pair selections now retain a signed exact-selection
receipt, including proven absence, while preserving fresh complete physical
verification. Before consumer entry only, shared-memory timestamp drift can
discard a refused accepted-source scope and obtain a fresh complete proof within
the existing retry budget. If the immutable-record backend already completed,
cleanup may retain that independently checked derivative, but never the rejected
source preimage or format. Closing owner, source, SQL, method, TEMP and physical
checks still apply; the next attempt proves the source anew. Incomplete backend
preparation and failed terminal verification do not use this retention path.
Database/WAL changes, structural drift and
post-consumer refusals are not relaxed. Restart into the reviewed build; these
disposable proof changes need no accepted-format migration or operator setting.
Contributor backing advances also send authenticated, acknowledged certificate
chunks (at most 64 certificates and 256 KiB each) through a private disposable
spool. Advances above 4,096 changed records no longer require cold replay solely
because of that aggregate count. Complete physical verification, predecessor
checks and transactional application remain required; an oversized individual
certificate still falls back to cold replay. Host certificate consumption yields
between bounded chunks and rechecks the caller and retained proof; interruption
rolls back tentative private certificate writes before any root is adopted.
Restart into the candidate build;
this worker protocol change has no accepted-format migration or operator setting.
Vault positive source-pair selections can also reuse an exact unchanged
request, HEAD and binding kind, retaining the original replay seal and fresh
physical checks. Absence and changed selections still require preparation.
Restart into the reviewed build; no accepted-format migration or setting changes.
Private main-thread certificate reads also share one opening/closing owner proof
across native readonly page traversal; every page and payload remains
authenticated. Generic readers and worker checkpoints keep per-page checks.
Restart into the reviewed build; no authority-format migration or new setting
is required.
Retained contributor predecessor reads now share authenticated tree pages within
one synchronous native batch of at most 64 detached keys, capped at 128 cached
pages. Closing scratch and complete owner checks still precede result use;
custom statement preparation retains per-record proofs. The cache expires after
each invocation and never spans writes or yields. Restart into the reviewed
build; this disposable optimization changes no accepted format or setting and
does not alter prior-build readability.
Incremental contributor certificate chunks now follow one disk-backed
membership-key order after replay, preserving each changed record's first
predecessor and final version. Only fixed-size keys, row pointers, sequences and
digests enter the ordering roster; complete record contents do not. The existing
signed chunk limits and closing authority checks remain required. This reduces
tree-page write duplication, not historical-query or full-replay scope. Restart
into the reviewed build; the roster is disposable, with no accepted-format
migration, new setting or change to prior-build readability. See the
[storage contract](../data/record-version-storage.md).
Fixed-path HEAD proofs now pin all canonical ancestors and check shared ancestors
twice around file-descriptor and endpoint checks. Ancestor replacement or mode
changes invalidate the proof even above the explicit storage parents; unrelated
sibling writes remain supported. Restart into the reviewed build to obtain the
new witnesses. There is no accepted-format migration or new filesystem support.
The cold journal codec now spools oversized records rather than decoding a
complete giant version string, preserving the existing accepted formats and
exact field-history semantics. Its windows do not cap old records, and required
final SQLite values remain materialized. No operator migration or setting is
needed; current old-profile recovery and integration qualification remain open.
See the [bounded-view contract](../data/intake-bounded-views.md).
Private prepared record rows and typed argument scratch now use signed,
ordered BLOB pieces with bounded native reads instead of whole scratch TEXT
or argument values. Restart into the reviewed build; this disposable scratch
is rebuilt during preparation, with no accepted-format, cache-schema or
operator-setting migration. A prior build retains its own preparation path.
Tentative capture and mutable BLOB snapshots can still be synchronous, while
some source reads and final SQLite bindings still materialize complete values;
this is not a giant-record native-memory qualification. See the [record storage
contract](../data/record-version-storage.md#prepared-publication-backing).

Encrypted unlock admission now retains genuine session or passkey ownership
through its final physical checks and refuses database callback re-entry during
the closing seal. Restart into the reviewed build and retry a refused unlock;
there is no accepted-format migration or new operator setting. Contributor
authorization callbacks still run during preparation, before final physical
verification, rather than after it. A callback that changes original ciphertext
refuses activation even when the bytes and manifest are unchanged. This unlock
boundary does not qualify the separate compact-publication callback repair or
the remaining [acceptance-publication work](../todo/CRS-237.md). See the
[profile encryption contract](../security/profile-encryption.md).

Native Import report-group pages now use a disposable indexed group order and retained page totals. After updating, reload an open Import queue if its older group cursor is refused; its cursor is navigation state and is not portable across this change. No original, accepted-record or operator-configuration migration is required. The prior build continues to use its own queue ordering and cache behavior. See the [report review queue contract](../../src/server/INTAKE.md#report-review-queue).

Native identity reviews add an optional complete evidence commitment for one
retry after unrelated intake-version progress. Restart into the reviewed build
and reload open Import reviews so the browser uses current warning selectors and
freshness checks. Missing or unsupported proofs require review after a conflict;
uncertain writes retain exact-request recovery. Overflow advisory warnings use
content-bound v2 references and warning-only page/fragment selectors, preserving
earlier immutable scope evidence while showing warnings changed by a saved Person
edit. Earlier clients can read legacy scope warning rows but cannot select these
new current-warning references; use a supporting build for complete current
warning review.

Internal complete-evidence aliases and a guarded build-catalog locator reuse
checked snapshots and publish differing rows or removed tails. Confirmation
retains exact logical receipt authority and never updates that build locator.
Missing pre-upgrade aliases are constructed from checked evidence; present corrupt
references refuse. Aligned equal-length fragmented text edits can reuse unchanged
byte leaves in the existing format, while character insertion or deletion can
resegment a changed scalar's suffix. Existing snapshot and receipt bytes remain
immutable. No operator setting or scope/receipt migration is required. Earlier
inline-only readers still cannot recover referenced native receipts; keep the
checked pre-update backup for prior-build recovery. See [identity
review](../import/identity-review.md) and the [API
contract](../../src/server/INTAKE.md#common-report-identity-review).

Reload open Import reviews after updating so large identity evidence uses the current continuation protocol. Continuations are disposable transport state and expire on preview invalidation, rollback, lock or close; reopen the evidence after expiry. Earlier clients that send numeric offsets remain readable, but scan the prefix on each request. The retained snapshot, byte-leaf and receipt formats are unchanged.

Accepted-journal-backed WAL connections now use NORMAL synchronization and a 32,768-page automatic checkpoint threshold for the rebuildable SQLite projection, instead of the earlier 8,192-page policy (or SQLite's 1,000-page default). Durable accepted objects and heads still reach storage before acknowledgment. No operator setting or format migration is required; restart into the reviewed build and verify retained current/history state. Allow substantially more WAL disk headroom and recovery-read work: a small fictional comparison sampled about 150 MB at the new threshold versus 52 MB before, and a transaction or active reader can grow the WAL beyond either threshold. An operating-system crash or power loss may require replaying a lost cache tail from accepted history. Keep the checked backup; a SQLite cache alone is not recovery authority. Earlier builds retain their own checkpoint policy, while unattached and non-WAL databases retain their existing settings. See [the record storage policy](../data/record-version-storage.md#rebuildable-sqlite-commit-policy).

## Identify the current and candidate builds

The derived record-history cache now uses projection 3. It omits redundant field
references for initial scalar metadata while retaining complete accepted versions
and identical history results. A projection-2 cache is incompatible, not an
authority migration: after the checked backup, restart and unlock each profile
to rebuild from authenticated accepted history, then verify current and earlier
state. Rebuild work follows retained history and may make the first unlock longer.
Do not relabel the cache or delete accepted records. Prior-build verification must
use a separate restored copy and rebuild its disposable cache under that build;
this does not make unsupported journal or intake formats backward compatible.
Direct contributor helpers follow their separate [staged recovery procedure](../data/contributor-record-authority.md#runtime-writes-and-reconstruction).

Record the current checkout's exact revision and the running build's `buildId`, `revision` and `worktree` from `http://localhost:3001/api/runtime` (use your configured port). Record the application image ID and tag from that archive's specific Compose project. Retain the prior checkout/revision and dependencies needed to build it again; a mutable image tag alone is not a retained release. Keep receipts outside Git and omit credentials, recovery phrases, private source paths and health content from shared diagnostics.

Select the intended candidate checkout and review its [release, configuration and format notes](#release-configuration-and-format-notes) against the prior checkout. `npm run image:build` can build it without opening an archive. `npm run start` builds from the invoking checkout; `CRS_IMAGE` selects the tag used for that build, not an immutable prebuilt release. Record the resulting candidate image/build identity after starting. Distinct production builds have distinct build IDs; restarting one image retains its ID. An unknown identity stays unknown, and a dirty worktree cannot be claimed to equal its recorded revision. See the [readiness API](../../src/server/API.md#public-runtime-readiness) and [connection behavior](connection-awareness.md).

Keep these identities separate:

| Identity                                                                                   | What it establishes                                                    |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| App build ID, source revision/worktree and image ID                                        | Which application artifact ran; not whether it understands the archive |
| Registry, keyring, encrypted framing, vault index/head and accepted-history formats/schema | The durable authority that must remain readable and intact             |
| Encrypted SQLite cache/projection schema                                                   | A disposable projection that can rebuild only from supported authority |

Readiness confirms process startup, not the readability of every locked profile or model availability. Unlock and check the retained state before declaring the update usable.

## Prepare the checked way back

1. Save the current explicit operator environment outside Git: archive path, proxy YAML and selected alias, provider credential-file selection, proxy state directory, public origin/port and any resource or capability overrides. Protect secrets separately; record safe configuration hashes or sanitized settings in receipts rather than credential values.
2. Record the exact state to check: original and attachment hashes, accepted current records and person attribution, prior accepted versions, correction actor/time/source, pending unaccepted review and explicit Stop. Check each profile you need to recover. Matching counts alone do not prove matching state.
3. Stop the foreground `npm run start` with Ctrl-C and wait for Compose cleanup. Ensure it is the sole writer and no old process remains in this archive's specific Compose project. Never bypass the writer lock/domain or use global Docker pruning.
4. Follow [independent encrypted archive restore](archive-restore.md) to copy the complete stopped `CRS_DATA_DIR` into a fresh protected external backup, compare inventories and SHA-256 hashes, and retain matching usable recovery kits independently. Verify a separate restored copy with those kits. Never start or alter the retained backup itself. A kit contains an unlock secret, not records; a cache rebuild and a restart do not prove an independent backup.

Keep the source stopped throughout copy verification. Complete the backup and independent restore checks before starting the candidate against the active archive. Preserve the backup inventory and its build/format identity, with the expected-state record in protected external storage.

## Start and verify the candidate

Start from the candidate checkout with the same explicit archive and proxy configuration. For example, after replacing these paths and alias with the saved settings:

```sh
CRS_DATA_DIR=/absolute/installation/data \
CRS_MODEL=health-primary \
CRS_LITELLM_CONFIG=/absolute/installation/proxy/litellm.yaml \
CRS_STATE_DIR=/absolute/installation/proxy/state npm run start
```

Also retain your explicit credential-file selection, origin/port and overrides; the abbreviated example does not replace the saved environment. Run only one app version against this archive. Refresh the browser when the [build-change notice](connection-awareness.md) offers it; a stale browser bundle is not verification of the candidate.

Unlock each covered profile and compare against the pre-backup record: download and hash originals/attachments; inspect accepted values, attribution, relationships, corrections and earlier history; verify pending proposals stay unaccepted and explicit Stop stays stopped. Lock and confirm private access is refused. Supported authority can reconstruct missing or incompatible disposable caches without OCR or model calls. An unsupported accepted-history schema is authority incompatibility, even if SQLite also needs a rebuild; deleting the cache cannot make that authority supported.

Retain the actual candidate result, identities and checked scope. A successful readiness response, unchanged record count or an older qualification receipt is insufficient. Avoid new record writes until these checks succeed; any later writes remain outside the pre-update recovery point.

## Refusal or failed startup

An unsupported or invalid authority format must fail explicitly; it is not permission to create an empty replacement archive, reset the profile, discard accepted history, edit format identifiers or invent a conversion. Record which scope failed, whether startup or profile unlock refused, and the operator action reported. Profile authority checks occur at unlock and when referenced originals are materialized; readiness does not validate every locked profile or reread all retained history. Preserve its originals, accepted versions, index, registry and key material. Incompatible disposable caches may rebuild only when the underlying authority is supported.

Stop the failed candidate cleanly, ensure its writer has exited, and preserve its archive and private diagnostics as candidate evidence. Keep the untouched pre-update backup and kits separate. Do not run the prior app against the archive the candidate used: the candidate may already have made valid writes before the failure. Do not damage an important archive to test refusal; use protected, disposable fictional copies for such checks.

## Recover with the prior app and a fresh backup copy

Follow the [isolated restore procedure](archive-restore.md#restore-into-an-isolated-installation), copying the untouched verified backup into a third fresh external directory ending in `data`. Select the retained prior checkout/revision and build it with `npm run start` against that copy. Use separate proxy state/configuration and an isolated browser session with no source cookies or stored keys; different localhost ports share a cookie namespace. Keep the failed candidate stopped and never start the retained backup.

Unlock with the independently retained matching kit and repeat the exact original/hash, accepted state/history, correction, pending-review, Stop and private-access checks. Record the recovered build/format identity and scope. Recovering an untouched backup with the prior app does not establish that the prior app can read candidate-modified authority. Post-backup writes require separate assessment; this procedure does not merge them or promise their recovery. Authenticated old copies can still unlock, so this procedure does not prevent rollback or revoke old backups after a passkey/profile change.

## Release, configuration and format notes

This section and its linked maintained contracts are the durable place to check update-relevant changes. Contributors update these notes and the owning contract in the same change when build selection, operator settings, authority formats or cache compatibility changes. Describe the implemented behavior, required operator action and compatibility limit; keep proposed migrations and unfinished requirements in the [work list](../todo/readme.md). Operators compare the notes in both chosen checkouts, including the linked contract changes, before opening the archive with the candidate. There is no automatic updater, image promotion or general migration policy implied by this process.

Native schema record cursors now return at most 16 KiB from up to 64 checked
internal lexical pieces per public advancement, with a fresh entry and closing
proof even on final `done`. This [connection-local read change](../data/intake-state-storage.md#prefix-scoped-lexical-order-reads) requires only restarting into the candidate build; it changes no retained format, operator setting or prior-build recovery path. Custom readers and transaction fallbacks are unchanged.

| Current boundary                          | Contract and operator consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build provenance and selection            | [Build identity](connection-awareness.md) and [environment](environment.md): launcher builds the invoking checkout; a tag does not select a retained immutable release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Explicit launcher configuration           | [Environment reference](environment.md): app-owned settings use `CRS_`; old prefixes are not persistent aliases. Keep archive/proxy/state settings explicit and separate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Encrypted authority                       | [Vault format](../security/vault-format.md) and [vault index](../security/vault-index.md): encrypted-object framing is v1; current index/head is v2. Older full-map indexes have no decoder or migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Accepted transaction manifests            | New accepted commits use [v2 bounded segment manifests](../data/record-version-storage.md#bounded-transaction-manifests) inside the existing immutable journal/head. Current readers also accept retained v1 commits; old builds refuse v2 commits. Take the checked pre-update backup before candidate writes and retain it for prior-build recovery. No SQLite-schema or encrypted-framing change is required; old monolithic objects retain their prior whole-object decoder boundary. Private ancestry/manifest ordering now batches scratch inserts within each traversal; restart into the candidate to use it. This changes no retained format, archive verification, cache compatibility or operator setting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Accepted history and projection           | [Record versions](../data/record-version-storage.md#condition-storage-schema-boundary): current schema is 7, including condition occurrences. Accepted journal schemas require an exact match; no legacy journal/cache/portable-snapshot compatibility is provided for that addition. A disposable cache's reconstruction does not convert older authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Personal packet preferences               | [Selective packets](../features/selective-packets.md#saved-preferences-and-recovery): changed-only `packet_preference:v1:` metadata uses existing schema 7 authority. Explicit personal portable snapshots add an optional `packetPreferences` overlay; earlier snapshots remain readable. Earlier app builds do not enforce these choices, so use a supporting build before sharing recovered data. No operator configuration is required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Processing queue authority                | [Queue journal](../data/intake-batch-journal.md#compatibility-and-recovery): new batch events/head use v3; supported v1/v2 events are verified and retained unchanged on adoption. No operator setting or SQLite schema change is needed. Older apps refuse v3 queues; take the checked pre-update backup and use that separate copy for prior-build recovery. Existing encrypted-index limits remain unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Intake work reuse                         | [Verified intake work reuse](../data/intake-processing-work.md): disposable lookup format 2 automatically rebuilds format-1 caches from supported selected authority. This cache change requires no operator configuration or manual cache deletion. Authority compatibility is described separately below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Paged intake authority                    | The [intake state owner](../data/intake-state-storage.md#v4-collections-and-selected-publication) supports V4 collections and an exact bridge from retained V3 envelopes in the existing accepted journal. Builds that understand only V3 cannot open a selected V4 intake; cache deletion cannot downgrade durable authority. Take the checked pre-update backup before candidate writes and use a separate untouched copy for prior-build recovery. Public intake identities and versions survive representation conversion. Opening a retained assistant conversion prepares native plan and reading state before its first model request, preserving prior reading progress. New compatibility builds retain authenticated replay progress so an interrupted retry can skip already published prefix writes; it still rereads and hashes the input. Earlier incomplete builds remain retained. Source search during conversion reads checked authority without repairing disposable projection rows; it keeps corruption refusal and counts the extra inventory/compatibility reads. No new SQLite authority or operator setting is introduced.                                             |
| Retained relationship evidence            | [Duplicate evidence snapshots](../import/import-reconciliation.md): native relationship decisions retain a `health-duplicate-evidence-snapshot-v1` reference and explicitly identify the reviewed pre-projection evidence. Use a build that understands the reference to read or reconstruct this history; older inline-array readers are not compatible. These references share the existing intake authority and require no operator configuration. Keep the checked pre-update backup for recovery with the prior build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Streamed ZIP members                      | [Package update and compatibility](../data/streamed-package-originals.md#update-and-compatibility): rebuild from the reviewed checkout; no new configuration or archive-format migration. Large members use verified staging. Located pending failures are additive metadata; older builds do not present them and retain former ZIP byte limits, so their missing warning is not proof of completion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Hosted checker progress                   | [Checker update and compatibility](../security/hosted-passkey-checker.md#update-and-compatibility): reload and verify the exact revision. The 2026-10-05 diagnostic round starts fresh active results in separate default/experimental namespaces; the old database and provider credentials remain intact, with separate prior-round export. Report/tool v3 and run format 1 retain additive optional diagnostics; schema alone does not identify this iteration. Mode changes resume independent runs and never combine A/B from different profiles into a pass. Older builds use the old namespace and cannot interpret newer imported shapes. No household auth, archive-format or operator-configuration changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Referenced identity and ownership history | [Identity review](../import/identity-review.md) retains native `health-intake-identity-receipt-v2` scope and draft references. [Ownership evidence](../data/ownership-name-evidence.md) retains immutable issue-set references and paged outcome receipts, including partial grouped results. Use a supporting build for inspection and reconstruction; earlier inline-only readers cannot recover these new shapes. Keep the checked pre-update backup for prior-build recovery. No operator setting changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Bounded map mutation preparation          | Adjacent inline map puts share authenticated tree paths within the existing 64-change checkpoint limit. Deletes, references, adoption and other maps retain their original order. Restart into the reviewed build; no migration, operator setting or retained-format change is required. Earlier immutable history and reference snapshots remain readable. See [intake storage](../data/intake-state-storage.md#v4-collections-and-selected-publication).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Authenticated collection page reuse       | [Intake state reads](../data/intake-state-storage.md#v4-collections-and-selected-publication) reuse bounded parsed pages only under a checked synchronous read certificate, preserving physical accepted-head checks. Restart into the candidate build; these certificates, their 128-page cache and the shared 32-header/256 KiB schema memo are connection-local and rebuilt. Header reuse checks current physical authority while reducing intermediate observations. The fixed synchronous schema resolver reuses its entry SQL witness for selected-root binding and still compares the closing witness after the final physical accepted-head check; general reads and transaction fallbacks are unchanged. Native lexical order ranges also honor their record prefix, avoiding unrelated returned entries while preserving complete selected values and the existing range authority checks. Bounded synchronous preparation uses its own fresh read certificate and final physical/SQL/registry seal; transaction preparation still reads raw pages and publication retains its existing checks. This changes no durable format, operator setting or prior-build recovery requirement. |
| Concurrent review preparation             | [Clinical review preparation](../data/intake-bounded-views.md) distinguishes certified disposable-cache maintenance from changes to accepted evidence and serializes participating clinical operations per database. A live review can delay another clinical request; complete identity artifact traversal and file hashing yield to unrelated host work, and disconnecting the last identity subscriber stops its preparation. Read-only record sections and fragments reuse the same completed public review session under its existing current-authority checks. Restart into the candidate build and reload open review pages; operation queues, preparation credits and provider memos are connection-local and rebuilt. Ordinary cache compatibility remains conservative. This adds no retained format, operator setting or prior-build recovery requirement.                                                                                                                                                                                                                                                                                                                           |
| Pending selection review                  | [Counted selections](../import/import-reconciliation.md#atomic-counted-selections-and-reconnect-receipts) commit to complete retained question, answer, warning and draft evidence, including values presented through references. Refresh pending reviews after updating before approving them; older presentation-only selection tokens may be refused. This changes derived review tokens, not accepted evidence or retained operation receipts, and requires no operator configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Pending pair autosaves                    | [Exact pair review](../import/import-reconciliation.md#related-record-discovery-and-exact-pair-review) can preserve an unchanged choice through certified native preparation using a response-only acknowledgement of its own new draft command. Reload the app after updating; older clients safely require another pair review when preparation advances several revisions. This adds no retained authority format or operator setting, and replays do not manufacture acknowledgement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Record indexing SQL                       | Publication reuses row-read SQL only within its current traversal; the derived field-history index batches up to 32 metadata rows per validated version. All actual current-row reads, journal authentication, retained versions, atomic publication and recovery checks remain. Restart into the reviewed build; no migration, operator setting, cache-format change or prior-build recovery change is required. See [record storage](../data/record-version-storage.md#replay-sql-reuse-and-the-short-debugging-loop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Retained-history validation               | Contributor/CI only: run `npm run test:history` for the complete artifact and receipt fixtures. They execute serially in a required CI lane and remain in `npm test`; ordinary server shards no longer duplicate them. Case guards and retained archive formats are unchanged. No operator configuration or data migration is required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Fictional recovery oracle                 | The [archive-restore fixture](archive-restore.md) now emits oracle v2 with native paged review and explicit report-acceptance receipts. Regenerate the disposable fictional fixture and receipt for this build; a v1 oracle does not cover the new checks. This changes the qualification artifact, not the personal archive format.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Independent recovery                      | [Archive restore](archive-restore.md): complete stopped-copy backup plus independently retained usable kits; old copies retain their clinical/key state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

These describe current contracts, not proof that a selected pair of releases passed a drill. If the candidate needs a new authority migration, resolve that requirement before use; this procedure supplies neither a decoder nor automatic conversion.

Source-resolution coverage lookup updates now share one bounded maintenance
checkpoint for at most four keys, preserving lookup precedence and the existing
separate scope-index updates. Restart into the reviewed build to use this reduced
publication work. There is no retained-format, operator-setting or compatibility
migration; earlier snapshots remain readable. See [intake storage](../data/intake-state-storage.md#v4-collections-and-selected-publication).

Fresh report maps can include the first bounded ordinary member and occurrence
in initialization. Ordinary reading ledgers can combine their last pending
window with selection within the existing 64-change limit; callback and overflow
flush barriers remain intact. Imported reading tails can share that same bounded
selection. The explicit native imported caller can rank its bounded pending
page flags without that intermediate publication; default and callback-driven
helpers still publish before rank inspection.
Restart into the reviewed build; no migration or
operator setting changes, and prior snapshots remain readable. These changes
reduce publication work, not the required final authority checks. See
[bounded intake views](../data/intake-bounded-views.md).

The candidate also coordinates upload publication, native conversion and short
background-extraction database phases through the existing operation queue; see
[import processing](../import/processing.md). Source-attention list preparation
also joins that queue, so its disposable count updates wait for active conversion
instead of invalidating its original proof. It now also waits for held
accepted-source reads before changing TEMP state, taking the clinical queue
before accepted-source admission to preserve nested attention reads. Earlier
builds can invalidate a concurrent reload's accepted proof with those updates.
Import-feed reads follow the same order before cold queue TEMP initialization;
cancellation at admission prevents that initialization for the cancelled read.
Restart into the candidate and
reload open import pages. Network reception and background source-extraction
workers stay outside the queue; a large participating operation may delay another
database operation. Exact historical batch-exception replay remains supported,
and new native clear-unit receipts retain their stronger unit binding. No archive
format, operator setting or prior-build recovery requirement changes.

Package inventory GETs also join the existing database owner, including their
inventory worker and final current-plan selection. Restart into the reviewed
candidate and reload open import pages. Disconnecting a request now stops its
waiting or active work; a later request resumes completed immutable checkpoints.
Earlier builds can continue inventory after disconnect and invalidate another
conversion's held proof through inventory writes. Originals and accepted
checkpoints remain the recovery authority. This changes no retained authority
format and requires no authority migration or operator configuration change.

Selected package members, shared inventory preparation and metadata reads now
coordinate their database writes with the same owner. Earlier builds could
publish a member from an already completed inventory, or write a located JSON
processing failure, during another conversion and invalidate its held proof.
Selected worker staging can finish while publication waits; cancellation or a
changed physical parent then prevents publication and new failure writes. Exact
member retry preserves the existing retained occurrence and workflow state.
Restart into the reviewed candidate and reload open import pages. This adds no
authority format, migration or operator setting; deferred PDF evidence continues
through the current caller lifecycle.

[Question recipes](../data/intake-bounded-views.md) are authenticated disposable
data owned by a review session, with fresh values on every borrow. Reload reviews
after updating; replacing or closing a review releases its recipes and providers.
They neither migrate retained questions nor change accepted evidence or recovery
compatibility. Their per-question bound is not an aggregate memory or storage
guarantee, and the focused work counts do not establish whole-import performance.

Identity preparation can also reuse an idle report queue's complete current
policy under its existing owner and physical-authority checks. Restart and reload
reviews when updating; retained owners are disposable, with no migration or
archive-format change. A stale selected owner refuses reuse, and grounding
changes still require fresh preparation. The focused parity and ownership checks
do not replace release-build acceptance and encrypted recovery qualification.

Retained asynchronous clinical reviews reuse one session-owned physical-verification
worker across serialized sweeps, while repeating every original-identity and
current-authority check. A completed request's cancellation signal cannot revoke
a later request; cancellation and session closure drain the revoked worker.
Restart and reload open reviews when updating. This changes no retained format,
recovery compatibility, migration or operator setting. Startup reduction is not
a bound on total physical verification work or whole-import performance.

Record replay retains a bounded decoded prefix when a transaction exceeds its
existing reuse budgets, rather than discarding all decode reuse. Later passes
still authenticate and frame the complete journal. Reference-verification
callbacks now receive detached values; modifying them cannot change the accepted
rows or history reconstructed from that journal. Restart into the candidate to
use the corrected replay path. Journal formats and retained authority are
unchanged; no migration or operator setting is required. Giant-value copies and
full physical verification retain their documented limits.

Grounded source-scope preparation also reuses an authenticated ordered prefix
within an opened collection scope. Restart into the candidate and reload pending
reviews after updating; prefixes and their proofs are disposable and are rebuilt.
No accepted record, archive format, operator setting or prior-build recovery
requirement changes. Complete scratch verification remains proportional to the
visited history; reduced native rereads do not make every review constant-cost.

Native PDF evidence reads can reuse a checked model summary and previously
completed validation of the current source-text revision within one result.
Restart into the candidate and reload open import pages after updating; these
receipts are disposable and require no migration, archive-format change or
operator setting. Original-file checks, worker reads, literal page routing and
malformed-authority refusal remain required. The focused read counts do not
establish whole-import timing or replace acceptance, encrypted recovery and
supported release-pair qualification.

Cold intake recovery and profile-copy validation reuse their fixed SQL read
statements. Restart into the reviewed candidate through the update procedure
above; this change needs no additional operator action. Retained formats,
authority rules and configuration are unchanged, with no migration required.
Complete reconstruction still traverses accepted history and validates the
selected intake graph. The focused recovery evidence does not establish full
64-record acceptance/recovery or general release-pair compatibility.

Native intake command preparation now builds its nonresumable candidate in
private disk-backed storage and publishes only the final selected graph. Its
auxiliary indexes retain the same original source and logical-owner checks;
unfinished private construction is discarded, not selected as recovery evidence.
Restart into the reviewed candidate and reload open import reviews. This changes
no retained collection format, requires no migration or configuration change,
and leaves ordinary and resumable collection limits unchanged. The unchanged
257-artifact History fixture covers this publication path, HTTP progress,
cancellation and changed-original refusal; it does not qualify every derived
producer, encrypted-copy path or the whole large-import workflow. See the
[selected publication contract](../data/intake-state-storage.md#v4-collections-and-selected-publication).

**Hosted checker publication, 2026-10-05:** the [static publication workflow](../security/hosted-passkey-checker.md#build-and-publish) now starts automatically on pushes to `main`, including reviewed PR merges; manual dispatch on `main` remains available. Older workflow revisions remain manual-only. Archive packaging uses disk rather than a bounded subprocess stdout buffer, preserving large source maps and validating extraction before updating `gh-pages`. Verify the completed Pages deploy job and the displayed source revision before collecting operator results; a generated-branch update alone is not deployment. This changes no household application, archive format, checker storage namespace or provider credential, and requires no data reset.

**Guided checker A/B/C:** the [guided update contract](../security/guided-passkey-checker.md#update-and-compatibility) introduces separate mode-specific `-abc-v1` namespaces and schema-4 reports while keeping tool version 3 and IndexedDB/run format 1. Reload and verify the deployed source revision; prior A/B databases and provider credentials stay intact and separately exportable. New runs test equal A/B usernames and a changed C username with a stable user handle/display name, then recheck retained credentials. Bounded native-message excerpts are explicitly transformed, not full original errors. Download the current report, check that it was saved, and explicitly clear only that run; a changed report requires a fresh download. Older checkouts use their prior namespace and cannot read guided shapes. This changes no production authentication, household archive or operator configuration and does not qualify any real release or provider.

## Repeatable fictional release qualification

Run from a frozen candidate checkout with Docker and the contributor Node/browser prerequisites available. Choose an exact locally available prior commit and a fresh absolute external output directory outside Git:

```sh
CRS_RELEASE_UPDATE_TEST=1 \
CRS_UPDATE_PRIOR_REVISION=<exact-prior-commit> \
CRS_UPDATE_OUTPUT_DIR=/absolute/fresh/external/directory \
npm run qualify:release-update
```

The drill builds distinct prior and candidate application artifacts, uses a small independently fictional fixture and explicit local proxy configuration, and requires no provider, paid inference or heavy import. The prior commit must be locally available and the two source trees must differ; keep the candidate checkout unchanged throughout the run. This bounded drill requires unchanged supported authority/cache formats. It verifies a separate backup copy with the prior app and retained kit before opening the candidate, then checks retained state, incompatible-cache reconstruction, protected-copy startup/index refusals and prior-app recovery from another fresh copy of the untouched backup. Focused storage tests additionally cover unsupported key and accepted-history formats. Kits, archives, full inventories and raw diagnostics stay outside Git. Retain the actual receipt, including both build/image identities, authority/cache identities, configuration checks, refusal scopes and recovery result, before claiming that release pair passed.

A passing fictional run covers the observed release pair and local environment. It does not establish general downgrade compatibility, rollback prevention, lossless post-backup recovery, power-loss durability, every filesystem, physical passkeys, a live provider or remote deployment. A command's existence is not a successful qualification receipt.

## Observed release-pair evidence

On 2026-10-03, the fictional cloud drill passed for clean prior revision `b5f6347e43a9a93a7a597e78d57891cb554f9258` and clean candidate revision `5def4db7367cb5dfc89b93e276994aeec88cf582`. It verified the separate backup copy and independently retained kit before candidate startup, distinct built artifacts, exact originals and accepted state/history, correction attribution, pending review and Stop. The authenticated future disposable-cache schema `999999` rebuilt from supported authority. Future/missing registry startup and future encrypted-manifest unlock refused on protected copies without changing their bytes. Prior-app recovery from another fresh untouched-backup copy passed; source and retained backup remained unchanged, with zero model requests. Both releases used accepted-history and disposable-cache schema 7.

The run used reviewed environment-only compact Docker build overrides to fit the cloud filesystem. The pinned base, lockfile-driven application build, qpdf/OCR/Chromium prerequisites, runtime allowlist, nonroot user, command and health probe matched the repository build contracts; the exact recipes and hashes were retained with the external evidence. This qualifies that observed pair and equivalent application/runtime configuration, rather than an unmodified stock-image build or other releases/filesystems. Focused storage tests separately cover unsupported key, accepted-history and eager/deferred encrypted-original framing. Public readiness does not establish exhaustive history validation. Future release qualification still needs current build-scoped evidence with the limitations above.
