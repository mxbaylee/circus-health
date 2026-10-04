import { prepareNativeReportSourceReviewScope } from './intake-report-source-review-scope.ts';
/** Native source receipt composer. The host stages its capability with provider writes under its writer lease. */
import { createHash, randomUUID } from 'node:crypto';
import type { IntakeReportSourceUpdate } from '../shared/intake.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type { IntakeReportSourceConfirmationV2 } from '../shared/intake-report-source-reference.ts';
import { HttpError, safeText, type Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  prepareIntakeEnvelopeMutation,
  type IntakeEnvelopeDerivedPreparation,
  type IntakeEnvelopeMutation,
} from './intake-envelope-mutation.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { retainedIntakeWorkflowCommand } from './intake-workflow-command.ts';
import { workflowHash } from './intake-workflow.ts';
import { canonicalLiteral } from './intake-format.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import {
  createReportSourceSnapshot,
  openReportSourceSnapshot,
  reportSourceSnapshotRows,
} from './intake-report-source-snapshot.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import { openSelectedReportSourceAuthority } from './intake-report-source-authority.ts';
import { prepareReportSourceIndexAppend } from './intake-report-source-state.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';

const value = (
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): unknown => {
  const result = view.field(record, name, { bytes: 16384 });
  if (result.kind === 'missing') return undefined;
  if (result.kind !== 'value')
    throw Error('Source command identity requires selected scalar: ' + name);
  return result.value;
};
function* children(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
) {
  let after: string | undefined;
  do {
    const page = view.children(record, name, { after, items: 64, bytes: 128 * 1024 });
    yield* page.records;
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Source command sequence did not advance');
    after = page.after;
  } while (true);
}
const scopeConflict = (message: string): never => {
  throw new HttpError(409, 'REPORT_SOURCE_SCOPE', message);
};
export interface NativeReportSourceCommandOptions {
  profileId: string;
  /** Complete checked host summary, never a client assertion. */
  needsReview?: boolean;
  createdAt: string;
  assertRunning?: () => void;
  onCheckpoint?: () => void | Promise<void>;
  prepareDerived?: (
    input: IntakeEnvelopeDerivedPreparation,
  ) => Promise<readonly IntakeCollectionChange[]>;
}
export async function prepareNativeReportSourceCommand(
  db: Database,
  source: IntakeEnvelopeSource,
  input: IntakeReportSourceUpdate,
  options: NativeReportSourceCommandOptions,
) {
  const { version: _, ...request } = input;
  if (!input.operationId)
    throw new HttpError(400, 'OPERATION_ID', 'A stable report source operation ID is required');
  // Exact retry precedes optimistic version, original verification and any new provider choice.
  if (retainedIntakeWorkflowCommand(db, source, { operationId: input.operationId, request }))
    return { replayed: true as const };
  const before = intakeSourceVersion(db, source.id);
  if (!Number.isSafeInteger(input.version) || input.version !== before.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  const operationId = safeText(input.operationId, 'operation ID', 200),
    groupId = safeText(input.groupId, 'report group ID', 2000),
    groupVersionId = safeText(input.groupVersionId, 'report group version ID', 2000),
    contextId = safeText(input.contextId, 'report context ID', 2000),
    label = safeText(input.source, 'source label', 200).trim();
  if (!label) throw new HttpError(400, 'REPORT_SOURCE', 'Choose a nonempty source label');
  if (
    input.basis !== undefined &&
    input.basis !== 'manual_report_label' &&
    input.basis !== 'explicit_current_members'
  )
    throw new HttpError(400, 'REPORT_SOURCE', 'Unsupported report source label basis');
  if (
    input.basis === 'explicit_current_members' &&
    (!input.scopeToken ||
      safeText(input.scopeToken, 'report source scope token', 200) !== input.scopeToken ||
      !['active', 'deferred', 'all'].includes(input.view || ''))
  )
    throw new HttpError(
      400,
      'REPORT_SOURCE_SCOPE',
      'Load the exact active, deferred or all source review before confirming it',
    );
  const reader = openIntakeCollectionEnvelope(db, source),
    intake = reader.child(reader.root(), 'intake'),
    workflow = intake && reader.child(intake, 'workflow'),
    group = workflow && reader.find('reportGroup', workflow, groupId),
    current =
      group && reader.childCount(group, 'versions')
        ? reader.childAt(group, 'versions', reader.childCount(group, 'versions') - 1)
        : undefined;
  if (!intake || !workflow || !group || !current || value(reader, current, 'id') !== groupVersionId)
    scopeConflict('This report changed; review its current source evidence before confirming it');
  const assertCurrent = () => {
    options.assertRunning?.();
    const now = intakeSourceVersion(db, source.id);
    if (now.version !== before.version || now.logicalBinding !== before.logicalBinding)
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'This intake changed. Reload it before continuing.',
      );
    reader.address(group!);
  };
  const catalog = createReportSnapshotCatalog(db, source, {
      assertRunning: assertCurrent,
      onCheckpoint: options.onCheckpoint,
    }),
    authority = await openSelectedReportSourceAuthority(db, reader, group!, assertCurrent),
    currentAuthority = await authority.version(current!),
    scratch = disposableSqlite('circus-source-confirmation-');
  const providerRow = db
    .prepare('SELECT id,name FROM providers WHERE name=? COLLATE NOCASE')
    .get(label) as { id: string; name: string } | undefined;
  const provider = providerRow
    ? { ...providerRow, create: false }
    : {
        id: 'source-' + createHash('sha256').update(label.toLowerCase()).digest('hex').slice(0, 24),
        name: label,
        create: true,
      };
  let explicit: Awaited<ReturnType<typeof prepareNativeReportSourceReviewScope>> | undefined;
  try {
    if (input.basis === 'explicit_current_members') {
      explicit = await prepareNativeReportSourceReviewScope(
        db,
        source,
        { profileId: options.profileId, groupId, view: input.view! },
        { assertRunning: assertCurrent },
      );
      if (explicit.scopeToken !== input.scopeToken)
        scopeConflict(
          'The affected report records changed; review the exact current source scope again',
        );
    }
    const valid =
      input.basis === 'explicit_current_members'
        ? contextId === groupVersionId
        : input.basis === 'manual_report_label'
          ? authority.basis === 'report_anchor' &&
            authority.anchored &&
            contextId === groupVersionId
          : currentAuthority.suggested && contextId === currentAuthority.contextId;
    if (!valid)
      scopeConflict('Review the current report boundary or source suggestion before labeling it');
    const scope = explicit ? null : currentAuthority.scope(input.basis);
    if (!explicit && !scope)
      scopeConflict(
        'This report has mixed source context; review its records separately before labeling it',
      );
    scratch.db.exec(
      'CREATE TABLE covered(candidate TEXT,version TEXT,PRIMARY KEY(candidate,version)) WITHOUT ROWID',
    );
    const remember = scratch.db.prepare('INSERT OR IGNORE INTO covered VALUES(?,?)'),
      has = scratch.db.prepare('SELECT 1 FROM covered WHERE candidate=? AND version=?');
    function* members(version: IntakeEnvelopeRecord) {
      const format = reader.field(version, 'format', { bytes: 256 });
      if (format.kind === 'value' && format.value === 'health-intake-report-group-version-v2') {
        const snapshot = openReportMemberSnapshot(
          catalog,
          value(reader, version, 'members') as IntakeReportMembersReference,
        );
        for (let ordinal = 0; ordinal < snapshot.reference.memberCount; ordinal++) {
          assertCurrent();
          const member = snapshot.memberAt(ordinal)!;
          yield { candidateId: member.candidateId, candidateVersionId: member.candidateVersionId };
        }
      } else
        for (const record of children(reader, version, 'members')) {
          const candidateId = value(reader, record, 'candidateId'),
            candidateVersionId = value(reader, record, 'candidateVersionId');
          if (typeof candidateId !== 'string' || typeof candidateVersionId !== 'string')
            throw Error('Invalid report member identity');
          yield { candidateId, candidateVersionId };
        }
    }
    const original = await createReportSourceSnapshot(catalog, operationId, groupVersionId);
    if (explicit)
      for (const entry of explicit.entries()) {
        if (!has.get(entry.candidateId, entry.candidateVersionId)) {
          await original.member({
            candidateId: entry.candidateId,
            candidateVersionId: entry.candidateVersionId,
          });
          remember.run(entry.candidateId, entry.candidateVersionId);
        }
        const id =
          'report-source-coverage:' + workflowHash([operationId, entry.id, entry.sourceRef]);
        await original.coverage(explicit.entryPieces(entry, id));
      }
    else
      for (const member of members(current!)) {
        const candidate = reader.find('candidate', workflow!, member.candidateId),
          version = candidate && reader.find('version', candidate, member.candidateVersionId);
        if (!version || value(reader, version, 'status') !== 'pending') continue;
        if (
          reader.lookup('accepted-candidate-version', [
            JSON.stringify(member.candidateId),
            member.candidateVersionId,
          ])
        )
          continue;
        await original.member(member);
        remember.run(member.candidateId, member.candidateVersionId);
      }
    const originalScope = await original.finish();
    if (!originalScope.members.memberCount)
      scopeConflict(
        'This report has no current pending members to label; preserve accepted source history',
      );
    const confirmation: IntakeReportSourceConfirmationV2 = {
      format: 'health-intake-report-source-confirmation-v2',
      ...(input.basis ? { basis: input.basis } : {}),
      operationId,
      groupId,
      groupVersionId,
      contextId,
      source: provider.name,
      sourceProviderId: provider.id,
      members: originalScope.members,
      ...(scope ? { scope } : {}),
      ...(explicit
        ? {
            coverageEntries: originalScope.coverageEntries,
            scopeToken: explicit.scopeToken,
            view: explicit.view,
          }
        : {}),
      at: options.createdAt,
    };
    const fingerprint = workflowHash(request),
      publicationId = randomUUID();
    let extensionCount = 0;
    const prepared = await prepareIntakeEnvelopeMutation(db, source, {
      reader,
      operationId: publicationId,
      requestDigest: fingerprint,
      domainVersion: before.rawVersion + 1,
      assertRunning: assertCurrent,
      onCheckpoint: options.onCheckpoint,
      prepareDerived: options.prepareDerived,
      additionalLogicalChanges: () => catalog.finalChanges(),
      async *changes(view): AsyncGenerator<IntakeEnvelopeMutation> {
        const flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
        if (!view.has(flow, 'reportSourceConfirmations'))
          yield { op: 'set', record: flow, field: 'reportSourceConfirmations', jsonText: '[]' };
        const finishIndex = await prepareReportSourceIndexAppend({
          db,
          source,
          view,
          workflow: flow,
          catalog,
          assertCurrent,
        });
        yield {
          op: 'append',
          record: flow,
          field: 'reportSourceConfirmations',
          jsonText: JSON.stringify(confirmation),
        };
        const record = view.childAt(
          flow,
          'reportSourceConfirmations',
          view.childCount(flow, 'reportSourceConfirmations') - 1,
        )!;
        if (!explicit)
          for (const prior of children(reader, group!, 'versions')) {
            if (value(reader, prior, 'id') === groupVersionId) break;
            const selected = await authority.version(prior);
            try {
              if (canonicalLiteral(selected.scope(input.basis)) !== canonicalLiteral(scope))
                continue;
              const writer = await createReportSourceSnapshot(catalog, operationId, selected.id);
              for (const member of members(prior))
                if (has.get(member.candidateId, member.candidateVersionId))
                  await writer.member(member);
              const reference = await writer.finish();
              if (!reference.members.memberCount) continue;
              const priorContext =
                  input.basis === 'manual_report_label' ? selected.id : selected.contextId,
                hash = createHash('sha256');
              const update = (piece: string) => {
                withIntakeWork(db, 'warm', () =>
                  recordIntakeWork('hashedBytes', Buffer.byteLength(piece)),
                );
                hash.update(piece);
              };
              withIntakeWork(db, 'warm', () => recordIntakeWork('hashCalls'));
              update(
                canonicalLiteral([operationId, selected.id, priorContext]).slice(0, -1) + ',[',
              );
              const snapshot = openReportSourceSnapshot(
                catalog,
                reference.members,
                operationId,
                selected.id,
                'members',
              );
              let first = true;
              for (const row of reportSourceSnapshotRows(snapshot.map, 'members')) {
                if (!first) update(',');
                first = false;
                for (const piece of snapshot.map.chunks(row.key)) update(piece);
              }
              update(']]');
              yield {
                op: 'append',
                record,
                field: 'extensions',
                jsonText: JSON.stringify({
                  format: 'health-intake-report-source-extension-v2',
                  id: 'report-source-extension:' + hash.digest('hex'),
                  groupVersionId: selected.id,
                  contextId: priorContext,
                  members: reference.members,
                  at: options.createdAt,
                }),
              };
              extensionCount++;
            } finally {
              selected.close();
            }
          }
        yield* finishIndex(record);
        if (options.needsReview)
          yield {
            op: 'set',
            record: view.child(view.root(), 'intake')!,
            field: 'state',
            jsonText: '"needs_review"',
          };
        yield {
          op: 'append',
          record: flow,
          field: 'operations',
          jsonText: JSON.stringify({ id: operationId, fingerprint, at: options.createdAt }),
        };
      },
    });
    if (!prepared.prepared) throw Error('Unexpected source receipt publication replay');
    return {
      replayed: false as const,
      prepared: prepared.prepared,
      publicationId,
      confirmation,
      extensionCount,
      provider,
      assertCurrent,
    };
  } finally {
    explicit?.close();
    currentAuthority.close();
    scratch.close();
  }
}
