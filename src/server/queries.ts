import { sourceFileDetails, sourceDetailsSearch } from './intake-state-access.ts';
import { recordSourceDetailsSearchDTORead } from './source-details-search.ts';
import { sourceAssertionBoundary } from './source-assertion-ownership.ts';
import { clinicalRedirect, resolveClinicalReference } from './clinical-references.ts';
import { clinicalRelationshipProjections } from './clinical-relationships.ts';
import { acceptedMeasurements } from './measurement-semantics.ts';
import { deriveMeasurement } from '../shared/measurement.ts';
import { resolveMeasurementUnit } from '../shared/measurement-units.ts';
import { appendMedicationPreference } from './medication-preferences.ts';
import {
  appendVisibilityEvent,
  visibilityState,
  visibilitySQL,
  visibilityCondition,
  noteVisibilitySQL,
} from './visibility.ts';
import { json, required, HttpError, managedTimestamp, transaction } from './database.ts';
import type { Database, SqliteRow } from './database.ts';
import type {
  ClinicalPersonOption,
  ClinicalEvidenceEntityType,
  Evidence,
  Medication,
  MedicationCurrentStatus,
  Observation,
  Procedure,
  ProcedureCategory,
  Provider,
  SourceFile,
  SourceFileReference,
  SourceRecordClinicalEvidence,
  SourceRecord,
  SourceRecordFileView,
  SourceRecordReference,
  TestType,
  Trend,
} from '../shared/api.ts';

interface ObservationRow extends SqliteRow {
  person_id: string;
  id: string;
  test_type_id: string;
  label: string;
  effective_at: string | null;
  date_precision: string;
  value_text: string;
  value_numeric: number | null;
  comparator: string | null;
  unit: string | null;
  reference_json: string | null;
  status: string | null;
  provider_id: string | null;
  provider_name: string | null;
  source_record_id: string;
  report_id: string | null;
  extra_json: string | null;
}
interface TestTypeRow extends SqliteRow {
  id: string;
  label: string;
  category: string;
  unit: string | null;
  aliases_json: string | null;
  codes_json: string | null;
  context: string | null;
  count: number;
  numeric_count: number;
  first_date: string | null;
  last_date: string | null;
}
interface MedicationRow extends SqliteRow {
  person_id: string;
  id: string;
  label: string;
  kind: Medication['kind'];
  status: string | null;
  current_status: MedicationCurrentStatus | null;
  current_status_version: number | null;
  current_status_updated_at: string | null;
  current_status_assertion_json: string | null;
  source_raw_json: string | null;
  dose_text: string | null;
  route: string | null;
  frequency: string | null;
  start_at: string | null;
  end_at: string | null;
  provider_name: string | null;
  source_record_id: string;
  extra_json: string | null;
}
interface ProcedureRow extends SqliteRow {
  person_id: string;
  id: string;
  label: string;
  category: ProcedureCategory;
  effective_at: string | null;
  status: string | null;
  provider_name: string | null;
  source_record_id: string;
  extra_json: string | null;
}
interface SourceFileRow extends SqliteRow {
  id: string;
  provider_id: string | null;
  provider_name: string | null;
  path: string;
  sha256: string;
  bytes: number;
  mime_type: string;
  kind: string;
  coverage_status: string;
  details_json: string | null;
}
interface SourceFileReferenceRow extends SqliteRow {
  id: string;
  provider_id: string | null;
  provider_name: string | null;
  path: string;
  sha256: string;
  bytes: number;
  mime_type: string;
  kind: string;
  coverage_status: string;
  reviewed_source_provider_id: string | number | null;
  reviewed_source: string | number | null;
  parent_source_file_id: string | number | null;
}
interface SourceRecordRow extends SqliteRow {
  id: string;
  source_file_id: string;
  provider_id: string | null;
  provider_name: string | null;
  source_key: string | null;
  kind: string;
  label: string | null;
  date_text: string | null;
  raw_json: string;
  locator_json: string | null;
  extraction_status: string;
}
interface EvidenceRow extends SqliteRow {
  id: string;
  entity_type: string;
  entity_id: string;
  source_record_id: string;
  role: string;
  locator_json: string | null;
}
type ClinicalTable = 'medications' | 'procedures';
type ClinicalRow = MedicationRow | ProcedureRow;
export type ObservationDTO = Observation & Record<string, unknown>;
export type MedicationDTO = Medication & Record<string, unknown>;
export type ProcedureDTO = Procedure & Record<string, unknown>;
export type SourceRecordDTO = SourceRecord & Record<string, unknown>;
export type SourceRecordReferenceDTO = SourceRecordReference & Record<string, unknown>;
type ClinicalItem = MedicationDTO | ProcedureDTO;
type ClinicalRedirect = NonNullable<ReturnType<typeof clinicalRedirect>>;
interface Page<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  complete: boolean;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nested = (value: unknown, key: string): Record<string, unknown> =>
  isRecord(value) && isRecord(value[key]) ? value[key] : {};
const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const count = (db: Database, sql: string, args: string[]): number =>
  Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);

export function pagination(params: URLSearchParams): { limit: number; offset: number } {
  return {
    limit: Math.min(200, Math.max(1, Number(params.get('limit')) || 50)),
    offset: Math.max(0, Number(params.get('offset')) || 0),
  };
}
export function documentPersonId(extra: unknown): string {
  const imported = nested(typeof extra === 'string' ? json(extra) : extra, 'import');
  return typeof imported.personId === 'string' && imported.personId ? imported.personId : 'patient';
}
export function clinicalPeople(db: Database): ClinicalPersonOption[] {
  return db
    .prepare(
      `SELECT n.id,n.person_id,n.title,json_extract(n.profile_json,'$.birthDate') AS birth_date,json_extract(n.profile_json,'$.icon') AS icon FROM notes n WHERE n.kind='person' AND n.person_id <> 'patient' AND ${noteVisibilitySQL('n')}=0 ORDER BY n.title COLLATE NOCASE,n.id`,
    )
    .all()
    .map((row) => ({
      personId: String(row.person_id),
      noteId: String(row.id),
      name: String(row.title),
      birthDate: typeof row.birth_date === 'string' ? row.birth_date : null,
      icon: typeof row.icon === 'string' ? row.icon : null,
    }));
}
export function clinicalPerson(db: Database, personId: string) {
  if (personId === 'patient') return { personId, noteId: null, name: 'Self' };
  const row = required(
    db
      .prepare("SELECT id,title FROM notes WHERE kind='person' AND person_id=? ORDER BY id LIMIT 1")
      .get(personId),
    'Person not found',
  );
  return { personId, noteId: String(row.id), name: String(row.title) };
}
export function documents(db: Database, params: URLSearchParams) {
  const personId = params.get('personId') || 'patient';
  const conditions = [
    "COALESCE(json_extract(extra_json,'$.import.personId'),'patient')=?",
    visibilityCondition(params, visibilitySQL("'document'", 'documents.id')),
  ];
  const args = [personId];
  if (params.get('q')) {
    conditions.push('(title LIKE ? OR text_content LIKE ?)');
    args.push('%' + params.get('q') + '%', '%' + params.get('q') + '%');
  }
  const where = ' WHERE ' + conditions.join(' AND ');
  const page = pagination(params);
  const rows = db
    .prepare('SELECT * FROM documents' + where + ' ORDER BY effective_at DESC,id LIMIT ? OFFSET ?')
    .all(...args, page.limit, page.offset);
  const total = count(db, 'SELECT count(*) AS n FROM documents' + where, args);
  return {
    data: rows.map((row) => ({
      id: String(row.id),
      personId,
      title: String(row.title),
      date: row.effective_at,
    })),
    total,
    ...page,
    complete: page.offset === 0 && rows.length === total,
  };
}
export const providerList = (db: Database): Provider[] =>
  db
    .prepare('SELECT id,name FROM providers ORDER BY name')
    .all()
    .map((row) => ({ id: String(row.id), name: String(row.name) }));
export function observation(row: ObservationRow): ObservationDTO {
  return {
    id: row.id,
    personId: row.person_id,
    testTypeId: row.test_type_id,
    label: row.label,
    date: row.effective_at,
    datePrecision: row.date_precision,
    valueText: row.value_text,
    value: row.value_numeric,
    comparator: row.comparator,
    unit: row.unit,
    reference: json(row.reference_json),
    status: row.status,
    providerId: row.provider_id,
    provider: row.provider_name,
    sourceRecordId: row.source_record_id,
    reportId: row.report_id,
    extra: json(row.extra_json),
  };
}
const obsSelect =
  'SELECT o.*, p.name AS provider_name FROM observations o LEFT JOIN providers p ON p.id=o.provider_id';
function obsWhere(params: URLSearchParams, prefix = 'o'): { sql: string; args: string[] } {
  const conditions = [
      `${prefix}.person_id=?`,
      visibilityCondition(params, visibilitySQL("'observation'", `${prefix}.id`)),
    ],
    args: string[] = [params.get('personId') || 'patient'];
  for (const [param, column, operator] of [
    ['testTypeId', 'test_type_id', '='],
    ['providerId', 'provider_id', '='],
    ['from', 'effective_at', '>='],
    ['to', 'effective_at', '<='],
  ]) {
    const value = params.get(param);
    if (value) {
      conditions.push(`${prefix}.${column} ${operator} ?`);
      args.push(param === 'to' && value.length === 10 ? value + 'T23:59:59.999Z' : value);
    }
  }
  const q = params.get('q');
  if (q) {
    conditions.push(
      `(${prefix}.label LIKE ? OR ${prefix}.value_text LIKE ? OR ${prefix}.test_type_id IN (SELECT id FROM test_types WHERE aliases_json LIKE ? OR category LIKE ?))`,
    );
    args.push(...Array(4).fill('%' + q + '%'));
  }
  return { sql: ' WHERE ' + conditions.join(' AND '), args };
}
export function observations(
  db: Database,
  params: URLSearchParams,
  all = false,
): Page<ObservationDTO> {
  const w = obsWhere(params),
    p = pagination(params);
  const total = count(db, 'SELECT COUNT(*) AS n FROM observations o' + w.sql, w.args);
  const rows = db
    .prepare(
      obsSelect +
        w.sql +
        ` ORDER BY o.effective_at ${params.get('sort') === 'oldest' ? 'ASC' : 'DESC'},o.id` +
        (all ? '' : ' LIMIT ? OFFSET ?'),
    )
    .all(...w.args, ...(all ? [] : [p.limit, p.offset]));
  return {
    data: rows.map((valueRow) => {
      const row = valueRow as ObservationRow;
      return {
        ...observation(row),
        archived: visibilityState(db, 'observation', row.id).archived,
      };
    }),
    total,
    ...p,
    complete: all || (p.offset === 0 && rows.length === total),
  };
}
export function getObservation(db: Database, id: string) {
  const redirect = clinicalRedirect(db, 'observation', id);
  if (redirect) return redirect;
  return {
    ...observation(
      required(db.prepare(obsSelect + ' WHERE o.id=?').get(id) as ObservationRow | undefined),
    ),
    archived: visibilityState(db, 'observation', id).archived,
  };
}
export function testTypes(db: Database, params: URLSearchParams): TestType[] {
  const args: string[] = [],
    conditions = [visibilityCondition(params, visibilitySQL("'test_type'", 't.id'))];
  if (params.get('q')) {
    conditions.push('(t.label LIKE ? OR t.category LIKE ? OR t.aliases_json LIKE ?)');
    args.push(...Array(3).fill('%' + params.get('q') + '%'));
  }
  let join = 'LEFT JOIN observations o ON o.test_type_id=t.id AND o.person_id=?';
  const joinArgs: string[] = [params.get('personId') || 'patient'];
  for (const [param, col, op] of [
    ['providerId', 'provider_id', '='],
    ['from', 'effective_at', '>='],
    ['to', 'effective_at', '<='],
  ]) {
    const value = params.get(param);
    if (!value) continue;
    join += ` AND o.${col}${op}?`;
    joinArgs.push(param === 'to' && value.length === 10 ? value + 'T23:59:59.999Z' : value);
  }
  const rows = db
    .prepare(
      `SELECT t.*,COUNT(o.id) AS count,COUNT(CASE WHEN o.value_numeric IS NOT NULL AND (o.comparator IS NULL OR o.comparator='=') THEN 1 END) AS numeric_count,MIN(o.effective_at) AS first_date,MAX(o.effective_at) AS last_date FROM test_types t ${join}${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''} GROUP BY t.id HAVING COUNT(o.id)>0 ORDER BY t.label,t.unit`,
    )
    .all(...joinArgs, ...args);
  return rows.map((valueRow) => {
    const r = valueRow as TestTypeRow;
    return {
      id: r.id,
      label: r.label,
      category: r.category,
      unit: r.unit,
      archived: visibilityState(db, 'test_type', r.id).archived,
      aliases: stringArray(json(r.aliases_json, [])),
      codes: Array.isArray(json(r.codes_json, [])) ? (json(r.codes_json, []) as unknown[]) : [],
      context: r.context,
      count: r.count,
      numericCount: r.numeric_count,
      firstDate: r.first_date,
      lastDate: r.last_date,
    };
  });
}
export function trends(
  db: Database,
  params: URLSearchParams,
  context?: { root: string; profileId: string },
): Trend[] {
  const unit = params.get('unit');
  if (unit && (!context || resolveMeasurementUnit(unit).status !== 'supported'))
    throw new HttpError(400, 'MEASUREMENT_UNIT', 'Choose a supported display unit');
  const ids = [...new Set((params.get('ids') || '').split(',').filter(Boolean))];
  if (ids.length > 12) throw new Error('Choose at most 12 measurements');
  const types = testTypes(
    db,
    new URLSearchParams({ visibility: 'all', personId: params.get('personId') || 'patient' }),
  );
  const result = ids.map((id) => {
    const test = required(
      types.find((t) => t.id === id),
      'Measurement not found',
    );
    const p = new URLSearchParams(params);
    p.delete('q');
    p.set('testTypeId', id);
    p.set('sort', 'oldest');
    p.set('visibility', 'all');
    const points = observations(db, p, true).data;
    return {
      test,
      points,
      complete: true as const,
      unplottableCount: points.filter(
        (p) => p.value === null || (p.comparator && p.comparator !== '=') || !p.date,
      ).length,
    };
  });
  const points = result.flatMap((trend) => trend.points);
  if (unit && context && points.length) {
    const accepted = acceptedMeasurements(
      db,
      context.root,
      context.profileId,
      points.map((point) => ({ kind: 'observation', recordId: point.id })),
    );
    for (let index = 0; index < points.length; index++) {
      const source = accepted.measurements[index]!;
      const derived = deriveMeasurement(source, unit);
      if (source.semanticStatus === 'stale') derived.status = 'stale_semantics';
      points[index]!.measurement = derived;
    }
  }
  if (points.length) {
    const profileId = String(
      required(db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()).value,
    );
    const projections = clinicalRelationshipProjections(
      db,
      profileId,
      points.map((point) => ({ kind: 'observation', recordId: point.id })),
    );
    for (let index = 0; index < points.length; index++) {
      const projection = projections[index]!;
      if (
        !projection.relationships.length &&
        !projection.legacyPairs.length &&
        !projection.truncated
      )
        continue;
      points[index]!.relationship = {
        display: projection.display,
        hasProviderAmendment: projection.relationships.some(
          (entry) =>
            entry.status === 'current' &&
            entry.request.action === 'provider_amendment' &&
            entry.request.mode === 'confirm',
        ),
        relatedRecordIds: [
          ...new Set(
            projection.relationships
              .flatMap((entry) => [entry.request.left.recordId, entry.request.right.recordId])
              .filter((id) => id !== points[index]!.id),
          ),
        ],
        truncated: projection.truncated,
      };
    }
  }
  return result;
}
export function medication(
  r: MedicationRow,
): Omit<Medication, 'archived' | 'visibilityVersion'> & Record<string, unknown> {
  const raw = json(r.source_raw_json),
    extra = json(r.extra_json);
  const rawRecord = isRecord(raw) ? raw : {},
    rawData = nested(rawRecord, 'data'),
    extraRecord = isRecord(extra) ? extra : {},
    sourceFields = nested(extraRecord, 'sourceFields');
  const recordedDate = [
    rawData.recordedDate,
    rawRecord.recordedDate,
    sourceFields.recordedDate,
  ].find((value) => typeof value === 'string' && value.trim());
  return {
    id: r.id,
    personId: r.person_id,
    label: r.label,
    kind: r.kind,
    status: r.status,
    currentStatus: r.current_status ?? 'unknown',
    currentStatusVersion: r.current_status_version ?? 0,
    currentStatusUpdatedAt: managedTimestamp(r.current_status_updated_at ?? null),
    currentStatusAssertion: json(r.current_status_assertion_json),
    sourceRecordedDate: typeof recordedDate === 'string' ? recordedDate : null,
    doseText: r.dose_text,
    route: r.route,
    frequency: r.frequency,
    startAt: r.start_at,
    endAt: r.end_at,
    provider: r.provider_name,
    sourceRecordId: r.source_record_id,
    extra,
  };
}
export function procedure(r: ProcedureRow): Omit<Procedure, 'archived'> & Record<string, unknown> {
  return {
    id: r.id,
    personId: r.person_id,
    label: r.label,
    category: r.category,
    date: r.effective_at,
    status: r.status,
    provider: r.provider_name,
    sourceRecordId: r.source_record_id,
    extra: json(r.extra_json),
  };
}
export function clinicalList(
  db: Database,
  table: 'medications',
  params: URLSearchParams,
): Page<MedicationDTO>;
export function clinicalList(
  db: Database,
  table: 'procedures',
  params: URLSearchParams,
): Page<ProcedureDTO>;
export function clinicalList(
  db: Database,
  table: 'medications',
  params: URLSearchParams,
  id: string,
): MedicationDTO | ClinicalRedirect;
export function clinicalList(
  db: Database,
  table: 'procedures',
  params: URLSearchParams,
  id: string,
): ProcedureDTO | ClinicalRedirect;
export function clinicalList(
  db: Database,
  table: ClinicalTable,
  params: URLSearchParams,
  id: string | undefined,
): Page<ClinicalItem> | ClinicalItem | ClinicalRedirect;
export function clinicalList(
  db: Database,
  table: ClinicalTable,
  params: URLSearchParams,
  id?: string,
): Page<ClinicalItem> | ClinicalItem | ClinicalRedirect {
  if (id) {
    const redirect = clinicalRedirect(db, table === 'medications' ? 'medication' : 'procedure', id);
    if (redirect) return redirect;
  }
  const base =
    `FROM ${table} r LEFT JOIN providers p ON p.id=r.provider_id` +
    (table === 'medications'
      ? ' LEFT JOIN medication_preferences mp ON mp.medication_id=r.id LEFT JOIN source_records sr ON sr.id=r.source_record_id'
      : '');
  const select =
    'SELECT r.*,p.name AS provider_name' +
    (table === 'medications'
      ? ',mp.status AS current_status,mp.version AS current_status_version,mp.updated_at AS current_status_updated_at,mp.assertion_json AS current_status_assertion_json,sr.raw_json AS source_raw_json '
      : ' ');
  const present = (row: ClinicalRow, includeHistory = false): ClinicalItem => {
    const visibility = visibilityState(
      db,
      table === 'medications' ? 'medication' : 'procedure',
      row.id,
    );
    if (table === 'medications') {
      const item = medication(row as MedicationRow);
      return {
        ...item,
        archived: visibility.archived || item.currentStatus === 'not_current',
        visibilityVersion: visibility.version,
        ...(includeHistory ? { archiveHistory: visibility.history } : {}),
      };
    }
    return { ...procedure(row as ProcedureRow), archived: visibility.archived };
  };
  if (id)
    return present(
      required(db.prepare(select + base + ' WHERE r.id=?').get(id) as ClinicalRow | undefined),
      true,
    );
  const args: string[] = [params.get('personId') || 'patient'],
    w = ['r.person_id=?'];
  if (table === 'procedures')
    w.push(visibilityCondition(params, visibilitySQL("'procedure'", 'r.id')));
  if (table === 'medications') {
    const requested = params.get('status') || 'current';
    // Old serialized unreviewed links resolve to Inactive. Historic unknown
    // assertions stay stored as-is; they are not rewritten merely to render this view.
    const aliases: Record<string, string> = {
      active: 'current',
      inactive: 'archived',
      unknown: 'archived',
      unreviewed: 'archived',
    };
    const status = aliases[requested] || requested;
    const archived = `(${visibilitySQL("'medication'", 'r.id')}=1 OR COALESCE(mp.status,'unknown')='not_current')`;
    if (status === 'current') w.push(`mp.status='current' AND NOT ${archived}`);
    else if (status === 'archived')
      w.push(`(${archived} OR COALESCE(mp.status,'unknown')='unknown')`);
    else if (status !== 'all')
      throw new HttpError(
        400,
        'INVALID_STATUS',
        'Choose current, archived, or all prescription records',
      );
  }
  if (table === 'procedures') {
    const category = params.get('category') || 'clinical';
    if (category === 'clinical') w.push("r.category NOT IN ('laboratory','pathology')");
    else if (category === 'tests') w.push("r.category IN ('laboratory','pathology')");
    else if (category === 'all') {
      /* All retained classifications remain available. */
    } else if (
      [
        'surgery',
        'clinical_procedure',
        'imaging',
        'laboratory',
        'pathology',
        'unspecified',
      ].includes(category)
    ) {
      w.push('r.category=?');
      args.push(category);
    } else
      throw new HttpError(
        400,
        'INVALID_CATEGORY',
        'Choose clinical, tests, all, or a supported procedure category',
      );
  }
  const search = params.get('q');
  if (search) {
    w.push('(r.label LIKE ? OR r.extra_json LIKE ?)');
    args.push(...Array(2).fill('%' + search + '%'));
  }
  const providerId = params.get('providerId');
  if (providerId) {
    w.push('r.provider_id=?');
    args.push(providerId);
  }
  const where = ' WHERE ' + w.join(' AND '),
    pg = pagination(params),
    total = count(db, 'SELECT COUNT(*) AS n ' + base + where, args);
  const rows = db
    .prepare(
      select +
        base +
        where +
        ' ORDER BY r.' +
        (table === 'medications' ? 'start_at' : 'effective_at') +
        ' DESC,r.id LIMIT ? OFFSET ?',
    )
    .all(...args, pg.limit, pg.offset);
  return {
    data: rows.map((row) => present(row as ClinicalRow)),
    ...pg,
    total,
    complete: pg.offset === 0 && rows.length === total,
  };
}
function medicationStatusInput(value: unknown): {
  status: MedicationCurrentStatus;
  version: number;
  visibilityVersion: number;
} {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['status', 'version', 'visibilityVersion'].includes(key)) ||
    !['current', 'not_current', 'unknown'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 0 ||
    !Number.isSafeInteger(value.visibilityVersion) ||
    Number(value.visibilityVersion) < 0
  )
    throw new HttpError(
      400,
      'INVALID_INPUT',
      'Supply personal status, its version, and the current visibility version',
    );
  return value as {
    status: MedicationCurrentStatus;
    version: number;
    visibilityVersion: number;
  };
}
export function setMedicationCurrentStatus(db: Database, id: string, value: unknown) {
  const input = medicationStatusInput(value);
  transaction(db, () => {
    appendMedicationPreference(db, id, input);
    appendVisibilityEvent(db, 'medication', id, {
      archived: input.status === 'not_current',
      version: input.visibilityVersion,
    });
  });
  return clinicalList(db, 'medications', new URLSearchParams(), id);
}
export type SourceFileDTO = SourceFile & Record<string, unknown>;
export function sourceFile(db: Database, r: SourceFileRow): SourceFileDTO {
  const details = sourceFileDetails(db, r);
  const intakeMetadata = nested(nested(details, 'intake'), 'metadata');
  return {
    id: r.id,
    providerId: r.provider_id,
    provider: r.provider_name,
    reviewedSourceProviderId:
      typeof intakeMetadata.sourceProviderId === 'string' ? intakeMetadata.sourceProviderId : null,
    reviewedSource: typeof intakeMetadata.source === 'string' ? intakeMetadata.source : null,
    path: r.path,
    sha256: r.sha256,
    bytes: r.bytes,
    mimeType: r.mime_type,
    kind: r.kind,
    coverageStatus: r.coverage_status,
    details,
    contentUrl: '/api/sources/' + encodeURIComponent(r.id) + '/content',
  };
}
export function getSourceFile(db: Database, id: string): SourceFileDTO {
  return {
    archived: visibilityState(db, 'source_file', id).archived,
    ...sourceFile(
      db,
      required(
        db
          .prepare(
            'SELECT f.*,p.name AS provider_name FROM source_files f LEFT JOIN providers p ON p.id=f.provider_id WHERE f.id=?',
          )
          .get(id) as SourceFileRow | undefined,
      ),
    ),
  };
}
interface SourceFileReferenceNode {
  file: SourceFileReference;
  parentSourceFileId: string | null;
}
function getSourceFileReference(db: Database, id: string): SourceFileReferenceNode {
  const row = required(
    db
      .prepare(
        `SELECT f.id,f.provider_id,p.name AS provider_name,f.path,f.sha256,f.bytes,
                f.mime_type,f.kind,f.coverage_status,
                json_extract(f.details_json,'$.intake.metadata.sourceProviderId') AS reviewed_source_provider_id,
                json_extract(f.details_json,'$.intake.metadata.source') AS reviewed_source,
                json_extract(f.details_json,'$.intake.parentSourceFileId') AS parent_source_file_id
         FROM source_files f
         LEFT JOIN providers p ON p.id=f.provider_id
         WHERE f.id=?`,
      )
      .get(id) as SourceFileReferenceRow | undefined,
  );
  return {
    file: {
      archived: visibilityState(db, 'source_file', row.id).archived,
      id: row.id,
      providerId: row.provider_id,
      provider: row.provider_name,
      reviewedSourceProviderId:
        typeof row.reviewed_source_provider_id === 'string'
          ? row.reviewed_source_provider_id
          : null,
      reviewedSource: typeof row.reviewed_source === 'string' ? row.reviewed_source : null,
      path: row.path,
      sha256: row.sha256,
      bytes: row.bytes,
      mimeType: row.mime_type,
      kind: row.kind,
      coverageStatus: row.coverage_status,
      contentUrl: '/api/sources/' + encodeURIComponent(row.id) + '/content',
      detailsUrl: '/api/sources/' + encodeURIComponent(row.id),
      detailsIncluded: false,
    },
    parentSourceFileId:
      typeof row.parent_source_file_id === 'string' ? row.parent_source_file_id : null,
  };
}
export function sourceFiles(db: Database, params: URLSearchParams): Page<SourceFileDTO> {
  const pg = pagination(params),
    args: string[] = [],
    where = [visibilityCondition(params, visibilitySQL("'source_file'", 'f.id'))];
  for (const [key, col] of [
    [
      'providerId',
      "COALESCE(json_extract(f.details_json,'$.intake.metadata.sourceProviderId'),f.provider_id)",
    ],
    ['acquisitionProviderId', 'f.provider_id'],
    [
      'reviewedSourceProviderId',
      "json_extract(f.details_json,'$.intake.metadata.sourceProviderId')",
    ],
    ['kind', 'f.kind'],
  ]) {
    const value = params.get(key);
    if (!value) continue;
    where.push(col + '=?');
    args.push(value);
  }
  const search = params.get('q');
  const searchPlan = search ? sourceDetailsSearch(db, search) : null;
  try {
    if (searchPlan) {
      where.push(searchPlan.predicate);
      args.push(...searchPlan.parameters);
    }
    const from =
      ' FROM source_files f LEFT JOIN providers p ON p.id=f.provider_id' +
      (searchPlan?.joins || '') +
      (where.length ? ' WHERE ' + where.join(' AND ') : '');
    const total = count(db, 'SELECT COUNT(*) AS n' + from, args);
    const data = db
      .prepare('SELECT f.*,p.name AS provider_name' + from + ' ORDER BY f.path LIMIT ? OFFSET ?')
      .all(...args, pg.limit, pg.offset)
      .map((valueRow) => {
        const row = valueRow as SourceFileRow;
        recordSourceDetailsSearchDTORead(db, row.details_json);
        return {
          ...sourceFile(db, row),
          archived: visibilityState(db, 'source_file', row.id).archived,
        };
      });
    return {
      data,
      total,
      ...pg,
      complete: pg.offset === 0 && data.length === total,
    };
  } catch (error) {
    searchPlan?.dispose(error);
    throw error;
  } finally {
    searchPlan?.dispose();
  }
}
export function sourceRecord(r: SourceRecordRow): SourceRecordDTO {
  return {
    id: r.id,
    sourceFileId: r.source_file_id,
    providerId: r.provider_id,
    provider: r.provider_name,
    sourceKey: r.source_key,
    kind: r.kind,
    label: r.label,
    date: r.date_text,
    raw: json(r.raw_json),
    rawText: r.raw_json,
    locator: json(r.locator_json),
    extractionStatus: r.extraction_status,
  };
}
export function sourceRecordFileView(params: URLSearchParams): SourceRecordFileView {
  const values = params.getAll('fileView');
  if (!values.length) return 'full';
  if (values.length !== 1 || !['full', 'reference'].includes(values[0]!))
    throw new HttpError(400, 'INVALID_INPUT', 'Choose one full or reference source-file view');
  return values[0] as SourceRecordFileView;
}
export function getSourceRecord(db: Database, id: string): SourceRecordDTO;
export function getSourceRecord(
  db: Database,
  id: string,
  options: { fileView: 'reference' },
): SourceRecordReferenceDTO;
export function getSourceRecord(
  db: Database,
  id: string,
  options: { fileView?: 'full' },
): SourceRecordDTO;
export function getSourceRecord(
  db: Database,
  id: string,
  options: { fileView: SourceRecordFileView },
): SourceRecordDTO | SourceRecordReferenceDTO;
export function getSourceRecord(
  db: Database,
  id: string,
  { fileView = 'full' }: { fileView?: SourceRecordFileView } = {},
): SourceRecordDTO | SourceRecordReferenceDTO {
  if (!['full', 'reference'].includes(fileView))
    throw new HttpError(400, 'INVALID_INPUT', 'Choose a full or reference source-file view');
  const base = sourceRecord(
    required(
      db
        .prepare(
          `SELECT r.*,p.name AS provider_name
           FROM source_records r
           LEFT JOIN providers p ON p.id=r.provider_id
           WHERE r.id=?`,
        )
        .get(id) as SourceRecordRow | undefined,
    ),
  );
  if (fileView === 'reference') {
    const fileNode = getSourceFileReference(db, base.sourceFileId);
    const locator = isRecord(base.locator) ? base.locator : {};
    const originalId = locator.originalSourceFileId;
    let originalNode: SourceFileReferenceNode | null = fileNode,
      originalMissing = false;
    if (typeof originalId === 'string' && originalId !== base.sourceFileId) {
      if (db.prepare('SELECT id FROM source_files WHERE id=?').get(originalId))
        originalNode = getSourceFileReference(db, originalId);
      else {
        originalNode = null;
        originalMissing = true;
      }
    }
    const ancestorFiles: SourceFileReference[] = [];
    const seen = new Set([base.sourceFileId, originalId]);
    let parentId = originalNode?.parentSourceFileId;
    while (typeof parentId === 'string' && !seen.has(parentId) && ancestorFiles.length < 8) {
      seen.add(parentId);
      if (!db.prepare('SELECT id FROM source_files WHERE id=?').get(parentId)) break;
      const parent = getSourceFileReference(db, parentId);
      ancestorFiles.push(parent.file);
      parentId = parent.parentSourceFileId;
    }
    const relationships = db
      .prepare(
        'SELECT * FROM record_relationships WHERE from_record_id=? OR to_record_id=? ORDER BY id',
      )
      .all(id, id);
    return {
      ...base,
      archived: visibilityState(db, 'source', id).archived,
      fileView: 'reference',
      file: fileNode.file,
      extractionFile: fileNode.file,
      originalFile: originalNode?.file ?? null,
      originalMissing,
      ancestorFiles,
      relationships,
    };
  }
  const file = getSourceFile(db, base.sourceFileId);
  const locator = isRecord(base.locator) ? base.locator : {};
  const originalId = locator.originalSourceFileId;
  let originalFile: SourceFileDTO | null = file,
    originalMissing = false;
  if (typeof originalId === 'string' && originalId !== base.sourceFileId) {
    if (db.prepare('SELECT id FROM source_files WHERE id=?').get(originalId))
      originalFile = getSourceFile(db, originalId);
    else {
      originalFile = null;
      originalMissing = true;
    }
  }
  const ancestorFiles: SourceFileDTO[] = [];
  const seen = new Set([base.sourceFileId, originalId]);
  let parentId = nested(originalFile?.details, 'intake').parentSourceFileId;
  while (typeof parentId === 'string' && !seen.has(parentId) && ancestorFiles.length < 8) {
    seen.add(parentId);
    if (!db.prepare('SELECT id FROM source_files WHERE id=?').get(parentId)) break;
    const parent = getSourceFile(db, parentId);
    ancestorFiles.push(parent);
    parentId = nested(parent.details, 'intake').parentSourceFileId;
  }
  const relationships = db
    .prepare(
      'SELECT * FROM record_relationships WHERE from_record_id=? OR to_record_id=? ORDER BY id',
    )
    .all(id, id);
  return {
    ...base,
    archived: visibilityState(db, 'source', id).archived,
    file,
    extractionFile: file,
    originalFile,
    originalMissing,
    ancestorFiles,
    relationships,
  };
}
export function sourceRecords(db: Database, params: URLSearchParams): Page<SourceRecordDTO> {
  const pg = pagination(params),
    args: string[] = [],
    w = [visibilityCondition(params, visibilitySQL("'source'", 'r.id'))];
  const ownership = params.getAll('ownership');
  if (ownership.length > 1 || (ownership.length === 1 && ownership[0] !== 'unresolved'))
    throw new HttpError(400, 'INVALID_OWNERSHIP_FILTER', 'Use ownership=unresolved once');
  if (ownership.length) {
    const boundary = sourceAssertionBoundary('r');
    w.push(boundary.disclosure, 'NOT ' + boundary.singleOwner);
  }
  const originalSourceFileId = params.get('originalSourceFileId');
  if (originalSourceFileId) {
    w.push(`(
      r.source_file_id=? OR (
        json_extract(r.locator_json,'$.originalSourceFileId')=? AND
        EXISTS (
          SELECT 1 FROM source_files proposal
          WHERE proposal.id=r.source_file_id
            AND proposal.kind='intake_proposal'
            AND json_extract(proposal.details_json,'$.originalSourceFileId')=?
        )
      )
    )`);
    args.push(originalSourceFileId, originalSourceFileId, originalSourceFileId);
  }
  for (const [key, col] of [
    ['sourceFileId', 'r.source_file_id'],
    ['providerId', 'r.provider_id'],
    ['kind', 'r.kind'],
  ]) {
    const value = params.get(key);
    if (!value) continue;
    w.push(col + '=?');
    args.push(value);
  }
  const search = params.get('q');
  if (search) {
    w.push('(r.label LIKE ? OR r.raw_json LIKE ?)');
    args.push(...Array(2).fill('%' + search + '%'));
  }
  const where = w.length ? ' WHERE ' + w.join(' AND ') : '';
  const from = ' FROM source_records r LEFT JOIN providers p ON p.id=r.provider_id' + where;
  const total = count(db, 'SELECT COUNT(*) AS n' + from, args);
  const data = db
    .prepare('SELECT r.*,p.name AS provider_name' + from + ' ORDER BY r.id LIMIT ? OFFSET ?')
    .all(...args, pg.limit, pg.offset)
    .map((valueRow) => {
      const row = valueRow as SourceRecordRow;
      return {
        ...sourceRecord(row),
        archived: visibilityState(db, 'source', row.id).archived,
      };
    });
  return {
    data,
    ...pg,
    total,
    complete: pg.offset === 0 && data.length === total,
  };
}
export const coverage = (db: Database): Record<string, number> =>
  Object.fromEntries(
    db
      .prepare(
        'SELECT extraction_status AS status,COUNT(*) AS n FROM source_records GROUP BY extraction_status',
      )
      .all()
      .map((r) => [String(r.status), Number(r.n)]),
  );

export function evidenceFor(db: Database, entityType: string, entityId: string): Evidence[] {
  const resolved = resolveClinicalReference(db, entityType, entityId);
  if (resolved) {
    entityType = resolved.kind;
    entityId = resolved.recordId;
  }
  return db
    .prepare('SELECT * FROM evidence WHERE entity_type=? AND entity_id=? ORDER BY id')
    .all(entityType, entityId)
    .map((valueRow) => {
      const r = valueRow as EvidenceRow;
      return {
        id: r.id,
        sourceRecordId: r.source_record_id,
        role: r.role,
        locator: json(r.locator_json),
      };
    });
}

/** Raw reverse provenance for the four accepted clinical record kinds. */
export function sourceRecordClinicalEvidence(
  db: Database,
  sourceRecordId: string,
  params: URLSearchParams,
): Page<SourceRecordClinicalEvidence> {
  required(
    db.prepare('SELECT id FROM source_records WHERE id=?').get(sourceRecordId),
    'Source record not found',
  );
  const scopes = params.getAll('scope');
  if (scopes.length !== 1 || scopes[0] !== 'clinical')
    throw new HttpError(400, 'INVALID_INPUT', 'Use scope=clinical for source evidence.');
  for (const [name, minimum] of [
    ['limit', 1],
    ['offset', 0],
  ] as const) {
    const values = params.getAll(name);
    if (values.length > 1) {
      throw new HttpError(400, 'INVALID_INPUT', `Use one whole-number ${name}.`);
    }
    if (!values.length) continue;
    const value = Number(values[0]);
    if (!/^\d+$/.test(values[0]) || !Number.isSafeInteger(value) || value < minimum)
      throw new HttpError(400, 'INVALID_INPUT', `Use one whole-number ${name}.`);
  }
  const page = pagination(params);
  const args = [sourceRecordId];
  const clinical =
    "source_record_id=? AND entity_type IN ('observation','medication','procedure','document')";
  const total = count(db, `SELECT COUNT(*) AS n FROM evidence WHERE ${clinical}`, args);
  const data = db
    .prepare(`SELECT * FROM evidence WHERE ${clinical} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...args, page.limit, page.offset)
    .map((valueRow) => {
      const row = valueRow as EvidenceRow;
      return {
        id: row.id,
        entityType: row.entity_type as ClinicalEvidenceEntityType,
        entityId: row.entity_id,
        sourceRecordId: row.source_record_id,
        role: row.role,
        locator: json(row.locator_json),
      };
    });
  return {
    data,
    ...page,
    total,
    complete: page.offset === 0 && data.length === total,
  };
}
