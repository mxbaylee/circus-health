import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { SelectionChip } from './SelectionChip';
import './creatable-combobox.css';

type Choice = { kind: 'existing'; value: string } | { kind: 'create'; value: string };

export function CreatableCombobox({
  label,
  values,
  options,
  multiple = false,
  disabled = false,
  maxLength,
  placeholder = 'Choose or add a value',
  listLabel = label,
  createNoun = 'value',
  hideLabel = false,
  onChange,
}: {
  label: string;
  values: string[];
  options: string[];
  multiple?: boolean;
  disabled?: boolean;
  maxLength?: number;
  placeholder?: string;
  listLabel?: string;
  createNoun?: string;
  hideLabel?: boolean;
  onChange: (values: string[]) => boolean | void;
}) {
  const inputId = useId();
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const focusInputOnOpen = useRef(false);
  const restoreChipFocus = useRef(false);
  const [editing, setEditing] = useState(multiple || !values[0]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const canonicalOptions = useMemo(() => {
    const seen = new Set<string>();
    return [...options, ...values].filter((option) => {
      const key = option.trim().toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [options, values]);
  const selectedKeys = new Set(values.map((value) => value.toLocaleLowerCase()));
  const trimmed = query.trim();
  const exact = canonicalOptions.find(
    (option) => option.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  const matching = canonicalOptions.filter(
    (option) =>
      option.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase()) &&
      (!multiple || !selectedKeys.has(option.toLocaleLowerCase())),
  );
  if (exact) matching.sort((left, right) => (left === exact ? -1 : right === exact ? 1 : 0));
  const choices: Choice[] = [
    ...matching.map((option): Choice => ({ kind: 'existing', value: option })),
    ...(trimmed && !exact ? ([{ kind: 'create', value: trimmed }] as Choice[]) : []),
  ];
  const active = activeIndex >= 0 ? choices[activeIndex] : undefined;

  useEffect(() => {
    if (editing && focusInputOnOpen.current) {
      focusInputOnOpen.current = false;
      input.current?.focus();
      input.current?.select();
    } else if (!editing && restoreChipFocus.current) {
      restoreChipFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  function positionMenu() {
    const bounds = input.current?.getBoundingClientRect();
    const target = menu.current;
    if (!bounds || !target) return;
    const gap = 5;
    const viewportPadding = 12;
    const viewportTop = window.visualViewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (window.visualViewport?.height || window.innerHeight);
    const below = Math.max(0, viewportBottom - bounds.bottom - gap - viewportPadding);
    const above = Math.max(0, bounds.top - viewportTop - gap - viewportPadding);
    const desired = Math.min(230, choices.length ? choices.length * 44 + 10 : 54);
    const placement = below < desired && above > below ? 'above' : 'below';
    const maxHeight = Math.floor(Math.min(230, placement === 'above' ? above : below));
    target.classList.toggle('above', placement === 'above');
    target.classList.toggle('below', placement === 'below');
    target.style.maxHeight = `${maxHeight}px`;
  }

  useLayoutEffect(() => {
    if (open) positionMenu();
  });

  useEffect(() => {
    if (!open) return;
    const position = () => positionMenu();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [choices.length, open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document
      .getElementById(`${listId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, listId, open]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        !open ||
        !root.current?.contains(document.activeElement)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [multiple, open, values]);

  function focusInput(nextQuery = '') {
    focusInputOnOpen.current = true;
    setEditing(true);
    setQuery(nextQuery);
    setOpen(true);
    setActiveIndex(0);
  }

  function commit(choice: Choice) {
    const next = multiple ? [...values, choice.value] : [choice.value];
    if (onChange(next) === false) return;
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
    if (multiple) input.current?.focus();
    else {
      setEditing(false);
      restoreChipFocus.current = true;
    }
  }

  function remove(value: string) {
    if (onChange(values.filter((item) => item !== value)) === false) return;
    if (multiple) input.current?.focus();
    else focusInput();
  }

  function cancel() {
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
    if (!multiple && values[0]) {
      restoreChipFocus.current = true;
      setEditing(false);
    }
  }

  return (
    <div
      className={`note-field creatable-field${multiple ? ' multiple' : ''}`}
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && root.current?.contains(event.relatedTarget)) return;
        setQuery('');
        setOpen(false);
        setActiveIndex(-1);
        if (!multiple && values[0]) setEditing(false);
      }}
    >
      <label className={hideLabel ? 'sr-only' : undefined} htmlFor={inputId}>
        {label}
      </label>
      {multiple && values.length > 0 && (
        <div className="creatable-selection-chips">
          {values.map((value) => (
            <SelectionChip
              label={value}
              key={value}
              disabled={disabled}
              removeLabel={`Remove ${createNoun} ${value}`}
              onRemove={() => remove(value)}
            />
          ))}
        </div>
      )}
      {!multiple && !editing && values[0] ? (
        <SelectionChip
          label={values[0]}
          disabled={disabled}
          editButtonRef={editButton}
          editLabel={`Edit ${createNoun} ${values[0]}`}
          removeLabel={`Clear ${createNoun} ${values[0]}`}
          onEdit={() => focusInput(values[0])}
          onRemove={() => remove(values[0])}
        />
      ) : (
        <div className="creatable-combobox">
          <input
            ref={input}
            id={inputId}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open && active ? `${listId}-option-${activeIndex}` : undefined}
            autoComplete="off"
            maxLength={maxLength}
            value={query}
            disabled={disabled}
            placeholder={placeholder}
            onFocus={() => {
              setOpen(true);
              setActiveIndex(0);
            }}
            onClick={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
                return;
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
                if (!choices.length) return;
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                setActiveIndex((current) => {
                  if (current < 0) return direction > 0 ? 0 : choices.length - 1;
                  return (current + direction + choices.length) % choices.length;
                });
                return;
              }
              if (event.key === 'Enter' && open && active) {
                event.preventDefault();
                commit(active);
              }
            }}
          />
          {open && (
            <div
              ref={menu}
              className="creatable-options below"
              id={listId}
              role="listbox"
              aria-label={listLabel}
              style={{ maxHeight: 230 }}
            >
              {choices.length ? (
                choices.map((choice, index) => (
                  <button
                    type="button"
                    role="option"
                    id={`${listId}-option-${index}`}
                    aria-selected={index === activeIndex}
                    tabIndex={-1}
                    className={choice.kind === 'create' ? 'creatable-create' : undefined}
                    key={`${choice.kind}:${choice.value.toLocaleLowerCase()}`}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => commit(choice)}
                  >
                    {choice.kind === 'create' ? (
                      <>
                        <Plus size={15} aria-hidden="true" /> Add “{choice.value}” as a new{' '}
                        {createNoun}
                      </>
                    ) : (
                      choice.value
                    )}
                  </button>
                ))
              ) : (
                <p>No matching {createNoun}s</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
