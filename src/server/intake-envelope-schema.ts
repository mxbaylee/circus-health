/** Schema-directed record codec. Unknown evidence remains exact lexical cells. */
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
export const ENVELOPE_SCHEMA = 'health-intake-record-envelope-v1';
export const schemaHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const schemaKey = (...parts: unknown[]): string => schemaHash(JSON.stringify(parts));
/** The exact single-string schema key, without serializing a whole large scalar. */
export async function schemaStringKey(
  value: string,
  assertRunning: () => void = () => {},
): Promise<string> {
  assertRunning();
  const hash = createHash('sha256').update('["');
  for (let at = 0; at < value.length;) {
    let end = Math.min(at + 4096, value.length);
    // Keep surrogate pairs together so chunk boundaries cannot change JSON bytes.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
    hash.update(JSON.stringify(value.slice(at, end)).slice(1, -1));
    at = end;
    if (at < value.length) {
      await setImmediate();
      assertRunning();
    }
  }
  assertRunning();
  return hash.update('"]').digest('hex');
}
export const schemaOrdinal = (n: number): string => String(n).padStart(16, '0');
export interface SchemaRecord {
  kind: string;
  shape: 'object' | 'array' | 'scalar';
  count: number;
}
export interface SchemaTarget {
  type: 'record' | 'cell';
  id: string;
}
export interface SchemaOrder {
  target: SchemaTarget;
  prefix: string;
  name?: string;
}
export interface SchemaControl {
  format: typeof ENVELOPE_SCHEMA;
  mode: 'raw' | 'normalized';
  root: string;
}
export function parseSchemaControl(raw: unknown): SchemaControl {
  if (typeof raw !== 'string') throw Error('Missing selected envelope schema');
  const value = JSON.parse(raw) as SchemaControl;
  if (
    Object.keys(value).sort().join(',') !== 'format,mode,root' ||
    value.format !== ENVELOPE_SCHEMA ||
    !['raw', 'normalized'].includes(value.mode) ||
    !/^[a-f0-9]{64}$/.test(value.root)
  )
    throw Error('Invalid selected envelope schema');
  return value;
}
const arrays: Record<string, string> = {
  anchors: 'navigationAnchor',
  headings: 'navigationHeading',
  proposals: 'proposal',
  importHistory: 'import',
  metadataHistory: 'metadataHistoryEntry',
  operations: 'operation',
  missingAssets: 'missingAsset',
  packageRoles: 'packageRole',
  packageRolesHistory: 'packageRoleHistory',
  references: 'reference',
  reportAcceptances: 'reportAcceptance',
  reportSourceConfirmations: 'reportSourceConfirmation',
  extensions: 'reportSourceExtension',
  coverageEntries: 'sourceCoverageEntry',
  candidates: 'candidate',
  versions: 'version',
  occurrences: 'occurrence',
  questions: 'question',
  answers: 'answer',
  plans: 'plan',
  units: 'unit',
  batches: 'batch',
  coverage: 'coverage',
  members: 'member',
  sections: 'section',
  reportGroups: 'reportGroup',
  decisions: 'decision',
  reviewDrafts: 'draft',
  peopleDrafts: 'peopleDraft',
  identityConfirmations: 'identityReceipt',
  targets: 'identityTarget',
  assignmentTargets: 'identityTarget',
  membership: 'membership',
  resolutions: 'resolution',
  corrections: 'correction',
  attempts: 'scalar',
  issueIds: 'scalar',
  records: 'clinicalRecord',
  issues: 'issue',
  preview: 'preview',
  roles: 'role',
  failures: 'failure',
  messages: 'message',
  attachments: 'attachment',
  reports: 'report',
  events: 'event',
  ambiguities: 'ambiguity',
  relationships: 'relationship',
  claims: 'claim',
  evidence: 'evidence',
  receipts: 'receipt',
  missing: 'missing',
  checkpoints: 'checkpoint',
};
const objects = new Set([
  'intake',
  'workflow',
  'index',
  'mapping',
  'decision',
  'scope',
  'receipt',
  'report',
  'subject',
  'evidencedIdentity',
  'anchor',
  'section',
  'assignedPerson',
  'identityAttribution',
  'coverage',
  'validation',
  'imported',
  'clinical',
  'summary',
  'metadata',
  'before',
  'acquisition',
  'locator',
  'derivative',
  'continuation',
  'pins',
  'source',
  'sourceRef',
  'extensionScope',
  'occurrence',
  'statistics',
  'counts',
  'packageFailures',
]);
export function structuredKind(parent: string, field: string, token: string): string | undefined {
  if (parent === 'packageFailures') return token === '{' ? 'packageFailure' : undefined;
  if (token === '[' && arrays[field]) return arrays[field];
  if (token === '{' && objects.has(field)) return field;
  return undefined;
}
export interface LexicalEntry {
  name?: string;
  start: number;
  end: number;
  prefixStart: number;
}
/** Input was validated by the supported legacy decoder. No array of tokens is built. */
export function valueEnd(text: string, start: number): number {
  let quoted = false,
    depth = 0;
  for (let at = start; at < text.length; at++) {
    const char = text[at]!;
    if (quoted) {
      if (char === '\\') at++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (!depth) return at;
      if (!--depth) return at + 1;
    } else if (!depth && (char === ',' || /\s/.test(char))) return at;
    if (!depth && !quoted && char === '"') return at + 1;
  }
  return text.length;
}
export function* lexicalEntries(text: string, start: number, end: number): Generator<LexicalEntry> {
  const object = text[start] === '{';
  let at = start + 1,
    prefixStart = start;
  const ws = () => {
    while (at < end && /\s/.test(text[at]!)) at++;
  };
  ws();
  while (at < end - 1) {
    let name: string | undefined;
    if (object) {
      const keyEnd = valueEnd(text, at);
      name = JSON.parse(text.slice(at, keyEnd)) as string;
      at = keyEnd;
      ws();
      if (text[at++] !== ':') throw Error('Invalid envelope property delimiter');
      ws();
    }
    const from = at,
      to = valueEnd(text, from);
    yield { name, start: from, end: to, prefixStart };
    at = to;
    prefixStart = at;
    ws();
    if (text[at] !== ',') break;
    at++;
    ws();
  }
}
