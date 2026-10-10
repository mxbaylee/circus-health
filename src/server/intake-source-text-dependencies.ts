import { readStoredIntakeDetails, intakeSourceMetadata } from './intake-state-access.ts';
import {
  hasIntakeCollectionEnvelope,
  openIntakeCollectionEnvelope,
} from './intake-collection-envelope.ts';
import { buildIntakeCollectionEnvelope } from './intake-envelope-build.ts';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { iterateIntakeSourceAncestry } from './intake-source-ancestry.ts';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import type { SourceTextRevision } from '../shared/intake-source-text.ts';
import { updateSourcePageHashes } from './intake-proposal-dependencies.ts';
import { proposalDependenciesCurrent } from './intake-proposal-dependencies.ts';
import {
  readIntakeSourcePin,
  withIntakeSourcePin,
  writeIntakeSourcePin,
  type IntakeSourcePin,
} from './intake-source-pin.ts';

/** Only inspection bookkeeping may change without invalidating clinical interpretation. */
export function sourceTextConfirmationOnly(
  previous: SourceTextRevision | null,
  next: SourceTextRevision,
): boolean {
  return (
    !!previous &&
    next.review?.action === 'confirm' &&
    JSON.stringify(previous.spans) === JSON.stringify(next.spans) &&
    JSON.stringify(previous.relations) === JSON.stringify(next.relations) &&
    JSON.stringify(
      previous.pages.map((p) => [
        p.page,
        ['unreadable', 'unsupported', 'not-text'].includes(p.disposition) ? p.disposition : 'text',
      ]),
    ) ===
      JSON.stringify(
        next.pages.map((p) => [
          p.page,
          ['unreadable', 'unsupported', 'not-text'].includes(p.disposition)
            ? p.disposition
            : 'text',
        ]),
      ) &&
    !next.review.resolvedIssueIds?.length
  );
}

/** Source-text invalidation needs three pin fields and the parent relationship,
 * never the package's candidates, units or retained report history. */
function dependencyHeader(db: DatabaseSync, id: string) {
  const source = db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as { id: string; kind: string; sha256: string; details_json: string } | undefined;
  if (!source) return undefined;
  if (!hasIntakeCollectionEnvelope(db, source)) return readStoredIntakeDetails(db, id);
  const view = openIntakeCollectionEnvelope(db, source),
    intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Missing source dependency header');
  const field = (name: string): unknown => {
    const value = view.field(intake, name, { bytes: 16384 });
    if (value.kind === 'fragmented') throw Error('Invalid source dependency pin field');
    return value.kind === 'value' ? value.value : undefined;
  };
  const revision = field('sourceTextRevisionId'),
    token = field('sourceTextDependencyToken'),
    requires = field('sourceTextRequiresInterpretation');
  if (
    (revision != null && typeof revision !== 'string') ||
    (token != null && typeof token !== 'string') ||
    (requires !== undefined && typeof requires !== 'boolean')
  )
    throw Error('Invalid source dependency pins');
  return {
    version: view.logical.domainVersion,
    parentSourceFileId: intakeSourceMetadata(db, id).parentSourceFileId,
    sourceTextRevisionId: revision ?? null,
    sourceTextDependencyToken: token ?? null,
    sourceTextRequiresInterpretation: requires ?? false,
  };
}

/** Explicit cold compatibility preparation before a native source capture.
 * V3 requires its one retained decode; subsequent invalidation reads fields.
 * This must run outside the source revision's final transaction. */
export async function prepareIntakeSourceDependencyHeaders(
  db: DatabaseSync,
  id: string,
  options: { assertRunning?: () => void; assertPublicationCurrent?: () => void } = {},
): Promise<void> {
  const profileId = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  if (typeof profileId !== 'string')
    throw new HttpError(409, 'SOURCE_CHANGED', 'Retained source owner is missing');
  let count = 0;
  for (const { id: current } of iterateIntakeSourceAncestry(db, profileId, id, options)) {
    const source = db
      .prepare(
        "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
      )
      .get(current) as
      { id: string; kind: string; sha256: string; details_json: string } | undefined;
    if (!source) throw new HttpError(409, 'SOURCE_CHANGED', 'Retained source is missing');
    if (!hasIntakeCollectionEnvelope(db, source))
      await buildIntakeCollectionEnvelope(db, source, options);
    if (++count % 64 === 0) await setImmediate();
  }
}

/** Called inside the source revision's durable transaction, never as a separate best-effort write. */
export function invalidateIntakeSourceTextDependencies(
  db: DatabaseSync,
  previous: SourceTextRevision | null,
  next: SourceTextRevision,
  changedPages?: number[],
): void {
  // The review head and its receipt remain durable. Unchanged transcription does
  // not replace the material source pin, increment intake versions, or stale proposals.
  if (sourceTextConfirmationOnly(previous, next)) return;
  updateSourcePageHashes(db, previous, next, changedPages);
  const owner = db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get();
  const file = db
    .prepare("SELECT sha256 FROM source_files WHERE id=? AND kind='intake_original'")
    .get(next.intakeId) as { sha256: string } | undefined;
  if (owner?.value !== next.profileId || !file || file.sha256 !== next.sourceHash)
    throw new HttpError(409, 'SOURCE_CHANGED', 'The source text no longer matches this intake');
  const details = dependencyHeader(db, next.intakeId);
  if (!details || typeof details !== 'object')
    throw new HttpError(409, 'SOURCE_CHANGED', 'The intake metadata is unavailable');
  // Proposals keep their old source pin and cannot be accepted after a material edit;
  // draft and accepted history are kept. Only the small pin records change, so the
  // intake rows (proposals and history) are not copied into the journal again.
  const current = withIntakeSourcePin(details, readIntakeSourcePin(db, next.intakeId));
  const pin = nextPin(db, next, next.intakeId, current, next.id);
  if (
    next.review &&
    ['correct', 'clarification', 'unreadable', 'not-text'].includes(next.review.action)
  )
    pin.requiresInterpretation = true;
  writeIntakeSourcePin(db, next.intakeId, pin);
  // A proposal for a ZIP/document may depend on an extracted descendant. Bind
  // every ancestor without pretending the child's revision is its own text.
  let first = true;
  for (const { id: parent } of iterateIntakeSourceAncestry(db, next.profileId, next.intakeId)) {
    if (first) {
      first = false;
      continue;
    }
    const metadata = dependencyHeader(db, parent);
    if (!metadata)
      throw new HttpError(409, 'SOURCE_CHANGED', 'Retained parent metadata is missing');
    const saved = withIntakeSourcePin(metadata, readIntakeSourcePin(db, parent));
    const bound = nextPin(db, next, parent, saved, saved.sourceTextRevisionId || null);
    if (pin.requiresInterpretation) bound.requiresInterpretation = true;
    writeIntakeSourcePin(db, parent, bound);
  }
}
function nextPin(
  db: DatabaseSync,
  next: SourceTextRevision,
  intakeId: string,
  current: {
    sourceTextDependencyToken?: string | null;
    sourceTextRequiresInterpretation?: boolean;
  },
  revisionId: string | null,
): IntakeSourcePin {
  return {
    revisionId,
    dependencyToken: createHash('sha256')
      .update(JSON.stringify([current.sourceTextDependencyToken || null, next.intakeId, next.id]))
      .digest('hex'),
    requiresInterpretation: !!current.sourceTextRequiresInterpretation,
    version: (readIntakeSourcePin(db, intakeId)?.version ?? 0) + 1,
  };
}

export function sourceTextProposalId(
  intakeId: string,
  contentHash: string,
  sourceTextRevisionId?: string | null,
  sourceTextDependencyToken?: string | null,
): string {
  return (
    'proposal:' +
    createHash('sha256')
      .update(
        intakeId +
          '\0' +
          contentHash +
          (sourceTextRevisionId ? '\0' + sourceTextRevisionId : '') +
          (sourceTextDependencyToken ? '\0' + sourceTextDependencyToken : ''),
      )
      .digest('hex')
  );
}

export function assertCurrentProposalSourceText(
  details: {
    sourceTextRevisionId?: string | null;
    sourceTextDependencyToken?: string | null;
    sourceTextRequiresInterpretation?: boolean;
    proposals: {
      id: string;
      sourceTextRevisionId?: string | null;
      sourceTextDependencyToken?: string | null;
    }[];
  },
  proposalId: string | null,
  db?: DatabaseSync,
): void {
  if (!proposalId && !details.sourceTextRequiresInterpretation) return;
  const proposal = details.proposals.find((item) => item.id === proposalId);
  const measured = db && proposal ? proposalDependenciesCurrent(db, proposal.id) : null;
  if (
    (!proposalId && details.sourceTextRequiresInterpretation) ||
    (proposal &&
      !(
        measured ??
        ((proposal.sourceTextRevisionId || null) === (details.sourceTextRevisionId || null) &&
          (proposal.sourceTextDependencyToken || null) ===
            (details.sourceTextDependencyToken || null))
      ))
  )
    throw new HttpError(
      409,
      'SOURCE_TEXT_CHANGED',
      'Source text changed after this proposal was created. Read the current text and create a new proposal before accepting it.',
    );
}
