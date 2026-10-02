import type { ImportDiagnosticArchive, ImportDiagnosticOrigin } from './import-performance.ts';

export interface ImportRecordingCheck {
  checkedAt: string;
  status:
    | 'recording_disabled'
    | 'not_attached'
    | 'current_origin_readable'
    | 'current_origin_unproven'
    | 'inspection_unavailable';
  recording: 'enabled' | 'disabled';
  currentAttachment: ImportDiagnosticArchive['currentAttachment'];
  /** Validated readable evidence, independently of append acknowledgement and historical coverage. */
  currentOriginReadable: boolean;
  archive: { status: ImportDiagnosticArchive['status']; coverageWarnings: boolean };
  completeness: 'not_established';
}

export function sameDiagnosticOrigin(a: ImportDiagnosticOrigin, b: ImportDiagnosticOrigin) {
  return (
    a.windowId === b.windowId &&
    a.attachedAt === b.attachedAt &&
    a.recordingAtAttachment === b.recordingAtAttachment &&
    a.observedBeforeAttachment === b.observedBeforeAttachment
  );
}

/** Input is the archive reader's validated current-format output, never caller-provided evidence. */
export function recordingCheckFromArchive(
  archive: ImportDiagnosticArchive,
  checkedAt: string,
): ImportRecordingCheck {
  const attachment = archive.currentAttachment;
  const readable =
    archive.recording === 'enabled' &&
    !!attachment &&
    archive.currentWindow.windowId === attachment.origin.windowId &&
    archive.windowOrigins.some((origin) => sameDiagnosticOrigin(origin, attachment.origin));
  return {
    checkedAt,
    status:
      archive.recording === 'disabled'
        ? 'recording_disabled'
        : archive.status === 'unavailable'
          ? 'inspection_unavailable'
          : !attachment
            ? 'not_attached'
            : readable
              ? 'current_origin_readable'
              : 'current_origin_unproven',
    recording: archive.recording,
    currentAttachment: attachment,
    currentOriginReadable: readable,
    archive: {
      status: archive.status,
      coverageWarnings: archive.status === 'partial' || archive.status === 'unavailable',
    },
    completeness: 'not_established',
  };
}

const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
/** Reject malformed/inconsistent responses before showing positive evidence or including a check. */
export function isImportRecordingCheck(value: unknown): value is ImportRecordingCheck {
  if (
    !object(value) ||
    !keys(value, [
      'checkedAt',
      'status',
      'recording',
      'currentAttachment',
      'currentOriginReadable',
      'archive',
      'completeness',
    ]) ||
    !date(value.checkedAt) ||
    value.completeness !== 'not_established' ||
    typeof value.recording !== 'string' ||
    !['enabled', 'disabled'].includes(value.recording) ||
    typeof value.currentOriginReadable !== 'boolean' ||
    !object(value.archive) ||
    !keys(value.archive, ['status', 'coverageWarnings']) ||
    typeof value.archive.status !== 'string' ||
    !['available', 'partial', 'unavailable', 'not_attached'].includes(value.archive.status) ||
    value.archive.coverageWarnings !==
      (value.archive.status === 'partial' || value.archive.status === 'unavailable')
  )
    return false;
  const attachment = value.currentAttachment;
  if (attachment !== null) {
    if (
      !object(attachment) ||
      !keys(attachment, ['origin', 'publication']) ||
      !object(attachment.origin) ||
      !keys(attachment.origin, [
        'windowId',
        'attachedAt',
        'recordingAtAttachment',
        'observedBeforeAttachment',
      ])
    )
      return false;
    const origin = attachment.origin;
    if (
      typeof origin.windowId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        origin.windowId,
      ) ||
      !date(origin.attachedAt) ||
      origin.recordingAtAttachment !== value.recording ||
      !Number.isSafeInteger(origin.observedBeforeAttachment) ||
      Number(origin.observedBeforeAttachment) < 0 ||
      typeof attachment.publication !== 'string' ||
      !(value.recording === 'disabled'
        ? attachment.publication === 'disabled'
        : ['confirmed', 'unconfirmed'].includes(attachment.publication))
    )
      return false;
  }
  if ((!attachment || value.archive.status === 'not_attached') && value.currentOriginReadable)
    return false;
  if (value.currentOriginReadable && value.recording !== 'enabled') return false;
  // An attached reader always includes its current attachment, even when no origin is readable.
  if (!attachment && ['available', 'partial'].includes(value.archive.status)) return false;
  if (value.archive.status === 'not_attached' && attachment) return false;
  const expected =
    value.recording === 'disabled'
      ? 'recording_disabled'
      : value.archive.status === 'unavailable'
        ? 'inspection_unavailable'
        : !attachment
          ? 'not_attached'
          : value.currentOriginReadable
            ? 'current_origin_readable'
            : 'current_origin_unproven';
  return value.status === expected;
}
