# Contributor accepted-record authority

The isolated contributor runtime uses the same [accepted-record journal](record-version-storage.md) as the encrypted application through a filesystem `RecordStorage` adapter. This gives normal contributor intake reads and writes genuine configured durability, including intake contributions, source pins, receipts and clinical changes in one transaction. It is separate from the default encrypted npm → Compose deployment and does not add remote household access.

## Selection and storage

Contributor profile storage is plaintext and belongs only in the existing isolated contributor facility. The profile's `record-authority.json` selects its format and owner; the sibling `records/` directory contains an atomically replaced `head`, immutable `objects/<UUID>` files and a kernel writer lock. Presence of either the marker or the directory selects this backend. Keeping the marker outside the directory also prevents loss of the whole journal subtree from selecting an old portable generation. Unknown formats, owner conflicts and missing selected heads refuse; SQLite or an older portable generation cannot silently become the replacement authority.

Only explicit fresh-profile or unpublished-copy initialization may create a new journal. Normal runtime open requires existing selected authority. An already-published portable archive is not silently converted, and a cache containing record history cannot seed a replacement journal after authority loss.

If the contributor registry is absent, discovery can establish an existing profile from independent reconstruction of its selected journal, owner and original bindings even after SQLite cache loss. A directory name or marker alone is insufficient. Damaged selected journal evidence or multiple durable archives claiming the same owner refuse; discovery neither seeds new authority nor falls back to portable state.

Each registry-free discovery repeats that full retained-state verification, including direct recovery/helper calls and initial startup lookups. The runtime lifecycle persists the verified registry before serving ordinary profile lists, whose subsequent lookups read that explicit registry. Registry-free discovery is not covered by warm intake lookup locality guarantees.

The backend accepts only its supported head/object names, checks physical profile-contained directories and regular files, refuses symlink traversal, creates immutable objects without replacing existing evidence, and verifies writes. File and directory synchronization accompany publication. The attached database holds an exclusive writer lease for its lifetime. Original source/asset references are verified against their profile-contained files before accepted publication and during reconstruction.

Fresh physical-path proofs use Node's `realpathSync.native` for each checked directory and regular file, rather than repeating the JavaScript path-component walk. Resolved paths are not memoized: every read still checks the current profile and journal directories, the selected file's parent, its physical path and regular-file status, then opens with `O_NOFOLLOW`. Replacing an ancestor or selected directory with a link, a broken link, a nonregular file or a resolver error remains a refusal. This changes neither the accepted-head format nor publication ordering, fsyncs, encryption or writer ownership. No archive migration or new operator configuration is required. The fictional storage regression counts all four physical-path proofs for each head read and verifies that an already-open backend sees new head bytes and rejects later link replacements. These checks do not add an atomic whole-path race guarantee.

## Runtime writes and reconstruction

`attachPersonalDurability` without an encrypted storage callback selects contributor record durability. The previous snapshot backend is an explicit portable-format mode; it is not a fallback after journal failure. Ordinary contributor operations append versions of changed records and the [selected intake contributions](intake-envelope-authority.md), rather than writing another full personal/curation generation each time.

The accepted head selects authority before acknowledgement. A published head survives a later SQL rollback or ambiguous completion; stale live state refuses further mutation until recovery. Reopening may catch up a valid earlier accepted cache from the selected head. It also compares substantive state with an independent journal reconstruction: conflicting or unacknowledged SQL changes refuse rather than being silently accepted or erased. Total SQLite cache loss reconstructs from the journal without inference. Missing or corrupt selected journal evidence is an error, even if a portable export or old SQLite file still exists.

Direct attachment also refuses an incompatible history projection, including projection 2 when the current reader requires projection 3. Contributor startup reconstruction creates a fresh runtime projection; direct helper users must use the existing staged `rebuildProfile(sourceRoot, profileId, newEmptyTargetRoot)` facility to recover into a separate empty target. This retains the same selected journal and originals and leaves the source archive untouched. Keep the source stopped, retain its backup and compare complete current/history state before selecting the target. There is no operator CLI for this contributor-only facility. Do not delete a live cache, relabel its projection or erase unacknowledged edits to make attachment pass. The supported encrypted Compose runtime instead reconstructs incompatible caches during authenticated unlock.

Portable personal/curation generations remain explicit export/recovery artifacts with real manifests. They omit disposable `__record_*` tables and preserve current selected intake representation. Exporting a snapshot is intentionally work proportional to retained state; it does not make that snapshot the runtime authority or authorize recurring full snapshots during mutations.

### Prepared publication core

The internal prepared-record API supports genuine contributor storage as well
as vault storage. It executes business decisions once in a rolled-back
preparation, authenticates changed predecessors against accepted storage, and
publishes only the frozen changes through a distinct final transaction. The
original report's complete artifact and source-lease proofs remain live through
the combined final physical check. A temporary verification frame must belong
to that exact report and add no expiring caller conditions; an arbitrary child
operation or a different report cannot supply this continuation.

Within the same live contributor owner, an exact committed publication can
extend its private accepted-history certificates with its own changes. A second
prepared write can reuse those certificates without replaying prior versions.
The complete physical namespace still receives verification; this is not
constant total work. Closing storage disposes retained verification resources
without turning an already committed acknowledgement into a failure.

Ordinary public ownership callers do not yet select this prepared path.
Prerequisite catalog publications and approved multi-group continuations remain
unqualified under [CRS-231](../todo/CRS-231.md). Helper qualification does not
establish those public workflows or change the supported recovery procedure.

## Copy and retry

The contributor copy operation retains its caller-supplied UUID, source/name binding, unpublished staging and final-directory publication contract. Source and backup must match the selected accepted head and substantive recovered state. One-time verification may reconstruct an independent source projection; it must not publish unacknowledged source changes to make a stale cache look coherent.

Before first destination publication, the target receives its own owner/path bindings, retained verified originals and fresh target intake chains. Copied disposable journal projections are removed. The target attaches genuine durability only after staging; a selected target head cannot be treated as an unpublished destination. Initial copy artifacts and the selected accepted head are pinned for first registration.

The staged journal is independently checked before final-directory rename publishes the destination. Registry publication and runtime activation follow. Retry before registration verifies the pinned initial destination and requested name; retry after completed registration preserves the destination's latest accepted changes and current name, even if the source advanced or disappeared. An already active target still checks genuine durable readiness, rejecting missing/corrupt selected heads and unacknowledged SQL changes. Cache-loss recovery follows the selected journal, not the copy's initial portable snapshot.

The `publicationAttempted` rule remains conservative. After an ambiguous attempt, missing final storage cannot justify an automatic new copy under the old operation ID. Preserve the intent and available stage/archive evidence for explicit recovery. Only a live failing operation that can prove the original stage remains and the final destination is absent may clear its attempted marker.

## Evidence limits

The plaintext adapter does not change the encrypted product's privacy, recovery-kit or browser-session boundaries. Filesystem checks and fault-injected publication tests do not establish physical power-loss behavior or arbitrary filesystem guarantees. Full source comparison, backup, initial framing and original verification during copy scale with retained state. Existing-profile attachment also performs independent reconstruction and comparison; that opening cost is separate from warm mutation locality.

The contributor backend enables genuine runtime authority; [application mutation and recovery qualification](intake-mutation-qualification.md) includes actual filesystem publication faults and independent backend reopening. No large-import, provider or physical-device release gate is closed by this storage contract alone.
