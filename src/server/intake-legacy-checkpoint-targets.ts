/** Explicit cold routing for old global read checkpoints. Scratch indexes retain
 * exact active-plan precedence and the old coverage predicate; they do not mint
 * terminal coverage or assign an irreversible global hash to guessed units. */
import { setImmediate } from 'node:timers/promises';
import type { Database } from './database.ts';
import { assertIntakeOwner } from './intake.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { prepareRetainedPlanAccess, readRetainedPlanScope } from './intake-retained-plan.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';
import { readDirectPlanScope } from './intake-direct-plan.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { workflowHash } from './intake-workflow.ts';
import {
  conversionScopeKey,
  conversionWindowKey,
  conversionReadDescriptor,
  type ConversionCheckpoint,
  type ReadWindow,
} from './intake-continuation.ts';

interface Unit {
  unitKey: string;
  planAddress: string;
  planId: string;
  unitId: string;
  kind: string;
  textReadKey?: string;
}
interface StoredUnit extends Unit {
  sourceId: string;
  memberId: string | null;
  hasPages: number;
  unitEnd: number | null;
  seenUnit: number;
  ordinal: number;
}
function scalar<T>(
  reader: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined {
  const value = reader.field(record, name, { bytes: 8192 });
  if (value.kind === 'missing') return undefined;
  if (value.kind !== 'value') throw Error('Legacy checkpoint identity is not scalar');
  return value.value as T;
}
function* children(
  reader: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
) {
  let after: string | undefined;
  for (;;) {
    const page = reader.children(record, field, { after, items: 32, bytes: 32768 });
    yield* page.records;
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Legacy target cursor failed to advance');
    after = page.after;
  }
}
export async function prepareLegacyCheckpointTargets(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  checkpoint: Pick<ConversionCheckpoint, 'profileId' | 'intakeId' | 'sourceHash'> & {
    seen: Iterable<string>;
  },
  options: { assertRunning?: () => void } = {},
) {
  assertIntakeOwner(db, profileId);
  options.assertRunning?.();
  await prepareRetainedPlanAccess(db, profileId, intakeId, options);
  const reader = openIntakeCollectionEnvelope(db, { id: intakeId }),
    version = intakeSourceVersion(db, intakeId),
    source = db
      .prepare("SELECT sha256 FROM source_files WHERE id=? AND kind='intake_original'")
      .get(intakeId) as { sha256: string } | undefined;
  if (
    !source ||
    checkpoint.profileId !== profileId ||
    checkpoint.intakeId !== intakeId ||
    checkpoint.sourceHash !== source.sha256
  )
    throw Error('Legacy reading checkpoint source changed');
  const scratch = disposableSqlite('intake-legacy-targets-');
  let disposed = false;
  const assertCurrent = () => {
    if (disposed) throw Error('Legacy target preparation closed');
    options.assertRunning?.();
    assertIntakeOwner(db, profileId);
    const now = intakeSourceVersion(db, intakeId);
    if (now.version !== version.version || now.logicalBinding !== version.logicalBinding)
      throw Error('Legacy target selection changed');
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    scratch.close();
  };
  try {
    scratch.db.exec(
      `CREATE TABLE plans(id TEXT PRIMARY KEY);CREATE TABLE seen(key TEXT PRIMARY KEY);CREATE TABLE units(unitKey TEXT PRIMARY KEY,planAddress TEXT,planId TEXT,unitId TEXT,kind TEXT,sourceId TEXT,memberId TEXT,hasPages INTEGER,unitEnd REAL,textReadKey TEXT,seenUnit INTEGER,ordinal INTEGER,UNIQUE(planAddress,unitId));CREATE INDEX unit_member ON units(sourceId,memberId);CREATE INDEX unit_text ON units(sourceId,hasPages,kind,seenUnit,unitEnd);CREATE INDEX unit_id ON units(sourceId,unitId);CREATE TABLE pages(unitKey TEXT,page REAL,ordinal INTEGER,scopeKey TEXT,sourceId TEXT,PRIMARY KEY(unitKey,page));CREATE INDEX pages_source ON pages(sourceId,page,unitKey);CREATE INDEX units_ordinal ON units(ordinal);CREATE INDEX pages_ordinal ON pages(unitKey,ordinal);`,
    );
    const putSeen = scratch.db.prepare('INSERT OR IGNORE INTO seen VALUES(?)');
    let work = 0;
    const checkpointWork = async () => {
      assertCurrent();
      if (++work % 128 === 0) await setImmediate();
    };
    for (const key of checkpoint.seen) {
      putSeen.run(key);
      await checkpointWork();
    }
    let ordinal = 0;
    const add = async (
      planAddress: string,
      planId: string,
      unit: {
        id: string;
        kind: string;
        sourceId?: string;
        memberId?: string;
        hasPages: boolean;
        end?: number;
      },
      pages: Iterable<number>,
    ) => {
      const unitKey = workflowHash([planAddress, unit.id]),
        sourceId = unit.sourceId || intakeId,
        memberId = unit.memberId || null,
        textReadKey = ['text', 'html'].includes(unit.kind)
          ? conversionWindowKey(
              conversionReadDescriptor('health_intake_plan', {
                id: sourceId,
                action: 'read_unit',
                unitId: unit.id,
              }),
            )
          : undefined;
      const inserted = scratch.db
        .prepare('INSERT OR IGNORE INTO units VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          unitKey,
          planAddress,
          planId,
          unit.id,
          unit.kind,
          sourceId,
          memberId,
          Number(unit.hasPages),
          unit.end ?? null,
          textReadKey ?? null,
          Number(
            !!textReadKey &&
              !!scratch.db.prepare('SELECT 1 FROM seen WHERE key=?').get(textReadKey),
          ),
          ordinal,
        );
      if (!inserted.changes) return;
      ordinal++;
      let pageOrdinal = 0;
      for (const page of pages) {
        const result = scratch.db
          .prepare('INSERT OR IGNORE INTO pages VALUES(?,?,?,?,?)')
          .run(
            unitKey,
            page,
            pageOrdinal,
            conversionScopeKey([sourceId, memberId, page]),
            sourceId,
          );
        if (result.changes) pageOrdinal++;
        await checkpointWork();
      }
      await checkpointWork();
    };
    const intake = reader.child(reader.root(), 'intake'),
      flow = intake && reader.child(intake, 'workflow');
    if (flow)
      for (const plan of children(reader, flow, 'plans')) {
        assertCurrent();
        if (scalar(reader, plan, 'status') !== 'active') continue;
        const planId = scalar<string>(reader, plan, 'id');
        if (!planId) throw Error('Invalid active plan identity');
        if (!scratch.db.prepare('INSERT OR IGNORE INTO plans VALUES(?)').run(planId).changes)
          continue;
        const planAddress = reader.address(plan),
          format = scalar<string>(reader, plan, 'format');
        if (format === 'health-intake-package-plan-v2') {
          const scope = readPackagePlanScope(db, root, profileId, intakeId, { planId });
          if (!scope) throw Error('Selected package target plan is unavailable');
          for (let offset = 0; offset < scope.plan.unitCount; offset += 50)
            for (const member of scope.inventory.range({ offset, limit: 50 })) {
              const unit = scope.unit(member.memberId);
              if (!unit) throw Error('Selected package target unit is unavailable');
              await add(
                planAddress,
                planId,
                {
                  id: unit.id,
                  kind: unit.kind,
                  sourceId: unit.sourceFileId,
                  memberId: unit.memberId,
                  hasPages: !!unit.pages,
                  end: unit.end,
                },
                unit.pages ?? [],
              );
            }
        } else if (format === 'health-intake-direct-plan-v2') {
          const scope = readDirectPlanScope(db, profileId, intakeId, {
            recordAddress: planAddress,
          });
          if (!scope) throw Error('Selected direct target plan is unavailable');
          for (let n = 0; n < scope.unitCount; n++) {
            const unit = scope.unitAt(n);
            if (!unit) throw Error('Selected direct target unit is unavailable');
            await add(
              planAddress,
              planId,
              {
                id: unit.id,
                kind: unit.kind,
                sourceId: unit.sourceFileId,
                memberId: unit.memberId,
                hasPages: !!unit.pages,
                end: unit.end,
              },
              unit.pages ?? [],
            );
          }
        } else {
          const scope = readRetainedPlanScope(db, profileId, intakeId, {
            recordAddress: planAddress,
          });
          if (!scope) throw Error('Selected expanded target plan is unavailable');
          for (const record of children(scope.reader, scope.record, 'units')) {
            const id = scalar<string>(scope.reader, record, 'id');
            if (!id) throw Error('Invalid retained target unit');
            const unit = scope.unitById(id);
            if (!unit) throw Error('Missing retained target unit');
            if (scope.reader.address(unit.record) !== scope.reader.address(record)) continue;
            const pageField = scope.reader.field(record, 'pages', { bytes: 8 });
            function* pages() {
              for (let n = 0; n < unit!.pages.uniqueCount; n++) {
                const page = unit!.pages.uniquePageAt(n);
                if (page === undefined) throw Error('Missing retained target page');
                yield page;
              }
            }
            await add(
              planAddress,
              planId,
              {
                id,
                kind: unit.kind,
                sourceId: scalar(scope.reader, record, 'sourceFileId'),
                memberId: scalar(scope.reader, record, 'memberId'),
                hasPages:
                  pageField.kind !== 'missing' && !(pageField.kind === 'value' && !pageField.value),
                end: scalar(scope.reader, record, 'end'),
              },
              pages(),
            );
          }
        }
      }
    assertCurrent();
    const publicUnit = (unit: StoredUnit): Unit => ({
      unitKey: unit.unitKey,
      planAddress: unit.planAddress,
      planId: unit.planId,
      unitId: unit.unitId,
      kind: unit.kind,
      ...(unit.textReadKey ? { textReadKey: unit.textReadKey } : {}),
    });
    return {
      assertCurrent,
      dispose,
      *units(): Iterable<Unit> {
        assertCurrent();
        for (const row of scratch.db.prepare('SELECT * FROM units ORDER BY ordinal').iterate()) {
          assertCurrent();
          yield publicUnit(row as unknown as StoredUnit);
        }
      },
      *pages(): Iterable<{ unitKey: string; page: number; ordinal: number; scopeKey: string }> {
        assertCurrent();
        for (const row of scratch.db
          .prepare(
            'SELECT pages.unitKey,pages.page,pages.ordinal,pages.scopeKey FROM pages JOIN units USING(unitKey) ORDER BY units.ordinal,pages.ordinal',
          )
          .iterate()) {
          assertCurrent();
          yield row as unknown as {
            unitKey: string;
            page: number;
            ordinal: number;
            scopeKey: string;
          };
        }
      },
      *targets(window: ReadWindow): Iterable<{ unitKey: string; textReadUnit: boolean }> {
        assertCurrent();
        const args = window.args,
          sourceId = args.id;
        if (typeof sourceId !== 'string') return;
        const statements: [string, unknown[]][] = [
          [
            'SELECT * FROM units WHERE sourceId=? AND memberId=?',
            [sourceId, args.memberId ?? null],
          ],
          [
            'SELECT units.* FROM pages JOIN units USING(unitKey) WHERE pages.sourceId=? AND units.memberId IS NULL AND units.hasPages=1 AND pages.page=?',
            [sourceId, args.page || 1],
          ],
          [
            "SELECT * FROM units WHERE sourceId=? AND memberId IS NULL AND hasPages=0 AND kind IN ('text','html') AND seenUnit=0 AND (unitEnd IS NULL OR unitEnd>?)",
            [sourceId, args.offset || 0],
          ],
          [
            'SELECT * FROM units WHERE sourceId=? AND memberId IS NULL AND hasPages=0 AND unitId=?',
            [sourceId, args.unitId ?? null],
          ],
        ];
        for (let i = 0; i < statements.length; i++) {
          if (i === 0 && !args.memberId) continue;
          if (i === 2 && (args.unitId || args.page)) continue;
          if (i === 3 && !args.unitId) continue;
          const [sql, values] = statements[i]!;
          for (const raw of scratch.db.prepare(sql).iterate(...(values as never[]))) {
            assertCurrent();
            const unit = raw as unknown as StoredUnit;
            yield { unitKey: unit.unitKey, textReadUnit: i === 2 };
          }
        }
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
