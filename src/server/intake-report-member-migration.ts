/** One explicit streaming conversion of retained v1 report members to shared snapshots. */
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  prepareIntakeJsonCanonical,
  type PreparedIntakeJsonCanonical,
  type IntakeJsonCanonicalHandle,
} from './intake-json-canonical.ts';
import {
  createReportMemberSnapshot,
  reportMemberSnapshotReader,
} from './intake-report-member-state.ts';
import type { ReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
function smallValue(
  parsed: PreparedIntakeJsonCanonical,
  record: IntakeJsonCanonicalHandle,
  name: string,
): unknown {
  const child = parsed.field(record, name);
  if (!child) return undefined;
  let text = '';
  for (const part of parsed.pieces(child)) {
    if (Buffer.byteLength(text) + Buffer.byteLength(part) > 8192)
      throw Error('Retained report identity exceeds supported header grammar');
    text += part;
  }
  return JSON.parse(text) as unknown;
}
export async function migrateReportMemberSnapshot(
  catalog: ReportSnapshotCatalog,
  view: IntakeCollectionEnvelopeReader,
  version: IntakeEnvelopeRecord,
  snapshotId: string,
  options: Pick<NonNullable<Parameters<typeof prepareIntakeJsonCanonical>[1]>, 'onWork'> = {},
): Promise<IntakeReportMembersReference> {
  const existing = catalog.open(snapshotId);
  if (existing) return reportMemberSnapshotReader(existing, snapshotId).reference;
  const writer = await createReportMemberSnapshot(catalog, snapshotId);
  let after: string | undefined;
  do {
    catalog.assertCurrent();
    const page = view.children(version, 'members', { after, items: 32, bytes: 32768 });
    for (const member of page.records) {
      catalog.assertCurrent();
      const parsed = await prepareIntakeJsonCanonical(view.recordChunks(member), {
        assertRunning: catalog.assertCurrent,
        onWork: options.onWork,
      });
      try {
        if (parsed.kind(parsed.root) !== 'object')
          throw Error('Retained report member is not an object');
        const candidateId = smallValue(parsed, parsed.root, 'candidateId'),
          candidateVersionId = smallValue(parsed, parsed.root, 'candidateVersionId');
        if (typeof candidateId !== 'string' || typeof candidateVersionId !== 'string')
          throw Error('Retained report member identity is invalid');
        const split = parsed.splitObjectField(parsed.root, 'occurrences');
        if (!split || parsed.kind(split.value) !== 'array')
          throw Error('Retained report member occurrences are missing');
        const section = parsed.field(parsed.root, 'section');
        let sectionTruthy = !!section;
        if (section) {
          const kind = parsed.kind(section);
          if (kind === 'null') sectionTruthy = false;
          else if (kind === 'boolean' || kind === 'number') {
            const raw = [...parsed.pieces(section)].join('');
            sectionTruthy = !!JSON.parse(raw);
          } else if (kind === 'string') {
            let prefix = '';
            for (const chunk of parsed.pieces(section)) {
              prefix += chunk.slice(0, 2 - prefix.length);
              if (prefix.length === 2) break;
            }
            sectionTruthy = prefix !== '""';
          }
        }
        let selected = await writer.include(
          {
            candidateId,
            candidateVersionId,
            ...(parsed.field(parsed.root, 'section') ? { section: null } : {}),
          },
          {
            retainDuplicate: true,
            canonicalPrefix: split.before(),
            canonicalSuffix: split.after(),
            canonicalSection: section && sectionTruthy ? parsed.pieces(section) : ['null'],
          },
        );
        for (const occurrence of parsed.arrayItems(split.value)) {
          if (parsed.kind(occurrence) !== 'object')
            throw Error('Retained report occurrence is not an object');
          const locator = parsed.field(occurrence, 'locator'),
            leading = [
              smallValue(parsed, occurrence, 'proposalId'),
              smallValue(parsed, occurrence, 'recordId'),
              smallValue(parsed, occurrence, 'batchId'),
            ].map((value) => {
              if (value === undefined || value === null) return null;
              if (typeof value !== 'string') throw Error('Invalid retained occurrence identity');
              return value;
            });
          const sourceIdentity = hashIntakeJsonScalar(
            locator ? parsed.pieces(locator) : ['null'],
            leading,
          ).hash;
          selected = await writer.appendCanonicalOccurrence(
            selected,
            parsed.pieces(occurrence),
            sourceIdentity,
            { proposalId: leading[0]!, recordId: leading[1]! },
          );
        }
      } finally {
        parsed.close();
      }
    }
    if (page.complete) break;
    if (!page.after || page.after === after)
      throw Error('Legacy report member page did not advance');
    after = page.after;
  } while (true);
  return writer.finish();
}
