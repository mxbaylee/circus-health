import { HttpError } from './database.ts';

/** Safe public guidance: never include decrypted contents or filesystem paths. */
export function archiveRefusal(scope: string, unavailable: string): HttpError {
  return new HttpError(
    409,
    'ARCHIVE_UNSUPPORTED',
    `${scope} is missing, invalid or unsupported. ${unavailable} Preserve this archive and use a compatible app release, or restore a complete pre-update backup into a separate data directory. Do not reset or convert this archive.`,
  );
}
