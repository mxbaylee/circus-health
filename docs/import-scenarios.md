# Import specification: never drop a record

_Draft, 2026-09-25. Iterating with the owner._

How importing health documents must behave, from the person's side. It is self-contained: a builder
with no access to any codebase should be able to produce the experience from this document alone.
It states behavior, not implementation. The bar is a real medical record system: nothing lost,
nothing silently changed, nothing attributed to the wrong person, and the person in control of what
enters their record. **Must** is mandatory; **should** is a strong default.

## The product in brief

- A personal health record. Each **profile** belongs to one person, **Self**, with a required full
  name and complete birth date, and optional **known names** (other spellings or earlier names
  confirmed as Self). Someone who looks after a child or parent has a separate profile for each and
  switches between them; profiles never share access.
- Profiles are encrypted; the person unlocks one to use it.
- Saved records by kind: **test results** (measurements, including vision), **medications**,
  **procedures**, **documents** (letters, visit notes, reports) and **notes**. **People** holds
  relatives and clinicians, with contact details and a free-text medical or family history.
- An **AI reader** reads uploads and **proposes** records; it never saves. A separate **assistant**
  answers questions over the saved record (for example "help me prepare for my annual physical");
  imports must leave the record complete and dated enough for it to answer well.

| Term               | Meaning                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Original           | The exact uploaded file, byte for byte                                                       |
| Proposal           | A record the AI reader suggests, with the place in the original it came from                 |
| Source             | An original, and the location in it, that supports a saved record; a record can have several |
| Version            | A later value for the same record from the same source, such as a correction                 |
| Reference material | An original kept for context that adds no clinical records to Self                           |
| Exception          | Something needing the person after reading: an unreadable page, unknown file, question       |
| Dismiss            | Decline a proposal. The original is always kept                                              |

## Principles

A design that breaks one is rejected, not traded off.

| ID  | Principle                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Never lose an original.** Every upload is kept exactly, with a checksum, whatever its format.                              |
| P2  | **Never save without me.** Nothing enters my record until I approve it.                                                      |
| P3  | **Never drop silently.** Every page is read, or listed with the reason it wasn't and can be read later in one action.        |
| P4  | **Never overwrite.** A changed value becomes a new version; every version stays, with its source.                            |
| P5  | **Never merge on a hunch.** Equal values or dates alone don't make records the same. A match is linked, never collapsed.     |
| P6  | **Never file someone else's record as mine.** The birth date is the anchor, and a mismatch stops early.                      |
| P7  | **Always show where it came from.** Every saved value leads back to each original and location that reported it.             |
| P8  | **AI is additive.** No shortcut trades accuracy or a safeguard for speed or cost; the saved record never needs AI re-run.    |
| P9  | **Interruptions lose nothing.** A closed tab, crash or provider outage keeps finished work and continues without duplicates. |
| P10 | **Removal is reversible.** Hiding or dismissing never deletes an original or a record's history.                             |
| P11 | **Few questions, never hidden ones.** Questions are grouped and batchable; a bulk action never includes anything needing me. |
| P12 | **What I chose to upload counts.** A photo or note I thought worth uploading is read and kept.                               |
| P13 | **My word beats the source.** No import overrides what I confirm about myself, such as what I take.                          |
| P14 | **No limits of our own.** No usage cap or budget; provider limits are waited out and retried.                                |
| P15 | **Leaving is not stopping.** Closing the tab, signing out or switching profiles never stops an import.                       |
| P16 | **Health terms stay private.** Test and medication names are never sent to a lookup service.                                 |
| P17 | **Keep the complete extracted text.** Retain all readable document text, including administrative and repeated content, with source locations and explicit unreadable regions. |

Reconciliation follows US certification criterion ONC 170.315(b)(2): match incoming data to the
right patient, show it beside existing data with source and date, and incorporate it only after the
person validates it.

## Requirements

### Receiving and formats

- Every upload **must** be kept exactly, including formats the app cannot read. An interrupted
  upload leaves nothing half-saved. Uploading an identical file again changes nothing.
- The app **must not** ask about file types before reading. Any kept file offers "Read it anyway"
  and "Find the words in it" later.

| Kind of file                                | Behavior                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| PDF, PNG, JPEG, WEBP, HEIC, multi-page TIFF | Read automatically                                                                    |
| Structured exports the app understands      | Imported by their structure, without AI where possible                                |
| ZIP                                         | Opened; each file inside treated by its own kind                                      |
| Medical imaging (DICOM), video, audio       | Kept, never sent to AI: "Saved as a medical image. Images are kept, not interpreted." |
| Imaging package with a report               | The report is read; the images are kept                                               |
| Anything unrecognized                       | Kept and listed afterward: "Saved, but we don't recognize this file type."            |

### Identity, before reading

- Printed patient name and birth date **must** be checked as early as possible, before AI reading
  where the text allows.
- A printed **patient** birth date that differs from Self's stops that file before reading, showing
  the printed date with "Upload the right file" and "Read it anyway". Other files continue. Only a
  birth date labeled as the patient's counts; a policyholder's, guarantor's, parent's or emergency
  contact's does not.
- A matching name with no printed birth date passes silently. No name and no birth date asks for
  confirmation.
- A matching birth date with a different name asks once: "Is this you under another name?" On yes
  the spelling becomes a known name. A spelling becomes a known name only from a document printing
  a complete birth date equal to Self's.

### Reading

- Supported files start reading automatically. Every page is read; nothing is skipped for length,
  age, apparent repetition or cost.
- Reading continues with the tab closed, after sign-out and while the person uses another profile.
  After a crash it resumes automatically once the person unlocks.
- A failing page or file is set aside as an exception while the rest finishes. A provider usage
  limit means wait, retry and update the estimate, never a failure.
- The only stop is a **Stop imports** button on the Import page; a stopped import keeps its work and
  restarts where it stopped.
- Reading ends as **"Done"** or **"Done, with exceptions"**, listing each exception once.
- Progress shows pages read, records found and a time estimate: "Estimating…" until a few pages
  finish, then a range such as "about 2–4 hours" from the measured pace, recalculated after every
  wait. The estimate predicts; it never promises. ("If it says 10 minutes I might check back; if it
  says 18 hours, I'm closing the tab.")

### Complete text extraction

Owner decision, 2026-09-26. Complete text extraction is required in addition to keeping the
original and proposing structured clinical records. Implementation and verification are tracked
in [CRS-115](application-todo.md#crs-115).

- For every supported document or image being read, the app **must** extract and durably retain
  all readable text on every page, including headings, footers, administrative instructions,
  repeated text, annotations and legible handwriting. Clinical relevance is not a reason to omit
  text. A usable text layer alone does not prove that visible annotations or image text were read.
- Preserve wording, numbers, units, negation and meaningful reading order and table relationships.
  Bind text to its original, page and applicable region or member so it can be checked against the
  source. A summary or a collection of clinical findings is not complete extracted text.
- Unreadable or uncertain regions **must** remain located exceptions with their uncertainty shown;
  never guess missing words or claim complete extraction while a region remains unresolved.
  Keep readable text from the rest of the document and allow the unresolved region to be retried.
- Extracted text **must** remain searchable and retrievable by the authorized assistant without
  requiring a new AI reading of the original. It remains source evidence, not automatically
  accepted clinical data; profile, identity and review boundaries still apply. The original stays
  unchanged and authoritative, and corrections to extracted text retain their history.
- Complete text may be retained separately from structured proposals and served in bounded
  passages. It need not be copied into every proposed record or sent in full on every model call.
  Keeping it only in temporary model history or keeping only the original does not satisfy this
  requirement. Reload and recovery must preserve the retained text without a new AI extraction.
- Account separately for pages read, text retained, unresolved regions and clinical records
  proposed or accepted. Fully retained text does not prove complete clinical extraction. The
  retain-only format exclusions above remain in force.

### Reconciling with what is already saved

| Group                       | Rule                                                                                        | Action offered                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| New                         | No saved record for the same test and date                                                  | Save                                                                          |
| Already saved               | Same test, same date, same value after unit conversion, at the precision the source printed | Mark as already saved: the new original is added as a source; nothing deleted |
| Differs from a saved record | Same test and date, different value                                                         | Side by side with both sources, one at a time; never saved in bulk            |

- **Same test** is a real match, not a character match. Tests and medications are identified with
  the public standard vocabularies: **LOINC** for tests and **RxNorm** for medications (so "Advil"
  matches "ibuprofen"). Both lists are bundled and searched locally (P16).
- The AI reader may suggest a standard name for a printed one; a suggestion counts only if it exists
  in the bundled list. A test code printed in the document is used directly. Any other equivalence
  ("Hgb" is "Hemoglobin") is confirmed by the person once per source and saved as a visible,
  reversible rule. Look-alikes that are different tests (hemoglobin, hemoglobin A1c) never match
  without confirmation.
- The printed name is never rewritten. The standard name may appear beside it, and abbreviations
  are search aliases ("A1c" finds "Hemoglobin A1c").
- **Same value** allows exact conversion within a dimension: 3 oz is 85.05 g, matching a printed
  "85 g" but not "85.5 g". No percentage tolerance. Conversions needing a per-substance factor
  (mg/dL ↔ mmol/L) apply only to a checked list of common tests: glucose, total, HDL and LDL
  cholesterol, triglycerides and creatinine. Other tests in differing unit systems stay separate.
- A converted value is always marked as converted, with the printed value and unit visible.

### Corrections and versions

- A corrected result keeps both versions. The version the source **issued later** (by amendment or
  report date, not upload order) is current, so an old export uploaded later never restores a
  corrected value.
- When confident (same source record issued later, or a report labeled amended or corrected), the
  current value is shown automatically with a "corrected" mark. Otherwise it goes to "Differs".
- Charts show the current value on the line; the older one is hidden or a separate point off the
  line, and listed below the chart as outdated. The person can choose the other version, and the
  choice is recorded.

### Reviewing and saving

- Review is by kind (test results, medications, procedures, documents, people, notes), with filters
  beneath: reconciliation group, source file, report date range, "needs attention". "The last 12
  months" filters review; it never limits reading.
- Default bulk action, within each kind: **Select all**, then **Approve** or **Dismiss**, plus
  "Mark all as already saved" where matches exist. Every bulk action shows its count and leaves out
  anything with a question or conflict.
- Review may start during reading but is never required. A record reviewed early can still be
  updated by later pages, and the person sees that it changed.
- Every save produces a receipt of what was saved, matched or updated.

### Dates

- Every clinical record **must** have a full date before it is saved. People records need none.
- A partially printed date is proposed as the first day of its period for the person to approve or
  change: "2019" as 1 January 2019, "March 2019" as 1 March 2019. The printed date stays visible
  as printed.
- With no printed date, the person supplies one or dismisses the record.
- The app never saves a date the person hasn't approved, and never expands a two-digit year into a
  century.

### Other people

- A report about someone else **must never** add clinical records to Self.
- A relative's report uploaded on purpose is **reference material**: the relative appears in People,
  the finding is summarized into their history with a link to the original ("Thyroid antibodies
  positive, 2025"), and each document that refers to a person adds a note about them.
- The relationship is optional and never prompted for. A named person is never merged into an
  existing Person automatically; an exact-name match is offered as a choice.

### Notes and handwriting

- Scans and photos are read like any document, including legible handwriting; illegible parts are
  marked uncertain, never guessed.
- A clinician's note is saved as a document and also appears in Notes.
- Measurements in the person's own photo (weight, height, blood pressure) are test results with the
  photo as source.

### Medications

Medication imports are additive.

- A medication in a document never makes the person "currently taking" it; the person chooses.
- After an import, the approval list shows only medications **not already on the person's list**,
  matched by RxNorm (brand = generic). Those switched on join the list; those left off are kept as
  history, not taking. Prescription history from documents is always kept.
- A document **must never** remove, deactivate or change a medication on the list, including by
  omitting it.
- The one exception is a suggestion, not a change: when a document explicitly records a stop
  ("discontinued valacyclovir") for a medication on the list, the approval list offers "Document
  says stopped: mark as not taking?" Nothing changes unless the person approves.
- Example: my list is Advil and valacyclovir. A new document lists B12 and D3. The approval list
  shows only B12 and D3; I switch on B12. My list is Advil, valacyclovir and B12, with D3 in
  history.

## Standard vocabularies

Both sources are free, public today, and allow bundling with attribution. Checked 2026-09-25.

| Source                                                                                                  | Covers                                                                             | Access                                   | Terms                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [LOINC](https://loinc.org/downloads/)                                                                   | Lab tests and observations, with short, long and consumer names                    | Full download with a free account        | [Free, redistributable with attribution](https://loinc.org/kb/license/); core fields unmodified |
| [LOINC Top 2000+ Lab Observations](https://loinc.org/usage/obs/)                                        | The tests behind about 98% of US lab result volume; US and SI unit versions        | Free spreadsheet                         | LOINC license                                                                                   |
| [RxNorm Current Prescribable Content](https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html) | US prescribable drugs, including many over-the-counter, with brand ↔ generic links | Monthly download, no UMLS license needed | NLM terms, attribution                                                                          |

Free online services exist ([NLM Clinical Tables](https://clinicaltables.nlm.nih.gov/apidoc/loinc/v3/doc.html),
[RxNav](https://lhncbc.nlm.nih.gov/RxNav/TermsofService.html)) but are not used, because they would
receive the person's health terms (P16). Unverified: whether supplements such as B12 and D3 are in
the prescribable subset; if not, they need another source or a person-confirmed entry.

## Scenarios

Each is a story and the checks a build must pass. The requirements above are the full rules.

| #   | Story                                                                                 | Checks                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **My first file.** I upload one lab report to see what happens.                       | Reading starts unprompted. Each proposal links to its page and location. Self's name and birth date raise no question. Nothing is saved before approval.                                                                                                                                                                                       |
| 2   | **My whole history, once.** Hundreds of pages, ten years; I don't want to babysit it. | Closing the tab, signing out and switching profiles don't pause reading. Crash then unlock resumes it. A provider limit waits and updates the estimate. An unreadable page is an exception; the rest completes. Every page is read or listed. "Estimating…", then a range. Only Stop imports stops it; restarting continues.                   |
| 3   | **A small delta.** Last week's two-page result, or a photo of it.                     | Re-uploading the identical file creates nothing. A confirmed spelling raises no question. "Select all" covers new results and nothing needing an answer. HEIC is read.                                                                                                                                                                         |
| 4   | **The annual re-export.** One new year and nine I already saved, before my physical.  | Every page is read. Already-saved records clear in one action and gain the re-export as a source. "Hgb 13.5 g/dL" matches saved "Hemoglobin 13.5 g/dL" on the same date; "HbA1c" never matches "Hemoglobin". Glucose 90 mg/dL matches 5.0 mmol/L, marked converted. Changed values go to "Differs". A date filter narrows review, not reading. |
| 5   | **A corrected report.** The potassium was re-run and changed.                         | Both versions kept with sources. The later-issued one is current regardless of upload order. The chart shows it on the line and lists the old one below as outdated.                                                                                                                                                                           |
| 6   | **A file that isn't mine.** My partner's report, by mistake.                          | A different patient birth date stops it before AI reading; other files continue. My report printing a spouse's birth date as policyholder is not stopped. "Read it anyway" continues to identity review.                                                                                                                                       |
| 7   | **I changed my name.** New records use my married surname.                            | Matching birth date, different surname asks once. Afterward, that name passes silently.                                                                                                                                                                                                                                                        |
| 8   | **Odd files.** A HEIC photo, a TIFF fax, an MRI CD folder.                            | HEIC and multi-page TIFF are read. DICOM is kept and never sent to AI. An unrecognized file is kept and listed, with no question before reading.                                                                                                                                                                                               |
| 9   | **Something interrupts.** Sleep, provider outage, server restart.                     | No proposal lost or duplicated. Reading continues once the provider is back or the person unlocks, and says why it paused.                                                                                                                                                                                                                     |
| 10  | **A relative's result, on purpose.** My sister's Hashimoto's test.                    | No clinical record added to Self. A Person proposed with a history summary and a note per referring document. No relationship prompt.                                                                                                                                                                                                          |
| 11  | **Dates missing or partial.** A result with no date; another dated only "2019".       | Neither saves without a full, approved date. "2019" is proposed as 1 January 2019 with "2019" shown as printed. Dismissing keeps the original.                                                                                                                                                                                                 |
| 12  | **Handwriting and my own photo.** A doctor's handwritten note; a photo of my vitals.  | The note appears in Notes and as a document. The readings become test results sourced to the photo.                                                                                                                                                                                                                                            |
| 13  | **A medication list that disagrees.** Lists one I stopped, omits one I started.       | Approval shows only medications not already on my list; Advil matches ibuprofen. Switching one on and leaving one off yields my list plus the one switched on. No import removes or deactivates anything. An explicit "discontinued" offers "mark as not taking?" and changes nothing until approved.                                          |
| 14  | **Someone I manage.** My child's and a parent's records.                              | Records never cross profiles. An import in one profile continues while I use another.                                                                                                                                                                                                                                                          |

### Complete-text acceptance scenario

A forty-page report has six clinical findings and thirty-three pages containing only repeated
headings and administrative continuation text. All forty pages' readable text must be durably
retained and retrievable, including a phrase appearing only on an administrative page. The six
findings may become separate structured proposals; administrative text needs no artificial
clinical record. Verify source navigation and retrieval after reload and recovery without a new
AI reading. A handwritten annotation absent from the PDF text layer must also be retained when
legible, or listed as a located exception when unreadable.

## Deferred and not yet written

- **Bulk review layout beyond the default.** The Select all / Approve / Dismiss default stands until
  a test with fictional records compares alternatives (groups beneath the kind filters, or filters
  alone) by clicks, time to clear and, above all, records cleared that shouldn't have been.
- **Scenarios not yet written:** a family's records mixed in one archive, an imaging report arriving
  with its images, and a structured portal export (FHIR or C-CDA).
