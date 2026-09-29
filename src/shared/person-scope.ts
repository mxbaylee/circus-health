/** Person selection lives in explicit URLs; sidebar navigation returns to Self. */
export function personScopeRoute(path: string, params: URLSearchParams) {
  const filterable =
    ['/tests', '/medications', '/procedures', '/notes'].includes(path) ||
    (path === '/sources' && (params.get('view') === 'documents' || params.has('document')));
  let target: { type: string; id: string } | null = null;
  const id = params.get('id');
  if (path === '/tests' && params.get('result'))
    target = { type: 'observation', id: params.get('result')! };
  if (path === '/tests' && params.get('document'))
    target = { type: 'document', id: params.get('document')! };
  if (path === '/medications' && id) target = { type: 'medication', id };
  if (path === '/procedures' && id) target = { type: 'procedure', id };
  if (['/notes', '/people'].includes(path) && id && params.get('new') !== '1')
    target = {
      type:
        path === '/people' ? 'person' : params.get('kind') === 'historical' ? 'historical' : 'note',
      id,
    };
  if (
    path === '/notes' &&
    params.get('new') === '1' &&
    params.get('targetType') &&
    params.get('targetId')
  )
    target = { type: params.get('targetType')!, id: params.get('targetId')! };
  if (path === '/sources' && params.get('document'))
    target = { type: 'document', id: params.get('document')! };
  return { filterable, target, scoped: filterable || !!target || path === '/' };
}
export function personSelectionQuery(params: URLSearchParams, personId: string) {
  // Preserve only presentation modes and search; other filters can depend on the old person.
  const next = new URLSearchParams();
  for (const key of ['view', 'kind', 'q', 'sort', 'visibility', 'status', 'category']) {
    const value = params.get(key);
    if (value !== null) next.set(key, value);
  }
  next.set('personId', personId);
  return next;
}
