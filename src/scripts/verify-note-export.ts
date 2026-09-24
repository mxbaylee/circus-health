// Render fictional evidence only; never opens or changes a real profile.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exportFixture } from '../server/test/note-export-fixture.ts';
import { exportSnapshot, exportHtml, exportPdf } from '../server/note-exports.ts';
const output = resolve(process.argv[2] || '../tmp/pdfs');
mkdirSync(output, { recursive: true });
const f = exportFixture(':memory:');
try {
  const snapshot = exportSnapshot(f.db, {
    type: 'note',
    id: f.note.id,
    noteVersion: f.note.version,
    mode: 'detailed',
    selected: ['test_type:cbc', 'medication:current-med', 'document:provider-note'],
    trends: true,
  });
  const html = exportHtml(snapshot);
  writeFileSync(resolve(output, 'synthetic-export.html'), html);
  const pdf = await exportPdf(html);
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new Error('Renderer did not produce a PDF');
  writeFileSync(resolve(output, 'synthetic-export.pdf'), pdf);
  console.log(`Fictional PDF written to ${resolve(output, 'synthetic-export.pdf')}`);
} finally {
  f.db.close();
}
