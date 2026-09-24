import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../data/api';
import {
  currentProfile,
  replaceProfiles,
  selectProfile,
  useProfile,
  useProfiles,
} from '../data/profile';
import type { Profile } from '../data/profile';
import '../clinical.css';
import { ProfileManagement } from './ProfileManagement';
import { ThemeProvider } from './ThemeProvider';
import { ThemeToggle } from './ThemeToggle';
import { ConnectionStatus } from './ConnectionStatus';
import { LoadingIndicator } from './LoadingIndicator';
import { connectionSnapshot, subscribeConnection } from '../data/connection';
import { BrandMark } from './BrandMark.generated';

export { useProfile } from '../data/profile';
export function ProfileProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ProfileSession>{children}</ProfileSession>
    </ThemeProvider>
  );
}

function ProfileSession({ children }: { children: ReactNode }) {
  const profiles = useProfiles();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const profile = useProfile();
  useEffect(() => {
    let recovered = connectionSnapshot().recoveries;
    return subscribeConnection(() => {
      const next = connectionSnapshot().recoveries;
      if (next !== recovered) {
        recovered = next;
        setError('');
        setRevision((value) => value + 1);
      }
    });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<Profile[]>('/profiles', { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        replaceProfiles(data);
        if (loaded) return;
        let remembered: string | null = null;
        try {
          remembered = localStorage.getItem('health-profile');
        } catch {
          /* Storage may be unavailable. */
        }
        const selected =
          data.find((item) => item.id === currentProfile()?.id && !item.locked) ??
          data.find((item) => item.id === remembered && !item.locked) ??
          data.find((item) => !item.locked);
        if (selected) selectProfile(selected);
        setLoaded(true);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof ApiError ? error.message : 'Unable to reach the local server.');
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!loaded) return;
    let controller: AbortController | undefined;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      api<Profile[]>('/profiles', { signal: request.signal })
        .then(({ data }) => {
          // Refresh lock state after another tab opens a profile, without selecting it here.
          if (!request.signal.aborted) replaceProfiles(data);
        })
        .catch(() => {
          /* Keep the current screen available during a transient outage. */
        });
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller?.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loaded]);
  if (!profile || !profiles.length)
    return (
      <main className="profile-startup">
        <div className="profile-startup-controls">
          <ConnectionStatus />
          <ThemeToggle />
        </div>
        <section className="profile-startup-welcome" aria-labelledby="profile-startup-title">
          <BrandMark className="profile-startup-logo" decorative />
          <h1 id="profile-startup-title">Circus Health</h1>
          <p className="profile-startup-tagline">Your circus, your monkeys, all under one tent.</p>
          {error ? (
            <div className="profile-startup-action">
              <p role="alert">{error}</p>
              <button
                className="button primary"
                onClick={() => {
                  setError('');
                  setRevision((value) => value + 1);
                }}
              >
                Try again
              </button>
            </div>
          ) : loaded ? (
            <div className="profile-startup-action">
              <p>
                {profiles.length
                  ? 'Choose a profile to open your private health archive.'
                  : 'Create a profile to start your private health archive.'}
              </p>
              <ProfileManagement
                initialMode={profiles.length ? 'list' : 'create'}
                triggerLabel={profiles.length ? 'Choose profile' : 'Create profile'}
              />
            </div>
          ) : (
            <div className="profile-startup-action">
              <LoadingIndicator label="Opening local profiles…" layout="centered" />
            </div>
          )}
        </section>
      </main>
    );
  // Every page, draft and dialog remounts, so another profile cannot inherit view state.
  return (
    <div key={profile.id} className="profile-root">
      {children}
    </div>
  );
}

export function ProfileSwitcher({
  onBack,
  backLabel,
}: { onBack?: () => void; backLabel?: string } = {}) {
  return <ProfileManagement onBack={onBack} backLabel={backLabel} />;
}
