import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CollectionImportReview } from '../../app/features/import/CollectionImportReview';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type {
  CollectionImportFeed,
  CollectionPersonProposal,
} from '../../shared/intake-clinical-pages';
import type { IntakePersonApplyRequest } from '../../shared/intake-people';

const sourceGate = vi.hoisted(() => ({
  listener: undefined as ((pending: boolean) => void) | undefined,
  flush: undefined as (() => Promise<boolean>) | undefined,
}));
vi.mock('../../app/features/import/ImportDetailReview', () => ({
  ImportDetailReview: ({
    beforeCloseRef,
  }: {
    beforeCloseRef?: { current: (() => Promise<boolean>) | null };
  }) => {
    useEffect(() => {
      if (!beforeCloseRef) return;
      const flush = () => sourceGate.flush?.() ?? Promise.resolve(true);
      beforeCloseRef.current = flush;
      return () => {
        if (beforeCloseRef.current === flush) beforeCloseRef.current = null;
      };
    }, [beforeCloseRef]);
    return null;
  },
  ImportRecordDetail: () => null,
}));
vi.mock('../../app/features/import/ImportSourceTextBrowser', () => ({
  ImportSourceTextBrowser: ({
    onPendingChange,
  }: {
    onPendingChange?: (pending: boolean) => void;
  }) => {
    useEffect(() => {
      sourceGate.listener = onPendingChange;
      return () => {
        sourceGate.listener = undefined;
      };
    }, [onPendingChange]);
    return null;
  },
}));

const profile = { id: 'fictional-source-gated-people', name: 'Fictional Reader', placebo: true };
const person = (id: string): CollectionPersonProposal => ({
  id,
  version: `version-${id}`,
  state: 'later',
  intakeId: 'fictional-intake',
  intakeVersion: 7,
  proposalId: null,
  envelopeRecordId: `record-${id}`,
  envelopeId: `envelope-${id}`,
  groupId: 'fictional-group',
  groupVersionId: 'group-v1',
  title: id,
  person: { fullName: id, tags: ['Professional'] },
  uncertainties: [],
  evidence: [],
  source: {
    sourceRecordId: id,
    filename: 'fictional.jsonl',
    contentUrl: '/api/sources/fictional/content',
    originalSourceFileId: 'fictional-source',
    originalSha256: 'fictional-hash',
    member: null,
  },
  matches: [],
  matchCount: 0,
  matchesTruncated: false,
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  sessionStorage.clear();
  sourceGate.listener = undefined;
  sourceGate.flush = undefined;
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('blocks Add People when source review becomes pending before or during an awaited close', async () => {
  const people = [person('Fictional Ellis'), person('Fictional Rowan')];
  const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  sessionStorage.setItem(`circus-health:report-acceptance:${profile.id}`, operationId);
  const feed: CollectionImportFeed = {
    format: 'health-intake-import-feed-v2',
    view: 'deferred',
    records: [],
    totalRecords: 0,
    totalGroups: 0,
    nextCursor: null,
    counts: {
      pending: 0,
      deferred: 0,
      blocked: 0,
      accepted: 4,
      keptOriginal: 0,
      superseded: 0,
      questions: 0,
    },
    kindCounts: {
      test: 0,
      procedure: 0,
      history: 0,
      prescription: 0,
      vision: 0,
      person: 2,
      unsupported: 0,
    },
    groups: [],
    people: {
      groups: [
        {
          format: 'health-intake-report-group-reference-v2',
          binding: 'fictional-group-v1',
          intakeId: 'fictional-intake',
          groupId: 'fictional-group',
          ordinal: 0,
          bytes: 80,
        },
      ],
      totalGroups: 1,
      counts: { pending: 0, later: 2, excluded: 0, saved: 0 },
      nextCursor: null,
    },
    activity: {
      format: 'activity',
      binding: 'fictional',
      runningFiles: 0,
      pausedFiles: 0,
      queuedFiles: 0,
      filesAwaitingConversion: 0,
      remainingUnits: { state: 'exact', value: 0 },
      extractionUnknownFiles: 0,
      extractionComplete: true,
      allCurrentReportsReviewed: false,
      readingAccounting: { state: 'referenced', scope: 'all', binding: 'fictional' },
    },
  };
  let receiptReads = 0;
  let peopleListReads = 0;
  let selectedPersonReads = 0;
  const writes: IntakePersonApplyRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.includes('/report-acceptance/')) {
        receiptReads++;
        if (receiptReads === 1)
          return json({ code: 'FICTIONAL_RECEIPT_UNAVAILABLE', message: 'Check again.' }, 503);
        return json({
          replayed: true,
          receipt: { operationId, acceptedCount: 4, atomic: true, receipts: [], items: [] },
        });
      }
      if (url.pathname.endsWith('/import-feed')) return json(feed);
      if (url.pathname.includes('/people/')) {
        const id = url.searchParams.get('personId');
        if (id) selectedPersonReads++;
        else peopleListReads++;
        return json({
          format: 'health-intake-people-page-v2',
          intakeId: 'fictional-intake',
          groupId: 'fictional-group',
          selectedPersonId: id,
          totalPeople: 2,
          people: people
            .filter((value) => !id || value.id === id)
            .map((value) => ({ kind: 'person', person: value })),
          counts: feed.people.counts,
          nextCursor: null,
        });
      }
      if (url.pathname.endsWith('/people-apply')) {
        const body = JSON.parse(String(init?.body)) as IntakePersonApplyRequest;
        writes.push(body);
        return json({
          proposalId: body.proposalId,
          status: 'saved',
          action: 'add',
          noteId: `note-${body.proposalId}`,
          personId: `person-${body.proposalId}`,
          resultUrl: `/#/people?id=${encodeURIComponent(body.proposalId)}`,
        });
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
  render(
    <MemoryRouter
      initialEntries={[
        '/intakes/import-feed?view=deferred&intake=fictional-intake&group=fictional-group&record=fictional-record',
      ]}
    >
      <CollectionImportReview
        initial={feed}
        path="/intakes/import-feed?view=deferred"
        onChanged={vi.fn()}
        sourceProps={{ onChanged: vi.fn() }}
        onUpload={vi.fn()}
        busy={false}
        status=""
        error=""
      />
    </MemoryRouter>,
  );
  await screen.findByRole('checkbox', { name: 'Select Fictional Ellis' });
  await screen.findByRole('button', { name: 'Check save status' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check save status' }));
  const add = screen.getByRole('button', { name: 'Add 2 people' });
  await waitFor(() => expect(peopleListReads).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(add).toBeEnabled());
  expect(sourceGate.listener).toBeTypeOf('function');
  let enteredFlush!: () => void;
  let finishFlush!: (allowed: boolean) => void;
  const entered = new Promise<void>((resolve) => {
    enteredFlush = resolve;
  });
  sourceGate.flush = () => {
    enteredFlush();
    return new Promise<boolean>((resolve) => {
      finishFlush = resolve;
    });
  };
  fireEvent.click(add);
  await entered;
  await act(async () => {
    sourceGate.listener!(true);
    finishFlush(true);
  });
  expect(selectedPersonReads).toBe(0);
  expect(writes).toHaveLength(0);
  sourceGate.flush = undefined;
  await act(async () => sourceGate.listener!(true));
  // Soft assertions preserve the complete held/released causal trace on red.
  expect.soft(add).toBeDisabled();
  await act(async () => fireEvent.click(add));
  expect(selectedPersonReads).toBe(0);
  expect(writes).toHaveLength(0);
  await act(async () => sourceGate.listener!(false));
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes.map((value) => value.proposalId)).toEqual(people.map((value) => value.id));
  expect(selectedPersonReads).toBe(2);
});
