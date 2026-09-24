import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beginClientOperation, browserImportPerformance } from '../../app/data/import-performance';
import { api, useResource } from '../../app/data/api';
import { selectProfile, replaceProfiles } from '../../app/data/profile';
import { uploadWithProgress } from '../../app/data/upload-transport';

const profile = { id: 'fictional-performance', name: 'Fictional', placebo: false };
function open() {
  selectProfile(profile);
}
afterEach(() => {
  replaceProfiles([]);
});

it('joins concurrent operations to their own requests without retaining paths or bodies', async () => {
  open();
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ data: { result: 'fictional private result' } }), {
        headers: { 'X-Request-ID': crypto.randomUUID() },
      });
    }),
  );
  const first = beginClientOperation('review_save', { selected: 2 });
  const second = beginClientOperation('upload', { files: 1, bytes: 30 });
  await Promise.all([
    api('/intakes/report-acceptance', {
      method: 'POST',
      body: JSON.stringify({ private: 'fictional medical input' }),
      operationId: first.operationId,
    }),
    api('/intakes/private.pdf/review', { operationId: second.operationId }),
  ]);
  first.finish();
  second.finish();
  await waitFor(() =>
    expect(calls.filter((c) => c.url.endsWith('/import-diagnostics'))).toHaveLength(2),
  );
  const summaries = browserImportPerformance();
  expect(summaries.map((s) => s.operationId)).toEqual([first.operationId, second.operationId]);
  expect(summaries.every((s) => s.requestIds?.length === 2)).toBe(true);
  expect(
    summaries.every((s) => s.phases?.map((p) => p.phase).join(',') === 'api_wait,response_decode'),
  ).toBe(true);
  expect(summaries[0]!.requestIds!.some((id) => summaries[1]!.requestIds!.includes(id))).toBe(
    false,
  );
  expect(JSON.stringify(summaries)).not.toMatch(
    /private.pdf|medical input|private result|fictional-performance/,
  );
  expect(new Headers(calls[0]!.options?.headers).get('X-Client-Operation-ID')).toBe(
    first.operationId,
  );
});

it('drops pending observations and aborts publication on a profile lock', async () => {
  open();
  let reportSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, options) => {
      reportSignal = options.signal;
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        ),
      );
    }),
  );
  const finished = beginClientOperation('upload');
  finished.finish();
  await waitFor(() => expect(reportSignal).toBeDefined());
  const pending = beginClientOperation('review_save');
  replaceProfiles([{ ...profile, locked: true }]);
  pending.finish();
  expect(reportSignal!.aborted).toBe(true);
  expect(browserImportPerformance()).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('waits for render opportunities and bounds observations when animation frames do not run', async () => {
  open();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback) => {
      frames.push(callback);
      return frames.length;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: ['row'] }))),
  );
  function View() {
    const result = useResource<string[]>('/intakes/import-feed', 'review_open');
    return <p>{result.data?.join(',') || 'loading'}</p>;
  }
  render(<View />);
  await screen.findByText('row');
  expect(browserImportPerformance()).toHaveLength(0);
  act(() => {
    frames.shift()!(performance.now());
    frames.shift()!(performance.now());
  });
  expect(browserImportPerformance()[0]!.phases!.some((p) => p.phase === 'render_wait')).toBe(true);
  expect(browserImportPerformance()[0]!.outcome).toBe('completed');
  expect(browserImportPerformance()[0]!.renderObservation).toBe('two_frames');
  const hidden = beginClientOperation('review_action');
  hidden.afterRender();
  await waitFor(() => expect(browserImportPerformance()).toHaveLength(2));
  expect(browserImportPerformance()[1]!.renderObservation).toBe('timeout');
});

it('reports a failed request without allowing a diagnostics delivery error to break the action', async () => {
  open();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('fictional offline');
    }),
  );
  const operation = beginClientOperation('review_save');
  await expect(
    api('/intakes/report-acceptance', { method: 'POST', operationId: operation.operationId }),
  ).rejects.toThrow('fictional offline');
  expect(() => operation.finish('failed')).not.toThrow();
  expect(browserImportPerformance()[0]!.outcome).toBe('failed');
  expect(browserImportPerformance()[0]!.phases![0]!.phase).toBe('api_wait');
});

it('observes actual transferred bytes and cancels the upload transport', async () => {
  class FakeXHR {
    static latest: FakeXHR;
    upload: {
      onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void;
      onload?: () => void;
    } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    responseText = '{"data":{}}';
    status = 200;
    constructor() {
      FakeXHR.latest = this;
    }
    open() {}
    setRequestHeader() {}
    getAllResponseHeaders() {
      return 'X-Request-ID: fictional\r\n';
    }
    send() {}
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  const progress = vi.fn(),
    transferred = vi.fn();
  const first = uploadWithProgress(
    '/fictional',
    { body: new Blob(['test']) },
    progress,
    transferred,
  );
  FakeXHR.latest.upload.onprogress!({ loaded: 2, total: 4, lengthComputable: true });
  expect(progress).toHaveBeenCalledWith(2, 4);
  expect(transferred).not.toHaveBeenCalled();
  FakeXHR.latest.upload.onload!();
  FakeXHR.latest.onload!();
  expect(transferred).toHaveBeenCalledTimes(1);
  expect((await first).status).toBe(200);
  const controller = new AbortController();
  const cancelled = uploadWithProgress(
    '/fictional',
    { signal: controller.signal },
    progress,
    transferred,
  );
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  open();
  const operation = beginClientOperation('upload');
  const delivered = api('/intakes', {
    method: 'POST',
    body: new Blob(['test']),
    operationId: operation.operationId,
    onUploadProgress: progress,
  });
  FakeXHR.latest.upload.onload!();
  FakeXHR.latest.onload!();
  await expect(delivered).resolves.toEqual({ data: {} });
  operation.finish();
  expect(browserImportPerformance()[0]!.phases!.map((phase) => phase.phase)).toEqual([
    'upload_transfer',
    'api_wait',
    'response_decode',
  ]);
  const interrupted = api('/intakes', {
    method: 'POST',
    body: new Blob(['test']),
    onUploadProgress: progress,
  });
  replaceProfiles([{ ...profile, locked: true }]);
  await expect(interrupted).rejects.toMatchObject({ name: 'AbortError', code: 'PROFILE_CHANGED' });
});

it('keeps safe-read coalescing while both operations retain the shared server request reference', async () => {
  open();
  let release!: (response: Response) => void;
  const transport = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal('fetch', transport);
  const first = beginClientOperation('review_open');
  const second = beginClientOperation('review_open');
  const serverId = crypto.randomUUID();
  const a = api('/intakes/import-feed', { operationId: first.operationId });
  const b = api('/intakes/import-feed', { operationId: second.operationId });
  expect(transport).toHaveBeenCalledTimes(1);
  release(new Response(JSON.stringify({ data: [] }), { headers: { 'X-Request-ID': serverId } }));
  await Promise.all([a, b]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  );
  first.finish();
  second.finish();
  expect(browserImportPerformance().every((op) => op.requestIds?.includes(serverId))).toBe(true);
});
