import type { IntakeIdentityReview } from '../../../shared/intake-identity';

export function ImportIdentityWarnings({
  warnings,
  onReviewPerson,
  reviewLabel = 'Change person',
}: {
  warnings?: IntakeIdentityReview['warnings'];
  onReviewPerson?: () => void;
  reviewLabel?: string;
}) {
  const modelBirthDateWarnings = warnings?.filter(
    (warning) => warning.kind === 'model_birth_date_mismatch',
  );
  if (!modelBirthDateWarnings?.length) return null;
  return (
    <div className="import-model-date-warning" role="status">
      {modelBirthDateWarnings.map((warning) => (
        <p key={`${warning.personName}:${warning.modelBirthDate}:${warning.savedBirthDate}`}>
          The automatic reading suggested a date of birth of {warning.modelBirthDate}, but that date
          has not been verified in the original. {warning.personName} has a saved date of birth of{' '}
          {warning.savedBirthDate}. Check the original or change the person if needed.
        </p>
      ))}
      {onReviewPerson && (
        <button type="button" className="text-link" onClick={onReviewPerson}>
          {reviewLabel}
        </button>
      )}
    </div>
  );
}
