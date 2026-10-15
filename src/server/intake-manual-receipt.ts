/** A manual receipt is one historical domain value. Its existing legacy decode
 * allowance is independent of presentation pages; no proposal list is loaded. */
import type { ManualSourceRecordReceipt } from '../shared/intake-manual-source-record.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { DEFAULT_LIMITS } from './intake-state-evidence.ts';

export function readSelectedManualSourceReceipt(
  view: IntakeCollectionEnvelopeReader,
  proposal: IntakeEnvelopeRecord,
): ManualSourceRecordReceipt | undefined {
  const value = view.field(proposal, 'manualSourceRecord', { bytes: 256 * 1024 });
  if (value.kind === 'missing' || (value.kind === 'value' && !value.value)) return undefined;
  if (value.kind === 'value') return value.value as ManualSourceRecordReceipt;
  let text = '',
    bytes = 0;
  const structured = view.child(proposal, 'manualSourceRecord');
  for (const piece of structured
    ? view.recordChunks(structured)
    : view.fieldChunks(proposal, 'manualSourceRecord')) {
    bytes += Buffer.byteLength(piece);
    if (bytes > DEFAULT_LIMITS.bytes)
      throw Error('Manual source receipt exceeds its supported legacy value budget');
    text += piece;
  }
  return JSON.parse(text) as ManualSourceRecordReceipt;
}
