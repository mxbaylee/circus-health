import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { NoteExportDialog } from '../../app/features/notes/NoteExportDialog';
import { PacketSelection, PacketPrivateReview } from '../../app/features/notes/PacketSelection';
import { selectProfile } from '../../app/data/profile';

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const privateRecord = {
  record: { kind: 'observation', recordId: 'sensitive' },
  key: 'observation:sensitive',
  title: 'Fictional private screening',
  date: '2026-02-03',
  kind: 'observation',
  tags: ['Personal'],
  alwaysWithhold: true,
  preferenceVersion: 2,
  opaque: false,
};
const routineRecord = {
  ...privateRecord,
  record: { kind: 'procedure', recordId: 'routine' },
  key: 'procedure:routine',
  title: 'Fictional routine procedure',
  kind: 'procedure',
  tags: [],
  alwaysWithhold: false,
  preferenceVersion: 0,
};
const options = {
  noteTitle: 'Fictional managed person',
  noteVersion: 3,
  choices: [],
  assets: [],
  packet: {
    personId: 'managed-person',
    candidates: [privateRecord, routineRecord],
    kinds: ['observation', 'procedure'],
    tags: ['Personal'],
  },
};
const review = {
  withheld: [{ key: privateRecord.key, title: privateRecord.title, reason: 'Always leave out' }],
  includedCount: 1,
  emptyKinds: ['observation'],
  opaqueItems: [
    {
      key: 'original:shared',
      title: 'Fictional shared original',
      fingerprint: 'exact-scope',
      blocked: false,
      reason: 'Shares a source with an excluded record',
      included: false,
    },
    {
      key: 'original:blocked',
      title: 'Fictional persistently withheld original',
      fingerprint: 'blocked-scope',
      blocked: true,
      reason: 'Contains a persistently withheld record',
      included: false,
    },
  ],
  notice: "Some records were left out at the patient's request",
};
const preview = {
  token: 'frozen',
  html: '<h1>Shared packet</h1>',
  fingerprint: 'frozen-membership',
  generatedAt: '2026-10-03',
  assets: [
    {
      id: 'original',
      originalName: 'fictional-companion.pdf',
      contentUrl: '/frozen/assets/original',
    },
  ],
  packetReview: review,
};
beforeEach(() => {
  selectProfile({ id: 'fictional-profile', name: 'Fictional profile', placebo: true });
});

it('sends manual kind, date, tag and record choices while persistent withholding stays separate', async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/options')) return response(options);
      if (String(input).endsWith('/preview')) {
        requests.push(JSON.parse(init.body));
        return response(preview);
      }
      throw new Error(`Unexpected ${input}`);
    }),
  );
  render(<NoteExportDialog type="person" id="managed-person" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await screen.findByRole('button', { name: 'Preview provider packet' });
  const privateChoice = screen.getByRole('combobox', {
    name: `Packet choice for ${privateRecord.title}`,
  });
  expect(privateChoice).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Results' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Personal' }));
  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-01-01' } });
  fireEvent.change(screen.getByLabelText('Through date'), { target: { value: '2026-04-01' } });
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: `Packet choice for ${routineRecord.title}` }),
    'include',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Preview provider packet' }));
  await screen.findByTitle('Exact export preview');
  expect(requests[0].packetSelection).toEqual({
    kinds: ['procedure'],
    tags: ['Personal'],
    from: '2026-01-01',
    to: '2026-04-01',
    include: [routineRecord.record],
    exclude: [],
    approvals: [],
  });
  expect(screen.getByRole('region', { name: 'Private packet review' })).toHaveTextContent(
    privateRecord.title,
  );
  expect(screen.getByText(/No selected records in these categories/)).toHaveTextContent('Results');
  expect(screen.getByTitle('Exact export preview')).toHaveAttribute(
    'srcdoc',
    '<h1>Shared packet</h1>',
  );
});

it('changes persistent preference explicitly and refreshes its version without erasing packet choices', async () => {
  let saved = false;
  const preferences: unknown[] = [];
  const previews: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/options'))
        return response(
          saved
            ? {
                ...options,
                packet: {
                  ...options.packet,
                  candidates: [
                    { ...privateRecord, alwaysWithhold: false, preferenceVersion: 3 },
                    routineRecord,
                  ],
                },
              }
            : options,
        );
      if (String(input).endsWith('/preferences')) {
        preferences.push(JSON.parse(init.body));
        saved = true;
        return response({ version: 3 });
      }
      if (String(input).endsWith('/preview')) {
        previews.push(JSON.parse(init.body));
        return response(preview);
      }
      throw new Error(`Unexpected ${input}`);
    }),
  );
  render(<NoteExportDialog type="person" id="managed-person" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await screen.findByRole('button', { name: 'Preview provider packet' });
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: `Packet choice for ${routineRecord.title}` }),
    'exclude',
  );
  await userEvent.click(
    screen.getByRole('button', { name: `Clear always leave out for ${privateRecord.title}` }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: `Packet choice for ${privateRecord.title}` }),
    ).toBeEnabled(),
  );
  expect(preferences).toEqual([
    {
      type: 'person',
      id: 'managed-person',
      personId: 'managed-person',
      record: privateRecord.record,
      alwaysWithhold: false,
      tags: ['Personal'],
      expectedVersion: 2,
    },
  ]);
  expect(
    screen.getByRole('combobox', { name: `Packet choice for ${routineRecord.title}` }),
  ).toHaveValue('exclude');
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: `Packet choice for ${privateRecord.title}` }),
    'include',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Preview provider packet' }));
  await screen.findByTitle('Exact export preview');
  expect(preferences).toHaveLength(1);
  expect(previews[0].packetSelection).toMatchObject({
    include: [privateRecord.record],
    exclude: [routineRecord.record],
  });
});

it('explicit unredacted approval requires a new frozen preview and cannot override persistent conflicts', async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/options')) return response(options);
      if (String(input).endsWith('/preview')) {
        requests.push(JSON.parse(init.body));
        return response(preview);
      }
      throw new Error('No output before disclosure choices are frozen again');
    }),
  );
  render(<NoteExportDialog type="person" id="managed-person" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Preview provider packet' }));
  await screen.findByTitle('Exact export preview');
  expect(screen.getByRole('link', { name: 'fictional-companion.pdf' })).toBeInTheDocument();
  expect(
    screen.getByRole('checkbox', { name: /Fictional persistently withheld original/ }),
  ).toBeDisabled();
  expect(
    screen.getByText(/Leaving out a record does not remove sensitive information/),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole('checkbox', { name: /Fictional shared original/ }));
  expect(screen.queryByRole('link', { name: 'fictional-companion.pdf' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Print$/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Download evidence JSON' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled());
  expect(requests[1].packetSelection).toEqual({
    approvals: [{ key: 'original:shared', fingerprint: 'exact-scope' }],
  });
  expect(screen.getByRole('link', { name: 'fictional-companion.pdf' })).toBeInTheDocument();
});

it('person-applied tag changes preserve withholding and appear as category choices after save', async () => {
  const requests: Record<string, unknown>[] = [];
  let saved = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/options'))
        return response(
          saved
            ? {
                ...options,
                packet: {
                  ...options.packet,
                  tags: ['Personal', 'Specialist'],
                  candidates: [
                    { ...privateRecord, tags: ['Personal', 'Specialist'], preferenceVersion: 3 },
                    routineRecord,
                  ],
                },
              }
            : options,
        );
      if (String(input).endsWith('/preferences')) {
        requests.push(JSON.parse(init.body));
        saved = true;
        return response({ version: 3 });
      }
      throw new Error(`Unexpected ${input}`);
    }),
  );
  render(<NoteExportDialog type="person" id="managed-person" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await screen.findByRole('button', { name: 'Preview provider packet' });
  const input = screen.getByRole('textbox', { name: `Tags for ${privateRecord.title}` });
  await userEvent.clear(input);
  await userEvent.type(input, 'Personal, Specialist, Specialist');
  await userEvent.click(
    screen.getByRole('button', { name: `Save tags for ${privateRecord.title}` }),
  );
  await screen.findByRole('checkbox', { name: 'Specialist' });
  expect(requests).toEqual([
    {
      type: 'person',
      id: 'managed-person',
      personId: 'managed-person',
      record: privateRecord.record,
      alwaysWithhold: true,
      tags: ['Personal', 'Specialist'],
      expectedVersion: 2,
    },
  ]);
  expect(
    screen.getByRole('combobox', { name: `Packet choice for ${privateRecord.title}` }),
  ).toBeDisabled();
});

it('bounds record pages and retains packet choices and unsaved tags through paging and search', async () => {
  const candidates = Array.from({ length: 55 }, (_, index) => ({
    ...routineRecord,
    record: { kind: 'procedure', recordId: `record-${index + 1}` },
    key: `procedure:record-${index + 1}`,
    title: `Fictional record ${String(index + 1).padStart(2, '0')}`,
  }));
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/options'))
        return response({
          ...options,
          packet: { ...options.packet, candidates, kinds: ['procedure'], tags: [] },
        });
      if (String(input).endsWith('/preview')) {
        requests.push(JSON.parse(init.body));
        return response(preview);
      }
      throw new Error(`Unexpected ${input}`);
    }),
  );
  render(<NoteExportDialog type="person" id="managed-person" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await screen.findByRole('button', { name: 'Preview provider packet' });
  expect(screen.getByRole('navigation', { name: 'Records pages' })).toHaveTextContent(
    '1–50 of 55 records',
  );
  expect(screen.getAllByRole('combobox', { name: /Packet choice for/ })).toHaveLength(50);
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Packet choice for Fictional record 01' }),
    'include',
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Tags for Fictional record 01' }),
    'Unsent draft',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Next records' }));
  expect(screen.getByRole('navigation', { name: 'Records pages' })).toHaveTextContent(
    '51–55 of 55 records',
  );
  expect(screen.getAllByRole('combobox', { name: /Packet choice for/ })).toHaveLength(5);
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Packet choice for Fictional record 55' }),
    'exclude',
  );
  await userEvent.type(screen.getByRole('searchbox', { name: 'Find a record' }), 'record 01');
  expect(screen.getByRole('navigation', { name: 'Records pages' })).toHaveTextContent(
    '1–1 of 1 records',
  );
  expect(
    screen.getByRole('combobox', { name: 'Packet choice for Fictional record 01' }),
  ).toHaveValue('include');
  expect(screen.getByRole('textbox', { name: 'Tags for Fictional record 01' })).toHaveValue(
    'Unsent draft',
  );
  await userEvent.clear(screen.getByRole('searchbox', { name: 'Find a record' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next records' }));
  expect(
    screen.getByRole('combobox', { name: 'Packet choice for Fictional record 55' }),
  ).toHaveValue('exclude');
  await userEvent.click(screen.getByRole('button', { name: 'Previous records' }));
  expect(
    screen.getByRole('combobox', { name: 'Packet choice for Fictional record 01' }),
  ).toHaveValue('include');
  await userEvent.click(screen.getByRole('button', { name: 'Preview provider packet' }));
  await screen.findByTitle('Exact export preview');
  expect(requests[0].packetSelection).toMatchObject({
    include: [candidates[0].record],
    exclude: [candidates[54].record],
  });
});

it('withheld starting-note titles never appear in PDF or evidence download filenames', async () => {
  const sensitiveTitle = 'Fictional confidential screening';
  const startingNote = {
    ...routineRecord,
    record: { kind: 'note', recordId: 'starting-note' },
    key: 'note:starting-note',
    title: sensitiveTitle,
    kind: 'note',
    opaque: true,
  };
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:fictional-packet');
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/options'))
        return response({
          ...options,
          noteTitle: sensitiveTitle,
          packet: { ...options.packet, candidates: [startingNote], kinds: ['note'] },
        });
      if (url.endsWith('/preview')) {
        requests.push(JSON.parse(init.body));
        return response({
          ...preview,
          assets: [],
          packetReview: {
            ...review,
            opaqueItems: [],
            withheld: [
              { key: startingNote.key, title: sensitiveTitle, reason: 'Left out this time' },
            ],
          },
        });
      }
      if (url.endsWith('/validate')) return response({ valid: true });
      if (url.endsWith('/pdf'))
        return new Response('fictional PDF', { headers: { 'Content-Type': 'application/pdf' } });
      if (url.endsWith('/evidence'))
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected ${input}`);
    }),
  );
  render(<NoteExportDialog type="note" id="starting-note" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await userEvent.selectOptions(
    await screen.findByRole('combobox', { name: 'Format' }),
    'provider',
  );
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: `Packet choice for ${sensitiveTitle}` }),
    'exclude',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Preview provider packet' }));
  await screen.findByTitle('Exact export preview');
  expect(requests[0].packetSelection).toMatchObject({ exclude: [startingNote.record] });
  await userEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole('button', { name: 'Download evidence JSON' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
  expect(click.mock.instances.map((anchor) => (anchor as HTMLAnchorElement).download)).toEqual([
    'health-packet-provider.pdf',
    'health-packet-provider-evidence.json',
  ]);
});

it('labels note event dates and last-modified fallbacks used by the date window', () => {
  render(
    <PacketSelection
      packet={{
        ...options.packet,
        candidates: [
          {
            ...routineRecord,
            key: 'note:event',
            title: 'Fictional event note',
            kind: 'note',
            date: '2025-04-03',
            dateBasis: 'event',
          },
          {
            ...routineRecord,
            key: 'note:modified',
            title: 'Fictional undated note',
            kind: 'note',
            date: '2026-10-03',
            dateBasis: 'note-last-modified',
          },
          {
            ...routineRecord,
            key: 'procedure:undated',
            title: 'Fictional undated procedure',
            date: null,
            dateBasis: 'undated',
          },
        ],
      }}
      selection={{}}
      onChange={vi.fn()}
      onPreference={vi.fn()}
      busy={false}
    />,
  );
  expect(screen.getByText(/Event date: 2025-04-03/)).toBeInTheDocument();
  expect(screen.getByText(/Last modified: 2026-10-03/)).toBeInTheDocument();
  expect(screen.getByText(/No date recorded/)).toBeInTheDocument();
  expect(
    screen.getByText(/For notes without an event date, it uses the last modified date/),
  ).toBeInTheDocument();
});

it('private inspection separates complete note fields and corrections while preserving every raw field', async () => {
  const text = JSON.stringify(
    {
      row: {
        content: '<img src=x onerror=alert(1)> Fictional note body',
        topics: 'Fictional topics',
        raw_thoughts: '[Untrusted](javascript:alert(1)) Fictional raw thoughts',
      },
      fieldCorrections: [
        {
          at: '2026-10-03',
          reason: 'Fictional correction reason',
          fields: ['content'],
          actor: 'profile-user',
        },
      ],
      ownershipCorrections: [
        {
          reason: 'Fictional owner correction',
          futureDetail: { preserved: 'Unknown correction field' },
        },
      ],
      unknownExtension: { exact: 'Retained additional field' },
    },
    null,
    2,
  );
  render(
    <PacketPrivateReview
      review={{
        ...review,
        opaqueItems: [
          {
            ...review.opaqueItems[0],
            key: 'record:note',
            title: 'Fictional private note',
            text,
            contentUrl: '/api/note-exports/frozen/inspection?key=record%3Anote',
          },
          {
            ...review.opaqueItems[0],
            key: 'original:bytes',
            title: 'Fictional original bytes',
            contentUrl: '/api/originals/fictional',
          },
          {
            ...review.opaqueItems[0],
            key: 'original:untrusted',
            title: 'Untrusted external location',
            contentUrl: 'javascript:alert(1)',
          },
        ],
      }}
      selection={{}}
      onChange={vi.fn()}
      busy={false}
    />,
  );
  await userEvent.click(screen.getByText('Review private text'));
  expect(
    within(screen.getByRole('region', { name: 'Note body' })).getByText(/Fictional note body/),
  ).toHaveTextContent('<img src=x onerror=alert(1)>');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Topics and questions' })).toHaveTextContent(
    'Fictional topics',
  );
  expect(screen.getByRole('region', { name: 'Raw thoughts' })).toHaveTextContent(
    '[Untrusted](javascript:alert(1))',
  );
  expect(screen.getByRole('region', { name: 'Correction details' })).toHaveTextContent(
    'Fictional correction reason',
  );
  expect(screen.getByRole('region', { name: 'Correction details' })).toHaveTextContent(
    'Unknown correction field',
  );
  expect(
    screen.getByRole('link', {
      name: 'Download complete private inspection (not a packet download)',
    }),
  ).toHaveAttribute('href', '/api/note-exports/frozen/inspection?key=record%3Anote');
  expect(
    screen.getByRole('link', { name: 'Review private original (not a packet download)' }),
  ).toHaveAttribute('href', '/api/originals/fictional');
  expect(screen.getAllByRole('link')).toHaveLength(2);
  await userEvent.click(screen.getByText('All raw inspection fields'));
  expect(screen.getByText(text, { exact: true, normalizer: (value) => value })).toHaveTextContent(
    'Retained additional field',
  );
});

it('truncated inspection stays visibly incomplete and cannot be mistaken for parsed complete fields', async () => {
  const excerpt = JSON.stringify({ row: { content: 'Fictional incomplete beginning' } });
  render(
    <PacketPrivateReview
      review={{
        ...review,
        opaqueItems: [
          {
            ...review.opaqueItems[0],
            key: 'record:truncated',
            text: excerpt,
            truncated: true,
            contentUrl: '/api/note-exports/frozen/inspection?key=record%3Atruncated',
          },
        ],
      }}
      selection={{}}
      onChange={vi.fn()}
      busy={false}
    />,
  );
  await userEvent.click(screen.getByText('Review private text'));
  expect(screen.getByText(/Only the beginning of this material is shown/)).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Note body' })).not.toBeInTheDocument();
  expect(
    screen.getByRole('link', {
      name: 'Download complete private inspection (not a packet download)',
    }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByText('Raw text excerpt (incomplete)'));
  expect(screen.getByText(excerpt)).toBeInTheDocument();
});
