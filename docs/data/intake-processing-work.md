# Reusing verified intake work

The [High-precision tracker's history-building job](../design/personas.md#build-a-history) includes reviewing one more record without repeatedly rebuilding everything already filed. The intake storage and derived readers reuse verified state while preserving exact values, ordering, review decisions and recovery evidence. This reduces repeated host work; it does not make every operation proportional only to changed bytes.

## Selected materializations and isolated changes

The [intake primitive](intake-state-storage.md) retains a privately owned immutable value, its exact serialized text, byte count and fingerprint with each verified selected basis. Ordinary `read()` and the public envelope reader still return detached mutable values. An internal reader can use the immutable materialization without copying it. A caller cannot promote an arbitrary frozen object or a fabricated preparation token into trusted state.

Reuse requires a current accepted-record projection and matching database owner, original source identity/hash and selected intake head. The envelope adapter additionally binds the exact compact `details_json` text. A matching head cannot hide conflicting compact metadata. Tentative values belong to the active application transaction; failed staging, rollback, uncertain publication and closure invalidate disposable state. Neither a cached value nor its serialized text becomes recovery authority.

Preparation normalizes the intended value once, reusing privately owned unchanged subtrees while charging their same logical node and depth budgets. Checked replay isolates changed ancestors and mutation targets while reusing immutable untouched children. It independently produces and compares exact candidate text with the intended text. The existing `health-intake-state-v3` fingerprint still hashes complete ordered JSON; this change does not replace that fingerprint or alter frame, receipt or cumulative decoder budgets. Array shifts and object-key reordering retain their existing logical work charges even when the warm implementation avoids cloning untouched descendants.

The access adapter obtains the selected envelope and stored intake from one materialization. Replacing the intake value preserves its existing outer member position. Stored state and effective source-pin overlays remain distinct, including their version arithmetic and interpretation requirements. Raw mode still retains exact input spelling and duplicate members until an authorized write normalizes it; the raw envelope text and the primitive's serialized `{raw: ...}` wrapper are different representations.

## Derived lookup and text reuse

The lookup projection stores what its consumers need: a maximum discovery value per source, the first acceptance payload for each operation within each source, and a linked sequence of identity occurrences. Equal identity payloads retain separate occurrences and observable order. Front insertion or movement changes affected references instead of renumbering every later item. Across sources, first-acceptance and identity ordering continue to follow source insertion order. Raw SQL extraction and scalar conversion semantics remain unchanged.

This is disposable lookup format 2. An earlier or damaged cache is rebuilt from supported selected authority; originals and accepted records are unchanged. Missing, cyclic or extra identity references cannot silently supply a shortened result. Dirty-source tracking reconciles changed authority while reusing verified unchanged payloads. Transaction failure, reconstruction, schema initialization, unmanaged transactions and profile closure discard disposable payload memos so failed work cannot certify a later retry.

The [source-text projection](source-text-projection.md) consumes already validated envelope text. In normalized mode it reuses the primitive fingerprint for those exact bytes; raw mode hashes the raw envelope rather than reusing the wrapper's fingerprint. Verified text-piece snapshots can serve subsequent unchanged reads without reloading and reconstructing the same rows.

Snapshot reuse follows authority bindings and derived-row invalidation. Content, occurrence, link and head changes invalidate affected snapshots, including changes from another connection detected through SQLite's data version. Schema changes and failed transactions clear readiness. Lowered caller limits still require their prescribed validation; a cached default-limit success cannot authorize a stricter operation. The pure text engine retains its conservative validation, reconstruction and matching checks for actual reconciliation. Those passes remain measured work, not a claim that every retained pass is intrinsically unavoidable.

## Proposal classification beyond a small cache

Source-context classification keeps positive and negative results within the open database, profile, root and original collection. Results cover currently referenced proposal sources and are pruned when no longer referenced. Separate collections do not compete for a process-wide 128-entry FIFO. No fixed cache allowance is raised, and no source literals are retained in the classification cache.

A reusable result binds the source ID, kind, path, original hash, byte count, resolved file identity and effective proposal source-text dependency/revision. Every hit checks physical metadata. Changed or replaced files and changed revision bindings require verification again; missing or corrupt evidence does not inherit an earlier classification. An explicitly unsuccessful transaction, failed activation, lock or close clears the relevant state. The DTO's best-effort classification fallback remains separate from review and acceptance verification, which still refuses changed evidence.

The dedicated fictional regression uses 160 mixed positive/negative proposals: the initial scan reads and hashes all 160 files, an unchanged repeated scan reads and hashes none, and adding one source reads and hashes one. Complete-view iteration and physical metadata checks remain. Candidate-version hash inputs have separate counters taken at the actual hashing boundary; these newly instrumented counts are not retroactively present in earlier receipts.

## Accounting and qualification limits

The [application qualification](intake-mutation-qualification.md) preserves its independently expected clinical literals, pending decisions, accepted history, source pins, exact search text, private-copy and recovery checks. Initial preparation, first raw normalization, warm mutations, complete consumer responses and cold reconstruction are separate phases. Generic mutable input still needs validation and ownership; public detached views still cost copying. Changed-array lookup scans and text matching remain visible even where writes are bounded.

Intake counters distinguish validation, trusted copying, immutable reuse, candidate ancestor copies, serialization, hashing, diffing and returned-view work. Logical decoder charges remain separate from physical copies avoided by reuse. Lookup counters include visited contributions, payload serialization/hashing, previous rows and changed ordering references. Text counters distinguish snapshot loads/reuses and retain completed engine work. Their overlapping units must not be added as total CPU instructions or physical disk traffic.

The optional `withRecordVersionWork` observation scope also counts work inside the accepted-record journal across every connection used by an operation. It includes actual JSON serialization/parsing, encoding, hashing, object and head reads, attempted indexing, structural version/column validation, field visits and replay attempts. Rebuild and catch-up have a separate reconstruction phase, including the temporary connection that a rebuild opens and closes before the final connection is inspected. Failed work remains counted. These counters retain numbers only, without record values, identities or paths.

Encoding includes serialization, and verification may reread the same object more than once. Relationship checks, SQL VM/index work, encryption, other consumers' codecs and total allocator work are outside these counters. The record observer adds evidence about previously uninstrumented work; an earlier receipt without these fields is not a zero-cost baseline.

The current focused before-baseline was captured from commit `3458b404a1d42b7cf01512f76ecf77c2b041675a`: seven real proposal/draft cycles including the initial cycle, plus 20/80/160-group locality cases. Its opt-in 300-cycle case was skipped. Earlier completed 300-cycle results in the application qualification are separately dated historical evidence and must not be relabeled as a new before-run.

Neither a small fixture nor storage-local work counts qualify a whole clinical import, provider performance, foreground responsiveness or an installation capacity. The [large-import qualification](../todo/CRS-194.md), its held runner/storage prerequisites and the physical release gates retain their separate requirements.

## Qualification measurements, 2026-10-03

Measured on 2026-10-03 against runtime/test source SHA-256 manifest `0ff9c1552c510b1c783e87df2733abe8f64b231dbf91f238ae794bda681e5903` (28 touched/new TypeScript files; identical before and after). [Commit `e7d9c11`](https://github.com/mxbaylee/circus-health/tree/e7d9c11fc7347a53e947bff6caf828a139fd5c57) contains that frozen implementation. The original 28-file manifest remained unchanged; a separately corrected, unexecuted accounting-regression test and documentation/main-merge followups are outside that frozen qualification input set. The focused eight-file lane passed 112 tests with the full 300 test explicitly skipped; the separately authorized full 300 run passed its actual initial/100/200/300 clinical, pending-review, ordering, source-pin, original-file, reopen and cache-loss assertions. Neither run invokes a provider or qualifies a heavy clinical import.

The fresh before-measurement is commit `3458b404a1d42b7cf01512f76ecf77c2b041675a`: seven total proposal/draft cycles plus 20/80/160-group locality. Its full 300 test was skipped. The retained historical 300-cycle receipt remains separately source-bound historical evidence; it is not a fresh full 300 before-run. New accepted-record internals, candidate-version hashing, immutable/path-copy/materialization and projection-reuse counters are post-only. Counts overlap and cannot be added into total CPU instructions or physical disk traffic.

### Fresh ordinary small-save comparison

| Measure                                  |     Before |   After |
| ---------------------------------------- | ---------: | ------: |
| Complete normalizations                  |         16 |       1 |
| Validated nodes                          |     24,100 |   1,529 |
| Normalization reused nodes (post-only)   | unmeasured |       0 |
| Validation reused nodes (post-only)      | unmeasured |       0 |
| Normalization clone nodes                |     24,100 |   1,529 |
| Trusted clone nodes (post-only)          | unmeasured |  15,038 |
| Detached-read bytes                      |    827,486 | 636,755 |
| Full candidate-copy bytes                |     63,577 |       0 |
| Candidate path copies (post-only)        | unmeasured |       5 |
| Candidate copied members (post-only)     | unmeasured |      47 |
| Serialized bytes                         |  1,440,405 | 137,623 |
| Parsed bytes                             |    221,213 |   8,364 |
| Hash bytes                               |    139,435 |  71,507 |
| Envelope hydrations                      |         13 |      10 |
| Envelope serialization bytes             |  1,084,749 |       0 |
| Diff node visits                         |      1,501 |   1,501 |
| Array-match serialized bytes             |    228,325 | 228,325 |
| Candidate verification bytes (post-only) | unmeasured |  64,562 |
| Materialization reads (post-only)        | unmeasured |      15 |
| Materializations created (post-only)     | unmeasured |       1 |
| Immutable nodes frozen (post-only)       | unmeasured |     403 |
| Immutable nodes reused (post-only)       | unmeasured |      34 |
| Full original DTO envelope bytes         |          0 |       0 |
| Lookup rows read                         |         16 |      10 |
| Lookup writes                            |          1 |       1 |
| Text snapshot loads (post-only)          | unmeasured |       1 |
| Text snapshot reuses (post-only)         | unmeasured |       0 |
| Text projection rows read                |         59 |      59 |
| Text engine existing-content read bytes  |    190,731 | 190,731 |
| Matching alignment steps                 |    600,927 | 603,934 |
| Search reconstructed bytes               |          0 |       0 |
| Physical API file reads                  |          1 |       1 |
| Physical API read bytes                  |      1,128 |   1,128 |
| Candidate-version hash calls (post-only) | unmeasured |       2 |
| Candidate-version hash bytes (post-only) | unmeasured |   2,554 |

Normalization calls fall 16→1 and measured serialization falls 1,440,405→137,623 bytes. Trusted cloning remains: 1,529 normalization clone nodes plus 15,038 trusted clone nodes after, compared with 24,100 normalization clone nodes before. The normalization reduction is not a claim that all copying fell by the same proportion. Diff visits and array-match serialization remain 1,501 and 228,325 bytes. Generic preparation, exact full-state verification/fingerprinting and complete detached views still perform full-view work.

### Warm locality

| Groups |                       Change | Lookup writes before / after | Lookup bytes before / after | Accepted bytes after | Text content bytes after | Text projection bytes after |
| ------ | ---------------------------: | ---------------------------: | --------------------------: | -------------------: | -----------------------: | --------------------------: |
| 20     |                       insert |                       22 / 2 |                 1,986 / 725 |                5,401 |                      162 |                       2,366 |
| 20     |                       delete |                       22 / 2 |                 1,983 / 728 |                5,209 |                        0 |                       1,673 |
| 20     |                       rotate |                       21 / 1 |                 1,925 / 665 |                5,186 |                        0 |                       2,987 |
| 20     |     mixed edits and rotation |                        3 / 1 |                   790 / 665 |                5,514 |                       84 |                       4,150 |
| 20     | distant string decoy anchors |                        1 / 1 |                   669 / 669 |                5,370 |                      230 |                       3,398 |
| 80     |                       insert |                       82 / 2 |                 5,830 / 729 |                5,416 |                      162 |                       2,381 |
| 80     |                       delete |                       82 / 2 |                 5,824 / 729 |                5,220 |                        0 |                       1,681 |
| 80     |                       rotate |                       81 / 1 |                 5,766 / 666 |                5,196 |                        0 |                       3,004 |
| 80     |     mixed edits and rotation |                        3 / 1 |                   791 / 666 |                5,524 |                        0 |                       4,094 |
| 80     | distant string decoy anchors |                        1 / 1 |                   671 / 671 |                5,385 |                        0 |                       3,193 |
| 160    |                       insert |                      162 / 2 |                11,235 / 733 |                5,424 |                      163 |                       2,390 |
| 160    |                       delete |                      162 / 2 |                11,228 / 733 |                5,223 |                        0 |                       1,686 |
| 160    |                       rotate |                      161 / 1 |                11,168 / 668 |                5,199 |                        0 |                       3,020 |
| 160    |     mixed edits and rotation |                        3 / 1 |                   797 / 669 |                5,532 |                        0 |                       4,115 |
| 160    | distant string decoy anchors |                        1 / 1 |                   674 / 674 |                5,389 |                        0 |                       3,206 |

Every 20/80/160-group mutation separately asserts one normalization, zero full candidate copies, zero detached internal reads and zero redundant envelope serializations. Exact final envelopes survive reconstruction. Host metrics newly added to this locality fixture have no before-measurement.

### Actual full 300 retained inventory and durable I/O

| Measure                              |   Initial |        100 |        200 |        300 |
| ------------------------------------ | --------: | ---------: | ---------: | ---------: |
| Retained proposals                   |         1 |        101 |        201 |        301 |
| Physical files                       |         2 |        102 |        202 |        302 |
| Physical source bytes                |    31,305 |    144,225 |    257,569 |    370,921 |
| Accepted objects including head      |        23 |        425 |        827 |      1,229 |
| Accepted object bytes including head |   163,685 |  2,652,756 |  5,149,500 |  7,647,462 |
| Transaction result rows              |        11 |        212 |        413 |        614 |
| Transaction result total bytes       |     2,335 |      4,403 |      6,471 |      8,539 |
| Largest transaction result bytes     |     1,262 |      1,268 |      1,268 |      1,268 |
| Intake contribution rows             |         6 |        208 |        410 |        612 |
| Intake contribution bytes            |    28,656 |  1,200,512 |  2,377,398 |  3,555,332 |
| Operation receipt rows               |         6 |        208 |        410 |        612 |
| Operation receipt bytes              |     1,794 |     62,500 |    123,302 |    184,104 |
| All SQLite rows                      |       757 |     11,276 |     21,895 |     32,319 |
| All SQLite stored-value bytes        |   395,466 |  6,809,807 | 13,254,343 | 19,671,087 |
| All SQLite serialized-row bytes      |   508,726 |  8,340,830 | 16,206,753 | 24,036,711 |
| SQLite allocated bytes               | 1,052,672 | 11,866,112 | 22,802,432 | 33,767,424 |
| SQLite free bytes                    |         0 |          0 |          0 |          0 |
| Immutable object writes              |        22 |        424 |        826 |      1,228 |
| Immutable bytes written              |   163,540 |  2,652,611 |  5,149,355 |  7,647,317 |
| Head publications                    |        11 |        212 |        413 |        614 |
| Head bytes written                   |     1,586 |     30,531 |     59,476 |     88,421 |
| Immutable reads                      |        33 |        636 |      1,239 |      1,842 |
| Immutable read bytes                 |   318,438 |  5,180,758 | 10,058,247 | 14,938,172 |
| Head reads                           |       207 |      7,097 |     15,194 |     24,195 |
| Head read bytes                      |    29,867 |  1,022,893 |  2,190,934 |  3,490,055 |
| Storage buffer-copy bytes            |   513,431 |  8,886,793 | 17,458,012 | 26,163,965 |

| Persistent SQLite table: rows / stored-value bytes / serialized-row bytes |                Initial |                           100 |                            200 |                            300 |
| ------------------------------------------------------------------------- | ---------------------: | ----------------------------: | -----------------------------: | -----------------------------: |
| __record_current                                                          |    63 / 9,207 / 12,091 |        573 / 92,383 / 118,727 |      1,083 / 175,559 / 225,363 |      1,593 / 258,735 / 331,999 |
| __record_fields                                                           | 498 / 87,217 / 157,785 |   5,358 / 924,274 / 1,683,336 | 10,218 / 1,763,355 / 3,210,911 | 15,078 / 2,602,436 / 4,738,486 |
| __record_intake_lookup_acceptances                                        |          1 / 171 / 215 |                 2 / 342 / 430 |                  3 / 513 / 645 |                  4 / 684 / 860 |
| __record_intake_lookup_groups                                             |          2 / 147 / 243 |          102 / 7,549 / 12,645 |          202 / 14,949 / 25,045 |          302 / 22,349 / 37,445 |
| __record_intake_lookup_identities                                         |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| __record_intake_lookup_payloads                                           |      1 / 1,419 / 1,535 |             2 / 2,844 / 3,076 |              3 / 4,269 / 4,617 |              4 / 5,694 / 6,158 |
| __record_intake_lookup_sources                                            |          2 / 727 / 979 |          102 / 9,737 / 20,689 |          202 / 18,838 / 40,490 |          302 / 27,939 / 60,291 |
| __record_intake_lookup_state                                              |            1 / 19 / 59 |                   1 / 19 / 59 |                    1 / 19 / 59 |                    1 / 19 / 59 |
| __record_source_text_contents                                             |    5 / 16,478 / 18,105 |       924 / 817,651 / 909,204 |  1,861 / 1,618,014 / 1,799,427 |  2,775 / 2,416,908 / 2,687,744 |
| __record_source_text_heads                                                |      2 / 1,715 / 2,067 |         102 / 59,938 / 75,990 |        202 / 118,142 / 149,894 |        302 / 176,343 / 223,795 |
| __record_source_text_links                                                |          5 / 661 / 835 |       956 / 141,068 / 173,776 |      1,948 / 288,644 / 355,280 |      2,854 / 423,062 / 520,702 |
| __record_source_text_occurrences                                          |        5 / 892 / 1,172 |       956 / 171,802 / 225,338 |      1,948 / 350,432 / 459,520 |      2,854 / 513,577 / 673,401 |
| __record_source_text_state                                                |            1 / 19 / 59 |                   1 / 19 / 59 |                    1 / 19 / 59 |                    1 / 19 / 59 |
| __record_state                                                            |          1 / 166 / 265 |                 1 / 167 / 266 |                  1 / 167 / 266 |                  1 / 167 / 266 |
| __record_transactions                                                     |   11 / 11,631 / 13,461 |       212 / 137,135 / 166,473 |        413 / 262,904 / 319,750 |        614 / 388,673 / 473,027 |
| __record_versions                                                         | 95 / 174,443 / 203,809 | 1,410 / 2,815,754 / 3,254,252 |  2,725 / 5,465,133 / 6,312,763 |  4,040 / 8,115,730 / 9,372,492 |
| app_meta                                                                  |   45 / 74,780 / 77,232 |   449 / 1,357,861 / 1,384,553 |    853 / 2,646,050 / 2,696,982 |  1,257 / 3,935,287 / 4,010,459 |
| assets                                                                    |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| attachments                                                               |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| conditions                                                                |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| documents                                                                 |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| evidence                                                                  |          2 / 677 / 873 |             4 / 1,356 / 1,748 |              6 / 2,035 / 2,623 |              8 / 2,714 / 3,498 |
| manual_batches                                                            |      2 / 4,898 / 5,552 |             3 / 7,149 / 8,092 |             4 / 9,370 / 10,602 |            5 / 11,615 / 13,136 |
| medication_preferences                                                    |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| medications                                                               |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| note_links                                                                |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| notes                                                                     |          1 / 201 / 509 |                 1 / 201 / 509 |                  1 / 201 / 509 |                  1 / 201 / 509 |
| observations                                                              |      1 / 4,495 / 5,177 |            2 / 9,013 / 10,379 |            3 / 13,511 / 15,561 |            4 / 18,026 / 20,764 |
| people                                                                    |            1 / 15 / 76 |                   1 / 15 / 76 |                    1 / 15 / 76 |                    1 / 15 / 76 |
| procedures                                                                |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| providers                                                                 |            1 / 56 / 75 |                   1 / 56 / 75 |                    1 / 56 / 75 |                    1 / 56 / 75 |
| record_relationships                                                      |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| reports                                                                   |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |
| schema_migrations                                                         |          7 / 175 / 371 |                 7 / 175 / 371 |                  7 / 175 / 371 |                  7 / 175 / 371 |
| source_files                                                              |      2 / 3,335 / 3,875 |       102 / 249,439 / 286,079 |        202 / 496,183 / 568,923 |        302 / 742,935 / 851,775 |
| source_records                                                            |      1 / 1,693 / 1,956 |             2 / 3,400 / 3,926 |              3 / 5,099 / 5,888 |              4 / 6,806 / 7,858 |
| test_types                                                                |          1 / 229 / 350 |                 2 / 460 / 702 |                3 / 691 / 1,054 |                4 / 922 / 1,406 |
| visibility_events                                                         |              0 / 0 / 0 |                     0 / 0 / 0 |                      0 / 0 / 0 |                      0 / 0 / 0 |

Checkpoint totals include initial creation and each completed consumer/search parity interval. All 301 proposals, 297 pending candidates and four independently specified clinical acceptances survive reopen and complete cache loss. Physical writes equal the retained original/proposal inventory.

### Historical scale comparator: 858f0f6 to current

Each cell is **historical → current**. Historical counts come from the preserved [300-cycle receipt](intake-mutation-qualification.md#host-and-derived-work) at `858f0f6edb70da69ac882a170004adc2e20cc438`; current counts come from the separately completed run above. Intervening changes and independently generated fixture identities mean this is a source-bound historical comparator, not a newly rerun 3458 full baseline or an isolated causal estimate of CRS-228. The controlled fresh comparison remains the ordinary seven-cycle and locality runs.

| Measure: historical → current                                          |             Initial |                           100 |                           200 |                             300 |
| ---------------------------------------------------------------------- | ------------------: | ----------------------------: | ----------------------------: | ------------------------------: |
| Serialized bytes                                                       | 1,173,966 → 175,143 |   1,371,818,848 → 119,434,529 |   5,330,584,007 → 458,688,916 |  11,882,112,184 → 1,018,327,351 |
| Parsed bytes                                                           |    288,431 → 56,170 |       180,443,258 → 1,899,417 |       690,607,941 → 3,759,136 |       1,531,349,395 → 5,620,926 |
| Hydrated envelopes                                                     |            100 → 85 |                 3,035 → 2,414 |                 5,970 → 4,743 |                   8,905 → 7,072 |
| Validated nodes                                                        |      24,667 → 1,709 |        21,874,534 → 1,254,560 |        84,583,982 → 4,838,287 |        188,149,488 → 10,752,690 |
| Clone nodes: historical normalization; current normalization + trusted |     24,667 → 18,797 |       21,874,534 → 15,650,565 |       84,583,982 → 60,487,530 |       188,149,488 → 134,527,173 |
| Detached read-copy bytes                                               |   592,267 → 492,718 |     840,550,487 → 667,692,308 | 3,278,651,289 → 2,603,062,968 |   7,317,795,119 → 5,808,903,560 |
| Full candidate-copy bytes                                              |          33,183 → 0 |                57,619,393 → 0 |               225,196,107 → 0 |                 502,963,853 → 0 |
| Host hash bytes                                                        |   188,459 → 118,086 |      119,872,232 → 60,933,553 |     459,553,173 → 231,750,262 |     1,019,612,955 → 512,759,853 |
| Diff node visits                                                       |       1,117 → 1,117 |         1,242,430 → 1,242,430 |         4,814,619 → 4,814,619 |         10,717,484 → 10,717,484 |
| Array-match serialized bytes                                           |   257,926 → 257,926 |     221,165,748 → 221,165,748 |     846,880,926 → 846,880,926 |   1,878,323,034 → 1,878,323,034 |
| Physical API whole-file reads                                          |             10 → 10 |                     315 → 315 |                  37,358 → 620 |                   114,418 → 925 |
| Physical API whole-file read bytes                                     |   127,472 → 127,472 |             529,998 → 529,998 |          42,479,080 → 933,772 |         129,749,364 → 1,337,594 |
| Lookup authority bytes                                                 |     47,752 → 47,752 |       58,371,338 → 58,371,338 |     226,688,296 → 226,688,296 |       505,196,310 → 505,196,310 |
| Lookup projection rows read                                            |               7 → 8 |                  11,015 → 816 |                42,627 → 2,028 |                  94,843 → 3,644 |
| Lookup projection writes                                               |              9 → 11 |                     413 → 515 |                   817 → 1,019 |                   1,221 → 1,523 |
| Lookup projection written bytes                                        |       5,799 → 6,019 |             190,086 → 201,902 |             375,622 → 398,926 |               561,259 → 596,068 |
| Text authority bytes                                                   |     16,158 → 16,158 |       58,339,744 → 58,339,744 |     226,656,702 → 226,656,702 |       505,164,716 → 505,164,716 |
| Text projection rows read                                              |            146 → 27 |             293,829 → 271,664 |         1,114,537 → 1,039,473 |           2,490,048 → 2,335,813 |
| Text projection read bytes                                             |    171,322 → 22,117 |      103,884,396 → 95,009,574 |     395,622,740 → 365,291,429 |       877,509,157 → 814,970,619 |
| Text projection writes                                                 |             17 → 17 |               12,777 → 12,770 |               25,665 → 25,657 |                 38,285 → 38,146 |
| Text projection written bytes                                          |     22,179 → 22,179 |         3,187,573 → 3,186,155 |         6,379,956 → 6,378,451 |           9,551,732 → 9,537,767 |
| Text engine existing-content read bytes                                |    129,264 → 16,158 |     181,847,680 → 176,428,360 |     701,458,408 → 682,920,095 |   1,558,398,784 → 1,520,075,421 |
| Matching scanned UTF-16 units                                          |               0 → 0 | 1,215,730,053 → 1,215,714,418 | 4,754,431,089 → 4,758,719,895 | 11,441,276,401 → 12,550,906,492 |
| Matching hashed UTF-16 units                                           |               0 → 0 | 2,374,146,237 → 2,374,108,450 | 9,286,810,054 → 9,295,374,626 | 22,388,140,621 → 24,607,385,842 |
| Matching alignment steps                                               |               0 → 0 |     228,525,007 → 228,441,078 |     923,658,709 → 923,717,646 |   2,118,974,101 → 2,119,358,707 |
| Search reconstructed bytes                                             |   129,264 → 129,264 |         6,157,536 → 6,157,536 |       19,990,380 → 19,990,378 |         40,485,876 → 40,485,944 |

The clone row adds the two measured current clone categories; it does not count every shallow path copy or runtime allocation. Diff and array matching remain complete-view work. The source collector initializes matching as an empty object and adds all returned metrics only after a completed reconcile call. Therefore initial and pre-small empty matching objects mean zero completed matching calls, not uninstrumented work. Pure-engine/matching counters omit refused calls because no metrics are returned; other missing scopes are not converted to zero. Matching shape can vary with generated identities; every selected increase at 300 is explicit: Lookup projection writes: 1,221 → 1,523; Lookup projection written bytes: 561,259 → 596,068; Matching scanned UTF-16 units: 11,441,276,401 → 12,550,906,492; Matching hashed UTF-16 units: 22,388,140,621 → 24,607,385,842; Matching alignment steps: 2,118,974,101 → 2,119,358,707; Search reconstructed bytes: 40,485,876 → 40,485,944. All underlying post-only metrics and current costs remain separately reported below.

### Full 300 warm host work

| Measure                                  | Initial |         100 |           200 |           300 |
| ---------------------------------------- | ------: | ----------: | ------------: | ------------: |
| Complete normalizations                  |       8 |         210 |           412 |           614 |
| Validated nodes                          |   1,709 |   1,254,560 |     4,838,287 |    10,752,690 |
| Normalization reused nodes (post-only)   |       0 |           0 |             0 |             0 |
| Validation reused nodes (post-only)      |       0 |           0 |             0 |             0 |
| Normalization clone nodes                |   1,709 |   1,254,560 |     4,838,287 |    10,752,690 |
| Trusted clone nodes (post-only)          |  17,088 |  14,396,005 |    55,649,243 |   123,774,483 |
| Detached-read bytes                      | 492,718 | 667,692,308 | 2,603,062,968 | 5,808,903,560 |
| Full candidate-copy bytes                |       0 |           0 |             0 |             0 |
| Candidate path copies (post-only)        |      37 |       1,958 |         3,880 |         5,802 |
| Candidate copied members (post-only)     |     155 |      58,257 |       216,763 |       475,472 |
| Serialized bytes                         | 175,143 | 119,434,529 |   458,688,916 | 1,018,327,351 |
| Parsed bytes                             |  56,170 |   1,899,417 |     3,759,136 |     5,620,926 |
| Hash bytes                               | 118,086 |  60,933,553 |   231,750,262 |   512,759,853 |
| Envelope hydrations                      |      85 |       2,414 |         4,743 |         7,072 |
| Envelope serialization bytes             |       0 |           0 |             0 |             0 |
| Diff node visits                         |   1,117 |   1,242,430 |     4,814,619 |    10,717,484 |
| Array-match serialized bytes             | 257,926 | 221,165,748 |   846,880,926 | 1,878,323,034 |
| Candidate verification bytes (post-only) |  47,405 |  58,176,887 |   226,299,101 |   504,612,363 |
| Materialization reads (post-only)        |     106 |       3,445 |         6,784 |        10,123 |
| Materializations created (post-only)     |       6 |         208 |           410 |           612 |
| Immutable nodes frozen (post-only)       |     614 |     346,736 |     1,324,712 |     2,934,342 |
| Immutable nodes reused (post-only)       |      57 |      48,336 |       187,018 |       415,903 |
| Full original DTO envelope bytes         |  42,666 |   1,715,148 |     5,024,130 |     9,969,660 |

### Full 300 projection and consumer work

| Measure                                        | Initial |           100 |           200 |            300 |
| ---------------------------------------------- | ------: | ------------: | ------------: | -------------: |
| Lookup authority reads                         |       6 |           308 |           610 |            912 |
| Lookup authority bytes                         |  47,752 |    58,371,338 |   226,688,296 |    505,196,310 |
| Lookup rows read                               |       8 |           816 |         2,028 |          3,644 |
| Lookup row bytes read                          |   2,871 |       471,500 |     1,264,285 |      2,380,186 |
| Lookup writes                                  |      11 |           515 |         1,019 |          1,523 |
| Lookup written bytes                           |   6,019 |       201,902 |       398,926 |        596,068 |
| Lookup contribution items visited (post-only)  |       5 |        10,710 |        41,817 |         93,326 |
| Lookup payload serialization bytes (post-only) |   4,682 |       127,922 |       248,068 |        368,214 |
| Text authority reads                           |       2 |           304 |           606 |            908 |
| Text authority bytes                           |  16,158 |    58,339,744 |   226,656,702 |    505,164,716 |
| Text authority hash bytes                      |   1,936 |       196,040 |       390,784 |        585,536 |
| Text snapshot loads (post-only)                |       4 |           406 |           808 |          1,210 |
| Text snapshot reuses (post-only)               |      14 |           730 |         2,648 |          5,466 |
| Text projection rows read                      |      27 |       271,664 |     1,039,473 |      2,335,813 |
| Text projection bytes read                     |  22,117 |    95,009,574 |   365,291,429 |    814,970,619 |
| Text projection writes                         |      17 |        12,770 |        25,657 |         38,146 |
| Text projection written bytes                  |  22,179 |     3,186,155 |     6,378,451 |      9,537,767 |
| Text content bytes written                     |  18,105 |     1,006,740 |     1,994,589 |      2,962,483 |
| Text occurrence bytes written                  |   1,172 |       514,667 |     1,037,848 |      1,554,377 |
| Text link bytes written                        |     835 |       854,947 |     1,723,612 |      2,589,849 |
| Text engine existing-content read bytes        |  16,158 |   176,428,360 |   682,920,095 |  1,520,075,421 |
| Text engine validated rows                     |      17 |       792,775 |     3,073,756 |      6,941,335 |
| Text engine scan steps                         |      40 |     4,966,845 |    20,032,666 |     45,151,161 |
| Text engine hash bytes                         |  66,448 |   480,554,833 | 1,864,578,444 |  4,164,850,600 |
| Text engine copy bytes                         | 239,411 | 1,416,277,138 | 5,493,961,063 | 12,271,606,740 |
| Matching scan UTF-16 units                     |       0 | 1,215,714,418 | 4,758,719,895 | 12,550,906,492 |
| Matching compared UTF-16 units                 |       0 |   397,754,214 | 1,525,134,760 |  3,379,646,188 |
| Matching alignment steps                       |       0 |   228,441,078 |   923,717,646 |  2,119,358,707 |
| Matching trace cells                           |       0 |       479,613 |       641,729 |        805,501 |
| Matching copied bytes                          |       0 |    58,136,679 |   226,261,281 |    504,576,935 |
| Search query projection rows read              |      17 |         2,951 |         8,506 |         16,487 |
| Search reconstructed bytes                     | 129,264 |     6,157,536 |    19,990,378 |     40,485,944 |
| Returned source-row details bytes              |   3,106 |       200,316 |       592,270 |      1,178,976 |

### Full 300 physical-source and classification work

| Measure                                  | Initial |       100 |       200 |       300 |
| ---------------------------------------- | ------: | --------: | --------: | --------: |
| Physical API file reads                  |      10 |       315 |       620 |       925 |
| Physical API read bytes                  | 127,472 |   529,998 |   933,772 | 1,337,594 |
| Physical API writes                      |       2 |       102 |       202 |       302 |
| Physical API write bytes                 |  31,305 |   144,225 |   257,569 |   370,921 |
| Stream read bytes                        | 120,716 |   120,716 |   120,716 |   120,716 |
| Stream hash bytes                        | 120,716 |   120,716 |   120,716 |   120,716 |
| Buffer hash bytes                        | 159,903 |   788,269 | 1,418,731 | 2,049,257 |
| Text hash bytes                          |  28,774 | 2,255,534 | 5,466,502 | 9,656,030 |
| Candidate-version hash calls (post-only) |      10 |       515 |     1,020 |     1,525 |
| Candidate-version hash bytes (post-only) |  12,750 |   658,275 | 1,305,880 | 1,953,565 |
| Verification cache hits                  |      22 |       728 |     1,434 |     2,140 |
| File publications                        |       2 |       102 |       202 |       302 |
| Fsync calls                              |       4 |       204 |       404 |       604 |

The growth fixture exercises negative classification reuse beyond 128 retained proposals; separate focused classification tests cover positive reuse and invalidation. Candidate-version hashing has its own newly measured scope; it is not a before/after improvement claim. Physical read counts include the fixture’s explicit retained-evidence operations and complete consumer requests. Full original DTO envelope bytes and returned source-row details bytes cover different populations, not a same-row compression ratio.

### Full 300 final small draft versus subsequent consumer parity

| Measure                                        | Small draft API | Subsequent consumer parity |
| ---------------------------------------------- | --------------: | -------------------------: |
| Immutable object writes                        |               2 |                          0 |
| Immutable bytes written                        |           7,186 |                          0 |
| Head publications                              |               1 |                          0 |
| Head bytes written                             |             144 |                          0 |
| Immutable reads                                |               3 |                          0 |
| Immutable read bytes                           |          13,801 |                          0 |
| Head reads                                     |              27 |                      2,940 |
| Head read bytes                                |           3,913 |                    423,360 |
| Storage buffer-copy bytes                      |          25,044 |                    423,360 |
| Complete normalizations                        |               1 |                          0 |
| Validated nodes                                |          35,045 |                          0 |
| Normalization reused nodes (post-only)         |               0 |                          0 |
| Validation reused nodes (post-only)            |               0 |                          0 |
| Normalization clone nodes                      |          35,045 |                          0 |
| Trusted clone nodes (post-only)                |         350,198 |                    280,360 |
| Detached-read bytes                            |      16,486,087 |                 13,195,976 |
| Full candidate-copy bytes                      |               0 |                          0 |
| Candidate path copies (post-only)              |               5 |                          0 |
| Candidate copied members (post-only)           |             929 |                          0 |
| Serialized bytes                               |       3,307,519 |                      1,782 |
| Parsed bytes                                   |           8,492 |                      4,338 |
| Hash bytes                                     |       1,656,459 |                      1,782 |
| Envelope hydrations                            |              10 |                          8 |
| Envelope serialization bytes                   |               0 |                          0 |
| Diff node visits                               |          35,017 |                          0 |
| Array-match serialized bytes                   |       5,897,585 |                          0 |
| Candidate verification bytes (post-only)       |       1,649,497 |                          0 |
| Materialization reads (post-only)              |              15 |                          9 |
| Materializations created (post-only)           |               1 |                          0 |
| Immutable nodes frozen (post-only)             |           9,517 |                          0 |
| Immutable nodes reused (post-only)             |             916 |                          0 |
| Full original DTO envelope bytes               |               0 |                  4,948,491 |
| Lookup authority reads                         |               1 |                          0 |
| Lookup authority bytes                         |       1,649,497 |                          0 |
| Lookup rows read                               |              10 |                          0 |
| Lookup row bytes read                          |           7,121 |                          0 |
| Lookup writes                                  |               1 |                          0 |
| Lookup written bytes                           |             770 |                          0 |
| Lookup contribution items visited (post-only)  |             305 |                          0 |
| Lookup payload serialization bytes (post-only) |               0 |                          0 |
| Text authority reads                           |               1 |                          0 |
| Text authority bytes                           |       1,649,497 |                          0 |
| Text authority hash bytes                      |               0 |                          0 |
| Text snapshot loads (post-only)                |               1 |                        302 |
| Text snapshot reuses (post-only)               |               0 |                      2,616 |
| Text projection rows read                      |           1,222 |                      2,429 |
| Text projection bytes read                     |       1,933,922 |                  2,899,072 |
| Text projection writes                         |              22 |                          0 |
| Text projection written bytes                  |           6,460 |                          0 |
| Text content bytes written                     |           1,323 |                          0 |
| Text occurrence bytes written                  |           2,124 |                          0 |
| Text link bytes written                        |           1,661 |                          0 |
| Text engine existing-content read bytes        |       4,945,530 |                  2,235,034 |
| Text engine validated rows                     |           3,630 |                      2,429 |
| Text engine scan steps                         |          12,369 |                      2,837 |
| Text engine hash bytes                         |      11,864,123 |                  4,599,773 |
| Text engine copy bytes                         |      34,475,111 |                 11,983,344 |
| Matching scan UTF-16 units                     |       9,941,538 |                          0 |
| Matching compared UTF-16 units                 |      10,986,958 |                          0 |
| Matching alignment steps                       |       5,631,820 |                          0 |
| Matching trace cells                           |               9 |                          0 |
| Matching copied bytes                          |       1,649,498 |                          0 |
| Search query projection rows read              |               0 |                      2,429 |
| Search reconstructed bytes                     |               0 |                 20,504,449 |
| Returned source-row details bytes              |               0 |                    586,706 |
| Physical API file reads                        |               1 |                          2 |
| Physical API read bytes                        |           1,136 |                     60,358 |
| Physical API writes                            |               0 |                          0 |
| Physical API write bytes                       |               0 |                          0 |
| Stream read bytes                              |               0 |                          0 |
| Stream hash bytes                              |               0 |                          0 |
| Buffer hash bytes                              |           1,136 |                     60,358 |
| Text hash bytes                                |          26,764 |                          0 |
| Candidate-version hash calls (post-only)       |               2 |                          0 |
| Candidate-version hash bytes (post-only)       |           2,570 |                          0 |
| Verification cache hits                        |               2 |                          2 |
| File publications                              |               0 |                          0 |
| Fsync calls                                    |               0 |                          0 |

The small API interval excludes its following complete consumer/search parity. The ordinary read preparation immediately before the small API is outside both intervals. Initial raw-conversion calls are zero because this fixture uploads normalized authority; one-time raw normalization is qualified separately. Scheduler-journal calls are zero in this fixture.

### Open and complete cache-loss reconstruction

| Storage / physical-source measure         | Reopen including parity | Cache loss including parity |
| ----------------------------------------- | ----------------------: | --------------------------: |
| Accepted storage reads                    |                   2,947 |                       6,022 |
| Accepted storage missingReads             |                       0 |                           0 |
| Accepted storage readBytes                |                 427,315 |                  29,947,922 |
| Accepted storage immutableReads           |                       0 |                       3,070 |
| Accepted storage immutableReadBytes       |                       0 |                  29,519,882 |
| Accepted storage headReads                |                   2,947 |                       2,952 |
| Accepted storage headReadBytes            |                 427,315 |                     428,040 |
| Accepted storage immutableWrites          |                       0 |                           0 |
| Accepted storage immutableWriteBytes      |                       0 |                           0 |
| Accepted storage headWrites               |                       0 |                           0 |
| Accepted storage headWriteBytes           |                       0 |                           0 |
| Accepted storage copiedBytes              |                 427,315 |                  29,947,922 |
| Physical source readAttempts              |                     303 |                         303 |
| Physical source reads                     |                     303 |                         303 |
| Physical source readBytes                 |                 401,100 |                     401,100 |
| Physical source writeAttempts             |                       0 |                           0 |
| Physical source writes                    |                       0 |                           0 |
| Physical source writeBytes                |                       0 |                           0 |
| Physical source writeFailures             |                       0 |                           0 |
| Physical source inspectionBufferBytes     |                       0 |                           0 |
| Physical source streamReadAttempts        |                       0 |                           0 |
| Physical source streamReadCalls           |                       0 |                           0 |
| Physical source streamReadBytes           |                       0 |                           0 |
| Physical source streamHashCalls           |                       0 |                           0 |
| Physical source streamHashBytes           |                       0 |                           0 |
| Physical source bufferHashCalls           |                     303 |                         303 |
| Physical source bufferHashBytes           |                 401,100 |                     401,100 |
| Physical source textHashCalls             |                       0 |                           0 |
| Physical source textHashBytes             |                       0 |                           0 |
| Physical source candidateVersionHashCalls |                       0 |                           0 |
| Physical source candidateVersionHashBytes |                       0 |                           0 |
| Physical source verificationCacheHits     |                       2 |                           2 |
| Physical source fsyncAttempts             |                       0 |                           0 |
| Physical source fsyncCalls                |                       0 |                           0 |
| Physical source renameAttempts            |                       0 |                           0 |
| Physical source renames                   |                       0 |                           0 |
| Physical source publications              |                       0 |                           0 |
| Physical source copyAttempts              |                       0 |                           0 |
| Physical source copies                    |                       0 |                           0 |
| Physical source copyRequestedBytes        |                       0 |                           0 |

| Connection-scoped intake measure | Reopen warm | Reopen reconstruction | Cache-loss final connection warm | Cache-loss final connection reconstruction |
| -------------------------------- | ----------: | --------------------: | -------------------------------: | -----------------------------------------: |
| normalizeCalls                   |           0 |                     0 |                                0 |                                          0 |
| normalizeValidationNodes         |           0 |                     0 |                                0 |                                          0 |
| normalizeCloneNodes              |           0 |                     0 |                                0 |                                          0 |
| normalizeReusedNodes             |           0 |                     0 |                                0 |                                          0 |
| normalizeValidationReusedNodes   |           0 |                     0 |                                0 |                                          0 |
| normalizeValidatedStringUnits    |           0 |                     0 |                                0 |                                          0 |
| trustedCloneCalls                |           8 |                     0 |                                8 |                                          0 |
| trustedCloneNodes                |     280,136 |                     0 |                          280,136 |                                          0 |
| immutableNodesFrozen             |       9,494 |                     0 |                            9,494 |                                          0 |
| immutableNodesReused             |           0 |                     0 |                                0 |                                          0 |
| candidatePathCopies              |           0 |                     0 |                                0 |                                          0 |
| candidateCopiedMembers           |           0 |                     0 |                                0 |                                          0 |
| candidateVerificationCalls       |           0 |                     0 |                                0 |                                          0 |
| candidateVerificationBytes       |           0 |                     0 |                                0 |                                          0 |
| materializationReads             |          11 |                     0 |                               11 |                                          0 |
| materializationsCreated          |           1 |                     0 |                                1 |                                          0 |
| preparedStateReuses              |           0 |                     0 |                                0 |                                          0 |
| serializationCalls               |          12 |                   615 |                               12 |                                        615 |
| serializedBytes                  |       2,568 |           504,612,729 |                            2,568 |                                504,612,729 |
| diffCalls                        |           0 |                     0 |                                0 |                                          0 |
| diffNodeVisits                   |           0 |                     0 |                                0 |                                          0 |
| diffStringComparedUnits          |           0 |                     0 |                                0 |                                          0 |
| arrayMatchSerializedBytes        |           0 |                     0 |                                0 |                                          0 |
| arrayMatchItems                  |           0 |                     0 |                                0 |                                          0 |
| diffAlignmentSteps               |           0 |                     0 |                                0 |                                          0 |
| diffTraceCells                   |           0 |                     0 |                                0 |                                          0 |
| hashCalls                        |          11 |                 1,837 |                               11 |                                      1,837 |
| hashedBytes                      |       2,178 |           510,513,147 |                            2,178 |                                510,513,147 |
| jsonParseCalls                   |          13 |                 1,836 |                               13 |                                      1,836 |
| jsonParseBytes                   |       6,082 |             6,084,690 |                            6,082 |                                  6,084,690 |
| evidenceDecodeCopyBytes          |       5,302 |             6,084,690 |                            5,302 |                                  6,084,690 |
| evidenceBufferCopiedBytes        |       5,302 |            15,465,706 |                            5,302 |                                 15,465,706 |
| evidenceFrameReads               |           0 |                   612 |                                0 |                                        612 |
| evidenceFrameReadBytes           |           0 |             3,555,332 |                                0 |                                  3,555,332 |
| evidenceReceiptReads             |           0 |                   612 |                                0 |                                        612 |
| evidenceReceiptReadBytes         |           0 |               184,104 |                                0 |                                    184,104 |
| evidenceReplayVersions           |           0 |                   612 |                                0 |                                        612 |
| evidenceReplayOperations         |           0 |                 8,126 |                                0 |                                      8,126 |
| envelopeHydrations               |           8 |                     0 |                                8 |                                          0 |
| envelopeTextReads                |           1 |                     0 |                                1 |                                          0 |
| envelopeSerializedBytes          |           0 |                     0 |                                0 |                                          0 |
| envelopeSerializationCalls       |           0 |                     0 |                                0 |                                          0 |
| rawNormalizations                |           0 |                     0 |                                0 |                                          0 |
| sourceDTOHydrations              |           3 |                     0 |                                3 |                                          0 |
| sourceDTOEnvelopeBytes           |   4,945,530 |                     0 |                        4,945,530 |                                          0 |

Intake host counters above remain scoped to the returned connection; temporary rebuild-connection intake work is not included. The separate accepted-record observer below spans every connection, including the temporary rebuild, and records operation versus reconstruction phases. Storage I/O spans the complete operation.

### Accepted-record internals: post-only measurements

| Measure                   | Initial |        100 |        200 |        300 |
| ------------------------- | ------: | ---------: | ---------: | ---------: |
| serializationCalls        |   1,775 |     33,496 |     67,631 |    103,574 |
| serializedBytes           | 544,938 | 10,062,970 | 19,953,227 | 30,107,695 |
| encodeCalls               |     117 |      1,834 |      3,551 |      5,268 |
| encodedBytes              | 165,126 |  2,683,142 |  5,208,831 |  7,735,738 |
| parseCalls                |     672 |     18,401 |     38,544 |     60,495 |
| parsedBytes               | 248,117 |  5,171,823 | 10,453,880 | 15,998,560 |
| hashCalls                 |      55 |      1,060 |      2,065 |      3,070 |
| hashedBytes               | 481,978 |  7,833,369 | 15,207,602 | 22,585,489 |
| objectReadCalls           |      33 |        636 |      1,239 |      1,842 |
| objectReadBytes           | 318,438 |  5,180,758 | 10,058,247 | 14,938,172 |
| headReadCalls             |     209 |      7,099 |     15,196 |     24,197 |
| headReadBytes             |  29,867 |  1,022,893 |  2,190,934 |  3,490,055 |
| commitValidations         |       0 |          0 |          0 |          0 |
| versionValidations        |      95 |      1,410 |      2,725 |      4,040 |
| indexedVersionValidations |       0 |          0 |          0 |          0 |
| validatedColumns          |     277 |      3,754 |      7,231 |     10,708 |
| decodedVersions           |      95 |      1,410 |      2,725 |      4,040 |
| indexedVersionAttempts    |      95 |      1,410 |      2,725 |      4,040 |
| fieldVisits               |     606 |      7,935 |     15,264 |     22,593 |
| replayDeleteAttempts      |       0 |          0 |          0 |          0 |
| replayInsertAttempts      |       0 |          0 |          0 |          0 |

| Metric                    | Small API operation | Small API reconstruction | Subsequent parity operation | Open operation | Open reconstruction | Cache-loss operation | Cache-loss reconstruction |
| ------------------------- | ------------------: | -----------------------: | --------------------------: | -------------: | ------------------: | -------------------: | ------------------------: |
| serializationCalls        |                 123 |                        0 |                       5,880 |          5,890 |                   2 |                5,890 |                    67,299 |
| serializedBytes           |              28,120 |                        0 |                     840,840 |        848,160 |                 288 |              848,160 |                16,356,325 |
| encodeCalls               |                   8 |                        0 |                           0 |              0 |                   0 |                    0 |                         0 |
| encodedBytes              |               7,330 |                        0 |                           0 |              0 |                   0 |                    0 |                         0 |
| parseCalls                |                  72 |                        0 |                       5,880 |          5,891 |                   3 |                5,891 |                    28,890 |
| parsedBytes               |              17,500 |                        0 |                     843,780 |        851,250 |               2,186 |              851,250 |                31,621,360 |
| hashCalls                 |                   5 |                        0 |                           0 |              0 |                   0 |                    0 |                     3,070 |
| hashedBytes               |              20,987 |                        0 |                           0 |              0 |                   0 |                    0 |                29,519,882 |
| objectReadCalls           |                   3 |                        0 |                           0 |              0 |                   0 |                    0 |                     3,070 |
| objectReadBytes           |              13,801 |                        0 |                           0 |              0 |                   0 |                    0 |                29,519,882 |
| headReadCalls             |                  27 |                        0 |                       2,940 |          2,946 |                   1 |                2,946 |                         6 |
| headReadBytes             |               3,913 |                        0 |                     423,360 |        427,170 |                 145 |              427,170 |                       870 |
| commitValidations         |                   0 |                        0 |                           0 |              0 |                   0 |                    0 |                       614 |
| versionValidations        |                   6 |                        0 |                           0 |              0 |                   0 |                    0 |                     8,080 |
| indexedVersionValidations |                   0 |                        0 |                           0 |              0 |                   0 |                    0 |                         0 |
| validatedColumns          |                  12 |                        0 |                           0 |              0 |                   0 |                    0 |                    21,416 |
| decodedVersions           |                   6 |                        0 |                           0 |              0 |                   0 |                    0 |                    16,160 |
| indexedVersionAttempts    |                   6 |                        0 |                           0 |              0 |                   0 |                    0 |                     4,040 |
| fieldVisits               |                  20 |                        0 |                           0 |              0 |                   0 |                    0 |                    22,593 |
| replayDeleteAttempts      |                   0 |                        0 |                           0 |              0 |                   0 |                    0 |                     4,040 |
| replayInsertAttempts      |                   0 |                        0 |                           0 |              0 |                   0 |                    0 |                     4,040 |

Encoding includes serialization, and hashes/read/decode/validation counts can cover overlapping bytes. Replay and indexing attempts include failed attempts; validation counters are distinct. The fixture independently checks that small-operation encoded bytes equal segment, commit and head bytes written. Accepted-record reconstruction includes temporary-connection processing; it does not establish comprehensive encryption, HTTP serialization, runtime allocation or SQLite-internal instrumentation. No elapsed model-time target is inferred.
