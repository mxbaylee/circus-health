import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import type { SourceTextRevision } from '../shared/intake-source-text.ts';

/** Pages actually exposed to a conversion response. Other paths retain the legacy broad pin. */
export interface ObservedSourcePages {
  intakeId: string;
  pages: number[];
  /** Bounded passages/search hits expose these spans without necessarily exposing the whole page. */
  spanIds?: string[];
  /** Host-only hashes recorded when the model received the evidence. */
  pageHashes?: { page: number; hash: string }[];
  spanHashes?: { spanId: string; hash: string }[];
  member?: {
    rootIntakeId: string;
    memberId: string;
    locator: string;
    sourceHash: string;
    roleHash?: string | null;
  };
}

interface ProposalDependencies {
  format: 'intake-proposal-dependencies-v1';
  sources: {
    intakeId: string;
    pages: { page: number; hash: string }[];
    spans?: { spanId: string; hash: string }[];
    member?: NonNullable<ObservedSourcePages['member']> & { roleHash: string | null };
  }[];
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pageKey = (intakeId: string, page: number) =>
  `intake_source_page_hash:v1:${intakeId}:${page}`;
const spanKey = (intakeId: string, spanId: string) =>
  `intake_source_span_hash:v1:${intakeId}:${spanId}`;
const amendmentKey = (intakeId: string, page: number) =>
  `intake_source_page_amendment:v1:${intakeId}:${page}`;
const proposalKey = (proposalId: string) => `intake_proposal_dependencies:v1:${proposalId}`;

export function packageMemberRoleHash(
  db: DatabaseSync,
  rootIntakeId: string,
  memberId: string,
): string | null {
  const row = db
    .prepare("SELECT details_json FROM source_files WHERE id=? AND kind='intake_original'")
    .get(rootIntakeId);
  if (!row) return null;
  try {
    const details = JSON.parse(String(row.details_json)) as {
      intake?: {
        workflow?: { plans?: { status: string; packageRoles?: { memberId: string }[] }[] };
      };
    };
    const role = details.intake?.workflow?.plans
      ?.find((plan) => plan.status === 'active')
      ?.packageRoles?.find((candidate) => candidate.memberId === memberId);
    return role ? digest(role) : null;
  } catch {
    return null;
  }
}

export function sourcePageCurrentHash(
  db: DatabaseSync,
  intakeId: string,
  page: number,
): string | null {
  const value = db
    .prepare('SELECT value FROM app_meta WHERE key=?')
    .get(pageKey(intakeId, page))?.value;
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function sourceSpanCurrentHash(
  db: DatabaseSync,
  intakeId: string,
  spanId: string,
): string | null {
  const value = db
    .prepare('SELECT value FROM app_meta WHERE key=?')
    .get(spanKey(intakeId, spanId))?.value;
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/** Include all context attached to a page, including cross-page edges and issue resolutions. */
export function sourcePageHash(revision: SourceTextRevision, page: number): string {
  const spans = revision.spans.filter((span) => span.region.page === page);
  const ids = new Set(spans.map((span) => span.id));
  const byId = new Map(revision.spans.map((span) => [span.id, span]));
  return digest({
    page: revision.pages.find((candidate) => candidate.page === page)?.disposition ?? null,
    spans,
    issues: revision.issues.filter((issue) => issue.region.page === page),
    relations: revision.relations
      .filter((relation) => ids.has(relation.from) || ids.has(relation.to))
      .map((relation) => ({
        relation,
        from: byId.get(relation.from),
        to: byId.get(relation.to),
      })),
  });
}

function amendment(db: DatabaseSync, intakeId: string, page: number): string | null {
  const value = db
    .prepare('SELECT value FROM app_meta WHERE key=?')
    .get(amendmentKey(intakeId, page))?.value;
  return typeof value === 'string' ? value : null;
}

function relatedAmendments(
  db: DatabaseSync,
  revision: SourceTextRevision,
  spanIds: Set<string>,
): [number, string | null][] {
  const byId = new Map(revision.spans.map((span) => [span.id, span.region.page]));
  const pages = new Set<number>();
  for (const relation of revision.relations)
    if (spanIds.has(relation.from) || spanIds.has(relation.to)) {
      const from = byId.get(relation.from);
      const to = byId.get(relation.to);
      if (from) pages.add(from);
      if (to) pages.add(to);
    }
  return [...pages]
    .sort((a, b) => a - b)
    .map((page) => [page, amendment(db, revision.intakeId, page)]);
}

function sourceSpanHashes(
  db: DatabaseSync,
  revision: SourceTextRevision,
  page: number,
): Map<string, string> {
  const spans = revision.spans.filter((span) => span.region.page === page);
  const byId = new Map(revision.spans.map((span) => [span.id, span]));
  const relationships = new Map<string, unknown[]>();
  const relationPages = new Map<string, Set<number>>();
  for (const relation of revision.relations) {
    const edge = { relation, from: byId.get(relation.from), to: byId.get(relation.to) };
    for (const spanId of [relation.from, relation.to]) {
      const list = relationships.get(spanId) || [];
      list.push(edge);
      relationships.set(spanId, list);
      const pages = relationPages.get(spanId) || new Set<number>();
      if (edge.from) pages.add(edge.from.region.page);
      if (edge.to) pages.add(edge.to.region.page);
      relationPages.set(spanId, pages);
    }
  }
  const disposition = revision.pages.find((candidate) => candidate.page === page)?.disposition;
  const issues = revision.issues.filter((issue) => issue.region.page === page);
  return new Map(
    spans.map((span) => [
      span.id,
      digest({
        span,
        disposition,
        issues,
        relations: relationships.get(span.id) || [],
        relatedAmendments: [...(relationPages.get(span.id) || [])]
          .sort((a, b) => a - b)
          .map((page) => [page, amendment(db, revision.intakeId, page)]),
      }),
    ]),
  );
}

/** Called in the source revision transaction. An append writes only the new page hashes. */
export function updateSourcePageHashes(
  db: DatabaseSync,
  previous: SourceTextRevision | null,
  next: SourceTextRevision,
  changedPages?: number[],
): void {
  const pages = changedPages || next.pages.map((candidate) => candidate.page);
  for (const page of pages) {
    if (next.review?.scope.page === page) {
      const nextAmendment = digest([amendment(db, next.intakeId, page), next.review]);
      db.prepare(
        'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(amendmentKey(next.intakeId, page), nextAmendment);
    }
  }
  for (const page of pages) {
    const ids = new Set(
      next.spans.filter((span) => span.region.page === page).map((span) => span.id),
    );
    const hash = digest([
      sourcePageHash(next, page),
      amendment(db, next.intakeId, page),
      relatedAmendments(db, next, ids),
    ]);
    if (sourcePageCurrentHash(db, next.intakeId, page) === hash) continue;
    db.prepare(
      'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(pageKey(next.intakeId, page), hash);
    const currentHashes = sourceSpanHashes(db, next, page);
    for (const span of previous?.spans.filter((candidate) => candidate.region.page === page) || [])
      if (!currentHashes.has(span.id))
        db.prepare('DELETE FROM app_meta WHERE key=?').run(spanKey(next.intakeId, span.id));
    for (const [spanId, contentHash] of currentHashes) {
      const spanHash = digest([contentHash, amendment(db, next.intakeId, page)]);
      if (sourceSpanCurrentHash(db, next.intakeId, spanId) === spanHash) continue;
      db.prepare(
        'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(spanKey(next.intakeId, spanId), spanHash);
    }
  }
}

/** The revision receipt already knows changed page blobs; add relation neighbours. */
export function affectedSourcePages(
  previous: SourceTextRevision | null,
  next: SourceTextRevision,
  previousRefs: string[] | null,
  nextRefs: string[],
): number[] {
  const affected = new Set(
    next.pages
      .filter((_page, index) => previousRefs?.[index] !== nextRefs[index])
      .map((page) => page.page),
  );
  if (!previous) return [...affected];
  if (next.review?.scope.page) affected.add(next.review.scope.page);
  const oldSpans = new Map(previous.spans.map((span) => [span.id, span.region.page]));
  const newSpans = new Map(next.spans.map((span) => [span.id, span.region.page]));
  const oldRelations = new Map(previous.relations.map((relation) => [relation.id, relation]));
  const newRelations = new Map(next.relations.map((relation) => [relation.id, relation]));
  for (const id of new Set([...oldRelations.keys(), ...newRelations.keys()])) {
    const old = oldRelations.get(id);
    const current = newRelations.get(id);
    if (JSON.stringify(old) === JSON.stringify(current)) continue;
    for (const relation of [old, current]) {
      if (!relation) continue;
      for (const page of [
        oldSpans.get(relation.from),
        oldSpans.get(relation.to),
        newSpans.get(relation.from),
        newSpans.get(relation.to),
      ])
        if (page) affected.add(page);
    }
  }
  for (const relation of next.relations) {
    const from = newSpans.get(relation.from);
    const to = newSpans.get(relation.to);
    if (from && to && (affected.has(from) || affected.has(to))) {
      affected.add(from);
      affected.add(to);
    }
  }
  return [...affected].sort((a, b) => a - b);
}

/** Unknown or incomplete coverage deliberately gets no record and keeps the broad pin. */
export function writeProposalDependencies(
  db: DatabaseSync,
  originalIntakeId: string,
  proposalId: string,
  observed: ObservedSourcePages[] | undefined,
): void {
  if (
    !observed?.length ||
    observed.some((source) => !source.pages.length && !source.spanIds?.length)
  )
    return;
  const original = db
    .prepare("SELECT mime_type FROM source_files WHERE id=? AND kind='intake_original'")
    .get(originalIntakeId);
  // Package membership and linked child/report relationships are not yet a
  // measured closed scope. Their proposals retain the conservative broad pin.
  if (!original) return;
  if (
    observed.some((source) =>
      original.mime_type === 'application/zip'
        ? source.intakeId === originalIntakeId || source.member?.rootIntakeId !== originalIntakeId
        : source.intakeId !== originalIntakeId,
    )
  )
    return;
  const sources: ProposalDependencies['sources'] = [];
  for (const source of observed) {
    if (source.member) {
      const row = db
        .prepare(
          "SELECT sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
        )
        .get(source.intakeId);
      let relationship: { parentSourceFileId?: string; locator?: string } | undefined;
      try {
        relationship = (JSON.parse(String(row?.details_json)) as { intake?: typeof relationship })
          .intake;
      } catch {
        return;
      }
      if (
        row?.sha256 !== source.member.sourceHash ||
        relationship?.parentSourceFileId !== source.member.rootIntakeId ||
        relationship?.locator !== source.member.locator ||
        (source.member.roleHash !== undefined &&
          source.member.roleHash !==
            packageMemberRoleHash(db, source.member.rootIntakeId, source.member.memberId))
      )
        throw new HttpError(
          409,
          'SOURCE_TEXT_CHANGED',
          'Observed package relationship changed before proposal publication',
        );
    }
    const pages: ProposalDependencies['sources'][number]['pages'] = [];
    for (const page of [...new Set(source.pages)].sort((a, b) => a - b)) {
      if (!Number.isSafeInteger(page) || page < 1) return;
      const hash = db
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get(pageKey(source.intakeId, page))?.value;
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return;
      const observedHash = source.pageHashes?.find((entry) => entry.page === page)?.hash;
      if (source.pageHashes && observedHash !== hash)
        throw new HttpError(
          409,
          'SOURCE_TEXT_CHANGED',
          'Observed source page changed before proposal publication',
        );
      pages.push({ page, hash });
    }
    const spans: NonNullable<ProposalDependencies['sources'][number]['spans']> = [];
    for (const spanId of [...new Set(source.spanIds || [])].sort()) {
      if (typeof spanId !== 'string' || !spanId || spanId.length > 128) return;
      const hash = sourceSpanCurrentHash(db, source.intakeId, spanId);
      if (!hash) return;
      const observedHash = source.spanHashes?.find((entry) => entry.spanId === spanId)?.hash;
      if (source.spanHashes && observedHash !== hash)
        throw new HttpError(
          409,
          'SOURCE_TEXT_CHANGED',
          'Observed source span changed before proposal publication',
        );
      spans.push({ spanId, hash });
    }
    sources.push({
      intakeId: source.intakeId,
      pages,
      ...(spans.length ? { spans } : {}),
      ...(source.member
        ? {
            member: {
              ...source.member,
              roleHash: packageMemberRoleHash(
                db,
                source.member.rootIntakeId,
                source.member.memberId,
              ),
            },
          }
        : {}),
    });
  }
  const value: ProposalDependencies = { format: 'intake-proposal-dependencies-v1', sources };
  db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
    proposalKey(proposalId),
    JSON.stringify(value),
  );
}

export function proposalDependenciesCurrent(db: DatabaseSync, proposalId: string): boolean | null {
  const raw = db
    .prepare('SELECT value FROM app_meta WHERE key=?')
    .get(proposalKey(proposalId))?.value;
  if (typeof raw !== 'string') return null;
  let value: ProposalDependencies;
  try {
    value = JSON.parse(raw) as ProposalDependencies;
  } catch {
    return false;
  }
  if (value.format !== 'intake-proposal-dependencies-v1' || !Array.isArray(value.sources))
    return false;
  return value.sources.every(
    (source) =>
      typeof source.intakeId === 'string' &&
      (!source.member ||
        (() => {
          const row = db
            .prepare(
              "SELECT sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
            )
            .get(source.intakeId);
          if (!row || row.sha256 !== source.member!.sourceHash) return false;
          let intake: { parentSourceFileId?: string; locator?: string };
          try {
            intake = (JSON.parse(String(row.details_json)) as { intake: typeof intake }).intake;
          } catch {
            return false;
          }
          return (
            intake?.parentSourceFileId === source.member!.rootIntakeId &&
            intake?.locator === source.member!.locator &&
            packageMemberRoleHash(db, source.member!.rootIntakeId, source.member!.memberId) ===
              source.member!.roleHash
          );
        })()) &&
      Array.isArray(source.pages) &&
      (source.pages.length > 0 || !!source.spans?.length) &&
      source.pages.every(
        ({ page, hash }) =>
          Number.isSafeInteger(page) &&
          typeof hash === 'string' &&
          db.prepare('SELECT value FROM app_meta WHERE key=?').get(pageKey(source.intakeId, page))
            ?.value === hash,
      ) &&
      (!source.spans ||
        (Array.isArray(source.spans) &&
          source.spans.every(
            ({ spanId, hash }) => sourceSpanCurrentHash(db, source.intakeId, spanId) === hash,
          ))),
  );
}
