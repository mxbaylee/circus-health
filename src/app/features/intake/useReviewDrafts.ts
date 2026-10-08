import type { IntakeClinicalReviewContext } from '../../../shared/intake-clinical-review';
import type { IntakeReviewDraftTransition } from '../../../shared/intake-review-draft-transition';
import { readSelectedClinicalReview } from '../../data/intake-clinical-review';
import { useEffect, useRef, useState } from 'react';
import type {
  Intake,
  IntakeReview,
  IntakeReviewDecision,
  IntakeReviewDraftUpdate,
  IntakeIssueResolution,
  IntakeReviewRecord,
  IntakeReviewDraft,
} from '../../../shared/intake';
import { api, ApiError } from '../../data/api';
import {
  refreshPairScopesAfterOwnDraft,
  type ReviewDraftPairCommit,
} from './review-draft-pair-scope';

export type LocalReviewDraft = {
  correctionReason?: string;
  decision: IntakeReviewDecision;
  resolutions: IntakeIssueResolution[];
  resolutionsReference?: IntakeReviewDraft['resolutionsReference'];
  history?: IntakeReviewDraft['history'];
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
    ...(stored?.resolutionsReference
      ? { resolutionsReference: stored.resolutionsReference, history: stored.history }
      : {}),
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
    ...(record.draft?.resolutionsReference
      ? { resolutionsReference: record.draft.resolutionsReference, history: record.draft.history }
      : {}),
    decision: {
      ...prior.decision,
      recordId: record.id,
      mapping: { ...record.mapping, kind: record.mapping.kind || record.kind, ...edits },
    },
  };
}

// Drafts live in encrypted intake storage. Memory keeps unsent edits through navigation;
// no clinical text is written to unencrypted browser storage.
export function useReviewDrafts(
  profileId: string,
  onSaved: (intake: Intake) => void,
  { retainedComparisons = false }: { retainedComparisons?: boolean } = {},
) {
  const [drafts, setDrafts] = useState<Record<string, LocalReviewDraft>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [comparison, setComparison] = useState<{
    review: IntakeClinicalReviewContext;
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
    reasonMapping?: IntakeReviewDecision['mapping'];
  };
  const queue = useRef(new Map<string, Work>());
  const pairCommits = useRef(new Map<string, ReviewDraftPairCommit>());
  const pairEpoch = useRef(0);
  const mounted = useRef(true);
  const editRevisions = useRef(new Map<string, number>());
  const active = useRef<Promise<boolean> | null>(null);
  const failedWork = useRef<{ key: string; work: Work } | null>(null);
  const epoch = useRef(0);
  const paused = useRef(false);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pairEpoch.current++;
      pairCommits.current.clear();
    };
  }, []);
  useEffect(() => {
    epoch.current++;
    queue.current.clear();
    versions.current.clear();
    baselines.current.clear();
    pairCommits.current.clear();
    editRevisions.current.clear();
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
    hydrateRecords(review, review.records);
  }
  function hydrateRecords(review: IntakeClinicalReviewContext, records: IntakeReviewRecord[]) {
    observe({ id: review.intakeId, version: review.version });
    const next = { ...draftsRef.current };
    for (const record of records) {
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
  function current(review: IntakeClinicalReviewContext, record: IntakeReviewRecord) {
    const draft = draftsRef.current[draftKey(review, record)] || initialDraft(record);
    // Native relationship controls write their exact choices independently of
    // this field editor. Keep those retained choices verbatim through later
    // mapping/resolution edits; an older local decision cannot replace them.
    return retainedComparisons
      ? {
          ...draft,
          decision: { ...draft.decision, comparisons: record.draft?.decision?.comparisons },
        }
      : draft;
  }
  function afterOwnSave(
    review: IntakeClinicalReviewContext,
    record: IntakeReviewRecord,
    commit = pairCommits.current.get(draftKey(review, record)),
  ) {
    const draft = current(review, record);
    return {
      ...draft,
      decision: refreshPairScopesAfterOwnDraft(profileId, review, record, draft.decision, commit),
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
          if (work.version === undefined && work.body.correctionReason && work.reasonMapping) {
            const baseline = baselines.current.get(key) || {};
            work.body.correctionPatch = Object.fromEntries(
              Object.entries(work.reasonMapping).filter(
                ([field, value]) =>
                  !['subject', 'personId', 'sourceSystem'].includes(field) &&
                  JSON.stringify(value) !==
                    JSON.stringify(baseline[field as keyof typeof baseline]),
              ),
            );
            if (!Object.keys(work.body.correctionPatch).length)
              work.body.correctionReason = undefined;
          }
          work.version ??= versions.current.get(work.intakeId) || 0;
          failedWork.current = { key, work };
          pairCommits.current.delete(key);
          const pairGeneration = pairEpoch.current;
          const result = await api<
            Intake & { reviewDraftTransition?: IntakeReviewDraftTransition }
          >(
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
              ...(result.data.reviewDraftTransition
                ? { transition: structuredClone(result.data.reviewDraftTransition) }
                : {}),
            });
          observe(result.data);
          baselines.current.set(key, { ...work.body.mapping });
          const local = draftsRef.current[key];
          if (
            local &&
            local.correctionReason === work.body.correctionReason &&
            JSON.stringify(local.decision.mapping) === JSON.stringify(work.body.mapping)
          ) {
            draftsRef.current = {
              ...draftsRef.current,
              [key]: { ...local, correctionReason: undefined },
            };
            setDrafts(draftsRef.current);
          }
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
    review: IntakeClinicalReviewContext,
    record: IntakeReviewRecord,
    patch: Partial<LocalReviewDraft>,
  ) {
    const key = draftKey(review, record);
    editRevisions.current.set(key, (editRevisions.current.get(key) || 0) + 1);
    const prior = current(review, record);
    const mappingChanged =
      patch.decision &&
      JSON.stringify(patch.decision.mapping) !== JSON.stringify(prior.decision.mapping);
    const reason = patch.correctionReason ?? prior.correctionReason;
    // A reason typed for one mapping remains in its field, but an unrelated
    // edit cannot attach that explanation to a different patch.
    const sendReason = mappingChanged && patch.correctionReason === undefined ? undefined : reason;
    const next = { ...prior, ...patch, correctionReason: reason };
    if (retainedComparisons)
      next.decision = {
        ...next.decision,
        comparisons: record.draft?.decision?.comparisons,
      };
    draftsRef.current = { ...draftsRef.current, [key]: next };
    setDrafts(draftsRef.current);
    if (!record.candidateVersionId) return;
    // A referenced policy collection is never reconstructed in the browser. Keep
    // only this edit and earlier unsent edits; an in-flight exact request remains
    // separate and completes before the queued successor.
    const pendingBody = queue.current.get(key)?.body;
    const priorResolutions = new Map(prior.resolutions.map((value) => [value.issueId, value]));
    const changedResolutions = next.resolutions.filter(
      (value) => JSON.stringify(priorResolutions.get(value.issueId)) !== JSON.stringify(value),
    );
    const sparseResolutions = [
      ...new Map(
        [...(pendingBody?.resolutions || []), ...changedResolutions].map((value) => [
          value.issueId,
          value,
        ]),
      ).values(),
    ];
    const sparseAnswers = {
      ...pendingBody?.answers,
      ...Object.fromEntries(
        Object.entries(next.answers).filter(([id, answer]) => prior.answers[id] !== answer),
      ),
    };
    queue.current.set(key, {
      intakeId: review.intakeId,
      candidateId: record.candidateId,
      reasonMapping: sendReason ? structuredClone(next.decision.mapping) : undefined,
      body: {
        operationId: crypto.randomUUID(),
        proposalId: review.proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId,
        mapping: next.decision.mapping,
        resolutions: next.resolutionsReference ? sparseResolutions : next.resolutions,
        disposition: next.disposition,
        decision: next.decision,
        answers: next.resolutionsReference ? sparseAnswers : next.answers,
        correctionReason: sendReason,
      },
    });
  }
  /** Only an explicit approval may change a retained skip into acceptance.
   * The returned acknowledgement belongs to this exact queued write, once.
   * A lost reply, remount, profile switch or newer edit grants no continuation. */
  async function prepareAcceptance(
    review: IntakeClinicalReviewContext,
    record: IntakeReviewRecord,
  ) {
    const draft = current(review, record);
    if (
      !mounted.current ||
      draft.disposition !== 'pending' ||
      queue.current.size ||
      active.current ||
      failedWork.current
    )
      return null;
    const generation = epoch.current;
    const pairGeneration = pairEpoch.current;
    const key = draftKey(review, record);
    update(review, record, { decision: { ...draft.decision, action: 'accept' } });
    const work = queue.current.get(key);
    const editRevision = editRevisions.current.get(key);
    if (!work || !(await flush())) return null;
    const commit = pairCommits.current.get(key);
    pairCommits.current.delete(key);
    const isCurrent = () =>
      mounted.current &&
      epoch.current === generation &&
      pairEpoch.current === pairGeneration &&
      editRevisions.current.get(key) === editRevision &&
      !queue.current.size &&
      !active.current &&
      !failedWork.current;
    if (!isCurrent() || !commit || commit.request.operationId !== work.body.operationId)
      return null;
    return { commit, isCurrent };
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
      const selected = await readSelectedClinicalReview(
        failed.work.intakeId,
        proposal || null,
        failed.work.body.recordId,
        failed.work.body.candidateVersionId,
      );
      if (generation !== epoch.current) return;
      const review = selected.context;
      const record = selected.record.kind === 'record' ? selected.record.record : undefined;
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
      const selected = await readSelectedClinicalReview(
        snapshot.review.intakeId,
        proposal,
        snapshot.record.id,
        snapshot.record.candidateVersionId,
      );
      if (generation !== epoch.current) return null;
      const latest = selected.context;
      const record = selected.record.kind === 'record' ? selected.record.record : undefined;
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
    const key = fresh.snapshot.key;
    const failed = failedWork.current?.key === key ? failedWork.current.work.body : undefined;
    const pending = queue.current.get(key)?.body;
    failedWork.current = null;
    queue.current.delete(key);
    update(fresh.review, fresh.record, fresh.snapshot.local);
    const work = queue.current.get(key);
    if (work) {
      work.version = fresh.review.version;
      // Referenced drafts retain saved choices outside the browser. Reapply
      // only unsent patches, never the local cache of earlier saved choices.
      if (fresh.snapshot.local.resolutionsReference) {
        work.body.resolutions = [
          ...new Map(
            [...(failed?.resolutions || []), ...(pending?.resolutions || [])].map((value) => [
              value.issueId,
              value,
            ]),
          ).values(),
        ];
        work.body.answers = { ...failed?.answers, ...pending?.answers };
      }
    }
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
    hydrateRecords,
    current,
    afterOwnSave,
    prepareAcceptance,
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
