import { HttpError, required, json } from './database.ts';
import type { Database } from './database.ts';
import type { FilterView } from '../shared/collection-filters.ts';
import { getHistoricalNote } from './historical-notes.ts';
import { parseCollectionFilters, filterIssue } from '../shared/collection-filters.ts';

type UnknownRecord = Record<string, unknown>;
const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const pages = {
  '/': 'Patient',
  '/tests': 'Test results',
  '/medications': 'Prescriptions',
  '/procedures': 'Procedures',
  '/people': 'People',
  '/notes': 'Notes',
  '/sources': 'Sources',
} as const;
type PagePath = keyof typeof pages;
const collections = [
  'people',
  'notes',
  'results',
  'test_types',
  'medications',
  'procedures',
  'sources',
  'records',
  'documents',
] as const;
type AssistantCollection = (typeof collections)[number];
const collectionSet: ReadonlySet<string> = new Set(collections);
const assistantCollection = (value: unknown): value is AssistantCollection =>
  typeof value === 'string' && collectionSet.has(value);
export interface AssistantSelection {
  collection: AssistantCollection;
  id: string;
}
export interface AssistantContext {
  route?: string;
  intakeId?: string;
  selection?: AssistantSelection;
  /** Strictly resolved by the server before persistence and model use. */
  intakeRepair?: unknown;
}
const allowedByPage = {
  '/': ['people'],
  '/tests': ['results', 'test_types'],
  '/medications': ['medications'],
  '/procedures': ['procedures'],
  '/people': ['people', 'notes', 'documents'],
  '/notes': ['people', 'notes', 'documents'],
  '/sources': ['sources', 'records', 'documents'],
} satisfies Record<PagePath, readonly AssistantCollection[]>;
const pagePath = (value: string): value is PagePath => Object.hasOwn(pages, value);

export function normalizeAssistantContext(input: unknown): AssistantContext {
  const context = object(input) && object(input.context) ? input.context : {},
    route = typeof context.route === 'string' ? context.route.replace(/^#/, '') : '';
  // Filter routes can exceed a single record ID's limit. Never silently cut a
  // serialized filter midway and give the assistant a different view.
  if (route.length > 32000)
    throw new HttpError(
      400,
      'ASSISTANT_CONTEXT',
      'The current page address is too long. Narrow its filters before asking.',
    );
  const result: AssistantContext = {
    ...(/^\/(?!\/)/.test(route) ? { route: '#' + route } : {}),
    ...(typeof context.intakeId === 'string' ? { intakeId: context.intakeId.slice(0, 2000) } : {}),
  };
  if (context.selection !== undefined) {
    const selection = context.selection;
    if (
      !object(selection) ||
      !assistantCollection(selection.collection) ||
      typeof selection.id !== 'string' ||
      !selection.id ||
      selection.id.length > 2000
    )
      throw new HttpError(400, 'ASSISTANT_CONTEXT', 'Invalid selected record context');
    result.selection = {
      collection: selection.collection,
      id: selection.id,
    };
  }
  if (context.intakeRepair !== undefined) {
    if (!object(context.intakeRepair))
      throw new HttpError(400, 'ASSISTANT_CONTEXT', 'Invalid selected import draft context');
    if (JSON.stringify(context.intakeRepair).length > 64000)
      throw new HttpError(
        413,
        'ASSISTANT_CONTEXT',
        'Narrow the selected import drafts before asking',
      );
    result.intakeRepair = context.intakeRepair;
  }
  return result;
}
export function readTestType(db: Database, id: string) {
  const row = required(db.prepare('SELECT * FROM test_types WHERE id=?').get(id));
  return {
    id: row.id,
    label: row.label,
    category: row.category,
    unit: row.unit,
    aliases: json(row.aliases_json),
    codes: json(row.codes_json),
    context: row.context,
    extra: json(row.extra_json),
  };
}
function routeSelection(path: PagePath, params: URLSearchParams): AssistantSelection | null {
  if (path === '/') return { collection: 'people', id: 'patient' };
  const id = params.get('id');
  if (path === '/tests')
    return params.get('view') === 'by-test' && params.get('type')
      ? { collection: 'test_types', id: params.get('type')! }
      : params.get('result')
        ? { collection: 'results', id: params.get('result')! }
        : null;
  if (['/medications', '/procedures'].includes(path) && id)
    return { collection: path === '/medications' ? 'medications' : 'procedures', id };
  if (['/notes', '/people'].includes(path) && id)
    return { collection: path === '/people' ? 'people' : 'notes', id };
  if (path === '/sources')
    for (const [key, collection] of [
      ['document', 'documents'],
      ['record', 'records'],
      ['file', 'sources'],
    ] as const) {
      const selectedId = params.get(key);
      if (selectedId) return { collection, id: selectedId };
    }
  return null;
}
function limited(entry: UnknownRecord): UnknownRecord {
  const serialized = JSON.stringify(entry);
  return serialized.length <= 12000
    ? entry
    : {
        id: entry.id,
        label: entry.label || entry.title,
        sourceRecordId: entry.sourceRecordId,
        appUrl: entry.appUrl,
        truncated: true,
        preview: serialized.slice(0, 12000),
        totalCharacters: serialized.length,
      };
}

/** Resolve identities against this database only. Never trust client-supplied record bodies. */
export function resolveAssistantPage(
  db: Database,
  context: AssistantContext | null | undefined,
  read: (selection: AssistantSelection) => UnknownRecord,
) {
  let url: URL;
  try {
    url = new URL((context?.route || '#/').replace(/^#/, ''), 'https://health.invalid');
  } catch {
    return { status: 'unavailable' };
  }
  const path = url.pathname,
    params = url.searchParams;
  if (!pagePath(path) || url.origin !== 'https://health.invalid') return { status: 'unavailable' };
  const page: {
    name: string;
    route: string;
    filters: Record<string, string>;
    selected: (AssistantSelection & UnknownRecord) | null;
    comparisons: UnknownRecord[];
    contentScope: string;
    collectionFilters?: UnknownRecord;
  } = {
    name: pages[path],
    route: '#' + path + url.search,
    filters: Object.fromEntries(
      [
        'q',
        'view',
        'typeLabel',
        'kind',
        'source',
        'status',
        'category',
        'tag',
        'from',
        'to',
        'providerId',
        'personId',
      ]
        .filter((key) => params.has(key))
        .map((key) => [key, params.get(key)!]),
    ),
    selected: null,
    comparisons: [],
    contentScope:
      'Saved records only; unsaved editor text, screenshots and PDF pixels are not included.',
  };
  if (['/people', '/notes'].includes(path) && params.has('filters')) {
    const view: FilterView | null =
      params.get('kind') === 'historical'
        ? 'historical'
        : path === '/people' || params.get('kind') === 'person'
          ? 'person'
          : null;
    try {
      const rows = parseCollectionFilters(params.get('filters'));
      page.collectionFilters = {
        view,
        match: 'All applied rows; any/all/none within each row as specified',
        conditions: rows.map(({ field, operator, values }) => {
          const issue = view
            ? filterIssue({ field, operator, values }, view)
            : 'Filters do not apply to this view.';
          return { field, operator, values, applied: !issue, ...(issue ? { issue } : {}) };
        }),
      };
    } catch {
      page.collectionFilters = {
        status: 'invalid',
        message: 'The page has invalid filters; do not treat it as an unfiltered list.',
      };
    }
  }
  const fromRoute = routeSelection(path, params);
  let selection: AssistantSelection | null = context?.selection || fromRoute;
  // The route's explicit identity takes precedence over a stale page registration.
  if (fromRoute && selection?.id !== fromRoute.id) selection = fromRoute;
  const allowed: readonly AssistantCollection[] = allowedByPage[path];
  if (selection && !allowed.includes(selection.collection)) selection = fromRoute;
  if (selection) {
    try {
      let entry;
      if (['/people', '/notes'].includes(path) && params.get('kind') === 'historical') {
        const historical = getHistoricalNote(db, selection.id);
        selection = {
          collection: historical.origin === 'provider' ? 'documents' : 'notes',
          id: selection.id,
        };
      }
      entry = read(selection);
      if (path === '/' && selection.id === 'patient') {
        if (typeof entry.title === 'string' && entry.title) page.name = entry.title;
        else if (typeof entry.displayName === 'string' && entry.displayName)
          page.name = entry.displayName;
      }
      page.selected = { ...selection, status: 'available', record: limited(entry) };
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      page.selected = {
        ...selection,
        status: 'not_found',
        message:
          'This entry is not saved in the selected profile. Do not infer its contents or read another profile.',
      };
    }
  }
  if (path === '/tests')
    for (const id of [...new Set((params.get('compare') || '').split(',').filter(Boolean))].slice(
      0,
      11,
    )) {
      try {
        page.comparisons.push({
          id,
          status: 'available',
          record: limited(read({ collection: 'test_types', id })),
        });
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        page.comparisons.push({ id, status: 'not_found' });
      }
    }
  return page;
}
