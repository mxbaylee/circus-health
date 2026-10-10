type ArchiveRefusal = Error & { status: number; code: string };
const refusals = new WeakSet<Error>();

export function isArchiveRefusal(error: unknown): error is ArchiveRefusal {
  return error instanceof Error && refusals.has(error);
}

/** Safe public guidance: never include decrypted contents or filesystem paths. */
export function archiveRefusal(
  scope: string,
  unavailable: string,
): Error & {
  status: number;
  code: string;
} {
  // Crypto imports this module before storage/database initialization. Keep the
  // public status/code contract independent of the database dependency graph.
  const error = Object.assign(
    new Error(
      `${scope} is missing, invalid or unsupported. ${unavailable} Preserve this archive and use a compatible app release, or restore a complete pre-update backup into a separate data directory. Do not reset or convert this archive.`,
    ),
    { status: 409, code: 'ARCHIVE_UNSUPPORTED' },
  );
  refusals.add(error);
  return error;
}
