import { useState } from 'react';

/** Skipping never invokes WebAuthn. Keep this secondary choice separate from Verify. */
export default function SkipStep({
  title,
  disabled,
  onSkip,
}: {
  title: string;
  disabled: boolean;
  onSkip(): void;
}) {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div className="checker-reset">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setAcknowledged(false);
        }}
      >
        {open ? 'Cancel skip' : "Can't test this step?"}
      </button>
      {open && (
        <fieldset disabled={disabled}>
          <legend>{`Skip ${title}`}</legend>
          <p>No validation will run. This step will remain unverified, not passed.</p>
          <label className="checker-confirm-save">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I understand this skips the test without verifying it
          </label>
          <button
            type="button"
            disabled={disabled || !acknowledged}
            onClick={() => {
              if (disabled || !acknowledged) return;
              setAcknowledged(false);
              setOpen(false);
              onSkip();
            }}
          >
            Skip this test without verifying
          </button>
        </fieldset>
      )}
    </div>
  );
}
