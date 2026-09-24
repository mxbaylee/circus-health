import { DynamicIcon, type IconName } from 'lucide-react/dynamic';
import {
  ICON_CATALOG,
  ICON_CATEGORIES,
  searchPersonIcons,
  type IconChoice,
} from '../../shared/person-icon-search';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, ChevronDown, Search, X } from 'lucide-react';
import {
  Bird,
  Cat,
  Cookie,
  Crown,
  Dog,
  Flower2,
  Heart,
  Moon,
  Sparkles,
  Star,
  Stethoscope,
  Sun,
  UserRound,
} from 'lucide-react';
import { lucidePersonIcon, validPersonIcon } from '../../shared/person-icon';
import './person-icon.css';
const icons = {
  person: UserRound,
  star: Star,
  moon: Moon,
  sun: Sun,
  heart: Heart,
  sparkles: Sparkles,
  flower: Flower2,
  cat: Cat,
  dog: Dog,
  bird: Bird,
  cookie: Cookie,
  crown: Crown,
  stethoscope: Stethoscope,
};
export function PersonIcon({ value, size = 21 }: { value?: string; size?: number }) {
  const Icon = icons[value as keyof typeof icons];
  const name = lucidePersonIcon(value || '');
  if (name && !Icon && value)
    return (
      <DynamicIcon
        key={name}
        name={name as IconName}
        size={size}
        strokeWidth={1.6}
        aria-hidden="true"
        fallback={() => <UserRound size={size} aria-hidden="true" />}
      />
    );
  if (Icon || !value || !validPersonIcon(value)) {
    const Symbol = Icon || UserRound;
    return <Symbol aria-hidden="true" size={size} strokeWidth={1.6} />;
  }
  return (
    <span
      className="person-emoji"
      aria-hidden="true"
      style={{ fontSize: size, width: size, height: size }}
    >
      {value}
    </span>
  );
}
export function PersonIconPicker({
  value = '',
  onChange,
  disabled,
  backLabel,
}: {
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  backLabel?: string;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [category, setCategory] = useState('All');
  const [position, setPosition] = useState({ top: 16, left: 16 });
  const trigger = useRef<HTMLButtonElement>(null),
    search = useRef<HTMLInputElement>(null),
    grid = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(60);
  const selectedName = lucidePersonIcon(value);
  const selected = ICON_CATALOG.find((choice) => choice.name === selectedName);
  const label = selected?.label || 'Previous emoji';
  const matches = useMemo(() => searchPersonIcons(query, category), [query, category]);
  const visible = matches.slice(0, limit);
  useEffect(() => {
    setLimit(60);
    if (grid.current) grid.current.scrollTop = 0;
  }, [query, category]);
  function placePicker() {
    const rect = trigger.current?.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const height = Math.min(490, viewportHeight - 32),
      width = Math.min(520, window.innerWidth - 32);
    setPosition({
      left: Math.max(16, Math.min(rect?.left || 16, window.innerWidth - width - 16)),
      top: Math.max(16, Math.min((rect?.bottom || 8) + 8, viewportHeight - height - 16)),
    });
  }
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', placePicker);
    window.visualViewport?.addEventListener('resize', placePicker);
    return () => {
      window.removeEventListener('resize', placePicker);
      window.visualViewport?.removeEventListener('resize', placePicker);
    };
  }, [open]);
  function changeOpen(next: boolean) {
    if (next) {
      placePicker();
      setQuery('');
      setCategory('All');
      setLimit(60);
    }
    setOpen(next);
  }
  function choose(choice: IconChoice) {
    onChange(choice.value);
    setOpen(false);
  }
  function move(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const buttons = [...(grid.current?.querySelectorAll<HTMLButtonElement>('button') || [])];
    const columns = grid.current
      ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').length
      : 6;
    const delta: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns,
    };
    if (event.key === 'Home' || event.key === 'End' || event.key in delta) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : Math.max(0, Math.min(buttons.length - 1, index + delta[event.key]));
      buttons[next]?.focus();
    }
  }
  return (
    <div className="person-icon-picker">
      <span className="person-icon-label">Person icon</span>
      <Dialog.Root open={open} onOpenChange={changeOpen}>
        <Dialog.Trigger asChild>
          <button
            ref={trigger}
            type="button"
            className="person-icon-trigger"
            disabled={disabled}
            aria-label={`Choose person icon: ${label}`}
          >
            <PersonIcon value={value} />
            <span>{label}</span>
            <ChevronDown size={16} />
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="person-icon-overlay" />
          <Dialog.Content
            className="person-icon-popover"
            style={position}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              search.current?.focus();
            }}
          >
            {backLabel && (
              <button type="button" className="button secondary" onClick={() => changeOpen(false)}>
                <ArrowLeft size={16} aria-hidden="true" />
                {backLabel}
              </button>
            )}
            <div className="person-icon-popover-heading">
              <Dialog.Title>Choose an icon</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-button" aria-label="Close icon picker">
                  <X size={18} />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">
              Search Lucide icon names, descriptions and categories, then choose one. Arrow keys
              move between results. Escape closes without changes.
            </Dialog.Description>
            <div className="person-icon-search-row">
              <label className="person-icon-search">
                <Search size={18} />
                <input
                  ref={search}
                  aria-label="Search icons"
                  placeholder="Search icons…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      grid.current?.querySelector<HTMLButtonElement>('button')?.focus();
                    }
                    if (event.key === 'Enter' && matches.length === 1) {
                      event.preventDefault();
                      choose(visible[0]);
                    }
                  }}
                />
              </label>
              <select
                aria-label="Icon category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option>All</option>
                {ICON_CATEGORIES.map((name) => (
                  <option key={name} value={name}>
                    {name[0].toUpperCase() + name.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <p className="person-icon-result-count" role="status">
              {matches.length} {matches.length === 1 ? 'result' : 'results'}
            </p>
            <div ref={grid} className="person-icon-grid" role="group" aria-label="Icon results">
              {visible.map((choice, index) => (
                <button
                  type="button"
                  key={choice.value}
                  aria-label={`${choice.label} icon`}
                  aria-pressed={selected?.canonicalName === choice.canonicalName}
                  title={[choice.label, ...choice.tags].join(' · ')}
                  onClick={() => choose(choice)}
                  onKeyDown={(event) => move(event, index)}
                >
                  <PersonIcon value={choice.value} size={28} />
                  <span>{choice.label}</span>
                </button>
              ))}
            </div>
            {matches.length > limit && (
              <button
                type="button"
                className="text-link person-icon-more"
                onClick={() => setLimit((current) => current + 60)}
              >
                Show more icons ({limit} of {matches.length})
              </button>
            )}
            {!visible.length && (
              <p className="person-icon-empty">No icons match. Try another name or description.</p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
