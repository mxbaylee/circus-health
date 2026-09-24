import { expect, it, vi } from 'vitest';
import { uploadWithProgress } from '../../app/data/upload-transport';

class FakeXHR {
  static latest: FakeXHR;
  upload = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  responseText = '';
  status = 200;
  constructor() {
    FakeXHR.latest = this;
  }
  open() {}
  setRequestHeader() {}
  getAllResponseHeaders() {
    return '';
  }
  send() {}
  abort() {
    this.onabort?.();
  }
}

it.each([204, 205, 304])(
  'settles an upload with valid empty-body HTTP status %s',
  async (status) => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const request = uploadWithProgress(
      '/fictional',
      {},
      () => {},
      () => {},
    );
    FakeXHR.latest.status = status;
    FakeXHR.latest.onload!();
    const response = await request;
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('');
  },
);

it('rejects a malformed XHR response instead of leaving the request pending', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  const request = uploadWithProgress(
    '/fictional',
    {},
    () => {},
    () => {},
  );
  FakeXHR.latest.status = 0;
  expect(() => FakeXHR.latest.onload!()).not.toThrow();
  await expect(request).rejects.toThrow();
});

it('removes cancellation listeners when XHR send throws synchronously', async () => {
  class ThrowingXHR extends FakeXHR {
    override send() {
      throw new TypeError('Fictional transport setup failure');
    }
  }
  vi.stubGlobal('XMLHttpRequest', ThrowingXHR);
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  await expect(
    uploadWithProgress(
      '/fictional',
      { signal: controller.signal },
      () => {},
      () => {},
    ),
  ).rejects.toThrow('Fictional transport setup failure');
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
