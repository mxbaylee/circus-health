import { streamPortableJson } from './portable-json-stream.ts';
import { portableProjectionCells, type PortableProjectionCell } from './portable-projection-row.ts';
import type { PortableProjectionTransfer } from './portable-projection-transfer.ts';
import {
  prepareIntakeJsonCanonicalSteps,
  type IntakeJsonCanonicalHandle,
  type PreparedIntakeJsonCanonical,
} from './intake-json-canonical.ts';
import { portableJsonStringPieces } from './portable-json-pieces.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';
import {
  normalizePacketTags,
  packetPreferenceIdentity,
  packetPreferenceKey,
  packetPreferenceRef,
} from './packet-preference-codec.ts';
import type { PacketRecordRef } from '../shared/packet-selection.ts';

type Expected = Readonly<{ bytes: number; sha256: string }>;
const FIELDS = ['$restoreOperations', '$assistantOperations', '$packetPreferences'] as const;

function invalid(): never {
  throw Error('Invalid portable personal special row');
}

function bounded(pieces: Iterable<string>, maximum: number): string {
  let value = '';
  for (const part of pieces) {
    if (value.length + part.length > maximum) invalid();
    value += part;
  }
  return value;
}

function equals(pieces: Iterable<string>, expected: string): boolean {
  let at = 0;
  for (const part of pieces) {
    if (expected.slice(at, at + part.length) !== part) return false;
    at += part.length;
  }
  return at === expected.length;
}

function number(
  tree: PreparedIntakeJsonCanonical,
  value: IntakeJsonCanonicalHandle,
  checkpoint: () => void,
) {
  let decoded: number | undefined;
  const steps = hashIntakeJsonScalarSteps(tree.pieces(value), [], undefined, (n) => {
    decoded = n;
  });
  try {
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value.kind === 'number' ? decoded : undefined;
      checkpoint();
    }
  } finally {
    steps.return(undefined as never);
  }
}

function nested(
  pieces: Iterable<string>,
  checkpoint: () => void,
  read: (tree: PreparedIntakeJsonCanonical) => void,
) {
  const steps = prepareIntakeJsonCanonicalSteps(pieces, { mode: 'stringify' });
  let tree: PreparedIntakeJsonCanonical | undefined;
  try {
    for (;;) {
      const step = steps.next();
      if (step.done) {
        tree = step.value;
        break;
      }
      checkpoint();
    }
    read(tree);
  } finally {
    tree?.close();
    steps.return(undefined as never);
  }
}

function validateSpecial(
  field: (typeof FIELDS)[number],
  cells: readonly PortableProjectionCell[],
  profileId: string,
  checkpoint: () => void,
): void {
  if (cells.length !== 2) invalid();
  const keyCell = cells.find((cell) => cell.name === 'key');
  const valueCell = cells.find((cell) => cell.name === 'value');
  if (keyCell?.kind !== 'text' || valueCell?.kind !== 'text') invalid();
  const key = bounded(keyCell.pieces(), 2048);
  nested(valueCell.pieces(), checkpoint, (tree) => {
    if (tree.kind(tree.root) !== 'object') invalid();
    const fieldValue = (name: string) => tree.field(tree.root, name);
    const string = (name: string) => {
      const selected = fieldValue(name);
      if (!selected || tree.kind(selected) !== 'string') invalid();
      return selected;
    };
    if (field !== '$packetPreferences') {
      const type = field === '$restoreOperations' ? 'restore' : 'assistant';
      if (!new RegExp(`^personal_${type}_[0-9a-f-]{36}$`, 'i').test(key)) invalid();
      if (!equals(portableJsonStringPieces(tree, string('profileId')), profileId)) invalid();
      string('noteId');
      const operation = type === 'restore' ? 'operationId' : 'proposalId';
      if (
        !equals(
          portableJsonStringPieces(tree, string(operation)),
          key.slice(`personal_${type}_`.length),
        )
      )
        invalid();
      if (type === 'restore') {
        string('fingerprint');
        for (const name of ['previousVersion', 'currentVersion']) {
          const selected = fieldValue(name);
          if (!selected || !Number.isInteger(number(tree, selected, checkpoint))) invalid();
        }
      } else {
        string('kind');
        const selected = fieldValue('version');
        const version = selected && number(tree, selected, checkpoint);
        if (!Number.isInteger(version) || version! < 1) invalid();
      }
      return;
    }
    const personId = bounded(portableJsonStringPieces(tree, string('personId')), 256);
    packetPreferenceIdentity(personId);
    const record = fieldValue('record');
    if (!record || tree.kind(record) !== 'object') invalid();
    const recordKind = tree.field(record, 'kind');
    const recordId = tree.field(record, 'recordId');
    if (
      !recordKind ||
      tree.kind(recordKind) !== 'string' ||
      !recordId ||
      tree.kind(recordId) !== 'string'
    )
      invalid();
    const ref = packetPreferenceRef({
      kind: bounded(portableJsonStringPieces(tree, recordKind), 32) as PacketRecordRef['kind'],
      recordId: bounded(portableJsonStringPieces(tree, recordId), 256),
    });
    if (key !== packetPreferenceKey(personId, ref)) invalid();
    const alwaysWithhold = fieldValue('alwaysWithhold');
    if (!alwaysWithhold || tree.kind(alwaysWithhold) !== 'boolean') invalid();
    const version = fieldValue('version');
    const versionNumber = version && number(tree, version, checkpoint);
    if (!Number.isSafeInteger(versionNumber) || versionNumber! < 1) invalid();
    if (!equals(portableJsonStringPieces(tree, string('actor')), 'profile-user')) invalid();
    const updatedAt = bounded(
      portableJsonStringPieces(tree, string('updatedAt')),
      Number.MAX_SAFE_INTEGER,
    );
    if (!Number.isFinite(Date.parse(updatedAt))) invalid();
    const tags = fieldValue('tags');
    if (!tags || tree.kind(tags) !== 'array') invalid();
    const values: string[] = [];
    for (const tag of tree.arrayItems(tags)) {
      checkpoint();
      if (tree.kind(tag) !== 'string' || values.length >= 32) invalid();
      values.push(bounded(portableJsonStringPieces(tree, tag), 80));
    }
    if (JSON.stringify(normalizePacketTags(values)) !== JSON.stringify(values)) invalid();
  });
}

/** Field presence, not row count, controls replacement of curation preferences. */
export function selectedPortablePersonalSpecialFields(
  file: string,
  expected: Expected,
  checkpoint: () => void,
): ReadonlySet<string> {
  const fields = new Set<string>();
  streamPortableJson(
    file,
    (name, rootField) => {
      checkpoint();
      if (rootField && FIELDS.includes(name as (typeof FIELDS)[number])) fields.add(name);
    },
    () => {
      throw Error('Portable special row unexpectedly hydrated');
    },
    expected,
    { parseTables: false, requireTables: false, rowPieces: () => checkpoint() },
  );
  return fields;
}

/** Stage the selected last occurrence of each personal special array in the
 * same fixed app_meta order as the portable reader. `tables` is streamed past
 * but not parsed during these additional bounded archive passes. */
export function stagePortablePersonalSpecialRows(
  file: string,
  expected: Expected,
  transfer: PortableProjectionTransfer,
  initialOrdinal: number,
  profileId: string,
  checkpoint: () => void,
): { nextOrdinal: number; fields: ReadonlySet<string> } {
  if (!Number.isSafeInteger(initialOrdinal) || initialOrdinal < 0)
    throw Error('Portable selected row ordinal changed');
  const fields = new Set<string>();
  let ordinal = initialOrdinal;
  for (const field of FIELDS) {
    let occurrences = 0;
    const first = streamPortableJson(
      file,
      (name, rootField) => {
        checkpoint();
        if (rootField && name === field) occurrences++;
      },
      () => {
        throw Error('Portable special row unexpectedly hydrated');
      },
      expected,
      { parseTables: false, requireTables: false, rowPieces: () => checkpoint() },
    );
    if (!occurrences) continue;
    fields.add(field);
    let seen = 0;
    let active = false;
    const second = streamPortableJson(
      file,
      (name, rootField) => {
        checkpoint();
        active = rootField === true && name === field && ++seen === occurrences;
      },
      () => {
        throw Error('Portable special row unexpectedly hydrated');
      },
      expected,
      {
        parseTables: false,
        requireTables: false,
        rowPieces: (name, _pieces, parsed) => {
          checkpoint();
          if (!active || name !== field) return;
          const cells = portableProjectionCells(parsed, ['key', 'value']);
          validateSpecial(field, cells, profileId, checkpoint);
          transfer.putRow('app_meta', ordinal++, cells);
        },
      },
    );
    if (seen !== occurrences || JSON.stringify(first) !== JSON.stringify(second))
      throw Error('Portable special field changed between passes');
  }
  return { nextOrdinal: ordinal, fields };
}
