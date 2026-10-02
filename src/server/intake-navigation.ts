import { readStoredIntakeDetails } from './intake-state-access.ts';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIntake, getIntakeOriginal, getRetainedIntakeOriginalReference } from './intake.ts';
import { searchPdfEvidence } from './intake-pdf-session.ts';
import { HttpError } from './database.ts';
import { workflowHash } from './intake-workflow.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { IntakeExtractionPlan } from '../shared/intake.ts';
import type { EvidenceIndex, PlannedExtractionUnit } from './intake-plan.ts';

interface NavigationReference {
  id: string;
  asset?: boolean;
  source: string;
  locator: string;
  status: string;
  note: string;
  sourceFileId?: string;
  contentUrl?: string;
  memberId?: string;
  intakeId?: string;
  fragment?: string;
}

interface NavigationAnchor {
  name: string;
  start: number;
  end: number;
  locator: string;
}

interface NavigationSection {
  id: string;
  locator: string;
  page?: number;
  start?: number;
  end?: number;
}

export interface NavigationIndex extends EvidenceIndex {
  sourceHash?: string;
  pages?: number;
  sections?: NavigationSection[];
  references?: NavigationReference[];
  anchors?: NavigationAnchor[];
  missingAssets?: NavigationReference[];
}

interface EvidenceSource {
  id: string;
  hash?: string;
  filename?: string;
  index: NavigationIndex;
}

interface NavigationContext {
  db: DatabaseSync;
  root: string;
  profileId: string;
  id: string;
  index: NavigationIndex;
  assertRunning: () => void;
  query?: unknown;
  offset?: unknown;
  referenceId?: string;
}

interface PdfAnnotation {
  id: string;
  dest?: string | unknown[];
  url?: string;
  unsafeUrl?: string;
}

interface PdfPage {
  getAnnotations(): Promise<PdfAnnotation[]>;
  getTextContent(): Promise<{ items: ({ str: string; hasEOL?: boolean } | object)[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(number: number): Promise<PdfPage>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(reference: unknown): Promise<number>;
}

interface PdfTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface FollowTarget {
  reference: NavigationReference;
  followed: boolean;
  sourceFileId: string;
  kind: string;
  coverage: string;
  start?: number;
  locator?: string;
}

interface PlannedReadContext {
  db: DatabaseSync;
  root: string;
  profileId: string;
  id: string;
  plan: Omit<IntakeExtractionPlan, 'index' | 'units'> & {
    index: NavigationIndex;
    units: PlannedExtractionUnit[];
  };
  unit: PlannedExtractionUnit;
  offset?: number;
  limit?: number;
}

const inertHtml = (text: string): string =>
  text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (value) => ' '.repeat(value.length));
const decodedAttribute = (value: string): string =>
  value.replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    const replacement = named[entity.toLowerCase() as keyof typeof named];
    if (replacement) return replacement;
    const number =
      entity[2].toLowerCase() === 'x'
        ? parseInt(entity.slice(3), 16)
        : parseInt(entity.slice(2), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
function attribute(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`(?:\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return match ? decodedAttribute(match[1] ?? match[2] ?? match[3]) : null;
}
function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function htmlNavigationIndex({
  db,
  id,
  filename,
  text,
}: {
  db: DatabaseSync;
  id: string;
  filename: string;
  text: string;
}) {
  const own = JSON.parse(
    (
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id) as
        { details_json?: string } | undefined
    )?.details_json || '{}',
  ) as { intake?: { parentSourceFileId?: string } };
  const intakeDetails = own.intake;
  const siblings = intakeDetails?.parentSourceFileId
    ? db
        .prepare(
          "SELECT id,details_json FROM source_files WHERE json_extract(details_json,'$.intake.parentSourceFileId')=?",
        )
        .all(intakeDetails.parentSourceFileId)
        .map((row) => {
          const value = row as { id: string; details_json: string };
          return {
            id: value.id,
            name: (JSON.parse(value.details_json) as { intake: { originalName: string } }).intake
              .originalName,
          };
        })
    : [];
  const parentDetails = intakeDetails?.parentSourceFileId
    ? readStoredIntakeDetails(db, intakeDetails.parentSourceFileId)
    : undefined;
  const inventory = parentDetails?.workflow?.plans?.find(
    (plan) => plan.status === 'active' && plan.index?.inventoryVersion === 1,
  )?.index;
  const anchors: NavigationAnchor[] = [],
    headings: { kind: string; start: number; end: number; text: string }[] = [],
    references: NavigationReference[] = [];
  const inert = inertHtml(text);
  for (const heading of inert.matchAll(
    /<h([1-6])\b[^>]*>[\s\S]*?<\/h\1\s*>|<caption\b[^>]*>[\s\S]*?<\/caption\s*>/gi,
  ))
    headings.push({
      kind: /^<caption/i.test(heading[0]) ? 'caption' : 'heading',
      start: heading.index,
      end: heading.index + heading[0].length,
      text: heading[0].replace(/<[^>]*>/g, '').slice(0, 1000),
    });
  for (const tag of inert.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    const anchor =
      attribute(tag[0], 'id') || (tag[1].toLowerCase() === 'a' ? attribute(tag[0], 'name') : null);
    if (anchor)
      anchors.push({
        name: anchor,
        start: tag.index,
        end: tag.index + tag[0].length,
        locator: `characters ${tag.index}–${tag.index + tag[0].length}`,
      });
    const kind = tag[1].toLowerCase(),
      asset = ['img', 'iframe', 'object', 'source', 'video', 'audio'].includes(kind);
    const source = attribute(tag[0], asset ? (kind === 'object' ? 'data' : 'src') : 'href');
    if (source == null) continue;
    if (references.length >= 5000)
      throw new HttpError(
        413,
        'REFERENCE_LIMIT',
        'This document exceeds 5,000 indexed references; original retained',
      );
    const reference = {
      id: 'reference:' + workflowHash([id, tag.index, source]),
      asset,
      source: source.slice(0, 2000),
      locator: `characters ${tag.index}–${tag.index + tag[0].length}`,
      status: 'not_supplied',
      note: 'Only retained evidence can be followed. No external dependency was fetched.',
    };
    const path = decodePart(source.split(/[?#]/, 1)[0]),
      fragment = decodePart(source.includes('#') ? source.slice(source.indexOf('#') + 1) : '');
    if (source.startsWith('data:image/')) reference.status = 'inline_visual_uninspected';
    else if (
      path != null &&
      fragment != null &&
      !/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(path) &&
      !/[\x00-\x1f\\]/.test(path)
    ) {
      const targetName = posix.normalize(posix.join(posix.dirname(filename), path));
      const supplied =
        path === '' || targetName === filename
          ? { id }
          : siblings.find((sibling) => sibling.name === targetName) ||
            inventory?.members?.find((member) => member.filename === targetName);
      if (supplied)
        Object.assign(reference, {
          ...('id' in supplied
            ? {
                sourceFileId: supplied.id,
                contentUrl: `/api/sources/${encodeURIComponent(supplied.id)}/content`,
              }
            : { memberId: supplied.memberId, intakeId: intakeDetails!.parentSourceFileId }),
          fragment,
          status: 'supplied_uninspected',
        });
    }
    references.push(reference);
  }
  return { references, anchors, headings };
}

export async function pdfNavigationIndex(
  document: PdfDocument,
  id: string,
  assertRunning: () => void,
) {
  const sections: NavigationSection[] = [],
    references: NavigationReference[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    assertRunning();
    sections.push({ id: `page:${number}`, locator: `page ${number}`, page: number });
    const page = await document.getPage(number),
      annotations = await page.getAnnotations();
    assertRunning();
    for (const annotation of annotations) {
      if (!annotation.dest && !annotation.url && !annotation.unsafeUrl) continue;
      if (references.length >= 5000)
        throw new HttpError(
          413,
          'REFERENCE_LIMIT',
          'This PDF exceeds 5,000 indexed references; original retained',
        );
      const reference = {
        id: 'reference:' + workflowHash([id, number, annotation.id]),
        source: String(annotation.unsafeUrl || annotation.url || annotation.dest).slice(0, 2000),
        locator: `page ${number}, annotation ${annotation.id}`,
        status: 'not_supplied',
        note: 'PDF link target is uninspected. No external dependency was fetched.',
      };
      if (annotation.dest) {
        try {
          const destination =
            typeof annotation.dest === 'string'
              ? await document.getDestination(annotation.dest)
              : annotation.dest;
          const targetPage = destination
            ? (Number.isInteger(destination[0])
                ? Number(destination[0])
                : await document.getPageIndex(destination[0])) + 1
            : null;
          if (targetPage !== null && targetPage > 0 && targetPage <= document.numPages)
            Object.assign(reference, {
              sourceFileId: id,
              fragment: `page=${targetPage}`,
              status: 'supplied_uninspected',
            });
          else reference.status = 'unresolved_reference';
        } catch {
          reference.status = 'unresolved_reference';
        }
        assertRunning();
      }
      references.push(reference);
    }
  }
  return { sections, references };
}

function sources(index: NavigationIndex, id: string): EvidenceSource[] {
  return index.kind === 'zip'
    ? (index.members || [])
        .filter((member) => member.sourceFileId)
        .map((member) => ({
          id: member.sourceFileId!,
          hash: member.sourceHash,
          filename: member.filename,
          index: member.index as NavigationIndex,
        }))
    : [{ id, index }];
}
function originalFor(
  context: Pick<NavigationContext, 'db' | 'root' | 'profileId'>,
  source: Pick<EvidenceSource, 'id' | 'hash'>,
) {
  const original = getIntakeOriginal(context.db, context.root, context.profileId, source.id);
  // getIntakeOriginal verifies bytes against retained metadata. This extra pin
  // prevents a plan from silently switching to a different member's content.
  if (source.hash && createHash('sha256').update(original.bytes).digest('hex') !== source.hash)
    throw new HttpError(409, 'SOURCE_CHANGED', 'The member no longer matches this extraction plan');
  return original;
}
async function pdfDocument(original: ReturnType<typeof getIntakeOriginal>): Promise<PdfTask> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return (getDocument as unknown as (options: Record<string, unknown>) => PdfTask)({
    data: new Uint8Array(original.bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(
      new URL('../../standard_fonts/', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')),
    ),
  });
}

/** One host-selected page; uses the same inert PDF lifecycle as evidence navigation. */
export async function readIdentityPageText(
  original: ReturnType<typeof getIntakeOriginal>,
  pageNumber: number,
): Promise<string> {
  const task = await pdfDocument(original);
  try {
    const document = await task.promise;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages)
      throw new HttpError(400, 'IDENTITY_EVIDENCE', 'Choose an existing original PDF page');
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
      .join('');
    if (text.length > 250000)
      throw new HttpError(
        413,
        'IDENTITY_EVIDENCE',
        'Review this unusually large page individually',
      );
    return text;
  } finally {
    await task.destroy();
  }
}
export async function searchIndexedEvidence(context: NavigationContext) {
  const query = typeof context.query === 'string' ? context.query.trim() : '';
  const offset = Number(context.offset || 0);
  if (!query || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
    throw new HttpError(
      400,
      'SEARCH_INPUT',
      'Enter 1–200 search characters and an offset from 0–10,000',
    );
  const needle = query.toLocaleLowerCase(),
    results: {
      sourceFileId: string;
      filename?: string;
      sectionId: string;
      locator: string;
      page?: number;
      start?: number;
      end?: number;
      snippet: string;
    }[] = [];
  let skipped = 0,
    hasMore = false;
  const add = (
    source: EvidenceSource,
    section: NavigationSection,
    text: string,
    base = 0,
  ): void => {
    const found = text.toLocaleLowerCase().indexOf(needle);
    if (found < 0) return;
    if (skipped++ < offset) return;
    const start = Math.max(0, found - 160),
      end = Math.min(text.length, found + needle.length + 320);
    results.push({
      sourceFileId: source.id,
      filename: source.filename,
      sectionId: section.id,
      locator: section.locator,
      ...(section.page ? { page: section.page } : { start: base + start, end: base + end }),
      snippet: text.slice(start, end),
    });
  };
  for (const source of sources(context.index, context.id)) {
    context.assertRunning();
    if (!['html', 'text', 'pdf'].includes(source.index.kind)) continue;
    if (source.index.kind === 'pdf') {
      const retained = getRetainedIntakeOriginalReference(
        context.db,
        context.root,
        context.profileId,
        source.id,
      );
      if (source.hash && retained.sourceHash !== source.hash)
        throw new HttpError(
          409,
          'SOURCE_CHANGED',
          'The member no longer matches this extraction plan',
        );
      const sourceOffset = Math.max(0, offset - skipped);
      const searched = await searchPdfEvidence(
        { ...retained, profileId: context.profileId },
        query,
        sourceOffset,
        context.assertRunning,
      );
      skipped += Math.min(sourceOffset, searched.matchedPages);
      for (const result of searched.results) {
        const section = source.index.sections?.find((candidate) => candidate.page === result.page);
        if (!section) continue;
        results.push({
          sourceFileId: source.id,
          filename: source.filename,
          sectionId: section.id,
          locator: section.locator,
          page: result.page,
          snippet: result.snippet,
        });
      }
      if (searched.nextOffset !== null) hasMore = true;
    } else {
      const original = originalFor(context, source);
      const literal = new TextDecoder('utf-8', { fatal: true }).decode(original.bytes),
        text = source.index.kind === 'html' ? inertHtml(literal) : literal;
      for (const section of source.index.sections || []) {
        add(source, section, text.slice(section.start!, section.end!), section.start);
        if (results.length > 20) break;
      }
    }
    if (results.length > 20) {
      hasMore = true;
      break;
    }
  }
  return {
    query,
    results: results.slice(0, 20),
    nextOffset: hasMore || results.length > 20 ? offset + 20 : null,
    coverage: 'search_only',
    note: 'Literal text search is not clinical extraction. Image-only content and nested archives are not searched; open their retained evidence explicitly.',
  };
}

export async function followIndexedReference(context: NavigationContext) {
  const owner = sources(context.index, context.id).find((source) =>
    source.index.references?.some((reference) => reference.id === context.referenceId),
  );
  const reference = owner?.index.references?.find(
    (reference) => reference.id === context.referenceId,
  );
  if (!reference)
    throw new HttpError(
      404,
      'REFERENCE_NOT_FOUND',
      'Reference does not belong to this supplied evidence index',
    );
  if (!reference.sourceFileId)
    return {
      reference,
      followed: false,
      coverage: 'uninspected',
      ...(reference.memberId
        ? { intakeId: reference.intakeId, memberId: reference.memberId, nextAction: 'read_member' }
        : {}),
      note: reference.memberId
        ? 'Supplied archive member remains uninspected. Use health_intake_package read_member with the supplied intakeId and memberId; no content was read by following this reference.'
        : 'Target is not a separately supplied file. No network request was made.',
    };
  const targetIntake = getIntake(
    context.db,
    context.root,
    context.profileId,
    reference.sourceFileId,
  );
  context.assertRunning();
  const { indexIntakeEvidence } = await import('./intake-evidence.ts');
  // Following a nested archive returns a descriptor. Expanding it requires a
  // separate explicit plan/read, so a link cannot recursively expand archives.
  if (targetIntake.mimeType === 'application/zip')
    return {
      reference,
      followed: true,
      sourceFileId: reference.sourceFileId,
      kind: 'archive',
      coverage: 'uninspected',
      note: 'Retained nested archive. Open it explicitly to inspect its bounded members.',
    };
  const index: NavigationIndex =
    reference.sourceFileId === owner!.id
      ? owner!.index
      : ((await indexIntakeEvidence({
          ...context,
          id: reference.sourceFileId,
        })) as NavigationIndex);
  const target: FollowTarget = {
    reference,
    followed: true,
    sourceFileId: reference.sourceFileId,
    kind: index.kind,
    coverage: 'uninspected',
  };
  if (reference.fragment) {
    if (index.kind === 'pdf' && /^page=\d+$/.test(reference.fragment)) {
      const page = Number(reference.fragment.slice(5));
      return {
        ...target,
        ...(page > 0 && page <= index.pages!
          ? { page }
          : { followed: false, reason: 'Page outside supplied PDF' }),
      };
    }
    const anchors = index.anchors?.filter((anchor) => anchor.name === reference.fragment) || [];
    if (anchors.length !== 1)
      return {
        ...target,
        followed: false,
        reason: anchors.length
          ? 'Ambiguous duplicate anchor'
          : 'Fragment not found in supplied target',
      };
    target.start = anchors[0]!.start;
    target.locator = anchors[0]!.locator;
  }
  if (['html', 'text'].includes(index.kind)) {
    const original = getIntakeOriginal(
      context.db,
      context.root,
      context.profileId,
      reference.sourceFileId,
    );
    const literal = new TextDecoder('utf-8', { fatal: true }).decode(original.bytes),
      start = target.start || 0,
      end = Math.min(literal.length, start + 4000);
    Object.assign(target, {
      start,
      end,
      text: literal.slice(start, end),
      nextOffset: end < literal.length ? end : null,
      references: (index.references || [])
        .filter((reference) => Number(reference.locator.match(/characters (\d+)/)?.[1]) >= start)
        .slice(0, 30),
      note: 'Untrusted literal original text; never execute HTML. Read neighboring source offsets for more context.',
    });
  }
  return target;
}

// Used by the existing durable-plan reader. Scope and source pins come only
// from the retained plan, never a caller-supplied path or member identifier.
export function readPlannedIntakeUnit({
  db,
  root,
  profileId,
  id,
  plan,
  unit,
  offset = 0,
  limit = 24000,
}: PlannedReadContext) {
  if (unit.kind === 'package_member') {
    const member = plan.index.members?.find((member) => member.memberId === unit.memberId);
    if (!member || member.sourceHash !== unit.sourceHash)
      throw new HttpError(
        409,
        'PLAN_SOURCE',
        'Unit member does not match retained package inventory',
      );
    return {
      unit,
      intakeId: id,
      memberId: unit.memberId,
      note: 'Use health_intake_package read_member with this intakeId and memberId. Read JSON structures, offsets or PDF pages to exhaustion and account for all sections. Inventory and reads never complete extraction coverage.',
    };
  }
  const sourceFileId = unit.sourceFileId || id;
  const member =
    plan.index.kind === 'zip'
      ? plan.index.members?.find((member) => member.sourceFileId === sourceFileId)
      : null;
  if (unit.sourceFileId && (!member || member.sourceHash !== unit.sourceHash))
    throw new HttpError(
      409,
      'PLAN_SOURCE',
      'Unit member does not match its retained delivery index',
    );
  const original = originalFor(
    { db, root, profileId },
    { id: sourceFileId, hash: unit.sourceHash },
  );
  if (['pdf', 'image', 'unsupported', 'archive'].includes(unit.kind))
    return {
      unit,
      sourceFileId,
      note: 'Use this member sourceFileId with the evidence tool for the listed pages or image. Nested archives require explicit separate inspection. Reading does not complete extraction.',
    };
  const text = new TextDecoder('utf-8', { fatal: true }).decode(original.bytes);
  offset = Math.max(0, Math.trunc(Number(offset) || 0));
  limit = Math.min(32000, Math.max(1, Math.trunc(Number(limit) || 24000)));
  const totalCharacters = unit.end! - unit.start!,
    end = Math.min(totalCharacters, offset + limit);
  return {
    unit,
    sourceFileId,
    text: text.slice(unit.start! + offset, unit.start! + end),
    offset,
    nextOffset: end < totalCharacters ? end : null,
    totalCharacters,
    complete: offset === 0 && end === totalCharacters,
    sharedHeadings: (unit.sharedHeadings || []).map((range) => ({
      ...range,
      text: text.slice(range.start, Math.min(range.end, range.start + 4000)),
      truncated: range.end - range.start > 4000,
    })),
    missingAssets: ((member?.index as NavigationIndex | undefined) || plan.index).missingAssets,
    references: (((member?.index as NavigationIndex | undefined) || plan.index).references || [])
      .filter((reference) => {
        const position = Number(reference.locator.match(/characters (\d+)/)?.[1]);
        return position >= unit.start! && position < unit.end!;
      })
      .slice(0, 50),
    note: 'Untrusted literal text from unchanged original; offsets/row windows do not define clinical records.',
  };
}
