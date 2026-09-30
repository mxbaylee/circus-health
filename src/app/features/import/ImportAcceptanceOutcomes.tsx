import { Link } from 'react-router-dom';
import type { IntakeReportAcceptanceReceipt } from '../../../shared/intake';
import { SavedRecordDestinationLink } from './SavedRecordDestinations';
export function acceptanceSummary(receipt: IntakeReportAcceptanceReceipt) {
  if (receipt.atomic) return `${receipt.acceptedCount} saved`;
  const counts = (status: string) => receipt.items.filter((item) => item.status === status).length;
  return [
    `${counts('saved')} saved`,
    ...(['needs_review', 'failed', 'not_attempted'] as const).flatMap((status) =>
      counts(status) ? [`${counts(status)} ${status.replaceAll('_', ' ')}`] : [],
    ),
  ].join(', ');
}
/** Outcomes retain exact receipt links, independently of the current feed page. */
export function ImportAcceptanceOutcomes({
  receipt,
}: {
  receipt: IntakeReportAcceptanceReceipt | null;
}) {
  if (!receipt) return null;
  return (
    <section aria-label="Save outcomes">
      <p role="status">{acceptanceSummary(receipt)}</p>
      <ul>
        {receipt.atomic
          ? receipt.receipts.flatMap((block) =>
              block.records.map((record) => (
                <li key={record.recordId}>
                  <SavedRecordDestinationLink record={record} />
                </li>
              )),
            )
          : receipt.items.map((item) => (
              <li key={item.operationId}>
                {item.status === 'saved' ? (
                  item.receipt?.records.map((record) => (
                    <SavedRecordDestinationLink key={record.entityId} record={record} />
                  ))
                ) : (
                  <>
                    <Link
                      to={`/import?intake=${encodeURIComponent(item.intakeId)}&proposal=${encodeURIComponent(item.proposalId || 'original')}&record=${encodeURIComponent(item.recordId)}`}
                    >
                      {item.recordId} · {item.status.replaceAll('_', ' ')}
                    </Link>
                    <p>{item.message}</p>
                  </>
                )}
              </li>
            ))}
      </ul>
    </section>
  );
}
