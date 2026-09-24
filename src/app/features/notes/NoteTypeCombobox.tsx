import { CreatableCombobox } from '../../components/CreatableCombobox';

export function NoteTypeCombobox({
  value,
  options,
  disabled = false,
  onChange,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <CreatableCombobox
      label="Type"
      values={value ? [value] : []}
      options={[...options, ...(value ? [value] : []), 'Dr. Visit']}
      disabled={disabled}
      maxLength={100}
      placeholder="Choose or add a type"
      listLabel="Note types"
      createNoun="type"
      onChange={(values) => onChange(values[0] || '')}
    />
  );
}
