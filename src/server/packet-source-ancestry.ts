import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import { iterateIntakeSourceAncestry } from './intake-source-ancestry.ts';
import { disposableSqlite } from './disposable-sqlite.ts';

/** Complete retained original/proposal ancestry. The temporary queue is an index,
 * never authority; original edges use the shared checked, uncapped walk. */
export function* packetSourceAncestry(db: Database, ids: Iterable<string>) {
  for (const step of packetSourceAncestryWork(db, ids)) if (step) yield step;
}
export function* packetSourceAncestryWork(db: Database, ids: Iterable<string>) {
  const profileId = String(
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value || '',
    ),
    scratch = disposableSqlite('circus-packet-ancestry-');
  try {
    scratch.db.exec('CREATE TABLE files(id TEXT PRIMARY KEY,seen INTEGER NOT NULL DEFAULT 0)');
    const enqueue = scratch.db.prepare('INSERT OR IGNORE INTO files(id) VALUES(?)'),
      seen = scratch.db.prepare('UPDATE files SET seen=1 WHERE id=?');
    const row = (id: string) => {
      const value = db
        .prepare(
          "SELECT id,kind,sha256,json_extract(details_json,'$.originalSourceFileId') original,json_extract(details_json,'$.intake.parentSourceFileId') parent FROM source_files WHERE id=?",
        )
        .get(id);
      if (!value)
        throw new HttpError(
          409,
          'EXPORT_SOURCE_MISSING',
          'Retained source ancestry is unavailable.',
        );
      return value;
    };
    let work = 0;
    for (const id of ids) {
      enqueue.run(id);
      if (++work % 64 === 0) yield undefined;
    }
    for (;;) {
      const next = scratch.db
        .prepare('SELECT id FROM files WHERE seen=0 ORDER BY id LIMIT 1')
        .get();
      if (!next) return;
      const id = String(next.id),
        source = row(id);
      if (source.kind === 'intake_original') {
        for (const ancestor of iterateIntakeSourceAncestry(db, profileId, id)) {
          if (++work % 64 === 0) yield undefined;
          const file = row(ancestor.id),
            prior = scratch.db.prepare('SELECT seen FROM files WHERE id=?').get(ancestor.id);
          // A completed earlier walk already checked the remaining chain. A
          // merely visited edge is insufficient: it could be this walk's cycle.
          if (prior?.seen === 2) break;
          enqueue.run(ancestor.id);
          seen.run(ancestor.id);
          if (typeof file.original === 'string') enqueue.run(file.original);
          if (!prior?.seen)
            yield {
              id: ancestor.id,
              hash: file.sha256 ? String(file.sha256) : null,
              kind: String(file.kind),
            };
        }
        scratch.db.exec('UPDATE files SET seen=2 WHERE seen=1');
      } else {
        if (++work % 64 === 0) yield undefined;
        seen.run(id);
        if (typeof source.original === 'string') enqueue.run(source.original);
        if (typeof source.parent === 'string') enqueue.run(source.parent);
        scratch.db.prepare('UPDATE files SET seen=2 WHERE id=?').run(id);
        yield { id, hash: source.sha256 ? String(source.sha256) : null, kind: String(source.kind) };
      }
    }
  } finally {
    scratch.close();
  }
}
