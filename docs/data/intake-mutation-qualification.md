# Intake mutation and recovery qualification

These independently fictional checks exercise the application APIs used to prepare, review and accept evidence. They support the High-precision tracker's [history-building job](../design/personas.md#build-a-history): earlier records, review choices and original files must remain correct as more work arrives. They distinguish changed evidence, retained history, rebuildable projections and the host work needed to produce a complete view.

The implemented authority is the [selected intake envelope](intake-envelope-authority.md), backed by the accepted-record journal. Original files and accepted versions remain recovery authority. The [v3 codec](intake-state-storage.md) retains exact ordered JSON and encodes changed array elements, moves and distant string edits. Unsupported older authority refuses explicitly; there is no migration, reset, history pruning or runtime-capacity increase.

## Accounting boundaries

The [growth harness](../../src/server/test/intake-mutation-growth.test.ts) uses actual original upload/extraction, durable passage reads, batch proposals, review drafts and reviewed clinical acceptance. Every proposal includes a complete fictional clinical observation plus administrative source material. Clinical assertions use independent literal expectations, including `< 0.030`, `+004.500`, `7.20` and `−0.125`, with exact unit, month precision and person scope. It never substitutes an empty clinical payload or uses model output as its acceptance oracle. All provider behavior is fictional; no inference is purchased.

The ordinary growth fixture's `RecordStorage` implements immutable-object and selected-head semantics in memory, with physical original and proposal files. Its counters establish logical accepted bytes and copies, not filesystem crash durability or disk-sector traffic. The separate recovery matrix uses the actual contributor filesystem journal, physical original verifier and newly opened backend instances. The encrypted private-copy test uses the actual encrypted lifecycle.

Routine server CI runs seven real proposal/draft cycles with four clinical acceptances, pending review, reopening, cache loss and a subsequent draft change. The dedicated growth qualification retains 300 additional cycles after its initial accepted record, with clinical acceptance and independent complete-state checks at each 100-cycle checkpoint. Both modes share the same fixture and exact oracle; a passing small test is not a completed 300-cycle receipt. Run the dedicated check explicitly from the repository:

```sh
CRS_INTAKE_MUTATION_QUALIFY=1 node --test --test-name-pattern='qualification:' src/server/test/intake-mutation-growth.test.ts
```

Its separate two-hour host hang guard only prevents an abandoned qualification process. It does not change application capacity or model limits, establish an acceptable completion time, or qualify foreground responsiveness. Normal CI retains its existing host watchdog. Checkpoint files are saved to a unique temporary artifact directory as each oracle passes; a stopped trial retains partial evidence and must not be reported as a full success.

An earlier full attempt passed checkpoints 100 and 200, published all 301 proposals, then refused during the fourth clinical acceptance because repeated text-piece boundary walks exhausted the unchanged two-million-step scan budget. That attempt is failed evidence, not a completed 300-cycle receipt. The explicit planner now reuses validated boundary indexes; the captured 121-edit case passes with 1,636,431 combined reconstruction/planning scan steps. Independent comparison of 300 mixed Unicode edit sequences preserves exact planned rows, identities and refusal behavior. Initial/setup, each completed checkpoint and all-phase failure context are retained outside Git; the final report separates the small save API from subsequent consumer/search parity.

The maintained test files emit portable JSON diagnostics and write raw qualification artifacts to unique temporary directories outside Git. Their measurements include:

| Representation or work | What is counted                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted journal       | Every immutable segment and commit, head publication, object count, buffer copy and read, with initial/open/reconstruction intervals separated                                                                    |
| Intake authority       | Contribution frames, heads and operation receipts; every production-created primitive handle; replayed versions/operations and evidence reads                                                                     |
| SQLite                 | Every persistent table's row count, stored value bytes and separately serialized row bytes; page count/size/free pages; temporary audit triggers count all inserts/updates/deletes and old/new stored value bytes |
| History and results    | Contents, metadata and field references; transaction-result total and largest size; source metadata and all `app_meta` authority categories                                                                       |
| Derived lookup/search  | Individual content, occurrence, link and head writes/deletes; lookup rows; source reads and bytes; search evaluations, reconstruction and selected DTO envelopes                                                  |
| Host envelope work     | Validation nodes and string units, clone nodes/bytes, serialization/parse calls and bytes, diff nodes/comparisons/alignment/trace cells, array matching, hashes and hydration                                     |
| Physical source files  | Retained original/proposal count and bytes, independently verified file hashes; actual API read/write payloads, streaming reads/hashes, verification cache hits, fsync and publication calls                      |

`intakeWorkCounters(db)` retains numeric totals for the connection, including rolled-back attempts and internally created primitive handles. Warm and reconstruction scopes are separate; cache clearing does not erase earlier counted work. `sourceDTOEnvelopeBytes` measures the complete reconstructed original envelope. `sourceDetailsSearchCounters().dtoDetailsBytes` measures the compact physical source row and must not be presented as a full DTO measurement.

`withIntakeFileWork` is an optional async-scoped numeric collector. Buffer and text hash counts are distinct; text hashing also includes semantic fingerprints, not only physical files. A failed write can have unknown partial bytes: attempts and failures are reported, while successful payload bytes do not claim to cover the failed portion. Cross-device copy requests are counted as requested bytes, separately from successful direct writes. The collector stores no paths, identities or values and introduces no extra filesystem reads for accounting.

These are logical work and API payload measurements. Activities overlap and cannot be summed into physical disk traffic or total CPU instructions. JavaScript runtime allocation, SQLite VM/index internals, accepted-record internal encode/hash/replay parsing and validation, HTTP receiver/response serialization, extraction-worker and encrypted-vault internals are not comprehensively instrumented. Rebuild storage I/O spans the complete operation, but reconstruction host counters describe intake work on the final connection: `rebuildRecordDatabase()` uses a separate temporary connection whose internal processing is not included. Initial creation, one-time raw normalization, opening, cold reconstruction and ordinary mutations have separate evidence; a small changed write does not imply changed-only host computation.

## Array and string locality

The [actual selected-authority writer fixture](../../src/server/test/intake-mutation-locality.test.ts) starts with 20, 80 and 160 operational report groups and a growing long string. It warms both lookup and exact-search projections before every measured mutation, then inserts at the front, deletes, rotates, moves and edits two groups, and changes distant string endpoints around an unchanged middle. Reconstruction from retained authority reproduces every exact envelope.

| Groups | One-time raw normalization, accepted bytes | Largest subsequent accepted bytes | Largest frame / decoded delta bytes | Largest changed search bytes |
| -----: | -----------------------------------------: | --------------------------------: | ----------------------------------: | ---------------------------: |
|     20 |                                    158,312 |                             5,514 |                         1,095 / 328 |                        4,150 |
|     80 |                                    619,091 |                             5,524 |                         1,095 / 328 |                        4,094 |
|    160 |                                  1,240,850 |                             5,532 |                         1,100 / 331 |                        4,115 |

Each subsequent mutation publishes one frame, one selected head and one receipt, carried by two immutable accepted objects and one head publication. It performs zero original source-row updates. Initial normalization deliberately records the complete initial state once; its cost is not folded into ordinary changes. The separate main growth fixture starts normalized and has zero raw conversions.

The mixed move-and-edit case originally fragmented search text into 334 occurrence and 334 link writes (109,191 logical bytes) even though new content was tiny. [Automatic reconciliation](text-piece-reconciliation.md) now reserves maximal exact blocks identified by unique context before character alignment; this fixture needs eight occurrence and ten link writes. Whole retained rows retain priority. Internal discriminating seeds prevent common suffixes from exhausting anchor work. Short residual fragments may become literals only within the documented bound based on independently proved novel text; pure moves get no such allowance.

Lookup ordering still has a separate cost: front insertion changes 22/82/162 rows and 1,986/5,830/11,235 logical bytes. Complete-view normalization, matching and projection reads also grow. [CRS-228](../todo/CRS-228.md) owns reducing that work; these results establish the measured content/locality patterns, not globally optimal edits or universal availability for every ambiguous input. Complex matching can explicitly exhaust its unchanged work budget before publication.

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

The [queue-journal fixture](../../src/server/test/intake-batch-journal-growth.test.ts) exercises actual manager create/stop/resume operations synchronously without starting inference. It preserves every event and original byte, compares independent durable and public-response state, and reopens the manager.

| Subsequent transitions | Retained events | Retained journal bytes | Prior bytes read by the checkpoint write |
| ---------------------: | --------------: | ---------------------: | ---------------------------------------: |
|                      0 |               2 |                  1,475 |                    Initial creation/stop |
|                    100 |             102 |                 56,011 |                                   55,471 |
|                    200 |             202 |                110,611 |                                  110,071 |
|                    300 |             302 |                165,211 |                                  164,671 |

The checkpoint writes each append 540 bytes. One final item reason changes 24 value bytes and appends a 290-byte event but rereads all 302 earlier events/165,211 bytes and replays 2,860 changes. This is a separate journal measurement, not a whole clinical-processing run. The stopped public response clears diagnostic `queuedAt` after publication, while durable/reopened state retains the timestamp; the oracle explicitly checks both boundaries.

The journal still scans/replays its history on each write. [CRS-227](../todo/CRS-227.md) is its scoped production prerequisite. The intake-envelope fixes do not replace this journal or establish bounded processing cost.

## Release boundary

The tests use fictional evidence and unchanged runtime limits. No known-failing dense/full import, paid route, owner original, physical passkey or deployment is exercised. The scheduler journal and repeated full-view processing remain explicit prerequisites in [CRS-194](../todo/CRS-194.md). [PR #35](https://github.com/mxbaylee/circus-health/pull/35) stays held for its own runner, capacity, clinical completeness and diagnostics requirements. Current focused storage evidence cannot close those requirements or the localhost release gate.
