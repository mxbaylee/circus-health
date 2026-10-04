/** Native report queue presentation, with independent bounded clinical and People sections. */
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import {
  openCollectionReportQueue,
  collectionReportGroupSummary,
  type CollectionReportGroupSummary,
} from './intake-report-group-collection.ts';
import { readCollectionQueueActivity } from './intake-queue-activity-collection.ts';
import { readCollectionIntakeReportRecords } from './intake-report-queue-collection.ts';
import { readCollectionPeoplePage } from './intake-people-collection.ts';
import { canonicalLiteral } from './intake-format.ts';
import { journalActivityBinding } from './journal-activity-index.ts';
import type { IntakeReportQueueView } from '../shared/intake.ts';

export interface CollectionReportGroupReference {
  format: 'health-intake-report-group-reference-v2';
  binding: string;
  intakeId: string;
  groupId: string;
  ordinal: number;
  bytes: number;
}
type Options = { view?: IntakeReportQueueView; limit?: number; bytes?: number; cursor?: string };
function window(input: Options, binding: string, scope: string) {
  const view = input.view || 'active',
    limit = input.limit ?? 30,
    bytes = input.bytes ?? 128 * 1024;
  if (
    !['active', 'deferred', 'all'].includes(view) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1024 ||
    bytes > 256 * 1024
  )
    throw new HttpError(
      400,
      'REPORT_QUEUE_WINDOW',
      'Choose active, deferred or all, 1 to 100 rows, and 1024 to 262144 bytes',
    );
  let after = '';
  if (input.cursor) {
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
    } catch {
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this queue');
    }
    if (
      !Array.isArray(raw) ||
      raw.length !== 4 ||
      raw[0] !== binding ||
      raw[1] !== scope ||
      raw[2] !== view ||
      typeof raw[3] !== 'string'
    )
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this queue');
    after = raw[3];
  }
  return {
    view,
    limit,
    bytes,
    after,
    cursor: (order: string) =>
      Buffer.from(canonicalLiteral([binding, scope, view, order])).toString('base64url'),
  };
}
export async function readCollectionReportQueuePage(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: Options = {},
) {
  const activityPin = journalActivityBinding(root, profileId),
    queue = await openCollectionReportQueue(db, root, profileId);
  try {
    const page = window(input, queue.binding + ':' + activityPin, 'groups'),
      groups: (
        | { kind: 'group'; group: CollectionReportGroupSummary }
        | { kind: 'reference'; reference: CollectionReportGroupReference }
      )[] = [];
    let totalGroups = 0,
      used = 0,
      full = false,
      more = false,
      last = '';
    for (const pointer of queue.groups(page.view)) {
      totalGroups++;
      const order =
        pointer.order + ':' + pointer.intakeId + ':' + String(pointer.ordinal).padStart(16, '0');
      if (order <= page.after) continue;
      if (full || groups.length >= page.limit) {
        more = true;
        continue;
      }
      const group = await collectionReportGroupSummary(db, root, profileId, queue, pointer),
        bytes = Buffer.byteLength(canonicalLiteral(group));
      const item: (typeof groups)[number] =
          bytes > page.bytes
            ? {
                kind: 'reference',
                reference: {
                  format: 'health-intake-report-group-reference-v2',
                  binding: queue.binding,
                  intakeId: pointer.intakeId,
                  groupId: pointer.groupId,
                  ordinal: pointer.ordinal,
                  bytes,
                },
              }
            : { kind: 'group', group },
        size = Buffer.byteLength(canonicalLiteral(item));
      if (groups.length && used + size > page.bytes) {
        full = true;
        more = true;
        continue;
      }
      groups.push(item);
      used += size;
      last = order;
    }
    if (journalActivityBinding(root, profileId) !== activityPin)
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Reading activity changed');
    return {
      format: 'health-intake-report-queue-page-v2' as const,
      view: page.view,
      groups,
      totalGroups,
      nextCursor: more ? page.cursor(last) : null,
      activity: readCollectionQueueActivity(db, root, profileId, queue),
    };
  } finally {
    queue.close();
  }
}
export async function readCollectionReportGroupDetail(
  db: DatabaseSync,
  root: string,
  profileId: string,
  groupId: string,
  input: Options & {
    intakeId?: string;
    peopleCursor?: string;
    personId?: string;
    peopleQuery?: string;
  } = {},
) {
  const queue = await openCollectionReportQueue(db, root, profileId);
  try {
    const pointer = (() => {
      for (const pointer of queue.groups('all'))
        if (pointer.groupId === groupId && (!input.intakeId || pointer.intakeId === input.intakeId))
          return pointer;
    })();
    if (!pointer) throw new HttpError(404, 'REPORT_GROUP_NOT_FOUND', 'Report group not found');
    const group = await collectionReportGroupSummary(db, root, profileId, queue, pointer),
      records = await readCollectionIntakeReportRecords(
        db,
        root,
        profileId,
        pointer.intakeId,
        {
          groupId,
          view: input.view,
          cursor: input.cursor,
          limit: input.limit,
          bytes: input.bytes,
        },
        queue,
      ),
      people = readCollectionPeoplePage(db, root, profileId, pointer.intakeId, {
        groupId,
        personId: input.personId,
        q: input.peopleQuery,
        view: input.view,
        cursor: input.peopleCursor,
        limit: input.limit,
        bytes: input.bytes,
      });
    queue.assertCurrent();
    return { format: 'health-intake-report-detail-v2' as const, group, records, people };
  } finally {
    queue.close();
  }
}
export async function readCollectionReportGroupFragment(
  db: DatabaseSync,
  root: string,
  profileId: string,
  reference: CollectionReportGroupReference,
  offset = 0,
  limit = 32768,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 65536
  )
    throw new HttpError(400, 'REPORT_QUEUE_WINDOW', 'Choose a bounded report fragment');
  const queue = await openCollectionReportQueue(db, root, profileId);
  try {
    if (
      reference.format !== 'health-intake-report-group-reference-v2' ||
      reference.binding !== queue.binding
    )
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report');
    const pointer = (() => {
      for (const pointer of queue.groups('all'))
        if (
          pointer.intakeId === reference.intakeId &&
          pointer.groupId === reference.groupId &&
          pointer.ordinal === reference.ordinal
        )
          return pointer;
    })();
    if (!pointer) throw new HttpError(404, 'REPORT_GROUP_NOT_FOUND', 'Report group not found');
    const bytes = Buffer.from(
      canonicalLiteral(await collectionReportGroupSummary(db, root, profileId, queue, pointer)),
    );
    if (bytes.length !== reference.bytes || offset > bytes.length)
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report');
    const next = Math.min(bytes.length, offset + limit);
    return {
      format: 'health-intake-report-group-fragment-v2' as const,
      reference,
      encoding: 'base64-json' as const,
      data: bytes.subarray(offset, next).toString('base64'),
      complete: next === bytes.length,
      nextOffset: next === bytes.length ? null : next,
    };
  } finally {
    queue.close();
  }
}
export async function readCollectionReportSourceCoverage(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: {
    intakeId: string;
    groupId: string;
    ordinal?: number;
    kind: 'current' | 'saved';
    cursor?: string;
    limit?: number;
  },
) {
  if (!['current', 'saved'].includes(input.kind))
    throw new HttpError(400, 'REPORT_QUEUE_WINDOW', 'Choose current or saved source coverage');
  const queue = await openCollectionReportQueue(db, root, profileId);
  try {
    const pointer = (() => {
      for (const pointer of queue.groups('all'))
        if (
          pointer.intakeId === input.intakeId &&
          pointer.groupId === input.groupId &&
          (input.ordinal === undefined || pointer.ordinal === input.ordinal)
        )
          return pointer;
    })();
    if (!pointer) throw new HttpError(404, 'REPORT_GROUP_NOT_FOUND', 'Report group not found');
    const summary = await collectionReportGroupSummary(db, root, profileId, queue, pointer, input);
    return {
      format: 'health-intake-report-source-coverage-page-v2' as const,
      intakeId: input.intakeId,
      groupId: input.groupId,
      kind: input.kind,
      coverage: summary.sourceCoverage[input.kind],
    };
  } finally {
    queue.close();
  }
}
