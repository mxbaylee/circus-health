import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { openDatabase, transaction } from '../database.ts';
import { attachRecordDurability } from '../record-versions.ts';
import {
  encodeIntakeReferencedEnvelope,
  INTAKE_REFERENCED_ENVELOPE_FORMAT,
} from '../intake-compact-envelope.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { openVault } from '../vault-store.ts';
import { freshKey } from '../vault-crypto.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { clearIntakeStateCache, createIntakeStateStorage } from '../intake-state-storage.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { prepareIntakeFilenameSummary } from '../intake-summary-name.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { parseSchemaControl } from '../intake-envelope-schema.ts';
import { hashIntakeJsonScalar } from '../intake-json-scalar.ts';
import {
  openAcceptedIntakeSourceColumn,
  readAcceptedIntakeSourceColumn,
} from '../intake-accepted-source-column.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import {
  captureReferencedEnvelopeRead,
  closeReferencedEnvelopeRead,
  referencedEnvelopeCurrentField,
  referencedEnvelopeCurrentFieldPart,
  referencedEnvelopeProviderSelector,
  referencedEnvelopeParentSelector,
  referencedEnvelopeCurrentStringField,
  referencedEnvelopeCurrentView,
  referencedEnvelopeFieldPart,
  referencedEnvelopeFilenameReference,
} from '../intake-referenced-envelope-access.ts';
import type { IntakeFilenameFragment, IntakeSummaryV3 } from '../../shared/intake-summary.ts';

test('accepted V3 scope reads bounded historical V4 name and refuses expired physical owner', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-referenced-read-')),
    profileId = 'fictional-referenced-read',
    intakeId = 'fictional-referenced-read-intake',
    paths = ensureProfileDirectories(root, profileId),
    key = freshKey(),
    vault = openVault({ directory: paths.root, profileId, key, initialize: true }),
    db = openDatabase(paths.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
    vault.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  attachRecordDurability(db, { profileId, storage: vault.recordStorage() });
  const original = Buffer.from('Independently fictional historical reference.'),
    sourceHash = createHash('sha256').update(original).digest('hex'),
    path = profilePaths(root, profileId).relativeRoot + '/sources/reference.pdf',
    name = 'fictional-' + '🌿'.repeat(5000) + '.pdf',
    identity = { profileId, intakeId, sourceHash };
  writeFileSync(join(root, path), original);
  vault.storeFile(path, original);
  vault.publish();
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: name,
      state: 'ready',
      createdAt: '2026-01-02T03:04:05.000Z',
    },
  });
  transaction(db, () => {
    db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
      'Fictional Provider',
      'Independently fictional provider',
    );
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,provider_id,details_json) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      intakeId,
      path,
      sourceHash,
      original.length,
      'intake_original',
      'application/pdf',
      'Fictional Provider',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, { id: intakeId, sha256: sourceHash });
  await prepareIntakeFilenameSummary(db, { id: intakeId, sha256: sourceHash });
  const collections = selectedEnvelopeStore(db, { id: intakeId, sha256: sourceHash }).collections,
    before = collections.binding(collections.openView())!,
    mode = parseSchemaControl(
      collections.get(collections.openView(), 'logical', 'envelope.control', 'representation'),
    ).mode;
  assert.ok(before.logical.root);
  const descriptor = encodeIntakeReferencedEnvelope({
    intakeAuthority: {
      format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
      identity,
      mode,
      storageSequence: before.storageSequence,
      logicalRoot: before.logical.root,
      sourceLabel: { kind: 'missing' },
    },
  });
  const wrongMode = encodeIntakeReferencedEnvelope({
    intakeAuthority: {
      format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
      identity,
      mode: mode === 'raw' ? 'normalized' : 'raw',
      storageSequence: before.storageSequence,
      logicalRoot: before.logical.root,
      sourceLabel: { kind: 'missing' },
    },
  });
  transaction(db, () => {
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(wrongMode, intakeId);
    db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(
      intakeNamespace(identity) + 'head',
    );
  });
  const wrongVersionId = String(
    db
      .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
      .get('source_files', JSON.stringify([intakeId]))!.version_id,
  );
  const wrongScope = await captureReferencedEnvelopeRead(
    db,
    identity,
    wrongVersionId,
    () => {},
    'current',
  );
  try {
    assert.throws(
      () => referencedEnvelopeCurrentField(wrongScope, 'intake.state'),
      /current envelope mode changed/,
    );
    assert.throws(
      () => referencedEnvelopeCurrentFieldPart(wrongScope, 'intake.metadata.source'),
      /current envelope mode changed/,
    );
    await assert.rejects(
      referencedEnvelopeCurrentStringField(wrongScope, 'intake.metadata.source'),
      /current envelope mode changed/,
    );
    assert.throws(
      () => referencedEnvelopeFieldPart(wrongScope, 'intake.metadata.source'),
      /historical mode changed/,
    );
  } finally {
    closeReferencedEnvelopeRead(wrongScope);
  }
  transaction(db, () => {
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(descriptor, intakeId);
    db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(
      intakeNamespace(identity) + 'head',
    );
  });
  const sourceVersionId = String(
    db
      .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
      .get('source_files', JSON.stringify([intakeId]))!.version_id,
  );
  const exactMime = await readAcceptedIntakeSourceColumn(
    db,
    identity,
    sourceVersionId,
    'mime_type',
    () => {},
  );
  assert.ok(exactMime);
  assert.equal(exactMime.preview, 'application/pdf');
  assert.equal(exactMime.bytes, Buffer.byteLength('application/pdf'));
  assert.ok(exactMime.work.maxChunk <= 16 * 1024);
  // The fixture selects a fictional provider, so its accepted column is a value.
  const exactProvider = await readAcceptedIntakeSourceColumn(
    db,
    identity,
    sourceVersionId,
    'provider_id',
    () => {},
  );
  assert.ok(exactProvider);
  assert.equal(exactProvider.preview, 'Fictional Provider');
  assert.equal(exactProvider.bytes, Buffer.byteLength('Fictional Provider'));
  assert.ok(exactProvider.work.maxChunk <= 16 * 1024);
  const referenceScope = await captureReferencedEnvelopeRead(
    db,
    identity,
    sourceVersionId,
    () => {},
    'current',
  );
  assert.equal(referencedEnvelopeCurrentField(referenceScope, 'intake.state'), 'ready');
  const selectedView = referencedEnvelopeCurrentView(referenceScope);
  const selectedIntake = selectedView.child(selectedView.root(), 'intake');
  assert.ok(selectedIntake);
  assert.deepEqual(selectedView.field(selectedIntake, 'state', { bytes: 4096 }), {
    kind: 'value',
    value: 'ready',
  });
  const reference = referencedEnvelopeFilenameReference(referenceScope);
  closeReferencedEnvelopeRead(referenceScope);
  assert.throws(() => selectedView.info(selectedIntake), /scope closed/);
  let summary: IntakeSummaryV3 | undefined;
  assert.equal(
    await handleIntakeRoute({
      resource: 'intakes',
      id: intakeId,
      method: 'GET',
      params: new URLSearchParams(),
      req: new IncomingMessage(new Socket()),
      db,
      root,
      profileId,
      respond: (value) => {
        summary = value as IntakeSummaryV3;
      },
      list: () => assert.fail('unexpected list'),
      body: async () => assert.fail('unexpected body'),
      assistant: {} as never,
    }),
    true,
  );
  assert.ok(summary);
  assert.equal(summary.format, 'health-intake-summary-v3');
  assert.equal(summary.id, intakeId);
  assert.equal(summary.state, 'ready');
  assert.equal(summary.version, selectedView.logical.domainVersion);
  assert.equal(summary.collections.proposals.total, 0);
  assert.equal(summary.metadataState, 'complete');
  assert.deepEqual(summary.metadata, {
    source: null,
    careArea: null,
    documentType: null,
    topics: [],
  });
  assert.deepEqual(summary.source.mimeType, { kind: 'value', value: 'application/pdf' });
  assert.equal(summary.source.providerName.state, 'unloaded');
  assert.equal(summary.acquisition.state, 'unloaded');
  assert.ok(summary.filenameTruncated);
  assert.deepEqual(summary.filenameReference, reference);
  const routeFragment = async (cursor?: string) => {
    let response: IntakeFilenameFragment | undefined;
    assert.equal(
      await handleIntakeRoute({
        resource: 'intakes',
        id: intakeId,
        action: 'filename-fragment',
        method: 'POST',
        params: new URLSearchParams(),
        req: Object.assign(new IncomingMessage(new Socket()), {
          headers: { 'content-type': 'application/json' },
        }),
        db,
        root,
        profileId,
        respond: (value) => {
          response = value as IntakeFilenameFragment;
        },
        list: () => assert.fail('unexpected list'),
        body: async () => Buffer.from(JSON.stringify({ reference, cursor, limit: 4096 })),
        assistant: {} as never,
      }),
      true,
    );
    assert.ok(response);
    return response;
  };
  const firstRoute = await routeFragment();
  assert.equal(firstRoute.reference.format, 'health-intake-filename-reference-v2');
  assert.ok(firstRoute.nextCursor && !firstRoute.complete);
  assert.ok(Buffer.byteLength(firstRoute.text) < 4096, 'page stops before a split UTF-8 scalar');
  await assert.rejects(routeFragment('%%%'), { code: 'INTAKE_FILENAME_WINDOW' });
  const lexicalName = JSON.stringify(name);
  const insideEmoji = Buffer.byteLength(lexicalName.slice(0, lexicalName.indexOf('🌿'))) + 1;
  assert.equal(Buffer.from(lexicalName)[insideEmoji]! & 0xc0, 0x80);
  await assert.rejects(
    routeFragment(
      Buffer.from(JSON.stringify({ base: null, offset: insideEmoji })).toString('base64url'),
    ),
    { code: 'INTAKE_FILENAME_WINDOW' },
  );
  const secondRoute = await routeFragment(firstRoute.nextCursor);
  const routePages = [firstRoute.text, secondRoute.text];
  let routeCursor = secondRoute.nextCursor;
  while (routeCursor) {
    const page = await routeFragment(routeCursor);
    routePages.push(page.text);
    routeCursor = page.nextCursor;
    assert.equal(page.complete, routeCursor === null);
  }
  assert.equal(routePages.join(''), JSON.stringify(name));
  const operationId = randomUUID(),
    later = collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: before.logical.domainVersion + 1,
      changes: [
        {
          area: 'logical',
          collection: 'fictional.reference.marker',
          op: 'put',
          key: 'later',
          value: 'accepted',
        },
      ],
    });
  transaction(db, () => collections.stage(later));
  clearIntakeStateCache(db);
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, async () => {
    let running = true;
    const scope = await captureReferencedEnvelopeRead(
      db,
      identity,
      sourceVersionId,
      () => {
        if (!running) throw Error('Fictional read cancelled');
      },
      'current',
    );
    let provider: Awaited<ReturnType<typeof referencedEnvelopeProviderSelector>> | undefined;
    try {
      provider = await referencedEnvelopeProviderSelector(scope);
      assert.equal(provider.exact(), 'Fictional Provider');
      assert.equal(provider.matches('Fictional Provider'), true);
      assert.equal(provider.matches('Other Provider'), false);
      const parent = await referencedEnvelopeParentSelector(scope);
      assert.equal(parent.exact(), undefined);
      assert.equal(parent.matches('fictional-unrelated-original'), false);
      assert.equal(referencedEnvelopeCurrentField(scope, 'intake.state'), 'ready');
      const currentView = referencedEnvelopeCurrentView(scope);
      assert.equal(currentView.logical.domainVersion, before.logical.domainVersion + 1);
      const parts: Buffer[] = [];
      let after: string | undefined;
      let firstCold: number | undefined;
      for (;;) {
        const part = referencedEnvelopeFieldPart(scope, 'intake.originalName', after);
        assert.ok(part && part.kind === 'bytes');
        assert.ok(part.chunk.length > 0 && part.chunk.length <= 16 * 1024);
        parts.push(part.chunk);
        firstCold ??= work.operation.vaultBackingColdReplays;
        if (part.complete) break;
        assert.ok(part.after && part.after !== after);
        after = part.after;
        await setImmediate();
      }
      assert.equal(Buffer.concat(parts).toString('utf8'), JSON.stringify(name));
      assert.equal(work.operation.vaultBackingColdReplays, firstCold);
      const currentParts: Buffer[] = [];
      let currentAfter: string | undefined;
      for (;;) {
        const part = referencedEnvelopeCurrentFieldPart(scope, 'intake.originalName', currentAfter);
        assert.ok(part && part.kind === 'bytes');
        assert.ok(part.chunk.length > 0 && part.chunk.length <= 16 * 1024);
        currentParts.push(part.chunk);
        if (part.complete) break;
        assert.ok(part.after && part.after !== currentAfter);
        currentAfter = part.after;
        await setImmediate();
      }
      assert.equal(Buffer.concat(currentParts).toString('utf8'), JSON.stringify(name));
      assert.equal(work.operation.vaultBackingColdReplays, firstCold);
      assert.deepEqual(await referencedEnvelopeCurrentStringField(scope, 'intake.state'), {
        kind: 'value',
        value: 'ready',
      });
      assert.deepEqual(await referencedEnvelopeCurrentStringField(scope, 'intake.originalName'), {
        kind: 'reference',
        bytes: Buffer.byteLength(JSON.stringify(name)),
        scalarHash: hashIntakeJsonScalar([JSON.stringify(name)]).hash,
      });
      assert.equal(work.operation.vaultBackingColdReplays, firstCold);
      assert.equal(referencedEnvelopeFieldPart(scope, 'intake.metadata.source'), undefined);
      assert.equal(referencedEnvelopeCurrentFieldPart(scope, 'intake.metadata.source'), undefined);
      assert.deepEqual(
        await referencedEnvelopeCurrentStringField(scope, 'intake.metadata.source'),
        {
          kind: 'missing',
        },
      );
      running = false;
      assert.throws(() => referencedEnvelopeFieldPart(scope, 'intake.originalName'));
    } finally {
      running = true;
      closeReferencedEnvelopeRead(scope);
    }
    assert.throws(() => referencedEnvelopeFieldPart(scope, 'intake.originalName'));
    assert.throws(() => provider?.matches('Fictional Provider'));
  });
  const giantMime = 'fictional/' + '🌿'.repeat(12_000) + '\u0000\uFEFF';
  const progressed = collections.binding(collections.openView());
  assert.ok(progressed?.logical.root);
  const progressedDescriptor = encodeIntakeReferencedEnvelope({
    intakeAuthority: {
      format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
      identity,
      mode,
      storageSequence: progressed.storageSequence,
      logicalRoot: progressed.logical.root,
      sourceLabel: { kind: 'missing' },
    },
  });
  transaction(db, () => {
    db.prepare('UPDATE source_files SET mime_type=?,details_json=? WHERE id=?').run(
      giantMime,
      progressedDescriptor,
      intakeId,
    );
    db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(
      intakeNamespace(identity) + 'head',
    );
  });
  const giantVersionId = String(
    db
      .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
      .get('source_files', JSON.stringify([intakeId]))!.version_id,
  );
  const pageWork = createRecordVersionWorkCounters();
  await withRecordVersionWork(pageWork, async () => {
    const field = await openAcceptedIntakeSourceColumn(
      db,
      identity,
      giantVersionId,
      'mime_type',
      () => {},
    );
    assert.ok(field);
    try {
      assert.equal(field.bytes, Buffer.byteLength(giantMime));
      assert.equal(field.preview, null);
      const replayCount = pageWork.operation.vaultBackingColdReplays;
      const initialReads = field.work.chunks;
      const pieces: string[] = [];
      let ordinal = 0;
      for (;;) {
        const page = field.page(ordinal, 8192, () => {});
        assert.ok(Buffer.byteLength(page.text) <= 8192);
        pieces.push(page.text);
        assert.equal(pageWork.operation.vaultBackingColdReplays, replayCount);
        if (page.complete) {
          assert.equal(page.nextOrdinal, null);
          break;
        }
        assert.equal(page.nextOrdinal, ++ordinal);
      }
      assert.equal(pieces.join(''), giantMime);
      assert.ok(field.work.chunks > initialReads);
      assert.ok(field.work.maxChunk <= 16 * 1024);
      assert.throws(() => field.page(ordinal + 1, 8192, () => {}));
    } finally {
      field.close();
    }
  });
  const physical = join(paths.root, 'vault', 'manifest.enc'),
    saved = physical + '.fictional-original',
    originalPhysical = readFileSync(physical),
    scope = await captureReferencedEnvelopeRead(db, identity, giantVersionId, () => {}, 'current');
  try {
    const first = referencedEnvelopeFieldPart(scope, 'intake.originalName');
    assert.ok(first && first.kind === 'bytes' && !first.complete);
    renameSync(physical, saved);
    writeFileSync(physical, originalPhysical);
    assert.throws(() => referencedEnvelopeFieldPart(scope, 'intake.originalName', first.after!));
  } finally {
    if (existsSync(saved)) renameSync(saved, physical);
    try {
      closeReferencedEnvelopeRead(scope);
    } catch (error) {
      assert.match(String(error), /original|interval|accepted|physical/i);
    }
  }
  const finalScope = await captureReferencedEnvelopeRead(
    db,
    identity,
    giantVersionId,
    () => {},
    'current',
  );
  assert.ok(referencedEnvelopeFieldPart(finalScope, 'intake.originalName'));
  try {
    renameSync(physical, saved);
    writeFileSync(physical, originalPhysical);
    assert.throws(
      () => closeReferencedEnvelopeRead(finalScope),
      /original|interval|accepted|physical/i,
    );
  } finally {
    if (existsSync(saved)) renameSync(saved, physical);
  }
  assert.throws(() => referencedEnvelopeFieldPart(finalScope, 'intake.originalName'));
  let checkpoints = 0;
  let changedDuringOpening = false;
  await assert.rejects(
    readAcceptedIntakeSourceColumn(db, identity, giantVersionId, 'mime_type', () => {
      if (++checkpoints !== 4) return;
      transaction(db, () => {
        db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run(
          'fictional/opening-change',
          intakeId,
        );
      });
      changedDuringOpening = true;
    }),
  );
  assert.equal(changedDuringOpening, true);
  transaction(db, () => {
    db.prepare('UPDATE source_files SET details_json=details_json WHERE id=?').run(intakeId);
  });
  await assert.rejects(() =>
    captureReferencedEnvelopeRead(db, identity, giantVersionId, () => {}, 'current'),
  );
  const historical = await captureReferencedEnvelopeRead(
    db,
    identity,
    sourceVersionId,
    () => {},
    'historical',
  );
  try {
    const part = referencedEnvelopeFieldPart(historical, 'intake.originalName');
    assert.ok(part && part.kind === 'bytes' && part.chunk.length > 0);
  } finally {
    closeReferencedEnvelopeRead(historical);
  }
});
