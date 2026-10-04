import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { IntakeFilename, IntakeSummaryPins } from '../shared/intake-summary.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import { isRetainOnlyIntake } from '../shared/intake-source-policy.ts';

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
    let preview = '',
      suffix = '',
      units = 0,
      bytes = 0;
    const pieces = function* () {
      for (const piece of view.fieldChunks(intake, 'originalName')) {
        bytes += Buffer.byteLength(piece);
        yield piece;
      }
    };
    const scalar = hashIntakeJsonScalar(pieces(), [], (unit) => {
      if (units++ < 120) preview += unit;
      suffix = (suffix + unit).slice(-64);
    });
    if (scalar.kind !== 'string' || bytes !== selected.bytes)
      throw new HttpError(
        409,
        'INTAKE_SUMMARY_UNAVAILABLE',
        'The selected original filename is invalid.',
      );
    const retainOnly = isRetainOnlyIntake({ filename: suffix, mimeType });
    const packageSource = /zip/i.test(mimeType) || /\.zip$/i.test(suffix);
    if (units <= 120) result = { filename: preview, retainOnly, packageSource };
    else {
      if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
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
          scalarHash: scalar.hash,
          bytes,
        },
      };
    }
  }
  cache.set(key, result);
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
  return result;
}
