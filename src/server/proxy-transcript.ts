import { createHash } from 'node:crypto';

const INTAKE_MUTATIONS = new Set(['health_intake_batch', 'health_intake_propose']);
const INTAKE_READS = new Set(['health_intake_read']);
const MIN_JSONL_COMPACTION_CHARACTERS = 4096;
const MIN_READ_RESULT_COMPACTION_CHARACTERS = 4096;
type UnknownRecord = Record<string, unknown>;
const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

interface TranscriptMessage extends UnknownRecord {
  content?: unknown;
}
interface TranscriptCall {
  successful: boolean;
  compactArguments: string | null;
  compacted: boolean;
  wire: { function: { arguments: string } };
}
// Host-only compaction state stays off the wire message, exactly as
// `TranscriptCall` keeps it off the tool-call wire: `wire` is the same object
// the request body serialises, so an extra `compacted` field on it would be
// sent to the provider.
interface TranscriptResult {
  compactContent: string | null;
  compacted: boolean;
  wire: TranscriptMessage;
}
interface TranscriptGroup {
  consumed: boolean;
  calls: TranscriptCall[];
  results: TranscriptResult[];
  imageMessage: TranscriptMessage | null;
  imageCompacted: boolean;
}
interface TranscriptLimits {
  textCharacters: number;
  mediaBytes: number;
}

export const PROXY_TRANSCRIPT_LIMITS = Object.freeze({
  textCharacters: 3 * 1024 * 1024,
  mediaBytes: 16 * 1024 * 1024,
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Project a completed intake mutation into bounded model history. The original
 * parsed arguments remain unchanged for execution and any durable app journal.
 */
export function compactIntakeMutationArguments(tool: string, args: unknown): string | null {
  const record = object(args) ? args : null;
  if (
    !INTAKE_MUTATIONS.has(tool) ||
    !record ||
    typeof record.jsonlText !== 'string' ||
    record.jsonlText.length < MIN_JSONL_COMPACTION_CHARACTERS
  )
    return null;
  const payloadCharacters = record.jsonlText.length;
  const payloadSha256 = sha256(record.jsonlText);
  const receipt =
    `[HOST_TRANSCRIPT_RECEIPT: ${tool} completed successfully and the app retained the full ` +
    `proposal. This is not source JSONL and must not be submitted. ` +
    `payloadCharacters=${payloadCharacters}; payloadSha256=${payloadSha256}. ` +
    `The unchanged tool result identifies the durable proposal. Exact record locators remain in ` +
    `that proposal and the retained original. Re-read the original with the unchanged intake ID ` +
    `and scoped intake read, package, or plan tools when source text is needed.]`;
  return JSON.stringify({ ...record, jsonlText: receipt });
}

/**
 * Project a consumed scoped intake read into bounded model history. Every read
 * result repeats the whole schema instruction block and up to a full page of
 * exact text, and nothing else evicts them. The retained original is unchanged
 * and re-readable with the same unchanged tool arguments, so the receipt names
 * what was removed and tells the model to re-read rather than treating an
 * absent field as evidence that the page held nothing.
 *
 * Counts, sizes and a fingerprint only — never a value, label, date or name.
 * Returns null when there is nothing worth evicting, which keeps the result
 * exact.
 */
export function compactIntakeReadResult(
  tool: string,
  value: unknown,
  args?: unknown,
): string | null {
  if (!object(value)) return null;
  const packageRead =
    tool === 'health_intake_package' && object(args) && args.action === 'read_member';
  if (!INTAKE_READS.has(tool) && !packageRead) return null;
  const instructions = typeof value.instructions === 'string' ? value.instructions : null;
  const original = object(value.original) ? value.original : null;
  const pageText = original && typeof original.text === 'string' ? original.text : null;
  // Package inventory, role plans and JSON structure results are not page reads.
  if (packageRead && pageText === null) return null;
  const instructionCharacters = instructions?.length ?? 0;
  const pageTextCharacters = pageText?.length ?? 0;
  if (instructionCharacters + pageTextCharacters < MIN_READ_RESULT_COMPACTION_CHARACTERS)
    return null;
  // Name only the fields actually replaced. A ZIP inventory read has no `original.text`
  // (`intake-evidence.ts`), so claiming page text was removed while reporting
  // `pageTextCharacters=0` would make a receipt whose whole job is precision inaccurate.
  const removed = [
    instructions === null ? null : 'schema instructions',
    pageText === null ? null : 'page text',
  ]
    .filter(Boolean)
    .join(' and ');
  const receipt =
    `[HOST_TRANSCRIPT_RECEIPT: the ${removed} for this consumed read ` +
    `${removed === 'page text' ? 'was' : 'were'} removed from transient history after a later valid model response. ` +
    // This string occupies `original.text`, the field the extraction contract tells the
    // model to take literal values from, so it carries the same explicit prohibition the
    // mutation receipt above uses when it hijacks a content-bearing field.
    `This is not page text and must not be quoted as evidence. ` +
    `instructionCharacters=${instructionCharacters}; pageTextCharacters=${pageTextCharacters}` +
    `${pageText === null ? '' : `; pageTextSha256=${sha256(pageText)}`}. ` +
    `The exact scoped tool arguments and metadata above remain unchanged. Re-read the retained ` +
    `original with those arguments when the text is needed. This receipt makes no extraction or ` +
    `confidence claim.]`;
  return JSON.stringify({
    ...value,
    ...(instructions === null ? {} : { instructions: receipt }),
    ...(pageText === null ? {} : { original: { ...original, text: receipt } }),
  });
}

function compactImageMessage(message: TranscriptMessage): boolean {
  if (!Array.isArray(message.content)) return false;
  const items = message.content.flatMap((part) => {
    if (!object(part)) return [];
    if (
      part.type === 'image_url' &&
      object(part.image_url) &&
      typeof part.image_url.url === 'string'
    )
      return [{ kind: 'image', data: part.image_url.url }];
    if (part.type === 'file' && object(part.file) && typeof part.file.file_data === 'string')
      return [{ kind: 'pdf', data: part.file.file_data }];
    return [];
  });
  if (!items.length) return false;
  const receipts = items
    .map(
      ({ kind, data }, index) =>
        `${kind}${index + 1}Characters=${data.length}; ${kind}${index + 1}Sha256=${sha256(data)}`,
    )
    .join('; ');
  message.content = [
    {
      type: 'text',
      text:
        `[HOST_TRANSCRIPT_RECEIPT: ${items.length} visual evidence data ` +
        `${items.length === 1 ? 'URL was' : 'URLs were'} removed from transient history after a ` +
        `later valid model response. ${receipts}. The exact scoped tool arguments and metadata ` +
        `above remain unchanged. Re-read the retained original with those arguments when visual evidence ` +
        `are needed. This receipt makes no extraction or confidence claim.]`,
    },
  ];
  return true;
}

/**
 * Compact only history that was included in a request which produced a valid
 * subsequent model response. Keep one consumed pair exact; after the caller
 * appends the current pair, the next request contains the two newest pairs.
 */
export function compactConsumedProxyHistory(
  history: TranscriptGroup[],
  {
    retainConsumedIntakeCalls = 1,
    retainConsumedImageMessages = 1,
    retainConsumedReadResults = 1,
  } = {},
): void {
  const intakeCalls = history
    .filter((group) => group.consumed)
    .flatMap((group) => group.calls)
    .filter((call) => call.successful && call.compactArguments && !call.compacted);
  const intakeCompactCount = Math.max(0, intakeCalls.length - retainConsumedIntakeCalls);
  for (const call of intakeCalls.slice(0, intakeCompactCount)) {
    if (!call.compactArguments) continue;
    call.wire.function.arguments = call.compactArguments;
    call.compacted = true;
  }

  const readResults = history
    .filter((group) => group.consumed)
    .flatMap((group) => group.results)
    .filter((result) => result.compactContent && !result.compacted);
  const readCompactCount = Math.max(0, readResults.length - retainConsumedReadResults);
  for (const result of readResults.slice(0, readCompactCount)) {
    if (!result.compactContent) continue;
    result.wire.content = result.compactContent;
    result.compacted = true;
  }

  const imageGroups = history.filter(
    (group) => group.consumed && group.imageMessage && !group.imageCompacted,
  );
  const imageCompactCount = Math.max(0, imageGroups.length - retainConsumedImageMessages);
  for (const group of imageGroups.slice(0, imageCompactCount)) {
    if (group.imageMessage) group.imageCompacted = compactImageMessage(group.imageMessage);
  }
}

export function proxyTranscriptSize(body: UnknownRecord): TranscriptLimits {
  let mediaBytes = 0;
  const sourceMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages = sourceMessages.map((value) => {
    if (!object(value)) return value;
    const message = value;
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (
          object(part) &&
          part.type === 'file' &&
          object(part.file) &&
          typeof part.file.file_data === 'string'
        ) {
          mediaBytes += Buffer.byteLength(part.file.file_data);
          return { ...part, file: { ...part.file, file_data: '' } };
        }
        if (
          !object(part) ||
          part.type !== 'image_url' ||
          !object(part.image_url) ||
          typeof part.image_url.url !== 'string'
        )
          return part;
        mediaBytes += Buffer.byteLength(part.image_url.url);
        return { ...part, image_url: { ...part.image_url, url: '' } };
      }),
    };
  });
  return {
    textCharacters: JSON.stringify({ ...body, messages }).length,
    mediaBytes,
  };
}

export function proxyTranscriptLimit(
  body: UnknownRecord,
  limits: TranscriptLimits = PROXY_TRANSCRIPT_LIMITS,
) {
  const size = proxyTranscriptSize(body);
  if (size.textCharacters > limits.textCharacters)
    return {
      kind: 'text',
      ...size,
      message:
        'AI response paused before another model request because retained text and tool history exceeded the supported context envelope. Partial work is retained, including any source checkpoints. Continue explicitly to start a fresh request.',
    };
  if (size.mediaBytes > limits.mediaBytes)
    return {
      kind: 'media',
      ...size,
      message:
        'AI response paused before another model request because retained visual evidence exceeded the supported media envelope. Partial work is retained, including any source checkpoints. Continue explicitly to start a fresh request.',
    };
  return null;
}
