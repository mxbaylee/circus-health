import {
  CLINICAL_INSTRUCTIONS,
  CLINICAL_OPTICAL_LITERAL_INSTRUCTIONS,
} from './clinical-instructions.ts';
import { HttpError } from './database.ts';
import {
  diagnosticValidation,
  copyDiagnosticValidation,
  diagnosticValidationError,
  withDiagnosticValidation,
} from './import-diagnostic-error.ts';
import type { HealthRecordEnvelope, IntakeValidation } from '../shared/intake.ts';
import {
  INTAKE_PEOPLE_EVIDENCE_INSTRUCTIONS,
  INTAKE_PEOPLE_INSTRUCTIONS,
  validatedIntakePeople,
} from './intake-people-format.ts';
export const INTAKE_FORMAT = 'health-record-v1';
export const MAX_INTAKE_BYTES = 25 * 1024 * 1024;
export const MAX_INTAKE_ROWS = 50000;
export const INTAKE_SCHEMA_INSTRUCTIONS =
  CLINICAL_INSTRUCTIONS +
  '\n' +
  CLINICAL_OPTICAL_LITERAL_INSTRUCTIONS +
  '\n' +
  INTAKE_PEOPLE_INSTRUCTIONS +
  '\n' +
  INTAKE_PEOPLE_EVIDENCE_INSTRUCTIONS +
  '\nUse optional top-level contextId:string when multiple independent clinical envelopes share literal report context retained in one kind:"context" envelope in the SAME proposal and original. Give the context envelope that same contextId (its envelope id may also be used for older output), put the exact shared page text in its payload, and put one top-level report reference on the context envelope. Do not repeat shared context as invented clinical facts. A context link proposes presentation scope only: by itself it never proves patient identity, clinical equivalence, issuer, a date, method, unit, category or acceptance. When exact shared text in that uniquely scoped context explicitly supplies a fact for a linked row, copy the fact into that row\'s canonical clinical field as well as retaining the literal context. Scope each fact independently: an explicit report-wide method, modality, unit or category may apply across sections and current/history columns in that report, while a row-, section- or column-specific fact cannot. Column dates stay with their own rows and columns. Do not link across reports, printed subjects, source systems, originals or package members, and do not propagate a fact beyond its evidenced scope. For package evidence, repeat the same host-supplied report.memberId on the context and every linked clinical envelope; otherwise omit contextId and keep the records separate. Explicit report evidence on a linked envelope must agree with the context report. If any report or subject boundary is uncertain or mixed, use separate context IDs or omit the link. Keep clinical.subject unknown until explicit review.' +
  '\nAn identity review issue may include selfSuggestion:{fullName?:string,birthDate?:string} only with field:"subject" when the full name is explicitly printed and the birth date has one unambiguous interpretation in the same supplied textAnchor. For a report, copy report.subject.text as one exact retained substring of this envelope payload, copy textAnchor as one exact retained substring of the same payload, and make textAnchor contain that exact report.subject.text without reformatting, joining or paraphrasing it. The suggested full name must occur literally in report.subject.text; the supported birth date must occur in that subject text or the containing textAnchor. Copy supported birth-date precision as YYYY, YYYY-MM or YYYY-MM-DD; do not infer or fill missing date parts. A suggestion is neither identity confirmation nor permission to update Self; user review is separate. Omit absent or conflicting values.' +
  '\nA profile display name may be a nickname; a different printed patient name is not by itself an identity conflict. Compare only supplied canonical full name and birth date, keep missing fields distinct from conflicting fields, and request explicit identity confirmation when needed. Separate identity confirmation from ambiguous date interpretation. Date issues for date, documentDate, startDate or endDate may offer choices:[{label:string,value:string}] with supported ISO alternatives. The app always supplies its own keep-unknown/manual controls, so omit an unknown choice. Copy the exact source date into textAnchor. Preserve an exact source ISO timestamp as a timestamp rather than reducing it to a day. Ambiguous numeric dates may offer each valid interpretation for explicit choice; never select or normalize one automatically, and never use an ambiguous numeric date for a Self birth-date suggestion. Missing units or laterality, clipped branding, and classification rationale are informational unless a specific extracted reading is uncertain; do not require users to invent missing source facts. Phrase each actionable issue as one concrete question, anchor the exact relevant source text, and keep general extraction notes in coverage/information.' +
  '\nUse optional reviewIssues:[{id:string,kind:identity|date|uncertain_reading|information,prompt:string,field?:string,textAnchor?:string,page?:number,memberId?:string,sourceSuggestion?:string,metadataSuggestion?:{careArea?:string,documentType?:string,topics?:string[]},selfSuggestion?:{fullName?:string,birthDate?:string},choices?:{label:string,value:string}[]}] for precise review concerns. Identity asks whether a finding belongs to the selected patient; date issues allow an unknown date; uncertain_reading cites the exact uncertain text; information covers coverage and extraction notes without requiring an answer. Copy a textAnchor, page or member only from supplied evidence; never invent locations or bounding boxes. sourceSuggestion is an unreviewed source label suggestion, independent of original acquisition and issuing provenance; the label itself and its textAnchor must both occur verbatim in this envelope payload. All suggestions are unreviewed: attach them only to an otherwise warranted issue whose exact textAnchor occurs verbatim in this envelope payload, and repeat the exact report memberId when one exists. Package suggestions without a host-validated report/member scope are unavailable. This internal alignment check does not certify a model transcription of a photo; the user still reviews the retained original. Use only careArea, documentType and at most 12 unique topics; values are concise single-line searchable labels of at most 200 characters grounded in an explicit heading, document type or central subject. Never use package instructions, filenames, adjacent members, another patient, or unsupported specialty inference as labels. Omit malformed, unanchored or conflicting suggestions. Do not create a review issue or question only to label a file. Suggestions never change clinical mappings, dates, subject, issuer, signer, capturedVia/acquisition or saved intake metadata; the app offers each separately for explicit selection through its metadata editor or profile update. Do not make every uncertainty a question or require prose answers. Unknown subjects and dates remain unknown until an explicit reviewed action. Keep a document envelope and its literal text even when no clinical assertion can yet be supported.' +
  '\nOptional report:{key:string,title:string,anchor:{locator:string,text:string},subject:{locator:string,text:string}|null,memberId?:string,section?:{key:string,title:string,anchor:{locator:string,text:string}}} groups a coherent evidenced report for presentation only. Copy a discriminating printed report identifier/heading and its exact location into anchor; repeat the same anchor for independent results from that report. Retain printed subject evidence in subject, or null if absent. Use the exact supplied inventory memberId for package evidence, never a filename or outer ZIP label. Separate different reports, members, issuers and subjects even when dates or values match. Sections need their own printed heading/location. Never use model chunks or dates alone as report identity. Omit report when the boundary is uncertain. A DEXA report may contain 28 independent result envelopes; an optical prescription remains one document with side-specific optical fields. Grouping does not confirm identity, combine clinical events or accept results.' +
  '\n' +
  `One UTF-8 JSON object per nonempty line. Required fields: format:"health-record-v1"; id (nonempty stable source/version ID); kind (record, document, context or unrecognized); payload (literal original JSON or transcribed text, never archive instructions); provenance:{capturedVia:string|null,sourceSystem:string|null,sourceRecordId:string|null,evidenceClass:provider_export|health_response|transcription|personal_report|unknown,locator:string}; coverage:{status:complete_response|partial|unknown,notes:string[]}. Keep all unknown source fields in payload, original number spelling, value signs, dates/roles and arrays. Do not rewrite original payloads. Clinical mappings are separate reviewable proposals. Never infer dates, medication use or missing records. Source-selected provider is acquisition attribution, not necessarily author. Transcription must cite the original file/page/region and retain uncertainty. When a clipped, unreadable, or otherwise unresolved source region cannot be confidently transcribed, do not encode one tentative guess as an exact literal payload field. Retain the original and exact locator, describe the unresolved region in coverage notes, and keep coverage partial or unknown. Tentative alternatives may remain only when explicitly qualified as uncertain; never copy them into clinical mappings, identity or Self suggestions, report or subject anchors, People evidence, provenance, source suggestions, or metadata suggestions. A bounded chunk is partial unless it covers the entire source. Preserve additional fields. Duplicate JSON keys are invalid. JSONL packaging completeness does not establish full-chart completeness.`;

// Validate grammar and duplicate keys separately from parsing. JSON.rawJSON
// retains number token spelling, including decimals and integers beyond 2^53.
export interface IntakeEntry {
  raw: string;
  value: HealthRecordEnvelope;
  canonical: string;
  line: number;
}

export type IntakeValidationResult =
  | (IntakeValidation & { valid: true; entries: IntakeEntry[] })
  | (IntakeValidation & { valid: false; entries?: IntakeEntry[] });

export function parseLiteralJSON(text: string): unknown {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new Error('A JSONL row exceeds 2 MiB; split source sections with locators');
  let pos = 0,
    nodes = 0;
  const ws = () => {
    while (/\s/.test(text[pos] || '') && pos < text.length) pos++;
  };
  function string(): string {
    const start = pos++;
    while (pos < text.length) {
      const char = text[pos++];
      if (char === '\\') pos++;
      else if (char === '"') return JSON.parse(text.slice(start, pos));
    }
    throw new Error('Unterminated JSON string');
  }
  function value(depth = 0): void {
    if (depth > 100 || ++nodes > 100000)
      throw new Error('JSON row is too deeply nested or complex');
    ws();
    if (text[pos] === '"') {
      string();
      return;
    }
    if (text[pos] === '{') {
      pos++;
      ws();
      const keys = new Set();
      if (text[pos] === '}') {
        pos++;
        return;
      }
      for (;;) {
        ws();
        if (text[pos] !== '"') throw new Error('Expected JSON object key');
        const key = string();
        if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key.slice(0, 80)}`);
        keys.add(key);
        ws();
        if (text[pos++] !== ':') throw new Error('Expected colon');
        value(depth + 1);
        ws();
        const delimiter = text[pos++];
        if (delimiter === '}') return;
        if (delimiter !== ',') throw new Error('Expected comma');
      }
    }
    if (text[pos] === '[') {
      pos++;
      ws();
      if (text[pos] === ']') {
        pos++;
        return;
      }
      for (;;) {
        value(depth + 1);
        ws();
        const delimiter = text[pos++];
        if (delimiter === ']') return;
        if (delimiter !== ',') throw new Error('Expected array delimiter');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(pos),
    );
    if (!token) throw new Error('Invalid JSON value');
    pos += token[0].length;
  }
  value();
  ws();
  if (pos !== text.length) throw new Error('Unexpected text after JSON value');
  return JSON.parse(text, (_key, val, context) =>
    typeof val === 'number' ? JSON.rawJSON(context.source) : val,
  );
}
export function canonicalLiteral(value: unknown): string {
  if (JSON.isRawJSON(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalLiteral).join(',') + ']';
  if (isObject(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalLiteral(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && !JSON.isRawJSON(value)
  );
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function envelope(value: unknown): HealthRecordEnvelope {
  if (!isObject(value) || value.format !== INTAKE_FORMAT)
    throw diagnosticValidationError(
      'Expected a health-record-v1 envelope',
      'invalid_envelope',
      'arguments.jsonlText[].format',
    );
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 2000)
    throw diagnosticValidationError(
      'Record id must be nonempty text of at most 2000 characters',
      'invalid_id',
      'arguments.jsonlText[].id',
    );
  if (
    typeof value.kind !== 'string' ||
    !['record', 'document', 'context', 'unrecognized'].includes(value.kind) ||
    !Object.hasOwn(value, 'payload')
  )
    throw diagnosticValidationError(
      'Record needs a supported kind and literal payload',
      'invalid_kind_or_payload',
      'arguments.jsonlText[].kind',
    );
  const p = value.provenance,
    c = value.coverage;
  if (
    !isObject(p) ||
    !['capturedVia', 'sourceSystem', 'sourceRecordId'].every(
      (k) => Object.hasOwn(p, k) && nullableText(p[k]),
    ) ||
    typeof p.locator !== 'string' ||
    !p.locator.trim() ||
    typeof p.evidenceClass !== 'string' ||
    !['provider_export', 'health_response', 'transcription', 'personal_report', 'unknown'].includes(
      p.evidenceClass,
    )
  )
    throw diagnosticValidationError(
      'Record provenance is incomplete',
      'invalid_provenance',
      'arguments.jsonlText[].provenance',
    );
  if (
    !isObject(c) ||
    typeof c.status !== 'string' ||
    !['complete_response', 'partial', 'unknown'].includes(c.status) ||
    !Array.isArray(c.notes) ||
    !c.notes.every((x) => typeof x === 'string')
  )
    throw diagnosticValidationError(
      'Record coverage must include status and notes',
      'invalid_coverage',
      'arguments.jsonlText[].coverage',
    );
  if (
    Object.hasOwn(value, 'contextId') &&
    (typeof value.contextId !== 'string' ||
      !value.contextId.trim() ||
      value.contextId.length > 2000)
  )
    throw diagnosticValidationError(
      'Context id must be nonempty text of at most 2000 characters',
      'invalid_context_id',
      'arguments.jsonlText[].contextId',
    );
  if (Object.hasOwn(value, 'report')) {
    const report = value.report;
    const text = (v: unknown, max: number): boolean =>
      typeof v === 'string' && !!v.trim() && v.length <= max;
    const anchor = (v: unknown): boolean =>
      isObject(v) && text(v.locator, 2000) && text(v.text, 4000);
    if (
      !isObject(report) ||
      !text(report.key, 500) ||
      !text(report.title, 1000) ||
      !anchor(report.anchor) ||
      !(report.subject === null || anchor(report.subject)) ||
      (Object.hasOwn(report, 'memberId') && !text(report.memberId, 500)) ||
      (Object.hasOwn(report, 'section') &&
        (!isObject(report.section) ||
          !text(report.section.key, 500) ||
          !text(report.section.title, 1000) ||
          !anchor(report.section.anchor)))
    )
      throw diagnosticValidationError(
        'Report reference requires bounded source anchors, title, key and explicit subject evidence or null',
        'invalid_report',
        'arguments.jsonlText[].report',
      );
  }
  const result = value as unknown as HealthRecordEnvelope;
  try {
    validatedIntakePeople(result);
  } catch (error) {
    if (error instanceof Error)
      withDiagnosticValidation(error, {
        code: 'invalid_people',
        path: 'arguments.jsonlText[].people',
      });
    throw error;
  }
  return result;
}
export function validateJSONL(bytes: Uint8Array): IntakeValidationResult {
  if (bytes.length > MAX_INTAKE_BYTES)
    throw new HttpError(413, 'FILE_SIZE', 'Source files must be at most 25 MiB');
  const result: IntakeValidation = {
    valid: true,
    rows: 0,
    exactRepeatedRows: 0,
    partialRows: 0,
    unrecognizedRows: 0,
    issues: [],
    preview: [],
    previewComplete: true,
  };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return withDiagnosticValidation(
      {
        ...result,
        valid: false,
        issues: [{ line: 0, message: 'Original is not UTF-8 JSONL; conversion is pending' }],
      },
      { code: 'invalid_encoding', path: 'arguments.jsonlText', line: 0 },
    );
  }
  const entries: IntakeEntry[] = [],
    seen = new Set();
  for (const [index, original] of text.split('\n').entries()) {
    const raw = original.endsWith('\r') ? original.slice(0, -1) : original;
    if (!raw.trim()) continue;
    if (++result.rows > MAX_INTAKE_ROWS) {
      result.valid = false;
      result.issues.push({ line: index + 1, message: 'File exceeds 50,000 records' });
      if (!diagnosticValidation(result))
        withDiagnosticValidation(result, {
          code: 'row_limit',
          path: 'arguments.jsonlText',
          line: index + 1,
        });
      break;
    }
    try {
      const value = envelope(parseLiteralJSON(raw)),
        canonical = canonicalLiteral(value);
      if (seen.has(canonical)) result.exactRepeatedRows++;
      else seen.add(canonical);
      if (value.coverage.status !== 'complete_response') result.partialRows++;
      if (value.kind === 'unrecognized') result.unrecognizedRows++;
      entries.push({ raw, value, canonical, line: index + 1 });
      if (result.preview.length < 5)
        result.preview.push({
          line: index + 1,
          id: value.id,
          kind: value.kind,
          text: raw.slice(0, 4000),
        });
    } catch (error: unknown) {
      result.valid = false;
      if (!diagnosticValidation(result))
        withDiagnosticValidation(result, {
          ...(diagnosticValidation(error) || { code: 'invalid_json', path: 'arguments.jsonlText' }),
          line: index + 1,
        });
      if (result.issues.length < 20)
        result.issues.push({
          line: index + 1,
          message: error instanceof Error ? error.message : 'Invalid JSONL row',
        });
    }
  }
  if (!result.rows) {
    result.valid = false;
    result.issues.push({ line: 0, message: 'File has no JSONL records' });
    withDiagnosticValidation(result, { code: 'empty_input', path: 'arguments.jsonlText', line: 0 });
  }
  result.previewComplete = result.rows <= 5 && result.preview.every((p) => p.text.length < 4000);
  return result.valid
    ? { ...result, valid: true, entries }
    : copyDiagnosticValidation({ ...result, valid: false as const, entries: [] }, result);
}
export const validationSummary = (result: IntakeValidationResult): IntakeValidation => {
  const { entries, ...summary } = result;
  return summary;
};
