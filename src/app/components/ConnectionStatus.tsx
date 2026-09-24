import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, LoaderCircle, RefreshCw, Wifi, WifiOff, X } from 'lucide-react';
import { startConnectionMonitor, useConnection } from '../data/connection';
import { CLIENT_BUILD_ID } from '../data/build';
import { pendingApiWrites, usePendingApiWrites } from '../data/api';
import { useProfileTransition } from './ProfileTransitionGuard';
import { notifyConnection, ToastViewport } from './Toasts';
import './connection-status.css';

const labels = {
  checking: 'Checking',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  unavailable: 'Server unavailable',
};
export function ConnectionStatus() {
  const state = useConnection();
  const [open, setOpen] = useState(false);
  const pointerFocus = useRef(false);
  const id = useId();
  const Icon =
    state.status === 'connected'
      ? Wifi
      : state.status === 'checking'
        ? LoaderCircle
        : state.status === 'unavailable'
          ? CircleAlert
          : WifiOff;
  const detail =
    state.status === 'connected'
      ? 'The local server is responding.'
      : state.status === 'checking'
        ? 'Checking the local server.'
        : state.reason === 'http'
          ? `The server responded with HTTP ${state.httpStatus}. We’ll keep checking.`
          : state.reason === 'invalid'
            ? 'The server returned an unexpected response. We’ll keep checking.'
            : 'The local server could not be reached. We’ll keep checking. Unsaved changes remain in this tab.';
  return (
    <div
      className="connection-control"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'touch') setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`icon-button connection-icon ${state.status}`}
        aria-label={`Server connection: ${labels[state.status]}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onPointerDown={() => {
          pointerFocus.current = true;
        }}
        onFocus={() => {
          if (!pointerFocus.current) setOpen(true);
        }}
        onClick={(event) => {
          setOpen((value) =>
            event.detail === 0 || (event.nativeEvent as PointerEvent).pointerType === 'touch'
              ? !value
              : true,
          );
          pointerFocus.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            event.stopPropagation();
          }
        }}
      >
        <Icon size={21} aria-hidden="true" />
      </button>
      {open && (
        <div className="connection-details" id={id} role="tooltip">
          <strong>{labels[state.status]}</strong>
          <p>{detail}</p>
        </div>
      )}
    </div>
  );
}

const dismissedBuilds = new Set<string>();
export function ConnectionNotices({
  clientBuildId = CLIENT_BUILD_ID,
  refresh = () => window.location.reload(),
}: { clientBuildId?: string | null; refresh?: () => void } = {}) {
  const state = useConnection();
  const writes = usePendingApiWrites();
  const transition = useProfileTransition();
  const outage = useRef(false);
  const [, rerender] = useState(0);
  useEffect(() => {
    const unavailable = state.status === 'reconnecting' || state.status === 'unavailable';
    if (unavailable && !outage.current)
      notifyConnection(
        'Connection interrupted. Unsaved changes remain in this tab; failed saves need your review.',
      );
    if (state.status === 'connected' && outage.current)
      notifyConnection('Connection restored. Reads can resume; review any failed saves.');
    if (state.status !== 'checking') outage.current = unavailable;
  }, [state.status]);
  const pair =
    clientBuildId && state.buildId && clientBuildId !== state.buildId
      ? `${clientBuildId}:${state.buildId}`
      : null;
  return (
    <>
      {pair && !dismissedBuilds.has(pair) && (
        <aside className="app-update-notice" aria-label="Application update">
          <RefreshCw size={20} aria-hidden="true" />
          <div>
            <strong>An update is available</strong>
            <p>Refresh when you’re ready.</p>
          </div>
          <button
            className="button secondary"
            disabled={writes > 0 || state.status !== 'connected'}
            onClick={() =>
              transition.request(() => {
                if (pendingApiWrites())
                  throw new Error(
                    'An operation is still saving. Wait for it to finish before refreshing.',
                  );
                refresh();
              })
            }
          >
            Refresh
          </button>
          <button
            className="icon-button"
            aria-label="Dismiss update notice"
            onClick={() => {
              dismissedBuilds.add(pair);
              rerender((value) => value + 1);
            }}
          >
            <X size={18} />
          </button>
        </aside>
      )}
      {transition.dialog}
    </>
  );
}
/** Mounted outside the profile-keyed shell, including startup and locked states. */
export function ConnectionBoundary({ children }: { children: ReactNode }) {
  useEffect(startConnectionMonitor, []);
  return (
    <>
      {children}
      <ConnectionNotices />
      <ToastViewport />
    </>
  );
}
