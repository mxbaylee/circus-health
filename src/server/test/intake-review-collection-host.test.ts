import { reviewIntakeRead, readIntakeReviewRecord, readIntakeReviewFragment } from '../intake.ts';
import { readPreparedCollectionClinicalReview } from '../intake-review-collection-host.ts';
import nodeFs, { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { profileOriginal } from '../profile-storage.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { reviewDraftResolutions } from '../intake-review-draft-selection.ts';
import { prepareNativeDraftHistory, readNativeReviewDraft } from '../intake-review-draft-state.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import type { IntakeReviewDraft, IntakeReviewRecord } from '../../shared/intake.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { randomUUID, createHash } from 'node:crypto';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { collectionClinicalProjectionContext } from '../intake-review-collection-session.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import {
  uploadIntake,
  reviewIntake,
  importIntake,
  proposeConversionRead,
  intakeTransaction,
} from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { intakeEnvelopeAuthorityBinding } from '../intake-authority.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { listIntakeReportQueue, getIntakeReportQueueGroup } from '../intake-report-queue.ts';
import { readCollectionIntakeReportRecords } from '../intake-report-queue-collection.ts';
import { prepareCollectionPeopleIndex } from '../intake-people-collection.ts';
import {
  openCollectionReportQueue,
  collectionReportGroupSummary,
  clearCollectionReportQueues,
} from '../intake-report-group-collection.ts';
import { prepareJournalActivity } from '../journal-activity-index.ts';
import { readCollectionQueueActivity } from '../intake-queue-activity-collection.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { workflowHash } from '../intake-workflow.ts';
import { activeMappingRules } from '../clinical-import.ts';
import {
  listIntakeReportQueueRead,
  getIntakeReportQueueGroupRead,
  listIntakeImportFeedRead,
  clearPreparedCollectionQueues,
  readIntakeReportRecords,
} from '../intake-queue-native.ts';
import { listIntakeImportFeed } from '../intake-report-queue.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { clearCollectionImportFeeds } from '../intake-import-feed-collection.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import {
  applyClinicalRecordAction,
  openSelectedClinicalRecord,
  readClinicalRecordSection,
  readClinicalRecordSectionFragment,
  getIntakeRelatedRecordsRead,
} from '../intake-clinical-record-sections.ts';
const envelope = (id: string, text = 'Fictional original') => ({
  format: 'health-record-v1',
  id,
  kind: 'document',
  payload: { text },
  provenance: {
    capturedVia: 'Fictional export',
    sourceSystem: 'Fictional clinic',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'page 1',
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: { kind: 'document', subject: 'unknown', documentTitle: id, date: '2026-01-01' },
});
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-clinical-host-')),
    profileId = 'fictional-profile';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearCollectionImportFeeds(db);
    clearCollectionReportQueues(db);
    clearPreparedCollectionQueues(db);
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, profileId };
}
// Real native proposal/catalog publication plus two complete review sessions
// measured about 80s here. Counts establish scaling; this is a host hang guard.
test(
  'selected clinical draft handoff decodes once per complete record beyond 32 drafts',
  { timeout: 120000 },
  async (t) => {
    const { db, root, profileId } = fixture(t);
    const count = 33;
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional-draft-handoff.txt',
      bytes: Buffer.from('Independently fictional original'),
      newProviderName: 'Fictional clinic',
    });
    await buildIntakeCollectionEnvelope(db, { id: source.id });
    await proposeConversionRead(db, root, profileId, source.id, {
      version: source.version,
      summary: 'Fictional selected draft proposal',
      jsonlText: Array.from({ length: count }, (_, n) =>
        JSON.stringify({
          ...envelope('draft-' + n),
          report: {
            key: 'fictional-draft-report',
            title: 'Fictional draft report',
            anchor: { locator: 'page 1', text: 'Independently fictional original' },
            subject: null,
          },
        }),
      ).join('\n'),
    });
    const proposalId = String(
      db
        .prepare(
          "SELECT id FROM source_files WHERE kind='intake_proposal' ORDER BY rowid DESC LIMIT 1",
        )
        .get()!.id,
    );
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id, proposalId);
    const initial = prepareCollectionClinicalReview(db, root, profileId, source.id, proposalId);
    if (initial.status !== 'ready') throw Error('Expected initial selected review');
    const view = openIntakeCollectionEnvelope(db, source),
      catalog = createReportSnapshotCatalog(db, source, { catalog: 'review.snapshots' }),
      drafts: IntakeReviewDraft[] = [];
    for (const [n, record] of initial.session.review.records.entries()) {
      const draft: IntakeReviewDraft = {
        id: 'fictional-draft-' + n,
        proposalId,
        recordId: record.id,
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        mapping: { documentTitle: 'Reviewed fictional title ' + n },
        resolutions: Array.from({ length: 3 }, (_, index) => ({
          issueId: 'fictional-historical-' + index,
          outcome: index === 2 ? 'this_is_me' : 'unknown',
          at: '2026-01-01',
        })),
        disposition: 'pending',
        at: '2026-01-01',
      };
      drafts.push(
        (await prepareNativeDraftHistory(db, source, view, undefined, draft, { catalog })).draft,
      );
    }
    const version = initial.session.review.version;
    initial.session.close();
    const prepared = await prepareIntakeWorkflowCommand(db, source, {
      version,
      operationId: 'fictional-draft-handoff-publication',
      request: { count },
      createdAt: '2026-01-01',
      additionalLogicalChanges: await catalog.finalChanges(),
      *changes({ workflow }) {
        for (const draft of drafts)
          yield {
            op: 'append',
            record: workflow,
            field: 'reviewDrafts',
            jsonText: JSON.stringify(draft),
          };
      },
    });
    if (prepared.replayed) throw Error('Unexpected fixture replay');
    intakeTransaction(
      db,
      () => {
        prepared.assertCurrent();
        selectedEnvelopeStore(db, source).collections.stage(prepared.prepared);
      },
      { operationId: prepared.publicationId, fingerprint: prepared.fingerprint },
    );
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id, proposalId);
    const before = intakeWorkCounters(db).warm;
    const ready = prepareCollectionClinicalReview(db, root, profileId, source.id, proposalId);
    if (ready.status !== 'ready') throw Error('Expected complete selected clinical review');
    const after = intakeWorkCounters(db).warm;
    assert.equal(after.reviewDraftReconstructions - before.reviewDraftReconstructions, count);
    assert.equal(after.reviewDraftHandoffs - before.reviewDraftHandoffs, count);
    assert.equal(ready.session.review.records.length, count);
    const freshView = openIntakeCollectionEnvelope(db, source),
      freshCatalog = createReportSnapshotCatalog(db, source, { catalog: 'review.snapshots' });
    for (let index = 0; index < count; index++) {
      const record: IntakeReviewRecord = ready.session.review.records[index]!;
      const selected = freshView.lookup('draft-record-version-last', [
        proposalId,
        record.id,
        record.candidateVersionId!,
      ])!;
      const freshDraft = readNativeReviewDraft(freshView, selected, freshCatalog, 256 * 1024, {
        db,
        source,
      });
      assert.equal(record.mapping.documentTitle, drafts[index]!.mapping.documentTitle);
      assert.deepEqual(record.draft?.mapping, drafts[index]!.mapping);
      assert.deepEqual(
        Array.from(reviewDraftResolutions(record.draft)),
        Array.from(reviewDraftResolutions(freshDraft)),
      );
      assert.equal(
        Array.from(canonicalReviewValueChunks(record.draft)).join(''),
        Array.from(canonicalReviewValueChunks(freshDraft)).join(''),
      );
    }
    const token = ready.session.review.reviewToken;
    ready.session.close();
    clearIntakeStateCache(db);
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id, proposalId);
    const rebuilt = prepareCollectionClinicalReview(db, root, profileId, source.id, proposalId);
    if (rebuilt.status !== 'ready') throw Error('Expected rebuilt selected clinical review');
    assert.equal(rebuilt.session.review.reviewToken, token);
    rebuilt.session.close();
  },
);
test('native clinical host preserves complete legacy review and selection tokens through migration and cache loss', async (t) => {
  const { db, root, profileId } = fixture(t);
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    bytes: Buffer.from(
      [envelope('one'), envelope('two')].map((item) => JSON.stringify(item)).join('\n'),
    ),
    newProviderName: 'Fictional clinic',
  });
  const oracle = reviewIntake(db, root, profileId, intake.id);
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  await prepareCollectionReviewMembership(db, { id: intake.id });
  clearIntakeStateCache(db);
  const before = intakeWorkCounters(db);
  const result = prepareCollectionClinicalReview(db, root, profileId, intake.id);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  const native = { ...result.session.review };
  if (oracle.sourceTextStale === undefined) delete native.sourceTextStale;
  assert.deepEqual(native, oracle);
  const page = result.session.page('records', { items: 1, bytes: 16384 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
  assert.ok(page.nextCursor);
  const second = result.session.page('records', {
    items: 1,
    bytes: 16384,
    cursor: page.nextCursor!,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(
    result.session.record(oracle.records[1]!.id)?.selectionReviewToken,
    oracle.records[1]!.selectionReviewToken,
  );
  const after = intakeWorkCounters(db);
  assert.equal(after.warm.materializationReads, before.warm.materializationReads);
  const fileWork = createIntakeFileWorkCounters();
  withIntakeFileWork(fileWork, () =>
    prepareCollectionClinicalReview(db, root, profileId, intake.id),
  );
  assert.equal(fileWork.streamHashBytes, 0);
  assert.ok(fileWork.verificationCacheHits > 0);
});
test('native clinical page returns fragments for large rows and refuses cross-profile cursors', async (t) => {
  const { db, root, profileId } = fixture(t);
  const item = envelope('one', 'Fictional ' + '🩺'.repeat(2000));
  item.clinical.documentTitle = 'Long ' + '🩺'.repeat(2000);
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    bytes: Buffer.from(JSON.stringify(item)),
    newProviderName: 'Fictional clinic',
  });
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  await prepareCollectionReviewMembership(db, { id: intake.id });
  const result = prepareCollectionClinicalReview(db, root, profileId, intake.id);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  const page = result.session.page('records', { items: 1, bytes: 1024 });
  const selected = page.items[0]!;
  assert.equal(selected.kind, 'reference');
  if (selected.kind !== 'reference') return;
  const selectedRecord = result.session.selectedRecord(
    result.session.review.records[0]!.id,
    undefined,
    1024,
  );
  assert.equal(selectedRecord.record.kind, 'reference');
  if (selectedRecord.record.kind !== 'reference') throw Error('Expected selected fragment');
  assert.deepEqual(selectedRecord.record.selection, {
    recordId: result.session.review.records[0]!.id,
    candidateId: result.session.review.records[0]!.candidateId,
    candidateVersionId: result.session.review.records[0]!.candidateVersionId,
    selectionReviewToken: result.session.review.records[0]!.selectionReviewToken,
  });
  assert.equal(selectedRecord.record.policy.canAcceptUnchanged, true);
  assert.equal(selectedRecord.record.policy.blockingIssueCount, 0);
  assert.equal(selectedRecord.record.policy.unreviewedPairChoices, false);
  assert.ok(Buffer.byteLength(JSON.stringify(selectedRecord)) < 2048);
  const buffers: Buffer[] = [];
  let offset = 0;
  do {
    const part = result.session.fragment(selected.reference, offset, 1001);
    buffers.push(Buffer.from(part.data, 'base64'));
    if (part.complete) break;
    offset = part.nextOffset!;
  } while (true);
  assert.deepEqual(
    JSON.parse(Buffer.concat(buffers).toString('utf8')),
    JSON.parse(JSON.stringify(result.session.review.records[0])),
  );
  const forged = Buffer.from(
    JSON.stringify([
      'different-profile',
      intake.id,
      null,
      result.session.review.reviewToken,
      'records',
      0,
    ]),
  ).toString('base64url');
  assert.throws(
    () => result.session.page('records', { items: 1, bytes: 1024, cursor: forged }),
    /Refresh this selected review/,
  );
});

test('selected clinical dependency preparation migrates only exact accepted source identities', async (t) => {
  const { db, root, profileId } = fixture(t);
  const upload = (id: string, text: string) =>
    uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(JSON.stringify(envelope(id, text))),
    });
  const first = upload('same', 'Earlier fictional source'),
    unrelated = upload('unrelated', 'Independent fictional source');
  const accepted = reviewIntake(db, root, profileId, first.id);
  importIntake(db, root, profileId, first.id, {
    version: accepted.version,
    reviewToken: accepted.reviewToken,
    decisions: accepted.records.map((record) => ({
      recordId: record.id,
      action: 'accept',
      mapping: {},
    })),
  });
  const next = upload('same', 'Changed fictional source'),
    oracle = reviewIntake(db, root, profileId, next.id);
  await buildIntakeCollectionEnvelope(db, { id: next.id, sha256: next.sha256 });
  await prepareCollectionReviewMembership(db, { id: next.id });
  assert.throws(
    () => prepareCollectionClinicalReview(db, root, profileId, next.id),
    /Prepare the referenced retained original/,
  );
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, next.id);
  assert.notEqual(
    intakeEnvelopeAuthorityBinding(
      db,
      db.prepare('SELECT * FROM source_files WHERE id=?').get(first.id) as unknown as {
        id: string;
        sha256: string;
        details_json: string;
      },
    ).logicalHead,
    undefined,
  );
  assert.equal(
    intakeEnvelopeAuthorityBinding(
      db,
      db.prepare('SELECT * FROM source_files WHERE id=?').get(unrelated.id) as unknown as {
        id: string;
        sha256: string;
        details_json: string;
      },
    ).logicalHead,
    undefined,
  );
  const selected = prepareCollectionClinicalReview(db, root, profileId, next.id);
  assert.equal(selected.status, 'ready');
  if (selected.status !== 'ready') throw Error('Expected selected clinical review');
  const native = { ...selected.session.review };
  if (oracle.sourceTextStale === undefined) delete native.sourceTextStale;
  assert.deepEqual(native, oracle);
  const before = intakeWorkCounters(db);
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, next.id);
  assert.equal(intakeWorkCounters(db).warm.materializationReads, before.warm.materializationReads);
});

test('native host preserves linked context and suggested-source pair commitments', async (t) => {
  const { db, root, profileId } = fixture(t);
  const report = {
    key: 'report-f27',
    title: 'Fictional report',
    anchor: { locator: 'page 1', text: 'Report F27' },
    subject: null,
  };
  const clinical = { ...envelope('one'), contextId: 'shared', report };
  const context = {
    ...envelope('context'),
    kind: 'context',
    clinical: undefined,
    contextId: 'shared',
    report,
    payload: {
      branding: 'Fictional Suggested Clinic',
      text: 'Fictional Suggested Clinic\nReport F27',
    },
  };
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    bytes: Buffer.from([clinical, context].map((value) => JSON.stringify(value)).join('\n')),
    newProviderName: 'Fictional acquisition',
  });
  const oracle = reviewIntake(db, root, profileId, intake.id);
  assert.ok(oracle.sourceContext?.[0]?.reportContext);
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  await prepareCollectionReviewMembership(db, { id: intake.id });
  const result = prepareCollectionClinicalReview(db, root, profileId, intake.id);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  const native = { ...result.session.review };
  if (oracle.sourceTextStale === undefined) delete native.sourceTextStale;
  assert.deepEqual(native, oracle);
});

// Complete 96-group history publication, cold native review and transaction/rollback proofs share this fixture.
test(
  'native suggested sources select one indexed report and retain later duplicate-group precedence',
  { timeout: 120000 },
  async (t) => {
    const { db, root, profileId } = fixture(t),
      report = {
        key: 'fictional-source',
        title: 'Fictional report',
        anchor: { locator: 'page 1', text: 'Report F27' },
        subject: null,
      },
      clinical = { ...envelope('one'), contextId: 'shared', report },
      context = {
        ...envelope('context'),
        kind: 'context',
        clinical: undefined,
        contextId: 'shared',
        report,
        payload: {
          branding: 'Fictional Suggested Clinic',
          text: 'Fictional Suggested Clinic\nReport F27',
        },
      };
    const intake = uploadIntake(db, root, profileId, {
      filename: 'fictional.txt',
      bytes: Buffer.from('Fictional original report F27'),
      newProviderName: 'Fictional acquisition',
    });
    await proposeConversionRead(db, root, profileId, intake.id, {
      version: intake.version,
      jsonlText: [clinical, context].map((value) => JSON.stringify(value)).join('\n'),
      summary: 'Fictional linked report',
    });
    const proposalId = String(
      db
        .prepare(
          "SELECT id FROM source_files WHERE kind='intake_proposal' ORDER BY rowid DESC LIMIT 1",
        )
        .get()!.id,
    );
    const selectedSource = async (verifyCache = false, verifyHistory = false) => {
      await prepareCollectionClinicalReviewDependencies(db, root, profileId, intake.id, proposalId);
      const { prepareCollectionClinicalReviewAsync } =
        await import('../intake-review-collection-host.ts');
      const result = await prepareCollectionClinicalReviewAsync(
        db,
        root,
        profileId,
        intake.id,
        proposalId,
        { signal: t.signal },
      );
      assert.equal(result.status, 'ready');
      if (result.status !== 'ready') throw Error('Expected complete fictional review');
      try {
        const read = () =>
          collectionClinicalProjectionContext(result.session).selected.reportSource(
            result.session.review.records[0]!,
            proposalId,
          );
        const first = read();
        if (verifyHistory) {
          const { runClinicalReviewWork } = await import('../clinical-review-work.ts');
          const { reviewReadStamp } = await import('../intake-clinical-review-read-cache.ts');
          const projection = collectionClinicalProjectionContext(result.session);
          const record = result.session.review.records[0]!;
          const pair = projection.selected.pairSource;
          assert.ok(pair.work);
          const expected = pair(record, proposalId);
          let inspections = 0,
            historyTurns = 0,
            finished = false;
          const pulse = () => {
            if (!finished) {
              historyTurns++;
              setImmediate(pulse);
            }
          };
          setImmediate(pulse);
          const work = function* () {
            const inner = pair.work!(record, proposalId);
            try {
              for (;;) {
                const next = inner.next();
                if (next.done) return next.value;
                inspections++;
                yield;
              }
            } finally {
              inner.return(null);
            }
          };
          try {
            assert.deepEqual(
              await runClinicalReviewWork(work(), {
                signal: t.signal,
                capture() {
                  projection.assertCurrent();
                  const stamp = reviewReadStamp(db);
                  assert.notEqual(stamp, undefined);
                  return () => {
                    projection.assertCurrent();
                    assert.equal(reviewReadStamp(db), stamp);
                  };
                },
              }),
              expected,
            );
          } finally {
            finished = true;
          }
          assert.ok(
            inspections >= 96,
            'every nonmatching retained group exposes an inner checkpoint',
          );
          assert.ok(
            historyTurns >= 6,
            'complete reverse source history exposes actual cooperative turns',
          );
          t.diagnostic(JSON.stringify({ nonmatchingSourceGroups: 96, inspections, historyTurns }));
        }
        if (!verifyCache) return first;
        const lookups = () => intakeWorkCounters(db).warm.collectionSuggestedSourceLookups;
        const before = lookups();
        const hashes = () => intakeWorkCounters(db).warm.collectionSuggestedSourceHashes;
        const beforeHashes = hashes();
        assert.deepEqual(read(), first);
        assert.equal(
          hashes(),
          beforeHashes,
          'complete confirmation hash is reused under the same proof',
        );
        assert.equal(lookups(), before, 'unchanged host lookups reuse the uniqueness proof');
        db.exec('SAVEPOINT fictional_source_lookup');
        try {
          assert.deepEqual(read(), first);
          assert.deepEqual(read(), first);
          assert.equal(
            lookups(),
            before + 2,
            'transactional reads never reuse a selected uniqueness proof',
          );
          assert.equal(
            hashes(),
            beforeHashes + 2,
            'transactions never reuse or retain complete confirmation hashes',
          );
        } finally {
          db.exec('ROLLBACK TO fictional_source_lookup; RELEASE fictional_source_lookup');
        }
        assert.deepEqual(read(), first);
        assert.equal(lookups(), before + 3, 'no transactional proof survives rollback');
        assert.equal(
          hashes(),
          beforeHashes + 3,
          'rolled back SQL cannot restore an old confirmation hash proof',
        );
        return first;
      } finally {
        result.session.close();
      }
    };
    assert.equal((await selectedSource(true))?.confirmation.source, 'Fictional Suggested Clinic');
    const source = { id: intake.id },
      view = openIntakeCollectionEnvelope(db, source),
      workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
      group = view.childAt(workflow, 'reportGroups', 0)!,
      duplicate = JSON.parse([...view.recordChunks(group)].join(''));
    assert.equal(duplicate.versions[0].format, 'health-intake-report-group-version-v2');
    duplicate.versions[0].context.sourceSuggestion.value = 'Fictional Later Clinic';
    const operationId = randomUUID(),
      mutation = await prepareIntakeEnvelopeMutation(db, source, {
        reader: view,
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: view.logical.domainVersion + 1,
        changes: [
          {
            op: 'append',
            record: workflow,
            field: 'reportGroups',
            jsonText: JSON.stringify(duplicate),
          },
          ...Array.from({ length: 96 }, (_, index) => {
            const unrelated = structuredClone(duplicate);
            unrelated.id = 'unrelated-retained-' + index;
            for (const version of unrelated.versions) {
              delete version.format;
              version.members = [];
            }
            return {
              op: 'append' as const,
              record: workflow,
              field: 'reportGroups',
              jsonText: JSON.stringify(unrelated),
            };
          }),
        ],
      });
    transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(mutation.prepared!));
    assert.equal(
      (await selectedSource(false, true))?.confirmation.source,
      'Fictional Later Clinic',
    );
  },
);

test('native report clinical pages preserve legacy records and reject stale policy cursors', async (t) => {
  const { db, root, profileId } = fixture(t);
  const report = {
    key: 'fictional-report',
    title: 'Fictional report',
    anchor: { locator: 'page 1', text: 'Fictional report' },
    subject: null,
  };
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      [envelope('one'), envelope('two')]
        .map((value) => JSON.stringify({ ...value, report }))
        .join('\n'),
    ),
  });
  const queue = listIntakeReportQueue(db, root, profileId),
    groupId = queue.groups[0]!.groupId;
  const oracle = getIntakeReportQueueGroup(db, root, profileId, groupId);
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  await prepareCollectionReviewMembership(db, { id: intake.id });
  clearIntakeStateCache(db);
  const before = intakeWorkCounters(db);
  const first = await readCollectionIntakeReportRecords(db, root, profileId, intake.id, {
    groupId,
    limit: 1,
  });
  assert.equal(first.totalRecords, oracle.totalRecords);
  assert.ok(first.nextCursor);
  const second = await readCollectionIntakeReportRecords(db, root, profileId, intake.id, {
    groupId,
    limit: 1,
    cursor: first.nextCursor!,
  });
  assert.equal(second.nextCursor, null);
  const records = [...first.records, ...second.records].map((item) => {
    assert.equal(item.kind, 'record');
    if (item.kind !== 'record') throw Error('Expected inline record');
    return item.record;
  });
  assert.deepEqual(
    records,
    oracle.blocks.flatMap((block) => block.records),
  );
  assert.equal(intakeWorkCounters(db).warm.materializationReads, before.warm.materializationReads);
  await prepareCollectionPeopleIndex(db, root, profileId, intake.id);
  await buildVerifiedWorkflowSummary(
    db,
    { id: intake.id },
    {
      mappingVersion: workflowHash(activeMappingRules(db, intake.providerId)),
      isSourceContextVersion: () => false,
    },
  );
  await prepareJournalActivity(root, profileId);
  const nativeQueue = await openCollectionReportQueue(db, root, profileId);
  try {
    const pointer = [...nativeQueue.groups('active')][0]!;
    const summary = await collectionReportGroupSummary(db, root, profileId, nativeQueue, pointer);
    for (const key of [
      'groupId',
      'groupVersionId',
      'intakeId',
      'intakeVersion',
      'discoveryOrder',
      'title',
      'source',
      'sourceScope',
      'date',
      'basis',
      'original',
      'member',
      'counts',
      'peopleCounts',
    ] as const)
      assert.deepEqual(summary[key], oracle.group[key], key);
    assert.ok(oracle.group.sourceCoverage);
    assert.deepEqual(
      summary.sourceCoverage.current.bySource.items,
      oracle.group.sourceCoverage.current.bySource,
    );
    assert.deepEqual(
      summary.sourceCoverage.saved.bySource.items,
      oracle.group.sourceCoverage.saved.bySource,
    );
    assert.equal(summary.sourceCoverage.current.total, oracle.group.sourceCoverage.current.total);
    const activity = readCollectionQueueActivity(db, root, profileId, nativeQueue);
    for (const key of [
      'runningFiles',
      'pausedFiles',
      'queuedFiles',
      'filesAwaitingConversion',
      'extractionUnknownFiles',
      'extractionComplete',
      'allCurrentReportsReviewed',
    ] as const)
      assert.deepEqual(activity[key], queue.activity[key], key);
  } finally {
    nativeQueue.close();
  }
  const pageRecords = () =>
    readCollectionIntakeReportRecords(db, root, profileId, intake.id, { groupId, limit: 1 });
  await pageRecords();
  const originalPath = profileOriginal(
    root,
    String(db.prepare('SELECT path FROM source_files WHERE id=?').get(intake.id)!.path),
    profileId,
  );
  const peer = new DatabaseSync(String(db.prepare('PRAGMA database_list').get()!.file)),
    priorRevision = db
      .prepare("SELECT value FROM app_meta WHERE key='clinical_review_revision'")
      .get()!.value,
    stat = nodeFs.statSync;
  let calls = 0,
    target = 0,
    armed = false,
    injected = false;
  Reflect.set(nodeFs, 'statSync', ((path, ...args) => {
    if (String(path) === originalPath && ++calls === target && armed) {
      peer.exec(
        "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='clinical_review_revision'",
      );
      injected = true;
    }
    return Reflect.apply(stat, nodeFs, [path, ...args]);
  }) as typeof nodeFs.statSync);
  syncBuiltinESMExports();
  try {
    await pageRecords();
    assert.ok(calls > 0);
    target = calls;
    calls = 0;
    armed = true;
    await assert.rejects(pageRecords, /Refresh/);
    assert.equal(injected, true, 'record-page policy changes during its final physical check');
  } finally {
    Reflect.set(nodeFs, 'statSync', stat);
    syncBuiltinESMExports();
    peer
      .prepare("UPDATE app_meta SET value=? WHERE key='clinical_review_revision'")
      .run(priorRevision!);
    peer.close();
  }
  db.exec(
    "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='clinical_review_revision'",
  );
  await assert.rejects(
    () =>
      readCollectionIntakeReportRecords(db, root, profileId, intake.id, {
        groupId,
        cursor: first.nextCursor!,
      }),
    /Refresh/,
  );
});

test('public queue adapters preserve legacy dispatch and prepare complete native group/feed pages', async (t) => {
  const { db, root, profileId } = fixture(t),
    intake = uploadIntake(db, root, profileId, {
      filename: 'queue.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        [envelope('one'), envelope('two')].map((value) => JSON.stringify(value)).join('\n'),
      ),
    });
  const legacy = listIntakeReportQueue(db, root, profileId),
    feed = listIntakeImportFeed(db, root, profileId);
  assert.deepEqual(await listIntakeReportQueueRead(db, root, profileId), legacy);
  assert.deepEqual(await listIntakeImportFeedRead(db, root, profileId), feed);
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  const page = await listIntakeReportQueueRead(db, root, profileId, { limit: '1' });
  assert.ok('format' in page && page.format === 'health-intake-report-queue-page-v2');
  assert.equal(page.totalGroups, legacy.totalGroups);
  const detail = await getIntakeReportQueueGroupRead(
    db,
    root,
    profileId,
    legacy.groups[0]!.groupId,
    { limit: '1' },
  );
  assert.ok('format' in detail && detail.format === 'health-intake-report-detail-v2');
  const nativeFeed = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
  assert.ok('format' in nativeFeed && nativeFeed.format === 'health-intake-import-feed-v2');
  assert.equal(nativeFeed.totalRecords, feed.totalRecords);
  assert.deepEqual(nativeFeed.counts, feed.counts);
  assert.ok(nativeFeed.nextCursor);
  const next = await listIntakeImportFeedRead(db, root, profileId, {
    limit: '1',
    cursor: nativeFeed.nextCursor,
  });
  assert.equal(next.nextCursor, null);
});

test('giant selected record sections preserve exact issue evidence and sparse unseen draft policy', async (t) => {
  const { db, root, profileId } = fixture(t);
  const source = {
    ...envelope('section', 'Fictional text '.repeat(9000)),
    reviewIssues: [
      {
        kind: 'uncertain_reading',
        field: 'documentTitle',
        prompt: 'Confirm fictional title ' + '🩺'.repeat(9000),
      },
      { kind: 'date', field: 'documentDate', prompt: 'Confirm the fictional document date' },
    ],
  };
  const intake = uploadIntake(db, root, profileId, {
    filename: 'sections.jsonl',
    bytes: Buffer.from(JSON.stringify(source)),
    newProviderName: 'Fictional clinic',
  });
  const oracle = reviewIntake(db, root, profileId, intake.id),
    record = oracle.records[0]!;
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  const selection = {
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
  };
  const page = await readClinicalRecordSection(db, root, profileId, intake.id, {
    ...selection,
    section: 'issues',
    bytes: 4096,
  });
  const giant = page.items.find(
    (item) => item.control.kind === 'issue' && item.control.issueKind === 'uncertain_reading',
  )!;
  assert.equal(giant.detail.kind, 'reference');
  if (giant.detail.kind !== 'reference') throw Error('Expected referenced issue');
  const parts: Buffer[] = [];
  let offset = 0;
  do {
    const part = await readClinicalRecordSectionFragment(db, root, profileId, intake.id, {
      reference: giant.detail.reference,
      offset,
      bytes: 4096,
    });
    parts.push(Buffer.from(part.data, 'base64'));
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  } while (true);
  assert.deepEqual(
    JSON.parse(Buffer.concat(parts).toString()),
    record.issues!.find((issue) => issue.kind === 'uncertain_reading'),
  );
  const date = record.issues!.find((issue) => issue.kind === 'date')!;
  await applyClinicalRecordAction(db, root, profileId, intake.id, {
    ...selection,
    version: page.context.version,
    reviewToken: page.context.reviewToken,
    operationId: 'section-unknown-date',
    patch: { resolutions: [{ issueId: date.id, outcome: 'unknown' }] },
  });
  let current = await openSelectedClinicalRecord(db, root, profileId, intake.id, selection);
  assert.equal(current.record.mapping.date, '');
  assert.equal(current.record.mapping.documentDate, '');
  await assert.rejects(
    readClinicalRecordSectionFragment(db, root, profileId, intake.id, {
      reference: giant.detail.reference,
      offset: 0,
    }),
    /Refresh/,
  );
  await applyClinicalRecordAction(db, root, profileId, intake.id, {
    ...selection,
    version: current.review.version,
    reviewToken: current.review.reviewToken,
    operationId: 'section-correct-title',
    patch: {
      mapping: { documentTitle: 'Corrected fictional title' },
      correctionPatch: { documentTitle: 'Corrected fictional title' },
      correctionReason: 'The fictional original supports this title',
    },
  });
  current = await openSelectedClinicalRecord(db, root, profileId, intake.id, selection);
  assert.equal(current.record.mapping.documentTitle, 'Corrected fictional title');
  assert.equal(current.record.mapping.date, '');
  assert.ok(
    current.record.draft?.resolutions.some(
      (resolution) => resolution.issueId === date.id && resolution.outcome === 'unknown',
    ),
  );
  let cursor: string | null = null,
    foundText = false;
  do {
    const mapping = await readClinicalRecordSection(db, root, profileId, intake.id, {
      ...selection,
      section: 'mapping',
      bytes: 4096,
      cursor,
    });
    const text = mapping.items.find(
      (item) => item.control.kind === 'mapping' && item.control.field === 'text',
    );
    if (text) {
      assert.equal(text.detail.kind, 'reference');
      foundText = true;
    }
    cursor = mapping.nextCursor;
  } while (cursor);
  assert.ok(foundText);
});

test('native pair section actions preserve unseen choices and bind exact saved evidence', async (t) => {
  const { db, root, profileId } = fixture(t);
  for (const id of ['saved-one', 'saved-two']) {
    const item = {
      ...envelope(id),
      clinical: { ...envelope(id).clinical, documentTitle: 'Shared fictional result' },
    };
    const uploaded = uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(JSON.stringify(item)),
    });
    const review = reviewIntake(db, root, profileId, uploaded.id);
    importIntake(db, root, profileId, uploaded.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: review.records.map((record) => ({
        recordId: record.id,
        action: 'accept',
        mapping: {},
      })),
    });
  }
  const item = {
    ...envelope('incoming', 'Fictional source text '.repeat(4500)),
    clinical: { ...envelope('incoming').clinical, documentTitle: 'Shared fictional result' },
  };
  const uploaded = uploadIntake(db, root, profileId, {
    filename: 'incoming.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(item)),
  });
  const record = reviewIntake(db, root, profileId, uploaded.id).records[0]!;
  const selection = {
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
  };
  await buildIntakeCollectionEnvelope(db, { id: uploaded.id, sha256: uploaded.sha256 });
  for (let i = 0; i < 2; i++) {
    const page = await readClinicalRecordSection(db, root, profileId, uploaded.id, {
      ...selection,
      section: 'comparisons',
      comparisonSearch: { query: 'Shared' },
    });
    assert.equal(page.total, 2);
    const control = page.items[i]!.control;
    assert.equal(control.kind, 'pair');
    if (control.kind !== 'pair') throw Error('Expected pair control');
    assert.ok(control.scopeToken);
    const action = {
      ...selection,
      version: page.context.version,
      reviewToken: page.context.reviewToken,
      operationId: 'pair-' + i,
      pair: {
        otherRecordId: control.otherRecordId,
        scopeToken: control.scopeToken!,
        outcome: 'distinct' as const,
        reason: 'Different fictional occurrence ' + i,
      },
    };
    const saved = await applyClinicalRecordAction(db, root, profileId, uploaded.id, action);
    const replay = await applyClinicalRecordAction(db, root, profileId, uploaded.id, action);
    assert.equal(replay.version, saved.version);
    await assert.rejects(
      applyClinicalRecordAction(db, root, profileId, uploaded.id, {
        ...action,
        pair: { ...action.pair, reason: 'Conflicting reused operation' },
      }),
      { code: 'OPERATION_CONFLICT' },
    );
  }
  const current = await openSelectedClinicalRecord(db, root, profileId, uploaded.id, selection);
  assert.equal(current.record.draft?.decision?.comparisons?.length, 2);
  const related = await getIntakeRelatedRecordsRead(db, root, profileId, uploaded.id, {
    ...selection,
    query: 'Shared',
  });
  assert.ok('format' in related);
  if ('format' in related) assert.equal(related.discoveryPage?.returned, 2);
  const body = {
    operationId: '2d99d914-3c1f-4d37-8c85-9c58b68601c2',
    blocks: [
      {
        intakeId: uploaded.id,
        proposalId: null,
        intakeVersion: current.review.version,
        reviewToken: current.review.reviewToken,
        selections: [
          {
            recordId: record.id,
            candidateId: current.record.candidateId!,
            candidateVersionId: selection.candidateVersionId,
            selectionReviewToken: current.record.selectionReviewToken!,
            mapping: {},
            useRetainedDecision: true as const,
          },
        ],
      },
    ],
  };
  await assert.rejects(
    acceptIntakeReportSelectionAsync(db, root, profileId, {
      ...body,
      operationId: 'ea1e230b-e5e5-4615-977e-11b520c02b5b',
      blocks: [{ ...body.blocks[0]!, reviewToken: 'stale' }],
    }),
    /changed|Refresh|fresh/i,
  );
  const accepted = await acceptIntakeReportSelectionAsync(db, root, profileId, body);
  assert.equal(accepted.receipt.acceptedCount, 1);
  const acceptanceReplay = await acceptIntakeReportSelectionAsync(db, root, profileId, body);
  assert.equal(acceptanceReplay.replayed, true);
  assert.deepEqual(acceptanceReplay.receipt, accepted.receipt);
  assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 3);
});

test('native queue reuses unrelated source joins and filtered counts after one clinical draft', async (t) => {
  const { db, root, profileId } = fixture(t);
  const sources = [];
  for (const id of ['one', 'two', 'three']) {
    const source = uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(JSON.stringify(envelope(id))),
    });
    sources.push(source);
  }
  for (const source of sources)
    await buildIntakeCollectionEnvelope(db, { id: source.id, sha256: source.sha256 });
  const first = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
  assert.ok('format' in first);
  const warmed = { ...intakeWorkCounters(db).warm };
  const second = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
  assert.ok('format' in second);
  const reused = intakeWorkCounters(db).warm;
  assert.equal(reused.collectionFeedRebuiltSources, warmed.collectionFeedRebuiltSources);
  assert.equal(reused.collectionFeedReviewedRecords, warmed.collectionFeedReviewedRecords);
  assert.equal(reused.collectionQueueMemberRows, warmed.collectionQueueMemberRows);
  assert.equal(reused.collectionQueueClinicalReviews, warmed.collectionQueueClinicalReviews);
  assert.equal(canonicalLiteral(second.records), canonicalLiteral(first.records));
  const intake = sources[1]!,
    opened = prepareCollectionClinicalReview(db, root, profileId, intake.id);
  if (opened.status !== 'ready') throw Error('Expected selected review');
  const record = opened.session.review.records[0]!;
  await applyClinicalRecordAction(db, root, profileId, intake.id, {
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    version: opened.session.review.version,
    reviewToken: opened.session.review.reviewToken,
    operationId: 'local-queue-draft',
    patch: {
      mapping: { documentTitle: 'Corrected fictional title' },
      correctionPatch: { documentTitle: 'Corrected fictional title' },
      correctionReason: 'Correct fictional label',
    },
  });
  const before = { ...intakeWorkCounters(db).warm };
  const after = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
  assert.equal(after.totalRecords, 3);
  const work = intakeWorkCounters(db).warm;
  assert.equal(work.collectionQueuePreparedSources - before.collectionQueuePreparedSources, 1);
  assert.equal(work.collectionQueueMemberRows - before.collectionQueueMemberRows, 1);
  assert.equal(work.collectionFeedRebuiltSources - before.collectionFeedRebuiltSources, 1);
  assert.equal(work.collectionFeedReviewedRecords - before.collectionFeedReviewedRecords, 1);
  assert.ok('format' in after);
  assert.notEqual(after.records[0]!.reviewToken, first.records[0]!.reviewToken);
  const unchanged = prepareCollectionClinicalReview(
    db,
    root,
    profileId,
    after.records[0]!.intakeId,
    after.records[0]!.proposalId,
  );
  if (unchanged.status !== 'ready') throw Error('Expected current unchanged-source review');
  assert.equal(after.records[0]!.reviewToken, unchanged.session.review.reviewToken);
  clearCollectionImportFeeds(db);
  clearCollectionReportQueues(db);
  clearPreparedCollectionQueues(db);
  const recovered = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
  assert.deepEqual(recovered.counts, after.counts);
  assert.equal(recovered.totalRecords, after.totalRecords);
});

// Eight native records exercise cold feed preparation, a retained correction, complete filtered counts and cache reconstruction.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'native feed updates one member in a shared report and retains complete filtered counts',
  { timeout: 180000 },
  async (t) => {
    const { db, root, profileId } = fixture(t);
    const report = {
      key: 'fictional-shared-report',
      title: 'Shared fictional report',
      anchor: { locator: 'page 1', text: 'Shared fictional report' },
      subject: null,
    };
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional-many.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        Array.from({ length: 8 }, (_, index) =>
          JSON.stringify({
            ...envelope('fictional-' + index),
            report,
          }),
        ).join('\n'),
      ),
    });
    await buildIntakeCollectionEnvelope(db, { id: source.id, sha256: source.sha256 });
    const first = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
    assert.ok('format' in first);
    assert.equal(first.totalRecords, 8);
    const queried = await listIntakeImportFeedRead(db, root, profileId, {
      limit: '1',
      q: 'amended',
    });
    assert.equal(queried.totalRecords, 0);
    const opened = prepareCollectionClinicalReview(db, root, profileId, source.id);
    if (opened.status !== 'ready') throw Error('Expected selected review');
    const record = opened.session.review.records[5]!;
    await applyClinicalRecordAction(db, root, profileId, source.id, {
      proposalId: null,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      version: opened.session.review.version,
      reviewToken: opened.session.review.reviewToken,
      operationId: 'fictional-shared-member-draft',
      patch: {
        mapping: { documentTitle: 'Amended fictional title' },
        correctionPatch: { documentTitle: 'Amended fictional title' },
        correctionReason: 'Correct fictional label',
      },
    });
    const before = { ...intakeWorkCounters(db).warm };
    const after = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
    const changed = await listIntakeImportFeedRead(db, root, profileId, {
      limit: '1',
      q: 'amended',
    });
    assert.equal(after.totalRecords, 8);
    assert.equal(changed.totalRecords, 1);
    assert.equal(changed.totalGroups, 1);
    const work = intakeWorkCounters(db).warm;
    assert.equal(work.collectionQueueMemberRows - before.collectionQueueMemberRows, 1);
    assert.equal(work.collectionQueueSummaryBuilds - before.collectionQueueSummaryBuilds, 0);
    assert.equal(work.collectionFeedReviewedRecords - before.collectionFeedReviewedRecords, 2);
    clearCollectionImportFeeds(db);
    clearCollectionReportQueues(db);
    clearPreparedCollectionQueues(db);
    const recovered = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
    const recoveredQuery = await listIntakeImportFeedRead(db, root, profileId, {
      limit: '1',
      q: 'amended',
    });
    assert.deepEqual(recovered.counts, after.counts);
    assert.deepEqual(recovered.kindCounts, after.kindCounts);
    assert.equal(recovered.totalRecords, after.totalRecords);
    assert.equal(recoveredQuery.totalRecords, changed.totalRecords);
    assert.equal(recoveredQuery.totalGroups, changed.totalGroups);
  },
);

// Native publication, affected-source preparation and independent-source reuse are checked through actual retained authority.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'native proposal refreshes its affected report and leaves unrelated feed sources prepared',
  { timeout: 120000 },
  async (t) => {
    const { db, root, profileId } = fixture(t),
      report = {
        key: 'append-report',
        title: 'Fictional append report',
        anchor: { locator: 'page 1', text: 'Fictional append report' },
        subject: null,
      };
    const first = uploadIntake(db, root, profileId, {
      filename: 'append.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        Array.from({ length: 3 }, (_, i) =>
          JSON.stringify({ ...envelope('append-' + i), report }),
        ).join('\n'),
      ),
    });
    const unrelated = uploadIntake(db, root, profileId, {
      filename: 'unrelated.jsonl',
      providerId: first.providerId,
      bytes: Buffer.from(JSON.stringify(envelope('unrelated'))),
    });
    for (const intake of [first, unrelated])
      await buildIntakeCollectionEnvelope(db, { id: intake.id });
    const warmed = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
    assert.equal(warmed.totalRecords, 4);
    await proposeConversionRead(db, root, profileId, first.id, {
      version: first.version,
      jsonlText: JSON.stringify({ ...envelope('appended'), report }),
      summary: 'Fictional additional evidence',
    });
    const before = { ...intakeWorkCounters(db).warm };
    const changed = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
    assert.equal(changed.totalRecords, 5);
    const counters = intakeWorkCounters(db).warm;
    assert.equal(
      counters.collectionQueuePreparedSources - before.collectionQueuePreparedSources,
      1,
    );
    assert.equal(counters.collectionFeedRebuiltSources - before.collectionFeedRebuiltSources, 1);
    assert.equal(counters.collectionQueueMemberRows - before.collectionQueueMemberRows, 1);
    const page = await readIntakeReportRecords(db, root, profileId, first.id, { limit: 1 });
    assert.equal(page.totalRecords, 4);
    assert.ok(page.nextCursor);
    const next = await readIntakeReportRecords(db, root, profileId, first.id, {
      limit: 1,
      cursor: page.nextCursor!,
    });
    assert.equal(next.totalRecords, 4);
    assert.notDeepEqual(next.records[0], page.records[0]);
    clearCollectionImportFeeds(db);
    clearCollectionReportQueues(db);
    clearPreparedCollectionQueues(db);
    const recovered = await listIntakeImportFeedRead(db, root, profileId, { limit: '1' });
    assert.deepEqual(recovered.counts, changed.counts);
    assert.equal(recovered.totalRecords, changed.totalRecords);
    const recoveredNext = await readIntakeReportRecords(db, root, profileId, first.id, {
      limit: 1,
      cursor: page.nextCursor!,
    });
    assert.deepEqual(recoveredNext.records, next.records);
  },
);

test('selected native host keeps an oversized linked-group sequence reachable with exact legacy tokens', async (t) => {
  const { db, root, profileId } = fixture(t),
    value = {
      ...envelope('fictional-linked-record'),
      report: {
        key: 'fictional-links',
        title: 'Fictional links',
        anchor: { locator: 'page 1', text: 'Fictional links' },
        subject: null,
      },
    };
  const intake = uploadIntake(db, root, profileId, {
    filename: 'links.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const saved = JSON.parse(readIntakeEnvelopeText(db, { id: intake.id }));
  const original = saved.intake.workflow.reportGroups[0];
  for (let index = 0; index < 12; index++)
    saved.intake.workflow.reportGroups.push({
      ...structuredClone(original),
      id: 'report-group:fictional-link-' + index,
    });
  writeIntakeFixtureEnvelope(db, intake.id, saved);
  const oracle = reviewIntake(db, root, profileId, intake.id);
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, intake.id);
  const selected = prepareCollectionClinicalReview(db, root, profileId, intake.id, null, {
    metadataBytes: 1024,
  });
  if (selected.status !== 'ready') throw Error('Linked groups must remain policy-accessible');
  const record = selected.session.review.records[0]!;
  assert.equal(Array.isArray(record.reportGroups), false);
  assert.equal(selected.session.review.reviewToken, oracle.reviewToken);
  assert.equal(record.selectionReviewToken, oracle.records[0]!.selectionReviewToken);
  const detail = selected.session.selectedRecord(record.id, record.candidateVersionId, 1024);
  assert.equal(detail.record.kind, 'reference');
  if (detail.record.kind !== 'reference') throw Error('Expected bounded selected reference');
  assert.equal(detail.record.reportGroups!.count, 13);
  const page = await readClinicalRecordSection(db, root, profileId, intake.id, {
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    section: 'reportGroups',
    limit: 5,
    bytes: 4096,
  });
  assert.equal(page.total, 13);
  assert.equal(page.items.length, 5);
  assert.ok(page.nextCursor);
  assert.equal(page.items[0]!.control.kind, 'reportGroup');
  const next = await readClinicalRecordSection(db, root, profileId, intake.id, {
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    section: 'reportGroups',
    limit: 5,
    bytes: 4096,
    cursor: page.nextCursor,
  });
  assert.equal(next.items[0]!.ordinal, 5);
});

test('native review policy scratch is session owned and leaves the authority connection unchanged', async (t) => {
  const { db, root, profileId } = fixture(t);
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-policy.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(envelope('policy'))),
  });
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
  const before = db.prepare('SELECT total_changes() AS n').get()!.n;
  const ready = prepareCollectionClinicalReview(db, root, profileId, source.id);
  assert.equal(ready.status, 'ready');
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(reviewIssueScratchCounts(db).databases, 1);
  assert.ok(reviewIssueScratchCounts(db).scopes > 0);
  if (ready.status === 'ready') {
    ready.session.close();
    ready.session.close();
  }
  assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
  const refused = prepareCollectionClinicalReview(db, root, profileId, source.id, null, {
    metadataBytes: 1,
  });
  assert.equal(refused.status, 'fragment_required');
  assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
  const held = prepareCollectionClinicalReview(db, root, profileId, source.id);
  clearIntakeStateCache(db);
  assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
  if (held.status === 'ready') assert.doesNotThrow(() => held.session.close());
});

test('signed native feed pages retain exact rows and refuse scratch, rollback, peer and publication changes', async (t) => {
  const { db, root, profileId } = fixture(t);
  const values = Array.from({ length: 3 }, (_, index) => ({
    ...envelope('signed-' + index),
    payload: {
      text: 'Fictional numeric evidence',
      negative: JSON.rawJSON('-0'),
      exponent: JSON.rawJSON('1e0'),
      large: JSON.rawJSON('9007199254740993'),
    },
  }));
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-signed.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(values.map((value) => JSON.stringify(value)).join('\n')),
  });
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const options = { limit: '1', view: 'all' };
  const first = await listIntakeImportFeedRead(db, root, profileId, options);
  const before = { ...intakeWorkCounters(db).warm },
    fileWork = createIntakeFileWorkCounters();
  const warm = await withIntakeFileWork(fileWork, () =>
    listIntakeImportFeedRead(db, root, profileId, options),
  );
  const next = await listIntakeImportFeedRead(db, root, profileId, {
    ...options,
    cursor: first.nextCursor!,
  });
  assert.equal(
    intakeWorkCounters(db).warm.collectionQueueClinicalReviews,
    before.collectionQueueClinicalReviews,
  );
  assert.ok('format' in first && 'format' in warm && 'format' in next);
  assert.equal(canonicalLiteral(warm.records), canonicalLiteral(first.records));
  assert.notEqual(next.records[0]!.feedKey, warm.records[0]!.feedKey);
  const wire = canonicalLiteral(warm.records);
  assert.match(wire, /:\s*-0[,}]/);
  assert.match(wire, /:\s*1e0[,}]/);
  assert.match(wire, /9007199254740993/);
  assert.ok(fileWork.verificationCacheHits > 0);
  assert.equal(
    intakeWorkCounters(db).warm.collectionFeedRowCertificateHashes -
      before.collectionFeedRowCertificateHashes,
    2,
  );
  assert.ok(
    intakeWorkCounters(db).warm.collectionFeedRowCertificateBytes >
      before.collectionFeedRowCertificateBytes,
  );
  const findScratch = () => {
    for (const name of readdirSync(tmpdir()).filter((name) =>
      name.startsWith('circus-import-feed-'),
    )) {
      const path = join(tmpdir(), name, 'scratch.sqlite');
      if (!existsSync(path)) continue;
      const candidate = new DatabaseSync(path);
      try {
        if (candidate.prepare('SELECT 1 FROM records WHERE intake=?').get(source.id))
          return candidate;
      } catch {}
      candidate.close();
    }
    throw Error('Expected owned feed scratch');
  };
  let scratch = findScratch();
  try {
    scratch
      .prepare(
        "UPDATE records SET value=json_set(value,'$.title','FORGED') WHERE ordering=(SELECT min(ordering) FROM records)",
      )
      .run();
  } finally {
    scratch.close();
  }
  await assert.rejects(() => listIntakeImportFeedRead(db, root, profileId, options), {
    code: 'REPORT_QUEUE_CURSOR',
  });
  await listIntakeImportFeedRead(db, root, profileId, options);
  scratch = findScratch();
  try {
    const rows = scratch
      .prepare('SELECT ordering,member,signature FROM records ORDER BY ordering')
      .all();
    scratch
      .prepare('UPDATE records SET member=?,signature=? WHERE ordering=?')
      .run(rows[1]!.member, rows[1]!.signature, rows[0]!.ordering);
  } finally {
    scratch.close();
  }
  await assert.rejects(() => listIntakeImportFeedRead(db, root, profileId, options), {
    code: 'REPORT_QUEUE_CURSOR',
  });
  await listIntakeImportFeedRead(db, root, profileId, options);
  let reviews = intakeWorkCounters(db).warm.collectionQueueClinicalReviews;
  db.exec('CREATE TEMP TABLE fictional_feed_stamp(n INTEGER)');
  await listIntakeImportFeedRead(db, root, profileId, options);
  assert.equal(intakeWorkCounters(db).warm.collectionQueueClinicalReviews, reviews + 1);
  db.exec('SAVEPOINT fictional_feed_rollback');
  try {
    await assert.rejects(
      () => listIntakeImportFeedRead(db, root, profileId, options),
      /Cooperative clinical review cannot hold a transaction/,
    );
    assert.equal(db.isTransaction, true, 'refusal leaves the caller-owned transaction intact');
  } finally {
    db.exec('ROLLBACK TO fictional_feed_rollback;RELEASE fictional_feed_rollback');
  }
  reviews = intakeWorkCounters(db).warm.collectionQueueClinicalReviews;
  await listIntakeImportFeedRead(db, root, profileId, options);
  assert.equal(
    intakeWorkCounters(db).warm.collectionQueueClinicalReviews,
    reviews + 1,
    'transaction-derived rows cannot survive rollback as certificates',
  );
  const peer = new DatabaseSync(String(db.prepare('PRAGMA database_list').get()!.file));
  const store = selectedEnvelopeStore(db, { id: source.id }).collections,
    selected = store.binding(store.openView())!;
  const prefix =
    intakeNamespace({ profileId, intakeId: source.id, sourceHash: source.sha256 }) + 'node:';
  let leaf = selected.logical.root!;
  for (;;) {
    const node = JSON.parse(
      String(db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + leaf.hash)!.value),
    );
    if (!node.left && !node.right) break;
    leaf = node.left || node.right;
  }
  assert.notEqual(leaf.hash, selected.logical.root!.hash);
  const key = prefix + leaf.hash;
  const original = String(db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)!.value);
  try {
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
    assert.throws(
      () => prepareCollectionClinicalReview(db, root, profileId, source.id),
      /collection|tree|schema|JSON/,
    );
    await assert.rejects(() => listIntakeImportFeedRead(db, root, profileId, options));
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(original, key);
    await listIntakeImportFeedRead(db, root, profileId, options);
    const originalPath = profileOriginal(
        root,
        String(db.prepare('SELECT path FROM source_files WHERE id=?').get(source.id)!.path),
        profileId,
      ),
      stat = nodeFs.statSync;
    let calls = 0,
      armed = false,
      target = 0,
      injected = false;
    Reflect.set(nodeFs, 'statSync', ((path, ...args) => {
      if (String(path) === originalPath) {
        calls++;
        if (armed && calls === target) {
          peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
          injected = true;
        }
      }
      return Reflect.apply(stat, nodeFs, [path, ...args]);
    }) as typeof nodeFs.statSync);
    syncBuiltinESMExports();
    try {
      await listIntakeImportFeedRead(db, root, profileId, options);
      assert.ok(calls > 0);
      target = calls;
      calls = 0;
      armed = true;
      await assert.rejects(() => listIntakeImportFeedRead(db, root, profileId, options));
      assert.equal(injected, true, 'corruption occurs during the final original-file check');
    } finally {
      Reflect.set(nodeFs, 'statSync', stat);
      syncBuiltinESMExports();
      peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(original, key);
    }
    await listIntakeImportFeedRead(db, root, profileId, options);
    const bytes = readFileSync(originalPath);
    writeFileSync(originalPath, Buffer.alloc(bytes.length, 32));
    try {
      await assert.rejects(() => listIntakeImportFeedRead(db, root, profileId, options));
    } finally {
      writeFileSync(originalPath, bytes);
    }
  } finally {
    peer.close();
  }
});

test('public native review windows reuse one private session with detached exact transport and concurrent reads', async (t) => {
  const { db, root, profileId } = fixture(t);
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-read-window.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      Array.from({ length: 3 }, (_, i) =>
        JSON.stringify({
          ...envelope('read-' + i),
          payload: {
            text: 'Fictional ' + 'z'.repeat(1800),
            negative: JSON.rawJSON('-0'),
            exponent: JSON.rawJSON('1e0'),
            large: JSON.rawJSON('9007199254740993'),
          },
        }),
      ).join('\n'),
    ),
  });
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  // The public request owns cold readiness; no helper prepares its dependencies first.
  const page = () =>
    reviewIntakeRead(db, root, profileId, source.id, null, { items: 1, bytes: 65536 });
  const first = await page();
  assert.ok('format' in first && first.format === 'health-intake-clinical-review-page-v2');
  const firstItem = first.items[0]!;
  assert.equal(firstItem.kind, 'value');
  if (firstItem.kind !== 'value') throw Error('Expected inline row');
  const record = firstItem.value as import('../../shared/intake.ts').IntakeReviewRecord;
  const original = canonicalLiteral(first);
  const before = { ...intakeWorkCounters(db).warm };
  record.mapping.documentTitle = 'FORGED caller mutation';
  const second = await page();
  assert.equal(canonicalLiteral(second), original);
  assert.equal(
    intakeWorkCounters(db).warm.collectionPublicClinicalReviews,
    before.collectionPublicClinicalReviews,
  );
  assert.equal(reviewIssueScratchCounts(db).databases, 1);
  const next = await reviewIntakeRead(db, root, profileId, source.id, null, {
    items: 1,
    bytes: 65536,
    cursor: first.nextCursor!,
  });
  assert.ok('format' in next && next.format === 'health-intake-clinical-review-page-v2');
  assert.notEqual(next.items[0], firstItem);
  const narrow = await reviewIntakeRead(db, root, profileId, source.id, null, {
    items: 1,
    bytes: 1024,
  });
  assert.ok('format' in narrow && narrow.format === 'health-intake-clinical-review-page-v2');
  const reference = narrow.items[0]!;
  assert.equal(reference.kind, 'reference');
  if (reference.kind !== 'reference') throw Error('Expected bounded reference');
  const concurrent = await Promise.all([
    page(),
    readIntakeReviewRecord(db, root, profileId, source.id, { recordId: record.id, bytes: 65536 }),
    readIntakeReviewFragment(db, root, profileId, source.id, {
      reference: reference.reference,
      bytes: 1024,
    }),
  ]);
  assert.equal(canonicalLiteral(concurrent[0]), original);
  assert.equal(concurrent[1].record.kind, 'record');
  assert.equal(concurrent[2].encoding, 'base64');
  assert.equal(
    intakeWorkCounters(db).warm.collectionPublicClinicalReviews,
    before.collectionPublicClinicalReviews,
  );
  const overlap = await Promise.allSettled([
    reviewIntakeRead(db, root, profileId, source.id, null, {
      items: 1,
      bytes: 65536,
      cursor: 'invalid',
    }),
    page(),
  ]);
  assert.equal(overlap[0]!.status, 'rejected');
  assert.equal(overlap[1]!.status, 'fulfilled');
  assert.equal(
    intakeWorkCounters(db).warm.collectionPublicClinicalReviews,
    before.collectionPublicClinicalReviews + 1,
    'serialized invalid read closes the old session before the queued valid read prepares once',
  );
  assert.equal(reviewIssueScratchCounts(db).databases, 1);
  const afterOverlap = intakeWorkCounters(db).warm.collectionPublicClinicalReviews;
  assert.equal(canonicalLiteral(await page()), original);
  assert.equal(
    intakeWorkCounters(db).warm.collectionPublicClinicalReviews,
    afterOverlap,
    'the completed newer request remains cached for the next exact read',
  );
  assert.equal(reviewIssueScratchCounts(db).databases, 1);
  assert.match(original, /:\s*-0[,}]/);
  assert.match(original, /:\s*1e0[,}]/);
  assert.match(original, /9007199254740993/);
  db.exec('CREATE TEMP TABLE fictional_private_review_stamp(n INTEGER)');
  await page();
  assert.equal(intakeWorkCounters(db).warm.collectionPublicClinicalReviews, afterOverlap + 1);
  clearIntakeStateCache(db);
  assert.equal(reviewIssueScratchCounts(db).databases, 0);
  // Concurrent cold preparation may finish uncached, but every unchanged request succeeds.
  await Promise.all([page(), page()]);
  assert.equal(reviewIssueScratchCounts(db).databases, 1);
  let reviews = intakeWorkCounters(db).warm.collectionPublicClinicalReviews;
  const retainedBeforeTransaction = reviewIssueScratchCounts(db);
  db.exec('SAVEPOINT fictional_private_review');
  try {
    await assert.rejects(page, /cannot (?:enter|wait) inside a transaction/);
    await assert.rejects(page, /cannot (?:enter|wait) inside a transaction/);
    assert.deepEqual(
      reviewIssueScratchCounts(db),
      retainedBeforeTransaction,
      'refused admission neither opens work nor releases the prior cache owner',
    );
  } finally {
    db.exec('ROLLBACK TO fictional_private_review;RELEASE fictional_private_review');
  }
  assert.equal(intakeWorkCounters(db).warm.collectionPublicClinicalReviews, reviews);
  assert.equal(canonicalLiteral(await page()), original);
  assert.equal(
    intakeWorkCounters(db).warm.collectionPublicClinicalReviews,
    reviews,
    'an empty rolled-back savepoint did not enter or rebase the completed review',
  );
  assert.deepEqual(reviewIssueScratchCounts(db), retainedBeforeTransaction);
  await assert.rejects(() =>
    readPreparedCollectionClinicalReview(db, root, 'wrong-profile', source.id, null, {
      kind: 'page',
      section: 'records',
      options: { items: 1, bytes: 65536 },
    }),
  );
  assert.equal(reviewIssueScratchCounts(db).databases, 0);
  await page();
  const originalPath = profileOriginal(
      root,
      String(db.prepare('SELECT path FROM source_files WHERE id=?').get(source.id)!.path),
      profileId,
    ),
    bytes = readFileSync(originalPath);
  writeFileSync(originalPath, Buffer.alloc(bytes.length, 32));
  try {
    await assert.rejects(page);
    assert.equal(reviewIssueScratchCounts(db).databases, 0);
  } finally {
    writeFileSync(originalPath, bytes);
  }
});

test('private public review cache binds source and proposal files and refuses consumed-leaf changes before publication', async (t) => {
  const { db, root, profileId } = fixture(t);
  const sources = [];
  for (const id of ['source-one', 'source-two']) {
    const source = uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(JSON.stringify(envelope(id))),
    });
    sources.push(source);
  }
  for (const source of sources) await buildIntakeCollectionEnvelope(db, { id: source.id });
  const a = sources[0]!,
    b = sources[1]!;
  const read = (source: string, proposalId: string | null = null) =>
    reviewIntakeRead(db, root, profileId, source, proposalId, { items: 1, bytes: 65536 });
  await read(a.id);
  await read(b.id);
  let reviews = intakeWorkCounters(db).warm.collectionPublicClinicalReviews;
  await read(b.id);
  assert.equal(intakeWorkCounters(db).warm.collectionPublicClinicalReviews, reviews);
  await read(a.id);
  assert.equal(intakeWorkCounters(db).warm.collectionPublicClinicalReviews, reviews + 1);
  assert.equal(reviewIssueScratchCounts(db).databases, 1);
  await proposeConversionRead(db, root, profileId, a.id, {
    version: a.version,
    jsonlText: JSON.stringify(envelope('proposal-one')),
    summary: 'Fictional proposal',
  });
  const proposal = String(
    db.prepare("SELECT id FROM source_files WHERE kind='intake_proposal'").get()!.id,
  );
  const page = () => read(a.id, proposal);
  await page();
  reviews = intakeWorkCounters(db).warm.collectionPublicClinicalReviews;
  await page();
  assert.equal(intakeWorkCounters(db).warm.collectionPublicClinicalReviews, reviews);
  const proposalPath = profileOriginal(
      root,
      String(db.prepare('SELECT path FROM source_files WHERE id=?').get(proposal)!.path),
      profileId,
    ),
    proposalBytes = readFileSync(proposalPath);
  writeFileSync(proposalPath, Buffer.alloc(proposalBytes.length, 32));
  try {
    await assert.rejects(page);
    assert.equal(reviewIssueScratchCounts(db).databases, 0);
  } finally {
    writeFileSync(proposalPath, proposalBytes);
  }
  await page();
  const store = selectedEnvelopeStore(db, { id: a.id }).collections,
    selected = store.binding(store.openView())!;
  const prefix = intakeNamespace({ profileId, intakeId: a.id, sourceHash: a.sha256 }) + 'node:';
  let leaf = selected.logical.root!;
  for (;;) {
    const node = JSON.parse(
      String(db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + leaf.hash)!.value),
    );
    if (!node.left && !node.right) break;
    leaf = node.left || node.right;
  }
  assert.notEqual(leaf.hash, selected.logical.root!.hash);
  const key = prefix + leaf.hash,
    original = String(db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)!.value),
    peer = new DatabaseSync(String(db.prepare('PRAGMA database_list').get()!.file));
  try {
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
    assert.throws(() => prepareCollectionClinicalReview(db, root, profileId, a.id, proposal));
    await assert.rejects(page);
    assert.equal(reviewIssueScratchCounts(db).databases, 0);
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(original, key);
    await page();
    const stat = nodeFs.statSync;
    let calls = 0,
      target = 0,
      armed = false,
      injected = false;
    Reflect.set(nodeFs, 'statSync', ((path, ...args) => {
      if (String(path) === proposalPath) {
        calls++;
        if (armed && calls === target) {
          peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
          injected = true;
        }
      }
      return Reflect.apply(stat, nodeFs, [path, ...args]);
    }) as typeof nodeFs.statSync);
    syncBuiltinESMExports();
    try {
      await page();
      assert.ok(calls > 0);
      target = calls;
      calls = 0;
      armed = true;
      await assert.rejects(page);
      assert.equal(injected, true);
      assert.equal(reviewIssueScratchCounts(db).databases, 0);
    } finally {
      Reflect.set(nodeFs, 'statSync', stat);
      syncBuiltinESMExports();
      peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(original, key);
    }
    await Promise.all([read(a.id), read(b.id)]);
    assert.equal(reviewIssueScratchCounts(db).databases, 1);
  } finally {
    peer.close();
  }
});

// Consecutive durable corrections, stale windows and detached queue rows share one complete host fixture.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'native feed retains one exact proposal across changed-source windows and detaches queue records',
  { timeout: 90000 },
  async (t) => {
    const { db, root, profileId } = fixture(t);
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional-retained-feed.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        Array.from({ length: 4 }, (_, index) => JSON.stringify(envelope('retained-' + index))).join(
          '\n',
        ),
      ),
    });
    await buildIntakeCollectionEnvelope(db, { id: source.id });
    const options = { view: 'all', limit: '1' };
    await listIntakeImportFeedRead(db, root, profileId, options);
    const correct = async (title: string) => {
      const opened = prepareCollectionClinicalReview(db, root, profileId, source.id);
      if (opened.status !== 'ready') throw Error('Expected retained review');
      try {
        const record = opened.session.review.records[0]!;
        await applyClinicalRecordAction(db, root, profileId, source.id, {
          proposalId: null,
          recordId: record.id,
          candidateVersionId: record.candidateVersionId!,
          version: opened.session.review.version,
          reviewToken: opened.session.review.reviewToken,
          operationId: randomUUID(),
          patch: {
            mapping: { documentTitle: title },
            correctionPatch: { documentTitle: title },
            correctionReason: 'Fictional correction',
          },
        });
      } finally {
        opened.session.close();
      }
    };
    await correct('First retained correction');
    const first = await listIntakeImportFeedRead(db, root, profileId, options);
    assert.ok('format' in first);
    assert.ok(first.nextCursor);
    const before = intakeWorkCounters(db).warm.collectionQueueClinicalReviews;
    const [second, simultaneous] = await Promise.all([
      listIntakeImportFeedRead(db, root, profileId, { ...options, cursor: first.nextCursor! }),
      listIntakeImportFeedRead(db, root, profileId, { ...options, cursor: first.nextCursor! }),
    ]);
    assert.ok('format' in second && 'format' in simultaneous);
    assert.equal(canonicalLiteral(second.records), canonicalLiteral(simultaneous.records));
    const third = await listIntakeImportFeedRead(db, root, profileId, {
      ...options,
      cursor: second.nextCursor!,
    });
    assert.ok('format' in third);
    assert.equal(
      intakeWorkCounters(db).warm.collectionQueueClinicalReviews,
      before,
      'unseen rows use the exact completed current proposal, not another full review',
    );
    assert.notEqual(first.records[0]!.feedKey, third.records[0]!.feedKey);
    const queue = await openCollectionReportQueue(db, root, profileId);
    const pointer = [...queue.groups('all')][0]!;
    const member = [...queue.members(source.id, pointer.ordinal)][0]!;
    const original = await queue.reviewMember(source.id, member);
    assert.equal('session' in original, false);
    const exact = canonicalLiteral(original.record);
    original.record.mapping.documentTitle = 'Forged detached title';
    original.record.evidence.push({ label: 'Forged detached evidence', locator: 'Fictional page' });
    original.facts.counts.questions = 999;
    if (original.certificate) original.certificate.sourcePin = 'forged';
    assert.equal(canonicalLiteral((await queue.reviewMember(source.id, member)).record), exact);
    queue.close({ retainReview: true });
    assert.equal(reviewIssueScratchCounts(db).databases, 1);
    const held = await openCollectionReportQueue(db, root, profileId);
    await correct('Second retained correction');
    await assert.rejects(() => held.reviewMember(source.id, member), /Refresh|changed/i);
    held.close();
    await listIntakeImportFeedRead(db, root, profileId, options);
    assert.equal(reviewIssueScratchCounts(db).databases, 1);
    await assert.rejects(() => openCollectionReportQueue(db, root, 'wrong-profile'));
    assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
    await listIntakeImportFeedRead(db, root, profileId, options);
    clearIntakeStateCache(db);
    assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
    await listIntakeImportFeedRead(db, root, profileId, options);
    assert.equal(reviewIssueScratchCounts(db).databases, 1);
    db.close();
    assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
  },
);

test('concurrent cold queue opens preserve the global four-queue bound', async (t) => {
  const { db, root, profileId } = fixture(t);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => openCollectionReportQueue(db, root, profileId)),
  );
  const ready = results.filter((result) => result.status === 'fulfilled');
  const refused = results.filter((result) => result.status === 'rejected');
  try {
    assert.equal(ready.length, 4);
    assert.equal(refused.length, 2);
    for (const result of refused) assert.equal(result.reason.code, 'REPORT_QUEUE_BUSY');
  } finally {
    for (const result of ready) result.value.close();
  }
  clearCollectionReportQueues(db);
  assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
});

test(
  'cooperative cold clinical review serves another HTTP request and preserves complete single-record policy',
  { timeout: 120000 },
  async (t) => {
    const { createServer } = await import('node:http');
    const { prepareCollectionClinicalReviewAsync } =
      await import('../intake-review-collection-host.ts');
    const { db, root, profileId } = fixture(t);
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional-cooperative-history.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(JSON.stringify(envelope('cooperative-history'))),
    });
    const saved = JSON.parse(readIntakeEnvelopeText(db, { id: source.id }));
    const candidate = saved.intake.workflow.candidates[0];
    saved.intake.workflow.questions = Array.from({ length: 96 }, (_, index) => ({
      id: 'fictional-cooperative-question-' + index,
      key: 'fictional-cooperative-key-' + index,
      locator: 'page 1',
      candidateId: candidate.id,
      candidateVersionId: index % 2 ? candidate.versions[0].id : null,
      prompt: 'Confirm fictional retained reading ' + index,
      field: 'documentTitle',
      status: 'unanswered',
      answers: [],
      createdAt: '2026-01-01',
    }));
    writeIntakeFixtureEnvelope(db, source.id, saved);
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
    const sync = prepareCollectionClinicalReview(db, root, profileId, source.id);
    assert.equal(sync.status, 'ready');
    if (sync.status !== 'ready') throw Error('Expected complete synchronous oracle');
    const expected = canonicalLiteral(sync.session.review);
    const expectedToken = sync.session.review.records[0]!.selectionReviewToken;
    sync.session.close();
    let completed = false,
      ticks = 0,
      stopped = false;
    const server = createServer((_request, response) => {
      const owner = db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()!
        .value;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ owner, reviewCompleted: completed }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      stopped = true;
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected fictional HTTP server');
    const heartbeat = () => {
      if (!stopped) {
        ticks++;
        setImmediate(heartbeat);
      }
    };
    setImmediate(heartbeat);
    const otherRequest = fetch(`http://127.0.0.1:${address.port}/unrelated-profile-header`);
    const pending = prepareCollectionClinicalReviewAsync(db, root, profileId, source.id).then(
      (result) => {
        completed = true;
        return result;
      },
    );
    const response = await otherRequest;
    assert.deepEqual(await response.json(), { owner: profileId, reviewCompleted: false });
    const ready = await pending;
    stopped = true;
    assert.equal(ready.status, 'ready');
    assert.ok(ticks > 1, 'actual event-loop heartbeat advanced during cold single-record policy');
    if (ready.status !== 'ready') throw Error('Expected complete cooperative review');
    assert.equal(canonicalLiteral(ready.session.review), expected);
    assert.equal(ready.session.review.records[0]!.selectionReviewToken, expectedToken);
    assert.equal(ready.session.review.records[0]!.questions?.length, 96);
    ready.session.close();
    assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
    t.diagnostic(
      JSON.stringify({ coldReviewHeartbeatTurns: ticks, completeRetainedQuestions: 96 }),
    );

    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await assert.rejects(
      prepareCollectionClinicalReviewAsync(db, root, profileId, source.id, null, {
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });

    setImmediate(() => {
      db.exec('BEGIN');
      db.prepare("UPDATE app_meta SET value=value WHERE key='owner_profile_id'").run();
      db.exec('ROLLBACK');
    });
    await assert.rejects(
      prepareCollectionClinicalReviewAsync(db, root, profileId, source.id),
      /Review changed while preparing/,
    );
    assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
  },
);

test('clinical question selection falls back completely without a reverse index and preserves retained order', async (t) => {
  const { prepareCollectionClinicalReviewAsync } =
    await import('../intake-review-collection-host.ts');
  const { db, root, profileId } = fixture(t);
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-question-fallback.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(envelope('question-fallback'))),
  });
  const saved = JSON.parse(readIntakeEnvelopeText(db, { id: source.id }));
  const candidate = saved.intake.workflow.candidates[0];
  const ids = ['fictional-question-12', 'fictional-question-2', 'fictional-question-1'];
  saved.intake.workflow.questions = ids.map((id, index) => ({
    id,
    key: id,
    candidateId: candidate.id,
    candidateVersionId: index === 1 ? null : candidate.versions[0].id,
    prompt: 'Confirm fictional reading ' + id,
    field: 'documentTitle',
    locator: 'page 1',
    status: 'unanswered',
    answers: [],
    createdAt: '2026-01-01',
  }));
  writeIntakeFixtureEnvelope(db, source.id, saved);
  const legacy = reviewIntake(db, root, profileId, source.id);
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  await prepareCollectionReviewMembership(db, source);
  // No workflow dependency preparation: this was a valid complete native reader before the optimization.
  const fallback = await prepareCollectionClinicalReviewAsync(db, root, profileId, source.id);
  if (fallback.status !== 'ready') throw Error('Expected complete fallback question scope');
  assert.deepEqual(
    fallback.session.review.records[0]!.questions!.map((question) => question.id),
    ids,
  );
  assert.equal(fallback.session.review.reviewToken, legacy.reviewToken);
  assert.equal(
    fallback.session.review.records[0]!.selectionReviewToken,
    legacy.records[0]!.selectionReviewToken,
  );
  const token = fallback.session.review.reviewToken;
  fallback.session.close();
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
  const indexed = await prepareCollectionClinicalReviewAsync(db, root, profileId, source.id);
  if (indexed.status !== 'ready') throw Error('Expected complete indexed question scope');
  assert.deepEqual(
    indexed.session.review.records[0]!.questions!.map((question) => question.id),
    ids,
  );
  assert.equal(indexed.session.review.reviewToken, token);
  indexed.session.close();
  assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
});

// This guard covers complete 33-record legacy/native policy, unrelated HTTP and two nested refusal attempts.
// Assertions use complete commitments and work counts, not a runtime target.
test(
  'cooperative suggested source hashes complete shared membership once and guards nested history yields',
  { timeout: 180000 },
  async (t) => {
    const { prepareCollectionClinicalReviewAsync } =
      await import('../intake-review-collection-host.ts');
    const { createServer } = await import('node:http');
    const { db, root, profileId } = fixture(t);
    const count = 33;
    const phaseStart = performance.now();
    const phase = (name: string) =>
      t.diagnostic(
        JSON.stringify({
          sharedReportPhase: name,
          elapsedMs: Math.round(performance.now() - phaseStart),
        }),
      );
    const report = {
      key: 'shared-cooperative-report',
      title: 'Fictional shared report',
      anchor: { locator: 'page 1', text: 'Report C33' },
      subject: null,
    };
    const records = Array.from({ length: count }, (_, i) => ({
      ...envelope('shared-' + i),
      contextId: 'shared',
      report,
    }));
    const context = {
      ...envelope('context'),
      kind: 'context',
      clinical: undefined,
      contextId: 'shared',
      report,
      payload: { branding: 'Fictional Shared Clinic', text: 'Fictional Shared Clinic\nReport C33' },
    };
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional-shared-report.jsonl',
      newProviderName: 'Fictional acquisition',
      bytes: Buffer.from([...records, context].map((v) => JSON.stringify(v)).join('\n')),
    });
    const saved = JSON.parse(readIntakeEnvelopeText(db, { id: source.id }));
    const group = saved.intake.workflow.reportGroups[0];
    const members = group.versions[0].members.length;
    assert.equal(members, count);
    // Retain duplicate group precedence while measuring the shared membership itself.
    const duplicate = structuredClone(group);
    duplicate.versions[0].contextState = 'mixed';
    saved.intake.workflow.reportGroups.push(duplicate);
    writeIntakeFixtureEnvelope(db, source.id, saved);
    phase('retained fictional setup complete');
    const legacy = reviewIntake(db, root, profileId, source.id);
    phase('complete legacy oracle ready');
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
    phase('native dependencies ready');
    let completed = false,
      stopped = false,
      hashTurns = 0;
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          owner: db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()!.value,
          completed,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      stopped = true;
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected HTTP fixture');
    const before = intakeWorkCounters(db).warm;
    let request: Promise<Response> | undefined;
    const heartbeat = () => {
      if (stopped) return;
      const hashes =
        intakeWorkCounters(db).warm.collectionSuggestedSourceMemberHashes -
        before.collectionSuggestedSourceMemberHashes;
      if (hashes > 0 && hashes < members) {
        hashTurns++;
        request ??= fetch(`http://127.0.0.1:${address.port}/unrelated-profile-header`);
      }
      setImmediate(heartbeat);
    };
    setImmediate(heartbeat);
    const ready = await prepareCollectionClinicalReviewAsync(db, root, profileId, source.id, null, {
      signal: t.signal,
    });
    completed = true;
    phase('complete cooperative review ready');
    assert.equal(ready.status, 'ready');
    if (ready.status !== 'ready') throw Error('Expected complete shared report');
    assert.ok(request, 'an actual HTTP request starts inside complete membership hashing');
    const response = await request;
    assert.deepEqual(await response.json(), { owner: profileId, completed: false });
    assert.ok(hashTurns > 0);
    const after = intakeWorkCounters(db).warm;
    assert.equal(after.collectionSuggestedSourceHashes - before.collectionSuggestedSourceHashes, 1);
    assert.equal(
      after.collectionSuggestedSourceMemberHashes - before.collectionSuggestedSourceMemberHashes,
      members,
    );
    assert.ok(
      after.collectionSuggestedSourceHashHits - before.collectionSuggestedSourceHashHits >=
        count - 1,
    );
    const native = { ...ready.session.review };
    if (legacy.sourceTextStale === undefined) delete native.sourceTextStale;
    assert.deepEqual(
      native,
      legacy,
      'complete review and comparison/selection tokens retain legacy canonical commitments',
    );
    stopped = true;
    t.diagnostic(
      JSON.stringify({
        sharedRecords: count,
        completeMembers: members,
        nestedHashTurns: hashTurns,
        completeHashes: 1,
      }),
    );
    const { runClinicalReviewWork } = await import('../clinical-review-work.ts');
    const { reviewReadStamp } = await import('../intake-clinical-review-read-cache.ts');
    const projection = collectionClinicalProjectionContext(ready.session);
    const pairSource = projection.selected.pairSource;
    assert.ok(pairSource.work);
    for (const mode of ['abort', 'rollback'] as const) {
      // A real intervening SQL write invalidates the completed hash memo; each
      // attempt must traverse complete membership again before retaining a hash.
      db.prepare("UPDATE app_meta SET value=value WHERE key='owner_profile_id'").run();
      const controller = new AbortController();
      const start = intakeWorkCounters(db).warm.collectionSuggestedSourceMemberHashes;
      let finished = false;
      const interfere = () => {
        if (finished) return;
        if (intakeWorkCounters(db).warm.collectionSuggestedSourceMemberHashes > start) {
          if (mode === 'abort') controller.abort();
          else {
            db.exec('BEGIN');
            db.prepare("UPDATE app_meta SET value=value WHERE key='owner_profile_id'").run();
            db.exec('ROLLBACK');
          }
        } else setImmediate(interfere);
      };
      setImmediate(interfere);
      try {
        await assert.rejects(
          runClinicalReviewWork(pairSource.work!(ready.session.review.records[0]!, null), {
            signal: controller.signal,
            capture() {
              projection.assertCurrent();
              const stamp = reviewReadStamp(db);
              return () => {
                projection.assertCurrent();
                assert.equal(reviewReadStamp(db), stamp, 'nested source proof changed');
              };
            },
          }),
          mode === 'abort' ? { name: 'AbortError' } : /nested source proof changed/,
        );
      } finally {
        finished = true;
      }
      t.diagnostic('shared report: nested ' + mode + ' refused');
    }
    ready.session.close();
    assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
  },
);

test(
  'multirow native feed preserves admitted rows across certified maintenance and rejects real rollback',
  { timeout: 120_000 },
  async (t) => {
    const { setImmediate } = await import('node:timers/promises');
    const { execClinicalReviewMaintenance, runClinicalReviewMaintenance } =
      await import('../clinical-review-maintenance.ts');
    const { db, root, profileId } = fixture(t);
    const sources: ReturnType<typeof uploadIntake>[] = [];
    for (let index = 0; index < 3; index++) {
      const source = uploadIntake(db, root, profileId, {
        filename: `fictional-cooperative-feed-${index}.jsonl`,
        newProviderName: 'Fictional clinic',
        bytes: Buffer.from(JSON.stringify(envelope('cooperative-feed-' + index))),
      });
      sources.push(source);
    }
    for (const source of sources) await buildIntakeCollectionEnvelope(db, { id: source.id });
    const options = { limit: '3', view: 'all' };
    const baseline = await listIntakeImportFeedRead(db, root, profileId, options);
    assert.ok('format' in baseline && baseline.format === 'health-intake-import-feed-v2');
    assert.equal(baseline.records.length, 3);
    execClinicalReviewMaintenance(
      db,
      'attention',
      'CREATE TEMP TABLE IF NOT EXISTS source_attention_counts_v1(source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL)',
    );
    for (const mode of ['neutral', 'rollback'] as const) {
      // Keep the signed feed rows while forcing fresh clinical review admission.
      db.exec(`CREATE TEMP TABLE fictional_feed_${mode}_stamp(n INTEGER)`);
      const before = intakeWorkCounters(db).warm.collectionQueueClinicalReviews;
      let completed = false,
        injected = false;
      const injection = (async () => {
        while (!completed) {
          await setImmediate();
          if (completed || intakeWorkCounters(db).warm.collectionQueueClinicalReviews < before + 2)
            continue;
          injected = true;
          if (mode === 'neutral')
            runClinicalReviewMaintenance(
              db,
              'attention',
              'INSERT OR REPLACE INTO source_attention_counts_v1 VALUES(?,?)',
              'fictional-neutral-feed-cache',
              0,
            );
          else {
            db.exec('BEGIN');
            db.prepare("UPDATE app_meta SET value=value WHERE key='owner_profile_id'").run();
            db.exec('ROLLBACK');
          }
          return;
        }
      })();
      try {
        if (mode === 'neutral') {
          const result = await listIntakeImportFeedRead(db, root, profileId, options);
          assert.ok('format' in result && result.format === 'health-intake-import-feed-v2');
          assert.equal(canonicalLiteral(result.records), canonicalLiteral(baseline.records));
        } else
          await assert.rejects(() => listIntakeImportFeedRead(db, root, profileId, options), {
            code: 'INTAKE_REVIEW_CHANGED',
          });
      } finally {
        completed = true;
        await injection;
      }
      assert.equal(
        injected,
        true,
        'the second actual row review yielded after an earlier row was admitted',
      );
    }
  },
);

test('selected questions, issues, fragments and public pages share complete detached review policy', async (t) => {
  const { importIntakeRead } = await import('../intake.ts');
  const { db, root, profileId } = fixture(t);
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-shared-section-policy.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      JSON.stringify({
        ...envelope('section-cache'),
        clinical: {
          ...envelope('section-cache').clinical,
          subject: 'self',
        },
      }),
    ),
  });
  const first = reviewIntake(db, root, profileId, source.id),
    record = first.records[0]!;
  const stored = JSON.parse(readIntakeEnvelopeText(db, { id: source.id }));
  stored.intake.workflow.questions.push(
    ...Array.from({ length: 7 }, (_, i) => ({
      id: 'question:fictional-shared-section-' + i,
      key: 'fictional-shared-section-' + i,
      candidateId: record.candidateId,
      candidateVersionId: record.candidateVersionId,
      prompt: 'Confirm fictional text ' + 'x'.repeat(6000),
      locator: 'page 1',
      field: 'documentTitle',
      status: i === 6 ? 'unanswered' : 'resolved',
      createdAt: '2026-01-01T00:00:00Z',
      answers:
        i === 6
          ? []
          : [
              {
                id: `answer:fictional-shared-section-${i}`,
                answer: 'Fictional prior confirmation',
                mapping: {},
                scope: 'record',
                at: '2026-01-01T00:00:00Z',
              },
            ],
    })),
  );
  writeIntakeFixtureEnvelope(db, source.id, stored);
  const oracle = reviewIntake(db, root, profileId, source.id);
  const lateQuestion = 'question:fictional-shared-section-6';
  assert.deepEqual(
    oracle.records[0]!.questions!.filter((question) => question.status === 'unanswered').map(
      (question) => question.id,
    ),
    [lateQuestion],
  );
  const pendingIssues = oracle.records[0]!.issues!.filter(
    (issue) => issue.blocking && issue.status !== 'resolved',
  );
  assert.deepEqual(
    pendingIssues.map((issue) => issue.questionId),
    [lateQuestion],
  );
  assert.equal(oracle.records[0]!.identityReview?.blocking ?? false, false);
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const selection = {
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
  };
  const count = () => intakeWorkCounters(db).warm.collectionPublicClinicalReviews;
  const before = count();
  const questions = await readClinicalRecordSection(db, root, profileId, source.id, {
    ...selection,
    section: 'questions',
    limit: 2,
    bytes: 4096,
  });
  assert.equal(questions.total, 7);
  assert.equal(questions.items.length, 2);
  assert.ok(questions.nextCursor);
  assert.equal(questions.context.reviewToken, oracle.reviewToken);
  const reference = questions.items[0]!.detail;
  assert.equal(reference.kind, 'reference');
  if (reference.kind !== 'reference') throw Error('Expected complete referenced question');
  const issues = await readClinicalRecordSection(db, root, profileId, source.id, {
    ...selection,
    section: 'issues',
    limit: 2,
    bytes: 4096,
  });
  assert.equal(issues.total, 7);
  assert.equal(issues.context.reviewToken, oracle.reviewToken);
  assert.ok(
    questions.items.every(
      (item) => item.control.kind === 'question' && item.control.id !== lateQuestion,
    ),
  );
  assert.ok(
    issues.items.every(
      (item) => item.control.kind === 'issue' && item.control.id !== pendingIssues[0]!.id,
    ),
  );
  const parts: Buffer[] = [];
  let offset = 0;
  do {
    const part = await readClinicalRecordSectionFragment(db, root, profileId, source.id, {
      reference: reference.reference,
      offset,
      bytes: 1024,
    });
    parts.push(Buffer.from(part.data, 'base64'));
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  } while (true);
  assert.deepEqual(JSON.parse(Buffer.concat(parts).toString()), oracle.records[0]!.questions![0]);
  const publicPage = await reviewIntakeRead(db, root, profileId, source.id, null, {
    items: 1,
    bytes: 65536,
  });
  assert.ok(
    'format' in publicPage && publicPage.format === 'health-intake-clinical-review-page-v2',
  );
  assert.equal(publicPage.reviewToken, oracle.reviewToken);
  assert.equal(
    count(),
    before + 1,
    'all bounded transports borrow the same complete policy session',
  );
  const canonical = canonicalLiteral(questions);
  questions.items[0]!.control.kind = 'ownershipBlocker';
  questions.context.reviewToken = 'fictional-caller-mutation';
  assert.equal(
    canonicalLiteral(
      await readClinicalRecordSection(db, root, profileId, source.id, {
        ...selection,
        section: 'questions',
        limit: 2,
        bytes: 4096,
      }),
    ),
    canonical,
  );
  assert.equal(count(), before + 1);
  // The seventh question is absent from both windows but still prevents acceptance.
  await assert.rejects(
    importIntakeRead(db, root, profileId, source.id, {
      version: oracle.version,
      reviewToken: oracle.reviewToken,
      decisions: [{ recordId: record.id, action: 'accept', mapping: oracle.records[0]!.mapping }],
    }),
    { code: 'QUESTIONS_PENDING' },
  );
  await assert.rejects(
    readClinicalRecordSection(db, root, profileId, source.id, {
      ...selection,
      candidateVersionId: 'fictional-wrong-version',
      section: 'questions',
    }),
    { code: 'REVIEW_SECTION_CHANGED' },
  );
  await assert.rejects(
    readClinicalRecordSection(db, root, profileId, source.id, {
      ...selection,
      section: 'questions',
      cursor: 'fictional-wrong-cursor',
    }),
    { code: 'REVIEW_SECTION_CHANGED' },
  );
  await assert.rejects(
    readClinicalRecordSectionFragment(db, root, profileId, source.id, {
      reference: { ...reference.reference, reviewToken: 'fictional-wrong-token' },
    }),
    { code: 'REVIEW_SECTION_CHANGED' },
  );
});

test('selected section transport refuses changes during its final physical check', async (t) => {
  const { clearIdentityGrounding } = await import('../intake-identity-grounding.ts');
  const { db, root, profileId } = fixture(t);
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-section-final-check.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(envelope('section-final'))),
  });
  const record = reviewIntake(db, root, profileId, source.id).records[0]!;
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const selection = {
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
  };
  const read = () =>
    readClinicalRecordSection(db, root, profileId, source.id, { ...selection, section: 'mapping' });
  const path = profileOriginal(
    root,
    String(db.prepare('SELECT path FROM source_files WHERE id=?').get(source.id)!.path),
    profileId,
  );
  const originalBytes = readFileSync(path),
    stat = nodeFs.statSync;
  const peer = new DatabaseSync(String(db.prepare('PRAGMA database_list').get()!.file));
  let peerMutation:
    { before: unknown; after: unknown; row: unknown; complete: boolean } | undefined;
  let calls = 0,
    target = 0,
    inject: (() => void) | undefined;
  Reflect.set(nodeFs, 'statSync', ((selected, ...args) => {
    if (String(selected) === path) {
      calls++;
      if (inject && calls === target) {
        const action = inject;
        inject = undefined;
        action();
      }
    }
    return Reflect.apply(stat, nodeFs, [selected, ...args]);
  }) as typeof nodeFs.statSync);
  syncBuiltinESMExports();
  try {
    for (const change of [
      () => {
        const before = db.prepare('PRAGMA data_version').get()!.data_version;
        peerMutation = { before, after: before, row: null, complete: false };
        peer
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional-section-final-aba', 'changed');
        peer.prepare('DELETE FROM app_meta WHERE key=?').run('fictional-section-final-aba');
        peerMutation.after = db.prepare('PRAGMA data_version').get()!.data_version;
        peerMutation.row = peer
          .prepare('SELECT value FROM app_meta WHERE key=?')
          .get('fictional-section-final-aba');
        peerMutation.complete = true;
      },
      () => clearIdentityGrounding(db),
      () => writeFileSync(path, Buffer.alloc(originalBytes.length, 32)),
    ]) {
      await read();
      calls = 0;
      await read();
      assert.ok(calls > 0);
      target = calls;
      calls = 0;
      inject = change;
      await assert.rejects(read, /changed|retained clinical|source/i);
      if (peerMutation) {
        assert.equal(peerMutation.complete, true, 'both peer commits completed');
        assert.notEqual(peerMutation.after, peerMutation.before);
        assert.equal(peerMutation.row, undefined, 'peer committed ABA restored the exact rows');
        peerMutation = undefined;
      }
      assert.equal(inject, undefined, 'change reached the last consumed-original stat');
      assert.equal(reviewIssueScratchCounts(db).databases, 0);
      writeFileSync(path, originalBytes);
    }
  } finally {
    Reflect.set(nodeFs, 'statSync', stat);
    syncBuiltinESMExports();
    writeFileSync(path, originalBytes);
    peer.close();
  }
  await read();
});

test('selected section renderer refuses async values and cleans up a cancelled result handoff', async (t) => {
  const { readPreparedClinicalRecordSection } = await import('../intake-review-collection-host.ts');
  const { runExclusiveClinicalOperation } = await import('../clinical-operation.ts');
  const { db, root, profileId } = fixture(t);
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-section-render-lifetime.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(envelope('section-lifetime'))),
  });
  const record = reviewIntake(db, root, profileId, source.id).records[0]!;
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const selection = {
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
  };
  for (const output of [
    Promise.resolve({}),
    (function* () {
      yield {};
    })(),
  ]) {
    await assert.rejects(
      readPreparedClinicalRecordSection(
        db,
        root,
        profileId,
        source.id,
        selection,
        () => output as never,
      ),
      /synchronous bounded DTO/,
    );
    assert.equal(reviewIssueScratchCounts(db).databases, 0);
  }
  const controller = new AbortController();
  await assert.rejects(
    runExclusiveClinicalOperation(
      db,
      async () => {
        return readPreparedClinicalRecordSection(db, root, profileId, source.id, selection, () => {
          queueMicrotask(() => controller.abort());
          return { encoding: 'base64', data: '', totalBytes: 0, complete: true, nextOffset: null };
        });
      },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(reviewIssueScratchCounts(db).databases, 0);
  const page = await readClinicalRecordSection(db, root, profileId, source.id, {
    ...selection,
    section: 'mapping',
  });
  assert.ok(page.items.length > 0);
  assert.equal(reviewIssueScratchCounts(db).databases, 1);
  clearIntakeStateCache(db);
  assert.equal(reviewIssueScratchCounts(db).databases, 0);
});
