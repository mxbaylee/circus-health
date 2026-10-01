import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  IntakeClinicalMapping,
  IntakeIssueResolution,
  IntakeReviewIssue,
} from '../shared/intake.ts';
import { canonicalLiteral } from './intake-format.ts';
import { resolutionFields } from './intake-review.ts';
import { sourcePageCurrentHash } from './intake-proposal-dependencies.ts';

function fieldHash(mapping: Partial<IntakeClinicalMapping>, fields: string[]): string {
  return createHash('sha256')
    .update(
      canonicalLiteral(
        fields.map((field) => [field, mapping[field as keyof IntakeClinicalMapping] ?? null]),
      ),
    )
    .digest('hex');
}

export function issueResolutionDependency(
  db: DatabaseSync,
  intakeId: string,
  issue: IntakeReviewIssue,
  mapping: Partial<IntakeClinicalMapping>,
): NonNullable<IntakeIssueResolution['dependency']> {
  const fields = [...new Set(resolutionFields(issue))].sort();
  const pageHash = issue.page ? sourcePageCurrentHash(db, intakeId, issue.page) : null;
  return {
    fields,
    fieldHash: fieldHash(mapping, fields),
    ...(pageHash && issue.page ? { source: { intakeId, page: issue.page, hash: pageHash } } : {}),
  };
}

export function issueResolutionCurrent(
  db: DatabaseSync,
  resolution: IntakeIssueResolution,
  mapping: Partial<IntakeClinicalMapping>,
): boolean {
  const dependency = resolution.dependency;
  if (!dependency) return true; // Historical answers remain visible until separately reviewed.
  if (!Array.isArray(dependency.fields) || typeof dependency.fieldHash !== 'string') return false;
  if (fieldHash(mapping, dependency.fields) !== dependency.fieldHash) return false;
  if (dependency.source) {
    const { intakeId, page, hash } = dependency.source;
    if (sourcePageCurrentHash(db, intakeId, page) !== hash) return false;
  }
  return true;
}
