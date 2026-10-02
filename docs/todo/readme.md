# ✨ TODOs

This is the single work list. Keep ordinary items to an ID and a short description here. Add a separate CRS file when an item needs more room: its specification, proposal, owner decisions, open questions and review findings belong there. Fold review feedback into the items it concerns.

Numbers are stable identifiers, not priority. Never renumber or reuse an ID. After skipping active and retired tickets, CRS-211 is next. When a ticket's work lands, delete its entry and CRS file in the same change and describe the result in the maintained documentation. If only part landed, delete it anyway and open a new ticket for the rest, with context scoped to that remainder. Entries under Closed identifiers predate this practice; they preserve prior status and do not certify today's code. Research items retain their status pending a separate discussion; listing them does not authorize runs, paid inference or deployment.

CRS-195 through CRS-198 are allocated in the [pending scripted-runner work](https://github.com/mxbaylee/circus-health/pull/35); their retained qualification findings prompted the implemented [incremental conversation journal](../data/conversation-journal.md). The [compact history projection](../data/record-version-storage.md#compact-history-projection) and [incremental encrypted index](../security/vault-index.md) are also implemented. Intake-authority capacity and complete diagnostic retention remain open in that work.

Each open item carries an effort and an impact size (S, M or L; owner request, 2026-09-30). The sizes live only in this index, so there is one place to update. They inform prioritization but are not priority.

- **Effort** (🐭 S · 🐕 M · 🐘 L) counts the work the app's builders control: design, implementation and verification, including owner time for devices or provider runs. It is not calendar time, and never a bound on model work. 🐭 **S** is one focused change with its tests. 🐕 **M** is several coordinated changes, or one design choice within a known shape. 🐘 **L** needs design plus a multi-part implementation or migration, or many owner-run checks.
- **Impact** (🟢 S · 🟡 M · 🔴 L) is judged by the [personas](CRS-130.md). 🔴 **L** protects patient safety or data correctness: the wrong person, a lost or silently incomplete record, a wrong printed value. It also covers unblocking a main job for a main persona. 🟡 **M** is noticeable friction, cost or trust for a main persona. 🟢 **S** is internal quality, polish or an option to explore.
- 🚀 **production** marks work required before the app is relied on for real records. That means the owner's household using the supported local installation as their records store, on localhost; remote deployment is conditional on need (owner, 2026-10-01). Every release check is required, through the 🚦 CRS-061 gate. An unmarked item can still matter; it just doesn't block that use. ☂️ marks an umbrella specification that is sized by its tickets.
- Each ticket also has its own emoji, decoration only, reused as little as possible. Its CRS file's title carries the same emoji, and IDs stay the stable identifiers.

Application documentation describes implemented behavior and current limitations; future work, its specifications and its plans live here. Before deleting a ticket, carry its unmet requirements, owner decisions and open questions into a new or existing item.

Keep the reason for a decision as well as its resulting behavior: who it serves, the failure it prevents, its limits and any earlier rule it supersedes. On implementation, move that rationale into maintained behavior documentation before deleting the ticket, and repoint links. Non-obvious regression tests should include a short why comment tied to that rationale; a test's expected value alone is not the product decision record. Import/identity decisions are consolidated in [CRS-126 D5 and D8](CRS-126.md#d5-identity-evidence-human-decisions-and-incorrect-printed-dobs-are-different-facts) while open.

The detailed work list and design documents that preceded this index are archived at `2ae9a0f`: the [earlier work list](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/application-todo.md), [processing context proposal](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/processing-context-proposal.md), [import processing implementation specification](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/import-processing.md) and [integrated evidence review draft](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/import-evidence-review-draft.md). The deployment designs are linked from [CRS-083](CRS-083.md). They are history; the CRS items below are authoritative.

## <a id="picking-the-next-item"></a>🥇 Picking the next item

Add up the points; the highest score is next.

|            | 3 points  | 2 points | 1 point |
| ---------- | --------- | -------- | ------- |
| Production | 🚀 marked | —        | —       |
| Impact     | 🔴 L      | 🟡 M     | 🟢 S    |
| Effort     | 🐭 S      | 🐕 M     | 🐘 L    |

Scores run from 2 to 9. For example, 🚀 🔴 🐭 scores 9, 🚀 🔴 🐘 scores 7, and an unmarked 🟢 🐘 scores 2. The 🚦 gate and ☂️ umbrella entries are not picked; they close when their checks and tickets do.

1. **Skip what can't start yet.** An item that depends on an unfinished ticket waits for it. The agent does all the work, including code, tests, docs and verification harnesses. Some items also need an input only the owner can give: a physical device in hand, a sign-in or credential, authorization for paid inference or a run, or a decision. Those still rank normally. Do all the preparation, then ask once for exactly that input, saying what to tap, sign in to or approve. Work the next item while waiting.
2. **Break ties in this order:**
   1. an item whose finish unblocks another open item, named in its ticket;
   2. higher impact;
   3. lower effort;
   4. lower ID.
3. **Before starting, re-read the ticket and confirm it is still true.** If it lists owner decisions, ask them first, with its recommendations, and start once they are answered.
4. **When done, follow the practice above:** an independent grade per `AGENTS.md`, then delete the ticket or open a scoped remainder, which gets its own sizes.

Sizes and marks are estimates. When starting a ticket shows one is wrong, correct it here in the same change.

Open scoring proposal (review feedback, 2026-10-01): an earlier draft reportedly proposed a 🫀 user-flow mark worth 4 points. Confirm whether it was intentionally dropped or should be reconsidered, including how it combines with production/impact/effort and changes tie-breaking. This mark is not adopted; keep the current scoring and ranking until the owner records a decision. Do not treat a reported unpublished proposal as current policy.

Each open item shows its score after its sizes. When a size or mark changes, recompute its score in the same change.

### <a id="top-5"></a>🏆 Top 5

**Refresh this list in the same change whenever a ticket is added, closed or removed, or whenever a size, mark or dependency changes.** Apply the rules above: skip items that are waiting on an unfinished ticket, and break ties as in step 2. The last column says what the owner must provide; everything else is agent work.

| # | Ticket | Score | Tie-break | Owner input |
| --- | --- | --- | --- | --- |
| 1 | 🔐 [CRS-163](#crs-163) passkeys | 8 | 🔴, unblocks CRS-088, lower ID | Tap passkey prompts on the intended localhost desktop |
| 2 | 🗝️ [CRS-206](CRS-206.md) intake lookup indexes | 8 | 🔴, unblocks CRS-209, lower ID | None |
| 3 | 🔎 [CRS-207](CRS-207.md) exact source search | 8 | 🔴, unblocks CRS-209, lower ID | None |
| 4 | 🪴 [CRS-208](CRS-208.md) intake copy bootstrap | 8 | 🔴, unblocks CRS-209 | None |
| 5 | 💽 [CRS-152](#crs-152) deployment drive | 8 | 🔴 | Connect or choose the drive and adopted provider |

CRS-194 waits for [CRS-210](CRS-210.md) real-mutation qualification after [CRS-209](CRS-209.md) production cutover. These build on the implemented [access boundary](../import/intake-state-access.md), [transaction-backed primitive](../data/intake-state-storage.md), [compact history projection](../data/record-version-storage.md#compact-history-projection) and [incremental encrypted index](../security/vault-index.md). CRS-194 retains the remaining capacity and diagnostic qualification after the [conversation journal recheck](../data/conversation-journal.md#bounded-import-recheck); physical page delivery did not establish clinical completeness. Next up: 👥 [CRS-124](#crs-124) (8, owner layout input), 📦 [CRS-043](CRS-043.md) (7, split before implementation), 🩻 [CRS-062](#crs-062), 🥡 [CRS-068](#crs-068), ⚙️ [CRS-086](CRS-086.md), 🏷️ [CRS-139](CRS-139.md), and 🎨 [CRS-190](CRS-190.md) (7, 🔴). CRS-086 independently implements async processing and bounded context; CRS-194 prepares complete downloadable diagnostics before the owner's common 800–900-page trial, supplies its instrumented comparison baseline, and produces prioritized production follow-ups (owner, 2026-10-01). Preparatory async design can start while diagnostics readiness proceeds; CRS-194's current scripted 900-page baseline precedes writing CRS-086's full implementation specification, and does not wait for parallel workers. 🩺 [CRS-154](CRS-154.md) (7, 🟡) shares complaint/download validation. ♻️ [CRS-155](CRS-155.md) scores 8 but waits for natural token expiry. 🗂️ [CRS-150](CRS-150.md) waits for 🗂️ [CRS-175](CRS-175.md); 🧐 [CRS-073](#crs-073) waits for CRS-150.

Proposed focused-ticket divisions are recorded in [CRS-140](CRS-140.md#proposed-division-into-focused-tickets), [CRS-141](CRS-141.md#proposed-division-into-focused-tickets), [CRS-043](CRS-043.md#proposed-division-into-focused-tickets) and [CRS-139](CRS-139.md#proposed-division-into-focused-tickets). Their existing requirements remain authoritative; children need their own sizes, production marks, dependencies and acceptance checks before allocation. CRS-081 now scores 6 as a production requirement. Historical raw-assertion restoration is outside the current release scope: the owner requires no old-schema support before production (2026-10-01), and current imports use the existing reviewed intake path; see [retained ownership limits](../../src/server/NOTE-EXPORTS.md#historical-raw-assertion-ownership). Conditions are active by owner request, 2026-10-01: [Condition storage](../data/data-model-contracts.md#condition-occurrence-storage) is implemented; CRS-173/174 supply reviewed records and personal status, and CRS-175 supplies the packet dependency. CRS-194 unblocks CRS-086 validation; retained recorder/export recovery, [per-request input composition counts](../import/import-performance.md#request-input-composition), [known loss checkpoints](../import/import-performance.md#retained-window-checkpoints), [known persisted-event omission accounting](../import/import-performance.md#known-persisted-event-omissions) [encrypted collection origins](../import/import-performance.md#encrypted-collection-origins) and a [manual recording check](../import/import-performance.md#manual-recording-check) are implemented, and a [fictional 900-page fixture/oracle](../import/import-performance.md#fictional-large-import-fixture) and [proposal/review reconciliation with bounded two-person identity qualification](../import/import-performance.md#large-import-proposal-reconciliation) are available; [bounded accepted-record/replay/cache-loss reconciliation](../import/import-performance.md#large-import-accepted-record-reconciliation) is implemented, while full-size processing, recovery and diagnostic coverage remain unqualified.

## <a id="product-and-maintenance"></a>🛠️ Product and maintenance

- [ ] <a id="crs-206"></a> 🗝️ [CRS-206](CRS-206.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Implement compact disposable discovery, acceptance-replay and identity-confirmation indexes through the current access boundary; unblocks CRS-209. Reassess and split before implementation if still high effort.
- [ ] <a id="crs-207"></a> 🔎 [CRS-207](CRS-207.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Preserve exact serialized source-search semantics with change-local derived storage and durable order parity; unblocks CRS-209. Reassess and split before implementation if still high effort.
- [ ] <a id="crs-208"></a> 🪴 [CRS-208](CRS-208.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Prepare destination-profile intake evidence before private-copy initial publication; unblocks CRS-209. Reassess and split before implementation if still high effort.
- [ ] <a id="crs-209"></a> 🧬 [CRS-209](CRS-209.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Activate incremental intake authority across all consumers, transactions and copy paths; waits for CRS-206/207/208, unblocks CRS-210. Reassess and split before implementation if still high effort.
- [ ] <a id="crs-210"></a> 📐 [CRS-210](CRS-210.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Qualify actual batch/review/acceptance mutation growth and recovery with complete storage accounting; waits for CRS-209, unblocks CRS-194. Reassess and split before implementation if still high effort.

- [ ] <a id="crs-173"></a> 🩹 [CRS-173](CRS-173.md) · 🐘 L · 🔴 L · score 4 — Review and accept literal condition occurrences with person/source scope, corrections and history; builds on the implemented storage table. Active by owner request, 2026-10-01; split before implementation or owner grade before merge.
- [ ] <a id="crs-174"></a> 🗒️ [CRS-174](CRS-174.md) · 🐘 L · 🔴 L · score 4 — Separate personal condition confirmations and Conditions UI; follows CRS-173. Visits remain notes. Split before implementation or owner grade before merge.
- [ ] <a id="crs-175"></a> 🗂️ [CRS-175](CRS-175.md) · 🐘 L · 🔴 L · score 4 — Qualify personally confirmed conditions in packets, exclusions and recovery; follows CRS-173/174 and unblocks CRS-150. Allergy scope remains open; split before implementation or owner grade before merge.

- [ ] <a id="crs-139"></a><a id="crs-090"></a> 🏷️ [CRS-139](CRS-139.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Make remembered name owners visible, revocable and unable to outrank another person's own name; release holds on later whole-report corrections; finish ownership-correction tests, including ambiguous confirmed-name remembering (remainder of CRS-134; CRS-090's remainder, with its real-file part in [CRS-062](#crs-062)).
- [ ] <a id="crs-140"></a> 🧊 [CRS-140](CRS-140.md) · 🐘 L · 🟡 M · 🚀 production · score 6 — Cool repeated timeouts on one unit with longer backoff, lower concurrency or a longer deadline behind a non-blocking status, never a stop or attempt cap (owner, 2026-09-30); detect provider sign-in without a click, stop journaling unchanged waits, and finish continuation tests (remainder of CRS-135).
- [ ] <a id="crs-141"></a> 💾 [CRS-141](CRS-141.md) · 🐘 L · 🟡 M · score 3 — Keep partial saves linear on large intakes, keep coupled groups together above the cap, name the person on saved outcomes, and finish coverage (remainder of CRS-136).
- [ ] <a id="crs-133"></a> 🎂 [CRS-133](CRS-133.md) · 🐕 M · 🟡 M · score 4 — Allow an explicit report-scoped assignment despite an incorrect printed DOB, preserving originals, demographics and the reason for the human exception.
- [ ] <a id="crs-043"></a> 📦 [CRS-043](CRS-043.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — If the app can store a file, it can import it: stream ZIP members and extraction to disk, replace the upload cap with a free-disk or operator-set storage check, and keep rather than reject a file that cannot be processed yet.
- [ ] <a id="crs-144"></a> 🪪 [CRS-144](CRS-144.md) · 🐘 L · 🟡 M · score 3 — Design and run one versioned migration of the clinical, candidate and report-group identity keys: define equivalence, stop running headers splitting reports and explain any remaining split, map drafts, receipts, exceptions and rebuild, then restore cross-member consolidation; never merge records across people (merges CRS-042 and CRS-046).
- [ ] <a id="crs-080"></a> 📸 **CRS-080** · 🐭 S · 🟢 S · score 4 — Add test-only capture of a real fictional run's proposals as downstream fixtures, beside the hand-written `fictional-*-proposals.ts`; fresh quality and work-count measurements must bypass replay.
- [ ] <a id="crs-081"></a> 🌙 [CRS-081](CRS-081.md) · 🐘 L · 🟡 M · 🚀 production · score 6 — Extend the implemented automatic coordinator with scoped authority after lock/logout/profile switch to complete the decided background-import experience and its joint release journeys; dependent recovery checks need CRS-140.
- [ ] <a id="crs-084"></a> 🛡️ [CRS-084](CRS-084.md) · 🐕 M · 🟡 M · 🚀 production · score 7 — Prioritize unresolved security risks and mitigations without describing proposed controls as existing protection.
- [ ] <a id="crs-086"></a> ⚙️ [CRS-086](CRS-086.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Independently implement async artifact processing with bounded context, shared extraction, safe adaptive concurrency and usable foreground chat/browsing/review; CRS-194 supplies diagnostics and the large-document baseline. Progressive review is a separate proposal pending its publication policy.
- [ ] <a id="crs-088"></a> 👆 [CRS-088](CRS-088.md) · 🐕 M · 🟡 M · score 4 — Quick passkey sign-in without choosing a profile first: a username-less request, one app-wide PRF salt migrated at the next unlock, while retaining origin checks, profile isolation and locked state after restart.
- [ ] <a id="crs-089"></a> 🪶 [CRS-089](CRS-089.md) · 🐕 M · 🟡 M · score 4 — Make the model gateway lighter and less patched: measure LiteLLM's memory, tune it first, and weigh replacements such as Bifrost (blocked on subscription sign-in) only if tuning falls short.
- [ ] <a id="crs-112"></a> 🧹 **CRS-112** · 🐭 S · 🟢 S · score 4 — Remove blank-Self-field filling from import confirmation; use normal profile editing/setup and keep old receipts readable.
- [ ] <a id="crs-114"></a> 🪓 [CRS-114](CRS-114.md) · 🐭 S · 🟢 S · score 4 — Remove the repository inventory checker and separately verified dead code, preserving live dynamic, worker, deployment and test entry points.
- [ ] <a id="crs-115"></a> 📜 [CRS-115](CRS-115.md) · 🐘 L · 🟡 M · score 3 — Qualify complete durable source text, located uncertainty, reading order, tables, search and no-AI recovery across difficult document strata.
- [ ] <a id="crs-116"></a> 🔍 [CRS-116](CRS-116.md) · 🐘 L · 🟡 M · score 3 — Improve evidence review, omission detection, bounded editing and measured human review burden.
- [ ] <a id="crs-128"></a> #️⃣ [CRS-128](CRS-128.md) · 🐕 M · 🟡 M · score 4 — Verify each retained original without a full synchronous hash after every restart: keep verification across restarts and move any full hash that remains off the request path.
- [ ] <a id="crs-129"></a> 🖋️ [CRS-129](CRS-129.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Record which source revision and verification state each proposal and accepted record was built from, separately from the staleness pin.
- [ ] <a id="crs-130"></a> 🎭 [CRS-130](CRS-130.md) · 🐕 M · 🟡 M · score 4 — Write the personas from what is known now, each with checks against today's app marked verified or unverified.
- [ ] <a id="crs-121"></a> 💊 **CRS-121** · 🐘 L · 🔴 L · score 4 — Build the medication and vocabulary rules decided in [CRS-126](CRS-126.md#dates), [medications](CRS-126.md#medications) and [standard vocabularies](CRS-126.md#standard-vocabularies): offline RxNorm matching against the saved list that shows only new medications, a "Document says stopped" suggestion, never deactivating on omission, first-of-period date proposals for approval with the printed date visible, and bundled offline LOINC/RxNorm (P16). No LOINC/RxNorm matching exists yet; imported prescriptions already start inactive and printed date precision is kept.
- [ ] <a id="crs-142"></a> 🐛 [CRS-142](CRS-142.md) · 🐕 M · 🟢 S · score 3 — Add error matchers to bare throw assertions, fail loudly on old `HEALTH_*` test opt-ins, decide whether CI installs Tesseract or OCR is qualified only in the image, resolve the `PDF_NATIVE_PAGE_LIMIT` flake, add the missing R40 route denial cases, and cover Import deep links and the historical Sources redirect in an encrypted browser journey (remainder of CRS-122 and CRS-041).
- [ ] <a id="crs-123"></a> 🧽 **CRS-123** · 🐭 S · 🟢 S · score 4 — Narrow or justify the broad legacy-variable rejection (`deploy/run.ts` `oldLauncherKeys` and the `HEALTH_`/`CIRCUS_` loop); make proxy-diagnostics flags consistent across `configure.py`, `compose.yaml` and `environment.md`; review noisy diagnostics routes; recheck `import/import-performance.md:3` (R48). Correct stale docs: `environment.md:84` still describes `CRS_CODEX_INTEGRATION_TEST`, removed from CI in `3a8b076`; `import/import-reconciliation.md:9-11` pauses on "a time/context limit" and "exhausted windows", contradicting CRS-126 D2/D3 and [automatic recovery](../import/automatic-recovery.md), and `:17` limits upload review to Self-confirmed records, contradicting D1; the tracked root `prompt.txt` points at missing `docs/application-todo.md` and `docs/workspace-and-handoffs.md`. Coordinate with CRS-142's `HEALTH_*` opt-ins.
- [ ] <a id="crs-125"></a> 📅 **CRS-125** · 🐕 M · 🟢 S · score 3 — Consolidate calendar-date validation into `src/shared/clinical-date.ts`, replacing the local copies in `CollectionFilters.tsx`, `format.ts`, `person-fields.ts`, `notes.ts` and `intake-evidence-dates.ts`; file DTO/form, server-safe formatting, filter/modal and HTTP/error duplicates separately once each has concrete locations.
- [ ] <a id="crs-126"></a> 📥 [CRS-126](CRS-126.md) · ☂️ umbrella: sized by its tickets — Meet the import specification: never drop a record, other people's records welcome, no size or time limits, waits are backoffs, writes scale with change.
- [ ] <a id="crs-127"></a> 🖼️ **CRS-127** · 🐕 M · 🟡 M · score 4 — Read HEIC and multi-page TIFF uploads automatically, as [CRS-126](CRS-126.md#receiving-and-formats) requires; today they are unsupported (the readable formats in `isRetainOnlyIntake`, `shared/intake-source-policy.ts`, and the image types in `extractSourceStep`, `intake-source-extraction.ts`; reliability R36).
- [ ] <a id="crs-143"></a> 🕰️ [CRS-143](CRS-143.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Decide and show which record is current when corrections and new versions arrive; today the importer does not infer it and the chart has no outdated display (CRS-126 scenario 5).
- [ ] <a id="crs-146"></a> 👣 [CRS-146](CRS-146.md) · 🐕 M · 🟡 M · score 4 — Log every sign-in (unlock) and failed attempt and show them clearly to the patient on their next sign-in; failed attempts happen before unlock, so they need a small separate log with no health data.
- [ ] <a id="crs-150"></a> 🗂️ [CRS-150](CRS-150.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Offer job-based packet presets, per-category and per-record exclusions, a generic withheld-record disclosure and a one-page emergency summary; annual and emergency current-condition lists depend on [CRS-175](CRS-175.md). Remainder of CRS-147.
- [ ] <a id="crs-157"></a> 🧮 [CRS-157](CRS-157.md) · 🐕 M · 🟡 M · 🚀 production · score 7 — Establish model-pass baselines for legacy queued/running batch journals from durable provenance, avoiding redundant billed replay without skipping new capture. Current-format and legacy review-ready baselines are implemented (remainder of CRS-118).
- [ ] <a id="crs-194"></a> 📈 [CRS-194](CRS-194.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Before an owner's common 800–900-page trial, verify complete downloadable AI/import/processing/UX diagnostics, establish an instrumented baseline and turn findings into prioritized production tickets; unblocks CRS-086's measured comparison and supports CRS-154 complaint reconstruction.
- [ ] <a id="crs-148"></a> 🧳 [CRS-148](CRS-148.md) · 🐘 L · 🟡 M · score 3 — Export everything in a portable form, Takeout-style: originals, records, notes, corrections and history, with a manifest, for moving storage or keeping a checkpoint elsewhere.
- [ ] <a id="crs-149"></a> 🎣 [CRS-149](CRS-149.md) · 🐭 S · 🟡 M · score 5 — Confirm and show the destination of external links in assistant text (warn when a link carries data), and test that one session's unlock never grants another session access.


## <a id="release-and-usability-checks"></a>✅ Release and usability checks

<a id="crs-060"></a>**CRS-060** — Validate each layer on its own: server, mounted, encrypted browser and real provider. CI already runs the server, UI, browser, continuation, deploy, brand and offline-proxy lanes (`code-checks.yml`); one layer never substitutes for another. The agent prepares and runs every check and records its evidence. The owner supplies only what an agent cannot: taps and gestures on physical phones and authenticators for the phone and passkey checks, the deployment drive, provider sign-ins and credentials for OAuth refresh and the route and import checks, and authorization for paid runs. The printed output needs nothing from the owner.

- [ ] <a id="crs-061"></a> 🏁 **CRS-061** · 🚦 gate · 🚀 production — Release gate: every check below passes on the release build; a mock, viewport simulation or partial extraction closes none. Includes CRS-190’s design/product/accessibility UI/UX review, requalification of affected flows and closure of all launch-blocking findings; these requirements survive retirement of the audit ticket. Also includes CRS-081's scoped continuation and joint journeys and CRS-086's async/foreground-usability acceptance. After their implementation and all identified large-import production blockers land, requalify the release workflow on fictional direct-upload PDFs of about 800 pages/115 MB and 900 pages/15 MB on the adopted route: complete page accounting, oracle-checked clinical facts and ownership, review/acceptance, interruption/recovery, original retention and cache-loss rebuild, usable foreground requests, and a full-run diagnostic download that reconstructs early/late problems. Require current independently passing evidence; this requirement survives deletion of the CRS-194 investigation ticket. Paid full-size inference needs the owner's approval.
- [ ] <a id="crs-190"></a> 🎨 [CRS-190](CRS-190.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Audit the full release UI for visual/theme consistency, accessibility and persona-based task usability through independent design/product reviews; cover all surfaces/states and complete flows, then scope fixes and preserve launch blockers in CRS-061. Split before execution or obtain owner grading for high-effort implementation.
- [ ] <a id="crs-055"></a><a id="crs-014"></a><a id="crs-056"></a> 📱 **CRS-055**, with CRS-014 and CRS-056 · 🐕 M · 🟡 M · 🚀 production · score 7 — Phones and browsers: phone-specific checks apply when phone access is adopted (localhost is the current release scope, owner 2026-10-01); on those physical devices, Files/Photos, virtual keyboard, screen reader, zoom, rotation, upload interruption, background return and lock recovery; in the release browsers, real tab and home-screen icons at small size and a live OS Light/Dark flip. Icon generation and theme logic are already tested.
- [ ] <a id="crs-163"></a> 🔐 [CRS-163](CRS-163.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Complete physical passkey qualification on the intended localhost desktop, authenticators, repeated unlock, recovery and recreation; remote HTTPS/phone origins are conditional on adopting that deployment. A headed Chrome/Edge journey driver is implemented (remainder of CRS-072).
- [ ] <a id="crs-152"></a> 💽 [CRS-152](CRS-152.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Finish deployment qualification: real provider authentication persistence across recreation and a complete fictional import on the chosen filesystem. Host/container mount probes are implemented (remainder of CRS-071).
- [ ] <a id="crs-155"></a> ♻️ [CRS-155](CRS-155.md) · 🐭 S · 🟡 M · 🚀 production · score 8 — Complete live natural-expiry refresh qualification for each adopted OAuth route; the guarded runner and fresh-container persistence check are ready, but an unexpired access token cannot establish refresh.
- [ ] <a id="crs-065"></a><a id="crs-064"></a><a id="crs-076"></a> 🛣️ **CRS-065**, with CRS-064 and CRS-076 · 🐕 M · 🟡 M · 🚀 production · score 7 — Route capabilities: per adopted hosted and Ollama route, with fictional content, alias and model identity, tools, images, native PDF, same-page PNG fallback and text-only coverage gaps, credential isolation, and proxy retention and logging. Never silently change providers or weaken local-only settings; the proxy configuration's rejections are already tested.
- [ ] <a id="crs-066"></a><a id="crs-077"></a><a id="crs-078"></a> 🚧 **CRS-066**, with CRS-077 and CRS-078 · 🐕 M · 🟡 M · 🚀 production · score 7 — Route workflows and failures: per route, from an empty fictional profile, chat, import, questions, acceptance, correction, opening the original, recreation and cache-loss rebuild, including an unavailable provider, cancellation, malformed tool output, rate limits and an explicit alias change with a saved conversation. Live runs are opt-in (`qualify-provider-pdf.ts`); unavailable credentials or routes stay explicit gaps.
- [ ] <a id="crs-062"></a><a id="crs-058"></a><a id="crs-067"></a> 🩻 **CRS-062**, with CRS-058 and CRS-067 · 🐘 L · 🔴 L · 🚀 production · score 7 — Complete-file imports: two consecutive complete real-route runs each of a DEXA PDF, an optical image and a full record PDF on fresh fictional profiles, graded against the literal oracle, with no hidden repair: no missing, extra or duplicate records; exact fields, units, dates, ownership, provenance, original hashes and page coverage; identical accepted records after cache rebuild; order versus performed-event and category-scope cases. Any accepted row showing Unknown source despite a confirmed report source fails (from CRS-045); include ambiguous confirmed-name remembering (from CRS-090) and repeated complete-file review (from CRS-033).
- [ ] <a id="crs-068"></a><a id="crs-069"></a><a id="crs-070"></a> 🥡 **CRS-068**, with CRS-069 and CRS-070 · 🐘 L · 🔴 L · 🚀 production · score 7 — Supported-size takeout through the real route: upload, overlapping reading, interruption and restart, retained questions, acceptance and original reopening, including overlapping PDF/HTML/package evidence, attachments, duplicates and later evidence that updates pending candidates or proposes reviewed versions of accepted records, and reconciliation with records created manually (moved from CRS-116). Nothing is lost or falsely merged; later-evidence work preserves the implemented measured source dependencies.
- [ ] <a id="crs-073"></a> 🧐 **CRS-073** · 🐭 S · 🟡 M · 🚀 production · score 8 — Printed output: inspect the released visit brief, provider packet and evidence JSON as rendered PDF pages, after [CRS-150](CRS-150.md) changes what is printed.
- [ ] <a id="crs-037"></a><a id="crs-033"></a> 🖱️ **CRS-037** · 🐭 S · 🟢 S · 🚀 production · score 7 — On supported browsers, verify drag-and-drop of files from the operating system's file manager into Import. Over one long multi-file real-provider run, verify the strip's unit/exception counts and rate-based estimate stay truthful across turn resets and backoffs (absorbs CRS-033).
- [ ] <a id="crs-154"></a> 🩺 [CRS-154](CRS-154.md) · 🐕 M · 🟡 M · 🚀 production · score 7 — Reconstruct a live provider complaint from a protected, private-safe diagnostics export through review and post-recovery inspection; the tiny fictional lifecycle oracle is available, but complaint and browser-download evidence remain.
- [ ] <a id="crs-124"></a> 👥 **CRS-124** · 🐭 S · 🟡 M · 🚀 production · score 8 — With the owner, check that non-Self people are visibly distinct, long and identical names, keyboard and narrow layouts, and whether prescription/procedure summaries are useful. Interrupted saves are covered by [CRS-141](CRS-141.md).

## <a id="deferred-options"></a>💤 Deferred options

- [ ] <a id="crs-082"></a> 🎞️ **CRS-082** · 🐘 L · 🟢 S · score 2 — Explore interpreting DICOM and media, which are retain-only today (`isRetainOnlyIntake`), and structured exports beyond what CRS-126 specifies for FHIR/C-CDA; originals stay and unsupported interpretation stays explicit. HEIC/TIFF is CRS-127.
- [ ] <a id="crs-083"></a> ☁️ [CRS-083](CRS-083.md) · 🐘 L · 🟡 M · score 3 — Explore private home/cloud placement and hosted readiness without changing the supported local Compose installation or provisioning services.
- [ ] <a id="crs-110"></a> 🏭 **CRS-110** · 🐘 L · 🟢 S · score 2 — Consider a separate processing service only if CPU contention counted under CRS-109 or a chosen hosted deployment justifies it; retain profile-key isolation.
- [ ] <a id="crs-145"></a> 🆘 [CRS-145](CRS-145.md) · 🐘 L · 🟡 M · score 3 — Explore emergency-contact "break-glass" access: a logged, emailed one-time code the patient sees next sign-in, using a key the patient grants in advance; owner-led, lower priority.

## <a id="experiment-related-items--pending-review"></a>🧪 Experiment-related items — pending review

The [experiment material](../experiments/README.md) is retained separately. No broad new study is a prerequisite for CRS-086.

<a id="crs-079"></a><a id="crs-091"></a><a id="crs-092"></a><a id="crs-102"></a><a id="crs-103"></a>CRS-079, CRS-091, CRS-092, CRS-102 and CRS-103 are folded into [CRS-086](CRS-086.md)'s measurement acceptance: counted requests, retries, tokens and rereads on one long fictional import, and one paired comparison of record quality and work per document.

- [ ] <a id="crs-044"></a> 🕳️ **CRS-044** · 🐕 M · 🟢 S · score 3 — Measure actual zero-yield pages during complete provider imports against independent ground truth, in the same run as CRS-086's measurement; do not use sparse text as permission to skip.
- [ ] <a id="crs-087"></a> 📑 **CRS-087** · 🐕 M · 🟢 S · score 3 — Assess whether PDF text-layer headings can support bounded report/table context, feeding CRS-086's unit-of-work question; do not change page-skipping policy.
- [ ] <a id="crs-099"></a> 🧮 **CRS-099** · 🐭 S · 🟢 S · score 4 — With separate owner authorization, the owner runs the counts-only reducer (`src/scripts/processing-library-counts.ts`) on a diagnostics export of the private library; publish counts only, never names, values, dates, filenames or paths.
- [ ] <a id="crs-104"></a> 🪙 **CRS-104** · 🐭 S · 🟢 S · score 4 — Measure achieved provider cache share as cached input tokens over input tokens per request, per route, rather than assuming cached-token savings.
- [ ] <a id="crs-106"></a> 🗜️ **CRS-106** · 🐭 S · 🟢 S · score 4 — Only if CRS-086 adopts a stage-one or compaction design, measure page-reading output size and whether compaction preserves useful evidence.
- [ ] <a id="crs-107"></a><a id="crs-105"></a> 📏 **CRS-107** · 🐕 M · 🟢 S · score 3 — Verify route limits and measure token estimation, including attached-media tokens per fictional page (absorbs CRS-105), on representative content types; model claims are not account-limit evidence.
- [ ] <a id="crs-109"></a><a id="crs-094"></a> 🤼 **CRS-109** · 🐕 M · 🟢 S · score 3 — Only when worker contention is observed, count concurrent units, queue depth, retries and 429/5xx responses, proxy health-check failures and CPU-throttle events, and report answered interactive requests as a ratio to an idle baseline on the same machine (absorbs CRS-094; its historical sweep is not a prerequisite for CRS-086).
- [ ] <a id="crs-113"></a> 🧭 **CRS-113** · 🐕 M · 🟢 S · score 3 — Compare model-suggested reading scope with validated defaults; preserve the historical experiment as unresolved, not an implementation prerequisite.

## <a id="closed-identifiers"></a>🗄️ Closed identifiers

- [x] <a id="crs-001"></a> 📖 **CRS-001** — Product README.
- [x] <a id="crs-002"></a> 🧰 **CRS-002** — Installation and deployment guides.
- [x] <a id="crs-003"></a> 📚 **CRS-003** — Curate permanent documentation.
- [x] <a id="crs-004"></a> 🍂 **CRS-004** — Remove obsolete skills carefully.
- [x] <a id="crs-005"></a> 🚪 **CRS-005** — Maintainer entry points.
- [x] <a id="crs-006"></a> 🔷 **CRS-006** — Complete JavaScript-to-TypeScript migration in one coordinated effort.
- [x] <a id="crs-007"></a> ⚖️ **CRS-007** — MIT and public repository checks.
- [x] <a id="crs-008"></a> 🔘 **CRS-008** — Audit buttons and implement shared variants.
- [x] <a id="crs-009"></a> 💁 **CRS-009** — Contextual help.
- [x] <a id="crs-010"></a> 🔌 **CRS-010** — Shared Moxie diagnostics dialog.
- [x] <a id="crs-011"></a> 🎨 **CRS-011** — Preserve the approved visual foundation.
- [x] <a id="crs-012"></a> ✏️ **CRS-012** — One editable logo source.
- [x] <a id="crs-013"></a> 🔣 **CRS-013** — Reproducible icon exports and head metadata.
- [x] <a id="crs-015"></a> 🗂️ **CRS-015** — Curated icon search vocabulary.
- [x] <a id="crs-016"></a> 💡 **CRS-016** — Readable starter suggestions.
- [x] <a id="crs-017"></a> 🧵 **CRS-017** — Correct conversation context.
- [x] <a id="crs-018"></a> 💬 **CRS-018** — One coherent assistant response.
- [x] <a id="crs-019"></a> ⏰ **CRS-019** — Useful message time.
- [x] <a id="crs-020"></a> 🗃️ **CRS-020** — Profile actions in three clear groups (superseded layout; see CRS-021).
- [x] <a id="crs-021"></a> 🪜 **CRS-021** — Consistent profile button hierarchy (approved follow-up).
- [x] <a id="crs-022"></a> 👋 **CRS-022** — Welcoming front page.
- [x] <a id="crs-023"></a> 🔔 **CRS-023** — Entry and activity.
- [x] <a id="crs-024"></a> 🧱 **CRS-024** — Durable report groups.
- [x] <a id="crs-025"></a> 🎟️ **CRS-025** — Stable review queue.
- [x] <a id="crs-026"></a> 1️⃣ **CRS-026** — Review common facts once.
- [x] <a id="crs-027"></a> 🤏 **CRS-027** — Compact clinical review.
- [x] <a id="crs-028"></a> 📎 **CRS-028** — Original evidence on demand.
- [x] <a id="crs-029"></a> 🔢 **CRS-029** — Explicit counted acceptance.
- [x] <a id="crs-030"></a> 🎛️ **CRS-030** — Clear completion and controls.
- [x] <a id="crs-031"></a> 👓 **CRS-031** — Bounded complete reading.
- [x] <a id="crs-032"></a> 🔬 **CRS-032** — Extraction and projection correctness.
- [x] <a id="crs-034"></a> 🔗 **CRS-034** — Connect retained shared context to review proposals.
- [x] <a id="crs-035"></a> 🛟 **CRS-035** — Explain and verify background recovery.
- [x] <a id="crs-036"></a> 🧑‍🤝‍🧑 **CRS-036** — Reviewed imports for named People (approved).
- [x] <a id="crs-047"></a> 🐳 **CRS-047** — Container hardening fallout on existing consumers.
- [x] <a id="crs-048"></a> 🪢 **CRS-048** — Surface possible related saved records.
- [x] <a id="crs-049"></a> 🤝 **CRS-049** — Explicit relationship decisions.
- [x] <a id="crs-050"></a> ↔️ **CRS-050** — Correct either side.
- [x] <a id="crs-051"></a> 📝 **CRS-051** — Source amendments and downstream visibility.
- [x] <a id="crs-052"></a> 📐 **CRS-052** — Derived normalization model.
- [x] <a id="crs-053"></a> 🎲 **CRS-053** — Rounding and uncertainty.
- [x] <a id="crs-054"></a> 📊 **CRS-054** — Consistent comparisons and charts.
- [x] <a id="crs-057"></a> 🤖 **CRS-057** — Independent agent iteration.
- [x] <a id="crs-059"></a> 🔁 **CRS-059** — Recovery and version tests.
- [x] <a id="crs-074"></a> 🕸️ **CRS-074** — Controlled proxy topology.
- [x] <a id="crs-075"></a> 🙋 **CRS-075** — Verified account sign-in and reuse.
- [x] <a id="crs-093"></a> 🪥 **CRS-093** — Measure prefix hygiene savings.
- [x] <a id="crs-095"></a> 🐾 **CRS-095** — Test re-export fingerprinting on re-rendered fictional charts.
- [x] <a id="crs-096"></a> 🗓️ **CRS-096** — Classify date roles for date cutoffs without AI.
- [x] <a id="crs-097"></a> 🦉 **CRS-097** — Count identity prompts with grouping and remembered spellings.
- [x] <a id="crs-098"></a> 💥 **CRS-098** — Inject faults to test unattended completion.
- [x] <a id="crs-100"></a> 📷 **CRS-100** — Evaluate local OCR for scans and photos.
- [x] <a id="crs-101"></a> 🦥 **CRS-101** — Withdrawn: matched re-export skipping experiment; never executed.
- [x] <a id="crs-108"></a> 🕵️ **CRS-108** — Test a pre-AI identity check from printed name and birth date.

## <a id="legacy-ids"></a>🏛️ Legacy IDs

The aliases below refer to the old backlog namespace. They are separate from security risk IDs and the later reliability review’s R1–R52 labels, whose open requirements are recorded in CRS-086, 118, 123, 126, 127 and 139–142. Implemented import recovery behavior and rationale live in [automatic import recovery](../import/automatic-recovery.md). An alias whose ticket closed or merged names the ticket or documentation that received its remainder.

- `R1` → [CRS-001](#crs-001); `R2` → [CRS-002](#crs-002); `R3` → [CRS-003](#crs-003); `R4` → [CRS-004](#crs-004); `R5` → [CRS-005](#crs-005); `R6` → [CRS-006](#crs-006); `R7` → [CRS-007](#crs-007).
- `U1` → [CRS-008](#crs-008); `U2` → [CRS-009](#crs-009); `U3` → [CRS-010](#crs-010); `U4` → [CRS-011](#crs-011); `U5` → [CRS-012](#crs-012); `U6` → [CRS-013](#crs-013); `U7` → [CRS-014](#crs-014); `U8` → [CRS-015](#crs-015).
- `M1` → [CRS-016](#crs-016); `M2` → [CRS-017](#crs-017); `M3` → [CRS-018](#crs-018); `M4` → [CRS-019](#crs-019).
- `P1` → [CRS-020](#crs-020); `P3` → [CRS-021](#crs-021); `P2` → [CRS-022](#crs-022).
- `I1` → [CRS-023](#crs-023); `I2` → [CRS-024](#crs-024); `I3` → [CRS-025](#crs-025); `I4` → [CRS-026](#crs-026); `I5` → [CRS-027](#crs-027); `I6` → [CRS-028](#crs-028); `I7` → [CRS-029](#crs-029); `I8` → [CRS-030](#crs-030); `I9` → [CRS-031](#crs-031); `I10` → [CRS-032](#crs-032); `I11` → CRS-033, merged into [CRS-037](#crs-037) and [CRS-062](#crs-062); `I12` → [CRS-034](#crs-034); `I13` → [CRS-035](#crs-035); `I14` → [CRS-036](#crs-036); `I15` → [CRS-037](#crs-037); `I16` → [CRS-154](CRS-154.md); `I17` → [automatic recovery](../import/automatic-recovery.md); `I18` → CRS-040, closed: [identity review](../import/identity-review.md); `I19` → CRS-041, remainder in [CRS-142](#crs-142); `I20` → CRS-042, merged into [CRS-144](#crs-144); `I22` → [CRS-043](#crs-043); `I23` → [CRS-044](#crs-044); `I21` → CRS-045, remainder in [CRS-062](#crs-062); `I24` → CRS-046, merged into [CRS-144](#crs-144); `I25` → [CRS-047](#crs-047).
- `C1` → [CRS-048](#crs-048); `C2` → [CRS-049](#crs-049); `C3` → [CRS-050](#crs-050); `C4` → [CRS-051](#crs-051).
- `N1` → [CRS-052](#crs-052); `N2` → [CRS-053](#crs-053); `N3` → [CRS-054](#crs-054).
- `T1` → [CRS-055](#crs-055); `T2` → [CRS-056](#crs-056); `T3` → [CRS-057](#crs-057); `T4` → [CRS-058](#crs-058); `T5` → [CRS-059](#crs-059); `T6` → [CRS-060](#crs-060); `T7` → [CRS-061](#crs-061); `T8` → [CRS-062](#crs-062).
