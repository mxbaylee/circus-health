import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ImportDiagnosticsControl } from '../../app/features/import/ImportDiagnosticsControl';
import { selectProfile } from '../../app/data/profile';
beforeEach(() =>
  selectProfile({ id: 'fictional-diagnostics', name: 'Fictional Self', placebo: true }),
);
it.each([false, true])('diagnostics download follows the server flag (%s)', async (enabled) => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path) => {
      requests.push(String(path));
      return new Response(JSON.stringify({ data: { enabled } }));
    }),
  );
  await act(async () => {
    render(<ImportDiagnosticsControl />);
  });
  const button = screen.queryByRole('button', { name: 'Download performance diagnostics' });
  if (enabled) expect(button).toBeVisible();
  else expect(button).toBeNull();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatch(/import-diagnostics\/status$/);
});
it('hides the control when flag lookup fails rather than enabling a download', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 })),
  );
  await act(async () => {
    render(<ImportDiagnosticsControl />);
  });
  expect(screen.queryByRole('button')).toBeNull();
});
