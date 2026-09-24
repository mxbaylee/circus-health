import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreateIntakeBatchInput, IntakeBatch } from '../../../shared/intake-batch';
import { api } from '../../data/api';

const POLL_INTERVAL = 1500;

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to update the reading batch.';

function storageKey(profileId: string) {
  return `circus:intake-batch-create:${profileId}`;
}

function readPending(profileId: string): CreateIntakeBatchInput | null {
  try {
    const value = localStorage.getItem(storageKey(profileId));
    if (!value) return null;
    const parsed = JSON.parse(value) as CreateIntakeBatchInput;
    return parsed.operationId && Array.isArray(parsed.intakeIds) ? parsed : null;
  } catch {
    return null;
  }
}

export function useIntakeBatch(profileId: string) {
  const [batch, setBatch] = useState<IntakeBatch | null>(null);
  const [pendingCreate, setPendingCreate] = useState<CreateIntakeBatchInput | null>(null);
  const [loading, setLoading] = useState(!!profileId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const mutationRevision = useRef(0);
  const activeProfile = useRef(profileId);
  activeProfile.current = profileId;
  const profileVersion = useRef({ id: profileId, value: 0 });
  if (profileVersion.current.id !== profileId)
    profileVersion.current = { id: profileId, value: profileVersion.current.value + 1 };
  const renderProfileVersion = profileVersion.current.value;
  const prefix = `/api/profiles/${encodeURIComponent(profileId)}/intake-batches`;

  const remember = useCallback(
    (input: CreateIntakeBatchInput | null) => {
      setPendingCreate(input);
      if (!profileId) return;
      if (input) localStorage.setItem(storageKey(profileId), JSON.stringify(input));
      else localStorage.removeItem(storageKey(profileId));
    },
    [profileId],
  );

  useEffect(() => {
    const current = ++generation.current;
    const readRevision = ++mutationRevision.current;
    setBatch(null);
    setError('');
    setBusy(false);
    setPendingCreate(profileId ? readPending(profileId) : null);
    setLoading(!!profileId);
    if (!profileId) return;
    const controller = new AbortController();
    api<IntakeBatch[]>(prefix, { signal: controller.signal })
      .then(({ data }) => {
        if (generation.current !== current || controller.signal.aborted) return;
        if (mutationRevision.current !== readRevision) return;
        const latest = data.find((item) => item.status === 'running') || data[0] || null;
        setBatch(latest);
        const pending = readPending(profileId);
        if (latest && pending?.operationId === latest.operationId) remember(null);
      })
      .catch(() => {
        // Older/offline application versions may not expose batch history yet. Upload and
        // explicit batch mutations still report their own errors.
        if (
          !controller.signal.aborted &&
          generation.current === current &&
          mutationRevision.current === readRevision
        )
          setBatch(null);
      })
      .finally(() => {
        if (!controller.signal.aborted && generation.current === current) setLoading(false);
      });
    return () => controller.abort();
  }, [prefix, profileId, remember]);

  useEffect(() => {
    if (!profileId || !batch || batch.status !== 'running') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const readRevision = mutationRevision.current;
      try {
        const result = await api<IntakeBatch>(`${prefix}/${encodeURIComponent(batch.id)}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (mutationRevision.current !== readRevision) {
          timer = setTimeout(poll, POLL_INTERVAL);
          return;
        }
        setBatch(result.data);
        setError('');
        if (result.data.status === 'running') timer = setTimeout(poll, POLL_INTERVAL);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (mutationRevision.current === readRevision) setError(message(cause));
        timer = setTimeout(poll, POLL_INTERVAL);
      }
    };
    timer = setTimeout(poll, POLL_INTERVAL);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [batch?.id, batch?.status, prefix, profileId]);

  const create = useCallback(
    async (intakeIds?: string[], options?: { appendToRunning?: boolean }) => {
      if (!profileId || busy) return null;
      if (
        activeProfile.current !== profileId ||
        profileVersion.current.value !== renderProfileVersion
      )
        throw new Error('Profile changed before this request started.');
      const operationProfile = profileId;
      const operationGeneration = generation.current;
      const current = () =>
        activeProfile.current === operationProfile && generation.current === operationGeneration;
      const retained = readPending(profileId);
      if (
        intakeIds?.length &&
        retained &&
        JSON.stringify(retained.intakeIds) !== JSON.stringify(intakeIds)
      ) {
        const cause = new Error(
          'Retry the earlier reading request before starting another batch. Newly selected originals remain saved.',
        );
        if (current()) setError(message(cause));
        throw cause;
      }
      const input = intakeIds?.length
        ? retained && JSON.stringify(retained.intakeIds) === JSON.stringify(intakeIds)
          ? retained
          : {
              operationId: crypto.randomUUID(),
              intakeIds,
              ...(options?.appendToRunning ? { appendToRunning: true } : {}),
            }
        : retained;
      if (!input) return null;
      mutationRevision.current++;
      remember(input);
      setBusy(true);
      setError('');
      try {
        const result = await api<IntakeBatch>(prefix, {
          method: 'POST',
          body: JSON.stringify(input),
        });
        if (current()) {
          setBatch(result.data);
          setError('');
          remember(null);
        }
        return result.data;
      } catch (cause) {
        if (current()) {
          setError(message(cause));
          const readRevision = mutationRevision.current;
          void api<IntakeBatch[]>(prefix)
            .then(({ data }) => {
              if (!current() || mutationRevision.current !== readRevision) return;
              const latest = data.find((item) => item.status === 'running') || data[0] || null;
              setBatch(latest);
              const pending = readPending(profileId);
              if (latest && pending?.operationId === latest.operationId) remember(null);
            })
            .catch(() => {});
        }
        throw cause;
      } finally {
        if (current()) setBusy(false);
      }
    },
    [busy, prefix, profileId, remember, renderProfileVersion],
  );

  const control = useCallback(
    async (action: 'stop' | 'resume') => {
      if (!batch || busy) return null;
      if (
        activeProfile.current !== profileId ||
        profileVersion.current.value !== renderProfileVersion
      )
        throw new Error('Profile changed before this request started.');
      const operationProfile = profileId;
      const operationGeneration = generation.current;
      const current = () =>
        activeProfile.current === operationProfile && generation.current === operationGeneration;
      mutationRevision.current++;
      setBusy(true);
      setError('');
      try {
        const result = await api<IntakeBatch>(
          `${prefix}/${encodeURIComponent(batch.id)}/${action}`,
          { method: 'POST', body: '{}' },
        );
        if (current()) {
          setBatch(result.data);
          setError('');
        }
        return result.data;
      } catch (cause) {
        if (current()) setError(message(cause));
        throw cause;
      } finally {
        if (current()) setBusy(false);
      }
    },
    [batch, busy, prefix, profileId, renderProfileVersion],
  );

  return {
    batch,
    loading,
    busy,
    error,
    pendingCreate,
    create,
    retryCreate: () => create(),
    stop: () => control('stop'),
    resume: () => control('resume'),
  };
}
