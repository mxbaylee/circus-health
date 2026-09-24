import { ExternalLink } from 'lucide-react';
import type { PersonProfile } from '../../../shared/api';
import { personContactError, canSchedulePerson } from '../../../shared/person-care';

export function PersonContacts({
  person,
  onChange,
  disabled = false,
  isSelf = false,
}: {
  person: PersonProfile;
  onChange: (field: 'phone' | 'email' | 'schedulingUrl', value: string) => void;
  disabled?: boolean;
  isSelf?: boolean;
}) {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const error = personContactError(person);
  const showScheduling = canSchedulePerson(person, isSelf);
  const scheduling = text(person.schedulingUrl).trim();
  return (
    <fieldset className="note-field person-contacts" disabled={disabled}>
      <legend>
        Contact details <span className="quiet-badge">Optional</span>
      </legend>
      <div className="note-fields-pair">
        <label className="note-field">
          Phone
          <input
            type="tel"
            maxLength={200}
            value={text(person.phone)}
            onChange={(event) => onChange('phone', event.target.value)}
            autoComplete="off"
            placeholder="Include a country code or extension if useful"
          />
        </label>
        <label className="note-field">
          Email
          <input
            type="email"
            maxLength={320}
            value={text(person.email)}
            onChange={(event) => onChange('email', event.target.value)}
            autoComplete="off"
            placeholder="name@example.com"
          />
        </label>
      </div>
      {showScheduling && (
        <label className="note-field">
          Scheduling URL
          <input
            type="url"
            maxLength={2048}
            value={text(person.schedulingUrl)}
            onChange={(event) => onChange('schedulingUrl', event.target.value)}
            autoComplete="off"
            placeholder="https://…"
          />
        </label>
      )}
      {showScheduling && scheduling && !personContactError({ schedulingUrl: scheduling }) && (
        <a className="text-link" href={scheduling} target="_blank" rel="noopener noreferrer">
          Open scheduling page <ExternalLink size={14} />
        </a>
      )}
      {error && (
        <small role="status">{error} Changes will save when the contact details are valid.</small>
      )}
    </fieldset>
  );
}
