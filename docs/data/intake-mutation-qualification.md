# Intake mutation and recovery qualification

These independently fictional checks exercise the application APIs used to prepare, review and accept evidence. They support the High-precision tracker's [history-building job](../design/personas.md#build-a-history): earlier records, review choices and original files must remain correct as more work arrives. They distinguish changed evidence, retained history, rebuildable projections and the host work needed to produce a complete view.

The implemented authority is the [selected intake envelope](intake-envelope-authority.md), backed by the accepted-record journal. Original files and accepted versions remain recovery authority. The [v3 codec](intake-state-storage.md) retains exact ordered JSON and encodes changed array elements, moves and distant string edits. Unsupported older authority refuses explicitly; there is no migration, reset, history pruning or runtime-capacity increase.

The current [verified-work reuse contract](intake-processing-work.md) describes immutable materializations, proposal classification and derived projection reuse, together with their qualification. The tables below retain the explicitly dated earlier measurements; they are historical evidence of the costs that motivated those changes, not measurements of the current implementation.

## Accounting boundaries

The [growth harness](../../src/server/test/intake-mutation-growth.test.ts) uses actual original upload/extraction, durable passage reads, batch proposals, review drafts and reviewed clinical acceptance. Every proposal includes a complete fictional clinical observation plus administrative source material. Clinical assertions use independent literal expectations, including `< 0.030`, `+004.500`, `7.20` and `−0.125`, with exact unit, month precision and person scope. It never substitutes an empty clinical payload or uses model output as its acceptance oracle. All provider behavior is fictional; no inference is purchased.

The ordinary growth fixture's `RecordStorage` implements immutable-object and selected-head semantics in memory, with physical original and proposal files. Its counters establish logical accepted bytes and copies, not filesystem crash durability or disk-sector traffic. The separate recovery matrix uses the actual contributor filesystem journal, physical original verifier and newly opened backend instances. The encrypted private-copy test uses the actual encrypted lifecycle.

Routine server CI runs seven real proposal/draft cycles with four clinical acceptances, pending review, reopening, cache loss and a subsequent draft change. The dedicated growth qualification retains 300 additional cycles after its initial accepted record, with clinical acceptance and independent complete-state checks at each 100-cycle checkpoint. Both modes share the same fixture and exact oracle; a passing small test is not a completed 300-cycle receipt. Run the dedicated check explicitly from the repository:

```sh
CRS_INTAKE_MUTATION_QUALIFY=1 node --test --test-name-pattern='qualification:' src/server/test/intake-mutation-growth.test.ts
```

Its separate two-hour host hang guard only prevents an abandoned qualification process. It does not change application capacity or model limits, establish an acceptable completion time, or qualify foreground responsiveness. Normal CI retains its existing host watchdog. Checkpoint files are saved to a unique temporary artifact directory as each oracle passes; a stopped trial retains partial evidence and must not be reported as a full success. Counter snapshots are detached when captured, including nested text metrics, and the fixture checks that later work cannot change earlier checkpoint measurements. Separate pre-small and post-API files preserve the small-operation baseline before subsequent parity work.

An earlier full attempt passed checkpoints 100 and 200 and published all 301 proposals, then failed in text projection while handling the fourth clinical acceptance: repeated text-piece boundary walks exhausted the unchanged two-million-step scan budget. That attempt is failed evidence, not a completed 300-cycle receipt. The explicit planner now reuses validated boundary indexes; the captured 121-edit case passes with 1,636,431 combined reconstruction/planning scan steps. Independent comparison of 300 mixed Unicode edit sequences preserves exact planned rows, identities and refusal behavior. Initial/setup, each completed checkpoint and all-phase failure context are retained outside Git; the final report separates the small save API from subsequent consumer/search parity.

The maintained test files emit portable JSON diagnostics and write raw qualification artifacts to unique temporary directories outside Git. Their measurements include:

| Representation or work | What is counted                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted journal       | Every immutable segment and commit, head publication, object count, buffer copy and read, with initial/open/reconstruction intervals separated                                                                                                                               |
| Intake authority       | Contribution frames, heads and operation receipts; every production-created primitive handle; replayed versions/operations and evidence reads                                                                                                                                |
| SQLite                 | Every persistent table's row count, stored value bytes and separately serialized row bytes; page count/size/free pages; temporary audit triggers count inserts/updates/deletes and old/new stored value bytes; the dated singleton replacement correction is explained below |
| History and results    | Contents, metadata and field references; transaction-result total and largest size; source metadata and all `app_meta` authority categories                                                                                                                                  |
| Derived lookup/search  | Individual content, occurrence, link and head writes/deletes; lookup rows; source reads and bytes; search evaluations, reconstruction and selected DTO envelopes                                                                                                             |
| Host envelope work     | Validation nodes and string units, clone nodes/bytes, serialization/parse calls and bytes, diff nodes/comparisons/alignment/trace cells, array matching, hashes and hydration                                                                                                |
| Physical source files  | Retained original/proposal count and bytes, independently verified file hashes; actual API read/write payloads, streaming reads/hashes, verification cache hits, fsync and publication calls                                                                                 |

`intakeWorkCounters(db)` retains numeric totals for the connection, including rolled-back attempts and internally created primitive handles. Warm and reconstruction scopes are separate; cache clearing does not erase earlier counted work. `sourceDTOEnvelopeBytes` measures complete reconstructed original envelopes. `sourceDetailsSearchCounters().dtoDetailsBytes` measures returned source-row details, including compact original markers and proposal details, and must not be presented as full original-envelope bytes. These counters cover different populations, not a same-row compression ratio.

`withIntakeFileWork` is an optional async-scoped numeric collector. Buffer and text hash counts are distinct; text hashing also includes semantic fingerprints, not only physical files. A failed write can have unknown partial bytes: attempts and failures are reported, while successful payload bytes do not claim to cover the failed portion. Cross-device copy requests are counted as requested bytes, separately from successful direct writes. The collector stores no paths, identities or values and introduces no extra filesystem reads for accounting.

These are logical work and API payload measurements. Activities overlap and cannot be summed into physical disk traffic or total CPU instructions. JavaScript runtime allocation, SQLite VM/index internals, HTTP receiver/response serialization, extraction-worker and encrypted-vault internals are not comprehensively instrumented. The dated measurements below also omit accepted-record internal encoding, hashing, parsing, validation and temporary rebuild-connection processing. The current harness separately observes those accepted-record operations across all connections through `withRecordVersionWork`; see its [scope and limitations](intake-processing-work.md#accounting-and-qualification-limits). Those new counters cannot be treated as zero in older receipts. Intake reconstruction counters continue to describe the final connection, while accepted storage I/O and the new record observer span the complete operation. Initial creation, one-time raw normalization, opening, cold reconstruction and ordinary mutations have separate evidence; a small changed write does not imply changed-only host computation.

## Real application growth

Measured on 2026-10-03 using the fictional fixture at [858f0f6](https://github.com/mxbaylee/circus-health/tree/858f0f6edb70da69ac882a170004adc2e20cc438): one initial cycle plus 300 subsequent batch/proposal and review-draft cycles, with four actual clinical acceptances. All 301 proposals, 297 pending candidates and the exact four accepted clinical values survive reopening and complete cache loss. Checkpoint totals below include initial creation and the checkpoint consumer/search parity requests. They are logical counts, not elapsed-time targets or physical disk traffic.

| Measure                                                 | Initial accepted cycle |           After 100 |              After 200 |               After 300 |
| ------------------------------------------------------- | ---------------------: | ------------------: | ---------------------: | ----------------------: |
| Immutable segments / commits                            |                11 / 11 |           212 / 212 |              413 / 413 |               614 / 614 |
| Retained accepted objects / bytes (including one head)  |           23 / 163,685 |     425 / 2,651,448 |        827 / 5,148,708 |       1,229 / 7,644,261 |
| Cumulative immutable written bytes / head-written bytes |        163,540 / 1,586 |  2,651,303 / 30,531 |     5,148,563 / 59,476 |      7,644,116 / 88,421 |
| Accepted immutable reads / bytes                        |           33 / 318,438 |     636 / 5,178,142 |     1,239 / 10,056,663 |      1,842 / 14,931,770 |
| Accepted head reads / bytes                             |           308 / 44,435 |  10,335 / 1,489,211 |     21,569 / 3,109,002 |      33,707 / 4,859,873 |
| Accepted buffer-copy bytes                              |                527,999 |           9,349,187 |             18,373,704 |              27,524,180 |
| Intake contribution rows / bytes                        |             6 / 28,656 |     208 / 1,199,204 |        410 / 2,376,606 |         612 / 3,552,148 |
| Intake operation receipts / bytes                       |              6 / 1,794 |        208 / 62,500 |          410 / 123,302 |           612 / 184,104 |
| Selected intake head bytes (one row)                    |                    466 |                 480 |                    481 |                     482 |
| Transaction results: rows / total bytes / largest bytes |     11 / 2,335 / 1,262 | 212 / 4,403 / 1,268 |    413 / 6,471 / 1,268 |     614 / 8,539 / 1,268 |
| All SQLite stored-value bytes                           |                395,393 |           6,808,236 |             13,254,172 |              19,669,383 |
| All SQLite serialized-row bytes                         |                508,570 |           8,336,876 |             16,201,629 |              24,028,285 |
| SQLite allocation / free bytes                          |          1,048,576 / 0 |      11,825,152 / 0 |         22,736,896 / 0 |          33,611,776 / 0 |
| Physical originals and proposals: files / bytes         |             2 / 31,305 |       102 / 144,225 |          202 / 257,569 |           302 / 370,921 |
| API whole-file reads / bytes                            |           10 / 127,472 |       315 / 529,998 |    37,358 / 42,479,080 |   114,418 / 129,749,364 |
| API stream-read bytes / stream-hash bytes               |      120,716 / 120,716 |   120,716 / 120,716 |      120,716 / 120,716 |       120,716 / 120,716 |
| API buffer-hash bytes / text-hash bytes                 |       159,903 / 28,774 | 788,269 / 2,255,534 | 42,964,039 / 5,466,502 | 130,461,027 / 9,656,030 |
| Physical file publications / fsync calls                |                  2 / 4 |           102 / 204 |              202 / 404 |               302 / 604 |

Physical writes exactly equal the retained original/proposal inventory: each file is published once, with no rewritten original. The original is 30,179 bytes; proposal counts are 1/101/201/301. Intake-frame and receipt totals are a subset of accepted history and `app_meta`, not additional independent bytes to sum. SQL stored values, serialized rows and allocated pages are different representations. The following retained inventory includes every persistent table, including zero-row tables in the other-application group; TEMP measurement/oracle tables are excluded.

| Measure                                      | Initial accepted cycle |         After 100 |          After 200 |          After 300 |
| -------------------------------------------- | ---------------------: | ----------------: | -----------------: | -----------------: |
| `__record_current` rows / stored bytes       |             63 / 9,207 |      573 / 92,383 |    1,083 / 175,559 |    1,593 / 258,735 |
| `__record_fields` rows / stored bytes        |           498 / 87,217 |   5,358 / 924,274 | 10,218 / 1,763,355 | 15,078 / 2,602,436 |
| Lookup projection rows / stored bytes        |              6 / 2,410 |      208 / 20,503 |       410 / 38,901 |       612 / 57,299 |
| Search projection rows / stored bytes        |            18 / 19,765 | 2,946 / 1,191,511 |  5,968 / 2,376,351 |  8,818 / 3,533,976 |
| `__record_state` rows / stored bytes         |                1 / 166 |           1 / 167 |            1 / 167 |            1 / 167 |
| `__record_transactions` rows / stored bytes  |            11 / 11,631 |     212 / 137,135 |      413 / 262,904 |      614 / 388,673 |
| `__record_versions` rows / stored bytes      |           95 / 174,443 | 1,410 / 2,814,446 |  2,725 / 5,464,341 |  4,040 / 8,112,529 |
| `app_meta` rows / stored bytes               |            45 / 74,780 |   449 / 1,356,553 |    853 / 2,645,258 |  1,257 / 3,932,103 |
| Other application/schema rows / stored bytes |            17 / 12,439 |       23 / 21,825 |        29 / 31,153 |        35 / 40,530 |
| `source_files` rows / stored bytes           |              2 / 3,335 |     102 / 249,439 |      202 / 496,183 |      302 / 742,935 |

### Host and derived work

These cumulative warm counters expose repeated full-view processing; they do not establish changed-only CPU cost. Some count overlapping views of the same work. Full original DTO envelope bytes and returned source-row details bytes cover different populations: the latter includes compact original markers and proposal details. They are not a same-row compression ratio. Pure text-engine and matching counters include completed calls only; refused calls do not return metrics. Initial matching totals are zero because no matching call completed in that initial phase.

| Measure                                                        | Initial accepted cycle |                     After 100 |                     After 200 |                       After 300 |
| -------------------------------------------------------------- | ---------------------: | ----------------------------: | ----------------------------: | ------------------------------: |
| Primitive read-copy bytes                                      |                592,267 |                   840,550,487 |                 3,278,651,289 |                   7,317,795,119 |
| Primitive candidate-copy bytes                                 |                 33,183 |                    57,619,393 |                   225,196,107 |                     502,963,853 |
| Validation nodes / cloned nodes                                |        24,667 / 24,667 |       21,874,534 / 21,874,534 |       84,583,982 / 84,583,982 |       188,149,488 / 188,149,488 |
| Serialized bytes / parsed bytes                                |    1,173,966 / 288,431 |   1,371,818,848 / 180,443,258 |   5,330,584,007 / 690,607,941 |  11,882,112,184 / 1,531,349,395 |
| Hydrated envelopes / envelope serialization bytes              |          100 / 732,682 |         3,035 / 1,072,666,920 |         5,970 / 4,182,712,440 |           8,905 / 9,334,565,164 |
| Diff node visits / array-match serialized bytes                |        1,117 / 257,926 |       1,242,430 / 221,165,748 |       4,814,619 / 846,880,926 |      10,717,484 / 1,878,323,034 |
| Host hashed bytes                                              |                188,459 |                   119,872,232 |                   459,553,173 |                   1,019,612,955 |
| Full original DTO envelope / returned source-row details bytes |         42,666 / 3,106 |           1,715,148 / 200,316 |           5,024,130 / 592,270 |           9,969,660 / 1,178,976 |
| Lookup authority reads / bytes                                 |             6 / 47,752 |              308 / 58,371,338 |             610 / 226,688,296 |               912 / 505,196,310 |
| Lookup projection rows read / bytes                            |              7 / 2,833 |              11,015 / 815,800 |            42,627 / 2,681,367 |              94,843 / 5,618,241 |
| Text authority reads / bytes                                   |             2 / 16,158 |              304 / 58,339,744 |             606 / 226,656,702 |               908 / 505,164,716 |
| Text projection rows read / bytes                              |          146 / 171,322 |         293,829 / 103,884,396 |       1,114,537 / 395,622,740 |         2,490,048 / 877,509,157 |
| Search query projection rows read / bytes                      |          136 / 170,520 |            23,696 / 9,932,744 |           78,199 / 32,434,963 |            158,352 / 65,628,270 |
| Search reconstructed bytes                                     |                129,264 |                     6,157,536 |                    19,990,380 |                      40,485,876 |
| Text engine existing-content read bytes                        |                129,264 |                   181,847,680 |                   701,458,408 |                   1,558,398,784 |
| Lookup projection writes / bytes                               |              9 / 5,799 |                 413 / 190,086 |                 817 / 375,622 |                 1,221 / 561,259 |
| Search projection writes / bytes                               |            17 / 22,179 |            12,777 / 3,187,573 |            25,665 / 6,379,956 |              38,285 / 9,551,732 |
| Search content writes / bytes                                  |             5 / 18,105 |             2,074 / 1,006,791 |             4,162 / 1,994,726 |               6,076 / 2,968,070 |
| Search occurrence writes / bytes                               |              5 / 1,172 |               2,199 / 515,621 |             4,426 / 1,038,802 |               6,628 / 1,556,025 |
| Search link writes / bytes                                     |                5 / 835 |               4,653 / 855,352 |             9,362 / 1,724,017 |              14,066 / 2,591,747 |
| Search head writes / bytes                                     |              2 / 2,067 |                 304 / 347,799 |                 606 / 694,989 |                 908 / 1,042,640 |
| Search projection deletions / bytes                            |                  0 / 0 |               3,547 / 462,010 |               7,109 / 927,422 |              10,607 / 1,393,250 |
| Text matching scanned / hashed UTF-16 units                    |                  0 / 0 | 1,215,730,053 / 2,374,146,237 | 4,754,431,089 / 9,286,810,054 | 11,441,276,401 / 22,388,140,621 |
| Text matching alignment steps                                  |                      0 |                   228,525,007 |                   923,658,709 |                   2,118,974,101 |

The source-context classification cache at that revision retained 128 proposal classifications. Larger sequential rescans evicted entries before reuse and repeatedly read/hashed the same proposal carriers; the 100/200/300 counts above expose that behavior. Current [collection-scoped positive/negative classification reuse](intake-processing-work.md#proposal-classification-beyond-a-small-cache) addresses that churn without increasing a fixed cache cap, omitting sources or pruning history.

### Complete SQL mutation audit

The following cumulative insert/update/delete counts and new/old stored-value bytes cover every persistent table from immediately after the initial accepted cycle through each checkpoint. A changed row contributes its entire stored row size to the audit; these are logical SQL values, not WAL or disk bytes. Derived tables can update and delete replaceable cache rows while accepted history remains retained. Initial creation is excluded from these mutation intervals and is included in the retained inventories above.

The displaced-row deletion counts and old bytes for `__record_state` are independently derived from the saved inventories and directly observed inserts. SQLite with `recursive_triggers=0` omitted the implicit deletes from its `INSERT OR REPLACE` operation; the raw audit retains those original zero fields. At the qualified revision, this table has one checked singleton row (`singleton=1`), one runtime replacement writer, and no observed updates or explicit deletes in these intervals. Thus displaced rows equal observed inserts, and displaced old bytes equal starting stored bytes plus inserted new bytes minus ending stored bytes. This gives 201/33,278, 402/66,645 and 603/100,012 displaced rows/bytes. All other table totals are directly audited. The corrected fixture now tracks that singleton through actual SQL events and separately checks replacement, ignored inserts, updates, deletion and rollback without changing production trigger settings.

| Measure                                       |                                      100 |                                       200 |                                        300 |
| --------------------------------------------- | ---------------------------------------: | ----------------------------------------: | -----------------------------------------: |
| `__record_current` I/U/D; new/old bytes       |              510/805/0; 150,234 / 67,058 |          1,020/1,610/0; 300,468 / 134,116 |           1,530/2,415/0; 450,702 / 201,174 |
| `__record_fields` I/U/D; new/old bytes        |                   4,860/0/0; 837,057 / 0 |                  9,720/0/0; 1,676,138 / 0 |                  14,580/0/0; 2,515,219 / 0 |
| Lookup projection I/U/D; new/old bytes        |             202/202/0; 148,994 / 130,901 |              404/404/0; 299,237 / 262,746 |               606/606/0; 449,581 / 394,692 |
| Search projection I/U/D; new/old bytes        | 6,475/2,738/3,547; 2,255,418 / 1,083,672 | 13,059/5,480/7,109; 4,530,552 / 2,173,966 | 19,407/8,254/10,607; 6,789,539 / 3,275,328 |
| `__record_state` I/U/D; new/old bytes         |               201/0/201; 33,279 / 33,278 |                402/0/402; 66,646 / 66,645 |               603/0/603; 100,013 / 100,012 |
| `__record_transactions` I/U/D; new/old bytes  |                     201/0/0; 125,504 / 0 |                      402/0/0; 251,273 / 0 |                       603/0/0; 377,042 / 0 |
| `__record_versions` I/U/D; new/old bytes      |                 1,315/0/0; 2,640,003 / 0 |                  2,630/0/0; 5,289,898 / 0 |                   3,945/0/0; 7,938,086 / 0 |
| `app_meta` I/U/D; new/old bytes               |         404/1,006/0; 1,411,819 / 130,046 |          808/2,012/0; 2,831,880 / 261,402 |         1,212/3,018/0; 4,250,182 / 392,859 |
| Other application/schema I/U/D; new/old bytes |                    6/2/0; 13,767 / 4,381 |                    12/4/0; 27,482 / 8,768 |                    18/6/0; 41,246 / 13,155 |
| `source_files` I/U/D; new/old bytes           |                     100/0/0; 246,104 / 0 |                      200/0/0; 492,848 / 0 |                       300/0/0; 739,600 / 0 |

### Setup, opening and reconstruction

The setup figures below are incremental phases before the initial proposal/acceptance, not repeated costs for each subsequent mutation. Registration writes the fictional original once; source capture includes extraction and initial evidence publication. The main fixture registers normalized authority and performs zero raw conversions. The separate locality fixture below measures raw normalization.

| Measure                                         | Attach record backend | Register original |    Capture source | Plan and read source |
| ----------------------------------------------- | --------------------: | ----------------: | ----------------: | -------------------: |
| Accepted immutable / head written bytes         |           5,974 / 144 |      11,261 / 144 |      77,720 / 721 |          8,038 / 144 |
| Accepted read bytes / copied bytes              |       11,808 / 17,926 |   22,962 / 34,367 | 159,740 / 238,181 |      21,157 / 29,339 |
| Host warm serialized / hashed bytes             |                 0 / 0 |    12,955 / 8,517 |    62,605 / 7,524 |      77,894 / 18,092 |
| Physical source written / whole-file read bytes |                 0 / 0 |        30,179 / 0 |             0 / 0 |           0 / 60,358 |
| Physical stream-read / stream-hash bytes        |                 0 / 0 |             0 / 0 | 120,716 / 120,716 |                0 / 0 |

Opening and complete cache-loss rebuild intervals include their subsequent exact consumer/search parity checks. Accepted storage I/O spans each complete interval. Host counters cover intake work on the final database connection only: temporary rebuild-connection work and accepted-record internal replay processing are not comprehensively counted. Zero immutable reads during an ordinary open can coexist with intake replay from retained SQLite evidence; it does not mean no history was read.

| Measure                                              |      Open existing cache | Rebuild after total cache loss |
| ---------------------------------------------------- | -----------------------: | -----------------------------: |
| Accepted immutable reads / bytes                     |                    0 / 0 |             3,070 / 29,507,078 |
| Accepted head reads / bytes                          |          2,958 / 428,910 |                2,963 / 429,635 |
| Accepted immutable / head writes                     |                    0 / 0 |                          0 / 0 |
| Accepted copied bytes                                |                  428,910 |                     29,936,713 |
| Intake cold reconstructions / ancestor reads         |                  1 / 612 |                        1 / 612 |
| Reconstruction frame reads / bytes                   |          612 / 3,552,148 |                612 / 3,552,148 |
| Reconstruction receipt reads / bytes                 |            612 / 184,104 |                  612 / 184,104 |
| Replayed intake versions / operations                |              612 / 8,105 |                    612 / 8,105 |
| Reconstruction serialized / parsed bytes             |  504,612,729 / 6,079,119 |        504,612,729 / 6,079,119 |
| Reconstruction hashed / evidence-buffer copied bytes | 510,507,576 / 15,450,587 |       510,507,576 / 15,450,587 |
| Subsequent warm serialized / parsed bytes            |   23,097,426 / 4,964,714 |         23,097,426 / 4,964,714 |
| Primitive read-copy bytes                            |               13,188,080 |                     13,188,080 |
| Physical whole-file reads / bytes                    |            604 / 741,842 |                  604 / 741,842 |
| Physical source writes / bytes                       |                    0 / 0 |                          0 / 0 |

### One small decision after growth

After reopening and rebuilding, one already pending proposal changes to “review later”. The first column measures only the actual save-draft API after its independent review has been prepared. The second includes the same save plus the subsequent complete-state, source, DTO and search parity checks. Neither column includes the preceding review preparation, open or rebuild. All earlier immutable accepted objects and physical originals/proposals remain unchanged.

| Measure                                                        |          Save API only |       Save plus parity |
| -------------------------------------------------------------- | ---------------------: | ---------------------: |
| Accepted immutable objects written / bytes                     |              2 / 7,186 |              2 / 7,186 |
| Accepted head publications / bytes                             |                1 / 144 |                1 / 144 |
| Accepted immutable reads / bytes                               |             3 / 13,801 |             3 / 13,801 |
| Accepted head reads / bytes                                    |             41 / 5,942 |        2,990 / 430,598 |
| Accepted copied bytes                                          |                 27,073 |                451,729 |
| Intake frames / frame bytes                                    |              1 / 2,355 |              1 / 2,355 |
| New operation receipts / stored bytes                          |                1 / 301 |                1 / 301 |
| Transaction-result rows / bytes                                |                  1 / 4 |                  1 / 4 |
| Primitive read-copy / candidate-copy bytes                     | 21,431,617 / 1,648,510 | 34,627,593 / 1,648,510 |
| Validation nodes / cloned nodes                                |      560,356 / 560,356 |      840,716 / 840,716 |
| Host serialized / parsed bytes                                 | 36,309,245 / 4,976,280 | 52,819,965 / 6,641,473 |
| Host hashed bytes                                              |              3,309,322 |              3,312,886 |
| Hydrated envelopes / envelope serialized bytes                 |        13 / 28,028,618 |        21 / 42,874,091 |
| Diff visits / array-match serialized bytes                     |     35,017 / 5,897,585 |     35,017 / 5,897,585 |
| Full original DTO envelope / returned source-row details bytes |                  0 / 0 |    4,948,491 / 586,706 |
| Lookup authority reads / bytes                                 |          1 / 1,649,497 |          1 / 1,649,497 |
| Lookup projection rows read / bytes                            |           310 / 17,921 |           310 / 17,921 |
| Text authority reads / bytes                                   |          1 / 1,649,497 |          1 / 1,649,497 |
| Text projection rows read / bytes                              |      1,222 / 1,933,922 |    23,883 / 28,665,652 |
| Search query projection rows read / bytes                      |                  0 / 0 |    22,661 / 26,731,730 |
| Search reconstructed bytes                                     |                      0 |             20,504,379 |
| Text engine existing-content read bytes                        |              4,945,530 |             25,449,918 |
| Lookup writes / bytes                                          |                1 / 770 |                1 / 770 |
| Search writes / bytes                                          |             22 / 6,460 |             22 / 6,460 |
| Search content writes / bytes                                  |              3 / 1,323 |              3 / 1,323 |
| Search occurrence / link writes                                |                  9 / 9 |                  9 / 9 |
| Physical whole-file reads / bytes                              |          302 / 341,878 |        906 / 1,083,720 |
| Physical source writes / bytes                                 |                  0 / 0 |                  0 / 0 |

The complete persistent SQL audit for that save follows. Tables with no mutations are omitted; no unlisted table changes. Counts include inserted history/field/receipt values as well as derived projection maintenance. The state-row displaced deletion and 167 old bytes use the same exact conservation derivation from the directly saved pre-small and post-API inventories; raw omitted counters are retained unchanged.

| Table                              | Inserts / updates / deletes | New / old stored-value bytes |
| ---------------------------------- | --------------------------: | ---------------------------: |
| `__record_current`                 |                   2 / 4 / 0 |                    679 / 333 |
| `__record_fields`                  |                   8 / 0 / 0 |                    1,381 / 0 |
| `__record_intake_lookup_sources`   |                   0 / 1 / 0 |                    654 / 654 |
| `__record_source_text_contents`    |                   3 / 0 / 0 |                    1,180 / 0 |
| `__record_source_text_heads`       |                   0 / 1 / 0 |                1,157 / 1,157 |
| `__record_source_text_links`       |                   6 / 3 / 0 |                  1,355 / 449 |
| `__record_source_text_occurrences` |                   6 / 3 / 0 |                  1,620 / 538 |
| `__record_state`                   |                   1 / 0 / 1 |                    166 / 167 |
| `__record_transactions`            |                   1 / 0 / 0 |                      613 / 0 |
| `__record_versions`                |                   6 / 0 / 0 |                    7,846 / 0 |
| `app_meta`                         |                   2 / 5 / 0 |                  3,558 / 652 |

The subsequent parity checks add reads and complete-view host work but no persistent SQL mutations.

## Array and string locality

The [actual selected-authority writer fixture](../../src/server/test/intake-mutation-locality.test.ts) starts with 20, 80 and 160 operational report groups and a growing long string. It warms both lookup and exact-search projections before every measured mutation, then inserts at the front, deletes, rotates, moves and edits two groups, and changes distant string endpoints around an unchanged middle. Reconstruction from retained authority reproduces every exact envelope.

| Groups | One-time raw normalization, accepted bytes | Largest subsequent accepted bytes | Largest frame / decoded delta bytes | Largest changed search bytes |
| -----: | -----------------------------------------: | --------------------------------: | ----------------------------------: | ---------------------------: |
|     20 |                                    158,312 |                             5,514 |                         1,095 / 328 |                        4,150 |
|     80 |                                    619,091 |                             5,524 |                         1,095 / 328 |                        4,094 |
|    160 |                                  1,240,850 |                             5,532 |                         1,100 / 331 |                        4,115 |

Each subsequent mutation publishes one frame, one selected head and one receipt, carried by two immutable accepted objects and one head publication. It performs zero original source-row updates. Initial normalization deliberately records the complete initial state once; its cost is not folded into ordinary changes. The separate main growth fixture starts normalized and has zero raw conversions.

The mixed move-and-edit case originally fragmented search text into 334 occurrence and 334 link writes (109,191 logical bytes) even though new content was tiny. [Automatic reconciliation](text-piece-reconciliation.md) now reserves maximal exact blocks identified by unique context before character alignment; this fixture needs eight occurrence and ten link writes. Whole retained rows retain priority. Internal discriminating seeds prevent common suffixes from exhausting anchor work. Short residual fragments may become literals only within the documented bound based on independently proved novel text; pure moves get no such allowance.

Lookup ordering at that revision had a separate cost: front insertion changed 22/82/162 rows and 1,986/5,830/11,235 logical bytes. The current [lookup and materialization reuse](intake-processing-work.md) removes ordinal renumbering and reduces repeated view processing; complete-view normalization, matching and projection reads still have separately counted costs. These earlier results establish the measured content/locality patterns, not globally optimal edits or universal availability for every ambiguous input. Complex matching can explicitly exhaust its unchanged work budget before the planned text-piece edits are installed.

## Recovery, attribution and consumer coverage

Seven [application recovery cases](../../src/server/test/intake-mutation-recovery.test.ts) cover real human-entered evidence, duplicate and stale review, encrypted private copy, lock/unlock, manager reopening, total cache loss, coherent contributor backup and five reviewed-acceptance publication failures: staging, immutable-object write, before-head publication, published head followed by SQL rollback, and a lost acknowledgement after publication. The five fault cases use the physical contributor journal and fresh backend instances. They independently verify retained clinical literals, exact pending state and order, earlier receipts, physical original/proposal bytes and hashes, selected serialization, search and effective source pins. Retry cannot add a second receipt or lose an earlier decision.

The contributor backup test rebuilds a selected coherent journal with accepted and still-pending review. Dirty published-head/SQL disagreement refuses backup. A fictional source DOB conflicting with the active person remains blocking before and after reconstruction. These are controlled callback/SQL interruption faults, not a hardware power-loss test or a release Compose recreation qualification.

Private copies preserve original manual-source receipts, authorship, public IDs and accepted `extra_json`. A bounded [target copy proof](intake-envelope-authority.md) carries the narrowly validated ownership relationship without rewriting the original receipt. Eight focused security cases cover target acceptance/replay, second-generation copies, hostile foreign-person claims, transplanted/tampered proofs, physical proposal changes, stale source state, opaque plans and published-target refusal. Missing proof follows ordinary review warnings; a present corrupt proof refuses. Neither route grants another profile's manual attribution merely because a receipt exists.

The [operational consumer inventory](../import/intake-state-access.md#operational-consumer-inventory) is checked by current focused tests in addition to the new growth/recovery fixtures:

| Consumer                            | Current evidence                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope, discovery and pins        | `intake-state-access.test.ts`: stored/effective versions, unknown/null/absent members, selected authority refusal and scoped discovery/search                                         |
| Package and navigation dependencies | `intake-navigation`, `intake-package` and `intake-package-inspector` tests: parent/sibling inventory, package hashing, material dependencies and rebuild                              |
| Sharing and historical evidence     | `note-export-report-review`, `note-exports` and `historical-assertion-packets`: partial report counts and refresh, private exclusion, unread-page disclosure and historical ownership |
| People and ownership                | `record-ownership` and `intake-identity-boundaries`: correction, replay, person/profile isolation and blockers                                                                        |
| Source refresh and continuation     | `intake-own-draft-pair-refresh` and `intake-automatic-recovery`: valid current pins and recovery behavior                                                                             |
| Assistant retry                     | Filtered `assistant.test.ts`: frozen/disjoint counted acceptance, nine final-host race cases, terminal uncertain publication/config changes and finite stale-batch repair             |

The twelve consumer files pass 248 tests. The filtered assistant cases pass 38 tests in total; the private-trace case required a temporary directory outside Git ancestry to preserve the trace safety guard. No protected marker or assertion was removed. These server checks do not establish browser usability, physical passkeys or complete clinical import capacity.

## Separate processing queue journal

The earlier [queue-journal fixture](../../src/server/test/intake-batch-journal-growth.test.ts) exercised actual manager create/stop/resume operations synchronously without starting inference. The following dated results describe the previous journal, before the implemented [selected queue authority](intake-batch-journal.md). The fixture now qualifies that replacement while preserving the independent state and byte-retention oracles.

| Subsequent transitions | Retained events | Retained journal bytes | Prior bytes read by the checkpoint write |
| ---------------------: | --------------: | ---------------------: | ---------------------------------------: |
|                      0 |               2 |                  1,475 |                    Initial creation/stop |
|                    100 |             102 |                 56,011 |                                   55,471 |
|                    200 |             202 |                110,611 |                                  110,071 |
|                    300 |             302 |                165,211 |                                  164,671 |

In that earlier implementation, checkpoint writes each appended 540 bytes. One final item reason changed 24 value bytes and appended a 290-byte event but reread all 302 earlier events/165,211 bytes and replayed 2,860 changes. This was a separate journal measurement, not a whole clinical-processing run. The stopped public response cleared diagnostic `queuedAt` after publication, while durable/reopened state retained the timestamp; the earlier oracle explicitly checked both boundaries.

These earlier complete-history scans and the diagnostic timestamp mismatch are addressed by the [processing queue journal](intake-batch-journal.md). Its current measurements separate warm queue work, encrypted publication, cold reconstruction, complete response copies and unrelated workspace inventory. Neither the earlier intake-envelope qualification nor this queue-specific work establishes bounded whole-import processing cost.

## Release boundary

The tests use fictional evidence and unchanged runtime limits. No known-failing dense/full import, paid route, owner original, physical passkey or deployment is exercised. The implemented [scheduler journal](intake-batch-journal.md) and [verified intake-work reuse](intake-processing-work.md) have their own scoped evidence; [CRS-194](../todo/CRS-194.md) retains whole-import qualification. [PR #35](https://github.com/mxbaylee/circus-health/pull/35) stays held for its own runner, capacity, clinical completeness and diagnostics requirements. Current focused storage evidence cannot close those requirements or the localhost release gate.
