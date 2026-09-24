import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { NoteDialog } from '../../app/features/notes/NoteDialog';
import { PersonIconPicker } from '../../app/components/PersonIcon';
it('Back returns to the parent view without closing; Escape restores the root trigger', async () => {
  function Flow() {
    const [open, setOpen] = useState(false),
      [child, setChild] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open flow</button>
        <NoteDialog
          open={open}
          onOpenChange={setOpen}
          title={child ? 'Child' : 'Parent'}
          description="Fictional flow"
          onBack={child ? () => setChild(false) : undefined}
          backLabel="Back to parent"
        >
          {!child && <button onClick={() => setChild(true)}>Next</button>}
        </NoteDialog>
      </>
    );
  }
  const user = userEvent.setup();
  render(<Flow />);
  const trigger = screen.getByRole('button', { name: 'Open flow' });
  await user.click(trigger);
  expect(screen.queryByRole('button', { name: /Back/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Back to parent' }));
  expect(screen.getByRole('dialog', { name: 'Parent' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});
it('Back is unavailable while its caller is committing', async () => {
  const onBack = vi.fn();
  render(
    <NoteDialog
      open
      onOpenChange={() => {}}
      title="Busy child"
      description="Fictional save"
      onBack={onBack}
      backDisabled
    >
      Saving
    </NoteDialog>,
  );
  const back = screen.getByRole('button', { name: 'Back' });
  expect(back).toBeDisabled();
  await userEvent.click(back);
  expect(onBack).not.toHaveBeenCalled();
});
it('nested icon Back and Escape return to the parent without changing its icon', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <NoteDialog open onOpenChange={() => {}} title="Profile details" description="Fictional setup">
      <PersonIconPicker value="person" onChange={onChange} backLabel="Back to profile details" />
    </NoteDialog>,
  );
  const trigger = screen.getByRole('button', { name: /Choose person icon/ });
  await user.click(trigger);
  await user.type(screen.getByRole('textbox', { name: 'Search icons' }), 'flower');
  await user.click(screen.getByRole('button', { name: 'Back to profile details' }));
  await waitFor(() =>
    expect(screen.getByRole('dialog', { name: 'Profile details' })).toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  expect(onChange).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.keyboard('{Escape}');
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Choose an icon' })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('dialog', { name: 'Profile details' })).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});
