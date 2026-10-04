import test, { type TestContext } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import {
  registerIntakeFile,
  intakeSourceVersion,
  type IntakeDetails,
} from '../intake-state-access.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import {
  intakeCandidateVersionId,
  intakeWorkflow,
  intakeCandidateVersionIdForRevision,
} from '../intake-workflow.ts';
import { validateJSONL, validationSummary } from '../intake-format.ts';
import {
  cachedSourceContextVersions,
  clearSourceContextClassificationCache,
} from '../intake-source-context-classification.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  prepareSelectedSourceContextClassification,
  readSelectedSourceContextClassification,
  SourceContextClassificationPending,
  prepareSourceContextClassificationDerived,
  type PreparedSourceContextDerived,
} from '../intake-source-context-state.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { workflowHash } from '../intake-workflow.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';

function value(id: string, context = true): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: context ? 'context' : 'document',
    payload: { text: 'Fictional ' + id },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional system',
      sourceRecordId: id,
      evidenceClass: 'transcription',
      locator: 'fictional page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
}
async function fixture(
  t: TestContext,
  count = 4,
  referenced = true,
  duplicate = false,
  modify?: (d: IntakeDetails) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-context-state-')),
    profileId = 'cookie-dough',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearSourceContextClassificationCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const uploaded = uploadIntake(db, root, profileId, {
    filename: 'fictional-original.jsonl',
    bytes: Buffer.from(JSON.stringify(value('original'))),
    newProviderName: 'Fictional clinic',
  });
  const file = db
    .prepare('SELECT * FROM source_files WHERE id=?')
    .get(uploaded.id) as unknown as Parameters<typeof cachedSourceContextVersions>[3];
  const all = JSON.parse(readIntakeEnvelopeText(db, file)!),
    d = all.intake as IntakeDetails;
  intakeWorkflow(d).candidates = [];
  d.proposals = [];
  const bytes: Buffer[] = [],
    sourceIds: string[] = [],
    versionIds: string[] = [];
  transaction(db, () => {
    for (let n = 0; n < count; n++) {
      const id = 'fictional-proposal-' + n,
        entry = value(id, n % 2 === 0),
        raw = Buffer.from(JSON.stringify(entry)),
        parsed = validateJSONL(raw);
      assert.equal(parsed.valid, true);
      bytes.push(raw);
      sourceIds.push(id);
      const validation = validationSummary(parsed),
        path = paths.relativeRoot + '/sources/' + id + '.jsonl';
      writeFileSync(join(root, path), raw);
      registerIntakeFile(db, {
        id,
        path,
        bytes: raw,
        kind: 'intake_proposal',
        mimeType: 'application/jsonl',
        coverage: 'complete_response',
        details: { originalSourceFileId: file.id, validation },
      });
      d.proposals.push({
        id,
        fileId: id,
        summary: 'Fictional',
        createdAt: '2026-01-01',
        runId: null,
        validation,
        contentUrl: '/fictional/' + id,
        sourceTextRevisionId: 'revision-1',
      });
      const versionId = intakeCandidateVersionId(d, id, { value: entry });
      versionIds.push(versionId);
      d.workflow!.candidates.push({
        id: 'candidate-' + n,
        envelopeId: id,
        sourceSystem: null,
        sourceRecordId: null,
        versions: [
          {
            id: versionId,
            status: 'pending',
            createdAt: '2026-01-01',
            occurrences: referenced
              ? [{ proposalId: id, recordId: id + ':line:1', batchId: null, locator: 'page 1' }]
              : [],
          },
        ],
      });
    }
    if (duplicate)
      d.proposals.push({
        ...d.proposals[0]!,
        sourceTextDependencyToken: 'ignored-later-duplicate',
      });
    modify?.(d);
    writeIntakeFixtureEnvelope(db, file.id, all);
  });
  await buildIntakeCollectionEnvelope(db, file);
  return { db, root, profileId, id: file.id, file, d, all, bytes, sourceIds, versionIds, paths };
}
test('cold native classification matches actual legacy fallback and warm points never hydrate or rehash', async (t) => {
  const f = await fixture(t),
    before = intakeSourceVersion(f.db, f.id);
  const expected = cachedSourceContextVersions(f.db, f.root, f.profileId, f.file, f.d);
  assert.equal(
    readSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id).state,
    'pending',
  );
  let work = createIntakeFileWorkCounters();
  const prepared = await prepareSelectedSourceContextClassification(
    f.db,
    f.root,
    f.profileId,
    f.id,
    { onWork: (w) => (work = w) },
  );
  assert.equal(prepared.state, 'ready');
  if (prepared.state !== 'ready') return;
  assert.equal(work.reads, 4);
  assert.equal(work.bufferHashCalls, 4);
  assert.deepEqual(intakeSourceVersion(f.db, f.id), before);
  const host = intakeWorkCounters(f.db).warm;
  for (let n = 0; n < 3; n++)
    for (const id of f.versionIds)
      assert.equal(prepared.isSourceContextVersion(id), expected.has(id));
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, host.materializationReads);
  const again = await prepareSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id, {
    onWork: (w) => (work = w),
  });
  assert.equal(again.state, 'ready');
  assert.equal(work.reads, 0);
  assert.equal(work.candidateVersionHashCalls, 0);
  assert.throws(
    () => readSelectedSourceContextClassification(f.db, f.root, 'foreign', f.id),
    /different profile/,
  );
});
test('empty referenced set uses all allowed sources and first duplicate proposal revision', async (t) => {
  const f = await fixture(t, 4, false, true);
  const expected = cachedSourceContextVersions(f.db, f.root, f.profileId, f.file, f.d);
  const prepared = await prepareSelectedSourceContextClassification(
    f.db,
    f.root,
    f.profileId,
    f.id,
  );
  assert.equal(prepared.state, 'ready');
  if (prepared.state !== 'ready') return;
  for (const id of f.versionIds)
    assert.equal(prepared.isSourceContextVersion(id), expected.has(id));
  assert.equal(expected.size, 2);
});
test('damaged positive evidence becomes explicit pending until repair preparation and never a false negative', async (t) => {
  const f = await fixture(t, 2),
    prepared = await prepareSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  assert.equal(prepared.state, 'ready');
  if (prepared.state !== 'ready') return;
  const path = join(f.root, f.paths.relativeRoot, 'sources', f.sourceIds[0] + '.jsonl');
  writeFileSync(path, Buffer.alloc(f.bytes[0]!.length, 32));
  assert.throws(
    () => prepared.isSourceContextVersion(f.versionIds[0]!),
    SourceContextClassificationPending,
  );
  const damaged = await prepareSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  assert.deepEqual(damaged, { state: 'pending', reason: 'source_evidence_unavailable' });
  writeFileSync(path, f.bytes[0]!);
  assert.equal(
    readSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id).state,
    'pending',
  );
  const repaired = await prepareSelectedSourceContextClassification(
    f.db,
    f.root,
    f.profileId,
    f.id,
  );
  assert.equal(repaired.state, 'ready');
  if (repaired.state === 'ready')
    assert.equal(repaired.isSourceContextVersion(f.versionIds[0]!), true);
});
test('cancellation cannot publish a partial classification and source-bound old scopes fail after change', async (t) => {
  const f = await fixture(t, 12);
  let checks = 0;
  await assert.rejects(
    prepareSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id, {
      assertRunning() {
        if (++checks === 10) throw Error('fictional cancellation');
      },
    }),
    /fictional cancellation/,
  );
  assert.equal(
    readSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id).state,
    'pending',
  );
  const prepared = await prepareSelectedSourceContextClassification(
    f.db,
    f.root,
    f.profileId,
    f.id,
  );
  assert.equal(prepared.state, 'ready');
  if (prepared.state !== 'ready') return;
  const view = openIntakeCollectionEnvelope(f.db, f.file),
    operationId = randomUUID();
  const mutation = await prepareIntakeEnvelopeMutation(f.db, f.file, {
    reader: view,
    operationId,
    requestDigest: workflowHash(operationId),
    domainVersion: view.logical.domainVersion + 1,
    changes: [
      {
        op: 'set',
        record: view.child(view.root(), 'intake')!,
        field: 'version',
        jsonText: String(view.logical.domainVersion + 1),
      },
    ],
  });
  transaction(f.db, () =>
    selectedEnvelopeStore(f.db, f.file).collections.stage(mutation.prepared!),
  );
  assert.throws(
    () => prepared.isSourceContextVersion(f.versionIds[0]!),
    SourceContextClassificationPending,
  );
});

test('addressed selector mode change reclassifies untouched IDs and atomically publishes a reusable reader', async (t) => {
  const f = await fixture(t, 2, false);
  const prior = await prepareSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  assert.equal(prior.state, 'ready');
  if (prior.state !== 'ready') return;
  assert.equal(prior.isSourceContextVersion(f.versionIds[0]!), true);
  const view = openIntakeCollectionEnvelope(f.db, f.file),
    intake = view.child(view.root(), 'intake')!,
    flow = view.child(intake, 'workflow')!,
    candidate = view.find('candidate', flow, 'candidate-1')!,
    version = view.find('version', candidate, f.versionIds[1]!)!,
    operationId = randomUUID(),
    work = createIntakeFileWorkCounters();
  let derived: PreparedSourceContextDerived | undefined;
  const result = await withIntakeFileWork(work, () =>
    prepareIntakeEnvelopeMutation(f.db, f.file, {
      reader: view,
      operationId,
      requestDigest: workflowHash(operationId),
      domainVersion: view.logical.domainVersion + 1,
      changes: [
        {
          op: 'append',
          record: version,
          field: 'occurrences',
          jsonText: JSON.stringify({
            proposalId: f.sourceIds[1],
            recordId: 'fictional-new-occurrence',
            batchId: null,
            locator: 'page 2',
          }),
        },
      ],
      prepareDerived: async (input) => {
        derived = await prepareSourceContextClassificationDerived(f.db, f.root, f.profileId, f.id, {
          ...input,
          impact: 'proposal',
          affected: {
            candidateChanges: [
              {
                candidateId: 'candidate-1',
                candidateVersionId: f.versionIds[1]!,
                candidateAddress: view.address(candidate),
                versionAddress: view.address(version),
                kind: 'update',
              },
            ],
            questionAddresses: [],
            reportGroupAddresses: [],
            proposalIds: [],
          },
        });
        assert.equal(derived.state, 'ready');
        if (derived.state !== 'ready') return [];
        assert.deepEqual([...derived.additionalVersionIds!], [f.versionIds[0]]);
        assert.equal(derived.isSourceContextVersion(f.versionIds[0]!, { ...input.reader }), false);
        return derived.changes;
      },
    }),
  );
  assert.equal(work.reads, 0);
  assert.equal(work.candidateVersionHashCalls, 0);
  assert.equal(prior.isSourceContextVersion(f.versionIds[0]!), true);
  transaction(f.db, () => {
    assert.ok(derived?.state === 'ready');
    derived.assertPublicationCurrent();
    selectedEnvelopeStore(f.db, f.file).collections.stage(result.prepared!);
  });
  const current = readSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  assert.equal(current.state, 'ready');
  if (current.state === 'ready') {
    assert.equal(current.isSourceContextVersion(f.versionIds[0]!), false);
    assert.equal(current.isSourceContextVersion(f.versionIds[1]!), false);
  }
});

test('closed metadata retag performs no original work and rejects misclassified candidate changes', async (t) => {
  const f = await fixture(t, 2);
  await prepareSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  const view = openIntakeCollectionEnvelope(f.db, f.file),
    operationId = randomUUID(),
    work = createIntakeFileWorkCounters();
  const result = await withIntakeFileWork(work, () =>
    prepareIntakeEnvelopeMutation(f.db, f.file, {
      reader: view,
      operationId,
      requestDigest: workflowHash(operationId),
      domainVersion: view.logical.domainVersion + 1,
      changes: [
        {
          op: 'set',
          record: view.child(view.root(), 'intake')!,
          field: 'fictionalLabel',
          jsonText: '"checked"',
        },
      ],
      prepareDerived: async (input) => {
        const affected = {
          candidateChanges: [],
          questionAddresses: [],
          reportGroupAddresses: [],
          proposalIds: [],
        };
        await assert.rejects(
          prepareSourceContextClassificationDerived(f.db, f.root, f.profileId, f.id, {
            ...input,
            impact: 'metadata',
            affected: { ...affected, proposalIds: ['fictional-invalid'] },
          }),
          /closed metadata/,
        );
        const prepared = await prepareSourceContextClassificationDerived(
          f.db,
          f.root,
          f.profileId,
          f.id,
          { ...input, impact: 'metadata', affected },
        );
        assert.equal(prepared.state, 'ready');
        if (prepared.state !== 'ready') return [];
        assert.equal(prepared.isSourceContextVersion(f.versionIds[0]!, { ...input.reader }), true);
        prepared.assertPublicationCurrent();
        return prepared.changes;
      },
    }),
  );
  assert.equal(work.reads, 0);
  assert.equal(work.candidateVersionHashCalls, 0);
  transaction(f.db, () => selectedEnvelopeStore(f.db, f.file).collections.stage(result.prepared!));
  const prepared = readSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  assert.equal(prepared.state, 'ready');
  if (prepared.state === 'ready')
    assert.equal(prepared.isSourceContextVersion(f.versionIds[0]!), true);
});

test('retained duplicate IDs include references from explicitly marked occurrences', async (t) => {
  const f = await fixture(t, 2, false, false, (d) => {
    const duplicate = structuredClone(d.workflow!.candidates[0]!);
    duplicate.id = 'fictional-duplicate';
    Object.assign(duplicate.versions[0]!, { sourceContext: { unknown: 'x'.repeat(32768) } });
    duplicate.versions[0]!.occurrences = [
      {
        proposalId: 'fictional-proposal-0',
        recordId: 'fictional-extra',
        batchId: null,
        locator: 'page 1',
      },
    ];
    d.workflow!.candidates.push(duplicate);
    d.workflow!.candidates[1]!.versions[0]!.occurrences = [
      {
        proposalId: 'fictional-proposal-1',
        recordId: 'fictional-noncontext',
        batchId: null,
        locator: 'page 2',
      },
    ];
  });
  const oracle = cachedSourceContextVersions(f.db, f.root, f.profileId, f.file, f.d),
    prepared = await prepareSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  assert.equal(prepared.state, 'ready');
  assert.equal(oracle.has(f.versionIds[0]!), true);
  if (prepared.state === 'ready')
    for (const id of f.versionIds)
      assert.equal(prepared.isSourceContextVersion(id), oracle.has(id));
});

test('incoming original witness is prepared before registration and publication refuses absent or changed rows', async (t) => {
  const f = await fixture(t, 1, false);
  await prepareSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  const bytes = f.bytes[0]!,
    parsed = validateJSONL(bytes),
    proposalId = 'fictional-new-proposal',
    path = f.paths.relativeRoot + '/sources/' + proposalId + '.jsonl',
    versionId = intakeCandidateVersionIdForRevision(parsed.entries![0]!, 'revision-1');
  assert.equal(versionId, f.versionIds[0]);
  writeFileSync(join(f.root, path), bytes);
  const incomingProposal = {
      id: proposalId,
      path,
      entries: parsed.entries!,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      sourceTextRevisionId: 'revision-1',
    },
    view = openIntakeCollectionEnvelope(f.db, f.file),
    intake = view.child(view.root(), 'intake')!,
    flow = view.child(intake, 'workflow')!,
    operationId = randomUUID(),
    work = createIntakeFileWorkCounters();
  let derived: PreparedSourceContextDerived | undefined;
  const result = await withIntakeFileWork(work, () =>
    prepareIntakeEnvelopeMutation(f.db, f.file, {
      reader: view,
      operationId,
      requestDigest: workflowHash(operationId),
      domainVersion: view.logical.domainVersion + 1,
      changes: [
        {
          op: 'append',
          record: intake,
          field: 'proposals',
          jsonText: JSON.stringify({ ...f.d.proposals[0], id: proposalId, fileId: proposalId }),
        },
        {
          op: 'append',
          record: flow,
          field: 'candidates',
          jsonText: JSON.stringify({
            id: 'fictional-new-candidate',
            envelopeId: 'fictional',
            sourceSystem: null,
            sourceRecordId: null,
            versions: [
              {
                id: versionId,
                status: 'pending',
                sourceContext: true,
                createdAt: '2026-01-02',
                occurrences: [
                  {
                    proposalId,
                    recordId: 'fictional-new-record',
                    batchId: null,
                    locator: 'page 2',
                  },
                ],
              },
            ],
          }),
        },
      ],
      prepareDerived: async (input) => {
        const candidate = input.reader.find(
            'candidate',
            input.reader.child(input.reader.child(input.reader.root(), 'intake')!, 'workflow')!,
            'fictional-new-candidate',
          )!,
          version = input.reader.find('version', candidate, versionId)!;
        derived = await prepareSourceContextClassificationDerived(f.db, f.root, f.profileId, f.id, {
          ...input,
          impact: 'proposal',
          incomingProposal,
          affected: {
            candidateChanges: [
              {
                candidateId: 'fictional-new-candidate',
                candidateVersionId: versionId,
                candidateAddress: input.reader.address(candidate),
                versionAddress: input.reader.address(version),
                kind: 'append',
              },
            ],
            proposalIds: [proposalId],
            questionAddresses: [],
            reportGroupAddresses: [],
          },
        });
        assert.equal(derived.state, 'ready');
        if (derived.state !== 'ready') return [];
        assert.equal(derived.isSourceContextVersion(versionId, { ...input.reader }), true);
        derived.assertCurrent();
        assert.throws(
          () => derived!.state === 'ready' && derived!.assertPublicationCurrent(),
          SourceContextClassificationPending,
        );
        return derived.changes;
      },
    }),
  );
  assert.equal(work.reads, 1);
  assert.equal(work.bufferHashCalls, 1);
  assert.ok(derived?.state === 'ready');
  const preparedDerived = derived;
  transaction(f.db, () => {
    registerIntakeFile(f.db, {
      id: proposalId,
      path,
      bytes,
      kind: 'intake_proposal',
      mimeType: 'application/jsonl',
      coverage: 'complete_response',
      details: { originalSourceFileId: f.id, validation: validationSummary(parsed) },
    });
    preparedDerived.assertPublicationCurrent();
    selectedEnvelopeStore(f.db, f.file).collections.stage(result.prepared!);
  });
  const current = readSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  assert.equal(current.state, 'ready');
  if (current.state !== 'ready') return;
  assert.equal(current.isSourceContextVersion(versionId), true);
  writeFileSync(join(f.root, path), Buffer.alloc(bytes.length, 32));
  assert.throws(
    () => current.isSourceContextVersion(versionId),
    SourceContextClassificationPending,
  );
});

test('explicit preparation refreshes changed validation eligibility, including a formerly negative source', async (t) => {
  const f = await fixture(t, 1);
  const initial = await prepareSelectedSourceContextClassification(f.db, f.root, f.profileId, f.id);
  assert.equal(initial.state, 'ready');
  if (initial.state !== 'ready') return;
  const sourceId = f.sourceIds[0]!,
    selected = f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(sourceId) as {
      details_json: string;
    },
    details = JSON.parse(selected.details_json);
  details.validation.valid = false;
  transaction(f.db, () =>
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(JSON.stringify(details), sourceId),
  );
  assert.throws(
    () => initial.isSourceContextVersion(f.versionIds[0]!),
    SourceContextClassificationPending,
  );
  const negative = await prepareSelectedSourceContextClassification(
    f.db,
    f.root,
    f.profileId,
    f.id,
  );
  assert.equal(negative.state, 'ready');
  if (negative.state === 'ready')
    assert.equal(negative.isSourceContextVersion(f.versionIds[0]!), false);
  details.validation.valid = true;
  transaction(f.db, () =>
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(JSON.stringify(details), sourceId),
  );
  const positive = await prepareSelectedSourceContextClassification(
    f.db,
    f.root,
    f.profileId,
    f.id,
  );
  assert.equal(positive.state, 'ready');
  if (positive.state === 'ready')
    assert.equal(positive.isSourceContextVersion(f.versionIds[0]!), true);
});
