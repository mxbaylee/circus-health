import { useState } from 'react';
import type {
  ClinicalRelationshipApplyInput,
  ClinicalRelationshipApplyResult,
  ClinicalRelationshipPreview,
  ClinicalRelationshipRequest,
  ClinicalRelationshipSide,
} from '../../../shared/clinical-relationships';
import { ClinicalRelationshipDialog } from './ClinicalRelationshipDialog';

export function ClinicalRelationshipAction({
  left,
  right,
  previewRelationship,
  applyRelationship,
  onApplied,
  label = 'Review relationship',
  initialAction = 'display_preference',
}: {
  left: ClinicalRelationshipSide;
  right: ClinicalRelationshipSide;
  previewRelationship: (
    request: ClinicalRelationshipRequest,
  ) => Promise<ClinicalRelationshipPreview>;
  applyRelationship: (
    request: ClinicalRelationshipApplyInput,
  ) => Promise<ClinicalRelationshipApplyResult>;
  onApplied: (result: ClinicalRelationshipApplyResult) => void | Promise<void>;
  label?: string;
  initialAction?: ClinicalRelationshipRequest['action'];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button secondary" onClick={() => setOpen(true)}>
        {label}
      </button>
      <ClinicalRelationshipDialog
        open={open}
        onOpenChange={setOpen}
        left={left}
        right={right}
        previewRelationship={previewRelationship}
        applyRelationship={applyRelationship}
        onApplied={onApplied}
        initialAction={initialAction}
      />
    </>
  );
}
