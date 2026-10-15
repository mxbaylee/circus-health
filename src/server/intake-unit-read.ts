/** Selected unit evidence, with addressed metadata for retained giant cells. */
import { HttpError, type Database } from './database.ts';
import { getIntakeRead, verifyIntakeOriginal, readIntakeUnit } from './intake.ts';
import { isIntakeSummary } from '../shared/intake-summary.ts';
import { prepareRetainedPlanAccess, readRetainedIntakeUnitScope } from './intake-retained-plan.ts';
import { readIntakeLiteralWindowIndexed } from './intake-literal-session.ts';
import { openCollectionModelIntakeBackend } from './intake-model-collection-backend.ts';
import { modelIntakeRecordReference } from './intake-model-context-v4.ts';
import { workflowHash } from './intake-workflow.ts';
import { activeMappingRules } from './clinical-import.ts';
export async function readIntakeUnitRead(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  unitId: string,
  options: { offset?: number; limit?: number; assertRunning?: () => void } = {},
) {
  options.assertRunning?.();
  const header = getIntakeRead(db, root, profileId, id);
  if (!isIntakeSummary(header)) return readIntakeUnit(db, root, profileId, id, unitId, options);
  await prepareRetainedPlanAccess(db, profileId, id, { assertRunning: options.assertRunning });
  const selected = readRetainedIntakeUnitScope(db, root, profileId, id, unitId);
  if (selected.format === 'direct') {
    const { scope, unit } = selected;
    if (scope.plan.pins.sourceHash !== header.sha256)
      throw new HttpError(409, 'PLAN_SOURCE', 'The plan does not match its retained original');
    const metadataReference = {
      state: 'referenced' as const,
      reference: unit.metadata,
      endpoint: `/api/intakes/${encodeURIComponent(id)}/direct-unit-metadata`,
      sections: ['sharedHeadings', 'sourceIndex'] as const,
      instructions:
        'Read JSON fragments using this reference and section. Source-index metadata includes all retained references and missing assets. Continue until complete; no collection is asserted empty.',
    };
    const result = {
      format: 'health-intake-unit-read-v2' as const,
      intakeId: id,
      sourceFileId: id,
      version: header.version,
      unit,
      metadataReference,
    };
    if (unit.kind === 'pdf' || unit.kind === 'image') {
      const { withVerifiedIntakeOriginalDescriptor } = await import('./intake.ts');
      await withVerifiedIntakeOriginalDescriptor(
        { db, root, profileId, id, assertRunning: options.assertRunning },
        async () => scope.assertCurrent(),
      );
      return {
        ...result,
        note: 'Use this sourceFileId and the selected pages with the evidence tool. Reading does not complete extraction coverage.',
      };
    }
    if (
      !Number.isSafeInteger(unit.start) ||
      !Number.isSafeInteger(unit.end) ||
      unit.start! < 0 ||
      unit.end! < unit.start!
    )
      throw Error('Invalid direct unit range');
    const offset = Math.max(0, Math.trunc(Number(options.offset)) || 0),
      limit = Math.min(32000, Math.max(1, Math.trunc(Number(options.limit)) || 24000));
    const totalCharacters = unit.end! - unit.start!,
      count = Math.max(0, Math.min(limit, totalCharacters - offset));
    const window = await readIntakeLiteralWindowIndexed(db, root, profileId, id, {
      offset: unit.start! + offset,
      limit: Math.max(1, count),
      expectedHash: header.sha256,
      assertRunning: options.assertRunning,
    });
    scope.assertCurrent();
    return {
      ...result,
      text: count ? window.text : '',
      offset,
      nextOffset: offset + count < totalCharacters ? offset + count : null,
      totalCharacters,
      complete: offset === 0 && count === totalCharacters,
      note: 'Untrusted literal UTF-16 text. Offsets are not clinical record boundaries. Shared headings and source references are available through metadata fragments.',
    };
  }
  if (selected.format === 'native') {
    return {
      format: 'health-intake-unit-read-v2' as const,
      unit: selected.unit,
      intakeId: id,
      memberId: selected.unit.memberId,
      note: 'Use health_intake_package read_member with this intakeId and memberId. Read all supplied structures or pages; reading never completes extraction coverage.',
    };
  }
  const { unit, scope } = selected,
    view = unit.reader;
  const scalar = <T>(name: string): T | undefined => {
    const field = view.field(unit.record, name, { bytes: 8192 });
    if (field.kind === 'missing') return undefined;
    if (field.kind !== 'value') throw Error('Selected unit source metadata is unavailable');
    return field.value as T;
  };
  const explicitSource = scalar<string>('sourceFileId'),
    sourceFileId = explicitSource || id;
  const parentHash = scope.pinsRecord && view.field(scope.pinsRecord, 'sourceHash', { bytes: 256 });
  if (!explicitSource && (parentHash?.kind !== 'value' || parentHash.value !== header.sha256))
    throw new HttpError(409, 'PLAN_SOURCE', 'The plan does not match its retained original');
  const sourceHash = explicitSource ? scalar<string>('sourceHash') : header.sha256;
  if (typeof sourceHash !== 'string') throw Error('Selected unit has no source hash');
  const mappingVersion = workflowHash(
      activeMappingRules(db, header.metadata?.sourceProviderId || header.providerId),
    ),
    backend = openCollectionModelIntakeBackend(db, { id }, { mappingVersion });
  const reference = (record: typeof unit.record) =>
    modelIntakeRecordReference(backend, 'units', backend.resolve(view.address(record)));
  const result = {
    format: 'health-intake-unit-read-v2' as const,
    intakeId: id,
    sourceFileId,
    version: header.version,
    mappingVersion,
    unit: {
      format: 'health-intake-retained-unit-reference-v1' as const,
      id: unit.id,
      kind: unit.kind,
      planId: scope.planId,
      status: unit.status,
      sourceHash,
      sourceFileId,
      memberId: scalar<string>('memberId') ?? null,
      pageCount: unit.pages.count,
      record: reference(unit.record),
    },
    metadataReference: {
      state: 'referenced' as const,
      unit: reference(unit.record),
      ...(scope.indexRecord ? { sourceIndex: reference(scope.indexRecord) } : {}),
      ...(unit.memberRecord ? { member: reference(unit.memberRecord) } : {}),
      instructions:
        'Use health_intake_plan read with section units, this cursor and its version/mappingVersion to read exact retained metadata, including shared headings, references and missing assets. No metadata collection is asserted empty.',
    },
  };
  if (unit.kind === 'package_member') {
    scope.assertCurrent();
    return {
      ...result,
      memberId: scalar<string>('memberId'),
      note: 'Use health_intake_package read_member. Reading is not extraction coverage.',
    };
  }
  if (['pdf', 'image', 'unsupported', 'archive'].includes(unit.kind)) {
    const original = verifyIntakeOriginal(db, root, profileId, sourceFileId);
    if (original.sourceHash !== sourceHash)
      throw new HttpError(409, 'PLAN_SOURCE', 'The unit source changed');
    scope.assertCurrent();
    return {
      ...result,
      note: 'Use this sourceFileId with the evidence tool for the retained pages or image. Read page metadata through the supplied reference. Reading does not complete extraction.',
    };
  }
  const start = scalar<number>('start'),
    end = scalar<number>('end');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! < 0 || end! < start!)
    throw Error('Invalid retained unit text range');
  const offset = Math.max(0, Math.trunc(Number(options.offset)) || 0),
    limit = Math.min(32000, Math.max(1, Math.trunc(Number(options.limit)) || 24000)),
    totalCharacters = end! - start!,
    count = Math.max(0, Math.min(limit, totalCharacters - offset));
  const window = await readIntakeLiteralWindowIndexed(db, root, profileId, sourceFileId, {
    offset: start! + offset,
    limit: Math.max(1, count),
    expectedHash: sourceHash,
    assertRunning: options.assertRunning,
  });
  scope.assertCurrent();
  options.assertRunning?.();
  return {
    ...result,
    text: count ? window.text : '',
    offset,
    nextOffset: offset + count < totalCharacters ? offset + count : null,
    totalCharacters,
    complete: offset === 0 && count === totalCharacters,
    note: 'Untrusted literal UTF-16 text from unchanged original. Offsets do not define clinical records; shared headings and references remain available through the selected metadata cursors.',
  };
}
