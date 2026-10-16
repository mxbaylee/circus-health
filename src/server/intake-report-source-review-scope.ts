import type { SQLInputValue } from 'node:sqlite';
/** Explicit whole-scope preparation. Scratch rows are pinned disposable work, never durable source authority. */
import { createHash } from 'node:crypto';
import type { IntakeReportQueueView, IntakeReportSourceCoverageEntry } from '../shared/intake.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { HttpError } from './database.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import { openSelectedReportSourceAuthority } from './intake-report-source-authority.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { canonicalLiteral } from './intake-format.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import { hashSourceScalar } from './intake-report-source-resolution-index.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
  type PreparedIntakeJsonCanonical,
} from './intake-json-canonical.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import { prepareReportSourceRouting } from './intake-report-source-routing.ts';

export interface NativeReportSourceScopeEntry {
  ordinal: number;
  id: string;
  candidateId: string;
  candidateVersionId: string;
  proposalId: string | null;
  recordId: string;
  batchId: string | null;
  occurrenceAddress: string;
  sourceRef: IntakeReportSourceCoverageEntry['sourceRef'];
}
const value = (
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): unknown => {
  const read = view.field(record, name, { bytes: 16384 });
  if (read.kind === 'missing') return undefined;
  if (read.kind !== 'value') throw Error('Source review selected identity unavailable: ' + name);
  return read.value;
};
const string = (
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
) => {
  const read = value(view, record, name);
  if (typeof read !== 'string') throw Error('Source review identity is invalid');
  return read;
};
const pieces = (
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
) => {
  const child = view.child(record, name);
  return child ? view.recordChunks(child) : view.fieldChunks(record, name);
};
function* children(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
) {
  let after: string | undefined;
  do {
    const page = view.children(record, name, { after, items: 64, bytes: 128 * 1024 });
    yield* page.records;
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Source review scope did not advance');
    after = page.after;
  } while (true);
}
const nativeVersion = (view: IntakeCollectionEnvelopeReader, version: IntakeEnvelopeRecord) => {
  const format = view.field(version, 'format', { bytes: 256 });
  return format.kind === 'value' && format.value === 'health-intake-report-group-version-v2';
};
export async function prepareNativeReportSourceReviewScope(
  db: Database,
  source: IntakeEnvelopeSource,
  input: { profileId: string; groupId: string; view: IntakeReportQueueView },
  options: { assertRunning?: () => void; sortItems?: number } = {},
) {
  const sortItems = options.sortItems ?? 64;
  if (!Number.isSafeInteger(sortItems) || sortItems < 1 || sortItems > 64)
    throw Error('Invalid source sort window');
  if (!['active', 'deferred', 'all'].includes(input.view))
    throw new HttpError(400, 'REPORT_SOURCE_SCOPE', 'Choose active, deferred or all records');
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
    input.profileId
  )
    throw new HttpError(409, 'REPORT_SOURCE_SCOPE', 'Refresh this report in its owning profile');
  const reader = openIntakeCollectionEnvelope(db, source),
    intake = reader.child(reader.root(), 'intake'),
    workflow = intake && reader.child(intake, 'workflow'),
    group = workflow && reader.find('reportGroup', workflow, input.groupId),
    current =
      group && reader.childCount(group, 'versions')
        ? reader.childAt(group, 'versions', reader.childCount(group, 'versions') - 1)
        : undefined;
  if (!workflow || !group || !current)
    throw new HttpError(
      409,
      'REPORT_SOURCE_SCOPE',
      'This report does not have a current anchored source-label scope',
    );
  const assertCurrent = () => {
      options.assertRunning?.();
      reader.address(current);
    },
    catalog = createReportSnapshotCatalog(db, source, { assertRunning: assertCurrent }),
    authority = await openSelectedReportSourceAuthority(db, reader, group, assertCurrent);
  if (authority.basis !== 'report_anchor' || !authority.anchored)
    throw new HttpError(
      409,
      'REPORT_SOURCE_SCOPE',
      'This report does not have a current anchored source-label scope',
    );
  const scratch = disposableSqlite('circus-source-review-'),
    cache = scratch.db;
  let closed = false,
    evidence: PreparedIntakeJsonCanonical | undefined;
  const check = () => {
    if (closed) throw Error('Source review scope is closed');
    assertCurrent();
  };
  const count = (
    name:
      | 'reportSourceScopeMembers'
      | 'reportSourceScopeOccurrences'
      | 'reportSourceScopeSortComparisons'
      | 'reportSourceScopeScratchReadBytes'
      | 'reportSourceScopeScratchWrittenBytes',
    amount = 1,
  ) => withIntakeWork(db, 'warm', () => recordIntakeWork(name, amount));
  // Logical text payload bytes delivered to/from scratch SQL; excludes SQLite's physical I/O and bookkeeping.
  const statement = (sql: string) => {
    const prepared = cache.prepare(sql);
    const read = (row: Record<string, unknown> | undefined) => {
      if (row)
        count(
          'reportSourceScopeScratchReadBytes',
          Object.values(row).reduce<number>(
            (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
            0,
          ),
        );
      return row;
    };
    return {
      run(...parameters: SQLInputValue[]) {
        const result = prepared.run(...parameters);
        if (/^INSERT/i.test(sql) && result.changes > 0)
          count(
            'reportSourceScopeScratchWrittenBytes',
            parameters.reduce<number>(
              (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
              0,
            ),
          );
        return result;
      },
      get(...parameters: SQLInputValue[]) {
        return read(prepared.get(...parameters));
      },
      *iterate(...parameters: SQLInputValue[]) {
        for (const row of prepared.iterate(...parameters)) yield read(row)!;
      },
    };
  };
  const compare = (left: string, right: string) => {
    count('reportSourceScopeSortComparisons');
    return left.localeCompare(right);
  };
  const parse = (text: Iterable<string>) =>
    prepareIntakeJsonCanonical(text, {
      assertRunning: check,
      onWork: intakeJsonCanonicalWorkObserver(db, 'warm'),
    });
  const hash = (text: Iterable<string>) => {
    const result = createHash('sha256');
    withIntakeWork(db, 'warm', () => recordIntakeWork('hashCalls'));
    for (const part of text) {
      check();
      withIntakeWork(db, 'warm', () => recordIntakeWork('hashedBytes', Buffer.byteLength(part)));
      result.update(part);
    }
    return result.digest('hex');
  };
  try {
    cache.exec(
      'CREATE TABLE introduced(candidate TEXT,version TEXT,identity TEXT,address TEXT,PRIMARY KEY(candidate,version,identity)) WITHOUT ROWID;CREATE TABLE authorities(address TEXT PRIMARY KEY,reference TEXT);CREATE TABLE entries(ordinal INTEGER PRIMARY KEY,identity TEXT UNIQUE,sortKey TEXT,metadata TEXT,rank INTEGER);CREATE TABLE chunks(entry INTEGER,ordinal INTEGER,text TEXT,PRIMARY KEY(entry,ordinal)) WITHOUT ROWID;CREATE TABLE evidence(version TEXT,ordinal INTEGER,text TEXT,PRIMARY KEY(version,ordinal)) WITHOUT ROWID;CREATE TABLE evidenceBounds(version TEXT PRIMARY KEY,start INTEGER,stop INTEGER);CREATE TABLE runs(level INTEGER,run INTEGER,ordinal INTEGER,entry INTEGER,sortKey TEXT,PRIMARY KEY(level,run,ordinal)) WITHOUT ROWID;',
    );
    function* members(version: IntakeEnvelopeRecord) {
      if (nativeVersion(reader, version)) {
        const snapshot = openReportMemberSnapshot(
          catalog,
          value(reader, version, 'members') as IntakeReportMembersReference,
        );
        for (let index = 0; index < snapshot.reference.memberCount; index++) {
          const member = snapshot.memberAt(index)!;
          count('reportSourceScopeMembers');
          yield {
            candidateId: member.candidateId,
            candidateVersionId: member.candidateVersionId,
            identities: function* () {
              let after: string | undefined;
              do {
                const page = snapshot.occurrenceDescriptors(member, {
                  after,
                  items: 64,
                  bytes: 128 * 1024,
                });
                for (const row of page.occurrences) {
                  count('reportSourceScopeOccurrences');
                  yield row.sourceIdentity;
                }
                if (page.complete) return;
                if (!page.after || page.after === after)
                  throw Error('Source occurrence page did not advance');
                after = page.after;
              } while (true);
            },
          };
        }
      } else {
        for (const member of children(reader, version, 'members')) {
          count('reportSourceScopeMembers');
          yield {
            candidateId: string(reader, member, 'candidateId'),
            candidateVersionId: string(reader, member, 'candidateVersionId'),
            identities: function* () {
              for (const occurrence of children(reader, member, 'occurrences'))
                yield occurrenceIdentity(occurrence);
            },
          };
        }
      }
    }
    const occurrenceIdentity = (occurrence: IntakeEnvelopeRecord) => {
      count('reportSourceScopeOccurrences');
      return hashSourceScalar(db, pieces(reader, occurrence, 'locator'), [
        value(reader, occurrence, 'proposalId') as string | null,
        string(reader, occurrence, 'recordId'),
        value(reader, occurrence, 'batchId') as string | null,
      ]).hash;
    };
    const routing = await prepareReportSourceRouting(db, {
        sourceId: source.id,
        binding: JSON.stringify([input.profileId, source.sha256, reader.logical]),
        assertCurrent: check,
        rows: function* () {
          // Anchor ownership takes precedence even when an anchor precedes a fallback.
          // Equal-basis writes preserve the legacy last-group/version/member winner.
          for (const selectedGroup of children(reader, workflow, 'reportGroups')) {
            check();
            const basis = value(reader, selectedGroup, 'basis');
            if (basis !== 'candidate_fallback' && basis !== 'report_anchor') continue;
            const groupId = string(reader, selectedGroup, 'id');
            for (const version of children(reader, selectedGroup, 'versions'))
              for (const member of members(version))
                yield {
                  kind: 'owner',
                  candidate: member.candidateId,
                  version: member.candidateVersionId,
                  groupId,
                  basis: basis === 'report_anchor' ? 1 : 0,
                };
          }
          for (const draft of children(reader, workflow, 'reviewDrafts'))
            yield {
              kind: 'draft',
              identity: schemaKey(
                value(reader, draft, 'candidateId'),
                value(reader, draft, 'candidateVersionId'),
                value(reader, draft, 'proposalId'),
                value(reader, draft, 'recordId'),
              ),
              disposition: String(value(reader, draft, 'disposition') || ''),
            };
        },
      }),
      introduced = statement('INSERT OR IGNORE INTO introduced VALUES(?,?,?,?)');
    for (const version of children(reader, group, 'versions'))
      for (const member of members(version))
        for (const identity of member.identities())
          introduced.run(
            member.candidateId,
            member.candidateVersionId,
            identity,
            reader.address(version),
          );
    let entryCount = 0;
    for (const member of members(current)) {
      check();
      if (routing.owner(member.candidateId, member.candidateVersionId) !== input.groupId) continue;
      const candidate = reader.find('candidate', workflow, member.candidateId, { match: 'last' }),
        version = candidate && reader.find('version', candidate, member.candidateVersionId);
      if (!candidate || !version) continue;
      if (
        value(reader, version, 'sourceContext') ||
        value(reader, version, 'peopleOnly') ||
        ['accepted', 'kept_original', 'superseded'].includes(
          String(value(reader, version, 'status')),
        )
      )
        continue;
      if (
        reader.lookup('accepted-candidate-version', [
          JSON.stringify(member.candidateId),
          member.candidateVersionId,
        ])
      )
        continue;
      const latest = reader.childAt(
        candidate,
        'versions',
        reader.childCount(candidate, 'versions') - 1,
      );
      if (!latest || value(reader, latest, 'id') !== member.candidateVersionId) continue;
      for (const occurrence of children(reader, version, 'occurrences')) {
        const proposalId = value(reader, occurrence, 'proposalId') as string | null,
          recordId = string(reader, occurrence, 'recordId'),
          disposition = routing.disposition(
            schemaKey(member.candidateId, member.candidateVersionId, proposalId, recordId),
          ),
          state = disposition === 'review_later' ? 'deferred' : 'active';
        if (input.view !== 'all' && input.view !== state) continue;
        const sourceIdentity = occurrenceIdentity(occurrence),
          identity = schemaKey(member.candidateId, member.candidateVersionId, sourceIdentity);
        if (statement('SELECT 1 FROM entries WHERE identity=?').get(identity)) continue;
        const first = statement(
          'SELECT address FROM introduced WHERE candidate=? AND version=? AND identity=?',
        ).get(member.candidateId, member.candidateVersionId, sourceIdentity);
        if (!first) continue;
        let cachedAuthority = statement('SELECT reference FROM authorities WHERE address=?').get(
          String(first.address),
        );
        if (!cachedAuthority) {
          const selected = await authority.version(reader.resolve(String(first.address)));
          try {
            const encoded = JSON.stringify(selected.reference());
            statement('INSERT INTO authorities VALUES(?,?)').run(String(first.address), encoded);
            cachedAuthority = { reference: encoded };
          } finally {
            selected.close();
          }
        }
        const sourceRef = JSON.parse(
            String(cachedAuthority.reference),
          ) as IntakeReportSourceCoverageEntry['sourceRef'],
          canonical = await parse(reader.recordChunks(occurrence));
        try {
          const id =
              'report-source-coverage:' +
              hash(
                (function* () {
                  yield canonicalLiteral([member.candidateId, member.candidateVersionId]).slice(
                    0,
                    -1,
                  ) + ',';
                  yield* canonical.chunks();
                  yield ',' + canonicalLiteral(sourceRef) + ']';
                })(),
              ),
            ordinal = entryCount++;
          const metadata: NativeReportSourceScopeEntry = {
            ordinal,
            id,
            candidateId: member.candidateId,
            candidateVersionId: member.candidateVersionId,
            proposalId,
            recordId,
            batchId: value(reader, occurrence, 'batchId') as string | null,
            occurrenceAddress: reader.address(occurrence),
            sourceRef,
          };
          statement('INSERT INTO entries VALUES(?,?,?,?,NULL)').run(
            ordinal,
            identity,
            canonicalLiteral({
              candidateId: member.candidateId,
              candidateVersionId: member.candidateVersionId,
              id,
            }),
            JSON.stringify(metadata),
          );
          let chunk = 0;
          for (const text of canonical.chunks())
            statement('INSERT INTO chunks VALUES(?,?,?)').run(ordinal, chunk++, text);
          if (
            !statement('SELECT 1 FROM evidenceBounds WHERE version=?').get(sourceRef.groupVersionId)
          ) {
            // Legacy evidence lookup uses the first version with this ID, independently of the introducing ordinal.
            const firstVersion = reader.find('version', group, sourceRef.groupVersionId),
              firstAuthority = firstVersion && (await authority.version(firstVersion));
            try {
              const suggestion = firstAuthority?.suggestion();
              let offset = 0,
                start = -1,
                stop = 0,
                buffer = '',
                chunk = 0;
              const flush = () => {
                if (buffer) {
                  statement('INSERT INTO evidence VALUES(?,?,?)').run(
                    sourceRef.groupVersionId,
                    chunk++,
                    buffer,
                  );
                  buffer = '';
                }
              };
              if (suggestion)
                hashSourceScalar(db, suggestion, [], (unit) => {
                  if (!/\s/u.test(unit)) {
                    if (start < 0) start = offset;
                    stop = offset + 1;
                  }
                  offset++;
                  buffer += unit;
                  if (buffer.length >= 4096) flush();
                });
              flush();
              statement('INSERT INTO evidenceBounds VALUES(?,?,?)').run(
                sourceRef.groupVersionId,
                start,
                stop,
              );
            } finally {
              firstAuthority?.close();
            }
          }
        } finally {
          canonical.close();
        }
      }
    }
    // Stable external merge sort uses the same localeCompare as the old complete scope.
    let run = 0,
      batch: { entry: number; key: string }[] = [];
    const flush = () => {
      batch.sort((a, b) => compare(a.key, b.key));
      for (let i = 0; i < batch.length; i++)
        statement('INSERT INTO runs VALUES(0,?,?,?,?)').run(run, i, batch[i]!.entry, batch[i]!.key);
      run++;
      batch = [];
    };
    for (const row of statement('SELECT ordinal,sortKey FROM entries ORDER BY ordinal').iterate()) {
      batch.push({ entry: Number(row.ordinal), key: String(row.sortKey) });
      if (batch.length === sortItems) flush();
    }
    if (batch.length) flush();
    let level = 0;
    while (run > 1) {
      for (let left = 0; left < run; left += 2) {
        const a = statement(
            'SELECT entry,sortKey FROM runs WHERE level=? AND run=? ORDER BY ordinal',
          ).iterate(level, left),
          b = statement(
            'SELECT entry,sortKey FROM runs WHERE level=? AND run=? ORDER BY ordinal',
          ).iterate(level, left + 1);
        let x = a.next(),
          y = b.next(),
          ordinal = 0;
        while (!x.done || !y.done) {
          const chooseA =
              y.done || (!x.done && compare(String(x.value.sortKey), String(y.value.sortKey)) <= 0),
            item = chooseA ? x.value! : y.value!;
          statement('INSERT INTO runs VALUES(?,?,?,?,?)').run(
            level + 1,
            Math.floor(left / 2),
            ordinal++,
            Number(item.entry),
            String(item.sortKey),
          );
          if (chooseA) x = a.next();
          else y = b.next();
        }
      }
      statement('DELETE FROM runs WHERE level=?').run(level);
      level++;
      run = Math.ceil(run / 2);
    }
    for (const row of statement(
      'SELECT ordinal,entry FROM runs WHERE level=? ORDER BY ordinal',
    ).iterate(level))
      statement('UPDATE entries SET rank=? WHERE ordinal=?').run(
        Number(row.ordinal),
        Number(row.entry),
      );
    function* evidenceObject() {
      yield '{';
      let first = true;
      for (const row of statement(
        'SELECT version,start,stop FROM evidenceBounds WHERE start>=0',
      ).iterate()) {
        if (!first) yield ',';
        first = false;
        yield '"';
        let offset = 0;
        for (const chunk of statement(
          'SELECT text FROM evidence WHERE version=? ORDER BY ordinal',
        ).iterate(String(row.version))) {
          const text = String(chunk.text),
            start = Math.max(0, Number(row.start) - offset),
            stop = Math.min(text.length, Number(row.stop) - offset);
          if (stop > start) yield JSON.stringify(text.slice(start, stop)).slice(1, -1);
          offset += text.length;
        }
        yield '":true';
      }
      yield '}';
    }
    evidence = await parse(evidenceObject());
    function* sourceEvidence() {
      for (const field of evidence!.objectFields(evidence!.root)) yield field.name();
    }
    function* entries() {
      check();
      for (const row of statement('SELECT metadata FROM entries ORDER BY rank').iterate())
        yield JSON.parse(String(row.metadata)) as NativeReportSourceScopeEntry;
    }
    function* entryPieces(entry: NativeReportSourceScopeEntry, replacementId = entry.id) {
      check();
      const row = statement('SELECT metadata FROM entries WHERE ordinal=?').get(entry.ordinal);
      if (!row || row.metadata !== JSON.stringify(entry))
        throw Error('Foreign source review entry');
      yield '{"candidateId":' +
        canonicalLiteral(entry.candidateId) +
        ',"candidateVersionId":' +
        canonicalLiteral(entry.candidateVersionId) +
        ',"id":' +
        canonicalLiteral(replacementId) +
        ',"occurrence":';
      for (const row of statement('SELECT text FROM chunks WHERE entry=? ORDER BY ordinal').iterate(
        entry.ordinal,
      ))
        yield String(row.text);
      yield ',"sourceRef":' + canonicalLiteral(entry.sourceRef) + '}';
    }
    const versionCanonical = await parse(reader.recordChunks(current));
    try {
      function* currentPieces() {
        if (!nativeVersion(reader, current!)) {
          yield* versionCanonical.chunks();
          return;
        }
        yield '{';
        let first = true;
        for (const field of versionCanonical.objectFields(versionCanonical.root)) {
          if (field.matches('format')) continue;
          if (!first) yield ',';
          first = false;
          yield* field.name();
          yield ':';
          if (field.matches('members'))
            yield* openReportMemberSnapshot(
              catalog,
              value(reader, current!, 'members') as IntakeReportMembersReference,
            ).canonicalMembers();
          else yield* versionCanonical.pieces(field.value);
        }
        yield '}';
      }
      function* tokenPieces() {
        yield canonicalLiteral([
          'report-source-review-v1',
          input.profileId,
          source.id,
          input.view,
        ]).slice(0, -1) + ',{';
        let first = true;
        for (const name of [
          'basis',
          'id',
          'memberId',
          'report',
          'sourceFileId',
          'sourceHash',
          'sourceSystem',
        ]) {
          if (!reader.has(group!, name)) continue;
          if (!first) yield ',';
          first = false;
          yield JSON.stringify(name) + ':';
          yield* pieces(reader, group!, name);
        }
        yield '},';
        yield* currentPieces();
        yield ',[';
        first = true;
        for (const entry of entries()) {
          if (!first) yield ',';
          first = false;
          yield* entryPieces(entry);
        }
        yield '],[';
        first = true;
        for (const label of sourceEvidence()) {
          if (!first) yield ',';
          first = false;
          yield* label;
        }
        yield ']]';
      }
      const token = await parse(tokenPieces());
      let scopeToken: string;
      try {
        scopeToken = hash(token.chunks());
      } finally {
        token.close();
      }
      let sourceEvidenceCount = 0;
      for (const _ of sourceEvidence()) sourceEvidenceCount++;
      return {
        scopeToken,
        groupId: input.groupId,
        groupVersionId: string(reader, current, 'id'),
        view: input.view,
        entryCount,
        sourceEvidenceCount,
        entries,
        entryPieces,
        sourceEvidence,
        assertCurrent: check,
        close() {
          if (!closed) {
            closed = true;
            evidence?.close();
            scratch.close();
          }
        },
      };
    } finally {
      versionCanonical.close();
    }
  } catch (error) {
    evidence?.close();
    scratch.close();
    throw error;
  }
}
