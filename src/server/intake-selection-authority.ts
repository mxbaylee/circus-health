import { copyOwnershipHoldMessage } from './ownership-identity-values.ts';
import { createHash } from 'node:crypto';
import { canonicalReviewValueChunks } from './intake-review-question-state.ts';
import { isSelectedReportGroups } from './intake-selected-report-groups.ts';
import { canonicalSelectionChunks } from './intake-selection-canonical.ts';

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
): string => {
  const hash = createHash('sha256');
  const record =
    value && typeof value === 'object' ? (value as { record?: unknown }).record : undefined;
  const chunks = canonicalReviewValueChunks(
    value,
    options.recordComparisonsUndefined
      ? {
          fieldValue: (object, key) =>
            object === record && key === 'comparisons' ? { value: undefined } : undefined,
        }
      : {},
  );
  for (const chunk of canonicalSelectionChunks(chunks)) hash.update(chunk);
  return hash.digest('hex');
};
