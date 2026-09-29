# Report identity review

Identity assignment applies to each report. A name or birth-date mismatch never rejects the upload or stops reading. Pending records can be assigned to Self, an existing person or a newly created person. Records assigned to someone else remain outside Self's clinical lists and trends. Assignment leaves clinical records in review; acceptance is a separate action.

## Automatic matches and human confirmation

A unique saved-name match requires the host to check the retained original and its patient birth-date evidence. A name-only match remains automatically assigned and eligible for **Select all**, but its person control says **Jordan Rivera (you?) · Review**, or **(?) · Review** for another person. A name-and-birth-date match and an earlier human confirmation use **Change**. Opening **Review** and confirming creates a human receipt even when the destination stays the same. Reusing a Self confirmation from another report requires patient-name evidence in the current report; a narrative mention of the name does not qualify.

Shared names require an explicit choice. Existing-person choices include birth dates; duplicate names also show relationships and identifiers for disambiguation. The server checks the selected person's current version and birth date. Pending acceptance rechecks the selected person’s current birth date against the original or human-confirmed reading. A new conflict blocks acceptance; unrelated profile edits leave the report assignment usable. A conflicting birth date requires another destination. Confirmed printed names with at least two name tokens can be retained as aliases without replacing primary name or birth date. A single printed name stays in the report confirmation and is not added as a reusable alias.

## Birth-date evidence

The host reads labelled patient dates from retained text or the explicit original PDF page, independently of model suggestions. JSON and JSONL decoding preserves field labels, roles and object boundaries. Multiline patient and nonpatient person labels apply to the following fields. Unknown structured person roles require human review rather than an automatic patient match. Supported labels include DOB/D.O.B., date of birth, birth date/birthdate and date-like Born labels. Numeric and full or abbreviated month-name dates are supported. Patient, relative, subscriber, policyholder, insured, guardian, parent, responsible-party, guarantor and contact fields bound the scan.

An ambiguous numeric date retains both valid readings and asks for review, even when only one reading matches a saved birth date. Masked, incomplete and otherwise unreadable dates also ask. A two-digit year prefills a suggestion using the latest century that places the birth date on or before a reliably associated report date, or today otherwise. A year-only original such as `DOB: 88` offers a year-only suggestion such as `1988`, without inventing a month or day. The person can correct the date or explicitly retain uncertainty. Suggested centuries never establish an automatic match or fill a saved profile field. A human date answer is retained with this report's confirmation; it does not change the person's saved birth date.

Model-only birth-date hints neither supply original evidence nor create an additional DOB decision. Uncertainty printed in the original still requires review even when a model supplies a plausible complete date. Name proofs, question proofs and DOB facts share one bounded cache per unlocked database. Negative checks replace earlier proofs atomically and eviction removes them together. Original date facts survive candidate membership growth; current name/question proofs still require the new scope. Reopening a database requires checking the original again.

This is a bounded header reader, not a universal patient-field detector. Unrecognized labels, dates outside the header, ambiguous report dates and images without readable text remain limitations. The original stays available for human review.

## Conflicting extraction claims

When another extraction group claims a different subject at the same report boundary, the person sidebar displays the competing claims and asks for an explicit decision about the original and listed records. The confirmation pins those claims, their versions and the exact pending occurrences. It neither rewrites the model's claims nor assigns the competing group. Later records and changed competing claims require another decision. A missing or unlocatable original subject cannot gain authority from this repair; the original and valid report scope remain required.

The same identity policy controls individual and bulk clinical acceptance. Editing a clinical value does not resolve identity. Stale scopes and unconfirmed identity questions remain blocking, and accepted history is not silently reassigned.

## Relatives' medications

Relatives follow the same medication rules as Self. Imported prescriptions remain clinical history and default to inactive, regardless of a provider's reported status. The profile owner can confirm current use on a relative's behalf. This personal assertion stays separate from provider evidence and does not rewrite the original prescription.

Reference material means an original retained for context with no clinical records for anyone. It is not the classification for a relative's prescription history.

See [processing](processing.md) for the surrounding workflow and [the intake API](../../src/server/INTAKE.md#common-report-identity-review) for scope, receipt and replay contracts.
