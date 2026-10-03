import { createHash } from 'node:crypto';
import { HttpError, type Database } from './database.ts';
import { resolveClinicalReference } from './clinical-references.ts';
import { readPacketPreferences } from './packet-preferences.ts';
import { readStoredIntakeDetails } from './intake-state-access.ts';
import type {
  PacketCandidate,
  PacketRecordRef,
  PacketReview,
  PacketSelection,
} from '../shared/packet-selection.ts';

export const packetWithholdingNotice = "Some records were left out at the patient's request";
export const packetOpaqueNotice =
  'Record choices do not redact other mentions in text or originals. Unchecked narratives, raw source context and originals are left out. Included structured fields remain as recorded.';
export const packetUnredactedNotice =
  'Explicitly included unredacted materials may contain information about records left out of the structured summary. Record choices do not redact those materials.';
export const packetHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const packetKey = (ref: PacketRecordRef): string => `${ref.kind}:${ref.recordId}`;
const fail = (message: string): never => {
  throw new HttpError(400, 'INVALID_PACKET_SELECTION', message);
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function checkedPacketSelection(value: unknown): PacketSelection | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) return fail('Invalid packet choices.');
  if (
    Object.keys(value).some(
      (key) => !['kinds', 'from', 'to', 'tags', 'include', 'exclude', 'approvals'].includes(key),
    )
  )
    return fail('Unknown packet choice.');
  const strings = (v: unknown, max: number): string[] => {
    if (
      !Array.isArray(v) ||
      v.length > max ||
      v.some((s) => typeof s !== 'string' || !s || s.length > 256)
    )
      return fail('Invalid packet choices.');
    return [...new Set(v as string[])].sort();
  };
  const refs = (v: unknown): PacketRecordRef[] => {
    if (!Array.isArray(v) || v.length > 100000) return fail('Invalid record choices.');
    return [
      ...new Map(
        v.map((item) => {
          if (
            !object(item) ||
            typeof item.kind !== 'string' ||
            typeof item.recordId !== 'string' ||
            !item.recordId ||
            item.recordId.length > 256
          )
            return fail('Invalid record choice.');
          const ref = { kind: item.kind, recordId: item.recordId };
          return [packetKey(ref), ref] as const;
        }),
      ).values(),
    ].sort((a, b) => packetKey(a).localeCompare(packetKey(b)));
  };
  const result: PacketSelection = {};
  if (value.kinds !== undefined) result.kinds = strings(value.kinds, 100);
  if (value.tags !== undefined) result.tags = strings(value.tags, 32);
  for (const field of ['from', 'to'] as const) {
    const date = value[field];
    if (date === undefined || date === null || date === '') continue;
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      return fail('Use a complete valid date for packet filtering.');
    result[field] = date;
  }
  if (result.from && result.to && result.from > result.to)
    return fail('The start date is after the end date.');
  if (value.include !== undefined) result.include = refs(value.include);
  if (value.exclude !== undefined) result.exclude = refs(value.exclude);
  if (value.approvals !== undefined) {
    if (!Array.isArray(value.approvals) || value.approvals.length > 100000)
      return fail('Invalid disclosure approvals.');
    result.approvals = value.approvals
      .map((approval) => {
        if (
          !object(approval) ||
          typeof approval.key !== 'string' ||
          typeof approval.fingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(approval.fingerprint)
        )
          return fail('Invalid disclosure approval.');
        return { key: approval.key, fingerprint: approval.fingerprint };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
    if (new Set(result.approvals.map((a) => a.key)).size !== result.approvals.length)
      return fail('Duplicate disclosure approval.');
  }
  return result;
}

export interface PacketSelectable {
  key: string;
  type: string;
  id: string;
  title: string;
  date: string | null;
  row: Record<string, unknown>;
  citations: { id: string }[];
  attachments: { assetId: string }[];
  note?: {
    kind: string;
    links: { targetType: string; targetId: string; resolvedTargetType?: string }[];
  };
}
export interface PacketDependencies {
  files: Set<string>;
  hashes: Set<string>;
  assets: Set<string>;
  links: Set<string>;
}
export interface PacketDependencyCache {
  files: Map<string, { hash: string | null; parents: string[] }>;
  sources: Map<
    string,
    {
      file: string;
      original: string | null;
      provider: string | null;
      hasData: boolean;
      references: { id: string; provider?: string }[];
    }
  >;
  assets: Map<string, { hash: string | null; file: string | null }>;
}
export const packetDependencyCache = (): PacketDependencyCache => ({
  files: new Map(),
  sources: new Map(),
  assets: new Map(),
});
export function packetDependencies(
  db: Database,
  item: PacketSelectable,
  cache = packetDependencyCache(),
): PacketDependencies {
  const sources = new Set(item.citations.map((c) => c.id));
  if (typeof item.row.source_record_id === 'string') sources.add(item.row.source_record_id);
  if (item.type === 'source') sources.add(item.id);
  const files = new Set<string>(),
    hashes = new Set<string>(),
    assets = new Set(item.attachments.map((a) => a.assetId));
  if (item.type === 'source_file') files.add(item.id);
  const pendingSources: { id: string; provider?: string }[] = [...sources].map((id) => ({ id })),
    seenSources = new Set<string>();
  while (pendingSources.length) {
    const next = pendingSources.pop()!,
      source = next.id;
    if (seenSources.size > 100000) fail('Source relationships exceed the packet limit.');
    let found = cache.sources.get(source);
    if (!found) {
      const row = db
        .prepare(
          'SELECT source_file_id,locator_json,provider_id,raw_json,kind FROM source_records WHERE id=?',
        )
        .get(source);
      if (row) {
        const locator: unknown = JSON.parse(String(row.locator_json || '{}'));
        const references = new Map<string, { id: string; provider?: string }>();
        const envelope: unknown = JSON.parse(String(row.raw_json || '{}'));
        const pool =
          typeof row.provider_id === 'string' && source.startsWith(`${row.provider_id}:`)
            ? source.slice(row.provider_id.length + 1).split(':')[0]
            : null;
        const nodes: unknown[] = object(envelope)
          ? row.kind === 'source_capture'
            ? [envelope.content]
            : pool === 'context'
              ? [envelope.data]
              : []
          : [];
        let count = 0;
        while (nodes.length) {
          if (++count > 1000000) fail('Source context exceeds the packet limit.');
          const node = nodes.pop();
          if (Array.isArray(node)) {
            for (const value of node) nodes.push(value);
            continue;
          }
          if (!object(node)) continue;
          if (Object.keys(node).length === 1 && Object.hasOwn(node, '$health_archive_ref')) {
            const ref = node.$health_archive_ref;
            if (
              typeof ref !== 'string' ||
              !/^(records:r\d+|context:c\d+|text:t\d+)$/.test(ref) ||
              typeof row.provider_id !== 'string'
            )
              throw new HttpError(
                409,
                'INVALID_ARCHIVE_REFERENCE',
                'Invalid retained archive context reference.',
              );
            const id = `${row.provider_id}:${ref}`;
            references.set(id, { id, provider: row.provider_id });
            continue;
          }
          for (const value of Object.values(node))
            if (value && typeof value === 'object') nodes.push(value);
        }
        for (const relation of db
          .prepare(
            "SELECT from_record_id,to_record_id FROM record_relationships WHERE status='accepted' AND (from_record_id=? OR to_record_id=?)",
          )
          .iterate(source, source)) {
          const id = String(
            relation.from_record_id === source ? relation.to_record_id : relation.from_record_id,
          );
          if (!references.has(id)) references.set(id, { id });
        }
        found = {
          file: String(row.source_file_id),
          original:
            object(locator) && typeof locator.originalSourceFileId === 'string'
              ? locator.originalSourceFileId
              : null,
          provider: typeof row.provider_id === 'string' ? row.provider_id : null,
          hasData: object(envelope) && Object.hasOwn(envelope, 'data'),
          references: [...references.values()].sort((a, b) => a.id.localeCompare(b.id)),
        };
        cache.sources.set(source, found);
      } else
        throw new HttpError(
          409,
          'EXPORT_SOURCE_MISSING',
          'Retained source context is unavailable.',
        );
    }
    if (found) {
      if (next.provider && (found.provider !== next.provider || !found.hasData))
        throw new HttpError(
          409,
          'INVALID_ARCHIVE_REFERENCE',
          'Retained archive context must identify a same-provider data envelope.',
        );
      if (seenSources.has(source)) continue;
      seenSources.add(source);
      files.add(found.file);
      if (found.original) files.add(found.original);
      for (const ref of found.references) {
        sources.add(ref.id);
        pendingSources.push(ref);
      }
    }
  }
  for (const asset of assets) {
    let found = cache.assets.get(asset);
    if (!found) {
      const row = db.prepare('SELECT sha256,source_file_id FROM assets WHERE id=?').get(asset);
      found = {
        hash: row?.sha256 ? String(row.sha256) : null,
        file: row?.source_file_id ? String(row.source_file_id) : null,
      };
      cache.assets.set(asset, found);
    }
    if (found.hash) hashes.add(found.hash);
    if (found.file) files.add(found.file);
  }
  // Follow retained source ancestry, not inferred filenames or arbitrary narrative links.
  const pending = [...files],
    visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    if (visited.size > 100000) fail('Source relationships exceed the packet limit.');
    visited.add(file);
    let found = cache.files.get(file);
    if (!found) {
      const row = db.prepare('SELECT sha256,details_json FROM source_files WHERE id=?').get(file);
      if (!row)
        throw new HttpError(
          409,
          'EXPORT_SOURCE_MISSING',
          'Retained source ancestry is unavailable.',
        );
      const metadata: unknown = JSON.parse(String(row.details_json || '{}'));
      const intake = readStoredIntakeDetails(db, file);
      found = {
        hash: row.sha256 ? String(row.sha256) : null,
        parents: [
          object(metadata) ? metadata.originalSourceFileId : undefined,
          intake?.parentSourceFileId,
        ].filter((parent): parent is string => typeof parent === 'string'),
      };
      cache.files.set(file, found);
    }
    if (found.hash) hashes.add(found.hash);
    for (const parent of found.parents)
      if (!visited.has(parent)) {
        files.add(parent);
        pending.push(parent);
      }
  }
  return {
    files,
    hashes,
    assets,
    links: new Set(
      [...sources]
        .map((source) => `source:${source}`)
        .concat(
          (item.note?.links || []).map((link) => {
            const kind = link.resolvedTargetType || link.targetType;
            const resolved = resolveClinicalReference(db, kind, link.targetId);
            return resolved ? `${resolved.kind}:${resolved.recordId}` : `${kind}:${link.targetId}`;
          }),
        ),
    ),
  };
}
export const packetOpaqueRecord = (item: PacketSelectable): boolean =>
  ['note', 'document', 'source', 'source_file'].includes(item.type);
export function packetCandidates(db: Database, personId: string, items: PacketSelectable[]) {
  const memberKeys = new Set(items.map((item) => item.key));
  const preferences = readPacketPreferences(db, personId, {
    validateMembership: (_db, _personId, ref) => memberKeys.has(packetKey(ref)),
  });
  const byKey = new Map(preferences.map((p) => [packetKey(p.record), p]));
  const candidates: PacketCandidate[] = items.map((item) => {
    const preference = byKey.get(item.key);
    // Personal current-use confirmation is not a clinical event date. Authored
    // notes deliberately fall back to last modification, disclosed separately.
    const date =
      String(
        item.type === 'medication'
          ? item.row.start_at || ''
          : ['observation', 'procedure', 'document'].includes(item.type)
            ? item.row.effective_at || item.row.event_date || ''
            : item.type === 'source'
              ? item.row.date_text || ''
              : item.type === 'note'
                ? item.row.event_date || item.row.updated_at || ''
                : '',
      ) || null;
    return {
      record: { kind: item.type, recordId: item.id },
      key: item.key,
      title: item.title,
      date,
      dateBasis: !date
        ? 'undated'
        : item.type === 'note' && !item.row.event_date
          ? 'note-last-modified'
          : 'event',
      kind: item.type,
      tags: preference?.tags || [],
      alwaysWithhold: preference?.alwaysWithhold || false,
      preferenceVersion: preference?.version || 0,
      opaque: packetOpaqueRecord(item),
    };
  });
  return { candidates, preferences };
}

export function planPacketSelection(
  db: Database,
  personId: string,
  items: PacketSelectable[],
  baseline: Set<string>,
  selection: PacketSelection | undefined,
  dependencyCache = packetDependencyCache(),
) {
  const { candidates, preferences } = packetCandidates(db, personId, items);
  const recipe = selection || {};
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const byItem = new Map(items.map((item) => [item.key, item]));
  const normalize = (ref: PacketRecordRef): string => {
    const resolved = resolveClinicalReference(db, ref.kind, ref.recordId);
    const key = resolved ? `${resolved.kind}:${resolved.recordId}` : packetKey(ref);
    if (!byKey.has(key))
      return fail('A selected record is unavailable for this person. Refresh packet choices.');
    return key;
  };
  const includes = new Set((recipe.include || []).map(normalize)),
    excludes = new Set((recipe.exclude || []).map(normalize));
  const knownKinds = new Set(candidates.map((c) => c.kind));
  if (recipe.kinds?.some((kind) => !knownKinds.has(kind)))
    return fail('A selected record kind is unavailable. Refresh packet choices.');
  const selected = new Set<string>(),
    withheld = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.alwaysWithhold) {
      withheld.set(candidate.key, 'Always leave out of packets');
      continue;
    }
    if (excludes.has(candidate.key)) {
      withheld.set(candidate.key, 'Left out for this packet');
      continue;
    }
    if (!baseline.has(candidate.key) && !includes.has(candidate.key)) continue;
    if (!includes.has(candidate.key)) {
      if (recipe.kinds && !recipe.kinds.includes(candidate.kind)) {
        withheld.set(candidate.key, 'Kind excluded');
        continue;
      }
      if (recipe.tags?.length && !recipe.tags.some((tag) => candidate.tags.includes(tag))) {
        withheld.set(candidate.key, 'Person-applied tag filter');
        continue;
      }
      const item = byItem.get(candidate.key)!;
      if (
        (recipe.from || recipe.to) &&
        (!candidate.date ||
          !/^\d{4}-\d{2}-\d{2}/.test(candidate.date) ||
          /\b(year|month|unknown|approximate|season)\b/i.test(
            String(item.row.date_precision || ''),
          ) ||
          (recipe.from && candidate.date.slice(0, 10) < recipe.from) ||
          (recipe.to && candidate.date.slice(0, 10) > recipe.to))
      ) {
        withheld.set(candidate.key, 'Date window (undated and imprecise dates left out)');
        continue;
      }
    }
    selected.add(candidate.key);
  }
  const active = withheld.size > 0;
  const dependencies = new Map(
    active
      ? items.map((item) => [item.key, packetDependencies(db, item, dependencyCache)] as const)
      : [],
  );
  // Consent is bound to the immutable requested exclusions, not the order in
  // which other unchecked narratives are omitted during projection.
  const requestedWithheld = new Set(withheld.keys());
  const index = {
    files: new Map<string, Set<string>>(),
    hashes: new Map<string, Set<string>>(),
    assets: new Map<string, Set<string>>(),
  };
  for (const key of requestedWithheld) {
    const dep = dependencies.get(key);
    if (!dep) continue;
    for (const kind of ['files', 'hashes', 'assets'] as const)
      for (const value of dep[kind]) {
        if (!index[kind].has(value)) index[kind].set(value, new Set());
        index[kind].get(value)!.add(key);
      }
  }
  const conflicts = (key: string, dep: PacketDependencies): string[] => {
    const result = new Set(requestedWithheld.has(key) ? [key] : []);
    for (const link of dep.links) if (requestedWithheld.has(link)) result.add(link);
    for (const kind of ['files', 'hashes', 'assets'] as const)
      for (const value of dep[kind])
        for (const excluded of index[kind].get(value) || []) result.add(excluded);
    return [...result].sort();
  };
  const recipeWithoutApprovals = { ...recipe, approvals: undefined };
  const approvalScope = {
    profileId:
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value || null,
    personId,
    recipe: recipeWithoutApprovals,
    preferences,
    selected: [...selected].sort(),
    withheld: [...withheld].sort(),
  };
  const approvals = new Map((recipe.approvals || []).map((a) => [a.key, a.fingerprint]));
  const usedApprovals = new Set<string>();
  const review: PacketReview = {
    withheld: [],
    includedCount: 0,
    emptyKinds: [],
    opaqueItems: [],
    notice: active ? packetOpaqueNotice : '',
  };
  const approve = (
    key: string,
    title: string,
    contents: unknown,
    dep: PacketDependencies,
  ): boolean => {
    const conflictKeys = conflicts(key, dep);
    const blocked = conflictKeys.some((key) => byKey.get(key)?.alwaysWithhold);
    const fingerprint = packetHash({
      approvalScope,
      key,
      contents,
      conflictKeys: conflictKeys.sort(),
      blocked,
    });
    const requested = approvals.get(key);
    if (requested && (requested !== fingerprint || blocked))
      throw new HttpError(
        409,
        'EXPORT_DISCLOSURE_STALE',
        blocked
          ? 'This material conflicts with an always-withhold preference. Change the saved preference before including it.'
          : 'Disclosure choices changed. Review the current material before including it.',
      );
    if (requested) usedApprovals.add(key);
    review.opaqueItems.push({
      key,
      title,
      fingerprint,
      blocked,
      reason: blocked
        ? 'Contains or shares evidence with an always-withheld record. Change that saved preference to include this material.'
        : conflictKeys.length
          ? 'Shares original evidence with records left out. Its unredacted contents may disclose those records.'
          : 'Unredacted text or original bytes are not checked for mentions of records left out.',
      included: !!requested,
    });
    return !!requested;
  };
  return {
    active,
    candidates,
    preferences,
    selected,
    withheld,
    dependencies,
    dependencyCache,
    review,
    approve,
    finish: () => {
      if ([...approvals.keys()].some((key) => !usedApprovals.has(key)))
        throw new HttpError(
          409,
          'EXPORT_DISCLOSURE_STALE',
          'An approved material is no longer in this packet. Refresh disclosure choices.',
        );
      review.withheld = [...withheld].map(([key, reason]) => ({
        key,
        title: byKey.get(key)?.title || 'Record',
        reason,
      }));
      review.includedCount = selected.size;
      review.emptyKinds = [...knownKinds]
        .filter((kind) => !candidates.some((c) => c.kind === kind && selected.has(c.key)))
        .sort();
      return {
        approvalScope,
        approvals: recipe.approvals || [],
        actor: 'profile-user',
        disclosure: 'explicit-per-item',
        dependencies: [...dependencies].map(([key, d]) => ({
          key,
          files: [...d.files].sort(),
          hashes: [...d.hashes].sort(),
          assets: [...d.assets].sort(),
          links: [...d.links].sort(),
        })),
      };
    },
  };
}
