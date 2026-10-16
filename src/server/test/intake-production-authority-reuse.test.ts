import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import {
  productionIntakeAuthorityWork,
  validateProductionIntakeAuthority,
} from '../intake-state-bootstrap.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-production-reuse-'));
  const identity = {
    profileId: 'fictional-production-reuse',
    intakeId: 'fictional-reuse-package',
    // Unique per run, so no other test's validated input can match this one.
    sourceHash: sha('fictional reuse package bytes ' + randomUUID()),
  };
  const db = openDatabase(join(directory, 'source.sqlite'), identity.profileId);
  memoryRecordAuthority(db);
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 7,
      originalName: 'fictional-reuse.zip',
      state: 'pending',
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [
          {
            id: 'candidate-reuse',
            versions: [{ id: 'version-reuse', status: 'pending', occurrences: [] }],
          },
        ],
        plans: [],
      },
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json,mime_type) VALUES(?,?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      `data/profiles/${identity.profileId}/sources/fictional-reuse.zip`,
      identity.sourceHash,
      29,
      'intake_original',
      initial.detailsJson,
      'application/zip',
    );
    writeIntakeSourcePin(db, identity.intakeId, {
      revisionId: null,
      dependencyToken: null,
      requiresInterpretation: false,
      version: 1,
    });
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, {
    id: identity.intakeId,
    kind: 'intake_original',
    sha256: identity.sourceHash,
  });
  const opened = [db];
  t.after(() => {
    for (const item of opened) {
      clearIntakeStateCache(item);
      if (item.isOpen) item.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, identity, db, opened };
}

const replays = (db: Parameters<typeof intakeWorkCounters>[0]) =>
  intakeWorkCounters(db).reconstruction.evidenceReplayVersions;

test('production intake validation runs once per exact input and reruns after any change', async (t) => {
  const f = await fixture(t);
  const start = productionIntakeAuthorityWork();
  validateProductionIntakeAuthority(f.db, f.identity.profileId);
  const first = replays(f.db);
  assert.ok(first > 0, 'fixture validation replays retained intake versions');
  assert.deepEqual(productionIntakeAuthorityWork(), {
    validations: start.validations + 1,
    reuses: start.reuses,
  });

  // Same connection, then an independent byte-identical copy: no further replay.
  validateProductionIntakeAuthority(f.db, f.identity.profileId);
  const copyPath = join(f.directory, 'copy.sqlite');
  f.db.exec(`VACUUM INTO '${copyPath.replaceAll("'", "''")}'`);
  const copy = openDatabase(copyPath, f.identity.profileId);
  f.opened.push(copy);
  validateProductionIntakeAuthority(copy, f.identity.profileId);
  assert.equal(replays(f.db), first);
  assert.equal(replays(copy), 0);
  assert.deepEqual(productionIntakeAuthorityWork(), {
    validations: start.validations + 1,
    reuses: start.reuses + 2,
  });

  // A changed intake row is validated completely again and refused.
  const head = copy
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head'")
    .get()!;
  copy.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
    String(head.value).replace(
      /"storageSequence":(\d+)/,
      (_, n) => `"storageSequence":${Number(n) + 1}`,
    ),
    head.key!,
  );
  assert.notEqual(
    copy.prepare('SELECT value FROM app_meta WHERE key=?').get(head.key!)!.value,
    head.value,
  );
  assert.throws(() => validateProductionIntakeAuthority(copy, f.identity.profileId));
  assert.deepEqual(productionIntakeAuthorityWork(), {
    validations: start.validations + 1,
    reuses: start.reuses + 2,
  });

  // Restoring the exact bytes restores the exact validated input.
  copy.prepare('UPDATE app_meta SET value=? WHERE key=?').run(head.value!, head.key!);
  validateProductionIntakeAuthority(copy, f.identity.profileId);
  assert.equal(productionIntakeAuthorityWork().reuses, start.reuses + 3);

  // A progress observer always receives the complete traversal.
  let progress = 0;
  const beforeProgress = replays(copy);
  validateProductionIntakeAuthority(copy, f.identity.profileId, {
    onProgress: () => {
      progress++;
    },
  });
  assert.equal(productionIntakeAuthorityWork().validations, start.validations + 2);
  assert.ok(replays(copy) > beforeProgress, 'observed validation replays again');
  assert.ok(progress > 0, 'observer saw the traversal');
});
