import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { StandaloneQuestion } from '../../app/features/import/ImportDetailReview';
import { QuestionAnswerHistory } from '../../app/features/intake/QuestionAnswerHistory';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { IntakeQuestion } from '../../shared/intake';

const profile = { id: 'fictional-answer-history', name: 'Fictional Reader', placebo: true };
const history: NonNullable<IntakeQuestion['answerHistory']> = {
  count: 5,
  reference: {
    format: 'health-intake-review-fragment-v1',
    logical: {
      root: {
        hash: 'fictional-history-hash',
        count: 1,
        height: 0,
        first: 'question',
        last: 'question',
      },
      domainVersion: 7,
    },
    address: 'question/fictional-question',
    field: 'answers',
  },
};
const question: IntakeQuestion = {
  id: 'fictional-question',
  key: 'fictional-key',
  candidateId: 'fictional-candidate',
  candidateVersionId: 'fictional-version',
  prompt: 'Which date appears beside the fictional result?',
  locator: 'Fictional page 2',
  field: 'date',
  status: 'answered',
  createdAt: '2026-10-03',
  answerScope: 'latest',
  answerHistory: history,
  answers: [
    {
      id: 'latest-answer',
      answer: 'Latest fictional answer',
      mapping: { date: '2026-06-07' },
      scope: 'record',
      at: '2026-10-03',
    },
  ],
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('labels the latest answer and reads complete older answer text one bounded window at a time', async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      { answer: 'first retained fictional answer ' + 'a'.repeat(9000) },
      { answer: 'second retained fictional answer ' + 'b'.repeat(9000) },
      { answer: 'third retained fictional answer ' + 'c'.repeat(9000) },
      { answer: 'd'.repeat(9000) + ' fourth retained answer ending' },
      question.answers[0],
    ]),
  );
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      expect(String(input)).toContain('/intakes/fictional-intake/collection-fragment');
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const end = Math.min(bytes.length, body.offset + 32768);
      return json({
        encoding: 'base64',
        data: Buffer.from(bytes.subarray(body.offset, end)).toString('base64'),
        totalBytes: bytes.length,
        complete: end === bytes.length,
        nextOffset: end === bytes.length ? null : end,
      });
    }),
  );
  render(
    <StandaloneQuestion
      intakeId="fictional-intake"
      question={question}
      answer={question.answers[0]!.answer}
      busy={false}
      onChange={() => {}}
      onSave={() => {}}
      onRefresh={() => {}}
    />,
  );
  expect(screen.getByText('Latest saved answer: Latest fictional answer')).toBeVisible();
  expect(screen.getByText(/5 saved answers/)).toHaveTextContent('earlier answers remain');
  expect(bodies).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'View answer history' }));
  const reader = within(screen.getByRole('region', { name: 'Complete saved answer history' }));
  fireEvent.click(reader.getByRole('button', { name: 'Open evidence' }));
  await reader.findByText(/first retained fictional answer/);
  fireEvent.click(reader.getByRole('button', { name: 'Next evidence page' }));
  await reader.findByText(/fourth retained answer ending/);
  expect(reader.queryByText(/first retained fictional answer/)).toBeNull();
  expect(reader.getByText(/Latest fictional answer/).textContent!.length).toBeLessThanOrEqual(
    32768,
  );
  expect(bodies).toEqual([
    { reference: history.reference, offset: 0, bytes: 32768 },
    { reference: history.reference, offset: 32768, bytes: 32768 },
  ]);
});

it('refuses stale history authority and offers refresh without replacing the retained count', async () => {
  const refresh = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({ code: 'SOURCE_CHANGED', message: 'The fictional question history changed.' }, 409),
    ),
  );
  render(
    <QuestionAnswerHistory intakeId="fictional-intake" history={history} onRefresh={refresh} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'View answer history' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('history changed');
  expect(screen.getByText(/5 saved answers/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Next evidence page' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh evidence' }));
  expect(refresh).toHaveBeenCalledOnce();
});

it('discards a late private history fragment on a profile change and can open the new profile scope', async () => {
  let release!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <QuestionAnswerHistory intakeId="fictional-intake" history={history} onRefresh={() => {}} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'View answer history' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  await waitFor(() => expect(release).toBeDefined());
  const oldRelease = release;
  act(() => selectProfile({ id: 'other-fictional-reader', name: 'Other Reader', placebo: true }));
  await act(async () =>
    oldRelease(
      json({
        encoding: 'base64',
        data: Buffer.from('old private answer').toString('base64'),
        totalBytes: 18,
        complete: true,
        nextOffset: null,
      }),
    ),
  );
  expect(screen.queryByText(/old private answer/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});
