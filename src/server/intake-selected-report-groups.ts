import { finishClinicalReviewWork } from './clinical-review-work.ts';
/** Complete host-only link traversal and an explicit bounded transport reference. */
import type { IntakeReviewGroupReference } from '../shared/intake.ts';
import type {
  IntakeReviewGroupLinks,
  IntakeReviewGroupLinksReference,
} from '../shared/intake-report-group-links.ts';
import { selectedSequence } from './intake-selected-sequence.ts';
import { canonicalLiteral, registerLiteralSharedValue } from './intake-format.ts';
import { registerReviewCanonicalValue } from './intake-review-question-state.ts';
const selections = new WeakMap<object, () => Iterable<IntakeReviewGroupReference>>();
export function selectedReportGroups(value: IntakeReviewGroupLinks | undefined) {
  if (!value || Array.isArray(value)) return selectedSequence(value);
  const read = selections.get(value);
  if (!read) throw Error('Unbound selected report-group reference');
  return selectedSequence(read);
}
export function isSelectedReportGroups(value: unknown): value is IntakeReviewGroupLinksReference {
  return !!value && typeof value === 'object' && selections.has(value);
}
export function selectedReportGroupLinks(
  ...input: Parameters<typeof selectedReportGroupLinksWork>
): IntakeReviewGroupLinks {
  return finishClinicalReviewWork(selectedReportGroupLinksWork(...input));
}
export function* selectedReportGroupLinksWork(
  read: () => Iterable<IntakeReviewGroupReference>,
  selection: IntakeReviewGroupLinksReference['selection'],
  bytes: number,
): Generator<void, IntakeReviewGroupLinks, void> {
  let inline: IntakeReviewGroupReference[] | undefined = [],
    count = 0,
    size = 2;
  let first: IntakeReviewGroupReference | undefined;
  for (const value of read()) {
    yield;
    first ??= value;
    count++;
    if (inline) {
      size += Buffer.byteLength(canonicalLiteral(value)) + 1;
      if (size > bytes) inline = undefined;
      else inline.push(value);
    }
  }
  if (inline) return inline;
  const reference: IntakeReviewGroupLinksReference = Object.freeze({
    format: 'health-intake-report-group-links-v1',
    count,
    ...(first ? { first: Object.freeze(first) } : {}),
    selection: Object.freeze(selection),
  });
  selections.set(reference, read);
  registerLiteralSharedValue(reference);
  registerReviewCanonicalValue(reference, function* () {
    yield '[';
    let first = true;
    for (const value of read()) {
      if (!first) yield ',';
      first = false;
      yield canonicalLiteral(value);
    }
    yield ']';
  });
  return reference;
}

/** Preserve the historical stable-JSON occurrence recipe, including raw-number wrapper handling. */
export function* canonicalReportGroupContextChunks(value: unknown): Generator<string> {
  if (isSelectedReportGroups(value)) {
    yield '[';
    let first = true;
    for (const item of selectedReportGroups(value)) {
      if (!first) yield ',';
      first = false;
      yield canonicalLiteral(item);
    }
    yield ']';
    return;
  }
  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) {
      if (index) yield ',';
      yield* canonicalReportGroupContextChunks(value[index] === undefined ? null : value[index]);
    }
    yield ']';
    return;
  }
  if (value && typeof value === 'object') {
    yield '{';
    let first = true;
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
      if (!first) yield ',';
      first = false;
      yield JSON.stringify(key) + ':';
      yield* canonicalReportGroupContextChunks(child);
    }
    yield '}';
    return;
  }
  yield JSON.stringify(value);
}
