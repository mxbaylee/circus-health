/** Portable audit membership in the existing accepted intake graph. A selected
 * ownership.snapshots catalog is retained evidence, not an unfinished build. */
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { clinicalReviewRevision, type Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import {
  createReportSnapshotCatalog,
  type ReportSnapshotMapReader,
  type ReportSnapshotMapWriter,
} from './intake-report-snapshot-catalog.ts';
import {
  recordIntakeWork,
  withIntakeWork,
  type IntakeWorkPhase,
} from './intake-work-accounting.ts';

export interface OwnershipSourceSnapshotReference {
  format: 'health-ownership-source-snapshot-v1';
  source: { intakeId: string; sourceHash: string };
  snapshotId: string;
  count: number;
  digest: string;
}
const prefix = 'source:';
const key = (id: string) => {
  if (!id || Buffer.byteLength(prefix + id) > 1024)
    throw Error('Ownership source identity exceeds supported key grammar');
  return prefix + id;
};
function* sorted(values: Iterable<string>) {
  let previous: string | undefined;
  for (const value of values) {
    if (typeof value !== 'string') throw Error('Invalid ownership source identity');
    key(value);
    if (previous !== undefined && previous >= value)
      throw Error('Ownership source identities must be distinct and ordered');
    previous = value;
    yield value;
  }
}
function* members(reader: ReportSnapshotMapReader) {
  let after: string | undefined = prefix;
  do {
    const page = reader.range({ after, items: 64, bytes: 65536 });
    for (const item of page.items) {
      if (
        !item.key.startsWith(prefix) ||
        typeof item.value !== 'string' ||
        key(item.value) !== item.key
      )
        throw Error('Invalid ownership source snapshot member');
      yield item.value;
    }
    if (page.complete) return;
    if (!page.after || page.after === after)
      throw Error('Ownership snapshot cursor failed to advance');
    after = page.after;
  } while (true);
}
function accumulator(db: Database, phase: IntakeWorkPhase) {
  const hash = createHash('sha256').update('[');
  let count = 0;
  withIntakeWork(db, phase, () => recordIntakeWork('ownershipSnapshotHashedBytes', 1));
  return {
    add(id: string) {
      const text = JSON.stringify(id),
        bytes = Buffer.byteLength(text) + (count ? 1 : 0);
      if (count++) hash.update(',');
      hash.update(text);
      withIntakeWork(db, phase, () => recordIntakeWork('ownershipSnapshotHashedBytes', bytes));
    },
    finish() {
      withIntakeWork(db, phase, () => recordIntakeWork('ownershipSnapshotHashedBytes', 1));
      return { count, digest: hash.update(']').digest('hex') };
    },
  };
}
function open(
  catalog: ReturnType<typeof createReportSnapshotCatalog>,
  reference: OwnershipSourceSnapshotReference,
) {
  if (
    reference.format !== 'health-ownership-source-snapshot-v1' ||
    !Number.isSafeInteger(reference.count) ||
    reference.count < 0 ||
    !/^[a-f0-9]{64}$/.test(reference.digest)
  )
    throw Error('Invalid ownership source snapshot reference');
  const reader = catalog.open(reference.snapshotId),
    metadata = reader?.get('$meta');
  if (!reader || typeof metadata !== 'string' || metadata !== JSON.stringify(reference))
    throw Error('Ownership source snapshot reference disagrees with retained authority');
  return reader;
}
export function createOwnershipSourceSnapshotPreparation(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { assertRunning?: () => void } = {},
) {
  const initial = selectedEnvelopeStore(db, source),
    { collections } = initial,
    basis = clinicalReviewRevision(db),
    version = collections.binding(collections.openView())!.logical.domainVersion,
    binding = { intakeId: initial.identity.intakeId, sourceHash: initial.identity.sourceHash },
    catalog = createReportSnapshotCatalog(db, source, {
      ...options,
      catalog: 'ownership.snapshots',
      catalogArea: 'builds',
    });
  let finished = false;
  let published = false;
  const assertCurrent = () => {
    options.assertRunning?.();
    catalog.assertCurrent();
    if (clinicalReviewRevision(db) !== basis)
      throw Error('Ownership source evidence changed during preparation');
  };
  const yieldStep = async (phase: IntakeWorkPhase) => {
    withIntakeWork(db, phase, () => recordIntakeWork('ownershipSnapshotYields'));
    await setImmediate();
    assertCurrent();
  };
  const publish = async (writer: ReportSnapshotMapWriter, phase: IntakeWorkPhase) => {
    assertCurrent();
    const total = accumulator(db, phase);
    let count = 0;
    for (const id of members(writer)) {
      total.add(id);
      if (++count % 64 === 0) await yieldStep(phase);
    }
    const reference: OwnershipSourceSnapshotReference = {
      format: 'health-ownership-source-snapshot-v1',
      source: binding,
      snapshotId: 'ownership:' + randomUUID(),
      ...total.finish(),
    };
    await writer.put('$meta', JSON.stringify(reference));
    await catalog.publish(reference.snapshotId, writer);
    return reference;
  };
  const prepareMembership = async (input: {
    previous?: OwnershipSourceSnapshotReference;
    sourceRecordIds: () => Iterable<string>;
  }) => {
    if (finished) throw Error('Ownership source snapshot preparation already finished');
    assertCurrent();
    if (input.previous && JSON.stringify(input.previous.source) !== JSON.stringify(binding))
      throw Error('Ownership source snapshot custodian changed');
    const previous = input.previous && open(catalog, input.previous),
      current = previous ? await catalog.forkReference(previous) : await catalog.fork(),
      before = previous ? members(previous) : [][Symbol.iterator](),
      after = sorted(input.sourceRecordIds()),
      phase: IntakeWorkPhase = previous ? 'warm' : 'reconstruction',
      oldHash = accumulator(db, phase);
    let old = before.next(),
      next = after.next(),
      pending: Array<{ key: string; value: string }> = [];
    let compared = 0;
    const flush = async () => {
      if (pending.length) {
        await current.putMany(pending);
        pending = [];
      }
    };
    while (!old.done || !next.done) {
      assertCurrent();
      withIntakeWork(db, phase, () => recordIntakeWork('ownershipSnapshotComparedIds'));
      if (++compared % 64 === 0) await yieldStep(phase);
      if (!old.done && (next.done || old.value < next.value)) {
        oldHash.add(old.value);
        await flush();
        await current.delete(key(old.value));
        withIntakeWork(db, phase, () => recordIntakeWork('ownershipSnapshotChangedIds'));
        old = before.next();
      } else if (!next.done && (old.done || next.value < old.value)) {
        pending.push({ key: key(next.value), value: next.value });
        withIntakeWork(db, phase, () => recordIntakeWork('ownershipSnapshotChangedIds'));
        if (pending.length === 16) await flush();
        next = after.next();
      } else {
        oldHash.add(old.value!);
        old = before.next();
        next = after.next();
      }
    }
    await flush();
    const prior = oldHash.finish();
    if (
      input.previous &&
      (prior.count !== input.previous.count || prior.digest !== input.previous.digest)
    )
      throw Error('Ownership prior source membership failed complete verification');
    return { current, phase };
  };
  return {
    assertCurrent,
    assertPublishedCurrent(reference: OwnershipSourceSnapshotReference) {
      if (!published || JSON.stringify(reference.source) !== JSON.stringify(binding))
        throw Error('Ownership source snapshot was not published by this preparation');
      options.assertRunning?.();
      if (clinicalReviewRevision(db) !== basis)
        throw Error('Ownership source evidence changed after publication');
      assertOwnershipSourceSnapshot(db, reference);
      options.assertRunning?.();
      if (clinicalReviewRevision(db) !== basis)
        throw Error('Ownership source evidence changed after publication');
    },
    async prepareMembership(input: {
      previous?: OwnershipSourceSnapshotReference;
      sourceRecordIds: () => Iterable<string>;
    }) {
      const { current, phase } = await prepareMembership(input);
      return publish(current, phase);
    },
    async prepareSplit(input: {
      previous?: OwnershipSourceSnapshotReference;
      sourceRecordIds: () => Iterable<string>;
      movingSourceRecordIds: () => Iterable<string>;
    }) {
      const { current, phase } = await prepareMembership(input);
      const moving = await catalog.fork();
      for (const id of sorted(input.movingSourceRecordIds())) {
        assertCurrent();
        if (current.get(key(id)) !== id)
          throw Error('Moving ownership source is outside selected membership');
        await moving.put(key(id), id);
        await current.delete(key(id));
        withIntakeWork(db, phase, () => recordIntakeWork('ownershipSnapshotChangedIds', 2));
      }
      return { moving: await publish(moving, phase), remaining: await publish(current, phase) };
    },
    async finishMaintenance() {
      const prepared = await this.finish();
      try {
        prepared.publishMaintenance();
      } finally {
        prepared.dispose();
      }
    },
    async finish() {
      if (finished) throw Error('Ownership source snapshot preparation already finished');
      finished = true;
      assertCurrent();
      const operationId = randomUUID(),
        changes = await catalog.finalChanges();
      const prepared = collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: version,
        changes,
      });
      let disposed = false;
      return {
        assertCurrent,
        apply() {
          if (disposed) throw Error('Disposed ownership source snapshots');
          assertCurrent();
          collections.stage(prepared);
        },
        publishMaintenance() {
          if (disposed) throw Error('Disposed ownership source snapshots');
          assertCurrent();
          collections.commitMaintenance(prepared);
          published = true;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          collections.disposePreparation(prepared);
        },
      };
    },
  };
}
export function readOwnershipSourceSnapshot(
  db: Database,
  reference: OwnershipSourceSnapshotReference,
  options: { after?: string; limit?: number; bytes?: number } = {},
) {
  const selected = selectedEnvelopeStore(db, { id: reference.source.intakeId });
  if (selected.identity.sourceHash !== reference.source.sourceHash)
    throw Error('Ownership source snapshot original changed');
  const catalog = createReportSnapshotCatalog(
      db,
      { id: reference.source.intakeId },
      {
        catalog: 'ownership.snapshots',
        catalogArea: 'builds',
      },
    ),
    reader = open(catalog, reference),
    page = reader.range({
      after: options.after ? key(options.after) : prefix,
      items: options.limit ?? 50,
      bytes: options.bytes ?? 32768,
    });
  const sourceRecordIds = page.items.map((item) => {
    if (typeof item.value !== 'string' || key(item.value) !== item.key)
      throw Error('Invalid ownership source snapshot member');
    return item.value;
  });
  if (page.count !== reference.count + 2) throw Error('Ownership snapshot member count disagrees');
  return {
    reference,
    sourceRecordIds,
    complete: page.complete,
    after: page.complete ? null : sourceRecordIds.at(-1)!,
    count: reference.count,
  };
}

/** Exact point membership in the immutable checked snapshot; its opaque members may be issue hashes. */
export function ownershipSourceSnapshotHas(
  db: Database,
  reference: OwnershipSourceSnapshotReference,
  id: string,
) {
  const selected = selectedEnvelopeStore(db, { id: reference.source.intakeId });
  if (selected.identity.sourceHash !== reference.source.sourceHash)
    throw Error('Ownership snapshot original changed');
  const catalog = createReportSnapshotCatalog(
    db,
    { id: reference.source.intakeId },
    { catalog: 'ownership.snapshots', catalogArea: 'builds' },
  );
  return open(catalog, reference).get(key(id)) === id;
}

/** Validate the exact immutable receipt target against its current authenticated source/catalog. */
export function assertOwnershipSourceSnapshot(
  db: Database,
  reference: OwnershipSourceSnapshotReference,
) {
  readOwnershipSourceSnapshot(db, reference, { limit: 1, bytes: 65536 });
}
