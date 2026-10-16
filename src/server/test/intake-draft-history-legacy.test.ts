import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, reviewIntake, saveIntakeReviewDraftRead } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import {
  createLegacyDraftHistoryReference,
  checkLegacyDraftHistoryReference,
  readLegacyDraftHistoryPage,
  readLegacyDraftHistoryFragment,
} from '../intake-draft-history-legacy.ts';
import { readLegacyDraftPolicyWitnesses } from '../intake-draft-policy-index.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearIntakeCollectionEvidenceFragments } from '../intake-evidence-fragment.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { workflowHash } from '../intake-workflow.ts';
import type { IntakeIssueResolution, IntakeReviewDraft } from '../../shared/intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { readNativeReviewDraft, readReviewDraftHistoryPage } from '../intake-review-draft-state.ts';
import {
  reviewDraftResolutions,
  latestReviewDraftResolution,
  knownReviewDraftResolution,
  latestSelfReviewDraftResolution,
} from '../intake-review-draft-selection.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import { canonicalLiteral } from '../intake-format.ts';

test(
  'large legacy draft policy is indexed once while exact history remains paged and survives later appends',
  { timeout: 120000 },
  async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(join(tmpdir(), 'fictional-old-draft-')),
      profileId = 'fictional',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearIntakeCollectionEvidenceFragments(db);
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        JSON.stringify({
          format: 'health-record-v1',
          id: 'record',
          kind: 'record',
          payload: { literal: 'Fictional document' },
          clinical: { kind: 'document', subject: 'self', documentTitle: 'Fictional history' },
          provenance: {
            sourceSystem: 'Fictional',
            sourceRecordId: 'record',
            capturedVia: null,
            evidenceClass: 'provider_export',
            locator: 'line 1',
          },
          coverage: { status: 'complete_response', notes: [] },
        }),
      ),
    });
    const record = reviewIntake(db, root, profileId, source.id).records[0]!;
    const draft: IntakeReviewDraft = {
      id: 'historical',
      proposalId: null,
      recordId: record.id,
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      mapping: {},
      disposition: 'pending',
      at: '2026-01-01',
      resolutions: Array.from({ length: 130 }, (_, index) => ({
        issueId: index === 0 ? 'identity' : 'measurement',
        outcome: (index === 0
          ? 'this_is_me'
          : index % 2
            ? 'unknown'
            : 'confirmed') as IntakeIssueResolution['outcome'],
        operationId: 'old-' + index,
        mapping: { method: ('Fictional ' + index).padEnd(2000, '.') },
        literalNumber: JSON.rawJSON('12.00'),
      })),
      corrections: [
        {
          operationId: 'historical',
          at: '2026-01-01',
          reason: 'Fictional reason '.repeat(6000),
          before: {},
          after: {},
        },
      ],
    };
    await buildIntakeCollectionEnvelope(db, { id: source.id });
    const initial = openIntakeCollectionEnvelope(db, { id: source.id });
    const fixtureOperationId = randomUUID();
    const inserted = await prepareIntakeEnvelopeMutation(
      db,
      { id: source.id },
      {
        reader: initial,
        operationId: fixtureOperationId,
        requestDigest: workflowHash(fixtureOperationId),
        domainVersion: initial.logical.domainVersion + 1,
        changes: [
          {
            op: 'append',
            record: initial.child(initial.child(initial.root(), 'intake')!, 'workflow')!,
            field: 'reviewDrafts',
            jsonText: JSON.stringify(draft),
          },
        ],
      },
    );
    transaction(db, () =>
      selectedEnvelopeStore(db, { id: source.id }).collections.stage(inserted.prepared!),
    );
    const options = { mappingVersion: 'fictional', isSourceContextVersion: () => false };
    await buildVerifiedWorkflowSummary(db, { id: source.id }, options);
    const view = openIntakeCollectionEnvelope(db, { id: source.id }),
      flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
      selected = view.childAt(flow, 'reviewDrafts', 0)!;
    const before = { ...intakeWorkCounters(db).warm };
    let resolutionLookups = 0;
    const childAt = view.childAt;
    view.childAt = (parent, field, ordinal) => {
      if (view.address(parent) === view.address(selected) && field === 'resolutions')
        resolutionLookups++;
      return childAt(parent, field, ordinal);
    };
    const witnesses = readLegacyDraftPolicyWitnesses(db, { id: source.id }, view, selected, {
      bytes: 32768,
    });
    const witnessValues = [...witnesses.policy.values()];
    assert.deepEqual(
      witnessValues.map((value) => value.operationId),
      ['old-0', 'old-128', 'old-129'],
    );
    assert.match(JSON.stringify(witnessValues.at(-1)), /"literalNumber":12\.00/);
    assert.deepEqual(witnesses.counts, { resolutions: 130, corrections: 1 });
    assert.equal(
      resolutionLookups,
      3,
      'selected policy visits only its three exact witness records',
    );
    assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
    const reference = createLegacyDraftHistoryReference(db, { id: source.id }, view, selected);
    assert.equal(reference.ordinal, 0);
    const page = readLegacyDraftHistoryPage(db, { id: source.id }, reference, {
      section: 'resolutions',
      offset: 128,
      limit: 2,
    });
    assert.equal(page.total, 130);
    assert.equal(page.complete, true);
    assert.equal(page.items.length, 2);
    const correction = readLegacyDraftHistoryPage(db, { id: source.id }, reference, {
      section: 'corrections',
    });
    assert.ok('reference' in correction.items[0]!);
    let cursor: string | undefined,
      output = '',
      first = true;
    do {
      const counted = intakeWorkCounters(db).warm.collectionEvidenceFragmentInputBytes;
      const part = await readLegacyDraftHistoryFragment(
        db,
        root,
        profileId,
        { id: source.id },
        reference,
        { section: 'corrections', ordinal: 0, cursor },
      );
      if (!first)
        assert.equal(
          intakeWorkCounters(db).warm.collectionEvidenceFragmentInputBytes,
          counted,
          'later bytes do not spool the prefix again',
        );
      first = false;
      output += Buffer.from(part.data, 'base64').toString();
      cursor = part.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(JSON.parse(output), draft.corrections![0]);
    assert.throws(
      () =>
        checkLegacyDraftHistoryReference(db, { id: source.id }, { ...reference, resolutions: 129 }),
      { code: 'REVIEW_HISTORY_CHANGED' },
    );
    const operationId = randomUUID();
    const appended = await prepareIntakeEnvelopeMutation(
      db,
      { id: source.id },
      {
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
              ...draft,
              id: 'later-native',
              format: 'health-intake-review-draft-v2',
              resolutions: [],
              corrections: [],
            }),
          },
        ],
      },
    );
    transaction(db, () =>
      selectedEnvelopeStore(db, { id: source.id }).collections.stage(appended.prepared!),
    );
    clearIntakeStateCache(db);
    const retained = checkLegacyDraftHistoryReference(db, { id: source.id }, reference);
    assert.equal(retained.view.childCount(retained.draft, 'resolutions'), 130);
    assert.throws(
      () =>
        checkLegacyDraftHistoryReference(
          db,
          { id: source.id },
          { ...reference, ordinal: 1, draftId: 'later-native', resolutions: 0, corrections: 0 },
        ),
      { code: 'REVIEW_HISTORY_CHANGED' },
    );
    await buildVerifiedWorkflowSummary(db, { id: source.id }, options);
    const checked = checkLegacyDraftHistoryReference(db, { id: source.id }, reference);
    assert.equal(
      [
        ...readLegacyDraftPolicyWitnesses(db, { id: source.id }, checked.view, checked.draft, {
          bytes: 32768,
        }).policy.values(),
      ].length,
      3,
    );
  },
);

// Real encrypted legacy-history migration, two public saves and cache-loss
// recovery need an integration hang guard. Counts and exact canonical hashes
// qualify the contract independently of host speed.
test(
  'draft policy streams more than 256 KiB of distinct witnesses through native saves without copying retained resolutions',
  { timeout: 180000 },
  async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(join(tmpdir(), 'fictional-complete-draft-policy-')),
      profileId = 'fictional',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearIntakeCollectionEvidenceFragments(db);
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        JSON.stringify({
          format: 'health-record-v1',
          id: 'complete-policy-record',
          kind: 'record',
          payload: { literal: 'Independent fictional policy history document' },
          clinical: { kind: 'document', subject: 'self', documentTitle: 'Fictional history' },
          provenance: {
            sourceSystem: 'Fictional',
            sourceRecordId: 'complete-policy-record',
            capturedVia: null,
            evidenceClass: 'provider_export',
            locator: 'line 1',
          },
          coverage: { status: 'complete_response', notes: [] },
          reviewIssues: [
            {
              kind: 'uncertain_reading',
              field: 'documentTitle',
              prompt: 'Confirm the fictional title',
            },
          ],
        }),
      ),
    });
    const record = reviewIntake(db, root, profileId, source.id).records[0]!,
      freshIssue = record.issues?.find((issue) => issue.kind === 'uncertain_reading');
    assert.ok(freshIssue);
    type HistoricalResolution = IntakeIssueResolution & {
      unknownEvidence: {
        literalNumber: ReturnType<typeof JSON.rawJSON>;
        names: string[];
        originalOrdinal: string;
      };
    };
    const resolutions: HistoricalResolution[] = Array.from({ length: 120 }, (_, index) => ({
      issueId: 'historical-issue:' + index,
      outcome: index === 0 ? 'this_is_me' : 'confirmed',
      operationId: 'old-' + index,
      mapping: { method: ('Fictional retained mapping ' + index).padEnd(2200, '.') },
      unknownEvidence: {
        literalNumber: JSON.rawJSON(index % 2 ? '12.00' : '1.200e+1'),
        names: ['Independent fictional witness ' + index],
        originalOrdinal: String(index),
      },
    }));
    for (const [issue, outcome] of [
      [0, 'unknown'],
      [1, 'unknown'],
      [2, 'this_is_me'],
      [2, 'unknown'],
    ] as const) {
      const ordinal = resolutions.length;
      resolutions.push({
        ...resolutions[issue]!,
        outcome,
        operationId: 'old-' + ordinal,
        unknownEvidence: {
          ...resolutions[issue]!.unknownEvidence,
          originalOrdinal: String(ordinal),
        },
      });
    }
    const historical: IntakeReviewDraft = {
      id: 'historical-complete-policy',
      proposalId: null,
      recordId: record.id,
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      mapping: {},
      disposition: 'pending',
      at: '2026-01-01',
      resolutions,
      corrections: [],
    };
    // Independent array oracle is confined to fictional source history. The selected
    // provider below is traversed directly, never materialized into another array.
    const witnessOracle = (history: readonly IntakeIssueResolution[]) => {
      const selected = new Set<number>(),
        latest = new Map<string, number>(),
        known = new Map<string, number>();
      let self: number | undefined;
      history.forEach((value, index) => {
        latest.set(value.issueId, index);
        if (value.outcome !== 'unknown') known.set(value.issueId, index);
        if (value.outcome === 'this_is_me') self = index;
      });
      for (const index of [...latest.values(), ...known.values()]) selected.add(index);
      if (self !== undefined) selected.add(self);
      return [...selected].sort((a, b) => a - b).map((index) => history[index]!);
    };
    const initialWitnesses = witnessOracle(resolutions);
    assert.equal(initialWitnesses.length, 123);
    assert.ok(Buffer.byteLength(JSON.stringify(initialWitnesses)) > 256 * 1024);
    const hash = (chunks: Iterable<string>) => {
      const digest = createHash('sha256');
      for (const chunk of chunks) digest.update(chunk);
      return digest.digest('hex');
    };
    const verifyPolicy = (draft: IntakeReviewDraft, expected: readonly IntakeIssueResolution[]) => {
      assert.deepEqual(draft.resolutions, []);
      assert.deepEqual(draft.resolutionsReference, {
        format: 'health-intake-review-draft-resolutions-v1',
        count: expected.length,
      });
      let ordinal = 0;
      for (const actual of reviewDraftResolutions(draft)) {
        assert.equal(
          canonicalLiteral(actual),
          canonicalLiteral(expected[ordinal]),
          'ordered complete witness ' + ordinal,
        );
        ordinal++;
      }
      assert.equal(ordinal, expected.length);
      for (let issue = 0; issue < 120; issue++) {
        const issueId = 'historical-issue:' + issue;
        assert.equal(
          canonicalLiteral(latestReviewDraftResolution(draft, issueId)),
          canonicalLiteral(expected.findLast((value) => value.issueId === issueId)),
        );
        assert.equal(
          canonicalLiteral(knownReviewDraftResolution(draft, issueId)),
          canonicalLiteral(
            expected.findLast((value) => value.issueId === issueId && value.outcome !== 'unknown'),
          ),
        );
      }
      assert.equal(latestSelfReviewDraftResolution(draft)?.operationId, 'old-122');
      assert.equal(latestReviewDraftResolution(draft, 'missing-issue'), undefined);
      assert.equal(knownReviewDraftResolution(draft, 'missing-issue'), undefined);
      const { resolutionsReference: _reference, ...header } = draft;
      assert.equal(
        hash(canonicalReviewValueChunks(draft)),
        hash([canonicalLiteral({ ...header, resolutions: expected })]),
        'presentation references preserve the full ordered canonical token input',
      );
      assert.match(
        canonicalLiteral(latestReviewDraftResolution(draft, 'historical-issue:119')),
        /"literalNumber":12\.00/,
      );
      assert.match(
        canonicalLiteral(knownReviewDraftResolution(draft, 'historical-issue:0')),
        /"literalNumber":1\.200e\+1/,
      );
    };
    await buildIntakeCollectionEnvelope(db, { id: source.id });
    const initial = openIntakeCollectionEnvelope(db, { id: source.id }),
      operationId = randomUUID();
    const inserted = await prepareIntakeEnvelopeMutation(
      db,
      { id: source.id },
      {
        reader: initial,
        operationId,
        requestDigest: workflowHash(operationId),
        domainVersion: initial.logical.domainVersion + 1,
        changes: [
          {
            op: 'append',
            record: initial.child(initial.child(initial.root(), 'intake')!, 'workflow')!,
            field: 'reviewDrafts',
            jsonText: JSON.stringify(historical),
          },
        ],
      },
    );
    transaction(db, () =>
      selectedEnvelopeStore(db, { id: source.id }).collections.stage(inserted.prepared!),
    );
    await buildVerifiedWorkflowSummary(
      db,
      { id: source.id },
      { mappingVersion: 'fictional', isSourceContextVersion: () => false },
    );
    const readLatest = () => {
      const view = openIntakeCollectionEnvelope(db, { id: source.id }),
        flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
        draftRecord = view.childAt(
          flow,
          'reviewDrafts',
          view.childCount(flow, 'reviewDrafts') - 1,
        )!,
        catalog = createReportSnapshotCatalog(
          db,
          { id: source.id },
          { catalog: 'review.snapshots' },
        );
      return {
        view,
        flow,
        draftRecord,
        draft: readNativeReviewDraft(view, draftRecord, catalog, 8192, {
          db,
          source: { id: source.id },
        }),
      };
    };
    const legacy = readLatest();
    verifyPolicy(legacy.draft, initialWitnesses);
    assert.equal(legacy.draft.history?.format, 'health-intake-review-draft-legacy-history-v1');
    const before = { ...intakeWorkCounters(db).warm };
    const first = await saveIntakeReviewDraftRead(db, root, profileId, source.id, {
      version: legacy.view.logical.domainVersion,
      operationId: 'first-complete-policy-save',
      proposalId: null,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      resolutions: [{ issueId: freshIssue.id, outcome: 'confirmed' }],
    });
    const migrated = readLatest();
    assert.equal(
      migrated.view.childCount(migrated.draftRecord, 'resolutions'),
      1,
      'the first native save stores only its new resolution',
    );
    assert.equal(migrated.draft.history?.format, 'health-intake-review-draft-history-v1');
    assert.equal(migrated.draft.history?.resolutions, resolutions.length + 1);
    const savedPage = readReviewDraftHistoryPage(db, { id: source.id }, migrated.draft.history!, {
      section: 'resolutions',
      offset: resolutions.length,
      limit: 1,
    });
    const newItem = savedPage.items[0]!;
    assert.ok('value' in newItem);
    const newResolution = newItem.value as IntakeIssueResolution;
    assert.equal(newResolution.issueId, freshIssue.id);
    assert.equal(newResolution.operationId, 'first-complete-policy-save');
    verifyPolicy(migrated.draft, [...initialWitnesses, newResolution]);
    await saveIntakeReviewDraftRead(db, root, profileId, source.id, {
      version: first.version,
      operationId: 'second-complete-policy-save',
      proposalId: null,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      resolutions: [{ issueId: freshIssue.id, outcome: 'unknown' }],
    });
    clearIntakeStateCache(db);
    const later = readLatest();
    assert.equal(
      later.view.childCount(later.draftRecord, 'resolutions'),
      1,
      'a later save never copies the previous witness collection',
    );
    assert.equal(later.draft.history?.resolutions, resolutions.length + 2);
    const laterPage = readReviewDraftHistoryPage(db, { id: source.id }, later.draft.history!, {
      section: 'resolutions',
      offset: resolutions.length + 1,
      limit: 1,
    });
    const laterItem = laterPage.items[0]!;
    assert.ok('value' in laterItem);
    const laterResolution = laterItem.value as IntakeIssueResolution;
    assert.equal(laterResolution.outcome, 'unknown');
    verifyPolicy(later.draft, [...initialWitnesses, newResolution, laterResolution]);
    assert.equal(latestReviewDraftResolution(later.draft, freshIssue.id)?.outcome, 'unknown');
    assert.equal(knownReviewDraftResolution(later.draft, freshIssue.id)?.outcome, 'confirmed');
    const historyStart = readReviewDraftHistoryPage(db, { id: source.id }, later.draft.history!, {
      section: 'resolutions',
      offset: 0,
      limit: 2,
    });
    assert.equal(historyStart.total, resolutions.length + 2);
    assert.ok('value' in historyStart.items[0]!);
    assert.equal(canonicalLiteral(historyStart.items[0].value), canonicalLiteral(resolutions[0]));
    assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
    assert.equal(intakeWorkCounters(db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  },
);
