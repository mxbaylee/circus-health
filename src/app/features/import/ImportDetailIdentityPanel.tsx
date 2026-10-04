import { IdentityScopeEvidence } from './IdentityScopeEvidence';
import { useEffect, useRef, useState } from 'react';
import type { IntakeIdentityAnswers, IntakeIdentityReview } from '../../../shared/intake-identity';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { ImportIdentityWarnings } from './ImportIdentityWarnings';
import { ImportFutureNameChoice, type FutureNameChoice } from './ImportFutureNameChoice';
import {
  ImportPersonChoice,
  ImportBirthDateReview,
  ImportPrintedName,
  printedNameReady,
  personSelectionReady,
  type ImportPersonSelection,
} from './ImportPersonChoice';

// Identity evidence and optional Self-field choices stay local to this panel.
// The parent retains navigation, draft guards and the confirmation operation.
export function ImportDetailIdentityPanel({
  review,
  loading,
  error,
  notice,
  busy,
  onRetry,
  onConfirm,
  onDone,
}: {
  review?: IntakeIdentityReview;
  loading: boolean;
  error: string;
  notice: string;
  busy: boolean;
  onRetry: () => void;
  onDone: () => void;
  onConfirm: (
    fields: { fullName?: string; birthDate?: string },
    personSelection?: ImportPersonSelection,
    printedName?: string,
    identityAnswers?: IntakeIdentityAnswers,
    futureNameOwner?: FutureNameChoice,
  ) => void;
}) {
  const scope = review?.scopeReference || review?.scope;
  const [reviewedQuestions, setReviewedQuestions] = useState<string>();
  const questionsReady =
    !review?.scopeReference?.collection.questions || reviewedQuestions === scope?.scopeToken;
  const [personSelection, setPersonSelection] = useState<ImportPersonSelection>();
  const [futureNameOwner, setFutureNameOwner] = useState<FutureNameChoice>({ outcome: 'ask' });
  const [selectedPrintedName, setSelectedPrintedName] = useState('');
  const [reviewedBirthDate, setReviewedBirthDate] = useState<string | null>(
    scope?.birthDateReview?.suggested || null,
  );
  const offered: { fullName?: string; birthDate?: string } = review?.offeredSelfFields.birthDate
    ? { birthDate: review.offeredSelfFields.birthDate }
    : {};
  const selectionScope = scope
    ? [
        scope.profileId,
        scope.intakeId,
        scope.groupId,
        scope.groupVersionId,
        scope.memberId || '',
      ].join(':')
    : null;
  const [selected, setSelected] = useState<Set<'fullName' | 'birthDate'>>(
    () => new Set(Object.keys(offered) as ('fullName' | 'birthDate')[]),
  );
  const previousOffers = useRef<{
    scope: string | null;
    fullName?: string;
    birthDate?: string;
  }>({ scope: null });
  useEffect(() => {
    if (!review || !selectionScope) return;
    const previous = previousOffers.current;
    if (previous.scope !== selectionScope) {
      setSelectedPrintedName('');
      setFutureNameOwner({ outcome: 'ask' });
      setReviewedBirthDate(scope?.birthDateReview?.suggested || null);
    }
    if (previous.scope !== selectionScope)
      setPersonSelection(
        review.assignedPerson && review.assignedPerson.personId !== 'patient'
          ? { noteId: review.assignedPerson.noteId, expectedVersion: review.assignedPerson.version }
          : undefined,
      );
    setSelected((current) => {
      const next = new Set<'fullName' | 'birthDate'>();
      if (
        offered.fullName &&
        (previous.scope !== selectionScope ||
          previous.fullName !== offered.fullName ||
          current.has('fullName'))
      )
        next.add('fullName');
      if (
        offered.birthDate &&
        (previous.scope !== selectionScope ||
          previous.birthDate !== offered.birthDate ||
          current.has('birthDate'))
      )
        next.add('birthDate');
      return next;
    });
    previousOffers.current = {
      scope: selectionScope,
      fullName: offered.fullName,
      birthDate: offered.birthDate,
    };
  }, [offered.birthDate, offered.fullName, selectionScope]);

  if (!review && !loading && !error) return null;
  if (!review && loading)
    return <LoadingIndicator label="Checking retained identity evidence…" layout="inline" />;
  if (!review)
    return (
      <section className="import-identity-question is-conflict" role="alert">
        <div>
          <strong>Identity status could not load.</strong>
          <small>{error}</small>
        </div>
        <button className="button secondary" type="button" onClick={onRetry}>
          Retry identity check
        </button>
      </section>
    );

  if (review.status === 'missing_warning')
    return (
      <section className="import-identity-question is-warning" role="status">
        <div>
          <strong>Identity is not printed clearly in this report.</strong>
          <small>{review.message} This warning does not block clinical review.</small>
        </div>
      </section>
    );

  if (review.status === 'conflict' && !scope)
    return (
      <section className="import-identity-question is-conflict" role="alert">
        <div>
          <strong>Review the conflicting report evidence before choosing a person.</strong>
          <small>{review.message}</small>
          {review.conflicts.map((conflict) => (
            <small key={`${conflict.field}:${conflict.evidencedValue}`}>
              {conflict.field === 'fullName' ? 'Full name' : 'Date of birth'}: Self has{' '}
              {conflict.selfValue || 'no value'}; report evidence has {conflict.evidencedValue}.
            </small>
          ))}
        </div>
      </section>
    );

  const confirmed = review.status === 'evidenced_match' || review.status === 'prior_confirmation';
  const offeredEntries = (
    Object.entries(offered) as ['fullName' | 'birthDate', string | undefined][]
  ).filter((entry): entry is ['fullName' | 'birthDate', string] => !!entry[1]);
  const unchanged =
    confirmed &&
    !review.challengedName &&
    !(review.status === 'evidenced_match' && !review.evidencedIdentity.birthDate) &&
    (!personSelection
      ? !review.assignedPerson || review.assignedPerson.personId === 'patient'
      : 'noteId' in personSelection && personSelection.noteId === review.assignedPerson?.noteId) &&
    (!offered.birthDate || !selected.has('birthDate')) &&
    !!review.evidencedIdentity.fullName;
  return (
    <section
      className="import-identity-question import-identity-editor"
      aria-label="Report identity"
    >
      <div>
        <strong>
          {confirmed
            ? review.assignedPerson
              ? `This report belongs to ${review.assignedPerson.fullName}.`
              : 'This report already matches Self.'
            : `This report identifies “${review.evidencedIdentity.fullName || scope?.subject.text || 'Self'}”.`}
        </strong>
        {!review.scope?.questions?.some((question) => question.prompt === review.message) && (
          <small>{review.message}</small>
        )}
        <ImportIdentityWarnings warnings={review.warnings} />
        {review.evidencedIdentity.birthDate && (
          <small>Printed date of birth: {review.evidencedIdentity.birthDate}</small>
        )}
        {scope && !confirmed && (
          <small>
            This confirmation applies to{' '}
            {review.scopeReference?.collection.assignmentTargets ??
              (review.scope?.assignmentTargets || review.scope?.targets || []).length}{' '}
            {(review.scopeReference?.collection.assignmentTargets ??
              (review.scope?.assignmentTargets || review.scope?.targets || []).length) === 1
              ? 'record'
              : 'records'}{' '}
            in this retained report scope.
          </small>
        )}
        {review.scopeReference && (
          <IdentityScopeEvidence
            key={scope!.scopeToken}
            scope={review.scopeReference}
            onRefresh={onRetry}
            onQuestionsReviewed={(ready) =>
              setReviewedQuestions(ready ? scope!.scopeToken : undefined)
            }
          />
        )}
        {review.scope?.questions?.map((question) => (
          <span
            className="import-identity-evidence"
            key={`${question.prompt}:${question.textAnchor}`}
          >
            {question.prompt}
            {question.textAnchor && <q>{question.textAnchor}</q>}
          </span>
        ))}
        {scope && !review.evidencedIdentity.fullName && (
          <ImportPrintedName
            value={selectedPrintedName}
            subjectText={scope!.subject.text}
            onChange={setSelectedPrintedName}
            disabled={busy}
          />
        )}
        {scope?.birthDateReview && (
          <ImportBirthDateReview
            review={scope!.birthDateReview}
            value={reviewedBirthDate}
            onChange={setReviewedBirthDate}
            disabled={busy}
          />
        )}
        <ImportPersonChoice
          selfNames={[review.self.fullName || '', ...(review.self.knownNames || [])]}
          selfDisabled={review.selfBirthDateConflict}
          birthDate={reviewedBirthDate || review.evidencedIdentity.birthDate}
          people={review.people}
          peopleTruncated={review.peopleTruncated}
          assignedPerson={review.assignedPerson}
          printedName={review.evidencedIdentity.fullName || selectedPrintedName}
          selection={personSelection}
          onChange={setPersonSelection}
          disabled={busy || !scope}
        />
        {review.challengedName && (
          <ImportFutureNameChoice
            name={review.challengedName}
            people={review.people}
            value={futureNameOwner}
            onChange={setFutureNameOwner}
            disabled={busy}
          />
        )}
        {!personSelection && offeredEntries.length > 0 && (
          <fieldset className="import-identity-self-fields">
            <legend>
              Optional blank Self details — importing clinical records does not require these
            </legend>
            {offeredEntries.map(([field, value]) => (
              <label key={field}>
                <input
                  type="checkbox"
                  checked={selected.has(field)}
                  disabled={busy}
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(field);
                      else next.delete(field);
                      return next;
                    })
                  }
                />
                <span>
                  {field === 'fullName' ? 'Full name' : 'Date of birth'}: <strong>{value}</strong>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {notice && <small role="status">{notice}</small>}
        {error && <small role="alert">{error}</small>}
      </div>
      {!!scope && (
        <button
          className="button secondary"
          type="button"
          disabled={
            busy ||
            loading ||
            !questionsReady ||
            !scope ||
            !personSelectionReady(personSelection, [
              review.self.fullName || '',
              ...(review.self.knownNames || []),
            ]) ||
            reviewedBirthDate === '' ||
            (!review.evidencedIdentity.fullName &&
              !printedNameReady(selectedPrintedName, scope!.subject.text))
          }
          onClick={() => {
            if (unchanged) {
              onDone();
              return;
            }
            onConfirm(
              personSelection
                ? {}
                : Object.fromEntries(
                    [...selected].flatMap((field) => {
                      const value = offered[field];
                      return value ? [[field, value]] : [];
                    }),
                  ),
              personSelection,
              !review.evidencedIdentity.fullName ? selectedPrintedName.trim() : undefined,
              scope?.birthDateReview ? { birthDate: reviewedBirthDate } : undefined,
              review.challengedName ? futureNameOwner : undefined,
            );
          }}
        >
          {busy
            ? 'Confirming…'
            : unchanged
              ? 'Done'
              : personSelection
                ? 'Confirm person'
                : confirmed
                  ? 'Save changes'
                  : offeredEntries.length
                    ? 'This is me and add selected details'
                    : 'This is me'}
        </button>
      )}
    </section>
  );
}
