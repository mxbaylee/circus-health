import { useState } from 'react';
import { api } from '../../data/api';
import { useProfile } from '../../data/profile';
import type {
  RecordCorrectionApplyRequest,
  RecordCorrectionApplyResult,
  RecordCorrectionPreview,
  RecordCorrectionRequest,
} from '../../../shared/record-correction';
import { RecordCorrectionDialog, type RecordCorrectionTarget } from './RecordCorrectionDialog';

export function RecordCorrectionAction({
  target,
  onApplied,
  label = 'Correct saved record',
}: {
  target: RecordCorrectionTarget;
  onApplied: (result: RecordCorrectionApplyResult) => void | Promise<void>;
  label?: string;
}) {
  const profile = useProfile();
  const [open, setOpen] = useState(false);
  const prefix = `/api/profiles/${encodeURIComponent(profile?.id || '')}`;
  const previewCorrection = (request: RecordCorrectionRequest) =>
    api<RecordCorrectionPreview>(`${prefix}/clinical-review/correction-preview`, {
      method: 'POST',
      body: JSON.stringify(request),
    }).then(({ data }) => data);
  const applyCorrection = (request: RecordCorrectionApplyRequest) =>
    api<RecordCorrectionApplyResult>(`${prefix}/clinical-review/correction-apply`, {
      method: 'POST',
      body: JSON.stringify(request),
    }).then(({ data }) => data);

  return (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={!profile}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <RecordCorrectionDialog
        open={open}
        onOpenChange={setOpen}
        target={target}
        previewCorrection={previewCorrection}
        applyCorrection={applyCorrection}
        onApplied={onApplied}
      />
    </>
  );
}
