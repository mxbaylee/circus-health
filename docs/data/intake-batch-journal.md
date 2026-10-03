# Processing queue journal

The [Operator's recovery job](../design/personas.md#operate-and-recover) needs saved reading progress to remain usable as an import runs longer. The scheduler stores that progress separately from [accepted intake evidence](intake-envelope-authority.md). Small queue changes retain every earlier event without reading and replaying the complete queue history again. This does not change model budgets, clinical acceptance or the meaning of completed reading.

## Selected authority and ordinary changes

Each batch has immutable `events/<sequence>-<UUID>.json` events and a small `events/current` marker. New events use `health-intake-batch-delta-v3`; the marker uses `health-intake-batch-head-v3`. The selected references bind event filenames and SHA-256 digests, profile, batch and ordering. Initial state is retained once; later events carry sequential field changes, removals and array truncations. Neither the marker nor a routine event rewrites a growing list of earlier events.

The manager uses tracked state to record exact mutations. Assigned values are detached from outside aliases, and detached former children cannot mutate a replacement at their old path. Existing batches require a verified publication basis; an untracked replacement snapshot or stale writer cannot overwrite current progress. Complete response objects use a separate copy operation, whose work is counted separately from journaling.

Warm publication checks the selected marker and remembered file identities under a kernel writer lock. It validates and serializes the changed evidence. The remembered state is disposable acceleration: it is not recovery authority and is invalidated on publication failure, closure and profile lock. Warm updates do not rehash every older event; cold reopening, copying and recovery verify the complete retained selected chain. Corrupt, missing or unsupported selected evidence fails visibly rather than falling back to SQLite or an earlier snapshot.

## Publication, interruption and retry

An event is staged and flushed before the selected marker is published. The staging directory is flushed after removing the temporary event link and before selecting it; both directories are flushed after the marker moves. Immutable event publication does not replace an earlier event. Staging material and unselected events cannot become current merely because they exist on disk. Temporary files and writer locks are excluded from encrypted publication and portable copies.

A failed save is not a successful pause or stop. The manager reconciles the selected durable state, fences earlier callbacks and retains a publication barrier. An idempotent reply or resumed dispatch cannot bypass an unresolved encrypted flush. Retrying establishes the durable outcome before acknowledging success; it does not duplicate an already selected transition.

An actual encrypted manifest-publication failure closes that vault writer. Repeated requests cannot repair it in place: lock and reopen the profile to select the authenticated committed manifest. Lock may report the earlier failure while still cleaning up the old runtime. Failure before manifest replacement leaves the prior state; failure after replacement can retain the new state despite the lost acknowledgment. A lost reply after an otherwise successful flush leaves the writer usable and follows the ordinary retry barrier.

Stop clears diagnostic `queuedAt` in the same saved transition, so the response and reopened state agree. Earlier timestamps remain in immutable history. Explicit Resume starts a new queue interval, keeping the user's pause out of queue-delay measurements.

## Encrypted publication and its scope

Every ordinary encrypted-workspace inventory prunes the queue subtree before enumerating its retained files. Cold vault opening materializes existing files from the authenticated manifest; the queue then verifies its retained selected chain when read. Subsequent publications supply only changed selected events and their marker. Pending selections remain pending until the encrypted manifest publishes successfully. Source and chat dependencies still participate in the existing publication path.

This bounds the work attributable to retained queue history. The existing inventory of unrelated source/chat files remains and is measured separately. A requested complete response also costs work proportional to that response, and cold reconstruction reads the retained chain. These are distinct costs; this journal does not establish constant work for an entire encrypted request or a complete clinical import.

## Compatibility and recovery

Supported `health-intake-batch-v1` snapshots and `health-intake-batch-delta-v2` events are verified before a new selected head adopts them. Their bytes remain unchanged. New UUID event names remain visible to older readers, which refuse the unsupported v3 event instead of silently returning an earlier queue state. Unsupported formats are not automatically converted.

There is no new lifetime event-count or history-byte allowance in the queue journal. Existing [encrypted-index resource limits](../security/vault-index.md#bounds-and-schema-boundary) remain unchanged. Originals, accepted record versions and queue events remain separate durable evidence. SQLite loss does not remove queue history. Before changing app versions, follow the [release update procedure](../setup/release-updates.md); an older app cannot resume a queue containing v3 events, and recovery with a prior build uses its verified pre-update backup.

## Counted fictional qualification, 2026-10-03

The following logical work counts were measured from the source and fixtures committed at [d09a958](https://github.com/mxbaylee/circus-health/commit/d09a958c85d347bf6bb8b3cefe9412ffffb62167), using production limits. Recorded source hashes were checked against that commit; the revision annotation is a documentation-only follow-up. They measure application operations and payload bytes, not physical disk traffic, total CPU instructions or a capacity target. No event pruning, model request or larger resource limit is used. Initial creation and cold reconstruction are separate from each sampled warm save.

### Retained history and warm Stop

| Measure                                               | Initial |   +100 |    +200 |    +300 |
| ----------------------------------------------------- | ------: | -----: | ------: | ------: |
| Retained events                                       |       2 |    102 |     202 |     302 |
| Retained event bytes                                  |   2,013 | 98,075 | 194,175 | 290,275 |
| Checkpoint event bytes written, serialized and hashed |     958 |    972 |     972 |     972 |
| Selected head bytes written and serialized            |     319 |    320 |     321 |     321 |
| Head bytes read (two reads)                           |     638 |    640 |     642 |     642 |
| Prior event reads / replayed events / diff calls      |       0 |      0 |       0 |       0 |
| Cold event bytes read and hashed                      |   2,013 | 98,075 | 194,175 | 290,275 |
| Cold changes replayed                                 |      11 |  1,012 |   2,012 |   3,012 |

Each sampled Stop performs 65 tracked property reads, 22 head-field comparisons, 13 path serializations totaling 137 UTF-16 units, two file syncs and four directory syncs. Event serialization and hashing each cover the one new event; marker serialization covers the one small head. Cold recovery reads every retained event once and verifies its digest and ordering. The increased retained bytes relative to the historical v2 fixture pay for explicit selection, digest binding and exact sequential mutations; they do not buy history pruning or full-state checkpoints.

### Untouched items and nested evidence

The actual manager's request-checkpoint callback is also measured after 300 transitions with one item and five retained exceptions (1,136 untouched bytes), and with 100 items and 500 retained exceptions (115,281 untouched bytes). Both small updates write and serialize a 502-byte event plus a 324-byte head, hash only that event, read 86 tracked properties, enumerate 38 keys, compare 11 head fields and perform 32 path serializations totaling 727 UTF-16 units. Both clone eight mutation nodes and four change nodes with zero historical replay clones.

An unchanged callback writes no event or head, hashes no bytes, clones no evidence and performs no sync. It still reads the 324-byte selected marker, compares 11 head fields and performs 28 path serializations totaling 683 units. Complete requested response copies remain separately counted: 96 nodes for the small queue and 4,156 for the larger queue. The callback qualification does not suppress genuinely changed timestamps in other manager paths; redundant authentication-wait behavior remains [separate work](../todo/CRS-140.md).

### Actual encrypted publication

The [vault fixture](../../src/server/test/vault-queue-publication.test.ts) measures a real encrypted Stop, accepted-record hooks and the generic response flush together at each checkpoint; cold setup/reopening is excluded. It observes pathname and descriptor metadata calls, directory enumeration, reads/writes, syncs, path mutations and SHA-256 input. Ciphertext includes authentication overhead. Writes and verification reads are independently counted, even where their byte totals match.

| Measure                                              | Initial |  +100 |  +200 |  +300 |
| ---------------------------------------------------- | ------: | ----: | ----: | ----: |
| Queue directory reads / entries                      |       0 |     0 |     0 |     0 |
| Queue plaintext bytes read                           |   3,747 | 3,642 | 3,647 | 3,647 |
| Queue plaintext bytes written                        |   1,374 | 1,320 | 1,321 | 1,321 |
| Encrypted object bytes written (and separately read) |   1,522 | 1,468 | 1,469 | 1,469 |
| Encrypted index bytes written (and separately read)  |     941 |   944 |   944 |   944 |
| Encrypted manifest bytes written                     |     599 |   607 |   608 |   609 |
| SHA-256 input bytes                                  |   5,856 | 5,700 | 5,703 | 5,703 |
| Other workspace directory reads                      |      18 |    18 |    18 |    18 |
| Other workspace directory entries                    |      22 |    22 |    22 |    22 |

Queue work stays at 14 opens, 20 stat calls (including descriptor stats), 24 other metadata checks, six syncs, five path mutations, 14 payload reads and two writes at every sample. Unrelated workspace work stays at four opens, 28 stats, eight other metadata checks, four syncs and four path mutations, with zero payload reads or writes in this fixture. Its 18 directory reads and 22 entries are existing source/chat inventory, not removed work: a larger unrelated archive can still increase that cost. The regression also publishes pending source/chat dependencies and multiple selected queue events in one flush, so pruning queue history does not omit those dependencies.

Run these focused fixtures with Node 24.19 or newer from the repository root:

```sh
node --test --test-timeout=30000 src/server/test/intake-work-accounting.test.ts src/server/test/intake-batch-journal-growth.test.ts
node --test --test-timeout=30000 src/server/test/intake-batch-journal.test.ts src/server/test/vault-queue-publication.test.ts
```

## Qualification boundary

The [manager growth fixture](../../src/server/test/intake-batch-journal-growth.test.ts) exercises initial state and 100, 200 and 300 real scheduler transitions, preserves earlier event and original bytes, and compares complete independently expected state after reopening. A separate actual manager callback varies untouched queue items and nested evidence while measuring a small change and a no-op. Cold reconstruction and complete response copies are attributed separately.

The [journal regressions](../../src/server/test/intake-batch-journal.test.ts) cover mutation aliases, stale writers, retained legacy evidence, corruption and publication interruptions. Encrypted qualification exercises the real vault and its selected-file publication, including pending non-queue dependencies. The fixtures use independently fictional data and local scripted callbacks, with no provider requests.

These checks do not establish hardware power-loss behavior, whole-import capacity or clinical completeness. The separate [verified intake-work reuse](intake-processing-work.md), [large-import qualification](../todo/CRS-194.md) and held runner/capacity requirements retain their own evidence boundaries.
