import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  createIntakeStateStorage,
  type IntakeCollectionChange,
  type IntakeCollectionDescriptor,
} from './intake-state-storage.ts';
import { COLLECTION_FORMAT, FORMAT, intakeNamespace } from './intake-state-evidence.ts';
import {
  PACKAGE_PROTOCOL_RECORD_BYTES,
  validPackageDescriptor,
  type PackageSourceBinding,
  type VerifiedPackageDescriptor,
  type PackageTraversalSummary,
} from './intake-package-protocol.ts';
import {
  buildPackageIndex,
  authorizeCheckedPackageMember,
  authorizePackageVerifiedPrefix,
} from './intake-package-index.ts';
import { withPackageSessionSource } from './intake-package-session.ts';
import { emptyPackageSourceVerificationWork } from './intake-package-source-lease.ts';
import { PackageInspectionError } from './intake-package-worker.ts';
import { packageMemberUnit } from './intake-plan.ts';
import { workflowHash } from './intake-workflow.ts';
import type { IntakePackageMember } from '../shared/intake.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const ordinalKey = (ordinal: number) => String(ordinal).padStart(16, '0');
const fail = (message: string): never => {
  throw new PackageInspectionError(message, 'PACKAGE_INCOMPLETE');
};
const suffixes = [
  'records',
  'manifests',
  'byId',
  'byUnit',
  'byName',
  'byContent',
  'contents',
] as const;
interface Manifest {
  recordHash: string;
  memberId: string;
  unitId: string;
  duplicateOf: string | null;
}
interface Inventory {
  format: 'health-package-inventory-v1';
  inventoryId: string;
  binding: PackageSourceBinding;
  summary: PackageTraversalSummary;
  uniqueByteContents: number;
  roots: Record<string, IntakeCollectionDescriptor | null>;
}
function checkedInventory(text: string, binding: PackageSourceBinding): Inventory {
  const value = JSON.parse(text) as Inventory;
  const integer = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (
    value.format !== 'health-package-inventory-v1' ||
    !/^[a-f0-9]{64}$/.test(value.inventoryId) ||
    JSON.stringify(value.binding) !== JSON.stringify(binding) ||
    !value.summary ||
    !integer(value.summary.entries) ||
    !integer(value.summary.members) ||
    !integer(value.summary.expandedBytes) ||
    value.summary.entries < value.summary.members ||
    !integer(value.uniqueByteContents) ||
    value.uniqueByteContents > value.summary.members ||
    !value.roots ||
    Object.keys(value.roots).length !== suffixes.length ||
    suffixes.some((suffix) => !Object.hasOwn(value.roots, suffix))
  )
    return fail('Complete inventory binding is invalid');
  for (const suffix of suffixes) {
    const root = value.roots[suffix];
    if (root !== null && (!root || root.kind !== 'map'))
      return fail('Complete inventory collection type is invalid');
    const expected = suffix === 'contents' ? value.uniqueByteContents : value.summary.members;
    if ((root?.root?.count ?? 0) !== expected)
      return fail('Complete inventory collection count is invalid');
  }
  return value;
}

/** Copy only a currently selected complete inventory after authenticating its
 * source collection pins. Public occurrence/plan IDs stay profile-independent;
 * accepted target node references and the profile binding are requalified. */
export function rebindCopiedPackageInventory({
  text,
  key,
  sourceBinding,
  targetProfileId,
  sourceCollection,
  rebindDescriptor,
}: {
  text: string;
  key: string;
  sourceBinding: PackageSourceBinding;
  targetProfileId: string;
  sourceCollection: (name: string) => IntakeCollectionDescriptor | null;
  rebindDescriptor: (descriptor: IntakeCollectionDescriptor) => IntakeCollectionDescriptor;
}): string {
  if (key !== sourceBinding.sourceHash || !targetProfileId)
    return fail('Copied inventory source is invalid');
  const value = checkedInventory(text, sourceBinding),
    roots: Inventory['roots'] = {};
  for (const suffix of suffixes) {
    const actual = sourceCollection(name(value.inventoryId, suffix));
    if (JSON.stringify(actual) !== JSON.stringify(value.roots[suffix]))
      return fail('Copied inventory collection pin changed');
    roots[suffix] = actual && rebindDescriptor(actual);
  }
  const result = { ...value, binding: { ...value.binding, profileId: targetProfileId }, roots };
  const encoded = JSON.stringify(result);
  checkedInventory(encoded, result.binding);
  return encoded;
}
export interface PackageStateContext {
  db: DatabaseSync;
  root: string;
  profileId: string;
  id: string;
  rawDomainVersion: number;
  assertRunning?: () => void;
}
/** Selected authority reads need no filesystem path; only builders open originals. */
export type PackageStateReadContext = Omit<PackageStateContext, 'root'> & { root?: string };
type Collections = ReturnType<typeof createIntakeStateStorage>['collections'];
const name = (id: string, suffix: string) => 'pkg.' + id + '.' + suffix;
const plain = (value: ReturnType<Collections['get']>): string | undefined => {
  if (value !== undefined && typeof value !== 'string')
    fail('Inventory index is not an inline value');
  return value as string | undefined;
};
function selectedSource(context: PackageStateReadContext): PackageSourceBinding {
  context.assertRunning?.();
  const row = context.db
    .prepare("SELECT sha256,bytes FROM source_files WHERE id=? AND kind='intake_original'")
    .get(context.id);
  if (!row || typeof row.sha256 !== 'string' || typeof row.bytes !== 'number')
    fail('Retained package source is missing');
  return {
    profileId: context.profileId,
    intakeId: context.id,
    sourceHash: row!.sha256 as string,
    bytes: row!.bytes as number,
  };
}
function open(context: PackageStateReadContext, binding = selectedSource(context)) {
  return createIntakeStateStorage(context.db, {
    profileId: binding.profileId,
    intakeId: binding.intakeId,
    sourceHash: binding.sourceHash,
  }).collections;
}
function readRecord(
  store: Collections,
  inventoryId: string,
  ordinal: number,
  onRead?: (bytes: number) => void,
): VerifiedPackageDescriptor {
  const value = store.get(
    store.openView(),
    'builds',
    name(inventoryId, 'records'),
    ordinalKey(ordinal),
  );
  if (value === undefined) return fail('Verified inventory ordinal is missing');
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    if (value.bytes > PACKAGE_PROTOCOL_RECORD_BYTES)
      return fail('Verified inventory record exceeds ZIP grammar bounds');
    const chunks: Buffer[] = [];
    let after: string | undefined;
    do {
      const page = store.readBytes(value, { after, items: 8, bytes: 32768 });
      chunks.push(...page.chunks);
      after = page.after ?? undefined;
      if (page.complete) break;
    } while (after);
    text = Buffer.concat(chunks).toString('utf8');
  }
  onRead?.(Buffer.byteLength(text));
  const descriptor: unknown = JSON.parse(text);
  if (
    !validPackageDescriptor(descriptor) ||
    descriptor.directory ||
    descriptor.ordinal !== ordinal ||
    !/^[a-f0-9]{64}$/.test((descriptor as VerifiedPackageDescriptor).sourceHash)
  )
    return fail('Verified inventory descriptor is invalid');
  return descriptor as VerifiedPackageDescriptor;
}
function publicMember(
  descriptor: VerifiedPackageDescriptor,
  manifest: Manifest,
): IntakePackageMember & {
  index: { kind: 'package_member'; sections: []; coverage: 'uninspected' };
} {
  return {
    ordinal: descriptor.ordinal,
    filename: descriptor.filename,
    bytes: descriptor.bytes,
    compressedBytes: descriptor.compressedBytes,
    sourceHash: descriptor.sourceHash,
    memberId: manifest.memberId,
    locator: 'ZIP member ' + descriptor.filename,
    duplicateOf: manifest.duplicateOf,
    index: { kind: 'package_member', sections: [], coverage: 'uninspected' },
  };
}

/** A selected complete inventory is independent of any plan. Incomplete attempt
 * collections are auxiliary checkpoints, never inventory or absence authority. */
export function readDurablePackageInventory(context: PackageStateReadContext) {
  const binding = selectedSource(context),
    store = open(context, binding);
  const format = context.db
    .prepare("SELECT json_extract(value,'$.format') AS format FROM app_meta WHERE key=?")
    .get(
      intakeNamespace({
        profileId: binding.profileId,
        intakeId: binding.intakeId,
        sourceHash: binding.sourceHash,
      }) + 'head',
    )?.format;
  if (format === FORMAT) return undefined;
  const view = store.openView();
  const raw = plain(store.get(view, 'builds', 'package.inventories', binding.sourceHash));
  if (!raw) return undefined;
  const inventory = checkedInventory(raw, binding);
  const assertAuthority = () => {
    context.assertRunning?.();
    if (JSON.stringify(selectedSource(context)) !== JSON.stringify(binding))
      fail('Complete inventory source changed');
    const current = store.openView();
    if (plain(store.get(current, 'builds', 'package.inventories', binding.sourceHash)) !== raw)
      fail('Complete inventory selection changed');
    for (const suffix of suffixes) {
      if (
        JSON.stringify(
          store.collection(current, 'builds', name(inventory.inventoryId, suffix)) ?? null,
        ) !== JSON.stringify(inventory.roots[suffix])
      )
        fail('Complete inventory collection changed');
    }
  };
  assertAuthority();
  const get = (ordinal: number) => {
    assertAuthority();
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= inventory.summary.members)
      return undefined;
    const text = plain(
      store.get(
        store.openView(),
        'builds',
        name(inventory.inventoryId, 'manifests'),
        ordinalKey(ordinal),
      ),
    );
    if (!text) return fail('Complete inventory manifest is missing');
    const manifest = JSON.parse(text) as Manifest;
    const descriptor = readRecord(store, inventory.inventoryId, ordinal);
    if (hash(JSON.stringify(descriptor)) !== manifest.recordHash)
      return fail('Complete inventory record hash changed');
    return { descriptor, manifest };
  };
  return {
    inventoryId: inventory.inventoryId,
    binding: Object.freeze({ ...binding }),
    summary: Object.freeze({ ...inventory.summary }),
    uniqueByteContents: inventory.uniqueByteContents,
    member(ordinal: number) {
      const value = get(ordinal);
      return value && publicMember(value.descriptor, value.manifest);
    },
    byId(memberId: string) {
      assertAuthority();
      const value = plain(
        store.get(store.openView(), 'builds', name(inventory.inventoryId, 'byId'), memberId),
      );
      return value === undefined ? undefined : this.member(Number(value));
    },
    byUnit(unitId: string) {
      assertAuthority();
      const value = plain(
        store.get(store.openView(), 'builds', name(inventory.inventoryId, 'byUnit'), unitId),
      );
      return value === undefined ? undefined : this.member(Number(value));
    },
    *range({ offset = 0, limit = 50 }: { offset?: number; limit?: number } = {}) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail('Invalid bounded inventory range');
      for (
        let ordinal = offset;
        ordinal < Math.min(inventory.summary.members, offset + limit);
        ordinal++
      )
        yield this.member(ordinal)!;
    },
    *matchesByExactName(filename: string) {
      const prefix = hash(filename) + ':';
      let after = prefix;
      while (true) {
        assertAuthority();
        const page = store.range(
          store.openView(),
          'builds',
          name(inventory.inventoryId, 'byName'),
          { after, items: 50, bytes: 32768 },
        );
        for (const candidate of page.items) {
          if (!candidate.key.startsWith(prefix)) return;
          if (typeof candidate.value !== 'string') return fail('Inventory name pointer is invalid');
          const member = this.member(Number(candidate.value));
          if (member?.filename === filename) yield member;
        }
        if (page.complete) return;
        after = page.after!;
      }
    },
    byExactName(filename: string) {
      const matches = this.matchesByExactName(filename);
      const first = matches.next().value;
      if (!matches.next().done) return fail('Exact package name has multiple occurrences');
      return first;
    },
    checkedMember(ordinal: number) {
      const value = get(ordinal);
      if (!value) return fail('Selected complete inventory member is missing');
      return authorizeCheckedPackageMember({
        binding,
        descriptor: value.descriptor,
        inventoryRoot: hash(raw),
        assertAuthority,
      });
    },
  };
}

/** Explicit new adapter; public package callers retain legacy safeguards until
 * their authority/consumer migration is complete. */
export async function buildDurablePackageInventory(
  context: PackageStateContext,
  {
    onProgress,
  }: {
    onProgress?: (work: {
      checkpoints: number;
      retainedRecords: number;
      reusedRecords: number;
      verifiedRecords: number;
    }) => void;
  } = {},
) {
  const binding = selectedSource(context),
    store = open(context, binding);
  const format = context.db
    .prepare("SELECT json_extract(value,'$.format') AS format FROM app_meta WHERE key=?")
    .get(
      intakeNamespace({
        profileId: binding.profileId,
        intakeId: binding.intakeId,
        sourceHash: binding.sourceHash,
      }) + 'head',
    )?.format;
  if (format === FORMAT) {
    const operationId = randomUUID();
    store.commitMaintenance(
      store.prepareLegacyBridge({
        operationId,
        requestDigest: hash(operationId),
        domainVersion: context.rawDomainVersion,
      }),
    );
  } else if (format !== COLLECTION_FORMAT)
    fail('Package inventory requires initialized intake authority');
  const existing = readDurablePackageInventory(context);
  if (existing)
    return {
      inventory: existing,
      reused: true,
      work: {
        checkpoints: 0,
        retainedRecords: existing.summary.members,
        reusedRecords: existing.summary.members,
        verifiedRecords: 0,
        checkpointEdits: 0,
        checkpointEncodedBytes: 0,
        peakCheckpointEdits: 0,
        peakCheckpointEncodedBytes: 0,
        prefixDescriptorReadBytes: 0,
        prefixDescriptorHashBytes: 0,
      },
      traversalWork: undefined,
      sourceVerificationWork: emptyPackageSourceVerificationWork(),
      spoolWork: undefined,
    };
  let current = store.openView();
  const attemptText = plain(store.get(current, 'builds', 'package.attempts', binding.sourceHash));
  const inventoryId = attemptText ?? hash(randomUUID());
  if (!/^[a-f0-9]{64}$/.test(inventoryId)) return fail('Retained inventory attempt is invalid');
  const work = {
    checkpoints: 0,
    retainedRecords:
      store.collection(current, 'builds', name(inventoryId, 'manifests'))?.root?.count ?? 0,
    reusedRecords: 0,
    verifiedRecords: 0,
    checkpointEdits: 0,
    checkpointEncodedBytes: 0,
    peakCheckpointEdits: 0,
    peakCheckpointEncodedBytes: 0,
    prefixDescriptorReadBytes: 0,
    prefixDescriptorHashBytes: 0,
  };
  const pending = new Map<string, IntakeCollectionChange>();
  let group: IntakeCollectionChange[] | undefined;
  let pendingBytes = 0;
  const flush = () => {
    if (!pending.size) return;
    context.assertRunning?.();
    const view = store.openView(),
      operationId = randomUUID();
    const version = store.binding(view)!.logical.domainVersion;
    const changes = [...pending.values()];
    const prepared = store.prepare(view, {
      operationId,
      requestDigest: hash(JSON.stringify(changes)),
      domainVersion: version,
      changes,
    });
    store.commitMaintenance(prepared);
    work.checkpointEdits += changes.length;
    work.checkpointEncodedBytes += pendingBytes;
    work.peakCheckpointEdits = Math.max(work.peakCheckpointEdits, changes.length);
    work.peakCheckpointEncodedBytes = Math.max(work.peakCheckpointEncodedBytes, pendingBytes);
    pending.clear();
    pendingBytes = 0;
    work.checkpoints++;
    onProgress?.({ ...work });
    context.assertRunning?.();
  };
  const add = (change: IntakeCollectionChange) => {
    if (group) {
      group.push(change);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(change));
    if (pending.size >= 60 || pendingBytes + bytes > 32768) flush();
    const key = change.collection + ':' + ('key' in change ? change.key : randomUUID());
    const old = pending.get(key);
    if (old) pendingBytes -= Buffer.byteLength(JSON.stringify(old));
    pending.set(key, change);
    pendingBytes += bytes;
  };
  const put = (suffix: string, key: string, value: string) =>
    add({ area: 'builds', collection: name(inventoryId, suffix), op: 'put', key, value });
  const lookup = (suffix: string, key: string) => {
    const edit = pending.get(name(inventoryId, suffix) + ':' + key);
    if (edit?.op === 'put') return edit.value;
    return plain(store.get(store.openView(), 'builds', name(inventoryId, suffix), key));
  };
  if (!attemptText) {
    add({
      area: 'builds',
      collection: 'package.attempts',
      op: 'put',
      key: binding.sourceHash,
      value: inventoryId,
    });
    flush();
  }
  let ordinal = -1,
    offset = 0,
    recordHash = '',
    skip = false;
  let pieces: Buffer[] = [];
  let chunkCollection = '',
    storedChunks = 0;
  let sourceVerificationWork = emptyPackageSourceVerificationWork();
  const prefixPins = Object.fromEntries(
    ['records', 'manifests'].map((suffix) => [
      suffix,
      store.collection(store.openView(), 'builds', name(inventoryId, suffix)) ?? null,
    ]),
  );
  const assertPrefix = () => {
    context.assertRunning?.();
    if (
      JSON.stringify(selectedSource(context)) !== JSON.stringify(binding) ||
      plain(store.get(store.openView(), 'builds', 'package.attempts', binding.sourceHash)) !==
        inventoryId
    )
      fail('Retained inventory prefix source or attempt changed');
    for (const suffix of ['records', 'manifests'])
      if (
        JSON.stringify(
          store.collection(store.openView(), 'builds', name(inventoryId, suffix)) ?? null,
        ) !== JSON.stringify(prefixPins[suffix])
      )
        fail('Retained inventory prefix root changed');
  };
  const verifiedPrefix = work.retainedRecords
    ? authorizePackageVerifiedPrefix({
        binding,
        count: work.retainedRecords,
        assertAuthority: assertPrefix,
        read: (ordinal) => {
          assertPrefix();
          const text = plain(
            store.get(
              store.openView(),
              'builds',
              name(inventoryId, 'manifests'),
              ordinalKey(ordinal),
            ),
          );
          if (!text) return fail('Retained verified prefix has a missing ordinal');
          const manifest: Manifest = JSON.parse(text);
          const descriptor = readRecord(store, inventoryId, ordinal, (bytes) => {
            work.prefixDescriptorReadBytes += bytes;
          });
          const canonical = JSON.stringify(descriptor);
          work.prefixDescriptorHashBytes += Buffer.byteLength(canonical);
          if (manifest.recordHash !== hash(canonical))
            throw new PackageInspectionError(
              'Retained verified prefix descriptor digest changed',
              'PACKAGE_PREFIX_CHANGED',
              descriptor.filename,
              ordinal,
            );
          return descriptor;
        },
      })
    : undefined;
  const result = await withPackageSessionSource(context, (lease) => {
    sourceVerificationWork = { ...lease.verificationWork };
    return buildPackageIndex({
      lease,
      scratchRoot: context.root,
      verifiedPrefix,
      onVerifiedBatch: async (batch) => {
        batch.assertRunning();
        for (const chunk of batch.chunks) {
          if (chunk.offset === 0) {
            if (pieces.length || offset) fail('Inventory metadata record interleaved');
            ordinal = chunk.ordinal;
            recordHash = chunk.recordHash;
            const existingManifest = lookup('manifests', ordinalKey(ordinal));
            skip = existingManifest !== undefined;
            if (skip && (JSON.parse(existingManifest!) as Manifest).recordHash !== recordHash)
              fail('Retained inventory prefix differs from verified source');
            chunkCollection = name(inventoryId, 'bytes.' + ordinalKey(ordinal));
            storedChunks =
              store.collection(store.openView(), 'builds', chunkCollection)?.root?.count ?? 0;
          }
          if (
            chunk.ordinal !== ordinal ||
            chunk.offset !== offset ||
            chunk.recordHash !== recordHash
          )
            fail('Inventory metadata continuation changed');
          offset += chunk.data.length;
          if (offset > PACKAGE_PROTOCOL_RECORD_BYTES)
            fail('Inventory record exceeds ZIP grammar bounds');
          if (!skip) {
            pieces.push(Buffer.from(chunk.data));
            // A one-chunk value fits inline; larger legal values attach immutable
            // per-record bytes. Resume compares every retained chunk exactly.
            if (!(chunk.offset === 0 && chunk.last && chunk.data.length <= 3072)) {
              const index = chunk.offset / 4096;
              if (!Number.isInteger(index)) fail('Inventory chunk offset is invalid');
              if (index < storedChunks) {
                const old = plain(
                  store.get(store.openView(), 'builds', chunkCollection, ordinalKey(index)),
                );
                if (old !== Buffer.from(chunk.data).toString('base64'))
                  fail('Retained partial metadata differs from verified source');
              } else
                add({
                  area: 'builds',
                  collection: chunkCollection,
                  op: 'appendBytes',
                  bytes: chunk.data,
                });
            }
          }
          if (chunk.last) {
            if (skip) work.reusedRecords++;
            else {
              const bytes = Buffer.concat(pieces),
                descriptor = JSON.parse(bytes.toString()) as VerifiedPackageDescriptor;
              if (
                !validPackageDescriptor(descriptor) ||
                descriptor.ordinal !== ordinal ||
                descriptor.directory ||
                hash(bytes) !== recordHash
              )
                fail('Verified metadata record is invalid');
              const memberId =
                'member:' + workflowHash([binding.intakeId, ordinal, descriptor.filename]);
              const firstText = lookup('contents', descriptor.sourceHash);
              const first = firstText
                ? (JSON.parse(firstText) as { memberId: string; ordinal: number; count: number })
                : { memberId, ordinal, count: 0 };
              if (descriptor.duplicateOrdinal !== (first.count ? first.ordinal : null))
                fail('Verified duplicate occurrence differs from retained inventory');
              const duplicateOf = first.count ? first.memberId : null;
              const member = publicMember(descriptor, {
                memberId,
                duplicateOf,
                recordHash,
                unitId: '',
              });
              const manifest: Manifest = {
                recordHash,
                memberId,
                unitId: packageMemberUnit(member).id,
                duplicateOf,
              };
              const key = ordinalKey(ordinal);
              group = [];
              if (bytes.length <= 3072) put('records', key, bytes.toString());
              else
                add({
                  area: 'builds',
                  collection: name(inventoryId, 'records'),
                  op: 'putBytes',
                  key,
                  fromArea: 'builds',
                  fromCollection: chunkCollection,
                });
              put('manifests', key, JSON.stringify(manifest));
              put('byId', memberId, String(ordinal));
              put('byUnit', manifest.unitId, String(ordinal));
              put('byName', hash(descriptor.filename) + ':' + key, String(ordinal));
              put('byContent', descriptor.sourceHash + ':' + key, String(ordinal));
              put(
                'contents',
                descriptor.sourceHash,
                JSON.stringify({ ...first, count: first.count + 1 }),
              );
              const changes = group;
              group = undefined;
              if (
                pending.size + changes.length > 60 ||
                pendingBytes +
                  changes.reduce(
                    (total, edit) => total + Buffer.byteLength(JSON.stringify(edit)),
                    0,
                  ) >
                  32768
              )
                flush();
              for (const change of changes) add(change);
              work.verifiedRecords++;
            }
            pieces = [];
            offset = 0;
          }
        }
        // Checkpoint partial records before ACK. Completed small records are batched
        // until the byte/edit budget or final clean completion requires a flush.
        if (pieces.length) flush();
        batch.assertRunning();
      },
    });
  });
  try {
    if (offset || pieces.length) fail('Inventory ended with partial metadata');
    flush();
    current = store.openView();
    const roots: Inventory['roots'] = {};
    for (const suffix of suffixes)
      roots[suffix] = store.collection(current, 'builds', name(inventoryId, suffix)) ?? null;
    if (
      (roots.manifests?.root?.count ?? 0) !== result.summary.members ||
      (roots.records?.root?.count ?? 0) !== result.summary.members ||
      work.verifiedRecords + work.reusedRecords !== result.summary.members
    )
      fail('Complete inventory counts disagree');
    const inventory: Inventory = {
      format: 'health-package-inventory-v1',
      inventoryId,
      binding,
      summary: result.summary,
      uniqueByteContents: roots.contents?.root?.count ?? 0,
      roots,
    };
    add({
      area: 'builds',
      collection: 'package.inventories',
      op: 'put',
      key: binding.sourceHash,
      value: JSON.stringify(inventory),
    });
    flush();
    return {
      inventory: readDurablePackageInventory(context)!,
      reused: false,
      work: { ...work },
      traversalWork: result.work,
      sourceVerificationWork,
      spoolWork: { ...result.io },
    };
  } finally {
    result.close();
  }
}
