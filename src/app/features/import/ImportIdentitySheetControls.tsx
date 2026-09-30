import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { IntakeIdentityAnswers } from '../../../shared/intake-identity';
import type { ImportReviewReport } from './ImportReviewPresentation';
import {
  ImportPersonChoice,
  ImportBirthDateReview,
  ImportPrintedName,
  printedNameReady,
  personSelectionReady,
  type ImportPersonSelection,
} from './ImportPersonChoice';
import { ImportIdentityWarnings } from './ImportIdentityWarnings';
import { ImportFutureNameChoice, type FutureNameChoice } from './ImportFutureNameChoice';

export function ImportIdentitySheetControls({
  report,
  busy,
  close,
  confirmIdentity,
  personSelection,
  setPersonSelection,
  selectedPrintedName,
  setSelectedPrintedName,
  reviewedBirthDate,
  setReviewedBirthDate,
  selectedSelfFields,
  setSelectedSelfFields,
  futureNameOwner,
  setFutureNameOwner,
}: {
  report: ImportReviewReport;
  busy: boolean;
  close: () => void;
  confirmIdentity: (
    reportId: string,
    fields: { fullName?: string; birthDate?: string },
    personSelection?: ImportPersonSelection,
    printedName?: string,
    identityAnswers?: IntakeIdentityAnswers,
    futureNameOwner?: FutureNameChoice,
  ) => void;
  personSelection: ImportPersonSelection;
  setPersonSelection: Dispatch<SetStateAction<ImportPersonSelection>>;
  selectedPrintedName: string;
  setSelectedPrintedName: Dispatch<SetStateAction<string>>;
  reviewedBirthDate: string | null;
  setReviewedBirthDate: Dispatch<SetStateAction<string | null>>;
  selectedSelfFields: Set<'fullName' | 'birthDate'>;
  setSelectedSelfFields: Dispatch<SetStateAction<Set<'fullName' | 'birthDate'>>>;
  futureNameOwner: FutureNameChoice;
  setFutureNameOwner: Dispatch<SetStateAction<FutureNameChoice>>;
}) {
  const needsPrintedName = !!report.subject.printedNameRequired;
  const offeredSelfFields: { fullName?: string; birthDate?: string } = report.subject
    .offeredSelfFields?.birthDate
    ? { birthDate: report.subject.offeredSelfFields.birthDate }
    : {};
  const offeredBirthDate = offeredSelfFields.birthDate;
  return (
    <>
      <Dialog.Description>
        {report.subject.identityStatus === 'conflict' && report.subject.scopeReady === false
          ? 'Processing could not establish a consistent report identity. Editing a result cannot resolve this issue, and these records cannot be approved yet.'
          : report.subject.confirmed
            ? 'Review who this report belongs to. Accepted records keep their existing attribution.'
            : 'Choose yourself or another person for the records in this report. Clinical results remain in review.'}
      </Dialog.Description>
      <div className="import-sheet-card import-context-card">
        <strong>
          {report.subject.identityStatus === 'missing_warning'
            ? 'Identity is not printed clearly in this report.'
            : report.subject.identityStatus === 'conflict'
              ? report.subject.scopeReady === false
                ? 'Report identity could not be established.'
                : 'Choose who this report belongs to.'
              : 'Report subject'}
        </strong>
        <span>
          {report.subject.evidenceText
            ? `The report identifies “${report.subject.evidenceText}”.`
            : 'Check the retained report before confirming identity.'}
        </span>
        {report.subject.identityMessage &&
          !report.subject.questions?.some(
            (question) => question.prompt === report.subject.identityMessage,
          ) && <span>{report.subject.identityMessage}</span>}
        <ImportIdentityWarnings warnings={report.subject.warnings} />
        {report.subject.scopeError && <span role="alert">{report.subject.scopeError}</span>}
        {report.subject.conflicts?.map((conflict) => (
          <span key={`${conflict.field}:${conflict.evidencedValue}`}>
            {conflict.field === 'fullName' ? 'Full name' : 'Date of birth'}: Self has{' '}
            {conflict.selfValue || 'no value'}; report evidence has{' '}
            {conflict.evidencedValue || 'different retained claims'}.
          </span>
        ))}
        {report.subject.scopeReady === false &&
          !report.subject.scopeError &&
          !report.subject.identityStatus && <span>Checking retained identity evidence…</span>}
        {!report.subject.confirmed && report.subject.targetCount !== undefined && (
          <span>
            This applies to {report.subject.targetCount}{' '}
            {report.subject.targetCount === 1 ? 'record' : 'records'} in this report.
          </span>
        )}
        {report.subject.questions?.map((question) => (
          <span key={`${question.prompt}:${question.textAnchor || ''}`}>
            <span>{question.prompt}</span>
            {question.textAnchor && <q>{question.textAnchor}</q>}
          </span>
        ))}
      </div>
      {needsPrintedName && (
        <ImportPrintedName
          value={selectedPrintedName}
          subjectText={report.subject.evidenceText || ''}
          onChange={setSelectedPrintedName}
          disabled={busy}
        />
      )}
      {report.subject.birthDateReview && (
        <ImportBirthDateReview
          review={report.subject.birthDateReview}
          value={reviewedBirthDate}
          onChange={setReviewedBirthDate}
          disabled={busy}
        />
      )}
      <ImportPersonChoice
        selfNames={report.subject.selfNames}
        selfDisabled={report.subject.selfBirthDateConflict}
        birthDate={reviewedBirthDate || report.subject.birthDate}
        people={report.subject.people}
        peopleTruncated={report.subject.peopleTruncated}
        assignedPerson={report.subject.assignedPerson}
        printedName={report.subject.printedName || selectedPrintedName}
        selection={personSelection}
        onChange={setPersonSelection}
        disabled={busy || report.subject.scopeReady === false}
      />
      {report.subject.challengedName && (
        <ImportFutureNameChoice
          name={report.subject.challengedName}
          people={report.subject.people}
          value={futureNameOwner}
          onChange={setFutureNameOwner}
          disabled={busy}
        />
      )}
      {report.subject.reviewUrl && (
        <a className="text-link" href={`#${report.subject.reviewUrl}`}>
          Review retained report evidence <ArrowRight size={15} aria-hidden="true" />
        </a>
      )}
      {!personSelection && !!Object.keys(offeredSelfFields).length && (
        <fieldset className="import-fill-name">
          <legend>Fill selected blank Self details in this same action</legend>
          <p className="import-sheet-note">
            These exact values came from retained report evidence. Existing Self fields are never
            overwritten.
          </p>
          {(['fullName', 'birthDate'] as const).flatMap((field) => {
            const value = offeredSelfFields[field];
            if (!value) return [];
            return [
              <label className="import-check-label" key={field}>
                <input
                  type="checkbox"
                  checked={selectedSelfFields.has(field)}
                  onChange={(event) =>
                    setSelectedSelfFields((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(field);
                      else next.delete(field);
                      return next;
                    })
                  }
                />
                {field === 'fullName' ? 'Full name' : 'Date of birth'}: <strong>{value}</strong>
              </label>,
            ];
          })}
          <small>
            Self display name stays “{report.subject.selfDisplayName || report.subject.label}”.
          </small>
        </fieldset>
      )}
      <div className="import-sheet-actions">
        <button className="button secondary" type="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          type="button"
          disabled={
            busy ||
            report.subject.scopeReady === false ||
            reviewedBirthDate === '' ||
            report.subject.identityStatus === 'missing_warning' ||
            (!personSelection && !!report.subject.selfBirthDateConflict) ||
            !personSelectionReady(personSelection, report.subject.selfNames) ||
            (needsPrintedName &&
              !printedNameReady(selectedPrintedName, report.subject.evidenceText || ''))
          }
          onClick={() => {
            if (
              report.subject.confirmed &&
              !report.subject.nameOnlyMatch &&
              !report.subject.challengedName &&
              !needsPrintedName &&
              (!personSelection
                ? !report.subject.assignedPerson ||
                  report.subject.assignedPerson.personId === 'patient'
                : 'noteId' in personSelection &&
                  personSelection.noteId === report.subject.assignedPerson?.noteId) &&
              (!offeredBirthDate || !selectedSelfFields.has('birthDate'))
            ) {
              close();
              return;
            }
            confirmIdentity(
              report.id,
              personSelection
                ? {}
                : Object.fromEntries(
                    [...selectedSelfFields].flatMap((field) => {
                      const value = offeredSelfFields[field];
                      return value ? [[field, value]] : [];
                    }),
                  ),
              personSelection,
              needsPrintedName ? selectedPrintedName.trim() : undefined,
              report.subject.birthDateReview ? { birthDate: reviewedBirthDate } : undefined,
              report.subject.challengedName ? futureNameOwner : undefined,
            );
          }}
        >
          {report.subject.confirmed &&
          !report.subject.nameOnlyMatch &&
          !report.subject.challengedName &&
          !needsPrintedName &&
          (!personSelection
            ? !report.subject.assignedPerson || report.subject.assignedPerson.personId === 'patient'
            : 'noteId' in personSelection &&
              personSelection.noteId === report.subject.assignedPerson?.noteId) &&
          (!offeredBirthDate || !selectedSelfFields.has('birthDate'))
            ? 'Done'
            : personSelection
              ? 'Confirm person'
              : report.subject.confirmed
                ? 'Save changes'
                : 'This is me'}
        </button>
      </div>
    </>
  );
}
