import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { packageMemberRoleHash } from '../intake-proposal-dependencies.ts';
import { uploadIntake, getIntake, getIntakeOriginal } from '../intake.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import { readIntakeEnvelope, stageIntakeEnvelope } from '../intake-authority.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import {
  storedIntakeDetails,
  requireStoredIntakeDetails,
  intakeDetails,
  readStoredIntakeDetails,
  writeIntakeDetails,
  updateStoredIntakeDetails,
  maximumReportDiscoveryOrder,
  retainedReportAcceptance,
  intakeIdentityConfirmations,
  sourceDetailsSearch,
  sourceFileDetails,
} from '../intake-state-access.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'intake-access-'));
  const profileId = 'fictional-access';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from('Independently fictional source evidence Ω.');
  const uploaded = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes,
    newProviderName: 'Fictional clinic',
  });
  const row = () =>
    db.prepare('SELECT id,kind,details_json FROM source_files WHERE id=?').get(uploaded.id) as {
      id: string;
      kind: string;
      details_json: string;
    };
  return { db, root, profileId, uploaded, bytes, row };
}

test('real intake DTO reads effective pins while writes preserve raw pin fields and envelope values', (t) => {
  const f = fixture(t);
  const raw = requireStoredIntakeDetails(f.db, f.row());
  const absentWorkflow = { ...raw };
  delete absentWorkflow.workflow;
  transaction(f.db, () => {
    stageIntakeEnvelope(f.db, { id: f.uploaded.id }, { intake: absentWorkflow });
  });
  assert.equal(Object.hasOwn(readStoredIntakeDetails(f.db, f.uploaded.id)!, 'workflow'), false);

  const envelope = {
    ...(readIntakeEnvelope(f.db, f.row()) as Record<string, unknown>),
    fictionalUnknown: { absent: [], nullable: null, text: 'Ω' },
  };
  transaction(f.db, () => {
    stageIntakeEnvelope(f.db, f.row(), envelope);
    writeIntakeSourcePin(f.db, f.uploaded.id, {
      revisionId: 'fictional-revision',
      dependencyToken: 'fictional-dependency',
      requiresInterpretation: true,
      version: 3,
    });
  });
  const pinned = {
    ...f.row(),
    source_pin: JSON.stringify({
      revisionId: 'fictional-revision',
      dependencyToken: 'fictional-dependency',
      requiresInterpretation: true,
      version: 3,
    }),
  };
  const effective = intakeDetails(f.db, pinned);
  assert.equal(effective.version, raw.version + 3);
  assert.equal(getIntake(f.db, f.root, f.profileId, f.uploaded.id).version, effective.version);
  transaction(f.db, () =>
    writeIntakeDetails(f.db, pinned, {
      ...effective,
      version: effective.version + 1,
      conversionChatId: null,
    }),
  );
  const stored = readStoredIntakeDetails(f.db, f.uploaded.id)!;
  assert.equal(stored.version, raw.version + 1);
  assert.equal(stored.conversionChatId, null);
  assert.equal(
    Object.hasOwn(stored, 'sourceTextRevisionId'),
    Object.hasOwn(raw, 'sourceTextRevisionId'),
  );
  assert.deepEqual(sourceFileDetails(f.db, f.row()), { ...envelope, intake: stored });
  transaction(f.db, () =>
    updateStoredIntakeDetails(f.db, f.uploaded.id, (details) => {
      details.lastReviewToken = null;
    }),
  );
  assert.equal(readStoredIntakeDetails(f.db, f.uploaded.id)!.version, stored.version);
  assert.equal(getIntake(f.db, f.root, f.profileId, f.uploaded.id).version, effective.version + 1);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, f.uploaded.id).bytes, f.bytes);
});

test('missing or malformed authority fails in real intake consumers without inventing an empty workflow', (t) => {
  const f = fixture(t);
  assert.equal(
    storedIntakeDetails(f.db, { id: f.uploaded.id, kind: 'other', details_json: '{}' }),
    undefined,
  );
  assert.equal(readStoredIntakeDetails(f.db, 'missing'), undefined);
  for (const details_json of [
    '{}',
    '{"intake":null}',
    '{"intake":[]}',
    '{"intake":{"workflow":null}}',
    '{"intake":{"workflow":[]}}',
  ]) {
    assert.throws(
      () =>
        transaction(f.db, () => {
          f.db
            .prepare('UPDATE source_files SET details_json=? WHERE id=?')
            .run(details_json, f.uploaded.id);
          getIntake(f.db, f.root, f.profileId, f.uploaded.id);
        }),
      /incomplete|authority|missing|unsupported|duplicated/,
    );
  }
  assert.throws(
    () =>
      storedIntakeDetails(f.db, {
        id: f.uploaded.id,
        kind: 'other',
        details_json: '{"intake":null}',
      }),
    /incomplete|authority|missing|unsupported|duplicated/,
  );
});

test('discovery and receipt adapters retain scoped SQL semantics and operational source search', (t) => {
  const f = fixture(t);
  const operations = [
    { receipt: { operationId: 'fictional-operation' }, request: { fictional: true } },
  ];
  const receipts = [{ fictional: 'confirmation' }];
  const envelope = readIntakeEnvelope(f.db, f.row()) as { intake: any };
  envelope.intake.workflow = {
    reportGroups: [{ discoveryOrder: 17 }],
    reportAcceptances: operations,
    identityConfirmations: receipts,
  };
  transaction(f.db, () => {
    stageIntakeEnvelope(f.db, f.row(), envelope);
  });
  transaction(f.db, () =>
    f.db
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run(
        'fictional-nonoriginal',
        'other.txt',
        'b'.repeat(64),
        0,
        'other',
        JSON.stringify({
          intake: {
            workflow: {
              reportGroups: [{ discoveryOrder: 999 }],
              reportAcceptances: [{ receipt: { operationId: 'other-operation' } }],
            },
          },
        }),
      ),
  );
  assert.equal(maximumReportDiscoveryOrder(f.db), 17);
  assert.deepEqual(retainedReportAcceptance(f.db, 'fictional-operation'), operations[0]);
  assert.equal(retainedReportAcceptance(f.db, 'other-operation'), null);
  assert.equal(retainedReportAcceptance(f.db, 'unknown'), null);
  assert.deepEqual(intakeIdentityConfirmations(f.db), receipts);
  const query = sourceDetailsSearch(f.db, 'fictional-operation');
  try {
    const rows = f.db
      .prepare(`SELECT f.id FROM source_files f ${query.joins} WHERE ${query.predicate}`)
      .all(...query.parameters);
    assert.deepEqual(
      rows.map((row) => row.id),
      [f.uploaded.id],
    );
  } finally {
    query.dispose();
  }
});

test('intake identity is required and package roles are read only from original sources', (t) => {
  const f = fixture(t);
  const envelope = readIntakeEnvelope(f.db, f.row()) as { intake: any };
  assert.throws(
    () =>
      storedIntakeDetails(f.db, {
        id: '',
        kind: 'intake_original',
        details_json: JSON.stringify(envelope),
      }),
    /identity is incomplete|missing source/,
  );
  envelope.intake.workflow = {
    plans: [{ status: 'active', packageRoles: [{ memberId: 'fictional-member', role: 'report' }] }],
  };
  const raw = JSON.stringify(envelope);
  transaction(f.db, () => {
    stageIntakeEnvelope(f.db, f.row(), envelope);
  });
  transaction(f.db, () =>
    f.db
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run('fictional-proposal', 'proposal.txt', 'b'.repeat(64), 0, 'intake_proposal', raw),
  );
  assert.ok(readStoredIntakeDetails(f.db, 'fictional-proposal'));
  assert.equal(
    readStoredIntakeDetails(f.db, 'fictional-proposal', { originalOnly: true }),
    undefined,
  );
  assert.equal(packageMemberRoleHash(f.db, 'fictional-proposal', 'fictional-member'), null);
  assert.match(packageMemberRoleHash(f.db, f.uploaded.id, 'fictional-member')!, /^[a-f0-9]{64}$/);
});
