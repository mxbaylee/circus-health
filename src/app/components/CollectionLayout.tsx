import type { ReactNode } from 'react';
import './collection-layout.css';

export function CollectionTabs({
  label,
  children,
  role,
}: {
  label: string;
  children: ReactNode;
  role?: 'tablist';
}) {
  return (
    <nav className="collection-tabs" aria-label={label} role={role}>
      {children}
    </nav>
  );
}

export function CollectionToolbar({ children }: { children: ReactNode }) {
  return <div className="collection-toolbar">{children}</div>;
}
