import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac } from 'node:crypto';
import { parseIntakeReferencedEnvelope } from './intake-referenced-envelope-codec.ts';
import {
  intakeNamespace,
  parseIntakeCollectionHead,
  validateIntakeIdentity,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import type { DurableRecordVersion, RecordCommit } from './record-versions.ts';
import { intakeSourcePinKey } from './intake-source-pin-key.ts';

export interface RecordReplaySourcePairRequest {
  identity: IntakeStateIdentity;
  sourceVersionId: string;
}
export interface RecordReplaySourcePair {
  sourceVersionId: string;
  sourceDetails: string;
  sourceFacts: {
    sourceBytes: number;
    path: { bytes: number; hash: string };
    mimeType: { bytes: number; hash: string };
    mimePredicates: {
      pdf: boolean;
      image: boolean;
      previewableImage: boolean;
      packageMime: boolean;
      retainOnlyMime: 'retain' | 'readable' | 'filename';
    };
    providerId: { bytes: number; hash: string } | null;
  };
  headVersionId: string;
  headValue: string;
  recordSequence: number;
  latestSourceVersionId: string;
  currentVisibility: {
    versionId: string;
    version: number;
    archived: boolean;
    id: { bytes: number; hash: string };
    createdAt: { bytes: number; hash: string };
    actor: { bytes: number; hash: string };
  } | null;
  currentSourcePin:
    | {
        kind: 'value';
        versionId: string;
        version: number;
        value: { bytes: number; hash: string };
      }
    | {
        kind: 'deleted';
        versionId: string;
      }
    | null;
}
const versionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
export const recordReplaySourceFieldDigest = (value: string) => {
  const hash = createHash('sha256');
  let bytes = 0;
  for (let at = 0; at < value.length;) {
    let end = Math.min(at + 4096, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
    const part = value.slice(at, end);
    bytes += Buffer.byteLength(part);
    hash.update(part);
    at = end;
  }
  return { bytes, hash: hash.digest('hex') };
};
const recordReplayMimePredicates = (value: string) => {
  const prefix = (token: string) => value.slice(0, token.length).toLowerCase() === token;
  const exactMime = (token: string) =>
    prefix(token) && (value.length === token.length || value[token.length] === ';');
  const retainOnlyMime =
    prefix('audio/') || prefix('video/') || exactMime('application/dicom')
      ? 'retain'
      : [
            'application/pdf',
            'image/png',
            'image/jpeg',
            'image/webp',
            'application/zip',
            'application/json',
            'application/x-ndjson',
          ].some(exactMime)
        ? 'readable'
        : 'filename';
  return {
    pdf: value === 'application/pdf',
    image: value.startsWith('image/'),
    previewableImage: /^image\/(png|jpeg|webp|gif)$/.test(value),
    packageMime: /zip/i.test(value),
    retainOnlyMime,
  } as const;
};
const checkedFieldDigest = (value: unknown): value is { bytes: number; hash: string } =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === 'bytes,hash' &&
  Number.isSafeInteger((value as { bytes: unknown }).bytes) &&
  (value as { bytes: number }).bytes >= 0 &&
  typeof (value as { hash: unknown }).hash === 'string' &&
  /^[a-f0-9]{64}$/.test((value as { hash: string }).hash);

/** Transport syntax only. The original worker replay and read owner supply
 * authority; a copied pair or its signature cannot do so independently. */
export function checkedRecordReplaySourcePair(
  request: RecordReplaySourcePairRequest,
  value: unknown,
): RecordReplaySourcePair {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Accepted source pair reply missing');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
      'currentSourcePin,currentVisibility,headValue,headVersionId,latestSourceVersionId,recordSequence,sourceDetails,sourceFacts,sourceVersionId' ||
    !versionId(row.sourceVersionId) ||
    row.sourceVersionId !== request.sourceVersionId ||
    !versionId(row.latestSourceVersionId) ||
    !versionId(row.headVersionId) ||
    !Number.isSafeInteger(row.recordSequence) ||
    Number(row.recordSequence) < 1 ||
    typeof row.sourceDetails !== 'string' ||
    Buffer.byteLength(row.sourceDetails) > 8192 ||
    !row.sourceFacts ||
    typeof row.sourceFacts !== 'object' ||
    Array.isArray(row.sourceFacts) ||
    Object.keys(row.sourceFacts).sort().join(',') !==
      'mimePredicates,mimeType,path,providerId,sourceBytes' ||
    !Number.isSafeInteger((row.sourceFacts as { sourceBytes: unknown }).sourceBytes) ||
    (row.sourceFacts as { sourceBytes: number }).sourceBytes < 0 ||
    !checkedFieldDigest((row.sourceFacts as { mimeType: unknown }).mimeType) ||
    !checkedFieldDigest((row.sourceFacts as { path: unknown }).path) ||
    typeof (row.sourceFacts as { mimePredicates: unknown }).mimePredicates !== 'object' ||
    (row.sourceFacts as { mimePredicates: unknown }).mimePredicates === null ||
    Array.isArray((row.sourceFacts as { mimePredicates: unknown }).mimePredicates) ||
    Object.keys((row.sourceFacts as { mimePredicates: object }).mimePredicates)
      .sort()
      .join(',') !== 'image,packageMime,pdf,previewableImage,retainOnlyMime' ||
    ['image', 'packageMime', 'pdf', 'previewableImage'].some(
      (key) =>
        typeof (row.sourceFacts as { mimePredicates: Record<string, unknown> }).mimePredicates[
          key
        ] !== 'boolean',
    ) ||
    !['retain', 'readable', 'filename'].includes(
      (row.sourceFacts as { mimePredicates: { retainOnlyMime: string } }).mimePredicates
        .retainOnlyMime,
    ) ||
    ((row.sourceFacts as { providerId: unknown }).providerId !== null &&
      !checkedFieldDigest((row.sourceFacts as { providerId: unknown }).providerId)) ||
    typeof row.headValue !== 'string' ||
    Buffer.byteLength(row.headValue) > 4096
  )
    throw Error('Accepted source pair reply shape changed');
  const visibility = row.currentVisibility;
  if (
    visibility !== null &&
    (!visibility ||
      typeof visibility !== 'object' ||
      Array.isArray(visibility) ||
      Object.keys(visibility).sort().join(',') !==
        'actor,archived,createdAt,id,version,versionId' ||
      !versionId((visibility as { versionId: unknown }).versionId) ||
      !Number.isSafeInteger((visibility as { version: unknown }).version) ||
      (visibility as { version: number }).version < 1 ||
      typeof (visibility as { archived: unknown }).archived !== 'boolean' ||
      !checkedFieldDigest((visibility as { id: unknown }).id) ||
      !checkedFieldDigest((visibility as { createdAt: unknown }).createdAt) ||
      !checkedFieldDigest((visibility as { actor: unknown }).actor))
  )
    throw Error('Accepted source pair visibility shape changed');
  const sourcePin = row.currentSourcePin;
  if (
    sourcePin !== null &&
    (!sourcePin ||
      typeof sourcePin !== 'object' ||
      Array.isArray(sourcePin) ||
      !versionId((sourcePin as { versionId: unknown }).versionId) ||
      ((sourcePin as { kind?: unknown }).kind === 'deleted'
        ? Object.keys(sourcePin).sort().join(',') !== 'kind,versionId'
        : (sourcePin as { kind?: unknown }).kind !== 'value' ||
          Object.keys(sourcePin).sort().join(',') !== 'kind,value,version,versionId' ||
          !Number.isSafeInteger((sourcePin as { version: unknown }).version) ||
          (sourcePin as { version: number }).version < 1 ||
          !checkedFieldDigest((sourcePin as { value: unknown }).value)))
  )
    throw Error('Accepted source pair source pin shape changed');
  const identity = validateIntakeIdentity(request.identity),
    descriptor = parseIntakeReferencedEnvelope(row.sourceDetails),
    head = parseIntakeCollectionHead(row.headValue, identity);
  if (
    JSON.stringify(descriptor.intakeAuthority.identity) !== JSON.stringify(identity) ||
    !head ||
    head.storageSequence !== descriptor.intakeAuthority.storageSequence ||
    JSON.stringify(head.logical.root) !== JSON.stringify(descriptor.intakeAuthority.logicalRoot)
  )
    throw Error('Accepted source pair reply binding changed');
  const facts = row.sourceFacts as RecordReplaySourcePair['sourceFacts'];
  const visibilityFacts = visibility as RecordReplaySourcePair['currentVisibility'];
  const sourcePinFacts = sourcePin as RecordReplaySourcePair['currentSourcePin'];
  return Object.freeze({
    sourceVersionId: row.sourceVersionId,
    sourceDetails: row.sourceDetails,
    sourceFacts: Object.freeze({
      sourceBytes: facts.sourceBytes,
      path: Object.freeze({ ...facts.path }),
      mimeType: Object.freeze({ ...facts.mimeType }),
      mimePredicates: Object.freeze({ ...facts.mimePredicates }),
      providerId: facts.providerId ? Object.freeze({ ...facts.providerId }) : null,
    }),
    headVersionId: row.headVersionId,
    headValue: row.headValue,
    recordSequence: row.recordSequence as number,
    latestSourceVersionId: row.latestSourceVersionId,
    currentVisibility: visibilityFacts
      ? Object.freeze({
          ...visibilityFacts,
          id: Object.freeze({ ...visibilityFacts.id }),
          createdAt: Object.freeze({ ...visibilityFacts.createdAt }),
          actor: Object.freeze({ ...visibilityFacts.actor }),
        })
      : null,
    currentSourcePin: sourcePinFacts
      ? sourcePinFacts.kind === 'deleted'
        ? Object.freeze({ ...sourcePinFacts })
        : Object.freeze({
            ...sourcePinFacts,
            value: Object.freeze({ ...sourcePinFacts.value }),
          })
      : null,
  });
}

export function signRecordReplaySourcePair(
  key: Uint8Array,
  nonce: string,
  pair: RecordReplaySourcePair,
): string {
  return createHmac('sha256', key)
    .update(JSON.stringify([nonce, 'accepted-source-pair', pair]))
    .digest('hex');
}

/** Binds an optional source-pair selection, including a proven absence, to
 * the exact request and accepted HEAD that the backing worker verified. */
export function signRecordReplaySourcePairSelection(
  key: Uint8Array,
  nonce: string,
  request: RecordReplaySourcePairRequest,
  selectedHead: string,
  pair: RecordReplaySourcePair | null,
): string {
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        nonce,
        'optional-accepted-source-pair-selection',
        request.sourceVersionId,
        request.identity,
        selectedHead,
        pair,
      ]),
    )
    .digest('hex');
}
interface Candidate {
  source?: Pick<RecordReplaySourcePair, 'sourceVersionId' | 'sourceDetails' | 'sourceFacts'>;
  head?: Pick<RecordReplaySourcePair, 'headVersionId' | 'headValue'>;
}
interface Observer {
  sourceRecordId: string;
  headRecordId: string;
  sourcePinRecordId: string;
  identity: IntakeStateIdentity;
  sourceVersionId: string;
  candidate: Candidate;
  pair?: RecordReplaySourcePair;
  latestSourceVersionId?: string;
  currentVisibility: RecordReplaySourcePair['currentVisibility'];
  currentSourcePin: RecordReplaySourcePair['currentSourcePin'];
}
const scope = new AsyncLocalStorage<Observer>();

/** Observation only; this result becomes usable only after the private worker's
 * entire accepted replay and original physical verification have succeeded. */
export function withRecordReplaySourcePair<T>(
  request: RecordReplaySourcePairRequest,
  run: () => T,
): { value: T; pair: RecordReplaySourcePair } {
  const observed = withOptionalRecordReplaySourcePair(request, run);
  if (!observed.pair) throw Error('Accepted source pair absent from complete replay');
  return { value: observed.value, pair: observed.pair };
}

export function withOptionalRecordReplaySourcePair<T>(
  request: RecordReplaySourcePairRequest,
  run: () => T,
): { value: T; pair?: RecordReplaySourcePair } {
  const identity = validateIntakeIdentity(request.identity),
    sourceVersionId = request.sourceVersionId;
  if (!versionId(sourceVersionId)) throw Error('Accepted source pair version locator invalid');
  const observer: Observer = {
    sourceRecordId: JSON.stringify([identity.intakeId]),
    headRecordId: JSON.stringify([intakeNamespace(identity) + 'head']),
    sourcePinRecordId: JSON.stringify([intakeSourcePinKey(identity.intakeId)]),
    identity,
    sourceVersionId,
    candidate: {},
    currentVisibility: null,
    currentSourcePin: null,
  };
  const value = scope.run(observer, run);
  if (!observer.pair || !observer.latestSourceVersionId) return { value };
  return {
    value,
    pair: Object.freeze({
      ...observer.pair,
      latestSourceVersionId: observer.latestSourceVersionId,
      currentVisibility: observer.currentVisibility,
      currentSourcePin: observer.currentSourcePin,
    }),
  };
}

export function observeRecordReplayVersion(version: DurableRecordVersion): void {
  const observer = scope.getStore();
  if (!observer) return;
  if (version.entity === 'visibility_events' && version.deleted)
    throw Error('Accepted source visibility history deleted');
  if (
    version.entity === 'visibility_events' &&
    version.contents.target_type === 'source_file' &&
    version.contents.target_id === observer.identity.intakeId
  ) {
    const { id, archived, created_at: createdAt, actor } = version.contents;
    const ordinal = version.contents.version;
    if (
      version.deleted ||
      typeof id !== 'string' ||
      (archived !== 0 && archived !== 1) ||
      !Number.isSafeInteger(ordinal) ||
      (ordinal as number) < 1 ||
      typeof createdAt !== 'string' ||
      typeof actor !== 'string' ||
      (observer.currentVisibility && (ordinal as number) <= observer.currentVisibility.version)
    )
      throw Error('Accepted source visibility history changed');
    observer.currentVisibility = {
      versionId: version.versionId,
      version: ordinal as number,
      archived: archived === 1,
      id: recordReplaySourceFieldDigest(id),
      createdAt: recordReplaySourceFieldDigest(createdAt),
      actor: recordReplaySourceFieldDigest(actor),
    };
  }
  if (version.entity === 'app_meta' && version.recordId === observer.sourcePinRecordId) {
    if (version.deleted)
      observer.currentSourcePin = { kind: 'deleted', versionId: version.versionId };
    else {
      const raw = version.contents.value;
      if (typeof raw !== 'string') throw Error('Accepted source pin value changed');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw Error('Accepted source pin JSON changed');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw Error('Accepted source pin shape changed');
      const pin = parsed as Record<string, unknown>;
      if (
        (pin.revisionId !== null && typeof pin.revisionId !== 'string') ||
        (pin.dependencyToken !== null && typeof pin.dependencyToken !== 'string') ||
        typeof pin.requiresInterpretation !== 'boolean' ||
        !Number.isSafeInteger(pin.version) ||
        (pin.version as number) < 1
      )
        throw Error('Accepted source pin fields changed');
      observer.currentSourcePin = {
        kind: 'value',
        versionId: version.versionId,
        version: pin.version as number,
        value: recordReplaySourceFieldDigest(raw),
      };
    }
  }
  if (version.entity === 'source_files' && version.recordId === observer.sourceRecordId) {
    observer.latestSourceVersionId = version.versionId;
    if (version.versionId !== observer.sourceVersionId) return;
    if (observer.pair || observer.candidate.source || version.deleted)
      throw Error('Accepted source pair version repeated or deleted');
    const details = version.contents.details_json;
    if (
      typeof details === 'string' &&
      !details.startsWith('{"intakeAuthority":{"format":"health-intake-envelope-v3"')
    )
      return;
    if (
      typeof details !== 'string' ||
      Buffer.byteLength(details) > 8192 ||
      version.contents.id !== observer.identity.intakeId ||
      version.contents.sha256 !== observer.identity.sourceHash ||
      version.contents.kind !== 'intake_original'
    )
      throw Error('Accepted source pair source row differs');
    const descriptor = parseIntakeReferencedEnvelope(details);
    if (JSON.stringify(descriptor.intakeAuthority.identity) !== JSON.stringify(observer.identity))
      throw Error('Accepted source pair descriptor identity differs');
    const mimeType = version.contents.mime_type,
      path = version.contents.path,
      providerId = version.contents.provider_id,
      sourceBytes = version.contents.bytes;
    if (
      typeof mimeType !== 'string' ||
      typeof path !== 'string' ||
      (providerId !== null && typeof providerId !== 'string') ||
      !Number.isSafeInteger(sourceBytes) ||
      (sourceBytes as number) < 0
    )
      throw Error('Accepted source pair summary fields invalid');
    observer.candidate.source = {
      sourceVersionId: version.versionId,
      sourceDetails: details,
      sourceFacts: {
        sourceBytes: sourceBytes as number,
        path: recordReplaySourceFieldDigest(path),
        mimeType: recordReplaySourceFieldDigest(mimeType),
        mimePredicates: recordReplayMimePredicates(mimeType),
        providerId:
          providerId === null ? null : recordReplaySourceFieldDigest(providerId as string),
      },
    };
  }
  if (version.entity === 'app_meta' && version.recordId === observer.headRecordId) {
    if (observer.candidate.head || version.deleted)
      throw Error('Accepted source pair HEAD repeated or deleted');
    const headValue = version.contents.value;
    if (typeof headValue !== 'string' || Buffer.byteLength(headValue) > 4096)
      throw Error('Accepted source pair HEAD bytes invalid');
    observer.candidate.head = { headVersionId: version.versionId, headValue };
  }
}

export function completeRecordReplayCommit(commit: RecordCommit): void {
  const observer = scope.getStore();
  if (!observer) return;
  const { source, head } = observer.candidate;
  if (source) {
    if (!head || observer.pair) throw Error('Accepted source pair lacks same-transaction HEAD');
    const descriptor = parseIntakeReferencedEnvelope(source.sourceDetails),
      selected = parseIntakeCollectionHead(head.headValue, observer.identity);
    if (
      !selected ||
      selected.storageSequence !== descriptor.intakeAuthority.storageSequence ||
      JSON.stringify(selected.logical.root) !==
        JSON.stringify(descriptor.intakeAuthority.logicalRoot)
    )
      throw Error('Accepted source pair logical root differs');
    observer.pair = Object.freeze({
      ...source,
      ...head,
      recordSequence: commit.sequence,
      latestSourceVersionId: source.sourceVersionId,
      currentVisibility: observer.currentVisibility,
      currentSourcePin: observer.currentSourcePin,
    });
  }
  observer.candidate = {};
}
