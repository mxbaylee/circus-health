import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { registerIntakeFile } from '../intake-state-access.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { prepareIntakeSourceDependencyHeaders } from '../intake-source-text-dependencies.ts';
import { readIntakeSourcePin } from '../intake-source-pin.ts';
import { runIntakeSourceExtractionOperation } from '../intake-source-extraction-operation.ts';
import { getIntakeSourceText, publishIntakeSourceText } from '../intake-source-text.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import type { SourceTextEvidence } from '../../shared/intake-source-text.ts';
import { packetSourceAncestry, packetSourceAncestryWork } from '../packet-source-ancestry.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture(t: test.TestContext, parents: (string | null | number)[]) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-ancestry-')),
    profileId = 'cookie-dough',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    authority = memoryRecordAuthority(db),
    bytes = Buffer.from('Exact fictional deep child source text.');
  transaction(db, () => {
    db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
      'fictional-clinic',
      'Fictional clinic',
    );
    for (let i = 0; i < parents.length; i++) {
      const filename = `fictional-${i}.txt`;
      writeFileSync(join(paths.sources, filename), bytes);
      registerIntakeFile(db, {
        id: `fictional-${i}`,
        providerId: 'fictional-clinic',
        path: `${paths.relativeRoot}/sources/${filename}`,
        sha256: digest(bytes),
        size: bytes.length,
        mimeType: 'text/plain',
        kind: 'intake_original',
        coverage: 'unknown',
        details: {
          intake: {
            version: 1,
            originalName: filename,
            proposals: [],
            parentSourceFileId: parents[i],
          },
        },
      });
    }
  });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    root,
    profileId,
    authority,
    sourceHash: digest(bytes),
    id: `fictional-${parents.length - 1}`,
  };
}
const evidence: SourceTextEvidence = {
  adapter: { name: 'fictional-source', version: '1' },
  pages: [{ page: 1, disposition: 'extracted', inspected: false }],
  spans: [
    {
      id: 'fictional-span',
      text: 'Exact fictional correction.',
      region: { page: 1 },
      provenance: 'native',
    },
  ],
  relations: [],
  issues: [],
};

test('packet ancestry work bounds duplicate seeds and ancestor advances without changing output', (t) => {
  const f = fixture(
    t,
    Array.from({ length: 130 }, (_, i) => (i ? `fictional-${i - 1}` : null)),
  );
  const expected = [...packetSourceAncestry(f.db, [f.id])];
  const iterator = packetSourceAncestryWork(
    f.db,
    Array.from({ length: 130 }, () => f.id),
  );
  let advances = 0;
  for (;;) {
    const next = iterator.next();
    advances++;
    if (!next.value && !next.done) break;
    assert.equal(next.done, false);
  }
  assert.equal(advances, 1, 'the first64 duplicate seeds produce a work checkpoint before records');
  iterator.return();
  const actual = [...packetSourceAncestryWork(f.db, [f.id])];
  assert.ok(actual.filter((value) => value === undefined).length >= 2);
  assert.deepEqual(
    actual.filter((value) => value !== undefined),
    expected,
  );
  assert.equal(expected.length, 130);
});

test('deep native capture propagates exact pins through every ancestor, replays without writes and cancels warm preparation', async (t) => {
  const f = fixture(
    t,
    Array.from({ length: 66 }, (_, i) => (i ? `fictional-${i - 1}` : null)),
  );
  await prepareIntakeSourceDependencyHeaders(f.db, f.id);
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  const objectsBefore = f.authority.objects.size;
  await prepareIntakeSourceDependencyHeaders(f.db, f.id);
  assert.equal(yielded, true);
  assert.equal(f.authority.objects.size, objectsBefore);
  const before = intakeWorkCounters(f.db).warm;
  const operation = {
    ...f,
    operationId: 'fictional-deep-source-capture',
    expectedRevisionId: null,
  };
  const captured = await runIntakeSourceExtractionOperation(operation);
  assert.equal(captured.operation.status, 'completed', JSON.stringify(captured.operation));
  assert.match(
    captured.sourceText.revision!.spans.map((span) => span.text).join(''),
    /Exact fictional deep child source text/,
  );
  const child = readIntakeSourcePin(f.db, f.id)!;
  assert.ok(child.version >= 1);
  const allPins = () =>
    Array.from({ length: 66 }, (_, i) => readIntakeSourcePin(f.db, `fictional-${i}`));
  for (const [i, pin] of allPins().entries()) {
    assert.ok(pin);
    assert.equal(pin.version, child.version);
    assert.equal(pin.dependencyToken, child.dependencyToken);
    assert.equal(pin.revisionId, i === 65 ? captured.sourceText.revision!.id : null);
  }
  const retained = allPins(),
    capturedObjects = f.authority.objects.size;
  const replay = await runIntakeSourceExtractionOperation(operation);
  assert.equal(replay.sourceText.revision!.id, captured.sourceText.revision!.id);
  assert.deepEqual(allPins(), retained);
  assert.equal(f.authority.objects.size, capturedObjects);
  const request = {
    operationId: randomUUID(),
    expectedRevisionId: captured.sourceText.revision!.id,
    sourceHash: f.sourceHash,
    evidence,
  };
  const next = publishIntakeSourceText(f.db, f.root, f.profileId, f.id, request);
  const expectedToken = digest(JSON.stringify([child.dependencyToken, f.id, next.revision!.id]));
  for (const [i, pin] of allPins().entries()) {
    assert.equal(pin!.version, child.version + 1);
    assert.equal(pin!.dependencyToken, expectedToken);
    assert.equal(pin!.revisionId, i === 65 ? next.revision!.id : null);
  }
  const nextObjects = f.authority.objects.size;
  assert.equal(
    publishIntakeSourceText(f.db, f.root, f.profileId, f.id, request).revision!.id,
    next.revision!.id,
  );
  assert.equal(f.authority.objects.size, nextObjects);
  const after = intakeWorkCounters(f.db).warm;
  for (const key of ['materializationReads', 'envelopeHydrations', 'sourceDTOHydrations'] as const)
    assert.equal(after[key], before[key], key);
  let cancelled = false;
  setImmediate(() => {
    cancelled = true;
  });
  await assert.rejects(
    prepareIntakeSourceDependencyHeaders(f.db, f.id, {
      assertRunning() {
        if (cancelled) throw Error('fictional cancellation');
      },
    }),
    /fictional cancellation/,
  );
  assert.equal(f.authority.objects.size, nextObjects);
});

for (const parents of [['fictional-1', 'fictional-0'], ['missing'], [17]] as const)
  test(`invalid source ancestry ${JSON.stringify(parents)} rolls back source revision and all ancestor pins`, async (t) => {
    const f = fixture(t, [...parents]);
    await assert.rejects(prepareIntakeSourceDependencyHeaders(f.db, f.id));
    const before = f.db.prepare('SELECT key,value FROM app_meta ORDER BY key').all(),
      objects = f.authority.objects.size;
    assert.throws(() =>
      publishIntakeSourceText(f.db, f.root, f.profileId, f.id, {
        operationId: randomUUID(),
        expectedRevisionId: null,
        sourceHash: f.sourceHash,
        evidence,
      }),
    );
    assert.deepEqual(f.db.prepare('SELECT key,value FROM app_meta ORDER BY key').all(), before);
    assert.equal(f.authority.objects.size, objects);
    assert.equal(getIntakeSourceText(f.db, f.root, f.profileId, f.id).status, 'unavailable');
  });
