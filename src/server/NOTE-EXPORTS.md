# Visit briefs and new-provider packets

Print / Export is available at the top of notes and the canonical Self profile. Editing surfaces save their current draft before loading options or previewing; a failed save stops export. Export never finishes, archives or rewrites a note.

## Two simple flows

**Visit brief** starts with the saved initiating note. Five booleans control directly linked entries, attachments, procedure history, personally confirmed current prescriptions and patient information. Links never recurse. Attachment inclusion covers the note and included direct/clinical entries. Current use comes from personal medication preferences, never an old provider `active` status. Source status, dose and personal confirmation remain separately labeled.

**New provider packet** starts from Self or a note. Its only user selection is additional personal notes. A note that initiates the export is always included. Selected notes bring direct links and attachments automatically; no attachment picker or depth option. The automatic clinical packet includes normalized Self medications (current and history), procedures, observations, known non-personal-provider documents and otherwise unrepresented retained clinical assertions. Source records already represented by normalized entries/evidence are not added again. Canonical entry IDs and attachment hashes deduplicate repeated selections; provenance and attachment ownership are retained.

There are no dedicated allergy, condition or visit tables yet. Those facts remain in provider narratives and additional retained `clinical_object` source assertions rather than being silently omitted or interpreted. They are clearly labeled; absence of a separate summary does not mean no allergies/conditions. Patient information and a personally confirmed current-prescription summary precede supporting clinical records. Source metadata preserves issuer versus acquisition provider, original paths/hashes, page/region locators and uncertainty. Unique provider narratives remain literal; no clinical interpretation is generated. Provider result histories use compact tables grouped by test and unit, retaining date/precision, result, reference, status and numbered citations. Prescriptions and procedures use concise recorded fields. Exact duplicate narrative text is printed once with every distinct entry attribution retained; no semantic deduplication is attempted.

**Sharing boundary:** automatic documents require a recorded provider whose ID/name is not marked personal. Unknown-provider and personal-source documents are conservatively excluded unless directly linked from a selected note. Automatic raw assertions use that same provider boundary and only clinical kinds. Other unselected personal notes, Self's private freeform note content, and care contacts' private notes/medical histories stay out. Patient information uses an explicit demographic/contact/medical-history field list; active care/emergency contact roles share only names, roles, phone/email and scheduling URL. Selecting a note linked to a person deliberately includes that person's linked entry. This scope is stated in the preview; it is not a claim to contain a complete hospital chart.

## PDF and automatic evidence companion

Provider packets automatically offer **Download evidence JSON** alongside the PDF, with no extra selection options. The PDF contains patient/current-medication orientation, selected notes, compact clinical tables, unique literal clinical narratives and readable additional clinical assertions. It explicitly points to `provider-evidence.json` for full supporting detail: raw source objects, complete original structured document text (including generated PDF-outline metadata), mapping metadata, medication confirmation details and all indexed source locators/file hashes. Those operational/raw details are not printed as thousands of redundant PDF pages. No unique original bytes are removed from the companion: `raw_json` remains a literal string, including large numeric tokens and duplicate JSON keys.

The companion has format `circus-health-provider-evidence-v1`, the frozen snapshot fingerprint and a stable numbered `citationIndex` matching every PDF [number]. It projects only export records, not UI `getNote` payloads/backlinks; links point only to included entries. Asset ownership metadata is filtered to included owners, so an unselected private note sharing the same asset cannot disclose its caption. The clinical data remains unchanged. Provider snapshots and evidence JSON also carry `readingGaps` for cited intake originals: each unfinished, unreadable or processing-stalled plan unit is named by its retained locator and reason. The PDF prints those gaps in an Unread source sections section. A source with no established plan is labeled as lacking page coverage. This disclosure describes only included cited sources, not every original in the profile.

## API contract and immutable previews

Converted proposal citations follow their retained original pointer, including source/package parents. A unit counts as read only with its matching retained coverage receipt; a completed status alone is insufficient. A retained original without an active reading plan is not established as fully read. This disclosure does not create a packet-delivery journal or identify who received an earlier packet.

POST `/note-exports/options`: `{type: "note" | "document" | "person", id}`. Person entry is restricted to `patient`. Returns `noteVersion`, `noteTitle`, `choices` (including note `kind`) and legacy asset choices. New UI only uses non-person note choices for additional-note selection.

POST `/note-exports/preview`: same origin plus `noteVersion`, `mode: "brief" | "provider"`, `noteIds: string[]`, and brief flags `includeLinked`, `includeAttachments`, `includeProcedures`, `includePrescriptions`, `includePatient`. Provider mode ignores false brief flags and builds its standard packet. Self origin only accepts provider mode. Preview responses include `evidenceAvailable` for provider packets. POST `/note-exports/:token/evidence` downloads `application/json` with filename `provider-evidence.json`; it uses the same profile-scoped token, expiry and current-fingerprint validation as PDF download, and rejects brief previews. Additional-note IDs must identify non-person notes in the active profile. Missing links fail visibly rather than disappearing. The simplified flows include chosen archived history, labeled as archived, without a further toggle; care-contact summary excludes archived contacts.

Legacy `selected`, `assets`, `detailed`, date bounds, archived selection and trend rendering remain supported for existing callers/tests, but are not exposed in the new UI. Legacy/current brief limits remain 2,000 expanded records and 8 MB snapshot text; provider packets allow 100,000 records and 64 MB. Both allow up to 100 companion originals and 2,000 selected personal notes. Large provider exports can take tens of seconds and may span many pages.

Deterministic snapshots cover saved notes, clinical rows, selections/membership, patient information, source citations and companion metadata. SHA-256 fingerprints detect changes. A profile-scoped in-memory preview token expires after 30 minutes; at most 30 previews are cached. Validate before browser printing/download; PDF generation revalidates after rendering. A changed selected note or clinical record requires a new preview. Unselected private-note content changes do not change the packet. Tokens do not survive restart.

Attachments are **companion downloads**, not embedded PDF appendices. Their existing profile-contained asset/source endpoints provide originals separately. No file selection recursively expands clinical records. Download and share the listed originals alongside the PDF when needed. Markdown raw HTML, external image fetches and browser network access remain disabled.

## PDF runtime

`playwright` is pinned in package-lock.json. Install its matching Chromium for local development:

```sh
npm ci
npx playwright install chromium
```

Docker must install the matching browser and Linux runtime packages (`npx playwright install --with-deps chromium`) and expose the same `PLAYWRIGHT_BROWSERS_PATH` to the application user. Node 24's native type stripping loads the shared chart semantics from `app/data/clinical.ts` and `app/data/format.ts`; those files must be included alongside server/shared in a packaged runtime.

Preview and PDF use the same server-rendered safe HTML. Markdown raw HTML is skipped; external image references and hyperlinks render as text without loading remote content. The preview has a restrictive sandbox/CSP, and Playwright blocks every network request. PDFs are actual Chromium-generated `application/pdf` bytes, never renamed HTML. Browser printing also supports its ordinary local Save as PDF action. An unavailable Chromium returns a clear failure rather than a fake download.

## Validation

Focused coverage: `node --test src/server/test/note-exports.test.ts` and `npm run test:ui -- tests/mounted/note-export.test.tsx`. Fixtures are fictional. Tests cover note-only and enriched selection, source citations, exact raw JSON, source-file companions, current-use semantics, Self versus relatives, archive selection, source/provider/finished immutability, date scope, trends, stale revisions, save failures, unsaved note creation and profile changes.

To reproduce PDF layout QA without opening real profile data:

```sh
node src/scripts/verify-note-export.ts /absolute/path/outside/repo/pdfs
pdftoppm -png /absolute/path/outside/repo/pdfs/synthetic-export.pdf /absolute/path/outside/repo/pdfs/page
```

Inspect the resulting pages, including the long laboratory section, chart and source appendix. The renderer produces page numbering and internal contents links. There are no embedded original images/files, OCR, clinical interpretations, AI calls, email or external uploads in this flow.

## Notes owned by another person

An ordinary or Historical Note can now belong to a saved person other than Self. Starting a brief or provider packet from that note derives the subject from its immutable `ownerPersonId`. The packet's identity, clinical queries, notes and test-series expansion use that same owner. Explicit mixed-owner note or clinical selections fail with `EXPORT_SUBJECT`; linked originals remain evidence and do not change ownership. A family packet does not inherit Self's care contacts or the Self-only fallback for otherwise unrepresented raw clinical assertions. Legacy notes remain Self. Starting directly from another person's Person profile or provider document remains unavailable; use their owned note to create the packet. Existing Self exports keep their behavior.
