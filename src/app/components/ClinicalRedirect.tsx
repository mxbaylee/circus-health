import { Link, Navigate } from 'react-router-dom';
import type { ReclassifiedRecord } from '../../shared/api';

export function isReclassifiedRecord(value: unknown): value is ReclassifiedRecord {
  return !!value && typeof value === 'object' && 'reclassifiedTo' in value;
}
export function currentClinicalRecord<T>(value: T | ReclassifiedRecord | undefined): T | undefined {
  return isReclassifiedRecord(value) ? undefined : value;
}
export function ClinicalRedirect({ record }: { record: ReclassifiedRecord }) {
  if (record.ownershipCorrected)
    return (
      <section className="panel">
        <h2>Person assignment corrected</h2>
        <p>
          This earlier record was linked to the reviewed destination. Its original evidence and
          previous accepted versions remain in history.
        </p>
        <Link className="button secondary" to={record.reclassifiedTo.appUrl}>
          Open current record
        </Link>
      </section>
    );
  return <Navigate to={record.reclassifiedTo.appUrl} replace />;
}
