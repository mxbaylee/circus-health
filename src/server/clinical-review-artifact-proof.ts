import type { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { HttpError } from './database.ts';
import { intakeFileIdentity } from './intake-files.ts';
import type { VerifiedClinicalArtifact } from './intake-review-collection-session.ts';

/** Copies exact host-verified physical proofs into an already owned scratch.
 * It never adopts a newer filesystem baseline after an asynchronous gap. */
export function createClinicalReviewArtifactProof(sql: DatabaseSync, table: string) {
  if (!/^[a-z_]+$/.test(table)) throw Error('Invalid clinical artifact proof table');
  sql.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,path TEXT,identity TEXT,signature TEXT)`);
  const key = randomBytes(32),
    signature = (id: string, path: string, identity: string) =>
      createHmac('sha256', key)
        .update(JSON.stringify([id, path, identity]))
        .digest('hex'),
    previous = sql.prepare(`SELECT path,identity,signature FROM ${table} WHERE id=?`),
    insert = sql.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`);
  let count = 0;
  const changed = () =>
    new HttpError(
      409,
      'SOURCE_CHANGED',
      'Retained clinical evidence changed; prepare a fresh review',
    );
  return {
    retain(artifacts: Iterable<VerifiedClinicalArtifact>) {
      for (const artifact of artifacts) {
        const prior = previous.get(artifact.id),
          proof = signature(artifact.id, artifact.path, artifact.identity);
        if (prior) {
          if (
            prior.path !== artifact.path ||
            prior.identity !== artifact.identity ||
            prior.signature !== proof
          )
            throw changed();
        } else {
          insert.run(artifact.id, artifact.path, artifact.identity, proof);
          count++;
        }
      }
    },
    /** Restore only together with the caller's SQL savepoint rollback. */
    checkpoint() {
      const previousCount = count;
      return () => {
        count = previousCount;
      };
    },
    assertCurrent() {
      let seen = 0;
      for (const row of sql
        .prepare(`SELECT id,path,identity,signature FROM ${table} ORDER BY id`)
        .iterate()) {
        if (
          typeof row.id !== 'string' ||
          typeof row.path !== 'string' ||
          typeof row.identity !== 'string' ||
          row.signature !== signature(row.id, row.path, row.identity) ||
          intakeFileIdentity(row.path) !== row.identity
        )
          throw changed();
        seen++;
      }
      if (seen !== count) throw changed();
    },
  };
}
