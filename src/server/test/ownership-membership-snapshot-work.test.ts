import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clinicalReviewRevision, openDatabase } from '../database.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { prepareOwnershipIdentityIssueSnapshot } from '../ownership-identity-snapshots.ts';
import {
  createOwnershipSourceSnapshotPreparation,
  readOwnershipSourceSnapshot,
  type OwnershipSourceSnapshotReference,
} from '../ownership-source-snapshots.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

interface SnapshotWork {
  selected: OwnershipSourceSnapshotReference;
  compared: number;
  changed: number;
  batches: number;
  bytes: number;
}

for (const count of [4, 64])
  test(`identity membership omits unused empty split publication for ${count} members`, async (t) => {
    const measured: Array<[SnapshotWork, SnapshotWork]> = [];
    for (const split of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), 'fictional-membership-work-')),
        db = openDatabase(join(root, 'cache.sqlite'), 'fictional'),
        authority = memoryRecordAuthority(db),
        source = { id: 'fictional-original' };
      t.after(() => {
        clearIntakeStateCache(db);
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      registerRawIntakeFixture(db, source.id, JSON.stringify({ intake: { version: 1 } }));
      await buildIntakeCollectionEnvelope(db, source);
      const values = Array.from(
          { length: count },
          (_, i) => `fictional-${String(i).padStart(4, '0')}`,
        ),
        revision = clinicalReviewRevision(db),
        version = intakeSourceVersion(db, source.id).version;
      const publish = async (ids: string[], previous?: OwnershipSourceSnapshotReference) => {
        const before = intakeWorkCounters(db),
          objects = new Set(authority.objects.keys()),
          factory = createOwnershipSourceSnapshotPreparation(db, source);
        let selected: OwnershipSourceSnapshotReference;
        if (split) {
          selected = (
            await factory.prepareSplit({
              previous,
              sourceRecordIds: () => ids,
              movingSourceRecordIds: () => [],
            })
          ).remaining;
          await factory.finishMaintenance();
        } else {
          selected = (
            await prepareOwnershipIdentityIssueSnapshot(
              factory,
              () => ids,
              previous && { format: 'health-ownership-identity-issues-v1', snapshot: previous },
            )
          ).snapshot;
        }
        const after = intakeWorkCounters(db);
        const delta = (key: 'ownershipSnapshotComparedIds' | 'ownershipSnapshotChangedIds') =>
          after.warm[key] +
          after.reconstruction[key] -
          before.warm[key] -
          before.reconstruction[key];
        return {
          selected,
          compared: delta('ownershipSnapshotComparedIds'),
          changed: delta('ownershipSnapshotChangedIds'),
          batches:
            after.warm.reportSnapshotCheckpointBatches -
            before.warm.reportSnapshotCheckpointBatches,
          bytes: [...authority.objects]
            .filter(([id]) => !objects.has(id))
            .reduce((sum, [, bytes]) => sum + bytes.length, 0),
        };
      };
      const first = await publish(values),
        changed = [...values.slice(1), 'fictional-new'],
        second = await publish(changed, first.selected);
      assert.equal(clinicalReviewRevision(db), revision);
      assert.equal(intakeSourceVersion(db, source.id).version, version);
      clearIntakeStateCache(db);
      const read = (reference: OwnershipSourceSnapshotReference) => {
        const ids: string[] = [];
        let after: string | undefined;
        do {
          const page = readOwnershipSourceSnapshot(db, reference, { after, limit: 7 });
          ids.push(...page.sourceRecordIds);
          if (page.complete) return ids;
          assert.ok(page.after && page.after !== after);
          after = page.after;
        } while (true);
      };
      assert.deepEqual(read(first.selected), values);
      assert.deepEqual(read(second.selected), changed);
      measured.push([first, second]);
    }
    for (const index of [0, 1]) {
      const before = measured[0]![index]!,
        after = measured[1]![index]!;
      assert.equal(after.compared, before.compared, 'complete membership comparison is unchanged');
      assert.equal(after.changed, before.changed, 'the same membership edits remain');
      assert.equal(after.selected.digest, before.selected.digest);
      assert.ok(after.batches < before.batches, 'the unused empty snapshot needs no checkpoints');
      assert.ok(after.bytes < before.bytes, 'accepted bytes exclude the unused empty snapshot');
      t.diagnostic(
        JSON.stringify({
          count,
          change: index,
          compared: after.compared,
          changed: after.changed,
          batches: [before.batches, after.batches],
          bytes: [before.bytes, after.bytes],
        }),
      );
    }
  });
