# People tags and care contact details

People can have several user-assigned tags. The initial suggestions are **Family**, **Professional**, **Primary Care Provider**, and **Emergency Contact**. Custom tags are supported. Tags are independent of the relationship field: a family member may also be a professional, and a professional is not automatically a primary care provider or emergency contact. Self has no assignable role/custom tags. Its stable patient identity and outgoing-link restriction are unchanged. Self has its own home page and is excluded from the People list, counts and pagination.

In People, open **Filters** beside search to add Active status, Tags, Relationship, Life status or Text conditions. Applied conditions appear as compact pills under search, each with Edit and Delete controls. Only one condition is edited at a time; **Save filter** applies its draft, and **Cancel** keeps the applied conditions unchanged. Save is disabled for an unchanged or incomplete condition. Save, Cancel and Escape end the draft but keep the panel open until the Filters toggle closes it. Active status uses a single switch: on is Active, off is Inactive. The default Active condition is visible as a pill; deleting it includes both active and inactive people. Active status and life status remain separate. Tags support includes any, includes all and excludes; conditions combine with text search and pagination. The [filter inventory](filter-inventory.md) describes this interaction across all routed collections and preserves each page's distinct query fields.

Both the People list and person detail show assigned tags. The person editor uses the shared searchable, creatable picker used by Notes Type. **Search or add a tag** offers the initial suggestions and tags already used in this profile. Selecting a result adds a chip; the explicit **Add … as a new tag** action creates a new label. Exact case-insensitive matches reuse existing choices and suppress Add. Remove an assigned tag with its chip's remove button. Tags save through the same serialized autosave and version checks as the rest of the person profile. Search text is only a proposed label until a choice is selected. Existing normalization retains the standard suggestions' capitalization and lowercases custom tags.

Non-Self **Relationship / context** uses the same picker with one selected value and Edit/Clear controls, drawing suggestions from this profile's existing relationships. Selecting a relationship never adds a tag. Similar words remain distinct; neither field infers clinical or personal equivalence. Self's canonical relationship is unchanged. These labels are aggregated from saved People records, not a separate taxonomy with its own creation history.

Optional **Phone** and **Email** fields are available for all people, including Self. **Scheduling URL** and its opening link appear only for non-Self people tagged **Professional** or **Primary Care Provider**. Removing those roles hides the controls without erasing a saved URL; adding a qualifying role reveals it again. Phone numbers are retained as supplied apart from surrounding whitespace; no country code or dialing format is inferred. Email addresses retain case and punctuation. Scheduling links must be complete HTTP or HTTPS URLs; opening a link is an explicit action. Saving contact information does not contact anyone or schedule an appointment. Incomplete or invalid email/URL input pauses that person's autosave while retaining the draft; completing or clearing it resumes saving. The existing unsaved-navigation guard still applies.

## Storage and API

When Import creates a named Person, its initial display label must contain the evidenced full name. A literal source title containing only a credential or role falls back to that full name; full-name-containing titles remain unchanged. Original title, credential and signature evidence stays retained. Updating an existing Person never replaces the user's saved display/familiar label.

No schema migration is needed. These optional values live in the existing personal note's `profile_json` object:

```json
{
  "name": "Dr Example",
  "fullName": "Morgan Example",
  "pronouns": "they/them",
  "relationship": "primary care clinician",
  "tags": ["Primary Care Provider", "Professional", "support team"],
  "phone": "+1 (555) 010-1111 ext 2",
  "email": "appointments@example.com",
  "schedulingUrl": "https://example.com/appointments"
}
```

Existing profile fields, source references, source-relative facts, IDs, attachments, links, full names and pronouns are retained. Raw provider/source files are never rewritten. No live people are tagged or assigned contact details by this feature; roles and contacts require explicit user input.

- `GET /api/profiles/:profileId/person-tags` returns the four suggestions plus custom tags used by non-archived, non-Self people in that profile.
- `GET /api/profiles/:profileId/notes?kind=person&tag=Family` returns people with that tag, with the existing `q`, `limit`, `offset`, archive handling, total and completeness metadata. A tag filter implies person kind even if `kind` is omitted. Self is treated as untagged, including when legacy stored data contains tags. Positive tag matches exclude it; the new builder’s exclusion/Unknown conditions follow ordinary untagged semantics.
- The People page adds `excludeSelf=1` to its `kind=person` collection query. The server excludes the canonical patient before counting and pagination; other API consumers and direct Self reads retain their existing access. People filter options also exclude Self, so its relationship is not offered as a dead-end choice.
- Existing note creation/update endpoints accept `person.tags`, `person.phone`, `person.email`, and `person.schedulingUrl`. Self rejects nonempty tag assignments through API and assistant operations. Older Self tags remain visible in saved history but cannot be restored; an ordinary Self save removes the tags from the current representation without rewriting old generations. Version conflicts use the existing `409 VERSION_CONFLICT` behavior and do not overwrite newer tags or contacts.
- `GET /api/profiles/:profileId/notes/:noteId/source-evidence?limit=&offset=` is a read-only Person projection. It pages every distinct source evidenced for the Person's stable ID, including sources added by later reviewed updates, then returns accepted clinical entries that cite those exact source-record IDs. It does not use the note's primary source alone, co-occurrence in a file/report, dates, names or provider labels; it never writes manual links or assigns care roles.

Tag identity ignores case and repeated/surrounding whitespace. Built-in tags use the capitalization shown above; custom tags are stored lowercase. Duplicates and blank entries are removed, and assigned tags are sorted deterministically. Limits are 24 distinct tags per person, 80 characters per tag, 200 characters for phone, 320 for email, and 2,048 for scheduling URL. Contact strings are trimmed only at their edges. Tags and filter options stay inside the selected profile's database.

## Validation

`server/test/people-tags.test.ts` checks canonicalization, role independence, preserved fields, Self, filters/pagination/counts, invalid inputs, stale writes and HTTP profile isolation. `server/test/person-source-evidence.test.ts` covers exact-source grouping, profile isolation, later sources, entity reuse, source-only evidence, pagination, current reclassification and retained inactive/unavailable state. `app/features/notes/person-care.test.ts` and the mounted source-evidence checks cover client normalization, draft preservation, stable autosave keys, contact validation, retry and profile/version refresh. Existing draft-writer/navigation tests continue to cover serialized saves and unsaved-work protection.
