import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase, transaction } from '../database.ts';
import { createApp } from '../index.ts';
import { attachPersonalDurability } from '../portable.ts';
import { copyContributorAuthority } from '../contributor-durability.ts';
import {
  contributorAuthorityPath,
  openContributorRecordStorage,
} from '../contributor-record-storage.ts';
import {
  assertRecordAcceptedSourcePreimage,
  attachRecordDurability,
  borrowRecordAcceptedIntakeHeadRead,
  captureRecordAcceptedSourceRead,
  closeRecordAcceptedSourceRead,
  rebuildRecordDatabase,
  recordAcceptedSourcePair,
} from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { projectIntakeReferencedTargetCandidateAsync } from '../intake-state-migration.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { withAcceptedNativeIntakeSourceFormat } from '../intake-accepted-source-format.ts';
import { withAcceptedSourceFileContent } from '../intake.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { checkIntakeSourceAncestry } from '../intake-source-ancestry.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  captureReferencedEnvelopeRead,
  captureReferencedEnvelopeReadFromFormat,
  closeReferencedEnvelopeRead,
  referencedEnvelopeCurrentExactStringField,
  referencedEnvelopeCurrentField,
  referencedEnvelopeCurrentSourceFacts,
  referencedEnvelopeProviderSelector,
} from '../intake-referenced-envelope-access.ts';

test('fictional accepted pre-V4 source format uses its record certificate', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-pre-v4-format-'));
  const profileId = 'fictional-pre-v4-format';
  const intakeId = 'fictional-pre-v4-original';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  const original = Buffer.from('Fictional accepted source before V4.');
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const relativePath = paths.relativeRoot + '/sources/original.txt';
  mkdirSync(dirname(join(root, relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), original);
  const initial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: 'fictional-original.txt', state: 'ready' },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      intakeId,
      relativePath,
      sourceHash,
      original.length,
      'intake_original',
      'text/plain',
      initial.detailsJson,
    );
  });
  assert.equal(
    db
      .prepare('SELECT count(*) AS n FROM app_meta WHERE key=?')
      .get(intakeNamespace({ profileId, intakeId, sourceHash }) + 'head')!.n,
    0,
  );
  assert.equal(
    await withAcceptedNativeIntakeSourceFormat(
      db,
      profileId,
      intakeId,
      () => {},
      (scope) => scope.format,
    ),
    'legacy',
  );
  transaction(db, () => {
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
      '{"legacyOperationalEnvelope":"unavailable"}',
      intakeId,
    );
  });
  let downloaded = false;
  await withAcceptedSourceFileContent(
    db,
    root,
    profileId,
    intakeId,
    () => {},
    async (lease) => {
      const bytes = Buffer.alloc(original.length);
      lease.assertCurrent();
      assert.equal(readSync(lease.sourceFd, bytes, 0, bytes.length, 0), bytes.length);
      lease.assertCurrent();
      assert.deepEqual(bytes, original);
      downloaded = true;
    },
  );
  assert.equal(downloaded, true, 'accepted retained original remains downloadable');
  await assert.rejects(
    withAcceptedNativeIntakeSourceFormat(
      db,
      profileId,
      intakeId,
      () => {},
      (scope) => scope.format,
    ),
  );
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
    '{"intakeAuthority":{"format":"health-intake-envelope-v3"}}',
    intakeId,
  );
  await assert.rejects(
    withAcceptedNativeIntakeSourceFormat(
      db,
      profileId,
      intakeId,
      () => {},
      (scope) => scope.format,
    ),
  );
});

test('fictional generic source content retains its accepted row and original bytes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-generic-content-'));
  const profileId = 'fictional-generic-content';
  const sourceId = 'fictional-generic-source';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  const original = Buffer.from('Independently fictional generic source content.');
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const relativePath = paths.relativeRoot + '/sources/generic.txt';
  mkdirSync(dirname(join(root, relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), original);
  transaction(db, () => {
    db.prepare('INSERT INTO source_files(id,path,sha256,bytes,mime_type) VALUES(?,?,?,?,?)').run(
      sourceId,
      relativePath,
      sourceHash,
      original.length,
      'text/plain',
    );
  });
  let consumed = false;
  await withAcceptedSourceFileContent(
    db,
    root,
    profileId,
    sourceId,
    () => {},
    async (lease, header) => {
      consumed = true;
      assert.equal(header.bytes, original.length);
      const bytes = Buffer.alloc(original.length);
      lease.assertCurrent();
      assert.equal(readSync(lease.sourceFd, bytes, 0, bytes.length, 0), bytes.length);
      lease.assertCurrent();
      assert.deepEqual(bytes, original);
    },
  );
  assert.equal(consumed, true);
  await t.test('HTTP content route streams under the accepted source proof', async () => {
    const app = createApp({ root, databases: new Map([[profileId, db]]) });
    await new Promise<void>((ready) => app.server.listen(0, '127.0.0.1', ready));
    t.after(() => new Promise<void>((done) => app.server.close(() => done())));
    const response = await fetch(
      `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${profileId}/sources/${sourceId}/content`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('transfer-encoding'), 'chunked');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    const authority = contributorAuthorityPath(root, profileId);
    const acceptedHead = JSON.parse(readFileSync(join(authority, 'head'), 'utf8')) as {
      name: string;
    };
    const consumedObject = join(authority, acceptedHead.name);
    const consumedBytes = readFileSync(consumedObject);
    const emitForReplacement = Worker.prototype.emit;
    const writeForReplacement = ServerResponse.prototype.write;
    let bodyStarted = false;
    let replaced = false;
    // Recorded, not asserted, inside emit: the worker is blocked on this
    // checkpoint until the message is forwarded, so throwing here would hang
    // the request instead of failing the test.
    let startedAtFinalProof: boolean | undefined;
    ServerResponse.prototype.write = function (this: ServerResponse, ...args: unknown[]) {
      bodyStarted = true;
      return Reflect.apply(writeForReplacement, this, args) as boolean;
    } as ServerResponse['write'];
    Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
      const message = args[0] as { checkpoint?: boolean; phase?: string } | undefined;
      if (
        !replaced &&
        event === 'message' &&
        message?.checkpoint &&
        message.phase === 'final-verify'
      ) {
        replaced = true;
        startedAtFinalProof = bodyStarted;
        if (bodyStarted) {
          renameSync(consumedObject, consumedObject + '.saved');
          writeFileSync(consumedObject, consumedBytes);
        }
      }
      return Reflect.apply(emitForReplacement, this, [event, ...args]);
    };
    try {
      const changed = await fetch(
        `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${profileId}/sources/${sourceId}/content`,
      );
      assert.equal(changed.status, 200);
      const body = changed.arrayBuffer();
      // Observe the body before asserting so a refusal never leaks.
      const settled = await body.then(
        () => false,
        () => true,
      );
      assert.equal(startedAtFinalProof, true, 'the response had begun before final physical proof');
      assert.equal(settled, true, 'the replaced original body was refused');
      assert.equal(replaced, true, 'final physical proof saw the same-byte replacement');
    } finally {
      Worker.prototype.emit = emitForReplacement;
      ServerResponse.prototype.write = writeForReplacement;
      if (existsSync(consumedObject + '.saved')) {
        rmSync(consumedObject, { force: true });
        renameSync(consumedObject + '.saved', consumedObject);
      }
    }
  });
  const abort = new AbortController();
  const emit = Worker.prototype.emit;
  let terminalCheckpoint = false;
  let armed = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { checkpoint?: boolean; phase?: string } | undefined;
    if (armed && event === 'message' && message?.checkpoint && message.phase === 'final-verify') {
      terminalCheckpoint = true;
      abort.abort();
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    await assert.rejects(
      withAcceptedSourceFileContent(
        db,
        root,
        profileId,
        sourceId,
        () => {},
        async () => {
          armed = true;
        },
        abort.signal,
      ),
    );
    assert.equal(terminalCheckpoint, true, 'cancellation reached the terminal worker checkpoint');
  } finally {
    Worker.prototype.emit = emit;
  }
  db.prepare('DELETE FROM __record_current WHERE entity=? AND record_id=?').run(
    'source_files',
    JSON.stringify([sourceId]),
  );
  consumed = false;
  await assert.rejects(
    withAcceptedSourceFileContent(
      db,
      root,
      profileId,
      sourceId,
      () => {},
      async () => {
        consumed = true;
      },
    ),
  );
  assert.equal(consumed, false, 'missing derivative version cannot authorize generic fallback');
});

test('fictional copied contributor authority reconstructs a current accepted V3 source', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-v3-copy-source-'));
  const target = mkdtempSync(join(tmpdir(), 'fictional-v3-copy-target-'));
  const profileId = 'fictional-v3-copy';
  const intakeId = 'fictional-v3-copy-original';
  const sourcePaths = ensureProfileDirectories(root, profileId);
  const targetPaths = ensureProfileDirectories(target, profileId);
  const db = openDatabase(sourcePaths.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  const original = Buffer.from('Independent fictional V3 copy evidence.');
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const relativePath = sourcePaths.relativeRoot + '/sources/original.txt';
  mkdirSync(dirname(join(root, relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), original);
  const source = { id: intakeId, sha256: sourceHash };
  const identity = { profileId, intakeId, sourceHash };
  const providerId = 'Fictional Provider ' + 'p'.repeat(20 * 1024);
  const parentId = 'fictional-parent-' + 'r'.repeat(1024);
  const parentOriginal = Buffer.from('Independent fictional parent evidence.');
  const parentHash = createHash('sha256').update(parentOriginal).digest('hex');
  const parentPath = sourcePaths.relativeRoot + '/sources/parent.txt';
  writeFileSync(join(root, parentPath), parentOriginal);
  const parentInitial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: 'parent.txt', state: 'ready' },
  });
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: 'fictional-original.txt',
      state: 'ready',
      parentSourceFileId: parentId,
      metadata: {
        source: 'Fictional copied clinic ' + 'q'.repeat(64 * 1024),
        sourceProviderId: providerId,
      },
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      parentId,
      parentPath,
      parentHash,
      parentOriginal.length,
      'intake_original',
      'text/plain',
      parentInitial.detailsJson,
    );
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      intakeId,
      relativePath,
      sourceHash,
      original.length,
      'intake_original',
      'text/plain',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, source);
  assert.equal(
    await withAcceptedNativeIntakeSourceFormat(
      db,
      profileId,
      intakeId,
      () => {},
      (scope) => scope.format,
    ),
    'legacy',
  );
  const headKey = intakeNamespace(identity) + 'head';
  const beforeHead = String(
    db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value,
  );
  const intent = await projectIntakeReferencedTargetCandidateAsync(
    db,
    { identity, afterHead: beforeHead, writes: [] },
    () => {},
  );
  assert.deepEqual(
    await prepareIntakeCompactMetadata(db, source, { referencedTargetCandidate: intent }),
    { changed: true },
  );
  assert.ok(
    Buffer.byteLength(
      String(
        db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId)!.details_json,
      ),
    ) < 8192,
  );
  assert.equal(
    await withAcceptedNativeIntakeSourceFormat(
      db,
      profileId,
      intakeId,
      () => {},
      (scope) => scope.format,
    ),
    'referenced',
  );
  let closedScope: { assertCurrent(): void } | undefined;
  const formatWork = createRecordVersionWorkCounters();
  await assert.rejects(
    withRecordVersionWork(formatWork, () =>
      withAcceptedNativeIntakeSourceFormat(
        db,
        profileId,
        intakeId,
        () => {},
        (scope) => {
          closedScope = scope;
          throw Error('Fictional consumer refusal');
        },
      ),
    ),
    /Fictional consumer refusal/,
  );
  assert.equal(formatWork.operation.acceptedSourceFormatHotHits, 1);
  assert.equal(formatWork.operation.acceptedSourceFormatColdReads, 0);
  assert.equal(formatWork.operation.acceptedSourceFormatVerifiedPreimageBytes, 0);
  assert.equal(formatWork.operation.acceptedSourceFormatCertificatePoints, 1);
  const closed = closedScope;
  assert.ok(closed);
  assert.throws(() => closed.assertCurrent(), /closed/);
  db.close();

  mkdirSync(dirname(join(target, relativePath)), { recursive: true });
  copyFileSync(join(root, relativePath), join(target, relativePath));
  copyFileSync(join(root, parentPath), join(target, parentPath));
  assert.ok(copyContributorAuthority(root, profileId, target).length > 0);
  const storage = openContributorRecordStorage(target, profileId);
  try {
    rebuildRecordDatabase(targetPaths.database, { profileId, storage });
    const recovered = openDatabase(targetPaths.database, profileId);
    try {
      attachRecordDurability(recovered, { profileId, storage });
      const sourceVersionId = String(
        recovered
          .prepare(
            "SELECT version_id FROM __record_current WHERE entity='source_files' AND record_id=?",
          )
          .get(JSON.stringify([intakeId]))!.version_id,
      );
      const pairRequest = { identity, sourceVersionId };
      const unproved = await captureRecordAcceptedSourceRead(
        recovered,
        profileId,
        () => {},
        pairRequest,
      );
      try {
        assert.throws(
          () => recordAcceptedSourcePair(recovered, unproved, profileId, pairRequest),
          /accepted source pair read unavailable/,
        );
        assert.throws(
          () => borrowRecordAcceptedIntakeHeadRead(recovered, unproved, identity, pairRequest),
          /accepted source pair read unavailable/,
        );
        assert.throws(() =>
          assertRecordAcceptedSourcePreimage(
            recovered,
            unproved,
            profileId,
            JSON.stringify([intakeId]),
            sourceVersionId,
            { hash: '0'.repeat(64), bytes: 0 },
          ),
        );
        assert.throws(
          () => recordAcceptedSourcePair(recovered, unproved, profileId, pairRequest),
          /accepted source pair read unavailable/,
        );
      } finally {
        closeRecordAcceptedSourceRead(unproved, false);
      }
      const scope = await captureReferencedEnvelopeRead(
        recovered,
        identity,
        sourceVersionId,
        () => {},
        'current',
      );
      try {
        assert.equal(referencedEnvelopeCurrentField(scope, 'intake.state'), 'ready');
        const facts = await referencedEnvelopeCurrentSourceFacts(scope);
        assert.deepEqual(facts.path, { kind: 'value', value: relativePath });
        const provider = await referencedEnvelopeProviderSelector(scope);
        assert.equal(provider.exact(), undefined);
        assert.equal(provider.matches(providerId), true);
        assert.equal(provider.matches('Other Provider'), false);
      } finally {
        closeReferencedEnvelopeRead(scope);
      }
      const positivePairWork = createRecordVersionWorkCounters();
      assert.equal(
        await withRecordVersionWork(positivePairWork, () =>
          withAcceptedNativeIntakeSourceFormat(
            recovered,
            profileId,
            intakeId,
            () => {},
            async (formatScope) => {
              const nested = await captureReferencedEnvelopeReadFromFormat(
                recovered,
                formatScope,
                () => {},
                'current',
              );
              try {
                assert.equal(referencedEnvelopeCurrentField(nested, 'intake.state'), 'ready');
                assert.equal(
                  await referencedEnvelopeCurrentExactStringField(
                    nested,
                    'intake.parentSourceFileId',
                  ),
                  parentId,
                );
                return formatScope.format;
              } finally {
                closeReferencedEnvelopeRead(nested);
              }
            },
            true,
          ),
        ),
        'referenced',
      );
      assert.equal(
        await withRecordVersionWork(positivePairWork, () =>
          withAcceptedNativeIntakeSourceFormat(
            recovered,
            profileId,
            intakeId,
            () => {},
            (scope) => scope.format,
            true,
          ),
        ),
        'referenced',
      );
      assert.ok(
        positivePairWork.operation.contributorBackingOptionalPairSelectionReuses +
          positivePairWork.reconstruction.contributorBackingOptionalPairSelectionReuses >
          0,
      );
      assert.equal(
        await checkIntakeSourceAncestry(recovered, profileId, intakeId, { stopAt: parentId }),
        true,
      );
      const authority = contributorAuthorityPath(target, profileId);
      const head = JSON.parse(readFileSync(join(authority, 'head'), 'utf8')) as {
        name: string;
      };
      assert.match(head.name, /^objects\/[0-9a-f-]+$/);
      const consumedObject = join(authority, head.name);
      const consumedBytes = readFileSync(consumedObject);
      assert.equal(
        await withAcceptedNativeIntakeSourceFormat(
          recovered,
          profileId,
          intakeId,
          () => {},
          (scope) => scope.format,
        ),
        'referenced',
      );
      const emit = Worker.prototype.emit;
      let armed = false;
      let finalVerifySeen = false;
      let lateCallback = false;
      Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        const message = args[0] as { checkpoint?: boolean; phase?: string } | undefined;
        if (armed && event === 'message' && message?.checkpoint && message.phase === 'final-verify')
          finalVerifySeen = true;
        return Reflect.apply(emit, this, [event, ...args]);
      };
      try {
        assert.equal(
          await withAcceptedNativeIntakeSourceFormat(
            recovered,
            profileId,
            intakeId,
            () => {
              if (!finalVerifySeen || lateCallback) return;
              lateCallback = true;
              renameSync(consumedObject, consumedObject + '.late-saved');
              writeFileSync(consumedObject, consumedBytes);
            },
            (scope) => {
              armed = true;
              return scope.format;
            },
          ),
          'referenced',
        );
        assert.equal(finalVerifySeen, true, 'the terminal worker checkpoint was reached');
        assert.equal(lateCallback, false, 'no caller callback ran after the terminal checkpoint');
      } finally {
        Worker.prototype.emit = emit;
        if (existsSync(consumedObject + '.late-saved')) {
          rmSync(consumedObject, { force: true });
          renameSync(consumedObject + '.late-saved', consumedObject);
        }
      }
      const replacementWork = createRecordVersionWorkCounters();
      let mutated = false;
      try {
        await assert.rejects(
          withRecordVersionWork(replacementWork, () =>
            withAcceptedNativeIntakeSourceFormat(
              recovered,
              profileId,
              intakeId,
              () => {},
              (scope) => {
                scope.assertCurrent();
                const saved = consumedObject + '.saved';
                renameSync(consumedObject, saved);
                writeFileSync(consumedObject, consumedBytes);
                mutated = true;
                scope.assertCurrent();
              },
            ),
          ),
        );
        assert.equal(mutated, true);
        assert.equal(replacementWork.operation.acceptedSourceFormatHotHits, 1);
        assert.equal(replacementWork.operation.acceptedSourceFormatColdReads, 0);
      } finally {
        if (existsSync(consumedObject + '.saved')) {
          rmSync(consumedObject, { force: true });
          renameSync(consumedObject + '.saved', consumedObject);
        }
      }
      const retryWork = createRecordVersionWorkCounters();
      assert.equal(
        await withRecordVersionWork(retryWork, () =>
          withAcceptedNativeIntakeSourceFormat(
            recovered,
            profileId,
            intakeId,
            () => {},
            (scope) => scope.format,
          ),
        ),
        'referenced',
      );
      assert.equal(retryWork.operation.acceptedSourceFormatHotHits, 0);
      assert.equal(retryWork.operation.acceptedSourceFormatColdReads, 1);
      assert.ok(retryWork.operation.contributorBackingColdDecodedVersions > 0);
      const selectedDetails = String(
        recovered.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId)!
          .details_json,
      );
      try {
        recovered
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run(initial.detailsJson, intakeId);
        await t.test('rewritten V3 row cannot authorize source ancestry', async () => {
          await assert.rejects(
            checkIntakeSourceAncestry(recovered, profileId, intakeId, { stopAt: intakeId }),
          );
        });
        let contentConsumed = false;
        await assert.rejects(
          withAcceptedSourceFileContent(
            recovered,
            target,
            profileId,
            intakeId,
            () => {},
            async () => {
              contentConsumed = true;
            },
          ),
        );
        assert.equal(contentConsumed, false, 'rewritten V3 row cannot enter generic content');
        let sent = false;
        await assert.rejects(
          handleIntakeRoute({
            resource: 'intakes',
            id: intakeId,
            method: 'GET',
            params: new URLSearchParams(),
            req: new IncomingMessage(new Socket()),
            db: recovered,
            root: target,
            profileId,
            respond: () => {
              sent = true;
            },
            list: () => assert.fail('unexpected list'),
            body: async () => assert.fail('unexpected body'),
            assistant: {} as never,
          }),
        );
        assert.equal(sent, false);
      } finally {
        recovered
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run(selectedDetails, intakeId);
      }
    } finally {
      recovered.close();
    }
  } finally {
    storage.close();
  }
});
