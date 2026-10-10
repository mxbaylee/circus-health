import { useState } from 'react';
import type { IntakeQuestion } from '../../../shared/intake';
import { CollectionEvidenceWindow } from './CollectionEvidenceWindow';

/** The latest policy answer is separate from this complete retained answer history. */
export function QuestionAnswerHistory({
  intakeId,
  history,
  onRefresh,
}: {
  intakeId: string;
  history: IntakeQuestion['answerHistory'];
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!history) return null;
  return (
    <section aria-label="Saved question answers">
      <p>
        {history.count.toLocaleString()} saved answers. The current review shows the latest answer;
        earlier answers remain in this history.
      </p>
      <button className="button secondary" type="button" onClick={() => setOpen(!open)}>
        {open ? 'Hide answer history' : 'View answer history'}
      </button>
      {open && (
        <CollectionEvidenceWindow
          key={JSON.stringify([intakeId, history])}
          scope={JSON.stringify([intakeId, history])}
          label="Complete saved answer history"
          path={`/intakes/${encodeURIComponent(intakeId)}/collection-fragment`}
          body={{ reference: history.reference }}
          onRefresh={onRefresh}
        />
      )}
    </section>
  );
}
