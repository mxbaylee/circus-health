import '../../app/tokens.css';
import '../../app/passkey-checker/checker.css';
import { createRoot } from 'react-dom/client';
import GuidedApp from '../../app/passkey-checker/GuidedApp.tsx';
import { guidedFixture } from '../passkey-checker-guided-fixture.ts';
import { openCheckerStore } from '../../app/passkey-checker/store.ts';
import { reportMarkdown } from '../../app/passkey-checker/report.ts';
import { roundDatabase, LEGACY_DATABASE } from '../../app/passkey-checker/round.ts';
import type { RegistrationMode } from '../../app/passkey-checker/round.ts';
import { createRun, inspectEnvironment } from '../../app/passkey-checker/environment.ts';
import type { CheckerController } from '../../app/passkey-checker/controller.ts';

declare global {
  interface Window {
    checkerFixture: {
      controller: CheckerController;
      report(): string;
      start(mode?: RegistrationMode): Promise<void>;
      openCheckerStore: typeof openCheckerStore;
      roundDatabase: typeof roundDatabase;
      oldSnapshot: string;
    };
  }
}

// This entry is served only by the controlled browser test, never the published checker.
const root = createRoot(document.getElementById('root')!);
let controller: CheckerController | undefined;
const old = await openCheckerStore(indexedDB, LEGACY_DATABASE);
if (!(await old.load()))
  await old.commit(null, { run: createRun({ version: '3', revision: 'a'.repeat(40), worktree: 'clean' }, inspectEnvironment('Fictional old browser')) });
const oldSnapshot = JSON.stringify(await old.load());
old.close();
async function start(mode: RegistrationMode = 'eval') {
  controller?.close();
  const fixture = await guidedFixture({ mode,
    failCreate: new Set(new URL(location.href).searchParams.has('failB') ? ['B'] : []),
    openStore: () => openCheckerStore(indexedDB, `${roundDatabase(mode)}-abc-v1`),
  });
  controller = fixture.controller;
  window.checkerFixture = { controller, report: () => reportMarkdown(fixture.controller.exportModel()),
    start, openCheckerStore, roundDatabase, oldSnapshot };
  // The injected fictional port tests UI/crypto/storage only. Production still requires HTTPS
  // both in checkSupport and again at nativePort; no native credential API is overridden.
  root.render(<GuidedApp key={mode} controller={controller} mode={mode} onMode={(next) => void start(next)}
    supportCheck={() => ({ supported: true, reason: null })} />);
}
await start();
