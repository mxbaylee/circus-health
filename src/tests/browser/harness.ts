import type { TestContext } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

const unavailable = () => ({
  available: false,
  backend: 'litellm',
  model: 'fictional-browser-model',
  readiness: 'unavailable',
  capabilities: { tools: null, images: null },
});

/** Real app/storage; third-party inference always has an explicit fixture owner. */
export async function startBrowserRuntime(
  t: TestContext,
  options: NonNullable<Parameters<typeof startRuntime>[0]>,
) {
  const runtime = await startRuntime({
    ...options,
    assistantOptions: {
      availability: unavailable,
      connectionCheck: async () => unavailable(),
      bridgeFactory: () => {
        throw new Error('Browser test must provide a scripted model bridge');
      },
      ...options.assistantOptions,
    },
  });
  // Register before Chromium starts: a failed browser launch must release the writer.
  // Runtime.close is idempotent; fixture teardown still owns its directories.
  t.after(() => runtime.close());
  return runtime;
}

export async function launchBrowser(t: TestContext) {
  const browser = await chromium.launch({ headless: true, timeout: 15000 });
  const abort = () => {
    void browser.close().catch(() => {});
  };
  t.signal.addEventListener('abort', abort, { once: true });
  browser.once('disconnected', () => t.signal.removeEventListener('abort', abort));
  if (t.signal.aborted) abort();
  // Normal fixture teardown closes the browser after any diagnostic capture.
  return browser;
}

export async function newTestPage(browser: Browser, options?: Parameters<Browser['newPage']>[0]) {
  const page = await browser.newPage(options);
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(10000);
  return page;
}
