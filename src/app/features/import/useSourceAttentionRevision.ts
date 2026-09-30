import { useEffect, useRef, useState } from 'react';
import type { IntakeSourceText } from '../../../shared/intake-source-text';

/** Accept newer source responses; profile/intake generations never share local state. */
export function useSourceAttentionRevision(
  scope: string,
  remote: IntakeSourceText | null,
  remoteSequence?: number,
) {
  type Snapshot = { scope: string; data: IntakeSourceText; sequence: number };
  const [local, setLocal] = useState<Snapshot | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const snapshot = local?.scope === scope ? local : null;
  const remoteNewer =
    remote &&
    (!snapshot ||
      (remoteSequence !== undefined
        ? remoteSequence > snapshot.sequence
        : remote.revision &&
          snapshot.data.revision &&
          (remote.revision.parentRevisionId === snapshot.data.revision.id ||
            remote.revision.createdAt > snapshot.data.revision.createdAt)));
  const data = remoteNewer ? remote : snapshot?.data || remote;
  const latest = useRef({
    data,
    sequence: remoteNewer ? remoteSequence || 0 : snapshot?.sequence || 0,
  });
  latest.current = { data, sequence: remoteNewer ? remoteSequence || 0 : snapshot?.sequence || 0 };
  useEffect(() => {
    if (remoteNewer && remote) setLocal({ scope, data: remote, sequence: remoteSequence || 0 });
  }, [scope, remote, remoteSequence]);
  function accept(data: IntakeSourceText, sequence: number | undefined, requestedScope: string) {
    if (currentScope.current !== requestedScope) return false;
    const prior = latest.current;
    if (
      (sequence !== undefined && sequence < prior.sequence) ||
      (data.revision &&
        prior.data?.revision &&
        data.revision.id !== prior.data.revision.id &&
        (prior.data.revision.parentRevisionId === data.revision.id ||
          data.revision.createdAt < prior.data.revision.createdAt))
    )
      return false;
    latest.current = { data, sequence: sequence || 0 };
    setLocal({ scope, data, sequence: sequence || 0 });
    return true;
  }
  return {
    data,
    accept,
    clear: () => setLocal(null),
    current: (requestedScope: string) => currentScope.current === requestedScope,
  };
}
