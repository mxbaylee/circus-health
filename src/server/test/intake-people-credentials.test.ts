import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJSONL } from '../intake-format.ts';

function candidate(passage: string, fullName = 'River Sparrow') {
  return {
    format: 'health-record-v1',
    id: 'fictional-signer',
    kind: 'record',
    payload: passage,
    provenance: {
      capturedVia: null,
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'fictional signature',
    },
    coverage: { status: 'complete_response', notes: [] },
    report: {
      key: 'fictional-report',
      title: 'Fictional report',
      anchor: { locator: 'signature', text: passage },
      subject: null,
    },
    people: [
      {
        id: 'signer',
        fullName,
        role: 'clinician',
        evidence: [{ textAnchor: passage, supports: ['fullName'] }],
      },
    ],
  };
}

test('named signer credentials allow separately reviewed clinician proposals', () => {
  for (const degree of ['OD', 'O.D.', 'M.D.', 'D.O.', 'DDS', 'D.D.S.', 'DMD', 'D.M.D.']) {
    const validation = validateJSONL(
      Buffer.from(JSON.stringify(candidate(`Signed by River Sparrow, ${degree}`))),
    );
    assert.equal(validation.valid, true, `${degree}: ${JSON.stringify(validation.issues)}`);
  }
});

test('optical laterality and another signer credential do not establish patient clinician role', () => {
  for (const passage of [
    'Patient: River Sparrow. Right (OD) sphere +2.00. Left (OS) sphere +1.00.',
    'Patient: River Sparrow. Signed by Rowan Lark, O.D.',
    'Patient: River Sparrow. Occupation: designer.',
  ]) {
    const validation = validateJSONL(Buffer.from(JSON.stringify(candidate(passage))));
    assert.equal(validation.valid, false, passage);
  }
});
