import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { IntakeReviewRecord } from '../../shared/intake.ts';
import type {
  IntakeClinicalReviewContext,
  IntakeClinicalReviewPage,
  IntakeClinicalReviewFragment,
} from '../../shared/intake-clinical-review.ts';
import type {
  CollectionImportFeed,
  CollectionReportDetail,
} from '../../shared/intake-clinical-pages.ts';

export function fixtureApi(page: Page, origin: string) {
  return async (path: string, body?: unknown): Promise<unknown> => {
    const response = await page.request.fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { Origin: origin },
      data: body,
    });
    assert.ok(response.ok(), await response.text());
    return (await response.json()).data;
  };
}
type Api = ReturnType<typeof fixtureApi>;

/** Read the complete records section of these small fictional fixtures through
 * the public page/fragment protocol. Other review sections remain unselected. */
export async function fixtureReview(
  api: Api,
  path: string,
): Promise<IntakeClinicalReviewContext & { records: IntakeReviewRecord[] }> {
  let cursor: string | null = null;
  let context: IntakeClinicalReviewContext | undefined;
  const records: IntakeReviewRecord[] = [];
  let total = 0;
  do {
    const window =
      path +
      (path.includes('?') ? '&' : '?') +
      'limit=10&bytes=32768' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const selected = (await api(window)) as IntakeClinicalReviewPage;
    assert.equal(selected.format, 'health-intake-clinical-review-page-v2');
    assert.equal(selected.section, 'records');
    if (context) assert.equal(selected.reviewToken, context.reviewToken);
    context = {
      intakeId: selected.intakeId,
      proposalId: selected.proposalId,
      version: selected.version,
      reviewToken: selected.reviewToken,
      summary: selected.summary,
      sourceTextStale: selected.sourceTextStale,
    };
    total = selected.total;
    for (const item of selected.items) {
      if (item.kind === 'value') records.push(item.value as IntakeReviewRecord);
      else {
        const chunks: Buffer[] = [];
        let offset: number | null = 0;
        do {
          const fragment = (await api(path.split('/review')[0] + '/review-fragment', {
            proposalId: selected.proposalId,
            reference: item.reference,
            offset,
            bytes: 32768,
          })) as IntakeClinicalReviewFragment;
          chunks.push(Buffer.from(fragment.data, 'base64'));
          offset = fragment.nextOffset;
          assert.equal(fragment.complete, offset === null);
        } while (offset !== null);
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, item.reference.bytes);
        records.push(JSON.parse(bytes.toString('utf8')) as IntakeReviewRecord);
      }
    }
    cursor = selected.nextCursor;
  } while (cursor);
  assert.equal(
    records.length,
    total,
    'all fixture records were selected, including off-page records',
  );
  assert.ok(context);
  return { ...context, records };
}

export async function fixtureProposalId(
  api: Api,
  prefix: string,
  intakeId: string,
): Promise<string> {
  const feed = (await api(
    prefix + '/intakes/import-feed?view=all&intakeId=' + encodeURIComponent(intakeId),
  )) as CollectionImportFeed;
  assert.equal(feed.format, 'health-intake-import-feed-v2');
  const id = feed.records[0]?.proposalId;
  assert.ok(id, 'native feed selects the exact seeded proposal');
  return id;
}

export async function fixtureReport(
  api: Api,
  prefix: string,
  groupId: string,
  intakeId: string,
): Promise<CollectionReportDetail> {
  const detail = (await api(
    prefix +
      '/intakes/report-queue/' +
      encodeURIComponent(groupId) +
      '?view=all&intakeId=' +
      encodeURIComponent(intakeId),
  )) as CollectionReportDetail;
  assert.equal(detail.format, 'health-intake-report-detail-v2');
  return detail;
}

/** Join only the fixture's saved occurrences through the native destination API. */
export async function fixtureDestinations(api: Api, prefix: string, intakeId: string) {
  const feed = (await api(
    prefix +
      '/intakes/import-feed?view=all&state=accepted&intakeId=' +
      encodeURIComponent(intakeId),
  )) as CollectionImportFeed;
  assert.equal(feed.format, 'health-intake-import-feed-v2');
  assert.equal(
    feed.nextCursor,
    null,
    'this small fixture selected all saved destination occurrences',
  );
  assert.equal(feed.records.length, feed.totalRecords);
  const destinations: import('../../shared/intake.ts').IntakeAcceptedRecord[] = [];
  for (const entry of feed.records) {
    const recordId =
      entry.detail.kind === 'record' ? entry.detail.record.id : entry.detail.selection.recordId;
    const params = new URLSearchParams({ groupId: entry.groupId, recordId });
    if (entry.proposalId) params.set('proposalId', entry.proposalId);
    const selected: import('../../shared/intake-summary.ts').IntakeAcceptedDestinations =
      (await api(
        prefix + '/intakes/' + encodeURIComponent(intakeId) + '/accepted-destinations?' + params,
      )) as import('../../shared/intake-summary.ts').IntakeAcceptedDestinations;
    assert.equal(selected.format, 'health-intake-accepted-destinations-v1');
    destinations.push(...selected.records);
  }
  return destinations;
}

/** The authoritative filtered total proves that no fixture record was accepted,
 * including partial acceptance that does not mark the whole intake imported. */
export async function fixtureAssertNoAccepted(api: Api, prefix: string, intakeId: string) {
  const feed = (await api(
    prefix +
      '/intakes/import-feed?view=all&state=accepted&intakeId=' +
      encodeURIComponent(intakeId),
  )) as CollectionImportFeed;
  assert.equal(feed.format, 'health-intake-import-feed-v2');
  assert.equal(feed.totalRecords, 0, 'the source has no accepted clinical records');
  assert.equal(feed.records.length, 0);
  assert.equal(feed.nextCursor, null);
}

export async function fixtureReportUrl(api: Api, prefix: string, intakeId: string, index = 0) {
  const feed = (await api(
    prefix + '/intakes/import-feed?view=all&intakeId=' + encodeURIComponent(intakeId),
  )) as CollectionImportFeed;
  assert.equal(feed.format, 'health-intake-import-feed-v2');
  const row = feed.records[index];
  const group = row || feed.people.groups[0];
  assert.ok(group, 'fixture report is reachable through the native feed');
  return '/#/import?' + new URLSearchParams({ intake: intakeId, group: group.groupId });
}

/** Source headers retain the shared API URL; encrypted reads select a profile. */
export function fixtureSourcePath(prefix: string, contentUrl: string): string {
  if (contentUrl.startsWith(prefix + '/sources/')) return contentUrl;
  assert.match(contentUrl, /^\/api\/sources\//);
  return prefix + contentUrl.slice(4);
}
