import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { getIntake, uploadIntake, reviewIntake } from '../intake.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { registerIntakeFile, type IntakeDetails } from '../intake-state-access.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { intakeCandidateVersionId, intakeWorkflow } from '../intake-workflow.ts';
import { canonicalLiteral, validateJSONL, validationSummary } from '../intake-format.ts';
import {
  cachedSourceContextVersions,
  clearSourceContextClassificationCache,
} from '../intake-source-context-classification.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const envelope = (id: string, context = true): HealthRecordEnvelope => ({
  format: 'health-record-v1',
  id,
  kind: context ? 'context' : 'document',
  payload: { text: `Fictional administrative entry ${id}`, literal: '12.00' },
  provenance: {
    capturedVia: 'Fictional export',
    sourceSystem: 'Fictional system',
    sourceRecordId: id,
    evidenceClass: 'transcription',
    locator: 'fictional page 1',
  },
  coverage: { status: 'complete_response', notes: [] },
});
type Source = Parameters<typeof cachedSourceContextVersions>[3];

function fixture(t: TestContext, count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'context-classification-'));
  const profileId = 'cookie-dough';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearSourceContextClassificationCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const uploaded = uploadIntake(db, root, profileId, {
    filename: 'fictional-original.jsonl',
    bytes: Buffer.from(JSON.stringify(envelope('original'))),
    newProviderName: 'Fictional intake',
  });
  const file = db
    .prepare('SELECT * FROM source_files WHERE id=?')
    .get(uploaded.id) as unknown as Source;
  const all = JSON.parse(readIntakeEnvelopeText(db, file)!);
  const d = all.intake as IntakeDetails;
  intakeWorkflow(d).candidates = [];
  const sources: Source[] = [];
  const values: HealthRecordEnvelope[] = [];
  const expected = new Set<string>();
  transaction(db, () => {
    for (let i = 0; i < count; i++) {
      const id = `fictional-proposal-${i}`;
      const value = envelope(id, i % 2 === 0);
      const bytes = Buffer.from(JSON.stringify(value));
      const parsed = validateJSONL(bytes);
      assert.equal(parsed.valid, true);
      const validation = validationSummary(parsed);
      const path = `${paths.relativeRoot}/sources/${id}.jsonl`;
      writeFileSync(join(root, path), bytes);
      registerIntakeFile(db, {
        id,
        path,
        bytes,
        kind: 'intake_proposal',
        mimeType: 'application/jsonl',
        coverage: 'complete_response',
        details: { originalSourceFileId: file.id, validation },
      });
      d.proposals.push({
        id,
        fileId: id,
        summary: 'Fictional proposal',
        createdAt: '2026-01-01T00:00:00.000Z',
        runId: null,
        validation,
        contentUrl: `/fictional/${id}`,
        sourceTextRevisionId: 'revision-1',
      });
      const versionId = intakeCandidateVersionId(d, id, { value });
      d.workflow!.candidates.push({
        id: `candidate-${i}`,
        envelopeId: id,
        sourceSystem: null,
        sourceRecordId: null,
        versions: [
          {
            id: versionId,
            status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z',
            occurrences: [
              { proposalId: id, recordId: `${id}:line:1`, batchId: null, locator: 'page 1' },
            ],
          },
        ],
      });
      if (i % 2 === 0) expected.add(versionId);
      sources.push(
        db.prepare('SELECT * FROM source_files WHERE id=?').get(id) as unknown as Source,
      );
      values.push(value);
    }
    writeIntakeFixtureEnvelope(db, file.id, all);
  });
  const scan = () => cachedSourceContextVersions(db, root, profileId, file, d);
  const measured = (run = scan) => {
    const work = createIntakeFileWorkCounters();
    const result = withIntakeFileWork(work, run);
    return { result, work };
  };
  return { root, profileId, db, paths, file, all, d, sources, values, expected, scan, measured };
}

test('160 mixed classifications survive repeated complete views and one newly referenced source without FIFO churn', (t) => {
  const f = fixture(t, 160);
  const cold = f.measured();
  assert.deepEqual(cold.result, f.expected);
  assert.equal(cold.work.reads, 160);
  assert.equal(cold.work.bufferHashCalls, 160);
  assert.equal(cold.work.candidateVersionHashCalls, 80);
  assert.equal(
    cold.work.candidateVersionHashBytes,
    f.values
      .filter((_, i) => i % 2 === 0)
      .reduce(
        (bytes, value) =>
          bytes + Buffer.byteLength(JSON.stringify([canonicalLiteral(value), 'revision-1'])),
        0,
      ),
  );
  assert.equal(cold.work.textHashCalls, 0);
  for (let i = 0; i < 3; i++) {
    const warm = f.measured();
    assert.deepEqual(warm.result, f.expected);
    assert.equal(warm.work.readAttempts, 0);
    assert.equal(warm.work.bufferHashCalls, 0);
    assert.equal(warm.work.candidateVersionHashCalls, 0);
    assert.equal(warm.work.candidateVersionHashBytes, 0);
  }
  const complete = createIntakeFileWorkCounters();
  const dto = withIntakeFileWork(complete, () => getIntake(f.db, f.root, f.profileId, f.file.id));
  assert.equal(
    dto.workflow!.candidates.filter((candidate) => candidate.versions[0]!.sourceContext).length,
    80,
  );
  assert.equal(complete.reads, 0);
  assert.equal(complete.bufferHashCalls, 0);
  const otherValue = envelope('another-collection');
  const other = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'other-fictional.jsonl',
    bytes: Buffer.from(JSON.stringify(otherValue)),
    newProviderName: 'Other fictional collection',
  });
  const otherEnvelope = JSON.parse(readIntakeEnvelopeText(f.db, { id: other.id })!);
  const otherDetails = otherEnvelope.intake as IntakeDetails;
  intakeWorkflow(otherDetails).candidates = [
    {
      id: 'other-candidate',
      envelopeId: otherValue.id,
      sourceSystem: null,
      sourceRecordId: null,
      versions: [
        {
          id: intakeCandidateVersionId(otherDetails, null, { value: otherValue }),
          status: 'pending',
          createdAt: '',
          occurrences: [
            { proposalId: null, recordId: `${other.id}:line:1`, batchId: null, locator: 'page 1' },
          ],
        },
      ],
    },
  ];
  writeIntakeFixtureEnvelope(f.db, other.id, otherEnvelope);
  for (const expectedReads of [1, 0]) {
    const otherWork = createIntakeFileWorkCounters();
    const otherDto = withIntakeFileWork(otherWork, () =>
      getIntake(f.db, f.root, f.profileId, other.id),
    );
    assert.equal(otherDto.workflow!.candidates[0]!.versions[0]!.sourceContext, true);
    assert.equal(otherWork.reads, expectedReads);
    assert.equal(
      f.measured().work.reads,
      0,
      'concurrent collection retains its own unchanged classifications',
    );
  }
  // A new selected candidate from an already existing but previously unreferenced
  // source must classify only that source, without invalidating the other 160.
  f.d.workflow!.candidates.push({
    id: 'original-candidate',
    envelopeId: 'original',
    sourceSystem: null,
    sourceRecordId: null,
    versions: [
      {
        id: intakeCandidateVersionId(f.d, null, { value: envelope('original') }),
        status: 'pending',
        createdAt: '',
        occurrences: [
          { proposalId: null, recordId: 'original:line:1', batchId: null, locator: 'page 1' },
        ],
      },
    ],
  });
  const added = f.measured();
  assert.equal(added.result.size, 81);
  assert.equal(added.work.reads, 1);
  assert.equal(added.work.bufferHashCalls, 1);
  assert.equal(added.work.candidateVersionHashCalls, 1);
  clearSourceContextClassificationCache(f.db);
  const rebuilt = f.measured();
  assert.equal(rebuilt.result.size, 81);
  assert.equal(rebuilt.work.reads, 161);
  assert.equal(rebuilt.work.bufferHashCalls, 161);
  assert.equal(rebuilt.work.candidateVersionHashCalls, 81);
});

test('dependency token and revision changes never reuse an obsolete candidate version', (t) => {
  const f = fixture(t);
  f.scan();
  const proposal = f.d.proposals[0]!;
  const version = f.d.workflow!.candidates[0]!.versions[0]!;
  const oldId = version.id;
  proposal.sourceTextRevisionId = 'revision-2';
  version.id = intakeCandidateVersionId(f.d, proposal.id, { value: f.values[0]! });
  assert.notEqual(version.id, oldId);
  const revised = f.measured();
  assert.deepEqual(revised.result, new Set([version.id]));
  assert.equal(revised.work.reads, 1);
  assert.equal(revised.work.bufferHashCalls, 1);
  assert.equal(revised.work.candidateVersionHashCalls, 1);
  proposal.sourceTextDependencyToken = 'dependency-3';
  version.id = intakeCandidateVersionId(f.d, proposal.id, { value: f.values[0]! });
  const pinned = f.measured();
  assert.deepEqual(pinned.result, new Set([version.id]));
  assert.equal(pinned.work.reads, 1);
  proposal.sourceTextRevisionId = 'irrelevant-under-token';
  assert.equal(f.measured().work.reads, 0, 'effective token takes precedence over revision');
  f.d.proposals.push({ ...proposal, sourceTextDependencyToken: 'ignored-later-duplicate' });
  assert.equal(
    f.measured().work.reads,
    0,
    'binding uses the same first matching proposal as the version function',
  );
  proposal.sourceTextDependencyToken = 'dependency-4';
  version.id = intakeCandidateVersionId(f.d, proposal.id, { value: f.values[0]! });
  const duplicated = f.measured();
  assert.deepEqual(duplicated.result, new Set([version.id]));
  assert.equal(duplicated.work.reads, 1);
  f.d.proposals[1]!.sourceTextDependencyToken = 'negative-dependency';
  assert.equal(f.measured().work.reads, 1, 'negative classifications obey the same binding');
});

test('missing, corrupt, replaced and rebound evidence cannot inherit a cached classification', (t) => {
  const f = fixture(t);
  const source = f.sources[0]!;
  const path = join(f.root, source.path);
  const bytes = Buffer.from(JSON.stringify(f.values[0]));
  f.scan();
  writeFileSync(path, Buffer.alloc(bytes.length, 32));
  let changed = f.measured();
  assert.equal(changed.result.size, 0);
  assert.equal(changed.work.reads, 1);
  assert.equal(f.measured().work.reads, 1, 'corruption never becomes a verified negative result');
  assert.throws(
    () => reviewIntake(f.db, f.root, f.profileId, f.file.id, source.id),
    /hash|changed/i,
  );
  rmSync(path);
  assert.equal(f.scan().size, 0);
  writeFileSync(path, bytes);
  assert.equal(f.measured().work.reads, 1);
  writeFileSync(path + '.replacement', bytes);
  renameSync(path + '.replacement', path);
  assert.equal(f.measured().work.reads, 1, 'same-path inode replacement is reverified');
  copyFileSync(path, path + '.copy');
  f.db.prepare('UPDATE source_files SET path=? WHERE id=?').run(source.path + '.copy', source.id);
  assert.equal(f.measured().work.reads, 1, 'changed path is rebound');
  f.db.prepare('UPDATE source_files SET kind=? WHERE id=?').run('fictional-context', source.id);
  assert.equal(f.measured().work.reads, 1, 'changed source kind is rebound');
  const replacement = Buffer.from(JSON.stringify(envelope(source.id, false)));
  writeFileSync(path + '.copy', replacement);
  f.db
    .prepare('UPDATE source_files SET sha256=?,bytes=? WHERE id=?')
    .run(digest(replacement), replacement.length, source.id);
  changed = f.measured();
  assert.equal(changed.result.size, 0);
  assert.equal(changed.work.reads, 1);
  assert.equal(f.measured().work.reads, 0, 'verified changed negative classification is reusable');
  f.db
    .prepare('UPDATE source_files SET details_json=? WHERE id=?')
    .run('{"validation":{"valid":false}}', source.id);
  assert.equal(f.scan().size, 0);
  f.db
    .prepare('UPDATE source_files SET details_json=? WHERE id=?')
    .run(source.details_json, source.id);
  assert.equal(f.measured().work.reads, 1, 'invalid validation evicts the earlier result');
  const invalid = Buffer.from('{"invalid":"fictional envelope"}');
  writeFileSync(path + '.copy', invalid);
  f.db
    .prepare('UPDATE source_files SET sha256=?,bytes=? WHERE id=?')
    .run(digest(invalid), invalid.length, source.id);
  assert.equal(f.measured().result.size, 0);
  assert.equal(f.measured().work.reads, 1, 'invalid envelopes never become verified negatives');
});

test('root, profile, connection, selected authority and rollback scopes remain independent', (t) => {
  const f = fixture(t);
  f.scan();
  const otherRoot = mkdtempSync(join(tmpdir(), 'context-other-root-'));
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }));
  ensureProfileDirectories(otherRoot, f.profileId);
  for (const source of f.sources)
    copyFileSync(join(f.root, source.path), join(otherRoot, source.path));
  const elsewhere = f.measured(() =>
    cachedSourceContextVersions(f.db, otherRoot, f.profileId, f.file, f.d),
  );
  assert.equal(elsewhere.work.reads, 2);
  assert.deepEqual(elsewhere.result, f.expected);
  assert.equal(f.measured().work.reads, 2, 'returning from another root starts a fresh scope');
  const otherDb = new DatabaseSync(f.paths.database);
  t.after(() => {
    clearSourceContextClassificationCache(otherDb);
    otherDb.close();
  });
  assert.equal(
    f.measured(() => cachedSourceContextVersions(otherDb, f.root, f.profileId, f.file, f.d)).work
      .reads,
    2,
  );
  assert.equal(f.measured().work.reads, 0, 'concurrent connection does not displace this cache');
  ensureProfileDirectories(f.root, 'other-fictional');
  const wrongProfile = f.measured(() =>
    cachedSourceContextVersions(f.db, f.root, 'other-fictional', f.file, f.d),
  );
  assert.equal(wrongProfile.result.size, 0);
  assert.equal(wrongProfile.work.reads, 0, 'old paths fail the other profile boundary');
  assert.equal(f.measured().work.reads, 2);
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.scan();
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.equal(f.measured().work.reads, 2, 'failed transaction discards verified reuse');
  // A warm classification cache cannot bypass the selected authority read in DTO.
  f.db.exec('BEGIN');
  f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run('{}', f.file.id);
  assert.throws(() => getIntake(f.db, f.root, f.profileId, f.file.id), /authority/i);
  f.db.exec('ROLLBACK');
  // Prune detached references while preserving other source classifications.
  const candidate = f.d.workflow!.candidates.shift()!;
  f.scan();
  f.d.workflow!.candidates.unshift(candidate);
  assert.equal(f.measured().work.reads, 1);
  f.db.close();
  assert.throws(f.scan, /open database/);
});
