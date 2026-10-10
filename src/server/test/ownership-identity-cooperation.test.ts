import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { openDatabase } from '../database.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  bindReviewRecordIssues,
  inlineReviewRecordIssues,
  reviewIssueFactory,
} from '../intake-review-issue-state.ts';
import {
  ownershipIdentityIssues,
  prepareOwnershipIdentityIssues,
} from '../record-ownership-authority.ts';
import { prepareOwnershipIdentitySnapshots } from '../ownership-identity-snapshots.ts';
import {
  createOwnershipSourceSnapshotPreparation,
  readOwnershipSourceSnapshot,
} from '../ownership-source-snapshots.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import type { IntakeReviewIssue, IntakeReviewRecord } from '../../shared/intake.ts';

test('native ownership identity preparation yields during complete referenced issue inspection', async (t) => {
  for (const count of [65, 4]) {
    const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-identity-cooperation-'));
    const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
    const storage = openDatabase(join(root, 'policy.sqlite'), 'fictional');
    memoryRecordAuthority(db);
    const source = { id: `fictional-original-${count}` };
    registerRawIntakeFixture(db, source.id, JSON.stringify({ intake: { version: 1 } }));
    await buildIntakeCollectionEnvelope(db, source);
    let current = true;
    const policy = reviewIssueFactory(
      db,
      {
        sourceId: source.id,
        generation: 'fictional-generation',
        assertCurrent() {
          if (!current) throw Error('Fictional source invalidated');
        },
      },
      storage,
    );
    t.after(() => {
      current = false;
      policy.dispose();
      storage.close();
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const record = {
      id: 'fictional-record',
      candidateVersionId: 'fictional-candidate',
    } as IntakeReviewRecord;
    const selected = policy(record);
    for (let index = 0; index < count; index++)
      selected.push({
        id: `fictional-issue-${index}`,
        kind: index % 3 === 0 ? 'uncertain_reading' : 'identity',
        prompt: `Fictional identity question ${index}`,
        textAnchor: index % 3 === 0 ? undefined : `Fictional anchor ${index}`,
      } as IntakeReviewIssue);
    bindReviewRecordIssues(record, selected);
    const expected = [...ownershipIdentityIssues(record)];
    let inspected = 0;
    let pointReads = 0;
    let iteratorReads = 0;
    let firstTurn: Promise<number> | undefined;
    const visit = () => {
      if (!firstTurn) firstTurn = setImmediate().then(() => inspected);
      inspected++;
    };
    const originalAt = selected.at.bind(selected);
    const originalIterate = selected[Symbol.iterator].bind(selected);
    selected.at = (ordinal) => {
      visit();
      pointReads++;
      return originalAt(ordinal);
    };
    selected[Symbol.iterator] = function* () {
      const iterator = originalIterate();
      for (let next = iterator.next(); !next.done; next = iterator.next()) {
        visit();
        iteratorReads++;
        yield next.value;
      }
    };
    const plan = await prepareOwnershipIdentitySnapshots(db, db, {
      sources: [{ intakeId: source.id, recordId: record.id }],
      record() {
        return record;
      },
      factory() {
        return createOwnershipSourceSnapshotPreparation(db, source);
      },
    });
    assert.ok(firstTurn);
    const firstInspected = await firstTurn;
    assert.ok(firstInspected > 0);
    if (count === 65)
      assert.ok(firstInspected <= 16, `first turn followed ${firstInspected} issue reads`);
    assert.equal(pointReads, count);
    assert.equal(iteratorReads, 0);
    const issues = plan.forSource(source.id, record.id);
    assert.ok(!Array.isArray(issues));
    assert.deepEqual(readOwnershipSourceSnapshot(db, issues.snapshot).sourceRecordIds, [
      ...new Set(expected),
    ]);
    plan.assertCurrent();
  }
});

test('referenced identity sort refuses cancellation, source loss, and changed policy between turns', async () => {
  for (const interruption of ['abort', 'source', 'count', 'same-count'] as const) {
    const db = openDatabase(':memory:', 'fictional');
    let current = true;
    const signal = new AbortController();
    const policy = reviewIssueFactory(db, {
      sourceId: 'fictional-original',
      generation: 'fictional-generation',
      assertCurrent() {
        if (!current) throw Error('Fictional source invalidated');
      },
    });
    try {
      const record = {
        id: 'fictional-record',
        candidateVersionId: 'fictional-candidate',
      } as IntakeReviewRecord;
      const selected = policy(record);
      for (let index = 0; index < 65; index++)
        selected.push({
          id: `fictional-issue-${index}`,
          kind: 'identity',
          prompt: `Fictional identity question ${index}`,
          textAnchor: `Fictional anchor ${index}`,
        } as IntakeReviewIssue);
      bindReviewRecordIssues(record, selected);
      const interrupt = setImmediate().then(() => {
        if (interruption === 'abort') signal.abort();
        if (interruption === 'source') current = false;
        if (interruption === 'same-count') selected.at(0)!.prompt = 'Fictional revised question';
        if (interruption === 'count')
          selected.push({
            id: 'fictional-late-issue',
            kind: 'identity',
            prompt: 'Fictional late question',
            textAnchor: 'Fictional late anchor',
          } as IntakeReviewIssue);
      });
      await assert.rejects(
        prepareOwnershipIdentityIssues(record, () => {
          if (signal.signal.aborted) throw Error('Fictional operation cancelled');
          if (!current) throw Error('Fictional source invalidated');
        }),
        /cancelled|invalidated|changed/,
      );
      await interrupt;
    } finally {
      policy.dispose();
      db.close();
    }
  }
});

test('cancelled native identity preparation publishes no partial snapshot', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-identity-cancel-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  const storage = openDatabase(join(root, 'policy.sqlite'), 'fictional');
  const authority = memoryRecordAuthority(db);
  const source = { id: 'fictional-original' };
  registerRawIntakeFixture(db, source.id, JSON.stringify({ intake: { version: 1 } }));
  await buildIntakeCollectionEnvelope(db, source);
  const signal = new AbortController();
  const policy = reviewIssueFactory(
    db,
    {
      sourceId: source.id,
      generation: 'fictional-generation',
      assertCurrent() {
        if (signal.signal.aborted) throw Error('Fictional operation cancelled');
      },
    },
    storage,
  );
  t.after(() => {
    policy.dispose();
    storage.close();
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const record = {
    id: 'fictional-record',
    candidateVersionId: 'fictional-candidate',
  } as IntakeReviewRecord;
  const selected = policy(record);
  for (let index = 0; index < 65; index++)
    selected.push({
      id: `fictional-issue-${index}`,
      kind: 'identity',
      prompt: `Fictional question ${index}`,
      textAnchor: `Fictional anchor ${index}`,
    } as IntakeReviewIssue);
  bindReviewRecordIssues(record, selected);
  const objects = authority.objects.size;
  await assert.rejects(
    prepareOwnershipIdentitySnapshots(db, db, {
      sources: [{ intakeId: source.id, recordId: record.id }],
      record() {
        return record;
      },
      factory() {
        void setImmediate().then(() => signal.abort());
        return createOwnershipSourceSnapshotPreparation(db, source, {
          assertRunning() {
            if (signal.signal.aborted) throw Error('Fictional operation cancelled');
          },
        });
      },
    }),
    /cancelled/,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM ownership_identity_snapshots').get()?.count,
    0,
  );
  assert.equal(authority.objects.size, objects);
});

test('inline issue change or cancellation after maintenance refuses the outward source snapshot', async (t) => {
  for (const change of ['nested', 'cancel'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-inline-terminal-'));
    const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
    const storage = openDatabase(join(root, 'policy.sqlite'), 'fictional');
    const signal = new AbortController();
    memoryRecordAuthority(db);
    const source = { id: 'fictional-original' };
    registerRawIntakeFixture(db, source.id, JSON.stringify({ intake: { version: 1 } }));
    await buildIntakeCollectionEnvelope(db, source);
    const policy = reviewIssueFactory(
      db,
      {
        sourceId: source.id,
        generation: 'fictional-generation',
        assertCurrent() {},
      },
      storage,
    );
    t.after(() => {
      policy.dispose();
      storage.close();
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const record = {
      id: 'fictional-record',
      candidateVersionId: 'fictional-candidate',
    } as IntakeReviewRecord;
    const selected = policy(record);
    selected.push({
      id: 'fictional-issue',
      kind: 'identity',
      prompt: 'Fictional question',
      resolution: { outcome: 'unknown' },
    } as IntakeReviewIssue);
    bindReviewRecordIssues(record, selected);
    inlineReviewRecordIssues(record, 128 * 1024);
    assert.equal(record.issuesReference, undefined);
    await assert.rejects(
      prepareOwnershipIdentitySnapshots(db, db, {
        sources: [{ intakeId: source.id, recordId: record.id }],
        record() {
          return record;
        },
        factory() {
          const factory = createOwnershipSourceSnapshotPreparation(db, source, {
            assertRunning() {
              if (signal.signal.aborted) throw Error('Fictional operation cancelled');
            },
          });
          return {
            ...factory,
            async finishMaintenance() {
              await factory.finishMaintenance();
              if (change === 'cancel') signal.abort();
              else record.issues![0]!.resolution!.outcome = 'other_person';
            },
          };
        },
      }),
      change === 'cancel' ? /cancelled/ : /policy changed/,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM ownership_identity_snapshots').get()?.count,
      0,
    );
  }
});

test('prepared identity sort preserves exact synchronous order, duplicates and closure', async () => {
  const record = {
    id: 'fictional-record',
    issues: [
      { id: 'a', kind: 'identity', prompt: 'Alpha', textAnchor: 'anchor' },
      { id: 'b', kind: 'identity', prompt: 'Alpha', textAnchor: 'anchor' },
      { id: 'c', kind: 'uncertain_reading', prompt: 'Skip', textAnchor: 'anchor' },
      { id: 'd', kind: 'identity', prompt: 'Unknown', resolution: { outcome: 'unknown' } },
      { id: 'e', kind: 'identity', prompt: 'No anchor' },
    ],
  } as IntakeReviewRecord;
  const sorted = await prepareOwnershipIdentityIssues(record, () => undefined);
  try {
    assert.deepEqual([...sorted.values()], [...ownershipIdentityIssues(record)]);
    assert.deepEqual([...sorted.values()], [...ownershipIdentityIssues(record)]);
  } finally {
    sorted.close();
  }
  assert.throws(() => [...sorted.values()], /Closed ownership identity sort/);
});

test('prepared sort rechecks policy lifetime and content during replay, including empty policy', async () => {
  for (const mode of ['empty-close', 'count-before', 'count-during', 'same-count'] as const) {
    const db = openDatabase(':memory:', 'fictional');
    const policy = reviewIssueFactory(db, {
      sourceId: 'fictional-original',
      generation: 'fictional-generation',
      assertCurrent() {},
    });
    const record = {
      id: 'fictional-record',
      candidateVersionId: 'fictional-candidate',
    } as IntakeReviewRecord;
    const selected = policy(record);
    if (mode !== 'empty-close')
      for (let index = 0; index < 4; index++)
        selected.push({
          id: `fictional-issue-${index}`,
          kind: 'identity',
          prompt: `Fictional question ${index}`,
          textAnchor: `Fictional anchor ${index}`,
        } as IntakeReviewIssue);
    bindReviewRecordIssues(record, selected);
    const sorted = await prepareOwnershipIdentityIssues(record, () => undefined);
    try {
      if (mode === 'empty-close') {
        policy.dispose();
        assert.throws(() => [...sorted.values()], /Closed issue policy scope/);
        assert.throws(() => sorted.assertSame(), /Closed issue policy scope/);
      } else {
        const cursor = sorted.values()[Symbol.iterator]();
        if (mode === 'count-during') assert.equal(cursor.next().done, false);
        if (mode === 'same-count') selected.at(0)!.prompt = 'Fictional revised question';
        else
          selected.push({
            id: 'fictional-late-issue',
            kind: 'identity',
            prompt: 'Fictional late question',
            textAnchor: 'Fictional late anchor',
          } as IntakeReviewIssue);
        assert.throws(() => cursor.next(), /policy changed/);
      }
    } finally {
      sorted.close();
      policy.dispose();
      db.close();
    }
  }
});

test('native private issue scratch refuses raw, schema and peer changes during prepared replay', async () => {
  for (const change of ['raw', 'restored', 'main-schema', 'temp-schema', 'peer'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-policy-witness-'));
    const db = openDatabase(':memory:', 'fictional');
    const storage = openDatabase(join(root, 'policy.sqlite'), 'fictional');
    storage.exec(
      "CREATE TABLE fictional_probe(value TEXT); INSERT INTO fictional_probe VALUES('before')",
    );
    const policy = reviewIssueFactory(
      db,
      {
        sourceId: 'fictional-original',
        generation: 'fictional-generation',
        assertCurrent() {},
      },
      storage,
    );
    try {
      const record = {
        id: 'fictional-record',
        candidateVersionId: 'fictional-candidate',
      } as IntakeReviewRecord;
      const selected = policy(record);
      selected.push({
        id: 'fictional-issue',
        kind: 'identity',
        prompt: 'Fictional question',
        textAnchor: 'Fictional anchor',
      } as IntakeReviewIssue);
      bindReviewRecordIssues(record, selected);
      const sorted = await prepareOwnershipIdentityIssues(record, () => undefined);
      try {
        if (change === 'raw' || change === 'restored') {
          const original = String(
            storage.prepare('SELECT value FROM intake_review_issue_policy_v2 WHERE ordinal=0').get()
              ?.value,
          );
          storage
            .prepare('UPDATE intake_review_issue_policy_v2 SET value=? WHERE ordinal=0')
            .run(original.replace('Fictional question', 'Altered question'));
          if (change === 'restored')
            storage
              .prepare('UPDATE intake_review_issue_policy_v2 SET value=? WHERE ordinal=0')
              .run(original);
        } else if (change === 'main-schema') {
          storage.exec('CREATE TABLE fictional_extra(value TEXT)');
        } else if (change === 'temp-schema') {
          storage.exec('CREATE TEMP TABLE fictional_extra(value TEXT)');
        } else {
          const peer = openDatabase(join(root, 'policy.sqlite'), 'fictional');
          try {
            peer.exec("UPDATE fictional_probe SET value='after'");
          } finally {
            peer.close();
          }
        }
        assert.throws(() => [...sorted.distinctValues()], /policy changed/);
      } finally {
        sorted.close();
      }
    } finally {
      policy.dispose();
      storage.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('native distinct replay seeks past duplicate hashes without a synchronous duplicate drain', async () => {
  const record = {
    id: 'fictional-record',
    issues: Array.from({ length: 65 }, (_, index) => ({
      id: `fictional-issue-${index}`,
      kind: 'identity',
      prompt: 'Fictional same question',
      textAnchor: 'Fictional same anchor',
    })),
  } as IntakeReviewRecord;
  let checks = 0;
  const sorted = await prepareOwnershipIdentityIssues(record, () => {
    checks++;
  });
  try {
    assert.equal([...sorted.values()].length, 65);
    const before = checks;
    const cursor = sorted.distinctValues()[Symbol.iterator]();
    assert.equal(cursor.next().done, false);
    assert.equal(cursor.next().done, true);
    assert.ok(checks - before <= 8, `duplicate replay used ${checks - before} checks`);
  } finally {
    sorted.close();
  }
});

test('inlined issue terminal check detects nested and structural changes without changing array behavior', async () => {
  for (const change of ['nested', 'replace', 'reorder', 'array', 'restored'] as const) {
    const db = openDatabase(':memory:', 'fictional');
    const policy = reviewIssueFactory(db, {
      sourceId: 'fictional-original',
      generation: 'fictional-generation',
      assertCurrent() {},
    });
    try {
      const record = {
        id: 'fictional-record',
        candidateVersionId: 'fictional-candidate',
      } as IntakeReviewRecord;
      const selected = policy(record);
      for (let index = 0; index < 4; index++)
        selected.push({
          id: `fictional-issue-${index}`,
          kind: 'identity',
          prompt: `Fictional question ${index}`,
          resolution: { outcome: 'unknown' },
        } as IntakeReviewIssue);
      bindReviewRecordIssues(record, selected);
      const before = JSON.stringify([...selected]);
      inlineReviewRecordIssues(record, 128 * 1024);
      assert.equal(record.issuesReference, undefined);
      assert.equal(JSON.stringify(record.issues), before);
      const sorted = await prepareOwnershipIdentityIssues(record, () => undefined);
      try {
        if (change === 'nested' || change === 'restored') {
          record.issues![0]!.resolution!.outcome = 'other_person';
          if (change === 'restored') record.issues![0]!.resolution!.outcome = 'unknown';
        } else if (change === 'replace') {
          record.issues![0] = { ...record.issues![0]!, prompt: 'Replaced question' };
        } else if (change === 'reorder') {
          record.issues!.reverse();
        } else {
          record.issues = [...record.issues!];
        }
        if (change === 'restored') sorted.assertSame();
        else assert.throws(() => sorted.assertSame(), /policy changed/);
      } finally {
        sorted.close();
      }
    } finally {
      policy.dispose();
      db.close();
    }
  }
});

test('absent issue fields remain a valid empty identity policy', async () => {
  const record = { id: 'fictional-record' } as IntakeReviewRecord;
  const sorted = await prepareOwnershipIdentityIssues(record, () => undefined);
  try {
    assert.deepEqual([...sorted.distinctValues()], []);
    await sorted.assertSame();
  } finally {
    sorted.close();
  }
});
