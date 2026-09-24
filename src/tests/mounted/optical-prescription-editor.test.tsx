import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { OpticalPrescriptionEditor } from '../../app/components/OpticalPrescriptionEditor';
import type { OpticalPrescription } from '../../shared/vision';
const initial: OpticalPrescription = {
  type: 'unknown',
  typeText: 'Distance lenses',
  statusText: 'Released to patient',
  prescribedDateText: '03/04/??',
  eyes: [
    {
      side: 'unknown',
      sph: { valueText: '+01.00' },
      axis: { valueText: '005' },
      cyl: { valueText: '-0.50', unit: 'D' },
    },
  ],
};
function Controlled({ changed }: { changed: (next: OpticalPrescription | null) => void }) {
  const [value, setValue] = useState<OpticalPrescription | null>(initial);
  return value ? (
    <OpticalPrescriptionEditor
      prescription={value}
      onChange={(next) => {
        changed(next);
        setValue(next);
      }}
    />
  ) : (
    <p>Mapping removed</p>
  );
}
it('preserves literal signs, zeros, dates and absent units through controlled edits', async () => {
  const changed = vi.fn();
  const user = userEvent.setup();
  render(<Controlled changed={changed} />);
  await user.clear(screen.getByLabelText('SPH value, as written'));
  await user.type(screen.getByLabelText('SPH value, as written'), '-00.00');
  await user.selectOptions(screen.getByLabelText('Side'), 'both');
  await user.type(screen.getByLabelText('Side label, as written'), 'OU?');
  await user.selectOptions(screen.getByLabelText('Prescription type'), 'contact_lens');
  await user.clear(screen.getByLabelText('Prescription type, as written'));
  await user.type(screen.getByLabelText('Prescription type, as written'), 'Daily lenses');
  await user.clear(screen.getByLabelText('Prescription status, as written'));
  await user.type(
    screen.getByLabelText('Prescription status, as written'),
    'Final - copy supplied',
  );
  await user.click(screen.getByText('Add other optical values'));
  await user.click(screen.getByRole('button', { name: 'Add Base curve' }));
  await user.type(screen.getByLabelText('Base curve value, as written'), '08.60');
  await user.click(screen.getByRole('button', { name: 'Add PD (not side specific)' }));
  await user.type(screen.getByLabelText('PD (not side specific) value, as written'), '063');
  expect(changed.mock.lastCall?.[0]).toEqual({
    ...initial,
    type: 'contact_lens',
    typeText: 'Daily lenses',
    statusText: 'Final - copy supplied',
    eyes: [
      {
        ...initial.eyes[0],
        side: 'both',
        sideText: 'OU?',
        sph: { valueText: '-00.00' },
        baseCurve: { valueText: '08.60' },
      },
    ],
    pd: { valueText: '063' },
  });
  await user.clear(screen.getByLabelText('CYL unit, if stated'));
  expect(changed.mock.lastCall?.[0].eyes[0].cyl).toEqual({ valueText: '-0.50' });
  await user.click(screen.getByRole('button', { name: 'Remove Axis' }));
  expect(changed.mock.lastCall?.[0].eyes[0]).not.toHaveProperty('axis');
  await user.click(screen.getByRole('button', { name: 'Remove PD (not side specific)' }));
  expect(changed.mock.lastCall?.[0]).not.toHaveProperty('pd');
  await user.clear(screen.getByLabelText('Prescription status, as written'));
  expect(changed.mock.lastCall?.[0]).not.toHaveProperty('statusText');
});
it('adds unknown entries and removes individual entries or the mapping', async () => {
  const changed = vi.fn();
  const user = userEvent.setup();
  render(<Controlled changed={changed} />);
  await user.click(screen.getByRole('button', { name: 'Add eye entry' }));
  expect(changed.mock.lastCall?.[0].eyes).toEqual([...initial.eyes, { side: 'unknown' }]);
  await user.selectOptions(
    within(screen.getByRole('group', { name: 'Eye entry 2' })).getByLabelText('Side'),
    'left',
  );
  await user.click(screen.getByRole('button', { name: 'Remove eye entry 1' }));
  expect(changed.mock.lastCall?.[0].eyes).toEqual([{ side: 'left' }]);
  await user.click(screen.getByRole('button', { name: 'Remove optical mapping' }));
  expect(changed.mock.lastCall).toEqual([null]);
  expect(screen.getByText('Mapping removed')).toBeVisible();
});
it('enforces the entry limit and disables mutations', async () => {
  const changed = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <OpticalPrescriptionEditor
      prescription={{
        ...initial,
        eyes: Array.from({ length: 20 }, () => ({ side: 'unknown' as const })),
      }}
      onChange={changed}
    />,
  );
  expect(screen.getByRole('button', { name: 'Add eye entry' })).toBeDisabled();
  rerender(<OpticalPrescriptionEditor prescription={initial} onChange={changed} disabled />);
  for (const control of [
    ...screen.getAllByRole('textbox'),
    ...screen.getAllByRole('combobox'),
    ...screen.getAllByRole('button'),
  ])
    expect(control).toBeDisabled();
  await user.type(screen.getByLabelText('SPH value, as written'), '123');
  await user.click(screen.getByRole('button', { name: 'Remove optical mapping' }));
  expect(changed).not.toHaveBeenCalled();
});
