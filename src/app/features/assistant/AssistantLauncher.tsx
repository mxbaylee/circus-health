import { ClinicalReviewPreview } from './ClinicalReviewPreview';
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { MessageCircleMore, Plus, Send, Square, RotateCcw, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { api, apiUrl, useResource } from '../../data/api';
import { useProfile } from '../../data/profile';
import type { Profile } from '../../data/profile';
import { AssistantText, assistantLink } from './AssistantText';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { ContextHelp } from '../../components/ContextHelp';
import { MoxieDiagnostics } from './MoxieDiagnostics';
import { historyValueLabel } from '../notes/NoteHistoryPanel';
import { useAssistantPage } from './pageContext';
import { useAssistantChat } from './useAssistantChat';
import { sampleStarterPrompts } from './starterPrompts';
import { formatMessageTime } from './messageTime';
import type {
  AssistantAvailability,
  AssistantChat,
  AssistantChatSummary,
  AssistantContext,
  AssistantRun,
  AssistantMessage,
} from './types';
import './assistant.css';

// Only explicit run identity groups provider items. Older saved messages retain
// their own boundaries, and retries remain separate, truthful attempts.
function responseGroups(messages: AssistantMessage[]): AssistantMessage[][] {
  const groups: AssistantMessage[][] = [];
  for (const message of messages) {
    const previous = groups.at(-1)?.[0];
    if (
      message.role === 'assistant' &&
      message.runId &&
      previous?.role === 'assistant' &&
      previous.runId === message.runId
    )
      groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  return groups;
}

const statusLabels = {
  idle: 'Ready',
  running: 'Running',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const tokens = (value: number | null) =>
  value === null ? 'unknown' : new Intl.NumberFormat().format(value);
function runUsage(run: AssistantRun, index: number) {
  const prefix = `Attempt ${index + 1}`;
  if (!run.usage)
    return `${prefix} · ${run.status === 'running' ? 'usage measurement pending' : 'measured usage unavailable'}${run.model ? ` · ${run.model}` : ''}`;
  const usage = run.usage;
  return `${prefix} · ${tokens(usage.totalTokens)} total · ${tokens(usage.inputTokens)} input · ${tokens(usage.cachedInputTokens)} cached input · ${tokens(usage.outputTokens)} output · ${tokens(usage.reasoningOutputTokens)} reasoning${run.model ? ` · ${run.model}` : ''}`;
}
const pageNames: Record<string, string> = {
  '/': 'Overview',
  '/tests': 'Test results',
  '/people': 'People',
  '/notes': 'Notes',
  '/medications': 'Prescriptions',
  '/procedures': 'Procedures',
  '/sources': 'Sources',
  '/import': 'Import',
};
function contextName(context: AssistantContext, pageLabel?: string) {
  if (context.intakeRepair) return 'Selected import drafts';
  if (context.intakeId) return 'Selected source import';
  if (pageLabel) return pageLabel;
  try {
    const path = new URL(context.route.replace(/^#/, ''), 'https://circus.invalid').pathname;
    return pageNames[path] || 'Current page';
  } catch {
    return 'Current page';
  }
}
function MessageTime({ value }: { value: string }) {
  const formatted = formatMessageTime(value);
  return (
    <time dateTime={value} title={formatted.full} aria-label={formatted.full}>
      {formatted.short}
    </time>
  );
}
export function AssistantLauncher() {
  const profile = useProfile();
  return profile ? <ProfileAssistant key={profile.id} profile={profile} /> : null;
}

function ProfileAssistant({ profile }: { profile: Profile }) {
  const location = useLocation();
  const page = useAssistantPage();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [prefillContext, setPrefillContext] = useState<AssistantContext | null>(null);
  const [pending, setPending] = useState<'send' | 'cancel' | 'retry' | 'apply' | null>(null);
  const [error, setError] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [starters, setStarters] = useState(() => sampleStarterPrompts());
  const base = useRef(apiUrl('/assistant')).current;
  const requests = useRef(new Set<AbortController>());
  const selectionRevision = useRef(0);
  const mounted = useRef(true);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const availability = useResource<AssistantAvailability>(open ? `${base}/status` : null);
  const history = useResource<AssistantChatSummary[]>(open ? `${base}/chats` : null);
  const conversation = useAssistantChat(
    open && selectedId ? `${base}/chats/${encodeURIComponent(selectedId)}` : null,
    history.reload,
  );
  const chat = conversation.chat;
  const running = chat?.status === 'running';
  const draftKey = selectedId ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const available =
    availability.data?.available === true || availability.data?.readiness === 'untested';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requests.current.forEach((controller) => controller.abort());
    };
  }, []);
  useEffect(() => {
    function prefill(event: Event) {
      const detail = (
        event as CustomEvent<{
          message?: unknown;
          context?: { route?: unknown; intakeId?: unknown; intakeRepair?: unknown };
        }>
      ).detail;
      if (!detail || typeof detail.message !== 'string' || !detail.message.trim()) return;
      const context = detail.context;
      selectionRevision.current++;
      setSelectedId(null);
      setError('');
      setDrafts((current) => ({ ...current, new: (detail.message as string).trim() }));
      setPrefillContext({
        route:
          typeof context?.route === 'string'
            ? context.route
            : `${location.pathname}${location.search}`,
        ...(typeof context?.intakeId === 'string' ? { intakeId: context.intakeId } : {}),
        ...(context?.intakeRepair && typeof context.intakeRepair === 'object'
          ? { intakeRepair: context.intakeRepair }
          : {}),
      });
      setOpen(true);
    }
    window.addEventListener('health:ask', prefill);
    return () => window.removeEventListener('health:ask', prefill);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedId, chat?.messages.length, chat?.messages.at(-1)?.content]);

  async function mutate(action: 'send' | 'cancel' | 'retry' | 'apply', proposalId?: string) {
    if (
      pending ||
      (action === 'send' && (!draft.trim() || running || !available)) ||
      (action === 'retry' && !available)
    )
      return;
    if ((action !== 'send' && !selectedId) || (action === 'apply' && (!proposalId || running)))
      return;
    const controller = new AbortController();
    requests.current.add(controller);
    const selectedRevision = selectionRevision.current;
    const sentDraft = draft;
    const context = nextContext;
    const path =
      action === 'send'
        ? selectedId
          ? `/chats/${encodeURIComponent(selectedId)}/messages`
          : '/chats'
        : `/chats/${encodeURIComponent(selectedId!)}/${action}`;
    setPending(action);
    setError('');
    try {
      const response = await api<AssistantChat>(`${base}${path}`, {
        method: 'POST',
        signal: controller.signal,
        ...(action === 'send'
          ? { body: JSON.stringify({ message: draft.trim(), context }) }
          : action === 'apply'
            ? { body: JSON.stringify({ proposalId }) }
            : {}),
      });
      if (!mounted.current || controller.signal.aborted) return;
      if (selectedRevision === selectionRevision.current) {
        setSelectedId(response.data.id);
        conversation.accept(response.data, `${base}/chats/${encodeURIComponent(response.data.id)}`);
        if (action === 'send') setPrefillContext(null);
      }
      if (action === 'send')
        setDrafts((current) =>
          current[draftKey] === sentDraft ? { ...current, [draftKey]: '' } : current,
        );
      history.reload();
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The request could not be completed. Your draft is still here.',
        );
    } finally {
      requests.current.delete(controller);
      if (mounted.current && !controller.signal.aborted) setPending(null);
    }
  }

  const newChat = () => {
    selectionRevision.current++;
    setSelectedId(null);
    setError('');
    if (prefillContext) {
      setPrefillContext(null);
      setDrafts((current) => ({ ...current, new: '' }));
    }
    if (!drafts.new?.trim() || prefillContext)
      setStarters((current) => sampleStarterPrompts(Math.random, current));
  };
  const nextContext: AssistantContext =
    !selectedId && prefillContext
      ? prefillContext
      : {
          route: `${location.pathname}${location.search}`,
          ...(page?.selection ? { selection: page.selection } : {}),
        };
  const nextContextLabel = contextName(
    nextContext,
    !prefillContext && page?.route === nextContext.route ? page.label : undefined,
  );
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="assistant-launcher button secondary" aria-label="Open assistant">
          <MessageCircleMore size={18} />
          <span>Assistant</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="assistant-dialog">
          <div className="assistant-header">
            <div>
              <Dialog.Title>
                <MessageCircleMore size={22} />
                Moxie the Assistant
              </Dialog.Title>
              <div className="assistant-header-meta">
                <Dialog.Description>
                  {profile.name}’s profile ·{' '}
                  {profile.placebo
                    ? 'Fictional placebo records'
                    : 'This profile’s records and notes'}
                </Dialog.Description>
                <button
                  type="button"
                  className="text-link assistant-connection-trigger"
                  onClick={() => setDiagnosticsOpen(true)}
                >
                  {availability.loading && !availability.data
                    ? 'Connection: checking…'
                    : availability.error ||
                        (availability.data?.available === false &&
                          availability.data.readiness !== 'untested')
                      ? 'Connection: unavailable'
                      : availability.data?.readiness === 'untested'
                        ? 'Connection: not tested'
                        : 'Connection: ready'}
                </button>
              </div>
            </div>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label="Close assistant">
                <X size={21} />
              </button>
            </Dialog.Close>
          </div>
          <div className="assistant-sessions">
            <label>
              Saved chats
              <select
                aria-label="Saved chats"
                value={selectedId ?? ''}
                disabled={!!pending}
                onChange={(event) => {
                  selectionRevision.current++;
                  const nextId = event.target.value || null;
                  if (prefillContext) {
                    setPrefillContext(null);
                    setDrafts((current) => ({ ...current, new: '' }));
                  }
                  if (!nextId && selectedId && !drafts.new?.trim())
                    setStarters((current) => sampleStarterPrompts(Math.random, current));
                  setSelectedId(nextId);
                  setError('');
                }}
              >
                <option value="">New chat</option>
                {selectedId && !history.data?.some((item) => item.id === selectedId) && (
                  <option value={selectedId}>{chat?.title || 'Selected chat'}</option>
                )}
                {history.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · {statusLabels[item.status]}
                  </option>
                ))}
              </select>
            </label>
            <button className="button secondary" disabled={!!pending} onClick={newChat}>
              <Plus size={17} />
              New chat
            </button>
          </div>
          {history.error && (
            <p className="assistant-notice" role="alert">
              {history.error.message}{' '}
              <button className="text-link" onClick={history.reload}>
                Retry chat history
              </button>
            </p>
          )}
          {(availability.error ||
            (availability.data?.available === false &&
              availability.data?.readiness !== 'untested')) && (
            <p className="assistant-notice" role="alert">
              {availability.error?.message ||
                availability.data?.message ||
                'Moxie is unavailable. Check the configured model connection.'}{' '}
              <button className="text-link" onClick={() => setDiagnosticsOpen(true)}>
                Open connection details
              </button>
            </p>
          )}
          <div className="assistant-conversation" aria-label="Chat messages">
            {!selectedId && (
              <div className="assistant-empty">
                <MessageCircleMore size={30} />
                <h3>Ask about your archive</h3>
                <p>
                  Pick a question to edit. Sending shares your question and relevant profile details
                  with your configured model. Hosted models receive that content outside this
                  device.
                </p>
                <ContextHelp label="What Moxie can use and change">
                  <p>
                    Moxie can request relevant records and original evidence from the unlocked
                    profile. Your selected page helps provide context. Model requests use the
                    connection configured for this app; local storage alone does not make the model
                    local.
                  </p>
                  <p>
                    Suggested changes need your review before they become accepted records. Choosing
                    a starter only fills the message box; Send starts the request.
                  </p>
                </ContextHelp>
                <div className="assistant-starters" role="group" aria-label="Conversation starters">
                  {starters.map((starter) => (
                    <button
                      type="button"
                      className="button assistant-starter-chip"
                      key={starter.label}
                      disabled={!!pending}
                      onClick={() => {
                        setPrefillContext(null);
                        setDrafts((current) => ({
                          ...current,
                          new: prefillContext
                            ? starter.message
                            : current.new?.trim()
                              ? `${current.new}\n\n${starter.message}`
                              : starter.message,
                        }));
                        composer.current?.focus();
                      }}
                    >
                      {starter.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="assistant-starters-refresh text-link"
                  disabled={!!pending}
                  onClick={() =>
                    setStarters((current) => sampleStarterPrompts(Math.random, current))
                  }
                >
                  <RotateCcw size={14} />
                  Refresh suggestions
                </button>
              </div>
            )}
            {conversation.loading && !chat && (
              <LoadingIndicator className="assistant-notice" label="Opening chat…" layout="panel" />
            )}
            {conversation.error && (
              <p className="assistant-notice" role="alert">
                {conversation.error}{' '}
                <button className="text-link" onClick={conversation.reload}>
                  Retry loading chat
                </button>
              </p>
            )}
            {chat && (
              <>
                <h3 className="assistant-chat-title">{chat.title}</h3>
                {responseGroups(chat.messages).map((parts) => {
                  const message = parts[0];
                  const interrupted = parts.some((part) => part.status === 'interrupted');
                  const streaming = parts.some((part) => part.status === 'streaming');
                  return (
                    <article
                      className={`assistant-message ${message.role}`}
                      key={message.id}
                      aria-label={`${message.role === 'user' ? 'You' : 'Moxie'} message`}
                    >
                      <div className="assistant-message-meta">
                        <strong>{message.role === 'user' ? 'You' : 'Moxie'}</strong>
                        <MessageTime value={message.createdAt} />
                        {message.role === 'user' && message.context && (
                          <span title={message.context.route}>
                            From {contextName(message.context)}
                          </span>
                        )}
                        {interrupted && <span>Previous attempt · interrupted</span>}
                        {streaming && !interrupted && <span>Responding…</span>}
                      </div>
                      {parts.map((part) => (
                        <AssistantText
                          key={part.id}
                          content={part.content}
                          onNavigate={() => setOpen(false)}
                        />
                      ))}
                    </article>
                  );
                })}
                {running && !pending && (
                  <LoadingIndicator
                    label={chat.runs?.at(-1)?.progress?.text || 'Moxie is responding…'}
                  />
                )}
                {chat.status === 'failed' && (
                  <p className="assistant-notice" role="alert">
                    {chat.error || 'The assistant could not finish this turn.'}
                  </p>
                )}
                {chat.status === 'cancelled' && (
                  <p className="assistant-notice" role="status">
                    This run was cancelled. You can retry the last turn or send a new message.
                  </p>
                )}
                {(chat.status === 'failed' || chat.status === 'cancelled') && (
                  <button
                    className="button secondary"
                    disabled={!!pending || !available}
                    onClick={() => void mutate('retry')}
                  >
                    <RotateCcw size={16} />
                    Retry last turn
                  </button>
                )}
                {!!chat.runs?.length && (
                  <details className="assistant-usage">
                    <summary>
                      Measured usage · {chat.runs.length}{' '}
                      {chat.runs.length === 1 ? 'attempt' : 'attempts'}
                    </summary>
                    {chat.runs.map((run, index) => (
                      <p key={run.id}>{runUsage(run, index)}</p>
                    ))}
                  </details>
                )}
                {chat.proposals?.map((proposal) => {
                  const result = proposal.resultUrl ? assistantLink(proposal.resultUrl) : null;
                  return (
                    <section
                      className="assistant-proposal"
                      key={proposal.id}
                      aria-label={proposal.title}
                    >
                      <h4>{proposal.title}</h4>
                      <p>{proposal.summary}</p>
                      <p>
                        {proposal.status === 'applied'
                          ? 'Saved to this profile'
                          : 'Review the proposed changes before saving to this profile.'}
                      </p>
                      {(proposal.kind === 'clinical_correction' ||
                        proposal.kind === 'duplicate_decision' ||
                        proposal.kind === 'intake_draft_repair' ||
                        proposal.kind === 'mapping') &&
                      proposal.preview ? (
                        <ClinicalReviewPreview proposal={proposal} />
                      ) : proposal.kind === 'restore' && proposal.preview ? (
                        <section aria-label="Restoration preview">
                          {proposal.preview.changes.map((change) => (
                            <p key={change.path}>
                              {change.label}: {historyValueLabel(change.before)} →{' '}
                              {historyValueLabel(change.after)}
                            </p>
                          ))}
                          <p className="helper-text">
                            Only these selected fields will be restored. A newer profile edit
                            requires a refreshed proposal.
                          </p>
                        </section>
                      ) : (
                        <details>
                          <summary>Proposed changes</summary>
                          <pre>
                            {JSON.stringify(proposal.changes, null, 2) ??
                              'No change details available.'}
                          </pre>
                        </details>
                      )}
                      {proposal.error && <p role="alert">{proposal.error}</p>}
                      {proposal.status !== 'applied' && (
                        <button
                          className="button secondary"
                          disabled={!!pending || running}
                          onClick={() => void mutate('apply', proposal.id)}
                        >
                          {proposal.kind === 'note'
                            ? 'Save note'
                            : proposal.kind === 'classification'
                              ? 'Apply classification'
                              : proposal.kind === 'attachment'
                                ? 'Attach file'
                                : proposal.kind === 'restore'
                                  ? 'Restore selected fields'
                                  : 'Apply reviewed change'}
                        </button>
                      )}
                      {proposal.status === 'applied' && result && !result.external && (
                        <Link to={result.href} className="text-link" onClick={() => setOpen(false)}>
                          Open saved item
                        </Link>
                      )}
                    </section>
                  );
                })}
              </>
            )}
            <div ref={bottom} />
          </div>
          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate('send');
            }}
          >
            {error && (
              <p className="assistant-notice" role="alert">
                {error}
              </p>
            )}
            {pending && (
              <LoadingIndicator
                label={
                  pending === 'send'
                    ? 'Sending your request…'
                    : pending === 'cancel'
                      ? 'Cancelling the request…'
                      : pending === 'retry'
                        ? 'Restarting the request…'
                        : 'Saving Moxie’s suggestion…'
                }
                size="small"
              />
            )}
            <label htmlFor="assistant-message">
              <span id="assistant-message-label">Message</span>
              <textarea
                ref={composer}
                id="assistant-message"
                aria-labelledby="assistant-message-label"
                value={draft}
                placeholder="Ask about these records…"
                rows={3}
                disabled={!!pending || running}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [draftKey]: event.target.value }))
                }
              />
            </label>
            <div className="assistant-composer-actions">
              <span title={nextContext.route}>Next message context · {nextContextLabel}</span>
              {running ? (
                <button
                  className="button secondary"
                  type="button"
                  disabled={!!pending}
                  onClick={() => void mutate('cancel')}
                >
                  <Square size={15} />
                  {pending === 'cancel' ? 'Cancelling…' : 'Cancel run'}
                </button>
              ) : (
                <button
                  className="button primary"
                  type="submit"
                  disabled={
                    !!pending ||
                    !available ||
                    !draft.trim() ||
                    (!!selectedId && (!chat || !!conversation.error))
                  }
                >
                  <Send size={16} />
                  {pending === 'send' ? 'Sending…' : 'Send'}
                </button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
      <MoxieDiagnostics
        profileId={profile.id}
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
        returnLabel="Back to chat"
        busy={!!pending || running}
        onStatusChange={availability.reload}
      />
    </Dialog.Root>
  );
}
