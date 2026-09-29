import { createContext, useCallback, useState } from 'react';

/** Source approvals share list selection, but never call clinical record acceptance. */
export interface SourceSectionSelection {
  count: number;
  selected: number;
  pending: boolean;
  select: (all: boolean) => void;
  approve: () => Promise<boolean>;
}
export type RegisterSourceSelection = (
  id: string,
  selection: SourceSectionSelection | null,
) => void;
export const ImportSourceSelection = createContext<RegisterSourceSelection | null>(null);

export function useSourceSelection() {
  const [files, setFiles] = useState<Record<string, SourceSectionSelection>>({});
  const register = useCallback<RegisterSourceSelection>((id, selection) => {
    setFiles((current) => {
      if (!selection && !(id in current)) return current;
      const next = { ...current };
      if (selection) next[id] = selection;
      else delete next[id];
      return next;
    });
  }, []);
  return { files: Object.values(files), register };
}
