import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import { getIntakeSourceText } from './intake-source-text.ts';

/** Literal source search, not clinical identity inference or extraction completeness. */
export function searchIntakeSourceText(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  options: { query: string; revisionId?: string; offset?: number; character?: number },
) {
  const { query, offset = 0, character = 0 } = options;
  if (
    typeof query !== 'string' ||
    !query.trim() ||
    query.length > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(character) ||
    character < 0
  )
    throw new HttpError(
      400,
      'SOURCE_TEXT_QUERY',
      'Use a literal query up to 200 characters and nonnegative cursors',
    );
  const source = getIntakeSourceText(db, root, profileId, id, options.revisionId);
  if (!source.revision)
    throw new HttpError(404, 'SOURCE_TEXT_UNAVAILABLE', 'Extract source text before searching it');
  const matches: {
    spanId: string;
    page: number;
    character: number;
    text: string;
    provenance: string;
  }[] = [];
  let spanIndex = offset,
    position = character;
  for (; spanIndex < source.revision.spans.length; spanIndex++, position = 0) {
    const span = source.revision.spans[spanIndex];
    while (position <= span.text.length) {
      const found = span.text.indexOf(query, position);
      if (found < 0) break;
      matches.push({
        spanId: span.id,
        page: span.region.page,
        character: found,
        text: span.text.slice(Math.max(0, found - 80), found + query.length + 80),
        provenance: span.provenance,
      });
      position = found + Math.max(1, query.length);
      if (matches.length === 20)
        return {
          revisionId: source.revision.id,
          sourceHash: source.revision.sourceHash,
          matches,
          nextOffset: spanIndex,
          nextCharacter: position,
          caseSensitive: true,
        };
    }
  }
  return {
    revisionId: source.revision.id,
    sourceHash: source.revision.sourceHash,
    matches,
    nextOffset: null,
    nextCharacter: 0,
    caseSensitive: true,
  };
}
