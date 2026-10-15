import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  intakeEnvelopeFilenameCell,
  hasIntakeCollectionEnvelope,
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  intakeEnvelopeMissingScalarFactsSteps,
} from './intake-collection-envelope.ts';
import type { IntakeFilename, IntakeSummaryPins } from '../shared/intake-summary.ts';
import { parseIntakeFilenameFacts } from './intake-filename-facts.ts';
import { isRetainOnlyIntake } from '../shared/intake-source-policy.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  assertClinicalOperation,
  currentClinicalOperation,
  runExclusiveClinicalOperation,
} from './clinical-operation.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { intakeEnvelopeProjectionFormatHint, INTAKE_ENVELOPE_FORMAT } from './intake-authority.ts';
import { prepareIntakeCompactMetadata } from './intake-compact-metadata.ts';
import { setImmediate } from 'node:timers/promises';

/** One cooperative compatibility preparation; all later reads remain point reads.
 * The selected map is shared, and only its bounded derivative entry is added. */
export async function prepareIntakeFilenameSummary(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { assertRunning?: () => void; assertPublicationCurrent?: () => void } = {},
): Promise<{ changed: boolean }> {
  options.assertRunning?.();
  const compact = await prepareIntakeCompactMetadata(db, source, options);
  if (intakeFilenameSummaryPrepared(db, source)) return compact;
  return runExclusiveClinicalOperation(
    db,
    async (operation) => {
      const assertRunning = () => {
        assertClinicalOperation(db, operation);
        options.assertRunning?.();
      };
      assertRunning();
      if (!hasIntakeCollectionEnvelope(db, source)) return { changed: false };
      const view = openIntakeCollectionEnvelope(db, source);
      const intake = view.child(view.root(), 'intake');
      if (!intake) throw Error('The selected filename header is missing');
      const { collections, source: expectedSource } = selectedEnvelopeStore(db, source);
      const logical = JSON.stringify(view.logical);
      const assertCurrent = () => {
        assertRunning();
        const current = selectedEnvelopeStore(db, source);
        if (
          JSON.stringify(collections.binding(collections.openView())?.logical) !== logical ||
          current.source.sha256 !== expectedSource.sha256 ||
          current.source.details_json !== expectedSource.details_json
        )
          throw Error('The selected filename authority changed during preparation');
      };
      const build = 'filename.facts.' + randomUUID();
      const prepare = (changes: Parameters<typeof collections.prepare>[1]['changes']) => {
        assertCurrent();
        const operationId = randomUUID();
        return collections.prepare(collections.openView(), {
          operationId,
          requestDigest: createHash('sha256').update(operationId).digest('hex'),
          domainVersion: view.logical.domainVersion,
          changes,
        });
      };
      collections.commitMaintenance(
        prepare([
          {
            area: 'builds',
            collection: build,
            op: 'adoptCollection',
            fromArea: 'logical',
            fromCollection: 'envelope.data',
          },
        ]),
      );
      const { createEnvelopeBuildWriter } = await import('./intake-envelope-build.ts');
      assertCurrent();
      const writer = createEnvelopeBuildWriter(db, source, build, view.logical.domainVersion, {
        assertRunning: assertCurrent,
      });
      const cells = intakeEnvelopeMissingScalarFactsSteps(db, source);
      try {
        for (;;) {
          assertCurrent();
          const next = cells.next();
          assertCurrent();
          if (next.done) break;
          if (next.value !== undefined) await writer.filenameFacts(next.value);
          else await setImmediate();
        }
      } finally {
        cells.return(undefined);
      }
      await writer.flush();
      const prepared = prepare([
        {
          area: 'logical',
          collection: 'envelope.data',
          op: 'adoptCollection',
          fromArea: 'builds',
          fromCollection: build,
        },
      ]);
      try {
        await collections.certifySchemaAdoptionAsync(prepared, { assertRunning: assertCurrent });
        assertCurrent();
        collections.commitMaintenance(prepared, { assertCurrent });
      } finally {
        collections.disposePreparation(prepared);
      }
      assertRunning();
      return { changed: true };
    },
    { operation: currentClinicalOperation(db), assertRunning: options.assertRunning },
  );
}

export function intakeFilenameSummaryPrepared(db: Database, source: IntakeEnvelopeSource): boolean {
  if (!hasIntakeCollectionEnvelope(db, source)) return true;
  const actual = db
    .prepare('SELECT details_json FROM main.source_files WHERE id=?')
    .get(source.id)?.details_json;
  const oldLarge =
    typeof actual === 'string' &&
    actual.length > 16384 &&
    intakeEnvelopeProjectionFormatHint(actual) === INTAKE_ENVELOPE_FORMAT;
  const view = openIntakeCollectionEnvelope(db, source);
  const intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('The selected filename header is missing');
  for (const field of ['originalName', 'locator'] as const) {
    const selected = view.field(intake, field, { bytes: 16384 });
    if (selected.kind !== 'fragmented' || !selected.bytes) continue;
    const cell = intakeEnvelopeFilenameCell(view, intake, field);
    if (cell.facts === undefined) {
      const fragment = view.fieldFragment(intake, field, { bytes: 4096 });
      if (!fragment.text.trimStart().startsWith('"')) continue;
      return false;
    }
    if (oldLarge) return false;
    const facts = parseIntakeFilenameFacts(cell.facts);
    if (facts.binding !== cell.binding || facts.bytes !== cell.bytes)
      throw Error('The prepared metadata scalar is stale');
  }
  return true;
}

function checkedFilenameFacts(view: IntakeCollectionEnvelopeReader, intake: IntakeEnvelopeRecord) {
  const cell = intakeEnvelopeFilenameCell(view, intake);
  if (cell.facts === undefined)
    throw new HttpError(409, 'INTAKE_SUMMARY_UNAVAILABLE', 'Prepare the selected filename first.');
  const facts = parseIntakeFilenameFacts(cell.facts);
  if (facts.binding !== cell.binding || facts.bytes !== cell.bytes)
    throw new HttpError(409, 'INTAKE_SUMMARY_UNAVAILABLE', 'The prepared filename is stale.');
  return facts;
}

const caches = new WeakMap<Database, Map<string, IntakeFilename>>();
/** The cache holds only a short preview, suffix classification and root pins. */
export function summaryFilename(
  db: Database,
  input: {
    view: IntakeCollectionEnvelopeReader;
    intake: IntakeEnvelopeRecord;
    pins: IntakeSummaryPins;
    id: string;
    mimeType: string;
  },
): IntakeFilename {
  const { view, intake, pins, id, mimeType } = input;
  const key = JSON.stringify([id, pins, mimeType]);
  const cache = caches.get(db) ?? new Map<string, IntakeFilename>();
  caches.set(db, cache);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const selected = view.field(intake, 'originalName', { bytes: 16384 });
  let result: IntakeFilename;
  if (selected.kind === 'value' && typeof selected.value === 'string') {
    result = {
      filename: selected.value,
      retainOnly: isRetainOnlyIntake({ filename: selected.value, mimeType }),
      packageSource: /zip/i.test(mimeType) || /\.zip$/i.test(selected.value),
    };
  } else {
    if (selected.kind !== 'fragmented' || !selected.bytes)
      throw new HttpError(
        409,
        'INTAKE_SUMMARY_UNAVAILABLE',
        'The selected original filename is unavailable.',
      );
    const facts = checkedFilenameFacts(view, intake);
    const { preview, suffix, bytes } = facts;
    const retainOnly = isRetainOnlyIntake({ filename: suffix, mimeType });
    const packageSource = /zip/i.test(mimeType) || /\.zip$/i.test(suffix);
    if (!facts.truncated) result = { filename: preview, retainOnly, packageSource };
    else {
      result = {
        filenamePreview: preview,
        filenameTruncated: true,
        retainOnly,
        packageSource,
        filenameReference: {
          format: 'health-intake-filename-reference-v1',
          intakeId: id,
          field: 'originalName',
          pins: { ...pins },
          scalarHash: facts.scalarHash,
          bytes,
        },
      };
    }
  }
  if (result.filenameReference) {
    Object.freeze(result.filenameReference.pins);
    Object.freeze(result.filenameReference);
  }
  Object.freeze(result);
  cache.set(key, result);
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
  return result;
}
