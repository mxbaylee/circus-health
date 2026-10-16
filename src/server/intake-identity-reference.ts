import type { IntakeIdentityReceipt } from '../shared/intake-identity.ts';
import type { IntakeIdentityReference } from './intake-lookup-projection.ts';
import type { IntakeEnvelopeRecord } from './intake-collection-envelope.ts';

export interface IntakeIdentityReferenceHeader {
  operationId: string;
  personId: string;
  intakeId: string;
  groupId: string;
  printedName: string;
}
/** SQL selected the outer occurrence; JSON.parse selected LAST inner fields. */
export function openIntakeIdentityReference(reference: IntakeIdentityReference) {
  if (reference.mode === 'legacy') {
    const receipt = reference.value as IntakeIdentityReceipt;
    const header: IntakeIdentityReferenceHeader = {
      operationId: receipt.operationId,
      personId: receipt.assignedPerson?.personId || 'patient',
      intakeId: receipt.scope.intakeId,
      groupId: receipt.scope.groupId,
      printedName: receipt.confirmedPrintedName || receipt.scope.evidencedIdentity?.fullName || '',
    };
    return {
      header,
      *targetIds(): Generator<string> {
        for (const target of receipt.scope.assignmentTargets || receipt.scope.targets)
          yield target.recordId;
      },
    };
  }
  const view = reference.view.subtree(reference.record, { fieldSelection: 'last' });
  const receipt = view.root(),
    scope = view.child(receipt, 'scope');
  if (!scope) throw Error('Intake identity receipt scope is unavailable');
  const value = (record: IntakeEnvelopeRecord, name: string): unknown => {
    const selected = view.field(record, name, { bytes: 64 * 1024 });
    if (selected.kind === 'fragmented')
      throw Error('Intake identity header requires addressed consumption');
    return selected.kind === 'missing' ? undefined : selected.value;
  };
  const text = (record: IntakeEnvelopeRecord | undefined, name: string): string => {
    if (!record) return '';
    const selected = value(record, name);
    if (selected == null) return '';
    if (typeof selected !== 'string') throw Error('Intake identity header is malformed');
    return selected;
  };
  const person = view.child(receipt, 'assignedPerson'),
    evidence = view.child(scope, 'evidencedIdentity');
  const printedName = text(receipt, 'confirmedPrintedName');
  const opaqueEvidence = printedName || evidence ? undefined : value(scope, 'evidencedIdentity');
  const evidenceName =
    opaqueEvidence && typeof opaqueEvidence === 'object' && 'fullName' in opaqueEvidence
      ? opaqueEvidence.fullName
      : '';
  if (evidenceName && typeof evidenceName !== 'string')
    throw Error('Intake identity evidenced name is malformed');
  const header: IntakeIdentityReferenceHeader = {
    operationId: text(receipt, 'operationId'),
    personId: text(person, 'personId') || 'patient',
    intakeId: text(scope, 'intakeId'),
    groupId: text(scope, 'groupId'),
    printedName:
      printedName || (evidence ? text(evidence, 'fullName') : String(evidenceName || '')),
  };
  const assignment = view.child(scope, 'assignmentTargets');
  const targetField =
    assignment || value(scope, 'assignmentTargets') ? 'assignmentTargets' : 'targets';
  const targets = view.child(scope, targetField);
  if (!targets || view.info(targets).shape !== 'array')
    throw Error('Intake identity receipt targets are unavailable');
  return {
    header,
    *targetIds(): Generator<string> {
      for (
        let ordinal = 0, total = view.childCount(scope, targetField);
        ordinal < total;
        ordinal++
      ) {
        const target = view.childAt(scope, targetField, ordinal);
        if (!target) throw Error('Intake identity target occurrence is unavailable');
        yield text(target, 'recordId');
      }
      view.address(view.root());
    },
  };
}
/** Complete membership decision: drains late targets even after an affected hit. */
export function intakeIdentityTargetMembership(
  reference: IntakeIdentityReference,
  selected: ReadonlySet<string>,
) {
  let count = 0,
    affected = false,
    moves = true;
  for (const id of openIntakeIdentityReference(reference).targetIds()) {
    count++;
    if (selected.has(id)) affected = true;
    else moves = false;
  }
  return { count, affected, moves: count > 0 && moves };
}
