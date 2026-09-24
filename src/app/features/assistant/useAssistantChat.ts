import { useEffect, useState } from 'react';
import { api, ApiError } from '../../data/api';
import type { AssistantChat } from './types';

export function useAssistantChat(endpoint: string | null, onStatusChanged: () => void) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    endpoint: string | null;
    chat: AssistantChat | null;
    loading: boolean;
    error: string | null;
  }>({ endpoint, chat: null, loading: !!endpoint, error: null });
  useEffect(() => {
    if (!endpoint) {
      setState({ endpoint, chat: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let checks = 0;
    let previousStatus: AssistantChat['status'] | undefined;
    setState((current) => ({
      endpoint,
      chat: current.endpoint === endpoint ? current.chat : null,
      loading: true,
      error: null,
    }));
    async function load() {
      try {
        const response = await api<AssistantChat>(endpoint!, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState({ endpoint, chat: response.data, loading: false, error: null });
        if (previousStatus !== response.data.status) onStatusChanged();
        previousStatus = response.data.status;
        if (response.data.status === 'running')
          timeout = setTimeout(() => void load(), checks++ === 0 ? 1000 : 3000);
      } catch (error) {
        if (!controller.signal.aborted)
          setState((current) => ({
            ...current,
            loading: false,
            error:
              error instanceof ApiError
                ? error.message
                : 'The chat could not be loaded. Check the local server and try again.',
          }));
      }
    }
    void load();
    return () => {
      controller.abort();
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [endpoint, revision, onStatusChanged]);
  const current =
    state.endpoint === endpoint
      ? state
      : { endpoint, chat: null, loading: !!endpoint, error: null };
  return {
    ...current,
    reload: () => setRevision((value) => value + 1),
    accept: (chat: AssistantChat, target: string) => {
      setState({ endpoint: target, chat, loading: false, error: null });
      setRevision((value) => value + 1);
    },
  };
}
