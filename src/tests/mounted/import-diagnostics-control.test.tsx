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
    eventArchive: {
      status: enabled ? 'partial' : 'unavailable',
      windowCoverage: enabled
        ? [0, 1].map((index) => ({
            windowId: `fictional-window-${index}`,
            checkpointedPersistedEvents: Number.MAX_SAFE_INTEGER,
            readableEvents: 0,
            exportedEvents: 0,
            knownPersistedNotExportedEvents: Number.MAX_SAFE_INTEGER,
          }))
        : [],
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
    enabled ? /Bounded diagnostics/ : /Detailed events are off/,
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
  if (enabled)
    expect(screen.getByRole('status')).toHaveTextContent(
      'At least 18014398509481982 previously saved diagnostic events are missing',
    );
  expect(screen.getByRole('status')).toHaveTextContent(
    enabled
      ? /Some retained event history could not be included/
      : /Retained event history is unavailable/,
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

it('downloads actual encrypted retained observations with recording off', async () => {
  // Run the real Node recorder/store in its server runtime; jsdom rewrites import.meta.url.
  const { execFileSync } = await import('node:child_process');
  const server = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createImportDiagnostics } from './src/server/import-diagnostics.ts';
    import { openDiagnosticChunkStore } from './src/server/diagnostic-chunk-store.ts';
    import { freshKey } from './src/server/vault-crypto.ts';
    const directory = mkdtempSync(join(tmpdir(), 'fictional-mounted-archive-'));
    const key = freshKey(), profileId = 'fictional-diagnostics';
    const open = () => openDiagnosticChunkStore({ directory, key, profileId, limits: { maxChunks: 1 } });
    const recorder = createImportDiagnostics({ enabled: true }), restored = createImportDiagnostics();
    try {
      recorder.attachEventStore(profileId, open());
      for (let i = 0; i < 128; i++) recorder.record('import.progress', { accountedUnits: i }, { profileId });
      recorder.record('import.progress', { accountedUnits: 42, narrative: 'Fictional medical canary' }, { profileId, importId: 'fictional-original.pdf' });
      recorder.close();
      restored.attachEventStore(profileId, open());
      process.stdout.write(JSON.stringify({ ...restored.exportSnapshot(profileId), eventArchive: await restored.exportArchive(profileId) }));
    } finally { recorder.close(); restored.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); }
  `,
      ],
      { encoding: 'utf8' },
    ),
  );
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
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (path) =>
        new Response(
          JSON.stringify({ data: String(path).endsWith('/status') ? { enabled: false } : server }),
        ),
    ),
  );
  await act(async () => {
    render(<ImportDiagnosticsControl />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Download performance diagnostics' }));
  });
  const contents = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(downloaded!);
  });
  const bundle = JSON.parse(contents);
  expect(bundle.server.events).toHaveLength(0);
  expect(bundle.server.eventArchive.events).toHaveLength(1);
  expect(bundle.server.eventArchive.events[0].event.fields.accountedUnits).toBe(42);
  expect(bundle.server.eventArchive.recording).toBe('disabled');
  expect(bundle.server.eventArchive.windowOrigins).toHaveLength(1);
  expect(bundle.server.eventArchive.windowOrigins[0].recordingAtAttachment).toBe('enabled');
  expect(bundle.server.eventArchive.currentAttachment.origin.recordingAtAttachment).toBe(
    'disabled',
  );
  expect(bundle.server.eventArchive.currentAttachment.publication).toBe('disabled');
  expect(bundle.coverage).toMatch(
    /Recording attachment dates describe archive attachment, not a complete import history/,
  );
  expect(bundle.server.eventArchive.crashTailEvents).toBeNull();
  expect(bundle.server.eventArchive.status).toBe('partial');
  expect(bundle.server.eventArchive.windowCoverageScope).toBe('retained_readable_checkpoints');
  expect(bundle.server.eventArchive.windowCoverage).toEqual([
    {
      windowId: bundle.server.eventArchive.events[0].windowId,
      checkpointedPersistedEvents: 129,
      readableEvents: 1,
      exportedEvents: 1,
      knownPersistedNotExportedEvents: 128,
    },
  ]);
  expect(contents).not.toMatch(/medical canary|fictional-original|fictional-diagnostics/);
  expect(screen.getByRole('status')).toHaveTextContent(
    /Some retained event history could not be included/,
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    /At least 128 previously saved diagnostic events are missing from this download. The cause is unknown/,
  );
});
