import { Link } from 'react-router-dom';
import type { IntakeReportAcceptanceReceipt } from '../../../shared/intake';
import type { IntakeIdentityPerson } from '../../../shared/intake-identity';
import { useResource } from '../../data/api';
import type { UnsentSelection } from './partial-save-plan';
import { SavedRecordDestinationLink } from './SavedRecordDestinations';
export function acceptanceSummary(receipt: IntakeReportAcceptanceReceipt) {
  if (receipt.atomic) return `${receipt.acceptedCount} saved`;
  const counts = (status: string) => receipt.items.filter((item) => item.status === status).length;
  return [
    `${counts('saved')} saved`,
    ...(counts('needs_review')
      ? [`${counts('needs_review')} ${counts('needs_review') === 1 ? 'needs' : 'need'} review`]
      : []),
    ...(['failed', 'not_attempted'] as const).flatMap((status) =>
      counts(status) ? [`${counts(status)} ${status.replaceAll('_', ' ')}`] : [],
    ),
  ].join(', ');
}
/** Outcomes retain exact receipt links, independently of the current feed page. */
export function ImportAcceptanceOutcomes({
  receipt,
  unsent = [],
}: {
  receipt: IntakeReportAcceptanceReceipt | null;
  unsent?: UnsentSelection[];
}) {
  const people = useResource<IntakeIdentityPerson[]>(receipt && !receipt.atomic ? '/people' : null);
  if (!receipt && !unsent.length) return null;
  const name = (personId?: string) => {
    if (!personId || personId === 'patient') return 'Self';
    const person = people.data?.find((entry) => entry.personId === personId);
    return person
      ? [person.fullName, person.birthDate, person.relationship].filter(Boolean).join(' · ')
      : 'another person';
  };
  return (
    <section aria-label="Save outcomes">
      <p role="status">
        {[
          receipt ? acceptanceSummary(receipt) : '',
          unsent.length ? `${unsent.length} not sent` : '',
        ]
          .filter(Boolean)
          .join(', ')}
      </p>
      <ul>
        {receipt?.atomic
          ? receipt.receipts.flatMap((block) =>
              block.records.map((record) => (
                <li key={record.recordId}>
                  <SavedRecordDestinationLink record={record} />
                </li>
              )),
            )
          : receipt && !receipt.atomic
            ? receipt.items.map((item) => (
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
                        {item.label || `Record in ${item.reportName || 'retained report'}`} ·{' '}
                        {name(item.personId)} · {item.status.replaceAll('_', ' ')}
                      </Link>
                      <p>{item.message}</p>
                    </>
                  )}
                </li>
              ))
            : null}
        {unsent.map((item) => (
          <li key={item.id}>
            <strong>{item.label} · not sent</strong>
            <p>{item.reason}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
