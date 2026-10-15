import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, proposeConversion, proposeConversionRead, getIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { createApp } from '../index.ts';
import { fictionalModel } from './fictional-model.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import type { IntakeIdentityReview } from '../../shared/intake-identity.ts';

export const heading = 'Fictional report IVY-61',
  subject = 'Patient: Fictional Iris Meadow',
  birthDate = '1990-03-08';
export const envelope = (id: string, explicit = false): HealthRecordEnvelope => ({
  format: 'health-record-v1',
  id,
  kind: 'record',
  payload: { literal: '12.00' },
  provenance: {
    capturedVia: null,
    sourceSystem: 'Invented Clinic',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'page 1 result ' + id,
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: {
    kind: 'observation',
    subject: 'unknown',
    testLabel: 'Fictional test ' + id,
    valueText: '12.00',
    unit: 'mg',
    date: '2026-03-02',
  },
  report: {
    key: 'claim',
    title: 'Fictional report',
    anchor: { locator: 'page 1 heading', text: heading },
    subject: { locator: 'page 1 patient', text: subject },
  },
  ...(explicit
    ? {
        reviewIssues: [
          {
            kind: 'identity' as const,
            field: 'subject',
            prompt: 'Confirm the original identifies its patient rather than a guardian',
            textAnchor: subject,
          },
        ],
      }
    : {}),
});
export async function fixture(
  t: test.TestContext,
  native = true,
  count = 3,
  explicit = false,
  recordAt = (n: number) => envelope('fictional-' + n, explicit && n === count - 1),
  originalText = `${heading}\n${subject}\nDOB: ${birthDate}\nFictional result`,
  nativeProposal = false,
) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-identity-http-')),
    profileId = 'fictional-identity-http';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from(originalText),
    newProviderName: 'Invented Clinic',
  });
  if (nativeProposal) await buildIntakeCollectionEnvelope(db, { id: original.id });
  // Native ordinary-import qualification starts the verified contributor app
  // before publishing the proposal. Separate recovery fixtures retain cold
  // startup after publication and qualify reconstruction explicitly.
  const startApp = async () => {
    const app = createApp({
      root,
      databases: new Map([[profileId, db]]),
      intakeBatchOptions: { authorized: () => false },
    });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/profiles/${profileId}/intakes/${encodeURIComponent(original.id)}/`;
    t.after(() => {
      app.close();
      if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    return { app, base };
  };
  const started = nativeProposal ? await startApp() : undefined;
  const proposed = await (nativeProposal ? proposeConversionRead : proposeConversion)(
    db,
    root,
    profileId,
    original.id,
    {
      version: original.version,
      summary: 'Independently fictional proposal',
      jsonlText: Array.from({ length: count }, (_, n) => JSON.stringify(recordAt(n))).join('\n'),
    },
  );
  const groupId = nativeProposal
    ? (() => {
        const view = openIntakeCollectionEnvelope(db, { id: original.id }),
          intake = view.child(view.root(), 'intake')!,
          workflow = view.child(intake, 'workflow')!,
          group = view.childAt(workflow, 'reportGroups', 0)!,
          field = view.field(group, 'id');
        assert.equal(field.kind, 'value');
        return (field as { kind: 'value'; value: string }).value;
      })()
    : getIntake(db, root, profileId, original.id).workflow!.reportGroups![0]!.id;
  if (native && !nativeProposal) await buildIntakeCollectionEnvelope(db, { id: original.id });
  const { app, base } = started || (await startApp());
  const request = async (action: string, input?: unknown, status = 200) => {
    const response = await fetch(
      base + action,
      input === undefined
        ? undefined
        : {
            method: 'POST',
            headers: {
              origin: 'http://127.0.0.1:5173',
              'content-type': 'application/json',
            },
            body: JSON.stringify(input),
          },
    );
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value.data || value;
  };
  const review = () =>
    request(
      'identity-review?groupId=' + encodeURIComponent(groupId),
    ) as Promise<IntakeIdentityReview>;
  return {
    root,
    profileId,
    db,
    original,
    proposed,
    groupId,
    app,
    base,
    request,
    review,
  };
}
