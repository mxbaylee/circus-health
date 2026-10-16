import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createVaultApp } from '../vault-app.ts';
import { createTestRuntimeDirectory } from './runtime-fixture.ts';
import {
  fixtureReview,
  fixtureProposalId,
  fixtureDestinations,
} from '../../tests/browser/native-intake-fixture.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import {
  ownershipIntakeScopes,
  ownershipIntakeScopeOccurrences,
} from '../ownership-intake-scopes.ts';
import type { OwnershipRequest } from '../../shared/record-ownership.ts';
import type { IntakeAcceptedRecord } from '../../shared/intake.ts';
import type {
  OwnershipReportPreviewReference,
  OwnershipReportPage,
  OwnershipReportPreviewRecord,
  OwnershipReceiptReference,
} from '../../shared/ownership-report-reference.ts';
import { ownershipSourceAuthority } from '../record-ownership-authority.ts';
import { queryRecordHistory } from '../record-versions.ts';
import type { CollectionImportFeed } from '../../shared/intake-clinical-pages.ts';
import type { Medication, Note } from '../../shared/api.ts';

// All clinical and identity writes use the encrypted public API. Direct DB reads
// below inspect authority and current projections, never seed the scenario.
test(
  'encrypted native prescription and procedure person correction preserves evidence and reconstructs history',
  { timeout: 180000 },
  async (t) => {
    const root = mkdtempSync(resolve(realpathSync(tmpdir()), 'fictional-native-ownership-http-'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const dataDirectory = resolve(root, 'data');
    mkdirSync(dataDirectory);
    const app = createVaultApp({
      dataDirectory,
      runtimeDirectory,
      assistantOptions: { availability: () => ({ available: false, readiness: 'unavailable' }) },
    });
    t.after(() => {
      app.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    let cookie = '';
    async function send(
      path: string,
      input?: unknown,
      method = input === undefined ? 'GET' : 'POST',
      raw = false,
    ) {
      const response = await fetch(origin + path, {
        method,
        headers: {
          Origin: 'http://localhost:5173',
          Cookie: cookie,
          'Content-Type': raw ? 'text/plain' : 'application/json',
          ...(raw ? { 'X-Filename': 'fictional-ownership.txt' } : {}),
        },
        ...(input === undefined ? {} : { body: raw ? String(input) : JSON.stringify(input) }),
      });
      if (response.headers.get('set-cookie'))
        cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      const payload = (await response.json()) as {
        data?: unknown;
        error?: { code: string; message: string };
      };
      return { status: response.status, ...payload };
    }
    const api = async (path: string, body?: unknown): Promise<unknown> => {
      const response = await send(path, body);
      assert.ok(response.status < 300, JSON.stringify(response));
      return response.data;
    };
    const setup = (await api('/api/profile-setups', {
      name: 'Fictional Hazel Self',
      fullName: 'Fictional Hazel Self',
      birthDate: '1983-04-17',
    })) as { setupId: string; profileId: string; recoveryKit: unknown };
    await api(`/api/profile-setups/${setup.setupId}/verify`, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
    const prefix = `/api/profiles/${setup.profileId}`;
    const person = (await api(prefix + '/notes', {
      kind: 'person',
      title: 'Fictional Robin Alder',
      person: {
        fullName: 'Fictional Robin Alder',
        birthDate: '1958-03-12',
        relationship: 'Parent',
      },
    })) as Note;
    async function accept(
      label: string,
    ): Promise<{ intakeId: string; records: IntakeAcceptedRecord[]; jsonlText: string }> {
      const upload = await send(
        prefix + '/intakes',
        `Independently fictional ${label} prescription and performed imaging.`,
        'POST',
        true,
      );
      assert.equal(upload.status, 201, JSON.stringify(upload));
      const intakeId = (upload.data as { id: string }).id;
      const batches = (await api(prefix + '/intake-batches')) as {
        id: string;
        items: { intakeId: string }[];
      }[];
      for (const batch of batches)
        if (batch.items.some((item) => item.intakeId === intakeId))
          await api(prefix + '/intake-batches/' + batch.id + '/stop', {});
      const current = (await api(prefix + '/intakes/' + intakeId)) as { version: number };
      const jsonlText = ['medication', 'procedure']
        .map((kind, i) =>
          JSON.stringify({
            format: 'health-record-v1',
            id: `fictional-${label}-${kind}`,
            kind: 'record',
            payload: { literal: `Independently fictional ${label} ${kind}` },
            clinical: {
              kind,
              subject: 'self',
              date: '2026-02-10',
              ...(kind === 'medication'
                ? {
                    medicationName: `Fictional ${label} capsule`,
                    medicationKind: 'order',
                    doseText: '5 mg',
                  }
                : {
                    procedureLabel: `Fictional ${label} imaging`,
                    procedureCategory: 'imaging',
                    eventKind: 'performed',
                    status: 'completed',
                  }),
            },
            provenance: {
              sourceSystem: 'Fictional Clinic',
              capturedVia: 'Fictional HTTP fixture',
              sourceRecordId: `${label}-${kind}`,
              evidenceClass: 'provider_export',
              locator: `fictional-${label}.jsonl line ${i + 1}`,
            },
            coverage: { status: 'complete_response', notes: [] },
          }),
        )
        .join('\n');
      await api(prefix + '/intakes/' + intakeId + '/proposals', {
        version: current.version,
        summary: 'Fictional ownership review',
        jsonlText,
      });
      const proposalId = await fixtureProposalId(api, prefix, intakeId);
      const review = await fixtureReview(
        api,
        `${prefix}/intakes/${intakeId}/review?proposalId=${encodeURIComponent(proposalId)}`,
      );
      assert.equal(review.records.length, 2);
      await api(prefix + '/intakes/' + intakeId + '/import', {
        version: review.version,
        proposalId,
        reviewToken: review.reviewToken,
        decisions: review.records.map((record) => ({
          recordId: record.id,
          action: 'accept',
          mapping: {},
        })),
      });
      return { intakeId, records: await fixtureDestinations(api, prefix, intakeId), jsonlText };
    }
    const selected = await accept('selected');
    const unrelated = await accept('unrelated');
    const selectedMedication = selected.records.find((record) => record.kind === 'medication')!;
    const medication = (await api(
      prefix + '/medications/' + selectedMedication.entityId,
    )) as Medication;
    const activated = await send(
      prefix + '/medications/' + medication.id + '/current-status',
      {
        status: 'current',
        version: medication.currentStatusVersion,
        visibilityVersion: medication.visibilityVersion,
      },
      'PATCH',
    );
    assert.equal(activated.status, 200, JSON.stringify(activated));
    assert.equal((activated.data as Medication).currentStatus, 'current');
    const originalBytes = async () =>
      Promise.all(
        [selected, unrelated].map(async ({ intakeId }) => {
          const response = await fetch(
            origin + prefix + '/sources/' + encodeURIComponent(intakeId) + '/content',
            { headers: { Cookie: cookie } },
          );
          assert.equal(response.status, 200);
          return Buffer.from(await response.arrayBuffer());
        }),
      );
    const retainedOriginals = await originalBytes();
    const state = () => app.manager.opened.get(setup.profileId)!;
    const before = state();
    const view = openIntakeCollectionEnvelope(before.db, { id: selected.intakeId });
    const workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
    const group = view.childAt(workflow, 'reportGroups', 0)!;
    const version = view.childAt(group, 'versions', view.childCount(group, 'versions') - 1)!;
    assert.equal(
      view.child(version, 'members'),
      undefined,
      'actual native member reference is a bounded object-valued cell',
    );
    const reference = view.field(version, 'members', { bytes: 65536 });
    assert.equal(reference.kind, 'value');
    assert.equal(
      (reference as { value: { format: string } }).value.format,
      'health-intake-report-members-v1',
    );
    const occurrences = [...ownershipIntakeScopeOccurrences(before.db, selected.intakeId)];
    const recordId = occurrences.find((row) => row.recordId)!.recordId!;
    assert.ok(
      [...ownershipIntakeScopes(before.db, selected.intakeId, recordId)].length > 0,
      'contains branch resolves native references without exactGroups',
    );
    assert.deepEqual(
      [...ownershipIntakeScopes(before.db, unrelated.intakeId, recordId)],
      [],
      'other intake members cannot enter selected scope',
    );
    const snapshot = () => ({
      medications: state().db.prepare('SELECT * FROM medications ORDER BY id').all(),
      procedures: state().db.prepare('SELECT * FROM procedures ORDER BY id').all(),
      sources: state().db.prepare('SELECT * FROM source_records ORDER BY id').all(),
      head: state().recordStorage.read('head'),
    });
    let request: OwnershipRequest = {
      selection: {
        type: 'records',
        records: selected.records.map((record) => ({
          kind: record.kind,
          recordId: record.entityId,
        })),
      },
      destination: { noteId: person.id, expectedVersion: person.version },
    };
    const historyPath = (record: IntakeAcceptedRecord) =>
      `${prefix}/record-history?kind=${record.kind}&recordId=${encodeURIComponent(record.entityId)}`;
    const originalHistories = await Promise.all(
      selected.records.map((record) => api(historyPath(record))),
    );
    const unchanged = snapshot();
    const preview = (await api(
      prefix + '/record-ownership/preview',
      request,
    )) as OwnershipReportPreviewReference;
    assert.deepEqual(preview.blockers, []);
    assert.deepEqual(await originalBytes(), retainedOriginals);
    assert.deepEqual(
      snapshot(),
      unchanged,
      'preview changes neither accepted authority nor clinical ownership or sources',
    );
    assert.deepEqual(
      await Promise.all(selected.records.map((record) => api(historyPath(record)))),
      originalHistories,
    );
    const page = (await api(
      preview.reportEvidence.url + '?section=records&after=-1&limit=10&bytes=65536',
    )) as OwnershipReportPage;
    assert.equal(page.complete, true);
    assert.equal(page.total, 2);
    const reviewedRecords = page.items as OwnershipReportPreviewRecord[];
    assert.ok(
      reviewedRecords.every(
        (record) => record.version && record.contributions && record.owner.personId === 'patient',
      ),
    );
    assert.equal(
      reviewedRecords.find((record) => record.kind === 'medication')!.medicationActivity,
      'inactive',
    );
    const commit = (p: OwnershipReportPreviewReference) => ({
      operationId: randomUUID(),
      request: p.request,
      version: p.version,
      scopeToken: p.scopeToken,
    });
    for (const input of [
      { ...commit(preview), scopeToken: preview.scopeToken + '-stale' },
      {
        ...commit(preview),
        request: {
          ...preview.request,
          destination: { noteId: person.id, expectedVersion: person.version + 1 },
        },
      },
      {
        ...commit(preview),
        request: {
          ...preview.request,
          selection: {
            type: 'records',
            records:
              preview.request.selection.type === 'records'
                ? preview.request.selection.records.map((record) => ({
                    ...record,
                    version: (record.version || '') + '-stale',
                  }))
                : [],
          },
        },
      },
    ]) {
      const refused = await send(prefix + '/record-ownership', input);
      assert.equal(refused.status, 409, JSON.stringify(refused));
      assert.deepEqual(snapshot(), unchanged, 'stale proof cannot partially publish');
    }
    // Advance the actual retained membership through another supported proposal.
    // The selected accepted records stay unchanged, while the old snapshot proof
    // must cease authorizing a correction.
    const stalePreview = (await api(
      prefix + '/record-ownership/preview',
      request,
    )) as OwnershipReportPreviewReference;
    const intake = (await api(prefix + '/intakes/' + selected.intakeId)) as { version: number };
    const sibling = JSON.parse(selected.jsonlText.split('\n')[0]!);
    sibling.id = 'fictional-later-pending';
    sibling.provenance.sourceRecordId = sibling.id;
    sibling.clinical.medicationName = 'Fictional later pending capsule';
    await api(prefix + '/intakes/' + selected.intakeId + '/proposals', {
      version: intake.version,
      summary: 'Fictional later pending sibling',
      jsonlText: selected.jsonlText + '\n' + JSON.stringify(sibling),
    });
    const advancedView = openIntakeCollectionEnvelope(state().db, { id: selected.intakeId });
    const advancedWorkflow = advancedView.child(
      advancedView.child(advancedView.root(), 'intake')!,
      'workflow',
    )!;
    const advancedGroup = advancedView.childAt(advancedWorkflow, 'reportGroups', 0)!;
    const advancedVersion = advancedView.childAt(
      advancedGroup,
      'versions',
      advancedView.childCount(advancedGroup, 'versions') - 1,
    )!;
    assert.notDeepEqual(
      advancedView.field(advancedVersion, 'members', { bytes: 65536 }),
      reference,
      'supported proposal advances the actual retained member snapshot',
    );
    const afterMembership = snapshot();
    const refusedSnapshot = await send(prefix + '/record-ownership', commit(stalePreview));
    assert.equal(refusedSnapshot.status, 409, JSON.stringify(refusedSnapshot));
    assert.equal(refusedSnapshot.error?.code, 'OWNERSHIP_CHANGED');
    assert.deepEqual(
      snapshot(),
      afterMembership,
      'changed retained members refuse without partial publication',
    );
    // A real destination edit also invalidates the reviewed correction.
    const destinationPreview = (await api(
      prefix + '/record-ownership/preview',
      request,
    )) as OwnershipReportPreviewReference;
    const savedPersonResponse = await send(
      prefix + '/notes/' + person.id,
      { ...person, title: 'Fictional Robin Alder updated' },
      'PUT',
    );
    assert.equal(savedPersonResponse.status, 200, JSON.stringify(savedPersonResponse));
    const savedPerson = savedPersonResponse.data as Note;
    const afterDestination = snapshot();
    const refusedDestination = await send(prefix + '/record-ownership', commit(destinationPreview));
    assert.equal(refusedDestination.status, 409, JSON.stringify(refusedDestination));
    assert.equal(refusedDestination.error?.code, 'OWNERSHIP_CHANGED');
    assert.deepEqual(snapshot(), afterDestination);
    request = {
      ...request,
      selection: {
        type: 'records',
        records: reviewedRecords.map(({ kind, recordId, version }) => ({
          kind,
          recordId,
          version,
        })),
      },
      destination: { noteId: savedPerson.id, expectedVersion: savedPerson.version },
    };
    const staleRecordRequest = {
      ...request,
      selection: {
        type: 'records',
        records: reviewedRecords.map(({ kind, recordId, version }) => ({
          kind,
          recordId,
          version: version + '-stale',
        })),
      },
    };
    const staleRecord = await send(prefix + '/record-ownership/preview', staleRecordRequest);
    assert.equal(staleRecord.status, 409, JSON.stringify(staleRecord));
    assert.equal(staleRecord.error?.code, 'OWNERSHIP_CHANGED');
    assert.deepEqual(snapshot(), afterDestination);
    const checkedPreview = (await api(
      prefix + '/record-ownership/preview',
      request,
    )) as OwnershipReportPreviewReference;
    assert.deepEqual(checkedPreview.blockers, []);
    assert.equal(checkedPreview.reportEvidence.recordTotal, 2);
    const sourceAuthorities: { identity: string; sourceRecordId: string; sourceFileId: string }[] =
      [];
    const checkedPage = (await api(
      checkedPreview.reportEvidence.url + '?section=records&after=-1&limit=10&bytes=65536',
    )) as OwnershipReportPage;
    assert.equal(checkedPage.complete, true);
    for (const record of checkedPage.items as OwnershipReportPreviewRecord[]) {
      const reference = record.contributions;
      const contributions = Array.isArray(reference)
        ? reference
        : await (async () => {
            const page = (await api(reference.url + '&after=-1&limit=10&bytes=65536')) as {
              items: { identity: string; sourceRecordId: string; sourceFileId: string }[];
              complete: boolean;
            };
            assert.equal(page.complete, true);
            return page.items;
          })();
      assert.equal(contributions.length, 1);
      sourceAuthorities.push(...contributions);
    }
    assert.equal(sourceAuthorities.length, 2);
    const beforeCommitSources = state()
      .db.prepare('SELECT * FROM source_records ORDER BY id')
      .all();
    const beforeCommitFiles = state().db.prepare('SELECT * FROM source_files ORDER BY id').all();
    const pendingPath =
      prefix +
      '/intakes/import-feed?view=all&state=pending&intakeId=' +
      encodeURIComponent(selected.intakeId);
    const pending = (await api(pendingPath)) as CollectionImportFeed;
    assert.ok(pending.totalRecords > 0, 'later sibling remains pending');
    const checked = commit(checkedPreview);
    const receipt = (await api(prefix + '/record-ownership', checked)) as OwnershipReceiptReference;
    assert.equal(receipt.moved, 2);
    assert.equal(receipt.destinationPersonId, person.personId);
    const checkOwners = async () => {
      assert.deepEqual(await originalBytes(), retainedOriginals);
      const currentPending = (await api(pendingPath)) as CollectionImportFeed;
      assert.equal(
        currentPending.totalRecords,
        pending.totalRecords,
        'selected-record correction never accepts the pending sibling',
      );
      assert.deepEqual(
        state().db.prepare('SELECT * FROM source_records ORDER BY id').all(),
        beforeCommitSources,
      );
      assert.deepEqual(
        state().db.prepare('SELECT * FROM source_files ORDER BY id').all(),
        beforeCommitFiles,
      );
      for (const source of sourceAuthorities) {
        const authority = ownershipSourceAuthority(state().db, source.identity);
        assert.equal(authority?.personId, person.personId);
        assert.equal(authority?.sourceRecordId, source.sourceRecordId);
        assert.ok(unchanged.sources.some((row) => row.id === source.sourceRecordId));
      }
      const movedMedication = (await api(
        prefix + '/medications/' + selectedMedication.entityId,
      )) as Medication;
      assert.equal(movedMedication.currentStatus, 'not_current');
      const preferences = queryRecordHistory(state().db, {
        profileId: setup.profileId,
        entity: 'medication_preferences',
        recordId: selectedMedication.entityId,
      });
      assert.ok(
        preferences.entries.some((entry) => entry.contents.status === 'current'),
        'former personal taking assertion remains in accepted history',
      );
      for (const record of selected.records) {
        const table = record.kind === 'medication' ? 'medications' : 'procedures';
        assert.equal(
          state().db.prepare(`SELECT person_id FROM ${table} WHERE id=?`).get(record.entityId)!
            .person_id,
          person.personId,
        );
        const history = (await api(historyPath(record))) as {
          entries: { contents: { person_id?: string } }[];
          ownershipCorrections: unknown[];
        };
        assert.ok(history.entries.some((entry) => entry.contents.person_id === 'patient'));
        assert.ok(history.entries.some((entry) => entry.contents.person_id === person.personId));
        assert.equal(history.ownershipCorrections.length, 1);
      }
      for (const record of unrelated.records) {
        const table = record.kind === 'medication' ? 'medications' : 'procedures';
        assert.deepEqual(
          state().db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(record.entityId),
          (table === 'medications' ? unchanged.medications : unchanged.procedures).find(
            (row) => row.id === record.entityId,
          ),
        );
      }
    };
    await checkOwners();
    const histories = await Promise.all(selected.records.map((record) => api(historyPath(record))));
    await api(prefix + '/lock', {});
    rmSync(resolve(app.manager.pathFor(setup.profileId), 'cache'), {
      recursive: true,
      force: true,
    });
    await api(prefix + '/unlock', { recovery: setup.recoveryKit });
    assert.equal(state().metrics.cacheHit, false);
    await checkOwners();
    assert.deepEqual(
      await Promise.all(selected.records.map((record) => api(historyPath(record)))),
      histories,
    );
    assert.deepEqual(await api(prefix + '/record-ownership', checked), {
      ...receipt,
      replayed: true,
    });
  },
);
