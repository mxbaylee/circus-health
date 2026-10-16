import type { IntakePersonProposal } from '../../shared/intake-people';

/** Independently fictional, complete Person proposal for client approval regressions. */
export const importPerson = (id = 'fictional-alex'): IntakePersonProposal => ({
  id,
  version: `version-${id}`,
  state: 'pending',
  intakeId: 'fictional-intake',
  intakeVersion: 7,
  proposalId: null,
  envelopeRecordId: `record-${id}`,
  envelopeId: `envelope-${id}`,
  groupId: 'fictional-group',
  groupVersionId: 'group-v1',
  title: 'Fictional family record',
  person: { fullName: 'Fictional Alex', relationship: 'child', tags: ['Family'] },
  uncertainties: [],
  evidence: [],
  matches: [],
  matchCount: 0,
  matchesTruncated: false,
  source: {
    sourceRecordId: id,
    filename: 'fictional.jsonl',
    contentUrl: '/api/sources/fictional/content',
    originalSourceFileId: 'fictional-source',
    originalSha256: 'fictional-hash',
    member: null,
  },
});
