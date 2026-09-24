import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

test('provider history preserves source status and escapes source text without personal editing controls', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const { ProviderNoteDetail } = await server.ssrLoadModule(
      '/app/features/notes/ProviderNoteDetail.tsx',
    );
    const { selectProfile } = await server.ssrLoadModule('/app/data/profile.ts');
    selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
    const note = {
      id: 'document:synthetic',
      origin: 'provider',
      title: 'Synthetic <script>note</script>',
      typeLabel: 'Primary care',
      date: '2026-08-17',
      eventDate: '2026-08-17',
      recordDate: '2026-08-18',
      dateBasis: 'Reviewed encounter date; source was recorded the following day.',
      status: 'provider',
      readOnly: true,
      sourceId: 'fictional',
      sourceLabel: 'Fictional Clinic',
      sourceStatus: 'current',
      sourceType: 'Progress note',
      sourceRecordId: 'source:synthetic',
      content: 'One\nTwo <img src=x onerror=alert(1)>',
      authors: ['Fictional Author'],
      classificationBasis: null,
      presentationNote: null,
      evidence: [
        {
          id: 'evidence:synthetic',
          sourceRecordId: 'source:other',
          role: 'Supporting record',
          locator: { line: 12 },
        },
      ],
      attachments: [],
      extra: {},
    };
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ProviderNoteDetail, { note })),
    );
    assert.match(html, /Source status/);
    assert.match(html, /current/);
    assert.match(html, /Primary care/);
    assert.match(html, /Event date/);
    assert.match(html, /Aug 17, 2026/);
    assert.match(html, /Source date/);
    assert.match(html, /Aug 18, 2026/);
    assert.match(html, /Reviewed encounter date/);
    assert.match(html, /One\nTwo &lt;img/);
    assert.doesNotMatch(
      html,
      /<script>|<img src=x|Finish note|Save draft|New correction|contenteditable|<textarea|type="file"/,
    );
    assert.match(html, /View original source/);
    assert.match(html, /View evidence/);
    assert.match(html, /Read-only record/);
    assert.match(html, /Record relationships/);

    const { leavesNoteEditor } = await server.ssrLoadModule('/app/features/notes/navigation.ts');
    const current = { pathname: '/notes', search: '?kind=historical&id=note%3Adraft' };
    assert.equal(
      leavesNoteEditor(current, {
        ...current,
        search:
          current.search + '&source=provider&typeLabel=Primary+care&status=provider&offset=40',
      }),
      false,
    );
    assert.equal(
      leavesNoteEditor(current, { ...current, search: '?kind=historical&id=document%3Asynthetic' }),
      true,
    );
    assert.equal(
      leavesNoteEditor(
        { ...current, search: '?kind=historical&new=1' },
        { ...current, search: '?kind=note&new=1' },
      ),
      true,
    );
  } finally {
    await server.close();
  }
});
