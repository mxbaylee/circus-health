import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { external, publicOrigin } from '../../deploy/run.ts';

export function physicalPasskeyConfiguration(env: NodeJS.ProcessEnv) {
  assert.equal(
    env.CRS_PHYSICAL_PASSKEY_QUALIFICATION,
    '1',
    'Explicit physical qualification opt-in required.',
  );
  assert.ok(env.CRS_QUALIFICATION_ORIGIN, 'Supply the isolated fictional installation origin.');
  const origin = publicOrigin({ CRS_PUBLIC_ORIGIN: env.CRS_QUALIFICATION_ORIGIN }, '443');
  assert.equal(
    new URL(origin).protocol,
    'https:',
    'Physical qualification requires a trusted HTTPS origin.',
  );
  const channel = env.CRS_QUALIFICATION_BROWSER ?? 'chrome';
  assert.ok(
    ['chrome', 'msedge'].includes(channel),
    'This driver supports actual Chrome or Edge only.',
  );
  const output = external(env.CRS_QUALIFICATION_OUTPUT_DIR, 'CRS_QUALIFICATION_OUTPUT_DIR', {
    directory: true,
  });
  return { origin, channel, output };
}

export interface PhysicalPasskeyProgress {
  confirmedEnrollment: boolean;
  successfulUnlocks: number;
  recoveryFallback: boolean;
}
export function physicalPasskeyPassed(progress: PhysicalPasskeyProgress) {
  return (
    progress.confirmedEnrollment === true &&
    progress.successfulUnlocks === 3 &&
    progress.recoveryFallback === true
  );
}

/** Uses the application's UI and unmodified navigator.credentials. No CDP,
 * virtual authenticator, injected credential function or TLS bypass is used. */
export async function physicalPasskeyJourney(
  page: Page,
  origin: string,
  saveRecovery: (phrase: string) => void,
  progress: PhysicalPasskeyProgress,
  observe: (progress: PhysicalPasskeyProgress) => Promise<void> = async () => {},
) {
  const api = async <T = unknown>(path: string, body?: unknown): Promise<T> => {
    assert.equal(new URL(page.url()).origin, origin);
    const result = await page.evaluate(
      async ({ path, body }) => {
        const response = await fetch(
          path,
          body === undefined
            ? {}
            : {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              },
        );
        return { ok: response.ok, data: ((await response.json()) as { data: unknown }).data };
      },
      { path, body },
    );
    assert.equal(result.ok, true);
    return result.data as T;
  };
  await page.goto(origin);
  assert.deepEqual(await api('/api/profiles'), [], 'Use a fresh isolated fictional installation.');
  const name = 'Fictional Passkey Person ' + randomUUID().slice(0, 8);
  await page.getByRole('button', { name: 'Create profile', exact: true }).click();
  const creation = page.getByRole('dialog', { name: 'Create profile', exact: true });
  await creation.getByLabel('Display name', { exact: true }).fill(name);
  await creation.getByLabel('Your name').fill(name);
  await creation.getByLabel('Date of birth', { exact: true }).fill('1982-04-17');
  await page.getByRole('button', { name: 'Continue to recovery key' }).click();
  const recovery = await page.getByLabel('Recovery key', { exact: true }).inputValue();
  assert.equal(recovery.trim().split(/\s+/u).length, 24);
  saveRecovery(recovery);
  await page.getByLabel('I have saved my recovery key').check();
  await page.getByRole('button', { name: 'Verify recovery key', exact: true }).click();
  const verification = page.getByRole('dialog', { name: 'Open profile', exact: true });
  await verification.getByLabel('Recovery key', { exact: true }).fill(recovery);
  await verification.getByRole('button', { name: 'Open profile', exact: true }).click();
  // Install response wait before the physical enrollment gesture can complete.
  const confirmation = page.waitForResponse(
    (response) =>
      new URL(response.url()).origin === origin && response.url().endsWith('/passkeys/confirm'),
  );
  await page
    .getByRole('dialog', { name: 'Recovery unlocked', exact: true })
    .getByRole('button', { name: 'Add passkey', exact: true })
    .click();
  assert.equal((await confirmation).status(), 200);
  for (const heading of ['Primary care provider', 'Emergency contact']) {
    const contacts = page.getByRole('dialog', { name: 'Care contacts' });
    await contacts.getByRole('heading', { name: heading, exact: true }).waitFor();
    await contacts.getByRole('button', { name: 'Skip for now' }).click();
  }
  type Profiles = { id: string; hasPasskey: boolean; locked: boolean }[];
  const profiles = await api<Profiles>('/api/profiles');
  assert.equal(profiles.length, 1);
  const profile = profiles[0];
  assert.equal(profile.hasPasskey, true);
  const path = '/api/profiles/' + encodeURIComponent(profile.id);
  assert.equal((await api<unknown[]>(path + '/passkeys')).length, 1);
  progress.confirmedEnrollment = true;
  await observe(progress);

  const openProfile = async () => {
    await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
    await page.getByRole('button', { name: new RegExp('^' + name + '\\s*Locked', 'u') }).click();
  };
  for (let index = 0; index < 3; index++) {
    await api(path + '/lock', {});
    await page.reload();
    const unlocked = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === origin &&
        response.url().endsWith('/passkeys/authenticate'),
    );
    await openProfile();
    assert.equal((await unlocked).status(), 200);
    assert.equal((await api<Profiles>('/api/profiles'))[0].locked, false);
    assert.equal((await api<unknown[]>(path + '/passkeys')).length, 1);
    await api(path + '/notes/patient');
    progress.successfulUnlocks++;
    await observe(progress);
  }
  await api(path + '/lock', {});
  await page.reload();
  await openProfile();
  const login = page.getByRole('dialog', { name: 'Open ' + name, exact: true });
  await login.getByRole('button', { name: 'Use recovery key', exact: true }).click();
  assert.equal((await api<Profiles>('/api/profiles'))[0].locked, true);
  await login.getByLabel('Recovery key', { exact: true }).fill(recovery);
  await login.getByRole('button', { name: 'Open profile', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Recovery unlocked', exact: true })
    .getByRole('button', { name: 'Skip', exact: true })
    .click();
  await api(path + '/notes/patient');
  assert.equal((await api<Profiles>('/api/profiles'))[0].locked, false);
  progress.recoveryFallback = true;
  await observe(progress);
  await api(path + '/lock', {});
}

async function main() {
  const config = physicalPasskeyConfiguration(process.env);
  const attempt = randomUUID();
  const progress: PhysicalPasskeyProgress = {
    confirmedEnrollment: false,
    successfulUnlocks: 0,
    recoveryFallback: false,
  };
  const browser = await chromium.launch({ channel: config.channel, headless: false });
  let cancel: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('Physical qualification cancelled.'));
  });
  process.once('SIGINT', cancel!);
  process.once('SIGTERM', cancel!);
  try {
    const page = await browser.newPage();
    // Human gestures have no elapsed-time acceptance target. Ctrl-C cancels the run.
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(30_000);
    console.log(
      'Approve the native enrollment and three unlock prompts. The last prompt switches to recovery. Do not share recovery material.',
    );
    await Promise.race([
      physicalPasskeyJourney(
        page,
        config.origin,
        (phrase) => {
          writeFileSync(join(config.output, attempt + '-recovery.txt'), phrase + '\n', {
            mode: 0o600,
            flag: 'wx',
          });
        },
        progress,
      ),
      cancellation,
    ]);
  } finally {
    process.removeListener('SIGINT', cancel!);
    process.removeListener('SIGTERM', cancel!);
    writeFileSync(
      join(config.output, attempt + '-passkey.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          task: 'CRS-072',
          independentlyFictional: true,
          browserChannel: config.channel,
          browserVersion: browser.version(),
          https: true,
          passed: physicalPasskeyPassed(progress),
          progress,
          scope: 'One actual desktop browser and authenticator on one trusted HTTPS origin.',
          remainingAcceptance: [
            'Other intended browsers and authenticators',
            'Physical phone HTTPS-origin journey',
            'Release-build container recreation',
          ],
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    await browser.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(
      'Physical passkey qualification did not pass. Check isolated origin, browser installation and external receipt; complete the authenticator gestures.',
    );
    process.exitCode = 1;
  }
}
