import { launchBrowser, startBrowserRuntime } from './harness.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Browser, type Page } from 'playwright';
import { createCanvas } from '@napi-rs/canvas';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';

test(
  'real source review retains corrections, history, stale-tab conflicts and original view without clinical acceptance',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-source-text-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startBrowserRuntime(t, {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: () => ({ available: false }) },
    });
    let browser: Browser | undefined;
    t.after(async () => {
      await browser?.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    browser = await launchBrowser(t);
    const context = await browser.newContext();
    context.setDefaultTimeout(5000);
    context.setDefaultNavigationTimeout(10000);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    const profileId = await page.evaluate(async () => {
      const post = async (path: string, body: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return (await response.json()).data;
      };
      const setup = await post('/api/profile-setups', {
        fullName: 'Fictional source reviewer',
        birthDate: '1982-04-17',
        name: 'Fictional source reviewer',
      });
      const profile = await post(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      return profile.id as string;
    });
    const prefix = `/api/profiles/${profileId}`;
    const original =
      'Fictional administrative wording.\nNo fever; value 0.05 mg.\nRepeated source footer.';
    const upload = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'text/plain',
        'X-Filename': 'fictional-source-review.txt',
      },
      data: Buffer.from(original),
    });
    assert.equal(upload.status(), 201);
    const intake = await stopFixtureImport(page, url, prefix, (await upload.json()).data.id);
    const get = async (path: string) => {
      const response = await page.request.get(url + prefix + path);
      assert(response.ok(), await response.text());
      return (await response.json()).data;
    };
    const open = async (target: Page, filename = 'fictional-source-review.txt') => {
      await target.goto(url + '/#/sources?q=' + encodeURIComponent(filename));
      await target.reload();
      assert.equal(
        await target
          .getByRole('button', { name: 'Browse imported source text', exact: true })
          .count(),
        0,
      );
      await target.getByRole('button', { name: filename, exact: true }).waitFor();
      await target.getByRole('button', { name: filename, exact: true }).click();
      await target.getByRole('button', { name: 'Review source text', exact: true }).click();
    };
    await open(page);
    const extract = page.getByRole('button', { name: 'Extract source text locally', exact: true });
    if (await extract.count()) await extract.click();
    const passage = page.getByRole('textbox', { name: /Passage 1/ });
    await passage.waitFor();
    const initial = await get(`/intakes/${encodeURIComponent(intake.id)}/source-text`);
    assert.equal(initial.status, 'available');
    assert.equal(await page.getByLabel('Literal original section 1').textContent(), original);
    assert.equal(await passage.inputValue(), original);
    await page.getByRole('searchbox', { name: 'Find retained text', exact: true }).fill('0.05');
    await page.getByRole('button', { name: 'Find in source text', exact: true }).click();
    await page
      .getByRole('button', { name: /Page 1 · native:.*Fictional administrative wording/ })
      .waitFor();
    const second = await context.newPage();
    await open(second);
    await second.getByRole('textbox', { name: /Passage 1/ }).waitFor();
    await passage.fill(original + '\nHuman verified missing administrative annotation.');
    await page.getByRole('button', { name: 'Save transcription correction', exact: true }).click();
    await page
      .getByText(
        'Correction saved. Other source questions remain until you explicitly inspect this page. Accepted clinical record versions are unchanged.',
      )
      .waitFor();
    const corrected = await get(`/intakes/${encodeURIComponent(intake.id)}/source-text`);
    assert.notEqual(corrected.revision.id, initial.revision.id);
    assert.equal(corrected.revision.parentRevisionId, initial.revision.id);
    assert.equal((await get(`/intakes/${encodeURIComponent(intake.id)}`)).imported, null);
    assert.equal((await get(`/intakes/${encodeURIComponent(intake.id)}`)).proposals.length, 0);
    await page.getByRole('button', { name: 'Source text revision history', exact: true }).click();
    await page.getByText(/Historical revision/).waitFor();
    assert.equal(
      await page
        .locator('.source-text-review')
        .getByRole('button', { name: /accept clinical/i })
        .count(),
      0,
    );
    await second
      .getByRole('textbox', { name: /Passage 1/ })
      .fill('Fictional stale draft must not overwrite current source.');
    await second
      .getByRole('button', { name: 'Save transcription correction', exact: true })
      .click();
    await second.getByText(/This source revision changed/).waitFor();
    assert.equal(
      await second.getByRole('textbox', { name: /Passage 1/ }).inputValue(),
      'Fictional stale draft must not overwrite current source.',
    );
    assert.equal(
      (await get(`/intakes/${encodeURIComponent(intake.id)}/source-text`)).revision.id,
      corrected.revision.id,
    );
    await open(page);
    assert.equal(
      await page.getByRole('textbox', { name: /Passage 1/ }).inputValue(),
      corrected.revision.spans[0].text,
    );
    assert.equal(await page.getByLabel('Literal original section 1').textContent(), original);
    await page.getByRole('button', { name: 'Load latest saved revision', exact: true }).click();
    await page.getByText('Latest saved source revision loaded.', { exact: true }).waitFor();
    // Source-only review must not silently queue model work or accept records.
    assert.equal(
      await page
        .getByRole('button', { name: 'Read source for clinical review', exact: true })
        .count(),
      0,
    );
    assert.ok(
      (await get('/intake-batches')).every(
        (batch: { status: string }) => batch.status === 'stopped',
      ),
      'source review does not restart the stopped upload job',
    );
    assert.equal((await get(`/intakes/${encodeURIComponent(intake.id)}`)).imported, null);
    // A real non-square image exercises browser layout/rotation. OCR availability is
    // not asserted here; the retained pixel view and explicit exceptions suffice.
    const canvas = createCanvas(360, 180);
    const draw = canvas.getContext('2d');
    draw.fillStyle = 'white';
    draw.fillRect(0, 0, 360, 180);
    draw.fillStyle = 'black';
    draw.font = '18px sans-serif';
    draw.fillText('Fictional source. No fever.', 12, 80);
    const imageUpload = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'image/png',
        'X-Filename': 'fictional-source-image.png',
      },
      data: canvas.toBuffer('image/png'),
    });
    assert.equal(imageUpload.status(), 201);
    const imageIntake = await stopFixtureImport(
      page,
      url,
      prefix,
      (await imageUpload.json()).data.id,
    );
    await open(page, 'fictional-source-image.png');
    const extractImage = page.getByRole('button', {
      name: 'Extract source text locally',
      exact: true,
    });
    if (await extractImage.count()) await extractImage.click();
    const image = page.getByRole('img', { name: 'Original page 1', exact: true });
    await image.waitFor();
    await page.getByRole('button', { name: 'Rotate source clockwise', exact: true }).click();
    const geometry = await image.evaluate((element) => {
      const frame = element.parentElement!.parentElement!;
      return {
        width: frame.getBoundingClientRect().width,
        height: frame.getBoundingClientRect().height,
        transform: element.parentElement!.style.transform,
      };
    });
    assert.match(geometry.transform, /rotate\(90deg\)/);
    assert(
      geometry.height > geometry.width,
      'Landscape page becomes portrait without clipped bounds',
    );
    await page.getByRole('combobox', { name: 'Source zoom', exact: true }).selectOption('1.5');
    const zoomed = await image.evaluate(
      (element) => element.parentElement!.parentElement!.getBoundingClientRect().width,
    );
    assert(zoomed > geometry.width);
    // A source with no model proposal can create a human-authored draft, which
    // links to the import review. Creation must not accept a clinical record.
    await open(page);
    await page.getByRole('button', { name: 'Add record from this section', exact: true }).click();
    const manual = page.getByRole('region', { name: 'Add record from source', exact: true });
    await manual
      .getByRole('combobox', { name: 'Person', exact: true })
      .selectOption('person-note:self');
    await manual
      .getByRole('textbox', { name: 'Label', exact: true })
      .fill('Cookie Doe fictional measurement');
    await manual.getByRole('textbox', { name: 'Value as printed', exact: true }).fill('0.05');
    await manual
      .getByRole('textbox', { name: 'Unit (leave blank if unknown)', exact: true })
      .fill('mg');
    await manual
      .getByRole('textbox', { name: 'Literal source wording', exact: true })
      .fill('No fever; value 0.05 mg.');
    await manual.getByRole('button', { name: 'Create review draft', exact: true }).click();
    assert.equal((await get(`/intakes/${encodeURIComponent(intake.id)}`)).imported, null);
    await page.getByRole('link', { name: 'Review the new record', exact: true }).click();
    const inline = page.locator('.import-record-accordion');
    await inline
      .getByRole('heading', { name: 'Cookie Doe fictional measurement', exact: true })
      .waitFor();
    assert.equal((await get(`/intakes/${encodeURIComponent(intake.id)}`)).imported, null);
    const screenshots = process.env.CRS_SCREENSHOTS_DIR;
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({
        path: resolve(screenshots, 'source-created-record.png'),
        fullPage: true,
      });
    }
    // Resolve the other fixture separately so approving the remaining text
    // section exercises disappearance of the final attention tab.
    const imageText = await get('/intakes/' + imageIntake.id + '/source-text');
    const resolvedImage = await page.request.post(
      url + prefix + '/intakes/' + imageIntake.id + '/source-text',
      {
        headers: { Origin: url },
        data: {
          operationId: crypto.randomUUID(),
          expectedRevisionId: imageText.revision.id,
          sourceHash: imageText.revision.sourceHash,
          action: 'not-text',
          scope: { page: 1 },
          reason: 'Fictional browser-test illustration excluded by the reviewer.',
        },
      },
    );
    assert(resolvedImage.ok(), await resolvedImage.text());
    // The queue count can arrive before the separate source-file request.
    // Hold that request so the browser test covers this response ordering.
    const intakeRoute = '**' + prefix + '/intakes/' + encodeURIComponent(intake.id);
    let releaseSource!: () => void;
    const heldSource = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    let sourceRequested!: () => void;
    const requestedSource = new Promise<void>((resolve) => {
      sourceRequested = resolve;
    });
    const sourceRequests: Promise<void>[] = [];
    await page.route(intakeRoute, (route) => {
      sourceRequested();
      const pending = heldSource.then(() => route.continue());
      sourceRequests.push(pending);
      return pending;
    });
    const attentionInAll = page.getByRole('region', {
      name: 'Text review for fictional-source-review.txt',
      exact: true,
    });
    try {
      await page.reload();
      await page.getByRole('tab', { name: /^Needs attention/ }).waitFor();
      await requestedSource;
      assert.equal(
        await attentionInAll.isVisible(),
        false,
        'Queue count does not imply the source section has loaded',
      );
      releaseSource();
      await attentionInAll.waitFor({ state: 'visible' });
      assert(await attentionInAll.isVisible(), 'Source sections are visible in All');
    } finally {
      releaseSource();
      await Promise.all(sourceRequests);
      await page.unroute(intakeRoute);
    }
    await attentionInAll.getByText('1 section not reviewed', { exact: true }).waitFor();
    await page.getByRole('checkbox', { name: 'Select all shown' }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: 'Select all shown' }).count(), 1);
    // Hold a real filtered read so its empty loading state cannot be mistaken
    // for the last record having been approved.
    let releaseFeed!: () => void;
    const heldFeed = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    const feedRoute = '**/intakes/import-feed?*';
    await page.route(feedRoute, async (route) => {
      if (new URL(route.request().url()).searchParams.get('kind') === 'test') await heldFeed;
      await route.continue();
    });
    try {
      await page.getByRole('tab', { name: /^Test results/ }).click();
      await page.getByText('Loading records…', { exact: true }).waitFor();
      assert.equal(
        await page.getByRole('tab', { name: /^Test results/ }).getAttribute('aria-selected'),
        'true',
      );
      releaseFeed();
      await page.getByText('Loading records…', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(
        await page.getByRole('tab', { name: /^Test results/ }).getAttribute('aria-selected'),
        'true',
      );
    } finally {
      releaseFeed();
      await page.unroute(feedRoute);
    }
    await page.getByRole('tab', { name: /^All/ }).click();
    await page.getByRole('tab', { name: /^Needs attention/ }).click();
    const attention = page.getByRole('region', {
      name: 'Text review for fictional-source-review.txt',
      exact: true,
    });
    await attention.getByText('1 section not reviewed', { exact: true }).waitFor();
    await attention.getByRole('button', { name: 'Review', exact: true }).click();
    await attention.getByRole('textbox', { name: 'Extracted text on page 1' }).waitFor();
    if (screenshots) {
      await page.screenshot({
        path: resolve(screenshots, 'source-attention-inline.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: resolve(screenshots, 'source-attention-mobile.png'),
        fullPage: true,
      });
    }
    const beforeApproval = await get('/intakes/' + encodeURIComponent(intake.id));
    await page.getByRole('checkbox', { name: 'Select all shown' }).check();
    await page.getByRole('button', { name: 'Approve 1 text section' }).click();
    await attention.waitFor({ state: 'hidden' });
    await page.getByRole('tab', { name: /^Needs attention/ }).waitFor({ state: 'hidden' });
    assert.equal(
      await page.getByRole('tab', { name: /^All/ }).getAttribute('aria-selected'),
      'true',
    );
    assert.equal(
      await attention.getByRole('textbox', { name: 'Extracted text on page 1' }).count(),
      0,
    );
    const afterApproval = await get('/intakes/' + encodeURIComponent(intake.id));
    assert.equal(afterApproval.version, beforeApproval.version);
    assert.equal(afterApproval.imported, null);
    assert.equal(
      (await get('/intake-batches')).filter(
        (batch: { status: string }) => batch.status === 'running',
      ).length,
      0,
    );
    assert.deepEqual(errors, []);
  },
);
