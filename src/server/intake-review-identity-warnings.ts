/** Complete advisory warnings share the existing connection-local policy row lifecycle. */
import { createHash } from 'node:crypto';
import type { IntakeReviewRecord } from '../shared/intake.ts';
import type { IntakeIdentityWarning } from '../shared/intake-identity.ts';
import { canonicalLiteral } from './intake-format.ts';
import { selectedSequence, type SelectedSequence } from './intake-selected-sequence.ts';
import { registerReviewRecordField } from './intake-review-selected-record.ts';
import {
  reviewIssueFactory,
  type ReviewPolicyValueCollection,
} from './intake-review-issue-state.ts';
export interface ReviewIdentityWarningsReference {
  format: 'health-intake-review-identity-warnings-v1';
  count: number;
  token: string;
}
type Row = { id: string; value: IntakeIdentityWarning };
const providers = new WeakMap<ReviewIdentityWarningsReference, ReviewPolicyValueCollection<Row>>();
export function bindReviewIdentityWarnings(
  factory: ReturnType<typeof reviewIssueFactory>,
  record: IntakeReviewRecord,
  warnings: Iterable<IntakeIdentityWarning>,
) {
  const rows = factory<Row>(record);
  const digest = createHash('sha256').update('[');
  let first = true;
  for (const warning of warnings) {
    const json = canonicalLiteral(warning),
      id = createHash('sha256').update(json).digest('hex');
    if (rows.findId!(id)) continue;
    rows.push({ id, value: warning });
    if (!first) digest.update(',');
    first = false;
    digest.update(json);
  }
  digest.update(']');
  const identity = record.identityReview;
  if (!identity || !rows.length) return;
  const reference: ReviewIdentityWarningsReference = {
    format: 'health-intake-review-identity-warnings-v1',
    count: rows.length,
    token: digest.digest('hex'),
  };
  providers.set(reference, rows);
  identity.warningsReference = reference;
  registerReviewRecordField(identity, 'warnings', 'warningsReference', function* () {
    yield '[';
    let first = true;
    for (const row of rows) {
      if (!first) yield ',';
      first = false;
      yield canonicalLiteral(row.value);
    }
    yield ']';
  });
  const preview: IntakeIdentityWarning[] = [];
  let bytes = 2;
  for (const row of rows) {
    bytes += Buffer.byteLength(canonicalLiteral(row.value)) + 1;
    if (preview.length === 100 || bytes > 16 * 1024) return;
    preview.push(row.value);
  }
  identity.warnings = preview;
}
export function reviewRecordIdentityWarnings(
  record: Pick<IntakeReviewRecord, 'identityReview'>,
): SelectedSequence<IntakeIdentityWarning> {
  const identity = record.identityReview;
  if (!identity?.warningsReference) return selectedSequence(identity?.warnings || []);
  const rows = providers.get(identity.warningsReference);
  if (!rows) throw Error('Unprepared complete identity warnings');
  return selectedSequence(rows).map((row) => row.value);
}
