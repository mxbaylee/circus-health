import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { NoteTypeCombobox } from '../../app/features/notes/NoteTypeCombobox';
import { NoteDialog } from '../../app/features/notes/NoteDialog';

function Harness({ initial = 'Therapist' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <NoteTypeCombobox
        value={value}
        options={['Therapy', 'Primary care', 'Specialist', 'Therapist']}
        onChange={setValue}
      />
      <output aria-label="Committed type">{value}</output>
      <button type="button">Outside</button>
    </>
  );
}

it('filters reusable choices and navigates them without treating similar types as equivalent', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Edit type Therapist' }));
  const input = screen.getByRole('combobox', { name: 'Type' });
  await user.clear(input);
  await user.type(input, 'ther');
  expect(screen.getByRole('option', { name: 'Therapy' })).toBeVisible();
  expect(screen.getByRole('option', { name: 'Therapist' })).toBeVisible();
  expect(screen.getByRole('option', { name: /Add “ther” as a new type/ })).toBeVisible();
  await user.keyboard('{ArrowDown}{Enter}');
  expect(screen.getByText('Therapist', { selector: '.selection-chip-label' })).toBeVisible();
  expect(screen.getByLabelText('Committed type')).toHaveTextContent('Therapist');
});

it('suggests Dr. Visit without selecting it until explicitly chosen', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<NoteTypeCombobox value="" options={[]} onChange={onChange} />);
  await user.click(screen.getByRole('combobox', { name: 'Type' }));
  expect(screen.getByRole('option', { name: 'Dr. Visit' })).toBeVisible();
  expect(onChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole('option', { name: 'Dr. Visit' }));
  expect(onChange).toHaveBeenCalledWith('Dr. Visit');
});

it('reuses an existing Dr. Visit spelling without duplicate suggestions or an Add option', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<NoteTypeCombobox value="" options={['DR. VISIT']} onChange={onChange} />);
  await user.type(screen.getByRole('combobox', { name: 'Type' }), 'dr. visit');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  await user.click(screen.getByRole('option', { name: 'DR. VISIT' }));
  expect(onChange).toHaveBeenCalledWith('DR. VISIT');
});

it('reuses the canonical display for an exact case-insensitive match and suppresses Create', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Edit type Therapist' }));
  const input = screen.getByRole('combobox', { name: 'Type' });
  await user.clear(input);
  await user.type(input, 'therapy');
  expect(screen.queryByRole('option', { name: /Add .* as a new type/ })).not.toBeInTheDocument();
  await user.keyboard('{Enter}');
  expect(screen.getByLabelText('Committed type')).toHaveTextContent('Therapy');
  expect(screen.getByRole('button', { name: 'Edit type Therapy' })).toHaveFocus();
});

it('requires the explicit Add option to commit a new type and Escape discards partial text', async () => {
  const user = userEvent.setup();
  render(<Harness initial="Primary care" />);
  await user.click(screen.getByRole('button', { name: 'Edit type Primary care' }));
  const input = screen.getByRole('combobox', { name: 'Type' });
  await user.clear(input);
  await user.type(input, 'Care planning');
  expect(screen.getByLabelText('Committed type')).toHaveTextContent('Primary care');
  await user.click(screen.getByRole('option', { name: /Add “Care planning” as a new type/ }));
  expect(screen.getByLabelText('Committed type')).toHaveTextContent('Care planning');

  await user.click(screen.getByRole('button', { name: 'Edit type Care planning' }));
  await user.clear(screen.getByRole('combobox', { name: 'Type' }));
  await user.type(screen.getByRole('combobox', { name: 'Type' }), 'Uncommitted');
  await user.keyboard('{Escape}');
  expect(screen.getByLabelText('Committed type')).toHaveTextContent('Care planning');
  expect(screen.getByRole('button', { name: 'Edit type Care planning' })).toHaveFocus();
});

it('clear commits an empty selection and reopens the choices', async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  function ClearHarness() {
    const [value, setValue] = useState('Specialist');
    return (
      <NoteTypeCombobox
        value={value}
        options={['Therapy', 'Specialist']}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  render(<ClearHarness />);
  await user.click(screen.getByRole('button', { name: 'Clear type Specialist' }));
  expect(changed).toHaveBeenCalledWith('');
  expect(screen.getByRole('combobox', { name: 'Type' })).toHaveFocus();
  expect(screen.getByRole('listbox', { name: 'Note types' })).toBeVisible();
});

it('disables both chip actions while the editor is busy', () => {
  render(
    <NoteTypeCombobox
      value="Therapy"
      options={['Therapy', 'Specialist']}
      disabled
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Edit type Therapy' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Clear type Therapy' })).toBeDisabled();
});

it('keeps a containing dialog open when Escape cancels the combobox query', async () => {
  const user = userEvent.setup();
  render(
    <NoteDialog
      open
      onOpenChange={vi.fn()}
      title="Convert to historical draft"
      description="Fictional conversion"
    >
      <NoteTypeCombobox
        value="Primary care"
        options={['Therapy', 'Primary care']}
        onChange={vi.fn()}
      />
    </NoteDialog>,
  );
  await user.click(screen.getByRole('button', { name: 'Edit type Primary care' }));
  await user.clear(screen.getByRole('combobox', { name: 'Type' }));
  await user.type(screen.getByRole('combobox', { name: 'Type' }), 'Uncommitted');
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog', { name: 'Convert to historical draft' })).toBeVisible();
  expect(screen.queryByRole('listbox', { name: 'Note types' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit type Primary care' })).toHaveFocus();
});

it('ignores Enter while an input method is composing and scrolls keyboard choices into view', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  render(
    <NoteTypeCombobox
      value=""
      options={Array.from({ length: 30 }, (_, index) => `Fictional type ${index + 1}`)}
      onChange={vi.fn()}
    />,
  );
  const input = screen.getByRole('combobox', { name: 'Type' });
  input.focus();
  await userEvent.setup().type(input, 'Brand new type');
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
  );
  expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('Brand new type');
  await userEvent.setup().clear(input);
  await userEvent.setup().keyboard('{ArrowUp}');
  expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option').at(-1)!.id);
  expect(scrollIntoView).toHaveBeenCalled();
});

it('repositions the choices above the input when the viewport has no room below', async () => {
  render(<NoteTypeCombobox value="" options={['Therapy', 'Specialist']} onChange={vi.fn()} />);
  const input = screen.getByRole('combobox', { name: 'Type' });
  let top = 100;
  vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        top,
        bottom: top + 44,
        left: 0,
        right: 300,
        width: 300,
        height: 44,
        x: 0,
        y: top,
        toJSON: () => {},
      }) as DOMRect,
  );
  const previousHeight = window.innerHeight;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
  fireEvent.focus(input);
  const list = screen.getByRole('listbox', { name: 'Note types' });
  expect(list).toHaveClass('below');
  top = 540;
  window.dispatchEvent(new Event('resize'));
  expect(list).toHaveClass('above');
  expect(list).toHaveStyle({ maxHeight: '230px' });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: previousHeight });
});
