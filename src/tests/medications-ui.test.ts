import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

test('personal current use stays separate from an active provider order and its recorded date', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const { Medications, ClinicalRecordDetail, MedicationStatusEditor } =
      await server.ssrLoadModule('/app/pages/ClinicalRecords.tsx');
    const { selectProfile } = await server.ssrLoadModule('/app/data/profile.ts');
    selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
    const list = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(Medications)),
    );
    assert.match(list, /Your personal current medication list/);
    assert.match(list, /aria-label="Edit Active"/);
    assert.doesNotMatch(list, /Not reviewed/);
    const record = {
      id: 'medication:synthetic',
      label: 'Fictional medicine',
      kind: 'order',
      status: 'active',
      doseText: '25 mg, as recorded',
      route: 'Oral',
      frequency: 'As needed',
      startAt: null,
      endAt: null,
      sourceRecordedDate: '2021-06-15T10:00:00Z',
      provider: 'Fictional Clinic',
      sourceRecordId: 'source:fictional',
      currentStatus: 'not_current',
      currentStatusUpdatedAt: '2026-09-11T13:00:00Z',
      currentStatusVersion: 1,
      currentStatusAssertion: { basis: '<script>Literal personal statement</script>' },
      extra: {},
      evidence: [],
      attachments: [],
    };
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ClinicalRecordDetail, { record, onStatusSaved() {} }),
      ),
    );
    assert.match(html, /Current/);
    assert.match(html, /Inactive/);
    assert.match(html, /<dt>Source status<\/dt><dd>active<\/dd>/);
    assert.match(
      html,
      /<dt>Recorded date<\/dt><dd><time dateTime="2021-06-15T10:00:00Z">Jun 15, 2021<\/time>/,
    );
    assert.match(html, /<dt>Source start date<\/dt><dd>Date not recorded<\/dd>/);
    assert.match(html, /<dt>Source end date<\/dt><dd>Date not recorded<\/dd>/);
    assert.match(html, /<dt>Source dose<\/dt><dd>25 mg, as recorded<\/dd>/);
    assert.match(html, /Current use history and details/);
    assert.match(html, /Record relationships/);
    assert.doesNotMatch(html, /Literal personal statement/);
    assert.doesNotMatch(html, /<script>|type="file"|Edit prescription|Discontinue prescription/);

    const unknown = renderToStaticMarkup(
      createElement(MedicationStatusEditor, {
        record: {
          ...record,
          currentStatus: 'unknown',
          currentStatusUpdatedAt: null,
          currentStatusVersion: 0,
          currentStatusAssertion: null,
        },
        onSaved() {},
      }),
    );
    assert.match(unknown, /Inactive/);
    assert.doesNotMatch(unknown, /role="switch"[^>]*checked/);
    assert.match(unknown, /Current use history and details/);
    assert.doesNotMatch(unknown, /Save personal status|Personal current use/);
  } finally {
    await server.close();
  }
});
