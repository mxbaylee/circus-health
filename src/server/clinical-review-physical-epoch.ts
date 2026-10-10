let epoch: object = {};
let activeWriters = 0;
let mutationSequence = 0n;

/** Rotates before and after a managed filesystem mutation, including failures. */
export function beginManagedPhysicalMutation(): () => void {
  mutationSequence++;
  epoch = {};
  activeWriters++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    mutationSequence++;
    activeWriters--;
    epoch = {};
  };
}

/** Read-only attempt sequence. It is not permission to renew an authority proof. */
export function managedPhysicalMutationSequence(): bigint {
  return mutationSequence;
}

export function captureManagedPhysicalEpoch(): object | undefined {
  return activeWriters === 0 ? epoch : undefined;
}

export function managedPhysicalEpochCurrent(expected: object): boolean {
  return activeWriters === 0 && epoch === expected;
}

export function withManagedPhysicalMutation<T>(work: () => T): T {
  const finish = beginManagedPhysicalMutation();
  try {
    return work();
  } finally {
    finish();
  }
}
