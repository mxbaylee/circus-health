import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistant } from '../assistant.ts';
import { writeChat } from '../assistant-journal.ts';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import {
  intakeEnvelopeFilenameCell,
  iterateIntakeEnvelopeText,
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { ensureIntakeFrontierObserver } from '../intake-lookup-frontier-observer.ts';
import { intakeMetadataScalarMatches } from '../intake-compact-scalar.ts';
import { intakeMetadataScalarReference, intakeSourceMetadata } from '../intake-state-access.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { collectionIntakeMetadataScalarFragment } from '../intake-summary.ts';
import { intakeFilenameSummaryPrepared } from '../intake-summary-name.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { getIntakeEvidenceHeader } from '../intake.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { recordDurabilityStatus } from '../record-versions.ts';
import { fictionalModel } from './fictional-model.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

function byteReads(db: ReturnType<typeof openDatabase>) {
  const counts = intakeWorkCounters(db);
  return (
    counts.warm.collectionByteChunkReadBytes + counts.reconstruction.collectionByteChunkReadBytes
  );
}

test('actual assistant bridge reads old-native giant filename and locator metadata without serializing their full scalars', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-assistant-compact-'));
  const profileId = 'fictional-compact-assistant',
    id = 'fictional-intake';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const original = Buffer.from('Independently fictional supplied clinic evidence.');
  const source = { id, sha256: createHash('sha256').update(original).digest('hex') };
  const path = paths.relativeRoot + '/sources/fictional.txt';
  writeFileSync(join(root, path), original);
  const filename = 'fictional-' + 'quoted-"-slash-\\-'.repeat(9000) + '.txt';
  const locator = 'fictional retained location ' + 'quoted-"-line-\n-'.repeat(9000);
  const firstFilename = 'first-' + 'fictional-name-'.repeat(9000) + '.txt';
  const firstLocator = 'first location ' + 'fictional-location-'.repeat(9000);
  const unrelatedScalar = 'fictional-unrelated-raw-' + 'retained-literal-'.repeat(12000);
  const filenameSyntax = JSON.stringify(filename).replace('fictional-', '\\u0066ictional-');
  const locatorSyntax = JSON.stringify(locator).replace('fictional', '\\u0066ictional');
  const raw = JSON.stringify({
    intake: {
      version: 3,
      originalName: filename,
      locator,
      acquisition: { providerId: 'fictional-provider', provider: 'Fictional Clinic' },
      createdAt: '2026-10-01T10:00:00.000Z',
      receivedMimeType: 'text/plain',
      state: 'pending_conversion',
      metadata: { source: 'Fictional Clinic', careArea: null, documentType: null, topics: [] },
      metadataHistory: [],
      validation: {
        valid: false,
        rows: 0,
        exactRepeatedRows: 0,
        partialRows: 0,
        unrecognizedRows: 1,
        issues: [{ line: 1, message: 'Fictional text awaits a reviewed conversion proposal.' }],
        preview: [],
        previewComplete: true,
      },
      proposals: [],
      acceptedProposalId: null,
      imported: null,
      importHistory: [],
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [],
        questions: [],
        plans: [],
        reportGroups: [],
      },
    },
    literalEvidence: {
      unrelatedScalar,
      negativeZero: 'fictional-negative-zero',
      exponent: 'fictional-exponent',
    },
  })
    .replace(
      JSON.stringify(filename),
      JSON.stringify(firstFilename) + ',"originalName":' + filenameSyntax,
    )
    .replace(JSON.stringify(locator), JSON.stringify(firstLocator) + ',"locator":' + locatorSyntax)
    .replace('"negativeZero":"fictional-negative-zero"', '"negativeZero":-0')
    .replace('"exponent":"fictional-exponent"', '"exponent":1.2500e+03');
  const initial = prepareInitialIntakeEnvelope(raw);
  transaction(db, () => {
    db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
      'fictional-provider',
      'Fictional Clinic',
    );
    db.prepare(
      "INSERT INTO manual_batches(id,title,status,created_at,notes,coverage_json) VALUES(?,?,'in_progress',?,?,?)",
    ).run(
      id,
      'Source intake: fictional.txt',
      '2026-10-01T10:00:00.000Z',
      'Original upload preserved. Clinical normalization has not been performed.',
      JSON.stringify({
        sourceIntake: id,
        sourceHash: source.sha256,
        rawPreserved: true,
        clinicalProjection: 'none',
      }),
    );
    db.prepare(
      'INSERT INTO source_files(id,provider_id,path,sha256,bytes,kind,mime_type,details_json,batch_id) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      'fictional-provider',
      path,
      source.sha256,
      original.length,
      'intake_original',
      'text/plain',
      initial.detailsJson,
      id,
    );
    createIntakeStateStorage(db, { profileId, intakeId: id, sourceHash: source.sha256 }).stage(
      initial.state,
      randomUUID(),
    );
  });
  await buildIntakeCollectionEnvelope(db, source);
  transaction(db, () =>
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id),
  );
  const status = recordDurabilityStatus(db);
  assert.ok(status?.configured && !status.dirty && !status.conflicted);
  const acceptedHead = db
    .prepare('SELECT head_json FROM __record_state WHERE singleton=1')
    .get()?.head_json;
  assert.equal(typeof acceptedHead, 'string');
  assert.deepEqual(authority.objects.get('head'), Buffer.from(acceptedHead + '\n'));
  ensureIntakeFrontierObserver(db);

  // An older native envelope lacks persisted scalar facts, but retains all exact evidence.
  const { collections } = selectedEnvelopeStore(db, source);
  const cells = new Set<string>();
  for (const fieldSelection of ['first', 'last'] as const) {
    const view = openIntakeCollectionEnvelope(db, source, { fieldSelection });
    const intake = view.child(view.root(), 'intake')!;
    for (const field of ['originalName', 'locator'] as const)
      cells.add(intakeEnvelopeFilenameCell(view, intake, field).id);
  }
  assert.equal(cells.size, 4);
  const build = 'fictional.old-assistant-metadata.' + randomUUID();
  const prepare = (changes: Parameters<typeof collections.prepare>[1]['changes']) => {
    const operationId = randomUUID();
    return collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 3,
      changes,
    });
  };
  collections.commitMaintenance(
    prepare([
      {
        area: 'builds',
        collection: build,
        op: 'adoptCollection',
        fromArea: 'logical',
        fromCollection: 'envelope.data',
      },
      ...[...cells].map((cell) => ({
        area: 'builds' as const,
        collection: build,
        op: 'delete' as const,
        key: 'q:' + cell,
      })),
    ]),
  );
  const old = prepare([
    {
      area: 'logical',
      collection: 'envelope.data',
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: build,
    },
  ]);
  await collections.certifySchemaAdoptionAsync(old);
  collections.commitMaintenance(old);
  assert.equal(intakeFilenameSummaryPrepared(db, source), false);
  assert.equal([...iterateIntakeEnvelopeText(db, source)].join(''), raw);

  const prompts: string[] = [],
    results: string[] = [];
  let providerCalls = 0,
    completedTurns = 0,
    warmReadBytes = -1;
  let finishTurn!: () => void;
  const turnFinished = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const assistant = createAssistant({
    root,
    databases: new Map([[profileId, db]]),
    availability: () => ({ available: true }),
    journalWriter(root, profileId, chat, reason) {
      writeChat(root, profileId, chat, reason);
      if (reason === 'turn-idle' || reason === 'turn-failed' || reason === 'turn-cancelled')
        finishTurn();
    },
    bridgeFactory(callbacks) {
      providerCalls++;
      return {
        async start() {
          return { model: 'fictional-compact-metadata-bridge' };
        },
        async turn(prompt) {
          prompts.push(prompt);
          await callbacks.beforeRequest?.();
          await callbacks.onEvent?.('turn/started', { turn: { id: 'fictional-compact-turn' } });
          assert.ok(callbacks.onTool, 'the real assistant dispatcher supplies its tool callback');
          for (let read = 0; read < 2; read++) {
            const before = byteReads(db);
            const result = await callbacks.onTool({
              tool: 'health_intake_read',
              arguments: { id },
              callId: 'fictional-read-' + read,
            });
            results.push(JSON.stringify(result));
            if (read === 1) warmReadBytes = byteReads(db) - before;
          }
          results.push(
            JSON.stringify(
              await callbacks.onTool({
                tool: 'health_intake_plan',
                arguments: { id, action: 'read', section: 'operations', freshStart: true },
                callId: 'fictional-native-model-read',
              }),
            ),
          );
          completedTurns++;
          await callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });
        },
        async cancel() {},
        close() {},
      };
    },
  });
  t.after(() => assistant.close());
  const chat = assistant.create(profileId, { title: 'Fictional retained metadata inspection' });
  const parse = JSON.parse,
    giantScalarSyntax = new Set([
      ...[filename, locator, firstFilename, firstLocator, unrelatedScalar].map((scalar) =>
        JSON.stringify(scalar),
      ),
      filenameSyntax,
      locatorSyntax,
    ]);
  let forbiddenHydrations = 0;
  JSON.parse = (text, reviver) => {
    if (
      typeof text === 'string' &&
      Buffer.byteLength(text) > 65536 &&
      (giantScalarSyntax.has(text.trim()) ||
        (/"intake"\s*:/.test(text) && text.includes('fictional-unrelated-raw-')))
    ) {
      forbiddenHydrations++;
      throw Error('The assistant must not hydrate the selected giant envelope or complete scalar');
    }
    return Reflect.apply(parse, JSON, [text, reviver]);
  };
  try {
    assert.throws(() => JSON.parse(raw), /must not hydrate/);
    assert.throws(() => JSON.parse(locatorSyntax), /must not hydrate/);
    assert.equal(forbiddenHydrations, 2, 'the narrow fixture hydration guard is active');
    forbiddenHydrations = 0;
    assistant.send(profileId, chat.id, {
      message: 'Inspect the supplied fictional evidence without accepting it.',
      context: { route: '/import', intakeId: id },
    });
    await turnFinished;
  } finally {
    JSON.parse = parse;
  }
  assert.equal(forbiddenHydrations, 0);
  assert.equal(chat.status, 'idle', chat.error || 'the positive provider turn must finish');
  assert.equal(providerCalls, 1);
  assert.equal(completedTurns, 1);
  assert.equal(prompts.length, 1);
  assert.equal(results.length, 3);
  assert.equal(intakeFilenameSummaryPrepared(db, source), true);
  for (const serialized of [...prompts, ...results]) {
    assert.ok(
      Buffer.byteLength(serialized) < 65536,
      'actual provider payload stays within a fixed metadata window',
    );
    for (const scalar of [filename, locator, firstFilename, firstLocator, unrelatedScalar])
      assert.equal(
        serialized.includes(JSON.stringify(scalar).slice(1, -1)),
        false,
        'provider payload excludes full oversized scalars',
      );
  }
  assert.equal(JSON.parse(results[0]!).intake.format, 'health-intake-model-evidence-context-v2');
  assert.match(results[2]!, /health-intake-model-context-v2/);
  assert.ok(
    warmReadBytes >= 0 && warmReadBytes < 16384,
    'warm dispatched evidence reads do not rescan giant scalar chunks',
  );

  const beforeHeader = byteReads(db);
  const header = getIntakeEvidenceHeader(db, root, profileId, id);
  const metadata = intakeSourceMetadata(db, id);
  assert.equal(
    byteReads(db),
    beforeHeader,
    'warm source header and scalar descriptors never reread exact scalar bytes',
  );
  assert.equal(header.sourceHash, source.sha256);
  assert.equal(header.filenameDescriptor?.truncated, true);
  assert.match(header.filename, /\[shortened\]$/);
  assert.ok(Buffer.byteLength(header.filename) < 8192);
  assert.equal(header.filenameReference?.field, 'originalName');
  assert.equal(intakeMetadataScalarMatches(metadata.originalName, filename), true);
  assert.equal(intakeMetadataScalarMatches(metadata.locator, locator), true);
  for (const [field, syntax] of [
    ['originalName', filenameSyntax],
    ['locator', locatorSyntax],
  ] as const) {
    const reference = intakeMetadataScalarReference(db, id, field, metadata)!;
    assert.ok(reference, 'actual compact source metadata exposes an exact source-bound fragment');
    const fragments: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const fragment = collectionIntakeMetadataScalarFragment(db, source, {
        reference,
        cursor,
        limit: 32768,
      });
      assert.ok(Buffer.byteLength(fragment.text) <= 32768);
      fragments.push(fragment.text);
      if (fragment.complete) break;
      assert.ok(fragment.nextCursor && fragment.nextCursor !== cursor);
      cursor = fragment.nextCursor!;
    }
    assert.equal(
      fragments.join(''),
      syntax,
      'fragments retain original escape spelling, not a reserialization',
    );
  }
  assert.equal(
    [...iterateIntakeEnvelopeText(db, source)].join(''),
    raw,
    'assistant preparation preserves all duplicate scalar occurrences',
  );
  assert.ok(raw.includes('"negativeZero":-0'));
  assert.ok(raw.includes('"exponent":1.2500e+03'));
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM documents').get()?.n,
    0,
    'reading never accepts clinical evidence',
  );
});
