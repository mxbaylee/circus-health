# Report identity review

Identity assignment applies to each report. A name or birth-date mismatch never rejects the upload or stops reading. Pending records can be assigned to Self, an existing person or a newly created person. Records assigned to someone else remain outside Self's clinical lists and trends. Assignment leaves clinical records in review; acceptance is a separate action.

## Automatic matches and human confirmation

Reusing a Self confirmation from another report requires the current printed name still to match Self, rather than a different saved person. The confirmed report's own receipt remains applicable after a later name change; a different report asks for an explicit owner.

A unique saved-name match requires the host to check the retained original and its patient birth-date evidence. The Import list and direct detail view run this check and refresh record eligibility and review tokens when it completes, including after a server restart. A record that remains blocked does not trigger a repeated refresh loop. A name-only match remains automatically assigned and eligible for **Select all**, but its person control says **Jordan Rivera (you?) · Review**, or **(?) · Review** for another person. A name-and-birth-date match and an earlier human confirmation use **Change**. Opening **Review** and confirming creates a human receipt even when the destination stays the same. An exact current-report confirmation takes precedence over confirmations of other reports. Reusing a Self confirmation from another report requires patient-name evidence in the current report; a narrative mention of the name does not qualify.

A patient name in an unlabelled demographic banner can support the same name-only match when the host grounds it to one report. An unlabelled date column is not verified DOB evidence and cannot strengthen the match, fill a profile field or supply a DOB answer. When a routine ownership question quotes a grounded name/sex/date banner, any reading compatible with the saved person leaves the name-only match unchanged. If no valid reading matches the saved DOB, the question remains blocking until the person reviews it and confirms or changes the report assignment. The host reads the same banner from the retained original itself, so a date that fits no saved-person reading (any month/day order, or any century for a two-digit year) blocks the name-only match with a confirmation request even when the model raised no identity question; a compatible date leaves it unchanged. This is a reason to ask about ownership, not an assertion that the column is a birth date. Specific identity uncertainty questions remain blocking; labelled DOBs still follow the original-date review rules below.

### Banner compatibility and report-scoped decisions

Confirming report A cannot resolve an incompatible banner in report B, even when both reports share a printed name and the same uploaded original. A caregiver may upload several people's reports together; a confirmation records the report the person actually reviewed. For a Self receipt borrowed from A, Import compares B's unlabelled banner with Self's saved birth date—the owner that receipt would assign—whether or not the printed name uniquely matches Self. If more than one saved owner matches B's printed name, another report's receipt cannot choose among them. B remains blocked in identity preview, the Import feed, individual acceptance and bulk acceptance until its own applicable confirmation resolves ownership. Both Self and another Person can receive an explicit assignment; B's own Self receipt remains valid after an unrelated saved birth-date edit when B has no verified DOB conflict. The receipt remains report-scoped, and a confirmation does not change the saved birth date or original bytes. Valid confirmation reuse remains available where no unresolved mismatch or competing owner exists; original grounding, report boundary, membership and explicit question resolutions still have to pass the existing receipt checks at acceptance. A confirmed alias that becomes disputed or inactive does not make a borrowed receipt override B's incompatible banner.

Generational suffixes (Jr., Sr., II, III and IV, with or without a period) remain part of saved-name comparisons: "Robin Lane Sr." and "Robin Lane Jr." are different names and are never merged into one identity. If an unsuffixed printed name exactly matches one saved owner but another saved owner's name differs only by such a suffix, Import asks who this report belongs to. A printed suffix, including in surname-first form such as "Lane, Robin Jr.", distinguishes its matching owner without a new suffix prompt. A unique unsuffixed name also needs no new suffix prompt. A confirmation from another report cannot choose between ambiguous unsuffixed names, even if it taught the first owner the unsuffixed name as an alias. The current report's own applicable Self or Person confirmation resolves this question. A Self confirmation is its own report decision only for the current report version; an older-version answer remains subject to the ordinary reuse checks as later membership arrives. Editing an unrelated saved birth date leaves the unchanged report's own confirmation in force when its original contains no verified conflicting DOB. An original verified DOB conflict still blocks acceptance.

An unlabelled date such as `4/12/88` uses the same compatibility readings whether the model asks a routine ownership question or asks nothing, and whether it quotes the name alone or the full banner. Model phrasing cannot change the meaning of an unchanged original or create extra work for the person reviewing it. Compatibility keeps only the limited name-only match: the date might not be a DOB at all, so it supplies neither DOB evidence nor a demographic update. An incompatible clue still asks about ownership because silently ignoring it could file a family member's report under Self. Making that question permanently unanswerable would instead prevent a legitimate report assignment.

This resolvable banner question is distinct from interpretation of a labelled ambiguous or two-digit DOB, which still needs review, and from an exception for a verified but incorrectly printed DOB. The latter requires the separately approved explicit human attribution action tracked in [CRS-133](../todo/CRS-133.md); banner confirmation does not introduce that exception. Model-only DOB discrepancies remain advisory for the reasons below. Permanent regressions in `src/server/test/intake-generic-name-question.test.ts` and `src/server/test/intake-identity-boundaries.test.ts` exercise these distinctions.

Shared names require an explicit choice. Existing-person choices include birth dates; duplicate names also show relationships and identifiers for disambiguation. The server checks the selected person's current version and birth date. Pending acceptance rechecks the selected person’s current birth date against the original or human-confirmed reading. A new conflict blocks acceptance; unrelated profile edits leave the report assignment usable. A conflicting birth date requires another destination. Confirmed printed names with at least two name tokens can be retained as aliases without replacing primary name or birth date. A single printed name stays in the report confirmation and is not added as a reusable alias.

## Birth-date evidence

The host reads labelled patient dates from retained text or the explicit original PDF page, independently of model suggestions. JSON and JSONL decoding preserves field labels, roles and object boundaries. Multiline patient and nonpatient person labels apply to the following fields. Unknown structured person roles require human review rather than an automatic patient match. Supported labels include DOB/D.O.B., date of birth, birth date/birthdate and date-like Born labels. Numeric and full or abbreviated month-name dates are supported. Patient, relative, subscriber, policyholder, insured, guardian, parent, responsible-party, guarantor and contact fields bound the scan.

An ambiguous labelled numeric birth date retains both valid readings and asks for review, even when only one reading matches a saved birth date. Masked, incomplete and otherwise unreadable dates also ask. A two-digit year prefills a suggestion using the latest century that places the birth date on or before a reliably associated report date, or today otherwise. A year-only original such as `DOB: 88` offers a year-only suggestion such as `1988`, without inventing a month or day. The person can correct the date or explicitly retain uncertainty. Suggested centuries never establish an automatic match or fill a saved profile field. A human date answer is retained with this report's confirmation; it does not change the person's saved birth date.

If the model reports a birth date that differs from the assigned person’s saved date and the original reader has not verified a DOB, Import shows a nonblocking warning. It identifies the model reading as unverified and lets the person review the original or change the assigned person. The warning does not require another DOB answer, change acceptance eligibility, establish identity or update saved demographics. Verified original DOB evidence takes precedence. This is advisory because the bounded reader can miss a date that the model noticed, while a model claim alone is not reliable enough to override the original or the person’s assignment. Uncertainty printed in the original still requires review even when a model supplies a plausible complete date. Name proofs, question proofs and DOB facts share one bounded cache per unlocked database, with independent entries for report groups even when they refer to the same header. Negative checks replace earlier proofs atomically and eviction removes them together. Original date facts survive candidate membership growth; current name/question proofs still require the new scope. Reopening a database requires checking the original again.

This is a bounded header reader, not a universal patient-field detector. Unrecognized labels, dates outside the header, ambiguous report dates and images without readable text remain limitations. The original stays available for human review. Report-boundary grounding also requires a uniquely locatable anchor. Prepared JSONL can repeat a report title inside payload and metadata fields; when that makes the boundary ambiguous, a retained structured name alone does not authorize automatic assignment. The current queue requires explicit report confirmation in that case.

## Conflicting extraction claims

When another extraction group claims a different subject at the same report boundary, the person sidebar displays the competing claims and asks for an explicit decision about the original and listed records. The confirmation pins those claims, their versions and the exact pending occurrences. It neither rewrites the model's claims nor assigns the competing group. Later records and changed competing claims require another decision. A missing or unlocatable original subject cannot gain authority from this repair; the original and valid report scope remain required.

The same identity policy controls individual and bulk clinical acceptance. Editing a clinical value does not resolve identity. Stale scopes and unconfirmed identity questions remain blocking, and accepted history is not silently reassigned.

## Relatives' medications

Relatives follow the same medication rules as Self. Imported prescriptions remain clinical history and default to inactive, regardless of a provider's reported status. The profile owner can confirm current use on a relative's behalf. This personal assertion stays separate from provider evidence and does not rewrite the original prescription.

Reference material means an original retained for context with no clinical records for anyone. It is not the classification for a relative's prescription history.

See [processing](processing.md) for the surrounding workflow and [the intake API](../../src/server/INTAKE.md#common-report-identity-review) for scope, receipt and replay contracts.

## Historical attribution and current name authority

A confirmation answers two different questions: who the person assigned the displayed
report to at that time, and whether its printed full name can help match a later report.
The original, accepted versions and confirmation receipt retain the first answer.
Historical linkage alone is not a reason to keep a mistaken name association active
forever: doing so would turn one mistaken confirmation into repeated wrong-person
assignments. Any correction of the second answer must preserve the first answer as
evidence. Primary names and saved birth dates remain separate assertions.

New full-name confirmations retain a separate support entry for each decision and
report boundary, including repeated confirmations of the same spelling. The compact
`sourceKnownNames` display list still keeps its original evidence link; it is not a
complete ledger of support. The first support entry records whether the name already
had a manual or primary-name assertion before it was mirrored into `knownNames`.
Legacy names whose origin cannot be established retain unknown provenance. Mirroring
a learned name into the editable name list does not independently affirm it.

Ownership corrections also record separate destination support for each affected
source and report boundary. Later corrections follow those contributions, including
after rebuilding the database; they never copy the first same-spelling report's
provenance or revoke a sibling contribution merely because both moved together.

The distinction matters for a caregiver correcting a mistaken assignment: moving one
report cannot silently withdraw another report's independently affirmed association,
and equal spelling does not merge people. A single printed name remains report-scoped.
Current name authority follows versioned correction decisions. People distinguishes active,
historical corrected and unresolved source names, with links back to the originating
report's audited correction. Ordinary name editing cannot rewrite historical evidence.
An independently entered unlinked name remains editable. Mirroring a learned name is
not a new manual assertion; uncertain legacy provenance requires review.

## Correcting accepted person assignments

Use **Change person · saved and pending records** in report review, **Change person**
on a saved clinical record, or **Select records to change person** in saved collections.
Saved-result, prescription, procedure and provider-note action menus each compose one
**Change person** control separately from **Correct saved record**. The correction control
does not add ownership actions implicitly. Completing the person-change dialog refreshes
the owning detail view. Source-document and vision views retain their own person-change
controls; report-level controls name their broader saved-and-pending scope.
Self, any active Person, and a Person created by the correction are available destinations.
The preview pins the displayed membership, records, source contributions, destination,
matching decisions, relationships and name support. Changed evidence or profile state
requires a fresh preview. A new Person is created only with the successful correction.
Unlike ordinary report assignment, this reviewed correction can create the Person
named by a mistaken learned Self alias: its name effects supersede the mistaken
authority in the same transaction. Equal spelling alone does not establish one person.

A report correction covers exactly that report's current contributions and pending
assignments. It also establishes a standing default for later members of the same
unchanged original/member/report/printed-subject boundary. Later clinical records still
require acceptance. A selected-record correction covers every source of those saved
records, leaves other records untouched, and creates no report default. The confirmation
states this distinction and links back to report correction when only one contribution
should move. If a selected-record correction contradicts an earlier standing report
assignment, the preview also revokes that default’s future authority. Other accepted
records keep their owners; later unaccepted members require renewed report identity
review instead of silently inheriting either person. A new explicit, valid confirmation
can resolve this hold.

When reports A and B support one saved record, correcting B keeps A's stable record ID
and history with its owner. The preview proposes B's contents from its retained accepted
mapping and shows A's remaining contents and both sets of originals. Both sides require
explicit clinical review. Missing or incompatible attribution requires an exact reviewed
mapping; the service does not copy the merged record's contents into B automatically.
Legacy contributions without an accepted-mapping snapshot require this review too.

Apparent destination matches require an explicit **link** or **keep both** decision.
Linking preserves the destination's clinical contents and medication activity. A moved
or newly split prescription starts inactive; the previous person's taking assertion
remains in history. Relationships that would cross owners require explicit withdrawal
or a new selection including their dependent records. A withdrawal preserves its earlier
decision as historical evidence.

Each displayed atomic correction group includes applicable name decisions. Unrelated
selected reports have separate groups; genuinely shared name support or relationship
dependencies join their groups. A partial failure leaves saved groups in place and
identifies unsaved records for a fresh preview.

The correction includes applicable name decisions. When all effective
support for a learned full name moves, the preview proposes transferring that association.
If independent support remains or legacy support is uncertain, choose the former person,
destination, both, or unresolved. Unresolved associations stop automatic reuse of the
challenged name and supporting receipts; they do not move unselected records. Other
people with the same spelling remain independent. Single-token names remain report-scoped.
A later explicit confirmation can reestablish an association with new support; an old
receipt or retained historical spelling cannot do so by itself.

Current limitation, open in [CRS-139](../todo/CRS-139.md): an "Always …" future-name
choice is applied before other owners are compared, so it can outrank another saved
person's own name. It is not shown in People, cannot be revoked there, and a later
correction does not end it.

An unresolved learned association remains a visible competing claim. A later report with
that printed name asks for explicit identity review even when only one other saved person
currently matches. A separately entered primary or manual name retains its own authority;
the learned association cannot remove it. The correction review can also choose who should
receive _future_ reports with that name: Self, a named Person, or **Ask each time**. This
choice governs later matching only. It does not rewrite earlier confirmations or move
accepted records. A selected-record correction places unaccepted members of the affected
report on hold until the report itself is confirmed again, even when the old confirmation
was ordinary and no standing correction default existed.

Original-grounded DOB conflicts remain blocking. Ordinary ownership correction neither
changes a saved DOB nor grants the separate printed-DOB exception tracked in
[CRS-133](../todo/CRS-133.md). Explicit unanswered identity questions, refusals, changed
boundaries, unavailable people and new contradictory evidence require review. Cold
original-grounding caches are rebuilt by opening identity review; a cached assignment
never substitutes for checking the original.

The browser keeps an uncertain save's operation ID with the exact profile, dialog and
selection, then reconciles it before permitting another correction. A definite refusal
requires a fresh preview with its reason displayed. Undo starts a new preview and
correction against current records, sources, relationships and names; the earlier link or
split decision is not preselected. It preserves intervening edits and never deletes the
earlier decision or automatically collapses a previous split. Accepted versions are
available from the corrected record's history. A new export packet includes the person
correction in PDF and evidence data; the app has no durable ledger of which earlier
packets were generated or shared, so a person must check copies they already shared.

Historical raw allergy, condition, visit and immunization assertions may predate explicit report-subject evidence. The [packet ownership evidence inventory](../../src/server/NOTE-EXPORTS.md#historical-raw-assertion-ownership) distinguishes accepted mappings and exact human receipts from raw names, shared files and source mentions. Packets omit unresolved assertions with a generic notice; current identity confirmation does not implement a historical backfill or raw-assertion review path.
