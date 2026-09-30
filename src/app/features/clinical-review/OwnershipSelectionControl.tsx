import { useEffect, useState } from 'react';
import { useProfile } from '../../data/profile';
import { RecordOwnershipAction } from './RecordOwnershipAction';
import type { OwnershipRecordReference } from '../../../shared/record-ownership';
/** Selection is explicit and can span pages; the server previews every retained source. */
export function OwnershipSelectionControl({
  records,
  onApplied,
}: {
  records: (OwnershipRecordReference & { title: string })[];
  onApplied: () => void | Promise<void>;
}) {
  const profile = useProfile();
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<Map<string, OwnershipRecordReference & { title: string }>>(
      new Map(),
    );
  useEffect(() => {
    setSelected(new Map());
    setOpen(false);
  }, [profile?.id]);
  if (!records.length && !selected.size) return null;
  return (
    <div className="ownership-selection">
      <button
        className="button secondary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Select records to change person
      </button>
      {open && (
        <fieldset>
          <legend>Saved records to move</legend>
          {records.map((r) => (
            <label key={r.kind + r.recordId}>
              <input
                type="checkbox"
                checked={selected.has(r.kind + r.recordId)}
                onChange={(e) =>
                  setSelected((old) => {
                    const next = new Map(old);
                    if (e.target.checked) next.set(r.kind + r.recordId, r);
                    else next.delete(r.kind + r.recordId);
                    return next;
                  })
                }
              />
              {r.title}
            </label>
          ))}
          <p>{selected.size} selected across pages.</p>
          <RecordOwnershipAction
            label="Move selected records"
            selection={{
              type: 'records',
              records: [...selected.values()].map(({ title: _title, ...ref }) => ref),
            }}
            onApplied={async () => {
              setSelected(new Map());
              await onApplied();
            }}
          />
          <button className="button secondary" onClick={() => setSelected(new Map())}>
            Clear selection
          </button>
        </fieldset>
      )}
    </div>
  );
}
