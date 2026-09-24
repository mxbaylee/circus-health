# Data and workflow contracts

## Identity and evidence

Stable IDs identify source files, source records, clinical projections, personal records, and relationships. A display label or date is never an identity. Every imported clinical projection links to retained evidence with an exact locator.

Acquisition source, authoring organization, performing organization, and subject are separate roles. Unknown roles remain unknown. Copies from different providers retain their distinct custody attribution.

## Values and time

Keep original strings for values, units, comparators, ranges, codes, and statuses. Numeric parsing adds a query aid without replacing the original token. Text values, missing values, and bounds do not become zero or ordinary point measurements.

Scalar observation query projections accept the existing signed dot-decimal/scientific syntax and ordinary comma thousands grouping for fixed decimals. A grouped integer starts with one to three digits and every following group has exactly three; malformed grouping, comma-decimal conventions, currency, embedded units and grouped scientific notation remain text-only. Commas are removed only from the parsed query copy. The retained value text, written precision, comparator and unit are unchanged, and the stricter exact comparison parser continues to reject commas.

Event, specimen, order, result, authored, capture, and publication dates are distinct. Store date precision and timezone evidence. A date-only value stays a date and must not shift through timezone conversion.

## Illustrative fictional statement

```json
{
  "evidence": {
    "id": "fictional:evidence:lab-1",
    "sourceRecordId": "fictional:source:line-4",
    "locator": { "page": 1, "region": "laboratory table, row 4" }
  },
  "statement": {
    "id": "fictional:observation:ferritin-1",
    "kind": "observation",
    "subjectId": "patient",
    "label": "Ferritin",
    "effectiveDate": "2026-05-30",
    "datePrecision": "day",
    "valueText": "42 ng/mL",
    "valueNumeric": 42,
    "unit": "ng/mL"
  }
}
```

All names, values, dates, and IDs above are invented.

## Match and correction ladder

1. Exact bytes or literal content may share storage while preserving every acquisition occurrence.
2. A known transformation links the derived representation to its exact input.
3. Different projections of one source remain available and are not independent corroboration.
4. An explicit source amendment retains both versions and its amendment scope.
5. Same-event candidates require qualified identity, subject, event detail, and lineage.
6. Similar names, values, dates, or narratives create at most a review candidate.

Provider amendments, parser fixes, and user corrections are different operations. Each retains the prior evidence and a reversible decision record.

## Personal context

Family information stays attached to the named relative. Preferences, discussion lists, clinician decisions, orders, and completion evidence remain separate. A new result can update a derived display without rewriting the saved preference that prompted the review.

Medication current use is a personal versioned assertion. A provider's order status, a dispense, and a reported use are separate facts.

## Query and publication

Queries return a dataset revision, scope, total, pagination, and whether the result is complete for that query. Filters apply before interpretation. Statistics require the complete eligible series and disclose excluded records.

Publication follows pending, preserved, validated, persisted, read-back verified, then published. Retries reuse operation IDs. Overlapping writes use revision checks and produce visible conflicts.

Portable exports include stable IDs, relationships, mappings, personal state, curation, and referenced originals. Restore and rebuild run in a new location and validate checksums, foreign keys, polymorphic links, and ownership before activation.

## Acceptance cases

- A repeated delivery retains the new source occurrence without duplicating a proven existing clinical event.
- A corrected result retains both source versions and makes the accepted amendment explicit.
- Equal values from distinct source events remain separate.
- An extraction repair changes only the derived record.
- A relevant result on the final page is included before trend statistics are computed.
- Unicode, decimals, arrays, empty values, unknown fields, long text, and artifacts round-trip through portable rebuild.
- A profile cannot read, link, mutate, back up, or restore another profile's records.
- Repository fixtures and browser checks use generated fictional data.
