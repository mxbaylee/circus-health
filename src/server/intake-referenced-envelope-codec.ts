/** Bounded V3 descriptor grammar shared with replay workers. Parsing is not
 * acceptance; original record replay must bind the source and V4 HEAD. */
import { toUSVString } from 'node:util';
import type { SchemaControl } from './intake-envelope-schema.ts';
import {
  exact,
  hash,
  integer,
  validateIntakeIdentity,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import { intakeTreeRef, type IntakeTreeRef } from './intake-state-tree.ts';

export const INTAKE_REFERENCED_ENVELOPE_FORMAT = 'health-intake-envelope-v3';
export type IntakeReferencedSourceLabel =
  | { kind: 'missing' }
  | { kind: 'null' }
  | {
      kind: 'string';
      scalarHash: string;
      bytes: number;
      preview: string;
      truncated: boolean;
    };
export interface IntakeReferencedEnvelope {
  intakeAuthority: {
    format: typeof INTAKE_REFERENCED_ENVELOPE_FORMAT;
    identity: IntakeStateIdentity;
    mode: SchemaControl['mode'];
    storageSequence: number;
    logicalRoot: IntakeTreeRef;
    sourceLabel: IntakeReferencedSourceLabel;
  };
}

/** Grammar only. Acceptance must separately prove the descriptor's source row
 * and matching V4 HEAD were selected in one genuine record transaction. */
export function parseIntakeReferencedEnvelope(raw: string): IntakeReferencedEnvelope {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8192)
    fail('referenced descriptor budget');
  const value: unknown = JSON.parse(raw);
  if (JSON.stringify(value) !== raw) fail('referenced descriptor canonical form');
  exact(value, ['intakeAuthority']);
  const authority = value.intakeAuthority;
  exact(authority, ['format', 'identity', 'mode', 'storageSequence', 'logicalRoot', 'sourceLabel']);
  const mode = authority.mode;
  if (authority.format !== INTAKE_REFERENCED_ENVELOPE_FORMAT)
    return fail('referenced descriptor format');
  if (mode !== 'raw' && mode !== 'normalized') return fail('referenced descriptor mode');
  const identity = validateIntakeIdentity(authority.identity as IntakeStateIdentity);
  const storageSequence = authority.storageSequence;
  integer(storageSequence, 1);
  const logicalRoot = authority.logicalRoot;
  intakeTreeRef(logicalRoot);
  if (logicalRoot === null) return fail('referenced descriptor root');
  const label = authority.sourceLabel;
  exact(
    label,
    label && typeof label === 'object' && 'kind' in label && label.kind === 'string'
      ? ['kind', 'scalarHash', 'bytes', 'preview', 'truncated']
      : ['kind'],
  );
  let sourceLabel: IntakeReferencedSourceLabel;
  if (label.kind === 'string') {
    const scalarHash = label.scalarHash,
      bytes = label.bytes,
      preview = label.preview,
      truncated = label.truncated;
    hash(scalarHash);
    integer(bytes, 1);
    if (
      typeof preview !== 'string' ||
      preview.length > 120 ||
      typeof truncated !== 'boolean' ||
      toUSVString(preview) !== preview
    )
      return fail('referenced source label facts');
    sourceLabel = Object.freeze({
      kind: 'string',
      scalarHash,
      bytes,
      preview,
      truncated,
    });
  } else if (label.kind === 'missing') sourceLabel = Object.freeze({ kind: 'missing' });
  else if (label.kind === 'null') sourceLabel = Object.freeze({ kind: 'null' });
  else return fail('referenced source label kind');
  const authorityResult: IntakeReferencedEnvelope['intakeAuthority'] = Object.freeze({
    format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
    identity: Object.freeze(identity),
    mode,
    storageSequence,
    logicalRoot: Object.freeze({
      hash: logicalRoot.hash,
      count: logicalRoot.count,
      height: logicalRoot.height,
      first: logicalRoot.first,
      last: logicalRoot.last,
    }),
    sourceLabel,
  });
  const result: IntakeReferencedEnvelope = Object.freeze({ intakeAuthority: authorityResult });
  if (JSON.stringify(result) !== raw) fail('referenced descriptor canonical order');
  return result;
}

export function encodeIntakeReferencedEnvelope(input: IntakeReferencedEnvelope): string {
  return JSON.stringify(parseIntakeReferencedEnvelope(JSON.stringify(input)));
}

const fail = (reason: string): never => {
  throw Error(`Intake collection envelope: ${reason}`);
};
