import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import GuidedApp from '../../app/passkey-checker/GuidedApp';
import { createCheckerController } from '../../app/passkey-checker/controller';
import { openCheckerStore } from '../../app/passkey-checker/store';
import { guidedCore, guidedRun } from '../passkey-checker-guided-fixture';

/** Loaded only by the controlled browser test, never by the public checker entry point. */
export async function mountGuidedFixture() {
  const native = guidedCore();
  const controller = await createCheckerController({
    build: guidedRun().build,
    environment: guidedRun().environment,
    newRun: () => ({ ...guidedRun(), id: `fictional-${crypto.randomUUID()}` }),
    core: native.core,
    openStore: () => openCheckerStore(indexedDB, 'fictional-guided-browser'),
  });
  (
    window as unknown as { fixture: { controller: typeof controller; native: typeof native } }
  ).fixture = { controller, native };
  const old = await openCheckerStore(indexedDB, 'fictional-previous-browser');
  if (!(await old.load())) {
    const { flow: _flow, registrationMode: _mode, ...run } = guidedRun();
    await old.commit(null, { run });
  }
  old.close();
  createRoot(document.getElementById('root')!).render(
    createElement(GuidedApp, {
      controller,
      support: { supported: true, reason: 'Controlled fixture, not physical qualification.' },
    }),
  );
}
