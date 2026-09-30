# Reliable review and partial clinical saves

Clinical review saves the valid, explicitly selected records and returns an exact outcome for every selection. A stale or invalid independent record does not undo another person's valid review work. A self-tracker should not repeat nine approvals because a tenth result changed; a caregiver must know which person's records actually saved.

## Approval authority and commit boundaries

The browser opts into `mode: "partial-v1"`. Each selected occurrence carries the server's `selectionReviewToken`, its intake/proposal, record ID, candidate/version, reviewed mapping and comparison decisions. The UI retains that selection snapshot across background refreshes. Detail approval waits until its own answer/draft write has finished and the acknowledged review version is displayed. It cannot replace the person's approved values with a fresh server mapping. A changed draft, source interpretation, identity assignment, candidate or chosen comparison destination requires explicit review again.

The selection token excludes unrelated profile/intake transport revisions. Saving an independent sibling is not another human review and must not invalidate an unchanged approval. Newly discovered comparison suggestions are advisory; they do not establish a relationship. Exact selected comparison scopes and automatic duplicate/source identities are still checked within publication. Chosen destinations are resolved directly; pagination and explicit search affect discovery, not approval validity. Changed destination values or evidence still require fresh review. The source and identity authority used by the selected record remains pinned.

Clinical rows, source occurrences, destination updates, identity attribution and acceptance receipts for one record publish together. Selections sharing an explicit source assertion or destination effect form one commit group and receive itemized explanations if that group cannot publish. Matching labels and dates alone do not establish a shared event. Whole-report ownership corrections must remain atomic: partially changing a report while displaying a fully changed owner would misrepresent its records and future name matching. Their implemented scope is described in [ownership evidence and correction scope](../data/change-history.md#ownership-evidence-and-correction-scope). Partial saves concern independent approvals, not an indivisible correction.

Source-text approval and clinical acceptance remain separate assertions. Saving a record does not approve its text. Changed source dependencies require fresh interpretation/review. The source-text acceptance gate and any combined approval interaction remain tracked in [CRS-129](../todo/CRS-129.md).

## Outcomes and recovery

A version 1 partial receipt has `atomic: false`, `status: "completed"` and an immutable result per selected item:

- **Saved** includes the exact durable destination record, source occurrence and added/matched/updated outcome.
- **Needs review** identifies a stale, blocked or invalid selection, with a stable reason code and an actionable explanation.
- **Failed** means the operation definitively did not publish clinical changes.
- **Not attempted** means a shared failure or interruption stopped processing before this item completed. Already committed results remain saved.

Each item includes its original selection token, reviewed-selection hash, deterministic child operation ID and bounded optional record label, kind, assigned person ID and report name. The browser resolves the person's current name when displaying an outcome, so identical names also show distinguishing person details; older receipts use a neutral report fallback. The stable parent operation manifest is written once. Item results are separate bounded journaled records, committed alongside the affected clinical rows; children do not append a growing copy of the parent request or preceding results. SQLite is a rebuildable projection, not the recovery authority.

A lost HTTP reply or ambiguous durable-head acknowledgement is **Checking save status**, not a final failure. Retain the original operation ID and reconcile its journal before retrying. A receipt lookup never performs new clinical acceptance. After recovery, interrupted uncommitted items become not attempted; they require a new explicit approval and operation. Replaying the original parent returns its completed results without duplicating publication, including after restart/rebuild. Changed content or changing between atomic and partial modes under the same operation ID conflicts. Lock and profile authorization apply to every call.

The browser retains only an opaque operation ID in session storage; clinical request contents remain in memory. An absent receipt while the transport outcome is unknown does not authorize a fresh operation. On reload, saved manifest results can be recovered by the original ID. When no manifest is available, the UI keeps the uncertainty visible instead of guessing that the request failed.

Only confirmed saved selections are removed. A submitted item needing review loses its stale checkbox and approval snapshot, retains its editor, and needs a fresh explicit approval; a changed displayed token does the same. Items omitted from an operation are shown as not sent, with a reason, without being counted as saved. The overview sends more than 1000 selected records as sequential operations of at most 200 selections; a child with an unknown outcome stops later children. Confirmed child receipts combine into one summary, including a child reconciled later by its original ID. A background feed response describing an item as saved is not acknowledgement of a newer local edit. Receipt links refer to exact returned entity IDs; current ownership is resolved separately, because later ownership corrections do not rewrite historical receipts. People operations use their own outcomes and are submitted separately from clinical selection saves.

Exact-record detail recovery matches the intake, proposal and record across all receipt blocks, including multiple saved siblings from one partial operation. A confirmed receipt hides repeat save controls for that exact candidate/version immediately, while refreshed review data is still arriving.

## Drafts, source revisions and People

A correction reason is associated with the changed fields and values it explains. The browser sends `correctionPatch` with its reason, and the server verifies that association against the actual changes before journaling the before/after values. Coalesced unsent work may retain a displayed reason for its current patch; an unrelated later edit does not inherit it. A transport retry retains the exact patch, reason, version and operation ID. An acknowledged reason is cleared without discarding newer queued work or historical reasons.

Source attention reconciles local save responses and resource refreshes by profile/intake scope and revision. A pristine editor follows the current source text. A dirty editor retains its text, displays the new revision for comparison and requires an explicit rebase or replacement before saving. Older responses cannot mask newer source state. Selection eligibility and remaining issue counts use the current revision, including while a local editor remains open.

The shared person chooser retains the exact selected Person and keyboard focus through refresh. Duplicate names include birth date, relationship and stable identifiers. The same canonical Self-name and saved-alias rule prevents creating a second Self through report assignment or People proposal acceptance. Caregivers may still confirm current medication use for relatives; exact record/version and active-profile authorization apply. Relative records, counts and charts remain separate from Self.

## Regression evidence and implementation boundaries

The implementation and independently fictional tests below cover the current contracts. Count tests measure review calls and journal writes, bytes and rows at 10, 50 and 200 selections; a 500-selection yielded save serves a read before completion. Real process-restart browser coverage replays the original operation. Person badge/list checks use mounted per-path API responses; they are not a full destination-page browser journey. The overview's approval state, outcome rendering, identity controls and source controls, plus the detail identity panel, are split into smaller modules. The detail record editor remains in its existing component.

- Counts/links and owner interpretation (R19/R28): `PersonClinicalRecords`, the existing `/record-owner` resolver, shared `person-scope` helpers and `SavedRecordDestinations`; `clinical-person-ownership.test.ts`, `person-clinical-records.test.tsx`, `person-scope.test.ts` and `import-review-reliability.test.tsx`.
- Caregiver medication activity (R20): existing `setMedicationCurrentStatus`/`appendMedicationPreference` behavior; `clinical-person-ownership.test.ts` and encrypted person-scope browser journeys.
- Partial results, exact approvals and unknown recovery (R21): `intake-partial-acceptance`, `intake-selection-authority`, `ImportAcceptanceOutcomes` and `useReportAcceptance`; `intake-report-acceptance.test.ts`, actual source/identity mutation tests in `intake-source-integration.test.ts` and `intake-identity.test.ts`, shared-destination group tests in `intake-independent-acceptance.test.ts`, mounted acceptance/presentation tests and `partial-review-save.test.ts`.
- Reason association (R22): `useReviewDrafts`, independent draft validation/journaling; `use-review-drafts.test.tsx` and `intake-generic-name-question.test.ts`.
- Stable/disambiguated person choices and second-Self checks (R23–R25): `ImportPersonChoice` and shared `matchesSelfIdentityName`; mounted reliability/presentation tests and server identity/People tests.
- Source revisions (R26): `useSourceAttentionRevision` and `SourceAttentionReview`; mounted source-text tests and encrypted source-text journeys.
- No production fixture fallback (R27): production presentation defaults to empty arrays, and no fixture data ships in the app. The unused design prototype and its fixtures were removed on 2026-09-30. Production Vite input is `src/index.html`.
- Effects, accessibility and boundaries (R29/R30): correction state resets use actual record/scope context rather than recreated props; the mixed-save summary uses one live region and item links use native accessible controls. Overview approval state, identity/source sheet controls, outcome rendering, destination resolution and durable partial acceptance have separate modules. Existing navigation/draft guards remain at their owning editors. Mounted detail/presentation tests and the keyboard/narrow real-restart browser journey cover those boundaries.

See the [acceptance API](../../src/server/INTAKE.md#counted-report-acceptance) and [reconciliation contract](import-reconciliation.md#atomic-counted-selections-and-reconnect-receipts).

Failed outcome labels do not infer Self from missing ownership. An unresolved report identity is shown as “Person not confirmed” until the report has an applicable ownership decision.
