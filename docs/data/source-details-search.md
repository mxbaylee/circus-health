# Exact source-details search

Source-list search consumes checked ordered text through `sourceDetailsSearch` in the [intake access boundary](../import/intake-state-access.md). Native v4 originals stream their selected logical authority directly; they have no second text-piece copy. Retained v3 originals and non-original sources use the [disposable exact source-text projection](source-text-projection.md). Original source rows contain compact metadata, while non-original rows retain their existing raw envelopes. Search never owns either representation.

## Matching and returned records

SQLite evaluates `__source_details_search_match(f.path LIKE ?,?,f.id,?)=1`. The text parameters are `%<query>%`, with unescaped `%`/`_` wildcards; the middle parameter is an opaque request token. Every callback checks the request and profile, including path matches. A path match needs no source-text traversal. Otherwise a streaming predicate consumes exact text in order, retaining state bounded by the pattern. SQLite oracle tests preserve default ASCII case folding, non-ASCII distinctions, codepoint wildcards, NUL truncation, lone-surrogate TEXT transport and SQLite's U+FFFE/U+FFFF replacement behavior. Empty or absent queries retain the unfiltered path.

Raw whitespace, duplicate-property spelling, escape spelling, member order and matches across piece/key/value boundaries remain searchable. Newly written normalized envelopes retain the [exact serialization contract](intake-state-storage.md#exact-serialization-domain). The projection validates authority before trusting it: malformed or unsupported evidence refuses the request, including a path-only match when upfront reconciliation discovers corrupt source authority. It never guesses a replacement string.

Provider, reviewed-source provider, acquisition provider, visibility and kind filters are unchanged. Count and page statements share the predicate and parameters and preserve ordering and pagination. Native v4 list rows return the existing `SourceFileReference` discriminator (`detailsIncluded:false`, `detailsUrl`); v3 and non-original list rows retain their complete DTOs. SQL metadata filters continue to inspect compact original metadata or non-original raw rows, preserving duplicate-member filter semantics.

`GET /sources/:id?fileView=reference` returns a checked header. Native v4 detail GET defaults to that header; an explicit `fileView=full` refuses and directs the caller to `/sources/:id/operational-envelope`, a streamed exact JSON download. Legacy detail GET remains unchanged. Sources browsing fetches headers and offers an explicit retained-details download. Original-content download uses its authorized source-row file binding and existing archive containment checks, so a missing operational head does not prevent downloading the retained original.

## Request lifetime and limits

`createSourceDetailsSearch(db, query, options?)` reconciles dirty bindings before outer count/page statements and permits one active scope per connection. Native v4 traversal checks the selected source/hash/logical root, drains every fragment even after an early match, and checks the binding again on completion. Missing late evidence or a changed binding fails the entire request. Count/page evaluations may each traverse the selected text: exact search remains O(selected text) work. The count/page statements and their fragment callbacks execute synchronously; fragment boundaries do not yield to other requests. Large-search responsiveness has not been qualified. Native mutations and auxiliary receipt/build changes do not reconstruct or write text rows. The query retains no source text; v3 compatibility retains at most one bounded text-piece snapshot.

The source-list caller disposes the plan in `finally`, with failures recorded for count, page and DTO errors. Transaction outcomes invalidate an outstanding scope. Application close, encrypted-profile lock and failed-open cleanup clear it, as do actual profile switches that lock the previous profile. Authorization occurs before source queries; warming a profile does not grant another HTTP session access. Independently authorized sessions may use the same open profile under the existing session rules. Internal callers managing their own database must dispose plans and call `clearSourceDetailsSearchCache(db)` before closing it; native `db.close()` is not intercepted.

The pattern budget matches SQLite's 50,000 UTF-8 bytes, including bytes after NUL. There is no default source-count or aggregate-text product limit. Optional diagnostic limits retain their historical names (`maxEvaluations`, `maxReconstructedUtf16Units`, `maxReconstructedBytes`) but now charge callback evaluations and streamed fragments; the default ceilings only protect exact integer accounting. Options may lower them; invalid values refuse. Exhaustion fails the entire count/page request rather than returning truncated counts. Native emitted fragments are at most 4 KiB; v3 compatibility retains the existing [engine limits](source-text-projection.md#limits-cleanup-and-work-accounting).

## Mutation and recovery boundary

An already-used projection is reconciled by `writeIntakeDetails` and `registerIntakeFile` inside their existing application transaction. The authoritative change and derived rows therefore stage and roll back together; a caught reconciliation failure still rejects the outer transaction. Cold writers initialize and reconcile the projection at the next read. On initialized connections, direct SQL and writers outside the application transaction retain transactional dirty tracking and next-read repair. These producers do not eagerly initialize the projection. Original registration and operational writers use the selected envelope chain; non-original envelopes retain their existing source-row contract. Indexed intake-head namespace triggers also invalidate affected projections transactionally, without decoding the head value for routing.

Reopen, private copy and total cache loss rebuild from the selected profile's verified authority. Missing, corrupt or unsupported selected durable evidence refuses recovery. Derived table/content loss repairs from authority; it cannot establish a new authority. Normal warm reads validate current durable readiness and selected heads without reauthenticating every historical immutable object on every query.

## Work accounting and measured growth

`sourceDetailsSearchCounters(db)` separates requests/outcomes, candidate callbacks (including path matches), profile binding reads, streamed fragments/UTF-16 units/UTF-8 bytes, peak fragment bytes, projection/authority consumption and selected DTO row bytes. Old query reconstruction counters remain zero. `peakMatcherBytes` counts typed numeric buffers; bounded JavaScript container overhead is separate. Native authority-byte counters charge compact binding reads and emitted logical payloads, while `intakeWorkCounters` records collection work and any explicitly selected v3 compatibility hydration. These are logical work counters, not physical disk bytes. Upfront reconciliation and callback deltas overlap in projection totals and must not be added together.

The numeric tables and measurements below are the historical preactivation PR #57/#58 baseline, not proof of the current selected-envelope write path. In that baseline, DTO bytes measured full inline envelopes. The 100/200/300 helper/source-text edits do not qualify actual batch/review/clinical-acceptance growth, PR #35 or heavy imports; see the separate [application mutation evidence](intake-mutation-qualification.md) and its release limits.

The [growth regression](../../src/server/test/source-details-search-growth.test.ts) starts with 10,097 UTF-8 bytes / 10,094 UTF-16 units of fictional JSON, including periodic text, Unicode and a literal escaped surrogate. It performs 300 actual one-character insertions in application transactions. Each change runs one source-list request before commit and two warm requests afterward; every request compares count and selected details with an independent old-SQL oracle. The details-only search term forces reconstruction in both count and page statements.

Initialization writes 3 content rows / 10,355 encoded bytes, 3 occurrences / 513 bytes, 3 links / 318 bytes and one 637-byte head. Initial accepted publication is 3 writes / 16,959 bytes; SQLite allocation is 413,696 bytes. The first request has two reconstructions / 20,194 UTF-8 bytes, 20 callback projection rows / 23,370 encoded bytes and one 10,097-byte DTO read. Upfront initialization reads the source authority once. The following cumulative update tables exclude this initialization unless described as totals.

| Changes | Content rows / bytes | Occurrence rows / bytes | Link rows / bytes | Head rows / bytes |
| ------: | -------------------: | ----------------------: | ----------------: | ----------------: |
|     100 |               1 / 84 |            102 / 17,239 |      201 / 24,010 |      100 / 63,992 |
|     200 |               1 / 84 |            202 / 34,239 |      401 / 48,210 |     200 / 128,292 |
|     300 |               1 / 84 |            302 / 51,239 |      601 / 72,410 |     300 / 192,592 |

Independent SQL audit triggers count actual inserted/updated payloads. Maximum changed row sizes are 84/172/122/643 bytes for content/occurrence/link/head. This fixture deletes no rows, shares the inserted character's content and visits one affected old reference plus two cleanup probes across all updates. Shared-content fanout, deletion and repair have separate storage regressions.

| Changes | Requests / reconstructions | Callback projection rows / bytes | Reconstructed UTF-8 bytes | DTO rows / details bytes |
| ------: | -------------------------: | -------------------------------: | ------------------------: | -----------------------: |
|     100 |                  300 / 600 |              68,400 / 14,560,902 |                 6,088,500 |          300 / 3,044,250 |
|     200 |                600 / 1,200 |             256,800 / 43,801,302 |                12,237,000 |          600 / 6,118,500 |
|     300 |                900 / 1,800 |             565,200 / 87,801,702 |                18,445,500 |          900 / 9,222,750 |

Callback source-row authority reads remain zero; durable readiness-head reads are separate below. Upfront maintenance reads and hashes each changed source once: 100/200/300 reads and 1,014,750/2,039,500/3,074,250 bytes. Selected DTO reads are additional full-envelope reads, as shown above. Binding reads equal reconstruction counts. Peak individual reconstructed strings grow to 10,197/10,297/10,397 bytes; retained text entries stay zero. Cumulative reconstructed UTF-16 units are 6,086,700/12,233,400/18,440,100.

| Changes | All projection rows / bytes read | Total SQLite allocation | Accepted writes / bytes written | Total retained accepted bytes |
| ------: | -------------------------------: | ----------------------: | ------------------------------: | ----------------------------: |
|     100 |              79,601 / 16,963,287 |               2,199,552 |                 300 / 1,252,168 |                     1,254,727 |
|     200 |             299,201 / 51,052,487 |               3,948,544 |                 600 / 2,515,118 |                     2,503,277 |
|     300 |            658,801 / 102,361,687 |               5,763,072 |                 900 / 3,788,068 |                     3,761,827 |

SQLite totals include source rows, accepted indexes and projection/index pages, not just changed text rows or filesystem usage. These allocation samples are dated 2026-10-03 and can vary with generated identities and SQLite. They are evidence about this fixture, not capacity thresholds.

| Changes | Engine existing-content bytes read | Engine hash bytes | Engine logically copied bytes | Engine reconstructed UTF-16 units |
| ------: | ---------------------------------: | ----------------: | ----------------------------: | --------------------------------: |
|     100 |                          9,088,197 |        29,759,424 |                    84,099,220 |                        10,144,200 |
|     200 |                         18,176,397 |        79,227,324 |                   229,564,870 |                        20,388,400 |
|     300 |                         27,264,597 |       148,495,224 |                   436,700,520 |                        30,732,600 |

Engine validation processes 10,100,247/20,210,497/30,330,747 UTF-16 units, exact comparisons process 1,014,450/2,038,900/3,073,350 units, and UTF-8 encoding processes 31,788,924/83,306,324/154,643,724 bytes. Automatic matching scans 5,086,241/10,202,291/15,368,341 units, compares 5,068,502/10,181,652/15,339,802 units, hashes 9,169,915/18,389,465/27,699,015 units and logically copies 1,014,750/2,039,500/3,074,250 bytes. It derives one operation per change, with no Myers trace or residual reuse in this fixture. Growing read/hash/reconstruction costs remain visible despite small changed rows; this does not prove computation proportional only to changed bytes.

The fixture also counts actual calls to its accepted-record `RecordStorage.read`, separating durable heads from immutable objects and isolating the reads made inside `sourceFiles` from oracle/mutation/publication work. Initialization makes 7 head reads / 720 returned bytes and 3 immutable-object reads / 33,197 bytes; two initial head reads return missing. Its first source-list request accounts for 3 head reads / 432 bytes and no immutable reads. The following table excludes initialization:

| Changes | All head reads / bytes | All immutable-object reads / bytes | Request-only head reads / bytes |
| ------: | ---------------------: | ---------------------------------: | ------------------------------: |
|     100 |        1,200 / 172,800 |                    300 / 2,418,250 |                   900 / 129,600 |
|     200 |        2,400 / 345,600 |                    600 / 4,857,850 |                 1,800 / 259,200 |
|     300 |        3,600 / 518,400 |                    900 / 7,317,450 |                 2,700 / 388,800 |

Each request in this fixture reads three readiness heads and no immutable history objects. No additional missing returns occur. Returned bytes equal bytes copied by the fixture's `Buffer.from`; these counts do not measure filesystem I/O, encryption or copies internal to the durability implementation. They must not be interpreted as zero durable reads merely because callback source-row authority reads are zero.

## Validation and qualification boundary

[Native v4 regressions](../../src/server/test/source-text-projection-v4.test.ts) compare real production count/page predicates and source HTTP header/export responses with independently retained raw SQLite text. They cover exact duplicate keys and escape spelling, bounded Unicode fragments, cold cache reads, local field edits, auxiliary churn, rollback, a binding changed during traversal, late missing evidence and accepted-journal rebuild. The [matcher oracle](../../src/server/test/source-details-like.test.ts) exercises UTF-16 chunk boundaries and SQLite's pattern-byte limit. These focused tests do not remove the public package metadata safeguards or qualify every import consumer.

[Focused regressions](../../src/server/test/source-details-search.test.ts) compare complete DTOs, count, membership and ordering against a frozen prechange SQL/DTO oracle across source kinds, filters, raw spelling, Unicode and serialized boundaries. They exercise actual HTTP responses, insertion/deletion, distant and periodic edits, reordering, rename, rollback, reopen, writer staging, lowered limits, profile binding, real encrypted copy, lock, cache loss, corrupt authority and multiple HTTP sessions. Controlled fictional fixtures establish neither physical passkey behavior nor full import capacity.

The [selected intake envelope authority](intake-envelope-authority.md) binds search reconstruction, complete DTOs and metadata filters to the original source's current chain, preserving complete envelope order and exact raw spelling until an authorized rewrite. Missing, corrupt or conflicting authority refuses; derived text cannot supply a fallback. The [application mutation/recovery measurements](intake-mutation-qualification.md) and current [verified-work reuse contract](intake-processing-work.md) disclose remaining host work separately from the repeated work avoided. This evidence does not qualify PR #35 or a heavy import retry.
