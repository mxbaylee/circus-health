import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { PersonIconPicker } from '../../app/components/PersonIcon';

it('keeps the direct heartbeat match first and selects a supplemental match by keyboard', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<PersonIconPicker value="moon" onChange={onChange} />);
  await user.click(screen.getByRole('button', { name: 'Choose person icon: Moon' }));
  const search = screen.getByRole('textbox', { name: 'Search icons' });
  await user.type(search, 'heartbeat');
  const results = within(screen.getByRole('group', { name: 'Icon results' }));
  expect(results.getAllByRole('button')[0]).toHaveAccessibleName('Heart Pulse icon');
  expect(results.getByRole('button', { name: 'Activity icon' })).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
  await user.clear(search);
  await user.type(search, 'cardiogram');
  await user.keyboard('{ArrowDown}');
  expect(results.getByRole('button', { name: 'Activity icon' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(onChange).toHaveBeenCalledExactlyOnceWith('lucide:activity');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('highlights a saved alias through its canonical icon without silently replacing its value', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<PersonIconPicker value="lucide:alarm-check" onChange={onChange} />);
  const trigger = screen.getByRole('button', { name: 'Choose person icon: Alarm Check' });
  await user.click(trigger);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Icon category' }), 'time');
  await user.type(screen.getByRole('textbox', { name: 'Search icons' }), 'alarm');
  expect(screen.getByRole('button', { name: 'Alarm Clock Check icon' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('button', { name: 'Alarm Check icon' })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(onChange).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});
