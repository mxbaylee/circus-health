import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { IntakeSummaryV2 } from '../../shared/intake-summary.ts';
import { fetchFixtureApi } from './fixture-api-request.ts';

/** Manual-review journeys own their seeded proposals. Stop the automatically queued
 * reader before seeding, then use the retained version after any admitted capture. */
export async function stopFixtureImport(
  page: Page,
  url: string,
  prefix: string,
  id: string,
): Promise<IntakeSummaryV2> {
  const response = await fetchFixtureApi(page.request, url + prefix + '/intake-batches');
  assert.ok(response.ok());
  const { data } = await response.json();
  for (const batch of data) {
    if (!batch.items.some((item: { intakeId: string }) => item.intakeId === id)) continue;
    const stopped = await fetchFixtureApi(
      page.request,
      url + prefix + '/intake-batches/' + batch.id + '/stop',
      {
        method: 'POST',
        headers: { Origin: url },
        data: {},
      },
    );
    assert.ok(stopped.ok(), await stopped.text());
  }
  const current = await fetchFixtureApi(
    page.request,
    url + prefix + '/intakes/' + encodeURIComponent(id),
  );
  assert.ok(current.ok());
  return (await current.json()).data;
}
