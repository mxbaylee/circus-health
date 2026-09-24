import { useEffect, useRef, useState } from 'react';
import type {
  Intake,
  IntakeReview,
  IntakeReviewDecision,
  IntakeReviewDraftUpdate,
  IntakeIssueResolution,
  IntakeReviewRecord,
} from '../../../shared/intake';
import { api, ApiError } from '../../data/api';
import {
  refreshPairScopesAfterOwnDraft,
  type ReviewDraftPairCommit,
} from './review-draft-pair-scope';

export type LocalReviewDraft = {
  decision: IntakeReviewDecision;
  resolutions: IntakeIssueResolution[];
  disposition: 'pending' | 'review_later' | 'keep_original_only';
  answers: Record<string, string>;
};
export const draftKey = (
  review: Pick<IntakeReview, 'intakeId' | 'proposalId'>,
  record: IntakeReviewRecord,
) => JSON.stringify([review.intakeId, review.proposalId, record.candidateVersionId || record.id]);

export function initialDraft(record: IntakeReviewRecord): LocalReviewDraft {
  const stored = record.draft as typeof record.draft & {
    decision?: IntakeReviewDecision;
    answers?: Record<string, string>;
  };
  return {
    decision: {
      recordId: record.id,
      action:
        record.classification === 'unsupported' ||
        stored?.disposition === 'review_later' ||
        record.reviewState === 'kept_original'
          ? 'skip'
          : 'accept',
      ...stored?.decision,
      mapping: {
        ...record.mapping,
        ...stored?.mapping,
        ...stored?.decision?.mapping,
        kind: stored?.mapping.kind || record.mapping.kind || record.kind,
      },
    },
    resolutions: stored?.resolutions || [],
    disposition: stored?.disposition || 'pending',
    answers:
      stored?.answers ||
      Object.fromEntries(
        (record.questions || []).map((question) => [
          question.id,
          question.answers.at(-1)?.answer || '',
        ]),
      ),
  };
}

export function reconcileReviewDraft(
  prior: LocalReviewDraft,
  record: IntakeReviewRecord,
  baseline: IntakeReviewDecision['mapping'],
): LocalReviewDraft {
  // Ordinary refreshes preserve exact pair scopes. The separate own-write check
  // may advance only transport pins proven to have changed by this editor's save.
  const edits = Object.fromEntries(
    Object.entries(prior.decision.mapping).filter(
      ([field, value]) =>
        JSON.stringify(value) !== JSON.stringify(baseline[field as keyof typeof baseline]),
    ),
  );
  return {
    ...prior,
    decision: {
      ...prior.decision,
      recordId: record.id,
      mapping: { ...record.mapping, kind: record.mapping.kind || record.kind, ...edits },
    },
  };
}

// Drafts live in encrypted intake storage. Memory keeps unsent edits through navigation;
// no clinical text is written to unencrypted browser storage.
export function useReviewDrafts(profileId: string, onSaved: (intake: Intake) => void) {
  const [drafts, setDrafts] = useState<Record<string, LocalReviewDraft>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [comparison, setComparison] = useState<{
    review: IntakeReview;
    record: IntakeReviewRecord;
    local: LocalReviewDraft;
    key: string;
  } | null>(null);
  const draftsRef = useRef(drafts);
  const versions = useRef(new Map<string, number>());
  const baselines = useRef(new Map<string, IntakeReviewDecision['mapping']>());
  type Work = {
    intakeId: string;
    candidateId?: string;
    body: Omit<IntakeReviewDraftUpdate, 'version'> & {
      decision?: IntakeReviewDecision;
      answers?: Record<string, string>;
    };
    version?: number;
  };
  const queue = useRef(new Map<string, Work>());
  const pairCommits = useRef(new Map<string, ReviewDraftPairCommit>());
  const pairEpoch = useRef(0);
  const active = useRef<Promise<boolean> | null>(null);
  const failedWork = useRef<{ key: string; work: Work } | null>(null);
  const epoch = useRef(0);
  const paused = useRef(false);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  useEffect(() => {
    epoch.current++;
    queue.current.clear();
    versions.current.clear();
    baselines.current.clear();
    pairCommits.current.clear();
    failedWork.current = null;
    draftsRef.current = {};
    setDrafts({});
    setError('');
    setConflict(false);
    setComparison(null);
    paused.current = false;
  }, [profileId]);
  function observe(intake: Pick<Intake, 'id' | 'version'>) {
    versions.current.set(intake.id, Math.max(versions.current.get(intake.id) || 0, intake.version));
  }
  function hydrate(review: IntakeReview) {
    observe({ id: review.intakeId, version: review.version });
    const next = { ...draftsRef.current };
    for (const record of review.records) {
      const key = draftKey(review, record);
      if (!next[key]) next[key] = initialDraft(record);
      else {
        // Saved answers may change server mappings. Keep each locally edited field.
        const prior = next[key];
        const baseline = baselines.current.get(key) || {};
        next[key] = reconcileReviewDraft(prior, record, baseline);
      }
      baselines.current.set(key, { ...record.mapping, kind: record.mapping.kind || record.kind });
      next[key] = {
        ...next[key],
        decision: refreshPairScopesAfterOwnDraft(
          profileId,
          review,
          record,
          next[key].decision,
          pairCommits.current.get(key),
        ),
      };
    }
    draftsRef.current = next;
    setDrafts(next);
  }
  function current(review: IntakeReview, record: IntakeReviewRecord) {
    return draftsRef.current[draftKey(review, record)] || initialDraft(record);
  }
  function afterOwnSave(review: IntakeReview, record: IntakeReviewRecord) {
    const draft = current(review, record);
    return {
      ...draft,
      decision: refreshPairScopesAfterOwnDraft(
        profileId,
        review,
        record,
        draft.decision,
        pairCommits.current.get(draftKey(review, record)),
      ),
    };
  }
  async function flush(): Promise<boolean> {
    if (active.current) return active.current;
    if (paused.current) return false;
    if (!queue.current.size && !failedWork.current) return true;
    const generation = epoch.current;
    const run = async () => {
      setSaving(true);
      try {
        while ((queue.current.size || failedWork.current) && generation === epoch.current) {
          const [key, work] = failedWork.current
            ? [failedWork.current.key, failedWork.current.work]
            : queue.current.entries().next().value!;
          // Preserve the exact operation/version on an uncertain transport failure.
          work.version ??= versions.current.get(work.intakeId) || 0;
          failedWork.current = { key, work };
          pairCommits.current.delete(key);
          const pairGeneration = pairEpoch.current;
          const result = await api<Intake>(
            `/api/profiles/${encodeURIComponent(profileId)}/intakes/${encodeURIComponent(work.intakeId)}/review-draft`,
            {
              method: 'POST',
              body: JSON.stringify({ ...work.body, version: work.version }),
            },
          );
          if (generation !== epoch.current) return false;
          if (
            pairGeneration === pairEpoch.current &&
            work.candidateId &&
            typeof result.meta?.revision === 'number' &&
            result.data.id === work.intakeId
          )
            pairCommits.current.set(key, {
              profileId,
              intakeId: work.intakeId,
              candidateId: work.candidateId,
              request: structuredClone({ ...work.body, version: work.version }),
              version: result.data.version,
              revision: result.meta.revision,
            });
          observe(result.data);
          if (queue.current.get(key) === work) queue.current.delete(key);
          failedWork.current = null;
          savedCallback.current(result.data);
        }
        setError('');
        setConflict(false);
        setComparison(null);
        return true;
      } catch (error) {
        if (generation === epoch.current) {
          paused.current = true;
          setConflict(error instanceof ApiError && error.status === 409);
          setError(
            error instanceof Error
              ? error.message
              : 'Draft could not save. Your edits remain here.',
          );
        }
        return false;
      } finally {
        active.current = null;
        setSaving(false);
      }
    };
    active.current = run();
    return active.current;
  }
  function update(
    review: IntakeReview,
    record: IntakeReviewRecord,
    patch: Partial<LocalReviewDraft>,
  ) {
    const key = draftKey(review, record),
      next = { ...current(review, record), ...patch };
    draftsRef.current = { ...draftsRef.current, [key]: next };
    setDrafts(draftsRef.current);
    if (!record.candidateVersionId) return;
    queue.current.set(key, {
      intakeId: review.intakeId,
      candidateId: record.candidateId,
      body: {
        operationId: crypto.randomUUID(),
        proposalId: review.proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId,
        mapping: next.decision.mapping,
        resolutions: next.resolutions,
        disposition: next.disposition,
        decision: next.decision,
        answers: next.answers,
      },
    });
  }
  useEffect(() => {
    if (!queue.current.size || paused.current) return;
    const timer = setTimeout(() => void flush(), 350);
    return () => clearTimeout(timer);
  }, [drafts]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (queue.current.size || active.current || failedWork.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  async function retry() {
    paused.current = false;
    return flush();
  }
  async function inspectConflict() {
    const failed = failedWork.current;
    if (!failed) return;
    const generation = epoch.current;
    try {
      const proposal = failed.work.body.proposalId;
      const review = (
        await api<IntakeReview>(
          `/api/profiles/${encodeURIComponent(profileId)}/intakes/${encodeURIComponent(failed.work.intakeId)}/review${proposal ? `?proposalId=${encodeURIComponent(proposal)}` : ''}`,
        )
      ).data;
      if (generation !== epoch.current) return;
      const record = review.records.find(
        (item) =>
          item.id === failed.work.body.recordId &&
          item.candidateVersionId === failed.work.body.candidateVersionId,
      );
      if (!record) {
        setError(
          'This candidate was replaced. Your edits remain here; review the new proposal before continuing.',
        );
        return;
      }
      setComparison({ review, record, key: failed.key, local: current(review, record) });
    } catch (error) {
      if (generation === epoch.current)
        setError(error instanceof Error ? error.message : 'The latest review could not load.');
    }
  }
  async function refreshComparison() {
    const snapshot = comparison;
    if (!snapshot) return null;
    const generation = epoch.current;
    try {
      const proposal = snapshot.review.proposalId;
      const latest = (
        await api<IntakeReview>(
          `/api/profiles/${encodeURIComponent(profileId)}/intakes/${encodeURIComponent(snapshot.review.intakeId)}/review${proposal ? `?proposalId=${encodeURIComponent(proposal)}` : ''}`,
        )
      ).data;
      if (generation !== epoch.current) return null;
      const record = latest.records.find(
        (item) =>
          item.id === snapshot.record.id &&
          item.candidateVersionId === snapshot.record.candidateVersionId,
      );
      if (!record) {
        setError(
          'This candidate was replaced. Your edits remain here; review the new proposal before continuing.',
        );
        return null;
      }
      observe({ id: latest.intakeId, version: latest.version });
      if (JSON.stringify(initialDraft(record)) !== JSON.stringify(initialDraft(snapshot.record))) {
        setComparison({ ...snapshot, review: latest, record });
        setError('The saved review changed again. Compare the newest fields before choosing.');
        return null;
      }
      return { snapshot, review: latest, record };
    } catch (error) {
      if (generation === epoch.current)
        setError(error instanceof Error ? error.message : 'The latest review could not load.');
      return null;
    }
  }
  async function reapply() {
    const fresh = await refreshComparison();
    if (!fresh) return false;
    failedWork.current = null;
    queue.current.delete(fresh.snapshot.key);
    update(fresh.review, fresh.record, fresh.snapshot.local);
    const work = queue.current.get(fresh.snapshot.key);
    if (work) work.version = fresh.review.version;
    paused.current = false;
    setComparison(null);
    setConflict(false);
    return flush();
  }
  async function useCurrent() {
    const fresh = await refreshComparison();
    if (!fresh) return false;
    failedWork.current = null;
    queue.current.delete(fresh.snapshot.key);
    const next = initialDraft(fresh.record);
    draftsRef.current = { ...draftsRef.current, [fresh.snapshot.key]: next };
    baselines.current.set(fresh.snapshot.key, {
      ...fresh.record.mapping,
      kind: fresh.record.mapping.kind || fresh.record.kind,
    });
    setDrafts(draftsRef.current);
    paused.current = false;
    setError('');
    setConflict(false);
    setComparison(null);
    return true;
  }
  return {
    drafts,
    hydrate,
    current,
    afterOwnSave,
    clearPairCommits: () => {
      pairEpoch.current++;
      pairCommits.current.clear();
    },
    update,
    observe,
    flush,
    retry,
    saving,
    error,
    conflict,
    comparison,
    inspectConflict,
    reapply,
    useCurrent,
    pending: () => !!(queue.current.size || active.current || failedWork.current),
    version: (id: string) => versions.current.get(id),
  };
}
