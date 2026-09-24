import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateSourceIdentityV1,
  clinicalSourceIdentityV1,
  INTAKE_SOURCE_IDENTITY_VERSION,
} from '../intake-source-identity.ts';
import type { IntakeEntry } from '../intake-format.ts';

const file = { id: 'delivery-a', sha256: 'a'.repeat(64) };
const entry: Pick<IntakeEntry, 'value'> = {
  value: {
    format: 'health-record-v1',
    id: 'result-a',
    kind: 'record',
    payload: { literal: '12' },
    provenance: {
      sourceSystem: ' Fictional Clinic ',
      sourceRecordId: ' F-17 ',
      locator: 'page 2',
      capturedVia: null,
      evidenceClass: 'provider_export',
    },
    coverage: { status: 'complete_response', notes: [] },
  },
};

test('v1 clinical and candidate domains preserve exact legacy persisted vectors', () => {
  assert.equal(INTAKE_SOURCE_IDENTITY_VERSION, 1);
  assert.equal(
    clinicalSourceIdentityV1(entry, file),
    '9579d7727c1e4cd42aa4bc820aebc608c6a9ef05e3a766dbb083d43d6393c236',
  );
  assert.equal(
    candidateSourceIdentityV1(file, entry),
    'candidate:352754929842d7d5b4deac5b5b19e17dd3fe84f4695df89ca2c4774897b301fc',
  );
  const original = structuredClone(entry);
  original.value.provenance.sourceSystem = null;
  assert.equal(
    clinicalSourceIdentityV1(original, file),
    '06fd30e82b263b89bfc89682d81a5561b09a986aeff26de749936bbb2ecf30e1',
  );
});

test('candidate history remains delivery and report-subject scoped while clinical lookup retains original source identity', () => {
  const other = { ...file, id: 'delivery-b' };
  assert.equal(clinicalSourceIdentityV1(entry, file), clinicalSourceIdentityV1(entry, other));
  assert.notEqual(candidateSourceIdentityV1(file, entry), candidateSourceIdentityV1(other, entry));
  const report = structuredClone(entry);
  report.value.report = {
    key: 'r',
    title: 'Fictional report',
    anchor: { locator: 'page 2', text: 'Report' },
    subject: { locator: 'page 2', text: 'Fictional Iris' },
  };
  const next = structuredClone(report);
  next.value.report!.subject!.text = 'Fictional Rowan';
  assert.notEqual(candidateSourceIdentityV1(file, report), candidateSourceIdentityV1(file, next));
});
