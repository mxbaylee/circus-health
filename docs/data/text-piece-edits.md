# Exact text pieces and explicit edits

The pure TypeScript primitive in [`text-piece-edits.ts`](../../src/server/text-piece-edits.ts) plans small changes to retained exact text. Content and each occurrence/link are separate bounded rows; the selected head has fixed fields rather than an expanding list. A consumer can apply the returned individual changes in its own transaction. The primitive does not write SQL or create durable authority.

This supports the Records assembler's need to keep evidence exact as information changes. It operates on the exact serialized string supplied by the caller, preserving punctuation, whitespace, property order and escape spelling. It does not parse a document, change clinical meaning or authorize a record update. [Intake serialization](intake-state-storage.md#exact-serialization-domain) remains the authority contract.

## Rows and selected identity

Immutable content rows identify their UTF-8 bytes by hash. An occurrence identifies a particular use of a scalar-safe UTF-16 slice of that content, and its separate link identifies the next occurrence. Equal content can have multiple distinct occurrences. Content equality does not establish position or permit exchanging occurrences.

A selected snapshot contains its head and content, occurrence and link maps. Sequence IDs are lowercase UUIDv4 values; each occurrence uses that ID and a monotonically allocated safe-integer ordinal. The head binds the sequence identity and revision, exact text and selected occurrence topology. Its text digest hashes UTF-8 bytes; a separate streaming topology digest hashes each canonical occurrence/slice/next tuple in chain order, so swapping equal-text occurrences cannot pass the old head. Validation checks the retained inventory and selected chain before planning edits. Unrelated rows remain unchanged; splitting an occurrence retains its left identity and introduces a right slice of the same content. No global rechunking or rebalance occurs after a small edit.

Occurrence and link maps contain exactly the live selected chain; extra, missing, foreign or cyclic entries refuse. Unreferenced immutable content may remain in the content map. It is still counted, validated and hashed on every call; retaining it does not bypass inventory limits. The primitive does not garbage-collect content or preserve prior selected heads on behalf of a storage consumer.

## Explicit edits and exact results

`createTextPiecePlan` plans initial content and occurrence rows. `planTextPieceEdits` takes a retained snapshot, expected old head, sequential explicit edits and exact expected final string. `reconstructTextPieces` validates and reconstructs the selected string. Plans are transient individual writes/deletes plus a bounded head, not a row containing the whole text or occurrence list. Inputs use ordinary Maps, plain data rows and dense ordinary edit arrays; callers supply a coherent snapshot that remains unchanged during the call. A future storage consumer must compare the expected head and apply the complete plan in its own transaction; the pure planner cannot establish that transaction for it.

A splice replaces `deleteCount` UTF-16 units at `at` with `insert`. A move selects `length` units from `from` and inserts that range at `to`, where `to` refers to the string before removal. The planner refuses a destination strictly inside the moved range. Each edit addresses the result of the preceding edit. A move keeps the selected interior occurrences and links, changing only the cut/insert boundaries; it creates no content for unchanged text.

Each successful edit plan advances the head revision, including an empty or no-op edit list; supplied no-op edits count toward the operation limit and metrics. Sequential insertions can allocate content and ordinals that later edits remove from the selected chain. That immutable content remains in the returned writes and retained inventory, while occurrence/link changes describe the final chain. It is still bounded and counted; a caller seeking no-op suppression or content reclamation must supply that separate policy.

Offsets count JavaScript UTF-16 code units, while hashes and byte counters use UTF-8. Endpoints must lie between Unicode scalar values. Raw unpaired surrogates are unsupported and refused explicitly; a literal JSON escape such as `\ud800` is ordinary ASCII text and remains exact. Invalid input is never repaired by replacement characters or normalization.

Malformed rows, wrong sequence identities, missing or cyclic links, stale expected heads, mismatched expected results, unknown edits, unsafe offsets and exhausted limits fail explicitly. The caller's snapshot remains unchanged on failure. A failed edit does not fall back to a complete text replacement or a large replacement spanning unrelated distant edits.

## Limits

`TEXT_PIECE_LIMITS` exports the defaults. Options may lower them but cannot raise them. Limits interact: meeting the maximum text size alone does not guarantee that its pieces, retained inventory and complete validation fit the other budgets.

| Bound                                             |                                  Default |
| ------------------------------------------------- | ---------------------------------------: |
| New content payload                               |                4,096 UTF-8 bytes per row |
| Serialized row / head                             |                     32,768 / 1,024 bytes |
| Live occurrences / retained content rows          |                             100,000 each |
| Retained unique content                           |                                   64 MiB |
| Text                                              | 16,777,216 UTF-16 units and 32 MiB UTF-8 |
| Explicit operations per call                      |                                    1,000 |
| Changed plan, including deletion keys             |                                   64 MiB |
| Counted row/reference scan steps                  |                                2,000,000 |
| Scalar-validation / reconstruction units per call |    134,217,728 / 67,108,864 UTF-16 units |
| Hashed / logically copied bytes per call          |                             256 MiB each |
| Logically copied UTF-16 units per call            |                              134,217,728 |
| Existing-content inventory reads per call         |                                  128 MiB |

Encoded row bounds include JSON quoting and escaping, rather than treating payload size as serialized size. Text byte/unit limits apply to each sequential candidate, not just the final result; retained-content byte limits apply before adding each unique row. A single scalar that cannot fit a lowered content limit refuses explicitly. Revision and occurrence ordinals must remain safe integers; exhaustion does not wrap or reuse identities.

## Work and qualification boundary

Initial creation reads and chunks the complete input. An edit can write only a small number of bounded rows while still performing linear validation, reconstruction, comparison and hashing of retained text. These are different claims. Work measurements separate changed content and occurrence/link writes from retained reads, scans, reconstruction, hashing, string copies and row serialization. No timing target depends on a model's speed.

The independent exact-string and UTF-8 oracles in [`text-piece-edits.test.ts`](../../src/server/test/text-piece-edits.test.ts) cover prefix/middle and distant edits, periodic text, both move directions, maximum-piece and scalar boundaries, malformed evidence, and duplicate occurrences at 10/100/1,000 anchors. Explicit moves write no new content and retain moved interior occurrence/link rows. A seeded mixed-edit sequence checks reconstruction without deriving the expected result from engine pieces or hashes.

One measured fixture starts with 40,031 ASCII bytes and repeatedly prepends the same one-byte character. Initial publication plans 3 unique content rows (11,608 encoded bytes), 10 occurrence rows (1,470 bytes), 10 links (914 bytes) and a 368-byte head. Equal inserted bytes reuse one content row; this fixture is not evidence about automatic edit discovery or arbitrary mutation types. The following counts exclude initialization and accumulate actual explicit update plans:

| Updates | Content rows / bytes | Occurrence rows / bytes | Link rows / bytes | Head bytes |
| ------: | -------------------: | ----------------------: | ----------------: | ---------: |
|     100 |               1 / 84 |            100 / 14,510 |       100 / 9,718 |     37,024 |
|     200 |               1 / 84 |            200 / 29,110 |      200 / 19,618 |     74,424 |
|     300 |               1 / 84 |            300 / 43,710 |      300 / 29,518 |    111,824 |

Each update writes at most one content, occurrence and link row in this fixture. Their maximum encoded sizes are 84, 146 and 99 bytes; heads reach 374 bytes. Including initialization, the largest content row is 4,179 encoded bytes for its 4,096-byte payload. Tests independently total serialized returned rows rather than trusting only engine write counters.

| Updates | Existing content read bytes | Scan steps | Hash bytes | Logical copied bytes |
| ------: | --------------------------: | ---------: | ---------: | -------------------: |
|     100 |                   1,135,999 |     55,149 | 11,487,081 |           40,562,544 |
|     200 |                   2,271,999 |    200,299 | 26,917,781 |           91,470,894 |
|     300 |                   3,407,999 |    435,449 | 46,308,481 |          152,769,244 |

| Updates | Validation UTF-16 units | Reconstruction UTF-16 units | Exact comparison UTF-16 units |
| ------: | ----------------------: | --------------------------: | ----------------------------: |
|     100 |               5,144,449 |                   8,016,200 |                     4,008,150 |
|     200 |              10,298,899 |                  16,052,400 |                     8,026,300 |
|     300 |              15,463,349 |                  24,108,600 |                    12,054,450 |

Existing-content read counts describe complete retained inventory reads into working memory, including unreferenced content. Reuse of those in-memory values during reconstruction and hashing is counted under those separate operations. Logical copies charge slices, joins, row serialization and explicit UTF-8 buffer allocations regardless of V8's internal string representation. These counters overlap by activity and must not be added as physical storage bytes. They do not measure allocator overhead or prove changed-only computation: chain scans and topology hashing grow with occurrences, and multiple operations can repeat linear scans within one call. Initial fixture work separately includes 33 scan steps, 120,093 validation units, 40,031 reconstruction units, 81,986 hashed bytes and 310,023 logically copied bytes.

Deletion metrics separately count occurrence/link rows and the JSON-encoded UTF-8 bytes of each deletion key. They are included in the changed-plan budget; the prefix-growth table has no deletions. Counts describe logical plans, not SQLite allocation, accepted-record journaling or filesystem writes.

Explicit-edit success does not prove that the application can infer edits from two snapshots. [Automatic occurrence alignment and duplicate/move assignment](text-piece-reconciliation.md) are separately implemented and qualified; [disposable transactional storage](source-text-projection.md) is implemented separately, [exact source-search integration](source-details-search.md) is implemented, and original production authority uses the [selected intake envelope chain](intake-envelope-authority.md), and real mutation-growth qualification remains [CRS-210](../todo/CRS-210.md). Originals and accepted versions remain recovery authority. This primitive alone does not qualify installation capacity or large imports.

The 100/200/300 pure-planner measurements above qualify only the described fictional edit plans. They do not qualify actual batch/review/clinical-acceptance mutation growth, PR #35 or heavy imports.
