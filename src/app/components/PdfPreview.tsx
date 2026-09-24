import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { apiUrl } from '../data/api';
import { subscribeProfileIdentity, useProfile } from '../data/profile';
import { LoadingIndicator } from './LoadingIndicator';
import './pdf-preview.css';

// These are package assets, never patient files or remote CDN dependencies.
const binaryAssets = import.meta.glob<string>(
  [
    '../../../node_modules/pdfjs-dist/cmaps/*.bcmap',
    '../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
    '../../../node_modules/pdfjs-dist/wasm/{jbig2,openjpeg,qcms_bg}.wasm',
  ],
  { eager: true, query: '?url', import: 'default' },
);

function binaryFactory(signal: AbortSignal) {
  return class LocalBinaryDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      const directory = {
        cMapUrl: 'cmaps',
        standardFontDataUrl: 'standard_fonts',
        wasmUrl: 'wasm',
      }[kind];
      const url = directory
        ? binaryAssets[`../../../node_modules/pdfjs-dist/${directory}/${filename}`]
        : undefined;
      if (!url) throw new Error(`A bundled PDF resource is unavailable (${kind}).`);
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error('A bundled PDF resource could not be opened.');
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}

export function PdfPreview({ contentUrl, filename }: { contentUrl: string; filename: string }) {
  const profile = useProfile();
  if (!profile) return null;
  // A changed profile or source cannot reuse the preceding document/canvas.
  return (
    <PdfDocument key={`${profile.id}:${contentUrl}`} contentUrl={contentUrl} filename={filename} />
  );
}

function PdfDocument({ contentUrl, filename }: { contentUrl: string; filename: string }) {
  const captionId = useId();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [pageText, setPageText] = useState('');
  const [width, setWidth] = useState(0);
  const frame = useRef<HTMLDivElement>(null);
  let scopedUrl: string | null = null;
  try {
    const url = apiUrl(contentUrl);
    if (/^\/api\/profiles\/[^/]+\/(?:sources|assets)\/[^/]+\/content$/.test(url)) scopedUrl = url;
  } catch {
    /* Keep a stale or unscoped file out of the renderer. */
  }

  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(0, Math.floor(entries[0].contentRect.width))),
    );
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setPdf(null);
    setPage(1);
    setPageText('');
    setLoading(true);
    setError('');
    frame.current?.replaceChildren();
    const controller = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    const destroy = () => {
      controller.abort();
      frame.current?.replaceChildren();
      if (task) void task.destroy().catch(() => {});
    };
    const unsubscribe = subscribeProfileIdentity(destroy);
    if (!scopedUrl) {
      setError('This PDF does not belong to the selected local profile.');
      setLoading(false);
      return () => {
        unsubscribe();
        destroy();
      };
    }
    const load = async () => {
      try {
        const [pdfjs, response] = await Promise.all([
          // The compatibility build supplies newer typed-array methods that
          // embedded WebKit versions may not expose yet (for example toHex).
          import('pdfjs-dist/legacy/build/pdf.mjs'),
          fetch(scopedUrl, {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'same-origin',
            redirect: 'error',
            headers: { Accept: 'application/pdf' },
          }),
        ]);
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'The original PDF is missing from local storage.'
              : `The original PDF could not be opened (${response.status}).`,
          );
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (controller.signal.aborted) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        // PDF.js 6 does not use JS eval for page rendering. We do not instantiate
        // its scripting manager, enable XFA, or render interactive annotations.
        task = pdfjs.getDocument({
          data: bytes,
          enableXfa: false,
          useWorkerFetch: false,
          BinaryDataFactory: binaryFactory(controller.signal),
          cMapPacked: true,
          useWasm: true,
          stopAtErrors: true,
        });
        const document = await task.promise;
        if (controller.signal.aborted) {
          await task.destroy();
          return;
        }
        setPdf(document);
        setLoading(false);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const name = cause instanceof Error ? cause.name : '';
        setError(
          name === 'PasswordException'
            ? 'This PDF requires a password. Open the original in a PDF application to unlock it.'
            : cause instanceof Error
              ? cause.message
              : 'This PDF could not be rendered.',
        );
        setLoading(false);
      }
    };
    void load();
    return () => {
      unsubscribe();
      destroy();
    };
  }, [scopedUrl, retry]);

  useEffect(() => {
    const host = frame.current;
    if (!pdf || !host || width <= 0) return;
    let active = true;
    let task: RenderTask | undefined;
    host.replaceChildren();
    setRendering(true);
    setPageText('');
    setError('');
    const render = async () => {
      try {
        const pdfPage = await pdf.getPage(page);
        if (!active) return;
        const original = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({
          scale: Math.min(width / original.width, 1400 / original.height),
        });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.className = 'pdf-page-canvas';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${filename}, page ${page} of ${pdf.numPages}`);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('This browser cannot create the PDF preview canvas.');
        task = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
          background: '#ffffff',
        });
        await task.promise;
        if (!active) return;
        host.replaceChildren(canvas);
        setRendering(false);
        const text = await pdfPage.getTextContent();
        if (active)
          setPageText(
            text.items
              .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
              .join('')
              .trim(),
          );
      } catch (cause) {
        if (!active || (cause instanceof Error && cause.name === 'RenderingCancelledException'))
          return;
        setError(cause instanceof Error ? cause.message : 'This page could not be rendered.');
        setRendering(false);
      }
    };
    void render();
    return () => {
      active = false;
      task?.cancel();
      host.replaceChildren();
    };
  }, [pdf, page, width, filename]);

  return (
    <figure className="local-pdf-preview" aria-describedby={captionId}>
      <figcaption id={captionId} className="pdf-preview-caption">
        <strong>{filename}</strong>
        <span>{pdf ? `Page ${page} of ${pdf.numPages}` : 'PDF preview'}</span>
      </figcaption>
      <div className="pdf-page-controls">
        <button
          type="button"
          className="button secondary"
          aria-label="Previous PDF page"
          disabled={!pdf || page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          <ChevronLeft size={17} />
          Previous
        </button>
        <span aria-live="polite">{pdf ? `${page} / ${pdf.numPages}` : '—'}</span>
        <button
          type="button"
          className="button secondary"
          aria-label="Next PDF page"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => setPage((value) => value + 1)}
        >
          Next
          <ChevronRight size={17} />
        </button>
      </div>
      {(loading || rendering) && (
        <LoadingIndicator
          className="pdf-preview-status"
          label={loading ? 'Opening PDF…' : `Rendering page ${page}…`}
          layout="panel"
        />
      )}
      {error && (
        <div className="pdf-preview-error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="text-link"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry preview
          </button>
        </div>
      )}
      <div ref={frame} className="pdf-page-frame" aria-busy={loading || rendering} />
      {pdf && !loading && !rendering && !error && (
        <details className="pdf-page-text">
          <summary>Extracted text from page {page}</summary>
          <p>
            {pageText || 'No text was extracted from this page. It may be scanned or image-only.'}
          </p>
        </details>
      )}
      {scopedUrl && (
        <a
          className="text-link pdf-original-link"
          href={scopedUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open original PDF
          <ExternalLink size={15} />
        </a>
      )}
    </figure>
  );
}
