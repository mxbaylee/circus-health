import type { DatabaseSync } from 'node:sqlite';
import { createHmac, createSecretKey, randomBytes } from 'node:crypto';
import { HttpError } from './database.ts';
import { intakeFileIdentity } from './intake-files.ts';
import {
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
} from './clinical-review-physical-epoch.ts';
import { openClinicalPhysicalVerifier } from './clinical-review-physical-worker.ts';
import type { VerifiedClinicalArtifact } from './intake-review-collection-session.ts';

/** Copies exact host-verified physical proofs into an already owned scratch.
 * It never adopts a newer filesystem baseline after an asynchronous gap. */
export function createClinicalReviewArtifactProof(sql: DatabaseSync, table: string) {
  if (!/^[a-z_]+$/.test(table)) throw Error('Invalid clinical artifact proof table');
  sql.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,path TEXT,identity TEXT,signature TEXT)`);
  const key = createSecretKey(randomBytes(32)),
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
  const scratchWitness = () => {
    if (!sql.isOpen) throw changed();
    return [
      sql.prepare('SELECT total_changes() changes').get()!.changes,
      sql.prepare('PRAGMA main.schema_version').get()!.schema_version,
      sql.prepare('PRAGMA temp.schema_version').get()!.schema_version,
    ].join(':');
  };
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
    /** Every source consumed after coupled speculative writes must already
     * belong to the group's original verified proof, never a newer baseline. */
    assertContains(ids: Iterable<string>) {
      for (const id of ids) {
        const row = previous.get(id);
        if (
          !row ||
          typeof row.path !== 'string' ||
          typeof row.identity !== 'string' ||
          row.signature !== signature(id, row.path, row.identity)
        )
          throw changed();
      }
    },
    /** Streams only the originally signed identities into a second owned proof. */
    *verifiedArtifacts(): Iterable<VerifiedClinicalArtifact> {
      let seen = 0;
      for (const row of sql
        .prepare(`SELECT id,path,identity,signature FROM ${table} ORDER BY id`)
        .iterate()) {
        if (
          typeof row.id !== 'string' ||
          typeof row.path !== 'string' ||
          typeof row.identity !== 'string' ||
          row.signature !== signature(row.id, row.path, row.identity)
        )
          throw changed();
        seen++;
        yield { id: row.id, path: row.path, identity: row.identity };
      }
      if (seen !== count) throw changed();
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
    /** The completion callback runs synchronously after the last physical proof. */
    async withVerifiedTerminal<T>(
      controls: { assertCurrent(): void; signal?: AbortSignal },
      complete: (terminalPhysicalCurrent: () => void) => T,
      mode: 'read-only' | 'publication' = 'read-only',
    ): Promise<T> {
      controls.signal?.throwIfAborted();
      controls.assertCurrent();
      const epoch = captureManagedPhysicalEpoch();
      if (!epoch) throw changed();
      const witness = scratchWitness();
      const expectedCount = count;
      const terminalPhysicalCurrent = () => {
        if (
          !managedPhysicalEpochCurrent(epoch) ||
          count !== expectedCount ||
          scratchWitness() !== witness
        )
          throw changed();
      };
      const current = () => {
        controls.signal?.throwIfAborted();
        controls.assertCurrent();
        terminalPhysicalCurrent();
      };
      const verifier = await openClinicalPhysicalVerifier(controls.signal);
      let closed = false;
      try {
        current();
        let seen = 0;
        let cursor: string | undefined;
        for (;;) {
          const records =
            cursor === undefined
              ? sql
                  .prepare(`SELECT id,path,identity,signature FROM ${table} ORDER BY id LIMIT 64`)
                  .all()
              : sql
                  .prepare(
                    `SELECT id,path,identity,signature FROM ${table} WHERE id>? ORDER BY id LIMIT 64`,
                  )
                  .all(cursor);
          if (!records.length) break;
          const page: { kind: 'identity'; path: string; expectedIdentity: string }[] = [];
          for (const row of records) {
            if (
              typeof row.id !== 'string' ||
              typeof row.path !== 'string' ||
              typeof row.identity !== 'string' ||
              row.signature !== signature(row.id, row.path, row.identity)
            )
              throw changed();
            page.push({ kind: 'identity', path: row.path, expectedIdentity: row.identity });
          }
          cursor = String(records[records.length - 1]!.id);
          seen += page.length;
          if (seen > expectedCount) throw changed();
          current();
          await verifier.verifyPage(page);
          current();
        }
        if (seen !== expectedCount) throw changed();
        await verifier.close();
        closed = true;
        current();
        const result = complete(terminalPhysicalCurrent);
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          ('then' in result || 'next' in result)
        )
          throw changed();
        // Publication's fixed synchronous callback has its own pre-durability
        // terminal guard. Its accepted writes can rotate the physical epoch.
        if (mode === 'read-only') current();
        return result;
      } finally {
        if (!closed) await verifier.abort();
      }
    },
  };
}
