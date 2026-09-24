const resources = new Set([
  'intakes',
  'intake-batches',
  'import-diagnostics',
  'notes',
  'tests',
  'vision',
  'vision-prescriptions',
  'people',
  'medications',
  'procedures',
  'documents',
  'sources',
  'source-records',
  'assistant',
  'providers',
  'test-types',
  'overview',
  'lock',
  'unlock',
]);
const actions = new Set([
  'import-feed',
  'report-queue',
  'report-acceptance',
  'report-source',
  'identity-scope',
  'identity-review',
  'identity-confirmation',
  'review-draft',
  'review',
  'stop',
  'resume',
  'limits',
  'diagnostics',
  'original',
  'content',
  'people',
  'people-apply',
  'people-disposition',
  'questions',
  'answer',
  'plan',
  'package',
  'navigate',
  'unit',
  'read',
  'convert',
  'proposals',
  'metadata',
  'chats',
  'messages',
]);

/** Only fixed vocabulary and placeholders survive; never IDs, queries, names or filenames. */
export function diagnosticRoute(path: string): string {
  const parts = path.split(/[?#]/)[0]!.split('/').filter(Boolean);
  if (parts[0] === 'api') parts.shift();
  if (parts[0] === 'profiles') {
    if (parts.length === 1) return '/profiles';
    parts.splice(0, 2);
  }
  const resource = resources.has(parts[0] || '') ? parts[0] : ':resource';
  const suffix = parts.slice(1, 4).map((part) => (actions.has(part) ? part : ':item'));
  return `/profiles/:profile/${[resource, ...suffix].join('/')}`;
}

/** The server recorder also rejects raw strings accidentally passed instead of templates. */
export function isDiagnosticRoute(value: string): boolean {
  return value === 'profile_api' || value === diagnosticRoute(value);
}
