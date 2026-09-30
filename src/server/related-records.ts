import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { HttpError, revision } from './database.ts';
import { canonicalLiteral } from './intake-format.ts';
import { getIntake, reviewIntake } from './intake.ts';
import { buildIntakeRelatedReview } from './duplicate-review.ts';
import type { IntakeClinicalMapping } from '../shared/intake.ts';
import type {
  ClinicalReviewKind,
  IntakeRelatedRecordsRequest,
  IntakeRelatedRecordsResult,
  RelatedRecordPage,
  RelatedRecordReason,
  RelatedRecordSearch,
} from '../shared/clinical-review.ts';

const tables = {
  observation: 'observations',
  medication: 'medications',
  procedure: 'procedures',
  document: 'documents',
} as const;
const maximumResults = 200;
const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const like = (value: string): string => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';

/** Deterministic, bounded ranked IDs. The caller loads evidence only for the requested page. */
export function relatedRecordIds(
  db: DatabaseSync,
  input: { kind: ClinicalReviewKind; mapping: IntakeClinicalMapping; identity: string },
  search: RelatedRecordSearch = {},
): { matches: { id: string; reasons: RelatedRecordReason[] }[]; page: RelatedRecordPage } {
  if (!Object.hasOwn(tables, input.kind))
    throw new HttpError(400, 'RELATED_RECORD_KIND', 'Choose a supported clinical kind');
  const query = clean(search.query),
    limit = search.limit ?? 20;
  if (
    query.length > 200 ||
    (search.query !== undefined && typeof search.query !== 'string') ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new HttpError(
      400,
      'RELATED_RECORD_SEARCH',
      'Use a search of at most 200 characters and a page of 1–50 records',
    );
  const { label, terms, code, codeSystem } = relatedMappingFields(input.kind, input.mapping);
  const issuer = clean(input.mapping.sourceSystem),
    date = clean(input.mapping.date);
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  const fingerprint = digest([profile, revision(db), input, query, limit]);
  let offset = 0;
  if (search.cursor != null) {
    try {
      if (typeof search.cursor !== 'string' || search.cursor.length > 1000) throw new Error();
      const cursor = JSON.parse(Buffer.from(search.cursor, 'base64url').toString('utf8')) as {
        fingerprint: string;
        offset: number;
      };
      if (
        cursor.fingerprint !== fingerprint ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset >= maximumResults
      )
        throw new Error();
      offset = cursor.offset;
    } catch {
      throw new HttpError(
        409,
        'RELATED_RECORD_SEARCH_CHANGED',
        'The records or search changed; start the related-record search again',
      );
    }
  }
  const labelColumn = input.kind === 'document' ? 'title' : 'label';
  const parameters: SQLInputValue[] = [];
  const parameter = (value: SQLInputValue) => {
    parameters.push(value);
    return '?';
  };
  const exactCode =
    code && codeSystem
      ? `(json_extract(extra_json,'$.import.acceptedMapping.code')=${parameter(code)} AND json_extract(extra_json,'$.import.acceptedMapping.codeSystem')=${parameter(codeSystem)})`
      : '0';
  const exactLabel = label ? `lower(trim(${labelColumn}))=lower(${parameter(label)})` : '0';
  const labelTerms = terms.length
    ? '(' +
      terms.map((term) => `${labelColumn} LIKE ${parameter(like(term))} ESCAPE '\\'`).join(' OR ') +
      ')'
    : '0';
  const searchMatch = query
    ? `(${labelColumn} LIKE ${parameter(like(query))} ESCAPE '\\' OR json_extract(extra_json,'$.import.sourceRecordId') LIKE ${parameter(like(query))} ESCAPE '\\' OR json_extract(extra_json,'$.import.acceptedMapping.code') LIKE ${parameter(like(query))} ESCAPE '\\')`
    : '0';
  const sameDate = date
    ? `json_extract(extra_json,'$.import.acceptedMapping.date')=${parameter(date)}`
    : '0';
  const sameIssuer = issuer
    ? `json_extract(extra_json,'$.import.sourceSystem')=${parameter(issuer)}`
    : '0';
  const rows = db
    .prepare(
      `
    WITH candidates AS (
      SELECT id, ${exactCode} AS same_code, ${exactLabel} AS same_label, ${labelTerms} AS label_terms,
        ${searchMatch} AS search_match, ${sameDate} AS same_date, ${sameIssuer} AS same_issuer
      FROM ${tables[input.kind]}
      WHERE ${input.kind === 'document' ? "COALESCE(json_extract(extra_json,'$.import.personId'),'patient')" : 'person_id'}=${parameter(input.mapping.personId || (input.mapping.subject === 'self' ? 'patient' : 'unassigned'))}
        AND COALESCE(json_extract(extra_json,'$.import.identity'),'')!=${parameter(input.identity)}
        AND EXISTS(SELECT 1 FROM evidence e JOIN source_records s ON s.id=e.source_record_id WHERE e.entity_type=${parameter(input.kind)} AND e.entity_id=${tables[input.kind]}.id)
    )
    SELECT * FROM candidates WHERE ${query ? 'search_match' : '(same_code OR same_label OR label_terms)'}
    ORDER BY (COALESCE(same_code,0)*100 + COALESCE(same_label,0)*50 + COALESCE(label_terms,0)*10 + COALESCE(same_date,0)*2 + COALESCE(same_issuer,0)) DESC, id
    LIMIT ${maximumResults + 1}
  `,
    )
    .all(...parameters);
  const bounded = rows.slice(0, maximumResults),
    selected = bounded.slice(offset, offset + limit);
  const nextOffset = offset + selected.length,
    hasMore = nextOffset < bounded.length;
  return {
    matches: selected.map((row) => ({
      id: String(row.id),
      reasons: (
        [
          'same_code',
          'same_label',
          'label_terms',
          'search_match',
          'same_date',
          'same_issuer',
        ] as const
      ).filter((reason) => !!row[reason]),
    })),
    page: {
      query,
      limit,
      returned: selected.length,
      hasMore,
      nextCursor: hasMore
        ? Buffer.from(JSON.stringify({ fingerprint, offset: nextOffset })).toString('base64url')
        : null,
      truncated: rows.length > maximumResults,
      maximumResults,
    },
  };
}

/** Profile-authorized adapter for an explicit related-record search/refine route. */
export function getIntakeRelatedRecords(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: IntakeRelatedRecordsRequest,
): IntakeRelatedRecordsResult {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !(input.proposalId === null || typeof input.proposalId === 'string') ||
    typeof input.recordId !== 'string' ||
    !input.recordId ||
    input.recordId.length > 2000 ||
    typeof input.candidateVersionId !== 'string' ||
    !input.candidateVersionId ||
    input.candidateVersionId.length > 2000 ||
    Object.keys(input).some(
      (key) =>
        !['proposalId', 'recordId', 'candidateVersionId', 'query', 'cursor', 'limit'].includes(key),
    )
  )
    throw new HttpError(
      400,
      'RELATED_RECORD_SEARCH',
      'Supply the exact pending proposal, record and candidate version for this search',
    );
  const item = getIntake(db, root, profileId, intakeId);
  const review = reviewIntake(db, root, profileId, intakeId, input.proposalId);
  const record = review.records.find((value) => value.id === input.recordId);
  const current = item.workflow?.candidates
    .find((value) => value.id === record?.candidateId)
    ?.versions.at(-1);
  if (
    item.archived ||
    !record?.comparisonReference ||
    !current ||
    current.status !== 'pending' ||
    current.id !== input.candidateVersionId ||
    record.candidateVersionId !== input.candidateVersionId
  )
    throw new HttpError(
      409,
      'RELATED_RECORD_REVIEW_CHANGED',
      'Choose the current pending candidate version before comparing records',
    );
  const result = buildIntakeRelatedReview(
    db,
    { ...record.comparisonReference, id: record.id, evidence: record.evidence },
    record.mapping,
    record.draft?.decision?.comparisons,
    input,
    record.comparisonContextHash
      ? {
          intakeId,
          intakeVersion: review.version,
          proposalId: input.proposalId,
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          contextHash: record.comparisonContextHash,
          locator: record.evidence[0]?.locator || 'Retained source occurrence',
          originalSourceFileId:
            decodeURIComponent(
              /^\/api\/sources\/([^/?#]+)\/content(?:[?#]|$)/.exec(
                record.evidence[0]?.contentUrl || '',
              )?.[1] || '',
            ) || intakeId,
        }
      : undefined,
  );
  return {
    intakeId,
    proposalId: input.proposalId,
    recordId: record.id,
    candidateVersionId: input.candidateVersionId,
    intakeVersion: review.version,
    reviewToken: review.reviewToken,
    comparisons: result.comparisons,
    page: result.comparisonPage,
  };
}

export function relatedMappingFields(kind: ClinicalReviewKind, mapping: IntakeClinicalMapping) {
  const label = clean(
    kind === 'observation'
      ? mapping.testLabel
      : kind === 'medication'
        ? mapping.medicationName
        : kind === 'procedure'
          ? mapping.procedureLabel
          : mapping.documentTitle,
  );
  const terms = [
    ...new Set(
      label
        .toLocaleLowerCase('en-US')
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length >= 3),
    ),
  ].slice(0, 8);
  const code = clean(mapping.code),
    codeSystem = clean(mapping.codeSystem);
  return { label, terms, code, codeSystem };
}
