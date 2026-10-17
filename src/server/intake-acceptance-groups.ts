import type { IntakeReportAcceptanceSelection, IntakeReview } from '../shared/intake.ts';

/** Clinical effects, never display labels, determine indivisible approval groups.
 * Retained native decisions must use the same destinations as their publication. */
export function acceptanceDependencyKeys(
  selection: IntakeReportAcceptanceSelection,
  record: IntakeReview['records'][number] | undefined,
): Set<string> {
  const keys = new Set<string>();
  const comparisons = selection.useRetainedDecision
    ? record?.draft?.decision?.comparisons
    : selection.comparisons;
  for (const comparison of comparisons || []) keys.add('destination:' + comparison.otherRecordId);
  if (record?.comparisonReference)
    keys.add('assertion:' + record.kind + ':' + record.comparisonReference.identity);
  if (record?.duplicateOf) keys.add('destination:' + record.duplicateOf.id);
  keys.add('destination:' + selection.recordId);
  return keys;
}

export function acceptanceCommitGroups(dependencies: readonly ReadonlySet<string>[]): number[][] {
  const parent = dependencies.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const seen = new Map<string, number>();
  for (const [index, keys] of dependencies.entries())
    for (const key of keys) {
      const prior = seen.get(key);
      if (prior !== undefined) {
        const a = find(index),
          b = find(prior);
        parent[Math.max(a, b)] = Math.min(a, b);
      }
      seen.set(key, index);
    }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < dependencies.length; index++) {
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(index);
    groups.set(root, group);
  }
  return [...groups.values()];
}
