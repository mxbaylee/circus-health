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
  type IntakeCollectionEnvelopeReader,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import {
  buildVerifiedWorkflowSummary,
  readVerifiedWorkflowSummary,
  openSelectedAcceptedDestinations,
} from '../intake-workflow-state.ts';
import {
  consumeWorkflowReceiptAppendProof,
  prepareWorkflowAcceptanceDerived,
} from '../intake-workflow-update.ts';
import { createNativeAcceptanceEffects } from '../intake-collection-acceptance.ts';
import { buildModelIntakeSectionIndexes } from '../intake-model-section-build.ts';
import { openCollectionModelIntakeBackend } from '../intake-model-collection-backend.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

for (const coupled of [false, true])
  test(`acceptance deltas retain historical destinations, exact scoped precedence and off-page version dependencies${coupled ? ' across coupled receipt blocks' : ''}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'fictional-acceptance-delta-'));
    const db = openDatabase(join(directory, 'cache.sqlite'), 'fictional');
    memoryRecordAuthority(db);
    t.after(() => {
      clearIntakeStateCache(db);
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const source = { id: 'fictional-intake', kind: 'intake_original', sha256: 'c'.repeat(64) };
    const receipt = (recordId: string, entityId: string, groupId?: string) => ({
      recordId,
      entityId,
      ...(groupId ? { identityAttribution: { groupId } } : {}),
    });
    const initial = prepareInitialIntakeEnvelope({
      intake: {
        version: 1,
        acceptedProposalId: 'p',
        imported: {
          clinical: { records: [receipt('r', 'old-unscoped'), receipt('old', 'old-only')] },
        },
        importHistory: [],
        proposals: [],
        workflow: {
          format: 'health-intake-workflow-v1',
          plans: [],
          decisions: [],
          reviewDrafts: [],
          operations: [],
          candidates: [
            {
              id: 'chosen',
              envelopeId: 'chosen',
              sourceSystem: null,
              sourceRecordId: null,
              versions: [
                { id: 'shared-v', status: 'pending', createdAt: '2026-01-01', occurrences: [] },
              ],
            },
            {
              id: 'other',
              envelopeId: 'other',
              sourceSystem: null,
              sourceRecordId: null,
              versions: [
                {
                  id: 'shared-v',
                  status: 'pending',
                  createdAt: '2026-01-01',
                  sourceContext: true,
                  occurrences: [],
                },
              ],
            },
          ],
          questions: [
            {
              id: 'q',
              key: 'q',
              createdAt: '2026-01-01',
              locator: 'Fictional source',
              candidateId: 'chosen',
              candidateVersionId: 'shared-v',
              prompt: 'Confirm result',
              field: null,
              status: 'unanswered',
              answers: [],
            },
          ],
        },
      },
    });
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
    await buildModelIntakeSectionIndexes(db, source, options);
    const baseline = { ...intakeWorkCounters(db).warm };
    const view = openIntakeCollectionEnvelope(db, source),
      intake = view.child(view.root(), 'intake')!,
      flow = view.child(intake, 'workflow')!,
      c = view.find('candidate', flow, 'chosen')!,
      v = view.find('version', c, 'shared-v')!,
      q = view.find('question', flow, 'q')!;
    const effects = createNativeAcceptanceEffects(),
      operationId = randomUUID();
    effects.archivedImportAddress = view.address(view.child(intake, 'imported')!);
    effects.archivedImportAddresses.push(effects.archivedImportAddress);
    effects.candidateChanges.push({
      candidateId: 'chosen',
      candidateVersionId: 'shared-v',
      candidateAddress: view.address(c),
      versionAddress: view.address(v),
      kind: 'update',
    });
    effects.questionAddresses.push(view.address(q));
    let needsReview: boolean | undefined;
    let appendProof: object | undefined;
    let appendReader: IntakeCollectionEnvelopeReader | undefined;
    let appendLogical: string | undefined;
    const prepared = await prepareIntakeEnvelopeMutation(db, source, {
      reader: view,
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 2,
      *changes(staged) {
        const current = staged.resolve(view.address(intake)),
          workflow = staged.resolve(view.address(flow));
        yield {
          op: 'set' as const,
          record: staged.resolve(view.address(v)),
          field: 'status',
          jsonText: '"accepted"',
        };
        yield {
          op: 'set' as const,
          record: staged.resolve(view.address(q)),
          field: 'status',
          jsonText: '"resolved"',
        };
        yield {
          op: 'append' as const,
          record: workflow,
          field: 'decisions',
          jsonText: JSON.stringify({
            id: 'accept',
            candidateId: 'chosen',
            candidateVersionId: 'shared-v',
            action: 'accept',
            mapping: { kind: 'observation' },
          }),
        };
        effects.decisionAddresses.push(
          staged.address(staged.find('decision', workflow, 'accept')!),
        );
        yield {
          op: 'archive-current-import' as const,
          record: current,
          acceptedProposalId: 'p',
          reviewToken: 'old-token',
        };
        if (coupled) {
          yield {
            op: 'set' as const,
            record: current,
            field: 'imported',
            jsonText: JSON.stringify({
              clinical: {
                records: [
                  receipt('r', 'middle-a', 'a'),
                  receipt('r', 'middle-c', 'c'),
                  receipt('middle', 'middle-only'),
                ],
              },
            }),
          };
          const middle = staged.child(current, 'imported')!;
          const clinical = staged.child(middle, 'clinical')!;
          effects.importedReceiptAddresses.push(staged.address(middle));
          effects.archivedImportAddresses.push(staged.address(middle));
          for (let i = 0; i < 3; i++)
            effects.acceptedRecordAddresses.push(
              staged.address(staged.childAt(clinical, 'records', i)!),
            );
          yield {
            op: 'archive-current-import' as const,
            record: current,
            acceptedProposalId: 'p',
            reviewToken: 'middle-token',
          };
        }
        yield {
          op: 'set' as const,
          record: current,
          field: 'imported',
          jsonText: JSON.stringify({
            clinical: { records: [receipt('r', 'new-a', 'a'), receipt('r', 'new-b', 'b')] },
          }),
        };
        const imported = staged.child(current, 'imported')!,
          clinical = staged.child(imported, 'clinical')!;
        effects.importedAddress = staged.address(imported);
        effects.importedReceiptAddresses.push(effects.importedAddress);
        for (let i = 0; i < 2; i++)
          effects.acceptedRecordAddresses.push(
            staged.address(staged.childAt(clinical, 'records', i)!),
          );
      },
      async prepareDerived(derived) {
        const result = await prepareWorkflowAcceptanceDerived(db, source, {
          ...derived,
          ...options,
          acceptance: effects,
          affected: {
            candidateChanges: [],
            questionAddresses: [],
            reportGroupAddresses: [],
            proposalIds: [],
          },
        });
        needsReview = result.needsReview;
        if (!coupled) {
          appendProof = result.receiptAppend;
          appendReader = derived.reader;
          appendLogical = JSON.stringify(derived.logical);
        }
        return result.changes;
      },
    });
    if (!coupled) {
      assert.ok(appendProof && appendReader && appendLogical);
      const oldLogical = JSON.stringify(view.logical);
      assert.equal(
        consumeWorkflowReceiptAppendProof(
          appendProof,
          db,
          { ...source, id: 'fictional-other' },
          appendReader,
          oldLogical,
          appendLogical,
        ),
        undefined,
      );
      assert.equal(
        consumeWorkflowReceiptAppendProof(appendProof, db, source, view, oldLogical, appendLogical),
        undefined,
      );
      assert.equal(
        consumeWorkflowReceiptAppendProof(
          appendProof,
          db,
          source,
          appendReader,
          oldLogical,
          oldLogical,
        ),
        undefined,
      );
      assert.deepEqual(
        consumeWorkflowReceiptAppendProof(
          appendProof,
          db,
          source,
          appendReader,
          oldLogical,
          appendLogical,
        ),
        [],
      );
      assert.equal(
        consumeWorkflowReceiptAppendProof(
          appendProof,
          db,
          source,
          appendReader,
          oldLogical,
          appendLogical,
        ),
        undefined,
      );
    }
    assert.equal(
      needsReview,
      true,
      'accepting a clinical shared version activates the other retained occurrence',
    );
    assert.equal(readVerifiedWorkflowSummary(db, source, options).counts?.unansweredCount, 0);
    transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(prepared.prepared!));
    clearIntakeStateCache(db);
    assert.deepEqual(readVerifiedWorkflowSummary(db, source, options).counts, {
      needsReview: true,
      pendingCount: 1,
      unansweredCount: 0,
      pendingWorkCount: 0,
      reviewLaterCount: 0,
    });
    const destinations = openSelectedAcceptedDestinations(db, source);
    const destination = (group: string, record = 'r') => {
      const item = destinations.select('p', group, record)!;
      const value = destinations.view.field(item, 'entityId', { bytes: 256 });
      return value.kind === 'value' ? value.value : undefined;
    };
    assert.equal(destination('a'), 'new-a');
    assert.equal(destination('b'), 'new-b');
    assert.equal(destination('c'), coupled ? 'middle-c' : 'old-unscoped');
    if (coupled) assert.equal(destination('a', 'middle'), 'middle-only');
    assert.equal(destination('a', 'old'), 'old-only');
    const model = openCollectionModelIntakeBackend(db, source, options);
    assert.deepEqual(model.section('acceptances'), {
      state: 'complete',
      root: model.sectionPage('acceptances', { items: 8, bytes: 12000 }).root,
      count: coupled ? 3 : 2,
    });
    assert.equal((await buildModelIntakeSectionIndexes(db, source, options)).reused, true);
    for (const name of [
      'materializationReads',
      'sourceDTOHydrations',
      'envelopeHydrations',
    ] as const)
      assert.equal(intakeWorkCounters(db).warm[name], baseline[name]);
  });
