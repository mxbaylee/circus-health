import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ImportDetailIdentityPanel } from '../../app/features/import/ImportDetailIdentityPanel';
import { NativeIdentity } from '../../app/features/import/CollectionImportReview';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type {
  IntakeIdentityReview,
  IntakeIdentityScopePage,
  IntakeIdentityConfirmation,
} from '../../shared/intake-identity';
const profile = {
  id: 'fictional-identity-reader',
  name: 'Fictional Reader',
  placebo: true,
};
const review: IntakeIdentityReview = {
  status: 'confirmation_required',
  blocking: true,
  message: 'Review the printed identity.',
  scope: null,
  scopeReference: {
    format: 'health-intake-identity-scope-v2',
    profileId: profile.id,
    intakeId: 'fictional-intake',
    intakeVersion: 7,
    groupId: 'fictional-group',
    groupVersionId: 'fictional-group-v1',
    sourceHash: 'fictional-source',
    memberId: null,
    original: {
      filename: 'fictional.pdf',
      contentUrl: '/api/sources/fictional-intake/content',
      page: 1,
    },
    report: { text: 'Fictional report', locator: 'Page 1' },
    subject: { text: 'Fictional Reader', locator: 'Page 1' },
    verificationMode: 'human_reviewed_original',
    scopeToken: 'identity-scope-7',
    collection: {
      snapshotId: 'snapshot-7',
      membership: 500,
      targets: 200,
      assignmentTargets: 250,
      questions: 2,
      competingSubjects: 0,
    },
  },
  evidencedIdentity: { fullName: 'Fictional Reader' },
  self: {
    noteId: 'person-note:self',
    version: 1,
    fullName: 'Fictional Reader',
    birthDate: null,
  },
  offeredSelfFields: {},
  conflicts: [],
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const page = (
  items: IntakeIdentityScopePage['items'],
  nextCursor: string | null,
): IntakeIdentityScopePage => ({
  format: 'health-intake-identity-scope-page-v2',
  scopeToken: 'identity-scope-7',
  section: 'questions',
  total: 2,
  items,
  nextCursor,
});
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
it('shows complete identity counts and requires all question windows before exact scoped confirmation', async () => {
  const bytes = new TextEncoder().encode(
    'fictional earlier reading '.repeat(1400) + 'FINAL QUESTION WINDOW',
  );
  const writes: IntakeIdentityConfirmation[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/identity-review')) return json(review);
      if (url.pathname.endsWith('/identity-scope-page'))
        return url.searchParams.has('cursor')
          ? json(
              page(
                [
                  {
                    kind: 'reference',
                    reference: {
                      format: 'health-intake-identity-item-v2',
                      scopeToken: 'identity-scope-7',
                      section: 'questions',
                      ordinal: 1,
                      bytes: bytes.length,
                    },
                  },
                ],
                null,
              ),
            )
          : json(
              page(
                [
                  {
                    kind: 'value',
                    value: { prompt: 'FIRST IDENTITY QUESTION' },
                  },
                ],
                'next-identity',
              ),
            );
      if (url.pathname.endsWith('/identity-scope-fragment')) {
        expect(init?.method).toBe('GET');
        const offset = Number(url.searchParams.get('offset'));
        expect(url.searchParams.get('cursor')).toBe(offset ? 'fictional-next-fragment' : 'start');
        const end = Math.min(bytes.length, offset + 32768);
        return json({
          encoding: 'base64',
          data: Buffer.from(bytes.subarray(offset, end)).toString('base64'),
          complete: end === bytes.length,
          nextOffset: end === bytes.length ? null : end,
          nextCursor: end === bytes.length ? null : 'fictional-next-fragment',
        });
      }
      if (url.pathname.endsWith('/identity-scope')) {
        writes.push(JSON.parse(String(init?.body)));
        if (writes.length === 1) throw new TypeError('Fictional connection interrupted');
        return json({ id: 'fictional-intake', version: 8 });
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
  const changed = vi.fn();
  render(
    <NativeIdentity intakeId="fictional-intake" groupId="fictional-group" onChanged={changed} />,
  );
  const confirm = await screen.findByRole('button', { name: 'This is me' });
  expect(confirm).toBeDisabled();
  expect(
    screen.getByText(
      /250 records receive this person choice; 500 retained memberships and 2 identity questions/,
    ),
  ).toBeVisible();
  fireEvent.click(await screen.findByRole('button', { name: 'Next identity questions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open evidence' }));
  expect(confirm).toBeDisabled();
  fireEvent.click(await screen.findByRole('button', { name: 'Next evidence page' }));
  await waitFor(() => expect(confirm).toBeEnabled());
  expect(screen.queryByText(/FIRST IDENTITY QUESTION/)).not.toBeInTheDocument();
  expect(screen.getByText(/FINAL QUESTION WINDOW/).textContent!.length).toBeLessThanOrEqual(32768);
  fireEvent.click(confirm);
  expect(await screen.findByText(/Fictional connection interrupted/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'This is me' }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]).toMatchObject({
    scope: review.scopeReference,
    attestation: 'confirmed_displayed_identity_questions',
  });
  expect(writes[0]!.scope).not.toHaveProperty('targets');
});
it('refuses a premature completed question page instead of authorizing unseen questions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json(page([{ kind: 'value', value: { prompt: 'Only one of two questions' } }], null)),
    ),
  );
  render(
    <ImportDetailIdentityPanel
      review={review}
      loading={false}
      busy={false}
      notice=""
      error=""
      onRetry={() => {}}
      onDone={() => {}}
      onConfirm={() => {}}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('identity evidence page changed');
  expect(screen.getByRole('button', { name: 'This is me' })).toBeDisabled();
});
it('discards a late identity question page when the selected profile changes', async () => {
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const view = render(
    <ImportDetailIdentityPanel
      review={review}
      loading={false}
      busy={false}
      notice=""
      error=""
      onRetry={() => {}}
      onDone={() => {}}
      onConfirm={() => {}}
    />,
  );
  await waitFor(() => expect(finish).toBeDefined());
  const old = finish!;
  await act(async () => selectProfile({ ...profile, id: 'fictional-other-profile' }));
  view.rerender(
    <ImportDetailIdentityPanel
      review={{
        ...review,
        scopeReference: {
          ...review.scopeReference!,
          profileId: 'fictional-other-profile',
          scopeToken: 'other-token',
        },
      }}
      loading={false}
      busy={false}
      notice=""
      error=""
      onRetry={() => {}}
      onDone={() => {}}
      onConfirm={() => {}}
    />,
  );
  await act(async () =>
    old(
      json(
        page(
          [
            { kind: 'value', value: 'OLD PROFILE PRIVATE QUESTION' },
            { kind: 'value', value: 'old second' },
          ],
          null,
        ),
      ),
    ),
  );
  expect(screen.queryByText(/OLD PROFILE PRIVATE QUESTION/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'This is me' })).toBeDisabled();
});
it('opens an oversized retained identity field without treating its fragment as confirmation authority', async () => {
  const reference = {
    format: 'health-intake-review-fragment-v1' as const,
    logical: { root: null, domainVersion: 7 },
    address: 'fictional-retained-group',
    field: 'report',
  };
  const bytes = new TextEncoder().encode(
    'fictional exact identity claim '.repeat(1200) + 'FINAL IDENTITY FIELD',
  );
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/identity-review'))
        return json({
          ...review,
          scopeReference: undefined,
          scopeFragmentReference: reference,
          status: 'conflict',
          message: 'Read this oversized exact retained identity field before individual review.',
        });
      if (url.endsWith('/collection-fragment')) {
        const body = JSON.parse(String(init?.body));
        expect(body.reference).toEqual(reference);
        const end = Math.min(bytes.length, body.offset + 32768);
        return json({
          encoding: 'base64',
          data: Buffer.from(bytes.subarray(body.offset, end)).toString('base64'),
          totalBytes: bytes.length,
          complete: end === bytes.length,
          nextOffset: end === bytes.length ? null : end,
        });
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
  render(
    <NativeIdentity intakeId="fictional-intake" groupId="fictional-group" onChanged={() => {}} />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open evidence' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Next evidence page' }));
  expect(await screen.findByText(/FINAL IDENTITY FIELD/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'This is me' })).not.toBeInTheDocument();
  expect(
    screen.getByText(/Reading it does not establish a complete scope for person confirmation/),
  ).toBeVisible();
  expect(requests.some((url) => url.endsWith('/identity-scope'))).toBe(false);
});

it('opens referenced advisory warnings as bounded evidence without treating the inline list as complete', async () => {
  const scope = {
    ...review.scopeReference!,
    collection: { ...review.scopeReference!.collection, questions: 0 },
  };
  const visited: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/identity-review'))
        return json({
          ...review,
          scopeReference: scope,
          warnings: [],
          warningsReference: {
            format: 'health-intake-identity-warnings-v1',
            scopeToken: scope.scopeToken,
            snapshotId: scope.collection.snapshotId,
            count: 2,
          },
        });
      if (url.pathname.endsWith('/identity-scope-page')) {
        const section = url.searchParams.get('section')!;
        visited.push(section);
        if (section === 'warnings')
          return json({
            format: 'health-intake-identity-scope-page-v2',
            scopeToken: scope.scopeToken,
            section,
            total: 2,
            items: [
              {
                kind: 'value',
                value: {
                  code: 'fictional-warning-one',
                  message: 'First retained warning',
                },
              },
              {
                kind: 'value',
                value: {
                  code: 'fictional-warning-two',
                  message: 'Second retained warning',
                },
              },
            ],
            nextCursor: null,
          });
        return json({
          format: 'health-intake-identity-scope-page-v2',
          scopeToken: scope.scopeToken,
          section,
          total: scope.collection.assignmentTargets,
          items: [{ kind: 'value', value: { title: 'Fictional current target' } }],
          nextCursor: 'next-target',
        });
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
  render(
    <NativeIdentity intakeId="fictional-intake" groupId="fictional-group" onChanged={vi.fn()} />,
  );
  expect(await screen.findByText(/2 advisory warnings are available/)).toBeVisible();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Inspect affected records and membership',
    }),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Identity evidence section' }), {
    target: { value: 'warnings' },
  });
  expect(await screen.findByText(/First retained warning/)).toBeVisible();
  expect(screen.getByText(/Second retained warning/)).toBeVisible();
  expect(visited).toContain('warnings');
  expect(screen.getByRole('button', { name: 'This is me' })).toBeEnabled();
});

it('pins content-aware warning pages/fragments and resets the window for changed same-count warnings', async () => {
  const { IdentityScopeEvidence } = await import('../../app/features/import/IdentityScopeEvidence');
  const scope = {
    ...review.scopeReference!,
    collection: { ...review.scopeReference!.collection, questions: 0 },
  };
  const reference = (digest: string) => ({
    format: 'health-intake-identity-warnings-v2' as const,
    scopeToken: scope.scopeToken,
    snapshotId: 'identity-warnings:' + scope.scopeToken + ':' + digest,
    count: 1,
    sha256: digest,
  });
  const old = reference('a'.repeat(64)),
    fresh = reference('b'.repeat(64));
  const bytes = Buffer.from('FICTIONAL EARLIER WARNING '.repeat(2000) + 'FINAL FICTIONAL WARNING');
  const selectors: { route: string; snapshotId: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid'),
        section = url.searchParams.get('section');
      if (section === 'warnings')
        selectors.push({
          route: url.pathname,
          snapshotId: url.searchParams.get('snapshotId'),
        });
      if (url.pathname.endsWith('/identity-scope-fragment')) {
        expect(url.searchParams.get('snapshotId')).toBe(old.snapshotId);
        const offset = Number(url.searchParams.get('offset')),
          end = Math.min(bytes.length, offset + 32768);
        expect(url.searchParams.get('cursor')).toBe(offset ? 'fictional-next-fragment' : 'start');
        return json({
          encoding: 'base64',
          data: bytes.subarray(offset, end).toString('base64'),
          complete: end === bytes.length,
          nextOffset: end === bytes.length ? null : end,
          nextCursor: end === bytes.length ? null : 'fictional-next-fragment',
        });
      }
      if (url.pathname.endsWith('/identity-scope-page')) {
        const snapshotId = url.searchParams.get('snapshotId');
        if (section === 'warnings')
          return json({
            format: 'health-intake-identity-scope-page-v2',
            scopeToken: scope.scopeToken,
            snapshotId,
            section,
            total: 1,
            nextCursor: null,
            items:
              snapshotId === old.snapshotId
                ? [
                    {
                      kind: 'reference',
                      reference: {
                        format: 'health-intake-identity-item-v2',
                        scopeToken: scope.scopeToken,
                        snapshotId,
                        section,
                        ordinal: 0,
                        bytes: bytes.length,
                      },
                    },
                  ]
                : [{ kind: 'value', value: 'CURRENT FICTIONAL WARNING' }],
          });
        return json({
          format: 'health-intake-identity-scope-page-v2',
          scopeToken: scope.scopeToken,
          section,
          total: scope.collection.assignmentTargets,
          items: [{ kind: 'value', value: 'Fictional target' }],
          nextCursor: 'next-target',
        });
      }
      throw Error('Unexpected fictional warning request');
    }),
  );
  const props = { scope, onQuestionsReviewed: vi.fn(), onRefresh: vi.fn() };
  const view = render(<IdentityScopeEvidence {...props} warningsReference={old} />);
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Inspect affected records and membership',
    }),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Identity evidence section' }), {
    target: { value: 'warnings' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Open evidence' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Next evidence page' }));
  expect(await screen.findByText(/FINAL FICTIONAL WARNING/)).toBeVisible();
  view.rerender(<IdentityScopeEvidence {...props} warningsReference={fresh} />);
  expect(await screen.findByText(/CURRENT FICTIONAL WARNING/)).toBeVisible();
  expect(screen.queryByText(/FINAL FICTIONAL WARNING/)).not.toBeInTheDocument();
  expect(selectors.filter((item) => item.route.endsWith('/identity-scope-fragment'))).toHaveLength(
    2,
  );
  expect(selectors.at(-1)?.snapshotId).toBe(fresh.snapshotId);
});

it('refuses a content-aware warning page returned from another snapshot', async () => {
  const { IdentityScopeEvidence } = await import('../../app/features/import/IdentityScopeEvidence');
  const scope = {
    ...review.scopeReference!,
    collection: { ...review.scopeReference!.collection, questions: 0 },
  };
  const snapshotId = 'identity-warnings:' + scope.scopeToken + ':' + 'a'.repeat(64);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid'),
        section = url.searchParams.get('section');
      return json({
        format: 'health-intake-identity-scope-page-v2',
        scopeToken: scope.scopeToken,
        section,
        snapshotId: section === 'warnings' ? 'another-warning-snapshot' : undefined,
        total: section === 'warnings' ? 1 : scope.collection.assignmentTargets,
        items: [{ kind: 'value', value: 'WRONG FICTIONAL WARNING' }],
        nextCursor: section === 'warnings' ? null : 'next-target',
      });
    }),
  );
  render(
    <IdentityScopeEvidence
      scope={scope}
      warningsReference={{
        format: 'health-intake-identity-warnings-v2',
        scopeToken: scope.scopeToken,
        snapshotId,
        count: 1,
        sha256: 'a'.repeat(64),
      }}
      onQuestionsReviewed={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Inspect affected records and membership',
    }),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Identity evidence section' }), {
    target: { value: 'warnings' },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('identity evidence page changed');
  expect(screen.queryByText(/WRONG FICTIONAL WARNING/)).not.toBeInTheDocument();
});
