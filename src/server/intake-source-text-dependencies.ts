import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import type { SourceTextRevision } from '../shared/intake-source-text.ts';

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

/** Called inside the source revision's durable transaction, never as a separate best-effort write. */
export function invalidateIntakeSourceTextDependencies(
  db: DatabaseSync,
  previous: SourceTextRevision | null,
  next: SourceTextRevision,
): void {
  // The review head and its receipt remain durable. Unchanged transcription does
  // not replace the material source pin, increment intake versions, or stale proposals.
  if (sourceTextConfirmationOnly(previous, next)) return;
  const owner = db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get();
  const file = db
    .prepare("SELECT sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'")
    .get(next.intakeId) as { sha256: string; details_json: string } | undefined;
  if (owner?.value !== next.profileId || !file || file.sha256 !== next.sourceHash)
    throw new HttpError(409, 'SOURCE_CHANGED', 'The source text no longer matches this intake');
  const envelope = JSON.parse(file.details_json);
  const details = envelope.intake;
  if (!details || typeof details !== 'object')
    throw new HttpError(409, 'SOURCE_CHANGED', 'The intake metadata is unavailable');
  details.sourceTextRevisionId = next.id;
  details.sourceTextDependencyToken = createHash('sha256')
    .update(JSON.stringify([details.sourceTextDependencyToken || null, next.intakeId, next.id]))
    .digest('hex');
  if (
    next.review &&
    ['correct', 'clarification', 'unreadable', 'not-text'].includes(next.review.action)
  )
    details.sourceTextRequiresInterpretation = true;
  details.version = Number(details.version || 0) + 1;
  // Keep draft and accepted history. Their tokens/version pins now require fresh review;
  // proposals retain their old source pin and cannot be accepted after a material edit.
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
    JSON.stringify(envelope),
    next.intakeId,
  );
  // A proposal for a ZIP/document may depend on an extracted descendant. Bind
  // every ancestor without pretending the child's revision is its own text.
  const seen = new Set([next.intakeId]);
  let parent: unknown = details.parentSourceFileId;
  while (typeof parent === 'string' && parent) {
    if (seen.has(parent) || seen.size > 32)
      throw new HttpError(409, 'SOURCE_CHANGED', 'Invalid retained source ancestry');
    seen.add(parent);
    const ancestor = db
      .prepare("SELECT details_json FROM source_files WHERE id=? AND kind='intake_original'")
      .get(parent);
    if (!ancestor) throw new HttpError(409, 'SOURCE_CHANGED', 'Retained parent source is missing');
    const saved = JSON.parse(String(ancestor.details_json));
    const metadata = saved.intake;
    if (!metadata)
      throw new HttpError(409, 'SOURCE_CHANGED', 'Retained parent metadata is missing');
    metadata.sourceTextDependencyToken = createHash('sha256')
      .update(JSON.stringify([metadata.sourceTextDependencyToken || null, next.intakeId, next.id]))
      .digest('hex');
    metadata.version = Number(metadata.version || 0) + 1;
    if (details.sourceTextRequiresInterpretation) metadata.sourceTextRequiresInterpretation = true;
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
      JSON.stringify(saved),
      parent,
    );
    parent = metadata.parentSourceFileId;
  }
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
): void {
  if (!proposalId && !details.sourceTextRequiresInterpretation) return;
  const proposal = details.proposals.find((item) => item.id === proposalId);
  if (
    (!proposalId && details.sourceTextRequiresInterpretation) ||
    (proposal &&
      ((proposal.sourceTextRevisionId || null) !== (details.sourceTextRevisionId || null) ||
        (proposal.sourceTextDependencyToken || null) !==
          (details.sourceTextDependencyToken || null)))
  )
    throw new HttpError(
      409,
      'SOURCE_TEXT_CHANGED',
      'Source text changed after this proposal was created. Read the current text and create a new proposal before accepting it.',
    );
}
