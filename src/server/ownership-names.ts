import { json, type Database } from './database.ts';
import { canonicalIdentityName, safeSourceIdentityName } from '../shared/self-identity.ts';
import type { IntakeIdentityReceipt } from '../shared/intake-identity.ts';
import type { OwnershipNameEffect, OwnershipRequest } from '../shared/record-ownership.ts';
import { ownershipHash, appendOwnershipDecision } from './ownership-journal.ts';
import { activeIdentityReceipts, type NameSupport } from './name-associations.ts';
import { getNote, rememberSourceNameInTransaction } from './notes.ts';
import type { IntakeWorkflow } from '../shared/intake.ts';

interface CorrectionNameSupport {
  operationId: string;
  correctionOperationId: string;
  noteId: string;
  name: string;
  sourceRecordId: string;
  intakeId: string;
  groupId: string;
}

function sourceNameScopes(
  db: Database,
  sourceRecordId: string,
  support: OwnershipNameEffect['support'],
) {
  const source = db
    .prepare('SELECT source_file_id,locator_json FROM source_records WHERE id=?')
    .get(sourceRecordId);
  if (!source) return [];
  const locator = json(source.locator_json) as { originalSourceFileId?: string };
  const intakeId = locator.originalSourceFileId || String(source.source_file_id);
  const file = db.prepare('SELECT sha256,details_json FROM source_files WHERE id=?').get(intakeId);
  const workflow = (json(file?.details_json) as { intake?: { workflow?: IntakeWorkflow } }).intake
    ?.workflow;
  const exact = support.filter((s) => s.sourceRecordIds.includes(sourceRecordId));
  return (workflow?.reportGroups || [])
    .filter((group) =>
      exact.length
        ? exact.some((s) => s.intakeId === intakeId && s.groupId === group.id)
        : group.versions
            .at(-1)
            ?.members.some((m) => m.occurrences.some((o) => o.recordId === sourceRecordId)),
    )
    .map((group) => ({
      intakeId,
      groupId: group.id,
      sourceHash: String(file!.sha256),
      subjectText: group.report?.subject?.text || '',
    }));
}

export function previewOwnershipNames(
  db: Database,
  sources: Set<string>,
  owners: Set<string>,
  request: OwnershipRequest,
): OwnershipNameEffect[] {
  const scopes = new Set<string>();
  const sourceScopes = new Map<string, Set<string>>();
  for (const id of sources) {
    const source = db
      .prepare('SELECT source_file_id,locator_json FROM source_records WHERE id=?')
      .get(id);
    if (!source) continue;
    const locator = json(source.locator_json) as { originalSourceFileId?: string };
    const intakeId = locator.originalSourceFileId || String(source.source_file_id);
    const file = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId);
    const workflow = (
      json(file?.details_json) as {
        intake?: { workflow?: import('../shared/intake.ts').IntakeWorkflow };
      }
    ).intake?.workflow;
    for (const group of workflow?.reportGroups || [])
      if (
        group.versions.some((v) =>
          v.members.some((m) => m.occurrences.some((o) => o.recordId === id)),
        )
      ) {
        const key = intakeId + ':' + group.id;
        scopes.add(key);
        const ids = sourceScopes.get(key) || new Set<string>();
        ids.add(id);
        sourceScopes.set(key, ids);
      }
  }
  const receipts: IntakeIdentityReceipt[] = [];
  for (const row of db
    .prepare(
      "SELECT j.value receipt FROM source_files s,json_each(s.details_json,'$.intake.workflow.identityConfirmations') j WHERE json_valid(s.details_json)",
    )
    .iterate())
    receipts.push(json(row.receipt) as IntakeIdentityReceipt);
  const active = activeIdentityReceipts(db, receipts) || [];
  // A correction establishes new support, independent of the original receipt's
  // former owner. Follow those exact contributions on later corrections/undo.
  // See docs/import/identity-review.md#historical-attribution-and-current-name-authority.
  const corrections =
    activeIdentityReceipts(
      db,
      db
        .prepare("SELECT coverage_json FROM manual_batches WHERE title='Ownership name support'")
        .all()
        .map((row) => json(row.coverage_json) as CorrectionNameSupport),
    ) || [];
  const effects: OwnershipNameEffect[] = [];
  for (const personId of owners) {
    const row = db
      .prepare("SELECT id FROM notes WHERE kind='person' AND person_id=?")
      .get(personId);
    if (!row) continue;
    const note = getNote(db, String(row.id));
    const candidates = new Map<string, string>();
    const corrected = corrections.filter((support) => support.noteId === note.id);
    for (const support of corrected)
      if (
        sources.has(support.sourceRecordId) ||
        (request.selection.type === 'report' &&
          request.selection.intakeId === support.intakeId &&
          request.selection.groupId === support.groupId)
      )
        candidates.set(canonicalIdentityName(support.name), support.name);
    for (const r of active) {
      const oldId = r.assignedPerson?.personId || 'patient';
      if (oldId !== personId) continue;
      const targets = r.scope.assignmentTargets || r.scope.targets;
      if (
        !targets.some((t) => sources.has(t.recordId)) &&
        !(
          request.selection.type === 'report' &&
          request.selection.intakeId === r.scope.intakeId &&
          request.selection.groupId === r.scope.groupId
        )
      )
        continue;
      const name = r.confirmedPrintedName || r.scope.evidencedIdentity?.fullName;
      if (name && safeSourceIdentityName(name)) candidates.set(canonicalIdentityName(name), name);
    }
    // Legacy evidence may have no complete receipt ledger. Challenge it rather than guessing sole support.
    for (const source of note.person.sourceKnownNames || []) {
      if (
        safeSourceIdentityName(source.name) &&
        (scopes.has(source.intakeId + ':' + source.groupId) ||
          (request.selection.type === 'report' &&
            source.intakeId === request.selection.intakeId &&
            source.groupId === request.selection.groupId))
      )
        candidates.set(canonicalIdentityName(source.name), source.name);
    }
    for (const [canonical, name] of candidates) {
      const supports = active.filter(
        (r) =>
          (r.assignedPerson?.personId || 'patient') === personId &&
          canonicalIdentityName(
            r.confirmedPrintedName || r.scope.evidencedIdentity?.fullName || '',
          ) === canonical,
      );
      const support = supports.map((r) => {
        const targets = r.scope.assignmentTargets || r.scope.targets;
        return {
          operationId: r.operationId,
          sourceRecordIds: targets.map((t) => t.recordId),
          intakeId: r.scope.intakeId,
          groupId: r.scope.groupId,
          version: ownershipHash(r),
          affected: targets.some((t) => sources.has(t.recordId)),
          moves: targets.length > 0 && targets.every((t) => sources.has(t.recordId)),
        };
      });
      const transferred = corrected.filter((s) => canonicalIdentityName(s.name) === canonical);
      support.push(
        ...transferred.map((s) => ({
          operationId: s.operationId,
          sourceRecordIds: [s.sourceRecordId],
          intakeId: s.intakeId,
          groupId: s.groupId,
          version: ownershipHash(s),
          affected: sources.has(s.sourceRecordId),
          moves: sources.has(s.sourceRecordId),
        })),
      );
      const first = db
        .prepare(
          "SELECT coverage_json FROM manual_batches WHERE title='Remembered name support' AND json_extract(coverage_json,'$.noteId')=? AND json_extract(coverage_json,'$.nameKey')=? ORDER BY json_extract(coverage_json,'$.revision'),id LIMIT 1",
        )
        .get(note.id, canonical);
      const provenance = first ? (json(first.coverage_json) as NameSupport) : null;
      const primary =
        !!note.person.fullName && canonicalIdentityName(note.person.fullName) === canonical;
      const manual = db
        .prepare(
          "SELECT json_extract(coverage_json,'$.active') active FROM manual_batches WHERE title='Manual name assertion' AND json_extract(coverage_json,'$.noteId')=? AND json_extract(coverage_json,'$.nameKey')=? ORDER BY json_extract(coverage_json,'$.revision') DESC,id DESC LIMIT 1",
        )
        .get(note.id, canonical);
      const independentSupport =
        primary ||
        (manual ? !!manual.active : provenance?.independentManual === true) ||
        support.some((s) => !s.moves);
      const unknownSupport =
        !provenance || provenance.independentManual === undefined || !support.length;
      const proposed =
        !independentSupport && !unknownSupport && support.every((s) => s.moves)
          ? 'destination'
          : 'unresolved';
      const key = ownershipHash([note.id, canonical]);
      effects.push({
        key,
        noteId: note.id,
        personId,
        name,
        proposed,
        decision: request.nameDecisions?.find((d) => d.key === key)?.outcome || proposed,
        independentSupport,
        unknownSupport,
        support,
        affectedSourceIds: [
          ...new Set([
            ...transferred
              .filter((s) => sources.has(s.sourceRecordId))
              .map((s) => s.sourceRecordId),
            ...supports.flatMap((r) =>
              (r.scope.assignmentTargets || r.scope.targets)
                .filter((t) => sources.has(t.recordId))
                .map((t) => t.recordId),
            ),
            ...(note.person.sourceKnownNames || [])
              .filter((s) => canonicalIdentityName(s.name) === canonical)
              .flatMap((s) => [...(sourceScopes.get(s.intakeId + ':' + s.groupId) || [])]),
          ]),
        ],
      });
    }
  }
  return effects.sort((a, b) => a.key.localeCompare(b.key));
}
export function commitOwnershipNames(
  db: Database,
  effects: OwnershipNameEffect[],
  destinationNoteId: string,
  operationId: string,
) {
  for (const effect of effects) {
    const activeOld = effect.decision === 'old' || effect.decision === 'both';
    appendOwnershipDecision(
      db,
      'name-correction:' + operationId + ':' + effect.key,
      'Remembered name correction',
      {
        noteId: effect.noteId,
        name: effect.name,
        status: activeOld
          ? 'active'
          : effect.decision === 'unresolved'
            ? 'unresolved'
            : 'superseded',
        operationId,
        supportOperations: [],
        origin: 'ownership',
      },
    );
    for (const support of effect.support) {
      // Even partial removal challenges the old receipt's future authority, not the immutable receipt itself.
      if (!support.affected) continue;
      const id =
        'identity-supersession:' +
        operationId +
        ':' +
        ownershipHash([effect.key, support.operationId]);
      appendOwnershipDecision(db, id, 'Identity receipt supersession', {
        operationId,
        supportOperationId: support.operationId,
        noteId: effect.noteId,
        name: effect.name,
        supportVersion: support.version,
      });
    }
    if (effect.decision === 'destination' || effect.decision === 'both') {
      const supportOperations: string[] = [];
      for (const sourceRecordId of effect.affectedSourceIds)
        for (const scope of sourceNameScopes(db, sourceRecordId, effect.support)) {
          const supportId =
            'ownership-name-support:' +
            ownershipHash([operationId, effect.key, sourceRecordId, scope.intakeId, scope.groupId]);
          appendOwnershipDecision(db, supportId, 'Ownership name support', {
            operationId: supportId,
            correctionOperationId: operationId,
            noteId: destinationNoteId,
            name: effect.name,
            sourceRecordId,
            intakeId: scope.intakeId,
            groupId: scope.groupId,
          } satisfies CorrectionNameSupport);
          rememberSourceNameInTransaction(db, destinationNoteId, {
            ...scope,
            operationId: supportId,
            name: effect.name,
          });
          supportOperations.push(supportId);
        }
      appendOwnershipDecision(
        db,
        'name-correction:' + operationId + ':destination:' + effect.key,
        'Remembered name correction',
        {
          noteId: destinationNoteId,
          name: effect.name,
          status: 'active',
          operationId,
          supportOperations,
          origin: 'ownership',
        },
      );
    }
  }
}
