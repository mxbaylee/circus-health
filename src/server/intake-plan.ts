import { configuredModelIdentity } from './model-bridge.ts';
import { readFileSync } from 'node:fs';
import { workflowHash } from './intake-workflow.ts';
import { activeMappingRules } from './clinical-import.ts';
import { HttpError } from './database.ts';
import { INTAKE_SCHEMA_INSTRUCTIONS } from './intake-format.ts';
import type { DatabaseSync } from 'node:sqlite';
import type {
  IntakeExtractionUnit,
  IntakeMetadata,
  IntakePackageMember,
} from '../shared/intake.ts';

interface SourceFileRow {
  id: string;
  sha256: string;
  provider_id: string;
  details_json: string;
}

export interface EvidenceRow {
  id: string;
  start: number;
  end: number;
  header?: boolean;
}

export interface EvidenceSection {
  id: string;
  locator: string;
  start?: number;
  end?: number;
  page?: number;
  rows?: EvidenceRow[];
  sharedHeadings?: { start: number; end: number }[];
}

export interface IndexedPackageMember extends IntakePackageMember {
  sourceFileId?: string;
  index: EvidenceIndex;
}

export interface EvidenceIndex {
  kind: string;
  coverage?: string;
  inventoryVersion?: 1;
  members?: IndexedPackageMember[];
  totalMembers?: number;
  totalExpandedBytes?: number;
  uniqueByteContents?: number;
  unsupportedMembers?: { locator: string; filename: string; reason: string }[];
  pages?: number;
  characters?: number;
  sections?: EvidenceSection[];
  note?: string;
  references?: {
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
  }[];
  anchors?: { name: string; start: number; end: number; locator: string }[];
  missingAssets?: {
    id?: string;
    asset?: boolean;
    source: string;
    locator: string;
    status: string;
    note?: string;
    sourceFileId?: string;
    contentUrl?: string;
  }[];
}

export interface PlannedExtractionUnit extends IntakeExtractionUnit {
  note?: string;
  rows?: string[];
  sharedHeadings?: { start: number; end: number }[];
}

interface ExtractionUnitInput {
  unitSize?: number;
  overlap?: number;
}

export function extractionPins(db: DatabaseSync, file: SourceFileRow, _env = process.env) {
  const reviewedMetadata =
    (JSON.parse(file.details_json || '{}') as { intake?: { metadata?: IntakeMetadata } }).intake
      ?.metadata || null;
  const profileId = db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get() as
    { value?: string } | undefined;
  const { backend, model, reasoningEffort, connectionIdentity } = configuredModelIdentity(
    profileId?.value,
  ) as ReturnType<typeof configuredModelIdentity> & { connectionIdentity?: string };
  return {
    sourceHash: file.sha256,
    backend,
    model,
    reasoningEffort,
    ...(connectionIdentity ? { connectionIdentity } : {}),
    instructionVersion: workflowHash(
      INTAKE_SCHEMA_INSTRUCTIONS +
        readFileSync(new URL('./assistant-instructions.md', import.meta.url), 'utf8'),
    ),
    mappingVersion: workflowHash(
      activeMappingRules(db, reviewedMetadata?.sourceProviderId || file.provider_id),
    ),
    ...(reviewedMetadata ? { reviewedMetadataVersion: workflowHash(reviewedMetadata) } : {}),
  };
}
export function extractionUnits(
  index: EvidenceIndex,
  input: ExtractionUnitInput = {},
): PlannedExtractionUnit[] {
  const units: PlannedExtractionUnit[] = [],
    count = Number(input.unitSize ?? (index.kind === 'pdf' ? 2 : 25));
  const overlap = Number(input.overlap ?? (index.kind === 'pdf' ? 0 : Math.min(1, count - 1)));
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 50 ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0 ||
    overlap >= count
  )
    throw new HttpError(
      400,
      'PLAN_INPUT',
      'Choose a unit size of 1–50 and smaller nonnegative context overlap',
    );
  const push = (value: Omit<PlannedExtractionUnit, 'id' | 'status' | 'attempts'>): void => {
    units.push({ id: 'unit:' + workflowHash(value), ...value, status: 'pending', attempts: [] });
  };
  if (index.kind === 'zip') {
    for (const member of index.members || []) {
      if (index.inventoryVersion === 1) {
        push({
          kind: 'package_member',
          memberId: member.memberId,
          sourceHash: member.sourceHash,
          filename: member.filename,
          locator: member.locator,
          bytes: member.bytes,
          duplicateOf: member.duplicateOf,
          note: 'Inventory only. Read and account for this occurrence; filenames and byte reuse never establish clinical record identity.',
        });
        continue;
      }
      const memberUnits: PlannedExtractionUnit[] = ['zip', 'image', 'unsupported'].includes(
        member.index.kind,
      )
        ? [
            {
              kind:
                member.index.kind === 'zip'
                  ? 'archive'
                  : (member.index.kind as 'image' | 'unsupported'),
              locator: member.locator,
              status: 'pending',
              attempts: [],
              note:
                member.index.note ||
                'Read this supplied member explicitly; no automatic nested extraction.',
            } as unknown as PlannedExtractionUnit,
          ]
        : extractionUnits(member.index, input);
      for (const unit of memberUnits) {
        const { id: _id, status: _status, attempts: _attempts, ...value } = unit;
        push({
          ...value,
          sourceFileId: member.sourceFileId,
          sourceHash: member.sourceHash,
          filename: member.filename,
          locator: `${member.locator}; ${unit.locator}`,
        });
      }
    }
    for (const member of index.unsupportedMembers || [])
      push({
        kind: 'unsupported',
        locator: member.locator,
        filename: member.filename,
        note: member.reason,
      });
  } else if (index.kind === 'pdf') {
    for (let start = 1; start <= index.pages!;) {
      const end = Math.min(index.pages!, start + count - 1);
      push({
        kind: 'pdf',
        locator: `pages ${start}–${end}`,
        pages: Array.from({ length: end - start + 1 }, (_, i) => start + i),
      });
      if (end === index.pages) break;
      start = end + 1 - overlap;
    }
  } else if (index.kind === 'image') {
    push({
      kind: 'image',
      locator: 'whole retained image',
      note: 'One host-indexed image occurrence. Read the visual original before recording an explicit disposition.',
    });
  } else if (['html', 'text'].includes(index.kind)) {
    for (const section of index.sections || []) {
      if (section.rows?.length) {
        for (let start = 0; start < section.rows.length;) {
          const rows = section.rows.slice(start, start + count),
            end = start + rows.length;
          push({
            kind: 'html',
            locator: `${section.locator}, rows ${start + 1}–${end}`,
            start: rows[0]!.start,
            end: rows.at(-1)!.end,
            rows: rows.map((r) => r.id),
            sharedHeadings: [
              ...(section.sharedHeadings || []),
              ...section.rows.filter((r) => r.header).map(({ start, end }) => ({ start, end })),
            ],
          });
          if (end === section.rows.length) break;
          start = end - overlap;
        }
      } else {
        for (let start = section.start!; start < section.end!;) {
          const end = Math.min(section.end!, start + 12000);
          push({
            kind: index.kind as 'html' | 'text',
            locator: `characters ${start}–${end}`,
            start,
            end,
            ...(section.sharedHeadings?.length ? { sharedHeadings: section.sharedHeadings } : {}),
          });
          if (end === section.end) break;
          start = end - 2000;
        }
      }
    }
  } else
    throw new HttpError(
      415,
      'PLAN_UNSUPPORTED',
      'This format has no resumable text/page index yet. Originals remain available.',
    );
  return units;
}
