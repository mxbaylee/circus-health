import { prepareOwnershipIdentitySnapshots } from './ownership-identity-snapshots.ts';
/** Owned complete report preview. Its scratch rows are views, never durable authority. */
import { createOwnershipScopeIndex } from './ownership-scope-index.ts';
import {
  iterateOwnershipStreamContributions,
  OwnershipContributionSequence,
  readOwnershipStreamContribution,
  restoreOwnershipStreamContribution,
} from './ownership-contribution-stream.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from './intake-review-collection-host.ts';
import type { IntakeReview } from '../shared/intake.ts';
import type { SelectedOwnershipReviewScope } from './record-ownership-authority.ts';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  HttpError,
  currentTransactionToken,
  rejectCurrentTransaction,
  type Database,
} from './database.ts';
import { prepareOwnershipReportSelection } from './ownership-report-selection.ts';
import {
  createOwnershipPreviewStore,
  type OwnershipCommitView,
} from './ownership-preview-store.ts';
import { previewRecordOwnership, previewRecordOwnershipPrepared } from './record-ownership.ts';
import { prepareOwnershipNamePlan } from './ownership-name-plan.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { prepareCollectionReviewMembership } from './intake-review-membership-index.ts';
import { activeMappingRules } from './clinical-import.ts';
import { intakeSourceMetadata } from './intake-state-access.ts';
import { intakeDiscoveryRevision } from './intake-lookup-state.ts';
import { clinicalReviewRevision } from './database.ts';
import { workflowHash } from './intake-workflow.ts';
import { ownershipHash } from './ownership-journal.ts';
import { ownershipClinicalHeader } from './ownership-clinical-header.ts';
import { prepareOwnershipDecisionIndex } from './ownership-decision-index.ts';
import {
  createOwnershipSourceSnapshotPreparation,
  type OwnershipSourceSnapshotReference,
} from './ownership-source-snapshots.ts';
import { ownershipRequest, object } from './record-ownership-input.ts';
import type { OwnershipRequest, OwnershipPreview } from '../shared/record-ownership.ts';
import type {
  OwnershipReportPreviewReference,
  OwnershipReportEvidenceReference,
} from '../shared/ownership-report-reference.ts';
export async function prepareOwnershipReportPlan(
  db: Database,
  root: string,
  profileId: string,
  request: OwnershipRequest,
  options: { assertRunning?: () => void; onCheckpoint?: (stage: string) => void } = {},
) {
  request = structuredClone(request);
  const submittedDecisions = request.decisions ?? [],
    submittedRelationships = request.relationshipDecisions ?? [];
  request = { ...request, decisions: [], relationshipDecisions: [] };
  if (request.selection.type !== 'report')
    throw Error('Report action requires its complete selection');
  const intakeId = request.selection.intakeId,
    metadata = intakeSourceMetadata(db, intakeId).metadata;
  const mappingVersion = () =>
    workflowHash(
      activeMappingRules(
        db,
        metadata?.sourceProviderId ||
          String(
            db.prepare('SELECT provider_id FROM source_files WHERE id=?').get(intakeId)!
              .provider_id,
          ),
      ),
    );
  options.onCheckpoint?.('readiness-start');
  await prepareOwnershipDecisionIndex(db, options);
  const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, intakeId, {
    mappingVersion: mappingVersion(),
    currentMappingVersion: mappingVersion,
    assertRunning: options.assertRunning,
  });
  if (ready.state !== 'ready')
    throw new HttpError(
      409,
      'OWNERSHIP_REVIEW_PENDING',
      'Complete report clinical evidence is still being prepared',
    );
  options.onCheckpoint?.('readiness-complete');
  await prepareCollectionReviewMembership(db, { id: intakeId }, options);
  const token = randomUUID(),
    evidenceUrl =
      '/api/profiles/' +
      encodeURIComponent(profileId) +
      '/record-ownership/report-evidence/' +
      token;
  let selection = await prepareOwnershipReportSelection(db, profileId, request, options);
  // Upgrade only exact participating legacy originals before selecting the final
  // preview frontier. This is a counted cold conversion, never a legacy DTO fallback.
  const selectedClinical = clinicalReviewRevision(db),
    selectedFrontier = intakeDiscoveryRevision(db);
  let preparedSources = 0;
  selection.sql.exec('CREATE TABLE dependency_prepared(key TEXT PRIMARY KEY)');
  const prepareDependency = async (originalId: string, sourceRecordId: string) => {
    const proposal = sourceRecordId.replace(/:line:\d+$/, ''),
      proposalId = proposal === originalId ? null : proposal,
      key = JSON.stringify([originalId, proposalId]);
    if (selection.sql.prepare('SELECT 1 FROM dependency_prepared WHERE key=?').get(key)) return;
    await prepareCollectionClinicalReviewDependencies(
      db,
      root,
      profileId,
      originalId,
      proposalId,
      options,
    );
    selection.sql.prepare('INSERT INTO dependency_prepared VALUES(?)').run(key);
  };
  try {
    for (const ref of selection.records())
      for (const contribution of iterateOwnershipStreamContributions(db, ref.kind, ref.recordId, {
        scopes: () => [],
      })) {
        await prepareDependency(contribution.intakeId, contribution.sourceRecordId);
        if (++preparedSources % 32 === 0) await setImmediate();
        options.assertRunning?.();
        if (clinicalReviewRevision(db) !== selectedClinical)
          throw new HttpError(
            409,
            'OWNERSHIP_CHANGED',
            'Clinical evidence changed while preparing its exact sources',
          );
        selection.view.address(selection.view.root());
      }
    for (const pending of selection.pending()) await prepareDependency(intakeId, pending.recordId);
    if (clinicalReviewRevision(db) !== selectedClinical)
      throw new HttpError(
        409,
        'OWNERSHIP_CHANGED',
        'Clinical evidence changed while preparing its exact sources',
      );
    selection.view.address(selection.view.root());
    if (intakeDiscoveryRevision(db) !== selectedFrontier) {
      selection.close();
      selection = await prepareOwnershipReportSelection(db, profileId, request, options);
    } else selection.assertCurrent();
  } catch (error) {
    selection.close();
    throw error;
  }
  const store = createOwnershipPreviewStore(selection.sql, selection.sources, evidenceUrl);
  options.onCheckpoint?.('selection-complete');
  const scopes = createOwnershipScopeIndex(db, selection.sql, selection.assertCurrent);
  selection.sql.exec(
    'CREATE TABLE record_choices(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE relationship_choices(id TEXT PRIMARY KEY); CREATE TABLE ownership_lineage(record_key TEXT PRIMARY KEY,moving TEXT,remaining TEXT); CREATE TABLE contribution_values(record_key TEXT,ordinal INTEGER,value TEXT,PRIMARY KEY(record_key,ordinal));',
  );
  const snapshotStages: Awaited<
    ReturnType<ReturnType<typeof createOwnershipSourceSnapshotPreparation>['finish']>
  >[] = [];
  let snapshotPrepared = false;
  let identitySnapshots: Awaited<ReturnType<typeof prepareOwnershipIdentitySnapshots>> | undefined;
  for (const choice of submittedDecisions)
    selection.sql
      .prepare(
        'INSERT INTO record_choices VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(choice.recordId, JSON.stringify(choice));
  for (const choice of submittedRelationships)
    selection.sql
      .prepare('INSERT OR IGNORE INTO relationship_choices VALUES(?)')
      .run(choice.decisionId);
  const decision = (recordId: string) => {
    const row = selection.sql.prepare('SELECT value FROM record_choices WHERE id=?').get(recordId);
    return row
      ? (JSON.parse(String(row.value)) as NonNullable<OwnershipRequest['decisions']>[number])
      : undefined;
  };
  const relationshipDecision = (id: string) =>
    !!selection.sql.prepare('SELECT 1 FROM relationship_choices WHERE id=?').get(id);
  let retainedReview:
    | { key: string; review: IntakeReview; ownership: SelectedOwnershipReviewScope; close(): void }
    | undefined;
  const reviewSource = (intakeId: string, sourceId: string) => {
    const proposal = sourceId.replace(/:line:\d+$/, ''),
      key = intakeId + ':' + proposal;
    if (retainedReview?.key !== key) {
      retainedReview?.close();
      const ready = prepareCollectionClinicalReview(
        db,
        root,
        profileId,
        intakeId,
        proposal === intakeId ? null : proposal,
      );
      if (ready.status !== 'ready')
        throw new HttpError(
          409,
          'OWNERSHIP_REVIEW_FRAGMENT',
          'Selected report clinical evidence requires its complete addressed reference',
        );
      retainedReview = {
        key,
        review: ready.session.review,
        ownership: ready.session.ownership,
        close: () => ready.session.close(),
      };
    }
    return retainedReview;
  };
  let plan: Awaited<ReturnType<typeof prepareOwnershipNamePlan>> | undefined;
  try {
    await scopes.prepare(selection.reference.intakeId);
    options.onCheckpoint?.('index-complete');
    const reportSelection = (
      refs: import('../shared/record-ownership.ts').OwnershipRecordReference[],
      pending: OwnershipPreview['pending'],
    ) => ({
      sources: selection.sources,
      refs,
      pending,
      hasRecord: selection.hasRecord,
      boundary: selection.boundary,
    });
    const scopeOptions = (
      refs: import('../shared/record-ownership.ts').OwnershipRecordReference[] = [],
      pending: OwnershipPreview['pending'] = [],
    ) => ({
      selection: reportSelection(refs, pending),
      sink: store.sink,
      scopes,
      reviewSource,
      decision,
      relationshipDecision,
      contributions(kind: import('./clinical-references.ts').ClinicalKind, recordId: string) {
        const key = ownershipHash([kind, recordId]);
        return new OwnershipContributionSequence(function* () {
          for (const row of selection.sql
            .prepare('SELECT value FROM contribution_values WHERE record_key=? ORDER BY ordinal')
            .iterate(key))
            yield restoreOwnershipStreamContribution(
              db,
              kind,
              recordId,
              String(row.value),
              scopes.contributionValues.bind(scopes),
            );
        });
      },
      captureNameScopes() {},
    });
    for (const ref of selection.records()) {
      selection.assertCurrent();
      let contributionOrdinal = 0;
      for (const contribution of iterateOwnershipStreamContributions(db, ref.kind, ref.recordId, {
        scopes: () => [],
      })) {
        await scopes.prepare(contribution.intakeId);
        selection.sql
          .prepare('INSERT INTO contribution_values VALUES(?,?,?)')
          .run(
            ownershipHash([ref.kind, ref.recordId]),
            contributionOrdinal++,
            JSON.stringify(contribution),
          );
        if (contributionOrdinal % 32 === 0) {
          await setImmediate();
          selection.assertCurrent();
        }
      }
      selection.assertCurrent();
      await previewRecordOwnershipPrepared(
        db,
        root,
        profileId,
        request,
        scopeOptions([ref]),
        selection.assertCurrent,
      );
      options.onCheckpoint?.('record-complete');
      await setImmediate();
    }
    options.onCheckpoint?.('records-complete');
    const blockers = store.sink.blockerBucket('allheader');
    for (const choice of submittedDecisions)
      if (!store.sink.hasRecord(choice.recordId))
        blockers.push('A matching decision is outside this selection.');
    for (const choice of submittedRelationships)
      if (!store.sink.relationships.has(choice.decisionId))
        blockers.push('A relationship decision is outside this selection.');
    for (const pending of selection.pending()) {
      selection.assertCurrent();
      const partial = previewRecordOwnership(
        db,
        root,
        profileId,
        request,
        scopeOptions([], [pending]),
      );
      void partial;
      for (const blocker of store.sink.blockerBucket('header', false).values())
        blockers.push(blocker);
      await setImmediate();
    }
    options.onCheckpoint?.('pending-complete');
    plan = await prepareOwnershipNamePlan(
      db,
      profileId,
      store.sink.sources,
      store.sink.owners,
      request,
      { ...options, ownedReportScopes: true, scopes },
    );
    options.onCheckpoint?.('names-complete');
    const finalize = () => {
      selection.assertCurrent();
      plan!.assertCurrent();
      const header = previewRecordOwnership(db, root, profileId, request, {
        ...scopeOptions(),
        namePlan: plan,
      });
      const bucket = store.sink.blockerBucket('header', false);
      for (const blocker of blockers.values()) bucket.push(blocker);
      Object.assign(header, { blockerEvidence: bucket.reference() });
      return header;
    };
    let header = finalize();
    const reference: OwnershipReportEvidenceReference = {
      token,
      digest: ownershipHash([selection.reference, store.sink.digest]),
      complete: true,
      recordTotal: store.records.length,
      pendingTotal: store.pending.length,
      relationshipTotal: store.relationships.length,
      recordBlockerTotal: store.recordBlockerTotal,
      url: evidenceUrl,
    };
    let stageToken: ReturnType<typeof currentTransactionToken>;
    const refresh = () => {
      header = finalize();
      reference.digest = ownershipHash([selection.reference, store.sink.digest]);
      reference.recordBlockerTotal = store.recordBlockerTotal;
      return header;
    };
    return {
      plan,
      scopes,
      decision,
      contributions(
        kind: import('./clinical-references.ts').ClinicalKind,
        recordId: string,
        selected?: boolean,
      ) {
        const key = ownershipHash([kind, recordId]);
        return new OwnershipContributionSequence(function* () {
          for (const row of selection.sql
            .prepare(
              'SELECT source_id FROM preview_contributions WHERE record_key=?' +
                (selected === undefined ? '' : ' AND selected=?') +
                ' ORDER BY ordinal',
            )
            .iterate(...(selected === undefined ? [key] : [key, Number(selected)])))
            yield readOwnershipStreamContribution(db, kind, recordId, String(row.source_id));
        });
      },
      async prepareSourceSnapshots() {
        if (snapshotPrepared) {
          for (const stage of snapshotStages) stage.assertCurrent();
          return;
        }
        selection.assertCurrent();
        plan!.assertCurrent();
        selection.sql.exec('DELETE FROM ownership_lineage');
        const factories = new Map<
          string,
          ReturnType<typeof createOwnershipSourceSnapshotPreparation>
        >();
        try {
          for (const item of store.records) {
            if (item.action === 'unchanged' || !item.splitReviewRequired) continue;
            const clinical = ownershipClinicalHeader(db, item.kind, item.recordId),
              audit = clinical.extra.import.ownershipReview as
                { sourceRecordIdsReference?: OwnershipSourceSnapshotReference } | undefined,
              previous = audit?.sourceRecordIdsReference,
              custodian = previous?.source.intakeId ?? intakeId;
            let factory = factories.get(custodian);
            if (!factory) {
              factory = createOwnershipSourceSnapshotPreparation(
                db,
                { id: custodian },
                {
                  assertRunning: () => {
                    selection.assertCurrent();
                    plan!.assertCurrent();
                  },
                },
              );
              factories.set(custodian, factory);
            }
            const key = ownershipHash([item.kind, item.recordId]);
            const ids = function* (selected?: boolean) {
              for (const row of selection.sql
                .prepare(
                  'SELECT source_id FROM preview_contributions WHERE record_key=?' +
                    (selected === undefined ? '' : ' AND selected=?') +
                    ' ORDER BY ordinal',
                )
                .iterate(...(selected === undefined ? [key] : [key, Number(selected)])))
                yield String(row.source_id);
            };
            const snapshots = await factory.prepareSplit({
              previous,
              sourceRecordIds: () => ids(),
              movingSourceRecordIds: () => ids(true),
            });
            selection.sql
              .prepare('INSERT INTO ownership_lineage VALUES(?,?,?)')
              .run(key, JSON.stringify(snapshots.moving), JSON.stringify(snapshots.remaining));
          }
          const factoryFor = (id: string) => {
            let factory = factories.get(id);
            if (!factory) {
              factory = createOwnershipSourceSnapshotPreparation(
                db,
                { id },
                {
                  assertRunning: () => {
                    selection.assertCurrent();
                    plan!.assertCurrent();
                  },
                },
              );
              factories.set(id, factory);
            }
            return factory;
          };
          identitySnapshots = await prepareOwnershipIdentitySnapshots(db, selection.sql, {
            factory: factoryFor,
            record: (intakeId, recordId) =>
              reviewSource(intakeId, recordId).review.records.find(
                (record) => record.id === recordId,
              ),
            report: { intakeId, groupId: selection.reference.groupId },
            sources: (function* () {
              for (const item of store.records)
                for (const c of iterateOwnershipStreamContributions(db, item.kind, item.recordId, {
                  scopes: scopes.contributionValues.bind(scopes),
                }))
                  yield { intakeId: c.intakeId, recordId: c.sourceRecordId, identity: c.identity };
              for (const recordId of selection.occurrences()) yield { intakeId, recordId };
            })(),
          });
          for (const factory of factories.values()) snapshotStages.push(await factory.finish());
          selection.assertCurrent();
          plan!.assertCurrent();
          snapshotPrepared = true;
        } catch (error) {
          for (const stage of snapshotStages) stage.dispose();
          snapshotStages.length = 0;
          throw error;
        }
      },
      identityIssues(intakeId: string, recordId: string) {
        if (!identitySnapshots) throw Error('Identity authority preparation required');
        return identitySnapshots.forSource(intakeId, recordId);
      },
      reportIdentityIssues() {
        if (!identitySnapshots) throw Error('Identity authority preparation required');
        return identitySnapshots.forReport();
      },
      sourceSnapshots(kind: string, recordId: string) {
        if (!snapshotPrepared)
          throw Error('Ownership source snapshots require completed preparation');
        const row = selection.sql
          .prepare('SELECT moving,remaining FROM ownership_lineage WHERE record_key=?')
          .get(ownershipHash([kind, recordId]));
        if (!row) throw Error('Ownership split source snapshots are unavailable');
        return {
          moving: JSON.parse(String(row.moving)) as OwnershipSourceSnapshotReference,
          remaining: JSON.parse(String(row.remaining)) as OwnershipSourceSnapshotReference,
        };
      },
      stageSourceSnapshots() {
        if (!snapshotPrepared)
          throw Error('Ownership source snapshots require completed preparation');
        for (const stage of snapshotStages) stage.assertCurrent();
        for (const stage of snapshotStages) stage.apply();
      },
      reference,
      boundary: selection.boundary,
      occurrences: selection.occurrences,
      assertCurrent: selection.assertCurrent,
      finalize: refresh,
      *choices() {
        selection.assertCurrent();
        for (const row of selection.sql
          .prepare('SELECT id,value FROM record_choices ORDER BY id')
          .iterate())
          yield { recordId: String(row.id), decision: JSON.parse(String(row.value)) };
        for (const row of selection.sql
          .prepare('SELECT id FROM relationship_choices ORDER BY id')
          .iterate())
          yield { relationshipId: String(row.id), withdraw: true };
      },
      async choose(input: unknown) {
        selection.assertCurrent();
        plan!.assertCurrent();
        if (!object(input))
          throw new HttpError(400, 'OWNERSHIP_DECISION', 'Choose one displayed report decision');
        const restore = store.checkpoint(),
          previousHeader = header,
          previousReference = { ...reference };
        selection.sql.exec('SAVEPOINT ownership_choice');
        try {
          let recordId: string;
          if (
            'recordId' in input &&
            typeof input.recordId === 'string' &&
            object(input.decision) &&
            Object.keys(input).every((key) => ['recordId', 'decision'].includes(key))
          ) {
            recordId = input.recordId;
            if (!store.sink.hasRecord(recordId))
              throw new HttpError(
                400,
                'OWNERSHIP_DECISION',
                'The record is outside this complete report selection',
              );
            const parsed = ownershipRequest({
              ...request,
              decisions: [{ ...decision(recordId), ...input.decision, recordId }],
            }).decisions![0]!;
            selection.sql
              .prepare(
                'INSERT INTO record_choices VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
              )
              .run(recordId, JSON.stringify(parsed));
          } else if (
            'relationshipId' in input &&
            typeof input.relationshipId === 'string' &&
            typeof input.withdraw === 'boolean' &&
            Object.keys(input).every((key) => ['relationshipId', 'withdraw'].includes(key))
          ) {
            const row = selection.sql
              .prepare('SELECT value FROM preview_relationships WHERE id=?')
              .get(input.relationshipId);
            if (!row)
              throw new HttpError(
                400,
                'OWNERSHIP_DECISION',
                'The relationship is outside this complete report selection',
              );
            recordId = (JSON.parse(String(row.value)) as OwnershipPreview['relationships'][number])
              .recordId;
            if (input.withdraw)
              selection.sql
                .prepare('INSERT OR IGNORE INTO relationship_choices VALUES(?)')
                .run(input.relationshipId);
            else
              selection.sql
                .prepare('DELETE FROM relationship_choices WHERE id=?')
                .run(input.relationshipId);
          } else
            throw new HttpError(400, 'OWNERSHIP_DECISION', 'Choose one displayed report decision');
          const affected = selection.sql
            .prepare(
              "SELECT s.kind,s.record_id FROM sorted s WHERE s.record_id=? OR EXISTS(SELECT 1 FROM preview_relationships r WHERE (json_extract(r.value,'$.recordId')=? OR json_extract(r.value,'$.otherRecordId')=?) AND (s.record_id=json_extract(r.value,'$.recordId') OR s.record_id=json_extract(r.value,'$.otherRecordId'))) ORDER BY s.rank",
            )
            .iterate(recordId, recordId, recordId);
          for (const row of affected) {
            selection.assertCurrent();
            await previewRecordOwnershipPrepared(
              db,
              root,
              profileId,
              request,
              scopeOptions([
                {
                  kind: row.kind as import('./clinical-references.ts').ClinicalKind,
                  recordId: String(row.record_id),
                },
              ]),
              selection.assertCurrent,
            );
            await setImmediate();
          }
          refresh();
          selection.sql.exec('RELEASE ownership_choice');
        } catch (error) {
          try {
            selection.sql.exec('ROLLBACK TO ownership_choice; RELEASE ownership_choice');
          } catch {
            /* Profile lock can close the disposable plan while preparation yields. */
          }
          restore();
          header = previousHeader;
          Object.assign(reference, previousReference);
          throw error;
        }
      },
      assertForTransaction() {
        selection.assertCurrent();
        stageToken = currentTransactionToken(db);
        if (!stageToken) throw Error('Report publication requires its owned atomic transaction');
      },
      preview(): OwnershipCommitView {
        if (!stageToken || stageToken !== currentTransactionToken(db))
          throw Error('Report preview belongs to another transaction');
        selection.assertCurrent();
        return {
          ...header,
          records: store.records,
          pending: store.pending,
          relationships: store.relationships,
        };
      },
      publicPreview(): OwnershipReportPreviewReference {
        selection.assertCurrent();
        const {
          records,
          pending,
          names,
          relationships,
          commitGroups,
          blockers: legacyBlockers,
          ...rest
        } = header;
        const blockerEvidence = (header as OwnershipCommitView).blockerEvidence;
        void legacyBlockers;
        void records;
        void pending;
        void names;
        void relationships;
        return {
          ...rest,
          blockers: blockerEvidence ? store.sink.blockerBucket('header', false).presentation() : [],
          namesIncluded: false,
          nameEvidence: plan!.reference,
          recordsIncluded: false,
          pendingIncluded: false,
          relationshipsIncluded: false,
          reportEvidence: reference,
          commitGroups: [
            {
              id: commitGroups[0]!.id,
              atomic: true,
              recordTotal: reference.recordTotal,
              pendingCount: reference.pendingTotal,
              url: reference.url,
            },
          ],
        };
      },
      contributionPage(key: string, source: string | null, after = -1, limit = 16, bytes = 65536) {
        selection.assertCurrent();
        plan!.assertCurrent();
        if (
          !/^[a-f0-9]{64}$/.test(key) ||
          !Number.isSafeInteger(after) ||
          after < -1 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 32 ||
          !Number.isSafeInteger(bytes) ||
          bytes < 1 ||
          bytes > 65536
        )
          throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid contribution evidence page');
        const table = source === null ? 'preview_contributions' : 'preview_contribution_scopes',
          predicate = 'record_key=?' + (source === null ? '' : ' AND source_id=?'),
          parameters = source === null ? [key] : [key, source],
          total = Number(
            selection.sql
              .prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE ' + predicate)
              .get(...parameters)!.n,
          ),
          rows = selection.sql
            .prepare(
              'SELECT ordinal,length(CAST(value AS BLOB)) bytes FROM ' +
                table +
                ' WHERE ' +
                predicate +
                ' AND ordinal>? ORDER BY ordinal LIMIT ?',
            )
            .all(...parameters, after, limit + 1);
        const items: unknown[] = [];
        let used = 0;
        for (const row of rows.slice(0, limit)) {
          if (Number(row.bytes) > bytes - used) {
            items.push({
              type: 'contribution-fragment',
              ordinal: Number(row.ordinal),
              bytes: Number(row.bytes),
              url:
                evidenceUrl +
                '?contribution=' +
                key +
                (source === null ? '' : '&source=' + encodeURIComponent(source)),
            });
            used += 256;
          } else {
            items.push(
              JSON.parse(
                String(
                  selection.sql
                    .prepare(
                      'SELECT value FROM ' + table + ' WHERE ' + predicate + ' AND ordinal=?',
                    )
                    .get(...parameters, row.ordinal)!.value,
                ),
              ),
            );
            used += Number(row.bytes);
          }
        }
        return {
          items,
          total,
          complete: rows.length <= limit,
          after: rows.length > limit ? String(rows[limit - 1]!.ordinal) : null,
        };
      },
      contributionFragment(
        key: string,
        source: string | null,
        ordinal: number,
        offset: number,
        bytes = 32768,
      ) {
        selection.assertCurrent();
        plan!.assertCurrent();
        if (
          !/^[a-f0-9]{64}$/.test(key) ||
          !Number.isSafeInteger(ordinal) ||
          ordinal < 0 ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(bytes) ||
          bytes < 1 ||
          bytes > 32768
        )
          throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid contribution fragment cursor');
        const table = source === null ? 'preview_contributions' : 'preview_contribution_scopes',
          predicate = 'record_key=?' + (source === null ? '' : ' AND source_id=?'),
          parameters = source === null ? [key] : [key, source];
        const row = selection.sql
          .prepare(
            'SELECT length(CAST(value AS BLOB)) bytes,substr(CAST(value AS BLOB),?,?) data FROM ' +
              table +
              ' WHERE ' +
              predicate +
              ' AND ordinal=?',
          )
          .get(offset + 1, bytes, ...parameters, ordinal);
        if (!row || offset > Number(row.bytes))
          throw new HttpError(
            400,
            'OWNERSHIP_CURSOR',
            'Contribution fragment is outside selected evidence',
          );
        const data = Buffer.from(row.data as Uint8Array),
          nextOffset = offset + data.length;
        return {
          encoding: 'base64' as const,
          data: data.toString('base64'),
          complete: nextOffset === Number(row.bytes),
          nextOffset,
        };
      },
      fragment(
        section: 'records' | 'pending' | 'relationships',
        ordinal: number,
        offset: number,
        bytes = 65536,
      ) {
        selection.assertCurrent();
        plan!.assertCurrent();
        if (
          !['records', 'pending', 'relationships'].includes(section) ||
          !Number.isSafeInteger(ordinal) ||
          ordinal < 0 ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(bytes) ||
          bytes < 1 ||
          bytes > 65536
        )
          throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid report fragment cursor');
        const row = selection.sql
          .prepare(
            'SELECT length(CAST(value AS BLOB)) bytes,substr(CAST(value AS BLOB),?,?) data FROM preview_' +
              section +
              ' WHERE ordinal=?',
          )
          .get(offset + 1, bytes, ordinal);
        if (!row || offset > Number(row.bytes))
          throw new HttpError(
            400,
            'OWNERSHIP_CURSOR',
            'Report fragment is outside selected evidence',
          );
        const data = Buffer.from(row.data as Uint8Array),
          nextOffset = offset + data.byteLength;
        return {
          encoding: 'base64' as const,
          data: data.toString('base64'),
          complete: nextOffset === Number(row.bytes),
          nextOffset,
        };
      },
      page(
        section: 'records' | 'pending' | 'relationships',
        after = -1,
        limit = 32,
        bytes = 65536,
      ) {
        selection.assertCurrent();
        plan!.assertCurrent();
        if (
          !Number.isSafeInteger(after) ||
          after < -1 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 32 ||
          !Number.isSafeInteger(bytes) ||
          bytes < 1 ||
          bytes > 65536
        )
          throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid report evidence page');
        const table = 'preview_' + section,
          total =
            section === 'records'
              ? reference.recordTotal
              : section === 'pending'
                ? reference.pendingTotal
                : reference.relationshipTotal;
        const rows = selection.sql
            .prepare(
              'SELECT ordinal,length(CAST(value AS BLOB)) bytes FROM ' +
                table +
                ' WHERE ordinal>? ORDER BY ordinal LIMIT ?',
            )
            .all(after, limit + 1),
          more = rows.length > limit;
        const items: import('../shared/ownership-report-reference.ts').OwnershipReportPageItem[] =
          [];
        let used = 0;
        for (const row of rows.slice(0, limit)) {
          const size = Number(row.bytes);
          if (size > bytes - used) {
            items.push({
              type: 'reference',
              section,
              ordinal: Number(row.ordinal),
              bytes: size,
              token,
              url: reference.url,
            });
            used += 128;
          } else {
            const value = selection.sql
              .prepare('SELECT value FROM ' + table + ' WHERE ordinal=?')
              .get(row.ordinal)!;
            items.push(JSON.parse(String(value.value)));
            used += size;
          }
        }
        return {
          items,
          total,
          complete: !more,
          after: more ? String(rows[limit - 1]!.ordinal) : null,
        };
      },
      close() {
        retainedReview?.close();
        for (const stage of snapshotStages) stage.dispose();
        plan!.close();
        selection.close();
      },
    };
  } catch (error) {
    retainedReview?.close();
    plan?.close();
    selection.close();
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}
export type PreparedOwnershipReportPlan = Awaited<ReturnType<typeof prepareOwnershipReportPlan>>;
