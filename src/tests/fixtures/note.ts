import type { Note } from '../../shared/api.ts';

/** Independently fictional complete DTO for focused editor tests. */
export function fictionalNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'fictional-note',
    kind: 'note',
    status: 'editable',
    title: '',
    content: '',
    typeLabel: null,
    eventDate: null,
    topics: '',
    rawThoughts: '',
    personId: null,
    person: {},
    pinned: false,
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
    version: 1,
    sourceRecordId: null,
    links: [],
    backlinks: [],
    attachments: [],
    ...overrides,
  };
}
