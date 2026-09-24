import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Run real focus guards, the browser's focus events and portaled dialogs; jsdom
// cannot exercise the intermediate focus transitions at a modal boundary.
test(
  'entry history restores focus and accepts Escape during the modal return-focus gap',
  { timeout: 30000 },
  async (t) => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const fixture = resolve(root, '__entry_focus_fixture.tsx');
    const source = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{EntryActions}from'/app/components/DetailHeader';import{NoteDialog}from'/app/features/notes/NoteDialog';import'/app/styles.css';function Fixture(){const[open,setOpen]=useState(false);return <EntryActions><button onClick={()=>setOpen(true)}>History</button><NoteDialog open={open} onOpenChange={setOpen} title="Saved history" description="Synthetic focus fixture"><button>Last dialog action</button></NoteDialog></EntryActions>}createRoot(document.getElementById('root')).render(<Fixture/>);`;
    const vite = await createServer({
      root,
      configFile: false,
      plugins: [
        react(),
        {
          name: 'entry-focus-fixture',
          resolveId(id) {
            if (id === '/__entry_focus_fixture.tsx' || id === fixture) return fixture;
          },
          load(id) {
            if (id === fixture) return source;
          },
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.url !== '/__entry_focus') return next();
              res.setHeader('Content-Type', 'text/html');
              void server
                .transformIndexHtml(
                  '/__entry_focus',
                  '<div id="root"></div><script type="module" src="/__entry_focus_fixture.tsx"></script>',
                )
                .then((html) => res.end(html));
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0 },
    });
    await vite.listen();
    const browser = await chromium.launch();
    t.after(async () => {
      await browser.close();
      await vite.close();
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(
      `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}/__entry_focus`,
      {
        waitUntil: 'domcontentloaded',
      },
    );
    page.setDefaultTimeout(5000);
    const trigger = page.locator('.entry-actions-trigger');
    for (let pass = 0; pass < 3; pass++) {
      await trigger.click();
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await page.getByRole('dialog', { name: 'Saved history' }).waitFor();
      // Radix guards receive focus while the browser crosses a portal boundary.
      await page.locator('[data-radix-focus-guard]').last().focus();
      await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]'));
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      if (pass === 2)
        await page.evaluate(() => {
          const observer = new MutationObserver(() => {
            if (document.querySelector('[role="dialog"]')) return;
            observer.disconnect();
            // A second Escape can arrive after unmount but before Radix's deferred
            // return-focus callback. At that instant, the browser focuses BODY.
            document.body.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
          });
          observer.observe(document.body, { childList: true, subtree: true });
        });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      if (pass === 2) {
        await page.waitForFunction(
          () =>
            document.querySelector('.entry-actions-trigger')!.getAttribute('aria-expanded') ===
            'false',
        );
        assert.equal(await trigger.evaluate((el) => document.activeElement === el), true);
        continue;
      }
      await page.waitForFunction(
        () => document.activeElement === document.querySelector('.entry-actions-panel > button'),
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () =>
          document.querySelector('.entry-actions-trigger')!.getAttribute('aria-expanded') ===
          'false',
      );
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await trigger.evaluate((el) => document.activeElement === el), true);
    }
  },
);
