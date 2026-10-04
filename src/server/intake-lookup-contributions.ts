import type { DatabaseSync } from 'node:sqlite';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { WorkflowIndexContribution, WorkflowIndexProgress } from './intake-workflow-index.ts';

/** Explicit object-return budget; fragmented scopes are unavailable, never absent. */
export const INTAKE_LOOKUP_SCOPE_BYTES = 128 * 1024;
export function boundedIntakeLookupText(pieces: Iterable<string>): string {
  const retained: string[] = [];
  let bytes = 0;
  for (const piece of pieces) {
    bytes += Buffer.byteLength(piece);
    if (bytes > INTAKE_LOOKUP_SCOPE_BYTES)
      throw Error('Intake lookup scope requires addressed consumption');
    retained.push(piece);
  }
  return retained.join('');
}

/**
 * Cold SQL-first lookup derivation. The caller must supply a first-selection
 * reader and publish completeness only after draining this iterator. Reverse
 * acceptance traversal plus the builder's last-write rule retains the first
 * operation occurrence without an in-memory set of every operation.
 */
export function* intakeLookupContributions(
  db: DatabaseSync,
  view: IntakeCollectionEnvelopeReader,
): Generator<WorkflowIndexContribution | WorkflowIndexProgress> {
  const intake = view.child(view.root(), 'intake');
  const workflow = intake && view.child(intake, 'workflow');
  if (!workflow) return;
  const count = (name: string): number => {
    const collection = view.child(workflow, name);
    if (!collection) {
      const value = view.field(workflow, name, { bytes: INTAKE_LOOKUP_SCOPE_BYTES });
      if (value.kind === 'missing' || (value.kind === 'value' && value.value == null)) return 0;
      throw Error('Intake lookup contribution collection is unavailable');
    }
    if (view.info(collection).shape !== 'array')
      throw Error('Intake lookup contribution must be an array');
    return view.childCount(workflow, name);
  };
  let visited = 0;
  const field = (record: IntakeEnvelopeRecord, name: string): string | undefined => {
    if (!view.has(record, name)) return undefined;
    const nested = view.child(record, name);
    return boundedIntakeLookupText(
      nested ? view.recordChunks(nested) : view.fieldChunks(record, name),
    );
  };
  let maximum: bigint | null = null;
  let maximumGroup: IntakeEnvelopeRecord | null = null;
  const cast = db.prepare("SELECT CAST(json_extract(?,'$') AS INTEGER) n");
  cast.setReadBigInts(true);
  for (let ordinal = 0, total = count('reportGroups'); ordinal < total; ordinal++) {
    const group = view.childAt(workflow, 'reportGroups', ordinal);
    if (!group) throw Error('Intake lookup report-group occurrence is unavailable');
    const text = field(group, 'discoveryOrder');
    let value: bigint | null;
    if (view.info(group).shape === 'scalar') {
      const statement = db.prepare(
        "SELECT CAST(json_extract(j.value,'$.discoveryOrder') AS INTEGER) n FROM json_each(?) j",
      );
      statement.setReadBigInts(true);
      value = statement.get('[' + boundedIntakeLookupText(view.recordChunks(group)) + ']')!.n as
        bigint | null;
    } else value = text === undefined ? null : (cast.get(text)!.n as bigint | null);
    if (value !== null && (maximum === null || value > maximum)) {
      maximum = value;
      maximumGroup = group;
    }
    if (++visited % 64 === 0) yield { checkpoint: true };
  }
  yield { index: 'lookup-discovery-maximum', key: [], target: maximumGroup };
  for (let ordinal = count('reportAcceptances') - 1; ordinal >= 0; ordinal--) {
    const acceptance = view.childAt(workflow, 'reportAcceptances', ordinal);
    if (!acceptance) throw Error('Intake lookup acceptance occurrence is unavailable');
    if (view.info(acceptance).shape === 'scalar') {
      // Preserve malformed-json refusal for string json_each payloads too.
      db.prepare("SELECT json_extract(j.value,'$.receipt.operationId') FROM json_each(?) j").get(
        '[' + boundedIntakeLookupText(view.recordChunks(acceptance)) + ']',
      );
      if (++visited % 64 === 0) yield { checkpoint: true };
      continue;
    }
    const receipt = view.child(acceptance, 'receipt');
    const text = receipt && field(receipt, 'operationId');
    const operation =
      text === undefined
        ? undefined
        : db
            .prepare(
              "SELECT typeof(json_extract(?,'$')) type,hex(CAST(json_extract(?,'$') AS BLOB)) identity",
            )
            .get(text, text);
    if (operation && operation.type !== 'null' && operation.type !== 'text')
      throw Error('Intake lookup invalid acceptance operation identity');
    if (operation?.type === 'text')
      // SQLite can retain invalid UTF8 from escaped lone surrogates. TEXT
      // equality compares those bytes; a JS round-trip would replace them and
      // falsely match an unqueryable operation with replacement characters.
      yield {
        index: 'lookup-acceptance-operation-first',
        key: [String(operation.identity)],
        target: acceptance,
      };
    if (++visited % 64 === 0) yield { checkpoint: true };
  }
  for (let ordinal = 0, total = count('identityConfirmations'); ordinal < total; ordinal++) {
    const target = view.childAt(workflow, 'identityConfirmations', ordinal);
    if (!target) throw Error('Intake lookup identity occurrence is unavailable');
    yield { index: 'lookup-identity-order', key: [String(ordinal)], target };
    if (++visited % 64 === 0) yield { checkpoint: true };
  }
}
