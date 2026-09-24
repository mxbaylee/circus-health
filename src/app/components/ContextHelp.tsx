import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import './context-help.css';

/** Native disclosure keeps short explanations reachable by keyboard, touch and pointer. */
export function ContextHelp({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="context-help">
      <summary>
        <Info size={15} aria-hidden="true" />
        {label}
      </summary>
      <div className="context-help-content">{children}</div>
    </details>
  );
}
