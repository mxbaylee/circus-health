import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { openDatabase, transaction } from '../database.ts';
import { attachRecordDurability } from '../record-versions.ts';
import { openVault } from '../vault-store.ts';
import { freshKey } from '../vault-crypto.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { prepareIntakeFilenameSummary } from '../intake-summary-name.ts';
import { parseSchemaControl } from '../intake-envelope-schema.ts';
import {
  encodeIntakeReferencedEnvelope,
  INTAKE_REFERENCED_ENVELOPE_FORMAT,
} from '../intake-compact-envelope.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import {
  clearIntakeSourceFieldSessions,
  readIntakeSourceFieldFragment,
} from '../intake-source-field-session.ts';
import type { IntakeSourceFieldReferenceV1 } from '../../shared/intake-summary.ts';

test('accepted source field route holds only an authorized sequential read session', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-field-route-'));
  const profileId = 'fictional-field-route';
  const intakeId = 'fictional-field-route-intake';
  const paths = ensureProfileDirectories(root, profileId);
  const key = freshKey();
  const vault = openVault({ directory: paths.root, profileId, key, initialize: true });
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    clearIntakeSourceFieldSessions(db);
    if (db.isOpen) db.close();
    vault.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  attachRecordDurability(db, { profileId, storage: vault.recordStorage() });
  const original = Buffer.from('Independently fictional field route.');
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const path = profilePaths(root, profileId).relativeRoot + '/sources/field.txt';
  const mime = 'fictional/example';
  const identity = { profileId, intakeId, sourceHash };
  writeFileSync(join(root, path), original);
  vault.storeFile(path, original);
  vault.publish();
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: 'fictional-field.txt',
      state: 'ready',
      createdAt: '2026-01-02T03:04:05.000Z',
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      intakeId,
      path,
      sourceHash,
      original.length,
      'intake_original',
      mime,
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, { id: intakeId, sha256: sourceHash });
  await prepareIntakeFilenameSummary(db, { id: intakeId, sha256: sourceHash });
  const collections = selectedEnvelopeStore(db, { id: intakeId, sha256: sourceHash }).collections;
  const binding = collections.binding(collections.openView());
  assert.ok(binding?.logical.root);
  const mode = parseSchemaControl(
    collections.get(collections.openView(), 'logical', 'envelope.control', 'representation'),
  ).mode;
  const descriptor = encodeIntakeReferencedEnvelope({
    intakeAuthority: {
      format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
      identity,
      mode,
      storageSequence: binding.storageSequence,
      logicalRoot: binding.logical.root,
      sourceLabel: { kind: 'missing' },
    },
  });
  transaction(db, () => {
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(descriptor, intakeId);
    db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(
      intakeNamespace(identity) + 'head',
    );
  });
  const sourceVersionId = String(
    db
      .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
      .get('source_files', JSON.stringify([intakeId]))!.version_id,
  );
  const reference: IntakeSourceFieldReferenceV1 = {
    format: 'health-intake-source-field-reference-v1',
    intakeId,
    sourceHash,
    sourceVersionId,
    field: 'mimeType',
    bytes: Buffer.byteLength(mime),
    scalarHash: createHash('sha256').update(mime).digest('hex'),
  };
  const fragment = async (
    cursor?: string,
    cookie = 'circus-session=fictional-reader',
    supplied = reference,
    release = false,
  ) => {
    let result:
      | { text: string; complete: boolean; nextCursor: string | null; reference: unknown }
      | undefined;
    assert.equal(
      await handleIntakeRoute({
        resource: 'intakes',
        id: intakeId,
        action: 'source-field-fragment',
        method: 'POST',
        params: new URLSearchParams(),
        req: Object.assign(new IncomingMessage(new Socket()), {
          headers: { 'content-type': 'application/json', cookie },
        }),
        db,
        root,
        profileId,
        respond: (value) => {
          result = value as typeof result;
        },
        list: () => assert.fail('unexpected list'),
        body: async () =>
          Buffer.from(
            JSON.stringify({
              reference: supplied,
              cursor,
              bytes: 4,
              ...(release ? { release } : {}),
            }),
          ),
        assistant: {} as never,
      }),
      true,
    );
    assert.ok(result);
    return result;
  };
  const first = await fragment();
  assert.equal(first.text, 'fict');
  assert.ok(first.nextCursor);
  await assert.rejects(fragment(first.nextCursor, 'circus-session=other-reader'), {
    code: 'INTAKE_SOURCE_FIELD_CHANGED',
  });
  await assert.rejects(fragment(first.nextCursor, undefined, { ...reference, bytes: 1 }), {
    code: 'INTAKE_SOURCE_FIELD_CHANGED',
  });
  const pages = [first.text];
  let cursor: string | null = first.nextCursor;
  while (cursor) {
    const page = await fragment(cursor);
    pages.push(page.text);
    cursor = page.nextCursor;
  }
  assert.equal(pages.join(''), mime);
  await assert.rejects(fragment(first.nextCursor), { code: 'INTAKE_SOURCE_FIELD_CHANGED' });
  const abandoned = await fragment();
  assert.ok(abandoned.nextCursor);
  await assert.rejects(
    fragment(abandoned.nextCursor, 'circus-session=other-reader', reference, true),
    { code: 'INTAKE_SOURCE_FIELD_CHANGED' },
  );
  await assert.rejects(
    fragment(
      abandoned.nextCursor,
      'circus-session=fictional-reader',
      { ...reference, bytes: 1 },
      true,
    ),
    { code: 'INTAKE_SOURCE_FIELD_CHANGED' },
  );
  await assert.rejects(
    fragment(
      abandoned.nextCursor.replace(/\.[0-9]+$/, '.999'),
      'circus-session=fictional-reader',
      reference,
      true,
    ),
    { code: 'INTAKE_SOURCE_FIELD_CHANGED' },
  );
  const released = await fragment(
    abandoned.nextCursor,
    'circus-session=fictional-reader',
    reference,
    true,
  );
  assert.equal(released.complete, true);
  assert.equal(released.text, '');
  await assert.rejects(fragment(abandoned.nextCursor), { code: 'INTAKE_SOURCE_FIELD_CHANGED' });

  const input = { reference, bytes: 4 };
  const nested: Promise<unknown>[] = [];
  let checks = 0;
  let cancelled = false;
  const opening = readIntakeSourceFieldFragment(
    db,
    profileId,
    intakeId,
    'fictional-cap-parent',
    input,
    () => {
      if (++checks === 2)
        for (let index = 0; index < 4; index++)
          nested.push(
            readIntakeSourceFieldFragment(
              db,
              profileId,
              intakeId,
              `fictional-cap-child-${index}`,
              input,
              () => {
                if (cancelled) throw Error('Fictional request stopped');
              },
            ),
          );
      if (cancelled) throw Error('Fictional request stopped');
    },
  );
  assert.equal(nested.length, 4);
  const openingSettled = Promise.allSettled([opening, ...nested.slice(0, 3)]);
  await assert.rejects(nested[3]!, { code: 'INTAKE_SOURCE_FIELD_BUSY' });
  cancelled = true;
  await openingSettled;
  clearIntakeSourceFieldSessions(db);

  let clearChecks = 0;
  await assert.rejects(
    readIntakeSourceFieldFragment(db, profileId, intakeId, 'fictional-clear-opening', input, () => {
      if (++clearChecks === 2) clearIntakeSourceFieldSessions(db);
    }),
    { code: 'INTAKE_SOURCE_FIELD_CHANGED' },
  );
  assert.ok(clearChecks >= 2);
});
