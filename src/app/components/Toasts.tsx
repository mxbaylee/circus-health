import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CircleCheck, Info, X } from 'lucide-react';
import { currentProfile, subscribeProfileIdentity } from '../data/profile';
import './toasts.css';

type Toast = { id: number; message: string; profileId?: string; app?: boolean };
let nextId = 0;
let messages: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => messages;
export function notifySuccess(message: string) {
  messages = [...messages, { id: ++nextId, message, profileId: currentProfile()?.id }].slice(-3);
  emit();
}
export function notifyConnection(message: string) {
  messages = [...messages, { id: ++nextId, message, app: true }].slice(-3);
  emit();
}
function dismiss(id: number) {
  messages = messages.filter((item) => item.id !== id);
  emit();
}
export function clearToasts() {
  messages = [];
  emit();
}

function ToastItem({ item }: { item: Toast }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(6000);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss(item.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [item.id, paused]);
  return (
    <div
      className="app-toast"
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {item.app ? (
        <Info size={20} aria-hidden="true" />
      ) : (
        <CircleCheck size={20} aria-hidden="true" />
      )}
      <span>{item.message}</span>
      <button
        type="button"
        aria-label={`Dismiss: ${item.message}`}
        onClick={() => dismiss(item.id)}
      >
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ToastViewport() {
  const items = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(
    () =>
      subscribeProfileIdentity(() => {
        messages = messages.filter((item) => item.app);
        emit();
      }),
    [],
  );
  return (
    <section className="toast-viewport" aria-label="Notifications">
      {items
        .filter((item) => item.app || item.profileId === currentProfile()?.id)
        .map((item) => (
          <ToastItem key={item.id} item={item} />
        ))}
    </section>
  );
}
