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
  // Identity/source attribution is enriched after issue evaluation and has its
  // own typed issues. A fieldless clinical issue follows every clinical field.
  const {
    subject: _subject,
    personId: _personId,
    sourceSystem: _sourceSystem,
    ...clinical
  } = mapping;
  return createHash('sha256')
    .update(
      canonicalLiteral(
        fields.includes('*')
          ? clinical
          : fields.map((field) => [field, mapping[field as keyof IntakeClinicalMapping] ?? null]),
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
  // Subject is projected from the printed identity and saved person after the
  // workflow review. Pinning that derived value here would invalidate even an
  // unchanged explicit Unknown answer on the next read. Exact identity receipt
  // and report-boundary checks own the person assignment; kind remains stable.
  const selected = [
    ...new Set(
      resolutionFields(issue).filter((field) =>
        issue.kind === 'identity' ? field !== 'subject' : true,
      ),
    ),
  ].sort();
  const fields = selected.length ? selected : ['*'];
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
  // Historical answers remain in the draft audit trail, but without a measured
  // dependency they cannot prove that today's field/source still supports them.
  if (!dependency) return false;
  if (!Array.isArray(dependency.fields) || typeof dependency.fieldHash !== 'string') return false;
  if (fieldHash(mapping, dependency.fields) !== dependency.fieldHash) return false;
  if (dependency.source) {
    const { intakeId, page, hash } = dependency.source;
    if (sourcePageCurrentHash(db, intakeId, page) !== hash) return false;
  }
  return true;
}
