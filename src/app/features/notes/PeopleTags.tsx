import { useState } from 'react';
import { CreatableCombobox } from '../../components/CreatableCombobox';
import { SelectionChip } from '../../components/SelectionChip';
import {
  MAX_PERSON_TAG_LENGTH,
  normalizePersonTags,
  PERSON_TAG_SUGGESTIONS,
} from '../../../shared/person-care';

export function PersonTagChips({ tags, badges = false }: { tags?: string[]; badges?: boolean }) {
  if (!Array.isArray(tags) || !tags.length) return null;
  return (
    <span
      className={`person-tag-chips${badges ? ' person-list-badges' : ''}`}
      aria-label="Person tags"
    >
      {tags
        .filter((tag) => typeof tag === 'string')
        .map((tag) =>
          badges ? (
            <span className="quiet-badge self-tag person-list-tag" key={tag}>
              {tag}
            </span>
          ) : (
            <SelectionChip label={tag} key={tag} />
          ),
        )}
    </span>
  );
}

export function PeopleTags({
  tags = [],
  options = [],
  onChange,
  disabled = false,
}: {
  tags?: string[];
  options?: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState('');
  const selected = Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [];
  function update(next: string[]) {
    try {
      onChange(normalizePersonTags(next));
      setError('');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This tag could not be added.');
      return false;
    }
  }
  return (
    <fieldset className="note-field person-tags-editor" disabled={disabled}>
      <legend>Tags</legend>
      <small>
        Choose any that apply. These are labels you assign, separate from relationships.
      </small>
      <CreatableCombobox
        label="Add a tag"
        hideLabel
        multiple
        values={selected}
        options={[...PERSON_TAG_SUGGESTIONS, ...options]}
        disabled={disabled}
        maxLength={MAX_PERSON_TAG_LENGTH}
        placeholder="Search or add a tag"
        listLabel="Person tags"
        createNoun="tag"
        onChange={update}
      />
      {error && (
        <p role="alert" className="note-warning">
          {error}
        </p>
      )}
    </fieldset>
  );
}
