import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openDatabase } from '../database.ts';
import { createNote } from '../notes.ts';
import { attachRecordDurability } from '../record-versions.ts';
import type {
  RecordTransactionBackingPlan,
  RecordTransactionIndexedPublication,
} from '../record-versions.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  openContributorRecordStorage,
  contributorAuthorityPath,
  captureContributorRecordReadOwner,
  closeContributorRecordReadOwner,
  captureContributorLegacyBridgeBackingScopeForStorage,
  bindContributorLegacyBridgeBackingScope,
  contributorLegacyBridgeBackingScopeCurrent,
} from '../contributor-record-storage.ts';
import { beginManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';
import { unlockPhysicalEntries, unlockPhysicalIdentity } from '../encrypted-unlock-physical.ts';
import {
  captureContributorRecordStaging,
  prepareContributorRecordTransactionBacking,
  assertContributorRecordTransactionPrior,
  stageContributorRecordObject,
  prepareContributorRecordStagingHead,
  prepareContributorRecordBackingAdvance,
  finishContributorRecordStagingPreparation,
  installContributorRecordStagingHead,
  discardContributorRecordStaging,
} from '../contributor-record-staging.ts';

function fixture(t: TestContext, accepted = false, originalMembers = 0) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-contributor-staging-'))),
    profileId = 'fictional',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    storage = openContributorRecordStorage(root, profileId, { initialize: true });
  attachRecordDurability(db, { profileId, storage });
  if (accepted)
    createNote(db, {
      kind: 'person',
      title: 'Fictional accepted predecessor',
      person: { fullName: 'Fictional Accepted Person' },
    });
  for (let index = 0; index < originalMembers; index++)
    storage.writeImmutable('objects/' + randomUUID(), Buffer.from(`fictional original ${index}`));
  const original = captureContributorRecordReadOwner(storage)!;
  t.after(() => {
    closeContributorRecordReadOwner(original);
    storage.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const head = join(contributorAuthorityPath(root, profileId), 'head'),
    selected = readFileSync(head, 'utf8');
  return { root, db, storage, original, head, selected };
}

test('contributor replay binds a real accepted predecessor to raw original contents bytes', async (t) => {
  const f = fixture(t, true),
    row = f.db
      .prepare(
        'SELECT c.entity,c.record_id,c.version_id,v.contents_json,v.deleted FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id ORDER BY c.entity LIMIT 1',
      )
      .get()!,
    raw = String(row.contents_json),
    prior = {
      deleted: !!row.deleted,
      preimage: {
        hash: createHash('sha256').update(raw).digest('hex'),
        bytes: Buffer.byteLength(raw),
      },
    },
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    await prepareContributorRecordTransactionBacking(witness, f.selected, () => {});
    assert.doesNotThrow(() =>
      assertContributorRecordTransactionPrior(
        witness,
        String(row.entity),
        String(row.record_id),
        String(row.version_id),
        prior,
      ),
    );
    assert.throws(
      () =>
        assertContributorRecordTransactionPrior(
          witness,
          String(row.entity),
          String(row.record_id),
          String(row.version_id),
          { ...prior, preimage: { ...prior.preimage, hash: '0'.repeat(64) } },
        ),
      /predecessor differs/,
    );
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor preparation refuses a checkpoint rewrite of an already visited original', async (t) => {
  const f = fixture(t, false, 80),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!,
    base = contributorAuthorityPath(f.root, 'fictional'),
    visited = [...unlockPhysicalEntries(base)]
      .slice(0, 63)
      .find((item) => item.kind === 'file' && item.path.startsWith('objects/'));
  assert.ok(visited, 'an original immutable file precedes the first worker checkpoint');
  const path = join(base, visited.path),
    initial = unlockPhysicalIdentity(path).value;
  let checks = 0,
    rewritten = false;
  try {
    await assert.rejects(
      prepareContributorRecordTransactionBacking(witness, f.selected, () => {
        if (++checks !== 3) return;
        writeFileSync(path, readFileSync(path));
        rewritten = true;
        assert.notEqual(unlockPhysicalIdentity(path).value, initial);
      }),
      /verification refused/,
    );
    assert.equal(rewritten, true);
    assert.equal(readFileSync(f.head, 'utf8'), f.selected);
    await assert.rejects(
      prepareContributorRecordTransactionBacking(witness, f.selected, () => {}),
      /attempt expired/,
    );
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor preparation cannot recapture after an early callback refusal', async (t) => {
  const f = fixture(t),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    await assert.rejects(
      prepareContributorRecordTransactionBacking(witness, f.selected, () => {
        throw Error('fictional callback refused');
      }),
      /fictional callback refused/,
    );
    await assert.rejects(
      prepareContributorRecordTransactionBacking(witness, f.selected, () => {}),
      /attempt expired/,
    );
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor preparation captures immutable baseline before its first supplied callback', async (t) => {
  const f = fixture(t, false, 1),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!,
    base = contributorAuthorityPath(f.root, 'fictional'),
    member = [...unlockPhysicalEntries(base)].find(
      (item) => item.kind === 'file' && item.path.startsWith('objects/'),
    );
  assert.ok(member);
  const path = join(base, member.path),
    initial = unlockPhysicalIdentity(path).value;
  let callbacks = 0;
  try {
    await assert.rejects(
      prepareContributorRecordTransactionBacking(witness, f.selected, () => {
        if (++callbacks !== 1) return;
        writeFileSync(path, readFileSync(path));
        assert.notEqual(unlockPhysicalIdentity(path).value, initial);
      }),
      /verification refused/,
    );
    assert.equal(callbacks > 0, true);
    assert.equal(readFileSync(f.head, 'utf8'), f.selected);
  } finally {
    discardContributorRecordStaging(witness);
  }
});

function candidate() {
  const bytes = Buffer.from('fictional changed immutable segment'),
    ref = {
      name: 'objects/' + randomUUID(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
  return { bytes, ref };
}

test('contributor legacy bridge scope is genuine, original, and path scoped', (t) => {
  const f = fixture(t),
    scope = captureContributorLegacyBridgeBackingScopeForStorage(f.storage);
  assert.ok(scope);
  assert.equal(bindContributorLegacyBridgeBackingScope(f.storage, f.original, scope), true);
  const unrelated = beginManagedPhysicalMutation([join(f.root, 'unrelated')]);
  unrelated();
  assert.equal(contributorLegacyBridgeBackingScopeCurrent(f.storage, f.original, scope), true);
  const original = beginManagedPhysicalMutation([
    join(contributorAuthorityPath(f.root, 'fictional'), 'objects', randomUUID()),
  ]);
  original();
  assert.equal(contributorLegacyBridgeBackingScopeCurrent(f.storage, f.original, scope), false);
});

test('contributor legacy bridge refuses an actual immutable write before read-owner bind', (t) => {
  const f = fixture(t),
    scope = captureContributorLegacyBridgeBackingScopeForStorage(f.storage);
  assert.ok(scope);
  f.storage.writeImmutable('objects/' + randomUUID(), Buffer.from('fictional intervening object'));
  assert.equal(bindContributorLegacyBridgeBackingScope(f.storage, f.original, scope), false);
  assert.equal(contributorLegacyBridgeBackingScopeCurrent(f.storage, f.original, scope), false);
});

test('contributor legacy bridge refuses an actual immutable write after read-owner bind', (t) => {
  const f = fixture(t),
    scope = captureContributorLegacyBridgeBackingScopeForStorage(f.storage);
  assert.ok(scope);
  assert.equal(bindContributorLegacyBridgeBackingScope(f.storage, f.original, scope), true);
  f.storage.writeImmutable('objects/' + randomUUID(), Buffer.from('fictional later object'));
  assert.equal(contributorLegacyBridgeBackingScopeCurrent(f.storage, f.original, scope), false);
});

test('contributor legacy bridge refuses an idempotent immutable write attempt', (t) => {
  const f = fixture(t),
    scope = captureContributorLegacyBridgeBackingScopeForStorage(f.storage);
  assert.ok(scope);
  assert.equal(bindContributorLegacyBridgeBackingScope(f.storage, f.original, scope), true);
  const ref = JSON.parse(f.selected) as { name: string },
    bytes = f.storage.read(ref.name)!;
  f.storage.writeImmutable(ref.name, bytes);
  assert.equal(contributorLegacyBridgeBackingScopeCurrent(f.storage, f.original, scope), false);
});

test('contributor original replay authenticates absence and stages only exact factory additions', async (t) => {
  const f = fixture(t),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    await prepareContributorRecordTransactionBacking(witness, f.selected, () => {});
    assert.doesNotThrow(() =>
      assertContributorRecordTransactionPrior(witness, 'people', '["fictional-new"]', null, null),
    );
    assert.throws(
      () =>
        assertContributorRecordTransactionPrior(witness, 'people', '["fictional-new"]', 'forged', {
          deleted: false,
          preimage: { hash: '0'.repeat(64), bytes: 0 },
        }),
      /predecessor differs/,
    );
    const { bytes, ref } = candidate();
    stageContributorRecordObject(witness, ref, bytes);
    prepareContributorRecordStagingHead(witness, ref);
    await finishContributorRecordStagingPreparation(witness, () => {});
    assert.equal(readFileSync(f.head, 'utf8'), f.selected);
    assert.throws(
      () =>
        installContributorRecordStagingHead(
          witness,
          Object.freeze({}) as RecordTransactionIndexedPublication,
          Object.freeze({}) as RecordTransactionBackingPlan,
        ),
      /not sealed/,
    );
    assert.equal(readFileSync(f.head, 'utf8'), f.selected);
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor changed certificate refuses caller-minted backing plans', async (t) => {
  const f = fixture(t),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    await prepareContributorRecordTransactionBacking(witness, f.selected, () => {});
    const { bytes, ref } = candidate();
    stageContributorRecordObject(witness, ref, bytes);
    prepareContributorRecordStagingHead(witness, ref);
    const forged = Object.freeze({}) as RecordTransactionBackingPlan;
    await assert.rejects(
      prepareContributorRecordBackingAdvance(witness, JSON.stringify(ref), forged),
      /successor HEAD differs/,
    );
    await assert.rejects(
      prepareContributorRecordBackingAdvance(witness, JSON.stringify(ref) + '\n', forged),
      /foreign record transaction backing payload/,
    );
    assert.doesNotThrow(() =>
      assertContributorRecordTransactionPrior(witness, 'people', '["fictional-new"]', null, null),
    );
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor final proof rejects an unowned physical member beside exact staged objects', async (t) => {
  const f = fixture(t),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    await prepareContributorRecordTransactionBacking(witness, f.selected, () => {});
    const { bytes, ref } = candidate();
    stageContributorRecordObject(witness, ref, bytes);
    prepareContributorRecordStagingHead(witness, ref);
    writeFileSync(
      join(contributorAuthorityPath(f.root, 'fictional'), 'objects', randomUUID()),
      bytes,
    );
    await assert.rejects(
      finishContributorRecordStagingPreparation(witness, () => {}),
      /verification refused/,
    );
    assert.equal(readFileSync(f.head, 'utf8'), f.selected);
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor final pass catches a checkpoint rewrite of an already visited original', async (t) => {
  const f = fixture(t, false, 80),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    await prepareContributorRecordTransactionBacking(witness, f.selected, () => {});
    const { bytes, ref } = candidate();
    stageContributorRecordObject(witness, ref, bytes);
    prepareContributorRecordStagingHead(witness, ref);
    const base = contributorAuthorityPath(f.root, 'fictional'),
      visited = [...unlockPhysicalEntries(base)]
        .slice(0, 63)
        .find((item) => item.kind === 'file' && item.path.startsWith('objects/'));
    assert.ok(visited, 'an original immutable file precedes the first worker checkpoint');
    const path = join(base, visited.path),
      initial = unlockPhysicalIdentity(path).value;
    let checks = 0,
      rewritten = false;
    await assert.rejects(
      finishContributorRecordStagingPreparation(witness, () => {
        if (++checks !== 3) return;
        writeFileSync(path, readFileSync(path));
        rewritten = true;
        assert.notEqual(unlockPhysicalIdentity(path).value, initial);
      }),
      /verification refused/,
    );
    assert.equal(rewritten, true);
    assert.equal(readFileSync(f.head, 'utf8'), f.selected);
    await assert.rejects(
      finishContributorRecordStagingPreparation(witness, () => {}),
      /final staging expired/,
    );
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor sealed scratch refuses a same-byte physical replacement', async (t) => {
  const previousTemporary = process.env.TMPDIR,
    temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-sealed-scratch-')));
  process.env.TMPDIR = temporary;
  t.after(() => {
    if (previousTemporary === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporary;
    rmSync(temporary, { recursive: true, force: true });
  });
  const f = fixture(t),
    before = new Set(
      readdirSync(temporary).filter((name) => name.startsWith('circus-contributor-backing-')),
    ),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    await prepareContributorRecordTransactionBacking(witness, f.selected, () => {});
    const created = readdirSync(temporary).filter(
      (name) => name.startsWith('circus-contributor-backing-') && !before.has(name),
    );
    assert.equal(created.length, 1);
    const physical = join(temporary, created[0]!, 'physical.sqlite');
    const { bytes, ref } = candidate();
    stageContributorRecordObject(witness, ref, bytes);
    prepareContributorRecordStagingHead(witness, ref);
    await finishContributorRecordStagingPreparation(witness, () => {});
    const initial = unlockPhysicalIdentity(physical).value;
    writeFileSync(physical, readFileSync(physical));
    assert.notEqual(unlockPhysicalIdentity(physical).value, initial);
    assert.throws(
      () =>
        assertContributorRecordTransactionPrior(witness, 'people', '["fictional-new"]', null, null),
      /backing unavailable/,
    );
    assert.equal(readFileSync(f.head, 'utf8'), f.selected);
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor staging refuses an existing same-byte foreign object', async (t) => {
  const f = fixture(t),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    await prepareContributorRecordTransactionBacking(witness, f.selected, () => {});
    const { bytes, ref } = candidate();
    writeFileSync(join(contributorAuthorityPath(f.root, 'fictional'), ref.name), bytes);
    assert.throws(
      () => stageContributorRecordObject(witness, ref, bytes),
      /Contributor original objects parent changed before own write/,
    );
    assert.equal(readFileSync(f.head, 'utf8'), f.selected);
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor original proof rejects same-byte raw replacement and foreign storage', async (t) => {
  const f = fixture(t),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    assert.equal(captureContributorRecordStaging(f.db, { ...f.storage }, f.original), undefined);
    await prepareContributorRecordTransactionBacking(witness, f.selected, () => {});
    const original = readFileSync(f.head);
    writeFileSync(f.head, original);
    assert.throws(
      () => assertContributorRecordTransactionPrior(witness, 'people', '["new"]', null, null),
      /owner changed/,
    );
  } finally {
    discardContributorRecordStaging(witness);
  }
});

test('contributor witness rejects an unplanned idempotent factory write', async (t) => {
  const f = fixture(t),
    witness = captureContributorRecordStaging(f.db, f.storage, f.original)!;
  try {
    await prepareContributorRecordTransactionBacking(witness, f.selected, () => {});
    const ref = JSON.parse(f.selected) as { name: string };
    f.storage.writeImmutable(ref.name, f.storage.read(ref.name)!);
    assert.throws(
      () => assertContributorRecordTransactionPrior(witness, 'people', '["new"]', null, null),
      /backing scratch changed/,
    );
  } finally {
    discardContributorRecordStaging(witness);
  }
});
