import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { HttpError } from './database.ts';
import { durableWrite, type CompleteLoadedPortable } from './portable.ts';
import { validProfileId } from './profiles.ts';

interface SelectedCopyHeads {
  personal: CompleteLoadedPortable['personal']['manifest'];
  curation: CompleteLoadedPortable['curation']['manifest'];
}
export interface ProfileCopyOperation {
  format: 'health-profile-copy-operation-v1';
  operationId: string;
  sourceProfileId: string;
  targetProfileId: string;
  name: string;
  createdAt: string;
  heads?: SelectedCopyHeads;
  published?: true;
  publicationAttempted?: true;
}
const operationPath = (root: string, operationId: string) =>
  resolve(root, 'data/operations/profile-copies', `${operationId}.json`);
const fail = (message: string): never => {
  throw new HttpError(409, 'PROFILE_COPY_OPERATION', message);
};
export function copyOperationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    throw new HttpError(
      400,
      'PROFILE_COPY_OPERATION',
      'A private copy requires a caller-generated UUID operationId; reuse it when retrying',
    );
  return value;
}
export function readCopyOperation(
  root: string,
  operationId: string,
  sourceProfileId: string,
  name: string,
): ProfileCopyOperation | null {
  const path = operationPath(root, operationId);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) fail('Copy operation intent must be a regular file');
  let value: ProfileCopyOperation;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      fail('Copy operation intent is invalid; recover its retained target explicitly');
    value = parsed as ProfileCopyOperation;
  } catch {
    fail('Copy operation intent is corrupt; recover its retained target explicitly');
  }
  if (
    value!.format !== 'health-profile-copy-operation-v1' ||
    value!.operationId !== operationId ||
    !validProfileId(value!.sourceProfileId) ||
    !validProfileId(value!.targetProfileId) ||
    value!.sourceProfileId === value!.targetProfileId ||
    typeof value!.name !== 'string' ||
    typeof value!.createdAt !== 'string' ||
    (value!.published !== undefined && value!.published !== true) ||
    (value!.publicationAttempted !== undefined && value!.publicationAttempted !== true) ||
    ((value!.published || value!.publicationAttempted) && !value!.heads) ||
    (value!.heads !== undefined &&
      (!value!.heads.personal ||
        !value!.heads.curation ||
        value!.heads.personal.profileId !== value!.targetProfileId ||
        value!.heads.curation.profileId !== value!.targetProfileId))
  )
    fail('Copy operation intent is invalid; recover its retained target explicitly');
  if (value!.sourceProfileId !== sourceProfileId || value!.name !== name)
    fail('This copy operationId is already bound to a different source or display name');
  return value!;
}
export function newCopyOperation(
  operationId: string,
  sourceProfileId: string,
  name: string,
): ProfileCopyOperation {
  return {
    format: 'health-profile-copy-operation-v1',
    operationId,
    sourceProfileId,
    targetProfileId: `p-${randomUUID()}`,
    name,
    createdAt: new Date().toISOString(),
  };
}
export function writeCopyOperation(root: string, operation: ProfileCopyOperation): void {
  const path = operationPath(root, operation.operationId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  durableWrite(path, Buffer.from(JSON.stringify(operation, null, 2) + '\n'));
}
export function selectCopyHeads(
  operation: ProfileCopyOperation,
  portable: CompleteLoadedPortable,
): ProfileCopyOperation {
  return {
    ...operation,
    heads: { personal: portable.personal.manifest, curation: portable.curation.manifest },
  };
}
export function verifyCopyHeads(
  operation: ProfileCopyOperation,
  portable: CompleteLoadedPortable,
): void {
  if (
    !operation.heads ||
    JSON.stringify(operation.heads.personal) !== JSON.stringify(portable.personal.manifest) ||
    JSON.stringify(operation.heads.curation) !== JSON.stringify(portable.curation.manifest)
  )
    fail('Published private copy conflicts with its prepared operation; retain it for recovery');
}
