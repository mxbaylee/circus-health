import type { DatabaseSync } from 'node:sqlite';

/** Diagnostic reads only. Run after the measured operation and counter snapshot.
 * These SQLite aggregates neither rebuild authority nor call product caches.
 * SQLite groups IDs in its pager; JavaScript retains aggregate buckets only. */
export function recordVersionWorkInventory(
  db: DatabaseSync,
  afterSequence: number,
  throughSequence = recordVersionSequence(db),
) {
  if (
    !Number.isSafeInteger(afterSequence) ||
    !Number.isSafeInteger(throughSequence) ||
    afterSequence < 0 ||
    throughSequence < afterSequence
  )
    throw Error('Invalid diagnostic interval');
  const selected = `SELECT v.*, p.contents_json AS previous_contents,
    CASE WHEN v.entity='app_meta' THEN json_extract(v.contents_json,'$.key') END AS meta_key
    FROM __record_versions v LEFT JOIN __record_versions p ON p.version_id=v.previous_version
    WHERE v.sequence>? AND v.sequence<=?`;
  const classified = `WITH selected AS (${selected}), classified AS (
    SELECT *, CASE
      WHEN entity!='app_meta' THEN entity
      WHEN meta_key GLOB 'intake_state_v1:*:node:*' THEN 'app_meta/intake-node'
      WHEN meta_key GLOB 'intake_state_v1:*:head' THEN 'app_meta/intake-head'
      WHEN meta_key GLOB 'intake_state_v1:*:frame:*' THEN 'app_meta/intake-frame'
      WHEN meta_key GLOB 'intake_state_v1:*:receipt:*' THEN 'app_meta/intake-receipt'
      WHEN meta_key GLOB 'intake_state_v1:*:history:*' THEN 'app_meta/intake-history'
      WHEN meta_key GLOB 'intake_partial_acceptance:*:item:*' THEN 'app_meta/partial-item'
      WHEN meta_key GLOB 'intake_partial_acceptance:*' THEN 'app_meta/partial-manifest'
      ELSE 'app_meta/' || CASE WHEN instr(meta_key,':')>0
        THEN substr(meta_key,1,instr(meta_key,':')-1) ELSE meta_key END END AS family
    FROM selected)`;
  const buckets = [];
  for (const row of db
    .prepare(
      `${classified}, per_id AS (
      SELECT entity,family,record_id,count(*) AS versions,
        sum(length(CAST(contents_json AS BLOB))) AS contents_bytes,
        sum(length(CAST(metadata_json AS BLOB))) AS metadata_bytes,
        sum(length(CAST(record_id AS BLOB))) AS record_id_bytes,
        max(length(CAST(contents_json AS BLOB))) AS largest_contents_bytes,
        sum(CASE WHEN contents_json=previous_contents THEN 1 ELSE 0 END) AS unchanged_versions,
        sum(CASE WHEN contents_json=previous_contents THEN length(CAST(contents_json AS BLOB)) ELSE 0 END) AS unchanged_contents_bytes,
        sum(deleted) AS deleted_rows
      FROM classified GROUP BY entity,family,record_id)
    SELECT entity,family,sum(versions) AS rows,count(*) AS distinct_record_ids,
      max(versions) AS max_versions_per_record_id,sum(contents_bytes) AS contents_bytes,
      sum(metadata_bytes) AS metadata_bytes,sum(record_id_bytes) AS record_id_bytes,
      max(largest_contents_bytes) AS largest_contents_bytes,
      sum(unchanged_versions) AS unchanged_versions,
      sum(unchanged_contents_bytes) AS unchanged_contents_bytes,sum(deleted_rows) AS deleted_rows
    FROM per_id GROUP BY entity,family ORDER BY entity,family`,
    )
    .iterate(afterSequence, throughSequence))
    buckets.push(row);
  const nodes = [];
  for (const row of db
    .prepare(
      `WITH selected AS (${selected}), raw_nodes AS (
      SELECT json_extract(contents_json,'$.value') AS raw FROM selected
      WHERE entity='app_meta' AND meta_key GLOB 'intake_state_v1:*:node:*'),
    valid_nodes AS (SELECT raw FROM raw_nodes WHERE json_valid(raw)),
    nodes AS (SELECT raw,json_extract(raw,'$.value') AS value,
      json_extract(raw,'$.key') AS key,
      max(COALESCE(json_extract(raw,'$.left.height'),0),COALESCE(json_extract(raw,'$.right.height'),0))+1 AS height,
      COALESCE(json_extract(raw,'$.left.count'),0)+COALESCE(json_extract(raw,'$.right.count'),0)+1 AS subtree_count,
      CASE WHEN json_type(raw,'$.left')='null' AND json_type(raw,'$.right')='null' THEN 'leaf' ELSE 'branch' END AS shape,
      COALESCE(length(CAST(json_extract(raw,'$.left') AS BLOB)),4)+COALESCE(length(CAST(json_extract(raw,'$.right') AS BLOB)),4) AS reference_bytes
      FROM valid_nodes WHERE json_extract(raw,'$.format')='health-intake-node-v4'),
    classified AS (SELECT *,CASE WHEN json_valid(value)
      THEN COALESCE(json_extract(value,'$.format'),json_extract(value,'$.kind'),json_type(value))
      ELSE 'raw-text' END AS value_kind FROM nodes)
    SELECT shape,height,value_kind,count(*) AS rows,
      sum(length(CAST(raw AS BLOB))) AS raw_node_bytes,
      sum(length(CAST(value AS BLOB))) AS value_bytes,
      sum(length(CAST(key AS BLOB))) AS key_bytes,
      sum(reference_bytes) AS reference_bytes,
      max(length(CAST(value AS BLOB))) AS largest_value_bytes,
      max(subtree_count) AS largest_subtree_count
    FROM classified GROUP BY shape,height,value_kind ORDER BY shape,height,value_kind`,
    )
    .iterate(afterSequence, throughSequence))
    nodes.push(row);
  const nodeRows = buckets
    .filter((row) => row.family === 'app_meta/intake-node')
    .reduce((sum, row) => sum + Number(row.rows), 0);
  return {
    afterSequence,
    throughSequence,
    buckets,
    nodes,
    unclassifiedNodeRows: nodeRows - nodes.reduce((sum, row) => sum + Number(row.rows), 0),
    limits:
      'Accepted projection rows only; raw JSON byte equality, not semantic equality. Nodes do not carry collection ownership: histograms cannot identify collections or show whether rebuilding paths was necessary. Observer SQL and parsing are outside measured product work.',
  };
}

export function recordVersionSequence(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COALESCE(max(sequence),0) n FROM __record_versions').get()!.n);
}

export type ImmutableWriteEvent = { name: string; bytes: number };
/** Every write event is retained, including duplicate, speculative and orphan
 * objects. Classification never follows HEAD to filter out unselected objects.
 * This aggregate diagnostic reuses the fixture's object Map and retains O(events)
 * event metadata; it does not claim constant diagnostic memory. */
export function encodedRecordObjectInventory(
  objects: Pick<ReadonlyMap<string, Buffer>, 'get'>,
  events: readonly ImmutableWriteEvent[],
  afterEvent: number,
  throughEvent = events.length,
) {
  if (
    !Number.isSafeInteger(afterEvent) ||
    !Number.isSafeInteger(throughEvent) ||
    afterEvent < 0 ||
    throughEvent < afterEvent ||
    throughEvent > events.length
  )
    throw Error('Invalid object diagnostic interval');
  const families: Record<string, { writes: number; bytes: number }> = {};
  for (let index = afterEvent; index < throughEvent; index++) {
    const event = events[index]!;
    const bytes = objects.get(event.name);
    if (!bytes || bytes.length !== event.bytes) throw Error('Missing immutable diagnostic object');
    let family = 'segment-or-unclassified';
    try {
      const value = JSON.parse(bytes.toString());
      if (value.format === 'health-record-segment-page-v1') family = 'segment-index-page';
      else if (
        ['health-record-versions-v1', 'health-record-versions-v2'].includes(value.format) &&
        value.segments &&
        typeof value.sequence === 'number'
      )
        family = 'record-commit';
      else if (
        value.format === 'health-record-versions-v1' &&
        value.versionId &&
        value.entity &&
        value.contents
      )
        family = 'single-version-segment';
    } catch {
      /* A version JSONL segment may end within an encoded JSON value. */
    }
    const total = (families[family] ||= { writes: 0, bytes: 0 });
    total.writes++;
    total.bytes += event.bytes;
  }
  return {
    families,
    limits:
      'All immutable write events, without reachability filtering. Segment framing/unknown bytes remain counted; this does not classify which objects are orphaned. HEAD calls and bytes are reported separately.',
  };
}
