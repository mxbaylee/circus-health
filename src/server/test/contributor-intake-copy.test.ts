import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import {
  createProfileLifecycle,
  type CreateProfileLifecycleOptions,
} from '../profile-lifecycle.ts';
import { profilePaths } from '../profile-storage.ts';
import { exportCuration, rebuildProfile, attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { getIntakePeopleQueue, applyIntakePerson } from '../intake-people.ts';
import { createNote, getNote, saveNote } from '../notes.ts';
import { readProfileRegistry } from '../profile-registry.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { getIntakeSourceText } from '../intake-source-text.ts';
import { readIntakeSourcePin, writeIntakeSourcePin } from '../intake-source-pin.ts';
import { storedIntakeDetails, intakeDetails, registerIntakeFile } from '../intake-state-access.ts';
import { readIntakeEnvelopeText, stageIntakeEnvelope } from '../intake-authority.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import { normalizeIntakeJson, serializeIntakeJson } from '../intake-state-codec.ts';
import { digest } from '../intake-state-evidence.ts';

const intakeId = 'fictional-contributor-intake';
const publicOperation = 'fictional-public-acceptance-operation';
const copiedName = 'Fictional independent playground';
function rows(db: Database, table: string) {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}
function retainedFiles(root: string, id: string) {
  const base = profilePaths(root, id).root;
  const found = new Map<string, string>();
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'db') visit(child);
      } else found.set(relative(base, child), digest(readFileSync(child)));
    }
  }
  visit(base);
  return found;
}
function selected(db: Database, id: string, sourceHash: string) {
  return createIntakeStateStorage(db, { profileId: id, intakeId, sourceHash }).readSerialized();
}
async function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'contributor-intake-copy-'));
  const databases = new Map<string, Database>();
  const opened: Database[] = [];
  const actions = createProfileLifecycle({ root, databases });
  t.after(() => {
    for (const db of [...databases.values(), ...opened]) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await actions.create({
    name: 'Fictional source owner',
    fullName: 'Fictional source owner',
    birthDate: '1982-04-17',
  });
  const db = databases.get(source.id)!;
  const bytes = Buffer.from('Independently fictional original. Decimal 10.00. Ω 😀\n');
  const sourceHash = digest(bytes);
  const unrelatedBytes = Buffer.from('Independently fictional unrelated provider payload.');
  writeFileSync(resolve(profilePaths(root, source.id).sources, 'unrelated.txt'), unrelatedBytes);
  const { raw, current, corrected } = transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      'fictional-unrelated-source',
      `data/profiles/${source.id}/sources/unrelated.txt`,
      digest(unrelatedBytes),
      unrelatedBytes.length,
      'source',
      ' {"providerOriginal" : "fictional"} ',
    );
    const path = `data/profiles/${source.id}/sources/fictional.txt`;
    writeFileSync(resolve(root, path), bytes);
    const intake = {
      originalName: 'fictional.txt',
      createdAt: '2026-01-12T00:00:00.000Z',
      version: 7,
      state: 'pending',
      validation: {},
      proposals: [
        { id: 'proposal-pending', fileId: intakeId, summary: 'Fictional pending proposal' },
      ],
      acceptedProposalId: null,
      imported: null,
      workflow: {
        format: 'health-intake-workflow-v1',
        questions: [
          { id: 'question-pending', question: 'Fictional unresolved question?', answer: null },
        ],
        candidates: [
          { id: 'candidate-pending', versionId: 'candidate-version', recordId: 'record-pending' },
        ],
        plans: [
          {
            id: 'plan-pending',
            units: [{ id: 'unit-pending', locator: 'Fictional page 1', status: 'pending' }],
          },
        ],
        decisions: [
          {
            id: 'decision-prior',
            candidateId: 'candidate-prior',
            candidateVersionId: 'version-prior',
            recordId: 'record-prior',
            action: 'accept',
            mapping: { valueText: '10.00' },
            scope: 'record',
            at: '2026-01-11T00:00:00.000Z',
          },
        ],
        reviewDrafts: [
          {
            id: 'draft-pending',
            proposalId: 'proposal-pending',
            recordId: 'record-pending',
            candidateId: 'candidate-pending',
            candidateVersionId: 'candidate-version',
            disposition: 'review_later',
            mapping: { valueText: '12.00' },
            at: '2026-01-12T00:00:00.000Z',
          },
        ],
        reportAcceptances: [
          {
            fingerprint: 'fictional-public-fingerprint',
            receipt: {
              version: 1,
              operationId: publicOperation,
              status: 'completed',
              at: '2026-01-11T00:00:00.000Z',
              receipts: [{ id: 'public-receipt', recordId: 'record-prior' }],
            },
          },
        ],
      },
      unknownFuture: { second: 'Fictional nested text Ω', first: null },
    };
    const raw = ` { "before" : {"escaped":"\\u03A9","duplicate":1,"duplicate":2}, "intake" : ${JSON.stringify(intake)}, "after" : "fictional" }\n`;
    registerIntakeFile(db, {
      id: intakeId,
      providerId: null,
      batchId: null,
      path,
      bytes,
      mimeType: 'text/plain',
      kind: 'intake_original',
      coverage: 'unknown',
      details: raw,
    });
    const revisionId = randomUUID();
    const priorId = randomUUID();
    const blob = (value: unknown) => {
      const raw = JSON.stringify(value);
      const hash = digest(raw);
      db.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)').run(
        `intake_source_text:v1:${intakeId}:blob:${hash}`,
        raw,
      );
      return hash;
    };
    const relationRef = blob([]);
    for (const [id, parentRevisionId, human] of [
      [priorId, null, false],
      [revisionId, priorId, true],
    ] as const) {
      const header = {
        format: 'intake-source-text-v1',
        id,
        parentRevisionId,
        profileId: source.id,
        intakeId,
        sourceHash,
        createdAt: '2026-01-12T00:00:00.000Z',
        adapter: { name: 'fictional-contributor-text', version: '1' },
        review: human
          ? {
              operationId: randomUUID(),
              expectedRevisionId: priorId,
              action: 'correct',
              scope: { page: 1 },
              actor: 'fictional-authenticated-owner',
              at: '2026-01-12T00:00:00.000Z',
            }
          : null,
        protectedPages: human ? [1] : [],
      };
      const pageRef = blob({
        page: { page: 1, disposition: 'extracted', inspected: human },
        spans: [
          {
            id: 'fictional-span',
            text: human
              ? 'Fictional human corrected value 10.00.'
              : 'Fictional extracted value 10.00.',
            region: { page: 1 },
            provenance: human ? 'human' : 'native',
          },
        ],
        issues: [],
      });
      const value = { header, pageRefs: [pageRef], relationRef };
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
        `intake_source_text:v1:${intakeId}:revision:${id}`,
        JSON.stringify({ value, sha256: digest(JSON.stringify(value)) }),
      );
    }
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
      `intake_source_text:v1:${intakeId}:head`,
      JSON.stringify({ revisionId, sourceHash }),
    );
    writeIntakeSourcePin(db, intakeId, {
      revisionId,
      dependencyToken: 'fictional-material-token',
      requiresInterpretation: true,
      version: 3,
    });
    const corrected = getIntakeSourceText(db, root, source.id, intakeId);
    const initial = normalizeIntakeJson(JSON.parse(raw));
    const reordered = normalizeIntakeJson({
      after: initial.after,
      intake: initial.intake,
      before: initial.before,
    });
    const current = normalizeIntakeJson({
      ...reordered,
      intake: {
        ...(reordered.intake as Record<string, unknown>),
        unknownFuture: { first: null, second: 'Fictional exact nested changed text Ω 😀' },
      },
    });
    for (const value of [initial, reordered, current])
      stageIntakeEnvelope(db, { id: intakeId }, value);
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
      'unrelated-fictional-metadata',
      '{"b":2,"a":1}',
    );
    db.exec(
      "INSERT INTO providers(id,name) VALUES('fictional-clinic','Fictional Clinic'); INSERT INTO test_types(id,label) VALUES('fictional-type','Fictional accepted reach')",
    );
    db.prepare('INSERT INTO source_records(id,source_file_id,raw_json) VALUES(?,?,?)').run(
      'fictional-accepted-source',
      intakeId,
      '{"literal":"10.00"}',
    );
    db.prepare(
      'INSERT INTO observations(id,test_type_id,source_record_id,label,value_text,value_numeric,unit) VALUES(?,?,?,?,?,?,?)',
    ).run(
      'fictional-observation',
      'fictional-type',
      'fictional-accepted-source',
      'Fictional accepted reach',
      '10.00',
      10,
      'cm',
    );
    return { raw, current, corrected };
  });
  exportCuration(db, root, source.id);
  const sourceFiles = retainedFiles(root, source.id);
  const sourceRows = Object.fromEntries(
    ['app_meta', 'source_files', 'source_records', 'observations'].map((table) => [
      table,
      rows(db, table),
    ]),
  );
  const reopen = (id: string, rebuild = false) => {
    databases.get(id)?.close();
    databases.delete(id);
    const paths = profilePaths(root, id);
    if (rebuild) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(paths.database + suffix, { force: true });
      const rebuilt = rebuildProfile(root, id, resolve(root, 'fictional-rebuild-' + randomUUID()));
      cpSync(rebuilt.database, paths.database);
    }
    const next = openDatabase(paths.database, id);
    attachPersonalDurability(next, { root, profileId: id });
    databases.set(id, next);
    opened.push(next);
    return next;
  };
  return {
    root,
    databases,
    actions,
    source,
    db,
    bytes,
    sourceHash,
    raw,
    current,
    corrected,
    sourceFiles,
    sourceRows,
    reopen,
  };
}
function verify(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const db = f.databases.get(id)!;
  assert.equal(selected(db, id, f.sourceHash), serializeIntakeJson(f.current));
  const file = db.prepare('SELECT * FROM source_files WHERE id=?').get(intakeId)!;
  assert.equal(
    readIntakeEnvelopeText(db, { id: intakeId }),
    serializeIntakeJson(f.current),
    'the selected full envelope retains outer member order and exact normalized content',
  );
  const unrelated = db
    .prepare('SELECT * FROM source_files WHERE id=?')
    .get('fictional-unrelated-source')!;
  assert.equal(unrelated.details_json, ' {"providerOriginal" : "fictional"} ');
  assert.equal(unrelated.path, `data/profiles/${id}/sources/unrelated.txt`);
  assert.equal(digest(readFileSync(resolve(f.root, String(unrelated.path)))), unrelated.sha256);
  assert.equal(file.path, `data/profiles/${id}/sources/fictional.txt`);
  assert.deepEqual(readFileSync(resolve(f.root, String(file.path))), f.bytes);
  assert.equal(digest(readFileSync(resolve(f.root, String(file.path)))), f.sourceHash);
  assert.equal(storedIntakeDetails(db, file as { id: string; details_json: string })!.version, 7);
  const pin = readIntakeSourcePin(db, intakeId)!;
  assert.deepEqual(pin, readIntakeSourcePin(f.databases.get(f.source.id)!, intakeId));
  assert.equal(
    intakeDetails(db, { ...file, id: intakeId, source_pin: JSON.stringify(pin) }).version,
    7 + pin.version,
  );
  const text = getIntakeSourceText(db, f.root, id, intakeId).revision!;
  assert.equal(text.profileId, id);
  assert.equal(text.id, f.corrected.revision!.id);
  assert.equal(text.spans[0]!.text, 'Fictional human corrected value 10.00.');
  if (id !== f.source.id)
    assert.deepEqual(text.copiedFrom, { profileId: f.source.id, revisionId: text.id });
  assert.deepEqual(rows(db, 'source_records'), f.sourceRows.source_records);
  assert.deepEqual(rows(db, 'observations'), f.sourceRows.observations);
  assert.equal(
    db.prepare('SELECT value FROM app_meta WHERE key=?').get('unrelated-fictional-metadata')!.value,
    '{"b":2,"a":1}',
  );
  assert.equal(
    createIntakeStateStorage(db, {
      profileId: id,
      intakeId,
      sourceHash: f.sourceHash,
    }).readSerialized(),
    serializeIntakeJson(f.current),
  );
  const compact = JSON.parse(String(file.details_json));
  assert.equal(compact.intakeAuthority.mode, 'normalized');
  assert.equal(compact.intake.workflow, undefined);
}

test('real contributor copy retains exact active review, originals and human text through independent reopen and complete cache loss', async (t) => {
  const f = await fixture(t);
  const copy = await f.actions.create({ name: copiedName, operationId: randomUUID() }, f.source.id);
  verify(f, copy.id);
  assert.deepEqual(retainedFiles(f.root, f.source.id), f.sourceFiles);
  assert.deepEqual(rows(f.db, 'app_meta'), f.sourceRows.app_meta);
  const sourceKeys = new Set(
    rows(f.db, 'app_meta')
      .filter((row) => String(row.key).startsWith('intake_state_'))
      .map((row) => row.key),
  );
  const targetRows = rows(f.databases.get(copy.id)!, 'app_meta').filter((row) =>
    String(row.key).startsWith('intake_state_'),
  );
  assert.ok(targetRows.length > 0);
  for (const row of targetRows)
    assert.equal(
      sourceKeys.has(row.key),
      false,
      'target selects fresh internal namespace/identities',
    );
  for (const id of [f.source.id, copy.id]) {
    f.reopen(id);
    verify(f, id);
    f.reopen(id, true);
    verify(f, id);
  }
  const targetFiles = retainedFiles(f.root, copy.id);
  createNote(f.databases.get(copy.id)!, {
    title: 'Fictional target only',
    content: 'Isolated ordinary contributor edit',
  });
  f.reopen(copy.id, true);
  verify(f, copy.id);
  assert.equal(
    f.databases
      .get(copy.id)!
      .prepare("SELECT count(*) n FROM notes WHERE title='Fictional target only'")
      .get()!.n,
    1,
  );
  assert.equal(
    f.databases
      .get(f.source.id)!
      .prepare("SELECT count(*) n FROM notes WHERE title='Fictional target only'")
      .get()!.n,
    0,
  );
  assert.deepEqual(retainedFiles(f.root, f.source.id), f.sourceFiles);
  assert.ok(targetFiles.size > 0);
});

test('unpublished failure matrix cleans staging and retries from the currently coherent source', async (t) => {
  for (const checkpoint of [
    'validated',
    'staged',
    'before-export',
    'exported',
    'before-publication',
  ] as const)
    await t.test(checkpoint, async (child) => {
      const f = await fixture(child);
      const operationId = randomUUID();
      let targetId = '';
      const options: CreateProfileLifecycleOptions = {
        root: f.root,
        databases: f.databases,
        copyCheckpoint(point, context) {
          targetId = context.targetProfileId;
          if (point === checkpoint) throw Error('fictional interrupted ' + checkpoint);
        },
      };
      const interrupted = createProfileLifecycle(options);
      await assert.rejects(
        interrupted.create({ name: copiedName, operationId }, f.source.id),
        /fictional interrupted/,
      );
      assert.equal(f.databases.has(targetId), false);
      assert.equal(
        readProfileRegistry(f.root).profiles.some((p) => p.id === targetId),
        false,
      );
      assert.equal(existsSync(profilePaths(f.root, targetId).root), false);
      assert.deepEqual(readdirSync(resolve(f.root, 'data/operations/profile-staging')), []);
      assert.deepEqual(retainedFiles(f.root, f.source.id), f.sourceFiles);
      createNote(f.db, {
        title: 'Fictional source advanced',
        content: 'Fresh coherent source state after unpublished interruption',
      });
      exportCuration(f.db, f.root, f.source.id);
      const retry = await f.actions.create({ name: copiedName, operationId }, f.source.id);
      verify(f, retry.id);
      assert.equal(
        f.databases
          .get(retry.id)!
          .prepare("SELECT count(*) n FROM notes WHERE title='Fictional source advanced'")
          .get()!.n,
        1,
      );
    });
});

test('real immutable-write and staged selected-head failures refuse publication and clean only the unpublished target', async (t) => {
  for (const kind of ['immutable-write', 'staged-head'] as const)
    await t.test(kind, async (child) => {
      const f = await fixture(child);
      const operationId = randomUUID();
      let targetId = '';
      const link = fs.linkSync;
      let hits = 0;
      const injected = child.mock.method(fs, 'linkSync', (...args: Parameters<typeof link>) => {
        if (
          kind === 'immutable-write' &&
          String(args[1]).includes('/profile-staging/') &&
          String(args[1]).includes('/records/objects/')
        ) {
          hits++;
          throw Error('Fictional immutable authority write failure');
        }
        return link(...args);
      });
      syncBuiltinESMExports();
      const interrupted = createProfileLifecycle({
        root: f.root,
        databases: f.databases,
        copyCheckpoint(point, context) {
          targetId = context.targetProfileId;
          const paths = profilePaths(context.stageRoot, targetId);
          if (kind === 'staged-head' && point === 'exported')
            writeFileSync(
              resolve(paths.root, 'records/head'),
              '{"fictional":"invalid selected head"}',
            );
        },
      });
      await assert.rejects(
        interrupted.create({ name: copiedName, operationId }, f.source.id),
        /snapshot|directory|manifest|ENOTDIR|authority|head/i,
      );
      injected.mock.restore();
      syncBuiltinESMExports();
      if (kind === 'immutable-write') assert.ok(hits > 0);
      assert.equal(existsSync(profilePaths(f.root, targetId).root), false);
      assert.equal(f.databases.has(targetId), false);
      assert.deepEqual(readdirSync(resolve(f.root, 'data/operations/profile-staging')), []);
      assert.deepEqual(retainedFiles(f.root, f.source.id), f.sourceFiles);
      verify(f, (await f.actions.create({ name: copiedName, operationId }, f.source.id)).id);
    });
});

test('published, registry and activation ambiguity survive restart, source advance or absence, and complete target cache loss without recopy', async (t) => {
  for (const checkpoint of ['published', 'registered', 'activated'] as const)
    await t.test(checkpoint, async (child) => {
      const f = await fixture(child);
      const operationId = randomUUID();
      let targetId = '';
      const interrupted = createProfileLifecycle({
        root: f.root,
        databases: f.databases,
        copyCheckpoint(point, context) {
          targetId = context.targetProfileId;
          if (point === checkpoint) throw Error('fictional ambiguous ' + checkpoint);
        },
      });
      await assert.rejects(
        interrupted.create({ name: copiedName, operationId }, f.source.id),
        /fictional ambiguous/,
      );
      assert.ok(existsSync(profilePaths(f.root, targetId).root));
      const targetFiles = retainedFiles(f.root, targetId);
      createNote(f.db, {
        title: 'Fictional source too late',
        content: 'Must never be recopied into published survivor',
      });
      exportCuration(f.db, f.root, f.source.id);
      f.databases.get(targetId)?.close();
      f.databases.delete(targetId);
      const targetPaths = profilePaths(f.root, targetId);
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(targetPaths.database + suffix, { force: true });
      f.databases.delete(f.source.id);
      f.db.close();
      const fresh = createProfileLifecycle({ root: f.root, databases: f.databases });
      const recovered = await fresh.create({ name: copiedName, operationId }, f.source.id);
      assert.equal(recovered.id, targetId);
      assert.deepEqual(retainedFiles(f.root, targetId), targetFiles);
      assert.equal(
        selected(f.databases.get(targetId)!, targetId, f.sourceHash),
        serializeIntakeJson(f.current),
      );
      assert.equal(
        f.databases
          .get(targetId)!
          .prepare("SELECT count(*) n FROM notes WHERE title='Fictional source too late'")
          .get()!.n,
        0,
      );
      assert.equal(readProfileRegistry(f.root).profiles.filter((p) => p.id === targetId).length, 1);
      assert.equal(
        (await fresh.create({ name: copiedName, operationId }, f.source.id)).id,
        targetId,
      );
      await assert.rejects(
        fresh.create({ name: 'Conflicting retry name', operationId }, f.source.id),
        /conflict|operation/i,
      );
      assert.deepEqual(retainedFiles(f.root, targetId), targetFiles);
    });
});

test('invalid selected source evidence fails explicitly without resetting scope or publishing any destination', async (t) => {
  const cases: [string, (f: Awaited<ReturnType<typeof fixture>>) => void][] = [
    [
      'corrupt-frame',
      (f) => {
        const row = f.db
          .prepare(
            "SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:frame:*' LIMIT 1",
          )
          .get()!;
        f.db
          .prepare('UPDATE app_meta SET value=? WHERE key=?')
          .run(String(row.value) + ' ', row.key!);
      },
    ],
    [
      'unsupported-head',
      (f) => {
        const row = f.db
          .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head' LIMIT 1")
          .get()!;
        const head = JSON.parse(String(row.value));
        head.format = 'unsupported-fictional-intake-format';
        f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(JSON.stringify(head), row.key!);
      },
    ],
    [
      'wrong-profile',
      (f) => {
        const row = f.db
          .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head' LIMIT 1")
          .get()!;
        const head = JSON.parse(String(row.value));
        head.profileId = 'foreign-fictional-owner';
        f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(JSON.stringify(head), row.key!);
      },
    ],
    [
      'wrong-source',
      (f) => {
        const row = f.db
          .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head' LIMIT 1")
          .get()!;
        const head = JSON.parse(String(row.value));
        head.intakeId = 'foreign-fictional-source';
        f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(JSON.stringify(head), row.key!);
      },
    ],
    [
      'missing-namespace',
      (f) => f.db.prepare("DELETE FROM app_meta WHERE key GLOB 'intake_state_*'").run(),
    ],
    [
      'duplicated-inline-authority',
      (f) => f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(f.raw, intakeId),
    ],
    [
      'conflicting-compact-metadata',
      (f) => {
        const row = f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId)!;
        const compact = JSON.parse(String(row.details_json));
        compact.intake.originalName = 'Fictional conflicting name';
        f.db
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run(JSON.stringify(compact), intakeId);
      },
    ],
    [
      'wrong-hash',
      (f) => {
        writeFileSync(
          resolve(
            f.root,
            String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(intakeId)!.path),
          ),
          Buffer.from('Fictional altered original'),
        );
      },
    ],
    [
      'missing-original',
      (f) => {
        rmSync(
          resolve(
            f.root,
            String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(intakeId)!.path),
          ),
        );
      },
    ],
    [
      'unpublished-sql-state',
      (f) => {
        f.db
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional-unpublished-write', 'must not be silently selected');
      },
    ],
    [
      'corrupt-source-text',
      (f) => {
        const row = f.db
          .prepare(
            "SELECT key FROM app_meta WHERE key LIKE 'intake_source_text:v1:%:revision:%' LIMIT 1",
          )
          .get()!;
        f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', row.key!);
      },
    ],
  ];
  for (const [name, corrupt] of cases)
    await t.test(name, async (child) => {
      const f = await fixture(child);
      if (name === 'unpublished-sql-state') corrupt(f);
      else transaction(f.db, () => corrupt(f));
      const evidence = rows(f.db, 'app_meta');
      await assert.rejects(
        f.actions.create({ name: copiedName, operationId: randomUUID() }, f.source.id),
      );
      assert.equal(f.actions.list().length, 1);
      assert.deepEqual(rows(f.db, 'app_meta'), evidence);
      assert.deepEqual(readdirSync(resolve(f.root, 'data/operations/profile-staging')), []);
    });
});

test('mandatory copy identity rejects duplicate concurrent requests and never recreates a deleted published survivor', async (t) => {
  const f = await fixture(t);
  const operationId = randomUUID();
  await assert.rejects(f.actions.create({ name: copiedName }, f.source.id), /operation|UUID/i);
  const first = f.actions.create({ name: copiedName, operationId }, f.source.id);
  await assert.rejects(
    f.actions.create({ name: copiedName, operationId }, f.source.id),
    /busy|progress|operation/i,
  );
  const target = await first;
  const before = retainedFiles(f.root, target.id);
  createNote(f.databases.get(target.id)!, {
    title: 'Fictional survivor edit',
    content: 'Already active target edit',
  });
  assert.equal(
    (await f.actions.create({ name: copiedName, operationId }, f.source.id)).id,
    target.id,
  );
  assert.equal(
    f.databases
      .get(target.id)!
      .prepare("SELECT count(*) n FROM notes WHERE title='Fictional survivor edit'")
      .get()!.n,
    1,
  );
  assert.ok(before.size > 0);
  f.actions.remove(target.id, { confirmationName: target.name, version: target.version });
  await assert.rejects(
    f.actions.create({ name: copiedName, operationId }, f.source.id),
    /missing|deleted|published|recover/i,
  );
  assert.equal(existsSync(profilePaths(f.root, target.id).root), false);
  assert.equal(f.actions.list().length, 1);
});

test('completed copy retry after restart retains accepted target edits and changed identity without the source', async (t) => {
  const f = await fixture(t);
  const operationId = randomUUID();
  const target = await f.actions.create({ name: copiedName, operationId }, f.source.id);
  const db = f.databases.get(target.id)!;
  createNote(db, {
    title: 'Fictional accepted survivor edit',
    content: 'Retain across restart and cache loss',
  });
  const self = getNote(db, 'patient');
  saveNote(db, self.id, {
    ...self,
    title: 'Fictional renamed survivor',
    person: { ...self.person, name: 'Fictional renamed survivor' },
  });
  const targetFiles = retainedFiles(f.root, target.id);
  db.close();
  f.databases.delete(target.id);
  f.db.close();
  f.databases.delete(f.source.id);
  const paths = profilePaths(f.root, target.id);
  for (const suffix of ['', '-wal', '-shm']) rmSync(paths.database + suffix, { force: true });
  const restarted = createProfileLifecycle({ root: f.root, databases: f.databases });
  const replay = await restarted.create({ name: copiedName, operationId }, f.source.id);
  assert.equal(replay.id, target.id);
  assert.equal(replay.name, 'Fictional renamed survivor');
  assert.equal(
    f.databases
      .get(target.id)!
      .prepare("SELECT count(*) n FROM notes WHERE title='Fictional accepted survivor edit'")
      .get()!.n,
    1,
  );
  assert.deepEqual(retainedFiles(f.root, target.id), targetFiles);
  assert.equal(
    selected(f.databases.get(target.id)!, target.id, f.sourceHash),
    serializeIntakeJson(f.current),
  );
});

test('actual final rename errors before and after side effect preserve the correct publication boundary', async (t) => {
  for (const after of [false, true])
    await t.test(after ? 'rename then throw' : 'throw before rename', async (child) => {
      const f = await fixture(child);
      const operationId = randomUUID();
      let targetId = '';
      let stageRoot = '';
      const lifecycle = createProfileLifecycle({
        root: f.root,
        databases: f.databases,
        copyCheckpoint(point, context) {
          if (point === 'before-publication') {
            targetId = context.targetProfileId;
            stageRoot = context.stageRoot;
          }
        },
      });
      const realRename = fs.renameSync;
      const mocked = child.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (
          targetId &&
          String(from) === profilePaths(stageRoot, targetId).root &&
          String(to) === profilePaths(f.root, targetId).root
        ) {
          if (after) realRename(from, to);
          throw Error('fictional actual final rename error');
        }
        return realRename(from, to);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          lifecycle.create({ name: copiedName, operationId }, f.source.id),
          /fictional actual final rename error/,
        );
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(existsSync(profilePaths(f.root, targetId).root), after);
      assert.equal(f.databases.has(targetId), false);
      assert.equal(
        readProfileRegistry(f.root).profiles.some((p) => p.id === targetId),
        false,
      );
      assert.deepEqual(readdirSync(resolve(f.root, 'data/operations/profile-staging')), []);
      const intent = JSON.parse(
        readFileSync(
          resolve(f.root, 'data/operations/profile-copies', operationId + '.json'),
          'utf8',
        ),
      );
      assert.equal(intent.published, undefined);
      assert.equal(intent.publicationAttempted, after ? true : undefined);
      const survivor = after ? retainedFiles(f.root, targetId) : null;
      createNote(f.db, {
        title: 'Fictional after rename failure',
        content: 'Current coherent source advance',
      });
      exportCuration(f.db, f.root, f.source.id);
      const retry = await createProfileLifecycle({ root: f.root, databases: f.databases }).create(
        { name: copiedName, operationId },
        f.source.id,
      );
      if (after) {
        assert.equal(retry.id, targetId);
        assert.deepEqual(retainedFiles(f.root, targetId), survivor);
      }
      assert.equal(
        f.databases
          .get(retry.id)!
          .prepare("SELECT count(*) n FROM notes WHERE title='Fictional after rename failure'")
          .get()!.n,
        after ? 0 : 1,
      );
      verify(f, retry.id);
    });
});

test('published corrupt record authority or stale cache refuses retry and is retained for explicit recovery', async (t) => {
  for (const kind of ['record-head', 'stale-cache'] as const)
    await t.test(kind, async (child) => {
      const f = await fixture(child);
      const operationId = randomUUID();
      const target = await f.actions.create({ name: copiedName, operationId }, f.source.id);
      if (kind === 'record-head')
        writeFileSync(resolve(contributorAuthorityPath(f.root, target.id), 'head'), '{}');
      else
        f.databases
          .get(target.id)!
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional-target-unpublished-change', 'refuse stale disposable cache');
      const before = retainedFiles(f.root, target.id);
      f.databases.get(target.id)!.close();
      f.databases.delete(target.id);
      const restart = createProfileLifecycle({ root: f.root, databases: f.databases });
      await assert.rejects(restart.create({ name: copiedName, operationId }, f.source.id));
      assert.deepEqual(retainedFiles(f.root, target.id), before);
      assert.equal(f.databases.has(target.id), false);
      assert.ok(existsSync(profilePaths(f.root, target.id).root));
      assert.deepEqual(retainedFiles(f.root, f.source.id), f.sourceFiles);
    });
});

test('active completed-copy retry requires the actual selected head and acknowledged target state', async (t) => {
  for (const kind of ['missing-head', 'corrupt-head', 'unacknowledged-sql'] as const)
    await t.test(kind, async (child) => {
      const f = await fixture(child);
      const operationId = randomUUID();
      const target = await f.actions.create({ name: copiedName, operationId }, f.source.id);
      const db = f.databases.get(target.id)!;
      assert.equal(db.isOpen, true);
      assert.equal(
        (await f.actions.create({ name: copiedName, operationId }, f.source.id)).id,
        target.id,
      );
      createNote(db, {
        title: 'Fictional acknowledged target advance',
        content: 'Retained by valid active retry',
      });
      const acceptedArchive = retainedFiles(f.root, target.id);
      assert.equal(
        (await f.actions.create({ name: copiedName, operationId }, f.source.id)).id,
        target.id,
      );
      assert.deepEqual(retainedFiles(f.root, target.id), acceptedArchive);
      const head = resolve(contributorAuthorityPath(f.root, target.id), 'head');
      if (kind === 'missing-head') rmSync(head);
      else if (kind === 'corrupt-head')
        writeFileSync(head, '{"fictional":"invalid selected record head"}');
      else
        db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
          'fictional-unacknowledged-target-write',
          'must not become accepted through retry',
        );
      const before = retainedFiles(f.root, target.id);
      const selectedRows = rows(db, 'app_meta');
      await assert.rejects(
        f.actions.create({ name: copiedName, operationId }, f.source.id),
        /head|authority|durability|projection|uncommitted|transaction/i,
      );
      assert.equal(f.databases.get(target.id), db, 'exercise the still-active target branch');
      assert.equal(db.isOpen, true);
      assert.deepEqual(
        retainedFiles(f.root, target.id),
        before,
        'refusal preserves retained target authority without recopy',
      );
      assert.deepEqual(
        rows(db, 'app_meta'),
        selectedRows,
        'retry does not publish or discard unacknowledged SQL',
      );
      assert.deepEqual(retainedFiles(f.root, f.source.id), f.sourceFiles);
      assert.equal(
        readProfileRegistry(f.root).profiles.filter((profile) => profile.id === target.id).length,
        1,
      );
    });
});

test('copy seeds target accepted record authority without retaining source version identities', async (t) => {
  const f = await fixture(t);
  const sourceArchive = retainedFiles(f.root, f.source.id);
  const sourceVersions = new Set(rows(f.db, '__record_current').map((row) => row.version_id));
  assert.ok(sourceVersions.size > 0);
  const target = await f.actions.create(
    { name: copiedName, operationId: randomUUID() },
    f.source.id,
  );
  const targetVersions = rows(f.databases.get(target.id)!, '__record_current');
  assert.ok(targetVersions.length > 0);
  for (const row of targetVersions) assert.equal(sourceVersions.has(row.version_id), false);
  assert.deepEqual(retainedFiles(f.root, f.source.id), sourceArchive);
  verify(f, target.id);
});

test('actual durable intent write failure after rename retains selected target and attempted marker, and missing survivor cannot be recopied', async (t) => {
  for (const removeSurvivor of [false, true])
    await t.test(
      removeSurvivor ? 'missing attempted survivor' : 'retained attempted survivor',
      async (child) => {
        const f = await fixture(child);
        const operationId = randomUUID();
        const intentPath = resolve(f.root, 'data/operations/profile-copies', operationId + '.json');
        let targetId = '';
        let intentBytes = Buffer.alloc(0);
        const lifecycle = createProfileLifecycle({
          root: f.root,
          databases: f.databases,
          copyCheckpoint(point, context) {
            if (point === 'renamed') {
              targetId = context.targetProfileId;
              intentBytes = readFileSync(intentPath);
              rmSync(intentPath);
              mkdirSync(intentPath);
            }
          },
        });
        await assert.rejects(
          lifecycle.create({ name: copiedName, operationId }, f.source.id),
          /EISDIR|ENOTEMPTY|directory/i,
        );
        assert.ok(existsSync(profilePaths(f.root, targetId).root));
        assert.equal(f.databases.has(targetId), false);
        assert.equal(
          readProfileRegistry(f.root).profiles.some((p) => p.id === targetId),
          false,
        );
        const intent = JSON.parse(intentBytes.toString());
        assert.equal(intent.publicationAttempted, true);
        assert.equal(intent.published, undefined);
        rmSync(intentPath, { recursive: true });
        writeFileSync(intentPath, intentBytes);
        if (removeSurvivor) rmSync(profilePaths(f.root, targetId).root, { recursive: true });
        const beforeSource = retainedFiles(f.root, f.source.id);
        const fresh = createProfileLifecycle({ root: f.root, databases: f.databases });
        if (removeSurvivor) {
          await assert.rejects(
            fresh.create({ name: copiedName, operationId }, f.source.id),
            /missing|published|publication|recover/i,
          );
          assert.equal(existsSync(profilePaths(f.root, targetId).root), false);
        } else {
          const archive = retainedFiles(f.root, targetId);
          assert.equal(
            (await fresh.create({ name: copiedName, operationId }, f.source.id)).id,
            targetId,
          );
          assert.deepEqual(retainedFiles(f.root, targetId), archive);
          verify(f, targetId);
        }
        assert.deepEqual(retainedFiles(f.root, f.source.id), beforeSource);
      },
    );
});

test('published copy with external disposable SQLite recovers from cache loss independently of absent source', async (t) => {
  const f = await fixture(t);
  const operationId = randomUUID();
  const databaseDirectory = resolve(f.root, 'fictional-external-cache');
  let targetId = '';
  const lifecycle = createProfileLifecycle({
    root: f.root,
    databases: f.databases,
    databaseDirectory,
    copyCheckpoint(point, context) {
      targetId = context.targetProfileId;
      if (point === 'published') throw Error('fictional external cache publication ambiguity');
    },
  });
  await assert.rejects(
    lifecycle.create({ name: copiedName, operationId }, f.source.id),
    /fictional external/,
  );
  const archive = retainedFiles(f.root, targetId);
  const external = resolve(databaseDirectory, targetId + '.sqlite');
  for (const suffix of ['', '-wal', '-shm']) rmSync(external + suffix, { force: true });
  f.db.close();
  f.databases.delete(f.source.id);
  const fresh = createProfileLifecycle({ root: f.root, databases: f.databases, databaseDirectory });
  assert.equal((await fresh.create({ name: copiedName, operationId }, f.source.id)).id, targetId);
  assert.equal(f.databases.get(targetId)!.location(), external);
  assert.equal(
    selected(f.databases.get(targetId)!, targetId, f.sourceHash),
    serializeIntakeJson(f.current),
  );
  assert.deepEqual(retainedFiles(f.root, targetId), archive);
});

test('copied saved People state retains public receipt and archives exact source operation bytes through rebuild and nested copy', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'contributor-people-receipt-copy-'));
  const databases = new Map<string, Database>();
  const actions = createProfileLifecycle({ root, databases });
  t.after(() => {
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await actions.create({
    name: 'Fictional People source',
    fullName: 'Fictional People source',
    birthDate: '1982-04-17',
  });
  const db = databases.get(source.id)!;
  const envelope = {
    format: 'health-record-v1',
    id: 'fictional-people-envelope',
    kind: 'record',
    payload: 'Fictional report\nDr Mira Finch signed the fictional report.',
    provenance: {
      capturedVia: 'Fictional upload',
      sourceSystem: 'Fictional issuer',
      sourceRecordId: 'fictional-people-envelope',
      evidenceClass: 'provider_export',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    report: {
      key: 'fictional-people-report',
      title: 'Fictional report',
      anchor: { locator: 'page 1 heading', text: 'Fictional report' },
      subject: null,
    },
    people: [
      {
        id: 'fictional-mira',
        fullName: 'Mira Finch',
        role: 'clinician',
        title: 'Dr Mira Finch',
        evidence: [
          {
            textAnchor: 'Dr Mira Finch signed the fictional report.',
            supports: ['fullName', 'title'],
            locator: 'page 1',
            page: 1,
          },
        ],
      },
    ],
  };
  const item = uploadIntake(db, root, source.id, {
    filename: 'fictional-people.jsonl',
    newProviderName: 'Fictional issuer',
    bytes: Buffer.from(JSON.stringify(envelope)),
  });
  const groupId = item.workflow!.reportGroups![0]!.id;
  const proposal = getIntakePeopleQueue(db, root, source.id, groupId).people[0]!;
  const accepted = applyIntakePerson(db, root, source.id, {
    operationId: randomUUID(),
    intakeId: item.id,
    proposalId: proposal.id,
    proposalVersion: proposal.version,
    action: 'add',
  });
  assert.equal(getIntakePeopleQueue(db, root, source.id, groupId).people[0]!.state, 'saved');
  const peopleRow = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'personal_assistant_*' LIMIT 1")
    .get()!;
  const originalPeopleReceipt = String(peopleRow.value);
  const genericKey = 'personal_assistant_' + randomUUID();
  const restoreKey = 'personal_restore_' + randomUUID();
  const genericRaw = ` { "profileId" : "${source.id}", "proposalId":"${genericKey.slice('personal_assistant_'.length)}", "noteId":"${accepted.noteId}", "kind":"person", "version":${accepted.version}, "fictional" : "\\u03A9", "duplicate":1,"duplicate":2 }\n`;
  const restoreRaw = ` { "profileId" : "${source.id}", "operationId":"${restoreKey.slice('personal_restore_'.length)}", "fingerprint":"fictional-restore-fingerprint", "noteId":"${accepted.noteId}", "previousVersion":1,"currentVersion":2, "fictionalRestore" : true }\n`;
  transaction(db, () => {
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(genericKey, genericRaw);
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(restoreKey, restoreRaw);
  });
  exportCuration(db, root, source.id);
  const sourceArchive = retainedFiles(root, source.id);
  const target = await actions.create(
    { name: 'Fictional People copy', operationId: randomUUID() },
    source.id,
  );
  const archiveKey = (key: unknown) => `private_copy_source_receipt:v1:${source.id}:${String(key)}`;
  const check = (id: string) => {
    const targetDb = databases.get(id)!;
    const saved = getIntakePeopleQueue(targetDb, root, id, groupId).people[0]!;
    assert.equal(saved.state, 'saved');
    assert.equal(saved.id, proposal.id);
    assert.equal(saved.version, proposal.version);
    assert.equal(saved.saved!.noteId, accepted.noteId);
    assert.equal(saved.saved!.version, accepted.version);
    const live = JSON.parse(
      String(targetDb.prepare('SELECT value FROM app_meta WHERE key=?').get(peopleRow.key!)!.value),
    );
    assert.deepEqual(live, { ...JSON.parse(originalPeopleReceipt), profileId: id });
    for (const [key, raw] of [
      [peopleRow.key, originalPeopleReceipt],
      [genericKey, genericRaw],
      [restoreKey, restoreRaw],
    ])
      assert.equal(
        targetDb.prepare('SELECT value FROM app_meta WHERE key=?').get(archiveKey(key))!.value,
        raw,
      );
    assert.equal(
      targetDb.prepare('SELECT value FROM app_meta WHERE key=?').get(genericKey),
      undefined,
    );
    assert.equal(
      targetDb.prepare('SELECT value FROM app_meta WHERE key=?').get(restoreKey),
      undefined,
    );
  };
  check(target.id);
  const paths = profilePaths(root, target.id);
  databases.get(target.id)!.close();
  databases.delete(target.id);
  for (const suffix of ['', '-wal', '-shm']) rmSync(paths.database + suffix, { force: true });
  const rebuilt = rebuildProfile(root, target.id, resolve(root, 'fictional-people-rebuild'));
  cpSync(rebuilt.database, paths.database);
  const targetDb = openDatabase(paths.database, target.id);
  attachPersonalDurability(targetDb, { root, profileId: target.id });
  databases.set(target.id, targetDb);
  check(target.id);
  const nested = await actions.create(
    { name: 'Fictional People nested copy', operationId: randomUUID() },
    target.id,
  );
  check(nested.id);
  assert.deepEqual(retainedFiles(root, source.id), sourceArchive);
});

test('published target with wrong owner, intake identity or original bytes never gets replaced from coherent source', async (t) => {
  for (const kind of ['owner', 'intake-identity', 'original-hash'] as const)
    await t.test(kind, async (child) => {
      const f = await fixture(child);
      const operationId = randomUUID();
      const target = await f.actions.create({ name: copiedName, operationId }, f.source.id);
      const db = f.databases.get(target.id)!;
      if (kind === 'owner')
        db.prepare("UPDATE app_meta SET value=? WHERE key='owner_profile_id'").run(f.source.id);
      else if (kind === 'intake-identity') {
        const row = db
          .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head' LIMIT 1")
          .get()!;
        const head = JSON.parse(String(row.value));
        head.profileId = f.source.id;
        db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(JSON.stringify(head), row.key!);
      } else
        writeFileSync(
          resolve(profilePaths(f.root, target.id).sources, 'fictional.txt'),
          'Fictional target corruption',
        );
      const archive = retainedFiles(f.root, target.id);
      db.close();
      f.databases.delete(target.id);
      await assert.rejects(
        createProfileLifecycle({ root: f.root, databases: f.databases }).create(
          { name: copiedName, operationId },
          f.source.id,
        ),
      );
      assert.deepEqual(retainedFiles(f.root, target.id), archive);
      assert.deepEqual(retainedFiles(f.root, f.source.id), f.sourceFiles);
      assert.equal(f.databases.has(target.id), false);
    });
});

test('contributor raw initial authority survives private copy and cache loss, then normalizes only the edited target', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'contributor-raw-intake-copy-'));
  const databases = new Map<string, Database>();
  const actions = createProfileLifecycle({ root, databases });
  t.after(() => {
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await actions.create({
    name: 'Fictional raw source',
    fullName: 'Fictional raw source',
    birthDate: '1982-04-17',
  });
  const db = databases.get(source.id)!;
  const bytes = Buffer.from('Fictional source original, untouched by review.');
  const path = `data/profiles/${source.id}/sources/raw-original.txt`;
  writeFileSync(resolve(root, path), bytes);
  const raw =
    ' {"before":{"escaped":"\\u03A9","duplicate":1,"duplicate":2}, "intake":{"originalName":"raw-original.txt","version":1,"state":"pending","proposals":[],"workflow":{"format":"health-intake-workflow-v1","questions":[]}}, "after":true}\n';
  transaction(db, () =>
    registerIntakeFile(db, {
      id: intakeId,
      providerId: null,
      batchId: null,
      path,
      bytes,
      mimeType: 'text/plain',
      kind: 'intake_original',
      coverage: 'unknown',
      details: raw,
    }),
  );
  const sourceArchive = retainedFiles(root, source.id);
  const copy = await actions.create(
    { name: 'Fictional raw copy', operationId: randomUUID() },
    source.id,
  );
  const rebuild = (id: string) => {
    databases.get(id)!.close();
    databases.delete(id);
    const paths = profilePaths(root, id);
    for (const suffix of ['', '-wal', '-shm']) rmSync(paths.database + suffix, { force: true });
    const recovered = rebuildProfile(
      root,
      id,
      resolve(root, 'fictional-raw-rebuild-' + randomUUID()),
    );
    cpSync(recovered.database, paths.database);
    const next = openDatabase(paths.database, id);
    attachPersonalDurability(next, { root, profileId: id });
    databases.set(id, next);
    return next;
  };
  for (const id of [source.id, copy.id]) {
    const current = rebuild(id);
    assert.equal(readIntakeEnvelopeText(current, { id: intakeId }), raw);
    assert.deepEqual(
      createIntakeStateStorage(current, {
        profileId: id,
        intakeId,
        sourceHash: digest(bytes),
      }).read(),
      { raw },
    );
    assert.deepEqual(
      readFileSync(resolve(profilePaths(root, id).sources, 'raw-original.txt')),
      bytes,
    );
  }
  const normalized = JSON.parse(raw);
  normalized.intake.workflow.questions.push({
    id: 'fictional-target-only',
    prompt: 'Fictional pending question?',
  });
  writeIntakeFixtureEnvelope(databases.get(copy.id)!, intakeId, normalized);
  assert.equal(
    readIntakeEnvelopeText(rebuild(copy.id), { id: intakeId }),
    JSON.stringify(normalized),
  );
  assert.equal(readIntakeEnvelopeText(databases.get(source.id)!, { id: intakeId }), raw);
  assert.deepEqual(retainedFiles(root, source.id), sourceArchive);
});
