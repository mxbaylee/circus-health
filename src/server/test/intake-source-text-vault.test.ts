import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { uploadIntake } from '../intake.ts';
import {
  getIntakeSourceText,
  publishIntakeSourceText,
  reviewIntakeSourceText,
  getIntakeSourceTextReviewHistory,
} from '../intake-source-text.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';
import type { SourceTextEvidence } from '../../shared/intake-source-text.ts';
const marker = 'FICTIONAL-TRANSCRIPTION-UNIQUE-ENCRYPTED-ONLY-4917';
function hasLiteral(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory()
    ? readdirSync(path).some((n) => hasLiteral(resolve(path, n)))
    : stat.isFile() && readFileSync(path).includes(Buffer.from(marker));
}
const evidence: SourceTextEvidence = {
  adapter: { name: 'fictional-text', version: '1' },
  pages: [{ page: 1, disposition: 'extracted', inspected: false }],
  spans: [{ id: 'one', text: marker, region: { page: 1 }, provenance: 'native' }],
  relations: [],
  issues: [
    {
      id: 'coverage',
      region: { page: 1 },
      kind: 'coverage',
      detail: 'Inspect the retained source',
      status: 'open',
    },
  ],
};

test('encrypted source text, human corrections and copied profile provenance survive cache deletion', async (t) => {
  const { manager } = vaultFixture(t),
    created = await newProfile(manager, 'Fictional source-text owner');
  const id = created.profile.id,
    state = manager.opened.get(id)!;
  const intake = uploadIntake(state.db, state.root, id, {
    filename: 'fictional-source.txt',
    newProviderName: 'Fictional source',
    bytes: Buffer.from(marker),
  });
  const first = publishIntakeSourceText(state.db, state.root, id, intake.id, {
    operationId: randomUUID(),
    expectedRevisionId: null,
    sourceHash: intake.sha256,
    evidence,
  });
  assert.ok(first.revision);
  const corrected = reviewIntakeSourceText(
    state.db,
    state.root,
    id,
    intake.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: first.revision.id,
      sourceHash: intake.sha256,
      action: 'correct',
      scope: { page: 1 },
      spans: [{ ...first.revision.spans[0], text: marker + ' Fictional correction.' }],
    },
    'authenticated-owner',
  );
  assert.ok(corrected.revision);
  assert.equal(
    hasLiteral(manager.pathFor(id)),
    false,
    'authoritative objects and cache remain encrypted',
  );
  const copy = manager.begin({ name: 'Fictional copied-source owner', copyFrom: id });
  await manager.verify(copy.setupId, { acknowledged: true, recovery: copy.recoveryKit });
  let copied = manager.opened.get(copy.profileId)!;
  const copiedText = getIntakeSourceText(copied.db, copied.root, copy.profileId, intake.id);
  assert.ok(copiedText.revision);
  assert.equal(copiedText.revision.profileId, copy.profileId);
  assert.equal(copiedText.revision.copiedFrom?.profileId, id);
  assert.deepEqual(copiedText.revision.spans, corrected.revision.spans);
  assert.equal(
    getIntakeSourceText(state.db, state.root, id, intake.id).revision?.profileId,
    id,
    'copy never rewrites source profile history',
  );
  manager.lock(copy.profileId);
  rmSync(resolve(manager.pathFor(copy.profileId), 'cache'), { recursive: true, force: true });
  manager.unlock(copy.profileId, copy.recoveryKit);
  copied = manager.opened.get(copy.profileId)!;
  assert.deepEqual(
    getIntakeSourceText(copied.db, copied.root, copy.profileId, intake.id),
    copiedText,
  );
  assert.equal(
    getIntakeSourceTextReviewHistory(copied.db, copied.root, copy.profileId, intake.id).entries
      .length,
    2,
  );
  manager.lock(id);
  rmSync(resolve(manager.pathFor(id), 'cache'), { recursive: true, force: true });
  manager.unlock(id, created.recoveryKit);
  const restored = manager.opened.get(id)!;
  assert.deepEqual(getIntakeSourceText(restored.db, restored.root, id, intake.id), corrected);
});
