import { finishClinicalReviewWork } from './clinical-review-work.ts';
import type { IntakeReviewDraft } from '../shared/intake.ts';

interface Proof {
  state: string;
  epoch: object;
}
interface SelectedDraft {
  proposalId: string | null;
  recordId: string;
  versionId: string;
  draft: IntakeReviewDraft | null;
  proof: Proof;
}
/** One-use transfer between the mapping and policy stages of the same selected
 * review. The complete draft/provider is already destined for that record;
 * nothing is serialized, cloned, or retained across review sessions. */
export function selectedDraftHandoff(proof: () => Proof | undefined) {
  let records = new WeakMap<object, SelectedDraft>();
  let last: SelectedDraft | undefined;
  let reading: object | undefined;
  const same = (a: Proof | undefined, b: Proof | undefined) =>
    !!a && !!b && a.state === b.state && a.epoch === b.epoch;
  return {
    read(
      proposalId: string | null,
      recordId: string,
      versionId: string,
      read: () => IntakeReviewDraft | null,
    ) {
      return finishClinicalReviewWork(
        this.readWork(proposalId, recordId, versionId, function* () {
          return read();
        }),
      );
    },
    *readWork(
      proposalId: string | null,
      recordId: string,
      versionId: string,
      read: () => Generator<void, IntakeReviewDraft | null, void>,
    ): Generator<void, IntakeReviewDraft | null, void> {
      last = undefined;
      const pending = (reading = {}),
        before = proof();
      try {
        const draft = yield* read();
        const after = proof();
        if (reading === pending && same(before, after))
          last = { proposalId, recordId, versionId, draft, proof: before! };
        return draft;
      } finally {
        if (reading === pending) reading = undefined;
      }
    },
    bind(record: { id: string }, draft: IntakeReviewDraft | null) {
      const selected = last;
      last = undefined;
      if (selected && selected.recordId === record.id && selected.draft === draft)
        records.set(record, selected);
    },
    consume(proposalId: string | null, record: { id: string }, versionId: string) {
      last = undefined;
      const selected = records.get(record);
      records.delete(record);
      if (
        selected &&
        selected.proposalId === proposalId &&
        selected.recordId === record.id &&
        selected.versionId === versionId &&
        same(selected.proof, proof())
      )
        return selected.draft;
      return undefined;
    },
    clear() {
      reading = undefined;
      last = undefined;
      records = new WeakMap();
    },
  };
}
