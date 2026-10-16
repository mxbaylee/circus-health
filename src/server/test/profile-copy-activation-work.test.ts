import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
import { createNote } from '../notes.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import type { Database } from '../database.ts';

// Counted work, not timing: activation of a published contributor copy attaches
// the target, which itself checks the indexed cache baseline and the selected
// authority by complete reconstruction. A second identical selected comparison
// adds one more complete reconstruction without strengthening the proof.
test('published copy activation reconstructs selected authority once per independent proof', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-activation-')),
    databases = new Map<string, Database>(),
    counters = createRecordVersionWorkCounters(),
    marks = new Map<string, number>(),
    lifecycle = createProfileLifecycle({
      root,
      databases,
      copyCheckpoint: (stage) => {
        marks.set(stage, counters.reconstruction.ancestryReferencesSpooled);
      },
    });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const profile = await lifecycle.create({
    name: 'Fictional activation source',
    fullName: 'Fictional activation source',
    birthDate: '1979-03-14',
  });
  for (let index = 0; index < 3; index++)
    createNote(databases.get(profile.id)!, {
      kind: 'person',
      title: `Fictional activation person ${index}`,
      person: { fullName: `Fictional activation person ${index}` },
    });
  const input = { name: 'Fictional activation copy', operationId: randomUUID() };
  const target = await withRecordVersionWork(counters, () => lifecycle.create(input, profile.id));
  const published = marks.get('published'),
    registered = marks.get('registered');
  assert.ok(published !== undefined && registered !== undefined);
  const copy = databases.get(target.id)!,
    commits = Number(copy.prepare('SELECT count(*) AS n FROM __record_transactions').get()!.n);
  assert.ok(commits > 0);
  // Exactly the indexed-baseline and selected-HEAD reconstructions, each one
  // complete spool of the published commit ancestry (previously three).
  assert.equal(registered - published, 2 * commits);
  assert.equal(
    copy.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()!.value,
    target.id,
  );
  // Retrying the completed operation reuses the active target without new proofs.
  const before = counters.reconstruction.ancestryReferencesSpooled;
  assert.equal(
    (await withRecordVersionWork(counters, () => lifecycle.create(input, profile.id))).id,
    target.id,
  );
  assert.equal(counters.reconstruction.ancestryReferencesSpooled, before);
});
