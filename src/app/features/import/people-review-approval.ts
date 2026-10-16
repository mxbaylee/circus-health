import type { IntakePersonProposal } from '../../../shared/intake-people';
import { sameReviewValue } from '../intake/review-draft-pair-scope';

/** Memory-only approval of the exact Person shown, independent of transport revisions. */
export type PeopleReviewApproval = Pick<
  IntakePersonProposal,
  'id' | 'intakeId' | 'groupId' | 'version' | 'person'
>;

export const peopleChangedMessage =
  'A selected Person changed while you were reviewing; review and approve them again.';

export function peopleReviewApproval(person: PeopleReviewApproval): PeopleReviewApproval {
  return structuredClone({
    id: person.id,
    intakeId: person.intakeId,
    groupId: person.groupId,
    version: person.version,
    person: person.person,
  });
}

export function samePeopleApproval(a: PeopleReviewApproval, b: PeopleReviewApproval) {
  return sameReviewValue(peopleReviewApproval(a), peopleReviewApproval(b));
}

/** Never silently drop a requested Person or substitute the currently refreshed row. */
export function requirePeopleApprovals(ids: string[], approvals: PeopleReviewApproval[]) {
  const indexed = new Map<string, PeopleReviewApproval>();
  for (const approval of approvals) {
    const id = `person:${approval.id}`;
    if (indexed.has(id)) throw new Error(peopleChangedMessage);
    indexed.set(id, approval);
  }
  return ids
    .filter((id) => id.startsWith('person:'))
    .map((id) => {
      const approval = indexed.get(id);
      if (!approval) throw new Error(peopleChangedMessage);
      return peopleReviewApproval(approval);
    });
}

export function assertPeopleCurrent(
  approval: PeopleReviewApproval,
  current: PeopleReviewApproval &
    Pick<IntakePersonProposal, 'state' | 'selfMatch' | 'matches' | 'matchesTruncated'>,
  adding: boolean,
) {
  if (!samePeopleApproval(approval, current) || current.state === 'saved')
    throw new Error(peopleChangedMessage);
  if (
    adding &&
    (!['pending', 'later'].includes(current.state) ||
      current.selfMatch ||
      current.matches.length ||
      current.matchesTruncated)
  )
    throw new Error(`${current.person.fullName} needs an individual People match decision.`);
}
