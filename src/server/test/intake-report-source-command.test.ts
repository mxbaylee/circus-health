import { readNativeReportSourceScopeFragment } from '../intake-report-source-review.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { captureReportRoutingScratch } from './helpers/report-routing-scratch.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { migrateReportMemberSnapshot } from '../intake-report-member-migration.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { readNativeReportSourceReceipt } from '../intake-report-source-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { prepareNativeReportSourceReviewScope } from '../intake-report-source-review-scope.ts';
import { prepareNativeReportSourceCommand } from '../intake-report-source-command.ts';
import {
  intakeReportSourceReviewScope,
  intakeReportSourceScope,
  priorIntakeReportSourceExtensions,
} from '../intake-report-source.ts';
import {
  resolveNativeReportSource,
  hasHistoricalReportSourceProvider,
} from '../intake-report-source-resolution.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { workflowHash } from '../intake-workflow.ts';
import type { IntakeWorkflow, IntakeReportSourceConfirmation } from '../../shared/intake.ts';

async function fixture(
  t: { after(fn: () => void): void },
  occurrenceCount = 2,
  configure?: (workflow: IntakeWorkflow) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-command-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const identity = {
      profileId: 'fictional',
      intakeId: 'fictional-original',
      sourceHash: 'c'.repeat(64),
    },
    occurrence = (recordId: string) => ({
      proposalId: 'proposal',
      recordId,
      batchId: 'batch',
      locator: recordId === 'one' ? '🌿'.repeat(18000) : 'page two',
    }),
    members = [
      {
        candidateId: 'candidate',
        candidateVersionId: 'version',
        occurrences:
          occurrenceCount === 2
            ? [occurrence('one'), occurrence('two')]
            : Array.from({ length: occurrenceCount }, (_, i) => occurrence('fictional-' + i)),
      },
    ];
  const context = {
      status: 'linked',
      contextId: 'context',
      sourceSuggestion: { value: '  Fictional source  ', unknown: 'retained' },
      unknown: occurrenceCount === 2 ? '🌺'.repeat(5000) : 'retained',
    },
    base = { contributionId: 'contribution', createdAt: '2026-01-01', context, members };
  const group = {
    id: 'group',
    basis: 'report_anchor',
    sourceFileId: identity.intakeId,
    sourceHash: identity.sourceHash,
    sourceSystem: null,
    memberId: null,
    report: { anchor: { text: 'Fictional report' }, subject: null },
    versions: [
      { ...base, id: 'old', members: [members[0], members[0]] },
      { ...base, id: 'current' },
    ],
  };
  const workflow = {
    format: 'health-intake-workflow-v1',
    questions: [],
    plans: [],
    operations: [],
    reportSourceConfirmations: [],
    decisions: [],
    reviewDrafts: [
      {
        id: 'draft',
        at: '2026-01-01',
        resolutions: [],
        candidateId: 'candidate',
        candidateVersionId: 'version',
        proposalId: 'proposal',
        recordId: 'two',
        disposition: 'review_later',
      },
    ],
    reportGroups: [group],
    candidates: [
      {
        id: 'candidate',
        envelopeId: 'envelope',
        sourceSystem: null,
        sourceRecordId: null,
        versions: [
          {
            id: 'version',
            createdAt: '2026-01-01',
            status: 'pending',
            occurrences: members[0]!.occurrences,
          },
        ],
      },
    ],
  } as unknown as IntakeWorkflow;
  configure?.(workflow);
  const initial = prepareInitialIntakeEnvelope({ intake: { version: 1, workflow } });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.pdf',
      identity.sourceHash,
      0,
      'intake_original',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  const source = { id: identity.intakeId, sha256: identity.sourceHash };
  await buildIntakeCollectionEnvelope(db, source);
  await buildVerifiedWorkflowSummary(db, source, {
    mappingVersion: 'fictional',
    isSourceContextVersion: () => false,
  });
  return { db, source, identity, workflow, group: workflow.reportGroups![0]! };
}
for (const basis of ['manual_report_label', 'explicit_current_members'] as const)
  test(
    'native source command preserves ' + basis + ' receipt, exact retry and complete logical hash',
    { timeout: 60_000 },
    async (t) => {
      const f = await fixture(t),
        options = { profileId: f.identity.profileId, createdAt: '2026-02-01' };
      let scopeToken: string | undefined;
      if (basis === 'explicit_current_members') {
        const catalog = createReportSnapshotCatalog(f.db, f.source),
          reader = openIntakeCollectionEnvelope(f.db, f.source),
          group = reader.find(
            'reportGroup',
            reader.child(reader.child(reader.root(), 'intake')!, 'workflow')!,
            f.group.id,
          )!;
        const nativeVersions = [];
        for (let ordinal = 0; ordinal < 2; ordinal++) {
          const record = reader.childAt(group, 'versions', ordinal)!;
          const members = await migrateReportMemberSnapshot(
            catalog,
            reader,
            record,
            'fixture-members-' + ordinal,
          );
          nativeVersions.push({
            ...f.group.versions[ordinal],
            format: 'health-intake-report-group-version-v2',
            members,
          });
        }
        const nativeGroup = { ...f.group, id: 'native-group', versions: nativeVersions };
        const migrated = await prepareIntakeEnvelopeMutation(f.db, f.source, {
          reader,
          operationId: randomUUID(),
          requestDigest: 'd'.repeat(64),
          domainVersion: 1,
          additionalLogicalChanges: () => catalog.finalChanges(),
          *changes(view) {
            yield {
              op: 'append',
              record: view.child(view.child(view.root(), 'intake')!, 'workflow')!,
              field: 'reportGroups',
              jsonText: JSON.stringify(nativeGroup),
            };
          },
        });
        transaction(f.db, () =>
          createIntakeStateStorage(f.db, f.identity).collections.stage(migrated.prepared!),
        );
        f.group = { ...f.group, id: 'native-group' };
        f.workflow.reportGroups!.push(f.group);
        await buildVerifiedWorkflowSummary(f.db, f.source, {
          mappingVersion: 'fictional',
          isSourceContextVersion: () => false,
        });
        for (const view of ['active', 'deferred', 'all'] as const) {
          const expected = intakeReportSourceReviewScope(
            f.workflow,
            f.identity.profileId,
            f.source.id,
            f.group.id,
            view,
          )!;
          const actual = await prepareNativeReportSourceReviewScope(f.db, f.source, {
            profileId: f.identity.profileId,
            groupId: f.group.id,
            view,
          });
          try {
            assert.equal(actual.scopeToken, expected.scopeToken);
            assert.equal(actual.entryCount, expected.entries.length);
            assert.deepEqual(
              [...actual.entries()].map((entry) =>
                JSON.parse([...actual.entryPieces(entry)].join('')),
              ),
              expected.entries,
            );
            assert.deepEqual(
              [...actual.sourceEvidence()].map((parts) => JSON.parse([...parts].join(''))),
              expected.sourceEvidence,
            );
            if (view === 'all') {
              scopeToken = actual.scopeToken;
              const entry = [...actual.entries()].find((entry) => entry.recordId === 'one')!;
              const reference = {
                format: 'health-intake-report-source-scope-fragment-v1' as const,
                intakeId: f.source.id,
                groupId: f.group.id,
                view,
                scopeToken: actual.scopeToken,
                section: 'target' as const,
                ordinal: entry.ordinal,
              };
              const fragment = await readNativeReportSourceScopeFragment(
                f.db,
                f.identity.profileId,
                f.source,
                { ...reference, offset: 0, limit: 127 },
              );
              assert.equal(Buffer.byteLength(fragment.text), fragment.nextOffset);
              assert.equal([...actual.entryPieces(entry)].join('').startsWith(fragment.text), true);
              const whole = [...actual.entryPieces(entry)].join(''),
                flower = Buffer.byteLength(whole.slice(0, whole.indexOf('🌿')));
              const scalarFragment = await readNativeReportSourceScopeFragment(
                f.db,
                f.identity.profileId,
                f.source,
                { ...reference, offset: flower, limit: 5 },
              );
              assert.equal(scalarFragment.text, '🌿');
              assert.equal(scalarFragment.nextOffset, flower + 4);
              await assert.rejects(
                () =>
                  readNativeReportSourceScopeFragment(f.db, f.identity.profileId, f.source, {
                    ...reference,
                    offset: flower + 1,
                    limit: 5,
                  }),
                /text boundary/,
              );
              const expectedLabel = JSON.stringify(expected.sourceEvidence[0]);
              const evidence = await readNativeReportSourceScopeFragment(
                f.db,
                f.identity.profileId,
                f.source,
                { ...reference, section: 'sourceEvidence', ordinal: 0, offset: 0, limit: 32768 },
              );
              assert.equal(evidence.text, expectedLabel);
              assert.equal(evidence.complete, true);
            }
          } finally {
            actual.close();
          }
        }
      }
      const input = {
        version: 1,
        operationId: 'operation',
        groupId: f.group.id,
        groupVersionId: 'current',
        contextId: 'current',
        source: 'Fictional chosen source',
        basis,
        ...(basis === 'explicit_current_members' ? { scopeToken, view: 'all' as const } : {}),
      };
      const prepared = await prepareNativeReportSourceCommand(f.db, f.source, input, options);
      assert.equal(prepared.replayed, false);
      if (prepared.replayed) return;
      assert.equal(
        JSON.parse([...iterateIntakeEnvelopeText(f.db, f.source)].join('')).intake.workflow
          .reportSourceConfirmations.length,
        0,
      );
      transaction(f.db, () => {
        prepared.assertCurrent();
        if (prepared.provider.create)
          f.db
            .prepare('INSERT INTO providers(id,name) VALUES(?,?)')
            .run(prepared.provider.id, prepared.provider.name);
        createIntakeStateStorage(f.db, f.identity).collections.stage(prepared.prepared);
      });
      const expectedScope =
        basis === 'explicit_current_members'
          ? intakeReportSourceReviewScope(
              f.workflow,
              f.identity.profileId,
              f.source.id,
              f.group.id,
              'all',
            )!
          : undefined;
      const members = [{ candidateId: 'candidate', candidateVersionId: 'version' }],
        scope = intakeReportSourceScope(f.group, f.group.versions.at(-1)!, basis),
        extensions =
          basis === 'explicit_current_members'
            ? []
            : priorIntakeReportSourceExtensions(
                f.group,
                f.group.versions.at(-1)!,
                basis,
                input.operationId,
                members,
                options.createdAt,
              );
      const expected: IntakeReportSourceConfirmation = {
        basis,
        operationId: input.operationId,
        groupId: input.groupId,
        groupVersionId: input.groupVersionId,
        contextId: input.contextId,
        source: prepared.provider.name,
        sourceProviderId: prepared.provider.id,
        members,
        ...(scope && basis !== 'explicit_current_members' ? { scope } : {}),
        ...(extensions.length ? { extensions } : {}),
        ...(expectedScope
          ? {
              scopeToken: expectedScope.scopeToken,
              view: 'all' as const,
              coverageEntries: expectedScope.entries.map((entry) => ({
                ...entry,
                id:
                  'report-source-coverage:' +
                  workflowHash([input.operationId, entry.id, entry.sourceRef]),
              })),
            }
          : {}),
        at: options.createdAt,
      };
      const request = {
        candidateId: 'candidate',
        candidateVersionId: 'version',
        references: () => [
          {
            groupId: f.group.id,
            groupVersionId: basis === 'manual_report_label' ? 'current' : 'old',
          },
        ],
        ...(basis === 'explicit_current_members'
          ? { occurrence: f.group.versions[0]!.members[0]!.occurrences[0]! }
          : {}),
      };
      const resolved = resolveNativeReportSource(f.db, f.source, request);
      assert.ok(resolved);
      assert.equal(
        resolved.confirmationHash,
        createHash('sha256').update(canonicalLiteral(expected)).digest('hex'),
      );
      assert.equal(
        readNativeReportSourceReceipt(f.db, f.source, input.operationId).operationId,
        input.operationId,
      );
      assert.equal(prepared.extensionCount, basis === 'manual_report_label' ? 1 : 0);
      assert.equal(
        hasHistoricalReportSourceProvider(f.db, f.source, request, prepared.provider.id),
        true,
      );
      assert.equal(
        hasHistoricalReportSourceProvider(f.db, f.source, request, 'absent-provider'),
        false,
      );
      assert.deepEqual(
        await prepareNativeReportSourceCommand(
          f.db,
          f.source,
          { ...input, version: -100 },
          options,
        ),
        { replayed: true },
      );
      await assert.rejects(
        () =>
          prepareNativeReportSourceCommand(
            f.db,
            f.source,
            { ...input, source: 'different', version: -100 },
            options,
          ),
        /different request/,
      );
      if (basis === 'manual_report_label') {
        await buildVerifiedWorkflowSummary(f.db, f.source, {
          mappingVersion: 'fictional',
          isSourceContextVersion: () => false,
        });
        const second = await prepareNativeReportSourceCommand(
          f.db,
          f.source,
          {
            ...input,
            version: 2,
            operationId: 'second-operation',
            source: 'Another fictional source',
          },
          options,
        );
        assert.equal(second.replayed, false);
        if (second.replayed) return;
        transaction(f.db, () => {
          second.assertCurrent();
          if (second.provider.create)
            f.db
              .prepare('INSERT INTO providers(id,name) VALUES(?,?)')
              .run(second.provider.id, second.provider.name);
          createIntakeStateStorage(f.db, f.identity).collections.stage(second.prepared);
        });
        assert.equal(
          resolveNativeReportSource(f.db, f.source, request)!.confirmation.sourceProviderId,
          second.provider.id,
        );
        assert.equal(
          hasHistoricalReportSourceProvider(f.db, f.source, request, prepared.provider.id),
          true,
        );
      }
    },
  );

test(
  'source scope externally merges more than one bounded sort run and counts actual scratch work',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, 5),
      expected = intakeReportSourceReviewScope(
        f.workflow,
        f.identity.profileId,
        f.source.id,
        f.group.id,
        'all',
      )!,
      actual = await prepareNativeReportSourceReviewScope(
        f.db,
        f.source,
        {
          profileId: f.identity.profileId,
          groupId: f.group.id,
          view: 'all',
        },
        { sortItems: 2 },
      );
    try {
      assert.equal(actual.scopeToken, expected.scopeToken);
      assert.equal(actual.entryCount, 5);
      const work = intakeWorkCounters(f.db).warm;
      assert.ok(work.reportSourceScopeMembers > 0);
      assert.ok(work.reportSourceScopeOccurrences >= 5);
      assert.ok(work.reportSourceScopeSortComparisons >= 5);
      assert.ok(work.reportSourceScopeScratchReadBytes > 0);
      assert.ok(work.reportSourceScopeScratchWrittenBytes > 0);
    } finally {
      actual.close();
    }
  },
);

test(
  'source routing scans complete history once for all selected-root report scopes',
  { timeout: 30_000 },
  async (t) => {
    const routing = captureReportRoutingScratch(t);
    const f = await fixture(t, 3, (workflow) => {
      const first = workflow.reportGroups![0]!;
      for (let index = 1; index <= 2; index++)
        workflow.reportGroups!.push({ ...first, id: 'anchored-' + index });
      // Later fallback must not steal an anchored member, including on a warm lookup.
      workflow.reportGroups!.push({ ...first, id: 'last-fallback', basis: 'candidate_fallback' });
      workflow.reviewDrafts!.push({
        ...workflow.reviewDrafts![0]!,
        id: 'latest-draft',
        recordId: 'fictional-2',
        disposition: 'review_later',
      });
    });
    for (const group of f.workflow.reportGroups!.filter(
      (group) => group.basis === 'report_anchor',
    )) {
      for (const view of ['active', 'deferred', 'all'] as const) {
        const expected = intakeReportSourceReviewScope(
          f.workflow,
          f.identity.profileId,
          f.source.id,
          group.id,
          view,
        )!;
        const actual = await prepareNativeReportSourceReviewScope(f.db, f.source, {
          profileId: f.identity.profileId,
          groupId: group.id,
          view,
        });
        try {
          assert.equal(actual.scopeToken, expected.scopeToken);
          assert.equal(actual.entryCount, expected.entries.length);
          assert.deepEqual(
            [...actual.entries()].map((entry) =>
              JSON.parse([...actual.entryPieces(entry)].join('')),
            ),
            expected.entries,
          );
        } finally {
          actual.close();
        }
      }
    }
    const work = intakeWorkCounters(f.db).warm;
    assert.equal(work.reportSourceScopeRoutingBuilds, 1);
    assert.equal(work.reportSourceScopeRoutingReuses, 8);
    assert.equal(
      work.reportSourceScopeRoutingRows,
      14,
      'all 12 historical owner members and both drafts were read exactly once',
    );
    await assert.rejects(
      () =>
        prepareNativeReportSourceReviewScope(f.db, f.source, {
          profileId: 'another-profile',
          groupId: 'anchored-2',
          view: 'all',
        }),
      /owning profile/,
    );
    // Damaged derived rows are never trusted as authoritative absence.
    routing().prepare('DELETE FROM __report_source_routing_owners WHERE source=?').run(f.source.id);
    const rebuilt = await prepareNativeReportSourceReviewScope(f.db, f.source, {
      profileId: f.identity.profileId,
      groupId: 'anchored-2',
      view: 'all',
    });
    try {
      assert.equal(rebuilt.entryCount, 3);
    } finally {
      rebuilt.close();
    }
    assert.equal(intakeWorkCounters(f.db).warm.reportSourceScopeRoutingBuilds, 2);
    routing().exec('DROP TABLE __report_source_routing_owners');
    const recovered = await prepareNativeReportSourceReviewScope(f.db, f.source, {
      profileId: f.identity.profileId,
      groupId: 'anchored-2',
      view: 'all',
    });
    try {
      assert.equal(recovered.entryCount, 3);
    } finally {
      recovered.close();
    }
    assert.equal(intakeWorkCounters(f.db).warm.reportSourceScopeRoutingBuilds, 3);
  },
);

test(
  'cancelled source routing cannot certify a partial owner index and selected-root changes rebuild',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, 3);
    const input = { profileId: f.identity.profileId, groupId: f.group.id, view: 'all' as const };
    await assert.rejects(
      () =>
        prepareNativeReportSourceReviewScope(f.db, f.source, input, {
          assertRunning() {
            if (intakeWorkCounters(f.db).warm.reportSourceScopeRoutingRows > 0)
              throw Error('fictional cancellation');
          },
        }),
      /fictional cancellation/,
    );
    assert.equal(intakeWorkCounters(f.db).warm.reportSourceScopeRoutingBuilds, 0);
    const first = await prepareNativeReportSourceReviewScope(f.db, f.source, input);
    const before = first.scopeToken;
    const reader = openIntakeCollectionEnvelope(f.db, f.source),
      workflow = reader.child(reader.child(reader.root(), 'intake')!, 'workflow')!;
    const draft = {
      ...f.workflow.reviewDrafts![0]!,
      id: 'later',
      recordId: 'fictional-0',
      disposition: 'review_later' as const,
    };
    const mutation = await prepareIntakeEnvelopeMutation(f.db, f.source, {
      reader,
      operationId: randomUUID(),
      requestDigest: 'e'.repeat(64),
      domainVersion: 2,
      changes: [
        { op: 'append', record: workflow, field: 'reviewDrafts', jsonText: JSON.stringify(draft) },
      ],
    });
    transaction(f.db, () =>
      createIntakeStateStorage(f.db, f.identity).collections.stage(mutation.prepared!),
    );
    assert.throws(() => first.assertCurrent());
    first.close();
    f.workflow.reviewDrafts!.push(draft);
    await buildVerifiedWorkflowSummary(f.db, f.source, {
      mappingVersion: 'fictional',
      isSourceContextVersion: () => false,
    });
    const refreshed = await prepareNativeReportSourceReviewScope(f.db, f.source, {
      ...input,
      view: 'deferred',
    });
    try {
      assert.equal(refreshed.entryCount, 1);
      assert.notEqual(refreshed.scopeToken, before);
      assert.equal(
        refreshed.scopeToken,
        intakeReportSourceReviewScope(
          f.workflow,
          input.profileId,
          f.source.id,
          input.groupId,
          'deferred',
        )!.scopeToken,
      );
    } finally {
      refreshed.close();
    }
    assert.equal(intakeWorkCounters(f.db).warm.reportSourceScopeRoutingBuilds, 2);
  },
);
