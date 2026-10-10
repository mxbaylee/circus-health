import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import { packetSourceAncestry } from './packet-source-ancestry.ts';
import { disposableSqlite } from './disposable-sqlite.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A targeted reachability proof retains identities in private SQL, not one
 * person's growing source/asset/dependency arrays. All edges are retained facts. */
export function packetSourcesReachFile(
  db: Database,
  target: string,
  sources: Iterable<string>,
  files: Iterable<string>,
): boolean {
  const scratch = disposableSqlite('circus-packet-membership-');
  try {
    scratch.db.exec(
      "CREATE TABLE sources(id TEXT,provider TEXT NOT NULL DEFAULT '',seen INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,provider));CREATE TABLE files(id TEXT PRIMARY KEY,seen INTEGER NOT NULL DEFAULT 0)",
    );
    const enqueueSource = scratch.db.prepare(
        'INSERT OR IGNORE INTO sources(id,provider) VALUES(?,?)',
      ),
      enqueueFile = scratch.db.prepare('INSERT OR IGNORE INTO files(id) VALUES(?)');
    for (const file of files) enqueueFile.run(file);
    for (const source of sources) enqueueSource.run(source, '');
    for (;;) {
      const next = scratch.db
        .prepare('SELECT id,provider FROM sources WHERE seen=0 ORDER BY id,provider LIMIT 1')
        .get();
      if (!next) break;
      const id = String(next.id),
        row = db
          .prepare(
            'SELECT source_file_id,locator_json,provider_id,raw_json,kind FROM source_records WHERE id=?',
          )
          .get(id);
      if (!row)
        throw new HttpError(
          409,
          'EXPORT_SOURCE_MISSING',
          'Retained source context is unavailable.',
        );
      const envelope: unknown = JSON.parse(String(row.raw_json || '{}'));
      if (
        next.provider &&
        (row.provider_id !== next.provider || !object(envelope) || !Object.hasOwn(envelope, 'data'))
      )
        throw new HttpError(
          409,
          'INVALID_ARCHIVE_REFERENCE',
          'Retained archive context must identify a same-provider data envelope.',
        );
      scratch.db
        .prepare('UPDATE sources SET seen=1 WHERE id=? AND provider=?')
        .run(id, String(next.provider));
      enqueueFile.run(String(row.source_file_id));
      const locator: unknown = JSON.parse(String(row.locator_json || '{}'));
      if (object(locator) && typeof locator.originalSourceFileId === 'string')
        enqueueFile.run(locator.originalSourceFileId);
      const pool =
        typeof row.provider_id === 'string' && id.startsWith(row.provider_id + ':')
          ? id.slice(row.provider_id.length + 1).split(':')[0]
          : null;
      const nodes: unknown[] = object(envelope)
        ? row.kind === 'source_capture'
          ? [envelope.content]
          : pool === 'context'
            ? [envelope.data]
            : []
        : [];
      // A retained raw context is still subject to its existing byte admission.
      // Iterate each object's children without a fan-out-sized traversal stack.
      function* references(node: unknown): Generator<string> {
        function* children(value: Record<string, unknown>) {
          for (const key in value) if (Object.hasOwn(value, key)) yield value[key];
        }
        const stack: Iterator<unknown>[] = [[node][Symbol.iterator]()];
        let count = 0;
        while (stack.length) {
          const next = stack.at(-1)!.next();
          if (next.done) {
            stack.pop();
            continue;
          }
          if (++count > 1000000)
            throw new HttpError(
              400,
              'INVALID_PACKET_SELECTION',
              'Source context exceeds the packet limit.',
            );
          const selected = next.value;
          if (Array.isArray(selected)) {
            stack.push(selected[Symbol.iterator]());
            continue;
          }
          if (!object(selected)) continue;
          let keys = 0;
          for (const key in selected) if (Object.hasOwn(selected, key) && ++keys > 1) break;
          if (keys === 1 && Object.hasOwn(selected, '$health_archive_ref')) {
            const reference = selected.$health_archive_ref;
            if (
              typeof reference !== 'string' ||
              !/^(records:r\d+|context:c\d+|text:t\d+)$/.test(reference) ||
              typeof row!.provider_id !== 'string'
            )
              throw new HttpError(
                409,
                'INVALID_ARCHIVE_REFERENCE',
                'Invalid retained archive context reference.',
              );
            yield row!.provider_id + ':' + reference;
          } else stack.push(children(selected));
        }
      }
      for (const node of nodes)
        for (const ref of references(node)) enqueueSource.run(ref, String(row.provider_id));
      for (const relation of db
        .prepare(
          "SELECT from_record_id,to_record_id FROM record_relationships WHERE status='accepted' AND (from_record_id=? OR to_record_id=?)",
        )
        .iterate(id, id))
        enqueueSource.run(
          String(relation.from_record_id === id ? relation.to_record_id : relation.from_record_id),
          '',
        );
    }
    function* retainedFiles() {
      for (const row of scratch.db.prepare('SELECT id FROM files ORDER BY id').iterate())
        yield String(row.id);
    }
    for (const file of packetSourceAncestry(db, retainedFiles()))
      if (file.id === target) return true;
    return false;
  } finally {
    scratch.close();
  }
}
