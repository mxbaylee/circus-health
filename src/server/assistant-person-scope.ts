import { personScopeRoute } from '../shared/person-scope.ts';
import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import { recordOwner } from './record-owner.ts';

export function assistantPersonScope(
  db: Database,
  context?: { route?: string; intakeId?: string },
): string | null {
  if (context?.intakeId || !context?.route) return null;
  const url = new URL(context.route.replace(/^#/, ''), 'https://circus.invalid');
  const route = personScopeRoute(url.pathname, url.searchParams);
  if (!route.scoped) return null;
  if (route.target) {
    try {
      return recordOwner(db, route.target.type, route.target.id);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
    }
  }
  // A stale/deleted selected entry is reported by the page resolver; it grants no extra scope.
  return url.pathname === '/' ? 'patient' : url.searchParams.get('personId') || 'patient';
}
const clinicalCollections: Record<string, string> = {
  results: 'observation',
  medications: 'medication',
  procedures: 'procedure',
  documents: 'document',
  notes: 'note',
};
export function scopeAssistantQuery(args: Record<string, unknown>, personId: string | null) {
  if (
    !personId ||
    ![...Object.keys(clinicalCollections), 'test_types'].includes(String(args.collection))
  )
    return args;
  if (args.personId !== undefined && args.personId !== personId)
    throw new HttpError(
      403,
      'PERSON_SCOPE',
      'Start a conversation from the other person’s records to query them.',
    );
  return { ...args, personId };
}
export function assertAssistantRecordOwner(
  db: Database,
  args: Record<string, unknown>,
  personId: string | null,
) {
  const type = clinicalCollections[String(args.collection)];
  if (!personId || !type) return;
  if (recordOwner(db, type, String(args.id)) !== personId)
    throw new HttpError(
      403,
      'PERSON_SCOPE',
      'This record belongs to a different person than this conversation.',
    );
}
