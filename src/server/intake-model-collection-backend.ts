import { createHash } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  intakeEnvelopeFieldAccess,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { ModelIntakeSection } from './intake-model-context.ts';
import type {
  ModelFieldDescriptor,
  ModelIntakePinsV2,
  ModelIntakeSectionBackend,
} from './intake-model-context-v4.ts';

export interface ModelSectionManifest {
  format: 'health-intake-model-section-v2' | 'health-intake-model-section-v3';
  section: ModelIntakeSection;
  pins: ModelIntakePinsV2;
  collection: string;
  root: string;
  count: number;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const samePins = (left: ModelIntakePinsV2, right: ModelIntakePinsV2) =>
  left.sourceId === right.sourceId &&
  left.sourceHash === right.sourceHash &&
  left.logicalRoot === right.logicalRoot &&
  left.domainVersion === right.domainVersion &&
  left.version === right.version &&
  left.sourceTextPin === right.sourceTextPin &&
  left.mappingVersion === right.mappingVersion;

/** Current roots and mapping/source pins; neither receipts nor index build progress participate. */
export function collectionModelIntakePins(
  db: Database,
  source: IntakeEnvelopeSource,
  mappingVersion: string,
): ModelIntakePinsV2 {
  const view = openIntakeCollectionEnvelope(db, source);
  const version = intakeSourceVersion(db, source.id);
  const selected = selectedEnvelopeStore(db, source).source;
  if (!selected.sha256) throw Error('Model context source hash is unavailable');
  return {
    sourceId: selected.id,
    sourceHash: selected.sha256,
    logicalRoot: view.logical.root?.hash || '',
    domainVersion: view.logical.domainVersion,
    version: version.version,
    sourceTextPin: hash(version.sourcePin),
    mappingVersion,
  };
}

/**
 * Real selected collection backend. Manifests live at builds/model.sections;
 * each selects a completed immutable ordered sequence of bounded addresses.
 * Absent/stale manifests are pending, never empty or trusted SQL-only counts.
 */
export function openCollectionModelIntakeBackend(
  db: Database,
  source: IntakeEnvelopeSource,
  options: {
    mappingVersion: string;
    summary?: ModelIntakeSectionBackend['summary'];
    /** Checked virtual/package or external mapping section; undefined uses the selected index. */
    sectionProvider?: (
      section: ModelIntakeSection,
    ) =>
      Pick<ModelIntakeSectionBackend, 'section' | 'sectionPage' | 'externalFragment'> | undefined;
  },
): ModelIntakeSectionBackend {
  const view = openIntakeCollectionEnvelope(db, source);
  const fieldAccess = intakeEnvelopeFieldAccess(view);
  const { collections } = selectedEnvelopeStore(db, source);
  const pins = collectionModelIntakePins(db, source, options.mappingVersion);
  const recordRoot = (record: IntakeEnvelopeRecord) =>
    hash([pins.logicalRoot, view.address(record)]);
  const fieldRoot = (record: IntakeEnvelopeRecord, name: string, format?: 'field' | 'name') =>
    hash([pins.logicalRoot, view.address(record), format ? { format, key: name } : name]);
  function current() {
    // Also checks compact source metadata and stale logical view after auxiliary churn.
    view.address(view.root());
    return collections.openView();
  }
  function manifest(section: ModelIntakeSection): ModelSectionManifest | undefined {
    const selected = current();
    const raw = collections.get(selected, 'builds', 'model.sections', section);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw Error('Fragmented model section manifest');
    const value = JSON.parse(raw) as ModelSectionManifest;
    if (
      !['health-intake-model-section-v2', 'health-intake-model-section-v3'].includes(
        value.format,
      ) ||
      value.section !== section ||
      !value.pins ||
      !samePins(value.pins, pins)
    )
      return undefined;
    if (
      typeof value.collection !== 'string' ||
      !/^model\.[a-zA-Z0-9_.:-]{1,120}$/.test(value.collection) ||
      typeof value.root !== 'string' ||
      !Number.isSafeInteger(value.count) ||
      value.count < 0
    )
      throw Error('Invalid model section manifest');
    const descriptor = collections.collection(selected, 'builds', value.collection);
    if (
      (descriptor &&
        descriptor.kind !==
          (value.format === 'health-intake-model-section-v3' ? 'map' : 'sequence')) ||
      (descriptor?.root?.hash || '') !== value.root ||
      (descriptor?.root?.count || 0) !== value.count
    )
      throw Error('Model section manifest does not match its selected sequence');
    return value;
  }
  const backend: ModelIntakeSectionBackend = {
    pins,
    summary: options.summary || { state: 'pending', counts: null },
    section(section) {
      const external = options.sectionProvider?.(section);
      if (external) return external.section(section);
      const selected = manifest(section);
      return selected
        ? { state: 'complete', root: selected.root, count: selected.count }
        : { state: 'pending' };
    },
    externalFragment(section, key, paging) {
      current();
      const provider = options.sectionProvider?.(section);
      if (!provider?.externalFragment) throw Error('External model fragment scope is unavailable');
      return provider.externalFragment(section, key, paging);
    },
    sectionPage(section, paging) {
      const external = options.sectionProvider?.(section);
      if (external) return external.sectionPage(section, paging);
      const selected = manifest(section);
      if (!selected) throw Error('Model section index is incomplete or stale');
      const page = collections.range(current(), 'builds', selected.collection, paging);
      const entries = page.items.map(({ value }) => {
        if (typeof value !== 'string') throw Error('Model section address entry is fragmented');
        const entry = JSON.parse(value) as { tag: string; records: string[]; value?: unknown };
        if (
          typeof entry.tag !== 'string' ||
          entry.tag.length > 80 ||
          !Array.isArray(entry.records) ||
          entry.records.length > 3 ||
          entry.records.some((address) => typeof address !== 'string')
        )
          throw Error('Invalid model section address entry');
        return {
          tag: entry.tag,
          records: entry.records.map((address) => view.resolve(address)),
          ...(entry.value === undefined ? {} : { value: entry.value }),
        };
      });
      return { root: selected.root, entries, complete: page.complete, after: page.after };
    },
    address: view.address,
    resolve: view.resolve,
    recordRoot,
    fields(record, paging) {
      const info = view.info(record),
        root = recordRoot(record);
      if (info.shape === 'array') {
        if (paging.after) throw Error('Foreign synthetic model field cursor');
        return {
          root,
          fields: [
            {
              key: '$items',
              name: 'items',
              kind: 'children',
              count: info.count,
              root: fieldRoot(record, '$items'),
            },
          ],
          complete: true,
          after: null,
        };
      }
      const field = (name: string): ModelFieldDescriptor => {
        const child = view.child(record, name);
        if (child) return { name, key: name, kind: 'record', record: child };
        const value = view.field(record, name, { bytes: 4096 });
        if (value.kind === 'missing') throw Error('Selected model field disappeared');
        return value.kind === 'value'
          ? { name, key: name, kind: 'value', value: value.value }
          : {
              name,
              key: name,
              kind: 'fragment',
              bytes: value.bytes,
              root: fieldRoot(record, name),
            };
      };
      if (info.shape === 'scalar') {
        if (paging.after) throw Error('Foreign scalar model field cursor');
        return { root, fields: [field('value')], complete: true, after: null };
      }
      // One possibly fragmented field per read keeps names, values and cursor overhead bounded.
      const page = fieldAccess.descriptors(record, { ...paging, items: 1 });
      return {
        root,
        fields: page.fields.map((descriptor): ModelFieldDescriptor => {
          const common = {
            name: descriptor.name ?? null,
            key: descriptor.key,
            keyFormat: 'field' as const,
            ...(descriptor.name === undefined
              ? {
                  nameFragment: {
                    key: descriptor.key,
                    root: fieldRoot(record, descriptor.key, 'name'),
                    bytes: descriptor.nameBytes,
                  },
                }
              : {}),
          };
          const child = fieldAccess.child(record, descriptor.key);
          if (child) return { ...common, kind: 'record', record: child };
          const value = fieldAccess.value(record, descriptor.key, { bytes: 4096 });
          if (value.kind === 'missing') throw Error('Selected addressed model field disappeared');
          return value.kind === 'value'
            ? { ...common, kind: 'value', value: value.value }
            : {
                ...common,
                kind: 'fragment',
                bytes: value.bytes,
                root: fieldRoot(record, descriptor.key, 'field'),
              };
        }),
        complete: page.complete,
        after: page.after,
      };
    },
    children(record, name, paging) {
      if (paging.keyFormat)
        throw Error('Addressed field arrays require their selected record reference');
      const page =
        name === '$items' && view.info(record).shape === 'array'
          ? view.propertyRecords(record, paging)
          : view.children(record, name, paging);
      return { ...page, root: fieldRoot(record, name) };
    },
    fragment(record, name, paging) {
      if (paging.keyFormat === 'name') {
        const page = fieldAccess.nameFragment(record, name, paging);
        return {
          root: fieldRoot(record, name, 'name'),
          jsonText: page.text,
          totalBytes: fieldAccess.nameBytes(record, name),
          complete: page.complete,
          after: page.after,
        };
      }
      if (paging.keyFormat === 'field') {
        const description = fieldAccess.value(record, name, { bytes: 1 });
        if (description.kind === 'missing')
          throw Error('Selected addressed model fragment disappeared');
        const page = fieldAccess.valueFragment(record, name, paging);
        return {
          root: fieldRoot(record, name, 'field'),
          jsonText: page.text,
          totalBytes:
            description.kind === 'fragmented'
              ? description.bytes
              : Buffer.byteLength(JSON.stringify(description.value)),
          complete: page.complete,
          after: page.after,
        };
      }
      const description = view.field(record, name, { bytes: 1 });
      if (description.kind === 'missing') throw Error('Selected model fragment field is missing');
      const page = view.fieldFragment(record, name, paging);
      const totalBytes =
        description.kind === 'fragmented'
          ? description.bytes
          : Buffer.byteLength(JSON.stringify(description.value));
      return {
        root: fieldRoot(record, name),
        jsonText: page.text,
        totalBytes,
        complete: page.complete,
        after: page.after,
      };
    },
  };
  return backend;
}
