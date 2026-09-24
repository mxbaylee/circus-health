import { useRef, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, X } from 'lucide-react';

export function NoteDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = '',
  returnFocusTo,
  onBack,
  backLabel = 'Back',
  backDisabled = false,
  hideDescription = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: string;
  children: ReactNode;
  className?: string;
  returnFocusTo?: () => HTMLElement | null;
  onBack?: () => void;
  backLabel?: string;
  backDisabled?: boolean;
  hideDescription?: boolean;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`source-dialog note-dialog ${className}`}
          onOpenAutoFocus={() => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocusTo?.() || returnFocus.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          {onBack && (
            <button
              type="button"
              className="button secondary note-dialog-back"
              onClick={onBack}
              disabled={backDisabled}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              {backLabel}
            </button>
          )}
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description className={hideDescription ? 'sr-only' : undefined}>
            {description}
          </Dialog.Description>
          <Dialog.Close asChild>
            <button type="button" className="icon-button dialog-close" aria-label="Close dialog">
              <X size={21} />
            </button>
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
