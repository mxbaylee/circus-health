import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { Attachment } from '../../shared/api';
import { AttachmentPanel } from '../../app/features/notes/AttachmentPanel';
import { selectProfile } from '../../app/data/profile';

vi.mock('../../app/components/PdfPreview', () => ({ PdfPreview: () => null }));

function setup(optionalValue: null | '' = null, failFirstSave = false) {
  selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
  let attachment: Attachment = {
    id: 'attachment-fictional',
    assetId: 'asset-fictional',
    ownerType: 'note',
    ownerId: 'note-fictional',
    caption: 'Original caption',
    bodyLocation: optionalValue,
    eventDate: optionalValue,
    personId: null,
    createdAt: '2026-09-01T12:00:00Z',
    asset: {
      id: 'asset-fictional',
      originalName: 'fictional.pdf',
      mimeType: 'application/pdf',
      bytes: 1024,
      sha256: 'fictional-hash',
      createdAt: '2026-09-01T12:00:00Z',
      attribution: 'Fictional fixture',
      contentUrl: '/assets/asset-fictional/content',
    },
  };
  const patches: Record<string, unknown>[] = [];
  const response = (data: unknown) =>
    new Response(JSON.stringify({ data }), {
      headers: { 'Content-Type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/attachments?')) return response([attachment]);
      if (url.endsWith('/attachments/attachment-fictional') && init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body));
        patches.push(patch);
        if (failFirstSave && patches.length === 1) {
          return new Response(JSON.stringify({ error: { message: 'Try saving again.' } }), {
            status: 500,
          });
        }
        attachment = { ...attachment, ...patch };
        return response(attachment);
      }
      if (url.endsWith('/notes/note-fictional'))
        return response({ id: 'note-fictional', version: 2 });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  render(<AttachmentPanel ownerType="note" ownerId="note-fictional" version={1} />);
  return { user: userEvent.setup(), patches };
}

it.each([null, ''] as const)(
  'disables unchanged and reverted metadata with optional fields stored as %j',
  async (value) => {
    const { user, patches } = setup(value);
    await user.click(await screen.findByRole('button', { name: 'Details' }));
    const dialog = screen.getByRole('dialog', { name: 'Attachment details' });
    const save = within(dialog).getByRole('button', { name: 'Save details' });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest('form')!);
    expect(patches).toHaveLength(0);
    const caption = within(dialog).getByLabelText('Caption');
    await user.type(caption, ' updated');
    expect(save).toBeEnabled();
    await user.clear(caption);
    await user.type(caption, 'Original caption');
    expect(save).toBeDisabled();
    const location = within(dialog).getByLabelText('Body location, if relevant');
    await user.type(location, ' ');
    expect(save).toBeEnabled(); // The server preserves whitespace in optional text.
    await user.clear(location);
    expect(save).toBeDisabled();
    const date = within(dialog).getByLabelText(/^Photo taken \/ event date/);
    fireEvent.change(date, { target: { value: '2026-09-01' } });
    expect(save).toBeEnabled();
    fireEvent.change(date, { target: { value: '' } });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest('form')!);
    expect(patches).toHaveLength(0);
  },
);

it('keeps changed details retryable after a failed save and disables them after success', async () => {
  const { user, patches } = setup(null, true);
  await user.click(await screen.findByRole('button', { name: 'Details' }));
  const dialog = screen.getByRole('dialog', { name: 'Attachment details' });
  await user.type(within(dialog).getByLabelText('Caption'), ' updated');
  await user.click(within(dialog).getByRole('button', { name: 'Save details' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Try saving again.');
  expect(within(dialog).getByRole('button', { name: 'Save details' })).toBeEnabled();
  expect(within(dialog).getByLabelText('Caption')).toHaveValue('Original caption updated');
  await user.click(within(dialog).getByRole('button', { name: 'Save details' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Attachment details' })).not.toBeInTheDocument(),
  );
  expect(patches).toEqual([
    { caption: 'Original caption updated', bodyLocation: null, eventDate: null, version: 1 },
    { caption: 'Original caption updated', bodyLocation: null, eventDate: null, version: 1 },
  ]);
  await screen.findByText('Original caption updated');
  await user.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByRole('button', { name: 'Save details' })).toBeDisabled();
});

it('keeps an unresolved failed save retryable after reverting to the displayed baseline', async () => {
  const { user, patches } = setup(null, true);
  await user.click(await screen.findByRole('button', { name: 'Details' }));
  const dialog = screen.getByRole('dialog', { name: 'Attachment details' });
  const caption = within(dialog).getByLabelText('Caption');
  await user.type(caption, ' updated');
  await user.click(within(dialog).getByRole('button', { name: 'Save details' }));
  await within(dialog).findByRole('alert');
  fireEvent.change(caption, { target: { value: 'Original caption' } });
  expect(within(dialog).getByRole('button', { name: 'Save details' })).toBeEnabled();
  await user.click(within(dialog).getByRole('button', { name: 'Save details' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(patches).toHaveLength(2);
  expect(patches[1].caption).toBe('Original caption');
});
