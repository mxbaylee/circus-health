import {
  canonicalReviewValueChunks,
  registerReviewCanonicalValue,
} from './intake-review-question-state.ts';
const fields = new WeakMap<
  object,
  Map<string, { transport: string; chunks: () => Iterable<string> }>
>();
/** Presentation references never replace complete policy fields in legacy review hashes. */
export function registerReviewRecordField(
  record: object,
  field: string,
  transport: string,
  chunks: () => Iterable<string>,
) {
  let selected = fields.get(record);
  if (!selected) fields.set(record, (selected = new Map()));
  selected.set(field, { transport, chunks });
  registerReviewCanonicalValue(record, function* (options = {}) {
    const current = fields.get(record)!,
      hidden = new Set([...current.values()].map((value) => value.transport));
    yield '{';
    let first = true;
    for (const key of [
      ...new Set([...Object.keys(record).filter((key) => !hidden.has(key)), ...current.keys()]),
    ].sort()) {
      if (!first) yield ',';
      first = false;
      yield JSON.stringify(key) + ':';
      const override = options.fieldValue?.(record, key);
      if (override) {
        yield* canonicalReviewValueChunks(override.value, options);
        continue;
      }
      const selected = current.get(key);
      if (selected) yield* selected.chunks();
      else yield* canonicalReviewValueChunks((record as Record<string, unknown>)[key], options);
    }
    yield '}';
  });
}
