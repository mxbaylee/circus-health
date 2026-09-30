import { useEffect, useRef, useState } from 'react';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../../../shared/intake';
import { api, ApiError } from '../../data/api';
import { currentProfile, subscribeProfileIdentity } from '../../data/profile';

const storageKey = (profileId: string) => `circus-health:report-acceptance:${profileId}`;
// Exact clinical selections stay only in memory, but survive detail/overview mounts.
// The non-clinical operation ID in sessionStorage additionally survives a reload.
type PendingAcceptance = {
  request: IntakeReportAcceptanceRequest;
  inFlight: number;
};
const pendingRequests = new Map<string, PendingAcceptance>();
const pendingListeners = new Map<string, Set<() => void>>();
const peerRecoveryMessage =
  'A previous save still needs receipt recovery before another selection can save.';
const notifyPending = (profileId: string) =>
  pendingListeners.get(profileId)?.forEach((listener) => listener());
const storedOperation = (profileId: string) => {
  if (!profileId) return null;
  try {
    return sessionStorage.getItem(storageKey(profileId));
  } catch {
    return null;
  }
};
const rememberOperation = (profileId: string, operationId: string | null) => {
  if (!profileId) return;
  try {
    if (operationId) sessionStorage.setItem(storageKey(profileId), operationId);
    else sessionStorage.removeItem(storageKey(profileId));
  } catch {
    // Receipt recovery remains available during this mounted session.
  }
};
const clearPending = (profileId: string, operationId: string, allowInFlight = false) => {
  const retained = pendingRequests.get(profileId);
  const stored = storedOperation(profileId);
  const currentOperationId = stored || retained?.request.operationId || null;
  if (
    currentOperationId !== operationId ||
    (retained && retained.request.operationId !== operationId) ||
    (!allowInFlight && (retained?.inFlight || 0) > 0)
  )
    return false;
  rememberOperation(profileId, null);
  if (retained?.request.operationId === operationId) pendingRequests.delete(profileId);
  notifyPending(profileId);
  return true;
};

// A profile transition or lock may happen without any acceptance control mounted.
// Retain only the opaque operation ID; discard every clinical request payload.
subscribeProfileIdentity(() => {
  const activeProfileId = currentProfile()?.locked ? null : currentProfile()?.id;
  for (const profileId of [...pendingRequests.keys()]) {
    if (profileId === activeProfileId) continue;
    pendingRequests.delete(profileId);
    notifyPending(profileId);
  }
});

export function useReportAcceptance(
  profileId: string,
  onConfirmed: (result: IntakeReportAcceptanceResult) => void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<IntakeReportAcceptanceRequest | null>(null);
  const [recoveryOperationId, setRecoveryOperationId] = useState<string | null>(() =>
    storedOperation(profileId),
  );
  const [recovering, setRecovering] = useState(() => !!storedOperation(profileId));
  const active = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current;
    active.current = false;
    setBusy(false);
    setError('');
    const retained = pendingRequests.get(profileId);
    const operationId = storedOperation(profileId) || retained?.request.operationId || null;
    setPending(retained?.request.operationId === operationId ? retained.request : null);
    setRecoveryOperationId(operationId);
    setRecovering(!!operationId);
    const syncPending = () => {
      const currentRequest = pendingRequests.get(profileId);
      const currentOperationId =
        storedOperation(profileId) || currentRequest?.request.operationId || null;
      setRecoveryOperationId(currentOperationId);
      setPending(
        currentRequest?.request.operationId === currentOperationId ? currentRequest.request : null,
      );
      if (!currentOperationId)
        setError((current) => (current === peerRecoveryMessage ? '' : current));
    };
    const listeners = pendingListeners.get(profileId) || new Set<() => void>();
    listeners.add(syncPending);
    pendingListeners.set(profileId, listeners);
    if (operationId && retained?.request.operationId === operationId && retained.inFlight > 0) {
      setRecovering(false);
    } else if (operationId)
      void readReceipt(operationId)
        .then((result) => {
          if (generation !== epoch.current) return;
          if (result) confirmed(result, operationId);
          else
            setError(
              'Checking save status. No durable outcome is available yet; retain this operation before retrying.',
            );
        })
        .catch((cause) => {
          if (generation !== epoch.current) return;
          setError(
            cause instanceof Error ? cause.message : 'Unable to check the previous saved receipt.',
          );
        })
        .finally(() => {
          if (generation === epoch.current) setRecovering(false);
        });
    return () => {
      if (generation === epoch.current) {
        epoch.current++;
        active.current = false;
      }
      listeners.delete(syncPending);
      if (!listeners.size) pendingListeners.delete(profileId);
    };
  }, [profileId]);

  async function readReceipt(operationId: string, diagnosticOperationId?: string) {
    try {
      return (
        await api<IntakeReportAcceptanceResult>(
          `/api/profiles/${encodeURIComponent(profileId)}/intakes/report-acceptance/${encodeURIComponent(operationId)}`,
          { operationId: diagnosticOperationId },
        )
      ).data;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) return null;
      throw cause;
    }
  }

  function confirmed(result: IntakeReportAcceptanceResult, operationId: string) {
    if (result.receipt.operationId !== operationId || !clearPending(profileId, operationId, true))
      return false;
    setPending(null);
    setRecoveryOperationId(null);
    onConfirmed(result);
    return true;
  }

  async function checkReceipt() {
    if (!recoveryOperationId || active.current) return null;
    const retained = pendingRequests.get(profileId);
    if (retained?.request.operationId === recoveryOperationId && retained.inFlight > 0) {
      setError('This exact save is still completing. Wait, then check its receipt again.');
      return null;
    }
    const generation = epoch.current;
    active.current = true;
    setRecovering(true);
    setError('');
    try {
      const result = await readReceipt(recoveryOperationId);
      if (generation !== epoch.current) return null;
      if (result) confirmed(result, recoveryOperationId);
      else
        setError(
          'Checking save status. No durable outcome is available yet; retry only this exact operation.',
        );
      return result;
    } catch (cause) {
      if (generation === epoch.current)
        setError(cause instanceof Error ? cause.message : 'Unable to check the saved receipt.');
      return null;
    } finally {
      if (generation === epoch.current) {
        active.current = false;
        setRecovering(false);
      }
    }
  }

  async function send(
    request: IntakeReportAcceptanceRequest,
    retry: boolean,
    diagnosticOperationId?: string,
  ) {
    const selected = currentProfile();
    if (!profileId || selected?.id !== profileId || selected.locked) return null;
    const retained = pendingRequests.get(profileId);
    const rememberedOperationId =
      storedOperation(profileId) || retained?.request.operationId || null;
    if (
      active.current ||
      recovering ||
      (retained?.inFlight || 0) > 0 ||
      (rememberedOperationId && (!retry || request.operationId !== rememberedOperationId)) ||
      (recoveryOperationId && (!retry || !pending || request.operationId !== recoveryOperationId))
    ) {
      if (rememberedOperationId && rememberedOperationId !== recoveryOperationId) {
        setRecoveryOperationId(rememberedOperationId);
        setPending(
          retained?.request.operationId === rememberedOperationId ? retained.request : null,
        );
        setError(peerRecoveryMessage);
      }
      return null;
    }
    const generation = epoch.current;
    active.current = true;
    setBusy(true);
    setError('');
    const current = pendingRequests.get(profileId);
    pendingRequests.set(profileId, {
      request,
      inFlight: current?.request.operationId === request.operationId ? current.inFlight + 1 : 1,
    });
    setPending(request);
    setRecoveryOperationId(request.operationId);
    rememberOperation(profileId, request.operationId);
    notifyPending(profileId);
    try {
      try {
        const result = (
          await api<IntakeReportAcceptanceResult>(
            `/api/profiles/${encodeURIComponent(profileId)}/intakes/report-acceptance`,
            {
              operationId: diagnosticOperationId,
              method: 'POST',
              body: JSON.stringify(request),
            },
          )
        ).data;
        if (generation !== epoch.current) return null;
        return confirmed(result, request.operationId) ? result : null;
      } catch (cause) {
        const recovered = await readReceipt(request.operationId, diagnosticOperationId);
        if (generation !== epoch.current) return null;
        if (recovered) {
          return confirmed(recovered, request.operationId) ? recovered : null;
        }
        if (cause instanceof ApiError && cause.status > 0 && cause.status < 500) {
          if (clearPending(profileId, request.operationId, true)) {
            setPending(null);
            setRecoveryOperationId(null);
            setError(cause.message);
          }
        } else {
          setError(
            `${retry ? 'Retry' : 'Save'} was not confirmed. Check the saved receipt, then retry this exact selection explicitly.`,
          );
        }
        return null;
      }
    } catch (cause) {
      if (generation === epoch.current)
        setError(cause instanceof Error ? cause.message : 'Unable to check the saved receipt.');
      return null;
    } finally {
      const current = pendingRequests.get(profileId);
      if (current?.request.operationId === request.operationId && current.inFlight > 0) {
        pendingRequests.set(profileId, { ...current, inFlight: current.inFlight - 1 });
        notifyPending(profileId);
      }
      if (generation === epoch.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }

  return {
    busy,
    error,
    pending,
    recovering,
    recoveryOperationId,
    submit: (request: IntakeReportAcceptanceRequest, diagnosticOperationId?: string) =>
      send(request, false, diagnosticOperationId),
    retry: () => (pending ? send(pending, true) : Promise.resolve(null)),
    checkReceipt,
    clearError: () => setError(''),
  };
}
