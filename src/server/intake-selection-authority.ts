import { copyOwnershipHoldMessage } from './ownership-identity-values.ts';
import { createHash } from 'node:crypto';
import { canonicalReviewValueChunks } from './intake-review-question-state.ts';
import { isSelectedReportGroups } from './intake-selected-report-groups.ts';

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
export const selectionAuthority = (value: unknown): string => {
  const hash = createHash('sha256');
  for (const chunk of canonicalReviewValueChunks(durableSelectionInputs(value))) hash.update(chunk);
  return hash.digest('hex');
};
