import { createPeopleReviewFixture, people } from './people-review-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public, session-authorized setup/import/accept/ownership APIs only. The external
// capture directory is opt-in; no screenshots, records or session secrets enter Git.
test(
  'People owner review: encrypted fictional records, distinction and keyboard return',
  { timeout: 120000 },
  async (t) => {
    const { page, browser, origin, persons, scenarios, errors } =
      await createPeopleReviewFixture(t);
    const visuals = process.env.CRS_PEOPLE_REVIEW_DIR;
    if (visuals) {
      const repo = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
      mkdirSync(visuals, { recursive: true });
      const outside = relative(repo, realpathSync(visuals));
      assert(outside === '..' || outside.startsWith(`..${sep}`), 'Evidence must be outside Git');
    }
    const sourceFiles = [
      'src/app/components/PersonFilter.tsx',
      'src/app/features/notes/NotesPage.tsx',
      'src/app/features/notes/NoteEditor.tsx',
      'src/app/features/notes/PersonClinicalRecords.tsx',
      'src/app/features/notes/notes.css',
      'src/tests/browser/people-review-fixture.ts',
      'src/tests/browser/people-owner-review.test.ts',
    ];
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const steps: unknown[] = [];
    async function focus() {
      return page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        return {
          tag: el.tagName,
          text: el.innerText?.slice(0, 220),
          label: el.getAttribute('aria-label'),
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          outline: getComputedStyle(el).outlineStyle,
        };
      });
    }
    async function capture(name: string) {
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'No horizontal overflow',
      );
      steps.push({ capture: name, focus: await focus() });
      if (visuals)
        await page.screenshot({ path: resolve(visuals, `${name}.png`), animations: 'disabled' });
    }
    async function tabTo(selector: string) {
      const order: unknown[] = [];
      if (
        await page
          .locator(selector)
          .evaluateAll((elements) => elements.some((element) => element === document.activeElement))
      )
        return;
      for (let n = 0; n < 80; n++) {
        await page.keyboard.press('Tab');
        order.push(await focus());
        if (
          await page
            .locator(selector)
            .evaluateAll((elements) =>
              elements.some((element) => element === document.activeElement),
            )
        ) {
          steps.push({ keyboardTabOrder: order });
          return;
        }
      }
      assert.fail(`Keyboard did not reach ${selector}`);
    }
    await page.reload();
    for (const [size, viewport] of [
      ['desktop', { width: 1280, height: 900 }],
      ['narrow', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto(origin + '/#/');
      const health = page.getByRole('region', { name: 'Health records' });
      await health.getByText('Fictional Hazel capsule', { exact: true }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await capture(`01-self-${size}`);
      await health.scrollIntoViewIfNeeded();
      await page.evaluate(() =>
        window.scrollBy(
          0,
          document.querySelector('.person-health-records')!.getBoundingClientRect().top - 160,
        ),
      );
      await capture(`01-self-${size}-summaries`);
    }
    for (const [size, viewport] of [
      ['desktop', { width: 1280, height: 900 }],
      ['narrow', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto(origin + '/#/people');
      const rows = page.locator('.notes-results .notes-row');
      await rows.nth(2).waitFor();
      assert.equal(await rows.count(), 3, 'Self remains separate');
      await capture(`02-${size}-people-list`);
      for (const [index, person] of persons.entries()) {
        const selector = `.notes-results .notes-row:has-text("${people[index].fullName}")`;
        await tabTo(selector);
        await capture(`03-${size}-${people[index].label}-list-focus`);
        await page.keyboard.press('Enter');
        await page
          .getByRole('textbox', { name: 'Display name or familiar label', exact: true })
          .waitFor();
        const health = page.getByRole('region', { name: 'Health records' });
        await health
          .getByText(`Fictional ${people[index].label} capsule`, { exact: true })
          .waitFor();
        await health
          .getByText(`Fictional ${people[index].label} imaging`, { exact: true })
          .waitFor();
        for (const other of scenarios.filter((scenario) => scenario.label !== people[index].label))
          assert.equal(
            await health.getByText(`Fictional ${other.label} capsule`, { exact: true }).count(),
            0,
          );
        assert(new URLSearchParams(page.url().split('?')[1]).get('id') === person.id);
        assert(
          await page
            .getByRole('heading', { name: people[index].title, exact: true, level: 2 })
            .evaluate((el) => el === document.activeElement),
          'Keyboard selection focuses person heading',
        );
        await capture(`04-${size}-${people[index].label}-selected-focus`);
        await health.scrollIntoViewIfNeeded();
        await page.evaluate(() => {
          const health = document.querySelector('.person-health-records')!;
          const header = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 220;
          window.scrollBy(0, health.getBoundingClientRect().top - Math.max(header + 24, 240));
        });
        await health.getByText(people[index].fullName, { exact: true }).waitFor();
        await health.getByText(`Born ${people[index].birthDate}`, { exact: true }).waitFor();
        await capture(`05-${size}-${people[index].label}-summaries`);
        if (size === 'narrow' && people[index].label === 'Meadow') {
          const recent = health.getByRole('heading', { name: 'Recent procedures', exact: true });
          await recent.scrollIntoViewIfNeeded();
          await recent.evaluate((element) => {
            const header = document.querySelector('.topbar')!.getBoundingClientRect();
            window.scrollBy(0, element.getBoundingClientRect().top - header.bottom - 24);
          });
          await capture('05-narrow-Meadow-procedure-companion');
        }
        if (size === 'narrow' && people[index].title === 'Fictional Robin') {
          for (const kind of ['capsule', 'imaging']) {
            const summarySelector = `.person-health-records a:has-text("Fictional ${people[index].label} ${kind}")`;
            await tabTo(summarySelector);
            const focusBounds = await page.locator(summarySelector).boundingBox();
            const footer = await page.locator('.note-actions').boundingBox();
            assert(
              focusBounds && footer && focusBounds.y + focusBounds.height < footer.y,
              `Focused ${kind} stays above sticky save controls`,
            );
            assert(
              await page.locator(summarySelector).evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return element.contains(
                  document.elementFromPoint(
                    bounds.x + bounds.width / 2,
                    bounds.y + bounds.height / 2,
                  ),
                );
              }),
              'Focused summary link is not covered',
            );
            await capture(`05-narrow-${people[index].label}-${kind}-link-focus`);
          }
        }
        if (size === 'narrow') {
          await tabTo('.notes-mobile-back');
          await capture(`06-${size}-${people[index].label}-back-focus`);
          await page.keyboard.press('Enter');
          await rows.nth(2).waitFor();
          await page.waitForFunction(
            (fullName) =>
              document.activeElement?.classList.contains('notes-row') &&
              document.activeElement.textContent?.includes(fullName),
            people[index].fullName,
          );
          assert(
            await page.locator(selector).evaluate((el) => el === document.activeElement),
            'Back restores the selected person row',
          );
          await capture(`07-${size}-${people[index].label}-returned-focus`);
        } else {
          await tabTo('a[href="#/people"]');
          await page.keyboard.press('Enter');
          await page.waitForURL((url) => !new URLSearchParams(url.hash.split('?')[1]).has('id'));
          await rows.nth(2).waitFor();
          await page.waitForFunction(
            (fullName) =>
              document.activeElement?.classList.contains('notes-row') &&
              document.activeElement.textContent?.includes(fullName),
            people[index].fullName,
          );
          assert(
            await page.locator(selector).evaluate((el) => el === document.activeElement),
            'People navigation restores the selected person row',
          );
          await capture(`07-${size}-${people[index].label}-returned-focus`);
        }
      }
    }
    // Native select typeahead is actual keyboard input; unlike selectOption it
    // also exercises the keyed trigger's replacement after applying a person.
    await page.goto(origin + '/#/medications?personId=' + encodeURIComponent(persons[0].personId!));
    await page.getByRole('button', { name: 'Edit person: Fictional Robin', exact: true }).waitFor();
    await tabTo('.person-filter button[aria-label="Edit person: Fictional Robin"]');
    await page.keyboard.press('Enter');
    const select = page.getByRole('combobox', { name: 'Show records for' });
    await page.waitForFunction(() => {
      const select = document.querySelector<HTMLSelectElement>('.person-filter select');
      return select && !select.disabled;
    });
    await tabTo('.person-filter select');
    for (
      let attempt = 0;
      attempt < people.length + 1 && (await select.inputValue()) !== persons[1].personId;
      attempt++
    )
      await page.keyboard.press('f');
    assert.equal(await select.inputValue(), persons[1].personId);
    await page.keyboard.press('Tab');
    assert(
      await page
        .getByRole('button', { name: 'Save filter', exact: true })
        .evaluate((el) => el === document.activeElement),
    );
    await page.keyboard.press('Enter');
    await page.waitForURL(
      (url) => new URLSearchParams(url.hash.split('?')[1]).get('personId') === persons[1].personId,
    );
    await page.getByRole('button', { name: /Fictional Birch capsule/ }).waitFor();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'Edit person: Fictional Robin',
    );
    await capture('08-narrow-person-filter-saved-focus');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const select = document.querySelector<HTMLSelectElement>('.person-filter select');
      return select && !select.disabled;
    });
    if (!(await select.evaluate((el) => el === document.activeElement)))
      await tabTo('.person-filter select');
    await page.keyboard.press('Escape');
    assert(
      await page
        .getByRole('button', { name: 'Edit person: Fictional Robin', exact: true })
        .evaluate((el) => el === document.activeElement),
    );
    await capture('09-narrow-person-filter-escape-focus');

    await page.goto(origin + '/#/people');
    await page.locator('.notes-results .notes-row').nth(2).waitFor();
    await tabTo('.notes-row:has-text("Fictional Marigold Meadowbrook")');
    await page.keyboard.press('Enter');
    await page.getByLabel('Pronouns', { exact: true }).waitFor();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname.endsWith('/notes/' + encodeURIComponent(persons[2].id)) &&
        response.ok(),
    );
    await page.getByLabel('Pronouns', { exact: true }).fill('they/them');
    const save = page.getByRole('button', { name: 'Save now', exact: true });
    await save.focus();
    assert(await save.isEnabled());
    assert(await save.evaluate((el) => el === document.activeElement));
    await capture('10-narrow-footer-save-focus');
    await page.keyboard.press('Enter');
    const accepted = (await (await saved).json()).data;
    assert.equal(accepted.person.pronouns, 'they/them');
    await page.getByText('Saved just now', { exact: true }).waitFor();
    await capture('11-narrow-footer-saved-status');
    assert.deepEqual(errors, []);
    if (visuals)
      writeFileSync(
        resolve(visuals, 'flow-receipt.json'),
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            source: {
              revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
              dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
              files: sourceFiles.map((path) => ({ path, sha256: hash(path) })),
            },
            build: JSON.parse(readFileSync('src/dist/build-info.json', 'utf8')),
            browser: browser.version(),
            viewports: [
              { width: 1280, height: 900 },
              { width: 390, height: 844 },
            ],
            fixture: { self: 'Fictional Hazel Self', people },
            steps,
            assets: [
              'src/dist/index.html',
              ...readdirSync('src/dist/assets')
                .filter(
                  (name) =>
                    name.startsWith('index-') && (name.endsWith('.js') || name.endsWith('.css')),
                )
                .map((name) => 'src/dist/assets/' + name),
            ].map((path) => ({
              path,
              sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
            })),
            limitations: [
              'Viewport simulation is not physical-phone qualification.',
              'No live provider/model requests; JSONL fictional records were explicitly accepted through public APIs.',
              'Screenshots are not accessibility certification.',
            ],
          },
          null,
          2,
        ),
      );
  },
);
