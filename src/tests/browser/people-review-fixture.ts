import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import {
  fixtureApi,
  fixtureReview,
  fixtureDestinations,
  fixtureProposalId,
} from './native-intake-fixture.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import { fetchFixtureApi } from './fixture-api-request.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { IntakeIdentityScopeReference } from '../../shared/intake-identity.ts';
import type { CollectionImportFeed } from '../../shared/intake-clinical-pages.ts';
import type { Note, Medication } from '../../shared/api.ts';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const people = [
  {
    title: 'Fictional Robin',
    fullName: 'Fictional Robin Alder',
    birthDate: '1958-03-12',
    relationship: 'Parent',
    label: 'Alder',
    dose: '5 mg',
  },
  {
    title: 'Fictional Robin',
    fullName: 'Fictional Robin Birch',
    birthDate: '1991-07-22',
    relationship: 'Sibling',
    label: 'Birch',
    dose: '10 mg',
  },
  {
    title: 'Fictional Marigold-With-A-Very-Long-Familiar-Name Meadowbrook',
    fullName: 'Fictional Marigold Meadowbrook',
    birthDate: '1974-11-03',
    relationship: 'Friend',
    label: 'Meadow',
    dose: '15 mg',
  },
];

export async function createPeopleReviewFixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(resolve(realpathSync(tmpdir()), 'circus-people-owner-review-'));
  mkdirSync(resolve(root, 'data'));
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startBrowserRuntime(t, {
    dataDirectory: resolve(root, 'data'),
    runtimeDirectory,
    port: 0,
    host: '127.0.0.1',
  });
  const browser = await launchBrowser(t);
  t.after(async () => {
    await browser.close();
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  await page.goto(origin);
  const runtimeResponse = await fetchFixtureApi(page.request, origin + '/api/runtime');
  assert.equal(
    (await runtimeResponse.json()).encrypted,
    true,
    'Review fixture requires a real encrypted runtime',
  );
  const api = fixtureApi(page, origin);
  const pending = (await api('/api/profile-setups', {
    name: 'Fictional Hazel Self',
    fullName: 'Fictional Hazel Self',
    birthDate: '1983-04-17',
  })) as { setupId: string; recoveryKit: unknown };
  const profile = (await api(`/api/profile-setups/${pending.setupId}/verify`, {
    acknowledged: true,
    recovery: pending.recoveryKit,
  })) as { id: string };
  const prefix = `/api/profiles/${profile.id}`;
  const persons: Note[] = [];
  for (const person of people)
    persons.push(
      (await api(prefix + '/notes', {
        kind: 'person',
        title: person.title,
        person: {
          fullName: person.fullName,
          birthDate: person.birthDate,
          relationship: person.relationship,
          tags: ['Family review'],
        },
      })) as Note,
    );
  const scenarios = [
    { label: 'Hazel', dose: '2 mg', person: null },
    ...people.map((person, i) => ({
      label: person.label,
      dose: person.dose,
      person: persons[i],
    })),
  ];
  for (const scenario of scenarios) {
    t.diagnostic(`Preparing fictional ${scenario.label} records`);
    const original = ['medication', 'procedure']
      .map((kind, i) =>
        JSON.stringify({
          format: 'health-record-v1',
          id: `fictional-${scenario.label}-${kind}`,
          kind: 'record',
          report: {
            key: `fictional-${scenario.label}-report`,
            anchor: { locator: 'page 1 heading', text: `Fictional ${scenario.label} report` },
            title: `Fictional ${scenario.label} report`,
            subject: {
              locator: 'page 1 patient',
              text: scenario.person
                ? String(scenario.person.person.fullName)
                : 'Fictional Hazel Self',
            },
          },
          payload: {
            literal:
              kind === 'medication'
                ? `Fictional ${scenario.label} capsule prescribed ${scenario.dose} on 2026-02-10.`
                : `Fictional ${scenario.label} imaging performed on 2026-02-10.`,
          },
          clinical: {
            kind,
            subject: 'unknown',
            date: '2026-02-10',
            ...(kind === 'medication'
              ? {
                  medicationName: `Fictional ${scenario.label} capsule`,
                  medicationKind: 'order',
                  doseText: scenario.dose,
                }
              : {
                  procedureLabel: `Fictional ${scenario.label} imaging`,
                  procedureCategory: 'imaging',
                  eventKind: 'performed',
                  status: 'completed',
                }),
          },
          provenance: {
            sourceSystem: 'Fictional People Clinic',
            capturedVia: 'Fictional browser fixture',
            sourceRecordId: `${scenario.label}-${kind}`,
            evidenceClass: 'provider_export',
            locator: `fictional-${scenario.label}.txt line ${i + 3}`,
          },
          coverage: { status: 'complete_response', notes: [] },
        }),
      )
      .join('\n');
    const upload = await fetchFixtureApi(page.request, origin + prefix + '/intakes', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'text/plain',
        'X-Filename': `fictional-${scenario.label}.txt`,
      },
      data: `Fictional ${scenario.label} report\nPatient: ${scenario.person ? String(scenario.person.person.fullName) : 'Fictional Hazel Self'}\nFictional ${scenario.label} capsule prescribed ${scenario.dose} on 2026-02-10.\nFictional ${scenario.label} imaging performed on 2026-02-10.`,
    });
    assert.equal(upload.status(), 201, await upload.text());
    const intake = (await upload.json()).data;
    const stopped = await stopFixtureImport(page, origin, prefix, intake.id);
    await api(`${prefix}/intakes/${encodeURIComponent(intake.id)}/proposals`, {
      version: stopped.version,
      summary: 'Fictional People review records',
      jsonlText: original,
    });
    const proposalId = await fixtureProposalId(api, prefix, intake.id);
    t.diagnostic(`Reviewing fictional ${scenario.label} report identity`);
    const feed = (await api(
      `${prefix}/intakes/import-feed?view=all&intakeId=${encodeURIComponent(intake.id)}`,
    )) as CollectionImportFeed;
    for (const groupId of new Set(feed.records.map((record) => record.groupId))) {
      const scope = (await api(
        `${prefix}/intakes/${encodeURIComponent(intake.id)}/identity-scope?groupId=${encodeURIComponent(groupId)}`,
      )) as IntakeIdentityScopeReference;
      await api(`${prefix}/intakes/${encodeURIComponent(intake.id)}/identity-scope`, {
        version: scope.intakeVersion,
        operationId: `confirm-${scenario.label}-${groupId}`,
        scope,
        outcome: scenario.person ? 'this_is_person' : 'this_is_me',
        attestation: 'confirmed_displayed_identity_questions',
        ...(scenario.person
          ? {
              personSelection: {
                noteId: scenario.person.id,
                expectedVersion: scenario.person.version,
              },
            }
          : {}),
      });
    }
    t.diagnostic(`Accepting fictional ${scenario.label} records`);
    const review = await fixtureReview(
      api,
      `${prefix}/intakes/${encodeURIComponent(intake.id)}/review?proposalId=${encodeURIComponent(proposalId)}`,
    );
    await api(`${prefix}/intakes/${encodeURIComponent(intake.id)}/import`, {
      version: review.version,
      proposalId: review.proposalId,
      reviewToken: review.reviewToken,
      decisions: review.records.map((record) => ({
        recordId: record.id,
        action: 'accept',
        mapping: record.mapping,
      })),
    });
    t.diagnostic(`Checking fictional ${scenario.label} destinations`);
    const destinations = await fixtureDestinations(api, prefix, intake.id);
    assert.equal(destinations.length, 2);
    const medication = destinations.find((record) => record.kind === 'medication')!;
    const saved = (await api(
      `${prefix}/medications/${encodeURIComponent(medication.entityId)}`,
    )) as Medication;
    const activated = await fetchFixtureApi(
      page.request,
      origin + `${prefix}/medications/${encodeURIComponent(medication.entityId)}/current-status`,
      {
        method: 'PATCH',
        headers: { Origin: origin },
        data: {
          status: 'current',
          version: saved.currentStatusVersion,
          visibilityVersion: saved.visibilityVersion,
        },
      },
    );
    assert.equal(activated.status(), 200, await activated.text());
    const owner = scenario.person?.personId || 'patient';
    const ownMeds = (await api(
      `${prefix}/medications?personId=${encodeURIComponent(owner)}&status=current`,
    )) as Medication[];
    assert.deepEqual(
      ownMeds.map((row) => row.label),
      [`Fictional ${scenario.label} capsule`],
    );
  }

  return { page, browser, origin, prefix, persons, scenarios, errors };
}
