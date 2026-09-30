import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, Outlet } from 'react-router-dom';
import { beforeEach, it, expect, vi } from 'vitest';
import {
  PersonScopeProvider,
  PersonScopeIndicator,
  PersonScopeContent,
  usePersonScope,
} from '../../app/components/PersonScope';
import { selectProfile } from '../../app/data/profile';
import { personSelectionQuery } from '../../shared/person-scope';
function Content() {
  const scope = usePersonScope()!;
  return (
    <div data-testid="content">
      {scope.personId}
      <button onClick={scope.reload}>Refresh person</button>
    </div>
  );
}
function mount(route: string) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <PersonScopeProvider>
            <PersonScopeIndicator />
            <PersonScopeContent>
              <Outlet />
            </PersonScopeContent>
          </PersonScopeProvider>
        ),
        children: [{ path: '*', element: <Content /> }],
      },
    ],
    { initialEntries: [route] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
const response = (data: unknown) => new Response(JSON.stringify({ data }));
beforeEach(() => {
  selectProfile({ id: 'fictional-owner', name: 'Self', placebo: true });
});
it('holds clinical content while resolving a direct link, then replaces a conflicting owner filter', async () => {
  let resolveOwner!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) =>
      String(input).includes('record-owner')
        ? new Promise<Response>((resolve) => {
            resolveOwner = resolve;
          })
        : response({ name: 'Cookie Doe' }),
    ),
  );
  const router = mount('/notes?id=note-cookie&personId=patient');
  expect(screen.getByTestId('content')).not.toBeVisible();
  await act(async () => {
    resolveOwner(response({ personId: 'cookie' }));
  });
  expect(await screen.findByText('Cookie Doe', { selector: 'strong' })).toBeVisible();
  expect(screen.getByTestId('content')).toHaveTextContent('cookie');
  expect(screen.getByTestId('content')).toBeVisible();
  expect(router.state.location.search).toContain('personId=cookie');
});
it('ignores late owner responses when navigating to Self and uses a clean selection query', async () => {
  let resolveOwner!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) =>
      String(input).includes('record-owner')
        ? new Promise<Response>((resolve) => {
            resolveOwner = resolve;
          })
        : response({ name: 'Cookie Doe' }),
    ),
  );
  const router = mount('/notes?id=note-cookie');
  await act(async () => {
    await router.navigate('/notes?personId=patient');
  });
  await act(async () => {
    resolveOwner(response({ personId: 'cookie' }));
  });
  expect(screen.getByTestId('content')).toHaveTextContent('patient');
  expect(screen.queryByText(/Viewing Cookie/)).not.toBeInTheDocument();
  const next = personSelectionQuery(
    new URLSearchParams(
      'result=old&compare=old&offset=40&new=1&q=lab&view=by-test&type=old&visibility=all',
    ),
    'cookie',
  );
  expect(Object.fromEntries(next)).toEqual({
    view: 'by-test',
    q: 'lab',
    visibility: 'all',
    personId: 'cookie',
  });
});
it('does not label shared originals as belonging to the last selected person', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ name: 'Cookie Doe' })),
  );
  const router = mount('/notes?personId=cookie');
  expect(await screen.findByText('Cookie Doe', { selector: 'strong' })).toBeVisible();
  await act(async () => {
    await router.navigate('/sources');
  });
  expect(screen.queryByText(/Viewing Cookie/)).not.toBeInTheDocument();
});

it('does not flash an ownership check while navigating between default Self lists', async () => {
  const fetch = vi.fn(async () => response({}));
  vi.stubGlobal('fetch', fetch);
  const router = mount('/notes');
  const mutations: string[] = [];
  const observer = new MutationObserver(() => mutations.push(document.body.textContent || ''));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  await act(async () => {
    await router.navigate('/tests');
  });
  observer.disconnect();
  expect(screen.getByTestId('content')).toBeVisible();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(mutations.some((text) => text.includes('Checking record owner'))).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

// A caregiver's keyboard position must survive a same-owner refresh; see
// docs/import/review-reliability.md. A different profile still hides stale data.
it('keeps the focused control visible during a same-owner refresh and holds a new profile', async () => {
  let delay = false;
  const pending: Array<() => void> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const data = String(input).includes('record-owner')
        ? { personId: 'cookie' }
        : { name: 'Cookie Doe', noteId: 'cookie-note' };
      if (!delay) return response(data);
      return new Promise<Response>((resolve) => pending.push(() => resolve(response(data))));
    }),
  );
  mount('/notes?id=note-cookie&personId=cookie');
  await screen.findByText('Cookie Doe', { selector: 'strong' });
  const button = screen.getByRole('button', { name: 'Refresh person' });
  delay = true;
  await userEvent.setup().click(button);
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(button).toHaveFocus();
  expect(button).toBeVisible();
  expect(screen.queryByText('Opening person’s records…')).not.toBeInTheDocument();
  await act(async () => pending.splice(0).forEach((finish) => finish()));
  expect(button).toHaveFocus();
  expect(button).toBeVisible();
  await act(async () =>
    selectProfile({ id: 'fictional-second', name: 'Other fictional profile', placebo: true }),
  );
  expect(screen.getByTestId('content')).not.toBeVisible();
  await act(async () => pending.splice(0).forEach((finish) => finish()));
  await act(async () => pending.splice(0).forEach((finish) => finish()));
  expect(await screen.findByText('Cookie Doe', { selector: 'strong' })).toBeVisible();
});
