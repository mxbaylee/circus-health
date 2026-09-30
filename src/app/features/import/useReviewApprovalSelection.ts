import { useRef, useState } from 'react';
import type { ImportReviewRecord } from './ImportReviewPresentation';

/** An approval belongs to the exact displayed selection, not a later feed refresh. */
export function useReviewApprovalSelection() {
  const snapshots = useRef(new Map<string, ImportReviewRecord>());
  const [selected, setSelected] = useState(() => new Set<string>());
  const [needsApproval, setNeedsApproval] = useState(() => new Set<string>());
  const clearContext = () => {
    snapshots.current.clear();
    setSelected(new Set());
    setNeedsApproval(new Set());
  };
  const clearSelected = () => setSelected(new Set());
  const removeSaved = (ids: string[]) => {
    for (const id of ids) snapshots.current.delete(id);
    setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
  };
  const reject = (ids: string[]) => {
    for (const id of ids) snapshots.current.delete(id);
    setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
    setNeedsApproval((current) => new Set([...current, ...ids]));
  };
  const revokeChanged = (records: ImportReviewRecord[]) => {
    // Block revision can advance during background reading. Exact record inputs
    // remain selected until their own reviewed values change.
    const changed = records.filter((record) => {
      const approved = snapshots.current.get(record.id);
      return (
        approved &&
        JSON.stringify(approved.approval?.selections) !==
          JSON.stringify(record.approval?.selections)
      );
    });
    if (changed.length) reject(changed.map((record) => record.id));
    return changed.length;
  };
  const toggle = (id: string, records: ImportReviewRecord[]) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        snapshots.current.delete(id);
      } else {
        next.add(id);
        const record = records.find((row) => row.id === id);
        if (record) snapshots.current.set(id, record);
        setNeedsApproval((pending) => new Set([...pending].filter((row) => row !== id)));
      }
      return next;
    });
  };
  const selectShown = (records: ImportReviewRecord[], all: boolean) => {
    if (all) {
      for (const record of records)
        if (!selected.has(record.id)) snapshots.current.set(record.id, record);
    } else {
      for (const record of records) snapshots.current.delete(record.id);
    }
    setSelected((current) =>
      all
        ? new Set([...current, ...records.map((record) => record.id)])
        : new Set([...current].filter((id) => !records.some((record) => record.id === id))),
    );
    if (all)
      setNeedsApproval(
        (current) =>
          new Set([...current].filter((id) => !records.some((record) => record.id === id))),
      );
  };
  const approvals = (ids: string[]) =>
    ids.flatMap((id) =>
      snapshots.current.get(id)?.approval ? [snapshots.current.get(id)!.approval!] : [],
    );
  return {
    selected,
    needsApproval,
    clearContext,
    clearSelected,
    removeSaved,
    reject,
    revokeChanged,
    toggle,
    selectShown,
    approvals,
  };
}
