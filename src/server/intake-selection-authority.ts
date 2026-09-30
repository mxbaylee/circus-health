import { createHash } from 'node:crypto';
import { canonicalLiteral } from './intake-format.ts';

/** Only v2 pair transport pins may advance without another human review. */
export function durableSelectionInputs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(durableSelectionInputs);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const transport = object.format === 'intake-pair-scope-v2';
  return Object.fromEntries(
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
}
export const selectionAuthority = (value: unknown): string =>
  createHash('sha256')
    .update(canonicalLiteral(durableSelectionInputs(value)))
    .digest('hex');
