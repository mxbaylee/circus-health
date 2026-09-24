import { ConnectionStatus } from './ConnectionStatus';
import { PersonIcon } from './PersonIcon';
import { StorageNotice } from './StorageNotice';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import {
  FlaskConical,
  Pill,
  Bandage,
  UserRound,
  UsersRound,
  BookHeart,
  Link2,
  Menu,
  X,
  Upload,
} from 'lucide-react';
import { Brand, HarlequinAccent } from './Brand';
import { ThemeToggle } from './ThemeToggle';
import { ProfileSwitcher, useProfile } from './ProfileProvider';
import { AssistantPageProvider } from '../features/assistant/pageContext';
import { AssistantLauncher } from '../features/assistant/AssistantLauncher';

const navigation = [
  { label: 'Self', icon: UserRound, href: '/', profileLabel: true },
  { label: 'Test results', icon: FlaskConical, href: '/tests' },
  { label: 'Prescriptions', icon: Pill, href: '/medications' },
  { label: 'Procedures', icon: Bandage, href: '/procedures' },
  { label: 'Notes', icon: BookHeart, href: '/notes' },
  { label: 'People', icon: UsersRound, href: '/people' },
  { label: 'Import', icon: Upload, href: '/import' },
  { label: 'Sources', icon: Link2, href: '/sources' },
];

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const profile = useProfile();
  const location = useLocation();
  const selfSelected =
    location.pathname === '/' ||
    (location.pathname === '/people' &&
      ['patient', 'person-note:self'].includes(
        new URLSearchParams(location.search).get('id') || '',
      ));
  return (
    <nav className="navigation" aria-label="Main navigation">
      {navigation.map(({ label: defaultLabel, icon: Icon, href, profileLabel }) => {
        const label = profileLabel ? profile?.name || 'Self' : defaultLabel;
        return href ? (
          <NavLink
            aria-label={profileLabel ? `${label} Self` : undefined}
            key={defaultLabel}
            to={href}
            end={href === '/'}
            onClick={onNavigate}
            aria-current={
              profileLabel
                ? selfSelected
                  ? 'page'
                  : false
                : href === '/people' && selfSelected
                  ? false
                  : undefined
            }
            className={({ isActive }) =>
              `nav-item ${(profileLabel ? selfSelected : href === '/people' ? isActive && !selfSelected : isActive) ? 'active' : ''}`
            }
          >
            {profileLabel ? (
              <PersonIcon value={profile?.icon} />
            ) : (
              <Icon size={21} strokeWidth={1.6} />
            )}
            <span className="nav-label">{label}</span>
            {profileLabel && <span className="self-tag">Self</span>}
          </NavLink>
        ) : (
          <button key={label} className="nav-item unavailable" disabled title="Not available">
            <Icon size={21} strokeWidth={1.6} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function SidebarFooter({ onBack, backLabel }: { onBack?: () => void; backLabel?: string }) {
  return (
    <div className="sidebar-footer">
      <ProfileSwitcher onBack={onBack} backLabel={backLabel} />
    </div>
  );
}

export function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const profile = useProfile();
  return (
    <AssistantPageProvider>
      <div className="app-shell">
        <a
          className="skip-link"
          href="#main-content"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById('main-content')?.focus();
          }}
        >
          Skip to content
        </a>
        <aside className="desktop-sidebar">
          <HarlequinAccent />
          <Brand />
          <Navigation />
          <SidebarFooter />
        </aside>
        <div className="app-main">
          <header className="topbar">
            <div className="mobile-brand">
              <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <Dialog.Trigger asChild>
                  <button className="icon-button" aria-label="Open navigation">
                    <Menu size={23} />
                  </button>
                </Dialog.Trigger>
                <Dialog.Portal>
                  <Dialog.Overlay className="dialog-overlay" />
                  <Dialog.Content className="nav-drawer">
                    <HarlequinAccent />
                    <div className="drawer-header">
                      <Brand compact />
                      <Dialog.Close asChild>
                        <button className="icon-button" aria-label="Close navigation">
                          <X size={22} />
                        </button>
                      </Dialog.Close>
                    </div>
                    <Dialog.Title className="sr-only">Navigation</Dialog.Title>
                    <Dialog.Description className="sr-only">
                      Explore records, notes, people and sources for the selected profile.
                    </Dialog.Description>
                    <Navigation onNavigate={() => setMenuOpen(false)} />
                    <SidebarFooter
                      onBack={() => setMenuOpen(true)}
                      backLabel="Back to navigation"
                    />
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
              <Brand compact />
            </div>
            <div className="theme-area">
              <AssistantLauncher />
              <ConnectionStatus />
              <ThemeToggle />
            </div>
          </header>
          <main id="main-content" tabIndex={-1}>
            <StorageNotice />
            <Outlet />
          </main>
          <footer className="page-footer">
            <span>
              {profile?.name} ·{' '}
              {profile?.placebo ? 'Entirely fictional placebo data' : 'Local personal archive'}
            </span>
            <span aria-hidden="true">✦</span>
          </footer>
        </div>
      </div>
    </AssistantPageProvider>
  );
}
