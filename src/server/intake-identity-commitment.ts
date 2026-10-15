/** Paired streamed scope digests: retained authority and version-independent evidence. */
import { createHash } from 'node:crypto';
import type { IntakeIdentityReview } from '../shared/intake-identity.ts';
import { canonicalLiteral } from './intake-format.ts';

type ScopeSection =
  'membership' | 'targets' | 'assignmentTargets' | 'questions' | 'competingSubjects';

/** Preserve UTF-8 bytes when a producer splits a surrogate pair across chunks.
 * At most one UTF-16 unit is carried between producer chunks. */
export function* identityUtf8Chunks(pieces: Iterable<string>): Generator<string> {
  let carry = '';
  for (const piece of pieces) {
    if (typeof piece !== 'string') throw Error('Invalid identity text chunk');
    const text = carry + piece;
    carry = '';
    let end = text.length;
    if (end && /[\uD800-\uDBFF]/.test(text[end - 1]!)) {
      carry = text.slice(-1);
      end--;
    }
    if (end) yield text.slice(0, end);
  }
  if (carry) throw Error('Identity text ended with an unpaired surrogate');
}

export function* identityScopeCommitmentsWork(input: {
  header: Record<string, unknown>;
  sections: Partial<Record<ScopeSection, Iterable<string>>>;
  sourceHash: string;
  warnings: Iterable<string>;
  onHash?: (kind: 'scope' | 'warnings', bytes: number) => void;
}): Generator<
  void,
  {
    scopeToken: string;
    warningsSha256: string;
    evidenceCommitment: NonNullable<IntakeIdentityReview['evidenceCommitment']>;
  },
  void
> {
  const versioned = createHash('sha256'),
    stable = createHash('sha256');
  const updateStable = (piece: string, kind: 'scope' | 'warnings' = 'scope') => {
    stable.update(piece);
    input.onHash?.(kind, Buffer.byteLength(piece));
  };
  versioned.update('[{');
  updateStable('["health-intake-identity-evidence-v1",{');
  let versionedComma = false,
    stableComma = false;
  const keys = [...Object.keys(input.header), ...Object.keys(input.sections)].sort();
  for (const name of keys) {
    if (versionedComma) versioned.update(',');
    versionedComma = true;
    versioned.update(JSON.stringify(name) + ':');
    const includeStable = name !== 'intakeVersion';
    if (includeStable) {
      if (stableComma) updateStable(',');
      stableComma = true;
      updateStable(JSON.stringify(name) + ':');
    }
    const section = input.sections[name as ScopeSection];
    const chunks = section || [canonicalLiteral(input.header[name])];
    for (const piece of identityUtf8Chunks(chunks)) {
      versioned.update(piece);
      if (includeStable) updateStable(piece);
      yield;
    }
  }
  const suffix = '},' + canonicalLiteral(input.sourceHash);
  versioned.update(suffix + ']');
  updateStable(suffix + ',');
  const warnings = createHash('sha256');
  for (const piece of identityUtf8Chunks(input.warnings)) {
    updateStable(piece, 'warnings');
    warnings.update(piece);
    input.onHash?.('warnings', Buffer.byteLength(piece));
    yield;
  }
  updateStable(']');
  return {
    scopeToken: versioned.digest('hex'),
    warningsSha256: warnings.digest('hex'),
    evidenceCommitment: {
      format: 'health-intake-identity-evidence-v1',
      sha256: stable.digest('hex'),
    },
  };
}

/** The retained question producer emits bounded, surrogate-safe pieces. */
export function* identitySnapshotQuestionHashWork(
  chunks: Iterable<string>,
): Generator<void, string, void> {
  const hash = createHash('sha256');
  for (const piece of chunks) {
    hash.update(piece);
    yield;
  }
  return hash.digest('hex');
}
