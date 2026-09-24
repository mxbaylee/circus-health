import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContextOptions } from 'playwright';
import type { AddressInfo } from 'node:net';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// This fixture renders the two components only. No app routes, user records,
// assistant endpoints or model calls are involved.
const root = fileURLToPath(new URL('../../', import.meta.url));
let server: ViteDevServer;
let browser: Browser;
let url: string;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [react()],
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { strict: true, allow: [root, realpathSync(`${root}/../node_modules`)] },
    },
  });
  await server.listen();
  url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/tests/visual/moxie-comparison.html`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(options: BrowserContextOptions = {}) {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1000 }, ...options });
  await page.goto(url);
  await page.locator('.theme-light .in-context .moxie-jester-alternative').waitFor();
  return page;
}

test('one decorative drawing remains visible through every frame boundary and loop', async () => {
  const page = await open({ reducedMotion: 'no-preference' });
  const result = await page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>(
      '.theme-light .in-context .moxie-jester-alternative',
    )!;
    const groups = [...svg.querySelectorAll<SVGGElement>('[data-pose]')];
    const animations = groups.flatMap((group) => group.getAnimations());
    const status = svg.closest('[role="status"]')!;
    const label = status.querySelector('span')!;
    const failures = [];
    const labelPositions = new Set();
    for (let loop = 0; loop < 3; loop++) {
      for (const percent of [
        0, 17.99, 18, 25.99, 26, 32.99, 33, 38.99, 39, 46.99, 47, 52.99, 53, 59.99, 60, 67.99, 68,
        90.99, 91, 99.99,
      ]) {
        animations.forEach((animation) => {
          animation.pause();
          animation.currentTime = loop * 2800 + percent * 28;
        });
        const visible = groups.filter((group) => getComputedStyle(group).visibility === 'visible');
        if (visible.length !== 1)
          failures.push({ loop, percent, visible: visible.map((group) => group.dataset.pose) });
        const box = label.getBoundingClientRect();
        labelPositions.add(JSON.stringify([box.x, box.y, box.width, box.height]));
      }
    }
    // Geometric bounds catch cropped bells, shoes and hands in unseen poses.
    const bounds = groups.map((group) => {
      const box = group.getBBox();
      return {
        pose: group.dataset.pose,
        x: box.x,
        y: box.y,
        right: box.x + box.width,
        bottom: box.y + box.height,
      };
    });
    return {
      failures,
      labelPositions: labelPositions.size,
      count: animations.length,
      bounds,
      transforms: groups.map((group) => getComputedStyle(group).transform),
      spriteSize: [svg.getBoundingClientRect().width, svg.getBoundingClientRect().height],
    };
  });
  assert.equal(result.count, 9);
  assert.deepEqual(result.failures, []);
  assert.equal(result.labelPositions, 1, 'The text must not move as the character changes pose.');
  assert.deepEqual(result.spriteSize, [48, 48]);
  assert.ok(result.transforms.every((transform) => transform === 'none'));
  for (const bound of result.bounds) {
    assert.ok(
      bound.x >= 0 && bound.y >= 0 && bound.right <= 32 && bound.bottom <= 32,
      JSON.stringify(bound),
    );
  }
  await page.close();
});

test('system reduced motion holds one complete pose and preserves the status text', async () => {
  const page = await open({ reducedMotion: 'reduce' });
  const sample = () =>
    page.evaluate(() => {
      const status = document.querySelector('.theme-dark .in-context .moxie-activity-alternative')!;
      const svg = status.querySelector('svg')!;
      return {
        text: status.textContent,
        live: status.getAttribute('aria-live'),
        atomic: status.getAttribute('aria-atomic'),
        hidden: svg.getAttribute('aria-hidden'),
        focusable: svg.getAttribute('focusable'),
        visible: [...svg.querySelectorAll<SVGGElement>('[data-pose]')]
          .filter((group) => getComputedStyle(group).visibility === 'visible')
          .map((group) => group.dataset.pose),
        animationCount: svg.getAnimations({ subtree: true }).length,
        labels: status.querySelectorAll('span').length,
        announcedImages: status.querySelectorAll('[role="img"], title').length,
      };
    });
  const first = await sample();
  assert.deepEqual(first, {
    text: 'Moxie is working…',
    live: 'polite',
    atomic: 'true',
    hidden: 'true',
    focusable: 'false',
    visible: ['ready'],
    animationCount: 0,
    labels: 1,
    announcedImages: 0,
  });
  await page.waitForTimeout(250);
  assert.deepEqual(await sample(), first);
  await page.close();
});

test('comparison controls pause, show a still pose, and unmount inactive work', async () => {
  const page = await open({ reducedMotion: 'no-preference' });
  await page.locator('#play').click();
  const allPaused = await page
    .locator('.moxie-jester-alternative')
    .first()
    .evaluate((svg) =>
      svg.getAnimations({ subtree: true }).every((animation) => animation.playState === 'paused'),
    );
  assert.equal(allPaused, true);
  await page.locator('#still').check();
  const visible = await page
    .locator('.moxie-jester-alternative')
    .first()
    .evaluate((svg) =>
      [...svg.querySelectorAll<SVGGElement>('[data-pose]')]
        .filter((group) => getComputedStyle(group).visibility === 'visible')
        .map((group) => group.dataset.pose),
    );
  assert.deepEqual(visible, ['ready']);
  await page.locator('#active').uncheck();
  await page.waitForFunction(() => !document.querySelector('.moxie-activity-alternative'));
  assert.equal(await page.locator('.in-context [role="status"]').count(), 0);
  await page.locator('#active').check();
  await page.locator('.theme-light .in-context .moxie-activity-alternative').waitFor();
  assert.equal(await page.locator('.in-context .moxie-activity-alternative').count(), 2);
  await page.close();
});
