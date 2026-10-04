/** Selected report authority hashes retain unknown historical evidence without whole-object decoding. */
import { createHash } from 'node:crypto';
import type {
  IntakeReportSourceConfirmation,
  IntakeReportSourceCoverageEntry,
  IntakeReportSourceScope,
} from '../shared/intake.ts';
import type { Database } from './database.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
  type PreparedIntakeJsonCanonical,
  type IntakeJsonCanonicalHandle,
} from './intake-json-canonical.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';

type Basis = IntakeReportSourceConfirmation['basis'];
const scalar = (
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): unknown => {
  const value = view.field(record, name, { bytes: 16384 });
  if (value.kind === 'missing') return undefined;
  if (value.kind !== 'value')
    throw Error('Report source identity requires selected scalar: ' + name);
  return value.value;
};
const fieldPieces = (
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): Iterable<string> => {
  const child = view.child(record, name);
  return child ? view.recordChunks(child) : view.fieldChunks(record, name);
};
const requiredText = (
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
) => {
  const value = scalar(view, record, name);
  if (typeof value !== 'string') throw Error('Invalid report source identity: ' + name);
  return value;
};
function truthy(
  parsed: PreparedIntakeJsonCanonical,
  value: IntakeJsonCanonicalHandle | undefined,
): boolean {
  if (!value) return false;
  const kind = parsed.kind(value);
  if (kind === 'null') return false;
  if (kind === 'object' || kind === 'array') return true;
  if (kind === 'string') {
    let prefix = '';
    for (const chunk of parsed.pieces(value)) {
      prefix += chunk.slice(0, 3 - prefix.length);
      if (prefix.length >= 3) break;
    }
    return prefix !== '""';
  }
  let text = '';
  for (const chunk of parsed.pieces(value)) {
    if (text.length + chunk.length > 128) throw Error('Invalid canonical report scalar');
    text += chunk;
  }
  return !!JSON.parse(text);
}
function small(
  parsed: PreparedIntakeJsonCanonical,
  parent: IntakeJsonCanonicalHandle,
  name: string,
): unknown {
  const field = parsed.field(parent, name);
  if (!field) return undefined;
  let text = '';
  for (const piece of parsed.pieces(field)) {
    if (Buffer.byteLength(text) + Buffer.byteLength(piece) > 16384)
      throw Error('Invalid report context identity');
    text += piece;
  }
  return JSON.parse(text) as unknown;
}
function digest(db: Database, pieces: Iterable<string>, assertCurrent: () => void) {
  const hash = createHash('sha256');
  withIntakeWork(db, 'warm', () => recordIntakeWork('hashCalls'));
  for (const piece of pieces) {
    assertCurrent();
    withIntakeWork(db, 'warm', () => recordIntakeWork('hashedBytes', Buffer.byteLength(piece)));
    hash.update(piece);
  }
  return hash.digest('hex');
}
export interface SelectedReportSourceVersionAuthority {
  id: string;
  contextId: string;
  suggested: boolean;
  /** Raw canonical suggestion value; presentation may need fragments. */
  suggestion(): Iterable<string> | undefined;
  canonicalContext(): Iterable<string>;
  scope(basis: Basis): IntakeReportSourceScope | null;
  reference(): IntakeReportSourceCoverageEntry['sourceRef'];
  close(): void;
}
export interface SelectedReportSourceGroupAuthority {
  id: string;
  basis: string;
  anchored: boolean;
  reportFingerprint: string;
  version(record: IntakeEnvelopeRecord): Promise<SelectedReportSourceVersionAuthority>;
}
export async function openSelectedReportSourceAuthority(
  db: Database,
  view: IntakeCollectionEnvelopeReader,
  group: IntakeEnvelopeRecord,
  assertCurrent: () => void = () => {
    view.address(group);
  },
): Promise<SelectedReportSourceGroupAuthority> {
  const id = requiredText(view, group, 'id'),
    basis = requiredText(view, group, 'basis'),
    sourceFileId = scalar(view, group, 'sourceFileId'),
    sourceHash = scalar(view, group, 'sourceHash'),
    sourceSystem = scalar(view, group, 'sourceSystem'),
    memberId = scalar(view, group, 'memberId'),
    report = view.child(group, 'report');
  const fields: PreparedIntakeJsonCanonical[] = [];
  let anchored = false;
  try {
    for (const name of ['anchor', 'subject']) {
      const pieces = report && view.has(report, name) ? fieldPieces(view, report, name) : ['null'];
      fields.push(
        await prepareIntakeJsonCanonical(pieces, {
          assertRunning: assertCurrent,
          onWork: intakeJsonCanonicalWorkObserver(db, 'warm'),
        }),
      );
    }
    anchored = truthy(fields[0]!, fields[0]!.root);
    function* fingerprint() {
      yield canonicalLiteral([id, sourceFileId, sourceHash, sourceSystem, memberId]).slice(0, -1);
      for (const parsed of fields) {
        yield ',';
        if (truthy(parsed, parsed.root)) yield* parsed.chunks();
        else yield 'null';
      }
      yield ']';
    }
    const reportFingerprint = digest(db, fingerprint(), assertCurrent);
    return {
      id,
      basis,
      anchored,
      reportFingerprint,
      async version(record) {
        assertCurrent();
        const versionId = requiredText(view, record, 'id'),
          contributionId = requiredText(view, record, 'contributionId'),
          contextState = scalar(view, record, 'contextState'),
          parsed = await prepareIntakeJsonCanonical(
            view.has(record, 'context') ? fieldPieces(view, record, 'context') : ['null'],
            { assertRunning: assertCurrent, onWork: intakeJsonCanonicalWorkObserver(db, 'warm') },
          );
        let closed = false;
        const check = () => {
          if (closed) throw Error('Report version authority is closed');
          assertCurrent();
          view.address(record);
        };
        try {
          const contextPresent = truthy(parsed, parsed.root),
            object = parsed.kind(parsed.root) === 'object',
            contextIdValue = object ? small(parsed, parsed.root, 'contextId') : undefined,
            linked = object && small(parsed, parsed.root, 'status') === 'linked',
            suggestion = object ? parsed.field(parsed.root, 'sourceSuggestion') : undefined,
            suggested = linked && truthy(parsed, suggestion),
            contextHash = contextPresent ? digest(db, parsed.chunks(), check) : null;
          if (
            contextIdValue !== undefined &&
            contextIdValue !== null &&
            typeof contextIdValue !== 'string'
          )
            throw Error('Invalid report context ID');
          const contextId = contextIdValue || versionId;
          function* canonicalContext() {
            check();
            if (contextPresent) yield* parsed.chunks();
            else yield 'null';
          }
          const scope = (confirmationBasis: Basis): IntakeReportSourceScope | null => {
            check();
            if (
              basis !== 'report_anchor' ||
              !sourceFileId ||
              !sourceHash ||
              !anchored ||
              contextState === 'mixed' ||
              (confirmationBasis !== 'manual_report_label' && !suggested)
            )
              return null;
            return {
              kind: 'anchored_report',
              reportFingerprint,
              contextFingerprint:
                confirmationBasis === 'manual_report_label' ? contextHash : contextHash!,
            };
          };
          const fingerprint = digest(
            db,
            (function* () {
              yield canonicalLiteral([
                reportFingerprint,
                versionId,
                contributionId,
                contextState || 'none',
              ]).slice(0, -1) + ',';
              yield* canonicalContext();
              yield ']';
            })(),
            check,
          );
          return {
            id: versionId,
            contextId,
            suggested,
            suggestion() {
              check();
              const value =
                suggestion && parsed.kind(suggestion) === 'object'
                  ? parsed.field(suggestion, 'value')
                  : undefined;
              return value ? parsed.pieces(value) : undefined;
            },
            canonicalContext,
            scope,
            reference() {
              check();
              const extensionScope = scope('manual_report_label');
              return {
                groupId: id,
                groupVersionId: versionId,
                contributionId,
                contextId,
                fingerprint,
                ...(extensionScope ? { extensionScope } : {}),
              };
            },
            close() {
              if (!closed) {
                closed = true;
                parsed.close();
              }
            },
          };
        } catch (error) {
          parsed.close();
          throw error;
        }
      },
    };
  } finally {
    for (const parsed of fields) parsed.close();
  }
}
