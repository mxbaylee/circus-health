import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useLocation } from 'react-router-dom';
import { useProfile } from '../../data/profile';
import type { AssistantContext } from './types';

type Page = AssistantContext & { profileId: string; label?: string };
const PageContext = createContext<{
  page: Page | null;
  setPage: Dispatch<SetStateAction<Page | null>>;
} | null>(null);
export function AssistantPageProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Page | null>(null);
  const value = useMemo(() => ({ page, setPage }), [page]);
  return <PageContext.Provider value={value}>{children}</PageContext.Provider>;
}

/** Publish identities only. The server reads saved content in the selected profile. */
export function useAssistantSelection(selection: AssistantContext['selection'], label?: string) {
  const context = useContext(PageContext),
    location = useLocation(),
    profile = useProfile();
  const setPage = context?.setPage;
  const serialized = JSON.stringify({
    profileId: profile?.id,
    route: `${location.pathname}${location.search}`,
    selection,
    label,
  });
  useEffect(() => {
    if (!setPage) return;
    const page = JSON.parse(serialized) as Page;
    setPage(page);
    return () => setPage((current) => (current === page ? null : current));
  }, [serialized, setPage]);
}
export function useAssistantPage() {
  const context = useContext(PageContext),
    location = useLocation(),
    profile = useProfile();
  const page = context?.page;
  return page?.profileId === profile?.id && page?.route === `${location.pathname}${location.search}`
    ? page
    : null;
}
