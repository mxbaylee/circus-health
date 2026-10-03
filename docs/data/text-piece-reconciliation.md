# Automatic exact text reconciliation

[`reconcileTextPieces`](../../src/server/text-piece-reconcile.ts) derives a transient text-piece plan from a coherent retained snapshot and the next exact string. A Records assembler's small document update can preserve unrelated evidence without describing the edits to the app. The caller supplies text, not a parsed document or semantic edit instructions.

The result uses the [explicit text-piece engine](text-piece-edits.md): individual bounded content, occurrence and link changes plus a small selected head. It preserves exact punctuation, whitespace, property order and escape spelling. Equal content is not proof that two occurrences occupy the same place. The planner does not interpret clinical meaning, accept a record, call a model or write a database.

## Caller boundary

The API accepts `reconcileTextPieces(snapshot, nextExactText, options?)`. Options can provide an expected old head, lowered text-piece limits and lowered automatic-matching limits. The returned `TextPieceReconcilePlan` includes the ordinary individual changes and engine metrics, with separate `matchingMetrics` for automatic discovery. It is working memory for the caller's transaction, not a new durable authority.

The caller must keep the supplied snapshot coherent for the duration of the call, compare the returned expected head and apply the complete plan atomically. Snapshot reconstruction validates the retained head, content hashes, occurrence identities and selected link topology; planning validates the final exact string and UTF-8 bytes. Missing or inconsistent evidence, a stale expected head, unsupported text or exhausted work limits fail explicitly. A failed call leaves supplied evidence unchanged.

Offsets follow the existing engine's scalar-safe UTF-16 domain. Raw unpaired surrogates are refused; literal JSON escape spellings such as `\\ud800` remain ordinary exact text. Identical output still follows the engine's successful-plan revision policy; it does not authorize an extra accepted-record write or establish an application's no-op policy.

## Deterministic occurrence reuse

Matching starts from retained occurrence slices and exact context in the reconstructed old text. A whole-piece pattern is an anchor only when its bytes appear exactly once across the complete old text and exactly once in the next text; a single standalone occurrence is insufficient if that text also appears inside another piece. Its lookup seed is the least frequent 16-unit window found inside that pattern in the old text (or the full shorter pattern). This avoids comparing many unrelated passages just because their suffixes coincide. Exact, uniquely placed 16-unit context windows can also anchor moved blocks whose former piece boundaries crossed a changed neighbor. Hashes index candidates; full equality establishes a match. Hash collisions can remove an available context anchor, but cannot establish equality or position.

Complete retained rows take priority over shorter context windows. Deterministic patience alignment first selects a monotone, nonoverlapping complete-row chain. Other globally unique complete rows are also reserved when their next-text intervals do not conflict, including out-of-order moves. Chain rows win overlapping-next ambiguities; remaining candidates follow next-offset order, longer same-offset rows first, then old-offset order. This protects distinct whole passages that share letters when their order reverses.

Unique context windows extend into maximal exact blocks before character alignment, stopping at reserved whole rows in both coordinate spaces. Seeds sharing one old-to-new offset skip expansion when an earlier expanded block already covers them. Longer blocks win conflicts, then next and old offsets break ties; a candidate must be disjoint from every reservation in both strings. These reservations include out-of-order moves. An intact row cannot be displaced by a shorter context coincidence. This matters for similar repeated passages: character edit distance alone can pair different passages and turn two moves into hundreds of tiny changes. Between the selected monotone anchors, matching keeps an equal suffix before an equal prefix. Bounded Myers alignment resolves remaining local gaps, preferring deletion before insertion on equal-cost paths. A gap with a fully reserved side needs no character alignment. Scalar-safe reservations remove competing character matches in both coordinate spaces.

Residual move reuse draws only from old ranges left unmatched after contextual alignment and reservations. Reuse visits next-text gaps in order and chooses the longest exact available block, with earliest old offset breaking ties. Candidates whose maximum possible length cannot beat that block need no character comparison. Equal content is never globally assigned before contextual matches; reserved and consumed ranges cannot be stolen by another duplicate.

After that inventory proves the novel scalar deficit, short residual matches of at most 32 UTF-16 units may be coalesced into literal inserts. Additional literal units cannot exceed twice the proved novel units, so total emitted text is at most three times that deficit. Intact/contextual/Myers matches are excluded, and a pure move has zero allowance. This fixed bound avoids hundreds of punctuation-sized moves when genuinely new proposal evidence is added without permitting a growing unchanged-history replacement. It is a UTF-16 content bound; UTF-8 encoding and individual row/reference overhead are measured separately. The planner does not promise globally minimal inserted content or operations.

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

Every hard work-cap exhaustion throws immediately. Local Myers search stops after edit distance 256 and hands unresolved alignment to exact retained-range reuse. Its complete inventory includes every scalar start in the disjoint unreserved old ranges. Only after exhausting all available exact candidates can it classify a scalar as novel; reserved or consumed occurrences cannot supply it twice. The separately bounded coalescing allowance above may add short reused fragments to literal inserts. Rearranging two 400-character runs and appending a new character retains both runs and writes only that character. This is not a whole-snapshot fallback or a promise to reconcile every input within raw text-size limits. Reference fragmentation and all comparisons still consume the unchanged budgets.

Matching scans old and new text, hashes context windows, sorts and aligns candidates, and may perform substantial repeated comparisons. Gap alignment depends on edit distance, and residual reuse can inspect many candidates. All of that work is capped and counted; small durable plans do not imply computation proportional only to the changed bytes. Pattern/context indexes and transient arrays are bounded by the occurrence, candidate, trace-cell and operation limits. Counts describe logical work rather than V8 allocation or physical disk bytes.

The ordinary `metrics` aggregate the initial snapshot reconstruction and the final explicit planner; the second call receives only the remaining engine work budget. `matchingMetrics` separately records automatic scans, comparisons, alignment/trace work, candidate visits, logical string copies and hashing, along with anchors, reused/matched units and derived operations. `matchedUtf16Units` includes reserved whole-row and context-block moves; `reusedUtf16Units` counts residual reuse. `novelUtf16Units` counts scalars proved novel after inventory exhaustion; `literalizedReuseUtf16Units` counts the separately bounded reused units emitted as literals, and `reusedUtf16Units` excludes them. `localAlignmentHandoffs` counts local Myers handoffs. Rolling hashes charge both outgoing and incoming units; seed-frequency inventory, block expansion and reservation ordering also consume the existing budgets. Logical string copy counts include slices regardless of V8's representation; reference-array work is charged as alignment steps. Counters overlap by activity and must not be added together as physical storage consumption.

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
|     100 |           24,435,965 |            12,822,233 |          44,873,879 |          44,682 |             9,931 |
|     200 |           48,851,865 |            25,676,383 |          89,697,629 |         100,232 |            20,131 |
|     300 |           73,327,765 |            38,560,533 |         134,631,379 |         165,782 |            30,331 |

| Updates | Logically copied units / bytes | Selected anchors | Matched UTF-16 units | Derived operations |
| ------: | -----------------------------: | ---------------: | -------------------: | -----------------: |
|     100 |          4,008,150 / 4,008,150 |              200 |            4,008,050 |                100 |
|     200 |          8,026,300 / 8,026,300 |              400 |            8,026,100 |                200 |
|     300 |        12,054,450 / 12,054,450 |              600 |           12,054,150 |                300 |

For this ASCII fixture, copied units equal copied bytes. It requires no Myers trace cells or residual reuse candidates/units; those paths have separate adversarial tests. All cumulative figures span independent bounded calls and may exceed a per-call cap. Growing chain scans and topology work are visible even while changed rows remain small. These figures establish logical plan locality for this fixture, not changed-only host computation, SQL allocation or arbitrary workload performance.

The tests independently check exact strings and UTF-8 bytes, retained identities and unaffected links. Coverage includes contextual duplicates at 10/100/1,000 anchors; the literal final-x move; periodic middles of 10,000/100,000 `ab` repeats (20,000/200,000 UTF-16 units) with distant edits and shifted boundaries; moves/reorders in both directions; shared-prefix whole-row reversals; tiny changes around maximum-piece boundaries; punctuation, whitespace, literal escapes and non-BMP scalars; same-size replacements at exact text caps; malformed/stale/foreign evidence; and lowered matching and engine limits. A seeded 120-step sequence supplies string mutations without edit intent. Identity regressions distinguish embedded duplicate text from unique placement and prevent context windows from displacing intact rows.

## Integration and evidence boundary

Automatic reconciliation does not make its pieces durable or qualify the application's complete write path. [Disposable transactional storage](source-text-projection.md) and [exact source-search integration](source-details-search.md) are implemented. Original production authority uses the [selected intake envelope chain](intake-envelope-authority.md); [application mutation/recovery qualification](intake-mutation-qualification.md) measures the combined path separately. Originals and accepted versions remain recovery authority. No SQL allocation, filesystem capacity, physical-device or large-import qualification is established by this pure planner.

The 100/200/300 pure-planner measurements above qualify only the described fictional edit plans. They do not qualify actual batch/review/clinical-acceptance mutation growth, PR #35 or heavy imports.
