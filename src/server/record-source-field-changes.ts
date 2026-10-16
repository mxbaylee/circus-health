/** Disk-backed field diffs for retained giant source metadata during replay. */
import {
  prepareRecordPriorFieldsSteps,
  type PreparedRecordPriorFields,
} from './record-prior-fields.ts';

export interface RecordSourceFieldChange {
  field: string;
  beforePresent: boolean;
  afterPresent: boolean;
}

export function* recordSourceFieldChanges(
  before: string | undefined,
  after: string | undefined,
  checkpoint: () => void,
): Generator<RecordSourceFieldChange> {
  const prepare = (raw: string): PreparedRecordPriorFields => {
    const steps = prepareRecordPriorFieldsSteps([raw], checkpoint);
    try {
      for (;;) {
        const next = steps.next();
        if (next.done) return next.value;
        checkpoint();
      }
    } finally {
      steps.return(undefined as never);
    }
  };
  const previous = prepare(before ?? '{}');
  let next: PreparedRecordPriorFields | undefined;
  try {
    next = prepare(after ?? '{}');
    const compare = function* (field: string): Generator<RecordSourceFieldChange> {
      checkpoint();
      const old = previous.get(field),
        value = next!.get(field);
      if (old?.hash !== value?.hash || old?.bytes !== value?.bytes)
        yield { field, beforePresent: old !== undefined, afterPresent: value !== undefined };
    };
    for (const field of previous.fields()) yield* compare(field);
    for (const field of next.fields()) if (previous.get(field) === undefined) yield* compare(field);
  } finally {
    previous.close();
    next?.close();
  }
}
