import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { createEncryptedProfiles, type OpenedProfile } from '../encrypted-profiles.ts';
import { transaction } from '../database.ts';
import * as intake from '../intake.ts';
import {
  acceptIntakeReportSelection,
  getIntakeReportAcceptance,
} from '../intake-report-acceptance.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  getIntakeSourceText,
  publishIntakeSourceText,
  reviewIntakeSourceText,
} from '../intake-source-text.ts';
import { intakeSourcePinKey, readIntakeSourcePin } from '../intake-source-pin.ts';
import { storedIntakeDetails, registerIntakeFile } from '../intake-state-access.ts';
import { readIntakeEnvelope, readIntakeEnvelopeText } from '../intake-authority.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { decryptObject, recoveryEntropy, unwrapKey } from '../vault-crypto.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';
import { fictionalModel } from './fictional-model.ts';
import type { HealthRecordEnvelope, Intake } from '../../shared/intake.ts';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const namespace = (profileId: string, intakeId: string, sourceHash: string) =>
  `intake_state_v1:${sha(JSON.stringify({ profileId, intakeId, sourceHash }))}:`;
const rows = (state: OpenedProfile, table: string) =>
  state.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
function archive(directory: string): unknown[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const path = resolve(directory, entry.name);
      return [entry.name, entry.isDirectory() ? archive(path) : sha(readFileSync(path))];
    });
}
function envelope(id: string): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: '+14.00' },
    provenance: {
      capturedVia: 'Fictional delivery',
      sourceSystem: 'Fictional issuer',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'fictional row ' + id,
    },
    coverage: { status: 'partial', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: 'Fictional copied reach ' + id,
      valueText: '+14.00',
      date: '2026-09',
      unit: 'mg',
    },
  };
}

async function fixture(t: TestContext) {
  fictionalModel(t); // Plan identity only; this fixture never requests inference.
  const f = vaultFixture(t);
  const created = await newProfile(f.manager, 'Fictional intake source');
  const sourceId = created.profile.id;
  const source = f.manager.opened.get(sourceId)!;
  const bytes = Buffer.from(
    [envelope('accepted'), envelope('pending')].map((v) => JSON.stringify(v)).join('\r\n') + '\n',
  );
  let item: Intake = intake.uploadIntake(source.db, source.root, sourceId, {
    filename: 'fictional-copy.jsonl',
    bytes,
    newProviderName: 'Fictional copied clinic',
  });
  let review = intake.reviewIntake(source.db, source.root, sourceId, item.id);
  const accepted = review.records[0]!;
  const publicOperation = randomUUID();
  const receipt = acceptIntakeReportSelection(source.db, source.root, sourceId, {
    operationId: publicOperation,
    blocks: [
      {
        intakeId: item.id,
        proposalId: null,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        selections: [
          {
            recordId: accepted.id,
            candidateId: accepted.candidateId!,
            candidateVersionId: accepted.candidateVersionId!,
            selectionReviewToken: accepted.selectionReviewToken,
            mapping: {},
          },
        ],
      },
    ],
  });
  assert.equal(receipt.receipt.status, 'accepted');
  assert.equal(receipt.receipt.operationId, publicOperation);
  assert.equal(rows(source, 'observations').length, 1);
  assert.equal(rows(source, 'observations')[0]!.value_text, '+14.00');
  review = intake.reviewIntake(source.db, source.root, sourceId, item.id);
  const pending = review.records.find((record) => record.id !== accepted.id)!;
  intake.saveIntakeReviewDraft(source.db, source.root, sourceId, item.id, {
    version: review.version,
    operationId: randomUUID(),
    proposalId: null,
    recordId: pending.id,
    candidateVersionId: pending.candidateVersionId!,
    disposition: 'review_later',
  });
  item = intake.getIntake(source.db, source.root, sourceId, item.id);
  const text = publishIntakeSourceText(source.db, source.root, sourceId, item.id, {
    operationId: randomUUID(),
    expectedRevisionId: null,
    sourceHash: item.sha256,
    evidence: {
      adapter: { name: 'fictional-copy-text', version: '1' },
      pages: [{ page: 1, disposition: 'extracted', inspected: false }],
      spans: [
        {
          id: 'fictional-span',
          text: 'Fictional retained interpretation Ω 🪴',
          region: { page: 1 },
          provenance: 'native',
        },
      ],
      relations: [],
      issues: [],
    },
  });
  assert.ok(text.revision);
  const corrected = reviewIntakeSourceText(
    source.db,
    source.root,
    sourceId,
    item.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: text.revision.id,
      sourceHash: item.sha256,
      action: 'correct',
      scope: { page: 1 },
      spans: [{ ...text.revision.spans[0]!, text: 'Fictional corrected interpretation Ω 🪴' }],
    },
    'authenticated-owner',
  );
  assert.ok(corrected.revision);
  const proposal = envelope('proposal-pending');
  proposal.reviewIssues = [
    { kind: 'uncertain_reading', field: 'valueText', prompt: 'Confirm fictional pending reading?' },
  ];
  const proposed = intake.proposeConversion(source.db, source.root, sourceId, item.id, {
    version: intake.getIntake(source.db, source.root, sourceId, item.id).version,
    summary: 'Fictional pending proposal',
    jsonlText: JSON.stringify(proposal),
  });
  const proposalId = proposed.proposals.at(-1)!.id;
  review = intake.reviewIntake(source.db, source.root, sourceId, item.id, proposalId);
  intake.saveIntakeReviewDraft(source.db, source.root, sourceId, item.id, {
    version: review.version,
    operationId: randomUUID(),
    proposalId,
    recordId: review.records[0]!.id,
    candidateVersionId: review.records[0]!.candidateVersionId!,
    disposition: 'review_later',
  });
  await intake.createIntakePlan(source.db, source.root, sourceId, item.id, {
    version: intake.getIntake(source.db, source.root, sourceId, item.id).version,
    operationId: randomUUID(),
    unitSize: 2,
    overlap: 0,
  });
  intake.askIntakeQuestion(source.db, source.root, sourceId, item.id, {
    version: intake.getIntake(source.db, source.root, sourceId, item.id).version,
    operationId: randomUUID(),
    key: 'fictional-pending-reading',
    candidateId: review.records[0]!.candidateId,
    candidateVersionId: review.records[0]!.candidateVersionId,
    prompt: 'Confirm the fictional pending reading?',
    locator: 'fictional row proposal-pending',
    field: 'valueText',
  });
  // The full selected envelope is the sole operational authority.
  const current = source.db.prepare('SELECT * FROM source_files WHERE id=?').get(item.id)!;
  const details = readIntakeEnvelope(source.db, { id: item.id }) as { intake: Intake };
  assert.ok(details.intake.proposals.length > 0);
  assert.ok(details.intake.workflow);
  assert.ok(details.intake.workflow.questions.length > 0);
  assert.ok(
    details.intake.workflow.plans.some((plan: { units: unknown[] }) => plan.units.length > 0),
  );
  assert.ok(details.intake.workflow.decisions.length > 0);
  assert.ok(
    details.intake.workflow.reviewDrafts && details.intake.workflow.reviewDrafts.length > 0,
  );
  assert.ok(
    details.intake.workflow.reportAcceptances &&
      details.intake.workflow.reportAcceptances.length > 0,
  );
  const raw = ` { "before" : {"escaped":"\\u03A9","duplicate":1,"duplicate":2}, "intake" : ${JSON.stringify(details.intake)}, "after" : {"second":"fictional","first":null} }\n`;
  transaction(source.db, () => {
    source.db
      .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
      .run('fictional-copy-unrelated', '{"second":2,"first":1}');
  });
  const scope = { profileId: sourceId, intakeId: item.id, sourceHash: item.sha256 };
  const store = createIntakeStateStorage(source.db, scope);
  writeIntakeFixtureEnvelope(source.db, item.id, JSON.parse(raw));
  const baseline = JSON.parse(raw);
  // Intentional normalized outer and nested member order must survive copying.
  const selected = {
    after: baseline.after,
    before: baseline.before,
    intake: baseline.intake,
    future: { z: 'fictional-' + 'x'.repeat(8192), a: ['Ω', '🪴', '\ud800'] },
  };
  writeIntakeFixtureEnvelope(source.db, item.id, selected);
  assert.equal(store.readSerialized(), JSON.stringify(selected));
  const expected = {
    compact: String(
      source.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(item.id)!
        .details_json,
    ),
    serialized: JSON.stringify(selected),
    bytes,
    receipt,
    publicOperation,
    sourcePath: String(current.path),
    storedVersion: storedIntakeDetails(
      source.db,
      source.db.prepare('SELECT * FROM source_files WHERE id=?').get(item.id)! as {
        id: string;
        details_json: string;
      },
    )!.version,
    publicVersion: intake.getIntake(source.db, source.root, sourceId, item.id).version,
    pin: source.db
      .prepare('SELECT value FROM app_meta WHERE key=?')
      .get(intakeSourcePinKey(item.id))!.value,
    workflow: intake.getIntake(source.db, source.root, sourceId, item.id).workflow,
    accepted: rows(source, 'observations'),
    sourceRecords: rows(source, 'source_records'),
    sourceText: corrected,
    sourceKeys: source.db
      .prepare("SELECT key FROM app_meta WHERE key GLOB 'intake_state_*' ORDER BY key")
      .all()
      .map((row) => String(row.key)),
  };
  assert.ok(readIntakeSourcePin(source.db, item.id)!.version > 0);
  assert.ok(expected.publicVersion > expected.storedVersion);
  const setup = f.manager.begin({ name: 'Fictional intake destination', copyFrom: sourceId });
  return { ...f, created, sourceId, source, item, scope, store, setup, expected };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function check(
  state: OpenedProfile,
  f: Fixture,
  copied: boolean,
  serialized = f.expected.serialized,
) {
  const row = state.db.prepare('SELECT * FROM source_files WHERE id=?').get(f.item.id)!;
  assert.equal(row.details_json, f.expected.compact);
  assert.equal(readIntakeEnvelopeText(state.db, { id: f.item.id }), serialized);
  assert.equal(row.sha256, sha(f.expected.bytes));
  assert.equal(
    row.path,
    f.expected.sourcePath.replace(`data/profiles/${f.sourceId}/`, `data/profiles/${state.id}/`),
  );
  assert.deepEqual(
    intake.getIntakeOriginal(state.db, state.root, state.id, f.item.id).bytes,
    f.expected.bytes,
  );
  assert.equal(
    sha(intake.getIntakeOriginal(state.db, state.root, state.id, f.item.id).bytes),
    f.item.sha256,
  );
  assert.equal(
    createIntakeStateStorage(state.db, {
      profileId: state.id,
      intakeId: f.item.id,
      sourceHash: f.item.sha256,
    }).readSerialized(),
    serialized,
  );
  assert.equal(
    state.db.prepare('SELECT value FROM app_meta WHERE key=?').get(intakeSourcePinKey(f.item.id))!
      .value,
    f.expected.pin,
  );
  assert.equal(
    storedIntakeDetails(state.db, row as { id: string; details_json: string })!.version,
    f.expected.storedVersion,
  );
  const view = intake.getIntake(state.db, state.root, state.id, f.item.id);
  assert.equal(view.version, f.expected.publicVersion);
  assert.deepEqual(view.workflow, f.expected.workflow);
  assert.deepEqual(
    getIntakeReportAcceptance(state.db, state.root, state.id, f.expected.publicOperation).receipt,
    f.expected.receipt.receipt,
  );
  assert.deepEqual(rows(state, 'observations'), f.expected.accepted);
  assert.deepEqual(rows(state, 'source_records'), f.expected.sourceRecords);
  assert.equal(
    state.db.prepare('SELECT value FROM app_meta WHERE key=?').get('fictional-copy-unrelated')!
      .value,
    '{"second":2,"first":1}',
  );
  const sourceText = getIntakeSourceText(state.db, state.root, state.id, f.item.id);
  assert.ok(sourceText.revision);
  assert.deepEqual(sourceText.revision.spans, f.expected.sourceText.revision!.spans);
  assert.equal(sourceText.revision.profileId, state.id);
  if (copied) assert.equal(sourceText.revision.copiedFrom!.profileId, f.sourceId);
  const keys = state.db
    .prepare("SELECT key FROM app_meta WHERE key GLOB 'intake_state_*' ORDER BY key")
    .all()
    .map((row) => String(row.key));
  const prefix = namespace(state.id, f.item.id, f.item.sha256);
  assert.ok(keys.length > 0 && keys.every((key) => key.startsWith(prefix)));
  if (copied) {
    assert.ok(
      keys.every((key) => !f.expected.sourceKeys.includes(key)),
      'no source internal replay namespace retained',
    );
    const sourcePrefix = namespace(f.sourceId, f.item.id, f.item.sha256);
    const sourceIds = f.expected.sourceKeys
      .filter((key) => !key.endsWith(':head'))
      .map((key) => key.slice(sourcePrefix.length));
    assert.ok(
      keys
        .filter((key) => !key.endsWith(':head'))
        .every((key) => !sourceIds.includes(key.slice(prefix.length))),
      'target uses fresh internal frame and operation identities while retaining public receipts',
    );
  }
}

type FixtureKit = ReturnType<Fixture['manager']['begin']>['recoveryKit'];
function kitKey(manager: Fixture['manager'], kit: FixtureKit) {
  const entropy = recoveryEntropy(kit, kit.profileId);
  try {
    return unwrapKey(manager.keyring(kit.profileId).recovery, entropy, kit.profileId);
  } finally {
    entropy.fill(0);
  }
}
function selectedHead(manager: Fixture['manager'], kit: FixtureKit): string | null {
  const key = kitKey(manager, kit);
  try {
    return JSON.parse(
      decryptObject(
        resolve(manager.pathFor(kit.profileId), 'vault/manifest.enc'),
        key,
        kit.profileId,
        'manifest',
      ).toString(),
    ).recordsHead;
  } finally {
    key.fill(0);
  }
}
type Fault = 'immutable' | 'head-before' | 'head-after' | 'activation';
async function fault(t: TestContext, f: Fixture, kind: Fault) {
  const key = kitKey(f.manager, f.setup.recoveryKit);
  const rename = fs.renameSync;
  let hit = 0;
  const mock = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
    const destination = String(args[1]);
    let matches =
      kind === 'immutable' &&
      destination.startsWith(resolve(f.manager.pathFor(f.setup.profileId), 'vault/versions') + '/');
    if (
      kind.startsWith('head-') &&
      destination === resolve(f.manager.pathFor(f.setup.profileId), 'vault/manifest.enc')
    ) {
      const manifest = JSON.parse(
        decryptObject(String(args[0]), key, f.setup.profileId, 'manifest').toString(),
      );
      matches = manifest.recordsHead !== null;
    }
    if (kind === 'activation' && destination === resolve(f.dataDirectory, 'profiles.json')) {
      matches = JSON.parse(readFileSync(args[0], 'utf8')).profiles.some(
        (p: { id: string }) => p.id === f.setup.profileId,
      );
    }
    if (matches) {
      hit++;
      if (kind === 'head-after') rename(...args);
      throw Error('Fictional copy fault: ' + kind);
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.manager.verify(f.setup.setupId, { acknowledged: true, recovery: f.setup.recoveryKit }),
      new RegExp('Fictional copy fault: ' + kind),
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    key.fill(0);
  }
  assert.ok(hit > 0, 'fault hit the actual publication path');
  assert.equal(
    f.manager.list().some((p) => p.id === f.setup.profileId),
    false,
  );
  assert.equal(f.manager.opened.has(f.setup.profileId), false);
  assert.equal(existsSync(resolve(f.runtimeDirectory, f.setup.profileId)), false);
}

test('actual encrypted copy retains exact intake evidence, originals and independent cache-loss recovery', async (t) => {
  const f = await fixture(t);
  const before = archive(f.manager.pathFor(f.sourceId));
  const dirty = resolve(f.source.workspace, 'sources/unpublished-fictional.txt');
  mkdirSync(resolve(f.source.workspace, 'sources'), { recursive: true });
  writeFileSync(dirty, 'FICTIONAL unpublished workspace evidence');
  await f.manager.verify(f.setup.setupId, { acknowledged: true, recovery: f.setup.recoveryKit });
  assert.deepEqual(
    archive(f.manager.pathFor(f.sourceId)),
    before,
    'copy performs no source encrypted writes',
  );
  assert.equal(f.source.vault.fileMetadata('sources/unpublished-fictional.txt'), null);
  const target = f.manager.opened.get(f.setup.profileId)!;
  assert.equal(target.vault.fileMetadata('sources/unpublished-fictional.txt'), null);
  check(f.source, f, false);
  check(target, f, true);
  rmSync(dirty);
  for (const [id, kit, copied] of [
    [f.sourceId, f.created.recoveryKit, false],
    [f.setup.profileId, f.setup.recoveryKit, true],
  ] as const) {
    f.manager.lock(id);
    f.manager.unlock(id, kit);
    check(f.manager.opened.get(id)!, f, copied);
    f.manager.lock(id);
    rmSync(resolve(f.manager.pathFor(id), 'cache'), { recursive: true, force: true });
    f.manager.unlock(id, kit);
    check(f.manager.opened.get(id)!, f, copied);
  }
  const sourceBefore = archive(f.manager.pathFor(f.sourceId));
  const reopened = f.manager.opened.get(f.setup.profileId)!;
  const frameBytes = () =>
    Number(
      reopened.db
        .prepare(
          "SELECT coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM app_meta WHERE key GLOB 'intake_state_v1:*:frame:*'",
        )
        .get()!.bytes,
    );
  const beforeFrameBytes = frameBytes();
  const next = JSON.parse(f.expected.serialized);
  next.future.a.push('fictional destination only');
  writeIntakeFixtureEnvelope(reopened.db, f.item.id, next);
  assert.ok(
    frameBytes() > beforeFrameBytes && frameBytes() - beforeFrameBytes < 4096,
    'subsequent intake frame scales with the changed suffix',
  );
  assert.deepEqual(archive(f.manager.pathFor(f.sourceId)), sourceBefore);
  assert.equal(
    createIntakeStateStorage(f.manager.opened.get(f.sourceId)!.db, f.scope).readSerialized(),
    f.expected.serialized,
  );
  f.manager.lock(reopened.id);
  rmSync(resolve(f.manager.pathFor(reopened.id), 'cache'), { recursive: true, force: true });
  f.manager.unlock(reopened.id, f.setup.recoveryKit);
  check(f.manager.opened.get(reopened.id)!, f, true, JSON.stringify(next));
});

for (const kind of ['immutable', 'head-before', 'head-after', 'activation'] as const) {
  test(
    'encrypted copy ' + kind + ' fault preserves visibility and selects correct retry authority',
    async (t) => {
      const f = await fixture(t);
      const sourceArchive = archive(f.manager.pathFor(f.sourceId));
      await fault(t, f, kind);
      assert.deepEqual(archive(f.manager.pathFor(f.sourceId)), sourceArchive);
      const head = selectedHead(f.manager, f.setup.recoveryKit);
      const published = kind === 'head-after' || kind === 'activation';
      assert.equal(head !== null, published);
      const advanced = JSON.parse(f.expected.serialized);
      advanced.future.a.push('fictional source advanced');
      writeIntakeFixtureEnvelope(f.source.db, f.item.id, advanced);
      if (!published) {
        f.manager.lock(f.sourceId);
        await assert.rejects(
          f.manager.verify(f.setup.setupId, { acknowledged: true, recovery: f.setup.recoveryKit }),
          /Unlock the original profile/,
        );
        assert.equal(selectedHead(f.manager, f.setup.recoveryKit), null);
        f.manager.unlock(f.sourceId, f.created.recoveryKit);
        let authorization = 0;
        await f.manager.verify(
          f.setup.setupId,
          { acknowledged: true, recovery: f.setup.recoveryKit },
          {
            authorizeCopySource(id) {
              assert.equal(id, f.sourceId);
              authorization++;
            },
          },
        );
        assert.equal(authorization, 1);
        check(f.manager.opened.get(f.setup.profileId)!, f, true, JSON.stringify(advanced));
      } else {
        const versions = archive(resolve(f.manager.pathFor(f.setup.profileId), 'vault/versions'));
        f.manager.lock(f.sourceId);
        f.manager.close();
        const restarted = createEncryptedProfiles({
          dataDirectory: f.dataDirectory,
          runtimeDirectory: f.runtimeDirectory,
        });
        try {
          const resumed = restarted.resume(f.setup.recoveryKit);
          assert.equal(resumed.active, false);
          assert.ok(resumed.setupId);
          await restarted.verify(
            resumed.setupId,
            { acknowledged: true, recovery: f.setup.recoveryKit },
            {
              authorizeCopySource() {
                assert.fail('published target must not borrow source authorization');
              },
            },
          );
          assert.equal(restarted.opened.has(f.sourceId), false);
          assert.equal(
            selectedHead(restarted, f.setup.recoveryKit),
            head,
            'selected accepted target is never recopied',
          );
          assert.deepEqual(
            archive(resolve(restarted.pathFor(f.setup.profileId), 'vault/versions')),
            versions,
            'retry creates no accepted version rewrite',
          );
          check(restarted.opened.get(f.setup.profileId)!, f, true);
          restarted.lock(f.setup.profileId);
          rmSync(resolve(restarted.pathFor(f.setup.profileId), 'cache'), {
            recursive: true,
            force: true,
          });
          restarted.unlock(f.setup.profileId, f.setup.recoveryKit);
          check(restarted.opened.get(f.setup.profileId)!, f, true);
        } finally {
          restarted.close();
        }
      }
    },
  );
}

test('unpublished copy requires exact recovery authentication and current source authorization before writes', async (t) => {
  const f = await fixture(t);
  const source = archive(f.manager.pathFor(f.sourceId));
  const target = archive(f.manager.pathFor(f.setup.profileId));
  await assert.rejects(
    f.manager.verify(f.setup.setupId, { acknowledged: true, recovery: f.created.recoveryKit }),
  );
  assert.deepEqual(archive(f.manager.pathFor(f.setup.profileId)), target);
  let called = 0;
  await assert.rejects(
    f.manager.verify(
      f.setup.setupId,
      { acknowledged: true, recovery: f.setup.recoveryKit },
      {
        authorizeCopySource(id) {
          assert.equal(id, f.sourceId);
          called++;
          throw Error('Fictional unauthorized source');
        },
      },
    ),
    /Fictional unauthorized source/,
  );
  assert.equal(called, 1);
  assert.deepEqual(archive(f.manager.pathFor(f.sourceId)), source);
  assert.deepEqual(archive(f.manager.pathFor(f.setup.profileId)), target);
  assert.equal(selectedHead(f.manager, f.setup.recoveryKit), null);
  assert.equal(f.manager.opened.has(f.setup.profileId), false);
});

for (const kind of [
  'unsupported',
  'missing-head',
  'missing-frame',
  'missing-receipt',
  'corrupt-frame',
  'wrong-profile',
  'wrong-source',
  'wrong-hash',
  'orphan-namespace',
  'corrupt-pin',
  'missing-namespace',
  'duplicated-inline-authority',
  'conflicting-compact-metadata',
] as const) {
  test(
    'actual encrypted copy refuses ' + kind + ' source evidence before target publication',
    async (t) => {
      const f = await fixture(t);
      const prefix = namespace(f.sourceId, f.item.id, f.item.sha256);
      transaction(f.source.db, () => {
        const headKey = prefix + 'head';
        const raw = String(
          f.source.db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value,
        );
        const head = JSON.parse(raw);
        if (kind === 'missing-namespace')
          f.source.db.prepare('DELETE FROM app_meta WHERE key LIKE ?').run(prefix + '%');
        if (kind === 'duplicated-inline-authority')
          f.source.db
            .prepare('UPDATE source_files SET details_json=? WHERE id=?')
            .run(f.expected.serialized, f.item.id);
        if (kind === 'conflicting-compact-metadata') {
          const compact = JSON.parse(f.expected.compact);
          compact.intake.originalName = 'Fictional conflicting original';
          f.source.db
            .prepare('UPDATE source_files SET details_json=? WHERE id=?')
            .run(JSON.stringify(compact), f.item.id);
        }
        if (kind === 'missing-head')
          f.source.db.prepare('DELETE FROM app_meta WHERE key=?').run(headKey);
        if (kind === 'unsupported') {
          head.format = 'health-intake-state-v1';
          f.source.db
            .prepare('UPDATE app_meta SET value=? WHERE key=?')
            .run(JSON.stringify(head), headKey);
        }
        if (kind === 'wrong-profile' || kind === 'wrong-hash') {
          head[kind === 'wrong-profile' ? 'profileId' : 'sourceHash'] =
            kind === 'wrong-profile' ? 'fictional-other-profile' : '0'.repeat(64);
          f.source.db
            .prepare('UPDATE app_meta SET value=? WHERE key=?')
            .run(JSON.stringify(head), headKey);
        }
        if (kind === 'wrong-source') {
          head.intakeId = 'fictional-other-source';
          f.source.db
            .prepare('UPDATE app_meta SET value=? WHERE key=?')
            .run(JSON.stringify(head), headKey);
        }
        const frame = f.source.db
          .prepare('SELECT key FROM app_meta WHERE key LIKE ? ORDER BY key LIMIT 1')
          .get(prefix + 'frame:%');
        if (kind === 'missing-frame')
          f.source.db.prepare('DELETE FROM app_meta WHERE key=?').run(String(frame!.key));
        if (kind === 'missing-receipt') {
          const operation = f.source.db
            .prepare('SELECT key FROM app_meta WHERE key LIKE ? ORDER BY key LIMIT 1')
            .get(prefix + 'operation:%');
          f.source.db.prepare('DELETE FROM app_meta WHERE key=?').run(String(operation!.key));
        }
        if (kind === 'corrupt-frame')
          f.source.db
            .prepare('UPDATE app_meta SET value=? WHERE key=?')
            .run('{fictional-corrupt', String(frame!.key));
        if (kind === 'orphan-namespace')
          f.source.db
            .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
            .run('intake_state_v9:fictional:head', '{}');
        if (kind === 'corrupt-pin')
          f.source.db
            .prepare('UPDATE app_meta SET value=? WHERE key=?')
            .run('{fictional-corrupt', intakeSourcePinKey(f.item.id));
      });
      const before = archive(f.manager.pathFor(f.sourceId));
      const target = archive(f.manager.pathFor(f.setup.profileId));
      await assert.rejects(
        f.manager.verify(f.setup.setupId, { acknowledged: true, recovery: f.setup.recoveryKit }),
        /intake|source text|unsupported|integrity/i,
      );
      assert.equal(selectedHead(f.manager, f.setup.recoveryKit), null);
      assert.equal(f.manager.opened.has(f.setup.profileId), false);
      assert.equal(
        f.manager.list().some((p) => p.id === f.setup.profileId),
        false,
      );
      assert.deepEqual(archive(f.manager.pathFor(f.sourceId)), before);
      assert.deepEqual(archive(f.manager.pathFor(f.setup.profileId)), target);
      clearIntakeStateCache(f.source.db);
    },
  );
}

for (const kind of ['missing', 'corrupt'] as const) {
  test(
    'encrypted copy refuses ' + kind + ' physical retained original before first head',
    async (t) => {
      const f = await fixture(t);
      const name = String(
        f.source.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.item.id)!.path,
      ).split('/sources/')[1]!;
      const metadata = f.source.vault.metadata();
      const objectId = metadata.files['sources/' + name]!;
      const path = resolve(f.manager.pathFor(f.sourceId), 'vault/objects', objectId + '.enc');
      const ciphertext = readFileSync(path);
      if (kind === 'missing') rmSync(path);
      else writeFileSync(path, Buffer.from('fictional corrupt ciphertext'));
      const before = archive(f.manager.pathFor(f.sourceId));
      try {
        await assert.rejects(
          f.manager.verify(f.setup.setupId, { acknowledged: true, recovery: f.setup.recoveryKit }),
        );
        assert.equal(selectedHead(f.manager, f.setup.recoveryKit), null);
        assert.equal(f.manager.opened.has(f.setup.profileId), false);
        assert.deepEqual(archive(f.manager.pathFor(f.sourceId)), before);
      } finally {
        writeFileSync(path, ciphertext);
      }
    },
  );
}

test('encrypted raw initial envelope remains exact through copy and rebuild until its first authorized rewrite', async (t) => {
  const f = vaultFixture(t);
  const created = await newProfile(f.manager, 'Fictional raw envelope source');
  const source = f.manager.opened.get(created.profile.id)!;
  const id = 'fictional-raw-envelope';
  const bytes = Buffer.from('Independently fictional raw original.');
  const relativePath = `data/profiles/${source.id}/sources/raw-envelope.txt`;
  const raw =
    ' { "before":{"escaped":"\\u03A9","duplicate":1,"duplicate":2}, "intake" : {"originalName":"raw-envelope.txt","version":1,"state":"pending","proposals":[],"workflow":{"format":"health-intake-workflow-v1","questions":[]}}, "after":true }\n';
  writeFileSync(resolve(source.root, relativePath), bytes);
  source.vault.storeFile('sources/raw-envelope.txt', bytes);
  transaction(source.db, () => {
    source.db
      .prepare('INSERT INTO providers(id,name) VALUES(?,?)')
      .run('fictional-raw-provider', 'Fictional raw provider');
    registerIntakeFile(source.db, {
      id,
      providerId: 'fictional-raw-provider',
      batchId: null,
      path: relativePath,
      bytes,
      mimeType: 'text/plain',
      kind: 'intake_original',
      coverage: 'unknown',
      details: raw,
    });
  });
  const setup = f.manager.begin({ name: 'Fictional raw envelope copy', copyFrom: source.id });
  await f.manager.verify(setup.setupId, { acknowledged: true, recovery: setup.recoveryKit });
  for (const [profileId, kit] of [
    [source.id, created.recoveryKit],
    [setup.profileId, setup.recoveryKit],
  ] as const) {
    f.manager.lock(profileId);
    rmSync(resolve(f.manager.pathFor(profileId), 'cache'), { recursive: true, force: true });
    f.manager.unlock(profileId, kit);
    const state = f.manager.opened.get(profileId)!;
    assert.equal(readIntakeEnvelopeText(state.db, { id }), raw);
    assert.deepEqual(
      createIntakeStateStorage(state.db, {
        profileId,
        intakeId: id,
        sourceHash: sha(bytes),
      }).read(),
      { raw },
    );
    assert.deepEqual(intake.getIntakeOriginal(state.db, state.root, profileId, id).bytes, bytes);
    const compact = JSON.parse(
      String(
        state.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!.details_json,
      ),
    );
    assert.equal(compact.intakeAuthority.mode, 'raw');
    assert.equal(compact.intake.workflow, undefined);
  }
  const target = f.manager.opened.get(setup.profileId)!;
  const normalized = JSON.parse(raw);
  normalized.intake.workflow.questions.push({
    id: 'fictional-target-question',
    prompt: 'Fictional review?',
  });
  writeIntakeFixtureEnvelope(target.db, id, normalized);
  assert.equal(readIntakeEnvelopeText(target.db, { id }), JSON.stringify(normalized));
  assert.equal(readIntakeEnvelopeText(f.manager.opened.get(source.id)!.db, { id }), raw);
  f.manager.lock(target.id);
  rmSync(resolve(f.manager.pathFor(target.id), 'cache'), { recursive: true, force: true });
  f.manager.unlock(target.id, setup.recoveryKit);
  assert.equal(
    readIntakeEnvelopeText(f.manager.opened.get(target.id)!.db, { id }),
    JSON.stringify(normalized),
  );
});
