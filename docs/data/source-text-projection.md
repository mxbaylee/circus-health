# Disposable exact source-text storage

The internal API in [`source-text-projection.ts`](../../src/server/source-text-projection.ts) stores retained v3 and non-original source-details text as bounded content, occurrence and link rows. Native v4 originals instead stream their checked logical authority directly, avoiding a second full text representation and text reconstruction during local mutations. Compatibility storage uses [automatic reconciliation](text-piece-reconciliation.md) to preserve untouched passages.

This is a disposable adapter over the [selected intake envelope authority](intake-envelope-authority.md). Original source rows contain compact metadata; selected authority owns their logical envelope. Non-original sources retain their raw `source_files.details_json`. [Source-list search](source-details-search.md) consumes ordered fragments with a SQLite-equivalent default LIKE predicate. The adapter never replaces originals, accepted versions, source-text revision authority or the [incremental intake primitive](intake-state-storage.md).

## API and selected text

`reconcileSourceTextProjection(db, options?)` reconciles dirty sources. Native v4 reconciliation binds its checked logical root and selected source; receipt/build churn and local edits write zero text-content rows. Conversion removes any old compatibility rope once. `consumeSourceTextProjection(db, sourceId, consume)` drains checked ordered fragments. Native export emits at most 4 KiB per fragment and checks selection on completion; incomplete evidence refuses even when a pattern matched earlier. A checked legacy bridge remains an explicitly counted v3 full-work compatibility path until schema adoption completes. `readSourceTextProjection` retains complete-string reconstruction for compatibility sources. `sourceTextProjectionCounters` records logical work; `clearSourceTextProjectionCache` clears readiness, its observer and retained snapshots on lock/close.

The v3 snapshot cache retains at most one bounded source, independently of source count. Native v4 search retains no operational envelope or text-piece snapshot. Cold and warm exact searches can both traverse the complete selected text; that counted query work is separate from mutation work.

Caller authorization and the existing exclusive profile lease remain application responsibilities; this internal API does not grant access to a locked profile.

Text is the exact selected envelope string. Raw-mode originals and non-original envelopes retain their stored spelling; normalized originals reconstruct the complete ordered envelope under the [exact serialization contract](intake-state-storage.md#exact-serialization-domain). Whitespace, member order, duplicate-property spelling, escape spelling and non-BMP text remain exact. JSON parsing validates authority but does not normalize the returned bytes. Generic source kinds may contain any valid JSON; original intake sources require an intake object, and an included workflow must be an object; a present workflow format must be supported. Malformed or unsupported selected authority fails rather than becoming empty text. The [engine's scalar-safe text domain](text-piece-edits.md#explicit-edits-and-exact-results) still applies.

The compatibility rope uses five `__record_source_text_*` tables: a format/profile binding, source heads, shared content, source occurrences and links. Native v4 originals have no rows in those text-data tables. Each compatibility head binds profile/source/hash/text digest/topology and the selected intake head where applicable. Equal content never establishes occurrence ownership. Selected pieces and bindings are checked before reuse; identity/hash/kind labels remain nonempty text bounded to 1,024 UTF-8 bytes.

The namespace is excluded from accepted-record capture and portable authority export. Private copies rebuild target-bound projection rows from the target's own selected source authority; projection rows are never a reason to copy the source profile's authority binding. Missing or damaged derived data can be repaired without changing originals or accepted records.

## Transactions and recovery

Connection-scoped TEMP triggers track source inserts, updates and deletes, including identity changes, and affected derived rows. Indexed intake-head namespace triggers also mark affected sources dirty on head insertion, update and deletion, so an operational-only mutation with unchanged compact source metadata still invalidates derived text. Routing uses the head key rather than JSON decoding a possibly corrupt value. They create no persistent trigger dependency in a copied or rebuilt database. A cold connection checks current sources and retained references once. Warm reconciliation reads only dirty source text; unchanged sources do not require operational intake hydration. Verified text-piece snapshots can serve unchanged selected warm reads without reloading and reconstructing the same rows. Content, occurrence, link and head changes invalidate affected snapshots, including external-connection changes detected through SQLite `PRAGMA data_version`. Schema changes and failed transactions clear readiness; lowered caller limits still receive their required validation.

Initialization, reconciliation, cleanup and the requested read run inside one savepoint. When invoked during an application transaction, the source update and derived changes commit or roll back together. An error rolls back the partial projection batch and rejects the outer application transaction even if its caller catches the error. Failed transaction outcomes, including exceptions after SQLite commit, invalidate readiness. The [source-search integration](source-details-search.md#mutation-and-recovery-boundary) makes ordinary intake writes and registration reconcile an already-used projection within their existing application transaction. Cold writers initialize and reconcile at the next read; initialized connections retain dirty tracking and next-read repair for direct SQL and outside-application-transaction producers. Original operational writers publish the selected envelope chain in that same transaction; the projection remains disposable.

Malformed schema, stale or wrongly bound heads, missing content, cycles, dangling links and foreign occurrence identities cannot supply trusted text. Repair first validates the selected source authority. A stale accepted-record projection refuses until normal accepted-record recovery succeeds. This follows the existing durability lifecycle: warm reads compare the selected durable head with the attached projection; they do not reauthenticate every historical immutable object on each call. Recovery tests separately exercise absent, corrupt and unsupported selected durable evidence.

Cache reconstruction and automatic matching are separate paths. Invalid disposable evidence may be recreated from verified source text. Exhausted caller limits or an unresolved automatic reconciliation are errors; they never trigger a full-source replacement fallback. Rollback preserves the prior selected projection, and retry does not erase that distinction.

## Limits, cleanup and work accounting

Source text and retained pieces use the [explicit engine limits](text-piece-edits.md#limits), and discovery uses the [automatic matching limits](text-piece-reconciliation.md#work-limits-and-refusal). Options may lower those limits. Default-limit validation decides whether persisted derived evidence is usable; supplied limits apply to individual planning or requested reconstruction calls. They are not an aggregate budget across every dirty source or every validation in a public API call. SQL source bindings add bounded row overhead beyond the pure engine's row representation.

Content cleanup follows affected references through the content-reference index. Source deletion removes that source's references; shared content survives while another source refers to it. Reconciliation does not repeatedly sweep all content to remove a single source's stale rows. A cold connection also performs one explicitly counted retained-content inventory scan to find orphans left while TEMP tracking was absent. Schema/index repair and cold initialization have separate work from ordinary warm updates.

Counters separate authority text reads/bytes and hashing; loaded projection rows and serialized bytes; content, occurrence, link and head writes; deletion keys; affected-reference cleanup; and completed engine/matching work. Host read/write counters include work counted before a later rollback. Content-change TEMP triggers report reference rows visited on completed cache calls: the indexed count, affected-source query and snapshot-invalidation query each visit matching references, so the counter charges all three traversals. A failed interval can roll back its TEMP counts. Failed pure-engine calls return no partial metrics; their declared limits still apply. Engine logical string copies, reconstruction and hashing overlap by activity and must not be added as physical storage bytes. SQLite page allocation, planner/internal index steps, schema checks and TEMP tracking are separate from serialized row payloads.

The changed source consumes already validated envelope text. Normalized authority reuses its primitive fingerprint for the exact envelope bytes; raw mode hashes the raw envelope because its primitive fingerprint covers the distinct `{raw: ...}` wrapper. Verified snapshots reuse retained pieces. Actual reconciliation retains conservative pure-engine validation, matching and reconstruction passes, which remain counted work. Small persisted changes do not establish computation proportional only to changed bytes. Original production writes retain compact source rows and changed envelope contributions. The [application mutation qualification](intake-mutation-qualification.md) separates those writes from full-view normalization, serialization, diffing, hashing and cloning; [verified intake work reuse](intake-processing-work.md) describes the implemented reuse and remaining work.

## Measured writes and host work

The numeric tables and measurements below are the historical preactivation PR #57/#58 baseline. Their full inline source-row and accepted-publication costs do not describe current original authority writes. These 100/200/300 helper/source-text changes do not qualify actual batch/review/clinical-acceptance mutations, PR #35 or heavy imports.

The historical pre-reuse [growth test](../../src/server/test/source-text-projection-growth.test.ts) begins with 10,097 UTF-8 bytes (10,094 UTF-16 units) of fictional raw JSON, including a periodic passage, Unicode and a literal escaped surrogate. It prepends one character inside a value for 300 actual application transactions. Each transaction updates current source authority and automatically reconciles its projection, followed by two exact warm reads and an unchanged reconciliation check. SQL audit triggers independently count actual inserted/updated row payloads and compare them with the public counters.

Initial text storage uses 3 content rows (10,355 encoded bytes), 3 occurrences (513 bytes), 3 links (318 bytes) and one 637-byte source head. The format-binding row and schema are separate from these text-data counters. Initial accepted publication writes 16,959 bytes in 3 writes. Total SQLite allocation after the first projected read is 413,696 bytes. The historical initialization plus that read reported 1 authority read, 16 projection rows/11,976 encoded bytes read, 41,492 engine-hashed bytes and 146,446 logically copied bytes.

The following cumulative updates exclude initialization:

| Updates | Content rows / bytes | Occurrence rows / bytes | Link rows / bytes | Head rows / bytes |
| ------: | -------------------: | ----------------------: | ----------------: | ----------------: |
|     100 |               1 / 84 |            102 / 17,239 |      201 / 24,010 |      100 / 63,992 |
|     200 |               1 / 84 |            202 / 34,239 |      401 / 48,210 |     200 / 128,292 |
|     300 |               1 / 84 |            302 / 51,239 |      601 / 72,410 |     300 / 192,592 |

The repeated inserted character shares one content row. This fixture has no deleted rows; the first insertion also splits its containing occurrence. Across updates, maximum encoded row sizes are 84 bytes for content, 172 for an occurrence, 122 for a link and 643 for a head. Shared-content and deletion repair have separate tests. These are SQL row representations including source bindings, so they differ from the pure planner's counters.

| Updates | Authority reads / bytes | Projection rows / bytes read | Total SQLite bytes | Accepted writes / bytes written |
| ------: | ----------------------: | ---------------------------: | -----------------: | ------------------------------: |
|     100 |         100 / 1,014,750 |           34,001 / 7,256,019 |          2,199,552 |                 300 / 1,252,168 |
|     200 |         200 / 2,039,500 |         128,001 / 21,851,619 |          3,952,640 |                 600 / 2,515,118 |
|     300 |         300 / 3,074,250 |         282,001 / 43,827,219 |          5,754,880 |                 900 / 3,788,068 |

In this historical pre-reuse run, authority hashing processed the same number of bytes as the authority-read column. SQLite totals include source rows, accepted-history indexes and projection/index allocation; they are not projection-only writes or filesystem usage. Accepted retained objects, including the selected head, occupy 1,254,727/2,503,277/3,761,827 bytes at 100/200/300 updates. The page totals are one measured run on 2026-10-03, and can vary with SQLite and generated identities. They are evidence, not a capacity threshold.

Completed engine calls, including the two warm reads per update, additionally report:

| Updates | Existing content read bytes | Scan steps | Hash bytes | Logical copied bytes |
| ------: | --------------------------: | ---------: | ---------: | -------------------: |
|     100 |                   5,048,997 |    116,340 | 17,428,024 |           49,861,352 |
|     200 |                  10,097,997 |    442,690 | 46,681,124 |          135,576,002 |
|     300 |                  15,146,997 |    979,040 | 87,814,224 |          257,320,652 |

| Updates | Validation UTF-16 units | Reconstruction UTF-16 units | Exact comparison UTF-16 units | Encoded UTF-8 bytes |
| ------: | ----------------------: | --------------------------: | ----------------------------: | ------------------: |
|     100 |               6,062,247 |                   6,086,400 |                     1,014,450 |          19,457,524 |
|     200 |              12,134,497 |                  12,232,800 |                     2,038,900 |          50,760,124 |
|     300 |              18,216,747 |                  18,439,200 |                     3,073,350 |          93,962,724 |

Automatic matching additionally reports:

| Updates | Scanned UTF-16 units | Compared UTF-16 units | Hashed UTF-16 units | Alignment steps | Anchor candidates |
| ------: | -------------------: | --------------------: | ------------------: | --------------: | ----------------: |
|     100 |            5,086,241 |             5,068,502 |           9,169,915 |          48,026 |         2,008,067 |
|     200 |           10,202,291 |            10,181,652 |          18,389,465 |         106,676 |         4,016,267 |
|     300 |           15,368,341 |            15,339,802 |          27,699,015 |         175,326 |         6,024,467 |

Matching logically copies 1,014,750/2,039,500/3,074,250 UTF-8 bytes at 100/200/300 updates and derives one operation per update. This fixture needs no Myers trace cells or residual reuse. It visits one affected old content reference and makes two additional indexed cleanup probes across all updates; initialization had three probes. There is no extra cold inventory scan or content-trigger reference fanout during these ordinary inserts. Corruption/shared-reference tests exercise those paths separately. The growing read, reconstruction and hash counts remain visible despite bounded changed rows.

## Recovery evidence

[Storage regressions](../../src/server/test/source-text-projection.test.ts) cover raw spelling/bytes, distant edits and retained periodic middle identities, shared content, warm dirty tracking and repeated UPSERTs, first-warmup and partly executed batch rollback, a caught error rejecting the outer transaction, post-COMMIT flush/release errors, actual reopen, schema/index/table loss, malformed heads/links/content and unsafe SQLite integer or BLOB values. Malformed actual source identity and unsupported authority fail without deleting source evidence. Automatic matching exhaustion preserves the old projection and never becomes a full replacement.

[Encrypted integration tests](../../src/server/test/source-text-projection-vault.test.ts) warm source storage, perform a real private copy, verify target owner/path bindings and unchanged source authority, then lock and rebuild each profile after total cache deletion. They also verify that missing, corrupt and unsupported selected durable evidence cannot yield a successful recovery. Portable export and accepted-record capture omit the derived namespace. All fixtures are independently fictional, with no inference or physical-device qualification.

## Integration boundary

[Exact source search](source-details-search.md) implements source-list count/page integration, native SQL LIKE parity, bounded request lifetime and separate query work accounting. The [selected intake envelope authority](intake-envelope-authority.md) implements original authority selection, compact source metadata and head-bound derived freshness; [application mutation/recovery qualification](intake-mutation-qualification.md) measures the combined path. This storage API does not establish full import capacity, provider behavior, physical-device qualification or production readiness.
