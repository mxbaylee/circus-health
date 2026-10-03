import { createSourceDetailsSearch } from '../source-details-search.ts';
import { sourceTextProjectionCounters } from '../source-text-projection.ts';
import { intakeLookupCounters } from '../intake-lookup-projection.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { readIntakeEnvelopeText, stageIntakeEnvelope } from '../intake-authority.ts';
import {
  writeIntakeDetails,
  maximumReportDiscoveryOrder,
  type IntakeDetails,
} from '../intake-state-access.ts';
import { rebuildRecordDatabase } from '../record-versions.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

test('real selected-authority writers retain operational arrays and distant string middles with bounded accepted writes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-intake-locality-'));
  const profileId = 'fictional-mutation-locality';
  const db = openDatabase(join(root, 'source.sqlite'), profileId);
  const authority = memoryRecordAuthority(db);
  const opened = [db];
  t.after(() => {
    for (const database of opened) if (database.isOpen) database.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(`CREATE TEMP TABLE locality_writes(kind TEXT, value TEXT);
    CREATE TEMP TRIGGER locality_source AFTER UPDATE ON main.source_files BEGIN INSERT INTO locality_writes VALUES('source',NEW.details_json); END;
    CREATE TEMP TRIGGER locality_meta_insert AFTER INSERT ON main.app_meta WHEN NEW.key GLOB 'intake_state_v1:*' BEGIN INSERT INTO locality_writes VALUES(NEW.key,NEW.value); END;
    CREATE TEMP TRIGGER locality_meta_update AFTER UPDATE ON main.app_meta WHEN NEW.key GLOB 'intake_state_v1:*' BEGIN INSERT INTO locality_writes VALUES(NEW.key,NEW.value); END;`);
  let acceptedBytes = 0,
    immutableObjects = 0,
    publications = 0;
  const immutable = authority.storage.writeImmutable,
    publish = authority.storage.publishHead;
  authority.storage.writeImmutable = (name, bytes) => {
    acceptedBytes += bytes.length;
    immutableObjects++;
    immutable(name, bytes);
  };
  authority.storage.publishHead = (bytes) => {
    acceptedBytes += bytes.length;
    publications++;
    publish(bytes);
  };
  const expected = new Map<string, string>();
  const warm = () => {
    maximumReportDiscoveryOrder(db);
    const search = createSourceDetailsSearch(db, 'fictional');
    try {
      db.prepare(`SELECT f.id FROM source_files f ${search.joins} WHERE ${search.predicate}`).all(
        ...search.parameters,
      );
    } finally {
      search.dispose();
    }
  };
  for (const size of [20, 80, 160]) {
    const id = `fictional-locality-${size}`;
    const groups = Array.from({ length: size }, (_, index) => ({
      id: `group-${index}`,
      revision: 0,
      discoveryOrder: index,
      content: `Independently fictional group ${index}: Ω 😀 \ud800 `.repeat(80),
    }));
    const middle = Array.from(
      { length: size * 100 },
      (_, index) => `fictional-${index.toString(36).padStart(5, '0')}:`,
    ).join('');
    const original = {
      before: { b: 2, a: 1 },
      intake: {
        originalName: 'fictional-locality.txt',
        version: 1,
        workflow: { reportGroups: groups },
        notes: 'A'.repeat(32) + middle + 'B'.repeat(32),
      },
      after: 'Ω\udc00',
    };
    registerRawIntakeFixture(
      db,
      id,
      ` { "before":${JSON.stringify(original.before)}, "intake":${JSON.stringify(original.intake)}, "after":${JSON.stringify(original.after)} } `,
    );
    warm();
    const sourceHash = db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(id)!.sha256;
    const write = (value: typeof original, stage = false) =>
      transaction(db, () => {
        if (stage) {
          stageIntakeEnvelope(db, { id }, value);
        } else {
          const row = db
            .prepare('SELECT id,kind,details_json FROM source_files WHERE id=?')
            .get(id)! as { id: string; kind: string; details_json: string };
          writeIntakeDetails(db, row, value.intake as unknown as IntakeDetails, {
            effective: false,
          });
        }
        // Actual application transactions discard the full serializer return.
      });
    const normalized = { ...original, intake: { ...original.intake, version: 2 } };
    db.exec('DELETE FROM locality_writes');
    acceptedBytes = 0;
    immutableObjects = 0;
    publications = 0;
    write(normalized);
    const normalizationBytes = acceptedBytes;
    assert.ok(normalizationBytes > Buffer.byteLength(middle));
    assert.equal(
      db.prepare("SELECT count(*) n FROM locality_writes WHERE kind='source'").get()!.n,
      1,
    );
    assert.equal(readIntakeEnvelopeText(db, { id }), JSON.stringify(normalized));
    const states: Array<{ label: string; value: typeof original; stage?: boolean }> = [
      {
        label: 'insert',
        value: {
          ...normalized,
          intake: {
            ...normalized.intake,
            workflow: {
              reportGroups: [
                { id: 'inserted', revision: 0, discoveryOrder: size, content: 'new' },
                ...groups,
              ],
            },
          },
        },
      },
      { label: 'delete', value: normalized },
      {
        label: 'rotate',
        value: {
          ...normalized,
          intake: {
            ...normalized.intake,
            workflow: { reportGroups: [...groups.slice(1), groups[0]!] },
          },
        },
      },
      {
        label: 'mixed edits and rotation',
        value: {
          ...normalized,
          intake: {
            ...normalized.intake,
            workflow: {
              reportGroups: [
                { ...groups[0]!, revision: 1 },
                ...groups.slice(2),
                { ...groups[1]!, revision: 1 },
              ],
            },
          },
        },
      },
      {
        label: 'distant string decoy anchors',
        stage: true,
        value: {
          ...normalized,
          intake: {
            ...normalized.intake,
            workflow: {
              reportGroups: [
                { ...groups[0]!, revision: 1 },
                ...groups.slice(2),
                { ...groups[1]!, revision: 1 },
              ],
            },
            notes: 'B'.repeat(32) + middle + 'C'.repeat(32),
          },
        },
      },
    ];
    for (const { label, value, stage } of states) {
      db.exec('DELETE FROM locality_writes');
      acceptedBytes = 0;
      immutableObjects = 0;
      publications = 0;
      const priorText = { ...sourceTextProjectionCounters(db) };
      const priorLookup = { ...intakeLookupCounters(db) };
      write(value, stage);
      warm();
      const text = sourceTextProjectionCounters(db),
        lookup = intakeLookupCounters(db);
      const derived = {
        lookupRows: lookup.projectionWrites - priorLookup.projectionWrites,
        lookupBytes: lookup.projectionBytes - priorLookup.projectionBytes,
        textContentRows: text.contentRowsWritten - priorText.contentRowsWritten,
        textContentBytes: text.contentBytesWritten - priorText.contentBytesWritten,
        textOccurrenceRows: text.occurrenceRowsWritten - priorText.occurrenceRowsWritten,
        textOccurrenceBytes: text.occurrenceBytesWritten - priorText.occurrenceBytesWritten,
        textLinkRows: text.linkRowsWritten - priorText.linkRowsWritten,
        textLinkBytes: text.linkBytesWritten - priorText.linkBytesWritten,
        textTotalBytes: text.projectionBytes - priorText.projectionBytes,
      };
      assert.ok(derived.textContentBytes < 3000, JSON.stringify(derived));
      assert.ok(derived.textTotalBytes < 20_000, JSON.stringify(derived));
      const writes = db.prepare('SELECT kind,value FROM locality_writes').all() as {
        kind: string;
        value: string;
      }[];
      const frames = writes.filter((row) => row.kind.includes(':frame:'));
      const heads = writes.filter((row) => row.kind.endsWith(':head'));
      const receipts = writes.filter((row) => row.kind.includes(':operation:'));
      assert.equal(frames.length, 1, `${size} ${label}: one contribution frame`);
      assert.equal(heads.length, 1);
      assert.equal(receipts.length, 1);
      assert.equal(writes.filter((row) => row.kind === 'source').length, 0);
      const frameBytes = Buffer.byteLength(frames[0]!.value);
      const payload = Buffer.from(JSON.parse(frames[0]!.value).data, 'base64').toString('utf8');
      assert.ok(
        Buffer.byteLength(payload) < 1800,
        `${size} ${label}: ${Buffer.byteLength(payload)} delta bytes`,
      );
      assert.ok(frameBytes < 3200, `${size} ${label}: ${frameBytes} frame bytes`);
      assert.ok(acceptedBytes < 10_000, `${size} ${label}: ${acceptedBytes} accepted bytes`);
      assert.equal(publications, 1);
      assert.equal(immutableObjects, 2, 'one changed-record segment and one commit');
      assert.ok(Buffer.byteLength(heads[0]!.value) < 1000);
      assert.ok(Buffer.byteLength(receipts[0]!.value) < 1000);
      assert.equal(readIntakeEnvelopeText(db, { id }), JSON.stringify(value));
      assert.equal(
        db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(id)!.sha256,
        sourceHash,
      );
      expected.set(id, JSON.stringify(value));
      t.diagnostic(
        JSON.stringify({
          size,
          ...derived,
          operation: label,
          initialNormalizationBytes: normalizationBytes,
          frameBytes,
          acceptedBytes,
          immutableObjects,
          publications,
          deltaBytes: Buffer.byteLength(payload),
        }),
      );
    }
  }
  const rebuiltPath = join(root, 'rebuilt.sqlite');
  rebuildRecordDatabase(rebuiltPath, { profileId, storage: authority.storage });
  const rebuilt = openDatabase(rebuiltPath, profileId);
  authority.attach(rebuilt);
  opened.push(rebuilt);
  for (const [id, exact] of expected) assert.equal(readIntakeEnvelopeText(rebuilt, { id }), exact);
});
