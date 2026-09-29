import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { SaveStatus, saveStatusLabel } from '../../app/components/SaveStatus';

it('distinguishes untouched, new, dirty, saving and acknowledged drafts', () => {
  const now = Date.parse('2026-09-28T10:00:00Z');
  const base = { exists: true, dirty: false, state: 'idle' as const };
  expect(saveStatusLabel(base, now)).toBe('All changes saved');
  expect(saveStatusLabel({ ...base, exists: false }, now)).toBe('Not saved yet');
  expect(saveStatusLabel({ ...base, dirty: true, savedAt: '2026-09-28T09:59:00Z' }, now)).toBe(
    'Unsaved changes',
  );
  expect(saveStatusLabel({ ...base, dirty: true, state: 'saving' }, now)).toBe('Saving…');
  expect(saveStatusLabel({ ...base, savedAt: '2026-09-28T09:57:00Z' }, now)).toBe(
    'Autosaved 3 minutes ago',
  );
  expect(
    saveStatusLabel({ ...base, savedAt: '2026-09-28T10:00:00Z', savedBy: 'manual' }, now),
  ).toBe('Saved just now');
});
it('does not present incomplete work as saved and exposes status without a tooltip', () => {
  const base = {
    exists: true,
    dirty: false,
    state: 'saved' as const,
    savedAt: new Date().toISOString(),
  };
  expect(saveStatusLabel({ ...base, state: 'error' })).toBe('Couldn’t save');
  expect(saveStatusLabel({ ...base, validation: 'Date needs correction' })).toBe(
    'Date needs correction',
  );
  expect(saveStatusLabel({ ...base, attachmentPending: true })).toBe('Attachment work pending');
  expect(saveStatusLabel({ ...base, portablePending: true })).toBe(
    'Saved locally · portable copy needs retry',
  );
  render(<SaveStatus {...base} />);
  expect(screen.getByRole('status')).toHaveTextContent('Autosaved just now');
});
