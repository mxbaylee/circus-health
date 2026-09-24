/** XHR exposes actual browser upload progress; fetch currently does not. Response body is buffered by XHR. */
export function uploadWithProgress(
  url: string,
  options: RequestInit,
  progress: (sent: number, total: number | null) => void,
  transferred: () => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    xhr.open(options.method || 'POST', url);
    new Headers(options.headers).forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.responseType = 'text';
    xhr.upload.onprogress = (event) =>
      progress(event.loaded, event.lengthComputable ? event.total : null);
    xhr.upload.onload = () => transferred();
    xhr.onload = () => {
      cleanup();
      try {
        const headers = new Headers();
        for (const line of xhr
          .getAllResponseHeaders()
          .trim()
          .split(/[\r\n]+/)) {
          const split = line.indexOf(':');
          if (split > 0) headers.append(line.slice(0, split).trim(), line.slice(split + 1).trim());
        }
        const body = [204, 205, 304].includes(xhr.status) ? null : xhr.responseText;
        resolve(new Response(body, { status: xhr.status, headers }));
      } catch (error) {
        // Exceptions thrown by an event callback do not reject its surrounding
        // Promise automatically. Keep malformed responses from hanging actions.
        reject(error);
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new TypeError('Upload transport failed'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Upload interrupted', 'AbortError'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      cleanup();
      reject(new DOMException('Upload interrupted', 'AbortError'));
      return;
    }
    try {
      xhr.send(options.body as XMLHttpRequestBodyInit);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
