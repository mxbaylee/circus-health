import { useEffect, useState } from 'react';

type Props = {
  exists: boolean;
  dirty: boolean;
  state: 'idle' | 'saving' | 'saved' | 'error';
  validation?: string;
  attachmentPending?: boolean;
  portablePending?: boolean;
  savedAt?: string | null;
  savedBy?: 'manual' | 'auto';
};
/** Status describes the latest local draft, not merely the last successful request. */
export function saveStatusLabel(props: Props, now = Date.now()): string {
  if (props.state === 'error') return 'Couldn’t save';
  if (props.validation) return props.validation;
  if (props.state === 'saving') return 'Saving…';
  if (props.dirty) return 'Unsaved changes';
  if (props.attachmentPending) return 'Attachment work pending';
  if (props.portablePending) return 'Saved locally · portable copy needs retry';
  if (!props.exists) return 'Not saved yet';
  if (!props.savedAt) return 'All changes saved';
  const minutes = Math.max(0, Math.floor((now - Date.parse(props.savedAt)) / 60000));
  const when =
    minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes} minute${minutes === 1 ? '' : 's'} ago`
        : new Date(props.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${props.savedBy === 'manual' ? 'Saved' : 'Autosaved'} ${minutes >= 60 ? 'at ' : ''}${when}`;
}
export function SaveStatus(props: Props) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!props.savedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, [props.savedAt]);
  return (
    <span
      className={`quiet-badge autosave-status ${props.state}`}
      role="status"
      aria-live="polite"
      title={props.savedAt ? `Last saved ${new Date(props.savedAt).toLocaleString()}` : undefined}
    >
      {saveStatusLabel(props, now)}
    </span>
  );
}
