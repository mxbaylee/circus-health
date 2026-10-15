import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeFictionalBenchmarkPdf,
  fictionalPageMarker,
} from '../../scripts/fictional-pdf-benchmark-fixture.ts';
import { openDatabase, HttpError } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  uploadIntake,
  createIntakePlan,
  ensureNativeIntakeSchema,
  getIntakeRead,
  getRetainedIntakeOriginalReference,
} from '../intake.ts';
import { activeMappingRules } from '../clinical-import.ts';
import { prepareCollectionModelContext } from '../intake-model-collection.ts';
import { getIntakeSourceText, publishIntakeSourceText } from '../intake-source-text.ts';
import * as evidence from '../intake-evidence.ts';
import { assertIntakeEvidenceSourceTextCurrent } from '../intake-evidence.ts';
import { collectionEvidenceModelContext } from '../intake-evidence-collection.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { collectionModelIntakePins } from '../intake-model-collection-backend.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { intakeWorkCounters, withIntakeWork } from '../intake-work-accounting.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import {
  disposePdfEvidenceSessions,
  pdfEvidenceSessionDiagnostics,
} from '../intake-pdf-session.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import { fictionalModel } from './fictional-model.ts';

const object = (value: unknown) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const delta = <T extends Record<string, number>>(after: T, before: T) =>
  Object.fromEntries(Object.keys(after).map((key) => [key, after[key]! - before[key]!]));

const snapshot = (f: { db: ReturnType<typeof openDatabase> }) => ({
  ...intakeWorkCounters(f.db).warm,
  workerReads: pdfEvidenceSessionDiagnostics().requests,
  workerSessions: pdfEvidenceSessionDiagnostics().sessionsCreated,
});

async function fixture(
  t: TestContext,
  pages: number,
  options: {
    native?: boolean;
    published?: boolean;
    prepare?: boolean;
    bytes?: Buffer;
  } = {},
) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-pdf-read-reuse-')),
    profileId = 'fictional-pdf-read-reuse',
    directory = ensureProfileDirectories(root, profileId),
    db = openDatabase(directory.database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(async () => {
    await disposePdfEvidenceSessions();
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(root, 'source.pdf');
  writeFictionalBenchmarkPdf(path, pages, 'mixed');
  const source = await uploadIntake(db, root, profileId, {
    filename: 'fictional.pdf',
    bytes: options.bytes ?? readFileSync(path),
  });
  if (options.published !== false) {
    const published = publishIntakeSourceText(db, root, profileId, source.id, {
      operationId: randomUUID(),
      expectedRevisionId: null,
      sourceHash: source.sha256,
      evidence: {
        adapter: { name: 'fictional-reuse-visible-markers', version: '1' },
        pages: Array.from({ length: pages }, (_, index) => ({
          page: index + 1,
          disposition: 'partial' as const,
          inspected: false,
        })),
        spans: Array.from({ length: pages }, (_, index) => ({
          id: 'marker-' + (index + 1),
          text: fictionalPageMarker(index + 1, pages),
          region: { page: index + 1 },
          provenance: 'structured' as const,
        })),
        relations: [],
        issues: [],
      },
    });
    assert.ok(published.revision);
  }
  if (options.native !== false) {
    await createIntakePlan(db, root, profileId, source.id, {
      version: getIntakeRead(db, root, profileId, source.id).version,
    });
    await ensureNativeIntakeSchema(db, profileId, source.id);
  }
  const mappingVersion = createHash('sha256')
    .update(JSON.stringify(activeMappingRules(db, source.providerId)))
    .digest('hex');
  if (options.native !== false && options.prepare !== false)
    await prepareCollectionModelContext(
      db,
      root,
      profileId,
      source.id,
      {
        format: 'health-intake-model-context-request-v2',
        section: 'plan',
        freshStart: true,
      },
      { mappingVersion },
    );
  let guard = () => {};
  const context = {
    db,
    root,
    profileId,
    id: source.id,
    modelContext: true,
    pagedContext: true as const,
    pdf: true,
    assertRunning() {
      guard();
    },
  };
  const validate = (result: unknown) => {
    assertIntakeEvidenceSourceTextCurrent(context, result);
  };
  return {
    root,
    profileId,
    db,
    context,
    mappingVersion,
    path,
    source,
    validate,
    setGuard(next: () => void) {
      guard = next;
    },
    read(page = 1) {
      return evidence.readIntakeEvidence({ ...context, page });
    },
  };
}

for (const pages of [4, 16])
  test(
    `native PDF ${pages}-page checked reads preserve exact model and literal source authority`,
    { timeout: 120_000 },
    async (t) => {
      const f = await fixture(t, pages),
        initialHash = createHash('sha256').update(readFileSync(f.path)).digest('hex');
      const rows = [];
      for (let page = 1; page <= pages; page++) {
        const before = snapshot(f),
          work = intakeWorkCounters(f.db).warm;
        const records = createRecordVersionWorkCounters(),
          files = createIntakeFileWorkCounters();
        const result = await withRecordVersionWork(records, () =>
          withIntakeFileWork(files, async () => {
            const value = await f.read(page);
            f.validate(value);
            return value;
          }),
        );
        const measured = delta(snapshot(f), before),
          counted = delta(intakeWorkCounters(f.db).warm, work);
        assert.equal(
          measured.sourceTextReadCalls,
          1,
          'one full reader before worker; post-read uses its checked receipt',
        );
        const metadata = object(object(result).metadata),
          original = object(metadata.original);
        assert.equal(original.page, page);
        assert.equal(original.totalPages, pages);
        assert.deepEqual(
          metadata.intake,
          collectionEvidenceModelContext(f.db, f.profileId, f.source.id, f.mappingVersion, page),
        );
        const text = getIntakeSourceText(f.db, f.root, f.profileId, f.source.id);
        assert.equal(text.revision?.spans[page - 1]?.text, fictionalPageMarker(page, pages));
        rows.push({
          page,
          operations: measured,
          counted,
          recordVersions: records.operation,
          files,
        });
      }
      assert.equal(
        createHash('sha256')
          .update(
            readFileSync(
              getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, f.source.id).path,
            ),
          )
          .digest('hex'),
        initialHash,
      );
      console.log(
        JSON.stringify({
          kind: 'pdf-checked-read-attempts',
          pages,
          rows,
        }),
      );
    },
  );

test(
  'native PDF fallback emits detached exact context after earlier output mutation',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 2),
      result = object(await f.read()),
      expected = collectionEvidenceModelContext(
        f.db,
        f.profileId,
        f.source.id,
        f.mappingVersion,
        1,
      );
    const model = object(object(result.metadata).intake);
    object(model.pins).sourceHash = 'caller mutation';
    object((model.sections as unknown[])[0]).state = 'caller mutation';
    assert.equal(typeof result.pdfFallback, 'function');
    const fallback = object(await (result.pdfFallback as () => Promise<unknown>)());
    f.validate(fallback);
    assert.deepEqual(object(fallback.metadata).intake, expected);
    assert.notEqual(object(fallback.metadata).intake, model);
  },
);

test(
  'a changed-before-admission text receipt follows the original full validator and refuses corrupt body',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 2),
      result = await f.read();
    const row = f.db
      .prepare("SELECT key,value FROM app_meta WHERE key LIKE ? AND key LIKE '%:blob:%' LIMIT 1")
      .get('intake_source_text:v1:' + f.source.id + ':%')!;
    assert.equal(typeof row.value, 'string');
    const before = snapshot(f),
      stamp = reviewReadStamp(f.db);
    f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', row.key);
    assert.notEqual(reviewReadStamp(f.db), stamp);
    assert.throws(() => f.validate(result), /inconsistent|integrity|revision/i);
    assert.equal(snapshot(f).sourceTextReadCalls - before.sourceTextReadCalls, 1);
    f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(row.value, row.key);
  },
);

test(
  'native PDF preserves complete corrupt-text refusal before worker I/O',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 2),
      before = snapshot(f);
    const row = f.db
      .prepare("SELECT key,value FROM app_meta WHERE key LIKE ? AND key LIKE '%:blob:%' LIMIT 1")
      .get('intake_source_text:v1:' + f.source.id + ':%')!;
    f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', row.key);
    let failure: unknown;
    try {
      await f.read();
    } catch (error) {
      failure = error;
    }
    assert.ok(
      failure instanceof Error && /inconsistent|integrity|revision/i.test(failure.message),
      String(failure),
    );
    assert.equal(snapshot(f).workerReads, before.workerReads);
    assert.equal(snapshot(f).workerSessions, before.workerSessions);
    f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(row.value, row.key);
  },
);

test(
  'native PDF current revision replacement and TEMP change use complete fresh validation before reuse admission',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 2),
      result = await f.read();
    const old = getIntakeSourceText(f.db, f.root, f.profileId, f.source.id);
    assert.ok(old.revision);
    const next = publishIntakeSourceText(f.db, f.root, f.profileId, f.source.id, {
      operationId: randomUUID(),
      expectedRevisionId: old.revision.id,
      sourceHash: f.source.sha256,
      evidence: {
        adapter: old.revision.adapter,
        pages: old.revision.pages,
        spans: old.revision.spans.map((span, index) =>
          index ? span : { ...span, text: span.text + ' changed' },
        ),
        issues: old.revision.issues,
        relations: old.revision.relations,
      },
    });
    assert.notEqual(next.revision?.id, old.revision.id);
    let before = snapshot(f);
    f.validate(result);
    assert.equal(snapshot(f).sourceTextReadCalls - before.sourceTextReadCalls, 1);
    const current = await f.read();
    f.db.exec('CREATE TEMP TABLE fictional_pdf_receipt_miss(value TEXT)');
    before = snapshot(f);
    f.validate(current);
    assert.equal(snapshot(f).sourceTextReadCalls - before.sourceTextReadCalls, 1);
  },
);

for (const stimulus of ['head', 'original', 'raw-rollback', 'peer-ABA'] as const)
  test(
    `selected PDF receipt refuses callback-only ${stimulus} mutation without fresh validation`,
    { timeout: 120_000 },
    async (t) => {
      const f = await fixture(t, 2),
        result = await f.read(),
        before = snapshot(f);
      const previousLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 64;
      let injected = false,
        restored = false;
      const path =
        stimulus === 'head'
          ? join(contributorAuthorityPath(f.root, f.profileId), 'head')
          : getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, f.source.id).path;
      const original = readFileSync(path),
        originalStamp = reviewReadStamp(f.db);
      f.setGuard(() => {
        if (injected || !new Error().stack?.includes('pdfReceiptBinding')) return;
        injected = true;
        if (stimulus === 'head' || stimulus === 'original')
          writeFileSync(path, Buffer.concat([original, Buffer.from('x')]));
        else if (stimulus === 'raw-rollback') {
          f.db.exec('SAVEPOINT fictional_pdf_aba');
          f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional_pdf_callback', 'x');
          f.db.exec('ROLLBACK TO fictional_pdf_aba');
          f.db.exec('RELEASE fictional_pdf_aba');
          restored = !f.db
            .prepare('SELECT 1 FROM app_meta WHERE key=?')
            .get('fictional_pdf_callback');
        } else {
          const peer = openDatabase(
            ensureProfileDirectories(f.root, f.profileId).database,
            f.profileId,
          );
          try {
            peer.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional_pdf_callback', 'x');
            peer.prepare('DELETE FROM app_meta WHERE key=?').run('fictional_pdf_callback');
          } finally {
            peer.close();
          }
          restored = !f.db
            .prepare('SELECT 1 FROM app_meta WHERE key=?')
            .get('fictional_pdf_callback');
        }
      });
      let failure: unknown;
      try {
        f.validate(result);
      } catch (error) {
        failure = error;
      } finally {
        f.setGuard(() => {});
        Error.stackTraceLimit = previousLimit;
        if (stimulus === 'head' || stimulus === 'original') {
          assert.notDeepEqual(readFileSync(path), original);
          writeFileSync(path, original);
          restored = readFileSync(path).equals(original);
        }
      }
      assert.ok(injected, 'actual selected receipt callback was reached');
      assert.ok(restored, 'the stimulus was restored outside the rejection oracle');
      if (stimulus === 'raw-rollback' || stimulus === 'peer-ABA')
        assert.notEqual(reviewReadStamp(f.db), originalStamp);
      if (stimulus === 'head') {
        assert.ok(failure instanceof SyntaxError, String(failure));
        assert.equal(
          failure.message,
          'Unexpected non-whitespace character after JSON at position ' +
            original.toString('utf8').length +
            ' (line 2 column 1)',
        );
      } else if (stimulus === 'original') {
        assert.ok(failure instanceof HttpError, String(failure));
        assert.equal(failure.status, 409);
        assert.equal(failure.code, 'SOURCE_CHANGED');
        assert.equal(failure.message, 'The retained original no longer matches its hash');
      } else
        assert.ok(
          failure instanceof Error &&
            /changed|authority|record|head|source|integrity|journal/i.test(failure.message),
          String(failure),
        );
      assert.equal(
        snapshot(f).sourceTextReadCalls,
        before.sourceTextReadCalls,
        'selected failure cannot enter the fresh source-text validator',
      );
    },
  );

test(
  'cancelled or closed native PDF receipt never revives its caller',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 2),
      result = await f.read();
    f.setGuard(() => {
      throw Error('Fictional PDF caller cancelled');
    });
    assert.throws(() => f.validate(result), /caller cancelled/);
    f.setGuard(() => {});
    f.db.close();
    assert.throws(() => f.validate(result), /closed|open|finalized/i);
  },
);

// Tiny real PDF used for attachment/annotation branches; no worker mocking.
function branchPdf(kind: 'plain' | 'attachment' | 'annotation') {
  const literal = 'Fictional native PDF branch page';
  const stream = 'BT /F1 12 Tf 72 720 Td (' + literal + ') Tj ET';
  const attachment = 'Fictional retained attachment 12.00 mg';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R ' +
      (kind === 'attachment'
        ? '/Names << /EmbeddedFiles << /Names [(fictional.txt) 5 0 R] >> >>'
        : '') +
      ' >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R ' +
      (kind === 'annotation'
        ? '/Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /A << /S /URI /URI (https://fictional.example/) >> >>]'
        : '') +
      ' >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Filespec /F (fictional.txt) /UF (fictional.txt) /EF << /F 6 0 R >> >>',
    '<< /Type /EmbeddedFile /Length ' +
      Buffer.byteLength(attachment) +
      ' >>\nstream\n' +
      attachment +
      '\nendstream',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += i + 1 + ' 0 obj\n' + obj + '\nendobj\n';
  }
  const xref = Buffer.byteLength(text);
  text +=
    'xref\n0 ' +
    offsets.length +
    '\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((x) => String(x).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    'trailer\n<< /Size ' +
    offsets.length +
    ' /Root 1 0 R >>\nstartxref\n' +
    xref +
    '\n%%EOF\n';
  return Buffer.from(text);
}

for (const mode of ['legacy', 'pending'] as const)
  test(
    mode +
      ' PDF model evidence remains page-correct through lazy fallback without a native receipt',
    { timeout: 120_000 },
    async (t) => {
      const f = await fixture(t, 2, { native: false }),
        before = snapshot(f);
      const result = object(
        await evidence.readIntakeEvidence({
          ...f.context,
          pagedContext: mode === 'pending',
          page: 2,
        }),
      );
      const model = object(object(result.metadata).intake);
      if (mode === 'pending') assert.equal(model.format, 'health-intake-model-evidence-pending-v1');
      else assert.notEqual(model.format, 'health-intake-model-evidence-context-v2');
      assert.equal(object(object(result.metadata).original).page, 2);
      const fallback = object(await (result.pdfFallback as () => Promise<unknown>)());
      f.validate(fallback);
      assert.deepEqual(object(fallback.metadata).intake, model);
      assert.equal(object(object(fallback.metadata).original).page, 2);
      assert.equal(snapshot(f).sourceTextReadCalls - before.sourceTextReadCalls, 2);
    },
  );

test(
  'unavailable durable text preserves original full post-read validation without capture',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 1, { published: false, prepare: false });
    assert.equal(getIntakeSourceText(f.db, f.root, f.profileId, f.source.id).revision, null);
    const before = snapshot(f);
    const result = await evidence.readIntakeEvidence({
      ...f.context,
      captureSourceText: false,
    });
    f.validate(result);
    assert.equal(
      snapshot(f).sourceTextReadCalls - before.sourceTextReadCalls,
      1,
      'original full reader is invoked despite unavailable revision',
    );
    assert.equal(getIntakeSourceText(f.db, f.root, f.profileId, f.source.id).revision, null);
    assert.equal(
      object(object(object(result).metadata).intake).format,
      'health-intake-model-evidence-context-v2',
    );
  },
);

test(
  'automatic PDF capture validates the newly published current revision before any receipt use',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 1, { published: false, prepare: false }),
      transitions: unknown[] = [];
    const before = getIntakeSourceText(f.db, f.root, f.profileId, f.source.id);
    assert.equal(before.revision, null);
    const result = await evidence.readIntakeEvidence({
      ...f.context,
      onSourceTextCaptured: (transition) => transitions.push(transition),
    });
    assert.equal(transitions.length, 1);
    const current = getIntakeSourceText(f.db, f.root, f.profileId, f.source.id);
    assert.ok(current.revision);
    assert.equal(
      object(object(result).metadata).sourceText &&
        object(object(object(result).metadata).sourceText).revisionId,
      current.revision.id,
    );
    const checkpoint = snapshot(f);
    f.validate(result);
    assert.equal(
      snapshot(f).sourceTextReadCalls - checkpoint.sourceTextReadCalls,
      1,
      'pre-capture missing revision cannot certify the captured graph',
    );
    const fallback = await (object(result).pdfFallback as () => Promise<unknown>)();
    f.validate(fallback);
    assert.equal(object(object(object(fallback).metadata).original).page, 1);
  },
);

test(
  'real embedded child publication misses the prior receipt and retains exact fallback routing',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 1, { bytes: branchPdf('attachment') }),
      stamp = reviewReadStamp(f.db);
    const result = object(await f.read()),
      original = object(object(result.metadata).original);
    const assets = original.assets as Array<{ id: string; filename: string }>;
    const child = assets.find((asset) => asset.id !== f.source.id);
    assert.ok(child);
    assert.equal(child.filename, 'fictional.txt');
    assert.notEqual(reviewReadStamp(f.db), stamp);
    const afterRead = snapshot(f);
    f.validate(result);
    assert.equal(
      snapshot(f).sourceTextReadCalls - afterRead.sourceTextReadCalls,
      1,
      'child publication requires fresh post-read validation',
    );
    const fallback = object(await (result.pdfFallback as () => Promise<unknown>)());
    f.validate(fallback);
    assert.deepEqual(object(object(fallback.metadata).original).assets, original.assets);
    assert.equal(object(object(fallback.metadata).original).page, 1);
    assert.equal(
      object(fallback.metadata).caution,
      'Native PDF input was unavailable for this page; a raster preview of the same original page is supplied.',
    );
  },
);

test(
  'native PDF section manifest corruption refuses before actual worker I/O',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 1),
      { collections } = selectedEnvelopeStore(f.db, { id: f.source.id }),
      view = collections.openView(),
      pins = collectionModelIntakePins(f.db, { id: f.source.id }, f.mappingVersion),
      operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(view, {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: pins.domainVersion,
        changes: [
          {
            area: 'builds',
            collection: 'model.sections',
            op: 'put',
            key: 'plan',
            value: JSON.stringify({
              format: 'health-intake-model-section-v3',
              section: 'plan',
              pins,
              collection: 'model.fictional',
              root: '',
              count: -1,
            }),
          },
        ],
      }),
    );
    const before = snapshot(f);
    await assert.rejects(f.read(), /Invalid model section manifest/);
    assert.equal(snapshot(f).workerReads, before.workerReads);
    assert.equal(snapshot(f).workerSessions, before.workerSessions);
  },
);

test(
  'unsupported native page preserves same-page raster and complete receipt validation',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 1, { bytes: branchPdf('annotation') }),
      result = object(await f.read());
    assert.equal(result.pdfContent, undefined);
    assert.match(String(result.imageContent), /^data:image\/png;base64,/);
    assert.equal(object(object(result.metadata).original).page, 1);
    assert.match(String(object(result.metadata).caution), /Native PDF input was unavailable/);
    f.validate(result);
  },
);

test(
  'full source-text attempted-read accounting includes unavailable and refused authority',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 1, { native: false, published: false }),
      before = intakeWorkCounters(f.db);
    assert.equal(getIntakeSourceText(f.db, f.root, f.profileId, f.source.id).status, 'unavailable');
    assert.throws(
      () => getIntakeSourceText(f.db, f.root, f.profileId, 'fictional-missing-source'),
      { code: 'INTAKE_NOT_FOUND' },
    );
    const after = intakeWorkCounters(f.db);
    assert.equal(after.warm.sourceTextReadCalls - before.warm.sourceTextReadCalls, 2);
    assert.equal(
      after.reconstruction.sourceTextReadCalls,
      before.reconstruction.sourceTextReadCalls,
    );
  },
);

test(
  'full source-text attempted reads preserve same-database reconstruction attribution and restore nested owners',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, 1, { native: false, published: false }),
      other = openDatabase(join(f.root, 'other.sqlite'), f.profileId);
    try {
      let before = intakeWorkCounters(f.db);
      withIntakeWork(f.db, 'reconstruction', () =>
        getIntakeSourceText(f.db, f.root, f.profileId, f.source.id),
      );
      let after = intakeWorkCounters(f.db);
      assert.equal(
        after.reconstruction.sourceTextReadCalls - before.reconstruction.sourceTextReadCalls,
        1,
      );
      assert.equal(after.warm.sourceTextReadCalls, before.warm.sourceTextReadCalls);
      before = after;
      const foreign = intakeWorkCounters(other);
      withIntakeWork(other, 'reconstruction', () => {
        getIntakeSourceText(f.db, f.root, f.profileId, f.source.id);
        assert.throws(
          () => getIntakeSourceText(other, f.root, f.profileId, 'fictional-missing-source'),
          { code: 'INTAKE_NOT_FOUND' },
        );
      });
      after = intakeWorkCounters(f.db);
      assert.equal(after.warm.sourceTextReadCalls - before.warm.sourceTextReadCalls, 1);
      assert.equal(
        after.reconstruction.sourceTextReadCalls,
        before.reconstruction.sourceTextReadCalls,
      );
      assert.equal(
        intakeWorkCounters(other).reconstruction.sourceTextReadCalls -
          foreign.reconstruction.sourceTextReadCalls,
        1,
      );
      const restored = intakeWorkCounters(f.db);
      getIntakeSourceText(f.db, f.root, f.profileId, f.source.id);
      assert.equal(
        intakeWorkCounters(f.db).warm.sourceTextReadCalls - restored.warm.sourceTextReadCalls,
        1,
      );
    } finally {
      other.close();
    }
  },
);
