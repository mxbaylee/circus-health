import {
  iterateIntakeIdentityReferences,
  readIntakeIdentityReference,
} from './intake-lookup-projection.ts';
import { ownershipIntakeScopes } from './ownership-intake-scopes.ts';
import type { IntakeIdentityReceipt } from '../shared/intake-identity.ts';
import {
  openIntakeIdentityReference,
  intakeIdentityTargetMembership,
} from './intake-identity-reference.ts';
import { json, type Database } from './database.ts';
import { canonicalIdentityName, safeSourceIdentityName } from '../shared/self-identity.ts';
import type { OwnershipNameEffect, OwnershipRequest } from '../shared/record-ownership.ts';
import { ownershipHash, appendOwnershipDecision } from './ownership-journal.ts';
import type { NameSupport } from './name-associations.ts';
import { getNote, rememberSourceNameInTransaction } from './notes.ts';

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
  const file = db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(intakeId);
  const exact = support.filter((s) => s.sourceRecordIds.includes(sourceRecordId));
  return Array.from(
    ownershipIntakeScopes(db, intakeId, sourceRecordId, {
      latestOnly: true,
      ...(exact.length
        ? {
            exactGroups: new Set(
              exact.filter((s) => s.intakeId === intakeId).map((s) => s.groupId),
            ),
          }
        : {}),
    }),
  ).map((group) => ({
    intakeId,
    groupId: group.id,
    sourceHash: String(file!.sha256),
    subjectText: group.subjectText,
  }));
}

export function previewOwnershipNames(
  db: Database,
  sources: ReadonlySet<string>,
  owners: ReadonlySet<string>,
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
    for (const group of ownershipIntakeScopes(db, intakeId, id, { subject: false })) {
      const key = intakeId + ':' + group.id;
      scopes.add(key);
      const ids = sourceScopes.get(key) || new Set<string>();
      ids.add(id);
      sourceScopes.set(key, ids);
    }
  }
  function* active(
    personId: string,
    canonical?: string,
    affectedOnly = false,
  ): Generator<IntakeIdentityReceipt> {
    for (const reference of iterateIntakeIdentityReferences(db)) {
      const { header } = openIntakeIdentityReference(reference);
      if (
        header.personId !== personId ||
        (canonical !== undefined && canonicalIdentityName(header.printedName) !== canonical)
      )
        continue;
      // A point anti-join preserves supersession without retaining its ledger.
      if (
        typeof header.operationId === 'string' &&
        db
          .prepare(
            "SELECT 1 FROM manual_batches WHERE title='Identity receipt supersession' AND COALESCE(CAST(json_extract(coverage_json,'$.supportOperationId') AS TEXT),'null')=? LIMIT 1",
          )
          .get(header.operationId)
      )
        continue;
      if (
        affectedOnly &&
        !(
          request.selection.type === 'report' &&
          request.selection.intakeId === header.intakeId &&
          request.selection.groupId === header.groupId
        ) &&
        !intakeIdentityTargetMembership(reference, sources).affected
      )
        continue;
      yield readIntakeIdentityReference(reference) as IntakeIdentityReceipt;
    }
  }
  // A correction establishes new support, independent of the original receipt's
  // former owner. Follow those exact contributions on later corrections/undo.
  // See docs/import/identity-review.md#historical-attribution-and-current-name-authority.
  function* corrections(): Generator<CorrectionNameSupport> {
    for (const row of db
      .prepare("SELECT coverage_json FROM manual_batches WHERE title='Ownership name support'")
      .iterate()) {
      const receipt = json(row.coverage_json) as CorrectionNameSupport;
      if (
        typeof receipt.operationId === 'string' &&
        db
          .prepare(
            "SELECT 1 FROM manual_batches WHERE title='Identity receipt supersession' AND COALESCE(CAST(json_extract(coverage_json,'$.supportOperationId') AS TEXT),'null')=? LIMIT 1",
          )
          .get(receipt.operationId)
      )
        continue;
      yield receipt;
    }
  }
  const effects: OwnershipNameEffect[] = [];
  for (const personId of owners) {
    const row = db
      .prepare("SELECT id FROM notes WHERE kind='person' AND person_id=?")
      .get(personId);
    if (!row) continue;
    const note = getNote(db, String(row.id));
    const candidates = new Map<string, string>();
    function* corrected(): Generator<CorrectionNameSupport> {
      for (const receipt of corrections()) if (receipt.noteId === note.id) yield receipt;
    }
    for (const support of corrected())
      if (
        sources.has(support.sourceRecordId) ||
        (request.selection.type === 'report' &&
          request.selection.intakeId === support.intakeId &&
          request.selection.groupId === support.groupId)
      )
        candidates.set(canonicalIdentityName(support.name), support.name);
    for (const r of active(personId, undefined, true)) {
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
      const support: OwnershipNameEffect['support'] = [];
      for (const r of active(personId, canonical)) {
        if (
          (r.assignedPerson?.personId || 'patient') !== personId ||
          canonicalIdentityName(
            r.confirmedPrintedName || r.scope.evidencedIdentity?.fullName || '',
          ) !== canonical
        )
          continue;
        const targets = r.scope.assignmentTargets || r.scope.targets;
        support.push({
          operationId: r.operationId,
          sourceRecordIds: targets.map((t) => t.recordId),
          intakeId: r.scope.intakeId,
          groupId: r.scope.groupId,
          version: ownershipHash(r),
          affected: targets.some((t) => sources.has(t.recordId)),
          moves: targets.length > 0 && targets.every((t) => sources.has(t.recordId)),
        });
      }
      const transferred: CorrectionNameSupport[] = [];
      for (const support of corrected())
        if (canonicalIdentityName(support.name) === canonical) transferred.push(support);
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
            ...support.flatMap((s) => s.sourceRecordIds.filter((id) => sources.has(id))),
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
