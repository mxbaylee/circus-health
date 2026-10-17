import type { DatabaseSync } from 'node:sqlite';
import {
  encodedRecordObjectInventory,
  type ImmutableWriteEvent,
} from './record-version-work-inventory.ts';

/** Opt-in fictional diagnostic. Retains O(write events + publications) metadata
 * and caller stacks, without retaining a second copy of any clinical payload. */
export function createRecordPublicationDiagnostic(
  objects: Pick<ReadonlyMap<string, Buffer>, 'get'>,
) {
  const events: ImmutableWriteEvent[] = [];
  const publications: Array<{
    phase: string;
    sequence: number;
    operationId: string;
    firstEvent: number;
    throughEvent: number;
    headBytes: number;
    stack: string[];
  }> = [];
  const phases = [{ phase: 'fixture', firstEvent: 0, firstPublication: 0 }];
  let phase = 'fixture',
    firstEvent = 0;
  return {
    phase(value: string) {
      phase = value;
      phases.push({ phase, firstEvent: events.length, firstPublication: publications.length });
    },
    immutable(name: string, bytes: number) {
      events.push({ name, bytes });
    },
    published(value: Uint8Array) {
      const ref = JSON.parse(Buffer.from(value).toString());
      const raw = objects.get(ref.name);
      if (!raw || raw.length !== ref.bytes) throw Error('Published diagnostic commit is missing');
      const commit = JSON.parse(raw.toString());
      if (!Number.isSafeInteger(commit.sequence) || typeof commit.operationId !== 'string')
        throw Error('Invalid published diagnostic commit');
      const priorDepth = Error.stackTraceLimit;
      let stack: string[];
      try {
        Error.stackTraceLimit = 80;
        stack = (new Error().stack || '').split('\n').slice(1);
      } finally {
        Error.stackTraceLimit = priorDepth;
      }
      publications.push({
        phase,
        sequence: commit.sequence,
        operationId: commit.operationId,
        firstEvent,
        throughEvent: events.length,
        headBytes: value.length,
        stack,
      });
      firstEvent = events.length;
    },
    inventory(db: DatabaseSync) {
      const versions = new Map<number, Record<string, unknown>>();
      for (const row of db
        .prepare(
          `WITH safe_versions AS (SELECT *,
        CASE WHEN json_valid(contents_json) THEN json_extract(contents_json,'$.key') END AS meta_key,
        CASE WHEN json_valid(contents_json) THEN json_extract(contents_json,'$.value') END AS raw_node
        FROM __record_versions)
        SELECT sequence,min(operation_id) AS operation_id,max(operation_id) AS last_operation_id,
        count(DISTINCT operation_id) AS operation_ids,count(*) AS rows,
        sum(CASE WHEN json_valid(contents_json) THEN 0 ELSE 1 END) AS malformed_contents_rows,
        sum(length(CAST(contents_json AS BLOB))) AS contents_bytes,
        sum(length(CAST(metadata_json AS BLOB))) AS metadata_bytes,
        sum(CASE WHEN entity='app_meta' AND meta_key GLOB 'intake_state_v1:*:node:*' THEN 1 ELSE 0 END) AS node_rows,
        sum(CASE WHEN entity='app_meta' AND meta_key GLOB 'intake_state_v1:*:node:*' THEN length(CAST(contents_json AS BLOB)) ELSE 0 END) AS node_contents_bytes,
        sum(CASE WHEN entity='app_meta' AND meta_key GLOB 'intake_state_v1:*:node:*' THEN length(CAST(raw_node AS BLOB)) ELSE 0 END) AS node_raw_bytes
        FROM safe_versions GROUP BY sequence ORDER BY sequence`,
        )
        .iterate())
        versions.set(Number(row.sequence), row);
      const nodeInventory = recordPublicationNodeInventory(db);
      const nodesBySequence = new Map<number, typeof nodeInventory>();
      for (const row of nodeInventory) {
        const sequence = Number(row.sequence);
        let buckets = nodesBySequence.get(sequence);
        if (!buckets) nodesBySequence.set(sequence, (buckets = []));
        buckets.push(row);
      }
      const fragments = (first: number, through: number) =>
        phases.flatMap((boundary, index) => {
          const from = Math.max(first, boundary.firstEvent),
            to = Math.min(through, phases[index + 1]?.firstEvent ?? events.length);
          return from < to
            ? [
                {
                  phase: boundary.phase,
                  firstEvent: from,
                  throughEvent: to,
                  objects: encodedRecordObjectInventory(objects, events, from, to),
                },
              ]
            : [];
        });
      const assigned = new Set<number>();
      const observed = publications.map((publication) => {
        // A duplicate physical HEAD call is retained, but cannot double-count
        // its already assigned accepted projection rows.
        const version = versions.get(publication.sequence);
        if (
          version &&
          (Number(version.operation_ids) !== 1 ||
            version.operation_id !== publication.operationId ||
            version.last_operation_id !== publication.operationId)
        )
          throw Error('Published sequence diagnostic operation does not match');
        const rows = assigned.has(publication.sequence) ? undefined : version;
        assigned.add(publication.sequence);
        // The nearest raw source frame after explicit storage/transaction containers.
        // This is an observed callsite, never a semantic collection owner.
        const caller =
          publication.stack.find(
            (frame) =>
              /[/]src[/]server[/]/.test(frame) &&
              !/[/]test[/]/.test(frame) &&
              !/[/](record-versions|record-version-work|database|intake-state-collections|intake-state-storage|clinical-operation)\.ts:/.test(
                frame,
              ),
          ) || 'unknown';
        return {
          ...publication,
          stack: [...publication.stack],
          caller,
          versions: rows,
          nodes: rows ? (nodesBySequence.get(publication.sequence) ?? []) : [],
          eventFragments: fragments(publication.firstEvent, publication.throughEvent),
          objects: encodedRecordObjectInventory(
            objects,
            events,
            publication.firstEvent,
            publication.throughEvent,
          ),
        };
      });
      const unknownSequences = [...versions]
        .filter(([sequence]) => !assigned.has(sequence))
        .map(([, row]) => row);
      const trailingObjects = encodedRecordObjectInventory(objects, events, firstEvent);
      const trailingFragments = fragments(firstEvent, events.length);
      const groups = new Map<
        string,
        {
          phase: string;
          caller: string;
          heads: number;
          head_bytes: number;
          rows: number;
          node_rows: number;
          malformed_contents_rows: number;
          contents_bytes: number;
          metadata_bytes: number;
          node_contents_bytes: number;
          node_raw_bytes: number;
          immutable_writes: number;
          immutable_bytes: number;
        }
      >();
      const groupFor = (phase: string, caller: string) => {
        const key = JSON.stringify([phase, caller]);
        let group = groups.get(key);
        if (!group)
          groups.set(
            key,
            (group = {
              phase,
              caller,
              heads: 0,
              head_bytes: 0,
              rows: 0,
              node_rows: 0,
              malformed_contents_rows: 0,
              contents_bytes: 0,
              metadata_bytes: 0,
              node_contents_bytes: 0,
              node_raw_bytes: 0,
              immutable_writes: 0,
              immutable_bytes: 0,
            }),
          );
        return group;
      };
      for (const item of observed) {
        const group = groupFor(item.phase, item.caller);
        group.heads++;
        group.head_bytes += item.headBytes;
        for (const key of [
          'rows',
          'node_rows',
          'malformed_contents_rows',
          'contents_bytes',
          'metadata_bytes',
          'node_contents_bytes',
          'node_raw_bytes',
        ] as const)
          group[key] += Number(item.versions?.[key] || 0);
        for (const fragment of item.eventFragments) {
          const eventGroup = groupFor(fragment.phase, item.caller);
          for (const family of Object.values(fragment.objects.families)) {
            eventGroup.immutable_writes += family.writes;
            eventGroup.immutable_bytes += family.bytes;
          }
        }
      }
      const allRows = [...versions.values()].reduce((sum, row) => sum + Number(row.rows), 0);
      const groupedRows =
        [...groups.values()].reduce((sum, row) => sum + row.rows, 0) +
        unknownSequences.reduce((sum, row) => sum + Number(row.rows), 0);
      if (allRows !== groupedRows) throw Error('Publication row diagnostic omitted rows');
      const families = [
        ...observed.flatMap((row) => Object.values(row.objects.families)),
        ...Object.values(trailingObjects.families),
      ];
      if (
        families.reduce((sum, row) => sum + row.writes, 0) !== events.length ||
        families.reduce((sum, row) => sum + row.bytes, 0) !==
          events.reduce((sum, row) => sum + row.bytes, 0)
      )
        throw Error('Publication object diagnostic omitted events');
      const fragmentFamilies = [
        ...observed.flatMap((row) => row.eventFragments),
        ...trailingFragments,
      ].flatMap((fragment) => Object.values(fragment.objects.families));
      if (
        fragmentFamilies.reduce((sum, family) => sum + family.writes, 0) !== events.length ||
        fragmentFamilies.reduce((sum, family) => sum + family.bytes, 0) !==
          events.reduce((sum, event) => sum + event.bytes, 0)
      )
        throw Error('Publication phase fragments omitted events');
      const totalNodeRows = [...versions.values()].reduce(
        (sum, row) => sum + Number(row.node_rows),
        0,
      );
      if (nodeInventory.reduce((sum, row) => sum + Number(row.rows), 0) !== totalNodeRows)
        throw Error('Publication node diagnostic omitted rows');
      return {
        phaseBoundaries: phases.map((boundary) => ({ ...boundary })),
        nodeInventory,
        nodeLimits:
          'Static value-kind/key-prefix buckets only, not semantic owners. Exact BINARY(identity,key,value) groups stay in SQLite. All-row decoded value bytes, one value length per exact group, within-sequence additional distinct hashes and earlier-sequence new-hash copies are separate views, not additive savings or encoded journal bytes. Equal byte lengths do not deduplicate unequal values. Invalid inner JSON/format/header/hash suffix remains unclassified; this recognizes headers only and never validates AVL edges, node digests or authority. Malformed outer contents JSON remains an explicit projection-row count and cannot be identified as a node.',
        groups: [...groups.values()],
        publications: observed,
        unknownSequences,
        missingProjectionSequences: publications
          .filter((row) => !versions.has(row.sequence))
          .map((row) => row.sequence),
        trailingObjects,
        trailingFragments,
        limits:
          'Physical HEAD call stacks and nearest raw source frames after the explicit storage/transaction container exclusion list; unknown/truncated callers retained. HEAD phase and row attribution use publication time; immutable events are intersected with exact recorded phase event boundaries. A crossing fragment retains its event phase and inherits its closing HEAD caller, not a proven origin. Version bytes are accepted projection rows, not scratch nodes. Write-event intervals include every immutable event, including unselected objects. Orphan/speculative events inherit the next HEAD interval caller; this does not prove their actual origin. Stack attribution describes the observed caller, not semantic necessity; observer work is outside product measurement.',
      };
    },
  };
}

/** SQL-only syntactic attribution after measured counters are frozen. Exact
 * BINARY text grouping is descriptive; it neither decodes authority nor proves
 * collection ownership or avoidable copying. Returned buckets contain no keys,
 * identities or values. SQLite owns the grouping memory, not a JS payload map. */
export function recordPublicationNodeInventory(db: DatabaseSync) {
  const query = `WITH node_rows AS (
    SELECT sequence,CASE WHEN json_valid(contents_json) THEN json_extract(contents_json,'$.value') END AS raw,
      CASE WHEN json_valid(contents_json) THEN substr(json_extract(contents_json,'$.key'),-64) END AS hash
    FROM __record_versions WHERE entity='app_meta' AND
      CASE WHEN json_valid(contents_json) THEN json_extract(contents_json,'$.key') END
      GLOB 'intake_state_v1:*:node:*'),
  parsed AS (SELECT *,CASE WHEN json_valid(raw) THEN raw ELSE '{}' END AS safe FROM node_rows),
  fields AS (SELECT *,json_extract(safe,'$.identity') AS identity,
    json_extract(safe,'$.key') AS key,json_extract(safe,'$.value') AS value,
    CASE WHEN json_extract(safe,'$.format')='health-intake-node-v4'
      AND json_type(safe,'$.identity')='object' AND json_type(safe,'$.key')='text'
      AND json_type(safe,'$.value')='text' AND length(hash)=64
      AND hash NOT GLOB '*[^a-f0-9]*' THEN 1 ELSE 0 END AS valid FROM parsed),
  classified AS (SELECT *,CASE WHEN valid=0 THEN 'unclassified'
      WHEN json_valid(value)=0 THEN 'raw-text'
      WHEN json_extract(value,'$.format') IN ('health-intake-state-history-v4','health-intake-state-receipt-v4')
        THEN json_extract(value,'$.format')
      WHEN json_extract(value,'$.kind') IN ('inline','map','collection','bytes') THEN json_extract(value,'$.kind')
      ELSE json_type(value) END AS value_kind,
    CASE WHEN valid=0 THEN 'unclassified'
      WHEN substr(key,1,2) IN ('r:','p:','f:','l:','i:','o:','m:','c:','u:','e:','k:','s:','b:','d:','a:','v:','q:') THEN substr(key,1,2)
      WHEN substr(key,1,8)='section:' THEN 'section:'
      WHEN key IN ('$before','$after','$schema') THEN key
      WHEN length(key)=64 AND key NOT GLOB '*[^a-f0-9]*' THEN 'hash-key'
      WHEN length(key)=16 AND key NOT GLOB '*[^0-9]*' THEN 'ordinal-key'
      ELSE 'other-key' END AS key_prefix FROM fields),
  hash_groups AS (SELECT sequence,value_kind,key_prefix,identity COLLATE BINARY AS identity,
    key COLLATE BINARY AS key,value COLLATE BINARY AS value,hash COLLATE BINARY AS hash,
    count(*) AS rows,sum(length(CAST(raw AS BLOB))) AS raw_bytes
    FROM classified WHERE valid=1 GROUP BY sequence,identity COLLATE BINARY,key COLLATE BINARY,
      value COLLATE BINARY,hash COLLATE BINARY),
  first_seen AS (SELECT *,min(sequence) OVER(PARTITION BY identity COLLATE BINARY,key COLLATE BINARY,value COLLATE BINARY) AS value_first_sequence,
    min(sequence) OVER(PARTITION BY identity COLLATE BINARY,key COLLATE BINARY,value COLLATE BINARY,hash COLLATE BINARY) AS hash_first_sequence
    FROM hash_groups),
  exact_values AS (SELECT sequence,value_kind,key_prefix,identity COLLATE BINARY AS identity,
    key COLLATE BINARY AS key,value COLLATE BINARY AS value,sum(rows) AS rows,
    sum(raw_bytes) AS raw_bytes,count(*) AS distinct_hashes,
    sum(rows-1) AS duplicate_hash_rows,
    sum(CASE WHEN hash_first_sequence<sequence THEN 1 ELSE 0 END) AS earlier_sequence_same_hashes,
    sum(CASE WHEN hash_first_sequence=sequence AND value_first_sequence<sequence THEN 1 ELSE 0 END) AS earlier_sequence_new_hashes,
    length(CAST(value AS BLOB)) AS value_bytes
    FROM first_seen GROUP BY sequence,identity COLLATE BINARY,key COLLATE BINARY,value COLLATE BINARY),
  buckets AS (SELECT sequence,value_kind,key_prefix,sum(rows) AS rows,sum(raw_bytes) AS raw_bytes,
    sum(distinct_hashes) AS distinct_hashes,sum(duplicate_hash_rows) AS duplicate_hash_rows,
    count(*) AS exact_identity_key_value_groups,sum(value_bytes) AS exact_group_value_bytes,
    sum(value_bytes*rows) AS all_row_value_bytes,
    sum(distinct_hashes-1) AS within_sequence_additional_hashes,
    sum((distinct_hashes-1)*value_bytes) AS within_sequence_additional_value_bytes,
    sum(earlier_sequence_same_hashes) AS earlier_sequence_same_hashes,
    sum(earlier_sequence_new_hashes) AS earlier_sequence_new_hashes,
    sum(earlier_sequence_new_hashes*value_bytes) AS earlier_sequence_new_hash_value_bytes
    FROM exact_values GROUP BY sequence,value_kind,key_prefix
    UNION ALL SELECT sequence,'unclassified','unclassified',count(*),sum(length(CAST(raw AS BLOB))),
      0,0,0,0,0,0,0,0,0,0 FROM classified WHERE valid=0 GROUP BY sequence)
  SELECT * FROM buckets ORDER BY sequence,value_kind,key_prefix`;
  return [...db.prepare(query).iterate()];
}
