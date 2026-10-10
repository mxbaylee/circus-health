import { createHash } from 'node:crypto';
import type { Database } from './database.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import { readDirectPlanScope } from './intake-direct-plan.ts';
import type { ModelIntakeSectionBackend } from './intake-model-context-v4.ts';

/** Direct recipe units have an exact ordinal inventory, without stored unit rows. */
export function openImplicitDirectModelUnits(db: Database, profileId: string, id: string) {
  const view = openIntakeCollectionEnvelope(db, { id });
  const collections = selectedEnvelopeStore(db, { id }).collections;
  if (
    collections.get(collections.openView(), 'logical', 'direct.selection', 'active') === undefined
  )
    return undefined;
  const scope = readDirectPlanScope(db, profileId, id);
  if (!scope) return undefined;
  const selected = view.resolve(scope.reader.address(scope.record));
  const root = createHash('sha256')
    .update(
      JSON.stringify([
        'health-intake-model-direct-units-v1',
        view.logical,
        view.address(selected),
        scope.plan,
      ]),
    )
    .digest('hex');
  const current = () => {
    view.address(selected);
    scope.assertCurrent();
  };
  const unitJSON = (ordinal: number) => {
    const unit = scope.unitAt(ordinal);
    if (!unit) throw Error('Direct recipe unit is unavailable');
    const text = JSON.stringify(unit);
    return { text, root: createHash('sha256').update(text).digest('hex'), unit };
  };
  const provider: Pick<ModelIntakeSectionBackend, 'section' | 'sectionPage' | 'externalFragment'> =
    {
      section(section) {
        if (section !== 'units') throw Error('Wrong direct unit section');
        current();
        return { state: 'complete', root, count: scope.unitCount };
      },
      sectionPage(section, options) {
        if (section !== 'units') throw Error('Wrong direct unit section');
        current();
        const offset = options.after === undefined ? 0 : Number(options.after);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > scope.unitCount ||
          (options.after !== undefined && String(offset) !== options.after) ||
          !Number.isSafeInteger(options.items) ||
          options.items < 1 ||
          options.items > 8 ||
          !Number.isSafeInteger(options.bytes) ||
          options.bytes < 2048
        )
          throw Error('Invalid direct unit page');
        const entries: ReturnType<ModelIntakeSectionBackend['sectionPage']>['entries'] = [];
        let next = offset,
          bytes = 0;
        while (next < scope.unitCount && entries.length < options.items) {
          const data = unitJSON(next),
            unit = data.unit;
          const source = scope.metadataPage(next, 'sourceIndex', { bytes: 4096 });
          const headings = unit.sharedHeadings
            ? scope.metadataPage(next, 'sharedHeadings', { bytes: 4096 })
            : undefined;
          const entry = {
            tag: 'implicit_unit',
            records: [],
            value: {
              ...unit.metadata,
              id: unit.id,
              kind: unit.kind,
              status: unit.status,
              sourceFileId: id,
              attemptCount: unit.attemptCount,
            },
            externalValues: {
              unit: { key: 'unit:' + next, bytes: Buffer.byteLength(data.text), root: data.root },
              sourceIndex: {
                key: 'sourceIndex:' + next,
                bytes: source.totalBytes,
                root: source.valueRoot,
              },
              ...(headings
                ? {
                    sharedHeadings: {
                      key: 'sharedHeadings:' + next,
                      bytes: headings.totalBytes,
                      root: headings.valueRoot,
                    },
                  }
                : {}),
            },
          };
          // The public response expands each reference into a pinned cursor.
          const cost =
            Buffer.byteLength(JSON.stringify(entry)) +
            Object.keys(entry.externalValues).length * 1536;
          if (bytes + cost > options.bytes) break;
          entries.push(entry);
          bytes += cost;
          next++;
        }
        if (!entries.length && next < scope.unitCount)
          throw Error('Direct unit reference exceeds page budget');
        return {
          root,
          entries,
          complete: next === scope.unitCount,
          after: next === scope.unitCount ? null : String(next),
        };
      },
      externalFragment(section, key, options) {
        if (section !== 'units') throw Error('Wrong direct unit fragment section');
        current();
        const match = /^(unit|sourceIndex|sharedHeadings):(0|[1-9][0-9]*)$/.exec(key);
        if (!match) throw Error('Invalid direct unit fragment identity');
        const ordinal = Number(match[2]);
        if (!Number.isSafeInteger(ordinal) || ordinal >= scope.unitCount)
          throw Error('Invalid direct unit ordinal');
        if (match[1] !== 'unit') {
          const page = scope.metadataPage(
            ordinal,
            match[1] as 'sourceIndex' | 'sharedHeadings',
            options,
          );
          return {
            root: page.valueRoot,
            jsonText: page.text,
            totalBytes: page.totalBytes,
            complete: page.complete,
            after: page.nextCursor,
          };
        }
        const data = unitJSON(ordinal),
          bytes = Buffer.from(data.text),
          prefix = data.root + ':';
        if (options.after && !options.after.startsWith(prefix))
          throw Error('Direct unit metadata changed');
        const offset = options.after === undefined ? 0 : Number(options.after.slice(prefix.length));
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > bytes.length ||
          (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)
        )
          throw Error('Invalid direct unit metadata offset');
        let end = Math.min(bytes.length, offset + options.bytes);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        if (end === offset && offset < bytes.length)
          throw Error('Direct unit metadata budget cannot fit a character');
        return {
          root: data.root,
          jsonText: bytes.subarray(offset, end).toString('utf8'),
          totalBytes: bytes.length,
          complete: end === bytes.length,
          after: end === bytes.length ? null : prefix + end,
        };
      },
    };
  return { sectionProvider: (section: string) => (section === 'units' ? provider : undefined) };
}
