import type {
  Note,
  NoteInput,
  NoteKind,
  NoteLink,
  PersonProfile,
  NoteTextFormats,
} from '../../../shared/api.ts';
import { personFields } from './person-fields.ts';
import { normalizedPersonCare, withoutPersonTags } from '../../../shared/person-care.ts';

export type FormState = {
  isSelf: boolean;
  title: string;
  content: string;
  textFormats: NoteTextFormats;
  typeLabel: string;
  eventDate: string;
  topics: string;
  rawThoughts: string;
  pinned: boolean;
  person: PersonProfile;
  links: NoteLink[];
};
export function formFor(note: Note | null): FormState {
  return {
    isSelf: note?.isSelf === true,
    title: (note?.isSelf ? note.person.name : note?.title) || '',
    content: note?.content || '',
    textFormats: note
      ? { ...note.textFormats }
      : {
          content: 'markdown-v1',
          topics: 'markdown-v1',
          rawThoughts: 'markdown-v1',
          medicalHistory: 'markdown-v1',
        },
    typeLabel: note?.typeLabel || '',
    eventDate: note?.eventDate || '',
    topics: note?.topics || '',
    rawThoughts: note?.rawThoughts || '',
    pinned: note?.pinned || false,
    person: personFields(note?.person || {}),
    links: note?.links || [],
  };
}
export function inputFor(form: FormState, kind: NoteKind, version?: number): NoteInput {
  const { isSelf, ...fields } = form;
  return {
    ...fields,
    textFormats: Object.fromEntries(
      Object.entries(form.textFormats || {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
    title:
      form.title.trim() ||
      (isSelf
        ? ''
        : kind === 'person'
          ? 'New person'
          : kind === 'historical'
            ? 'Untitled historical note'
            : 'Untitled note'),
    kind,
    person:
      kind === 'person'
        ? normalizedPersonCare({
            ...(isSelf ? withoutPersonTags(form.person) : form.person),
            name: form.title.trim() || (isSelf ? '' : 'New person'),
          })
        : { ...form.person },
    typeLabel: form.typeLabel.trim() || null,
    eventDate: form.eventDate || null,
    links: form.links
      .map(({ targetType, targetId, relation }) => ({
        targetType,
        targetId,
        relation: relation || 'references',
      }))
      .sort((a, b) =>
        `${a.targetType}:${a.targetId}:${a.relation}`.localeCompare(
          `${b.targetType}:${b.targetId}:${b.relation}`,
        ),
      ),
    version,
  };
}
export function keyFor(form: FormState, kind: NoteKind) {
  return JSON.stringify(inputFor(form, kind));
}
