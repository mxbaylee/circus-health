import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { runSourceRasterWorker } from '../intake-source-extraction.ts';

// Opt-in packaging check. Uses the actual installed local engine, no provider,
// network credential, private file, or mocked OCR executable.
test(
  'packaged English OCR retains a clean fictional raster with explicit source review',
  {
    skip: process.env.CRS_SOURCE_OCR_REAL !== '1',
  },
  async () => {
    const canvas = createCanvas(1000, 400),
      ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 1000, 400);
    ctx.fillStyle = 'black';
    ctx.font = '40px sans-serif';
    ctx.fillText('FICTIONAL SOURCE ONLY', 50, 90);
    ctx.fillText('Administrative routing 12345', 50, 170);
    ctx.fillText('No finding. Decimal 12.00 mg', 50, 250);
    const result = await runSourceRasterWorker(canvas.toBuffer('image/png'), 1, []);
    assert.equal(result.ocrAvailable, true);
    const text = result.spans.map((s) => s.text).join(' ');
    for (const literal of ['FICTIONAL', 'Administrative', '12345', 'No', '12.00', 'mg'])
      assert.ok(text.includes(literal), literal);
    assert.ok(result.spans.every((s) => s.provenance === 'ocr' && s.region.page === 1));
    assert.ok(result.issues.some((i) => i.kind === 'coverage' && i.status === 'open'));
  },
);
