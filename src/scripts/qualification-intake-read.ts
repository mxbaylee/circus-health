/** Bounded public API evidence for fictional qualification. Never treats an unloaded value as absent. */
import type {
  IntakeImportFeed,
  IntakeImportFeedBlock,
  IntakeReview,
  IntakeReviewRecord,
} from '../shared/intake.ts';
import {
  isClinicalReviewPage,
  type IntakeClinicalReviewRead,
  type IntakeClinicalReviewSection,
} from '../shared/intake-clinical-review.ts';
import {
  isCollectionImportFeed,
  type CollectionImportFeed,
} from '../shared/intake-clinical-pages.ts';

export type QualificationFeedPage = IntakeImportFeed | CollectionImportFeed;
export type QualificationFeedBlock = Pick<
  IntakeImportFeedBlock,
  'intakeId' | 'proposalId' | 'intakeVersion' | 'reviewToken' | 'groupId' | 'records'
>;
export type QualificationRead = <T>(path: string) => Promise<T>;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error('Qualification public evidence: ' + message);
}

export function qualificationFeedBlocks(page: QualificationFeedPage): QualificationFeedBlock[] {
  if (!isCollectionImportFeed(page)) return page.blocks;
  const blocks = new Map<string, QualificationFeedBlock>();
  for (const entry of page.records) {
    check(entry.detail.kind === 'record', 'inspect the referenced record before qualification');
    const key = JSON.stringify([entry.intakeId, entry.proposalId, entry.groupId]);
    let block = blocks.get(key);
    if (!block) {
      block = {
        intakeId: entry.intakeId,
        proposalId: entry.proposalId,
        groupId: entry.groupId,
        intakeVersion: entry.intakeVersion,
        reviewToken: entry.reviewToken,
        records: [],
      };
      blocks.set(key, block);
    }
    check(
      block.intakeVersion === entry.intakeVersion && block.reviewToken === entry.reviewToken,
      'feed changed while collecting its page',
    );
    check(
      !entry.detail.record.issuesReference && !entry.detail.record.questionsReference,
      'inspect all referenced question and issue policy before qualification',
    );
    block.records.push(entry.detail.record);
  }
  return [...blocks.values()];
}

export async function collectQualificationFeed(
  request: QualificationRead,
  prefix: string,
  onPage?: (pages: QualificationFeedPage[]) => void,
) {
  const pages: QualificationFeedPage[] = [],
    blocks: QualificationFeedBlock[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  let feed: QualificationFeedPage;
  do {
    feed = await request<QualificationFeedPage>(
      prefix +
        '/intakes/import-feed?view=all&limit=100' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    pages.push(feed);
    blocks.push(...qualificationFeedBlocks(feed));
    onPage?.(pages);
    check(
      blocks.reduce((count, block) => count + block.records.length, 0) <= 1000,
      'review exceeded the qualification bound',
    );
    cursor = feed.nextCursor;
    if (cursor) {
      check(!seen.has(cursor), 'feed cursor did not advance');
      seen.add(cursor);
    }
  } while (cursor);
  return {
    feed,
    pages,
    blocks: blocks.map((block) => ({
      ...block,
      records: block.records.filter((record) => record.queueState !== 'superseded'),
    })),
    supersededReviewVersions: blocks.reduce(
      (count, block) =>
        count + block.records.filter((record) => record.queueState === 'superseded').length,
      0,
    ),
  };
}

function reviewRecord(value: unknown): value is IntakeReviewRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'mapping' in value &&
    !!value.mapping &&
    typeof value.mapping === 'object' &&
    'evidence' in value &&
    Array.isArray(value.evidence) &&
    'classification' in value &&
    'kind' in value
  );
}

/** Collect every section of an explicitly bounded fictional review, preserving exact server values and pins. */
export async function readQualificationReview(
  request: QualificationRead,
  path: string,
): Promise<IntakeReview> {
  let context: Omit<IntakeReview, 'records' | 'sourceContext' | 'coverageGaps'> | undefined;
  const records: IntakeReviewRecord[] = [],
    sourceContext: NonNullable<IntakeReview['sourceContext']> = [],
    coverageGaps: IntakeReview['coverageGaps'] = [];
  let totalBytes = 0;
  for (const section of ['records', 'sourceContext', 'coverageGaps'] as const) {
    let cursor: string | null = null,
      count = 0,
      total: number | undefined;
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ section, limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const page: IntakeClinicalReviewRead = await request<IntakeClinicalReviewRead>(
        path + (path.includes('?') ? '&' : '?') + params,
      );
      if (!isClinicalReviewPage(page)) {
        check(
          !('format' in page) && section === 'records' && !cursor,
          'unexpected review response',
        );
        check(
          page.records.length <= 1000 && Buffer.byteLength(JSON.stringify(page)) <= 8 * 1024 * 1024,
          'review exceeded the qualification bound',
        );
        return page;
      }
      check(page.section === section, 'wrong review section');
      const selected = {
        intakeId: page.intakeId,
        proposalId: page.proposalId,
        version: page.version,
        reviewToken: page.reviewToken,
        summary: page.summary,
        sourceTextStale: page.sourceTextStale,
      };
      if (context)
        check(
          JSON.stringify(context) === JSON.stringify(selected),
          'review changed while collecting sections',
        );
      else context = selected;
      if (total === undefined) total = page.total;
      check(
        total === page.total && page.total <= 1000,
        'section changed or exceeded qualification bound',
      );
      for (const item of page.items) {
        check(item.kind === 'value', 'inspect the referenced review value before qualification');
        check(item.ordinal === count++, 'review section omitted or duplicated a value');
        totalBytes += Buffer.byteLength(JSON.stringify(item.value));
        check(totalBytes <= 8 * 1024 * 1024, 'review exceeded the qualification byte bound');
        append(section, item.value);
      }
      cursor = page.nextCursor;
      if (cursor) {
        check(!seen.has(cursor), 'review cursor did not advance');
        seen.add(cursor);
      }
    } while (cursor);
    check(count === total, 'incomplete review section');
  }
  check(context, 'review context missing');
  return { ...context, records, sourceContext, coverageGaps };
  function append(section: IntakeClinicalReviewSection, value: unknown) {
    if (section === 'records') {
      check(reviewRecord(value), 'invalid review record');
      check(
        !value.issuesReference && !value.questionsReference,
        'inspect complete question and issue policy before qualification',
      );
      records.push(value);
    } else if (section === 'sourceContext') {
      check(
        !!value && typeof value === 'object' && 'id' in value && typeof value.id === 'string',
        'invalid source context',
      );
      sourceContext.push(value as NonNullable<IntakeReview['sourceContext']>[number]);
    } else {
      check(
        !!value &&
          typeof value === 'object' &&
          'id' in value &&
          typeof value.id === 'string' &&
          'label' in value &&
          typeof value.label === 'string' &&
          'detail' in value &&
          typeof value.detail === 'string',
        'invalid coverage gap',
      );
      coverageGaps.push(value as IntakeReview['coverageGaps'][number]);
    }
  }
}

/** Fully inspected scope for offline grading; commands retain the original server reference. */
export async function readQualificationIdentity(request: QualificationRead, path: string) {
  const review = await request<import('../shared/intake-identity.ts').IntakeIdentityReview>(path);
  const reference = review.scopeReference;
  check(!review.warningsReference, 'inspect all referenced identity warnings before qualification');
  if (!reference) {
    check(review.scope, 'identity scope is unavailable');
    return { review, inspectedScope: review.scope, confirmationScope: review.scope, pages: [] };
  }
  const pages: import('../shared/intake-identity.ts').IntakeIdentityScopePage[] = [];
  const sections: Record<string, unknown[]> = {};
  let bytes = 0;
  for (const section of [
    'membership',
    'targets',
    'assignmentTargets',
    'questions',
    'competingSubjects',
  ] as const) {
    const items: unknown[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({
        groupId: reference.groupId,
        scopeToken: reference.scopeToken,
        section,
        limit: '100',
      });
      if (cursor) params.set('cursor', cursor);
      const page: import('../shared/intake-identity.ts').IntakeIdentityScopePage = await request(
        path.split('?')[0]!.replace(/identity-review$/, 'identity-scope-page') + '?' + params,
      );
      check(
        page.scopeToken === reference.scopeToken &&
          page.section === section &&
          page.total === reference.collection[section] &&
          page.total <= 1000,
        'identity scope changed or exceeded qualification bound',
      );
      pages.push(page);
      for (const item of page.items) {
        check(
          item.kind === 'value',
          'inspect the referenced identity scope value before qualification',
        );
        bytes += Buffer.byteLength(JSON.stringify(item.value));
        check(
          bytes <= 8 * 1024 * 1024 && item.value !== null && typeof item.value === 'object',
          'invalid or oversized identity scope value',
        );
        items.push(item.value);
      }
      cursor = page.nextCursor;
      if (cursor) {
        check(!seen.has(cursor), 'identity scope cursor did not advance');
        seen.add(cursor);
      }
    } while (cursor);
    check(items.length === reference.collection[section], 'incomplete identity scope');
    sections[section] = items;
  }
  const { format: _format, collection: _collection, ...header } = reference;
  // Values above come from the named, token-bound complete server sections; the
  // combined scope is only an inspection artifact, never a command authority.
  const inspectedScope: import('../shared/intake-identity.ts').IntakeIdentityScope = {
    ...header,
    membership:
      sections.membership as import('../shared/intake-identity.ts').IntakeIdentityScope['membership'],
    targets:
      sections.targets as import('../shared/intake-identity.ts').IntakeIdentityScope['targets'],
    assignmentTargets:
      sections.assignmentTargets as import('../shared/intake-identity.ts').IntakeIdentityScope['assignmentTargets'],
    questions:
      sections.questions as import('../shared/intake-identity.ts').IntakeIdentityScope['questions'],
    competingSubjects:
      sections.competingSubjects as import('../shared/intake-identity.ts').IntakeIdentityScope['competingSubjects'],
  };
  return { review, inspectedScope, confirmationScope: reference, pages };
}
