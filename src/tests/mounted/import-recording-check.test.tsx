import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ImportDiagnosticsControl } from '../../app/features/import/ImportDiagnosticsControl';
import { clearProfile, selectProfile } from '../../app/data/profile';
import type { ImportRecordingCheck } from '../../shared/import-recording-check';

const profile = { id: 'fictional-check-profile', name: 'Fictional Cedar', placebo: true };
const origin = {
  windowId: 'a53e80c1-0c0d-4577-a77a-b99089d42b13',
  attachedAt: '2026-01-01T00:00:00.000Z',
  recordingAtAttachment: 'enabled' as const,
  observedBeforeAttachment: 0,
};
const good: ImportRecordingCheck = {
  checkedAt: '2026-01-01T00:10:00.000Z',
  status: 'current_origin_readable',
  recording: 'enabled',
  currentAttachment: { origin, publication: 'confirmed' },
  currentOriginReadable: true,
  archive: { status: 'available', coverageWarnings: false },
  completeness: 'not_established',
};
const envelope = (data: unknown) => new Response(JSON.stringify({ data }));
let downloaded: Blob | undefined;
beforeEach(() => {
  selectProfile(profile);
  downloaded = undefined;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => {
        downloaded = blob;
        return 'blob:fictional-check';
      });
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
async function mount(
  check: () => Promise<Response>,
  archiveOrigin: typeof origin | null = origin,
  archiveStatus = 'available',
) {
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (String(path).endsWith('/status')) return envelope({ enabled: true });
    if (String(path).endsWith('/check')) {
      expect(options?.method).toBe('POST');
      return check();
    }
    return envelope({
      enabled: true,
      droppedEvents: 0,
      events: [],
      eventArchive: {
        status: archiveStatus,
        currentAttachment: archiveOrigin
          ? { origin: archiveOrigin, publication: 'confirmed' }
          : null,
        windowCoverage: [],
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await act(async () => {
    render(<ImportDiagnosticsControl />);
  });
  return fetcher;
}
async function clickCheck() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check diagnostic recording' }));
  });
}
async function download() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Download performance diagnostics' }));
  });
  const contents = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(downloaded!);
  });
  return JSON.parse(contents);
}

it('offers a pre-upload explicit check, preserves date, and keeps partial history separate', async () => {
  const check = { ...good, archive: { status: 'partial' as const, coverageWarnings: true } };
  const fetcher = await mount(async () => envelope(check));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Check diagnostic recording' })).toBeVisible();
  expect(screen.queryByText(/Checked at/)).toBeNull();
  await clickCheck();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('status')).toHaveTextContent(
    /Checked at.*current saved attachment record was readable/,
  );
  expect(screen.getByRole('status')).toHaveTextContent(/Some retained history is missing/);
  expect(screen.getByRole('status').textContent).not.toContain(origin.windowId);
  expect(screen.getByText(/Checked at/).querySelector('time')).toHaveAttribute(
    'datetime',
    good.checkedAt,
  );
  const bundle = await download();
  expect(bundle.recordingCheck).toEqual({
    observation: check,
    attachmentComparison: 'same_attachment',
  });
});

it('marks the historical observation superseded when download sees a new attachment', async () => {
  await mount(async () => envelope(good), {
    ...origin,
    windowId: '00df6c24-0ab3-4ac7-90d8-1fca4a5b7d84',
  });
  await clickCheck();
  expect((await download()).recordingCheck).toEqual({
    observation: good,
    attachmentComparison: 'superseded',
  });
});

it('unavailable download inspection cannot invent a different attachment', async () => {
  await mount(async () => envelope(good), null, 'unavailable');
  await clickCheck();
  expect((await download()).recordingCheck).toEqual({
    observation: good,
    attachmentComparison: 'unavailable',
  });
});

it('authoritative absent attachment supersedes an earlier attachment observation', async () => {
  await mount(async () => envelope(good), null, 'not_attached');
  await clickCheck();
  expect((await download()).recordingCheck).toEqual({
    observation: good,
    attachmentComparison: 'superseded',
  });
});

it('clears a completed observation on lock and same-ID reselection', async () => {
  await mount(async () => envelope(good));
  await clickCheck();
  await act(async () => {
    clearProfile();
    selectProfile(profile);
  });
  expect(screen.queryByText(/Checked at/)).toBeNull();
  expect((await download()).recordingCheck).toBeNull();
});

it.each([
  'recording_disabled',
  'not_attached',
  'current_origin_unproven',
  'inspection_unavailable',
] as const)('shows truthful %s feedback without a success claim', async (status) => {
  const check: ImportRecordingCheck =
    status === 'recording_disabled'
      ? {
          ...good,
          status,
          recording: 'disabled',
          currentOriginReadable: false,
          currentAttachment: {
            origin: { ...origin, recordingAtAttachment: 'disabled' },
            publication: 'disabled',
          },
        }
      : status === 'not_attached'
        ? {
            ...good,
            status,
            currentOriginReadable: false,
            currentAttachment: null,
            archive: { status: 'not_attached', coverageWarnings: false },
          }
        : status === 'inspection_unavailable'
          ? {
              ...good,
              status,
              currentOriginReadable: false,
              archive: { status: 'unavailable', coverageWarnings: true },
            }
          : { ...good, status, currentOriginReadable: false };
  await mount(async () => envelope(check));
  await clickCheck();
  expect(screen.getByRole('status')).toHaveTextContent(/Checked at/);
  expect(screen.getByRole('status')).not.toHaveTextContent('was readable');
});

it('lost acknowledgement may have readable evidence without proving a whole run', async () => {
  await mount(async () =>
    envelope({
      ...good,
      currentAttachment: {
        origin: { ...origin, observedBeforeAttachment: 3 },
        publication: 'unconfirmed',
      },
    }),
  );
  await clickCheck();
  expect(screen.getByRole('status')).toHaveTextContent(
    /save was not acknowledged, but its attachment record was readable/,
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    /3 observations occurred before encrypted attachment/,
  );
  expect(screen.getByRole('status')).toHaveTextContent(/does not guarantee that a whole import/);
});

it('rejects extra response data and exports no malformed check', async () => {
  await mount(async () => envelope({ ...good, clinicalText: 'Fictional private canary' }));
  await clickCheck();
  expect(screen.getByRole('status')).toHaveTextContent('could not be verified');
  expect((await download()).recordingCheck).toBeNull();
});

it('does not replay a check after a lost response, and replaces the previous check', async () => {
  let calls = 0;
  const fetcher = await mount(async () => {
    if (++calls === 1) return envelope(good);
    throw Error('Fictional response lost');
  });
  await clickCheck();
  await clickCheck();
  expect(calls).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('status')).toHaveTextContent('Fictional response lost');
  expect(screen.queryByText(/Checked at/)).toBeNull();
  expect((await download()).recordingCheck).toBeNull();
});

it.each([false, true])(
  'discards a late check after lock, including same-ID reselection %s',
  async (sameId) => {
    let resolve!: (response: Response) => void;
    await mount(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    await clickCheck();
    expect(screen.getByRole('status')).toHaveTextContent('Checking saved diagnostic attachment');
    await act(async () => {
      clearProfile();
      selectProfile(sameId ? profile : { ...profile, id: 'fictional-other-profile' });
    });
    await act(async () => {
      resolve(envelope(good));
    });
    expect(screen.queryByText(/Checked at/)).toBeNull();
    expect((await download()).recordingCheck).toBeNull();
  },
);

it('discards results after unmount and a new component has no old observation', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      String(path).endsWith('/status')
        ? envelope({ enabled: true })
        : new Promise<Response>((done) => {
            resolve = done;
          }),
    ),
  );
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ImportDiagnosticsControl />);
  });
  await clickCheck();
  view.unmount();
  await act(async () => {
    resolve(envelope(good));
    render(<ImportDiagnosticsControl />);
  });
  expect(screen.queryByText(/Checked at/)).toBeNull();
});
