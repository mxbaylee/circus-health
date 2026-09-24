import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, CheckCircle2, CircleAlert, Settings2, X } from 'lucide-react';
import { api, useResource } from '../../data/api';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import type { AssistantAvailability } from './types';
import './assistant.css';

type DiagnosticsProps = {
  profileId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnLabel?: string;
  busy?: boolean;
  onStatusChange?: () => void;
};

function profileAssistantBase(profileId: string) {
  return `/api/profiles/${encodeURIComponent(profileId)}/assistant`;
}

function capabilityLabel(value: boolean | null | undefined, kind: 'tools' | 'images' | 'pdf') {
  if (value === true)
    return kind === 'tools'
      ? 'Verified with fictional content'
      : kind === 'pdf'
        ? 'Verified with a fictional PDF'
        : 'Verified with a fictional image';
  if (value === false) return 'Not verified on this route';
  return 'Not yet verified';
}

function readinessLabel(value: AssistantAvailability | null) {
  if (!value) return 'Not checked';
  if (value.readiness === 'tested' && value.available) return 'Tested and ready';
  if (value.readiness === 'untested') return 'Not yet tested';
  if (!value.available) return 'Unavailable';
  return value.readiness || 'Available';
}

export function MoxieDiagnostics({
  profileId,
  open,
  onOpenChange,
  returnLabel = 'Back',
  busy = false,
  onStatusChange,
}: DiagnosticsProps) {
  const base = profileAssistantBase(profileId);
  const status = useResource<AssistantAvailability>(open ? `${base}/status` : null);
  const [testing, setTesting] = useState<'tools' | 'images' | 'pdf' | null>(null);
  const [testError, setTestError] = useState('');
  const requests = useRef(new Set<AbortController>());
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setTesting(null);
    setTestError('');
    requests.current.forEach((controller) => controller.abort());
  }, [profileId]);
  useEffect(() => {
    if (open) setTestError('');
    else {
      requests.current.forEach((controller) => controller.abort());
      setTesting(null);
    }
  }, [open]);
  useEffect(
    () => () => {
      requests.current.forEach((controller) => controller.abort());
    },
    [],
  );

  async function testConnection(kind: 'tools' | 'images' | 'pdf') {
    if (testing || busy) return;
    const controller = new AbortController();
    requests.current.add(controller);
    setTesting(kind);
    setTestError('');
    try {
      await api<AssistantAvailability>(`${base}/test-connection`, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          image: kind === 'images',
          ...(kind === 'pdf' ? { pdf: true } : {}),
        }),
      });
      if (!controller.signal.aborted) {
        status.reload();
        onStatusChange?.();
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setTestError(
          cause instanceof Error ? cause.message : 'The fictional connection test failed.',
        );
    } finally {
      requests.current.delete(controller);
      if (!controller.signal.aborted) setTesting(null);
    }
  }

  const unavailable = status.data?.available === false && status.data.readiness !== 'untested';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay moxie-diagnostics-overlay" />
        <Dialog.Content
          className="source-dialog moxie-diagnostics-dialog"
          onOpenAutoFocus={() => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus();
            }
          }}
        >
          <Dialog.Close asChild>
            <button
              className="icon-button dialog-close"
              type="button"
              aria-label="Close diagnostics"
            >
              <X size={21} />
            </button>
          </Dialog.Close>
          <Settings2 className="pink-icon" size={25} aria-hidden="true" />
          <Dialog.Title>Moxie connection</Dialog.Title>
          <Dialog.Description>
            Check the configured model route with fictional prompts. These tests do not send profile
            records.
          </Dialog.Description>

          {status.loading && !status.data && (
            <LoadingIndicator label="Checking Moxie connection…" layout="panel" />
          )}
          {status.error && (
            <div className="moxie-diagnostics-alert" role="alert">
              <CircleAlert size={18} aria-hidden="true" />
              <p>{status.error.message}</p>
              <button className="text-link" type="button" onClick={status.reload}>
                Check again
              </button>
            </div>
          )}
          {status.data && (
            <>
              <dl className="moxie-diagnostics-grid">
                <div>
                  <dt>Route</dt>
                  <dd>
                    {status.data.backend === 'litellm' || !status.data.backend
                      ? 'LiteLLM'
                      : 'Configured model route'}
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{readinessLabel(status.data)}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{status.data.model || 'Configured model name not reported'}</dd>
                </div>
                <div>
                  <dt>Tool use</dt>
                  <dd>{capabilityLabel(status.data.capabilities?.tools, 'tools')}</dd>
                </div>
                <div>
                  <dt>Image reading</dt>
                  <dd>{capabilityLabel(status.data.capabilities?.images, 'images')}</dd>
                </div>
                <div>
                  <dt>PDF reading</dt>
                  <dd>{capabilityLabel(status.data.capabilities?.pdf, 'pdf')}</dd>
                </div>
              </dl>
              {status.data.message && (
                <p
                  className={
                    unavailable ? 'moxie-diagnostics-message error' : 'moxie-diagnostics-message'
                  }
                >
                  {unavailable ? (
                    <CircleAlert size={17} aria-hidden="true" />
                  ) : (
                    <CheckCircle2 size={17} aria-hidden="true" />
                  )}
                  <span>{status.data.message}</span>
                </p>
              )}
            </>
          )}
          {testError && (
            <p className="moxie-diagnostics-test-error" role="alert">
              {testError}
            </p>
          )}
          <div className="moxie-diagnostics-actions">
            <button
              className="button secondary"
              type="button"
              disabled={!!testing || busy}
              onClick={() => void testConnection('pdf')}
            >
              {testing === 'pdf' ? (
                <LoadingIndicator label="Testing PDF reading…" layout="control" announce={false} />
              ) : (
                'Test with a fictional PDF'
              )}
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={!!testing || busy}
              onClick={() => void testConnection('tools')}
            >
              {testing === 'tools' ? (
                <LoadingIndicator label="Testing tools…" layout="control" announce={false} />
              ) : (
                'Test tools with fictional content'
              )}
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={!!testing || busy || status.data?.capabilities?.images === false}
              onClick={() => void testConnection('images')}
            >
              {testing === 'images' ? (
                <LoadingIndicator
                  label="Testing image reading…"
                  layout="control"
                  announce={false}
                />
              ) : (
                'Test with a fictional image'
              )}
            </button>
          </div>
          {testing && (
            <p className="sr-only" role="status">
              Running a fictional connection test…
            </p>
          )}
          <Dialog.Close asChild>
            <button className="button primary moxie-diagnostics-back" type="button">
              <ArrowLeft size={16} aria-hidden="true" />
              {returnLabel}
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function MoxieDiagnosticsTrigger({
  profileId,
  returnLabel = 'Back',
  disabled = false,
  label = 'Connection details',
  className = '',
}: {
  profileId: string;
  returnLabel?: string;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`text-link moxie-diagnostics-trigger${className ? ` ${className}` : ''}`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Settings2 size={15} aria-hidden="true" />
        {label}
      </button>
      <MoxieDiagnostics
        profileId={profileId}
        open={open}
        onOpenChange={setOpen}
        returnLabel={returnLabel}
        busy={disabled}
      />
    </>
  );
}
