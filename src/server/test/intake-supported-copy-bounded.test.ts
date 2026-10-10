import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { IntakeStateManifest } from '../intake-state-manifest.ts';
import {
  intakeCopyEncodedBytes,
  intakeCopyJsonHash,
  intakeCopyJsonString,
  intakeCopyJsonTree,
  intakeCopyManualReceipt,
  intakeCopyTextPieces,
  intakeCopyTrimmedPieces,
} from '../intake-copy-json.ts';
import {
  disposeIntakeStateCopyPlan,
  prepareIntakeStateCopySnapshot,
  prepareProductionIntakeStateCopyRows,
  validateIntakeStateCopyRows,
} from '../intake-state-bootstrap.ts';
import {
  prepareInitialIntakeEnvelope,
  prepareIntakeEnvelopeProjection,
  prepareIntakeEnvelopeProjectionSteps,
} from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
import { createNote } from '../notes.ts';
import { getIntake, uploadIntake } from '../intake.ts';
import { intakeSourceRoute } from '../intake-source-routes.ts';
import { getIntakeSourceText } from '../intake-source-text.ts';
import { createManualSourceRecord } from '../intake-manual-source-record.ts';
import { iterateIntakeEnvelopeText, selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { copiedManualSourceRecordApplies } from '../intake-manual-copy.ts';
import type { Database } from '../database.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sourceProfileId = 'fictional-bounded-copy-source';
const targetProfileId = 'fictional-bounded-copy-target';
const giant = 'Independently fictional retained value \\" '.repeat(60000);
const original = (detailsJson: string) => ({
  id: 'fictional-bounded-original',
  kind: 'intake_original',
  sha256: 'e'.repeat(64),
  path: `data/profiles/${sourceProfileId}/sources/fictional.txt`,
  detailsJson,
  sourcePin: null,
  preserved: {
    provider_id: null,
    bytes: 0,
    mime_type: 'text/plain',
    coverage_status: 'unknown',
    batch_id: null,
  },
});

function forbidLargeParse<T>(action: () => T): T {
  const parse = JSON.parse;
  JSON.parse = ((text: string, ...args: unknown[]) => {
    assert.ok(text.length <= 65536, 'supported native copy must not parse a giant JSON value');
    return Reflect.apply(parse, JSON, [text, ...args]);
  }) as typeof JSON.parse;
  try {
    return action();
  } finally {
    JSON.parse = parse;
  }
}

test('original copy admission validates complete giant syntax and UTF8 without a wrapped original', () => {
  const detailsJson = '{"intake":{"unknown":' + JSON.stringify(giant) + '}}',
    retained = original(detailsJson),
    snapshot = { sourceProfileId, originals: [retained], rows: [] };
  assert.ok(Buffer.byteLength(detailsJson) > 2 * 1024 * 1024);
  assert.equal(intakeCopyEncodedBytes(retained), Buffer.byteLength(JSON.stringify(retained)));
  const plan = forbidLargeParse(() => prepareIntakeStateCopySnapshot(snapshot, targetProfileId));
  assert.equal(plan.counters.sourceBytes, Buffer.byteLength(JSON.stringify(retained)));
  disposeIntakeStateCopyPlan(plan);
  assert.throws(
    () =>
      validateIntakeStateCopyRows({ ...snapshot, originals: [original(detailsJson.slice(0, -1))] }),
    /JSON syntax/,
  );
  assert.throws(
    () => validateIntakeStateCopyRows({ ...snapshot, originals: [original('{"raw":"\ud800"}')] }),
    /UTF-8/,
  );
  validateIntakeStateCopyRows({ ...snapshot, originals: [original('{"raw":"\\ud800"}')] });
});

test('receipt projection hashes complete giant unknown values and duplicate last members', () => {
  const receipt = {
    actor: 'profile-owner',
    operationId: randomUUID(),
    fingerprint: 'b'.repeat(64),
    profileId: sourceProfileId,
    intakeId: 'fictional-bounded-original',
    sourceHash: 'e'.repeat(64),
    sourceTextRevisionId: randomUUID(),
    person: { noteId: giant, personId: giant, fullName: giant },
    unknown: { retained: giant, numeric: -0 },
  };
  const raw = '{"actor":"untrusted",' + JSON.stringify(receipt).slice(1),
    expected = hash(canonicalLiteral(JSON.parse(raw)));
  const checked = forbidLargeParse(() => intakeCopyManualReceipt(intakeCopyTextPieces(raw)))!;
  assert.equal(checked.hash, expected);
  assert.equal(checked.receipt.actor, 'profile-owner');
  assert.equal(checked.receipt.operationId, receipt.operationId);
  assert.deepEqual(checked.receipt.person, { noteId: '', personId: '' });
  const changed = intakeCopyManualReceipt(
    intakeCopyTextPieces(raw.replace('retained', 'changed')),
  )!;
  assert.notEqual(changed.hash, expected);
  const tree = intakeCopyJsonTree(intakeCopyTextPieces(raw));
  try {
    assert.equal(intakeCopyJsonHash(tree), expected);
    assert.equal(
      intakeCopyJsonString(tree, tree.field(tree.root, 'operationId')),
      receipt.operationId,
    );
    assert.equal(tree.work.maxBufferBytes, 8192);
    assert.ok(tree.work.maxChunkBytes <= 8192);
  } finally {
    tree.close();
  }
  assert.throws(() => intakeCopyManualReceipt(intakeCopyTextPieces(raw.slice(0, -1))));
});

test('stream trimming preserves internal whitespace and discards arbitrarily long edge runs', () => {
  const text = ' \t\r\n'.repeat(18000) + '{ "unknown" : [1,  2] }' + '\t \r\n'.repeat(18000);
  assert.equal([...intakeCopyTrimmedPieces(intakeCopyTextPieces(text))].join(''), text.trim());
  const internal = '"first"' + ' \t'.repeat(18000) + ',"second"';
  assert.equal([...intakeCopyTrimmedPieces(intakeCopyTextPieces(internal))].join(''), internal);
});

test('manifest fingerprint authenticates direct scalar columns and distinguishes null from its spelling', () => {
  const manifest = new IntakeStateManifest();
  try {
    manifest.db.exec('ALTER TABLE originals ADD COLUMN provider_id TEXT');
    manifest.db.prepare('INSERT INTO originals VALUES(?,?,?)').run('fictional', '{}', null);
    const missing = manifest.fingerprint();
    manifest.db.prepare('UPDATE originals SET provider_id=?').run('null');
    assert.notEqual(manifest.fingerprint(), missing);
    const text = manifest.fingerprint();
    manifest.db.prepare('UPDATE originals SET value=?').run('{"changed":true}');
    assert.notEqual(manifest.fingerprint(), text);
  } finally {
    manifest.close();
  }
});

test('normalized selected reads retain native source/head/metadata under installed policy method forgery', async () => {
  const db = openDatabase(':memory:', sourceProfileId),
    identity = {
      profileId: sourceProfileId,
      intakeId: 'fictional-native-read',
      sourceHash: 'c'.repeat(64),
    },
    initial = prepareInitialIntakeEnvelope({
      intake: {
        version: 1,
        proposals: [],
        workflow: { format: 'health-intake-workflow-v1', operations: [] },
      },
    });
  memoryRecordAuthority(db);
  const prepare = db.prepare;
  let installed = false;
  try {
    transaction(db, () => {
      db.prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      ).run(
        identity.intakeId,
        original('').path,
        identity.sourceHash,
        0,
        'intake_original',
        initial.detailsJson,
      );
      createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
    });
    await buildIntakeCollectionEnvelope(db, {
      id: identity.intakeId,
      kind: 'intake_original',
      sha256: identity.sourceHash,
    });
    const expected = selectedEnvelopeStore(db, { id: identity.intakeId });
    db.setAuthorizer((action, table) => {
      if (!installed && action === constants.SQLITE_READ && table === 'source_files') {
        installed = true;
        db.prepare = function (sql: string) {
          db.prepare = prepare;
          if (/SELECT.*source_files/.test(sql))
            return prepare.call(
              this,
              "SELECT 'fictional-native-read' id,'intake_original' kind,'0' sha256,'{}' details_json",
            );
          return prepare.call(this, sql);
        };
      }
      return constants.SQLITE_OK;
    });
    const actual = selectedEnvelopeStore(db, { id: identity.intakeId });
    assert.deepEqual(actual.source, expected.source);
    assert.deepEqual(actual.binding, expected.binding);
    const collections = createIntakeStateStorage(db, identity).collections,
      view = collections.openView();
    assert.equal(JSON.stringify(collections.binding(view)?.logical), expected.binding.logicalHead);
    assert.equal(installed, true);
  } finally {
    db.prepare = prepare;
    db.setAuthorizer(null);
    clearIntakeStateCache(db);
    db.close();
  }
});

for (const mode of ['normalized', 'raw'] as const)
  test(`production native copy checks complete giant ${mode} metadata without hydration`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-bounded-copy-')),
      db = openDatabase(join(root, 'cache.sqlite'), sourceProfileId),
      identity = {
        profileId: sourceProfileId,
        intakeId: 'fictional-bounded-original',
        sourceHash: 'e'.repeat(64),
      };
    memoryRecordAuthority(db);
    t.after(() => {
      clearIntakeStateCache(db);
      if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const intake = {
      version: 1,
      originalName: 'fictional.txt',
      metadata: { unknown: giant, preservedNumbers: [12.5, -0] },
      proposals: [],
      workflow: { format: 'health-intake-workflow-v1', operations: [] },
    };
    const raw =
      ' {"unselected":1,"unselected":2,"intake":{"version":0,"metadata":{"old":true}},' +
      '"\\u0069ntake":' +
      JSON.stringify(intake).slice(0, -1) +
      ',"metadata": {"unknown":' +
      JSON.stringify(giant) +
      ',"numeric":12.5000}} } \n';
    const initial = prepareInitialIntakeEnvelope(mode === 'raw' ? raw : { intake });
    transaction(db, () => {
      db.prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      ).run(
        identity.intakeId,
        original('').path,
        identity.sourceHash,
        0,
        'intake_original',
        initial.detailsJson,
      );
      createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
    });
    await buildIntakeCollectionEnvelope(db, {
      id: identity.intakeId,
      kind: 'intake_original',
      sha256: identity.sourceHash,
    });
    const details = String(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(identity.intakeId)!
        .details_json,
    );
    const asyncProjection = await prepareIntakeEnvelopeProjection(intakeCopyTextPieces(details));
    const steps = prepareIntakeEnvelopeProjectionSteps(intakeCopyTextPieces(details));
    for (;;) {
      const next = steps.next();
      if (next.done) {
        assert.deepEqual(next.value, asyncProjection);
        break;
      }
    }
    assert.ok(Buffer.byteLength(details) > 2 * 1024 * 1024);
    const before = db.prepare('SELECT key,value FROM app_meta ORDER BY key').all();
    const plan = forbidLargeParse(() =>
      prepareProductionIntakeStateCopyRows(db, sourceProfileId, targetProfileId),
    );
    disposeIntakeStateCopyPlan(plan);
    assert.deepEqual(db.prepare('SELECT key,value FROM app_meta ORDER BY key').all(), before);
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
      details.replace('retained value', 'modified value'),
      identity.intakeId,
    );
    assert.throws(
      () => prepareProductionIntakeStateCopyRows(db, sourceProfileId, targetProfileId),
      /metadata conflicts/,
    );
  });

// This new integration deliberately crosses the >2 MiB receipt boundary and
// includes genuine source/target publication. The guard detects host hangs,
// while acceptance remains exact evidence and bounded-work assertions.
test(
  'supported contributor lifecycle copy preserves a giant manual author receipt and target grant',
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-bounded-manual-copy-')),
      databases = new Map<string, Database>(),
      lifecycle = createProfileLifecycle({ root, databases });
    t.after(() => {
      lifecycle.close();
      for (const db of databases.values()) if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const profile = await lifecycle.create({
      name: 'Fictional bounded manual author',
      fullName: 'Fictional bounded manual author',
      birthDate: '1982-04-17',
    });
    const db = databases.get(profile.id)!,
      person = createNote(db, {
        kind: 'person',
        title: 'Fictional retained person',
        person: { fullName: 'Fictional retained person ' + '\u754c'.repeat(750000) },
      }),
      source = uploadIntake(db, root, profile.id, {
        filename: 'fictional-reading.txt',
        bytes: Buffer.from('Fictional reading: 12.50 units'),
        newProviderName: 'Fictional clinic',
      });
    await intakeSourceRoute({
      db,
      root,
      profileId: profile.id,
      id: source.id,
      action: 'source-extract',
      params: new URLSearchParams(),
      input: { operationId: randomUUID(), expectedRevisionId: null },
    });
    const manual = createManualSourceRecord(db, root, profile.id, source.id, {
      version: getIntake(db, root, profile.id, source.id).version,
      operationId: randomUUID(),
      sourceHash: source.sha256,
      sourceTextRevisionId: getIntakeSourceText(db, root, profile.id, source.id).revision!.id,
      scope: { page: 1 },
      person: { kind: 'person', noteId: person.id, expectedVersion: person.version },
      literalText: 'Fictional reading: 12.50 units',
      clinical: {
        kind: 'observation',
        testLabel: 'Fictional reading',
        valueText: '12.50',
        unit: 'units',
        date: '2026-09-01',
      },
    });
    await buildIntakeCollectionEnvelope(db, source);
    const before = [...iterateIntakeEnvelopeText(db, { id: source.id })].join(''),
      receipt = manual.intake.proposals[0]!.manualSourceRecord!;
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) > 2 * 1024 * 1024);
    const copyInput = { name: 'Fictional bounded copy', operationId: randomUUID() };
    let ticks = 0,
      preparing = true;
    const heartbeat = () => {
      if (preparing) {
        ticks++;
        setImmediate(heartbeat);
      }
    };
    setImmediate(heartbeat);
    let target;
    try {
      target = await lifecycle.create(copyInput, profile.id);
    } finally {
      preparing = false;
    }
    assert.ok(ticks > 20, 'real copy preparation allows unrelated host work to run');
    const copy = databases.get(target.id)!;
    assert.equal((await lifecycle.create(copyInput, profile.id)).id, target.id);
    assert.equal([...iterateIntakeEnvelopeText(copy, { id: source.id })].join(''), before);
    assert.equal(
      copiedManualSourceRecordApplies(
        copy,
        {
          profileId: target.id,
          intakeId: source.id,
          sourceHash: source.sha256,
          proposalId: manual.proposalId,
          proposalHash: String(
            copy.prepare('SELECT sha256 FROM source_files WHERE id=?').get(manual.proposalId)!
              .sha256,
          ),
        },
        receipt,
      ),
      true,
    );
    const grant = copy
      .prepare("SELECT value FROM app_meta WHERE key GLOB 'intake_manual_copy:*'")
      .get()!;
    assert.ok(Buffer.byteLength(String(grant.value)) < 2000);
    assert.equal(JSON.parse(String(grant.value)).receiptHash, hash(canonicalLiteral(receipt)));
  },
);
