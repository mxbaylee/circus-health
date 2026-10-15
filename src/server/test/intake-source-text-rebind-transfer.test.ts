import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { currentTransactionToken, transaction } from '../database.ts';
import {
  createIntakeCopyIncrementalReader,
  createIntakeCopyIncrementalReaderFromStandalone,
} from '../intake-copy-incremental-reader.ts';
import { createIntakeCopyTransfer } from '../intake-copy-transfer.ts';
import {
  prepareCopiedIntakeSourceTextTransferSync,
  validatePortableIntakeSourceTextDatabase,
} from '../intake-source-text.ts';

const profileId = 'fictional-source-text-owner';
const targetId = 'fictional-source-text-copy';
const intakeId = 'fictional-source-text-intake';
const sourceHash = 'a'.repeat(64);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (name: string) => `intake_source_text:v1:${intakeId}:${name}`;

test('source-text copy rebind streams exact validated revisions into one sealed target transaction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-source-text-rebind-'));
  const db = new DatabaseSync(join(directory, 'copy.sqlite'));
  const transfer = createIntakeCopyTransfer(() => {});
  try {
    db.exec(
      'CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE source_files(id TEXT PRIMARY KEY,kind TEXT NOT NULL,sha256 TEXT NOT NULL,details_json TEXT);',
    );
    const put = db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
    put.run('owner_profile_id', profileId);
    db.prepare('INSERT INTO source_files VALUES(?,?,?,?)').run(
      intakeId,
      'intake_original',
      sourceHash,
      '{}',
    );
    const blob = (value: unknown) => {
      const ref = hash(value);
      put.run(key(`blob:${ref}`), JSON.stringify(value));
      return ref;
    };
    const relationRef = blob([]);
    const pageRef = blob({
      page: { page: 1, disposition: 'extracted', inspected: true },
      spans: [
        {
          id: 'span-1',
          text: 'Fictional Ω source passage. '.repeat(3000),
          region: { page: 1 },
          provenance: 'native',
        },
      ],
      issues: [],
    });
    const revisionId = randomUUID();
    const value = {
      header: {
        format: 'intake-source-text-v1',
        id: revisionId,
        parentRevisionId: null,
        profileId,
        intakeId,
        sourceHash,
        createdAt: '2026-01-12T00:00:00.000Z',
        adapter: { name: 'fictional', version: '1' },
        review: null,
        protectedPages: [],
      },
      pageRefs: [pageRef],
      relationRef,
    };
    const revisionKey = key(`revision:${revisionId}`);
    const original = JSON.stringify({ value, sha256: hash(value) });
    put.run(revisionKey, original);
    put.run(key('head'), JSON.stringify({ revisionId, sourceHash }));

    const asyncReader = await createIntakeCopyIncrementalReader(db, () => {});
    try {
      let progress = 0;
      await asyncReader.validateSourceTextInWorker(profileId, undefined, () => progress++);
      assert.ok(progress > 0);
      const early = new AbortController();
      const earlyReader = await createIntakeCopyIncrementalReader(db, () =>
        early.signal.throwIfAborted(),
      );
      try {
        const pending = earlyReader.validateSourceTextInWorker(profileId, early.signal);
        early.abort(Error('fictional pre-ready cancellation'));
        await assert.rejects(pending, /fictional pre-ready cancellation/);
      } finally {
        earlyReader.close();
      }
      const controller = new AbortController();
      await assert.rejects(
        asyncReader.validateSourceTextInWorker(profileId, controller.signal, () => {
          controller.abort(Error('fictional copy cancellation'));
        }),
        /fictional copy cancellation/,
      );
    } finally {
      asyncReader.close();
    }

    prepareCopiedIntakeSourceTextTransferSync(db, profileId, targetId, transfer, () => {});
    assert.ok(transfer.work().chunks > 1);
    assert.ok(transfer.work().maxChunk <= 16 * 1024);
    transfer.seal();
    assert.equal(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(revisionKey)!.value,
      original,
    );
    transaction(db, () => {
      db.prepare("UPDATE app_meta SET value=? WHERE key='owner_profile_id'").run(targetId);
      transfer.withTarget(db, currentTransactionToken(db)!, (target) => target.applyRevisions());
    });
    transfer.assertReleased();
    const expectedValue = {
      ...value,
      header: {
        ...value.header,
        profileId: targetId,
        copiedFrom: { profileId, revisionId },
      },
    };
    assert.equal(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(revisionKey)!.value,
      JSON.stringify({ value: expectedValue, sha256: hash(expectedValue) }),
    );
    const rebound = createIntakeCopyIncrementalReaderFromStandalone(db, () => {});
    try {
      validatePortableIntakeSourceTextDatabase(rebound, targetId);
    } finally {
      rebound.close();
    }
    assert.equal(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(key(`blob:${pageRef}`))!.value,
      JSON.stringify({
        page: { page: 1, disposition: 'extracted', inspected: true },
        spans: [
          {
            id: 'span-1',
            text: 'Fictional Ω source passage. '.repeat(3000),
            region: { page: 1 },
            provenance: 'native',
          },
        ],
        issues: [],
      }),
    );
  } finally {
    transfer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source-text copy with no revisions does not scan unrelated retained rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-empty-source-text-rebind-'));
  const db = new DatabaseSync(join(directory, 'copy.sqlite'));
  const transfer = createIntakeCopyTransfer(() => {});
  try {
    db.exec('CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run('owner_profile_id', profileId);
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run('unrelated', 'x'.repeat(100_000));
    prepareCopiedIntakeSourceTextTransferSync(db, profileId, targetId, transfer, () => {});
    assert.equal(transfer.work().values, 0);
    assert.equal(transfer.work().bytes, 0);
  } finally {
    transfer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
