import { createContext, useContext, useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CLIENT_BUILD_ID } from '../data/build';

type ThemePreference = 'system' | 'light' | 'dark';
const storageKey = 'circus-health-theme';
const systemQuery = '(prefers-color-scheme: dark)';
const assetVersion = CLIENT_BUILD_ID ? `?v=${encodeURIComponent(CLIENT_BUILD_ID)}` : '';
const ThemeContext = createContext<{
  preference: ThemePreference;
  select: (value: ThemePreference) => void;
} | null>(null);

function savedPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'system' || saved === 'light' || saved === 'dark') return saved;
    // Keep an explicit appearance choice when upgrading the app's branding.
    const previous = localStorage.getItem('health-prototype-theme');
    if (saved === null && (previous === 'system' || previous === 'light' || previous === 'dark')) {
      localStorage.setItem(storageKey, previous);
      localStorage.removeItem('health-prototype-theme');
      return previous;
    }
  } catch {
    /* Appearance still works when browser storage is unavailable. */
  }
  return 'system';
}
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(savedPreference);
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(systemQuery).matches,
  );
  const theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  useEffect(() => {
    const media = window.matchMedia(systemQuery);
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    const syncPreference = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) setPreference(savedPreference());
    };
    window.addEventListener('storage', syncPreference);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('storage', syncPreference);
    };
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#191722' : '#fff8fb');
    document
      .querySelector<HTMLLinkElement>('#app-favicon')
      ?.setAttribute('href', `/favicon-${theme}.svg${assetVersion}`);
    document
      .querySelector<HTMLLinkElement>('#fallback-favicon')
      ?.setAttribute('href', `/favicon.ico${assetVersion}`);
    document
      .querySelector<HTMLLinkElement>('#apple-touch-icon')
      ?.setAttribute('href', `/apple-touch-icon.png${assetVersion}`);
    document
      .querySelector<HTMLLinkElement>('#app-manifest')
      ?.setAttribute('href', `/site.webmanifest${assetVersion}`);
  }, [theme]);
  function select(value: ThemePreference) {
    setPreference(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      /* Retain the selection in this tab. */
    }
  }
  return <ThemeContext.Provider value={{ preference, select }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('ThemeToggle requires ThemeProvider');
  return theme;
}
