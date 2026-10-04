import { useEffect, useRef, useState } from 'react';
import type {
  IntakeIdentityReview,
  IntakeIdentityScopePage,
  IntakeIdentityScopeReference,
  IntakeIdentityScopeSection,
} from '../../../shared/intake-identity';
import { api } from '../../data/api';
import { useProfile } from '../../data/profile';
import { CollectionEvidenceWindow } from '../intake/CollectionEvidenceWindow';

const labels: Record<IntakeIdentityScopeSection, string> = {
  questions: 'Identity questions',
  targets: 'Records needing identity confirmation',
  assignmentTargets: 'Records receiving this person choice',
  membership: 'Retained report membership',
  competingSubjects: 'Other printed subjects',
  warnings: 'Report identity warnings',
};
/** The reference identifies complete authority; only the displayed evidence window is retained here. */
export function IdentityScopeEvidence({
  scope,
  warningsReference,
  onQuestionsReviewed,
  onRefresh,
}: {
  scope: IntakeIdentityScopeReference;
  warningsReference?: IntakeIdentityReview['warningsReference'];
  onQuestionsReviewed: (ready: boolean) => void;
  onRefresh: () => void;
}) {
  const [section, setSection] = useState<IntakeIdentityScopeSection>('assignmentTargets');
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Complete report identity scope">
      <p>
        {scope.collection.assignmentTargets.toLocaleString()} records receive this person choice;{' '}
        {scope.collection.membership.toLocaleString()} retained memberships and{' '}
        {scope.collection.questions.toLocaleString()} identity questions belong to this exact report
        scope.
      </p>
      {scope.collection.questions > 0 && (
        <IdentityScopePage
          scope={scope}
          section="questions"
          onReviewed={onQuestionsReviewed}
          onRefresh={onRefresh}
        />
      )}
      {warningsReference && (
        <p>
          {warningsReference.count.toLocaleString()} advisory warnings are available in the complete
          report identity warnings section below.
        </p>
      )}
      <button type="button" className="button secondary" onClick={() => setOpen(!open)}>
        {open ? 'Hide identity scope evidence' : 'Inspect affected records and membership'}
      </button>
      {open && (
        <>
          <label>
            Identity evidence section
            <select
              value={section}
              onChange={(event) => setSection(event.target.value as IntakeIdentityScopeSection)}
            >
              {Object.entries(labels)
                .filter(
                  ([key]) => key !== 'questions' && (key !== 'warnings' || !!warningsReference),
                )
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <IdentityScopePage
            key={section}
            scope={scope}
            section={section}
            expectedCount={section === 'warnings' ? warningsReference?.count : undefined}
            onRefresh={onRefresh}
          />
        </>
      )}
    </section>
  );
}
function IdentityScopePage({
  scope,
  section,
  expectedCount,
  onReviewed,
  onRefresh,
}: {
  scope: IntakeIdentityScopeReference;
  section: IntakeIdentityScopeSection;
  expectedCount?: number;
  onReviewed?: (ready: boolean) => void;
  onRefresh: () => void;
}) {
  const profile = useProfile();
  const [position, setPosition] = useState<{ cursor?: string; offset: number }>({ offset: 0 });
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data?: IntakeIdentityScopePage;
    error?: string;
  }>();
  const [inspected, setInspected] = useState<Set<number>>(new Set());
  const binding = JSON.stringify([profile?.id, scope]);
  const key = JSON.stringify([binding, section, position, revision]);
  const reviewed = useRef(onReviewed);
  reviewed.current = onReviewed;
  const expected = section === 'warnings' ? (expectedCount ?? 0) : scope.collection[section];
  useEffect(() => {
    setPosition({ offset: 0 });
    setInspected(new Set());
  }, [binding]);
  useEffect(() => {
    const controller = new AbortController();
    reviewed.current?.(false);
    setInspected(new Set());
    setState({ key });
    const query = new URLSearchParams({
      groupId: scope.groupId,
      scopeToken: scope.scopeToken,
      section,
      limit: '20',
      bytes: '65536',
    });
    if (position.cursor) query.set('cursor', position.cursor);
    void api<IntakeIdentityScopePage>(
      `/intakes/${encodeURIComponent(scope.intakeId)}/identity-scope-page?${query}`,
      { signal: controller.signal },
    )
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        const end = position.offset + data.items.length;
        if (
          data.format !== 'health-intake-identity-scope-page-v2' ||
          data.scopeToken !== scope.scopeToken ||
          data.section !== section ||
          data.total !== expected ||
          data.items.length > 20 ||
          end > expected ||
          (data.nextCursor === null
            ? end !== expected
            : !data.nextCursor ||
              data.nextCursor === position.cursor ||
              !data.items.length ||
              end >= expected) ||
          data.items.some(
            (item, index) =>
              item.kind !== 'value' &&
              (item.kind !== 'reference' ||
                item.reference.format !== 'health-intake-identity-item-v2' ||
                item.reference.scopeToken !== scope.scopeToken ||
                item.reference.section !== section ||
                item.reference.ordinal !== position.offset + index ||
                !Number.isSafeInteger(item.reference.bytes) ||
                item.reference.bytes < 0),
          )
        )
          throw new Error(
            'This identity evidence page changed. Refresh the exact report before confirming.',
          );
        setState({ key, data });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setState({
            key,
            error: cause instanceof Error ? cause.message : 'Identity evidence could not load.',
          });
      });
    return () => controller.abort();
  }, [key]);
  const page = state?.key === key ? state : undefined;
  const completeWindow =
    !!page?.data &&
    page.data.items.every((item, index) => item.kind === 'value' || inspected.has(index));
  useEffect(() => {
    reviewed.current?.(completeWindow && page?.data?.nextCursor === null);
  }, [completeWindow, page?.data]);
  const refresh = () => {
    setPosition({ offset: 0 });
    setRevision((value) => value + 1);
    onRefresh();
  };
  return (
    <section aria-label={labels[section]}>
      <h4>{labels[section]}</h4>
      <p>
        {expected.toLocaleString()} in the complete selected scope. One page is shown at a time.
      </p>
      {page?.error ? (
        <p role="alert">
          {page.error}
          <button type="button" onClick={refresh}>
            Refresh identity evidence
          </button>
        </p>
      ) : !page?.data ? (
        <p role="status">Opening identity evidence…</p>
      ) : (
        <>
          {page.data.items.map((item, index) => (
            <div key={`${key}:${index}`}>
              {item.kind === 'value' ? (
                section === 'questions' &&
                item.value &&
                typeof item.value === 'object' &&
                'prompt' in item.value &&
                typeof item.value.prompt === 'string' ? (
                  <div>
                    <p>{item.value.prompt}</p>
                    {'textAnchor' in item.value && typeof item.value.textAnchor === 'string' && (
                      <q>{item.value.textAnchor}</q>
                    )}
                  </div>
                ) : (
                  <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {JSON.stringify(item.value, null, 2)}
                  </pre>
                )
              ) : (
                <CollectionEvidenceWindow
                  scope={JSON.stringify([binding, item.reference])}
                  bytes={item.reference.bytes}
                  label={`${labels[section]} entry ${item.reference.ordinal + 1}`}
                  path={`/intakes/${encodeURIComponent(scope.intakeId)}/identity-scope-fragment?${new URLSearchParams({ groupId: scope.groupId, scopeToken: scope.scopeToken, section, ordinal: String(item.reference.ordinal) })}`}
                  method="GET"
                  body={{}}
                  onRefresh={refresh}
                  onInspected={(ready) =>
                    setInspected((current) => {
                      if (current.has(index) === ready) return current;
                      const next = new Set(current);
                      if (ready) next.add(index);
                      else next.delete(index);
                      return next;
                    })
                  }
                />
              )}
            </div>
          ))}
          {!completeWindow && <p>Open every page of the referenced evidence before continuing.</p>}
          {page.data.nextCursor && (
            <button
              type="button"
              className="button secondary"
              disabled={!completeWindow}
              onClick={() =>
                setPosition({
                  cursor: page.data!.nextCursor!,
                  offset: position.offset + page.data!.items.length,
                })
              }
            >
              Next {labels[section].toLowerCase()}
            </button>
          )}
          {position.offset > 0 && (
            <button
              type="button"
              className="button secondary"
              onClick={() => setPosition({ offset: 0 })}
            >
              First {labels[section].toLowerCase()}
            </button>
          )}
        </>
      )}
    </section>
  );
}
