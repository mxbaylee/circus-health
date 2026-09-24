import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RelatedNotes } from '../../app/components/RelatedNotes';
import { selectProfile } from '../../app/data/profile';

it('comments render complete legacy Markdown and offer a read-only exact source tab', async () => {
  selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
  const content =
    '# Comment heading\n\n- First point\n- Second point\n\n' +
    'Long context. '.repeat(30) +
    '\n\n**Last words**';
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'note-comment',
              title: 'Appointment notes',
              content,
              textFormats: { content: 'plain-v1' },
              status: 'finished',
              archived: false,
              updatedAt: '2026-09-11',
              attachmentCount: 1,
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const { container } = render(
    <MemoryRouter>
      <RelatedNotes targetType="test_type" targetId="hdl" />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { name: 'Comment heading' })).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('Last words')).toBeInTheDocument();
  expect(container.querySelector('[contenteditable=true]')).toBeNull();
  const field = screen.getByRole('region', { name: 'Content' }),
    user = userEvent.setup();
  await user.click(within(field).getByRole('tab', { name: 'Markdown' }));
  expect(within(field).getByRole('textbox')).toHaveValue(content);
  expect(within(field).getByRole('textbox')).toHaveAttribute('readonly');
  await user.click(within(field).getByRole('tab', { name: 'Formatted' }));
  expect(screen.getByRole('heading', { name: 'Comment heading' })).toBeInTheDocument();
  expect(fetcher.mock.calls).toHaveLength(1);
});
