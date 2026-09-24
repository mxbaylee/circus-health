import type { Ref } from 'react';
import { Pencil, X } from 'lucide-react';
import './selection-chip.css';

export function SelectionChip({
  label,
  disabled = false,
  onEdit,
  onRemove,
  editLabel = `Edit ${label}`,
  removeLabel = `Remove ${label}`,
  editButtonRef,
}: {
  label: string;
  disabled?: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
  editLabel?: string;
  removeLabel?: string;
  editButtonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <span className="selection-chip">
      <span className="selection-chip-label">{label}</span>
      {onEdit && (
        <button
          ref={editButtonRef}
          type="button"
          disabled={disabled}
          aria-label={editLabel}
          onClick={onEdit}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
      )}
      {onRemove && (
        <button type="button" disabled={disabled} aria-label={removeLabel} onClick={onRemove}>
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
