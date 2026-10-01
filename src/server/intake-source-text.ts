import { sourceIssueCategory, sourceIssueNeedsReview } from '../shared/intake-source-issues.ts';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, transaction, type Database } from './database.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import { profileOriginal } from './profile-storage.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import { readIntakeSourcePin } from './intake-source-pin.ts';
import { affectedSourcePages } from './intake-proposal-dependencies.ts';
import { visibilityCondition, visibilitySQL } from './visibility.ts';
import {
  invalidateIntakeSourceTextDependencies,
  sourceTextConfirmationOnly,
} from './intake-source-text-dependencies.ts';
import type {
  IntakeSourceText,
  SourceTextEvidence,
  SourceTextRegion,
  SourceTextRevision,
  SourceTextReviewRequest,
  SourceTextSummary,
  SourceTextPassage,
  SourceTextPage,
  SourceTextSpan,
  SourceTextIssue,
  SourceTextRelation,
  SourceTextAnnotationPassage,
  SourceTextIssueList,
  SourceTextIssueSummary,
  SourceAttentionQueue,
} from '../shared/intake-source-text.ts';

const FORMAT = 'intake-source-text-v1';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const encode = (value: unknown) => JSON.stringify(value);
const hash = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
function bad(message: string): never {
  throw new HttpError(400, 'SOURCE_TEXT_INVALID', message);
}
function conflict(message: string): never {
  throw new HttpError(409, 'SOURCE_TEXT_CONFLICT', message);
}
function corrupt(): never {
  throw new HttpError(
    409,
    'SOURCE_TEXT_INTEGRITY',
    'Retained source text is missing or inconsistent; recover the profile before continuing',
  );
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const key = (id: string, name: string) => `intake_source_text:v1:${id}:${name}`;
const read = (db: Database, name: string): string | undefined =>
  db.prepare('SELECT value FROM app_meta WHERE key=?').get(name)?.value as string | undefined;
const put = (db: Database, name: string, value: unknown) => {
  const text = encode(value),
    previous = read(db, name);
  if (previous !== undefined && previous !== text) corrupt();
  if (previous === undefined)
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(name, text);
};
function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return corrupt();
  }
}
function owner(db: Database, profileId: string, intakeId: string) {
  if (read(db, 'owner_profile_id') !== profileId)
    throw new HttpError(403, 'PROFILE_SCOPE', 'Source text belongs to a different profile');
  if (typeof intakeId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,200}$/.test(intakeId))
    throw new HttpError(404, 'INTAKE_NOT_FOUND', 'Import not found');
  const source = db
    .prepare("SELECT id,path,sha256,bytes FROM source_files WHERE id=? AND kind='intake_original'")
    .get(intakeId);
  if (!source) throw new HttpError(404, 'INTAKE_NOT_FOUND', 'Import not found');
  return source as { id: string; path: string; sha256: string; bytes: number };
}
function source(db: Database, root: string, profileId: string, intakeId: string) {
  const row = owner(db, profileId, intakeId);
  const path = profileOriginal(root, row.path, profileId);
  verifyIntakeFileHash(path, { bytes: row.bytes, sha256: row.sha256 });
  return row;
}
function durable(db: Database) {
  const status = recordDurabilityStatus(db);
  if (!status || status.conflicted)
    throw new HttpError(
      503,
      'SOURCE_TEXT_DURABILITY',
      'Source text requires the unlocked durable profile journal',
    );
}
function region(value: unknown, pages?: Set<number>): asserts value is SourceTextRegion {
  if (
    !object(value) ||
    Object.keys(value).some((k) => k !== 'page' && k !== 'box') ||
    !Number.isSafeInteger(value.page) ||
    Number(value.page) < 1 ||
    (pages && !pages.has(Number(value.page)))
  )
    bad('Source location must name an inventoried page');
  if (value.box !== undefined) {
    const b = value.box;
    if (
      !Array.isArray(b) ||
      b.length !== 4 ||
      b.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) ||
      b[2] <= 0 ||
      b[3] <= 0 ||
      b[0] + b[2] > 1.000001 ||
      b[1] + b[3] > 1.000001
    )
      bad('Source coordinates must be normalized canonical rectangles');
  }
}
function uniqueIds(items: { id: string }[], description: string) {
  const ids = new Set<string>();
  for (const item of items) {
    if (!object(item) || typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id))
      bad(`Invalid or duplicate ${description} identity`);
    ids.add(item.id);
  }
  return ids;
}
/** Explicit validation at extraction, human-edit and authenticated recovery read boundaries. */
export function validateSourceTextEvidence(value: unknown): asserts value is SourceTextEvidence {
  if (
    !object(value) ||
    !object(value.adapter) ||
    typeof value.adapter.name !== 'string' ||
    !value.adapter.name ||
    value.adapter.name.length > 128 ||
    typeof value.adapter.version !== 'string' ||
    !value.adapter.version ||
    value.adapter.version.length > 128 ||
    !Array.isArray(value.pages) ||
    !Array.isArray(value.spans) ||
    !Array.isArray(value.relations) ||
    !Array.isArray(value.issues)
  )
    bad('Invalid source-text evidence');
  if (value.pages.length < 1) bad('Source-text evidence exceeds the supported bound');
  const pages = new Set<number>();
  for (const page of value.pages) {
    if (
      !object(page) ||
      !Number.isSafeInteger(page.page) ||
      Number(page.page) < 1 ||
      pages.has(Number(page.page)) ||
      !['extracted', 'partial', 'unreadable', 'unsupported', 'not-text'].includes(
        String(page.disposition),
      ) ||
      typeof page.inspected !== 'boolean'
    )
      bad('Invalid source page accounting');
    if (
      [page.width, page.height].some(
        (v) => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0),
      )
    )
      bad('Invalid page dimensions');
    pages.add(Number(page.page));
  }
  // Page inventory is exhaustive; an absent middle/trailing page is not repaired by an empty warning list.
  if ([...pages].some((p) => p > pages.size))
    bad('Page inventory must be contiguous from page one');
  const spans = uniqueIds(value.spans as SourceTextSpan[], 'span');
  for (const span of value.spans) {
    region(span.region, pages);
    if (
      typeof span.text !== 'string' ||
      !span.text.length ||
      !['native', 'ocr', 'structured', 'human'].includes(span.provenance)
    )
      bad('Invalid literal span');
    if (
      span.confidence !== undefined &&
      (typeof span.confidence !== 'number' ||
        !Number.isFinite(span.confidence) ||
        span.confidence < 0 ||
        span.confidence > 1)
    )
      bad('Invalid reader confidence');
    if (
      span.alternatives !== undefined &&
      (!Array.isArray(span.alternatives) ||
        span.alternatives.some(
          (a: unknown) => !object(a) || typeof a.text !== 'string' || typeof a.adapter !== 'string',
        ))
    )
      bad('Invalid reader alternative');
  }
  uniqueIds(value.issues as SourceTextIssue[], 'issue');
  for (const issue of value.issues) {
    region(issue.region, pages);
    if (
      typeof issue.detail !== 'string' ||
      !issue.detail ||
      ![
        'confidence',
        'coverage',
        'disagreement',
        'structure',
        'unreadable',
        'unsupported',
      ].includes(issue.kind) ||
      !['open', 'confirmed', 'corrected', 'not-text', 'unreadable', 'later'].includes(issue.status)
    )
      bad('Invalid extraction issue');
  }
  uniqueIds(value.relations as SourceTextRelation[], 'relation');
  const edges = new Map<string, string[]>();
  for (const relation of value.relations) {
    if (
      !spans.has(relation.from) ||
      !spans.has(relation.to) ||
      relation.from === relation.to ||
      !['precedes', 'same-row', 'same-column', 'header-for'].includes(relation.kind) ||
      !['adapter', 'human'].includes(relation.provenance)
    )
      bad('Invalid source relationship');
    if (relation.kind === 'precedes')
      edges.set(relation.from, [...(edges.get(relation.from) ?? []), relation.to]);
  }
  // Kahn traversal avoids a call-stack failure on long documents.
  const incoming = new Map([...spans].map((id) => [id, 0]));
  for (const targets of edges.values())
    for (const id of targets) incoming.set(id, incoming.get(id)! + 1);
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const id = ready[cursor];
    visited++;
    for (const next of edges.get(id) ?? []) {
      incoming.set(next, incoming.get(next)! - 1);
      if (!incoming.get(next)) ready.push(next);
    }
  }
  if (visited !== spans.size) bad('Reading order cannot contain a cycle');
}
interface StoredIssueIndex {
  summary: SourceTextIssueSummary;
  chunks: { ref: string; count: number }[];
}
/** Since CRS-117 the chunk list itself is chunked, so the envelope stays small on long sources. */
interface StoredIssueIndexRefs {
  summary: SourceTextIssueSummary;
  chunkLists: string[];
}
interface StoredRevision {
  issueIndex?: StoredIssueIndex | StoredIssueIndexRefs;
  header: Omit<SourceTextRevision, 'pages' | 'spans' | 'issues' | 'relations'>;
  /** Revisions written before CRS-117 list every page and every relation inline. */
  pageRefs?: string[];
  relationRef?: string;
  /**
   * Page refs in fixed slices; relations in content-defined chunks whose refs are chunked again,
   * so one change rewrites one chunk and the envelope stays small.
   */
  pageChunks?: string[];
  relationLists?: string[];
}
/** A validated revision envelope with its chunked references resolved. */
interface LoadedRevision {
  stored: StoredRevision;
  header: StoredRevision['header'];
  issueIndex?: StoredIssueIndex;
  pageRefs: string[];
  relationRefs: string[];
}
const PAGE_CHUNK = 64;
const MAX_PAGES = Number.MAX_SAFE_INTEGER;
/**
 * Content-defined boundaries: an insertion or removal changes the chunk it lands in, not every
 * later chunk. Boundaries follow roughly one item in sixteen, capped at max.
 */
function chunkBy<T>(items: T[], identity: (item: T) => string, max: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    current.push(item);
    if (current.length >= max || createHash('sha256').update(identity(item)).digest()[0] < 16) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}
const hashRefs = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((ref) => HASH.test(ref));
function issueIndexOf(
  db: Database,
  intakeId: string,
  index: StoredIssueIndex | StoredIssueIndexRefs,
): StoredIssueIndex {
  if (!object(index)) return corrupt();
  if (!('chunkLists' in index)) return index;
  if (!hashRefs(index.chunkLists, MAX_PAGES)) corrupt();
  return {
    summary: index.summary,
    chunks: index.chunkLists.flatMap((ref) => {
      const chunks = readBlob(db, intakeId, ref);
      if (!Array.isArray(chunks) || !chunks.length) corrupt();
      return chunks as StoredIssueIndex['chunks'];
    }),
  };
}
function blob(db: Database, intakeId: string, value: unknown): string {
  const sha = hash(value);
  put(db, key(intakeId, `blob:${sha}`), value);
  return sha;
}
function readBlob(db: Database, intakeId: string, ref: string): unknown {
  if (!HASH.test(ref)) corrupt();
  const raw = read(db, key(intakeId, `blob:${ref}`));
  if (raw === undefined) corrupt();
  const value = parse(raw!);
  if (hash(value) !== ref) corrupt();
  return value;
}
function loadStoredRevision(
  db: Database,
  profileId: string,
  intakeId: string,
  sourceHash: string,
  id: string,
): LoadedRevision {
  if (!UUID.test(id)) bad('Invalid source-text revision');
  const raw = read(db, key(intakeId, `revision:${id}`));
  if (raw === undefined)
    throw new HttpError(404, 'SOURCE_TEXT_REVISION_NOT_FOUND', 'Source-text revision not found');
  const envelope = parse(raw!);
  if (!object(envelope) || !object(envelope.value) || envelope.sha256 !== hash(envelope.value))
    corrupt();
  const saved = envelope.value as unknown as StoredRevision;
  if (
    !object(saved.header) ||
    saved.header.format !== FORMAT ||
    saved.header.id !== id ||
    saved.header.profileId !== profileId ||
    saved.header.intakeId !== intakeId ||
    saved.header.sourceHash !== sourceHash ||
    (saved.header.parentRevisionId !== null && !UUID.test(saved.header.parentRevisionId)) ||
    !Number.isFinite(Date.parse(saved.header.createdAt)) ||
    (saved.pageChunks === undefined
      ? !hashRefs(saved.pageRefs, MAX_PAGES)
      : saved.pageRefs !== undefined ||
        !hashRefs(saved.pageChunks, Math.ceil(MAX_PAGES / PAGE_CHUNK))) ||
    (saved.relationLists === undefined
      ? typeof saved.relationRef !== 'string'
      : saved.relationRef !== undefined || !hashRefs(saved.relationLists, MAX_PAGES))
  )
    corrupt();
  const pageRefs = saved.pageChunks
    ? saved.pageChunks.flatMap((ref) => {
        const refs = readBlob(db, intakeId, ref);
        if (!hashRefs(refs, PAGE_CHUNK) || !refs.length) corrupt();
        return refs as string[];
      })
    : saved.pageRefs!;
  if (
    pageRefs.length > MAX_PAGES ||
    !Array.isArray(saved.header.protectedPages) ||
    saved.header.protectedPages.some(
      (p) => !Number.isSafeInteger(p) || p < 1 || p > pageRefs.length,
    )
  )
    corrupt();
  return {
    stored: saved,
    header: saved.header,
    issueIndex: saved.issueIndex && issueIndexOf(db, intakeId, saved.issueIndex),
    pageRefs,
    relationRefs: saved.relationLists
      ? saved.relationLists.flatMap((ref) => {
          const refs = readBlob(db, intakeId, ref);
          if (!hashRefs(refs, PAGE_CHUNK) || !refs.length) corrupt();
          return refs as string[];
        })
      : [saved.relationRef!],
  };
}
function loadRevision(
  db: Database,
  profileId: string,
  intakeId: string,
  sourceHash: string,
  id: string,
): SourceTextRevision {
  const saved = loadStoredRevision(db, profileId, intakeId, sourceHash, id);
  const pages: SourceTextPage[] = [],
    spans: SourceTextSpan[] = [],
    issues: SourceTextIssue[] = [];
  for (const ref of saved.pageRefs) {
    const page = readBlob(db, intakeId, ref);
    if (
      !object(page) ||
      !object(page.page) ||
      !Array.isArray(page.spans) ||
      !Array.isArray(page.issues)
    )
      corrupt();
    pages.push(page.page as unknown as SourceTextPage);
    spans.push(...(page.spans as SourceTextSpan[]));
    issues.push(...(page.issues as SourceTextIssue[]));
  }
  const revision = {
    ...saved.header,
    pages,
    spans,
    issues,
    relations: saved.relationRefs.flatMap((ref) => {
      const relations = readBlob(db, intakeId, ref);
      if (!Array.isArray(relations)) corrupt();
      return relations as SourceTextRelation[];
    }),
  };
  try {
    validateSourceTextEvidence(revision);
  } catch {
    corrupt();
  }
  return revision;
}
export function getIntakeSourceTextReviewHistory(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  options: { beforeRevisionId?: string; limit?: number } = {},
) {
  const row = source(db, root, profileId, intakeId),
    limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    bad('Invalid review history page size');
  let next: string | null =
    options.beforeRevisionId ?? currentIntakeSourceTextRevisionId(db, profileId, intakeId);
  const entries: SourceTextPassage['reviewHistory'] = [],
    seen = new Set<string>();
  while (next && entries.length < limit) {
    if (seen.has(next)) corrupt();
    seen.add(next);
    const { header } = loadStoredRevision(db, profileId, intakeId, row.sha256, next);
    const entry: SourceTextPassage['reviewHistory'][number] = {
      revisionId: header.id,
      parentRevisionId: header.parentRevisionId,
      event: header.review,
    };
    if (entry.event) {
      entry.event = structuredClone(entry.event);
      for (const field of ['reason', 'clarification'] as const)
        if ((entry.event[field]?.length ?? 0) > 256) {
          entry.event[field] = safePrefix(entry.event[field]!, 256);
          (entry.truncatedFields ??= []).push(field);
        }
    }
    entries.push(entry);
    if (Buffer.byteLength(encode({ entries, nextRevisionId: header.parentRevisionId })) > 60000) {
      entries.pop();
      break;
    }
    next = header.parentRevisionId;
  }
  return { entries, nextRevisionId: next };
}
/** Only for the unpublished database copy before the destination vault is initialized.
 * Original immutable objects stay untouched; the destination seeds its own journal.
 */
export function rebindCopiedIntakeSourceText(
  db: Database,
  previousProfileId: string,
  profileId: string,
): void {
  if (
    previousProfileId === profileId ||
    read(db, 'owner_profile_id') !== profileId ||
    recordDurabilityStatus(db)
  )
    throw new Error('Source-text copy rebinding requires an unpublished destination profile');
  const revisions = db
    .prepare("SELECT key FROM app_meta WHERE key LIKE 'intake_source_text:v1:%:revision:%'")
    .all();
  for (const row of revisions) {
    const match = /^intake_source_text:v1:(.+):revision:([0-9a-f-]{36})$/.exec(String(row.key));
    if (!match) corrupt();
    const [, intakeId, id] = match;
    const original = owner(db, profileId, intakeId);
    // Validate every page and relationship before copying its authority to a new owner.
    loadRevision(db, previousProfileId, intakeId, original.sha256, id);
    const value = loadStoredRevision(db, previousProfileId, intakeId, original.sha256, id).stored;
    value.header = {
      ...value.header,
      profileId,
      copiedFrom: { profileId: previousProfileId, revisionId: id },
    };
    db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
      encode({ value, sha256: hash(value) }),
      row.key,
    );
  }
}
export function currentIntakeSourceTextRevisionId(
  db: Database,
  profileId: string,
  intakeId: string,
): string | null {
  const row = owner(db, profileId, intakeId),
    raw = read(db, key(intakeId, 'head'));
  if (!raw) return null;
  const head = parse(raw);
  if (
    !object(head) ||
    head.sourceHash !== row.sha256 ||
    typeof head.revisionId !== 'string' ||
    !UUID.test(head.revisionId)
  )
    corrupt();
  return head.revisionId;
}
/** Material source pin, excluding unchanged-text inspection receipts. Review APIs still use the exact head. */
export function intakeSourceTextInterpretationRevisionId(
  db: Database,
  profileId: string,
  intakeId: string,
  revisionId?: string | null,
): string | null {
  const head = currentIntakeSourceTextRevisionId(db, profileId, intakeId);
  const id = revisionId ?? head;
  if (!id) return null;
  const row = owner(db, profileId, intakeId);
  // The durable intake projection keeps the last material revision. The common
  // current-head path must not walk hundreds of whole-document approval receipts.
  const metadata = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId);
  const pin = readIntakeSourcePin(db, intakeId);
  const material = pin
    ? pin.revisionId
    : metadata
      ? JSON.parse(String(metadata.details_json)).intake?.sourceTextRevisionId
      : null;
  if (id === head && typeof material === 'string') return material;
  let revision = loadRevision(db, profileId, intakeId, row.sha256, id);
  for (
    let count = 0;
    count < 4096 && revision.parentRevisionId && revision.review?.action === 'confirm';
    count++
  ) {
    const prior = loadRevision(db, profileId, intakeId, row.sha256, revision.parentRevisionId);
    if (!sourceTextConfirmationOnly(prior, revision)) break;
    revision = prior;
  }
  return revision.id;
}

export function sourceTextSummary(revision: SourceTextRevision): SourceTextSummary {
  const unresolved = revision.issues.filter((i) => ['open', 'later'].includes(i.status)).length;
  const exceptions = revision.issues.filter(
    (i) => i.status === 'unreadable' || i.kind === 'unsupported',
  ).length;
  const inspectedPages = revision.pages.filter((p) => p.inspected).length;
  const pending =
    unresolved > 0 ||
    inspectedPages !== revision.pages.length ||
    revision.pages.some((p) => p.disposition === 'partial');
  return {
    pages: revision.pages.length,
    spans: revision.spans.length,
    unresolved,
    exceptions,
    inspectedPages,
    status: pending
      ? 'needs-review'
      : exceptions ||
          revision.pages.some((p) => ['unreadable', 'unsupported'].includes(p.disposition))
        ? 'reviewed-with-exceptions'
        : 'reviewed',
  };
}
const dto = (revision: SourceTextRevision): IntakeSourceText => ({
  status: 'available',
  revision,
  summary: sourceTextSummary(revision),
});
export function getIntakeSourceText(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  revisionId?: string,
): IntakeSourceText {
  const row = source(db, root, profileId, intakeId),
    id = revisionId ?? currentIntakeSourceTextRevisionId(db, profileId, intakeId);
  return id
    ? dto(loadRevision(db, profileId, intakeId, row.sha256, id))
    : { status: 'unavailable', revision: null, summary: null };
}
const ISSUE_CHUNK = 50;
function issueProjection(issue: SourceTextIssue): SourceTextIssueList['issues'][number] {
  return {
    id: issue.id,
    region: issue.region,
    kind: issue.kind,
    status: issue.status,
    detail: issue.detail.slice(0, 1200),
    ...(issue.detail.length > 1200 ? { detailTruncated: true } : {}),
    category: sourceIssueCategory(issue),
    precision: issue.region.box ? 'region' : 'page',
  };
}
function issueSummary(pages: SourceTextPage[], issues: SourceTextIssue[]): SourceTextIssueSummary {
  const pending = issues.filter(sourceIssueNeedsReview);
  const coverageIssues = pending.filter((i) => sourceIssueCategory(i) === 'not-inspected').length;
  return {
    attentionSections: new Set(pending.map((issue) => issue.region.page)).size,
    pages: pages.length,
    inspectedPages: pages.filter((p) => p.inspected).length,
    totalIssues: pending.length,
    coverageIssues,
    specificIssues: pending.length - coverageIssues,
    exceptions: pending.filter(
      (i) =>
        i.status === 'later' ||
        i.status === 'unreadable' ||
        sourceIssueCategory(i) === 'processing-failure',
    ).length,
  };
}

/** Metadata-only queue. Completed originals never occupy an attention page. */
export function listSourceAttention(
  db: Database,
  profileId: string,
  offset = 0,
): SourceAttentionQueue {
  if (read(db, 'owner_profile_id') !== profileId)
    throw new HttpError(403, 'PROFILE_SCOPE', 'Source text belongs to a different profile');
  if (!Number.isSafeInteger(offset) || offset < 0) bad('Invalid source attention offset');
  const files = db
    .prepare(
      "SELECT f.id,f.sha256 FROM source_files f WHERE f.kind='intake_original' AND " +
        visibilityCondition(
          new URLSearchParams({ visibility: 'visible' }),
          visibilitySQL("'source_file'", 'f.id'),
        ) +
        " ORDER BY json_extract(f.details_json,'$.intake.createdAt') DESC,f.id",
    )
    .all() as { id: string; sha256: string }[];
  const items: SourceAttentionQueue['items'] = [];
  for (const file of files) {
    const head = currentIntakeSourceTextRevisionId(db, profileId, file.id);
    if (!head) continue;
    const saved = loadStoredRevision(db, profileId, file.id, file.sha256, head);
    let sections = saved.issueIndex?.summary.attentionSections;
    if (sections === undefined) {
      const pages = new Set<number>();
      if (saved.issueIndex)
        for (const chunk of saved.issueIndex.chunks) {
          const issues = readBlob(db, file.id, chunk.ref) as SourceTextIssue[];
          for (const issue of issues)
            if (sourceIssueNeedsReview(issue)) pages.add(issue.region.page);
        }
      else
        for (const ref of saved.pageRefs) {
          const page = readBlob(db, file.id, ref) as { issues: SourceTextIssue[] };
          for (const issue of page.issues)
            if (sourceIssueNeedsReview(issue)) pages.add(issue.region.page);
        }
      sections = pages.size;
    }
    if (!Number.isSafeInteger(sections) || sections < 0 || sections > saved.pageRefs.length)
      corrupt();
    if (sections > 0) items.push({ intakeId: file.id, sections });
  }
  const window = items.slice(offset, offset + 30);
  return {
    sections: items.reduce((sum, item) => sum + item.sections, 0),
    total: items.length,
    items: window,
    offset,
    nextOffset: offset + window.length < items.length ? offset + window.length : null,
  };
}
function persistIssueIndex(db: Database, revision: SourceTextRevision): StoredIssueIndexRefs {
  const issues = revision.issues
    .filter(sourceIssueNeedsReview)
    .map(issueProjection)
    .sort(
      (a, b) =>
        Number(a.category === 'not-inspected') - Number(b.category === 'not-inspected') ||
        a.region.page - b.region.page ||
        a.id.localeCompare(b.id),
    );
  const chunks = chunkBy(issues, (issue) => issue.id, ISSUE_CHUNK).map((values) => ({
    ref: blob(db, revision.intakeId, values),
    count: values.length,
  }));
  return {
    summary: issueSummary(revision.pages, revision.issues),
    chunkLists: chunkBy(chunks, (chunk) => chunk.ref, PAGE_CHUNK).map((list) =>
      blob(db, revision.intakeId, list),
    ),
  };
}
/** Bounded output and bounded page-blob working memory for pre-index revisions. No GET mutation. */
export function getIntakeSourceIssues(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  options: { revisionId?: string; offset?: number; limit?: number } = {},
): SourceTextIssueList {
  const offset = options.offset ?? 0,
    limit = options.limit ?? 50;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    bad('Choose an issue offset and a limit from 1 to 50');
  const row = source(db, root, profileId, intakeId);
  const revisionId = currentIntakeSourceTextRevisionId(db, profileId, intakeId);
  if (
    (options.revisionId && options.revisionId !== revisionId) ||
    (offset > 0 && !options.revisionId)
  )
    throw new HttpError(
      409,
      'SOURCE_TEXT_CHANGED',
      'Reload source issues before continuing this page',
    );
  if (!revisionId)
    return {
      status: 'unavailable',
      revisionId: null,
      sourceHash: row.sha256,
      adapter: null,
      summary: null,
      issues: [],
      offset,
      nextOffset: null,
    };
  const saved = loadStoredRevision(db, profileId, intakeId, row.sha256, revisionId);
  let summary: SourceTextIssueSummary;
  const issues: SourceTextIssueList['issues'] = [];
  if (saved.issueIndex) {
    const index = saved.issueIndex;
    if (
      !object(index.summary) ||
      !Array.isArray(index.chunks) ||
      index.chunks.length > 2000 ||
      (
        [
          'pages',
          'inspectedPages',
          'totalIssues',
          'coverageIssues',
          'specificIssues',
          'exceptions',
        ] as const
      ).some((field) => !Number.isSafeInteger(index.summary[field]) || index.summary[field] < 0) ||
      index.summary.pages !== saved.pageRefs.length ||
      index.chunks.some(
        (c) =>
          !HASH.test(c.ref) || !Number.isInteger(c.count) || c.count < 1 || c.count > ISSUE_CHUNK,
      ) ||
      index.chunks.reduce((n, c) => n + c.count, 0) !== index.summary.totalIssues
    )
      corrupt();
    summary = {
      pages: index.summary.pages,
      inspectedPages: index.summary.inspectedPages,
      totalIssues: index.summary.totalIssues,
      coverageIssues: index.summary.coverageIssues,
      specificIssues: index.summary.specificIssues,
      exceptions: index.summary.exceptions,
    };
    if (
      summary.inspectedPages > summary.pages ||
      summary.exceptions > summary.totalIssues ||
      summary.specificIssues + summary.coverageIssues !== summary.totalIssues
    )
      corrupt();
    let cursor = 0;
    for (const chunk of index.chunks) {
      if (cursor < offset + limit && cursor + chunk.count > offset) {
        const values = readBlob(db, intakeId, chunk.ref);
        if (!Array.isArray(values) || values.length !== chunk.count) corrupt();
        issues.push(
          ...(values as SourceTextIssueList['issues']).slice(
            Math.max(0, offset - cursor),
            offset + limit - cursor,
          ),
        );
      }
      cursor += chunk.count;
    }
  } else {
    let legacyPosition = 0;
    summary = {
      pages: saved.pageRefs.length,
      specificIssues: 0,
      coverageIssues: 0,
      exceptions: 0,
      inspectedPages: 0,
      totalIssues: 0,
    };
    for (const ref of saved.pageRefs) {
      const page = readBlob(db, intakeId, ref);
      if (!object(page) || !object(page.page) || !Array.isArray(page.issues)) corrupt();
      const stats = issueSummary(
        [page.page as unknown as SourceTextPage],
        page.issues as SourceTextIssue[],
      );
      for (const field of [
        'specificIssues',
        'coverageIssues',
        'exceptions',
        'inspectedPages',
        'totalIssues',
      ] as const)
        summary[field] += stats[field];
      for (const issue of page.issues as SourceTextIssue[])
        if (sourceIssueNeedsReview(issue)) {
          if (legacyPosition >= offset && issues.length < limit)
            issues.push(issueProjection(issue));
          legacyPosition++;
        }
    }
  }
  return {
    status: 'available',
    revisionId,
    sourceHash: row.sha256,
    adapter: saved.header.adapter,
    summary,
    issues,
    offset,
    nextOffset: offset + issues.length < summary.totalIssues ? offset + issues.length : null,
  };
}

function persist(db: Database, revision: SourceTextRevision): string[] {
  const { pages, spans, issues, relations, ...header } = revision;
  const pageRefs = pages.map((page) =>
    blob(db, revision.intakeId, {
      page,
      spans: spans.filter((s) => s.region.page === page.page),
      issues: issues.filter((i) => i.region.page === page.page),
    }),
  );
  const value: StoredRevision = {
    header,
    pageChunks: Array.from({ length: Math.ceil(pageRefs.length / PAGE_CHUNK) }, (_, i) =>
      blob(db, revision.intakeId, pageRefs.slice(i * PAGE_CHUNK, (i + 1) * PAGE_CHUNK)),
    ),
    relationLists: chunkBy(
      chunkBy(relations, (relation) => relation.id, PAGE_CHUNK).map((chunk) =>
        blob(db, revision.intakeId, chunk),
      ),
      (ref) => ref,
      PAGE_CHUNK,
    ).map((refs) => blob(db, revision.intakeId, refs)),
    issueIndex: persistIssueIndex(db, revision),
  };
  put(db, key(revision.intakeId, `revision:${revision.id}`), { value, sha256: hash(value) });
  db.prepare(
    'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(
    key(revision.intakeId, 'head'),
    encode({ revisionId: revision.id, sourceHash: revision.sourceHash }),
  );
  return pageRefs;
}
/** The durable transaction result: identity only, never revision content (CRS-117). */
interface SourceTextReceipt {
  format: 'intake-source-text-receipt-v1';
  revisionId: string;
  parentRevisionId: string | null;
  changedPages: number[];
}
function sourceTextReceipt(
  revision: SourceTextRevision,
  pageRefs: string[],
  priorRefs: string[] | null,
): SourceTextReceipt {
  return {
    format: 'intake-source-text-receipt-v1',
    revisionId: revision.id,
    parentRevisionId: revision.parentRevisionId,
    changedPages: revision.pages
      .filter((_page, index) => pageRefs[index] !== priorRefs?.[index])
      .map((page) => page.page),
  };
}
/** A replayed operation returns its stored result; rebuild the response it originally produced. */
function replayedSourceText(
  db: Database,
  profileId: string,
  intakeId: string,
  sourceHash: string,
  stored: unknown,
): IntakeSourceText {
  if (object(stored) && stored.format === 'intake-source-text-receipt-v1')
    return dto(loadRevision(db, profileId, intakeId, sourceHash, String(stored.revisionId)));
  // Results recorded before CRS-117 are the complete response itself.
  if (object(stored) && stored.status === 'available' && object(stored.revision))
    return stored as unknown as IntakeSourceText;
  return corrupt();
}
function mutate(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  request: { operationId: string; expectedRevisionId: string | null; sourceHash: string },
  fingerprint: unknown,
  apply: (prior: SourceTextRevision | null) => SourceTextRevision,
): IntakeSourceText {
  durable(db);
  const row = source(db, root, profileId, intakeId);
  if (
    !object(request) ||
    !UUID.test(request.operationId) ||
    !HASH.test(request.sourceHash) ||
    (request.expectedRevisionId !== null && !UUID.test(request.expectedRevisionId))
  )
    bad('Invalid operation or revision identity');
  if (request.sourceHash !== row.sha256)
    conflict('Source changed since this operation was prepared');
  const fp = hash({ profileId, intakeId, fingerprint });
  // The response is built from the revision in memory; only the receipt becomes durable history.
  let response: SourceTextRevision | undefined;
  // The operation receipt is also an ordinary durable record, so idempotency survives cache loss.
  const result = transaction(
    db,
    (): SourceTextReceipt => {
      const existing = read(db, key(intakeId, `operation:${request.operationId}`));
      if (existing) {
        const receipt = parse(existing);
        if (!object(receipt) || receipt.fingerprint !== fp)
          conflict('Operation ID was already used for a different source-text request');
        response = loadRevision(db, profileId, intakeId, row.sha256, String(receipt.revisionId));
        return sourceTextReceipt(response, [], []);
      }
      const head = currentIntakeSourceTextRevisionId(db, profileId, intakeId);
      if (head !== request.expectedRevisionId)
        conflict('Source text changed in another tab; reload before saving');
      const prior = head ? loadRevision(db, profileId, intakeId, row.sha256, head) : null;
      const revision = apply(prior);
      validateSourceTextEvidence(revision);
      const priorRefs = head
        ? loadStoredRevision(db, profileId, intakeId, row.sha256, head).pageRefs
        : null;
      const pageRefs = persist(db, revision);
      invalidateIntakeSourceTextDependencies(
        db,
        prior,
        revision,
        affectedSourcePages(prior, revision, priorRefs, pageRefs),
      );
      put(db, key(intakeId, `operation:${request.operationId}`), {
        fingerprint: fp,
        revisionId: revision.id,
      });
      response = revision;
      return sourceTextReceipt(revision, pageRefs, priorRefs);
    },
    {
      actor: 'source-text',
      origin: 'source-text-review',
      references: { intakeId, sourceHash: row.sha256 },
      operationId: request.operationId,
      fingerprint: fp,
    },
  );
  return response ? dto(response) : replayedSourceText(db, profileId, intakeId, row.sha256, result);
}
export function publishIntakeSourceText(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  request: {
    operationId: string;
    expectedRevisionId: string | null;
    sourceHash: string;
    evidence: SourceTextEvidence;
  },
): IntakeSourceText {
  if (!object(request)) bad('Invalid extraction publication');
  validateSourceTextEvidence(request.evidence);
  return mutate(
    db,
    root,
    profileId,
    intakeId,
    request,
    { kind: 'extraction', ...request },
    (prior) => {
      const protectedPages = prior?.protectedPages ?? [];
      const pageContents = (evidence: SourceTextEvidence, page: number) => ({
        page: evidence.pages.find((p) => p.page === page),
        spans: evidence.spans.filter((s) => s.region.page === page),
        issues: evidence.issues.filter((i) => i.region.page === page),
      });
      const protectedRelations = (evidence: SourceTextEvidence) => {
        const ids = new Set(
          evidence.spans.filter((s) => protectedPages.includes(s.region.page)).map((s) => s.id),
        );
        return evidence.relations.filter((r) => ids.has(r.from) || ids.has(r.to));
      };
      if (
        prior &&
        (protectedPages.some(
          (page) =>
            encode(pageContents(prior, page)) !== encode(pageContents(request.evidence, page)),
        ) ||
          encode(protectedRelations(prior)) !== encode(protectedRelations(request.evidence)))
      )
        throw new HttpError(
          409,
          'SOURCE_TEXT_REVIEW_CONFLICT',
          'Automatic extraction cannot replace reviewed source pages or their relationships',
        );
      const unprotectedIds = new Set(
        request.evidence.spans
          .filter((s) => !protectedPages.includes(s.region.page))
          .map((s) => s.id),
      );
      if (
        request.evidence.pages.some((p) => !protectedPages.includes(p.page) && p.inspected) ||
        request.evidence.spans.some(
          (s) => !protectedPages.includes(s.region.page) && s.provenance === 'human',
        ) ||
        request.evidence.issues.some(
          (i) => !protectedPages.includes(i.region.page) && i.status !== 'open',
        ) ||
        request.evidence.relations.some(
          (r) => unprotectedIds.has(r.from) && unprotectedIds.has(r.to) && r.provenance === 'human',
        )
      )
        bad('An extraction adapter cannot attest human inspection');
      if (
        prior &&
        (prior.pages.length !== request.evidence.pages.length ||
          prior.pages.some((p) => !request.evidence.pages.some((n) => n.page === p.page)))
      )
        conflict('Extraction cannot silently change the source inventory');
      return {
        ...request.evidence,
        format: FORMAT,
        id: randomUUID(),
        parentRevisionId: prior?.id ?? null,
        profileId,
        intakeId,
        sourceHash: request.sourceHash,
        createdAt: new Date().toISOString(),
        review: null,
        protectedPages,
      };
    },
  );
}
function contains(scope: SourceTextRegion, target: SourceTextRegion): boolean {
  if (scope.page !== target.page) return false;
  if (!scope.box) return true;
  if (!target.box) return false;
  const [x, y, w, h] = scope.box,
    [a, b, c, d] = target.box;
  return a >= x - 1e-6 && b >= y - 1e-6 && a + c <= x + w + 1e-6 && b + d <= y + h + 1e-6;
}
export function reviewIntakeSourceText(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  request: SourceTextReviewRequest,
  actor: string,
): IntakeSourceText {
  if (
    !object(request) ||
    !['confirm', 'correct', 'not-text', 'unreadable', 'later', 'clarification'].includes(
      request.action,
    ) ||
    typeof actor !== 'string' ||
    !actor ||
    actor.length > 256
  )
    bad('Invalid source-text review action');
  region(request.scope);
  if (
    request.reason !== undefined &&
    (typeof request.reason !== 'string' || request.reason.length > 10000)
  )
    bad('Invalid review reason');
  if (['not-text', 'unreadable', 'later'].includes(request.action) && !request.reason?.trim())
    bad('Give a reason for this source disposition');
  if (request.action === 'correct' && !Array.isArray(request.spans))
    bad('Correction requires replacement spans for the inspected scope');
  if (
    request.action !== 'correct' &&
    (request.spans !== undefined || request.relations !== undefined)
  )
    bad('Only a correction may replace source text or relationships');
  if (
    request.action === 'clarification' &&
    (typeof request.clarification !== 'string' ||
      !request.clarification.trim() ||
      request.clarification.length > 100000)
  )
    bad('Clarification requires separately attributed information');
  if (request.action !== 'clarification' && request.clarification !== undefined)
    bad('External clarification must remain separate from transcription');
  if (
    request.resolveIssueIds !== undefined &&
    (request.action !== 'confirm' ||
      !Array.isArray(request.resolveIssueIds) ||
      request.resolveIssueIds.length > 100 ||
      request.resolveIssueIds.some((id) => typeof id !== 'string' || !ID.test(id)) ||
      new Set(request.resolveIssueIds).size !== request.resolveIssueIds.length)
  )
    bad('Explicit issue resolutions require a unique bounded selection with confirmation');
  return mutate(
    db,
    root,
    profileId,
    intakeId,
    request,
    { kind: 'human-review', actor, ...request },
    (prior) => {
      if (!prior) conflict('Extract source text before reviewing it');
      const revision = structuredClone(prior!);
      region(request.scope, new Set(revision.pages.map((p) => p.page)));
      const resolved = new Set(request.resolveIssueIds ?? []);
      for (const id of resolved) {
        const issue = revision.issues.find((i) => i.id === id);
        if (!issue || !contains(request.scope, issue.region))
          bad('Choose an existing issue inside the inspected scope');
        if (
          issue.kind === 'unsupported' &&
          !(
            issue.id.endsWith('-ocr-unavailable') &&
            revision.spans.some((s) => s.provenance === 'human' && contains(s.region, issue.region))
          )
        )
          bad('Unsupported format limitations cannot be resolved by source-text confirmation');
        if (
          (issue.kind === 'unreadable' || issue.status === 'unreadable') &&
          !revision.spans.some(
            (s) => s.provenance === 'human' && regionsOverlap(s.region, issue.region),
          )
        )
          bad('Transcribe the source in this region before explicitly resolving unreadability');
      }
      const removed = new Set<string>();
      if (['correct', 'not-text'].includes(request.action)) {
        revision.spans = revision.spans.filter((s) => {
          if (contains(request.scope, s.region)) {
            removed.add(s.id);
            return false;
          }
          return true;
        });
        revision.relations = revision.relations.filter(
          (r) => !removed.has(r.from) && !removed.has(r.to),
        );
      }
      if (request.action === 'correct') {
        for (const span of request.spans!) {
          if (!object(span)) bad('Invalid replacement span');
          region(span.region, new Set(revision.pages.map((p) => p.page)));
          if (!contains(request.scope, span.region))
            bad('Correction spans must remain inside the inspected source scope');
          const { confidence: _confidence, alternatives: _alternatives, ...literal } = span;
          revision.spans.push({ ...literal, provenance: 'human' });
        }
        if (request.relations !== undefined) {
          if (!Array.isArray(request.relations)) bad('Invalid replacement relationships');
          uniqueIds(request.relations, 'relation');
          const old = new Map(prior!.relations.map((r) => [r.id, r]));
          const spans = new Map(revision.spans.map((s) => [s.id, s]));
          const incoming = new Map(request.relations.map((r) => [r.id, r]));
          for (const r of prior!.relations) {
            const from = spans.get(r.from),
              to = spans.get(r.to);
            if (
              from &&
              to &&
              !contains(request.scope, from.region) &&
              !contains(request.scope, to.region) &&
              encode(incoming.get(r.id)) !== encode(r)
            )
              bad('Relationships outside the inspected scope must remain unchanged');
          }
          for (const r of request.relations) {
            const before = old.get(r.id);
            if (before && encode(before) === encode(r)) continue;
            const from = spans.get(r.from),
              to = spans.get(r.to);
            if (
              !from ||
              !to ||
              (!contains(request.scope, from.region) && !contains(request.scope, to.region))
            )
              bad('Changed relationship must touch the inspected scope');
          }
          revision.relations = request.relations.map((r) =>
            old.get(r.id) && encode(old.get(r.id)) === encode(r)
              ? r
              : { ...r, provenance: 'human' },
          );
        }
      }
      if (request.action !== 'clarification') {
        for (const issue of revision.issues)
          if (
            contains(request.scope, issue.region) &&
            (request.action !== 'correct' || /^p\d+-pending$/.test(issue.id)) &&
            !(
              request.action === 'confirm' &&
              !resolved.has(issue.id) &&
              (issue.status === 'unreadable' ||
                issue.kind === 'unreadable' ||
                issue.kind === 'unsupported')
            )
          )
            issue.status =
              request.action === 'confirm'
                ? 'confirmed'
                : request.action === 'correct'
                  ? 'corrected'
                  : request.action;
        if (request.action === 'correct') {
          // Saving an edit does not attest that every warning or every pixel was inspected.
          // Resolve only the internal pending-extraction placeholder; human inspection
          // remains separate so a protected manually transcribed page can still finish.
          const inspectionId = `human-inspection-p${request.scope.page}`;
          revision.issues = revision.issues.filter((i) => i.id !== inspectionId);
          revision.issues.push({
            id: inspectionId,
            region: { page: request.scope.page },
            kind: 'coverage',
            status: 'open',
            detail:
              'Transcription changed. Inspect the full source page and explicitly confirm it; saving a correction did not resolve other uncertainties.',
          });
          revision.pages.find((p) => p.page === request.scope.page)!.inspected = false;
        }
        if (['unreadable', 'later', 'not-text'].includes(request.action))
          revision.issues.push({
            id: randomUUID(),
            region: request.scope,
            kind: request.action === 'unreadable' ? 'unreadable' : 'coverage',
            detail: request.reason!,
            status: request.action as 'unreadable' | 'later' | 'not-text',
          });
        if (!request.scope.box) {
          const page = revision.pages.find((p) => p.page === request.scope.page)!;
          page.inspected = !['later', 'correct'].includes(request.action);
          if (request.action === 'not-text') page.disposition = 'not-text';
          else if (request.action === 'unreadable') page.disposition = 'unreadable';
          else if (request.action === 'later') page.disposition = 'partial';
          else if (!['unreadable', 'unsupported'].includes(page.disposition))
            page.disposition = 'extracted';
          if (
            request.action === 'confirm' &&
            page.disposition === 'unreadable' &&
            resolved.size > 0 &&
            !revision.issues.some(
              (i) =>
                i.region.page === page.page &&
                (i.kind === 'unreadable' || i.status === 'unreadable') &&
                !['confirmed', 'corrected', 'not-text'].includes(i.status),
            )
          )
            page.disposition = 'extracted';
        }
      }
      const at = new Date().toISOString();
      return {
        ...revision,
        id: randomUUID(),
        parentRevisionId: prior!.id,
        createdAt: at,
        protectedPages: [...new Set([...revision.protectedPages, request.scope.page])].sort(
          (a, b) => a - b,
        ),
        review: {
          operationId: request.operationId,
          expectedRevisionId: prior!.id,
          action: request.action,
          scope: request.scope,
          actor,
          at,
          ...(request.reason ? { reason: request.reason } : {}),
          ...(request.clarification ? { clarification: request.clarification } : {}),
          ...(resolved.size ? { resolvedIssueIds: [...resolved] } : {}),
        },
      };
    },
  );
}
function regionsOverlap(a: SourceTextRegion, b: SourceTextRegion): boolean {
  if (a.page !== b.page) return false;
  if (!a.box || !b.box) return true;
  return (
    a.box[0] < b.box[0] + b.box[2] &&
    b.box[0] < a.box[0] + a.box[2] &&
    a.box[1] < b.box[1] + b.box[3] &&
    b.box[1] < a.box[1] + a.box[3]
  );
}
export function getIntakeSourceTextPassage(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  options: {
    revisionId?: string;
    page?: number;
    offset?: number;
    character?: number;
    limit?: number;
    maxCharacters?: number;
    issueOffset?: number;
    relationOffset?: number;
    historyBeforeRevisionId?: string;
  } = {},
): SourceTextPassage {
  const {
    offset = 0,
    character = 0,
    limit = 50,
    maxCharacters = 12000,
    issueOffset = 0,
    relationOffset = 0,
  } = options;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(character) ||
    character < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 1 ||
    maxCharacters > 64000 ||
    !Number.isSafeInteger(issueOffset) ||
    issueOffset < 0 ||
    !Number.isSafeInteger(relationOffset) ||
    relationOffset < 0 ||
    (options.page !== undefined && (!Number.isSafeInteger(options.page) || options.page < 1))
  )
    bad('Invalid passage bounds');
  const result = getIntakeSourceText(db, root, profileId, intakeId, options.revisionId);
  if (!result.revision)
    throw new HttpError(
      404,
      'SOURCE_TEXT_UNAVAILABLE',
      'Durable text is not available for this import',
    );
  const candidates = result.revision.spans.filter(
      (s) => options.page === undefined || s.region.page === options.page,
    ),
    spans: SourceTextSpan[] = [];
  let chars = 0,
    cursor = offset,
    characterCursor = character;
  const spanFragments: SourceTextPassage['spanFragments'] = [];
  if (
    character &&
    (!candidates[offset] ||
      character >= candidates[offset].text.length ||
      splitsSurrogate(candidates[offset].text, character))
  )
    bad('Invalid literal fragment cursor');
  while (cursor < candidates.length && spans.length < limit && chars < maxCharacters) {
    const { alternatives: _alternatives, ...span } = candidates[cursor];
    let end = Math.min(span.text.length, characterCursor + maxCharacters - chars);
    // Bound serialized bytes, not only JS characters (escaping and Unicode expand).
    while (
      end > characterCursor &&
      Buffer.byteLength(
        encode({
          spans: [...spans, { ...span, text: span.text.slice(characterCursor, end) }],
          spanFragments: [
            ...spanFragments,
            { spanId: span.id, start: characterCursor, end, total: span.text.length },
          ],
        }),
      ) > 40000
    )
      end = characterCursor + Math.floor((end - characterCursor) / 2);
    if (splitsSurrogate(span.text, end)) end--;
    if (end === characterCursor) {
      if (!spans.length) bad('Passage character budget cannot hold the next character');
      break;
    }
    const text = span.text.slice(characterCursor, end);
    spans.push({ ...span, text });
    spanFragments.push({ spanId: span.id, start: characterCursor, end, total: span.text.length });
    chars += text.length;
    if (end < span.text.length) {
      characterCursor = end;
      break;
    }
    cursor++;
    characterCursor = 0;
  }
  const ids = new Set(spans.map((s) => s.id));
  const issues = result.revision.issues.filter(
    (i) => options.page === undefined || i.region.page === options.page,
  );
  const relations = result.revision.relations.filter((r) => ids.has(r.from) || ids.has(r.to));
  const history = getIntakeSourceTextReviewHistory(db, root, profileId, intakeId, {
    beforeRevisionId: options.historyBeforeRevisionId ?? result.revision.id,
  });
  const passage: SourceTextPassage = {
    revisionId: result.revision.id,
    sourceHash: result.revision.sourceHash,
    spans,
    issues: [],
    relations: [],
    issuesTruncated: issueOffset < issues.length,
    relationsTruncated: relationOffset < relations.length,
    nextIssueOffset: issueOffset < issues.length ? issueOffset : null,
    nextRelationOffset: relationOffset < relations.length ? relationOffset : null,
    alternativeCounts: Object.fromEntries(
      candidates
        .slice(offset, cursor + (characterCursor ? 1 : 0))
        .filter((s) => s.alternatives?.length)
        .map((s) => [s.id, s.alternatives!.length]),
    ),
    spanFragments,
    nextOffset: cursor < candidates.length ? cursor : null,
    nextCharacter: cursor < candidates.length ? characterCursor : 0,
    reviewHistory: [],
    nextHistoryRevisionId: history.entries[0]?.revisionId ?? null,
  };
  for (const issue of issues.slice(issueOffset, issueOffset + 200)) {
    const short = {
      ...issue,
      detail: safePrefix(issue.detail, 256),
      ...(issue.detail.length > 256
        ? { detailTruncated: true, detailCharacters: issue.detail.length }
        : {}),
    };
    passage.issues.push(short);
    if (Buffer.byteLength(encode(passage)) > 48000) {
      passage.issues.pop();
      break;
    }
  }
  passage.nextIssueOffset =
    issueOffset + passage.issues.length < issues.length
      ? issueOffset + passage.issues.length
      : null;
  passage.issuesTruncated = passage.nextIssueOffset !== null;
  for (const relation of relations.slice(relationOffset, relationOffset + 200)) {
    passage.relations.push(relation);
    if (Buffer.byteLength(encode(passage)) > 54000) {
      passage.relations.pop();
      break;
    }
  }
  passage.nextRelationOffset =
    relationOffset + passage.relations.length < relations.length
      ? relationOffset + passage.relations.length
      : null;
  passage.relationsTruncated = passage.nextRelationOffset !== null;
  for (const entry of history.entries) {
    const short = structuredClone(entry);
    if (short.event)
      for (const field of ['reason', 'clarification'] as const) {
        const text = short.event[field];
        if (text && text.length > 256) {
          short.event[field] = safePrefix(text, 256);
          (short.truncatedFields ??= []).push(field);
        }
      }
    passage.reviewHistory.push(short);
    if (Buffer.byteLength(encode(passage)) > 60000) {
      passage.reviewHistory.pop();
      break;
    }
  }
  passage.nextHistoryRevisionId =
    passage.reviewHistory.length < history.entries.length
      ? history.entries[passage.reviewHistory.length].revisionId
      : history.nextRevisionId;
  if (Buffer.byteLength(encode(passage)) > 60000)
    bad('Requested source passage metadata exceeds the bound; use a smaller span limit');
  return passage;
}
function splitsSurrogate(text: string, at: number): boolean {
  return at > 0 && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at] ?? '');
}
function safePrefix(text: string, length: number): string {
  return text.slice(0, splitsSurrogate(text, length) ? length - 1 : length);
}
/** Full long alternatives/issue descriptions/user clarifications remain retrievable by exact cursor. */
export function getIntakeSourceTextAnnotation(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  options: {
    revisionId: string;
    kind: 'alternative' | 'issue' | 'review';
    id: string;
    index?: number;
    field?: 'reason' | 'clarification';
    offset?: number;
    maxCharacters?: number;
  },
): SourceTextAnnotationPassage {
  const { offset = 0, maxCharacters = 4000 } = options;
  if (
    !UUID.test(options.revisionId) ||
    !identityAnnotation(options.id) ||
    !['alternative', 'issue', 'review'].includes(options.kind) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 1 ||
    maxCharacters > 12000
  )
    bad('Invalid source annotation cursor');
  const row = source(db, root, profileId, intakeId);
  let text: string | undefined;
  if (options.kind === 'review') {
    if (!['reason', 'clarification'].includes(options.field ?? ''))
      bad('Choose an attributed review field');
    // The annotation ID is the exact historical revision, scoped to this original.
    const { header } = loadStoredRevision(db, profileId, intakeId, row.sha256, options.id);
    text = header.review?.[options.field!];
  } else {
    const revision = loadRevision(db, profileId, intakeId, row.sha256, options.revisionId);
    if (options.kind === 'issue') text = revision.issues.find((i) => i.id === options.id)?.detail;
    else {
      if (!Number.isSafeInteger(options.index) || options.index! < 0)
        bad('Choose a reader alternative');
      text = revision.spans.find((s) => s.id === options.id)?.alternatives?.[options.index!]?.text;
    }
  }
  if (text === undefined)
    throw new HttpError(404, 'SOURCE_TEXT_ANNOTATION_NOT_FOUND', 'Source annotation not found');
  if (offset > text.length || splitsSurrogate(text, offset))
    bad('Invalid source annotation character cursor');
  let end = Math.min(text.length, offset + maxCharacters);
  while (Buffer.byteLength(encode(text.slice(offset, end))) > 20000)
    end = offset + Math.floor((end - offset) / 2);
  if (splitsSurrogate(text, end)) end--;
  if (end === offset && offset < text.length)
    bad('Annotation budget cannot hold the next character');
  return {
    revisionId: options.revisionId,
    sourceHash: row.sha256,
    kind: options.kind,
    id: options.id,
    ...(options.index !== undefined ? { index: options.index } : {}),
    ...(options.field ? { field: options.field } : {}),
    text: text.slice(offset, end),
    offset,
    totalCharacters: text.length,
    nextOffset: end < text.length ? end : null,
  };
}
const identityAnnotation = (value: unknown): value is string =>
  typeof value === 'string' && ID.test(value);
