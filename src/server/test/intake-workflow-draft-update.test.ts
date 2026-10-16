import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import {
  buildVerifiedWorkflowSummary,
  readVerifiedWorkflowSummary,
} from '../intake-workflow-state.ts';
import { prepareWorkflowDraftDerived } from '../intake-workflow-update.ts';
import { buildModelIntakeSectionIndexes } from '../intake-model-section-build.ts';
import { openCollectionModelIntakeBackend } from '../intake-model-collection-backend.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { workflowHash } from '../intake-workflow.ts';
import { schemaKey } from '../intake-envelope-schema.ts';

test('draft deltas preserve exact latest joins, historical resolutions, model entries and summary after cache loss', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-draft-delta-')),
    db = openDatabase(join(directory, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = { id: 'fictional-intake', kind: 'intake_original', sha256: 'a'.repeat(64) };
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: 'fictional.json',
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [
          {
            id: 'candidate',
            envelopeId: 'candidate',
            sourceSystem: null,
            sourceRecordId: null,
            versions: [
              {
                id: 'version',
                status: 'pending',
                createdAt: '2026-01-01',
                occurrences: [
                  {
                    proposalId: 'proposal',
                    recordId: 'record',
                    batchId: 'first',
                    locator: 'Fictional first',
                  },
                  {
                    proposalId: 'proposal',
                    recordId: 'record',
                    batchId: 'last',
                    locator: 'Fictional last',
                  },
                ],
              },
            ],
          },
        ],
        questions: [],
        decisions: [],
        plans: [],
        reviewDrafts: [],
      },
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(source.id, 'fictional.json', source.sha256, 0, source.kind, initial.detailsJson);
    createIntakeStateStorage(db, {
      profileId: 'fictional',
      intakeId: source.id,
      sourceHash: source.sha256,
    }).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, source);
  const options = { mappingVersion: 'mapping', isSourceContextVersion: () => false };
  await buildVerifiedWorkflowSummary(db, source, options);
  await buildModelIntakeSectionIndexes(db, source, options);
  const before = { ...intakeWorkCounters(db).warm };
  const mutate = async (n: number, disposition: string, issueId?: string, fail = false) => {
    const view = openIntakeCollectionEnvelope(db, source),
      flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
      candidate = view.find('candidate', flow, 'candidate')!,
      version = view.find('version', candidate, 'version')!;
    const operationId = randomUUID();
    const result = await prepareIntakeEnvelopeMutation(db, source, {
      reader: view,
      operationId,
      requestDigest: workflowHash(operationId),
      domainVersion: view.logical.domainVersion + 1,
      changes: [
        {
          op: 'append',
          record: flow,
          field: 'reviewDrafts',
          jsonText: JSON.stringify({
            id: 'draft' + n,
            candidateId: 'candidate',
            candidateVersionId: 'version',
            proposalId: 'proposal',
            recordId: 'record',
            disposition,
            mapping: { kind: 'observation' },
            resolutions: issueId ? [{ issueId, outcome: 'confirmed' }] : [],
          }),
        },
        ...(disposition === 'keep_original_only'
          ? [
              {
                op: 'append' as const,
                record: flow,
                field: 'decisions',
                jsonText: JSON.stringify({
                  id: 'decision' + n,
                  candidateId: 'candidate',
                  candidateVersionId: 'version',
                  action: 'keep_original_only',
                  mapping: {},
                }),
              },
              { op: 'set' as const, record: version, field: 'status', jsonText: '"kept_original"' },
            ]
          : []),
      ],
      async prepareDerived(derived) {
        const after = derived.reader,
          selectedFlow = after.child(after.child(after.root(), 'intake')!, 'workflow')!,
          draft = after.childAt(selectedFlow, 'reviewDrafts', n - 1)!;
        const effects = await prepareWorkflowDraftDerived(db, source, {
          ...derived,
          ...options,
          affected: {
            candidateChanges: [
              {
                candidateId: 'candidate',
                candidateVersionId: 'version',
                candidateAddress: view.address(candidate),
                versionAddress: view.address(version),
                kind: 'update',
              },
            ],
            questionAddresses: [],
            reportGroupAddresses: [],
            proposalIds: [],
          },
          draftAddresses: [after.address(draft)],
          decisionAddresses:
            disposition === 'keep_original_only'
              ? [after.address(after.childAt(selectedFlow, 'decisions', 0)!)]
              : [],
          resolutionChanges: issueId
            ? [
                {
                  candidateId: 'candidate',
                  candidateVersionId: 'version',
                  issueId,
                  resolutionAddress: after.address(after.childAt(draft, 'resolutions', 0)!),
                },
              ]
            : [],
          onCheckpoint() {
            if (fail) throw Error('Interrupted draft summary');
          },
        });
        assert.equal(effects.needsReview, disposition !== 'keep_original_only');
        return effects.changes;
      },
    });
    transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(result.prepared!));
  };
  await assert.rejects(mutate(1, 'review_later', 'issue-a', true), /Interrupted draft summary/);
  assert.equal(readVerifiedWorkflowSummary(db, source, options).counts?.reviewLaterCount, 0);
  await mutate(1, 'review_later', 'issue-a');
  assert.equal(readVerifiedWorkflowSummary(db, source, options).counts?.reviewLaterCount, 1);
  await mutate(2, 'pending', 'issue-b');
  await mutate(3, 'keep_original_only');
  clearIntakeStateCache(db);
  const view = openIntakeCollectionEnvelope(db, source),
    flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
  assert.equal(
    view.address(view.lookup('draft-version-last', ['version'])!),
    view.address(view.childAt(flow, 'reviewDrafts', 2)!),
  );
  assert.equal(
    view.address(view.lookup('draft-candidate-version-last', ['"candidate"', 'version'])!),
    view.address(view.childAt(flow, 'reviewDrafts', 2)!),
  );
  const candidate = view.find('candidate', flow, 'candidate')!,
    version = view.find('version', candidate, 'version')!;
  assert.equal(
    view.address(
      view.lookup('version-occurrence-last', [view.address(version), '"proposal"', 'record'])!,
    ),
    view.address(view.childAt(version, 'occurrences', 1)!),
  );
  assert.equal(
    view.address(view.lookup('draft-record-version-last', ['proposal', 'record', 'version'])!),
    view.address(view.childAt(flow, 'reviewDrafts', 2)!),
  );
  assert.equal(
    view.field(view.lookup('resolution-last', ['"candidate"', 'version', 'issue-a'])!, 'issueId', {
      bytes: 100,
    }).kind,
    'value',
  );
  assert.equal(
    view.field(view.lookup('resolution-last', ['"candidate"', 'version', 'issue-b'])!, 'issueId', {
      bytes: 100,
    }).kind,
    'value',
  );
  assert.equal(readVerifiedWorkflowSummary(db, source, options).counts?.needsReview, false);
  const decisions = openCollectionModelIntakeBackend(db, source, options).section('decisions');
  assert.equal(decisions.state, 'complete');
  if (decisions.state !== 'complete') throw Error('Draft model history is unavailable');
  assert.equal(decisions.count, 4);
  assert.equal(
    (
      await buildModelIntakeSectionIndexes(db, source, {
        ...options,
        onCheckpoint() {
          throw Error('Rebuilt warm model history');
        },
      })
    ).reused,
    true,
  );
  for (const key of ['materializationReads', 'sourceDTOHydrations', 'envelopeHydrations'] as const)
    assert.equal(intakeWorkCounters(db).warm[key], before[key]);
  // A previous persisted semantic grammar is never accepted as a complete
  // negative result for a newly introduced lookup.
  const collections = selectedEnvelopeStore(db, source).collections,
    operationId = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId,
      requestDigest: workflowHash(operationId),
      domainVersion: view.logical.domainVersion,
      changes: [
        {
          area: 'builds',
          collection: 'envelope.indexes',
          op: 'put',
          key: 'policy',
          value: 'health-intake-workflow-index-v1',
        },
        {
          area: 'builds',
          collection: 'envelope.indexes',
          op: 'delete',
          key: schemaKey('draft-record-version-last', 'proposal', 'record', 'version'),
        },
      ],
    }),
  );
  assert.throws(
    () => view.lookup('draft-record-version-last', ['proposal', 'record', 'version']),
    /indexes.*(complete|available)/,
  );
  assert.notEqual((await buildVerifiedWorkflowSummary(db, source, options)).reused, true);
  assert.equal(
    view.address(view.lookup('draft-record-version-last', ['proposal', 'record', 'version'])!),
    view.address(view.childAt(flow, 'reviewDrafts', 2)!),
  );
});
