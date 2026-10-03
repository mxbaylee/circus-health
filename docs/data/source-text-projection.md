# Disposable exact source-text storage

The internal API in [`source-text-projection.ts`](../../src/server/source-text-projection.ts) stores exact source-details text as individually bounded content, occurrence and link rows. This supports a Records assembler's need to retain trustworthy evidence as a collection changes and after recovery. It uses [automatic reconciliation](text-piece-reconciliation.md) to preserve untouched passages without requiring the caller to describe semantic edits.

This is a disposable projection of current `source_files.details_json`. [Source-list search](source-details-search.md) reconstructs exact text through this API while retaining native SQLite LIKE; production intake authority remains in that source column. The projection does not replace originals, accepted versions, source-text revision authority or the [incremental intake primitive](intake-state-storage.md).

## API and selected text

`reconcileSourceTextProjection(db, options?)` initializes the connection and reconciles dirty sources. `readSourceTextProjection(db, sourceId, options?)` also reconstructs and validates the selected source's exact string. A missing selected source fails explicitly. `sourceTextProjectionCounters(db)` exposes accumulated logical work, and `clearSourceTextProjectionCache(db)` clears connection readiness and its transaction observer. Internal callers managing their own database must clear it before disposal; application close, encrypted-profile lock and failed-open cleanup already do so.

Caller authorization and the existing exclusive profile lease remain application responsibilities; this internal API does not grant access to a locked profile.

Text is the raw stored string, without parsing and reserializing it. Whitespace, member order, duplicate-property spelling, escape spelling and non-BMP text remain exact. JSON parsing validates authority but does not normalize the returned bytes. Generic source kinds may contain any valid JSON; original intake sources require an intake object, and an included workflow must be an object; a present workflow format must be supported. Malformed or unsupported selected authority fails rather than becoming empty text. The [engine's scalar-safe text domain](text-piece-edits.md#explicit-edits-and-exact-results) still applies.

Five `__record_source_text_*` tables contain a format/profile binding, small source heads, shared immutable-content identities, source-scoped occurrence rows and source-scoped links. Each source head binds the profile, source ID, source hash and exact text digest to the engine's selected topology. Equal content can be shared across sources; it does not establish occurrence identity or source ownership. Source/profile/hash bindings and all selected pieces are checked before reuse. Profile/source identities, source-hash labels and source-kind labels must be nonempty text bounded to 1,024 UTF-8 bytes.

The namespace is excluded from accepted-record capture and portable authority export. Private copies rebuild target-bound projection rows from the target's own selected source authority; projection rows are never a reason to copy the source profile's authority binding. Missing or damaged derived data can be repaired without changing originals or accepted records.

## Transactions and recovery

Connection-scoped TEMP triggers track source inserts, updates and deletes, including identity changes, and affected derived rows. They create no persistent trigger dependency in a copied or rebuilt database. A cold connection checks current sources and retained references once. Warm reconciliation reads only dirty source text; unchanged sources do not require operational intake hydration. A selected warm read still validates and reconstructs that source's pieces, so it is not constant work.

Initialization, reconciliation, cleanup and the requested read run inside one savepoint. When invoked during an application transaction, the source update and derived changes commit or roll back together. An error rolls back the partial projection batch and rejects the outer application transaction even if its caller catches the error. Failed transaction outcomes, including exceptions after SQLite commit, invalidate readiness. The [source-search integration](source-details-search.md#mutation-and-recovery-boundary) makes ordinary intake writes and registration reconcile an already-used projection within their existing application transaction. Cold writers initialize and reconcile at the next read; initialized connections retain dirty tracking and next-read repair for direct SQL and outside-application-transaction producers. A cache API alone cannot certify a mutation that never called it; full authority activation remains open.

Malformed schema, stale or wrongly bound heads, missing content, cycles, dangling links and foreign occurrence identities cannot supply trusted text. Repair first validates the selected source authority. A stale accepted-record projection refuses until normal accepted-record recovery succeeds. This follows the existing durability lifecycle: warm reads compare the selected durable head with the attached projection; they do not reauthenticate every historical immutable object on each call. Recovery tests separately exercise absent, corrupt and unsupported selected durable evidence.

Cache reconstruction and automatic matching are separate paths. Invalid disposable evidence may be recreated from verified source text. Exhausted caller limits or an unresolved automatic reconciliation are errors; they never trigger a full-source replacement fallback. Rollback preserves the prior selected projection, and retry does not erase that distinction.

## Limits, cleanup and work accounting

Source text and retained pieces use the [explicit engine limits](text-piece-edits.md#limits), and discovery uses the [automatic matching limits](text-piece-reconciliation.md#work-limits-and-refusal). Options may lower those limits. Default-limit validation decides whether persisted derived evidence is usable; supplied limits apply to individual planning or requested reconstruction calls. They are not an aggregate budget across every dirty source or every validation in a public API call. SQL source bindings add bounded row overhead beyond the pure engine's row representation.

Content cleanup follows affected references through the content-reference index. Source deletion removes that source's references; shared content survives while another source refers to it. Reconciliation does not repeatedly sweep all content to remove a single source's stale rows. A cold connection also performs one explicitly counted retained-content inventory scan to find orphans left while TEMP tracking was absent. Schema/index repair and cold initialization have separate work from ordinary warm updates.

Counters separate authority text reads/bytes and hashing; loaded projection rows and serialized bytes; content, occurrence, link and head writes; deletion keys; affected-reference cleanup; and completed engine/matching work. Host read/write counters include work counted before a later rollback. Content-change TEMP triggers report reference rows visited on completed cache calls: an indexed count and the affected-source query each visit the matching references, so the counter charges both traversals. A failed interval can roll back its TEMP counts. Failed pure-engine calls return no partial metrics; their declared limits still apply. Engine logical string copies, reconstruction and hashing overlap by activity and must not be added as physical storage bytes. SQLite page allocation, planner/internal index steps, schema checks and TEMP tracking are separate from serialized row payloads.

The changed source still requires a complete raw authority read, JSON validation and digest. Its retained pieces are loaded, validated, matched and reconstructed. Small persisted changes do not establish computation proportional only to changed bytes. The complete production write path also still retains full source rows and accepted source versions; reducing that authority cost belongs to later activation and mutation qualification.

## Measured writes and host work

The [growth test](../../src/server/test/source-text-projection-growth.test.ts) begins with 10,097 UTF-8 bytes (10,094 UTF-16 units) of fictional raw JSON, including a periodic passage, Unicode and a literal escaped surrogate. It prepends one character inside a value for 300 actual application transactions. Each transaction updates current source authority and automatically reconciles its projection, followed by two exact warm reads and an unchanged reconciliation check. SQL audit triggers independently count actual inserted/updated row payloads and compare them with the public counters.

Initial text storage uses 3 content rows (10,355 encoded bytes), 3 occurrences (513 bytes), 3 links (318 bytes) and one 637-byte source head. The format-binding row and schema are separate from these text-data counters. Initial accepted publication writes 16,959 bytes in 3 writes. Total SQLite allocation after the first projected read is 413,696 bytes. Initialization plus that read reports 1 authority read, 16 projection rows/11,976 encoded bytes read, 41,492 engine-hashed bytes and 146,446 logically copied bytes.

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

Authority hashing processes the same number of bytes as the authority-read column. SQLite totals include source rows, accepted-history indexes and projection/index allocation; they are not projection-only writes or filesystem usage. Accepted retained objects, including the selected head, occupy 1,254,727/2,503,277/3,761,827 bytes at 100/200/300 updates. The page totals are one measured run on 2026-10-03, and can vary with SQLite and generated identities. They are evidence, not a capacity threshold.

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

[Exact source search](source-details-search.md) implements source-list count/page integration, native SQL LIKE parity, bounded request lifetime and separate query work accounting. [CRS-209](../todo/CRS-209.md) retains production intake activation; [CRS-210](../todo/CRS-210.md) retains actual mutation/recovery growth qualification. This storage API does not establish full import capacity, provider behavior, physical-device qualification or production readiness.
