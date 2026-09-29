import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PdfPreview } from '../../app/components/PdfPreview';
import { replaceProfiles, selectProfile } from '../../app/data/profile';

const pdf = vi.hoisted(() => {
  const viewport = vi.fn(({ scale, rotation }: { scale: number; rotation: number }) => ({
    width: (rotation % 180 ? 800 : 600) * scale,
    height: (rotation % 180 ? 600 : 800) * scale,
  }));
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const page = {
    rotate: 90,
    getViewport: viewport,
    render,
    getTextContent: async () => ({
      items: [{ str: 'Cookie Doe, fictional evidence', hasEOL: true }],
    }),
  };
  const getPage = vi.fn(async () => page);
  return { viewport, render, getPage, destroy: vi.fn(async () => {}) };
});
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 4, getPage: pdf.getPage }),
    destroy: pdf.destroy,
  }),
}));

it('opens the explicit evidence page, rotates from intrinsic orientation, and zooms without changing the source', async () => {
  const profile = { id: 'cookie-evidence', name: 'Cookie Doe', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private notify: (entries: { contentRect: { width: number } }[]) => void) {}
      observe() {
        this.notify([{ contentRect: { width: 600 } }]);
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  const view = render(
    <PdfPreview
      contentUrl="/api/sources/fictional-original/content"
      filename="cookie-doe.pdf"
      initialPage={3}
    />,
  );
  await screen.findByRole('img', { name: 'cookie-doe.pdf, page 3 of 4' });
  expect(pdf.getPage).toHaveBeenCalledWith(3);
  expect(pdf.viewport).toHaveBeenCalledWith({ scale: 1, rotation: 90 });
  fireEvent.click(screen.getByRole('button', { name: 'Rotate page' }));
  await waitFor(() => expect(pdf.viewport).toHaveBeenCalledWith({ scale: 1, rotation: 180 }));
  fireEvent.change(screen.getByRole('combobox', { name: 'PDF zoom' }), { target: { value: '2' } });
  await waitFor(() => expect(pdf.viewport).toHaveBeenCalledWith({ scale: 2, rotation: 180 }));
  expect(screen.getByRole('link', { name: 'Open original PDF' })).toHaveAttribute(
    'href',
    '/api/profiles/cookie-evidence/sources/fictional-original/content',
  );
  view.rerender(
    <PdfPreview
      contentUrl="/api/sources/fictional-original/content"
      filename="cookie-doe.pdf"
      initialPage={999}
    />,
  );
  await screen.findByRole('img', { name: 'cookie-doe.pdf, page 1 of 4' });
  expect(screen.getByText(/The referenced page is unavailable/)).toBeVisible();
  expect(pdf.getPage).not.toHaveBeenCalledWith(999);
});
