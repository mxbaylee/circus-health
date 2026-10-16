# Backlog workflow

The [index](readme.md) is the complete open catalog and the sole authority for current sizes, production marks and scores. The rules below govern writing, selection, review and retirement.

Each open item carries an effort and an impact size (S, M or L; owner request, 2026-09-30). The sizes live only in the [index](readme.md), so there is one place to update. They inform prioritization but are not priority.

- **Effort** (🐭 S · 🐕 M · 🐘 L) counts the work the app's builders control: design, implementation and verification, including owner time for devices or provider runs. It is not calendar time, and never a bound on model work. 🐭 **S** is one focused change with its tests. 🐕 **M** is several coordinated changes, or one design choice within a known shape. 🐘 **L** needs design plus a multi-part implementation or migration, or many owner-run checks.
- **Impact** (🟢 S · 🟡 M · 🔴 L) is judged by the [personas](../design/personas.md). 🔴 **L** protects patient safety or data correctness: the wrong person, a lost or silently incomplete record, a wrong printed value. It also covers unblocking a main job for a main persona. 🟡 **M** is noticeable friction, cost or trust for a main persona. 🟢 **S** is internal quality, polish or an option to explore.
- 🚀 **production** marks work required before the app is relied on for real records. That means the owner's household using the supported local installation as their records store, on localhost; remote deployment is conditional on need (owner, 2026-10-01). Every release check is required, through the 🚦 CRS-061 gate. An unmarked item can still matter; it just doesn't block that use. ☂️ marks an umbrella specification that is sized by its tickets.
- Each ticket also has its own emoji, decoration only, reused as little as possible. Its CRS file's title carries the same emoji, and IDs stay the stable identifiers.

Application documentation describes implemented behavior and current limitations; future work, its specifications and its plans live here. Before deleting a ticket, carry its unmet requirements, owner decisions and open questions into a new or existing item.

Keep the reason for a decision as well as its resulting behavior: who it serves, the failure it prevents, its limits and any earlier rule it supersedes. On implementation, move that rationale into maintained behavior documentation before deleting the ticket, and repoint links. Non-obvious regression tests should include a short why comment tied to that rationale; a test's expected value alone is not the product decision record. Import/identity decisions are consolidated in [CRS-126 D5 and D8](CRS-126.md#d5-identity-evidence-human-decisions-and-incorrect-printed-dobs-are-different-facts) while open.

## <a id="ticket-writing-and-review"></a>Ticket writing and review

Owner guidance, 2026-10-02, narrowed after the completed backfill on 2026-10-03: every incoming ticket explains its user outcome using the canonical [personas and jobs](../design/personas.md). Use documented persona names and link the relevant job. The supplied story, walkthrough and Given–When–Then structure guides readable intent; it does not add scope or require mechanical rewriting of useful specifications. Keep stories about what the person wants and why, without implementation jargon. Describe their experience in a concise plain-English walkthrough. Put business rules, edge cases, technical ambiguity and engineer details in acceptance criteria or explicitly referenced contract sections, preserving existing requirements and evidence boundaries. Keep the detail proportionate to the task: even a short specification lives in its owning CRS file, while the index keeps one concise catalog row. PR #54 backfilled all existing open items. Ordinary ticket edits do not require rewriting their stories; update the story or walkthrough when the user outcome or scope changes, preserving acceptance requirements. The next grooming checks for any missed coverage, rather than repeating the completed backfill.

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

Owner guidance, 2026-10-16: use the canonical personas to resolve product questions, considering affected stakeholders beyond the primary persona. Include the [Operator](../design/personas.md#operate-and-recover) and the [record-integrity lens](../design/personas.md#record-integrity-lens) where recovery, privacy or health-data accuracy is affected. Record the rationale and preserve prior explicit decisions. Persona judgment can resolve design choices; it does not substitute for required device/provider evidence or claim owner review that has not occurred.

Follow `AGENTS.md` for independent review and the normal feature-branch/required-CI/squash-merge workflow. Supply the reviewer with scope, requirements and current evidence; ask for an unbiased numerical grade, actionable findings, useful improvement feedback and limitations, without a desired score or expected conclusion. Resolve blocking findings and verify fixes before the final review and merge. Historical splits below remain history, not a rule that high effort must be split again.

## Backlog grooming cadence

Owner instruction, 2026-10-02: after every seven merged ticket completions, groom the backlog before starting the next implementation. Recheck requirements against code, persona/operator gaps, owner decisions versus proposals, dependencies, effort/impact and the top five; preserve unresolved decisions in their owning tickets. Keep readable persona-based stories, plain-English walkthroughs and Given–When–Then acceptance current across all remaining backlog items, including short specifications linked from the index. The 2026-10-03 grooming backfills that guidance across the existing backlog; subsequent grooming verifies the user intent and engineering contract still agree. Count completed tickets, not commits or pushes. A split with no implemented completion does not advance the count. Record the new checkpoint and reset the count only after the grooming change merges.

## <a id="picking-the-next-item"></a>🥇 Picking the next item

Add up the points; the highest score is next.

|            | 3 points  | 2 points | 1 point |
| ---------- | --------- | -------- | ------- |
| Production | 🚀 marked | —        | —       |
| Impact     | 🔴 L      | 🟡 M     | 🟢 S    |
| Effort     | 🐭 S      | 🐕 M     | 🐘 L    |

Scores run from 2 to 9. For example, 🚀 🔴 🐭 scores 9, 🚀 🔴 🐘 scores 7, and an unmarked 🟢 🐘 scores 2. The 🚦 gate and ☂️ umbrella entries are not picked; they close when their checks and tickets do.

1. **Skip what can't start yet.** An item that depends on an unfinished ticket waits for it. The agent does all the work, including code, tests, docs and verification harnesses. Some items also need an input only the owner can give: a physical device in hand, a sign-in or credential, authorization for paid inference or a run, or an explicit adoption/risk-acceptance decision. Those still rank normally. Do all the preparation, then ask once for exactly that input, saying what to tap, sign in to or approve. Work the next item while waiting.
2. **Break ties in this order:**
   1. an item whose finish unblocks another open item, named in its ticket;
   2. higher impact;
   3. lower effort;
   4. lower ID.
3. **Before starting, re-read the ticket and confirm it is still true.** Resolve delegated product questions with the canonical personas, Operator and record-integrity lens, recording rationale while preserving prior explicit decisions. Prepare everything possible before requesting a genuinely external authorization, evidence or adoption/risk-acceptance input; routine policy questions are not owner-only blockers.
4. **When done, follow the practice above:** an independent grade per `AGENTS.md`, then delete the ticket or open a scoped remainder, which gets its own sizes.

Sizes and marks are estimates. When starting a ticket shows one is wrong, correct it in the index in the same change.

Open scoring proposal (review feedback, 2026-10-01): an earlier draft reportedly proposed a 🫀 user-flow mark worth 4 points. Confirm whether it was intentionally dropped or should be reconsidered, including how it combines with production/impact/effort and changes tie-breaking. This mark is not adopted; keep the current scoring and ranking until the owner records a decision. Do not treat a reported unpublished proposal as current policy.

Dependency-priority proposal (owner discussion, 2026-10-02): dependencies should inherit urgency from downstream tickets, with an accumulation effect. The current candidate is boosted score = base score + number of unique unfinished prerequisites, then effective priority = the highest boosted score among the ticket and all downstream tickets it blocks. This interprets the owner’s example as a 4-point ticket plus three unique prerequisites = 7. Count shared prerequisites once, exclude completed tickets and release-gate/umbrella scores, and retain base scores separately. This formula is still under discussion, not adopted; current scores and the ranking below continue to use the existing rules.

Each open item shows its score after its sizes. When a size or mark changes, recompute its score in the same change.


[Current queue](readme.md#top-5) · [Grooming and identifier history](history.md)

Refresh the [next ready queue and visible waits](readme.md#top-5) whenever a ticket is added, retired, re-estimated or its dependency/input status changes. Apply the scored selection rules above; distinguish ready implementation from an external-input hold and link a genuine human gate to its issue. A provided input removes that hold only, not its qualification requirements.

## Retirement and identifiers

IDs are stable and never reused; the next unused ID is recorded in the index. When a ticket’s work lands, delete its catalog row and CRS file in the same change and document shipped behavior in maintained documentation. If only part lands, retire the old ticket and allocate a new scoped remainder preserving its unfinished requirements, prior decisions and open questions. Historical closed identifiers do not certify current behavior.
