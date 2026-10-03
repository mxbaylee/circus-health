# ✨ TODOs

This is the single work list. Keep ordinary items to an ID and a short description here. Add a separate CRS file when an item needs more room: its specification, proposal, owner decisions, open questions and review findings belong there. Fold review feedback into the items it concerns.

Numbers are stable identifiers, not priority. Never renumber or reuse an ID. After skipping active and retired tickets, CRS-230 is next. When a ticket's work lands, delete its entry and CRS file in the same change and describe the result in the maintained documentation. If only part landed, delete it anyway and open a new ticket for the rest, with context scoped to that remainder. Entries under Closed identifiers predate this practice; they preserve prior status and do not certify today's code. Research items retain their status pending a separate discussion; listing them does not authorize runs, paid inference or deployment.

CRS-195 through CRS-198 are allocated in the [pending scripted-runner work](https://github.com/mxbaylee/circus-health/pull/35); their retained qualification findings prompted the implemented [incremental conversation journal](../data/conversation-journal.md). The [compact history projection](../data/record-version-storage.md#compact-history-projection) and [incremental encrypted index](../security/vault-index.md) are also implemented. Intake-authority capacity and complete diagnostic retention remain open in that work. CRS-197’s renderer/generation fix is [implemented](../import/import-performance.md#portable-raster-table-rendering); its blocked full processing attempt remains CRS-212. The draft has retired CRS-197 with that remainder preserved.

Each open item carries an effort and an impact size (S, M or L; owner request, 2026-09-30). The sizes live only in this index, so there is one place to update. They inform prioritization but are not priority.

- **Effort** (🐭 S · 🐕 M · 🐘 L) counts the work the app's builders control: design, implementation and verification, including owner time for devices or provider runs. It is not calendar time, and never a bound on model work. 🐭 **S** is one focused change with its tests. 🐕 **M** is several coordinated changes, or one design choice within a known shape. 🐘 **L** needs design plus a multi-part implementation or migration, or many owner-run checks.
- **Impact** (🟢 S · 🟡 M · 🔴 L) is judged by the [personas](../design/personas.md). 🔴 **L** protects patient safety or data correctness: the wrong person, a lost or silently incomplete record, a wrong printed value. It also covers unblocking a main job for a main persona. 🟡 **M** is noticeable friction, cost or trust for a main persona. 🟢 **S** is internal quality, polish or an option to explore.
- 🚀 **production** marks work required before the app is relied on for real records. That means the owner's household using the supported local installation as their records store, on localhost; remote deployment is conditional on need (owner, 2026-10-01). Every release check is required, through the 🚦 CRS-061 gate. An unmarked item can still matter; it just doesn't block that use. ☂️ marks an umbrella specification that is sized by its tickets.
- Each ticket also has its own emoji, decoration only, reused as little as possible. Its CRS file's title carries the same emoji, and IDs stay the stable identifiers.

Application documentation describes implemented behavior and current limitations; future work, its specifications and its plans live here. Before deleting a ticket, carry its unmet requirements, owner decisions and open questions into a new or existing item.

Keep the reason for a decision as well as its resulting behavior: who it serves, the failure it prevents, its limits and any earlier rule it supersedes. On implementation, move that rationale into maintained behavior documentation before deleting the ticket, and repoint links. Non-obvious regression tests should include a short why comment tied to that rationale; a test's expected value alone is not the product decision record. Import/identity decisions are consolidated in [CRS-126 D5 and D8](CRS-126.md#d5-identity-evidence-human-decisions-and-incorrect-printed-dobs-are-different-facts) while open.

The detailed work list and design documents that preceded this index are archived at `2ae9a0f`: the [earlier work list](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/application-todo.md), [processing context proposal](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/processing-context-proposal.md), [import processing implementation specification](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/import-processing.md) and [integrated evidence review draft](https://github.com/mxbaylee/circus-health/blob/2ae9a0f6f158bcf274d86b2a771d223bc14e4a6e/docs/import-evidence-review-draft.md). The deployment designs are linked from [CRS-083](CRS-083.md). They are history; the CRS items below are authoritative.

## <a id="ticket-writing-and-review"></a>Ticket writing and review

Owner guidance, 2026-10-02, narrowed after the completed backfill on 2026-10-03: every incoming ticket explains its user outcome using the canonical [personas and jobs](../design/personas.md). Use documented persona names and link the relevant job. The supplied story, walkthrough and Given–When–Then structure guides readable intent; it does not add scope or require mechanical rewriting of useful specifications. Keep stories about what the person wants and why, without implementation jargon. Describe their experience in a concise plain-English walkthrough. Put business rules, edge cases, technical ambiguity and engineer details in acceptance criteria or explicitly referenced contract sections, preserving existing requirements and evidence boundaries. Keep the detail proportionate to the task; short index-only items can carry concise versions inline. PR #54 backfilled all existing open items. Ordinary ticket edits do not require rewriting their stories; update the story or walkthrough when the user outcome or scope changes, preserving acceptance requirements. The next grooming checks for any missed coverage, rather than repeating the completed backfill.

```markdown
# <emoji> CRS-NNN: <concrete outcome>

Status: <current behavior, remaining scope and real dependencies>

## User Story

As a [<canonical persona>](../design/personas.md#<job>),
I want to <user goal>,
So that <value to that person>.

## Plain-English User Walkthrough

1. <What the person does or experiences in familiar language.>
2. <What they see next, including interruption/recovery where relevant.>

## Acceptance Criteria

### Scenario: <observable outcome>

Given <starting conditions>,
When <action or event occurs>,
Then <required outcome and evidence>,
And <relevant business rule, edge case or engineering constraint>.

<Preserved technical contracts/references, owner decisions versus proposals,
open questions, validation and independently reviewable evidence.>
```

Owner instruction, 2026-10-02 supersedes earlier effort-only split/owner-grade rules: split only when distinct complexity, scope or dependency boundaries make implementation and review clearer. A coherent high-effort task may be implemented and independently reviewed; do not defer it solely because of its size or require special owner grading for that reason. Preserve useful existing boundaries and real dependencies. If actual work remains after implementation, carry that specific remainder into an appropriate ticket with its own user story. Physical evidence, paid-run authorization and explicit owner decisions/acceptance standards remain required where applicable.

Follow `AGENTS.md` for independent review and the normal feature-branch/required-CI/squash-merge workflow. Supply the reviewer with scope, requirements and current evidence; ask for an unbiased numerical grade, actionable findings, useful improvement feedback and limitations, without a desired score or expected conclusion. Resolve blocking findings and verify fixes before the final review and merge. Historical splits below remain history, not a rule that high effort must be split again.

## Backlog grooming cadence

Owner instruction, 2026-10-02: after every seven merged ticket completions, groom the backlog before starting the next implementation. Recheck requirements against code, persona/operator gaps, owner decisions versus proposals, dependencies, effort/impact and the top five; preserve unresolved decisions in their owning tickets. Keep readable persona-based stories, plain-English walkthroughs and Given–When–Then acceptance current across all remaining backlog items, including short index-only items. The 2026-10-03 grooming backfills that guidance across the existing backlog; subsequent grooming verifies the user intent and engineering contract still agree. Count completed tickets, not commits or pushes. A split with no implemented completion does not advance the count. Record the new checkpoint and reset the count only after the grooming change merges.

Last merged grooming checkpoint: [PR #63](https://github.com/mxbaylee/circus-health/pull/63). Completed tickets since that checkpoint: **1 of 7**: CRS-216 ([selective packets](../features/selective-packets.md)). This completion takes effect when its implementation change merges; grooming is not itself a ticket completion. The completed preceding cycle was CRS-225 ([automatic exact-text reconciliation](../data/text-piece-reconciliation.md)), CRS-219 ([disposable source-text storage](../data/source-text-projection.md)), CRS-220 ([exact source search](../data/source-details-search.md)), CRS-209 ([selected intake authority](../data/intake-envelope-authority.md)), CRS-210 ([real mutation and recovery qualification](../data/intake-mutation-qualification.md)), CRS-226 ([hosted passkey checker](../security/hosted-passkey-checker.md)) and CRS-215 ([safe release updates](../setup/release-updates.md)), completed by [PR #62](https://github.com/mxbaylee/circus-health/pull/62). Update the counter and compact completion list in each completion change so a new session can resume it.

Grooming findings, 2026-10-03 after PR #62: reviewed all **63 primary open items** (38 file tickets and 25 index-only items), plus CRS-060's qualification guidance, against current code, maintained contracts and canonical personas. Existing stories, plain-English walkthroughs and Given–When–Then acceptance cover the backlog; new tickets retain that requirement without mechanically rewriting unchanged user outcomes. Historical bulk-save measurements and upstream sign-in assessments are distinguished from current evidence. Existing proposal capture, text/search authority and test prerequisites are recognized while remaining replay-fixture, complete-text, bulk-save, packaged-OCR and encrypted redirect checks stay open. CRS-123 is now M effort / S impact / score 3 for its coordinated launcher, proxy-configuration and documentation work; other sizes, production marks and scores remain unchanged.

Dependencies now distinguish reusable foundations from actual blockers: CRS-212 explicitly waits for CRS-227/228 and the held runner/capacity work; CRS-140's redundant waits and CRS-227's journal costs can be fixed independently; packet selection, Conditions ingestion and proposal preparation do not wait on their downstream consumers. Top five: CRS-163, CRS-152, CRS-124, CRS-155 and CRS-143; CRS-163's explicit CRS-088 unblock wins the score-8 tie. Current-version policy, other substantive owner choices, physical/adopted-route qualification and held PR #35 remain open. Scoring proposals remain unadopted. No new ticket was needed and no completion or new physical/provider result is claimed by this checkpoint. Continue independent work while those gates await their required input.

Later mobile checkpoint, 2026-10-03: the owner supplied five hosted reports and requested [CRS-229](CRS-229.md) as an active blocker, with detailed findings in [issue #66](https://github.com/mxbaylee/circus-health/issues/66). **Resolve CRS-229 before CRS-163 testing resumes.** This supersedes the draft's earlier allowance for continuing evidence collection. Targeted diagnosis and fix verification belong to CRS-229; unrelated work can continue. Adding this ticket changes the top five below but does not advance the completed-ticket counter or qualify a release.

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

Dependency-priority proposal (owner discussion, 2026-10-02): dependencies should inherit urgency from downstream tickets, with an accumulation effect. The current candidate is boosted score = base score + number of unique unfinished prerequisites, then effective priority = the highest boosted score among the ticket and all downstream tickets it blocks. This interprets the owner’s example as a 4-point ticket plus three unique prerequisites = 7. Count shared prerequisites once, exclude completed tickets and release-gate/umbrella scores, and retain base scores separately. This formula is still under discussion, not adopted; current scores and the ranking below continue to use the existing rules.

Each open item shows its score after its sizes. When a size or mark changes, recompute its score in the same change.

### <a id="top-5"></a>🏆 Top 5

**Refresh this list in the same change whenever a ticket is added, closed or removed, or whenever a size, mark or dependency changes.** Apply the rules above: skip items that are waiting on an unfinished ticket, and break ties as in step 2. The last column says what the owner must provide; everything else is agent work.

| #   | Ticket                                            | Score | Tie-break                         | Owner input                                                                        |
| --- | ------------------------------------------------- | ----- | --------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | 🗝️ [CRS-229](CRS-229.md) mobile passkey findings | 8     | Unblocks CRS-163                  | Clarify the input-format observation and perform targeted physical verification     |
| 2   | 💽 [CRS-152](#crs-152) deployment drive           | 8     | 🔴, lower ID                      | Connect or choose the drive and adopted provider                                   |
| 3   | 👥 [CRS-124](#crs-124) People                     | 8     | 🟡, 🐭, lower ID                  | Review People views and useful summaries                                           |
| 4   | ♻️ [CRS-155](CRS-155.md) provider sign-in renewal | 8     | 🟡, 🐭                            | Fresh readiness check, natural expiry and operator/route authorization             |
| 5   | 🕰️ [CRS-143](CRS-143.md) current record versions  | 7     | Unblocks Conditions, 🔴, lower ID | Decide automatic versus reviewed current-version policy and its remaining defaults |

CRS-163 is blocked by [CRS-229](CRS-229.md) and its broader testing iteration is paused until those findings are resolved. The [hosted compatibility checker](../security/hosted-passkey-checker.md) remains available for targeted diagnosis and fix verification under CRS-229. CRS-163 retains all actual localhost release-build qualification and continues to block CRS-088, including that future feature's separate requalification: **CRS-229 → CRS-163 → CRS-088**. A hosted report cannot substitute for actual application recovery, session or recreation evidence. Remote-phone testing at the checker does not adopt remote household deployment. Continue unrelated work while this hold is open; merging the checkpoint documentation alone does not lift it.

CRS-194 builds on the completed [real-mutation and recovery qualification](../data/intake-mutation-qualification.md) and waits for the separately scoped [queue-journal](CRS-227.md) and [full-view processing](CRS-228.md) prerequisites before another heavy attempt. These follow the implemented [intake authority activation](../data/intake-envelope-authority.md). These build on the implemented [access boundary](../import/intake-state-access.md), [transaction-backed primitive](../data/intake-state-storage.md), [compact history projection](../data/record-version-storage.md#compact-history-projection) and [incremental encrypted index](../security/vault-index.md). CRS-194 retains the remaining capacity and diagnostic qualification after the [conversation journal recheck](../data/conversation-journal.md#bounded-import-recheck); physical page delivery did not establish clinical completeness. Other score-7 work (not an ordered queue) includes: 📦 [CRS-043](CRS-043.md) (7), 🩻 [CRS-062](#crs-062), 🥡 [CRS-068](#crs-068), ⚙️ [CRS-086](CRS-086.md), 🏷️ [CRS-139](CRS-139.md), 🩹 [CRS-173](CRS-173.md), 🎨 [CRS-190](CRS-190.md), 📜 [CRS-115](CRS-115.md) and 💾 [CRS-141](CRS-141.md) (7, 🔴). CRS-086 independently implements async processing and bounded context; CRS-194 prepares complete downloadable diagnostics before the owner's common 800–900-page trial, supplies its instrumented comparison baseline, and produces prioritized production follow-ups (owner, 2026-10-01). Preparatory async design can start while diagnostics readiness proceeds; CRS-194's current scripted 900-page baseline precedes writing CRS-086's full implementation specification, and does not wait for parallel workers. 🩺 [CRS-154](CRS-154.md) (7, 🟡) shares complaint/download validation. ♻️ [CRS-155](CRS-155.md) scores 8 and awaits live qualification after a fresh readiness check, natural expiry and the required operator/route authorization; its historical pending result does not establish today’s token state. 🗂️ [CRS-150](CRS-150.md) waits for 🗂️ [CRS-175](CRS-175.md); the [selective-packet foundation](../features/selective-packets.md) is implemented for CRS-175 and the later presets; 🧐 [CRS-073](#crs-073) waits for CRS-150.

CRS-207 was split before implementation after code review found separate durable-order, text-locality, cache-lifecycle and query-integration designs. The [exact ordered serialization contract](../data/intake-state-storage.md#exact-serialization-domain) and [explicit text-piece engine](../data/text-piece-edits.md) are implemented. [Automatic exact-text reconciliation](../data/text-piece-reconciliation.md) is also implemented; [Disposable transactional source-text storage](../data/source-text-projection.md) is implemented; [exact source-search integration](../data/source-details-search.md) is implemented with native LIKE parity and request-lifetime qualification. The [unpublished-target bootstrap](../data/intake-state-storage.md#unpublished-target-bootstrap) now prepares target-bound intake evidence; [encrypted private-copy publication/retry](../data/intake-state-storage.md#encrypted-private-copy-publication-and-retry) and [contributor private-copy retention/retry](../data/intake-state-storage.md#contributor-private-copy-publication-and-retry) are integrated. The original specification-only split did not advance the seven-completion grooming counter. CRS-208 was reassessed high effort before implementation and retired into CRS-221 pure preparation, CRS-222 encrypted-copy publication/retry and CRS-223 contributor copy retention/rebuild integration; genuine [contributor runtime durability](../data/contributor-record-authority.md) is now integrated. All are medium-effort, high-impact production prerequisites; that specification-only split did not advance the completion counter. The implemented preparation, encrypted-copy, contributor-retention and exact-search APIs now support the [selected intake envelope authority](../data/intake-envelope-authority.md), including contributor runtime reads and writes. CRS-218 was also reassessed high effort before code: both the [bounded explicit splice/move engine](../data/text-piece-edits.md) and [automatic retained-anchor snapshot reconciliation](../data/text-piece-reconciliation.md) are now implemented. Automatic contextual alignment, move reuse and counted work limits were reassessed as large effort but completed coherently without an effort-only split. The [disposable storage layer](../data/intake-state-storage.md) now uses both primitives and qualifies transactional rollback, reopen, private copy and cache loss with fictional evidence. Exact source search now has its own [parity and lifecycle evidence](../data/source-details-search.md); neither that nor SQL lifecycle evidence establishes production mutation qualification. The historical specification-only splits did not advance the completion counter.

Proposed focused-ticket divisions are recorded in [CRS-140](CRS-140.md#proposed-division-into-focused-tickets), [CRS-141](CRS-141.md#proposed-division-into-focused-tickets), [CRS-043](CRS-043.md#proposed-division-into-focused-tickets) and [CRS-139](CRS-139.md#proposed-division-into-focused-tickets). Their existing requirements remain authoritative; children need their own sizes, production marks, dependencies and acceptance checks before allocation. CRS-081 now scores 6 as a production requirement. Historical raw-assertion restoration is outside the current release scope: the owner requires no old-schema support before production (2026-10-01), and current imports use the existing reviewed intake path; see [retained ownership limits](../../src/server/NOTE-EXPORTS.md#historical-raw-assertion-ownership). Conditions are active by owner request, 2026-10-01. Their production marks now reflect the existing CRS-150 launch dependency, not adoption of new diagnosis inference or a new scoring formula; a narrower packet launch would need an explicit scope change in CRS-175: [Condition storage](../data/data-model-contracts.md#condition-occurrence-storage) is implemented; CRS-173/174 supply reviewed records and personal status, and CRS-175 supplies the packet dependency. CRS-194 unblocks CRS-086 validation; retained recorder/export recovery, [per-request input composition counts](../import/import-performance.md#request-input-composition), [known loss checkpoints](../import/import-performance.md#retained-window-checkpoints), [known persisted-event omission accounting](../import/import-performance.md#known-persisted-event-omissions) [encrypted collection origins](../import/import-performance.md#encrypted-collection-origins) and a [manual recording check](../import/import-performance.md#manual-recording-check) are implemented, and a [fictional 900-page fixture/oracle](../import/import-performance.md#fictional-large-import-fixture) and [proposal/review reconciliation with bounded two-person identity qualification](../import/import-performance.md#large-import-proposal-reconciliation) are available; [bounded accepted-record/replay/cache-loss reconciliation](../import/import-performance.md#large-import-accepted-record-reconciliation) is implemented, while full-size processing, recovery and diagnostic coverage remain unqualified.

## <a id="product-and-maintenance"></a>🛠️ Product and maintenance

- [ ] <a id="crs-229"></a> 🗝️ [CRS-229](CRS-229.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Resolve mobile passkey selection, the reported input-format problem, PRF confirmation and second-credential findings before CRS-163 testing resumes. Preserve all five reports' positives, retries and gaps in [issue #66](https://github.com/mxbaylee/circus-health/issues/66); targeted diagnosis and fix verification belong here. Blocks CRS-163, which still blocks CRS-088.

- [ ] <a id="crs-212"></a> 🧪 [CRS-212](CRS-212.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Run and retain a new unchanged full scripted-fixture attempt; builds on the implemented renderer; waits for CRS-227/228 and the runner/storage qualifications CRS-195/198 in pending PR #35. Unblocks CRS-194’s baseline.

- [ ] <a id="crs-227"></a> 🧵 [CRS-227](CRS-227.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Remove complete-history rereads/replay from ordinary processing-queue journal changes while retaining exact recovery and every event; separately measured prerequisite for CRS-194 before another heavy attempt.
- [ ] <a id="crs-228"></a> 🪶 [CRS-228](CRS-228.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Reduce measured full-view validation, cloning, serialization, repeated proposal reads and projection work for small intake changes, with complete DTO/cold-rebuild costs separated; prerequisite for CRS-194 before another heavy attempt.

- [ ] <a id="crs-173"></a> 🩹 [CRS-173](CRS-173.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Review and accept literal condition occurrences with person/source scope, corrections and history; builds on the implemented storage table. Active by owner request, 2026-10-01.
- [ ] <a id="crs-174"></a> 🗒️ [CRS-174](CRS-174.md) · 🐘 L · 🟡 M · 🚀 production · score 7 — Separate personal condition confirmations and Conditions UI; follows CRS-173. Visits remain notes.
- [ ] <a id="crs-175"></a> 🗂️ [CRS-175](CRS-175.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Qualify personally confirmed conditions in packets, exclusions and recovery; follows CRS-173/174 and qualifies the implemented [packet foundation](../features/selective-packets.md), and unblocks CRS-150. Allergy scope remains open.

- [ ] <a id="crs-139"></a><a id="crs-090"></a> 🏷️ [CRS-139](CRS-139.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Resolve remembered-owner precedence and make choices visible and revocable; release holds on later whole-report corrections; finish ownership-correction tests, including ambiguous confirmed-name remembering (remainder of CRS-134; CRS-090's remainder, with its real-file part in [CRS-062](#crs-062)).
- [ ] <a id="crs-140"></a> 🧊 [CRS-140](CRS-140.md) · 🐘 L · 🟡 M · 🚀 production · score 6 — Cool repeated timeouts on one unit with longer backoff, lower concurrency or a longer deadline behind a non-blocking status, never a stop or attempt cap (owner, 2026-09-30); detect provider sign-in without a click, stop journaling unchanged waits, and finish continuation tests (remainder of CRS-135).
- [ ] <a id="crs-141"></a> 💾 [CRS-141](CRS-141.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Keep partial saves linear on large intakes, keep coupled groups together above the cap, name the person on saved outcomes, and finish coverage (remainder of CRS-136).
- [ ] <a id="crs-133"></a> 🎂 [CRS-133](CRS-133.md) · 🐕 M · 🟡 M · score 4 — Allow an explicit report-scoped assignment despite an incorrect printed DOB, preserving originals, demographics and the reason for the human exception.
- [ ] <a id="crs-043"></a> 📦 [CRS-043](CRS-043.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — If the app can store a file, it can import it: stream ZIP members and extraction to disk, replace the upload cap with a free-disk or operator-set storage check, and keep rather than reject a file that cannot be processed yet.
- [ ] <a id="crs-144"></a> 🪪 [CRS-144](CRS-144.md) · 🐘 L · 🟡 M · score 3 — Define coordinated clinical/candidate/report identity scope for the supported format; prevent running-header splits and explain refusals without crossing people. Preserve current accepted history and decisions; cross-member consolidation remains a decision. No old-archive migration (merges CRS-042 and CRS-046).
- [ ] <a id="crs-080"></a> 📸 **CRS-080** · 🐭 S · 🟢 S · score 4 — Turn the existing private fictional proposal captures in `qualify-provider-pdf.ts` into reusable downstream test fixtures beside the hand-written `fictional-*-proposals.ts`; preserve capture completeness/provenance, and bypass replay for fresh quality and work-count measurements.

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to trust that app updates keep record review working, so that I can update without repeatedly paying to reread the same test documents.

  **Plain-English User Walkthrough:** I review evidence that an update preserves previously checked results. Fresh reading quality is checked separately.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Reuse fictional review inputs honestly
    Given a completed fictional reading has retained proposals
    When downstream review tests replay those proposals
    Then test-only fixtures reproduce the complete captured review inputs with their provenance, partial captures stay explicit, and fresh quality and work-count runs bypass replay
  ```

- [ ] <a id="crs-081"></a> 🌙 [CRS-081](CRS-081.md) · 🐘 L · 🟡 M · 🚀 production · score 6 — Extend the implemented automatic coordinator with scoped authority after lock/logout/profile switch to complete the decided background-import experience and its joint release journeys; dependent recovery checks need CRS-140.
- [ ] <a id="crs-084"></a> 🛡️ [CRS-084](CRS-084.md) · 🐕 M · 🟡 M · 🚀 production · score 7 — Prioritize unresolved security risks and mitigations without describing proposed controls as existing protection.
- [ ] <a id="crs-086"></a> ⚙️ [CRS-086](CRS-086.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Independently implement async artifact processing with bounded context, shared extraction, safe adaptive concurrency and usable foreground chat/browsing/review; CRS-194 supplies diagnostics and the large-document baseline. Progressive review is a separate proposal pending its publication policy.
- [ ] <a id="crs-088"></a> 👆 [CRS-088](CRS-088.md) · 🐕 M · 🟡 M · score 4 — Quick passkey sign-in without choosing a profile first: a username-less request, one app-wide PRF salt migrated at the next unlock, while retaining origin checks, profile isolation and locked state after restart. Waits for CRS-163’s physical baseline.
- [ ] <a id="crs-089"></a> 🪶 [CRS-089](CRS-089.md) · 🐕 M · 🟡 M · score 4 — Make the model gateway lighter and less patched: measure LiteLLM's memory, tune it first, and weigh replacements such as Bifrost only if tuning falls short, rechecking the candidate release's adopted-route sign-in support.
- [ ] <a id="crs-112"></a> 🧹 **CRS-112** · 🐭 S · 🟢 S · score 4 — Remove blank-Self-field filling from import confirmation; use normal profile editing/setup. Preserve historical human decisions within the supported current format; no old-schema decoder or deletion of accepted history. The selfUpdate mutation in intake-identity.ts is still live.

  **User Story:** As a [Low-effort self-tracker](../design/personas.md#file-and-review), I want to keep my personal details under my control when I file a report, so that a document does not unexpectedly change my profile.

  **Plain-English User Walkthrough:** I confirm who a report belongs to. I edit my own details separately when I choose.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Keep report confirmation separate from profile editing
    Given Self has blank personal fields and a report contains identity details
    When the person confirms the report
    Then confirmation does not fill Self fields, and existing accepted decisions and history remain intact
  ```

- [ ] <a id="crs-114"></a> 🪓 [CRS-114](CRS-114.md) · 🐭 S · 🟢 S · score 4 — Remove the repository inventory checker and separately verified dead code, preserving live dynamic, worker, deployment and test entry points.
- [ ] <a id="crs-115"></a> 📜 [CRS-115](CRS-115.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Qualify complete durable source text, located uncertainty, reading order, tables, search and no-AI recovery across difficult document strata.
- [ ] <a id="crs-116"></a> 🔍 [CRS-116](CRS-116.md) · 🐘 L · 🟡 M · score 3 — Improve evidence review, omission detection, bounded editing and measured human review burden.
- [ ] <a id="crs-128"></a> #️⃣ [CRS-128](CRS-128.md) · 🐕 M · 🟡 M · score 4 — Verify each retained original without a full synchronous hash after every restart: keep verification across restarts and move any full hash that remains off the request path.
- [ ] <a id="crs-129"></a> 🖋️ [CRS-129](CRS-129.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Record which source revision and verification state each proposal and accepted record was built from, separately from the staleness pin.
- [ ] <a id="crs-121"></a> 💊 **CRS-121** · 🐘 L · 🔴 L · score 4 — Build the medication and vocabulary rules decided in [CRS-126](CRS-126.md#dates), [medications](CRS-126.md#medications) and [standard vocabularies](CRS-126.md#standard-vocabularies): offline RxNorm matching against the saved list that shows only new medications, a "Document says stopped" suggestion, never deactivating on omission, first-of-period date proposals for approval with the printed date visible, and bundled offline LOINC/RxNorm (P16). No LOINC/RxNorm matching exists yet; imported prescriptions already start inactive and printed date precision is kept.

  **User Story:** As a [Chronic-condition tracker](../design/personas.md#follow-values-and-medications), I want to review new medication information and uncertain dates without losing my current choices, so that my list reflects what I have actually confirmed.

  **Plain-English User Walkthrough:** I compare a new report with my saved list. I review suggested additions, stopping information and dates before accepting changes.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Do not stop medication through omission
    Given a saved medication is absent from a new report
    When that report is reviewed
    Then the medication is not deactivated; an explicit stopped statement becomes a reviewable suggestion under the recorded vocabulary and date rules
  ```

- [ ] <a id="crs-142"></a> 🐛 [CRS-142](CRS-142.md) · 🐘 L · 🟡 M · score 3 — Add error matchers to bare throw assertions, fail loudly on old `HEALTH_*` test opt-ins, select and run the explicit packaged OCR qualification lane, resolve the `PDF_NATIVE_PAGE_LIMIT` flake, add the missing R40 route denial cases, and complete encrypted parity between existing direct Import links and the historical Sources redirect (remainder of CRS-122 and CRS-041).
- [ ] <a id="crs-123"></a> 🧽 **CRS-123** · 🐕 M · 🟢 S · score 3 — Narrow or justify the broad legacy-variable rejection (`deploy/run.ts` `oldLauncherKeys` and the `HEALTH_`/`CIRCUS_` loop); make proxy-diagnostics flags consistent across `configure.py`, `compose.yaml` and `environment.md`; review noisy diagnostics routes while preserving the implemented recording controls and documented metadata-correlation limits. Correct stale docs: `environment.md:84` still describes `CRS_CODEX_INTEGRATION_TEST`, removed from CI in `3a8b076`; `import/import-reconciliation.md:9-11` pauses on "a time/context limit" and "exhausted windows", contradicting CRS-126 D2/D3 and [automatic recovery](../import/automatic-recovery.md), and `:17` limits upload review to Self-confirmed records, contradicting D1; the tracked root `prompt.txt` points at missing `docs/application-todo.md` and `docs/workspace-and-handoffs.md`. Coordinate with CRS-142's `HEALTH_*` opt-ins.

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to follow setup and recovery instructions that match the app, so that I can resolve problems without following obsolete advice.

  **Plain-English User Walkthrough:** I follow the installation instructions and any configuration error. The guidance explains the settings and recovery behavior the current app actually supports.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Align guidance with current configuration and recovery
    Given the supported launcher and automatic recovery contracts are current
    When configuration rejection and retained documentation are reviewed
    Then legacy-variable rejection is narrowed or justified, diagnostics flags agree, and obsolete time-limit, Self-only and missing-path instructions are corrected
  ```

- [ ] <a id="crs-125"></a> 📅 **CRS-125** · 🐕 M · 🟢 S · score 3 — Consolidate calendar-date validation into `src/shared/clinical-date.ts`, replacing the local copies in `CollectionFilters.tsx`, `format.ts`, `person-fields.ts`, `notes.ts` and `intake-evidence-dates.ts`; file DTO/form, server-safe formatting, filter/modal and HTTP/error duplicates separately once each has concrete locations.

  **User Story:** As a [Low-effort self-tracker](../design/personas.md#build-a-history), I want to have dates checked consistently wherever I enter or filter them, so that the same date is not accepted in one place and rejected in another.

  **Plain-English User Walkthrough:** I enter a date and later use it to find a record. Invalid dates receive the same understandable refusal in both places.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Use one calendar-date rule
    Given the same valid or invalid calendar date reaches profile, note, evidence and filter inputs
    When each input validates it
    Then the named consumers use the shared clinical-date contract with equivalent valid-date acceptance and invalid-date refusal
  ```

- [ ] <a id="crs-126"></a> 📥 [CRS-126](CRS-126.md) · ☂️ umbrella: sized by its tickets — Meet the import specification: never drop a record, other people's records welcome, no size or time limits, waits are backoffs, writes scale with change.
- [ ] <a id="crs-127"></a> 🖼️ **CRS-127** · 🐕 M · 🟡 M · score 4 — Read HEIC and multi-page TIFF uploads automatically, as [CRS-126](CRS-126.md#receiving-and-formats) requires; today they are unsupported (the readable formats in `isRetainOnlyIntake`, `shared/intake-source-policy.ts`, and the image types in `extractSourceStep`, `intake-source-extraction.ts`; reliability R36).

  **User Story:** As a [Records assembler](../design/personas.md#read-unusual-evidence), I want to file photos and scanned documents in the formats I already have, so that I do not have to convert them before reviewing my records.

  **Plain-English User Walkthrough:** I add a phone photo or a document with several scanned pages. I can review what was read and reopen the original.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Read supported photo and multipage formats
    Given an upload is a HEIC photo or a multipage TIFF
    When automatic source extraction runs
    Then all supported pages enter the normal review flow with originals retained and unsupported scope explicitly identified
  ```

- [ ] <a id="crs-143"></a> 🕰️ [CRS-143](CRS-143.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Decide and show which record is current when corrections and new versions arrive; today the importer does not infer it and the chart has no outdated display (CRS-126 scenario 5).
- [ ] <a id="crs-146"></a> 👣 [CRS-146](CRS-146.md) · 🐕 M · 🟡 M · score 4 — Log every sign-in (unlock) and failed attempt and show them clearly to the patient on their next sign-in; failed attempts happen before unlock, so they need a small separate log with no health data.
- [ ] <a id="crs-150"></a> 🗂️ [CRS-150](CRS-150.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Compose job-based packet presets and a one-page emergency summary using the implemented [shared exclusion foundation](../features/selective-packets.md) and CRS-175's confirmed Conditions; qualify the integrated privacy/current-status output. Remainder of CRS-147.
- [ ] <a id="crs-194"></a> 📈 [CRS-194](CRS-194.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Before an owner's common 800–900-page trial, verify complete downloadable AI/import/processing/UX diagnostics, establish an instrumented baseline and turn findings into prioritized production tickets; unblocks CRS-086's measured comparison and supports CRS-154 complaint reconstruction.
- [ ] <a id="crs-148"></a> 🧳 [CRS-148](CRS-148.md) · 🐘 L · 🟡 M · score 3 — Export everything in a portable form, Takeout-style: originals, records, notes, corrections and history, with a manifest, for moving storage or keeping a checkpoint elsewhere.
- [ ] <a id="crs-149"></a> 🎣 [CRS-149](CRS-149.md) · 🐕 M · 🟡 M · score 4 — Confirm and show the destination of external links in assistant text (warn when a link carries data), and test that one session's unlock never grants another session access.

## <a id="release-and-usability-checks"></a>✅ Release and usability checks

<a id="crs-060"></a>**CRS-060** — Validate each layer on its own: server, mounted, encrypted browser and real provider. CI already runs the server, UI, browser, continuation, deploy, brand and offline-proxy lanes (`code-checks.yml`); one layer never substitutes for another. The agent prepares and runs every check and records its evidence. The owner supplies only what an agent cannot: taps and gestures on physical phones and authenticators for the phone and passkey checks, the deployment drive, provider sign-ins and credentials for OAuth refresh and the route and import checks, and authorization for paid runs. The printed output needs nothing from the owner.

**User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want evidence that each part of the installation works in its real setting, so that one successful test does not hide a different unverified risk.

**Plain-English User Walkthrough:** I inspect the checks for the release I intend to use. Software results and any device or service steps I must complete are shown separately.

**Acceptance Criteria:**

```gherkin
Scenario: Preserve the boundary between test layers
  Given server, mounted-interface and encrypted-browser checks pass
  When a required real-provider or physical-device check has not run
  Then that check remains unqualified with its precise missing input, rather than inheriting another layer’s result
```

- [ ] <a id="crs-061"></a> 🏁 **CRS-061** · 🚦 gate · 🚀 production — Release gate: every check below passes on the release build; a mock, viewport simulation or partial extraction closes none. Includes CRS-190’s design/product/accessibility UI/UX review, requalification of affected flows and closure of all launch-blocking findings; these requirements survive retirement of the audit ticket. Also includes CRS-081's scoped continuation and joint journeys and CRS-086's async/foreground-usability acceptance. After their implementation and all identified large-import production blockers land, requalify the release workflow on fictional direct-upload PDFs of about 800 pages/115 MB and 900 pages/15 MB on the adopted route: complete page accounting, oracle-checked clinical facts and ownership, review/acceptance, interruption/recovery, original retention and cache-loss rebuild, usable foreground requests, and a full-run diagnostic download that reconstructs early/late problems. Require current independently passing evidence; this requirement survives deletion of the CRS-194 investigation ticket. Paid full-size inference needs the owner's approval. Also require the [independent encrypted-archive restore drill](../setup/archive-restore.md#repeatable-fictional-qualification) with current release-build evidence, separately from CRS-152 filesystem/provider and recreation evidence, the [release-update and unsupported-authority-format refusal/recovery drill](../setup/release-updates.md#repeatable-fictional-release-qualification) with current release-pair evidence and its build/environment limits, and the [supported backup entrypoint boundary](../setup/deployment.md#backup-and-recovery); these gates survive ticket retirement. Current-format completed-pass recovery must avoid redundant dispatch without skipping new capture, preserve Stop and account for unknown provider outcomes (CRS-140); obsolete legacy baseline migration is outside release scope.

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to know that the household installation is ready for real records, so that I can rely on it to preserve and recover our medical history.

  **Plain-English User Walkthrough:** I review the release evidence for filing, correction, sharing and recovery. Any missing required check remains visible before I rely on that release.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Keep missing release evidence open
    Given software tests pass but a required adopted-device, provider, recovery or complete-import check is missing
    When release readiness is assessed
    Then the release gate remains open and does not substitute mocks or partial extraction for the missing evidence
  ```

- [ ] <a id="crs-190"></a> 🎨 [CRS-190](CRS-190.md) · 🐘 L · 🔴 L · 🚀 production · score 7 — Audit the full release UI for visual/theme consistency, accessibility and persona-based task usability through independent design/product reviews; cover all surfaces/states and complete flows, then scope fixes and preserve launch blockers in CRS-061.
- [ ] <a id="crs-055"></a><a id="crs-014"></a><a id="crs-056"></a> 📱 **CRS-055**, with CRS-014 and CRS-056 · 🐕 M · 🟡 M · 🚀 production · score 7 — Phones and browsers: phone-specific checks apply when phone access is adopted (localhost is the current release scope, owner 2026-10-01); on those physical devices, Files/Photos, virtual keyboard, screen reader, zoom, rotation, upload interruption, background return and lock recovery; in the release browsers, real tab and home-screen icons at small size and a live OS Light/Dark flip. Icon generation and theme logic are already tested.

  **User Story:** As a [Low-effort self-tracker](../design/personas.md#file-and-review), I want to use the app comfortably on each device I choose, so that I can file records and recover from interruptions without losing my place.

  **Plain-English User Walkthrough:** I add a file, use the keyboard or accessibility tools and return after an interruption. The app remains readable and makes recovery clear on the devices included in my setup.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Qualify the actual adopted device
    Given phone access is adopted and a physical supported phone is available
    When upload, keyboard, screen reader, zoom, rotation and return-from-background journeys are exercised
    Then the recorded result reflects that device rather than a viewport simulation; release-browser icons and live OS theme changes are checked separately
  ```

- [ ] <a id="crs-163"></a> 🔐 [CRS-163](CRS-163.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — **Testing paused by [CRS-229](CRS-229.md); resolve that blocker before this iteration resumes.** Then use the [hosted checker](../security/hosted-passkey-checker.md) to gather compatibility observations and complete physical passkey qualification on the intended localhost desktop, authenticators, repeated unlock, recovery and recreation; hosted compatibility results do not close those installation checks. Remote production HTTPS/phone origins remain conditional on adopting that deployment. The headed Chrome/Edge driver is implemented; this ticket still blocks CRS-088.
- [ ] <a id="crs-152"></a> 💽 [CRS-152](CRS-152.md) · 🐕 M · 🔴 L · 🚀 production · score 8 — Finish deployment qualification: real provider authentication persistence across recreation and a complete fictional import on the chosen filesystem. Host/container mount probes are implemented (remainder of CRS-071).
- [ ] <a id="crs-155"></a> ♻️ [CRS-155](CRS-155.md) · 🐭 S · 🟡 M · 🚀 production · score 8 — Complete live natural-expiry refresh qualification for each adopted OAuth route; the guarded runner and fresh-container persistence check are ready, but an unexpired access token cannot establish refresh.
- [ ] <a id="crs-065"></a><a id="crs-064"></a><a id="crs-076"></a> 🛣️ **CRS-065**, with CRS-064 and CRS-076 · 🐕 M · 🟡 M · 🚀 production · score 7 — Route capabilities: per adopted hosted and Ollama route, with fictional content, alias and model identity, tools, images, native PDF, same-page PNG fallback and text-only coverage gaps, credential isolation, and proxy retention and logging. Never silently change providers or weaken local-only settings; the proxy configuration's rejections are already tested.

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to understand what my chosen reading service can handle, so that I can choose it without hidden capability or privacy surprises.

  **Plain-English User Walkthrough:** I inspect the service’s tested abilities and restrictions. Unsupported input is explained before I depend on it.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Preserve an explicitly chosen route
    Given an adopted route is authorized for fictional qualification
    When tools, images, native PDF and fallback behavior are exercised
    Then the recorded alias and model identity match the chosen route, unsupported coverage is explicit, and no silent provider switch or weakening of local-only settings occurs
  ```

- [ ] <a id="crs-066"></a><a id="crs-077"></a><a id="crs-078"></a> 🚧 **CRS-066**, with CRS-077 and CRS-078 · 🐕 M · 🟡 M · 🚀 production · score 7 — Route workflows and failures: per route, from an empty fictional profile, chat, import, questions, acceptance, correction, opening the original, recreation and cache-loss rebuild, including an unavailable provider, cancellation, malformed tool output, rate limits and an explicit alias change with a saved conversation. Live runs are opt-in (`qualify-provider-pdf.ts`); unavailable credentials or routes stay explicit gaps.

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to recover safely when my chosen reading service fails, so that I can continue filing without losing decisions or confusing a failed request with a saved record.

  **Plain-English User Walkthrough:** I file a document and review its suggestions. If the service fails or I change the chosen service, I can see what happened and recover the retained work.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Retain a complete route journey through failures
    Given an authorized adopted route and empty fictional profile are available
    When chat, import, acceptance, correction, provider failure and recreation are exercised
    Then originals reopen and accepted records rebuild identically, while cancellation, malformed output and unavailable routes remain explicit outcomes
  ```

- [ ] <a id="crs-062"></a><a id="crs-058"></a><a id="crs-067"></a> 🩻 **CRS-062**, with CRS-058 and CRS-067 · 🐘 L · 🔴 L · 🚀 production · score 7 — Complete-file imports: two consecutive complete real-route runs each of a DEXA PDF, an optical image and a full record PDF on fresh fictional profiles, graded against the literal oracle, with no hidden repair: no missing, extra or duplicate records; exact fields, units, dates, ownership, provenance, original hashes and page coverage; identical accepted records after cache rebuild; order versus performed-event and category-scope cases. Any accepted row showing Unknown source despite a confirmed report source fails (from CRS-045); include ambiguous confirmed-name remembering (from CRS-090) and repeated complete-file review (from CRS-033).

  **User Story:** As a [High-precision tracker](../design/personas.md#read-unusual-evidence), I want to have every relevant fact in a document appear accurately in review, so that I can trust a complete record rather than a plausible-looking sample.

  **Plain-English User Walkthrough:** I add a complete report or prescription image and compare the proposed facts with the original. After acceptance and recovery, I find the same records and source details.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Qualify complete files without hidden repair
    Given fresh fictional profiles and an authorized adopted route are available
    When each specified DEXA, optical and full-record input is processed twice consecutively
    Then independent literal oracles find no missing, extra or duplicate records, wrong ownership or altered original hashes, and cache rebuild preserves the accepted records
  ```

- [ ] <a id="crs-068"></a><a id="crs-069"></a><a id="crs-070"></a> 🥡 **CRS-068**, with CRS-069 and CRS-070 · 🐘 L · 🔴 L · 🚀 production · score 7 — Supported-size takeout through the real route: upload, overlapping reading, interruption and restart, retained questions, acceptance and original reopening, including overlapping PDF/HTML/package evidence, attachments, duplicates and later evidence that updates pending candidates or proposes reviewed versions of accepted records, and reconciliation with records created manually (moved from CRS-116). Nothing is lost or falsely merged; later-evidence work preserves the implemented measured source dependencies.

  **User Story:** As a [Records assembler](../design/personas.md#file-and-review), I want to bring a collection of overlapping documents into one reliable history, so that I can keep all useful evidence without false merges or repeated manual filing.

  **Plain-English User Walkthrough:** I upload a collection, answer retained questions and resume after interruption. Later documents can add evidence or offer corrections that I review.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Preserve overlapping package evidence
    Given an authorized real-route qualification uses a supported fictional takeout with overlapping documents and attachments
    When the import is interrupted, resumed and reviewed alongside manually created records
    Then originals and questions remain available, evidence is neither lost nor falsely merged, and changes to accepted records require reviewed versions
  ```

- [ ] <a id="crs-073"></a> 🧐 **CRS-073** · 🐭 S · 🟡 M · 🚀 production · score 8 — Printed output: inspect the released visit brief, provider packet and evidence JSON as rendered PDF pages, after [CRS-150](CRS-150.md) changes what is printed.

  **User Story:** As a [Receiving clinician](../design/personas.md#share-a-packet), I want to receive a clear and accurate printed summary with its evidence, so that I can understand the patient’s information without opening the app.

  **Plain-English User Walkthrough:** I read the visit brief or packet the patient gives me. I can identify whose records it contains and locate the supporting evidence.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Inspect the final printed packet
    Given the packet content changes in CRS-150 are implemented
    When release PDFs are rendered and inspected with their evidence JSON
    Then the visit brief and provider packet are readable, correctly scoped and consistent with the exported evidence
  ```

- [ ] <a id="crs-037"></a><a id="crs-033"></a> 🖱️ **CRS-037** · 🐭 S · 🟢 S · 🚀 production · score 7 — On supported browsers, verify drag-and-drop of files from the operating system's file manager into Import. Over one long multi-file real-provider run, verify the strip's unit/exception counts and rate-based estimate stay truthful across turn resets and backoffs (absorbs CRS-033).

  **User Story:** As a [Low-effort self-tracker](../design/personas.md#file-and-review), I want to add files naturally and see truthful progress, so that I can tell what is finished and what still needs attention.

  **Plain-English User Walkthrough:** I drag files from my file manager into Import. During a long run I see counts and an estimate that still make sense after waiting or resuming.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Keep progress truthful across recovery
    Given a supported browser receives multiple fictional files from the operating system
    When an authorized provider run crosses turn resets and backoffs
    Then drag-and-drop succeeds and unit, exception and observed-rate estimate displays remain consistent with retained work
  ```

- [ ] <a id="crs-154"></a> 🩺 [CRS-154](CRS-154.md) · 🐕 M · 🟡 M · 🚀 production · score 7 — Reconstruct a live provider complaint from a protected, private-safe diagnostics export through review and post-recovery inspection; the tiny fictional lifecycle oracle is available, but complaint and browser-download evidence remain.
- [ ] <a id="crs-124"></a> 👥 **CRS-124** · 🐭 S · 🟡 M · 🚀 production · score 8 — With the owner, check that non-Self people are visibly distinct, long and identical names, keyboard and narrow layouts, and whether prescription/procedure summaries are useful. Interrupted saves are covered by [CRS-141](CRS-141.md).

  **User Story:** As a [Caregiver](../design/personas.md#file-family-records), I want to clearly distinguish the people whose records I manage, so that I can avoid choosing or reviewing the wrong person.

  **Plain-English User Walkthrough:** I find a person even when names are long or alike. I use the keyboard or a narrow view and check whether their summaries are useful.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Distinguish people in the actual views
    Given Self and non-Self people include long or identical display names
    When the owner reviews keyboard and narrow-layout People journeys
    Then non-Self people remain visibly distinct and the usefulness of prescription and procedure summaries is recorded; interrupted-save correctness stays with CRS-141
  ```

## <a id="deferred-options"></a>💤 Deferred options

- [ ] <a id="crs-082"></a> 🎞️ **CRS-082** · 🐘 L · 🟢 S · score 2 — Explore interpreting DICOM and media, which are retain-only today (`isRetainOnlyIntake`), and structured exports beyond what CRS-126 specifies for FHIR/C-CDA; originals stay and unsupported interpretation stays explicit. HEIC/TIFF is CRS-127.

  **User Story:** As a [Records assembler](../design/personas.md#read-unusual-evidence), I want to understand whether more of my unusual records could become readable, so that I can judge their usefulness while keeping the originals.

  **Plain-English User Walkthrough:** I review which unusual files are currently retained without interpretation. Any proposed expansion explains what it could and could not read.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Keep exploration separate from supported reading
    Given DICOM or media is currently retain-only
    When interpretation options beyond the approved format scope are assessed
    Then originals remain retained, unsupported interpretation stays explicit and the assessment does not claim the new reader is implemented
  ```

- [ ] <a id="crs-083"></a> ☁️ [CRS-083](CRS-083.md) · 🐘 L · 🟡 M · score 3 — Explore private home/cloud placement and hosted readiness without changing the supported local Compose installation or provisioning services.
- [ ] <a id="crs-110"></a> 🏭 **CRS-110** · 🐘 L · 🟢 S · score 2 — Consider a separate processing service only if CPU contention counted under CRS-109 or a chosen hosted deployment justifies it; retain profile-key isolation.

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to keep the app usable while documents are being read, so that background work does not prevent me from using my records.

  **Plain-English User Walkthrough:** I use the app while it reads documents. If measured contention becomes a problem, I review a justified way to separate the work.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Require evidence before a separate service
    Given worker contention is observed or a hosted deployment is explicitly chosen
    When a separate processing service is evaluated
    Then the proposal cites the measured need and preserves profile-key isolation without implicitly provisioning or adopting the service
  ```

- [ ] <a id="crs-145"></a> 🆘 [CRS-145](CRS-145.md) · 🐕 M · 🟡 M · score 4 — Explore emergency-contact "break-glass" access: a logged, emailed one-time code the patient sees next sign-in, using a key the patient grants in advance; owner-led, lower priority.

## <a id="experiment-related-items--pending-review"></a>🧪 Experiment-related items — pending review

The [experiment material](../experiments/README.md) is retained separately. No broad new study is a prerequisite for CRS-086.

<a id="crs-079"></a><a id="crs-091"></a><a id="crs-092"></a><a id="crs-102"></a><a id="crs-103"></a>CRS-079, CRS-091, CRS-092, CRS-102 and CRS-103 are folded into [CRS-086](CRS-086.md)'s measurement acceptance: counted requests, retries, tokens and rereads on one long fictional import, and one paired comparison of record quality and work per document.

- [ ] <a id="crs-044"></a> 🕳️ **CRS-044** · 🐕 M · 🟢 S · score 3 — Measure actual zero-yield pages during complete provider imports against independent ground truth, in the same run as CRS-086's measurement; do not use sparse text as permission to skip.

  **User Story:** As a [Records assembler](../design/personas.md#file-and-review), I want to know whether pages with no reported findings were actually read, so that blank results do not hide missed evidence.

  **Plain-English User Walkthrough:** I compare a complete document with what the reading produced. A page with no findings is explained by evidence rather than skipped because it looks sparse.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Do not infer permission to skip from zero yield
    Given an authorized complete fictional import has an independent page oracle
    When pages returning no findings are measured during the CRS-086 comparison
    Then the report distinguishes genuine zero yield from omissions and does not change page-skipping policy
  ```

- [ ] <a id="crs-087"></a> 📑 **CRS-087** · 🐕 M · 🟢 S · score 3 — Assess whether PDF text-layer headings can support bounded report/table context, feeding CRS-086's unit-of-work question; do not change page-skipping policy.

  **User Story:** As a [Records assembler](../design/personas.md#file-and-review), I want to keep headings and nearby context with the information they explain, so that a table or report is not misread when it spans sections.

  **Plain-English User Walkthrough:** I review evidence that information was read with the headings it needs. Any proposed reading change still accounts for the whole document.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Assess context without changing coverage policy
    Given fictional PDFs contain headings and tables across reading boundaries
    When text-layer headings are assessed for CRS-086 context selection
    Then the result reports bounded-context usefulness and failures without using headings to authorize skipped pages
  ```

- [ ] <a id="crs-099"></a> 🧮 **CRS-099** · 🐭 S · 🟢 S · score 4 — With separate owner authorization, the owner runs the counts-only reducer (`src/scripts/processing-library-counts.ts`) on a diagnostics export of the private library; publish counts only, never names, values, dates, filenames or paths.

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to understand the size of my filing workload without sharing my records, so that I can plan improvements while keeping personal information private.

  **Plain-English User Walkthrough:** I separately authorize the counts-only review and run it on my retained diagnostics. I inspect the aggregate output before sharing it.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Publish counts only after separate authorization
    Given the owner separately authorizes and runs the private-library counts reducer
    When its output is prepared for sharing
    Then only aggregate counts are published, excluding names, medical values, dates, filenames and paths, with retained selected scopes distinguished from unknown original-page and whole-library coverage
  ```

- [ ] <a id="crs-104"></a> 🪙 **CRS-104** · 🐭 S · 🟢 S · score 4 — Measure achieved provider cache share as cached input tokens over input tokens per request, per route, rather than assuming cached-token savings.

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to know whether my chosen reading service actually saves on repeated input, so that I can judge costs using observed results.

  **Plain-English User Walkthrough:** I inspect measured request costs for the service I chose. Claimed reuse savings are shown only when the service reports them.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Measure observed cache share
    Given an authorized route reports input and cached-input token usage
    When request-level cache share is calculated
    Then the result uses reported cached input tokens divided by input tokens for that request and route, with missing usage or a zero denominator left unavailable; implemented usage capture alone does not qualify an adopted route
  ```

- [ ] <a id="crs-106"></a> 🗜️ **CRS-106** · 🐭 S · 🟢 S · score 4 — Only if CRS-086 adopts a stage-one or compaction design, measure page-reading output size and whether compaction preserves useful evidence.

  **User Story:** As a [Records assembler](../design/personas.md#file-and-review), I want to keep useful evidence if the app adopts a shorter intermediate reading, so that a smaller summary does not silently omit information I need.

  **Plain-English User Walkthrough:** If a shorter reading step is proposed, I compare its retained evidence with the complete source. Missing information is visible before the approach is accepted.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Qualify compaction only if adopted
    Given CRS-086 explicitly adopts a stage-one or compaction design
    When its output size and retained evidence are measured against fictional source truth
    Then the report states what was preserved and omitted rather than treating smaller output as proof of correctness
  ```

- [ ] <a id="crs-107"></a><a id="crs-105"></a> 📏 **CRS-107** · 🐕 M · 🟢 S · score 3 — Verify route limits and measure token estimation, including attached-media tokens per fictional page (absorbs CRS-105), on representative content types; model claims are not account-limit evidence.

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to know the practical limits of the service I use, so that I can plan document reading without relying on advertised capacity.

  **Plain-English User Walkthrough:** I review measured limits and estimates for my chosen service. The evidence explains how images and other attachments affect those estimates.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Distinguish account evidence from model claims
    Given an adopted route is authorized for representative fictional text and media checks
    When route limits and token estimates are measured
    Then the results include attached-media token costs and distinguish verified account limits from model or marketing claims
  ```

- [ ] <a id="crs-109"></a><a id="crs-094"></a> 🤼 **CRS-109** · 🐕 M · 🟢 S · score 3 — Only when worker contention is observed, count concurrent units, queue depth, retries and 429/5xx responses, proxy health-check failures and CPU-throttle events, and report answered interactive requests as a ratio to an idle baseline on the same machine (absorbs CRS-094; its historical sweep is not a prerequisite for CRS-086).

  **User Story:** As an [Operator](../design/personas.md#operate-and-recover), I want to understand why the app slows down while reading documents, so that I can improve responsiveness without guessing at the cause.

  **Plain-English User Walkthrough:** I use the app while it reads documents. If measured contention becomes a problem, I review a justified way to separate the work.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Measure observed contention on the same host
    Given worker contention has been observed
    When concurrency, queues, retries, provider errors and host throttling are measured
    Then interactive success is reported relative to an idle baseline on the same machine, without treating a historical sweep as a prerequisite for CRS-086
  ```

- [ ] <a id="crs-113"></a> 🧭 **CRS-113** · 🐕 M · 🟢 S · score 3 — Compare model-suggested reading scope with validated defaults; preserve the historical experiment as unresolved, not an implementation prerequisite.

  **User Story:** As a [Records assembler](../design/personas.md#file-and-review), I want to understand whether suggested reading boundaries improve complete evidence review, so that I can judge a proposed approach without risking skipped information.

  **Plain-English User Walkthrough:** I compare a suggested reading scope with the validated default. The result explains its differences and remaining uncertainty.

  **Acceptance Criteria:**

  ```gherkin
  Scenario: Keep unresolved scope research separate from implementation
    Given a historical reading-scope experiment is unresolved
    When model-suggested scope is compared with validated defaults under separate run authorization
    Then the comparison preserves coverage requirements and is not presented as an implementation prerequisite or an adopted policy
  ```

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
