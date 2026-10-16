/** Read retained correction evidence without treating derived/chart values as edits. */
export type RecordCorrectionEntry = {
  stage: 'import' | 'saved';
  at: string | null;
  reason: string | null;
  changes: { field: string; before: unknown; after: unknown }[];
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Inline arrays remain legacy evidence; this marker requires accepted-contribution paging. */
export function hasReferencedImportCorrections(extra: unknown): boolean {
  return (
    object(object(object(extra).import).correctionHistorySource).format ===
    'health-accepted-contribution-corrections-v1'
  );
}

export function recordCorrections(extra: unknown): RecordCorrectionEntry[] {
  const metadata = object(extra);
  const imported = object(metadata.import);
  return (
    [
      ['import', imported.corrections],
      ['saved', metadata.recordCorrections],
    ] as const
  ).flatMap(([stage, entries]) =>
    (Array.isArray(entries) ? entries : []).flatMap((entry: unknown) => {
      const item = object(entry);
      const before = object(item.before);
      const after = object(item.after);
      const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
        .map((field) => ({ field, before: before[field], after: after[field] }));
      return changes.length
        ? [
            {
              stage,
              at: typeof item.at === 'string' ? item.at : null,
              reason: typeof item.reason === 'string' ? item.reason : null,
              changes,
            },
          ]
        : [];
    }),
  );
}

export function recordCorrectionStages(extra: unknown) {
  const entries = recordCorrections(extra);
  const metadata = object(extra);
  const imported = object(metadata.import);
  const later = entries.some((entry) => entry.stage === 'saved');
  // Legacy individual exceptions may represent a later correction. Do not label
  // those as import edits when their post-save history is present.
  const legacyImport =
    !('manuallyEdited' in imported) &&
    !later &&
    Object.keys(object(object(imported.recordException).set)).some(
      (key) => !['kind', 'subject', 'personId', 'sourceSystem'].includes(key),
    );
  return {
    imported:
      hasReferencedImportCorrections(extra) ||
      imported.manuallyEdited === true ||
      entries.some((entry) => entry.stage === 'import') ||
      legacyImport,
    later,
  };
}
