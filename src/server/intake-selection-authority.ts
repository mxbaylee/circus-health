import { finishClinicalReviewWork } from './clinical-review-work.ts';
import { copyOwnershipHoldMessage } from './ownership-identity-values.ts';
import { createHash } from 'node:crypto';
import {
  canonicalReviewValueChunks,
  hasReviewCanonicalValue,
  type ReviewCanonicalOptions,
} from './intake-review-question-state.ts';
import { canonicalLiteral } from './intake-format.ts';
import { isSelectedReportGroups } from './intake-selected-report-groups.ts';
import { canonicalSelectionChunks } from './intake-selection-canonical.ts';

const ephemeral = new Set([
  'selectionReviewToken',
  'comparisonPage',
  'comparisonDrafts',
  'draftScopeStatus',
]);
const pairPins = new Set(['requestRevision', 'intakeVersion', 'token']);

/** Structured values need no serialize/parse round trip. Opaque retained
 * providers still use the complete checked stream, including excluded fields. */
function* selectedValueChunks(
  value: unknown,
  options: ReviewCanonicalOptions,
  depth = 0,
  emit = true,
): Generator<string> {
  if (depth > 128) throw Error('Canonical selected evidence exceeds retained depth');
  // Preserve the legacy parser's terminal-depth handling of array holes and
  // string format discriminators as well as opaque retained values.
  if (depth === 128 || hasReviewCanonicalValue(value)) {
    for (const chunk of canonicalSelectionChunks(canonicalReviewValueChunks(value, options), depth))
      yield emit ? chunk : '';
    return;
  }
  const text = function* (literal: string): Generator<string> {
    for (let at = 0; at < literal.length;) {
      let end = Math.min(at + 8192, literal.length);
      if (end < literal.length && /[\uD800-\uDBFF]/.test(literal[end - 1]!)) end--;
      yield emit ? literal.slice(at, end) : '';
      at = end;
    }
  };
  if (JSON.isRawJSON(value) || !value || typeof value !== 'object') {
    yield* text(canonicalLiteral(value) ?? 'undefined');
    return;
  }
  if (Array.isArray(value)) {
    yield emit ? '[' : '';
    for (let n = 0; n < value.length; n++) {
      if (n) yield emit ? ',' : '';
      if (value[n] !== undefined) yield* selectedValueChunks(value[n], options, depth + 1, emit);
    }
    yield emit ? ']' : '';
    return;
  }
  yield emit ? '{' : '';
  let first = true,
    pair = false;
  for (const key of Object.keys(value).sort()) {
    const include: boolean = emit && !ephemeral.has(key) && !(pair && pairPins.has(key));
    if (include) {
      if (!first) yield ',';
      first = false;
      yield* text(JSON.stringify(key));
      yield ':';
    }
    const override = options.fieldValue?.(value, key);
    const child = override ? override.value : (value as Record<string, unknown>)[key];
    if (key === 'format') {
      let literal: string | undefined = '';
      for (const chunk of selectedValueChunks(child, options, depth + 1, include)) {
        if (literal !== undefined)
          literal = literal.length + chunk.length <= 512 ? literal + chunk : undefined;
        yield chunk;
      }
      pair =
        literal !== undefined &&
        literal.startsWith('"') &&
        JSON.parse(literal) === 'intake-pair-scope-v2';
    } else yield* selectedValueChunks(child, options, depth + 1, include);
  }
  yield emit ? '}' : '';
}

/** Only v2 pair transport pins may advance without another human review. */
export function durableSelectionInputs(value: unknown): unknown {
  if (isSelectedReportGroups(value)) return value;
  if (Array.isArray(value)) return value.map(durableSelectionInputs);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const transport = object.format === 'intake-pair-scope-v2';
  const result = Object.fromEntries(
    Object.entries(object)
      .filter(
        ([key]) =>
          ![
            'selectionReviewToken',
            'comparisonPage',
            'comparisonDrafts',
            'draftScopeStatus',
          ].includes(key) &&
          !(transport && ['requestRevision', 'intakeVersion', 'token'].includes(key)),
      )
      .map(([key, item]) => [key, durableSelectionInputs(item)]),
  );
  copyOwnershipHoldMessage(object, result);
  return result;
}
export const selectionAuthority = (
  value: unknown,
  options: { recordComparisonsUndefined?: boolean } = {},
): string => finishClinicalReviewWork(selectionAuthorityWork(value, options));
export function* selectionAuthorityWork(
  value: unknown,
  options: { recordComparisonsUndefined?: boolean } = {},
): Generator<void, string, void> {
  const hash = createHash('sha256');
  const record =
    value && typeof value === 'object' ? (value as { record?: unknown }).record : undefined;
  const chunks = selectedValueChunks(
    value,
    options.recordComparisonsUndefined
      ? {
          fieldValue: (object, key) =>
            object === record && key === 'comparisons' ? { value: undefined } : undefined,
        }
      : {},
  );
  for (const chunk of chunks) {
    hash.update(chunk);
    yield;
  }
  return hash.digest('hex');
}
