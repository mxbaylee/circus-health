import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ImportDiagnosticsControl } from '../../app/features/import/ImportDiagnosticsControl';
import { selectProfile } from '../../app/data/profile';
beforeEach(() =>
  selectProfile({ id: 'fictional-diagnostics', name: 'Fictional Self', placebo: true }),
);
it.each([false, true])('downloads bounded JSON with detailed recording %s', async (enabled) => {
  const requests: string[] = [];
  let downloaded: Blob | undefined;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => {
        downloaded = blob;
        return 'blob:fictional';
      });
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const server = {
    enabled,
    droppedEvents: enabled ? 2 : 0,
    events: enabled ? [{ event: 'import.progress' }] : [],
    eventWindow: {
      recording: enabled ? 'enabled' : 'disabled',
      storage: 'memory_only',
      capacity: 10,
      observedEvents: 12,
      observedSince: '2026-01-01T00:00:00Z',
      notRetainedWhileDisabled: enabled ? 0 : 12,
      omittedBeforeWindow: null,
      completeness: 'not_established',
    },
    recentPerformance: { operations: [] },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path) => {
      requests.push(String(path));
      return new Response(
        JSON.stringify({ data: String(path).endsWith('/status') ? { enabled } : server }),
      );
    }),
  );
  await act(async () => {
    render(<ImportDiagnosticsControl />);
  });
  const button = screen.getByRole('button', { name: 'Download performance diagnostics' });
  expect(button).toBeVisible();
  expect(button).toHaveAccessibleDescription(
    enabled ? /Bounded recent diagnostics/ : /Detailed events are off/,
  );
  await act(async () => {
    fireEvent.click(button);
  });
  expect(click).toHaveBeenCalledOnce();
  expect(downloaded?.type).toBe('application/json');
  const contents = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(downloaded!);
  });
  const bundle = JSON.parse(contents);
  expect(bundle.server).toEqual(server);
  expect(bundle.coverage).toMatch(/not an established full-run history/);
  expect(bundle.server.eventWindow.omittedBeforeWindow).toBeNull();
  expect(contents).not.toMatch(/fictional-diagnostics|Fictional Self/);
  expect(screen.getByRole('status')).toHaveTextContent(
    enabled ? /2 server events exceeded/ : /Detailed server events are off/,
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatch(/import-diagnostics\/status$/);
  expect(requests[1]).toMatch(/import-diagnostics$/);
});
it.each([null, {}, { enabled: 'true' }])('hides invalid status %j', async (data) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data }))),
  );
  await act(async () => {
    render(<ImportDiagnosticsControl />);
  });
  expect(screen.queryByRole('button')).toBeNull();
});
it('hides the control while status is loading', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  render(<ImportDiagnosticsControl />);
  expect(screen.queryByRole('button')).toBeNull();
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
