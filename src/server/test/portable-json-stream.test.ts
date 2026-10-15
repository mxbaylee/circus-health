import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamPortableJson } from '../portable-json-stream.ts';
import { createPortableWorkCounters, withPortableWork } from '../portable-work.ts';

test('portable row pieces preserve selected bytes across Unicode read blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-row-pieces-'));
  try {
    const path = join(root, 'generation.json');
    const value = { note: 'a'.repeat(65_533) + '😀' + 'Ω'.repeat(1_100_000) };
    const raw = JSON.stringify({ format: 1, tables: { notes: [value] } });
    writeFileSync(path, raw);
    const expected = {
      bytes: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
    const rows: string[] = [];
    const header = streamPortableJson(
      path,
      () => {},
      () => assert.fail('whole row callback'),
      expected,
      {
        rowPieces(name, pieces, parsed) {
          assert.equal(name, 'notes');
          assert.equal(parsed.kind(parsed.root), 'object');
          const chunks = [...pieces];
          assert.ok(chunks.length > 100);
          assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 8195));
          rows.push(chunks.join(''));
        },
      },
    );
    assert.equal(header.format, 1);
    assert.deepEqual(JSON.parse(rows[0]!), value);
    assert.equal(rows[0], JSON.stringify(value));
    assert.equal(readFileSync(path, 'utf8'), raw);
    let expired: Iterator<string> | undefined;
    streamPortableJson(
      path,
      () => {},
      () => {},
      expected,
      {
        rowPieces(_name, pieces) {
          expired = pieces[Symbol.iterator]();
          assert.equal(expired.next().done, false);
        },
      },
    );
    assert.throws(() => expired!.next(), /Expired portable row pieces/);
    assert.throws(
      () =>
        streamPortableJson(
          path,
          () => {},
          () => {},
          { ...expected, sha256: '0'.repeat(64) },
          {
            rowPieces() {},
          },
        ),
      /checksum failed/,
    );
    const malformed = '{"tables":{"notes":[{"note":1,}]}}';
    writeFileSync(path, malformed);
    assert.throws(
      () =>
        streamPortableJson(
          path,
          () => {},
          () => {},
          undefined,
          { rowPieces() {} },
        ),
      /Invalid|JSON|object/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('portable row pieces refuse a same-size scratch edit after parsing', () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-row-tamper-'));
  try {
    const path = join(root, 'generation.json');
    const row = { note: 'x'.repeat(20_000) };
    const raw = JSON.stringify({ tables: { notes: [row] } });
    writeFileSync(path, raw);
    let edited = false;
    assert.throws(
      () =>
        streamPortableJson(
          path,
          () => {},
          () => {},
          undefined,
          {
            rowPieces() {
              const encoded = JSON.stringify(row);
              for (const name of readdirSync(tmpdir())) {
                if (!name.startsWith('circus-portable-row-')) continue;
                const scratch = join(tmpdir(), name, 'row');
                try {
                  if (statSync(scratch).size !== Buffer.byteLength(encoded)) continue;
                  if (readFileSync(scratch, 'utf8') !== encoded) continue;
                } catch {
                  continue;
                }
                const fd = openSync(scratch, 'r+');
                try {
                  writeSync(fd, Buffer.from('X'), 0, 1, 0);
                } finally {
                  closeSync(fd);
                }
                edited = true;
                return;
              }
              assert.fail('Private fictional row scratch was not found');
            },
          },
        ),
      /Portable row scratch changed/,
    );
    assert.equal(edited, true);
    assert.equal(readFileSync(path, 'utf8'), raw);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spooled portable keys and rows reuse one private canonical scratch set', () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-scratch-reuse-'));
  const previous = process.env.TMPDIR;
  // A private temp root, so only this stream's scratch directories are counted.
  process.env.TMPDIR = root;
  try {
    const path = join(root, 'generation.json');
    const rows = Array.from({ length: 12 }, (_, at) => ({ label: `fictional row ${at}`, at }));
    const raw = JSON.stringify({
      format: 1,
      kind: 'fictional',
      tables: { notes: rows, empty: [] },
    });
    writeFileSync(path, raw);
    const seen = new Set<string>(),
      read: string[] = [],
      counters = createPortableWorkCounters();
    withPortableWork(counters, () =>
      streamPortableJson(
        path,
        () => {},
        () => assert.fail('whole row callback'),
        undefined,
        {
          rowPieces(name, pieces, parsed) {
            assert.equal(name, 'notes');
            assert.equal(parsed.kind(parsed.root), 'object');
            for (const entry of readdirSync(root))
              if (entry.startsWith('intake-json-canonical-')) seen.add(entry);
            read.push([...pieces].join(''));
          },
        },
      ),
    );
    assert.deepEqual(
      read.map((text) => JSON.parse(text)),
      rows,
    );
    assert.deepEqual(
      read,
      rows.map((row) => JSON.stringify(row)),
    );
    // One spool directory and one SQLite index directory for all 12 rows,
    // not a fresh pair per row (24 before reuse).
    assert.equal(seen.size, 2);
    assert.equal(counters.canonicalScratchSets, 1);
    // Five keys (format, kind, tables, notes, empty) and twelve rows.
    assert.equal(counters.canonicalPreparations, 17);
    assert.deepEqual(
      readdirSync(root).filter((entry) => entry.startsWith('intake-json-canonical-')),
      [],
    );
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
