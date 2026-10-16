import { randomUUID } from 'node:crypto';
import type {
  IntakeReportSourceMembersReference,
  IntakeReportSourceCoverageReference,
} from '../shared/intake-report-source-reference.ts';
import type {
  ReportSnapshotCatalog,
  ReportSnapshotMapReader,
} from './intake-report-snapshot-catalog.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import { canonicalLiteral } from './intake-format.ts';
export function* reportSourceSnapshotRows(
  map: ReportSnapshotMapReader,
  kind: 'members' | 'coverage',
) {
  const prefix = kind === 'members' ? 'm:' : 'e:';
  let after = prefix;
  do {
    const page = map.range({ after, items: 64, bytes: 128 * 1024 });
    for (const row of page.items) {
      if (!row.key.startsWith(prefix)) return;
      yield row;
    }
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Source snapshot did not advance');
    after = page.after;
  } while (true);
}
export function openReportSourceSnapshot(
  catalog: ReportSnapshotCatalog,
  reference: IntakeReportSourceMembersReference | IntakeReportSourceCoverageReference,
  operationId: string,
  groupVersionId: string,
  kind: 'members' | 'coverage',
) {
  const count =
    kind === 'members'
      ? (reference as IntakeReportSourceMembersReference).memberCount
      : (reference as IntakeReportSourceCoverageReference).entryCount;
  if (
    !reference ||
    reference.format !==
      (kind === 'members'
        ? 'health-intake-report-source-members-v1'
        : 'health-intake-report-source-coverage-v1') ||
    typeof reference.snapshotId !== 'string' ||
    !Number.isSafeInteger(count) ||
    count < 0
  )
    throw Error('Invalid selected source snapshot reference');
  const root = catalog.open(reference.snapshotId),
    raw = root?.get('meta');
  if (typeof raw !== 'string') throw Error('Missing selected source snapshot');
  const meta = JSON.parse(raw);
  if (
    meta.format !== 'health-intake-report-source-extension-snapshot-v1' ||
    meta.operationId !== operationId ||
    meta.groupVersionId !== groupVersionId ||
    meta[kind === 'members' ? 'memberCount' : 'coverageEntryCount'] !== count
  )
    throw Error('Source snapshot binding mismatch');
  const map = root!.reference(kind);
  if (!map) throw Error('Missing source snapshot scope');
  return { map, count };
}
export async function createReportSourceSnapshot(
  catalog: ReportSnapshotCatalog,
  operationId: string,
  groupVersionId: string,
) {
  const root = await catalog.fork(),
    members = await catalog.fork(),
    coverage = await catalog.fork(),
    snapshotId = 'source-scope:' + randomUUID();
  let memberCount = 0,
    entryCount = 0,
    finished = false;
  const check = () => {
    catalog.assertCurrent();
    if (finished) throw Error('Source scope is already published');
  };
  return {
    async member(value: { candidateId: string; candidateVersionId: string }) {
      check();
      await members.put('m:' + schemaOrdinal(memberCount++), canonicalLiteral(value));
    },
    async coverage(pieces: Iterable<string>) {
      check();
      await coverage.putText('e:' + schemaOrdinal(entryCount++), pieces);
    },
    async finish() {
      check();
      finished = true;
      await root.put(
        'meta',
        JSON.stringify({
          format: 'health-intake-report-source-extension-snapshot-v1',
          operationId,
          groupVersionId,
          memberCount,
          coverageEntryCount: entryCount,
        }),
      );
      await root.attach('members', members);
      await root.attach('coverage', coverage);
      await catalog.publish(snapshotId, root);
      return {
        members: {
          format: 'health-intake-report-source-members-v1' as const,
          snapshotId,
          memberCount,
        },
        coverageEntries: {
          format: 'health-intake-report-source-coverage-v1' as const,
          snapshotId,
          entryCount,
        },
      };
    },
  };
}
