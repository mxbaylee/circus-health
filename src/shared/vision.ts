import type { Evidence } from './api.ts';

/** Source spellings only. Missing units and dates must never be inferred. */
export interface OpticalValue {
  valueText: string;
  unit?: string;
}
export interface OpticalEye {
  side: 'right' | 'left' | 'both' | 'unknown';
  sideText?: string;
  sph?: OpticalValue;
  cyl?: OpticalValue;
  axis?: OpticalValue;
  add?: OpticalValue;
  prism?: OpticalValue;
  pd?: OpticalValue;
  baseCurve?: OpticalValue;
  diameter?: OpticalValue;
  notes?: string;
}
export interface OpticalPrescription {
  /** Normalized eyewear category for filtering and presentation. */
  type: 'spectacle' | 'contact_lens' | 'unknown';
  /** Optional source wording for the prescription type, preserved exactly as reviewed. */
  typeText?: string;
  /** Optional source wording for the prescription status, preserved exactly as reviewed. */
  statusText?: string;
  prescribedDateText?: string;
  expiresDateText?: string;
  eyes: OpticalEye[];
  pd?: OpticalValue;
  notes?: string;
}
export interface VisionPrescriptionRecord {
  id: string;
  occurrenceId: string;
  title: string;
  date: string | null;
  provider: string | null;
  sourceRecordId: string;
  opticalPrescription: OpticalPrescription;
  evidence: Evidence[];
}
