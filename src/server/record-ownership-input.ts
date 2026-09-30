import { HttpError } from './database.ts';
import { clinicalTables } from './clinical-references.ts';
import type { OwnershipRequest } from '../shared/record-ownership.ts';
export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= 500;
export const invalid = (message: string): never => {
  throw new HttpError(400, 'OWNERSHIP_INPUT', message);
};
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).every((k) => names.includes(k));
export function ownershipRequest(value: unknown): OwnershipRequest {
  if (
    !object(value) ||
    !keys(value, [
      'selection',
      'destination',
      'decisions',
      'nameDecisions',
      'relationshipDecisions',
      'reason',
    ])
  )
    return invalid('Supply the exact selection and destination');
  const { selection, destination } = value;
  if (!object(selection) || !object(destination))
    return invalid('Choose records or a report and a destination');
  if (selection.type === 'records') {
    if (
      !keys(selection, ['type', 'records']) ||
      !Array.isArray(selection.records) ||
      !selection.records.length ||
      selection.records.length > 1000 ||
      selection.records.some(
        (r) =>
          !object(r) ||
          !Object.hasOwn(clinicalTables, String(r.kind)) ||
          !text(r.recordId) ||
          (r.version !== undefined && !text(r.version)) ||
          !keys(r, ['kind', 'recordId', 'version']),
      )
    )
      return invalid('Select up to 1000 clinical records');
    if (
      new Set(selection.records.map((r) => r.kind + ':' + r.recordId)).size !==
      selection.records.length
    )
      return invalid('Select each record once');
  } else if (
    selection.type !== 'report' ||
    !text(selection.intakeId) ||
    !text(selection.groupId) ||
    !text(selection.groupVersionId) ||
    !keys(selection, ['type', 'intakeId', 'groupId', 'groupVersionId'])
  )
    return invalid('Select the displayed report version');
  if ('newPerson' in destination) {
    if (
      !keys(destination, ['newPerson']) ||
      !object(destination.newPerson) ||
      !text(destination.newPerson.fullName) ||
      destination.newPerson.fullName.length > 200 ||
      !keys(destination.newPerson, ['fullName', 'relationship']) ||
      (destination.newPerson.relationship !== undefined &&
        (typeof destination.newPerson.relationship !== 'string' ||
          destination.newPerson.relationship.length > 200))
    )
      return invalid('Supply a new person’s full name and optional relationship');
  } else if (
    !text(destination.noteId) ||
    !Number.isSafeInteger(destination.expectedVersion) ||
    !keys(destination, ['noteId', 'expectedVersion'])
  )
    return invalid('Choose the displayed destination version');
  if (
    value.reason !== undefined &&
    (typeof value.reason !== 'string' || value.reason.length > 4000)
  )
    return invalid('Reason must be at most 4000 characters');
  if (value.decisions !== undefined) {
    if (
      !Array.isArray(value.decisions) ||
      value.decisions.length > 1000 ||
      value.decisions.some(
        (d) =>
          !object(d) ||
          !text(d.recordId) ||
          (d.action !== undefined && !['keep_both', 'link'].includes(String(d.action))) ||
          (d.action === 'link' && !text(d.targetRecordId)) ||
          !keys(d, [
            'recordId',
            'action',
            'targetRecordId',
            'splitMapping',
            'remainingMapping',
            'reviewedSplit',
          ]) ||
          (d.splitMapping !== undefined && !object(d.splitMapping)) ||
          (d.remainingMapping !== undefined && !object(d.remainingMapping)) ||
          (d.reviewedSplit !== undefined && typeof d.reviewedSplit !== 'boolean'),
      )
    )
      return invalid('Choose explicit matching and split decisions');
    if (new Set(value.decisions.map((d) => d.recordId)).size !== value.decisions.length)
      return invalid('Decide each record once');
  }
  if (
    value.nameDecisions !== undefined &&
    (!Array.isArray(value.nameDecisions) ||
      value.nameDecisions.some(
        (d) =>
          !object(d) ||
          !text(d.key) ||
          !['old', 'destination', 'both', 'unresolved'].includes(String(d.outcome)) ||
          !keys(d, ['key', 'outcome']),
      ))
  )
    return invalid('Choose the current name association');
  if (
    value.relationshipDecisions !== undefined &&
    (!Array.isArray(value.relationshipDecisions) ||
      value.relationshipDecisions.some(
        (d) =>
          !object(d) ||
          !text(d.decisionId) ||
          d.action !== 'withdraw' ||
          !keys(d, ['decisionId', 'action']),
      ))
  )
    return invalid('Review the affected relationships');
  return structuredClone(value) as unknown as OwnershipRequest;
}
