/** Process-local validation metadata. Never infer diagnostics from exception prose. */
export interface DiagnosticValidation {
  code: string;
  path: string;
  line?: number;
}
const metadata = new WeakMap<object, DiagnosticValidation>();
const problems = new Set([
  'invalid_json',
  'invalid_encoding',
  'row_limit',
  'empty_input',
  'invalid_envelope',
  'invalid_id',
  'invalid_kind_or_payload',
  'invalid_provenance',
  'invalid_coverage',
  'invalid_context_id',
  'invalid_report',
  'invalid_people',
  'invalid_batch_coverage',
  'nesting_too_deep',
  'outside_allowed_choices',
  'expected_object',
  'missing_required_field',
  'unknown_field',
  'expected_array',
  'invalid_array_length',
  'invalid_text',
  'invalid_number',
  'invalid_boolean',
]);
const pathKeys = new Set([
  'arguments',
  'id',
  'version',
  'planId',
  'operationId',
  'jsonlText',
  'coverage',
  'unitId',
  'kind',
  'notes',
  'summary',
  'runId',
  'sourceTextRevisionId',
  'format',
  'payload',
  'provenance',
  'clinical',
  'people',
  'contextId',
  'report',
  'capturedVia',
  'sourceSystem',
  'sourceRecordId',
  'locator',
  'evidenceClass',
  'status',
  'key',
  'title',
  'anchor',
  'subject',
  'memberId',
  'section',
  'text',
  'action',
  'page',
  'offset',
  'limit',
  'query',
  'revisionId',
  'reviewIssues',
  'field',
  'choices',
  'value',
  'label',
  'date',
  'documentDate',
  'testLabel',
  'valueText',
  'unit',
  'name',
  'fullName',
  'birthDate',
  'roles',
  'role',
  'reason',
  'jsonPointer',
  'jsonOffset',
  'recordId',
  'scopeToken',
  'evidenceId',
  'changes',
  'fields',
  'sourceHash',
]);
export function safeDiagnosticValidationCode(value: string): boolean {
  return problems.has(value);
}
export function diagnosticValidationPath(value: string): string | null {
  if (
    value.length > 320 ||
    !/^(?:arguments|\$)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:\d{1,6}|unknown)?\]){0,24}$/.test(value)
  )
    return null;
  const path = value
    .replace(/\.[A-Za-z_][A-Za-z0-9_]*/g, (part) =>
      pathKeys.has(part.slice(1)) ? part : '[unknown]',
    )
    .replace(/\[\d+\]/g, '[]');
  return path.length <= 160 ? path : null;
}
export function diagnosticValidation(value: unknown): DiagnosticValidation | undefined {
  return value !== null && typeof value === 'object' ? metadata.get(value) : undefined;
}
export function withDiagnosticValidation<T extends object>(
  value: T,
  detail: DiagnosticValidation,
): T {
  const path = diagnosticValidationPath(detail.path);
  if (path && problems.has(detail.code))
    metadata.set(value, {
      code: detail.code,
      path,
      ...(Number.isSafeInteger(detail.line) && detail.line! >= 0 && detail.line! <= 50001
        ? { line: detail.line }
        : {}),
    });
  return value;
}
export function copyDiagnosticValidation<T extends object>(value: T, original: unknown): T {
  const facts = diagnosticContext(original);
  if (facts) withDiagnosticContext(value, facts);
  const detail = diagnosticValidation(original);
  return detail ? withDiagnosticValidation(value, detail) : value;
}
export function diagnosticValidationError(message: string, code: string, path: string): Error {
  return withDiagnosticValidation(new Error(message), { code, path });
}

const contextFacts = new WeakMap<
  object,
  Readonly<Record<string, string | number | boolean | null>>
>();
export function withDiagnosticContext<T extends object>(
  error: T,
  facts: Record<string, string | number | boolean | null>,
): T {
  contextFacts.set(error, Object.freeze({ ...facts }));
  return error;
}
export function diagnosticContext(error: unknown) {
  return error !== null && typeof error === 'object' ? contextFacts.get(error) : undefined;
}
