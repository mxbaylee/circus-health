# Automatic exact text reconciliation

[`reconcileTextPieces`](../../src/server/text-piece-reconcile.ts) derives a transient text-piece plan from a coherent retained snapshot and the next exact string. A Records assembler's small document update can preserve unrelated evidence without describing the edits to the app. The caller supplies text, not a parsed document or semantic edit instructions.

The result uses the [explicit text-piece engine](text-piece-edits.md): individual bounded content, occurrence and link changes plus a small selected head. It preserves exact punctuation, whitespace, property order and escape spelling. Equal content is not proof that two occurrences occupy the same place. The planner does not interpret clinical meaning, accept a record, call a model or write a database.

## Caller boundary

The API accepts `reconcileTextPieces(snapshot, nextExactText, options?)`. Options can provide an expected old head, lowered text-piece limits and lowered automatic-matching limits. The returned `TextPieceReconcilePlan` includes the ordinary individual changes and engine metrics, with separate `matchingMetrics` for automatic discovery. It is working memory for the caller's transaction, not a new durable authority.

The caller must keep the supplied snapshot coherent for the duration of the call, compare the returned expected head and apply the complete plan atomically. Snapshot reconstruction validates the retained head, content hashes, occurrence identities and selected link topology; planning validates the final exact string and UTF-8 bytes. Missing or inconsistent evidence, a stale expected head, unsupported text or exhausted work limits fail explicitly. A failed call leaves supplied evidence unchanged.

Offsets follow the existing engine's scalar-safe UTF-16 domain. Raw unpaired surrogates are refused; literal JSON escape spellings such as `\\ud800` remain ordinary exact text. Identical output still follows the engine's successful-plan revision policy; it does not authorize an extra accepted-record write or establish an application's no-op policy.

## Deterministic occurrence reuse

Matching starts from retained occurrence slices and exact context in the reconstructed old text. A whole-piece pattern is an anchor only when its bytes appear exactly once across the complete old text and exactly once in the next text; a single standalone occurrence is insufficient if that text also appears inside another piece. Exact, uniquely placed 16-unit context windows can also anchor moved blocks whose former piece boundaries crossed a changed neighbor. Hashes index candidates; full equality establishes a match. Hash collisions can remove an available context anchor, but cannot establish equality or position.

Complete retained rows take priority over shorter context windows. Deterministic patience alignment first selects a monotone, nonoverlapping complete-row chain. Other globally unique complete rows are also reserved when their next-text intervals do not conflict, including out-of-order moves. Chain rows win overlapping-next ambiguities; remaining candidates follow next-offset order, longer same-offset rows first, then old-offset order. This protects distinct whole passages that share letters when their order reverses.

Context windows may refine only the chain's corresponding gaps in both old and next coordinates; a window cannot displace an intact row merely because it starts earlier or has a smaller endpoint. Between anchors, matching keeps an equal suffix before an equal prefix, preserving a repeated prefix run's relationship to the following context. Bounded Myers alignment resolves the remaining local gap, preferring deletion before insertion on equal-cost paths. A gap with a fully reserved side needs no character alignment. Matches are trimmed to scalar-safe endpoints; complete-row reservations then remove competing character/window matches in both coordinate spaces.

Residual move reuse draws only from old ranges left unmatched after contextual alignment and complete-row reservations. Reuse visits next-text gaps in order, chooses the earliest remaining old scalar offset with an exact match, and extends it greedily within that available range. This is the deterministic policy for residual ambiguity; equal content is never globally assigned to positions before contextual matches. Already matched ranges cannot be stolen by another duplicate.

The translator removes unused old ranges in descending original-offset order, then derives moves and inserts. Deleting unused text first permits an equal-size replacement at the configured text limit without transiently growing past it. A pure move creates no content. Interior retained rows and links stay unchanged; the explicit engine's local boundary-splitting identity policy still applies. No fresh global chunking or balancing rewrites the retained middle.

## Work limits and refusal

`TEXT_PIECE_RECONCILE_LIMITS` exports automatic-matching defaults. Callers may only lower them. These are cumulative per call, independently of the existing engine limits:

| Matching activity                           |             Default cap |
| ------------------------------------------- | ----------------------: |
| Scanned UTF-16 units                        |             268,435,456 |
| Compared UTF-16 units                       |             134,217,728 |
| Alignment/reference steps                   |               8,388,608 |
| Allocated Myers trace cells                 |               4,194,304 |
| Anchor / reuse candidates                   |          2,000,000 each |
| Logically copied UTF-16 units / UTF-8 bytes | 33,554,432 / 67,108,864 |
| Hashed UTF-16 units                         |             268,435,456 |

Every hard work-cap exhaustion throws immediately. In addition, local Myers search stops after edit distance 256 and hands the unresolved alignment to exact retained-range reuse. If any gap still needs novel text after that handoff, the call refuses explicitly. For example, rearranging two 400-character runs can reuse them without new content; the same unresolved rearrangement with a new character refuses. This conservative algorithm boundary is not permission to substitute a giant replacement or whole snapshot. It is not a promise to reconcile every input that fits the raw text-size limits.

Matching scans old and new text, hashes context windows, sorts and aligns candidates, and may perform substantial repeated comparisons. Gap alignment depends on edit distance, and residual reuse can inspect many candidates. All of that work is capped and counted; small durable plans do not imply computation proportional only to the changed bytes. Pattern/context indexes and transient arrays are bounded by the occurrence, candidate, trace-cell and operation limits. Counts describe logical work rather than V8 allocation or physical disk bytes.

The ordinary `metrics` aggregate the initial snapshot reconstruction and the final explicit planner; the second call receives only the remaining engine work budget. `matchingMetrics` separately records automatic scans, comparisons, alignment/trace work, candidate visits, logical string copies and hashing, along with anchors, reused/matched units and derived operations. `matchedUtf16Units` includes reserved whole-row moves; `reusedUtf16Units` counts only residual unmatched-range reuse. Rolling hashes charge both outgoing and incoming units. Logical string copy counts include slices regardless of V8's representation; reference-array work is charged as alignment steps. Counters overlap by activity and must not be added together as physical storage consumption.

## Measured automatic updates

The independently fictional fixture in [the reconciliation tests](../../src/server/test/text-piece-reconcile.test.ts) starts with 40,031 ASCII bytes, then supplies the next exact string for 300 one-character prefix insertions. No edit intent is supplied. Initial creation plans 3 unique content rows (11,608 encoded bytes), 10 occurrences (1,470 bytes), 10 links (914 bytes) and a 368-byte head. Initial engine work includes 33 scan steps, 120,093 validation units, 40,031 reconstructed units, 81,986 hashed bytes and 310,023 logically copied bytes; initialization has no automatic matching work.

The following cumulative update counts exclude initialization. Tests independently serialize and total the returned changed rows, then compare those totals with the reported metrics:

| Updates | Content rows / bytes | Occurrence rows / bytes | Link rows / bytes | Head bytes |
| ------: | -------------------: | ----------------------: | ----------------: | ---------: |
|     100 |               1 / 84 |            100 / 14,510 |       100 / 9,718 |     37,024 |
|     200 |               1 / 84 |            200 / 29,110 |      200 / 19,618 |     74,424 |
|     300 |               1 / 84 |            300 / 43,710 |      300 / 29,518 |    111,824 |

Each update writes at most one content row (84 encoded bytes), one occurrence (146 bytes), one link (99 bytes) and a head of at most 374 bytes. The repeated inserted character shares one content row across all updates. Including initialization, the largest encoded content row is 4,179 bytes for a 4,096-byte payload. This fixture has no occurrence/link deletions; other operations count deleted rows and their encoded keys separately through the engine.

Initial reconstruction and final planning together report this engine work:

| Updates | Existing content read bytes | Scan steps | Hash bytes | Logical copied bytes |
| ------: | --------------------------: | ---------: | ---------: | -------------------: |
|     100 |                   2,271,998 |     73,398 | 17,788,762 |           58,674,468 |
|     200 |                   4,543,998 |    266,798 | 41,492,862 |          134,076,268 |
|     300 |                   6,815,998 |    580,198 | 71,136,962 |          226,278,068 |

| Updates | Validation UTF-16 units | Reconstruction UTF-16 units | Exact comparison UTF-16 units |
| ------: | ----------------------: | --------------------------: | ----------------------------: |
|     100 |               6,280,448 |                  12,024,250 |                     4,008,150 |
|     200 |              12,570,898 |                  24,078,500 |                     8,026,300 |
|     300 |              18,871,348 |                  36,162,750 |                    12,054,450 |

Automatic discovery additionally reports:

| Updates | Scanned UTF-16 units | Compared UTF-16 units | Hashed UTF-16 units | Alignment steps | Anchor candidates |
| ------: | -------------------: | --------------------: | ------------------: | --------------: | ----------------: |
|     100 |           20,114,615 |            16,348,503 |          36,229,779 |          27,062 |         4,003,367 |
|     200 |           40,199,165 |            32,737,003 |          72,389,429 |          64,512 |         8,006,867 |
|     300 |           60,333,715 |            49,165,503 |         108,639,079 |         111,962 |        12,010,367 |

| Updates | Logically copied units / bytes | Selected anchors | Matched UTF-16 units | Derived operations |
| ------: | -----------------------------: | ---------------: | -------------------: | -----------------: |
|     100 |          4,008,150 / 4,008,150 |              200 |            4,008,050 |                100 |
|     200 |          8,026,300 / 8,026,300 |              400 |            8,026,100 |                200 |
|     300 |        12,054,450 / 12,054,450 |              600 |           12,054,150 |                300 |

For this ASCII fixture, copied units equal copied bytes. It requires no Myers trace cells or residual reuse candidates/units; those paths have separate adversarial tests. All cumulative figures span independent bounded calls and may exceed a per-call cap. Growing chain scans and topology work are visible even while changed rows remain small. These figures establish logical plan locality for this fixture, not changed-only host computation, SQL allocation or arbitrary workload performance.

The tests independently check exact strings and UTF-8 bytes, retained identities and unaffected links. Coverage includes contextual duplicates at 10/100/1,000 anchors; the literal final-x move; 10,000/100,000-unit periodic middles with distant edits and shifted boundaries; moves/reorders in both directions; shared-prefix whole-row reversals; tiny changes around maximum-piece boundaries; punctuation, whitespace, literal escapes and non-BMP scalars; same-size replacements at exact text caps; malformed/stale/foreign evidence; and lowered matching and engine limits. A seeded 120-step sequence supplies string mutations without edit intent. Identity regressions distinguish embedded duplicate text from unique placement and prevent context windows from displacing intact rows.

## Integration and evidence boundary

Automatic reconciliation does not make its pieces durable or qualify the application's complete write path. Disposable transactional storage remains [CRS-219](../todo/CRS-219.md); source-search integration remains [CRS-220](../todo/CRS-220.md). Production activation and actual mutation/recovery growth qualification remain [CRS-209](../todo/CRS-209.md) and [CRS-210](../todo/CRS-210.md). Originals and accepted versions remain recovery authority. No SQL allocation, filesystem capacity, physical-device or large-import qualification is established by this pure planner.
