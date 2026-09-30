import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { Intake } from '../../shared/intake.ts';

/** Manual-review journeys own their seeded proposals. Stop the automatically queued
 * reader before seeding, then use the retained version after any admitted capture. */
export async function stopFixtureImport(
  page: Page,
  url: string,
  prefix: string,
  id: string,
): Promise<Intake> {
  const response = await page.request.get(url + prefix + '/intake-batches');
  assert.ok(response.ok());
  const { data } = await response.json();
  for (const batch of data) {
    if (!batch.items.some((item: { intakeId: string }) => item.intakeId === id)) continue;
    const stopped = await page.request.post(
      url + prefix + '/intake-batches/' + batch.id + '/stop',
      {
        headers: { Origin: url },
        data: {},
      },
    );
    assert.ok(stopped.ok(), await stopped.text());
  }
  const current = await page.request.get(url + prefix + '/intakes/' + encodeURIComponent(id));
  assert.ok(current.ok());
  return (await current.json()).data;
}
