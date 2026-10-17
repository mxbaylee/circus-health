import { useResource } from '../../data/api';
import {
  intakeFilenameDisplay,
  isIntakePackageHeader,
  type IntakePublicRead,
} from '../../../shared/intake-summary';
import type { IntakeReportQueueBlock, IntakeReportQueueRecord } from '../../../shared/intake';
import { IntakeFilenameDetails } from '../intake/IntakeFilenameDetails';
import { IntakeSourceFieldDetails } from '../intake/IntakeSourceFieldDetails';
import { PackageInventory } from '../intake/PackageInventory';
export function detailUrl(
  groupId: string,
  block: Pick<IntakeReportQueueBlock, 'intakeId' | 'proposalId'>,
  record: Pick<IntakeReportQueueRecord, 'id'>,
) {
  const params = new URLSearchParams({
    group: groupId,
    intake: block.intakeId,
    proposal: block.proposalId || 'original',
    record: record.id,
    review: 'full',
  });
  return `/import?${params}`;
}

export function ImportFileDetails({ intakeId }: { intakeId: string }) {
  const intake = useResource<IntakePublicRead>(`/intakes/${encodeURIComponent(intakeId)}`);
  if (!intake.data) return null;
  if ('format' in intake.data && intake.data.format === 'health-intake-summary-v3')
    return (
      <details className="intake-processing-details">
        <summary>Original file details</summary>
        <dl>
          <dt>Filename</dt>
          <dd>
            {intakeFilenameDisplay(intake.data)}
            {intake.data.filenameReference && (
              <IntakeFilenameDetails reference={intake.data.filenameReference} />
            )}
          </dd>
          <dt>State</dt>
          <dd>{intake.data.state.replaceAll('_', ' ')}</dd>
          <dt>Size</dt>
          <dd>{intake.data.bytes.toLocaleString()} bytes</dd>
          <dt>Media type</dt>
          <dd>
            {intake.data.source.mimeType.kind === 'value' ? (
              intake.data.source.mimeType.value
            ) : (
              <IntakeSourceFieldDetails
                reference={intake.data.source.mimeType.reference}
                label="View media type"
              />
            )}
          </dd>
          <dt>Provider ID</dt>
          <dd>
            {intake.data.source.providerId === null ? (
              'None'
            ) : intake.data.source.providerId.kind === 'value' ? (
              intake.data.source.providerId.value
            ) : (
              <IntakeSourceFieldDetails
                reference={intake.data.source.providerId.reference}
                label="View provider ID"
              />
            )}
          </dd>
        </dl>
      </details>
    );
  if (!isIntakePackageHeader(intake.data)) return null;
  return (
    <details className="intake-processing-details">
      <summary>Package and original file details</summary>
      <PackageInventory intake={intake.data} />
    </details>
  );
}
