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
  const routeKey =
    typeof window === 'undefined'
      ? ''
      : window.location.hash.split('?')[0] || window.location.pathname;
  const storageKey = `ownership-selected:${profile?.id || ''}:${routeKey}`;
  type SelectedRecord = OwnershipRecordReference & { title: string };
  const readSelection = (): Map<string, SelectedRecord> => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]') as SelectedRecord[];
      if (!Array.isArray(saved)) return new Map();
      return new Map(
        saved
          .filter(
            (item) => item && typeof item.kind === 'string' && typeof item.recordId === 'string',
          )
          .map((item) => [item.kind + item.recordId, item]),
      );
    } catch {
      return new Map();
    }
  };
  const [open, setOpen] = useState(false),
    [selectionState, setSelectionState] = useState<{
      key: string;
      values: Map<string, SelectedRecord>;
    }>(() => ({ key: storageKey, values: readSelection() }));
  const selected =
    selectionState.key === storageKey ? selectionState.values : new Map<string, SelectedRecord>();
  const setSelected = (update: (old: Map<string, SelectedRecord>) => Map<string, SelectedRecord>) =>
    setSelectionState((old) => ({
      key: storageKey,
      values: update(old.key === storageKey ? old.values : new Map()),
    }));
  useEffect(() => {
    setSelectionState({ key: storageKey, values: readSelection() });
    setOpen(false);
  }, [storageKey]);
  useEffect(() => {
    if (selectionState.key === storageKey)
      sessionStorage.setItem(storageKey, JSON.stringify([...selectionState.values.values()]));
  }, [storageKey, selectionState]);
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
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              setSelected((old) => {
                const next = new Map(old);
                for (const record of records) next.set(record.kind + record.recordId, record);
                return next;
              })
            }
          >
            Select all in this view
          </button>
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
          {selected.size > 0 && (
            <ul aria-label="All selected records">
              {[...selected.values()].map((record) => (
                <li key={record.kind + record.recordId}>
                  {record.title}
                  <button
                    type="button"
                    className="button secondary"
                    aria-label={`Remove ${record.title} from selection`}
                    onClick={() =>
                      setSelected((old) => {
                        const next = new Map(old);
                        next.delete(record.kind + record.recordId);
                        return next;
                      })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <RecordOwnershipAction
            label="Move selected records"
            selection={{
              type: 'records',
              records: [...selected.values()].map(({ title: _title, ...ref }) => ref),
            }}
            onApplied={async () => {
              setSelected(() => new Map());
              await onApplied();
            }}
          />
          <button className="button secondary" onClick={() => setSelected(() => new Map())}>
            Clear selection
          </button>
        </fieldset>
      )}
    </div>
  );
}
