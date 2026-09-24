import { Navigate } from 'react-router-dom';
import type { ReclassifiedRecord } from '../../shared/api';

export function isReclassifiedRecord(value: unknown): value is ReclassifiedRecord {
  return !!value && typeof value === 'object' && 'reclassifiedTo' in value;
}
export function currentClinicalRecord<T>(value: T | ReclassifiedRecord | undefined): T | undefined {
  return isReclassifiedRecord(value) ? undefined : value;
}
export function ClinicalRedirect({ record }: { record: ReclassifiedRecord }) {
  return <Navigate to={record.reclassifiedTo.appUrl} replace />;
}
