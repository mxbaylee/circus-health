# Assistant and incoming records

The app has a profile-scoped Assistant beside the theme control and a dedicated **Import** page. Both use the same private LiteLLM Proxy and exact operator-selected model alias. It has no direct Health connector. Sending a message or starting conversion sends supplied context and requested record content through LiteLLM to the configured upstream model. Provider availability and task capabilities must be reported explicitly.

## Moxie and connection readiness

The navigation button remains **Assistant**; the panel is **Moxie the Assistant** and replies are labeled **Moxie**. This application-owned identity is consistent across providers. First acquaintance introduces Moxie briefly; later new conversations use the display-name greeting, while continuations and retries repeat neither. Editable starters cover annual, urgent-care, vision and dental preparation and record-grounded clinician questions. Selecting a starter fills the draft; Send starts the conversation. Annual planning asks Moxie to find and propose updates to the existing Annual Planning note before creating another.

Chat and import conversion automatically preflight the configured connection with fictional content before sending private task content. PDF/image conversion requests image capability as well. Failure stays visible and retryable; manual text/image diagnostics remain available. Passing a probe establishes the checked protocol capability, not clinical extraction quality.

## Import workflow

New conversion chats retain a self-contained `/import?intake=…` context; assistant citations allow the dedicated Import route. Historical `/sources?view=import&…` and `/sources?intake=…` links redirect to Import with their exact selectors preserved. Ordinary source-file, source-record, and document links remain on Sources. A historical context is retained as history rather than rewritten in the archive.

Create/select a profile → upload an original → read with Moxie → review → accept. Source attribution is optional at upload; absent attribution is retained as Unknown source. Prepared JSONL is optional; PDFs, photos and office exports are normal inputs. Prepared JSONL must follow the [shared envelope schema](../src/shared/schemas/health-record-v1.schema.json).

The original filename, bytes, hash and acquisition ownership stay fixed. Reviewed metadata can separately set source, care area, document type and topics. An acquisition source says how evidence arrived; an issuing system identifies who authored a record only when the evidence supports it. A reviewed source suggestion changes metadata after review, never original bytes or the source's literal claims.

The converter reads PDF page renders/text, images, embedded files, ZIP members and bounded plain text. It receives the selected source's accepted mapping rules. Each proposal retains original evidence, exact values, unknown fields and coverage gaps. A clipped or unreadable region that cannot be confidently transcribed keeps its original and locator with partial or unknown coverage instead of one tentative guess presented as an exact literal; explicitly qualified uncertain alternatives never become clinical, identity, People, report, provenance or metadata facts. Large extractions use several independently reviewable proposals; each tool submission is limited to one million characters. Relevant pages/members must all be accounted for or explicitly left unresolved.

Review exposes proposed clinical fields, original/asset links, coverage gaps and typed issues for identity, date, uncertain reading and information. Available text anchors and page/member locators connect issues to evidence. Confirm or correct a reading, explicitly identify the subject, or retain an unknown date; informational notices do not require an invented answer. One **This is me** action can optionally add the visible, selected suggestions for blank Self fields atomically; existing Self values are preserved. Clinical acceptance remains separate and requires a supported Self mapping and resolution of blocking issues.

**Review later** saves candidate-version-scoped edits, answers and resolutions as encrypted profile metadata; it does not annotate or modify the original file. **Keep original only** is a terminal review disposition that retains evidence without clinical acceptance. Earlier accepted groups remain retained when another group is deferred. **Remove from review** archives the delivery's visibility and retains originals; restoring visibility is available. Physical file deletion is not implemented.

Correct or skip entries, optionally save a narrow reusable label/classification rule, then accept. Clinical adapters populate observations, medications, procedures and documents only after review. Unknown subjects and unsupported shapes remain raw evidence. A provider status does not establish personal current medication use. Optical prescriptions are reviewed documents with literal right/left eye fields, values, units and supplied dates; **Test results → Vision** shows accepted prescriptions and their retained source occurrences.

A completed delivery can be converted/reviewed again to recover skipped details or correct extraction. New passes retain previous accepted assertions and source provenance. Exact supported identity/assertion matches reuse clinical rows; changed assertions retain versions. Acceptance is not a claim that the entire hospital chart was obtained. See [import and rebuild](import-and-rebuild.md) and [the intake API](../src/server/INTAKE.md).

## What the assistant knows

Each message carries canonical Self identity, reliable local time when available, current route/filters, selected saved entry and compared tests. The assistant defaults to questions about this profile's saved data. It follows evidence before answering provenance questions and supplies links to actual app entries.

Context is structured saved state, not unsaved editor text or a screenshot of the interface. An explicitly named topic overrides an unrelated selected entry. The model uses bounded health query/read tools for additional evidence; a sample does not establish all records' provenance.

The first reply uses one brief warm greeting with the current display name. Continuations and retries do not repeat it. Replies render as Markdown. Per-attempt usage comes from actual bridge events; missing figures display as unavailable/pending, not a fabricated estimate.

## Reviewable actions

- Draft/edit a personal note or Person entry with version checks.
- Associate an existing uploaded asset with an editable note.
- Inspect saved history and propose restoring selected editable fields through a new save.
- Propose a procedure-category correction or an exact-label source mapping, with affected rows previewed before Apply.
- Convert an incoming delivery into separate reviewable proposals.

Finished notes remain immutable and need a linked correction. Restoration does not silently replace links, attachments, status or unrelated fields. Mapping rules cannot propagate clinical values/dates/doses or cross into another profile. Apply uses durable receipts so retrying an acknowledged action does not repeat it.

## Boundaries and recovery

The application exposes scoped `health_*` tools to its LiteLLM model loop. It exposes no filesystem, shell, connected apps, plugins, memories, hooks, or general skill discovery. Uploaded content is evidence, never instructions. The in-app assistant cannot edit code, access another profile, schedule visits, contact providers or send messages. Application changes and rebuild activation remain operator tasks.

Historical compatibility checks record the earlier bridge/tool surfaces. The supported deployment now routes only through LiteLLM; an incompatible proxy or model stops rather than falling back to broader access. This local profile boundary is not multi-tenant authentication.

Visible conversation messages and operation summaries have append-only generations under `profiles/<profile>/chats/`. Hidden reasoning and raw internal event streams are not recorded. Interruptions retain completed checkpoints and permit retry. Originals, proposals, clinical curation and personal generations are durable outside SQLite. Failed publication stays visible and retryable.

People tags define care roles such as Primary Care Provider and Emergency Contact. The assistant never infers those roles from a past visit or an available phone number. The two-step [new-profile onboarding](profile-management.md) collects optional information and saves it into Self and People. Document-specific uncertainties remain attached to their import delivery for review; a standalone Todo inbox is out of scope. No automatic outreach exists.
