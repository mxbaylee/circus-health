import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { ImportManualSourceRecord } from '../../app/features/import/ImportManualSourceRecord';
import { selectProfile } from '../../app/data/profile';
import type { ManualSourceRecordRequest } from '../../shared/intake-manual-source-record';

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const result = {
  intake: { id: 'source-cookie' },
  proposalId: 'proposal-cookie',
  recordId: 'record-cookie',
  groupId: 'group-cookie',
  reviewUrl:
    '/import?intake=source-cookie&group=group-cookie&proposal=proposal-cookie&record=record-cookie',
  replayed: false,
};
const self = {
  id: 'person-note:self',
  title: 'Cookie',
  version: 2,
  isSelf: true,
  person: { fullName: 'Cookie Doe' },
};

function setup(
  post: (input: ManualSourceRecordRequest) => Promise<Response>,
  onCreated = vi.fn(),
  onPendingChange = vi.fn(),
) {
  selectProfile({ id: 'cookie-profile', name: 'Cookie', placebo: true });
  const requests: { url: string; method: string }[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method || 'GET' });
    if (url.endsWith('/source-records')) return post(JSON.parse(String(init?.body)));
    if (url.endsWith('/intakes/source-cookie'))
      return response({ id: 'source-cookie', version: 4, sha256: 'a'.repeat(64) });
    if (url.includes('/source-issues'))
      return response({ revisionId: 'cookie-revision', summary: { pages: 3 } });
    if (url.endsWith('/notes/patient')) return response(self);
    if (url.includes('/notes?')) return response([]);
    throw new Error(`Unexpected fictional request ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  render(
    <MemoryRouter>
      <ImportManualSourceRecord
        intakeId="source-cookie"
        page={2}
        onCreated={onCreated}
        onPendingChange={onPendingChange}
      />
    </MemoryRouter>,
  );
  return { requests, onCreated };
}
async function fill() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Add record from this section' }));
  await screen.findByRole('option', { name: 'Me (Self)' });
  expect(screen.getByRole('button', { name: 'Create review draft' })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText('Person'), self.id);
  await user.type(screen.getByLabelText('Label'), 'Cookie count');
  await user.type(screen.getByLabelText('Value as printed'), '12.50');
  await user.type(screen.getByLabelText('Unit (leave blank if unknown)'), 'units');
  await user.type(screen.getByLabelText('Literal source wording'), 'Cookie count: 12.50 units');
  return user;
}

it('creates only a review draft from a source page without model proposals', async () => {
  const posts: ManualSourceRecordRequest[] = [];
  const state = setup(async (request) => {
    posts.push(request);
    return response(result);
  });
  const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Create review draft' }));
  expect(await screen.findByRole('link', { name: 'Review the new record' })).toHaveAttribute(
    'href',
    result.reviewUrl,
  );
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    version: 4,
    sourceHash: 'a'.repeat(64),
    sourceTextRevisionId: 'cookie-revision',
    scope: { page: 2 },
    person: { kind: 'self', expectedVersion: 2 },
    literalText: 'Cookie count: 12.50 units',
    clinical: { kind: 'observation', testLabel: 'Cookie count', valueText: '12.50', unit: 'units' },
  });
  expect(
    state.requests.filter((request) => request.method === 'POST').map((request) => request.url),
  ).toEqual(['/api/profiles/cookie-profile/intakes/source-cookie/source-records']);
  expect(state.onCreated).toHaveBeenCalledWith(result);
  expect(
    screen.getByText('Review draft created. No clinical record has been saved.'),
  ).toBeVisible();
});

it('retries an uncertain manual creation with the exact same operation and request', async () => {
  const posts: ManualSourceRecordRequest[] = [];
  setup(async (request) => {
    posts.push(request);
    if (posts.length === 1) throw new Error('Fictional response lost');
    return response({ ...result, replayed: true });
  });
  const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Create review draft' }));
  expect(await screen.findByRole('button', { name: 'Retry draft creation' })).toBeEnabled();
  expect(screen.getByLabelText('Label')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Retry draft creation' }));
  await screen.findByRole('link', { name: 'Review the new record' });
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
});

it('retains edits on a source conflict and requires a fresh explicit person selection', async () => {
  const posts: ManualSourceRecordRequest[] = [];
  setup(async (request) => {
    posts.push(request);
    return response({ code: 'SOURCE_TEXT_CHANGED', message: 'Fictional source changed' }, 409);
  });
  const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Create review draft' }));
  await user.click(await screen.findByRole('button', { name: 'Reload source and person choices' }));
  await waitFor(() => expect(screen.getByLabelText('Person')).toHaveValue(''));
  expect(screen.getByLabelText('Label')).toHaveValue('Cookie count');
  expect(screen.getByLabelText('Literal source wording')).toHaveValue('Cookie count: 12.50 units');
  expect(screen.getByRole('button', { name: 'Create review draft' })).toBeDisabled();
  expect(posts).toHaveLength(1);
  const unload = new Event('beforeunload', { cancelable: true });
  fireEvent(window, unload);
  expect(unload.defaultPrevented).toBe(true);
});

it('does not publish a late manual creation response after a profile switch', async () => {
  let release!: (response: Response) => void;
  const state = setup(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Create review draft' }));
  await act(async () => {
    selectProfile({ id: 'other-profile', name: 'Other', placebo: true });
  });
  await act(async () => release(response(result)));
  expect(state.onCreated).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: 'Review the new record' })).toBeNull();
});

it.each(['Value as printed', 'Date (leave blank if unknown)', 'Unit (leave blank if unknown)'])(
  'guards an unfinished %s edit even before label or transcription is entered',
  async (field) => {
    const onPendingChange = vi.fn();
    setup(async () => response(result), vi.fn(), onPendingChange);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add record from this section' }));
    await screen.findByRole('option', { name: 'Me (Self)' });
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false));
    await user.type(screen.getByLabelText(field), '12');
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole('button', { name: 'Create review draft' })).toBeDisabled();
    const unload = new Event('beforeunload', { cancelable: true });
    fireEvent(window, unload);
    expect(unload.defaultPrevented).toBe(true);
  },
);
