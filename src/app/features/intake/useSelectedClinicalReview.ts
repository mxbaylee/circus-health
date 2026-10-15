import { useCallback, useEffect, useState } from 'react';
import { useProfile } from '../../data/profile';
import {
  readSelectedClinicalReview,
  type SelectedClinicalReview,
} from '../../data/intake-clinical-review';

export function useSelectedClinicalReview(
  intakeId: string,
  proposalId: string | null,
  recordId: string,
) {
  const profile = useProfile();
  const scope = JSON.stringify([profile?.id, intakeId, proposalId, recordId]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    scope: string;
    data?: SelectedClinicalReview;
    error?: Error;
    loading: boolean;
  }>({ scope, loading: true });
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState((previous) =>
      previous.scope === scope
        ? { ...previous, error: undefined, loading: true }
        : { scope, loading: true },
    );
    void readSelectedClinicalReview(intakeId, proposalId, recordId, undefined, {
      signal: controller.signal,
    }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ scope, data, loading: false });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...(previous.scope === scope ? previous : { scope }),
            error: cause instanceof Error ? cause : new Error('Unable to open this exact record.'),
            loading: false,
          }));
      },
    );
    return () => controller.abort();
  }, [scope, intakeId, proposalId, recordId, revision]);
  const current = state.scope === scope ? state : { scope, loading: true };
  return {
    data: current.data?.context,
    record: current.data?.record.kind === 'record' ? current.data.record.record : undefined,
    reference:
      current.data?.record.kind === 'reference' ? current.data.record.reference : undefined,
    selected: current.data,
    error: current.error,
    loading: current.loading,
    reload,
  };
}
