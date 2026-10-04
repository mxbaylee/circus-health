import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import { canonicalLiteral, type IntakeEntry } from '../intake-format.ts';
import {
  identityOriginalFingerprintForMember,
  iterateCompetingIdentityBoundaries,
  type IdentityBoundaryHeader,
} from '../intake-identity-policy.ts';
import { resolveReportContextsWithLookup } from '../intake-report-context.ts';

const boundary = (id: string, subject: string, memberId = 'member-1'): IdentityBoundaryHeader => ({
  id,
  sourceFileId: 'source',
  sourceHash: 'original-hash',
  memberId,
  report: {
    key: 'report',
    title: 'Fictional report',
    anchor: { locator: 'page 1', text: 'Fictional report' },
    subject: { locator: 'page 1', text: subject },
    memberId,
  },
});
test('complete streamed boundaries retain off-page conflict and separate equal-byte occurrences', () => {
  const group = boundary('current', 'Patient: Iris Meadow');
  let visited = 0;
  function* completeScope() {
    for (let index = 0; index < 10_001; index++) {
      visited++;
      yield boundary(String(index), 'Iris Meadow');
    }
    yield boundary('other-occurrence', 'Rowan River', 'member-2');
    yield boundary('off-page-conflict', 'Rowan River');
  }
  const conflicts = [...iterateCompetingIdentityBoundaries(group, completeScope())];
  assert.equal(visited, 10_001);
  assert.deepEqual(
    conflicts.map((item) => item.id),
    ['off-page-conflict'],
  );
});

test('member point lookup preserves exact original fingerprint preimage and occurrence separation', () => {
  const expected = createHash('sha256')
    .update(
      canonicalLiteral([
        'intake-member-original',
        'source',
        'member-1',
        'folder/évidence.txt',
        'member-hash',
      ]),
    )
    .digest('hex');
  assert.equal(
    identityOriginalFingerprintForMember('source', 'archive-hash', 'member-1', {
      locator: 'folder/évidence.txt',
      sourceHash: 'member-hash',
    }),
    expected,
  );
  assert.notEqual(
    identityOriginalFingerprintForMember('source', 'archive-hash', 'member-2', {
      locator: 'folder/évidence.txt',
      sourceHash: 'member-hash',
    }),
    expected,
  );
});

function entry(id: string, kind: HealthRecordEnvelope['kind'], line: number): IntakeEntry {
  const value: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id,
    kind,
    payload: { text: 'Fictional report' },
    contextId: 'context-alias',
    provenance: {
      sourceSystem: 'Fictional source',
      capturedVia: null,
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    report: {
      key: 'report',
      title: 'Fictional report',
      anchor: { locator: 'page 1', text: 'Fictional report' },
      subject: null,
      memberId: 'member-1',
    },
  };
  return { value, line, raw: JSON.stringify(value), canonical: canonicalLiteral(value) };
}

test('report display page checks complete off-page alias ambiguity with bounded retained matches', () => {
  const record = entry('record', 'record', 4);
  let reads = 0;
  const result = resolveReportContextsWithLookup(
    { packageEvidence: true, hasMember: () => true },
    [record],
    {
      *contexts(alias) {
        assert.equal(alias, 'context-alias');
        reads++;
        yield entry('first-context', 'context', 1);
        reads++;
        yield entry('off-page-context', 'context', 10001);
        throw Error('A proven ambiguity must not collect the rest of the alias scope');
      },
    },
  );
  assert.equal(reads, 2);
  assert.equal(result.get(4)?.context.status, 'unresolved');
  assert.match(result.get(4)!.context.detail, /ambiguous/);
});

test('report display page requires selected inventory membership even when the context exists', () => {
  const record = entry('record', 'record', 4),
    context = entry('context', 'context', 1);
  const lookup = { contexts: () => [context] };
  const located = resolveReportContextsWithLookup(
    { packageEvidence: true, hasMember: (id) => id === 'member-1' },
    [record],
    lookup,
  );
  assert.equal(located.get(4)?.context.status, 'linked');
  const missing = resolveReportContextsWithLookup(
    { packageEvidence: true, hasMember: () => false },
    [record],
    lookup,
  );
  assert.equal(missing.get(4)?.context.status, 'unresolved');
  assert.match(missing.get(4)!.context.detail, /host-verified package member/);
});
