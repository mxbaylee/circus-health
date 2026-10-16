import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
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
import { prepareWorkflowProposalDerived } from '../intake-workflow-update.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

// Host-only closure of 65 questions beside 65 unrelated versions, including
// cancellation, atomic publication and cache loss; no model request is timed.
test(
  'proposal closure updates off-page latest-version questions, preserves unrelated history, and publishes counts atomically',
  { timeout: 180_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'fictional-workflow-delta-'));
    const db = openDatabase(join(directory, 'cache.sqlite'), 'fictional');
    memoryRecordAuthority(db);
    t.after(() => {
      clearIntakeStateCache(db);
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const source = { id: 'fictional-intake', kind: 'intake_original', sha256: 'e'.repeat(64) };
    const candidate = (id: string, count: number) => ({
      id,
      envelopeId: id,
      sourceSystem: null,
      sourceRecordId: null,
      versions: Array.from({ length: count }, (_, i) => ({
        id: id + '-v' + i,
        status: 'accepted',
        createdAt: '2026-01-01',
        occurrences: [],
      })),
    });
    const unrelated = candidate('unrelated', 65);
    Object.assign(unrelated.versions[0]!, { id: 'changed-new', sourceContext: true });
    const body = {
      intake: {
        version: 1,
        originalName: 'fictional.json',
        workflow: {
          format: 'health-intake-workflow-v1',
          candidates: [candidate('changed', 1), unrelated],
          questions: Array.from({ length: 65 }, (_, i) => ({
            id: 'q' + i,
            key: 'q' + i,
            candidateId: 'changed',
            candidateVersionId: null,
            prompt: 'Verify measurement',
            locator: '',
            field: null,
            status: 'resolved',
            resolvedByDecisionId: 'old-decision',
            createdAt: '2026-01-01',
            answers: [],
          })),
          decisions: [
            {
              id: 'old-decision',
              candidateId: 'changed',
              candidateVersionId: 'changed-v0',
              action: 'accept',
              mapping: {},
            },
          ],
          plans: [],
          reviewDrafts: [],
        },
      },
    };
    const initial = prepareInitialIntakeEnvelope(body);
    const storage = createIntakeStateStorage(db, {
      profileId: 'fictional',
      intakeId: source.id,
      sourceHash: source.sha256,
    });
    transaction(db, () => {
      db.prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      ).run(source.id, 'fictional.json', source.sha256, 0, source.kind, initial.detailsJson);
      storage.stage(initial.state, randomUUID());
    });
    await buildIntakeCollectionEnvelope(db, source);
    const options = { mappingVersion: 'mapping', isSourceContextVersion: () => false };
    await buildVerifiedWorkflowSummary(db, source, options);
    assert.equal(readVerifiedWorkflowSummary(db, source, options).counts?.unansweredCount, 0);
    const warmBefore = { ...intakeWorkCounters(db).warm };
    const prepare = async (append: boolean, interrupt = false) => {
      const view = openIntakeCollectionEnvelope(db, source),
        intake = view.child(view.root(), 'intake')!,
        flow = view.child(intake, 'workflow')!;
      const c = view.find('candidate', flow, 'changed')!;
      const operationId = randomUUID();
      const inspected = new Set<string>();
      const result = await prepareIntakeEnvelopeMutation(db, source, {
        reader: view,
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: view.logical.domainVersion + 1,
        changes: append
          ? [
              {
                op: 'append',
                record: c,
                field: 'versions',
                jsonText: JSON.stringify({
                  id: 'changed-new',
                  status: 'pending',
                  createdAt: '2026-01-02',
                  occurrences: [],
                }),
              },
            ]
          : [
              {
                op: 'set',
                record: view.find('version', c, 'changed-new')!,
                field: 'sourceContext',
                jsonText: 'true',
              },
            ],
        prepareDerived: async (derived) => {
          const c = derived.reader.find(
            'candidate',
            derived.reader.child(
              derived.reader.child(derived.reader.root(), 'intake')!,
              'workflow',
            )!,
            'changed',
          )!;
          const v = derived.reader.find('version', c, 'changed-new')!;
          return prepareWorkflowProposalDerived(db, source, {
            ...derived,
            mappingVersion: options.mappingVersion,
            affected: {
              candidateChanges: [
                {
                  candidateId: 'changed',
                  candidateVersionId: 'changed-new',
                  candidateAddress: derived.reader.address(c),
                  versionAddress: derived.reader.address(v),
                  kind: append ? 'append' : 'update',
                },
              ],
              questionAddresses: [],
              reportGroupAddresses: [],
              proposalIds: [],
            },
            isSourceContextVersion(id) {
              inspected.add(id);
              return false;
            },
            onCheckpoint() {
              if (interrupt) throw Error('fictional interrupted closure');
            },
          });
        },
      });
      assert.deepEqual([...inspected], append ? ['changed-new'] : []);
      return result;
    };
    const result = await prepare(true);
    assert.ok(result.prepared);
    // Preparing auxiliary closure work leaves the selected domain and counts unchanged.
    assert.equal(readVerifiedWorkflowSummary(db, source, options).counts?.unansweredCount, 0);
    transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(result.prepared!));
    clearIntakeStateCache(db);
    const selected = openIntakeCollectionEnvelope(db, source);
    const selectedFlow = selected.child(selected.child(selected.root(), 'intake')!, 'workflow')!;
    const retainedLast = selected.find(
      'version',
      selected.find('candidate', selectedFlow, 'unrelated')!,
      'changed-new',
    )!;
    assert.equal(
      selected.address(selected.lookup('workflow-version-last', ['changed-new'])!),
      selected.address(retainedLast),
    );
    assert.deepEqual(readVerifiedWorkflowSummary(db, source, options).counts, {
      needsReview: true,
      pendingCount: 1,
      unansweredCount: 65,
      pendingWorkCount: 0,
      reviewLaterCount: 0,
    });
    await assert.rejects(prepare(false, true), /fictional interrupted closure/);
    clearIntakeStateCache(db);
    assert.equal(readVerifiedWorkflowSummary(db, source, options).counts?.unansweredCount, 65);
    const updated = await prepare(false);
    transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(updated.prepared!));
    assert.deepEqual(readVerifiedWorkflowSummary(db, source, options).counts, {
      needsReview: false,
      pendingCount: 0,
      unansweredCount: 0,
      pendingWorkCount: 0,
      reviewLaterCount: 0,
    });
    const warmAfter = intakeWorkCounters(db).warm;
    for (const name of [
      'materializationReads',
      'sourceDTOHydrations',
      'envelopeHydrations',
    ] as const)
      assert.equal(warmAfter[name], warmBefore[name]);
  },
);
