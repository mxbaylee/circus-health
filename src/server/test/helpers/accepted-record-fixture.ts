import { type Database, transaction } from '../../database.ts';

/** Explicit fictional accepted-record mutation using the runtime transaction boundary. */
export function fixtureTransaction<T>(db: Database, write: () => T): T {
  return db.isTransaction ? write() : transaction(db, write);
}

/** A genuine accepted-record backend with an explicit controllable publication fault. */
export function recordPublicationFixture() {
  const objects = new Map<string, Buffer>();
  let publicationError: Error | null = null;
  const storage: import('../../record-versions.ts').RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, bytes) {
      const prior = objects.get(name);
      if (prior && !prior.equals(bytes)) throw new Error('Fixture immutable bytes changed');
      objects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes) {
      if (publicationError) throw publicationError;
      objects.set('head', Buffer.from(bytes));
    },
  };
  return {
    storage,
    refusePublication(error: Error | null) {
      publicationError = error;
    },
  };
}
