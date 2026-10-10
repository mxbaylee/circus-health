import { useEffect, useRef, useState } from 'react';
import type {
  CollectionFeedRecord,
  CollectionPeoplePage,
  CollectionPersonProposal,
} from '../../../shared/intake-clinical-pages';
import type { IntakePersonApplyResult } from '../../../shared/intake-people';
import { api, ApiError } from '../../data/api';
import { readSelectedClinicalReview } from '../../data/intake-clinical-review';
export type CollectionDisposition = 'pending' | 'later' | 'excluded';
type Work = (
  | { kind: 'clinical'; row: CollectionFeedRecord; state: CollectionDisposition }
  | {
      kind: 'person';
      person: CollectionPersonProposal;
      groupId: string;
      state?: CollectionDisposition;
    }
) & { command?: { path: string; body: Record<string, unknown> } };
/** Commands cover only the displayed selection. An uncertain command and its unsent successors remain exact. */
export function useCollectionBulkActions({
  scope,
  onClinicalDone,
  onPersonDone,
  onPersonSaved,
  onRefresh,
}: {
  scope: string;
  onClinicalDone: (key: string) => void;
  onPersonDone: (id: string) => void;
  onPersonSaved: (saved: IntakePersonApplyResult, title: string) => void;
  onRefresh: () => void;
}) {
  const active = useRef(scope);
  active.current = scope;
  const queue = useRef<Work[] | null>(null),
    running = useRef(false);
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const callbacks = useRef({ onClinicalDone, onPersonDone, onPersonSaved, onRefresh });
  callbacks.current = { onClinicalDone, onPersonDone, onPersonSaved, onRefresh };
  useEffect(() => {
    active.current = scope;
    queue.current = null;
    running.current = false;
    setBusy(false);
    setPending(false);
    setError('');
    setNotice('');
    return () => {
      active.current = '';
    };
  }, [scope]);
  async function run(work: Work[]) {
    if (running.current || !work.length) return;
    running.current = true;
    queue.current = work;
    setBusy(true);
    setPending(true);
    setError('');
    setNotice('');
    let completed = 0;
    try {
      while (work.length) {
        if (active.current !== scope) return;
        const item = work[0]!;
        if (!item.command) {
          if (item.kind === 'clinical') {
            if (item.row.detail.kind !== 'record')
              throw new Error('Open the referenced record before changing its review status.');
            const row = item.row.detail.record;
            const fresh = await readSelectedClinicalReview(
              item.row.intakeId,
              item.row.proposalId,
              row.id,
              row.candidateVersionId,
            );
            if (active.current !== scope) return;
            if (
              fresh.record.kind !== 'record' ||
              ['accepted', 'kept_original'].includes(fresh.record.record.reviewState || '')
            )
              throw new Error('A selected record is no longer pending. Refresh this page.');
            item.command = {
              path: `/intakes/${encodeURIComponent(item.row.intakeId)}/review-draft`,
              body: {
                version: fresh.context.version,
                operationId: crypto.randomUUID(),
                proposalId: item.row.proposalId,
                recordId: row.id,
                candidateVersionId: row.candidateVersionId,
                disposition:
                  item.state === 'later'
                    ? 'review_later'
                    : item.state === 'excluded'
                      ? 'keep_original_only'
                      : 'pending',
              },
            };
          } else {
            const query = new URLSearchParams({
              intakeId: item.person.intakeId,
              personId: item.person.id,
              view: 'all',
              limit: '1',
              bytes: '65536',
            });
            const fresh = (
              await api<CollectionPeoplePage>(
                `/intakes/people/${encodeURIComponent(item.groupId)}?${query}`,
              )
            ).data;
            if (active.current !== scope) return;
            const selected = fresh.people.find(
              (value) => value.kind === 'person' && value.person.id === item.person.id,
            );
            if (
              fresh.selectedPersonId !== item.person.id ||
              !selected ||
              selected.kind !== 'person' ||
              selected.person.version !== item.person.version ||
              selected.person.state === 'saved'
            )
              throw new Error(
                'A selected Person changed. Open their current evidence before retrying.',
              );
            const person = selected.person;
            if (!item.state && (person.selfMatch || person.matches.length))
              throw new Error(
                `${person.person.fullName} needs an individual People match decision.`,
              );
            item.command = {
              path: item.state ? '/intakes/people-disposition' : '/intakes/people-apply',
              body: {
                operationId: crypto.randomUUID(),
                intakeId: person.intakeId,
                proposalId: person.id,
                proposalVersion: person.version,
                ...(item.state
                  ? { state: item.state, intakeVersion: person.intakeVersion }
                  : { action: 'add' }),
              },
            };
          }
        }
        if (active.current !== scope) return;
        const response = await api<IntakePersonApplyResult>(item.command.path, {
          method: 'POST',
          body: JSON.stringify(item.command.body),
        });
        if (active.current !== scope) return;
        if (item.kind === 'clinical') callbacks.current.onClinicalDone(item.row.feedKey);
        else {
          callbacks.current.onPersonDone(item.person.id);
          if (!item.state)
            callbacks.current.onPersonSaved(response.data, item.person.person.fullName);
        }
        work.shift();
        completed++;
        setNotice(`${completed} selected ${completed === 1 ? 'item' : 'items'} updated.`);
      }
      queue.current = null;
      setPending(false);
    } catch (cause) {
      if (active.current !== scope) return;
      const definite =
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        ![408, 429].includes(cause.status);
      const beforeWrite = !work[0]?.command;
      if (definite || beforeWrite) {
        queue.current = null;
        setPending(false);
      }
      setError(
        (cause instanceof Error ? cause.message : 'The selected action could not complete.') +
          (!definite && !beforeWrite
            ? ' The outcome is unconfirmed. Retry the exact selected action before continuing.'
            : ''),
      );
    } finally {
      if (active.current === scope) {
        running.current = false;
        setBusy(false);
        callbacks.current.onRefresh();
      }
    }
  }
  return {
    busy,
    pending,
    error,
    notice,
    retry: () => (queue.current ? run(queue.current) : Promise.resolve()),
    disposition: (
      rows: CollectionFeedRecord[],
      people: CollectionPersonProposal[],
      groupId: string,
      state: CollectionDisposition,
    ) => {
      if (queue.current) return Promise.resolve();
      return run([
        ...rows.map((row) => ({ kind: 'clinical' as const, row, state })),
        ...people.map((person) => ({ kind: 'person' as const, person, groupId, state })),
      ]);
    },
    addPeople: (people: CollectionPersonProposal[], groupId: string) => {
      if (queue.current) return Promise.resolve();
      return run(people.map((person) => ({ kind: 'person' as const, person, groupId })));
    },
  };
}
