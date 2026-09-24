import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { MoreHorizontal } from 'lucide-react';
import './detail-header.css';

/** The same entry identity and action layout for personal and provider records. */
export function DetailHeader({
  eyebrow,
  title,
  badges,
  metadata,
  actions,
  headingRef,
}: {
  eyebrow: string;
  title: ReactNode;
  badges?: ReactNode;
  metadata?: ReactNode;
  actions?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="detail-header entry-header">
      <div className="detail-heading-copy">
        <p className="eyebrow">{eyebrow}</p>
        <div className="note-identity-heading">
          <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
            {title}
          </h2>
          {badges}
        </div>
        {metadata && <div className="note-meta">{metadata}</div>}
      </div>
      {actions && <div className="detail-header-actions">{actions}</div>}
    </header>
  );
}

/** A disclosure of ordinary controls: Tab works normally; this is not an ARIA menu. */
export function EntryActions({
  children,
  label = 'More entry actions',
}: {
  children: ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(0);
  const id = useId();
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (bounds) {
        const width = Math.min(280, window.innerWidth - 32);
        setLeft(
          Math.max(16, Math.min(bounds.right - width, window.innerWidth - width - 16)) -
            bounds.left,
        );
      }
    };
    position();
    panel.current
      ?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]')
      ?.focus();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const target = event.target;
      // A history dialog remains a child action. Let its focus trap and Escape
      // handling work, then return to its still-mounted trigger on dismissal.
      if (
        target instanceof Element &&
        !root.current?.contains(target) &&
        !target.closest('[role="dialog"], .dialog-overlay')
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      // Radix restores focus after the dialog unmounts. A second Escape may
      // arrive on BODY during that gap, so listen outside the disclosure too.
      // Leave the first Escape entirely to any open modal's focus scope.
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);
  return (
    <div className="entry-actions" ref={root}>
      <button
        type="button"
        className="icon-button entry-actions-trigger"
        ref={trigger}
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={21} aria-hidden="true" />
      </button>
      <div
        ref={panel}
        id={id}
        className="entry-actions-panel"
        role="group"
        aria-label="Entry actions"
        hidden={!open}
        style={{ left }}
      >
        {children}
      </div>
    </div>
  );
}
