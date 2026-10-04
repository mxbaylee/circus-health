import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { ModelToolValidationError } from '../model-tool-validation.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { fictionalModel } from './fictional-model.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { transaction } from '../database.ts';
import { createAssistant } from '../assistant.ts';
import { readChat, listChats, writeChat } from '../assistant-journal.ts';
import { createNote, getNote, saveNote, finishNote } from '../notes.ts';
import { noteHistory } from '../note-history.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import {
  attachPersonalDurability,
  exportCuration,
  personalDurabilityStatus,
  rebuildProfile,
} from '../portable.ts';
import { freshKey } from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';
import type { VaultRecordStorage } from '../vault-store.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { createApp } from '../index.ts';
import {
  createImportDiagnostics,
  beginImportPhase,
  diagnosticFailureFields,
} from '../import-diagnostics.ts';
import { createPrivateImportTrace } from '../import-private-trace.ts';
import { listIntakeReportQueueRead } from '../intake-queue-native.ts';
import { ModelContextLimitError } from '../model-config.ts';
import {
  uploadIntake,
  getIntake,
  getIntakeRead,
  getIntakeOriginal,
  getRetainedIntakeOriginalReference,
  linkIntakeConversion,
  askIntakeQuestionRead,
  answerIntakeQuestionRead,
  createIntakePlan,
  retainIntakeChildren,
} from '../intake.ts';
import {
  proposalDependenciesCurrent,
  sourcePageCurrentHash,
  sourceSpanCurrentHash,
} from '../intake-proposal-dependencies.ts';
import { uploadAsset } from '../assets.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
import type { HealthTool } from '../proxy-model-bridge.ts';
import { selectedFixturePlan } from './helpers/selected-plan.ts';
import {
  selectedFixtureValue,
  selectedFixtureHash,
  selectedFixtureReview,
} from './helpers/selected-intake.ts';
import { readPackagePlanScope } from '../intake-package-plan.ts';
import { prepareDirectPlanAccess, readDirectPlanScope } from '../intake-direct-plan.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { decisionIndexCount } from '../intake-reading-state.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import type { IntakeSummaryV2, IntakeRead } from '../../shared/intake-summary.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import {
  nativeAssistantConversion,
  nativeAssistantResume,
  isNativeAssistantCheckpoint,
} from '../assistant-intake-native.ts';
import { activeMappingRules } from '../clinical-import.ts';
import type { Intake, IntakeWorkflow, IntakeProposal } from '../../shared/intake.ts';
import type { ProposalSourceTextHandoff } from '../../shared/intake-source-text.ts';
import { getIntakeIdentityScope, confirmIntakeIdentityScope } from '../intake-identity.ts';

type AssistantOptions = Parameters<typeof createAssistant>[0];
type NativeModelContext = Awaited<
  ReturnType<typeof import('../intake-model-collection.ts').prepareCollectionModelContext>
>;
function assertNativeModelPins(
  value: unknown,
): asserts value is import('../intake-model-context-v4.ts').ModelIntakePinsV2 {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  for (const key of ['sourceId', 'sourceHash', 'logicalRoot', 'sourceTextPin', 'mappingVersion'])
    assert.equal(typeof Reflect.get(value, key), 'string');
  for (const key of ['version', 'domainVersion'])
    assert.ok(Number.isSafeInteger(Reflect.get(value, key)) && Reflect.get(value, key) >= 0);
}
function firstModelRecordCursor(context: NativeModelContext): string {
  assert.ok(Array.isArray(context.items), 'the selected fictional section has actual items');
  for (const item of context.items) {
    assert.ok(item && typeof item === 'object' && Array.isArray(item.records));
    for (const record of item.records) {
      assert.ok(record && typeof record === 'object' && typeof record.cursor === 'string');
      return record.cursor;
    }
  }
  assert.fail('the fictional operation section contains an addressed record');
}
type AssistantChat = ReturnType<ReturnType<typeof createAssistant>['get']>;
type BridgeFactory = NonNullable<AssistantOptions['bridgeFactory']>;
type BridgeCallbacks = Parameters<BridgeFactory>[0];
type TestCallbacks = BridgeCallbacks & {
  onEvent: NonNullable<BridgeCallbacks['onEvent']>;
  onTool: NonNullable<BridgeCallbacks['onTool']>;
};
interface RequiredArray<T> extends Array<T> {
  [index: number]: T;
}
interface PromptDto extends Record<string, unknown> {
  route?: string;
  conversation: { firstAcquaintance: boolean; firstAssistantResponse: boolean };
  conversion: {
    version: number;
    mappingVersion: string | null;
    retainedCandidateCount: number;
    instructions: string;
    currentWindow: unknown;
    pendingReadWindows: RequiredArray<{ args: { offset?: number; page?: number } }>;
    nextReadWindows: RequiredArray<{ args: { offset?: number; page?: number } }>;
    pendingWindows?: {
      total: number;
      complete: boolean;
      items: { args: { page?: number; offset?: number } }[];
    };
    freshTopLevelImageBootstrap?: { eligible: boolean; instructions: string };
  };
  identity: { name: string; displayName: string };
  localTime: Record<string, unknown>;
  messages: RequiredArray<{ content: string; context: { selection: { id: string } } }>;
  page: {
    selected: { status: string; record: Record<string, string> };
    comparisons: RequiredArray<{ record: Record<string, string> }>;
    filters: Record<string, string>;
    contentScope: string;
  };
  intakeId: string;
}
interface TestBridge {
  callbacks: TestCallbacks;
  closed: boolean;
  instructions?: string;
  tools: HealthTool[];
  prompt: PromptDto;
  start(instructions: string, tools: HealthTool[]): Promise<{ model: string }>;
  turn(prompt: string): Promise<void>;
  cancel(): Promise<void>;
  close(): void;
}
interface AssistantToolResult extends Record<string, unknown> {
  id: string;
  noteId: string;
  status: string;
  title: string;
  appUrl: string;
  rawText: string;
  unit: string;
  planId: string;
  totalMembers: number;
  truncated?: boolean;
  version: number;
  members: RequiredArray<{ memberId: string; unitId: string }>;
  structure: {
    literal: string;
    children: RequiredArray<{ literal: string; literalComplete: boolean }>;
  };
  roleProposalCount: number;
  pendingWorkCount: number;
  sourceHash: string;
  plan?: { id: string };
  latestProposal: { contentUrl: string };
  candidates: { candidateCount: number; versionCount: number; occurrenceCount: number };
  questions: { count: number };
  sections: RequiredArray<{ section: string; count: number }>;
  paging: string;
  mappingRules: {
    count: number;
    version: string;
    planVersion: string;
    consistentWithPlan: boolean;
  };
  contextStart?: {
    kind: string;
    section: string;
    offset: number;
    version: number;
    mappingVersion: string;
    sourceHash: string;
    instruction: string;
  };
  page?: {
    section: string;
    offset: number;
    nextOffset: number | null;
    complete: boolean;
    items: unknown[];
  };
  metadata: {
    sourceFileId: string;
    intake: { id: string };
    caution: string;
    preparedExtraction?: {
      kind: string;
      planId: string;
      unit: {
        id: string;
        kind: string;
        locator: string;
        sourceFileId: string;
        sourceHash: string;
        status: string;
      };
      version: number;
      sourceHash: string;
      mappingVersion: string;
      instructions: string;
    };
    original: {
      page: number;
      nextPage: number | null;
      nextOffset: number | null;
      text: string;
      totalPages?: number;
      complete: boolean;
      coverage: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  proposals: RequiredArray<{ id: string }>;
  data: RequiredArray<{ appUrl: string; id?: string }>;
  changes: { person: { tags?: string[] }; [key: string]: unknown };
  imageContent: string;
  messages: RequiredArray<Record<string, unknown>>;
  entries: RequiredArray<Record<string, unknown>>;
  plans: unknown;
}
interface TestBridgeList extends Array<TestBridge> {
  [index: number]: TestBridge;
}
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;
const required = <T>(value: T | null | undefined, label = 'test value'): T => {
  if (value == null) throw new Error(`Expected ${label}`);
  return value;
};
const testCallbacks = (callbacks: BridgeCallbacks): TestCallbacks => {
  if (!callbacks.onEvent || !callbacks.onTool) throw new Error('Expected assistant callbacks');
  return callbacks as TestCallbacks;
};
const readTestChat = (root: string, profileId: string, chatId: string): AssistantChat =>
  readChat(root, profileId, chatId) as AssistantChat;
const sqlText = (row: Record<string, unknown> | undefined, key: string): string => {
  const value = required(row, 'SQL row')[key];
  if (typeof value !== 'string') throw new Error(`Expected string column ${key}`);
  return value;
};
const sqlNumber = (row: Record<string, unknown> | undefined, key: string): number => {
  const value = required(row, 'SQL row')[key];
  if (typeof value !== 'number') throw new Error(`Expected number column ${key}`);
  return value;
};
const selectedWorkflowHasOperation = (
  db: ReturnType<typeof openDatabase>,
  id: string,
  operationId: string,
) => {
  const view = openIntakeCollectionEnvelope(db, { id }),
    intake = required(view.child(view.root(), 'intake')),
    workflow = required(view.child(intake, 'workflow'));
  return !!view.find('operation', workflow, operationId);
};

const proposalCount = (...args: Parameters<typeof getIntakeRead>) => {
  const value = getIntakeRead(...args);
  return isIntakeSummary(value) ? value.collections.proposals.total : value.proposals.length;
};
const fixtureProposals = (...args: Parameters<typeof getIntakeRead>): IntakeProposal[] => {
  const header = getIntakeRead(...args);
  return isIntakeSummary(header)
    ? selectedFixtureValue<IntakeProposal[]>(args[0], args[3], ['intake', 'proposals'])
    : header.proposals;
};
const selectedResume = (
  db: ReturnType<typeof openDatabase>,
  root: string,
  profileId: string,
  id: string,
  chat: AssistantChat,
) => {
  const header = getIntakeRead(db, root, profileId, id);
  assert.ok(isIntakeSummary(header));
  assert.ok(isNativeAssistantCheckpoint(chat.conversionCheckpoint));
  return nativeAssistantResume(
    nativeAssistantConversion(db, root, profileId, chat.id, header),
    chat.conversionCheckpoint,
    createHash('sha256')
      .update(JSON.stringify(activeMappingRules(db, header.providerId)))
      .digest('hex'),
  );
};
const selectedPending = (f: ReturnType<typeof fixture>, id: string, chat: AssistantChat) => {
  const resume = selectedResume(f.db, f.root, 'cedar', id, chat);
  assert.ok(resume.pendingWindows.complete, 'fictional pending windows are completely selected');
  return resume.pendingWindows.items.map((window) => {
    assert.ok('args' in window);
    return window;
  });
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitForConversionBridge(
  t: TestContext,
  f: { bridges: TestBridgeList },
  chat: AssistantChat,
  index = 0,
) {
  while (!f.bridges[index]?.prompt.conversion) {
    t.signal.throwIfAborted();
    assert.equal(chat.status, 'running', chat.error ?? 'conversion stopped before its context');
    await tick();
  }
  return f.bridges[index]!;
}
// Real inventory/JSON/role host work across 382 members; the model bridge is synthetic.
test(
  'assistant package tools keep large inventory and JSON reads bounded and role proposals resumable',
  { timeout: 90_000 },
  async (t) => {
    fictionalModel(t);
    const { assistant, bridges, root, db } = fixture(t);
    const path = resolve(root, 'fictional-package.zip');
    writeFileSync(
      path,
      zipFixture(
        Array.from({ length: 382 }, (_, i) => ({
          name: String(i).padStart(3, '0') + '.json',
          data: '{"items":[{"sourceId":"fictional","value":1.000}]}',
        })),
      ),
    );
    const item = uploadIntake(db, root, 'cedar', {
      filename: 'fictional-package.zip',
      newProviderName: 'Fictional clinic',
      bytes: readFileSync(path),
    });
    assistant.create('cedar', { message: 'Inspect supplied package' });
    await tick();
    const bridge = bridges[0];
    assert.ok(bridge.tools.some((tool) => tool.name === 'health_intake_package'));
    const plan = await call<IntakeSummaryV2>(bridge, 'intake_plan', {
      id: item.id,
      action: 'create',
      version: item.version,
    });
    assert.ok(
      plan.activePlan.state === 'exact' &&
        plan.activePlan.plan?.format === 'health-intake-package-plan-v2',
    );
    const planId = plan.activePlan.plan.id;
    assert.equal(plan.activePlan.plan.unitCount, 382);
    const inventory = await call(bridge, 'intake_package', {
      id: item.id,
      action: 'inventory',
      limit: 20,
    });
    assert.equal(inventory.members.length, 20);
    const memberId = inventory.members[0].memberId;
    const read = await call(bridge, 'intake_package', {
      id: item.id,
      action: 'read_member',
      memberId,
      jsonPointer: '/items/0',
    });
    assert.match(read.structure.literal, /1\.000/);
    const roles = await call<IntakeSummaryV2>(bridge, 'intake_package', {
      id: item.id,
      action: 'plan_roles',
      version: getIntakeRead(db, root, 'cedar', item.id).version,
      planId: planId,
      operationId: 'fictional-roles',
      roles: [
        {
          memberId,
          role: 'unknown',
          reason: 'Literal JSON source ID read; issuer remains unknown.',
          coverage: 'pending',
        },
      ],
    });
    assert.ok(roles.activePlan.state === 'exact' && roles.activePlan.plan);
    assert.equal(roles.activePlan.plan.unitCount, 382);
    const roleScope = required(readPackagePlanScope(db, root, 'cedar', item.id));
    assert.equal(roleScope.memberState(memberId)?.role?.role, 'unknown');
    assert.equal(roleScope.memberState(memberId)?.role?.coverage, 'pending');
    assert.equal(
      decisionIndexCount(
        selectedEnvelopeStore(db, { id: item.id }).collections,
        roleScope.decisionIndex('accounted'),
      ),
      0,
    );
    await assert.rejects(
      call(bridge, 'intake_package', {
        id: item.id,
        action: 'read_member',
        memberId: 'foreign-member',
      }),
      (error: unknown) => hasCode(error, 'PACKAGE_MEMBER'),
    );
    assert.equal(proposalCount(db, root, 'cedar', item.id), 0);
    const batch = await call<IntakeSummaryV2>(bridge, 'intake_batch', {
      id: item.id,
      version: roles.version,
      planId: roles.activePlan.plan.id,
      operationId: 'fictional-batch',
      summary: 'One member read; remaining occurrences are pending.',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-record',
        kind: 'context',
        payload: { literal: '1.000' },
        provenance: {
          capturedVia: 'Fictional package',
          sourceSystem: null,
          sourceRecordId: 'fictional',
          evidenceClass: 'unknown',
          locator: 'ZIP member 000.json; /items/0',
        },
        coverage: { status: 'partial', notes: ['Other members remain pending'] },
      }),
      coverage: [
        {
          unitId: inventory.members[0].unitId,
          kind: 'extracted',
          notes: 'Member content retained in the proposal; other occurrences remain pending.',
        },
      ],
    });
    assert.equal(batch.collections.proposals.total, 1);
    assert.equal(batch.collections.candidates.total, 0);
    assert.equal(batch.collections.questions.total, 0);
    const savedScope = required(readPackagePlanScope(db, root, 'cedar', item.id));
    assert.equal(
      savedScope.plan.unitCount -
        decisionIndexCount(
          selectedEnvelopeStore(db, { id: item.id }).collections,
          savedScope.decisionIndex('accounted'),
        ),
      381,
    );
    const candidates = await call<{
      format: string;
      logicalTotal: number;
      complete: boolean;
      items: unknown[];
      nextCursor: string | null;
    }>(bridge, 'intake_plan', {
      id: item.id,
      action: 'read',
      section: 'candidates',
      freshStart: true,
    });
    assert.equal(candidates.format, 'health-intake-model-context-v2');
    assert.equal(candidates.logicalTotal, 0);
    assert.equal(candidates.complete, true);
    assert.deepEqual(candidates.items, []);
    assert.equal(candidates.nextCursor, null);
    assert.equal(batch.version, getIntakeRead(db, root, 'cedar', item.id).version);
    complete(bridge);
  },
);

function fixture(
  t: TestContext,
  overrides: Partial<Omit<AssistantOptions, 'root' | 'databases'>> = {},
  recordStorage?: VaultRecordStorage,
) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-assistant-test-'));
  const databases = new Map(
    ['cedar', 'cookie-dough'].map((id) => [id, openDatabase(profilePaths(root, id).database, id)]),
  );
  for (const [id, db] of databases)
    attachPersonalDurability(db, {
      root,
      profileId: id,
      ...(id === 'cedar' && recordStorage ? { recordStorage } : {}),
    });
  const bridges: TestBridgeList = [];
  const options = {
    availability: () => ({ available: true }),
    bridgeFactory: (callbacks: BridgeCallbacks) => {
      const bridge: TestBridge = {
        callbacks: testCallbacks(callbacks),
        closed: false,
        tools: [],
        prompt: {} as PromptDto,
        async start(instructions: string, tools: HealthTool[]) {
          this.instructions = instructions;
          this.tools = tools;
          return { model: 'synthetic-test' };
        },
        async turn(prompt: string) {
          this.prompt = JSON.parse(prompt.slice(prompt.indexOf('{')));
          callbacks.onEvent?.('turn/started', { turn: { id: 'turn-1' } });
        },
        async cancel() {},
        close() {
          this.closed = true;
        },
      };
      bridges.push(bridge);
      return bridge;
    },
    ...overrides,
  };
  const db = databases.get('cedar');
  if (!db) throw new Error('Expected the fictional test database');
  const assistant = createAssistant({ root, databases, ...options });
  t.after(() => {
    assistant.close();
    for (const db of databases.values()) {
      try {
        db.close();
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, databases, assistant, bridges, options, db };
}

function encryptedRecordStorage(t: TestContext): VaultRecordStorage {
  const directory = mkdtempSync(resolve(tmpdir(), 'health-assistant-record-vault-'));
  const vault = openVault({
    directory,
    profileId: 'cedar',
    key: freshKey(),
    initialize: true,
  });
  t.after(() => {
    vault.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return vault.recordStorage();
}
const durabilitySequence = (db: Parameters<typeof personalDurabilityStatus>[0]): number => {
  const status = personalDurabilityStatus(db) as ReturnType<typeof personalDurabilityStatus> & {
    sequence?: number;
  };
  return required(status.sequence, 'durable record sequence');
};
const call = async <T = AssistantToolResult>(
  bridge: TestBridge,
  tool: string,
  args: Record<string, unknown>,
): Promise<T> => {
  if (!bridge.callbacks.onTool) throw new Error('Expected a tool callback');
  return (await bridge.callbacks.onTool({
    tool: 'health_' + tool,
    arguments: args,
    callId: 'call-' + Math.random(),
  })) as T;
};
const complete = (bridge: TestBridge) =>
  bridge.callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });
// `syntheticPdf` (a minimal multi-page PDF builder) is declared further down
// in this file; function declarations hoist, so it is usable here too.

// Real ZIP read, proposal, resume and journal checks; no model latency is measured.
test(
  'linked ZIP conversion supplies multiple literal records per window and resumes for explicit extraction accounting',
  { timeout: 90_000 },
  async (t) => {
    fictionalModel(t);
    const f = fixture(t);
    const path = resolve(f.root, 'fictional-three-records.zip');
    writeFileSync(
      path,
      zipFixture([
        {
          name: 'records.json',
          data: JSON.stringify({
            items: ['one', 'two', 'three'].map((id, i) => ({
              id,
              literal: '0' + (i + 1) + '.00',
              unknown: 'x'.repeat(6000),
            })),
          }),
        },
      ]),
    );
    const item = uploadIntake(f.db, f.root, 'cedar', {
      filename: 'fictional-three-records.zip',
      bytes: readFileSync(path),
    });
    const chat = f.assistant.create('cedar', { title: 'Fictional bounded conversion' });
    linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
    f.assistant.send('cedar', chat.id, {
      message: 'Convert every supplied record for review',
      context: { route: '/sources', intakeId: item.id },
    });
    let bridge = await waitForConversionBridge(t, f, chat);
    assert.equal(bridge.prompt.conversation.firstAcquaintance, false);
    assert.equal(bridge.prompt.conversation.firstAssistantResponse, false);
    const plan = await call<IntakeSummaryV2>(bridge, 'intake_plan', {
      id: item.id,
      action: 'create',
      version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
    });
    assert.ok(plan.activePlan.state === 'exact' && plan.activePlan.plan);
    const inventory = await call(bridge, 'intake_package', { id: item.id, action: 'inventory' });
    const memberId = inventory.members[0].memberId;
    await call(bridge, 'intake_package', { id: item.id, action: 'read_member', memberId });
    await call(bridge, 'intake_package', {
      id: item.id,
      action: 'read_member',
      memberId,
      jsonPointer: '/items',
    });
    const rows = ['one', 'two', 'three'].map((id, index) =>
      JSON.stringify({
        format: 'health-record-v1',
        id,
        kind: 'document',
        payload: { literal: `0${index + 1}.00` },
        clinical: { kind: 'document', subject: 'unknown', documentTitle: 'Fictional ' + id },
        provenance: {
          capturedVia: 'Fictional ZIP',
          sourceSystem: 'Fictional source',
          sourceRecordId: id,
          evidenceClass: 'transcription',
          locator: `ZIP records.json /items/${index}`,
        },
        coverage: {
          status: 'partial',
          notes: ['Other source records remain separately reviewable'],
        },
      }),
    );
    const supplied = await call(bridge, 'intake_package', {
      id: item.id,
      action: 'read_member',
      memberId,
      jsonPointer: '/items',
    });
    assert.deepEqual(
      supplied.structure.children.map((child) => JSON.parse(child.literal).id),
      ['one', 'two', 'three'],
    );
    assert.ok(supplied.structure.children.every((child) => child.literalComplete));
    assert.equal(
      supplied.structure.literal.includes('three'),
      false,
      'the old fixed literal preview misses the third record',
    );
    assert.ok(
      supplied.structure.children.every(
        (child) => JSON.parse(child.literal).unknown.length === 6000,
      ),
    );
    assert.ok(
      JSON.stringify(supplied).length < 64000,
      'the complete tool envelope avoids fallback truncation',
    );
    await call(bridge, 'intake_propose', {
      id: item.id,
      version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
      jsonlText: rows.join('\n'),
      summary: 'Three fictional records from one literal window; coverage remains partial',
    });
    bridge.callbacks.onEvent('item/completed', {
      item: {
        id: 'reused-generation-item',
        type: 'agentMessage',
        text: 'Three fictional entries are proposed; coverage is still partial.',
      },
    });
    complete(bridge);
    assert.equal(
      chat.status,
      'running',
      'a supplied window alone does not finish extraction accounting',
    );
    await waitForConversionBridge(t, f, chat, 1);
    assert.equal(bridge.closed, true);
    bridge = f.bridges[1];
    assert.ok(bridge);
    assert.equal(bridge.prompt.conversion.retainedCandidateCount, 3);
    assert.match(
      bridge.prompt.conversion.instructions,
      /finish and publish all unproposed records from the current window/i,
    );
    assert.equal(required(chat.reading).readyRecords, 3);
    assert.equal(required(chat.reading).pendingReadWindows, 0);
    await call(bridge, 'intake_batch', {
      id: item.id,
      version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
      planId: plan.activePlan.plan.id,
      operationId: 'fictional-final-coverage',
      jsonlText: rows.join('\n'),
      summary: 'All three fictional records retained',
      coverage: [
        {
          unitId: inventory.members[0].unitId,
          kind: 'extracted',
          notes: 'All three source entries read and each proposed separately',
        },
      ],
    });
    bridge.callbacks.onEvent('item/completed', {
      item: {
        id: 'reused-generation-item',
        type: 'agentMessage',
        text: 'All three fictional entries are retained for review; none are accepted.',
      },
    });
    complete(bridge);
    const responseItems = chat.messages.filter((message) => message.role === 'assistant');
    assert.equal(responseItems.length, 2);
    assert.equal(responseItems[0].runId, responseItems[1].runId);
    assert.notEqual(responseItems[0].generation, responseItems[1].generation);
    assert.notEqual(responseItems[0].id, responseItems[1].id);
    assert.equal(
      responseItems[0].content,
      'Three fictional entries are proposed; coverage is still partial.',
    );
    assert.equal(
      responseItems[1].content,
      'All three fictional entries are retained for review; none are accepted.',
    );
    assert.deepEqual(
      responseItems.map((message) => message.status),
      ['complete', 'complete'],
    );
    assert.equal(chat.status, 'idle');
    assert.equal(required(chat.reading).reason, 'reading_exhausted');
    assert.equal(required(chat.reading).coverage, 'reading_progress_only');
    assert.equal(required(chat.runs).length, 1, 'continuations share the existing run budget');
    assert.equal(proposalCount(f.db, f.root, 'cedar', item.id), 1);
    assert.equal(
      required(f.db.prepare('SELECT count(*) AS n FROM documents').get()).n,
      0,
      'proposals are never autoaccepted',
    );
    assert.deepEqual(
      readTestChat(f.root, 'cedar', chat.id).conversionCheckpoint,
      JSON.parse(JSON.stringify(chat.conversionCheckpoint)),
    );
  },
);

test('conversion pauses on repeated reads and retains checkpoints across resume and Stop', async (t) => {
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-long.txt',
    bytes: Buffer.from('Fictional evidence '.repeat(1800)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional progress guard' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read the delivery',
    context: { intakeId: item.id },
  });
  await waitForConversionBridge(t, f, chat);
  await call(f.bridges[0], 'intake_read', { id: item.id });
  await f.bridges[0].callbacks.onEvent('thread/tokenUsage/updated', {
    turnId: 'turn-1',
    tokenUsage: { total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  });
  await complete(f.bridges[0]);
  await waitForConversionBridge(t, f, chat, 1);
  assert.equal(f.bridges.length, 2);
  await call(f.bridges[1], 'intake_read', { id: item.id });
  await f.bridges[1].callbacks.onEvent('thread/tokenUsage/updated', {
    turnId: 'turn-1',
    tokenUsage: { total: { inputTokens: 20, outputTokens: 7, totalTokens: 27 } },
  });
  await complete(f.bridges[1]);
  await tick();
  assert.equal(f.bridges.length, 2);
  assert.equal(chat.status, 'idle');
  assert.equal(required(chat.reading).reason, 'no_progress');
  assert.equal(required(required(chat.runs)[0].usage).totalTokens, 42);
  assert.equal(
    chat.reading?.measuredModelTokens,
    42,
    'cumulative turns never double-count token totals',
  );
  const saved = selectedResume(f.db, f.root, 'cedar', item.id, chat);
  f.assistant.send('cedar', chat.id, {
    message: 'Resume reading the retained evidence',
    context: { intakeId: item.id },
  });
  await waitForConversionBridge(t, f, chat, 2);
  assert.deepEqual(f.bridges[2].prompt.conversion.currentWindow, saved.currentWindow);
  assert.equal(f.bridges[2].prompt.conversion.pendingReadWindows, saved.pendingWindows.total);
  f.assistant.cancel('cedar', chat.id);
  assert.equal(required(chat.reading).reason, 'stopped');
  f.bridges[2].callbacks.onEvent('turn/completed', { turn: { status: 'completed' } });
  await tick();
  assert.equal(f.bridges.length, 3, 'late completion after Stop never schedules another turn');
});

test('productive host slice boundaries are resumable while provider errors stay failures', async (t) => {
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-context.txt',
    bytes: Buffer.from('Fictional evidence '.repeat(1800)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional bounded context' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, { message: 'Read evidence', context: { intakeId: item.id } });
  await waitForConversionBridge(t, f, chat);
  await call(f.bridges[0], 'intake_read', { id: item.id });
  f.bridges[0].callbacks.onExit?.(
    new ModelContextLimitError('Fictional local transcript boundary', 'slice'),
  );
  assert.equal(chat.status, 'idle');
  assert.equal(chat.reading?.reason, 'time_limit');
  assert.equal(
    chat.conversionCheckpoint?.initialContextFailures || 0,
    0,
    'a normal slice must not exhaust provider context recovery',
  );
  assert.ok(chat.reading!.pendingReadWindows > 0);
  f.assistant.send('cedar', chat.id, {
    message: 'Continue retained evidence',
    context: { intakeId: item.id },
  });
  await waitForConversionBridge(t, f, chat, 1);
  f.bridges[1].callbacks.onExit?.(new Error('Fictional provider unavailable'));
  assert.equal(chat.status, 'failed');
  assert.equal(chat.reading?.reason, 'error');
});

test('a reading deadline retains the in-flight guarded tool result and blocks another model request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-soft-reading-deadline.txt',
    bytes: Buffer.from('Independent fictional evidence '.repeat(1000)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional soft reading deadline' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read the fictional delivery',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  assert.ok(bridge);

  t.mock.timers.tick(15 * 60 * 1000);
  assert.equal(chat.status, 'running');
  assert.equal(bridge.closed, false, 'the slice deadline does not abort an in-flight request');

  const beforeVersion = getIntakeRead(f.db, f.root, 'cedar', item.id).version;
  const plan = await call(bridge, 'intake_plan', {
    id: item.id,
    action: 'create',
    version: beforeVersion,
  });
  assert.ok(plan.version > beforeVersion, 'the already-returned guarded tool applies exactly once');
  assert.equal(
    (getIntakeRead(f.db, f.root, 'cedar', item.id) as IntakeSummaryV2).collections.plans.total,
    1,
  );

  let boundaryError: unknown;
  try {
    await bridge.callbacks.beforeRequest?.();
  } catch (error) {
    boundaryError = error;
  }
  assert.ok(boundaryError instanceof ModelContextLimitError);
  bridge.callbacks.onExit?.(boundaryError);

  assert.equal(chat.status, 'idle');
  assert.equal(chat.reading?.reason, 'time_limit');
  assert.equal(chat.error, null);
  assert.equal(bridge.closed, true);
  assert.equal(f.bridges.length, 1, 'the expired slice never creates a fresh model turn');
  assert.equal(
    (getIntakeRead(f.db, f.root, 'cedar', item.id) as IntakeSummaryV2).collections.plans.total,
    1,
  );
});

test('Stop remains immediate after a soft reading deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-soft-deadline-stop.txt',
    bytes: Buffer.from('Independent fictional evidence '.repeat(1000)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional deadline Stop' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read the fictional delivery',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  assert.ok(bridge);

  t.mock.timers.tick(15 * 60 * 1000);
  f.assistant.cancel('cedar', chat.id);

  assert.equal(chat.status, 'cancelled');
  assert.equal(chat.reading?.reason, 'stopped');
  assert.equal(bridge.closed, true);
});

test('an absolute reading deadline blocks requests and generations before an overdue timer runs', async (t) => {
  fictionalModel(t);
  let monotonicNow = 0;
  const f = fixture(t, { monotonicNow: () => monotonicNow });
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-expired-generation.txt',
    bytes: Buffer.from('Independent fictional evidence '.repeat(1800)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional expired generation' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read the fictional delivery',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  assert.ok(bridge);
  await assert.doesNotReject(async () => bridge.callbacks.beforeRequest?.());
  await call(bridge, 'intake_read', { id: item.id });

  monotonicNow = 15 * 60 * 1000;
  await assert.rejects(
    async () => bridge.callbacks.beforeRequest?.(),
    ModelContextLimitError,
    'the absolute deadline denies admission before the overdue timer callback runs',
  );
  assert.equal(chat.status, 'running', 'the undispatched wakeup timer did not end the turn');
  complete(bridge);
  await tick();

  assert.equal(chat.status, 'idle');
  assert.equal(chat.reading?.reason, 'time_limit');
  assert.ok(chat.reading!.pendingReadWindows > 0);
  assert.equal(
    f.bridges.length,
    1,
    'productive completion cannot cross the expired slice boundary',
  );
  assert.equal(bridge.closed, true);

  f.assistant.send('cedar', chat.id, {
    message: 'Resume the retained fictional checkpoint',
    context: { intakeId: item.id },
  });
  const resumedBridge = await waitForConversionBridge(t, f, chat, 1);
  assert.ok(resumedBridge);
  await assert.doesNotReject(
    async () => resumedBridge.callbacks.beforeRequest?.(),
    'an explicit later resume receives a new run-scoped deadline',
  );
});

test('a genuine context limit keeps precedence after the soft reading deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-context-limit-precedence.txt',
    bytes: Buffer.from('Independent fictional evidence '.repeat(1000)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional context-limit precedence' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read the fictional delivery',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  assert.ok(bridge);

  t.mock.timers.tick(15 * 60 * 1000);
  bridge.callbacks.onExit?.(
    new ModelContextLimitError('Fictional provider context boundary', 'provider'),
  );

  assert.equal(chat.status, 'idle');
  assert.equal(chat.reading?.reason, 'context_limit');
  assert.equal(chat.error, 'Fictional provider context boundary');
  assert.equal(bridge.closed, true);
});

test('repeated source reads pause within one unfinished model turn', async (t) => {
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-repeat-guard.txt',
    bytes: Buffer.from('Independent fictional evidence '.repeat(1000)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional in-turn repeat guard' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read the original',
    context: { intakeId: item.id },
  });
  await waitForConversionBridge(t, f, chat);
  await call(f.bridges[0], 'intake_read', { id: item.id });
  await call(f.bridges[0], 'intake_read', { id: item.id });
  await call(f.bridges[0], 'intake_read', { id: item.id });
  await assert.rejects(call(f.bridges[0], 'intake_read', { id: item.id }), {
    code: 'CONVERSION_NO_PROGRESS',
  });
  assert.equal(chat.status, 'idle');
  assert.equal(chat.reading?.reason, 'no_progress');
  assert.equal(f.bridges.length, 1, 'no provider turn completion is needed to detect the loop');
});

test('a repeated page read carries a distinct re-read signal through the real read path, scoped to its own import', async (t) => {
  fictionalModel(t);
  const f = fixture(t);
  interface HostTimings {
    page: number;
    textLayerCharacters: number;
    reReadCount: number;
    firstRead: boolean;
  }
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-reread-signals.pdf',
    bytes: syntheticPdf([
      'Fictional page one text',
      'Fictional page two carries a longer stretch of independent evidence text',
    ]),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional re-read signal story' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read the original',
    context: { intakeId: item.id },
  });
  await waitForConversionBridge(t, f, chat);
  const read = (page?: number) =>
    call<{ hostTimings?: HostTimings }>(
      f.bridges[0]!,
      'intake_read',
      page === undefined ? { id: item.id } : { id: item.id, page },
    );

  const firstReadOfPage1 = await read();
  const rereadOfPage1 = await read();
  const firstReadOfPage2 = await read(2);
  const laterReadOfPage1 = await read();
  const lastReadOfPage1 = await read();

  assert.equal(firstReadOfPage1.hostTimings?.firstRead, true);
  assert.equal(firstReadOfPage1.hostTimings?.reReadCount, 0);

  assert.equal(rereadOfPage1.hostTimings?.firstRead, false);
  assert.equal(rereadOfPage1.hostTimings?.reReadCount, 1);
  assert.equal(
    rereadOfPage1.hostTimings?.textLayerCharacters,
    firstReadOfPage1.hostTimings?.textLayerCharacters,
    'the same page reports the same text-layer count on a re-read',
  );

  // A different page is its own first read, not a continuation of page 1's count.
  assert.equal(firstReadOfPage2.hostTimings?.firstRead, true);
  assert.equal(firstReadOfPage2.hostTimings?.reReadCount, 0);
  assert.notEqual(
    firstReadOfPage2.hostTimings?.textLayerCharacters,
    firstReadOfPage1.hostTimings?.textLayerCharacters,
  );

  // Back to page 1, twice more. `reReadCount` is a lifetime tally of prior reads of
  // this window in this import, so page 1's four reads report 0, 1, 2, 3 even with
  // page 2's read between the second and the third. The `repeatedReads` pause tracker
  // cannot answer this: its count resets whenever the progress fingerprint changes,
  // which it did here, so sourcing the diagnostic from it reported 1 for both of these.
  assert.equal(laterReadOfPage1.hostTimings?.firstRead, false);
  assert.equal(laterReadOfPage1.hostTimings?.reReadCount, 2);
  assert.equal(lastReadOfPage1.hostTimings?.firstRead, false);
  assert.equal(lastReadOfPage1.hostTimings?.reReadCount, 3);

  f.assistant.cancel('cedar', chat.id);

  // A separate import for the same profile must not inherit the first
  // import's re-read history: the new conversion checkpoint starts empty even
  // though this profile just accumulated re-reads in the earlier import.
  const secondItem = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-second-import.pdf',
    bytes: syntheticPdf(['Fictional independent second import page text']),
  });
  const secondChat = f.assistant.create('cedar', { title: 'Fictional second import' });
  linkIntakeConversion(f.db, f.root, 'cedar', secondItem.id, secondChat.id);
  f.assistant.send('cedar', secondChat.id, {
    message: 'Read the original',
    context: { intakeId: secondItem.id },
  });
  await waitForConversionBridge(t, f, secondChat, 1);
  const secondImportFirstRead = await call<{ hostTimings?: HostTimings }>(
    f.bridges[1]!,
    'intake_read',
    { id: secondItem.id },
  );
  assert.equal(secondImportFirstRead.hostTimings?.firstRead, true);
  assert.equal(secondImportFirstRead.hostTimings?.reReadCount, 0);
});

test('a retired model bridge rejection cannot stop its productive successor', async (t) => {
  fictionalModel(t);
  const callbacks: BridgeCallbacks[] = [];
  let admittedTurns = 0;
  let rejectRetired: ((error: Error) => void) | undefined;
  const f = fixture(t, {
    bridgeFactory: (events) => {
      const first = callbacks.length === 0;
      callbacks.push(events);
      return {
        async start() {
          return { model: 'fictional-late-close' };
        },
        turn() {
          admittedTurns++;
          return first
            ? new Promise<void>((_resolve, reject) => {
                rejectRetired = reject;
              })
            : Promise.resolve();
        },
        async cancel() {},
        close() {
          if (first) rejectRetired?.(new Error('Retired bridge closed'));
        },
      };
    },
  });
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-late-close.txt',
    bytes: Buffer.from('Fictional long evidence '.repeat(1800)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional generation boundary' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read this delivery',
    context: { intakeId: item.id },
  });
  while (admittedTurns < 1) {
    t.signal.throwIfAborted();
    assert.equal(chat.status, 'running', chat.error ?? 'conversion stopped before its turn');
    await tick();
  }
  await callbacks[0]!.onTool!({
    tool: 'health_intake_read',
    arguments: { id: item.id },
    callId: 'fictional-read',
  });
  callbacks[0]!.onEvent!('turn/completed', { turn: { status: 'completed' } });
  while (admittedTurns < 2) {
    t.signal.throwIfAborted();
    assert.equal(chat.status, 'running', chat.error ?? 'conversion stopped before its successor');
    await tick();
  }
  assert.equal(callbacks.length, 2);
  assert.equal(chat.status, 'running');
  assert.equal(chat.error, null);
  assert.equal(f.assistant.isBusy('cedar'), true);
  f.assistant.cancel('cedar', chat.id);
});

test('conversion diagnostics bind the original, model run, real progress and terminal reason', async (t) => {
  fictionalModel(t);
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());
  const f = fixture(t, { diagnostics });
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-diagnostics.txt',
    bytes: Buffer.from('Fictional source evidence '.repeat(1000)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional diagnostic story' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read source evidence',
    context: { intakeId: item.id },
  });
  await waitForConversionBridge(t, f, chat);
  await call(f.bridges[0], 'intake_read', { id: item.id });
  f.bridges[0].callbacks.onEvent('model/evidenceFallback', {
    durationMs: 12,
    pageCount: 1,
    reason: 'pdf_unsupported',
  });
  f.assistant.cancel('cedar', chat.id);
  const events = diagnostics.snapshot('cedar');
  assert.ok(
    events.some(
      (event) =>
        event.fields.phase === 'pdf_compatibility_fallback' &&
        event.fields.durationMs === 12 &&
        event.fields.pageCount === 1,
    ),
  );
  assert.ok(events.some((event) => event.event === 'import.active.started'));
  assert.ok(events.every((event) => event.context.importId === item.id));
  const journals = events.filter((event) => event.fields.phase === 'chat_journal');
  assert.ok(
    journals.some(
      (event) => event.event === 'import.phase.completed' && Number(event.fields.durationMs) >= 0,
    ),
  );
  assert.equal(
    journals.filter((event) => event.event === 'import.phase.started').length,
    journals.filter((event) => event.event === 'import.phase.completed').length,
  );
  assert.ok(journals.every((event) => typeof event.fields.messageCount === 'number'));
  assert.ok(
    events.some((event) => event.event === 'import.progress' && event.fields.readWindows === 1),
  );
  assert.equal(events.at(-1)?.event, 'import.active.completed');
  assert.equal(events.at(-1)?.fields.reasonCode, 'stopped');
  assert.ok(events.every((event) => event.context.runId === chat.runs?.[0]?.id));
  assert.doesNotMatch(
    JSON.stringify(events),
    /Fictional source evidence|fictional-diagnostics.txt/,
  );
});

test('conversion journal diagnostics report failed writes without swallowing the durability failure', async (t) => {
  fictionalModel(t);
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());
  const f = fixture(t, {
    diagnostics,
    journalWriter(root, profileId, chat, reason) {
      if (reason === 'turn-started') throw new Error('Fictional journal write failure');
      writeChat(root, profileId, chat, reason);
    },
  });
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-journal.txt',
    bytes: Buffer.from('Fictional private journal evidence'),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional journal check' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  assert.throws(
    () =>
      f.assistant.send('cedar', chat.id, {
        message: 'Read fictional evidence',
        context: { intakeId: item.id },
      }),
    (error: unknown) => hasCode(error, 'ASSISTANT_JOURNAL'),
  );
  assert.equal(f.bridges.length, 0);
  const events = diagnostics.snapshot('cedar');
  const failure = events.find(
    (event) => event.event === 'import.phase.failed' && event.fields.phase === 'chat_journal',
  );
  assert.ok(failure);
  assert.equal(failure.context.importId, item.id);
  assert.equal(failure.fields.reasonCode, 'unexpected_error');
  assert.ok(Number(failure.fields.durationMs) >= 0);
  assert.doesNotMatch(
    JSON.stringify(events),
    /Fictional private journal evidence|fictional-journal.txt|Fictional journal write failure/,
  );
});

test('a new provider request restores the truthful waiting phase without manufacturing progress', async (t) => {
  const f = await linkedFictionalOpticalConversion(t);
  const invalid = {
    id: f.item.id,
    sourceTextRevisionId: f.sourceTextRevisionId,
    version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
    jsonlText: JSON.stringify(fictionalOpticalPeopleEnvelope()),
    summary: 'Fictional rejected structure before another provider request',
  };
  await assert.rejects(call(f.bridge, 'intake_propose', invalid), {
    code: 'INVALID_JSONL',
  });
  const readsBeforeWait = required(f.chat.reading).readWindows;
  assert.equal(required(f.chat.reading).phase, 'preparing_results');

  await f.bridge.callbacks.onEvent('model/requestStarted', { turnId: 'fictional-next-request' });

  assert.equal(required(f.chat.reading).phase, 'waiting_for_model');
  assert.equal(required(f.chat.reading).modelRequests, 1);
  assert.equal(required(f.chat.reading).readWindows, readsBeforeWait);
  assert.equal(readTestChat(f.root, 'cedar', f.chat.id).reading?.phase, 'waiting_for_model');
  f.assistant.cancel('cedar', f.chat.id);
});

test('every physical provider retry attempt reaches cumulative reading request accounting', async (t) => {
  const f = await linkedFictionalOpticalConversion(t);
  const before = required(f.chat.reading).modelRequests || 0;

  await f.bridge.callbacks.onEvent('model/requestStarted', {
    turnId: 'fictional-transient-attempt-one',
    attempt: 1,
  });
  await f.bridge.callbacks.onEvent('model/requestStarted', {
    turnId: 'fictional-transient-attempt-two',
    attempt: 2,
  });
  await f.bridge.callbacks.onEvent('model/requestUsage', {
    turnId: 'fictional-transient-attempt-two',
    measured: true,
  });

  assert.equal(required(f.chat.reading).modelRequests, before + 2);
  assert.equal(required(f.chat.reading).modelUsageIncomplete, true);
  f.assistant.cancel('cedar', f.chat.id);
  assert.equal(readTestChat(f.root, 'cedar', f.chat.id).reading?.modelRequests, before + 2);
  assert.equal(readTestChat(f.root, 'cedar', f.chat.id).reading?.modelUsageIncomplete, true);
});

test('two-page PDF conversion corrects premature coverage in the same model run', async (t) => {
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-two-page-conversion.pdf',
    bytes: syntheticPdf(['Fictional first page', 'Fictional second page']),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional page continuation' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  const send = () =>
    f.assistant.send('cedar', chat.id, {
      message: 'Continue the reviewed conversion task',
      context: { intakeId: item.id },
    });
  send();
  let bridge = await waitForConversionBridge(t, f, chat);
  await call(bridge, 'intake_plan', {
    id: item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
  });
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', item.id);
  const row = (page: number) =>
    JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-page-' + page,
      kind: 'document',
      payload: 'Fictional page ' + page,
      provenance: {
        capturedVia: 'Fictional PDF',
        sourceSystem: null,
        sourceRecordId: null,
        evidenceClass: 'transcription',
        locator: 'page ' + page,
      },
      coverage: {
        status: 'partial',
        notes: ['Page-specific proposal; source remains separately accounted for'],
      },
    });
  await call(bridge, 'intake_read', { id: item.id, page: 1 });
  let sourceTextRevisionId = (
    await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: item.id })
  ).revisionId;
  await call(bridge, 'intake_propose', {
    sourceTextRevisionId,
    id: item.id,
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
    jsonlText: row(1),
    summary: 'Fictional first page retained',
  });
  complete(bridge);
  await waitForConversionBridge(t, f, chat, 1);
  assert.equal(chat.status, 'running', chat.error ?? '');
  bridge = required(f.bridges[1]);
  assert.equal(bridge.prompt.conversion.pendingWindows?.items[0]?.args.page, 2);
  sourceTextRevisionId = (
    await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: item.id })
  ).revisionId;
  const batch = () => ({
    sourceTextRevisionId,
    id: item.id,
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
    planId: plan.id,
    operationId: 'fictional-pages-covered',
    jsonlText: row(2),
    summary: 'Fictional pages covered',
    coverage: [
      {
        unitId: plan.units[0].id,
        kind: 'extracted',
        notes: 'Both fictional pages individually read and proposed',
      },
    ],
  });
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(call(bridge, 'intake_batch', batch()), {
      code: 'CONVERSION_COVERAGE_PENDING',
    });
  assert.equal(chat.status, 'running');
  assert.equal(required(chat.reading).reason, null);
  assert.equal(proposalCount(f.db, f.root, 'cedar', item.id), 1);
  await call(bridge, 'intake_read', { id: item.id, page: 2 });
  sourceTextRevisionId = (
    await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: item.id })
  ).revisionId;
  const wrongUnit = batch();
  wrongUnit.operationId = 'fictional-wrong-unit-after-read';
  wrongUnit.coverage[0].unitId = 'unit:fictional-wrong';
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(call(bridge, 'intake_batch', wrongUnit), {
      code: 'CONVERSION_COVERAGE_PENDING',
    });
  assert.equal(chat.status, 'running', 'a fresh evidence read reset the bounded error count');
  await call(bridge, 'intake_batch', batch());
  complete(bridge);
  assert.equal(chat.status, 'idle');
  assert.equal(required(chat.reading).reason, 'reading_exhausted');
  assert.equal(required(chat.reading).readyRecords, 2);
  assert.equal(required(chat.reading).pendingReadWindows, 0);
  assert.equal(f.bridges.length, 2, 'the first completed pass scheduled only one continuation');
  assert.equal(required(f.db.prepare('SELECT count(*) AS n FROM documents').get()).n, 0);
  assert.deepEqual(
    getIntakeOriginal(f.db, f.root, 'cedar', item.id).bytes,
    syntheticPdf(['Fictional first page', 'Fictional second page']),
  );
});

test('three consecutive premature coverage claims pause without publishing a proposal', async (t) => {
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-repeated-coverage.pdf',
    bytes: syntheticPdf(['Fictional first page', 'Fictional unread second page']),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional repeated coverage' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Convert the fictional PDF',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  await call(bridge, 'intake_plan', {
    id: item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
  });
  const current = getIntakeRead(f.db, f.root, 'cedar', item.id);
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', current.id);
  await call(bridge, 'intake_read', { id: item.id, page: 1 });
  const batch = {
    id: item.id,
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
    planId: plan.id,
    operationId: 'fictional-repeated-premature-coverage',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-first-page-only',
      kind: 'document',
      payload: 'Fictional first page',
      provenance: {
        capturedVia: 'Fictional PDF',
        sourceSystem: null,
        sourceRecordId: null,
        evidenceClass: 'transcription',
        locator: 'page 1',
      },
      coverage: { status: 'partial', notes: ['Second page remains unread'] },
    }),
    summary: 'Fictional premature coverage claim',
    coverage: [
      {
        unitId: plan.units[0].id,
        kind: 'extracted',
        notes: 'Incorrectly claims both pages were read',
      },
    ],
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(call(bridge, 'intake_batch', batch), {
      code: 'CONVERSION_COVERAGE_PENDING',
    });
    assert.equal(chat.status, attempt < 3 ? 'running' : 'idle');
  }
  assert.equal(required(chat.reading).reason, 'tool_error');
  assert.equal(proposalCount(f.db, f.root, 'cedar', item.id), 0);
  assert.equal(required(selectedPending(f, item.id, chat)[0]).args.page, 2);
});

async function linkedPdfPackage(t: TestContext, pages: string[], otherMember = false) {
  fictionalModel(t);
  const f = fixture(t);
  const pdf = resolve(f.root, 'fictional-member.pdf'),
    zip = resolve(f.root, 'fictional-pages.zip');
  writeFileSync(pdf, syntheticPdf(pages));
  writeFileSync(
    zip,
    zipFixture([
      { name: 'fictional-member.pdf', data: readFileSync(pdf) },
      ...(otherMember
        ? [{ name: 'fictional-other.txt', data: 'Other independently fictional source.' }]
        : []),
    ]),
  );
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-pages.zip',
    bytes: readFileSync(zip),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional PDF package coverage' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Convert this supplied package',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  const plan = await call<IntakeSummaryV2>(bridge, 'intake_plan', {
    id: item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
  });
  const inventory = await call(bridge, 'intake_package', { id: item.id, action: 'inventory' });
  const member = inventory.members[0];
  const first = await call(bridge, 'intake_package', {
    id: item.id,
    action: 'read_member',
    memberId: member.memberId,
    page: 1,
  });
  const jsonlText = JSON.stringify({
    format: 'health-record-v1',
    id: 'fictional-page-report',
    kind: 'document',
    payload: 'Fictional PDF page evidence',
    provenance: {
      capturedVia: 'Fictional ZIP',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'ZIP fictional-member.pdf; page 1',
    },
    coverage: { status: 'partial', notes: ['Fictional source evidence remains reviewable'] },
  });
  assert.ok(plan.activePlan.state === 'exact' && plan.activePlan.plan);
  return { ...f, item, chat, bridge, planId: plan.activePlan.plan.id, member, first, jsonlText };
}

// Real ZIP/PDF read and durable cursor accounting; the synthetic model has no latency.
test(
  'real package member page reads retain cursors, report rereads, and stop an unproductive loop',
  { timeout: 90_000 },
  async (t) => {
    const f = await linkedPdfPackage(t, [
      'Fictional package page one',
      'Fictional package page two',
    ]);
    const initialReads = f.chat.reading?.distinctReads || 0;
    const pending = selectedPending(f, f.item.id, f.chat).find((window) => window.args.page === 2);
    assert.equal(pending?.tool, 'health_intake_package');
    assert.equal(pending?.args.action, 'read_member');
    assert.equal(pending?.args.id, f.item.id);
    assert.equal(pending?.args.memberId, f.member.memberId);
    const firstTimings = f.first.hostTimings as
      { firstRead: boolean; reReadCount: number } | undefined;
    assert.equal(firstTimings?.firstRead, true);
    assert.equal(firstTimings?.reReadCount, 0);
    const read = (page?: number) =>
      call<{ hostTimings: { firstRead: boolean; reReadCount: number } }>(
        f.bridge,
        'intake_package',
        {
          id: f.item.id,
          action: 'read_member',
          memberId: f.member.memberId,
          ...(page === undefined ? {} : { page }),
        },
      );
    assert.equal(
      (await read()).hostTimings.reReadCount,
      1,
      'omitted page and explicit page1 share a read key',
    );
    assert.equal((await read(2)).hostTimings.firstRead, true);
    assert.equal(
      f.chat.reading?.distinctReads,
      initialReads + 1,
      'only the new page adds distinct progress',
    );
    assert.equal(
      selectedPending(f, f.item.id, f.chat).some(
        (window) => window.args.page === 2 && window.args.memberId === f.member.memberId,
      ),
      false,
    );
    assert.equal((await read(1)).hostTimings.reReadCount, 2);
    assert.equal((await read(1)).hostTimings.reReadCount, 3);
    await assert.rejects(read(1), { code: 'CONVERSION_NO_PROGRESS' });
    assert.equal(f.chat.reading?.reason, 'no_progress');
    assert.equal(f.chat.status, 'idle');
    assert.equal(f.bridges.length, 1);
  },
);

test(
  'retained child batch coverage is checked against its own plan and cannot bypass unread PDF pages',
  // Real parent/child PDF reads and a fresh durable reconstruction; no model calls.
  { timeout: 120_000 },
  async (t) => {
    const f = await linkedPdfPackage(
      t,
      ['Fictional first page', 'Fictional unread second page'],
      true,
    );
    const childId = f.first.metadata.sourceFileId;
    assert.equal(f.first.metadata.original.nextPage, 2);
    await call(f.bridge, 'intake_plan', {
      id: childId,
      action: 'create',
      version: getIntakeRead(f.db, f.root, 'cedar', childId).version,
    });
    const child = getIntakeRead(f.db, f.root, 'cedar', childId);
    const childPlan = selectedFixturePlan(f.db, f.root, 'cedar', childId);
    assert.equal(required(childPlan.units[0]).pages?.length, 2);
    await assert.rejects(
      call(f.bridge, 'intake_batch', {
        id: childId,
        version: child.version,
        planId: childPlan.id,
        operationId: 'fictional-premature-child-coverage',
        jsonlText: f.jsonlText,
        summary: 'Fictional attempted premature coverage',
        coverage: [
          {
            unitId: childPlan.units[0].id,
            kind: 'extracted',
            notes: 'Only first page was inspected through its parent member',
          },
        ],
      }),
      { code: 'CONVERSION_COVERAGE_PENDING' },
    );
    assert.equal(proposalCount(f.db, f.root, 'cedar', childId), 0);
    assert.equal(selectedFixturePlan(f.db, f.root, 'cedar', childId).units[0]!.status, 'pending');
    assert.equal(f.chat.status, 'running');
    await f.bridge.callbacks.beforeRequest?.();
    assert.equal(required(f.chat.reading).reason, null);
    assert.ok(
      selectedPending(f, f.item.id, f.chat).some(
        (window) => window.args.memberId === f.member.memberId && window.args.page === 2,
      ),
    );
    const childBatch = () => ({
      id: childId,
      version: getIntakeRead(f.db, f.root, 'cedar', childId).version,
      planId: childPlan.id,
      operationId: 'fictional-actual-child-coverage',
      jsonlText: f.jsonlText,
      summary: 'Both exact child pages were read',
      coverage: [
        {
          unitId: childPlan.units[0]!.id,
          kind: 'extracted',
          notes: 'Every page in the child plan was directly read',
        },
      ],
    });
    await call(f.bridge, 'intake_read', { id: childId, page: 1 });
    await assert.rejects(call(f.bridge, 'intake_batch', childBatch()), {
      code: 'CONVERSION_COVERAGE_PENDING',
    });
    assert.equal(proposalCount(f.db, f.root, 'cedar', childId), 0);
    const otherUnit = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units[1]!;
    await call(f.bridge, 'intake_plan', {
      id: f.item.id,
      action: 'read_unit',
      unitId: otherUnit.id,
    });
    assert.ok(isNativeAssistantCheckpoint(f.chat.conversionCheckpoint));
    assert.equal(f.chat.conversionCheckpoint.activeUnitId, otherUnit.id);
    const { clearIntakeStateCache } = await import('../intake-state-storage.ts');
    clearIntakeStateCache(f.db);
    const { nativeAssistantScope } = await import('../assistant-intake-native.ts');
    const { collectionConversionSourceUnit } = await import('../intake-continuation-collection.ts');
    const parentHeader = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
    assert.ok(isIntakeSummary(parentHeader));
    const unrelatedScope = nativeAssistantScope(
      nativeAssistantConversion(f.db, f.root, 'cedar', f.chat.id, parentHeader),
      otherUnit.id,
    )!;
    assert.equal(
      collectionConversionSourceUnit(unrelatedScope, childId),
      f.member.unitId,
      'the acknowledged child selects its persisted parent ledger after cache loss and another displayed unit',
    );
    // The route is part of recovered authority, not only the live SQLite/cache.
    exportCuration(f.db, f.root, 'cedar');
    const recoveredRoot = resolve(f.root, 'recovered-child-reading');
    rebuildProfile(f.root, 'cedar', recoveredRoot);
    const recoveredDB = openDatabase(profilePaths(recoveredRoot, 'cedar').database, 'cedar');
    attachPersonalDurability(recoveredDB, { root: recoveredRoot, profileId: 'cedar' });
    try {
      const recoveredHeader = getIntakeRead(recoveredDB, recoveredRoot, 'cedar', f.item.id);
      assert.ok(isIntakeSummary(recoveredHeader));
      const recoveredHost = nativeAssistantConversion(
        recoveredDB,
        recoveredRoot,
        'cedar',
        f.chat.id,
        recoveredHeader,
      );
      const { prepareNativeAssistantConversion } = await import('../assistant-intake-native.ts');
      await prepareNativeAssistantConversion(recoveredHost, {
        mappingVersion: createHash('sha256')
          .update(JSON.stringify(activeMappingRules(recoveredDB, recoveredHeader.providerId)))
          .digest('hex'),
      });
      const recoveredScope = nativeAssistantScope(recoveredHost, otherUnit.id)!;
      assert.equal(collectionConversionSourceUnit(recoveredScope, childId), f.member.unitId);
    } finally {
      recoveredDB.close();
    }
    await call(f.bridge, 'intake_read', { id: childId, page: 2 });
    const currentChild = getIntakeRead(f.db, f.root, 'cedar', childId);
    assert.ok(isIntakeSummary(currentChild));
    const childScope = nativeAssistantScope(
      nativeAssistantConversion(f.db, f.root, 'cedar', f.chat.id, currentChild),
      childPlan.units[0]!.id,
    )!;
    const { assertCollectionChildConversionCoverage } =
      await import('../intake-continuation-collection.ts');
    await assert.rejects(
      assertCollectionChildConversionCoverage(unrelatedScope, [childScope], {
        planId: childPlan.id,
        coverage: [
          {
            unitId: childPlan.units[0]!.id,
            kind: 'extracted',
            notes: 'Fictional wrong member ledger',
          },
        ],
      }),
      /Read does not belong to the retained package occurrence/,
    );
    const source = await call<{ revisionId: string }>(f.bridge, 'intake_source_text', {
      id: childId,
    });
    await call(f.bridge, 'intake_batch', {
      ...childBatch(),
      sourceTextRevisionId: source.revisionId,
    });
    assert.equal(proposalCount(f.db, f.root, 'cedar', childId), 1);
    assert.equal(selectedFixturePlan(f.db, f.root, 'cedar', childId).units[0]!.status, 'completed');
    assert.equal(
      selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units[0]!.status,
      'pending',
      'a child receipt does not invent parent member extraction coverage',
    );
  },
);

for (const parentNative of [false, true])
  // Actual parent/child authority, partial-tail refusal and publication; no model calls.
  test(
    `a ${parentNative ? 'native' : 'migrated legacy'} parent requires complete direct child text evidence for a native child plan`,
    { timeout: 90_000 },
    async (t) => {
      fictionalModel(t);
      const f = fixture(t);
      const literal = 'Fictional child text evidence and its retained tail. '.repeat(120);
      const item = uploadIntake(f.db, f.root, 'cedar', {
        filename: 'fictional-text-child.zip',
        bytes: zipFixture([{ name: 'fictional-child.txt', data: literal }]),
      });
      const chat = f.assistant.create('cedar', { title: 'Fictional child text coverage' });
      linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
      if (!parentNative) {
        // Retain a real pre-upgrade partial member read before the native host starts.
        // Fresh conversions now prepare native parent plans before model dispatch.
        await createIntakePlan(f.db, f.root, 'cedar', item.id, {
          version: item.version,
          operationId: 'fictional-legacy-parent-plan',
        });
        const { inventoryIntakePackage, readIntakePackageMember } =
          await import('../intake-package.ts');
        const { conversionCheckpoint, recordConversionRead } =
          await import('../intake-continuation.ts');
        const context = { db: f.db, root: f.root, profileId: 'cedar', id: item.id };
        const inventory = await inventoryIntakePackage(context);
        const memberId = required(inventory.members[0]).memberId;
        const args = { id: item.id, action: 'read_member', memberId, limit: 50 };
        const priorRead = await readIntakePackageMember({ ...context, memberId, limit: 50 });
        const legacy = getIntake(f.db, f.root, 'cedar', item.id);
        assert.ok(legacy.workflow);
        const prior = conversionCheckpoint({}, { ...legacy, workflow: legacy.workflow }, 'cedar');
        assert.equal(recordConversionRead(prior, 'health_intake_package', args, priorRead), true);
        assert.ok(prior.seen.length > 0);
        assert.ok(prior.pending.some((window) => window.args.memberId === memberId));
        chat.conversionCheckpoint = prior;
        writeChat(f.root, 'cedar', chat, 'fictional-pre-upgrade-child-coverage-journal');
        assert.deepEqual(readTestChat(f.root, 'cedar', chat.id).conversionCheckpoint, prior);
        assert.equal(isNativeAssistantCheckpoint(chat.conversionCheckpoint), false);
      }
      f.assistant.send('cedar', chat.id, {
        message: 'Convert this supplied package',
        context: { intakeId: item.id },
      });
      const bridge = await waitForConversionBridge(t, f, chat);
      const parentCheckpoint = chat.conversionCheckpoint;
      assert.ok(isNativeAssistantCheckpoint(parentCheckpoint));
      if (parentNative)
        await call(bridge, 'intake_plan', {
          id: item.id,
          action: 'create',
          version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
        });
      const inventory = await call(bridge, 'intake_package', { id: item.id, action: 'inventory' });
      const member = inventory.members[0];
      const first = await call<{ sourceFileId: string; original: { nextOffset: number | null } }>(
        bridge,
        'intake_package',
        {
          id: item.id,
          action: 'read_member',
          memberId: member.memberId,
          limit: 50,
        },
      );
      const childId = first.sourceFileId;
      assert.ok(first.original.nextOffset);
      await call(bridge, 'intake_plan', {
        id: childId,
        action: 'create',
        version: getIntakeRead(f.db, f.root, 'cedar', childId).version,
      });
      assert.equal(
        chat.conversionCheckpoint,
        parentCheckpoint,
        'creating the child plan never resets the migrated or native parent checkpoint',
      );
      const plan = selectedFixturePlan(f.db, f.root, 'cedar', childId);
      assert.equal(plan.units.length, 1);
      const jsonlText = JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-child-text',
        kind: 'document',
        payload: literal,
        provenance: {
          capturedVia: 'Fictional ZIP',
          sourceSystem: null,
          sourceRecordId: null,
          evidenceClass: 'transcription',
          locator: 'fictional-child.txt',
        },
        coverage: { status: 'partial', notes: ['Fictional child evidence remains reviewable'] },
      });
      const batch = () => ({
        id: childId,
        version: getIntakeRead(f.db, f.root, 'cedar', childId).version,
        planId: plan.id,
        operationId: 'fictional-child-text-coverage',
        jsonlText,
        summary: 'Fictional retained child text',
        coverage: [
          { unitId: plan.units[0]!.id, kind: 'extracted', notes: 'All selected text inspected' },
        ],
      });
      await assert.rejects(
        call(bridge, 'intake_batch', batch()),
        { code: 'CONVERSION_COVERAGE_PENDING' },
        'a parent-addressed pending tail and no direct child read cannot prove child completeness',
      );
      const read = await call<{ original: { nextOffset: number | null } }>(bridge, 'intake_read', {
        id: childId,
        limit: 512,
      });
      assert.ok(read.original.nextOffset);
      await assert.rejects(
        call(bridge, 'intake_batch', batch()),
        { code: 'CONVERSION_COVERAGE_PENDING' },
        'a direct child read must still exhaust its exact text tail',
      );
      await call(bridge, 'intake_plan', {
        id: childId,
        action: 'read_unit',
        unitId: plan.units[0]!.id,
      });
      await assert.rejects(
        call(bridge, 'intake_batch', {
          ...batch(),
          coverage: [
            {
              unitId: 'fictional-foreign-unit',
              kind: 'extracted',
              notes: 'Fictional foreign unit',
            },
          ],
        }),
        { code: 'CONVERSION_COVERAGE_PENDING' },
      );
      const source = await call<{ revisionId: string }>(bridge, 'intake_source_text', {
        id: childId,
      });
      await call(bridge, 'intake_batch', { ...batch(), sourceTextRevisionId: source.revisionId });
      assert.equal(proposalCount(f.db, f.root, 'cedar', childId), 1);
      assert.equal(
        selectedFixturePlan(f.db, f.root, 'cedar', childId).units[0]!.status,
        'completed',
      );
      const parentPlan = required(readPackagePlanScope(f.db, f.root, 'cedar', item.id));
      assert.equal(required(parentPlan.unit(member.memberId)).status, 'pending');
      assert.ok(
        selectedPending(f, item.id, chat).some(
          (window) => window.args.id === item.id && window.args.memberId === member.memberId,
        ),
        'the child receipt leaves the separately retained parent tail pending',
      );
    },
  );

test('a completely read single-page PDF member can receive reviewed extraction coverage without an unnecessary duplicate child read', async (t) => {
  const f = await linkedPdfPackage(t, ['Fictional complete single page']);
  assert.equal(f.first.metadata.original.page, 1);
  assert.equal(f.first.metadata.original.nextPage, null);
  assert.equal(f.first.metadata.original.nextOffset, null);
  assert.equal(selectedPending(f, f.item.id, f.chat).length, 0);
  await call(f.bridge, 'intake_batch', {
    id: f.item.id,
    version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
    planId: f.planId,
    operationId: 'fictional-single-page-covered',
    jsonlText: f.jsonlText,
    summary: 'Fictional single page read and proposed',
    coverage: [
      {
        unitId: f.member.unitId,
        kind: 'extracted',
        notes: 'Only supplied page fully read and its source content retained in proposal',
      },
    ],
  });
  complete(f.bridge);
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 1);
  assert.equal(selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units[0]!.status, 'completed');
  assert.equal(required(f.chat.reading).reason, 'reading_exhausted');
  assert.equal(required(f.db.prepare('SELECT count(*) AS n FROM documents').get()).n, 0);
});

test('encrypted cache loss retains conversion cursors for explicit resume and enforces the selected delivery boundary', async (t) => {
  fictionalModel(t);
  const vault = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(
    vault.manager,
    'Fictional resumable conversion',
  );
  let state = required(vault.manager.opened.get(profile.id), 'opened vault');
  const bridges: TestBridgeList = [];
  const options: Partial<Omit<AssistantOptions, 'root' | 'databases'>> = {
    availability: () => ({ available: true }),
    journalWriter(root, profileId, chat, reason) {
      writeChat(root, profileId, chat, reason);
      vault.manager.flush(profileId, { duringLock: true });
    },
    bridgeFactory: (callbacks: BridgeCallbacks) => {
      const bridge: TestBridge = {
        callbacks: testCallbacks(callbacks),
        closed: false,
        tools: [],
        prompt: {} as PromptDto,
        async start(_instructions: string, _tools: HealthTool[]) {
          return { model: 'fictional-continuation' };
        },
        async turn(prompt: string) {
          this.prompt = JSON.parse(prompt.slice(prompt.indexOf('{')));
        },
        async cancel() {},
        close() {
          this.closed = true;
        },
      };
      bridges.push(bridge);
      return bridge;
    },
  };
  const open = () =>
    createAssistant({ ...options, root: state.root, databases: new Map([[profile.id, state.db]]) });
  let assistant = open();
  t.after(() => assistant.close());
  const item = uploadIntake(state.db, state.root, profile.id, {
    filename: 'fictional-resume.txt',
    bytes: Buffer.from('Fictional retained source window. '.repeat(1000)),
  });
  const foreign = uploadIntake(state.db, state.root, profile.id, {
    filename: 'separate-unselected.txt',
    bytes: Buffer.from('Separate fictional delivery'),
  });
  const chat = assistant.create(profile.id, { title: 'Fictional durable cursor' });
  linkIntakeConversion(state.db, state.root, profile.id, item.id, chat.id);
  assistant.send(profile.id, chat.id, {
    message: 'Convert this delivery',
    context: { intakeId: item.id },
  });
  await waitForConversionBridge(t, { bridges }, chat);
  await call(bridges[0], 'intake_read', { id: item.id });
  assert.ok(isNativeAssistantCheckpoint(chat.conversionCheckpoint));
  const checkpoint = JSON.parse(JSON.stringify(chat.conversionCheckpoint));
  const resume = selectedResume(state.db, state.root, profile.id, item.id, chat);
  assert.ok(resume.pendingWindows.total > 0);
  const { readCollectionConversionSessionTotals } =
    await import('../intake-continuation-collection.ts');
  const retainedReads = readCollectionConversionSessionTotals(
    state.db,
    profile.id,
    item.id,
    chat.id,
  );
  assistant.close();
  vault.manager.lock(profile.id);
  rmSync(resolve(vault.dataDirectory, 'profiles', profile.id, 'cache'), {
    recursive: true,
    force: true,
  });
  vault.manager.unlock(profile.id, recoveryKit);
  state = required(vault.manager.opened.get(profile.id), 'reopened vault');
  assert.equal(state.metrics.cacheHit, false);
  assistant = open();
  const restored = assistant.get(profile.id, chat.id);
  assert.deepEqual(restored.conversionCheckpoint, checkpoint);
  assert.equal(bridges.length, 1, 'unlock/read does not restart model work');
  assistant.retry(profile.id, chat.id);
  await waitForConversionBridge(t, { bridges }, restored, 1);
  assert.deepEqual(bridges[1].prompt.conversion.currentWindow, resume.currentWindow);
  assert.deepEqual(bridges[1].prompt.conversion.pendingWindows, resume.pendingWindows);
  const firstPending = required(resume.pendingWindows.items[0]);
  assert.ok('args' in firstPending);
  assert.equal(firstPending.args.offset, 12000);
  await assert.rejects(call(bridges[1], 'intake_read', { id: foreign.id }), {
    code: 'CONVERSION_SCOPE',
  });
  assert.equal(required(restored.reading).reason, 'tool_error');
  assert.deepEqual(
    readCollectionConversionSessionTotals(state.db, profile.id, item.id, chat.id),
    retainedReads,
    'foreign evidence refusal preserves the exact recovered session root and counters',
  );
  assert.equal(required(state.db.prepare('SELECT count(*) AS n FROM documents').get()).n, 0);
});

test('an untested configured connection is checked automatically before private chat starts', async (t) => {
  let checks = 0;
  const { assistant, bridges } = fixture(t, {
    availability: () => ({ available: false, readiness: 'untested' }),
    connectionCheck: async () => {
      checks++;
      return { available: true };
    },
  });
  const chat = assistant.create('cedar', { message: 'Find my notes' });
  await tick();
  assert.equal(checks, 1);
  assert.equal(bridges.length, 1);
  assert.equal(chat.status, 'running');
  complete(bridges[0]);
});

test('failed automatic preflight sends no private chat to the model', async (t) => {
  const { assistant, bridges } = fixture(t, {
    availability: () => ({ available: false, readiness: 'untested' }),
    connectionCheck: async () => {
      throw Error('Fictional authentication expired');
    },
  });
  const chat = assistant.create('cedar', { message: 'Find my notes' });
  await tick();
  assert.equal(bridges.length, 0);
  assert.equal(chat.status, 'failed');
  assert.match(required(chat.error), /authentication expired/);
});

test('chat streams, cancels, retries without duplicating user text, and persists only visible messages', async (t) => {
  const { assistant, bridges, root } = fixture(t);
  const chat = assistant.create('cedar', {
    message: 'Find my notes',
    context: { route: '/notes?id=abc' },
  });
  await tick();
  assert.equal(chat.status, 'running');
  assert.equal(bridges[0].prompt.route, '#/notes?id=abc');
  assert.throws(() => assistant.create('cedar', { message: 'Second batch' }), /already running/);
  bridges[0].callbacks.onEvent('item/reasoning/textDelta', {
    text: 'Never store internal reasoning',
  });
  bridges[0].callbacks.onEvent('item/agentMessage/delta', {
    itemId: 'reply',
    delta: 'Visible partial answer',
  });
  assert.equal(
    required(assistant.get('cedar', chat.id).messages.at(-1)).content,
    'Visible partial answer',
  );
  assistant.cancel('cedar', chat.id);
  assert.equal(chat.status, 'cancelled');
  assert.equal(required(chat.messages.at(-1)).status, 'interrupted');
  assert.equal(bridges[0].closed, true);
  assistant.retry('cedar', chat.id);
  await tick();
  assert.equal(chat.messages.filter((m) => m.role === 'user').length, 1);
  bridges[0].callbacks.onEvent('item/agentMessage/delta', {
    itemId: 'late',
    delta: 'Must be ignored',
  });
  bridges[1].callbacks.onEvent('item/completed', {
    item: { id: 'reply-2', type: 'agentMessage', text: 'Completed answer' },
  });
  complete(bridges[1]);
  assert.equal(chat.status, 'idle');
  assert.equal(required(chat.messages.at(-1)).content, 'Completed answer');
  const saved = readTestChat(root, 'cedar', chat.id);
  assert.equal(saved.messages.length, 3);
  assert.equal(JSON.stringify(saved).includes('Never store internal reasoning'), false);
  assert.equal(JSON.stringify(saved).includes('Must be ignored'), false);
});

test('tool reads, conversations and writes cannot be redirected into another profile', async (t) => {
  const { assistant, db, databases, bridges, root } = fixture(t);
  createNote(db, {
    id: 'note:11111111-2222-4333-8444-555555555555',
    title: 'Private original',
    content: 'Only this profile',
  });
  createNote(required(databases.get('cookie-dough')), {
    id: 'note:11111111-2222-4333-8444-555555555555',
    title: 'Cookie fixture',
    content: 'Synthetic',
  });
  const chat = assistant.create('cookie-dough', { message: 'Read note' });
  await tick();
  const note = await call(bridges[0], 'read', {
    collection: 'notes',
    id: 'note:11111111-2222-4333-8444-555555555555',
    profileId: 'cedar',
  });
  assert.equal(note.title, 'Cookie fixture');
  assert.equal(note.appUrl, '#/notes?id=note%3A11111111-2222-4333-8444-555555555555');
  const found = await call(bridges[0], 'query', { collection: 'notes', q: 'Cookie fixture' });
  assert.equal(found.data[0].appUrl, note.appUrl);
  assert.throws(() => assistant.get('cedar', chat.id), /not found/);
  await assert.rejects(
    () => call(bridges[0], 'query', { collection: 'sqlite_master' }),
    /Unsupported/,
  );
  await assert.rejects(() => call(bridges[0], 'shell', { command: 'anything' }), /Unsupported/);
  assert.equal(listChats(root, 'cedar').length, 0);
  complete(bridges[0]);
});

test('note proposals preserve unrelated data, require versions and apply idempotently', async (t) => {
  const { assistant, db, bridges } = fixture(t);
  let person = createNote(db, {
    kind: 'person',
    title: 'A relative',
    content: 'Original',
    person: {
      fullName: 'Synthetic Relative',
      relationship: 'family',
      unknownProperty: { preserved: true },
    },
  });
  const chat = assistant.create('cedar', { message: 'Add a phone' });
  await tick();
  const proposal = await call(bridges[0], 'propose_note', {
    noteId: person.id,
    version: person.version,
    kind: 'person',
    title: person.title,
    content: person.content,
    person: { phone: '555-0100' },
    reason: 'User-provided phone',
  });
  assert.equal(getNote(db, person.id).person.phone, undefined);
  complete(bridges[0]);
  assistant.apply('cedar', chat.id, proposal.id);
  person = getNote(db, person.id);
  assert.equal(person.person.phone, '555-0100');
  assert.deepEqual(person.person.unknownProperty, { preserved: true });
  assert.equal(person.person.fullName, 'Synthetic Relative');
  const version = person.version;
  assistant.apply('cedar', chat.id, proposal.id);
  assert.equal(getNote(db, person.id).version, version);
  assistant.send('cedar', chat.id, { message: 'Edit again' });
  await tick();
  const stale = await call(bridges[1], 'propose_note', {
    noteId: person.id,
    version,
    title: person.title,
    content: 'Proposed content',
    reason: 'Draft',
  });
  saveNote(db, person.id, { version, content: 'Intervening user edit' });
  complete(bridges[1]);
  assert.throws(() => assistant.apply('cedar', chat.id, stale.id), /changed/);
  assert.equal(getNote(db, person.id).content, 'Intervening user edit');
});

test('new People proposals keep contact and family history on the reviewed person', async (t) => {
  const { assistant, db, bridges } = fixture(t);
  const chat = assistant.create('cedar', { message: 'Prepare fictional People entries' });
  await tick();
  const selfBefore = getNote(db, 'patient');
  const proposals = [];
  for (const entry of [
    {
      title: 'Dr Mira Finch',
      content: 'Named clinician in a fictional visit summary.',
      person: { fullName: 'Mira Finch', phone: '+1 415 555 0127', tags: ['Professional'] },
    },
    {
      title: 'Aunt Juniper',
      content: 'Fictional family recollection, not the profile owner’s diagnosis.',
      person: {
        fullName: 'Juniper Vale',
        relationship: 'aunt',
        tags: ['Family'],
        medicalHistory: 'Reported migraines; onset date unknown.',
      },
    },
  ]) {
    const proposal = await call(bridges[0], 'propose_note', {
      kind: 'person',
      ...entry,
      reason: 'Prepare supplied fictional information for explicit review',
    });
    assert.equal(
      sqlNumber(db.prepare('SELECT count(*) AS n FROM notes WHERE id=?').get(proposal.noteId), 'n'),
      0,
    );
    proposals.push({ proposal, entry });
  }
  complete(bridges[0]);
  for (const { proposal, entry } of proposals) {
    assistant.apply('cedar', chat.id, proposal.id);
    const saved = getNote(db, proposal.noteId);
    assert.equal(saved.kind, 'person');
    assert.equal(saved.isSelf, false);
    assert.equal(saved.title, entry.title);
    for (const [key, value] of Object.entries(entry.person)) {
      assert.deepEqual(saved.person[key], value);
    }
    assert.equal(saved.person.tags?.includes('Primary Care Provider'), false);
    assistant.apply('cedar', chat.id, proposal.id);
    assert.equal(getNote(db, proposal.noteId).version, saved.version);
    assert.equal(
      sqlNumber(db.prepare('SELECT count(*) AS n FROM notes WHERE id=?').get(proposal.noteId), 'n'),
      1,
    );
  }
  assert.deepEqual(getNote(db, 'patient'), selfBefore);
});

test('new note save stays editable; finished notes cannot be overwritten', async (t) => {
  const { assistant, db, bridges } = fixture(t);
  const old = createNote(db, { kind: 'historical', title: 'Finished visit', content: 'Original' });
  finishNote(db, old.id, {
    version: old.version,
    title: old.title,
    content: old.content,
    links: old.links,
  });
  const chat = assistant.create('cedar', { message: 'Prepare annual visit' });
  await tick();
  await assert.rejects(
    () =>
      call(bridges[0], 'propose_note', {
        noteId: old.id,
        version: 2,
        title: 'Replacement',
        content: 'Changed',
        reason: 'No',
      }),
    /finished history/,
  );
  const proposal = await call(bridges[0], 'propose_note', {
    kind: 'historical',
    title: 'Annual preparation',
    content: 'Questions',
    typeLabel: 'Primary care',
    reason: 'Requested preparation',
  });
  complete(bridges[0]);
  assistant.apply('cedar', chat.id, proposal.id);
  assert.equal(getNote(db, proposal.noteId).status, 'draft');
  const version = getNote(db, proposal.noteId).version;
  proposal.status = 'pending'; // Simulate a lost post-save journal response.
  assistant.apply('cedar', chat.id, proposal.id);
  assert.equal(getNote(db, proposal.noteId).version, version);
});

test('assistant journals survive profile backup and restoration', async (t) => {
  const { assistant, db, bridges, root } = fixture(t);
  const chat = assistant.create('cedar', { message: 'Synthetic backup test' });
  await tick();
  complete(bridges[0]);
  exportCuration(db, root, 'cedar');
  const backup = await createBackup(db, root, 'cedar');
  const destination = resolve(root, 'restored');
  restoreBackup(backup.path, destination);
  assert.deepEqual(readChat(destination, 'cedar', chat.id), readChat(root, 'cedar', chat.id));
  const receipt = JSON.parse(readFileSync(resolve(backup.path, 'manifest.json'), 'utf8')) as {
    profileSources: Array<{ path: string }>;
  };
  assert.ok(receipt.profileSources.some((f) => f.path.includes('/chats/')));
  assert.equal(
    receipt.profileSources.some((f) => f.path.includes('/cookie-dough/')),
    false,
  );
});

test('assistant HTTP routes retain profile scope and require the app origin for messages', async (t) => {
  const { root, databases, options } = fixture(t);
  const app = createApp({ root, databases, assistantOptions: options });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/cedar/assistant`;
  const headers = { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' };
  assert.equal(
    (
      await fetch(base + '/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Test' }),
      })
    ).status,
    403,
  );
  const response = await fetch(base + '/chats', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'HTTP fixture' }),
  });
  assert.equal(response.status, 200);
  const { data } = (await response.json()) as { data: { id: string } };
  assert.equal(
    (await fetch(base + `/chats/${data.id}/cancel`, { method: 'POST', headers })).status,
    200,
  );
  assert.equal(
    (await fetch(base.replace('cedar', 'cookie-dough') + `/chats/${data.id}`)).status,
    404,
  );
});

test('cancelled tools cannot act in a later retry or publish an in-flight intake proposal', async (t) => {
  const { assistant, bridges, root, db } = fixture(t);
  const original = uploadIntake(db, root, 'cedar', {
    filename: 'letter.txt',
    newProviderName: 'Synthetic clinic',
    bytes: Buffer.from('Original letter'),
  });
  const chat = assistant.create('cedar', { message: 'Convert my letter' });
  await tick();
  const jsonlText = JSON.stringify({
    format: 'health-record-v1',
    id: 'letter-page-1',
    kind: 'document',
    payload: 'Original letter',
    provenance: {
      capturedVia: 'Upload',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'letter.txt / full text',
    },
    coverage: { status: 'unknown', notes: [] },
  });
  const pending = call(bridges[0], 'intake_propose', {
    id: original.id,
    version: original.version,
    jsonlText,
    summary: 'Letter conversion',
  });
  assistant.cancel('cedar', chat.id);
  await assert.rejects(pending, /no longer running/);
  assert.equal(proposalCount(db, root, 'cedar', original.id), 0);
  assert.equal(chat.operations.length, 0);
  assistant.retry('cedar', chat.id);
  await tick();
  await assert.rejects(
    () =>
      call(bridges[0], 'propose_note', {
        title: 'Late proposal',
        content: 'Must not be saved',
        reason: 'Old response',
      }),
    /no longer running/,
  );
  assert.equal(chat.proposals.length, 0);
  const converted = await call<IntakeSummaryV2>(bridges[1], 'intake_propose', {
    id: original.id,
    version: original.version,
    jsonlText,
    summary: 'Letter conversion',
  });
  assert.equal(converted.collections.proposals.total, 1);
  assert.equal(chat.operations.length, 1);
  complete(bridges[1]);
});

test('journal failure during streaming stops the response without throwing from the event callback', async (t) => {
  let fail = false;
  const { assistant, bridges } = fixture(t, {
    journalWriter(root, profileId, chat, reason) {
      if (fail) throw new Error('Synthetic disk failure');
      writeChat(root, profileId, chat, reason);
    },
  });
  const chat = assistant.create('cedar', { message: 'Keep the visible response' });
  await tick();
  fail = true;
  assert.doesNotThrow(() =>
    bridges[0].callbacks.onEvent('item/completed', {
      item: { id: 'visible', type: 'agentMessage', text: 'The visible answer' },
    }),
  );
  assert.equal(chat.status, 'failed');
  assert.match(required(chat.error), /recovery log could not be saved/);
  assert.equal(required(chat.messages.at(-1)).content, 'The visible answer');
  assert.equal(bridges[0].closed, true);
  fail = false;
  assistant.retry('cedar', chat.id);
  await tick();
  complete(bridges[1]);
  assert.equal(chat.status, 'idle');
});

test('a failed start journal keeps a recoverable failed chat instead of an unowned running response', async (t) => {
  let fail = true;
  const { assistant, bridges } = fixture(t, {
    journalWriter(root, profileId, chat, reason) {
      if (fail && reason === 'turn-started') throw new Error('Synthetic disk failure');
      writeChat(root, profileId, chat, reason);
    },
  });
  assert.throws(
    () => assistant.create('cedar', { message: 'Retry after disk failure' }),
    (error: unknown) => hasCode(error, 'ASSISTANT_JOURNAL'),
  );
  const chat = required(assistant.list('cedar')[0]) as AssistantChat;
  assert.equal(chat.status, 'failed');
  assert.equal(bridges.length, 0);
  fail = false;
  assistant.retry('cedar', chat.id);
  await tick();
  complete(bridges[0]);
  assert.equal(assistant.get('cedar', chat.id).status, 'idle');
  assert.equal(
    assistant.get('cedar', chat.id).messages.filter((message) => message.role === 'user').length,
    1,
  );
});

function syntheticPdf(pages: string[]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of pages.entries()) {
    const content = `BT /F1 12 Tf 20 150 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500000 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('assistant native PDF selection uses the host capability and preserves a lazy same-page fallback', async (t) => {
  const { assistant, bridges, root, db } = fixture(t);
  const item = uploadIntake(db, root, 'cedar', {
    filename: 'fictional-host-pdf.pdf',
    newProviderName: 'Fictional clinic',
    bytes: syntheticPdf(['Fictional first page', 'Fictional selected second page']),
  });
  assistant.create('cedar', { message: 'Read selected fictional PDF evidence' });
  await tick();
  const bridge = bridges[0];
  const result = (await bridge.callbacks.onTool({
    tool: 'health_intake_read',
    arguments: { id: item.id, page: 2 },
    callId: 'fictional-host-native',
    pdf: true,
  })) as {
    pdfContent: string;
    pdfFallback: () => Promise<{ imageContent: string; metadata: { original: { page: number } } }>;
    metadata: { original: { page: number; complete: boolean } };
  };
  assert.match(result.pdfContent, /^data:application\/pdf;base64,/);
  assert.equal(result.metadata.original.page, 2);
  assert.equal(result.metadata.original.complete, false);
  assert.equal(
    typeof result.pdfFallback,
    'function',
    'assistant result bounding must retain the host callback',
  );
  const fallback = await result.pdfFallback();
  assert.match(fallback.imageContent, /^data:image\/png;base64,/);
  assert.equal(fallback.metadata.original.page, 2);
  const untrustedFlag = (await bridge.callbacks.onTool({
    tool: 'health_intake_read',
    arguments: { id: item.id, page: 2, pdf: true },
    callId: 'fictional-model-pdf-flag',
  })) as { imageContent: string; pdfContent?: string };
  assert.match(untrustedFlag.imageContent, /^data:image\/png;base64,/);
  assert.equal(untrustedFlag.pdfContent, undefined);
  complete(bridge);
});

test('assistant PDF intake preserves visual pages, text offsets, and explicit image derivatives', async (t) => {
  const { assistant, bridges, root, db } = fixture(t);
  const original = uploadIntake(db, root, 'cedar', {
    filename: 'two-pages.pdf',
    newProviderName: 'Synthetic clinic',
    bytes: syntheticPdf(['A'.repeat(27000), 'Second page']),
  });
  assistant.create('cedar', { message: 'Read these pages' });
  await tick();
  const first = await call(bridges[0], 'intake_read', { id: original.id, page: 1 });
  assert.match(first.imageContent, /^data:image\/png;base64,/);
  assert.equal(first.metadata.original.page, 1);
  assert.equal(first.metadata.original.totalPages, 2);
  assert.equal(first.metadata.original.text.length, 24000);
  assert.equal(first.metadata.original.nextOffset, 24000);
  assert.equal(first.metadata.original.nextPage, 2);
  assert.equal(first.metadata.original.complete, false);
  assert.equal('workflow' in first.metadata.intake, false);
  assert.equal('intake' in first.metadata.original, false);
  const remainder = await call(bridges[0], 'intake_read', {
    id: original.id,
    page: 1,
    offset: first.metadata.original.nextOffset,
  });
  assert.equal(remainder.metadata.original.nextOffset, null);
  assert.equal(remainder.metadata.original.complete, false);
  const second = await call(bridges[0], 'intake_read', { id: original.id, page: 2 });
  assert.match(second.metadata.original.text, /Second page/);
  assert.equal(second.metadata.original.nextPage, null);
  assert.match(second.metadata.original.coverage, /Page render plus text and embedded files/);
  await assert.rejects(
    () => call(bridges[0], 'intake_read', { id: original.id, page: 3 }),
    /outside document/,
  );
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=',
    'base64',
  );
  const image = uploadIntake(db, root, 'cedar', {
    filename: 'synthetic.png',
    newProviderName: 'Synthetic clinic',
    bytes,
  });
  const read = await call(bridges[0], 'intake_read', { id: image.id });
  assert.match(read.imageContent, /^data:image\/png;base64,/);
  assert.equal(read.metadata.intake.id, image.id);
  assert.equal('workflow' in read.metadata.intake, false);
  assert.equal('intake' in read.metadata.original, false);
  assert.match(read.metadata.caution, /visual derivative/);
  assert.equal(proposalCount(db, root, 'cedar', image.id), 0);
  complete(bridges[0]);
});

test('default PDF units require every listed page and leave later targets resumable', async (t) => {
  fictionalModel(t);
  const f = fixture(t);
  const original = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-default-targets.pdf',
    newProviderName: 'Fictional clinic',
    bytes: syntheticPdf(['First target page', 'Second target page', 'Later target page']),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional default PDF targets' });
  linkIntakeConversion(f.db, f.root, 'cedar', original.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read each exact fictional target without accepting records',
    context: { route: '/import', intakeId: original.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  await bridge.callbacks.onEvent('model/requestStarted', { turnId: 'fictional-before-first-plan' });
  await call(bridge, 'intake_read', { id: original.id, page: 1 });
  assert.ok(isNativeAssistantCheckpoint(chat.conversionCheckpoint));
  const prior = structuredClone(chat.conversionCheckpoint);
  const priorReading = structuredClone(chat.reading);
  assert.ok((priorReading?.readWindows ?? 0) > 0);
  await call(bridge, 'intake_plan', {
    id: original.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', original.id).version,
  });
  assert.ok(isNativeAssistantCheckpoint(chat.conversionCheckpoint));
  assert.equal(chat.conversionCheckpoint.turns, prior.turns);
  assert.equal(chat.conversionCheckpoint.modelRequests, prior.modelRequests);
  assert.equal(chat.reading?.readWindows, priorReading?.readWindows);
  assert.equal(selectedPending(f, original.id, chat)[0]?.args.page, 2);
  let item = getIntakeRead(f.db, f.root, 'cedar', original.id);
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', item.id);
  assert.deepEqual(
    plan.units.map((unit) => unit.pages),
    [[1, 2], [3]],
  );
  const descriptor = await call<{
    unit: { id: string; pages: number[] };
    sourceFileId: string;
    note: string;
    text?: unknown;
    imageContent?: unknown;
  }>(bridge, 'intake_plan', {
    id: item.id,
    action: 'read_unit',
    unitId: plan.units[0]!.id,
  });
  assert.deepEqual(descriptor.unit.pages, [1, 2]);
  assert.equal(descriptor.sourceFileId, item.id);
  assert.equal(descriptor.text, undefined, 'read_unit does not replace exact page reads');
  assert.equal(descriptor.imageContent, undefined);

  const contextRow = (id: string, locator: string) => ({
    format: 'health-record-v1',
    id,
    kind: 'context',
    payload: { text: 'Independently fictional PDF context' },
    provenance: {
      capturedVia: 'Fictional PDF',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator,
    },
    coverage: { status: 'partial', notes: ['No clinical completeness claim is made.'] },
  });
  let sourceTextRevisionId: string | undefined;
  const batch = (unitIndex: number, operationId: string) => ({
    sourceTextRevisionId,
    id: item.id,
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
    planId: plan.id,
    operationId,
    summary: 'Exact fictional target pages retained without acceptance.',
    jsonlText: JSON.stringify(contextRow(operationId, plan.units[unitIndex]!.locator)),
    coverage: [
      {
        unitId: plan.units[unitIndex]!.id,
        kind: 'extracted',
        notes: 'Every page and cursor in this exact target was read.',
      },
    ],
  });
  await assert.rejects(call(bridge, 'intake_batch', batch(0, 'fictional-target-one')), (error) =>
    hasCode(error, 'CONVERSION_COVERAGE_PENDING'),
  );
  await call(bridge, 'intake_read', { id: item.id, page: 1 });
  await call(bridge, 'intake_read', { id: item.id, page: 2 });
  sourceTextRevisionId = (
    await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: item.id })
  ).revisionId;
  const firstSaved = await call<IntakeRead>(
    bridge,
    'intake_batch',
    batch(0, 'fictional-target-one'),
  );
  assert.ok(isIntakeSummary(firstSaved));
  assert.equal(chat.reading?.remainingUnits, 1);
  item = getIntakeRead(f.db, f.root, 'cedar', item.id);
  assert.equal(selectedFixturePlan(f.db, f.root, 'cedar', item.id).units[1]!.status, 'pending');

  await call(bridge, 'intake_plan', {
    id: item.id,
    action: 'read_unit',
    unitId: plan.units[1]!.id,
  });
  await assert.rejects(call(bridge, 'intake_batch', batch(1, 'fictional-target-two')), (error) =>
    hasCode(error, 'CONVERSION_COVERAGE_PENDING'),
  );
  await call(bridge, 'intake_read', { id: item.id, page: 3 });
  sourceTextRevisionId = (
    await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: item.id })
  ).revisionId;
  const secondSaved = await call<IntakeRead>(
    bridge,
    'intake_batch',
    batch(1, 'fictional-target-two'),
  );
  assert.ok(isIntakeSummary(secondSaved));
  assert.equal(chat.reading?.remainingUnits, 0);
  item = getIntakeRead(f.db, f.root, 'cedar', item.id);
  assert.equal(selectedFixturePlan(f.db, f.root, 'cedar', item.id).units[1]!.status, 'completed');
  complete(bridge);
});

test('assistant accounts for one exact image only after a visual read and durable batch receipt', async (t) => {
  fictionalModel(t);
  const { assistant, bridges, db, root } = fixture(t);
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=',
    'base64',
  );
  let image: IntakeRead = uploadIntake(db, root, 'cedar', {
    filename: 'fictional-prescription.png',
    newProviderName: 'Fictional vision office',
    bytes,
  });
  const chat = assistant.create('cedar', { title: 'Fictional image conversion' });
  linkIntakeConversion(db, root, 'cedar', image.id, chat.id);
  assistant.send('cedar', chat.id, {
    message: 'Read the supplied fictional image',
    context: { route: '/sources', intakeId: image.id },
  });
  const bridge = await waitForConversionBridge(t, { bridges }, chat);
  const created = await call(bridge, 'intake_plan', {
    id: image.id,
    version: getIntakeRead(db, root, 'cedar', image.id).version,
    action: 'create',
  });
  image = getIntakeRead(db, root, 'cedar', image.id);
  const plan = selectedFixturePlan(db, root, 'cedar', image.id);
  assert.ok('sourceIndex' in plan.plan);
  assert.equal(plan.plan.sourceIndex.kind, 'image');
  assert.equal(plan.pins.sourceHash, image.sha256);
  assert.deepEqual(
    plan.units.map(({ kind, locator, status }) => ({ kind, locator, status })),
    [{ kind: 'image', locator: 'whole retained image', status: 'pending' }],
  );
  const request = {
    id: image.id,
    version: created.version,
    sourceTextRevisionId: undefined as string | undefined,
    planId: plan.id,
    operationId: 'fictional-image-batch',
    summary: 'The exact fictional image was inspected.',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-image-context',
      kind: 'context',
      payload: { text: 'Fictional visual context' },
      provenance: {
        capturedVia: 'Fictional image',
        sourceSystem: null,
        sourceRecordId: null,
        evidenceClass: 'transcription',
        locator: 'whole image',
      },
      coverage: { status: 'complete_response', notes: [] },
    }),
    coverage: [
      {
        unitId: plan.units[0]!.id,
        kind: 'extracted',
        notes: 'Exact whole-image occurrence inspected.',
      },
    ],
  };
  await assert.rejects(call(bridge, 'intake_batch', request), (error: unknown) =>
    hasCode(error, 'CONVERSION_COVERAGE_PENDING'),
  );
  const read = await call(bridge, 'intake_read', { id: image.id });
  assert.match(read.imageContent, /^data:image\/png;base64,/);
  request.sourceTextRevisionId = (
    await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: image.id })
  ).revisionId;
  request.version = getIntakeRead(db, root, 'cedar', image.id).version;
  const saved = await call<IntakeRead>(bridge, 'intake_batch', request);
  assert.ok(isIntakeSummary(saved));
  assert.ok(isNativeAssistantCheckpoint(chat.conversionCheckpoint));
  const resume = nativeAssistantResume(
    nativeAssistantConversion(db, root, 'cedar', chat.id, saved),
    chat.conversionCheckpoint,
    plan.pins.mappingVersion,
  );
  assert.equal(resume.reading.totalUnits, 1);
  assert.equal(resume.reading.accountedUnits, 1);
  assert.equal(resume.reading.remainingUnits, 0);
  assert.equal(resume.coverage, 'reading_progress_only');
  let queue = await listIntakeReportQueueRead(db, root, 'cedar');
  assert.ok('format' in queue.activity);
  assert.deepEqual(queue.activity.remainingUnits, { state: 'exact', value: 0 });
  assert.equal(queue.activity.extractionUnknownFiles, 1);
  assert.equal(queue.activity.extractionComplete, false);
  const extracted = required(readDirectPlanScope(db, 'cedar', image.id));
  assert.equal(extracted.unitCount, 1);
  assert.equal(extracted.unitAt(0)?.coverage?.kind, 'extracted');
  assert.equal(extracted.unitAt(0)?.status, 'completed');

  await call(bridge, 'intake_read', { id: image.id });
  await call(bridge, 'intake_batch', request);
  const retained = required(readDirectPlanScope(db, 'cedar', image.id));
  assert.equal(retained.reader.childCount(retained.record, 'batches'), 1);
  assert.equal(retained.unitCount, 1);
  assert.equal(retained.unitAt(0)?.coverage?.kind, 'extracted');
  queue = await listIntakeReportQueueRead(db, root, 'cedar');
  assert.deepEqual(queue.activity.remainingUnits, { state: 'exact', value: 0 });
  complete(bridge);
});

const fictionalPixel = () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=',
    'base64',
  );

function linkedFreshImage(
  t: TestContext,
  bytes: Buffer = fictionalPixel(),
  onJournal?: (
    reason: string,
    state: { db: ReturnType<typeof openDatabase>; root: string; item: Intake },
  ) => void,
  filename = 'fictional-fresh-image.png',
  startImmediately = true,
) {
  fictionalModel(t);
  const journalReasons: string[] = [];
  let item: Intake | undefined;
  const f = fixture(t, {
    journalWriter(root, profileId, chat, reason) {
      journalReasons.push(reason);
      writeChat(root, profileId, chat, reason);
      if (item) onJournal?.(reason, { db: f.db, root, item });
    },
  });
  item = uploadIntake(f.db, f.root, 'cedar', {
    filename,
    newProviderName: 'Fictional vision office',
    bytes,
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional fresh image conversion' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  const start = () =>
    f.assistant.send('cedar', chat.id, {
      message: 'Read the supplied fictional image without accepting any record',
      context: { route: '/import', intakeId: item.id },
    });
  if (startImmediately) start();
  return { ...f, item, chat, journalReasons, start };
}

test('native image startup prepares the exact plan and preserves later visual batch and question turns', async (t) => {
  const f = linkedFreshImage(t);
  const bridge = await waitForConversionBridge(t, f, f.chat);
  let current = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  assert.ok(isIntakeSummary(current));
  assert.equal(current.collections.plans.total, 1);
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id);
  assert.ok('sourceIndex' in plan.plan);
  assert.equal(plan.plan.sourceIndex.kind, 'image');
  assert.equal(plan.pins.sourceHash, current.sha256);
  assert.equal(plan.units.length, 1);
  const unit = required(plan.units[0]);
  assert.equal(unit.kind, 'image');
  assert.equal(unit.status, 'pending');
  assert.equal(f.chat.reading?.readWindows, 0, 'startup does not count a visual inspection');
  const operationId = 'assistant-plan:' + f.chat.id;
  assert.equal(
    selectedFixtureValue<Array<{ id: string }>>(f.db, f.item.id, [
      'intake',
      'workflow',
      'operations',
    ]).filter((item) => item.id === operationId).length,
    1,
  );
  const read = await call(bridge, 'intake_read', { id: f.item.id });
  assert.match(read.imageContent, /^data:image\/png;base64,/);
  assert.equal(f.chat.reading?.distinctReads, 1);
  assert.equal(
    selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units[0]?.status,
    'pending',
    'a visual read alone does not create durable extraction coverage',
  );

  const sourceTextRevisionId = (
    await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: current.id })
  ).revisionId;
  const saved = await call(bridge, 'intake_batch', {
    sourceTextRevisionId,
    id: current.id,
    version: getIntakeRead(f.db, f.root, 'cedar', current.id).version,
    planId: plan.id,
    operationId: 'fictional-image-bootstrap-batch',
    summary: 'One fictional image result is ready for explicit review.',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-image-bootstrap-result',
      kind: 'record',
      payload: { literal: 'Fictional acuity 20/40' },
      provenance: {
        capturedVia: 'Fictional image',
        sourceSystem: null,
        sourceRecordId: 'fictional-image-bootstrap-result',
        evidenceClass: 'transcription',
        locator: 'whole image',
      },
      coverage: { status: 'complete_response', notes: [] },
      clinical: {
        kind: 'observation',
        subject: 'unknown',
        testLabel: 'Fictional visual acuity',
        valueText: '20/40',
        date: null,
      },
    }),
    coverage: [
      {
        unitId: unit.id,
        kind: 'extracted',
        notes: 'The exact whole-image occurrence was inspected and retained for review.',
      },
    ],
  });
  assert.equal(saved.format, 'health-intake-summary-v2');
  assert.equal(f.chat.reading?.remainingUnits, 0);
  assert.equal(selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units[0]?.status, 'completed');
  current = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  const candidate = required(
    selectedFixtureValue<Array<{ id: string }>>(f.db, f.item.id, [
      'intake',
      'workflow',
      'candidates',
    ])[0],
  );
  const asked = await call<IntakeRead>(bridge, 'intake_question', {
    id: current.id,
    version: current.version,
    key: 'fictional-image-subject-review',
    candidateId: candidate.id,
    prompt: 'Does this fictional result belong to the displayed Self?',
    locator: 'whole image',
    field: 'subject',
  });
  assert.ok(isIntakeSummary(asked));
  assert.equal(asked.collections.questions.total, 1);
  assert.equal(
    f.chat.status,
    'running',
    'zero remaining units never skips a later useful question',
  );
  assert.deepEqual(
    f.chat.operations.map(({ tool }) => tool),
    [
      'health_intake_read',
      'health_intake_source_text',
      'health_intake_batch',
      'health_intake_question',
    ],
  );
  await complete(bridge);
  assert.equal(f.chat.status, 'idle');

  exportCuration(f.db, f.root, 'cedar');
  const destination = resolve(f.root, 'rebuilt-image-bootstrap');
  rebuildProfile(f.root, 'cedar', destination);
  const rebuilt = openDatabase(profilePaths(destination, 'cedar').database, 'cedar');
  attachPersonalDurability(rebuilt, { root: destination, profileId: 'cedar' });
  try {
    const recoveredPlan = selectedFixturePlan(rebuilt, destination, 'cedar', f.item.id);
    assert.deepEqual(recoveredPlan.pins, plan.pins);
    assert.equal(recoveredPlan.id, plan.id);
    assert.equal(
      selectedFixtureValue<Array<{ id: string }>>(rebuilt, f.item.id, [
        'intake',
        'workflow',
        'operations',
      ]).filter((item) => item.id === operationId).length,
      1,
    );
  } finally {
    rebuilt.close();
  }
});

test('failed native image decoding leaves one durable pending plan and repeated reads never duplicate it', async (t) => {
  const corrupt = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('independently fictional corrupt image bytes'),
  ]);
  const f = linkedFreshImage(t, corrupt);
  const bridge = await waitForConversionBridge(t, f, f.chat);
  await assert.rejects(call(bridge, 'intake_read', { id: f.item.id }));
  const after = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  assert.ok(isIntakeSummary(after));
  assert.equal(after.collections.plans.total, 1);
  assert.equal(after.collections.proposals.total, 0);
  assert.equal(selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units[0]?.status, 'pending');
  assert.equal(f.chat.reading?.readWindows, 0);
  const retry = linkedFreshImage(t);
  const retryBridge = await waitForConversionBridge(t, retry, retry.chat);
  const plan = selectedFixturePlan(retry.db, retry.root, 'cedar', retry.item.id);
  const first = await call(retryBridge, 'intake_read', { id: retry.item.id });
  assert.match(first.imageContent, /^data:image\/png;base64,/);
  const version = getIntakeRead(retry.db, retry.root, 'cedar', retry.item.id).version;
  const second = await call(retryBridge, 'intake_read', { id: retry.item.id });
  assert.match(second.imageContent, /^data:image\/png;base64,/);
  const retried = getIntakeRead(retry.db, retry.root, 'cedar', retry.item.id);
  assert.ok(isIntakeSummary(retried));
  assert.equal(retried.version, version);
  assert.equal(retried.collections.plans.total, 1);
  assert.equal(selectedFixturePlan(retry.db, retry.root, 'cedar', retry.item.id).id, plan.id);
  assert.equal(
    selectedFixtureValue<Array<{ id: string }>>(retry.db, retry.item.id, [
      'intake',
      'workflow',
      'operations',
    ]).filter((item) => item.id === 'assistant-plan:' + retry.chat.id).length,
    1,
  );
  await complete(retryBridge);
});

test('concurrent native image reads share one exact host plan and source capture', async (t) => {
  const f = linkedFreshImage(t);
  const bridge = await waitForConversionBridge(t, f, f.chat);
  const before = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id);
  const [first, second] = await Promise.all([
    call(bridge, 'intake_read', { id: f.item.id }),
    call(bridge, 'intake_read', { id: f.item.id }),
  ]);
  assert.match(first.imageContent, /^data:image\/png;base64,/);
  assert.match(second.imageContent, /^data:image\/png;base64,/);
  const reading = selectedResume(f.db, f.root, 'cedar', f.item.id, f.chat).reading;
  assert.equal(reading.readWindows, 1);
  assert.equal(reading.distinctReads, 1, 'both successful calls retain one exact unique window');
  const current = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  assert.ok(isIntakeSummary(current));
  assert.equal(
    current.version,
    before.version + 2,
    'one extraction and its material source pin; the plan already existed before dispatch',
  );
  assert.equal(current.collections.plans.total, 1);
  assert.equal(current.collections.proposals.total, 0);
  const after = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id);
  assert.equal(after.id, plan.id);
  assert.deepEqual(after.pins, plan.pins);
  assert.equal(after.units[0]?.status, 'pending');
  assert.equal(
    selectedFixtureValue<Array<{ id: string }>>(f.db, f.item.id, [
      'intake',
      'workflow',
      'operations',
    ]).filter((item) => item.id === 'assistant-plan:' + f.chat.id).length,
    1,
  );
  assert.equal(selectedFixtureValue(f.db, f.item.id, ['intake', 'acceptedProposalId']), null);
  assert.equal(selectedFixtureValue(f.db, f.item.id, ['intake', 'imported']), null);
  await complete(bridge);
});

test('automatic source capture shares publication while retaining each reader cancellation', async (t) => {
  const { captureIntakeSourceTextForRead } = await import('../intake-evidence.ts');
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-shared-capture.txt',
    bytes: Buffer.from('One fictional source shared by two independent readers.'),
  });
  let cancelled = false;
  let cancelledCallbacks = 0;
  const transitions: unknown[] = [];
  const context = { db: f.db, root: f.root, profileId: 'cedar', id: item.id, modelContext: true };
  const first = captureIntakeSourceTextForRead({
    ...context,
    assertRunning() {
      if (cancelled) throw Error('Fictional first reader cancelled');
    },
    onSourceTextCaptured() {
      cancelledCallbacks++;
    },
  });
  const second = captureIntakeSourceTextForRead({
    ...context,
    onSourceTextCaptured(transition) {
      transitions.push(transition);
    },
  });
  cancelled = true;
  await assert.rejects(first, /first reader cancelled/);
  await second;
  assert.equal(cancelledCallbacks, 0);
  assert.equal(transitions.length, 1);
  const current = getIntake(f.db, f.root, 'cedar', item.id);
  await captureIntakeSourceTextForRead({
    ...context,
    onSourceTextCaptured(transition) {
      transitions.push(transition);
    },
  });
  assert.equal(transitions.length, 1, 'completed capture leaves no repeated publication');
  assert.equal(getIntakeRead(f.db, f.root, 'cedar', item.id).version, current.version);

  const retry = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-cancelled-capture.txt',
    bytes: Buffer.from('A cancelled capture can be attempted by a new reader.'),
  });
  let retryCancelled = false;
  const abandoned = captureIntakeSourceTextForRead({
    ...context,
    id: retry.id,
    assertRunning() {
      if (retryCancelled) throw Error('Fictional all readers cancelled');
    },
  });
  retryCancelled = true;
  await assert.rejects(abandoned, /all readers cancelled/);
  await captureIntakeSourceTextForRead({ ...context, id: retry.id });
  assert.ok(getIntakeRead(f.db, f.root, 'cedar', retry.id).version > retry.version);
});

test('native image plan replay requires the exact host create-plan request fingerprint', async (t) => {
  const f = linkedFreshImage(t);
  await waitForConversionBridge(t, f, f.chat);
  const { createPagedDirectPlan } = await import('../intake-direct-plan.ts');
  const current = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id);
  const operationId = 'assistant-plan:' + f.chat.id;
  const replay = await createPagedDirectPlan(f.db, f.root, 'cedar', f.item.id, {
    version: current.version,
    operationId,
  });
  assert.equal(replay.replayed, true);
  assert.ok('plan' in replay);
  assert.equal(replay.plan.id, plan.id);
  const before = selectedFixtureHash(f.db, f.item.id, ['intake', 'workflow']);
  await assert.rejects(
    createPagedDirectPlan(f.db, f.root, 'cedar', f.item.id, {
      version: current.version,
      operationId,
      unitSize: 1,
    }),
    { code: 'OPERATION_CONFLICT' },
  );
  assert.equal(selectedFixtureHash(f.db, f.item.id, ['intake', 'workflow']), before);
  f.assistant.cancel('cedar', f.chat.id);
});

test('native image preparation rejects stale versions, changed source and cancelled visual reads', async (t) => {
  const { updateIntakeMetadataRead, createIntakePlanRead } = await import('../intake.ts');
  const changed = linkedFreshImage(t);
  const changedBridge = await waitForConversionBridge(t, changed, changed.chat);
  const before = getIntakeRead(changed.db, changed.root, 'cedar', changed.item.id);
  const beforePlans = selectedFixtureHash(changed.db, changed.item.id, [
    'intake',
    'workflow',
    'plans',
  ]);
  await updateIntakeMetadataRead(changed.db, changed.root, 'cedar', changed.item.id, {
    version: before.version,
    operationId: 'fictional-concurrent-metadata',
    metadata: { careArea: 'Fictional vision' },
  });
  await assert.rejects(
    call(changedBridge, 'intake_plan', {
      id: changed.item.id,
      action: 'create',
      version: before.version,
      operationId: 'fictional-stale-plan',
    }),
    { code: 'VERSION_CONFLICT' },
  );
  assert.equal(
    selectedFixtureHash(changed.db, changed.item.id, ['intake', 'workflow', 'plans']),
    beforePlans,
  );
  assert.equal(
    selectedFixtureValue<{ careArea: string }>(changed.db, changed.item.id, ['intake', 'metadata'])
      .careArea,
    'Fictional vision',
  );

  const concurrent = linkedFreshImage(t);
  await waitForConversionBridge(t, concurrent, concurrent.chat);
  const selected = getIntakeRead(concurrent.db, concurrent.root, 'cedar', concurrent.item.id);
  const workflow = selectedFixtureHash(concurrent.db, concurrent.item.id, ['intake', 'workflow']);
  let changedDuringPreparation = false;
  try {
    await assert.rejects(
      createIntakePlanRead(concurrent.db, concurrent.root, 'cedar', concurrent.item.id, {
        version: selected.version,
        operationId: 'fictional-source-race-plan',
        assertRunning() {
          if (changedDuringPreparation) return;
          changedDuringPreparation = true;
          concurrent.db
            .prepare('UPDATE source_files SET sha256=? WHERE id=?')
            .run('fictional-changed-source', concurrent.item.id);
        },
      }),
    );
  } finally {
    concurrent.db
      .prepare('UPDATE source_files SET sha256=? WHERE id=?')
      .run(selected.sha256, concurrent.item.id);
  }
  assert.equal(changedDuringPreparation, true);
  assert.equal(
    selectedFixtureHash(concurrent.db, concurrent.item.id, ['intake', 'workflow']),
    workflow,
  );
  assert.equal(concurrent.chat.reading?.readWindows, 0);
  concurrent.assistant.cancel('cedar', concurrent.chat.id);

  for (const closeProfile of [false, true]) {
    const cancelled = linkedFreshImage(t);
    const bridge = await waitForConversionBridge(t, cancelled, cancelled.chat);
    const plans = selectedFixtureHash(cancelled.db, cancelled.item.id, [
      'intake',
      'workflow',
      'plans',
    ]);
    const pending = call(bridge, 'intake_read', { id: cancelled.item.id });
    if (closeProfile) cancelled.assistant.close();
    else cancelled.assistant.cancel('cedar', cancelled.chat.id);
    await assert.rejects(pending, /no longer running|stopped|cancelled/i);
    assert.equal(
      selectedFixtureHash(cancelled.db, cancelled.item.id, ['intake', 'workflow', 'plans']),
      plans,
    );
    assert.equal(
      selectedFixturePlan(cancelled.db, cancelled.root, 'cedar', cancelled.item.id).units[0]
        ?.status,
      'pending',
    );
    assert.equal(cancelled.chat.reading?.readWindows, 0);
  }
});

test('native image startup preserves existing plan history and direct child reads never create a child plan', async (t) => {
  const active = linkedFreshImage(t, fictionalPixel(), undefined, 'fictional-active.png', false);
  const created = await createIntakePlan(active.db, active.root, 'cedar', active.item.id, {
    version: getIntakeRead(active.db, active.root, 'cedar', active.item.id).version,
  });
  active.start();
  const activeBridge = await waitForConversionBridge(t, active, active.chat);
  const activePlans = selectedFixtureHash(active.db, active.item.id, [
    'intake',
    'workflow',
    'plans',
  ]);
  const activeRead = await call(activeBridge, 'intake_read', { id: active.item.id });
  assert.match(activeRead.imageContent, /^data:image\/png;base64,/);
  assert.equal(
    selectedFixtureHash(active.db, active.item.id, ['intake', 'workflow', 'plans']),
    activePlans,
  );
  assert.deepEqual(
    selectedFixtureValue(active.db, active.item.id, ['intake', 'workflow', 'plans']),
    created.workflow?.plans,
  );
  active.assistant.cancel('cedar', active.chat.id);

  const superseded = linkedFreshImage(
    t,
    fictionalPixel(),
    undefined,
    'fictional-historical.png',
    false,
  );
  const modelBefore = process.env.CRS_AI_MODEL;
  process.env.CRS_AI_MODEL = 'fictional-prior-image-model';
  try {
    await createIntakePlan(superseded.db, superseded.root, 'cedar', superseded.item.id, {
      version: getIntakeRead(superseded.db, superseded.root, 'cedar', superseded.item.id).version,
    });
  } finally {
    if (modelBefore === undefined) delete process.env.CRS_AI_MODEL;
    else process.env.CRS_AI_MODEL = modelBefore;
  }
  const details = JSON.parse(readIntakeEnvelopeText(superseded.db, { id: superseded.item.id })!);
  details.intake.workflow.plans[0].status = 'superseded';
  const history = structuredClone(details.intake.workflow.plans[0]);
  writeIntakeFixtureEnvelope(superseded.db, superseded.item.id, details);
  superseded.start();
  const supersededBridge = await waitForConversionBridge(t, superseded, superseded.chat);
  await call(supersededBridge, 'intake_read', { id: superseded.item.id });
  const retained = selectedFixtureValue<IntakeWorkflow['plans']>(
    superseded.db,
    superseded.item.id,
    ['intake', 'workflow', 'plans'],
  );
  assert.equal(retained.length, 2, 'startup adds a current plan while retaining prior history');
  assert.deepEqual(
    retained.find((plan) => plan.id === history.id),
    history,
  );
  superseded.assistant.cancel('cedar', superseded.chat.id);

  const parent = linkedFreshImage(
    t,
    Buffer.from('Fictional retained parent text. '.repeat(700)),
    undefined,
    'fictional-parent.txt',
    false,
  );
  const child = retainIntakeChildren(parent.db, parent.root, 'cedar', parent.item.id, [
    {
      filename: 'fictional-child.png',
      locator: 'fictional retained child image',
      bytes: fictionalPixel(),
      derivative: false,
    },
  ])[0]!;
  parent.start();
  const parentBridge = await waitForConversionBridge(t, parent, parent.chat);
  const parentPlans = selectedFixtureHash(parent.db, parent.item.id, [
    'intake',
    'workflow',
    'plans',
  ]);
  const beforeChild = intakeSourceVersion(parent.db, parent.item.id);
  const childRead = await call(parentBridge, 'intake_read', { id: child.id });
  assert.match(childRead.imageContent, /^data:image\/png;base64,/);
  const afterChild = intakeSourceVersion(parent.db, parent.item.id);
  assert.equal(afterChild.rawVersion, beforeChild.rawVersion);
  assert.equal(afterChild.logicalBinding, beforeChild.logicalBinding);
  assert.ok(
    afterChild.version > beforeChild.version,
    'only the separate material source pin advances',
  );
  const parentPlan = selectedFixturePlan(parent.db, parent.root, 'cedar', parent.item.id);
  assert.ok(parentPlan.units.length > 1);
  await readFixtureTextUnit(parentBridge, parent.item.id, parentPlan.units[1]!.id);
  assert.equal(parent.chat.conversionCheckpoint?.activeUnitId, parentPlan.units[1]!.id);
  const repeatedChild = await call(parentBridge, 'intake_read', { id: child.id });
  assert.match(repeatedChild.imageContent, /^data:image\/png;base64,/);
  assert.equal(
    parent.chat.conversionCheckpoint?.activeUnitId,
    parentPlan.units[0]!.id,
    'manual child acknowledgment reuses its exact retained parent-unit route',
  );
  const childState = getIntakeRead(parent.db, parent.root, 'cedar', child.id);
  assert.equal(
    isIntakeSummary(childState)
      ? childState.collections.plans.total
      : childState.workflow?.plans.length,
    0,
  );
  assert.equal(
    selectedFixtureHash(parent.db, parent.item.id, ['intake', 'workflow', 'plans']),
    parentPlans,
  );
  parent.assistant.cancel('cedar', parent.chat.id);

  const mixed = linkedFreshImage(t);
  const sibling = uploadIntake(mixed.db, mixed.root, 'cedar', {
    filename: 'fictional-unselected-image.png',
    bytes: fictionalPixel(),
  });
  const mixedBridge = await waitForConversionBridge(t, mixed, mixed.chat);
  const mixedPlans = selectedFixtureHash(mixed.db, mixed.item.id, ['intake', 'workflow', 'plans']);
  await assert.rejects(call(mixedBridge, 'intake_read', { id: sibling.id }), {
    code: 'CONVERSION_SCOPE',
  });
  const siblingState = getIntakeRead(mixed.db, mixed.root, 'cedar', sibling.id);
  assert.equal(
    isIntakeSummary(siblingState)
      ? siblingState.collections.plans.total
      : siblingState.workflow?.plans.length,
    0,
  );
  assert.equal(
    selectedFixtureHash(mixed.db, mixed.item.id, ['intake', 'workflow', 'plans']),
    mixedPlans,
  );
});

test('native startup gives PDF, ZIP and text their own ordinary plan kinds', async (t) => {
  for (const [filename, bytes, kind] of [
    ['fictional.txt', Buffer.from('Fictional retained text evidence'), 'text'],
    ['fictional.pdf', syntheticPdf(['Fictional retained PDF evidence']), 'pdf'],
    [
      'fictional.zip',
      zipFixture([{ name: 'fictional.txt', data: 'Fictional retained package evidence' }]),
      'package',
    ],
  ] as const) {
    const delivery = linkedFreshImage(t, bytes, undefined, filename);
    const bridge = await waitForConversionBridge(t, delivery, delivery.chat);
    assert.equal(bridge.prompt.conversion.freshTopLevelImageBootstrap, undefined);
    const current = getIntakeRead(delivery.db, delivery.root, 'cedar', delivery.item.id);
    assert.ok(isIntakeSummary(current));
    assert.equal(current.collections.plans.total, 1);
    const plan = selectedFixturePlan(delivery.db, delivery.root, 'cedar', delivery.item.id);
    assert.ok(plan.units.length > 0);
    assert.ok(plan.units.every((unit) => unit.kind !== 'image'));
    if (kind === 'package') assert.ok('inventory' in plan.plan);
    else {
      assert.ok('sourceIndex' in plan.plan);
      assert.equal(plan.plan.sourceIndex.kind, kind);
    }
    assert.equal(delivery.chat.reading?.readWindows, 0);
    delivery.assistant.cancel('cedar', delivery.chat.id);
  }
});

test('atomic assistant receipts prevent reapplying a note after a lost journal response and later user edits', async (t) => {
  let fail = false;
  const { assistant, bridges, db, root, databases, options } = fixture(t, {
    journalWriter(root, profileId, chat, reason) {
      if (fail && reason.startsWith('proposal-')) throw new Error('Lost action journal write');
      writeChat(root, profileId, chat, reason);
    },
  });
  const chat = assistant.create('cedar', { message: 'Make an editable preparation note' });
  await tick();
  const proposal = await call(bridges[0], 'propose_note', {
    title: 'Preparation',
    content: 'Initial suggestions',
    reason: 'Requested note',
  });
  complete(bridges[0]);
  fail = true;
  assert.throws(() => assistant.apply('cedar', chat.id, proposal.id), /Lost action journal write/);
  let note = getNote(db, proposal.noteId);
  const receiptKey = `personal_assistant_${proposal.id}`;
  const receipt = JSON.parse(
    sqlText(db.prepare('SELECT value FROM app_meta WHERE key=?').get(receiptKey), 'value'),
  );
  assert.deepEqual(
    { ...receipt, appliedAt: undefined },
    {
      profileId: 'cedar',
      proposalId: proposal.id,
      noteId: note.id,
      kind: 'note',
      version: note.version,
      appliedAt: undefined,
    },
  );
  const updatedNote = saveNote(db, note.id, {
    version: note.version,
    content: 'User additions after the response was lost',
  });
  fail = false;
  const restarted = createAssistant({ root, databases, ...options });
  t.after(() => restarted.close());
  const recovered = restarted.get('cedar', chat.id);
  assert.equal(recovered.proposals[0].status, 'applied');
  restarted.apply('cedar', chat.id, proposal.id);
  assert.equal(getNote(db, updatedNote.id).version, updatedNote.version);
  assert.equal(getNote(db, updatedNote.id).content, 'User additions after the response was lost');
  assert.equal(
    sqlNumber(
      db.prepare('SELECT COUNT(*) AS count FROM notes WHERE id=?').get(updatedNote.id),
      'count',
    ),
    1,
  );
  exportCuration(db, root, 'cedar');
  const destination = resolve(root, 'rebuilt-receipt');
  rebuildProfile(root, 'cedar', destination);
  const rebuilt = openDatabase(profilePaths(destination, 'cedar').database, 'cedar');
  attachPersonalDurability(rebuilt, { root: destination, profileId: 'cedar' });
  try {
    assert.deepEqual(
      JSON.parse(
        sqlText(rebuilt.prepare('SELECT value FROM app_meta WHERE key=?').get(receiptKey), 'value'),
      ),
      receipt,
    );
  } finally {
    rebuilt.close();
  }
});

test('a newer action journal cannot claim a note was applied to older restored profile data', async (t) => {
  const { assistant, bridges, root, databases, db, options } = fixture(t);
  const chat = assistant.create('cedar', { message: 'Create a note after a backup point' });
  await tick();
  const proposal = await call(bridges[0], 'propose_note', {
    title: 'Later note',
    content: 'Review before applying',
    reason: 'Requested note',
  });
  complete(bridges[0]);
  // Simulate a chat journal captured later than its SQLite backup snapshot.
  const saved = structuredClone(readTestChat(root, 'cedar', chat.id));
  saved.proposals[0].status = 'applied';
  writeChat(root, 'cedar', saved, 'simulated-newer-action-journal');
  const restarted = createAssistant({ root, databases, ...options });
  t.after(() => restarted.close());
  const recovered = restarted.get('cedar', chat.id);
  assert.equal(recovered.proposals[0].status, 'pending');
  assert.match(required(recovered.proposals[0].error), /absent from the restored profile data/);
  assert.equal(
    sqlNumber(
      db.prepare('SELECT COUNT(*) AS count FROM notes WHERE id=?').get(proposal.noteId),
      'count',
    ),
    0,
  );
  restarted.apply('cedar', chat.id, proposal.id);
  assert.equal(getNote(db, proposal.noteId).content, 'Review before applying');
});

test('classification changes retain raw evidence and retry publication without repeating the change', async (t) => {
  const { assistant, bridges, root, db } = fixture(t);
  const bytes = Buffer.from('Synthetic original laboratory service record');
  const intake = uploadIntake(db, root, 'cedar', {
    filename: 'laboratory.txt',
    newProviderName: 'Synthetic clinic',
    bytes,
  });
  const raw = '{"service":"Original laboratory service","unchanged":1.000}';
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_records(id,source_file_id,provider_id,raw_json) VALUES(?,?,?,?)',
    ).run('raw-lab', intake.id, intake.providerId, raw);
    db.prepare(
      'INSERT INTO procedures(id,source_record_id,provider_id,label,category,extra_json) VALUES(?,?,?,?,?,?)',
    ).run(
      'procedure-lab',
      'raw-lab',
      intake.providerId,
      'Original laboratory service',
      'unspecified',
      '{"originalAdditionalField":"retained"}',
    );
  });
  exportCuration(db, root, 'cedar');
  const chat = assistant.create('cedar', {
    message: 'This service should be a laboratory category',
  });
  await tick();
  const assistantRecord = await call(bridges[0], 'read', {
    collection: 'records',
    id: 'raw-lab',
  });
  assert.equal(assistantRecord.rawText, raw);
  assert.equal(assistantRecord.fileView, 'reference');
  assert.equal((assistantRecord.file as Record<string, unknown>).detailsIncluded, false);
  assert.equal(Object.hasOwn(assistantRecord.file as object, 'details'), false);
  await assert.rejects(
    () =>
      call(bridges[0], 'propose_classification', {
        procedureId: 'procedure-lab',
        category: 'laboratory',
        sourceRecordId: 'foreign-source',
        reason: 'Wrong evidence',
      }),
    /source does not match/,
  );
  const proposal = await call(bridges[0], 'propose_classification', {
    procedureId: 'procedure-lab',
    category: 'laboratory',
    sourceRecordId: 'raw-lab',
    reason: 'User reviewed the laboratory service',
  });
  complete(bridges[0]);
  const original = getIntakeOriginal(db, root, 'cedar', intake.id);
  writeFileSync(original.path, 'Simulated damaged original');
  assert.throws(() => assistant.apply('cedar', chat.id, proposal.id), { code: 'SOURCE_CHANGED' });
  assert.equal(proposal.status, 'failed');
  assert.equal(
    sqlText(
      db.prepare('SELECT raw_json FROM source_records WHERE id=?').get('raw-lab'),
      'raw_json',
    ),
    raw,
  );
  let procedure = required(db.prepare('SELECT * FROM procedures WHERE id=?').get('procedure-lab'));
  assert.equal(
    procedure.category,
    'unspecified',
    'A curation edit cannot commit without durable validated evidence',
  );
  assert.equal(JSON.parse(sqlText(procedure, 'extra_json')).classificationHistory, undefined);
  writeFileSync(original.path, bytes);
  assistant.apply('cedar', chat.id, proposal.id);
  assert.equal(proposal.status, 'applied');
  procedure = required(db.prepare('SELECT * FROM procedures WHERE id=?').get('procedure-lab'));
  assert.equal(JSON.parse(sqlText(procedure, 'extra_json')).classificationHistory.length, 1);
  assert.equal(JSON.parse(sqlText(procedure, 'extra_json')).originalAdditionalField, 'retained');
  assert.equal(
    sqlNumber(
      db
        .prepare('SELECT COUNT(*) AS count FROM manual_batches WHERE id=?')
        .get(`assistant-classification:${proposal.id}`),
      'count',
    ),
    1,
  );
  const destination = resolve(root, 'rebuilt-classification');
  rebuildProfile(root, 'cedar', destination);
  const rebuilt = openDatabase(profilePaths(destination, 'cedar').database, 'cedar');
  attachPersonalDurability(rebuilt, { root: destination, profileId: 'cedar' });
  try {
    assert.equal(
      sqlText(
        rebuilt.prepare('SELECT category FROM procedures WHERE id=?').get('procedure-lab'),
        'category',
      ),
      'laboratory',
    );
    assert.equal(
      sqlText(
        rebuilt.prepare('SELECT raw_json FROM source_records WHERE id=?').get('raw-lab'),
        'raw_json',
      ),
      raw,
    );
    assert.deepEqual(getIntakeOriginal(rebuilt, destination, 'cedar', intake.id).bytes, bytes);
  } finally {
    rebuilt.close();
  }
});

test('current page resolves automatic selections in this profile and refreshes on each question', async (t) => {
  const { assistant, db, databases, bridges } = fixture(t);
  const id = 'note:11111111-3333-4333-8333-777777777777';
  createNote(db, { id, title: 'Original profile title', content: 'Must not cross profiles' });
  const target = createNote(required(databases.get('cookie-dough')), {
    id,
    title: 'Synthetic selected entry',
    content: 'Saved content in the selected profile',
  });
  const chat = assistant.create('cookie-dough', {
    message: 'Is this recorded?',
    context: {
      route: '/notes',
      selection: { collection: 'notes', id },
      content: 'Untrusted client body',
      profileId: 'cedar',
    },
  });
  await tick();
  assert.equal(bridges[0].prompt.page.selected.record.title, target.title);
  assert.equal(bridges[0].prompt.page.selected.record.content, target.content);
  assert.equal(JSON.stringify(bridges[0].prompt).includes('Must not cross profiles'), false);
  assert.equal(JSON.stringify(bridges[0].prompt).includes('Untrusted client body'), false);
  assert.deepEqual(bridges[0].prompt.messages[0].context.selection, { collection: 'notes', id });
  assert.match(
    required(bridges[0].instructions),
    /Default to questions about THIS PERSON'S SAVED DATA/,
  );
  complete(bridges[0]);
  const person = createNote(required(databases.get('cookie-dough')), {
    kind: 'person',
    title: 'Synthetic contact',
    person: { tags: ['Professional'] },
  });
  assistant.create('cookie-dough', {
    message: 'How about this one?',
    context: {
      route: `/people?id=${encodeURIComponent(person.id)}&tag=Professional`,
      selection: { collection: 'people', id: person.id },
    },
  });
  await tick();
  assert.equal(bridges[1].prompt.page.selected.record.id, person.id);
  assert.equal(bridges[1].prompt.page.filters.tag, 'Professional');
  assert.equal(bridges[0].prompt.messages[0].context.selection.id, id);
  assert.equal(
    assistant.get('cookie-dough', chat.id).messages.filter((m) => m.role === 'user').length,
    1,
  );
  assert.equal(
    bridges[1].prompt.messages.length,
    1,
    'A different person starts a separate conversation',
  );
  assert.equal(required(bridges[1].prompt.messages.at(-1)).context.selection.id, person.id);
  complete(bridges[1]);
});

test('page context reports missing entries and validates selection without reading outside profile', async (t) => {
  const { assistant, bridges, db } = fixture(t);
  const note = createNote(db, { title: 'Explicit target', content: 'Saved' });
  const chat = assistant.create('cedar', {
    message: 'This record?',
    context: {
      route: `/notes?id=${encodeURIComponent(note.id)}`,
      selection: { collection: 'notes', id: 'stale-id' },
    },
  });
  await tick();
  assert.equal(bridges[0].prompt.page.selected.record.id, note.id);
  complete(bridges[0]);
  assistant.send('cedar', chat.id, {
    message: 'This draft?',
    context: { route: '/notes?id=not-yet-saved&new=1' },
  });
  await tick();
  assert.equal(bridges[1].prompt.page.selected.status, 'not_found');
  assert.match(bridges[1].prompt.page.contentScope, /unsaved editor text/);
  complete(bridges[1]);
  assert.throws(
    () =>
      assistant.send('cedar', chat.id, {
        message: 'Invalid',
        context: { route: '/', selection: { collection: 'sqlite_master', id: 'x' } },
      }),
    /Invalid selected record/,
  );
  assert.equal(chat.messages.filter((m) => m.role === 'user').length, 2);
});

test('measurement context resolves the selected type, comparison types and current date filters', async (t) => {
  const { assistant, bridges, db } = fixture(t);
  db.prepare('INSERT INTO test_types(id,label,category,unit) VALUES(?,?,?,?)').run(
    'synthetic:bmi',
    'Body mass index',
    'Vitals',
    'kg/m2',
  );
  db.prepare('INSERT INTO test_types(id,label,category,unit) VALUES(?,?,?,?)').run(
    'synthetic:weight',
    'Body weight',
    'Vitals',
    'kg',
  );
  assistant.create('cedar', {
    message: 'Is BMI recorded or calculated?',
    context: {
      route: '/tests?view=by-test&q=BMI&from=2025-01-01&compare=synthetic%3Aweight',
      selection: { collection: 'test_types', id: 'synthetic:bmi' },
    },
  });
  await tick();
  const page = bridges[0].prompt.page;
  assert.equal(page.selected.record.label, 'Body mass index');
  assert.equal(page.comparisons[0].record.label, 'Body weight');
  assert.equal(page.filters.from, '2025-01-01');
  assert.equal(page.selected.record.appUrl, '#/tests?view=by-test&type=synthetic%3Abmi&detail=1');
  assert.equal(
    (await call(bridges[0], 'read', { collection: 'test_types', id: 'synthetic:bmi' })).unit,
    'kg/m2',
  );
  complete(bridges[0]);
});

test('assistant cannot propose or apply role tags to Self but can update independent contacts', async (t) => {
  const { assistant, db, bridges } = fixture(t);
  const self = getNote(db, 'patient');
  const chat = assistant.create('cedar', { message: 'Update my profile' });
  await tick();
  for (const tags of [['Professional'], ['custom'], 'Family']) {
    await assert.rejects(
      () =>
        call(bridges[0], 'propose_note', {
          noteId: self.id,
          version: self.version,
          title: self.title,
          person: { tags },
          reason: 'Attempted role assignment',
        }),
      /Self cannot have/,
    );
  }
  assert.equal(chat.proposals.length, 0);
  const proposal = await call(bridges[0], 'propose_note', {
    noteId: self.id,
    version: self.version,
    title: self.title,
    person: { phone: '555-0100' },
    reason: 'Update personal contact',
  });
  complete(bridges[0]);
  // A pending proposal created by an older app version still goes through
  // the ordinary policy when the user applies it.
  proposal.changes.person.tags = ['Family'];
  assert.throws(() => assistant.apply('cedar', chat.id, proposal.id), /Self cannot have/);
  assert.equal(getNote(db, 'patient').version, self.version);
  delete proposal.changes.person.tags;
  assistant.apply('cedar', chat.id, proposal.id);
  assert.equal(getNote(db, 'patient').person.phone, '555-0100');
  assert.equal(getNote(db, 'patient').person.tags, undefined);
});

test('first-turn context supplies canonical identity and local time once while actual usage is retained per attempt', async (t) => {
  const at = new Date('2026-09-11T17:15:00.000Z');
  const { assistant, bridges } = fixture(t, {
    clock: () => at,
    timeZone: () => 'America/Los_Angeles',
  });
  const chat = assistant.create('cookie-dough', { message: 'Hello there' });
  await tick();
  assert.equal(bridges[0].prompt.identity.name, 'Cookie Dough');
  assert.equal(bridges[0].prompt.identity.displayName, 'Cookie Dough');
  assert.deepEqual(bridges[0].prompt.localTime, {
    available: true,
    instant: at.toISOString(),
    timeZone: 'America/Los_Angeles',
    localDate: '2026-09-11',
    localHour: 10,
    greetingPeriod: 'morning',
  });
  assert.equal(bridges[0].prompt.conversation.firstAssistantResponse, true);
  bridges[0].callbacks.onEvent('thread/tokenUsage/updated', {
    threadId: 'thread',
    turnId: 'turn-1',
    tokenUsage: {
      total: {
        totalTokens: 125,
        inputTokens: 80,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 30,
        reasoningOutputTokens: 15,
      },
      last: {},
      modelContextWindow: 200000,
    },
  });
  assistant.cancel('cookie-dough', chat.id);
  const runs = required(chat.runs);
  assert.equal(required(required(runs[0]).usage).inputTokens, 80);
  assistant.retry('cookie-dough', chat.id);
  await tick();
  assert.equal(
    bridges[1].prompt.conversation.firstAssistantResponse,
    false,
    'a retry must not repeat the opening greeting',
  );
  complete(bridges[1]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, 'cancelled');
  assert.equal(required(runs[0].usage).source, 'thread/tokenUsage/updated');
  assert.equal(
    runs[1].usage,
    null,
    'missing protocol usage stays unavailable rather than estimated',
  );
});

test('greeting context follows a renamed Self and falls back cleanly when local time is unavailable', async (t) => {
  const { assistant, bridges, db } = fixture(t, {
    timeZone() {
      throw new Error('No reliable zone');
    },
  });
  const self = getNote(db, 'patient');
  saveNote(db, self.id, {
    version: self.version,
    title: 'Starlight',
    person: { ...self.person, name: 'Starlight' },
  });
  const chat = assistant.create('cedar', { message: 'Use my current profile name' });
  await tick();
  assert.equal(bridges[0].prompt.identity.name, 'Starlight');
  assert.equal(bridges[0].prompt.identity.displayName, 'Starlight');
  assert.deepEqual(bridges[0].prompt.localTime, { available: false });
  assert.equal(bridges[0].prompt.conversation.firstAssistantResponse, true);
  complete(bridges[0]);
  assert.match(required(bridges[0].instructions), /simple “Hi, \[display name\]\.?” greeting/);
  assert.equal(chat.status, 'idle');
});

test('attachment associations remain pending until explicit apply and are versioned and idempotent', async (t) => {
  const { assistant, bridges, db, root } = fixture(t);
  const note = createNote(db, { title: 'Photo note', content: 'Synthetic note' });
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=',
    'base64',
  );
  const asset = uploadAsset(db, root, 'cedar', bytes, 'synthetic.png', 'image/png');
  const chat = assistant.create('cedar', { message: 'Attach the selected image' });
  await tick();
  const found = await call(bridges[0], 'query', { collection: 'assets', q: 'synthetic' });
  assert.equal(found.data[0].id, asset.id);
  const proposal = await call(bridges[0], 'propose_attachment', {
    noteId: note.id,
    version: note.version,
    assetId: asset.id,
    caption: 'Fictional example',
    reason: 'User requested this association',
  });
  assert.equal(getNote(db, note.id).attachments.length, 0);
  let finished = createNote(db, {
    kind: 'historical',
    title: 'Finished entry',
    content: 'Immutable',
  });
  finished = finishNote(db, finished.id, {
    version: finished.version,
    title: finished.title,
    content: finished.content,
    links: [],
  });
  await assert.rejects(
    () =>
      call(bridges[0], 'propose_attachment', {
        noteId: finished.id,
        version: finished.version,
        assetId: asset.id,
        reason: 'Must stay immutable',
      }),
    /finished notes cannot receive attachments/,
  );
  complete(bridges[0]);
  assistant.apply('cedar', chat.id, proposal.id);
  const applied = getNote(db, note.id);
  assert.equal(applied.attachments[0].assetId, asset.id);
  assert.equal(applied.attachments[0].caption, 'Fictional example');
  const version = applied.version;
  proposal.status = 'pending';
  assistant.apply('cedar', chat.id, proposal.id);
  assert.equal(getNote(db, note.id).version, version);
  assert.equal(getNote(db, note.id).attachments.length, 1);
});

test('conversational field restoration uses verified history and changes only explicitly reviewed fields', async (t) => {
  const { assistant, bridges, db, root } = fixture(t);
  let note = createNote(db, {
    kind: 'historical',
    title: 'Visit preparation',
    content: 'Earlier content',
    topics: 'Keep this topic',
  });
  const older = required(noteHistory(db, root, 'cedar', note.id).entries[0]).generationId;
  note = saveNote(db, note.id, {
    version: note.version,
    content: 'Current content',
    topics: 'Current unrelated topic',
  });
  const chat = assistant.create('cedar', { message: 'Undo only the content change' });
  await tick();
  const history = await call(bridges[0], 'note_history', { noteId: note.id });
  assert.ok(history.entries.some((entry) => entry.generationId === older));
  let finished = createNote(db, {
    kind: 'historical',
    title: 'Finished history',
    content: 'Earlier',
  });
  const finishedGeneration = required(
    noteHistory(db, root, 'cedar', finished.id).entries[0],
  ).generationId;
  finished = saveNote(db, finished.id, { version: finished.version, content: 'Later' });
  finished = finishNote(db, finished.id, {
    version: finished.version,
    title: finished.title,
    content: finished.content,
    links: [],
  });
  await assert.rejects(
    () =>
      call(bridges[0], 'propose_restore', {
        noteId: finished.id,
        generationId: finishedGeneration,
        fields: ['content'],
        version: finished.version,
        reason: 'Must stay immutable',
      }),
    /Finished history/,
  );
  assert.equal(getNote(db, note.id).content, 'Current content');
  const proposal = await call(bridges[0], 'propose_restore', {
    noteId: note.id,
    generationId: older,
    fields: ['content'],
    version: note.version,
    reason: 'Restore only the earlier content',
  });
  complete(bridges[0]);
  assistant.apply('cedar', chat.id, proposal.id);
  const restored = getNote(db, note.id);
  assert.equal(restored.content, 'Earlier content');
  assert.equal(restored.topics, 'Current unrelated topic');
  const version = restored.version;
  proposal.status = 'pending';
  assistant.apply('cedar', chat.id, proposal.id);
  assert.equal(getNote(db, note.id).version, version);
  assert.throws(
    () =>
      assistant.apply('cedar', chat.id, {
        toString() {
          return 'missing';
        },
      } as unknown as string),
    /not found/,
  );
});

test('scoped assistant extensions register without replacing built-ins and approved intake conversion has a host entry point', async (t) => {
  const seen: Array<{ name: string; args: unknown; profileId: string }> = [];
  let applied = 0;
  const receipts = new Set<string>();
  const extension: HealthTool = {
    type: 'function',
    name: 'health_review_import',
    description: 'Review an import',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  };
  const { assistant, bridges } = fixture(t, {
    actionExtensions: {
      tools: [extension],
      async call(name, args, context) {
        if (typeof context.profileId !== 'string') throw new Error('Expected extension profile');
        seen.push({ name, args, profileId: context.profileId });
        context.chat.proposals.push({
          id: 'mapping-proposal',
          kind: 'mapping',
          title: 'Reviewed mapping',
          summary: 'Synthetic preview',
          status: 'pending',
          changes: { id: args.id },
        });
        return { reviewed: true };
      },
      apply(proposal) {
        applied++;
        receipts.add(proposal.id);
        return { applied: true, resultUrl: '#/sources?view=records' };
      },
      reconcile(proposal) {
        return receipts.has(proposal.id) ? { resultUrl: '#/sources?view=records' } : null;
      },
    },
  });
  const chat = assistant.startIntakeConversion('cedar', 'intake:synthetic', { version: 4 });
  assert.deepEqual(chat.context, {
    route: '#/import?intake=intake%3Asynthetic',
    intakeId: 'intake:synthetic',
  });
  assert.deepEqual(chat.messages[0]?.context, chat.context);
  await tick();
  assert.ok(bridges[0].tools.some((item) => item.name === 'health_query'));
  assert.ok(bridges[0].tools.some((item) => item.name === 'health_review_import'));
  assert.equal(bridges[0].prompt.intakeId, 'intake:synthetic');
  assert.match(required(required(chat.messages[0]).content), /version 4/);
  assert.deepEqual(await call(bridges[0], 'review_import', { id: 'intake:synthetic' }), {
    reviewed: true,
  });
  assert.deepEqual(seen, [
    { name: 'health_review_import', args: { id: 'intake:synthetic' }, profileId: 'cedar' },
  ]);
  complete(bridges[0]);
  assistant.apply('cedar', chat.id, 'mapping-proposal');
  assert.equal(applied, 1);
  assert.equal(chat.proposals[0].status, 'applied');
  chat.proposals[0].status = 'pending';
  assistant.apply('cedar', chat.id, 'mapping-proposal');
  assert.equal(applied, 1, 'durable reconciliation prevents duplicate extension apply');
  const prepared = assistant.create('cedar', {
    title: 'Convert another synthetic delivery',
  });
  assert.equal(prepared.status, 'idle');
  assert.equal(prepared.messages.length, 0);
  assert.equal(bridges.length, 1);
  assistant.send('cedar', prepared.id, {
    message: 'Begin after explicit host approval',
    context: { route: '/sources', intakeId: 'intake:second' },
  });
  await tick();
  assert.equal(bridges[1].prompt.conversation.firstAssistantResponse, true);
  complete(bridges[1]);
});

test('Moxie acquaintance is profile-scoped and never repeats across new chats or retries', async (t) => {
  const { assistant, bridges } = fixture(t);
  const chat = assistant.create('cedar', { message: 'Hi' });
  await tick();
  assert.match(required(bridges[0].instructions), /You are Moxie/);
  assert.equal(bridges[0].prompt.conversation.firstAcquaintance, true);
  assistant.cancel('cedar', chat.id);
  assistant.retry('cedar', chat.id);
  await tick();
  assert.equal(bridges[1].prompt.conversation.firstAcquaintance, false);
  complete(bridges[1]);
  assistant.create('cedar', { message: 'New topic' });
  await tick();
  assert.equal(bridges[2].prompt.conversation.firstAssistantResponse, true);
  assert.equal(bridges[2].prompt.conversation.firstAcquaintance, false);
  assistant.create('cookie-dough', { message: 'Hello' });
  await tick();
  assert.equal(bridges[3].prompt.conversation.firstAcquaintance, true);
});

test('assistant procedure exceptions survive general rules, repeated deliveries, distinct edits and rebuild', async (t) => {
  const { reviewIntake, importIntake } = await import('../intake.ts');
  const { getIntakeIdentityReview } = await import('../intake-identity.ts');
  const { previewMappingChange } = await import('../clinical-import.ts');
  const { applyMappingChange } = await import('../mapping-actions.ts');
  const { assistant, bridges, root, db } = fixture(t);
  const value = {
    format: 'health-record-v1',
    id: 'proc',
    kind: 'record',
    payload: {
      literal: 'immutable',
      header: 'Fictional procedure report',
      patient: 'Fictional Rowan Cedar',
    },
    report: {
      key: 'fictional-procedure',
      title: 'Fictional procedure report',
      anchor: { locator: 'page 1 heading', text: 'Fictional procedure report' },
      subject: { locator: 'page 1 patient', text: 'Fictional Rowan Cedar' },
    },
    provenance: {
      capturedVia: 'Fictional',
      sourceSystem: 'Fictional issuer',
      sourceRecordId: 'proc-1',
      evidenceClass: 'provider_export',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'procedure',
      subject: 'self',
      procedureLabel: 'Example',
      procedureCategory: 'unspecified',
      date: '2026-09',
    },
  };
  const bytes = Buffer.from(JSON.stringify(value));
  let item: ReturnType<typeof getIntake> = uploadIntake(db, root, 'cedar', {
    filename: 'procedure.jsonl',
    newProviderName: 'Fictional',
    bytes,
  });
  async function accept(
    target: ReturnType<typeof getIntake>,
  ): Promise<ReturnType<typeof getIntake>> {
    if (!target.imported) {
      const identity = await getIntakeIdentityReview(
        db,
        root,
        'cedar',
        target.id,
        target.workflow!.reportGroups![0]!.id,
      );
      if (identity.blocking) {
        const scope = required(identity.scope);
        await confirmIntakeIdentityScope(db, root, 'cedar', target.id, {
          version: scope.intakeVersion,
          operationId: `fictional-source-confirm-${target.id}`,
          scope,
          outcome: 'this_is_me',
          attestation: 'reviewed_original_and_membership',
        });
      }
    }
    const review = reviewIntake(db, root, 'cedar', target.id);
    importIntake(db, root, 'cedar', target.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: review.records.map((record) => ({
        recordId: record.id,
        action: 'accept' as const,
        mapping: record.mapping,
      })),
    });
    return getIntake(db, root, 'cedar', target.id);
  }
  item = await accept(item);
  const original = required(db.prepare('SELECT * FROM procedures').get());
  for (const category of ['laboratory', 'imaging', 'laboratory']) {
    const chat = assistant.create('cedar', { message: 'Reviewed individual correction' });
    await tick();
    const bridge = required(bridges.at(-1));
    const proposal = await call(bridge, 'propose_classification', {
      procedureId: original.id,
      sourceRecordId: original.source_record_id,
      category,
      reason: 'Explicit user correction',
    });
    complete(bridge);
    assistant.apply('cedar', chat.id, proposal.id);
    assistant.apply('cedar', chat.id, proposal.id);
  }
  const rule: Parameters<typeof previewMappingChange>[2] = {
    match: { kind: 'procedure', label: 'Example' },
    set: { procedureCategory: 'surgery' },
  };
  const preview = previewMappingChange(db, item.providerId, rule);
  assert.equal(preview.count, 0);
  applyMappingChange(db, root, 'cedar', {
    providerId: item.providerId,
    rule,
    previewToken: preview.token,
    version: preview.version,
    operationId: 'general-rule',
  });
  item = await accept(item);
  const repeated = uploadIntake(db, root, 'cedar', {
    filename: 'repeated.jsonl',
    providerId: item.providerId,
    bytes: Buffer.from(
      JSON.stringify({
        ...value,
        id: 'another-envelope',
        payload: { ...value.payload, literal: 'same source identity in another delivery' },
      }),
    ),
  });
  await accept(repeated);
  assert.equal(
    sqlNumber(db.prepare('SELECT count(*) n FROM procedures').get(), 'n'),
    1,
    'Repeated original reuses the corrected entity',
  );
  for (const clinical of [
    { ...value.clinical, valueText: '2.90', unit: 'mg/dL' },
    { ...value.clinical, text: 'New explicit clinical narrative' },
  ]) {
    const changed = uploadIntake(db, root, 'cedar', {
      filename: 'changed-clinical.jsonl',
      providerId: item.providerId,
      bytes: Buffer.from(JSON.stringify({ ...value, id: 'changed-envelope', clinical })),
    });
    const changedReview = reviewIntake(db, root, 'cedar', changed.id);
    assert.equal(
      (
        required(changedReview.records[0]) as (typeof changedReview.records)[number] & {
          recordException: unknown;
        }
      ).recordException,
      null,
      'Changed explicit cross-kind fields cannot inherit an earlier source-version exception',
    );
    assert.equal(
      required(changedReview.records[0]).mapping.procedureCategory,
      'surgery',
      'Only the general rule applies to changed source assertions',
    );
  }
  const corrected = required(db.prepare('SELECT * FROM procedures').get());
  assert.equal(corrected.category, 'laboratory');
  assert.equal(JSON.parse(sqlText(corrected, 'extra_json')).classificationHistory.length, 3);
  assert.equal(
    sqlNumber(
      db
        .prepare("SELECT count(*) n FROM manual_batches WHERE title='Import record exception'")
        .get(),
      'n',
    ),
    3,
  );
  assert.deepEqual(getIntakeOriginal(db, root, 'cedar', item.id).bytes, bytes);
  const destination = resolve(root, 'rebuilt-exceptions');
  rebuildProfile(root, 'cedar', destination);
  const rebuilt = openDatabase(profilePaths(destination, 'cedar').database, 'cedar');
  attachPersonalDurability(rebuilt, { root: destination, profileId: 'cedar' });
  try {
    assert.deepEqual(rebuilt.prepare('SELECT * FROM procedures').get(), corrected);
    assert.equal(previewMappingChange(rebuilt, item.providerId, rule).count, 0);
    assert.equal(
      sqlNumber(
        rebuilt
          .prepare("SELECT count(*) n FROM manual_batches WHERE title='Import record exception'")
          .get(),
        'n',
      ),
      3,
    );
  } finally {
    rebuilt.close();
  }
});

test('assistant can explicitly replace changed extraction pins and retains both plans after restart', async (t) => {
  fictionalModel(t);
  const { saveMappingRule } = await import('../clinical-import.ts');
  const { assistant, bridges, root, db, databases, options } = fixture(t);
  let item: IntakeRead = uploadIntake(db, root, 'cedar', {
    filename: 'source.html',
    newProviderName: 'Fictional',
    bytes: Buffer.from('<html><body><p>Literal evidence</p></body></html>'),
  });
  assistant.create('cedar', { message: 'Plan extraction' });
  await tick();
  const bridge = bridges[0];
  const schema = required(
    required(bridge.tools.find((tool) => tool.name === 'health_intake_plan')).inputSchema
      .properties,
  );
  assert.ok(schema.replacePlanId);
  assert.ok(schema.mappingVersion);
  const created = await call<IntakeSummaryV2>(bridge, 'intake_plan', {
    id: item.id,
    version: item.version,
    action: 'create',
  });
  item = getIntakeRead(db, root, 'cedar', item.id);
  const first = structuredClone(selectedFixturePlan(db, root, 'cedar', item.id));
  transaction(db, () =>
    saveMappingRule(
      db,
      item.providerId,
      { match: { kind: 'procedure', label: 'Example' }, set: { procedureCategory: 'laboratory' } },
      'new-rule',
    ),
  );
  await assert.rejects(
    () => call(bridge, 'intake_plan', { id: item.id, version: item.version, action: 'create' }),
    (error: unknown) => hasCode(error, 'PLAN_CHANGED'),
  );
  const replaced = await call<IntakeSummaryV2>(bridge, 'intake_plan', {
    id: item.id,
    version: item.version,
    action: 'create',
    replacePlanId: first.id,
  });
  assert.ok(created.version < replaced.version);
  item = getIntakeRead(db, root, 'cedar', item.id);
  assert.ok(isIntakeSummary(item));
  assert.equal(item.collections.plans.total, 2);
  const retainedFirst = selectedFixturePlan(db, root, 'cedar', item.id, { planId: first.id });
  assert.deepEqual(retainedFirst, {
    ...first,
    plan: { ...first.plan, status: 'superseded' },
    // Addressed unit metadata carries the current public pin even for retained plans.
    units: first.units.map((unit) => ({
      ...unit,
      ...('metadata' in unit ? { metadata: { ...unit.metadata, version: item.version } } : {}),
    })),
  });
  const activePlan = structuredClone(selectedFixturePlan(db, root, 'cedar', item.id));
  assert.equal(activePlan.plan.status, 'active');
  assert.notEqual(activePlan.id, first.id);
  complete(bridge);
  assistant.close();
  const restarted = createAssistant({ root, databases, ...options });
  t.after(() => restarted.close());
  const resumed = restarted.create('cedar', { message: 'Resume saved extraction' });
  await tick();
  const modelPlan = await call<NativeModelContext>(required(bridges.at(-1)), 'intake_plan', {
    id: item.id,
    action: 'read',
    freshStart: true,
    section: 'units',
  });
  assert.equal(modelPlan.format, 'health-intake-model-context-v2');
  assertNativeModelPins(modelPlan.pins);
  assert.equal(modelPlan.pins.version, item.version);
  assert.equal(modelPlan.pins.mappingVersion, activePlan.pins.mappingVersion);
  assert.equal(modelPlan.complete, true);
  assert.ok(Array.isArray(modelPlan.items));
  assert.deepEqual(
    modelPlan.items.map((entry) => entry.value.id),
    activePlan.units.map(({ id }) => id),
  );
  const unitCursor = modelPlan.items[0].valueFragments.unit.cursor;
  assert.equal(typeof unitCursor, 'string');
  await assert.rejects(
    call(required(bridges.at(-1)), 'intake_plan', {
      id: item.id,
      action: 'read',
      version: item.version - 1,
      mappingVersion: modelPlan.pins.mappingVersion,
      section: 'units',
      cursor: unitCursor,
    }),
    (error: unknown) => hasCode(error, 'MODEL_CONTEXT_CHANGED'),
  );
  assert.equal(restarted.get('cedar', resumed.id).status, 'running');
  complete(required(bridges.at(-1)));
  const destination = resolve(root, 'rebuilt-plans');
  rebuildProfile(root, 'cedar', destination);
  const rebuilt = openDatabase(profilePaths(destination, 'cedar').database, 'cedar');
  attachPersonalDurability(rebuilt, { root: destination, profileId: 'cedar' });
  try {
    for (const expected of [retainedFirst, activePlan]) {
      await prepareDirectPlanAccess(rebuilt, 'cedar', item.id, { planId: expected.id });
      assert.deepEqual(
        selectedFixturePlan(rebuilt, destination, 'cedar', item.id, { planId: expected.id }),
        expected,
      );
    }
    const recovered = getIntakeRead(rebuilt, destination, 'cedar', item.id);
    assert.ok(isIntakeSummary(recovered));
    assert.equal(recovered.collections.plans.total, 2);
  } finally {
    rebuilt.close();
  }
});

test('fresh plan context starts at one captured current pin pair and stale continuations cannot mix', async (t) => {
  const { saveMappingRule } = await import('../clinical-import.ts');
  const f = await linkedFictionalPlanVersionConversion(t);
  await call(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
  });
  const beforeRead = intakeSourceVersion(f.db, f.item.id);
  const selected = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id);
  const first = await call<NativeModelContext>(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'read',
    freshStart: true,
    section: 'units',
    offset: 0,
  });
  assert.equal(first.format, 'health-intake-model-context-v2');
  assert.equal(first.section, 'units');
  assert.equal(first.scope, 'section');
  assertNativeModelPins(first.pins);
  assert.equal(first.pins.version, beforeRead.version);
  assert.equal(first.pins.sourceId, f.item.id);
  assert.equal(first.pins.sourceHash, f.item.sha256);
  assert.equal(first.pins.mappingVersion, selected.pins.mappingVersion);
  assert.match(String(first.scopeInstructions), /complete page covers only its named scope/);
  assert.deepEqual(intakeSourceVersion(f.db, f.item.id), beforeRead);
  assert.ok(Array.isArray(first.items) && first.items.length > 0);
  const cursor = first.items[0].valueFragments.unit.cursor;
  assert.equal(typeof cursor, 'string');
  transaction(f.db, () =>
    saveMappingRule(
      f.db,
      f.item.providerId,
      {
        match: { kind: 'procedure', label: 'Fictional fresh context procedure' },
        set: { procedureCategory: 'laboratory' },
      },
      'fictional-fresh-context-rule',
    ),
  );
  await assert.rejects(
    call(f.bridge, 'intake_plan', {
      id: f.item.id,
      action: 'read',
      version: first.pins.version,
      mappingVersion: first.pins.mappingVersion,
      section: 'units',
      cursor,
    }),
    (error: unknown) => {
      assert.equal(hasCode(error, 'MODEL_CONTEXT_CHANGED'), true);
      assert.match(
        error instanceof Error ? error.message : '',
        /Discard previously assembled pages and partial fields/,
      );
      assert.match(
        error instanceof Error ? error.message : '',
        /freshStart true and no cursor or version pins/,
      );
      assert.match(error instanceof Error ? error.message : '', /Never combine pages/);
      return true;
    },
  );
  const restarted = await call<NativeModelContext>(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'read',
    freshStart: true,
    section: 'units',
  });
  assertNativeModelPins(restarted.pins);
  assert.equal(restarted.pins.version, first.pins.version);
  assert.notEqual(restarted.pins.mappingVersion, first.pins.mappingVersion);
  assert.equal(restarted.pins.sourceHash, first.pins.sourceHash);
  assert.deepEqual(
    intakeSourceVersion(f.db, f.item.id),
    beforeRead,
    'fresh context writes no workflow, proposal, or accepted history',
  );
  assert.deepEqual(selectedFixturePlan(f.db, f.root, 'cedar', f.item.id), selected);
  f.assistant.cancel('cedar', f.chat.id);
});

// Seventeen independent native conversion fixtures took about 46 seconds locally.
// This is a coarse host integration hang guard; every malformed-envelope oracle remains exact.
test(
  'fresh plan context rejects every malformed envelope before dispatch',
  { timeout: 120_000 },
  async (t) => {
    const cases: { name: string; args: Record<string, unknown> }[] = [
      {
        name: 'false flag',
        args: { action: 'read', freshStart: false, section: 'units', offset: 0 },
      },
      { name: 'missing section', args: { action: 'read', freshStart: true, offset: 0 } },
      {
        name: 'unknown section',
        args: { action: 'read', freshStart: true, section: 'fictional_unknown', offset: 0 },
      },
      {
        name: 'nonzero offset',
        args: { action: 'read', freshStart: true, section: 'units', offset: 1 },
      },
      {
        name: 'intake pin',
        args: { action: 'read', freshStart: true, section: 'units', version: 1 },
      },
      {
        name: 'mapping pin',
        args: { action: 'read', freshStart: true, section: 'units', mappingVersion: 'stale' },
      },
      {
        name: 'create action',
        args: { action: 'create', freshStart: true, section: 'units' },
      },
      {
        name: 'read unit action',
        args: { action: 'read_unit', freshStart: true, section: 'units' },
      },
      {
        name: 'search action',
        args: { action: 'search', freshStart: true, section: 'units' },
      },
      {
        name: 'follow action',
        args: { action: 'follow', freshStart: true, section: 'units' },
      },
      {
        name: 'read unit field',
        args: { action: 'read', freshStart: true, section: 'units', unitId: 'unit-1' },
      },
      {
        name: 'create field',
        args: { action: 'read', freshStart: true, section: 'units', replacePlanId: 'plan-1' },
      },
      {
        name: 'search field',
        args: { action: 'read', freshStart: true, section: 'units', query: 'fictional' },
      },
      {
        name: 'follow field',
        args: { action: 'read', freshStart: true, section: 'units', referenceId: 'reference-1' },
      },
      {
        name: 'create sizing field',
        args: { action: 'read', freshStart: true, section: 'units', unitSize: 100 },
      },
      {
        name: 'create overlap field',
        args: { action: 'read', freshStart: true, section: 'units', overlap: 10 },
      },
      {
        name: 'unknown future field',
        args: { action: 'read', freshStart: true, section: 'units', futureMode: true },
      },
    ];

    for (const item of cases)
      await t.test(item.name, async (child) => {
        const f = await linkedFictionalPlanVersionConversion(child);
        const before = intakeSourceVersion(f.db, f.item.id);
        await assert.rejects(call(f.bridge, 'intake_plan', { id: f.item.id, ...item.args }), {
          name: 'ModelToolValidationError',
          code: 'MODEL_CONTEXT_FRESH_START',
        });
        assert.deepEqual(intakeSourceVersion(f.db, f.item.id), before);
        assert.equal(f.chat.status, 'running');
        assert.equal(f.bridge.closed, false);
        f.assistant.cancel('cedar', f.chat.id);
      });
  },
);

// Four actual native conversion scenarios share this host integration hang guard.
test(
  'fresh plan context malformed repair and repeated reads remain finitely bounded',
  { timeout: 90_000 },
  async (t) => {
    await t.test(
      'third malformed envelope pauses through the bounded repair path',
      async (child) => {
        const f = await linkedFictionalPlanVersionConversion(child);
        const before = intakeSourceVersion(f.db, f.item.id);
        for (let attempt = 1; attempt <= 3; attempt++) {
          await assert.rejects(
            call(f.bridge, 'intake_plan', {
              id: f.item.id,
              action: 'read',
              freshStart: true,
              offset: 0,
            }),
            { name: 'ModelToolValidationError', code: 'MODEL_CONTEXT_FRESH_START' },
          );
          assert.equal(f.chat.status, attempt < 3 ? 'running' : 'idle');
        }
        assert.equal(required(f.chat.reading).reason, 'tool_error');
        assert.equal(f.bridge.closed, true);
        assert.deepEqual(intakeSourceVersion(f.db, f.item.id), before);
      },
    );

    await t.test('third unchanged fresh start pauses without another page', async (child) => {
      const f = await linkedFictionalOpticalConversion(child);
      await call(f.bridge, 'intake_plan', {
        id: f.item.id,
        action: 'create',
        version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
      });
      const before = intakeSourceVersion(f.db, f.item.id);
      const args = {
        id: f.item.id,
        action: 'read',
        freshStart: true,
        section: 'units',
        offset: 0,
      };
      await call(f.bridge, 'intake_plan', args);
      await call(f.bridge, 'intake_plan', args);
      let terminalResult: unknown;
      await assert.rejects(
        call(f.bridge, 'intake_plan', args).then((value) => {
          terminalResult = value;
          return value;
        }),
        { code: 'CONVERSION_NO_PROGRESS' },
      );
      assert.equal(terminalResult, undefined);
      assert.equal(f.chat.status, 'idle');
      assert.equal(required(f.chat.reading).reason, 'no_progress');
      assert.equal(f.bridge.closed, true);
      assert.deepEqual(intakeSourceVersion(f.db, f.item.id), before);
      assert.equal(sqlNumber(f.db.prepare('SELECT count(*) n FROM observations').get(), 'n'), 0);
      assert.equal(sqlNumber(f.db.prepare('SELECT count(*) n FROM source_records').get(), 'n'), 0);
    });

    await t.test('intake version churn alone cannot evade the fresh-start bound', async (child) => {
      const f = await linkedFictionalOpticalConversion(child);
      await call(f.bridge, 'intake_plan', {
        id: f.item.id,
        action: 'create',
        version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
      });
      const args = {
        id: f.item.id,
        action: 'read',
        freshStart: true,
        section: 'units',
        offset: 0,
      };
      for (let attempt = 1; attempt <= 2; attempt++) {
        await call(f.bridge, 'intake_plan', args);
        const current = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
        await askIntakeQuestionRead(f.db, f.root, 'cedar', f.item.id, {
          version: current.version,
          operationId: `fictional-fresh-version-churn-${attempt}`,
          key: `fictional-fresh-version-question-${attempt}`,
          prompt: `Did the fictional reviewer inspect pass ${attempt}?`,
          locator: `fictional page ${attempt}`,
        });
      }
      await assert.rejects(call(f.bridge, 'intake_plan', args), {
        code: 'CONVERSION_NO_PROGRESS',
      });
      const after = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
      assert.ok(isIntakeSummary(after));
      assert.equal(after.collections.candidates.total, 0);
      assert.equal(after.collections.plans.total, 1);
      assert.equal(
        selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units.filter(
          (unit) => unit.status !== 'pending',
        ).length,
        0,
      );
      assert.equal(f.chat.status, 'idle');
      assert.equal(required(f.chat.reading).reason, 'no_progress');
    });

    await t.test(
      'durable candidate and coverage progress resets this fingerprint',
      async (child) => {
        const f = await linkedFictionalBatchConversion(child);
        const args = {
          id: f.item.id,
          action: 'read',
          freshStart: true,
          section: 'units',
          offset: 0,
        };
        await call(f.bridge, 'intake_plan', args);
        await call(f.bridge, 'intake_plan', args);
        await call(f.bridge, 'intake_batch', f.batch);
        const advanced = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
        assert.ok(isIntakeSummary(advanced));
        assert.equal(advanced.collections.candidates.total, 1);
        assert.equal(advanced.collections.plans.total, 1);
        assert.equal(
          selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units.filter(
            (unit) => unit.status !== 'pending',
          ).length,
          1,
        );
        const restarted = await call<NativeModelContext>(f.bridge, 'intake_plan', args);
        assertNativeModelPins(restarted.pins);
        assert.equal(restarted.pins.version, advanced.version);
        assert.equal(f.chat.status, 'running');
        f.assistant.cancel('cedar', f.chat.id);
      },
    );
  },
);

async function linkedFictionalPlanVersionConversion(t: TestContext) {
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-plan-version.txt',
    newProviderName: 'Fictional plan source',
    bytes: Buffer.from('Fictional retained evidence for one reviewable plan unit.'),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional plan version validation' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Prepare this fictional delivery for review',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  return { ...f, item, chat, bridge };
}

test('plan create advertises and recovers its conditional current-version requirement', async (t) => {
  const f = await linkedFictionalPlanVersionConversion(t);
  const planTool = required(f.bridge.tools.find((tool) => tool.name === 'health_intake_plan'));
  const questionTool = required(
    f.bridge.tools.find((tool) => tool.name === 'health_intake_question'),
  );
  assert.match(
    planTool.description,
    /Action create requires the exact current conversion\.version/,
  );
  assert.match(
    required(f.bridge.instructions),
    /Action create requires the exact current\s+conversion\.version as `version`/,
  );
  assert.deepEqual(planTool.inputSchema.required, ['id', 'action']);
  assert.deepEqual(required(required(planTool.inputSchema.properties).version), {
    type: 'integer',
    minimum: 1,
  });
  assert.deepEqual(required(planTool.inputSchema.properties).freshStart, { type: 'boolean' });
  assert.match(planTool.description, /freshStart true/);
  assert.match(planTool.description, /discard every previously assembled context page/);
  assert.match(required(f.bridge.instructions), /freshStart true/);
  assert.match(required(f.bridge.instructions), /discard every previously assembled model-context/);
  assert.match(questionTool.description, /answers in Import/);
  assert.doesNotMatch(questionTool.description, /answers in Sources/);

  const before = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  assert.ok(isIntakeSummary(before));
  assert.equal(before.collections.plans.total, 1, 'native startup prepared one admitted plan');
  const initialPlanId = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).id;
  assert.equal(f.bridge.prompt.conversion.version, before.version);
  await assert.rejects(call(f.bridge, 'intake_plan', { id: f.item.id, action: 'create' }), {
    name: 'ModelToolValidationError',
    code: 'INTAKE_PLAN_CREATE_VERSION',
    message: /exact current conversion\.version/,
  });
  assert.equal(f.chat.status, 'running');
  assert.equal(f.bridge.closed, false);
  const unchanged = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  assert.ok(isIntakeSummary(unchanged));
  assert.equal(unchanged.collections.plans.total, before.collections.plans.total);
  assert.equal(selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).id, initialPlanId);
  assert.equal(getIntakeRead(f.db, f.root, 'cedar', f.item.id).version, before.version);

  await call(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'create',
    version: before.version,
  });
  const planned = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  assert.ok(isIntakeSummary(planned));
  assert.equal(
    planned.collections.plans.total,
    1,
    'the corrected retry retains exactly one prepared plan',
  );
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id);
  assert.equal(plan.plan.status, 'active');
  await call(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'read_unit',
    unitId: required(plan.units[0]).id,
  });
  assert.equal(f.chat.status, 'running', 'read_unit remains valid without a global version field');
  const final = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  assert.ok(isIntakeSummary(final));
  assert.equal(final.collections.plans.total, 1);
  f.assistant.cancel('cedar', f.chat.id);
});

test('fresh conversion turns retain the mapping pin and reject it after mappings change', async (t) => {
  const f = await linkedFictionalPlanVersionConversion(t);
  await call(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
  });
  const planned = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id);

  f.bridge.callbacks.onExit?.(
    new ModelContextLimitError('Fictional manual initial context limit', 'initial'),
  );
  assert.equal(f.chat.status, 'idle');
  assert.equal(f.chat.reading?.reason, 'context_limit');
  assert.equal(f.chat.conversionCheckpoint?.contextTier, 1);
  f.assistant.send('cedar', f.chat.id, {
    message: 'Resume the fictional delivery in a fresh turn',
    context: { intakeId: planned.id },
  });
  await waitForConversionBridge(t, f, f.chat, 1);
  assert.equal(f.bridges.length, 2, 'the conversion continues in a fresh model turn');
  const resumed = required(f.bridges[1]);
  assert.equal(resumed.prompt.conversion.version, planned.version);
  assert.equal(resumed.prompt.conversion.mappingVersion, plan.pins.mappingVersion);
  assert.match(
    resumed.prompt.conversion.instructions,
    /finish and publish all unproposed records from the current window/,
  );
  assert.match(resumed.prompt.conversion.instructions, /Do not accept\/import/);
  assert.doesNotMatch(
    resumed.prompt.conversion.instructions,
    /dispatched unit|Publish only with health_intake_batch/,
  );

  const firstRead = await call<NativeModelContext>(resumed, 'intake_plan', {
    id: planned.id,
    action: 'read',
    freshStart: true,
    section: 'units',
  });
  assertNativeModelPins(firstRead.pins);
  assert.equal(firstRead.pins.version, resumed.prompt.conversion.version);
  assert.equal(firstRead.pins.mappingVersion, resumed.prompt.conversion.mappingVersion);
  assert.ok(Array.isArray(firstRead.items) && firstRead.items.length > 0);
  const cursor = firstRead.items[0].valueFragments.unit.cursor;
  assert.equal(typeof cursor, 'string');

  const { saveMappingRule } = await import('../clinical-import.ts');
  transaction(f.db, () =>
    saveMappingRule(
      f.db,
      planned.providerId,
      {
        match: { kind: 'procedure', label: 'Fictional changed mapping' },
        set: { procedureCategory: 'laboratory' },
      },
      'fictional-changed-mapping',
    ),
  );
  await assert.rejects(
    call(resumed, 'intake_plan', {
      id: planned.id,
      action: 'read',
      version: resumed.prompt.conversion.version,
      mappingVersion: resumed.prompt.conversion.mappingVersion,
      section: 'units',
      cursor,
    }),
    (error: unknown) => hasCode(error, 'MODEL_CONTEXT_CHANGED'),
  );
  assert.equal(f.chat.status, 'running');
  f.assistant.cancel('cedar', f.chat.id);
});

test('three malformed plan-create versions exhaust only the finite validation budget', async (t) => {
  const f = await linkedFictionalPlanVersionConversion(t);
  const before = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  assert.ok(isIntakeSummary(before));
  assert.equal(before.collections.plans.total, 1, 'native startup prepared one admitted plan');
  const initialPlanId = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).id;
  const invalidVersions: unknown[] = ['1', Number.NaN, Number.MAX_SAFE_INTEGER + 1];
  for (const [index, version] of invalidVersions.entries()) {
    await assert.rejects(
      call(f.bridge, 'intake_plan', { id: f.item.id, action: 'create', version }),
      {
        name: 'ModelToolValidationError',
        code: 'INTAKE_PLAN_CREATE_VERSION',
      },
    );
    assert.equal(f.chat.status, index < 2 ? 'running' : 'idle');
    const unchanged = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
    assert.ok(isIntakeSummary(unchanged));
    assert.equal(unchanged.collections.plans.total, before.collections.plans.total);
    assert.equal(selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).id, initialPlanId);
    assert.equal(getIntakeRead(f.db, f.root, 'cedar', f.item.id).version, before.version);
  }
  assert.equal(f.bridge.closed, true);
  assert.equal(required(f.chat.reading).reason, 'tool_error');
});

test('a supplied stale numeric plan-create version remains terminal', async (t) => {
  const f = await linkedFictionalPlanVersionConversion(t);
  const initialVersion = getIntakeRead(f.db, f.root, 'cedar', f.item.id).version;
  await call(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'create',
    version: initialVersion,
  });
  await assert.rejects(
    call(f.bridge, 'intake_plan', {
      id: f.item.id,
      action: 'create',
      version: initialVersion,
    }),
    (error: unknown) => {
      assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
      assert.notEqual(error instanceof Error && error.name, 'ModelToolValidationError');
      return true;
    },
  );
  assert.equal(f.chat.status, 'idle');
  assert.equal(f.bridge.closed, true);
  assert.equal(required(f.chat.reading).reason, 'tool_error');
  const final = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  assert.ok(isIntakeSummary(final));
  assert.equal(final.collections.plans.total, 1);
});

test('retained v2 individual exceptions resolve delivery defaults from originals without rewriting the journal', async (t) => {
  const { createHash } = await import('node:crypto');
  const { transaction } = await import('../database.ts');
  const { reviewIntake, importIntake } = await import('../intake.ts');
  const { procedureClassificationException } = await import('../clinical-import.ts');
  const { db, root } = fixture(t);
  const value = {
    format: 'health-record-v1',
    id: 'old-envelope',
    kind: 'record',
    payload: {
      literal: 'first delivery',
      header: 'Fictional legacy procedure report',
      patient: 'Fictional Rowan Cedar',
    },
    report: {
      key: 'fictional-legacy-procedure',
      title: 'Fictional legacy procedure report',
      anchor: { locator: 'row 1 heading', text: 'Fictional legacy procedure report' },
      subject: { locator: 'row 1 patient', text: 'Fictional Rowan Cedar' },
    },
    clinical: {
      kind: 'procedure',
      subject: 'self',
      procedureLabel: 'Fictional legacy entry',
      procedureCategory: 'unspecified',
    },
    provenance: {
      capturedVia: 'Fictional',
      sourceSystem: 'Fictional issuer',
      sourceRecordId: 'legacy-procedure',
      evidenceClass: 'provider_export',
      locator: 'row 1',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  const first = uploadIntake(db, root, 'cedar', {
    filename: 'legacy-origin.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const scope = await getIntakeIdentityScope(
    db,
    root,
    'cedar',
    first.id,
    first.workflow!.reportGroups![0]!.id,
  );
  await confirmIntakeIdentityScope(db, root, 'cedar', first.id, {
    version: scope.intakeVersion,
    operationId: 'fictional-legacy-source-confirm',
    scope,
    outcome: 'this_is_me',
    attestation: 'reviewed_original_and_membership',
  });
  const review = reviewIntake(db, root, 'cedar', first.id);
  importIntake(db, root, 'cedar', first.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: 'accept' as const,
      mapping: record.mapping,
    })),
  });
  const row = required(db.prepare('SELECT * FROM procedures').get());
  // Seed the prior v2 format in one unacknowledged test transaction. Production
  // reads below must retain these old accepted bytes rather than migrate them.
  transaction(db, () => {
    type LegacyExtra = Record<string, unknown> & {
      import: {
        originalMapping: Record<string, unknown> & { mappingOrigins?: unknown };
        recordException: { id: string; sourceVersion: string };
      };
    };
    const extra = procedureClassificationException(
      db,
      row as Parameters<typeof procedureClassificationException>[1],
      'laboratory',
      'legacy-v2-fixture',
    ) as LegacyExtra;
    delete extra.import.originalMapping.mappingOrigins;
    const stable = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(stable)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value as Record<string, unknown>)
                .sort()
                .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
            )
          : value;
    extra.import.recordException.sourceVersion =
      'mapping-v2:' +
      createHash('sha256')
        .update(JSON.stringify(stable(extra.import.originalMapping)))
        .digest('hex');
    db.prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?').run(
      JSON.stringify({ recordException: extra.import.recordException }),
      extra.import.recordException.id,
    );
    db.prepare('UPDATE procedures SET category=?,extra_json=? WHERE id=?').run(
      'laboratory',
      JSON.stringify(extra),
      required(row.id),
    );
  });
  const journal = sqlText(
    db
      .prepare("SELECT coverage_json FROM manual_batches WHERE title='Import record exception'")
      .get(),
    'coverage_json',
  );
  const copy = uploadIntake(db, root, 'cedar', {
    filename: 'legacy-copy.jsonl',
    providerId: first.providerId,
    bytes: Buffer.from(
      JSON.stringify({
        ...value,
        id: 'new-envelope',
        payload: { ...value.payload, literal: 'another acquisition of the same clinical mapping' },
      }),
    ),
  });
  const copied = reviewIntake(db, root, 'cedar', copy.id);
  assert.equal(required(copied.records[0]).classification, 'duplicate');
  assert.equal(required(copied.records[0]).mapping.procedureCategory, 'laboratory');
  assert.deepEqual(
    sqlText(
      db
        .prepare("SELECT coverage_json FROM manual_batches WHERE title='Import record exception'")
        .get(),
      'coverage_json',
    ),
    journal,
  );
  const changed = uploadIntake(db, root, 'cedar', {
    filename: 'legacy-changed.jsonl',
    providerId: first.providerId,
    bytes: Buffer.from(
      JSON.stringify({
        ...value,
        clinical: { ...value.clinical, valueText: 'New clinical assertion' },
      }),
    ),
  });
  const changedRecord = required(
    reviewIntake(db, root, 'cedar', changed.id).records[0],
  ) as unknown as {
    recordException: unknown;
  };
  assert.equal(changedRecord.recordException, null);
});

test('one response retains raw streamed items and explicit progress across tools and reopen', async (t) => {
  const { assistant, bridges, root, databases, options } = fixture(t);
  const profileId = 'cookie-dough';
  const chat = assistant.create(profileId, { message: 'Compare the fictional source notes' });
  await tick();
  const bridge = bridges[0];
  bridge.callbacks.onEvent('item/agentMessage/delta', { itemId: 'first', delta: 'One source ' });
  bridge.callbacks.onEvent('item/agentMessage/delta', { itemId: 'first', delta: 'lists 12.' });
  bridge.callbacks.onEvent('item/completed', {
    item: {
      id: 'first',
      type: 'agentMessage',
      text: 'One source lists 12. [Source](#/sources?file=fictional).',
    },
  });
  await call(bridge, 'assistant_progress', { text: 'Checking the second source.' });
  await call(bridge, 'query', { collection: 'notes' });
  await call(bridge, 'assistant_progress', { text: 'Comparing the retained notes.' });
  bridge.callbacks.onEvent('item/agentMessage/delta', {
    itemId: 'second',
    delta: 'The second source lists 13; the difference remains unresolved.',
  });
  bridge.callbacks.onEvent('item/completed', {
    item: {
      id: 'second',
      type: 'agentMessage',
      text: 'The second source lists 13; the difference remains unresolved.',
    },
  });
  assert.equal(chat.messages.length, 3, 'progress never becomes an answer fragment');
  assert.equal(
    chat.messages[1].status,
    'streaming',
    'a completed item is not a completed response',
  );
  assert.equal(chat.messages[1].runId, chat.messages[2].runId);
  assert.equal(chat.messages[1].itemId, 'first');
  assert.equal(chat.runs?.at(-1)?.progress?.text, 'Comparing the retained notes.');
  assert.deepEqual(
    chat.operations
      .filter((operation) => operation.tool === 'health_assistant_progress')
      .map((operation) => operation.arguments),
    [{ text: 'Checking the second source.' }, { text: 'Comparing the retained notes.' }],
  );
  complete(bridge);
  assert.equal(chat.messages[1].status, 'complete');
  const recoveredService = createAssistant({ root, databases, ...options });
  t.after(() => recoveredService.close());
  const recovered = recoveredService.get(profileId, chat.id);
  assert.deepEqual(recovered.messages, chat.messages);
  assert.deepEqual(recovered.operations, chat.operations);
  assert.equal(
    recovered.messages[1].content,
    'One source lists 12. [Source](#/sources?file=fictional).',
  );
});

test('cancelled and failed responses retain completed items and isolate reused item IDs on retry', async (t) => {
  for (const terminal of ['cancel', 'failure', 'close'] as const)
    await t.test(terminal, async (t) => {
      const { assistant, bridges, root, databases, options } = fixture(t);
      const profileId = 'cookie-dough';
      const chat = assistant.create(profileId, { message: 'Read the fictional notes' });
      await tick();
      bridges[0].callbacks.onEvent('item/completed', {
        item: { id: 'shared-item', type: 'agentMessage', text: 'The first note is retained.' },
      });
      bridges[0].callbacks.onEvent('item/agentMessage/delta', {
        itemId: 'partial',
        delta: 'The second note is only partially read.',
      });
      if (terminal === 'cancel') assistant.cancel(profileId, chat.id);
      else if (terminal === 'close') assistant.close();
      else
        bridges[0].callbacks.onEvent('error', {
          message: 'Fictional tool continuation failed',
          willRetry: false,
        });
      assert.deepEqual(
        chat.messages.slice(1).map((message) => message.status),
        ['interrupted', 'interrupted'],
      );
      assert.deepEqual(
        readTestChat(root, profileId, chat.id).messages,
        chat.messages,
        'terminal paths flush buffered text',
      );
      const recoveredService = createAssistant({ root, databases, ...options });
      t.after(() => recoveredService.close());
      assert.deepEqual(recoveredService.get(profileId, chat.id).messages, chat.messages);
      assistant.retry(profileId, chat.id);
      const retriedChat = assistant.get(profileId, chat.id);
      if (terminal === 'close')
        assert.notEqual(retriedChat, chat, 'close discards the prior conversation cache');
      await tick();
      bridges[0].callbacks.onEvent('item/agentMessage/delta', {
        itemId: 'shared-item',
        delta: 'Late stale text',
      });
      bridges[1].callbacks.onEvent('item/completed', {
        item: {
          id: 'shared-item',
          type: 'agentMessage',
          text: 'A separately verified retry answer.',
        },
      });
      complete(bridges[1]);
      assert.equal(retriedChat.messages.length, 4);
      assert.notEqual(retriedChat.messages[1].id, retriedChat.messages[3].id);
      assert.notEqual(retriedChat.messages[1].runId, retriedChat.messages[3].runId);
      assert.equal(retriedChat.messages[1].content, 'The first note is retained.');
      assert.equal(retriedChat.messages[1].status, 'interrupted');
      assert.equal(retriedChat.messages[3].status, 'complete');
    });
});

test('stream checkpoints coalesce tokens and recover an interrupted response after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: string[] = [];
  const { assistant, bridges, root, databases, options } = fixture(t, {
    journalWriter(root, profileId, chat, reason) {
      writes.push(reason);
      writeChat(root, profileId, chat, reason);
    },
  });
  const profileId = 'cookie-dough';
  const chat = assistant.create(profileId, { message: 'Read fictional notes' });
  await tick();
  for (const delta of ['A ', 'meaningful ', 'partial ', 'answer.'])
    bridges[0].callbacks.onEvent('item/agentMessage/delta', { itemId: 'partial', delta });
  assert.equal(writes.filter((reason) => reason === 'assistant-stream-checkpoint').length, 0);
  t.mock.timers.tick(1000);
  assert.equal(writes.filter((reason) => reason === 'assistant-stream-checkpoint').length, 1);
  const restarted = createAssistant({ root, databases, ...options });
  t.after(() => restarted.close());
  const recovered = restarted.get(profileId, chat.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.messages[1].content, 'A meaningful partial answer.');
  assert.equal(recovered.messages[1].status, 'interrupted');
  assert.equal(recovered.messages[1].runId, chat.messages[1].runId);
  assert.equal(bridges.length, 1, 'reopen does not restart provider work');
});

test('a buffered stream journal failure stops safely and leaves visible partial text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { assistant, bridges } = fixture(t, {
    journalWriter(root, profileId, chat, reason) {
      if (reason === 'assistant-stream-checkpoint') throw new Error('Fictional disk failure');
      writeChat(root, profileId, chat, reason);
    },
  });
  const chat = assistant.create('cookie-dough', { message: 'Read fictional notes' });
  await tick();
  bridges[0].callbacks.onEvent('item/agentMessage/delta', {
    itemId: 'partial',
    delta: 'Retained partial text.',
  });
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  assert.equal(chat.status, 'failed');
  assert.match(chat.error || '', /could not be saved/);
  assert.equal(chat.messages[1].content, 'Retained partial text.');
  assert.equal(chat.messages[1].status, 'interrupted');
  assert.equal(bridges[0].closed, true);
});

test('explicit context and unreadable dispositions advance bounded accounting without repeated reads or extracted claims', async (t) => {
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-accounting.txt',
    bytes: Buffer.from('Fictional context '.repeat(800)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional source accounting' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Account for the source sections',
    context: { intakeId: item.id },
  });
  await waitForConversionBridge(t, f, chat);
  await call(f.bridges[0], 'intake_plan', {
    id: item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
  });
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', item.id);
  assert.equal(plan.units.length, 2);
  for (const [index, kind] of ['context', 'unreadable'].entries()) {
    await waitForConversionBridge(t, f, chat, index);
    await call(f.bridges[index], 'intake_batch', {
      id: item.id,
      version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
      planId: plan.id,
      operationId: 'fictional-account-' + index,
      summary: 'Fictional scope disposition, not extraction verification',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-context-' + index,
        kind: 'context',
        payload: { text: 'Fictional context retained' },
        provenance: {
          capturedVia: null,
          sourceSystem: 'Fictional source',
          sourceRecordId: null,
          evidenceClass: 'unknown',
          locator: plan.units[index].locator,
        },
        coverage: { status: 'partial', notes: ['Clinical extraction remains unknown'] },
      }),
      coverage: [
        {
          unitId: plan.units[index].id,
          kind,
          notes: 'Explicit fictional ' + kind + ' disposition',
        },
      ],
    });
    complete(f.bridges[index]);
    await tick();
  }
  assert.equal(f.bridges.length, 2);
  assert.equal(chat.status, 'idle');
  assert.equal(required(chat.reading).reason, 'reading_exhausted');
  assert.equal(required(chat.reading).remainingUnits, 0);
  const saved = selectedFixturePlan(f.db, f.root, 'cedar', item.id);
  assert.ok(saved.units.every((unit) => unit.status === 'partial'));
  assert.deepEqual(
    saved.units.map((unit) => unit.coverage?.kind),
    ['context', 'unreadable'],
  );
  assert.equal(saved.units.filter((unit) => unit.status === 'completed').length, 0);
  assert.ok(isNativeAssistantCheckpoint(chat.conversionCheckpoint));
  assert.equal(chat.reading?.accountedUnits, 2);
  assert.deepEqual(selectedFixtureValue(f.db, item.id, ['intake', 'workflow', 'decisions']), []);
});

function fictionalOpticalPeopleEnvelope() {
  return {
    format: 'health-record-v1',
    id: 'fictional-optical-with-clinician',
    kind: 'document',
    payload: 'Fictional eyewear prescription. Dr Rowan Finch. Right sphere +01.25.',
    provenance: {
      capturedVia: 'Fictional image',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'page 1',
    },
    coverage: { status: 'partial', notes: [] },
    report: {
      key: 'fictional-optical',
      title: 'Fictional eyewear prescription',
      anchor: { locator: 'page 1 heading', text: 'Fictional eyewear prescription' },
      subject: null,
    },
    clinical: {
      kind: 'document',
      subject: 'unknown',
      documentTitle: 'Fictional eyewear prescription',
      opticalPrescription: {
        type: 'spectacle',
        eyes: [{ side: 'right', sph: { valueText: '+01.25' } }],
      },
    },
    people: [
      {
        id: 'fictional-rowan',
        fullName: 'Rowan Finch',
        role: 'clinician',
        title: 'Dr Rowan Finch',
        evidence: [
          { textAnchor: 'Dr Rowan Finch.', supports: ['fullName', 'title'], locator: 'page 1' },
        ],
      },
    ],
  };
}
async function linkedFictionalOpticalConversion(t: TestContext) {
  fictionalModel(t);
  const f = fixture(t);
  const literal = fictionalOpticalPeopleEnvelope().payload;
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-eyewear.txt',
    bytes: Buffer.from(literal),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional optical conversion' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Convert the fictional prescription',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  assert.ok(isNativeAssistantCheckpoint(chat.conversionCheckpoint));
  await call(bridge, 'intake_read', { id: item.id });
  const passage = await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: item.id });
  return { ...f, item, chat, bridge, literal, sourceTextRevisionId: passage.revisionId };
}

async function readFixtureTextUnit(bridge: TestBridge, intakeId: string, unitId: string) {
  let offset = 0;
  for (;;) {
    const window = await call<{
      unit: { id: string };
      text: string;
      offset: number;
      nextOffset: number | null;
      totalCharacters: number;
    }>(bridge, 'intake_plan', { id: intakeId, action: 'read_unit', unitId, offset });
    assert.equal(window.unit.id, unitId);
    assert.equal(window.offset, offset);
    assert.equal(typeof window.text, 'string');
    if (window.nextOffset === null) {
      assert.equal(offset + window.text.length, window.totalCharacters);
      return;
    }
    assert.ok(window.nextOffset > offset && window.nextOffset < window.totalCharacters);
    offset = window.nextOffset;
  }
}

async function linkedFictionalBatchConversion(
  t: TestContext,
  overrides: Partial<Omit<AssistantOptions, 'root' | 'databases'>> = {},
  sourceText = 'Fictional retained evidence: result 02.40 mg on 2026-02-04.',
  recordStorage?: VaultRecordStorage,
  initialRead: 'source' | 'first_unit' = 'source',
) {
  fictionalModel(t);
  const f = fixture(t, overrides, recordStorage);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-review-race.txt',
    bytes: Buffer.from(sourceText),
  });
  if (initialRead === 'first_unit') {
    const { extractIntakeSourceText } = await import('../intake-source-extraction.ts');
    const extraction = await extractIntakeSourceText({
      db: f.db,
      root: f.root,
      profileId: 'cedar',
      id: item.id,
      maxPages: 10,
    });
    assert.equal(extraction.morePending, false, 'the fictional source capture is complete');
  }
  const chat = f.assistant.create('cedar', { title: 'Fictional review race' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Prepare the fictional result for review',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  await call(bridge, 'intake_plan', {
    id: item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
  });
  const plan = selectedFixturePlan(f.db, f.root, 'cedar', item.id);
  if (initialRead === 'first_unit') await readFixtureTextUnit(bridge, item.id, plan.units[0]!.id);
  else await call(bridge, 'intake_read', { id: item.id });
  // Both contributor and encrypted runtimes retain durable source text. Read
  // its actual passages and carry the returned revision into the proposal.
  const sourceTextRevisionId = (
    await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: item.id })
  ).revisionId;
  if (initialRead === 'first_unit')
    assert.equal(selectedPending(f, item.id, chat).length, 0, 'the first unit has no unread tail');
  const batch = {
    id: item.id,
    ...(sourceTextRevisionId ? { sourceTextRevisionId } : {}),
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
    planId: plan.id,
    operationId: 'fictional-review-race-batch',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-review-race-result',
      kind: 'record',
      payload: { literal: 'Fictional retained evidence: result 02.40 mg on 2026-02-04.' },
      provenance: {
        capturedVia: 'Fictional text fixture',
        sourceSystem: 'Fictional source',
        sourceRecordId: 'fictional-review-race-result',
        evidenceClass: 'transcription',
        locator: 'fictional line 1',
      },
      coverage: { status: 'partial', notes: ['The source remains subject to user review.'] },
      clinical: {
        kind: 'observation',
        subject: 'unknown',
        testLabel: 'Fictional review race result',
        valueText: '02.40',
        unit: 'mg',
        date: '2026-02-04',
      },
    }),
    summary: 'Fictional reviewable result; no record is accepted.',
    coverage: [
      {
        unitId: plan.units[0]!.id,
        kind: 'inspected',
        notes: 'The literal fictional source was read; clinical review remains separate.',
      },
    ],
  };
  return { ...f, item, chat, bridge, batch, plan };
}

test('host source capture advances multi-page reads without waiving fresh passages or human revision guards', async (t) => {
  const f = await linkedFictionalBatchConversion(
    t,
    {},
    'Fictional retained section. '.repeat(2500),
    encryptedRecordStorage(t),
  );
  const { getIntakeSourceText, reviewIntakeSourceText } = await import('../intake-source-text.ts');
  const first = getIntakeSourceText(f.db, f.root, 'cedar', f.item.id).revision!;
  assert.ok(first.issues.some((issue) => issue.id === 'p3-pending'));
  await assert.doesNotReject(async () => f.bridge.callbacks.beforeRequest?.());
  await call(f.bridge, 'intake_read', { id: f.item.id, offset: 12000 });
  const next = getIntakeSourceText(f.db, f.root, 'cedar', f.item.id).revision!;
  assert.notEqual(next.id, first.id);
  assert.ok(!next.issues.some((issue) => issue.id === 'p3-pending'));
  await assert.doesNotReject(async () => f.bridge.callbacks.beforeRequest?.());
  await call(f.bridge, 'intake_source_text', { id: f.item.id, revisionId: next.id });
  await assert.doesNotReject(async () => f.bridge.callbacks.beforeRequest?.());
  reviewIntakeSourceText(
    f.db,
    f.root,
    'cedar',
    f.item.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: next.id,
      sourceHash: next.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'human-correction',
          text: 'Fictional corrected source.',
          provenance: 'human',
          region: { page: 1 },
        },
      ],
    },
    'fictional-owner',
  );
  await assert.rejects(async () => f.bridge.callbacks.beforeRequest?.(), /Source text changed/);
});

test('host source capture cannot rebase a human correction that preceded its next page read', async (t) => {
  const f = await linkedFictionalBatchConversion(
    t,
    {},
    'Fictional retained section. '.repeat(3500),
    encryptedRecordStorage(t),
  );
  const { getIntakeSourceText, reviewIntakeSourceText } = await import('../intake-source-text.ts');
  const first = getIntakeSourceText(f.db, f.root, 'cedar', f.item.id).revision!;
  const corrected = reviewIntakeSourceText(
    f.db,
    f.root,
    'cedar',
    f.item.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: first.id,
      sourceHash: first.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'human-correction',
          text: 'Fictional human correction before the next page.',
          provenance: 'human',
          region: { page: 1 },
        },
      ],
    },
    'fictional-owner',
  );
  await call(f.bridge, 'intake_read', { id: f.item.id, offset: 12000 });
  const next = getIntakeSourceText(f.db, f.root, 'cedar', f.item.id).revision!;
  assert.notEqual(next.id, corrected.revision!.id);
  assert.deepEqual(
    next.spans.filter((span) => span.region.page === 1),
    corrected.revision!.spans.filter((span) => span.region.page === 1),
  );
  await assert.rejects(async () => f.bridge.callbacks.beforeRequest?.(), /Source text changed/);
});

test('host source capture does not substitute for reading the new durable passage before proposing', async (t) => {
  const f = await linkedFictionalBatchConversion(
    t,
    {},
    'Fictional retained section. '.repeat(2500),
    encryptedRecordStorage(t),
  );
  const { getIntakeSourceText } = await import('../intake-source-text.ts');
  await call(f.bridge, 'intake_read', { id: f.item.id, offset: 12000 });
  const next = getIntakeSourceText(f.db, f.root, 'cedar', f.item.id).revision!;
  await assert.doesNotReject(async () => f.bridge.callbacks.beforeRequest?.());
  await assert.rejects(
    call(f.bridge, 'intake_propose', {
      id: f.item.id,
      sourceTextRevisionId: next.id,
      version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
      summary: 'Fictional current proposal',
      jsonlText: f.batch.jsonlText,
    }),
    (error: unknown) => hasCode(error, 'SOURCE_TEXT_CHANGED'),
  );
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 0);
});

for (const extension of ['txt', 'json'])
  test(`host source capture advances a retained ZIP ${extension} member without losing the next-request guard`, async (t) => {
    fictionalModel(t);
    const f = fixture(t, {}, encryptedRecordStorage(t));
    const source = uploadIntake(f.db, f.root, 'cedar', {
      filename: 'fictional-long-member.zip',
      bytes: zipFixture([
        {
          name: `fictional-member.${extension}`,
          data:
            extension === 'json'
              ? JSON.stringify({ literal: 'Fictional retained member. '.repeat(2500) })
              : 'Fictional retained member. '.repeat(2500),
        },
      ]),
    });
    f.assistant.create('cedar', { message: 'Inspect the fictional archive' });
    await tick();
    const bridge = f.bridges[0];
    const inventory = await call(bridge, 'intake_package', { id: source.id, action: 'inventory' });
    const memberId = inventory.members[0].memberId;
    const first = await call<{ sourceFileId: string; sourceText: { revisionId: string } }>(
      bridge,
      'intake_package',
      {
        id: source.id,
        action: 'read_member',
        memberId,
      },
    );
    const { getIntakeSourceText } = await import('../intake-source-text.ts');
    const initial = getIntakeSourceText(f.db, f.root, 'cedar', first.sourceFileId).revision!;
    assert.equal(first.sourceText.revisionId, initial.id);
    assert.ok(
      initial.issues.some((issue) => issue.id === 'p3-pending'),
      'one member read captures at most two pages',
    );
    const read = await call<{ revisionId: string }>(bridge, 'intake_source_text', {
      id: first.sourceFileId,
    });
    await call(bridge, 'intake_package', {
      id: source.id,
      action: 'read_member',
      memberId,
      offset: 12000,
    });
    const current = getIntakeSourceText(f.db, f.root, 'cedar', first.sourceFileId).revision!;
    assert.notEqual(current.id, read.revisionId);
    assert.ok(!current.issues.some((issue) => /^p\d+-pending$/.test(issue.id)));
    await assert.doesNotReject(async () => bridge.callbacks.beforeRequest?.());
  });

test('default-on diagnostics retain the precise wrapped batch validation failure without document text', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: false });
  t.after(() => diagnostics.close());
  const f = await linkedFictionalBatchConversion(t, { diagnostics });
  const phase = beginImportPhase(
    'model_tool',
    { toolName: 'health_intake_batch' },
    {
      profileId: 'cedar',
      importId: f.item.id,
      runId: f.chat.id,
    },
    diagnostics,
  );
  await assert.rejects(
    phase.run(async () => {
      try {
        await call(f.bridge, 'intake_batch', {
          ...f.batch,
          jsonlText: JSON.stringify({
            format: 'health-record-v1',
            id: 'fictional-private-id',
            kind: 'record',
            payload: { text: 'FICTIONAL_MEDICAL_VALUE_MUST_NOT_EXPORT' },
          }),
        });
      } catch (error) {
        phase.fail(error);
        throw error;
      }
    }),
    (error: unknown) => hasCode(error, 'INVALID_JSONL'),
  );
  const exported = diagnostics.exportSnapshot('cedar');
  const failure = exported
    .recentPerformance!.operations.map((op) => op.latestValidationFailure)
    .find((entry) => entry?.fields.toolName === 'health_intake_batch');
  assert.equal(failure?.fields.reasonCode, 'invalid_jsonl');
  assert.equal(failure?.fields.errorType, 'model_tool_validation');
  assert.equal(failure?.fields.validationCode, 'invalid_provenance');
  assert.equal(failure?.fields.validationPath, 'arguments.jsonlText[].provenance');
  assert.equal(failure?.fields.validationLine, 1);
  assert.doesNotMatch(
    JSON.stringify(exported),
    /FICTIONAL_MEDICAL_VALUE_MUST_NOT_EXPORT|fictional-private-id/,
  );
});

test('always-on document-level yield counter tracks proposals produced, unset diagnostics included, and survives a reload', async (t) => {
  const previous = process.env.CRS_IMPORT_DIAGNOSTICS;
  delete process.env.CRS_IMPORT_DIAGNOSTICS;
  t.after(() => {
    if (previous === undefined) delete process.env.CRS_IMPORT_DIAGNOSTICS;
    else process.env.CRS_IMPORT_DIAGNOSTICS = previous;
  });
  const f = await linkedFictionalBatchConversion(t);
  assert.equal(process.env.CRS_IMPORT_DIAGNOSTICS, undefined);
  assert.equal(required(f.chat.reading).proposalsProduced, 0);

  await call(f.bridge, 'intake_batch', f.batch);
  assert.equal(required(f.chat.reading).proposalsProduced, 1);
  assert.equal(
    readTestChat(f.root, 'cedar', f.chat.id).reading?.proposalsProduced,
    1,
    'the counter survives being written to and read back from the journal',
  );
});

test('replaying a batch submission with the same operationId does not double count proposalsProduced', async (t) => {
  const f = await linkedFictionalBatchConversion(t);
  await call(f.bridge, 'intake_batch', f.batch);
  assert.equal(required(f.chat.reading).proposalsProduced, 1);
  const versionAfterFirstSubmit = getIntakeRead(f.db, f.root, 'cedar', f.item.id).version;

  // Same operationId, same fingerprint (the batch's own fields are unchanged) —
  // submitIntakeBatch short-circuits to the existing intake without creating a
  // second plan.batches entry, per intake.ts's replay handling. The stale
  // `version` field on the replayed args is not itself a problem: the replay
  // check runs before the version check.
  await call(f.bridge, 'intake_batch', f.batch);
  assert.equal(
    required(f.chat.reading).proposalsProduced,
    1,
    'a replayed batch operation must not be counted as a second proposal',
  );
  assert.equal(
    getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
    versionAfterFirstSubmit,
    'the replay made no new change to the intake',
  );
});

test('a chat journal saved before the new counters existed still loads, with the counters absent rather than rejected', async (t) => {
  const f = await linkedFictionalOpticalConversion(t);
  assert.ok(required(f.chat.reading).distinctReads! >= 1);
  const saved = structuredClone(readTestChat(f.root, 'cedar', f.chat.id)) as AssistantChat & {
    reading: Record<string, unknown>;
  };
  delete saved.reading.distinctReads;
  delete saved.reading.proposalsProduced;
  writeChat(f.root, 'cedar', saved, 'simulated-pre-task-6-journal');
  const restarted = createAssistant({ root: f.root, databases: f.databases, ...f.options });
  t.after(() => restarted.close());
  const recovered = restarted.get('cedar', f.chat.id);
  assert.equal(recovered.reading?.distinctReads, undefined);
  assert.equal(recovered.reading?.proposalsProduced, undefined);
});

test('a reading snapshot saved under the pre-rename pagesProcessed name still loads', async (t) => {
  const f = await linkedFictionalOpticalConversion(t);
  const saved = structuredClone(readTestChat(f.root, 'cedar', f.chat.id)) as AssistantChat & {
    reading: Record<string, unknown>;
  };
  // What a journal written before the rename looks like: the old key with a real count
  // and no `distinctReads` at all. The validator must accept it rather than rejecting
  // the whole reading snapshot over a name it has never seen.
  saved.reading.pagesProcessed = saved.reading.distinctReads;
  delete saved.reading.distinctReads;
  writeChat(f.root, 'cedar', saved, 'simulated-pre-rename-journal');
  const restarted = createAssistant({ root: f.root, databases: f.databases, ...f.options });
  t.after(() => restarted.close());
  const recovered = restarted.get('cedar', f.chat.id);
  assert.ok(recovered.reading, 'the pre-rename reading snapshot still loads');
  assert.equal(recovered.reading?.distinctReads, undefined);
});

test('a reading snapshot whose distinctReads is present but not a number is rejected', async (t) => {
  const f = await linkedFictionalOpticalConversion(t);
  const saved = structuredClone(readTestChat(f.root, 'cedar', f.chat.id)) as AssistantChat & {
    reading: Record<string, unknown>;
  };
  // The half of the rename the accepting test above cannot reach: that one deletes
  // `distinctReads`, so the pre-rename clause (`pagesProcessed` is a number) and the
  // renamed clause (`distinctReads` is absent) both accept it and it passes either
  // way. Only a present-but-non-number value distinguishes them — and only under the
  // renamed clause is it rejected.
  (saved.reading as Record<string, unknown>).distinctReads = 'seven';
  writeChat(f.root, 'cedar', saved, 'simulated-corrupt-distinct-reads-journal');
  const restarted = createAssistant({ root: f.root, databases: f.databases, ...f.options });
  t.after(() => restarted.close());
  assert.throws(() => restarted.get('cedar', f.chat.id), /invalid chat/);
});

async function eligibleCountedAcceptanceRace(
  t: TestContext,
  beforeBatchRevalidationRetry: NonNullable<AssistantOptions['beforeBatchRevalidationRetry']>,
  beforeBasis?: (value: {
    db: ReturnType<typeof openDatabase>;
    root: string;
    item: ReturnType<typeof uploadIntake>;
    plan: IntakeWorkflow['plans'][number];
    bridge: TestBridge;
    mutateSelected: (
      changes: Parameters<
        typeof import('../intake-envelope-mutation.ts').prepareIntakeEnvelopeMutation
      >[2]['changes'],
      incrementVersion?: boolean,
    ) => Promise<void>;
  }) => void | Promise<void>,
  recordStorage?: VaultRecordStorage,
) {
  const { acceptIntakeReportSelectionAsync } = await import('../intake-report-acceptance.ts');
  const { buildIntakeCollectionEnvelope } = await import('../intake-envelope-build.ts');
  const { prepareRetainedPlanAccess } = await import('../intake-retained-plan.ts');
  const { linkIntakeConversionRead, intakeTransaction } = await import('../intake.ts');
  const { prepareIntakeEnvelopeMutation } = await import('../intake-envelope-mutation.ts');
  const sourceText =
    'Fictional accepted result 02.40 mg on 2026-02-04. ' +
    'first-section filler '.repeat(700) +
    'Fictional later result 09.70 mg on 2026-02-09. ' +
    'second-section filler '.repeat(700);
  fictionalModel(t);
  let retryCount = 0;
  const base = fixture(
    t,
    {
      beforeBatchRevalidationRetry(context) {
        retryCount++;
        return beforeBatchRevalidationRetry(context);
      },
    },
    recordStorage,
  );
  const item = uploadIntake(base.db, base.root, 'cedar', {
    filename: 'fictional-retained-plan-race.txt',
    bytes: Buffer.from(sourceText),
  });
  // These source-pointer races cover a real persisted expanded plan upgraded
  // to native authority. Generated direct-v2 units have no mutable child pointer.
  await createIntakePlan(base.db, base.root, 'cedar', item.id, {
    version: item.version,
    operationId: 'fictional-retained-race-plan',
  });
  const { extractIntakeSourceText } = await import('../intake-source-extraction.ts');
  const extraction = await extractIntakeSourceText({
    db: base.db,
    root: base.root,
    profileId: 'cedar',
    id: item.id,
    maxPages: 10,
  });
  assert.equal(extraction.morePending, false, 'the fictional source capture is complete');
  await buildIntakeCollectionEnvelope(base.db, { id: item.id });
  await prepareRetainedPlanAccess(base.db, 'cedar', item.id);
  const plan = selectedFixtureValue<IntakeWorkflow['plans']>(base.db, item.id, [
    'intake',
    'workflow',
    'plans',
  ]).find((entry) => entry.status === 'active')!;
  assert.ok(plan);
  const mutateSelected = async (
    changes: Parameters<typeof prepareIntakeEnvelopeMutation>[2]['changes'],
    incrementVersion = false,
  ) => {
    const reader = openIntakeCollectionEnvelope(base.db, { id: item.id });
    const operationId = randomUUID();
    const prepared = await prepareIntakeEnvelopeMutation(
      base.db,
      { id: item.id },
      {
        reader,
        changes,
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: intakeSourceVersion(base.db, item.id).rawVersion + Number(incrementVersion),
      },
    );
    assert.ok(prepared.prepared);
    const compact = prepared.projectDetailsJson!({ bytes: 128 * 1024 });
    intakeTransaction(
      base.db,
      () => {
        selectedEnvelopeStore(base.db, { id: item.id }).collections.stage(prepared.prepared!);
        base.db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(compact, item.id);
      },
      {},
    );
    await prepareRetainedPlanAccess(base.db, 'cedar', item.id);
  };
  const chat = base.assistant.create('cedar', { title: 'Fictional retained-plan review race' });
  await linkIntakeConversionRead(base.db, base.root, 'cedar', item.id, chat.id);
  base.assistant.send('cedar', chat.id, {
    message: 'Prepare the fictional result for review',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, base, chat);
  assert.ok(bridge.prompt.conversion);
  await readFixtureTextUnit(bridge, item.id, plan.units[0]!.id);
  const passage = await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: item.id });
  const batch = {
    id: item.id,
    ...(passage.revisionId ? { sourceTextRevisionId: passage.revisionId } : {}),
    version: getIntakeRead(base.db, base.root, 'cedar', item.id).version,
    planId: plan.id,
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-accepted-result',
      kind: 'document',
      payload: { literal: 'Fictional accepted result 02.40 mg on 2026-02-04.' },
      provenance: {
        capturedVia: 'Fictional text fixture',
        sourceSystem: 'Fictional source',
        sourceRecordId: 'fictional-accepted-result',
        evidenceClass: 'transcription',
        locator: plan.units[0]!.locator,
      },
      coverage: { status: 'partial', notes: ['The source remains subject to user review.'] },
      clinical: {
        kind: 'document',
        subject: 'self',
        documentTitle: 'Fictional accepted result',
        date: '2026-02-04',
      },
    }),
    summary: 'Fictional reviewable document; no record is accepted.',
  };
  const f = { ...base, item, chat, bridge, batch, plan, mutateSelected };
  assert.ok(plan.units.length >= 2);
  await call(f.bridge, 'intake_batch', {
    ...f.batch,
    operationId: 'fictional-accepted-basis-batch',
    coverage: [
      {
        unitId: plan.units[0]!.id,
        kind: 'extracted',
        notes: 'The first fictional section was read and retained.',
      },
    ],
  });
  const proposal = required(
    selectedFixtureValue<IntakeProposal[]>(f.db, f.item.id, ['intake', 'proposals'])[0],
  );
  let review = await selectedFixtureReview(f.db, f.root, 'cedar', f.item.id, proposal.id);
  await call(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'read_unit',
    unitId: plan.units[1]!.id,
  });
  await beforeBasis?.(f);
  if (beforeBasis)
    review = await selectedFixtureReview(f.db, f.root, 'cedar', f.item.id, proposal.id);
  await f.bridge.callbacks.onEvent('model/requestStarted', { turnId: 'fictional-delayed-batch' });
  const preparedVersion = getIntakeRead(f.db, f.root, 'cedar', f.item.id).version;
  const secondBatch = {
    id: f.item.id,
    ...(f.batch.sourceTextRevisionId ? { sourceTextRevisionId: f.batch.sourceTextRevisionId } : {}),
    version: preparedVersion,
    planId: plan.id,
    operationId: 'fictional-later-section-batch',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-later-result',
      kind: 'record',
      payload: { literal: 'Fictional later result 09.70 mg on 2026-02-09.' },
      provenance: {
        capturedVia: 'Fictional text fixture',
        sourceSystem: 'Fictional source',
        sourceRecordId: 'fictional-later-result',
        evidenceClass: 'transcription',
        locator: plan.units[1]!.locator,
      },
      coverage: { status: 'partial', notes: ['The source remains subject to user review.'] },
      clinical: {
        kind: 'observation',
        subject: 'unknown',
        testLabel: 'Fictional later result',
        valueText: '09.70',
        unit: 'mg',
        date: '2026-02-09',
      },
    }),
    summary: 'Fictional later section retained for review; no record is accepted.',
    coverage: [
      {
        unitId: plan.units[1]!.id,
        kind: 'extracted' as const,
        notes: 'The second fictional section was read and retained.',
      },
    ],
  };
  await acceptIntakeReportSelectionAsync(f.db, f.root, 'cedar', {
    operationId: 'bb82469a-1cd4-44b3-88d4-d8e60d228482',
    blocks: [
      {
        intakeId: f.item.id,
        intakeVersion: review.version,
        proposalId: proposal.id,
        reviewToken: review.reviewToken,
        selections: review.records.map((record) => ({
          recordId: record.id,
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          mapping: record.mapping,
        })),
      },
    ],
  });
  const accepted = selectedFixtureValue<NonNullable<IntakeWorkflow['reportAcceptances']>>(
    f.db,
    f.item.id,
    ['intake', 'workflow', 'reportAcceptances'],
  );
  assert.equal(accepted.length, 1);
  assert.equal(sqlNumber(f.db.prepare('SELECT count(*) n FROM documents').get(), 'n'), 1);
  const acceptance = accepted[0]!;
  const receipt = required(
    f.db
      .prepare('SELECT fingerprint,result_json FROM __record_transactions WHERE operation_id=?')
      .get(acceptance.receipt.operationId),
  );
  assert.equal(receipt.fingerprint, acceptance.fingerprint);
  assert.deepEqual(JSON.parse(String(receipt.result_json)), acceptance.receipt);
  const assertAcceptanceRetained = (db = f.db, expectedReceipt: unknown = acceptance.receipt) => {
    assert.equal(retryCount, 1, 'the race ran after native counted-acceptance proof exactly once');
    assert.deepEqual(
      selectedFixtureValue(db, f.item.id, ['intake', 'workflow', 'reportAcceptances']),
      accepted,
    );
    assert.equal(sqlNumber(db.prepare('SELECT count(*) n FROM documents').get(), 'n'), 1);
    assert.equal(sqlNumber(db.prepare('SELECT count(*) n FROM observations').get(), 'n'), 0);
    const retainedReceipt = required(
      db
        .prepare('SELECT fingerprint,result_json FROM __record_transactions WHERE operation_id=?')
        .get(acceptance.receipt.operationId),
    );
    assert.equal(retainedReceipt.fingerprint, acceptance.fingerprint);
    assert.deepEqual(JSON.parse(String(retainedReceipt.result_json)), expectedReceipt);
  };
  return { ...f, secondBatch, preparedVersion, assertAcceptanceRetained };
}

test('a user review during model work requires a fresh plan before the same batch can remain pending', async (t) => {
  const f = await linkedFictionalBatchConversion(t);
  const asked = await askIntakeQuestionRead(f.db, f.root, 'cedar', f.item.id, {
    version: f.batch.version,
    operationId: 'fictional-question-before-model-work',
    key: 'fictional-user-review-question',
    prompt: 'Did the fictional reviewer inspect the displayed source evidence?',
    locator: 'fictional line 1',
  });
  f.batch.version = asked.version;
  const questionView = openIntakeCollectionEnvelope(f.db, { id: f.item.id }),
    questionWorkflow = required(
      questionView.child(required(questionView.child(questionView.root(), 'intake')), 'workflow'),
    ),
    question = required(
      questionView.childAt(
        questionWorkflow,
        'questions',
        questionView.childCount(questionWorkflow, 'questions') - 1,
      ),
    ),
    questionId = questionView.field(question, 'id', { bytes: 8192 });
  assert.ok(questionId.kind === 'value' && typeof questionId.value === 'string');
  await answerIntakeQuestionRead(f.db, f.root, 'cedar', f.item.id, {
    version: f.batch.version,
    operationId: 'fictional-user-review-answer',
    questionId: questionId.value,
    answer: 'Yes, the fictional reviewer inspected the displayed source evidence.',
  });

  await assert.rejects(call(f.bridge, 'intake_batch', f.batch), (error: unknown) => {
    assert.equal(error instanceof Error && error.name, 'ModelToolValidationError');
    assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
    assert.match(error instanceof Error ? error.message : '', /health_intake_plan action "read"/);
    assert.match(error instanceof Error ? error.message : '', /accepted history/);
    assert.match(
      error instanceof Error ? error.message : '',
      /same operationId only for an exact retry/,
    );
    return true;
  });
  assert.equal(f.chat.status, 'running');
  assert.equal(f.bridge.closed, false);
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 0);
  assert.ok(selectedWorkflowHasOperation(f.db, f.item.id, 'fictional-user-review-answer'));
  assert.ok(!selectedWorkflowHasOperation(f.db, f.item.id, f.batch.operationId));
  assert.equal(sqlNumber(f.db.prepare('SELECT count(*) n FROM observations').get(), 'n'), 0);

  const refreshed = await call<NativeModelContext>(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'read',
    freshStart: true,
    section: 'units',
    offset: 0,
  });
  assert.equal(refreshed.format, 'health-intake-model-context-v2');
  assert.equal(refreshed.section, 'units');
  assertNativeModelPins(refreshed.pins);
  assert.equal(refreshed.pins.sourceId, f.item.id);
  assert.equal(refreshed.pins.sourceHash, f.item.sha256);
  assert.equal(refreshed.pins.version, getIntakeRead(f.db, f.root, 'cedar', f.item.id).version);
  await call(f.bridge, 'intake_batch', { ...f.batch, version: refreshed.pins.version });

  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 1);
  assert.ok(selectedWorkflowHasOperation(f.db, f.item.id, f.batch.operationId));
  assert.equal(sqlNumber(f.db.prepare('SELECT count(*) n FROM observations').get(), 'n'), 0);
  assert.equal(sqlNumber(f.db.prepare('SELECT count(*) n FROM source_records').get(), 'n'), 0);
  f.assistant.cancel('cedar', f.chat.id);
});

// Real encrypted acceptance, deferred reading, replay and database reconstruction;
// the synthetic model has no network latency. The complete host proof takes ~39s.
test(
  'one host request retains an exact later-unit batch across disjoint counted acceptance',
  { timeout: 90_000 },
  async (t) => {
    const { acceptIntakeReportSelectionAsync } = await import('../intake-report-acceptance.ts');
    const retryInputs: unknown[] = [];
    const recordStorage = encryptedRecordStorage(t);
    const printedSubject = 'Patient: Fictional Rowan Cedar';
    const sourceText =
      printedSubject +
      '\n' +
      'Fictional retained evidence: result 02.40 mg on 2026-02-04. ' +
      'Fictional companion result 04.60 mg on 2026-02-06. ' +
      'first-section filler '.repeat(700) +
      printedSubject +
      '\n' +
      'Fictional retained evidence: result 02.40 mg on 2026-02-04. ' +
      'second-section filler '.repeat(700);
    const f = await linkedFictionalBatchConversion(
      t,
      {
        beforeBatchRevalidationRetry({ intakeId, batchInput }) {
          retryInputs.push({ id: intakeId, ...structuredClone(batchInput) });
        },
      },
      sourceText,
      recordStorage,
      'first_unit',
    );
    const plan = selectedFixturePlan(f.db, f.root, 'cedar', f.item.id);
    const snapshot = () => ({
      version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
      proposals: selectedFixtureValue<IntakeProposal[]>(f.db, f.item.id, ['intake', 'proposals']),
      candidates: selectedFixtureValue<IntakeWorkflow['candidates']>(f.db, f.item.id, [
        'intake',
        'workflow',
        'candidates',
      ]),
      acceptances: selectedFixtureValue<NonNullable<IntakeWorkflow['reportAcceptances']>>(
        f.db,
        f.item.id,
        ['intake', 'workflow', 'reportAcceptances'],
      ),
      workflowHash: selectedFixtureHash(f.db, f.item.id, ['intake', 'workflow']),
    });
    assert.ok(plan.units.length >= 2);

    const scopedFirst = JSON.parse(f.batch.jsonlText);
    scopedFirst.payload = { ...scopedFirst.payload, patient: printedSubject };
    scopedFirst.clinical.subject = 'self';
    scopedFirst.report = {
      key: 'fictional-first-section-report',
      title: 'Fictional first section report',
      anchor: { locator: plan.units[0]!.locator, text: 'Fictional retained evidence' },
      subject: { locator: plan.units[0]!.locator, text: printedSubject },
    };
    f.batch.jsonlText = JSON.stringify(scopedFirst);

    const firstBatch = {
      ...f.batch,
      operationId: 'fictional-first-section-batch',
      coverage: [
        {
          unitId: plan.units[0]!.id,
          kind: 'extracted' as const,
          notes: 'The first fictional source section was read and retained for review.',
        },
      ],
      jsonlText:
        f.batch.jsonlText +
        '\n' +
        JSON.stringify({
          format: 'health-record-v1',
          id: 'fictional-companion-result',
          kind: 'record',
          payload: { literal: 'Fictional companion result 04.60 mg on 2026-02-06.' },
          provenance: {
            capturedVia: 'Fictional text fixture',
            sourceSystem: 'Fictional source',
            sourceRecordId: 'fictional-companion-result',
            evidenceClass: 'transcription',
            locator: plan.units[0]!.locator,
          },
          coverage: { status: 'partial', notes: ['The source remains subject to user review.'] },
          clinical: {
            kind: 'observation',
            subject: 'unknown',
            testLabel: 'Fictional companion result',
            valueText: '04.60',
            unit: 'mg',
            date: '2026-02-06',
          },
        }),
    };
    await call(f.bridge, 'intake_batch', firstBatch);
    const firstProposal = required(
      selectedFixtureValue<IntakeProposal[]>(f.db, f.item.id, ['intake', 'proposals'])[0],
    );
    const reportGroups = selectedFixtureValue<NonNullable<IntakeWorkflow['reportGroups']>>(
      f.db,
      f.item.id,
      ['intake', 'workflow', 'reportGroups'],
    );
    const scope = await getIntakeIdentityScope(
      f.db,
      f.root,
      'cedar',
      f.item.id,
      reportGroups.find((group) => group.basis === 'report_anchor')!.id,
    );
    await confirmIntakeIdentityScope(f.db, f.root, 'cedar', f.item.id, {
      version: scope.intakeVersion,
      operationId: 'fictional-disjoint-source-confirm',
      scope,
      outcome: 'this_is_me',
      attestation: 'reviewed_original_and_membership',
    });
    const firstReview = await selectedFixtureReview(
      f.db,
      f.root,
      'cedar',
      f.item.id,
      firstProposal.id,
    );

    const seenBeforeDeferredRead = required(f.chat.reading?.readWindows);
    await f.bridge.callbacks.onTool({
      tool: 'health_intake_plan',
      arguments: { id: f.item.id, action: 'read_unit', unitId: plan.units[1]!.id },
      callId: 'fictional-deferred-later-unit',
      deferReadConsumption: true,
    });
    assert.equal(f.chat.reading?.readWindows, seenBeforeDeferredRead);
    assert.ok(
      selectedPending(f, f.item.id, f.chat).some(
        (window) => window.args.unitId === plan.units[1]!.id,
      ),
    );
    const modelRequestsBefore = required(required(f.chat.reading).modelRequests);
    await f.bridge.callbacks.onEvent('model/requestStarted', { turnId: 'fictional-delayed-batch' });
    const preparedVersion = getIntakeRead(f.db, f.root, 'cedar', f.item.id).version;
    const secondBatch = {
      id: f.item.id,
      ...(f.batch.sourceTextRevisionId
        ? { sourceTextRevisionId: f.batch.sourceTextRevisionId }
        : {}),
      version: preparedVersion,
      planId: plan.id,
      operationId: 'fictional-second-section-batch',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-review-race-result',
        kind: 'record',
        payload: {
          literal: 'Fictional retained evidence: result 02.40 mg on 2026-02-04.',
          patient: printedSubject,
        },
        provenance: {
          capturedVia: 'Fictional text fixture',
          sourceSystem: 'Fictional source',
          sourceRecordId: 'fictional-review-race-result',
          evidenceClass: 'transcription',
          locator: plan.units[1]!.locator,
        },
        report: {
          key: 'fictional-second-section-report',
          title: 'Fictional second section report',
          anchor: {
            locator: plan.units[1]!.locator,
            text: 'Fictional retained evidence',
          },
          subject: { locator: plan.units[1]!.locator, text: printedSubject },
        },
        coverage: { status: 'partial', notes: ['The source remains subject to user review.'] },
        clinical: {
          kind: 'observation',
          subject: 'self',
          testLabel: 'Fictional review race result',
          valueText: '02.40',
          unit: 'mg',
          date: '2026-02-04',
        },
      }),
      summary: 'Fictional second section retained for review; no record is accepted.',
      coverage: [
        {
          unitId: plan.units[1]!.id,
          kind: 'extracted' as const,
          notes: 'The second fictional source section was read and retained for review.',
        },
      ],
    };

    await acceptIntakeReportSelectionAsync(f.db, f.root, 'cedar', {
      operationId: '3aa606b6-87f4-4665-9536-a224b16180c5',
      blocks: [
        {
          intakeId: f.item.id,
          intakeVersion: firstReview.version,
          proposalId: firstProposal.id,
          reviewToken: firstReview.reviewToken,
          selections: firstReview.records.map((record) => ({
            recordId: record.id,
            candidateId: record.candidateId!,
            candidateVersionId: record.candidateVersionId!,
            mapping: record.draft?.mapping || {},
          })),
        },
      ],
    });
    const accepted = snapshot();
    assert.ok(accepted.version > preparedVersion);
    assert.equal(accepted.acceptances.length, 1);
    assert.equal(accepted.candidates.length, 2);
    assert.ok(
      accepted.candidates.every((candidate) => candidate.versions[0]!.status === 'accepted'),
    );
    const acceptanceEntry = required(accepted.acceptances.at(-1));
    const acceptanceTransaction = required(
      f.db
        .prepare(
          'SELECT sequence,fingerprint,result_json FROM __record_transactions WHERE operation_id=?',
        )
        .get(acceptanceEntry.receipt.operationId),
    ) as { sequence: number; fingerprint: string; result_json: string };
    assert.equal(acceptanceTransaction.fingerprint, acceptanceEntry.fingerprint);
    assert.deepEqual(JSON.parse(acceptanceTransaction.result_json), acceptanceEntry.receipt);
    assert.equal(acceptanceTransaction.sequence, durabilitySequence(f.db));
    const acceptanceSequence = acceptanceTransaction.sequence;

    // The provider response consumes the earlier read before dispatching its batch.
    // This host-only checkpoint change must not invalidate the frozen source/version
    // basis; every actual user/source change still needs the existing exact proof.
    await f.bridge.callbacks.onEvent('model/toolResultsConsumed', {
      callIds: ['fictional-deferred-later-unit'],
    });
    assert.ok(required(f.chat.reading?.readWindows) > seenBeforeDeferredRead);
    assert.ok(
      !selectedPending(f, f.item.id, f.chat).some(
        (window) => window.args.unitId === plan.units[1]!.id,
      ),
    );

    const overlappingBatch = {
      ...secondBatch,
      operationId: 'fictional-overlapping-accepted-candidate-batch',
      jsonlText: f.batch.jsonlText,
    };
    await assert.rejects(call(f.bridge, 'intake_batch', overlappingBatch), (error: unknown) => {
      assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
      return true;
    });
    assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 1);
    assert.ok(!selectedWorkflowHasOperation(f.db, f.item.id, overlappingBatch.operationId));

    await call(f.bridge, 'intake_batch', secondBatch);

    const retained = snapshot();
    assert.equal(f.bridges.length, 1);
    // The source revision is a host admission pin, not a submitted batch field.
    // Preserve exact equality for every retained batch field and separately prove
    // that the resulting proposal remains bound to the very same source revision.
    const { sourceTextRevisionId, ...secondBatchPayload } = secondBatch;
    assert.ok(sourceTextRevisionId);
    assert.deepEqual(retryInputs, [{ ...secondBatchPayload, runId: f.chat.id }]);
    assert.equal(retained.proposals.at(-1)!.sourceTextRevisionId, sourceTextRevisionId);
    assert.equal(required(f.chat.reading).modelRequests, modelRequestsBefore + 1);
    assert.equal(retained.proposals.length, 2);
    assert.equal(retained.candidates.length, 3);
    assert.equal(retained.version, accepted.version + 1, 'exactly one batch changes public state');
    assert.deepEqual(retained.acceptances, accepted.acceptances);
    assert.equal(retained.candidates[0]!.versions[0]!.status, 'accepted');
    assert.equal(retained.candidates[1]!.versions[0]!.status, 'accepted');
    assert.equal(retained.candidates[2]!.versions[0]!.status, 'pending');
    assert.notEqual(retained.candidates[0]!.id, retained.candidates[2]!.id);
    assert.equal(
      selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units[1]!.status,
      'completed',
    );
    assert.equal(
      selectedFixtureValue<Array<{ id: string }>>(f.db, f.item.id, [
        'intake',
        'workflow',
        'operations',
      ]).filter((operation) => operation.id === secondBatch.operationId).length,
      1,
    );
    const retainedBatchOperation = required(
      selectedFixtureValue<Array<{ id: string; fingerprint: string }>>(f.db, f.item.id, [
        'intake',
        'workflow',
        'operations',
      ]).find((operation) => operation.id === secondBatch.operationId),
    );
    // Native read checkpoints and index preparation also have durable journals.
    // Bind the single business publication to its exact retained request fingerprint.
    const batchTransactions = (db: ReturnType<typeof openDatabase>) =>
      db
        .prepare(
          'SELECT operation_id,sequence,fingerprint,result_json FROM __record_transactions WHERE fingerprint=? AND sequence>? ORDER BY sequence',
        )
        .all(retainedBatchOperation.fingerprint, acceptanceSequence);
    const transactions = batchTransactions(f.db);
    assert.equal(transactions.length, 1);
    const batchTransaction = required(transactions[0]);
    assert.ok(sqlNumber(batchTransaction, 'sequence') > acceptanceSequence);
    assert.ok(sqlNumber(batchTransaction, 'sequence') <= durabilitySequence(f.db));
    assert.equal(sqlNumber(f.db.prepare('SELECT count(*) n FROM observations').get(), 'n'), 2);
    const retainedReview = await selectedFixtureReview(
      f.db,
      f.root,
      'cedar',
      f.item.id,
      retained.proposals[1]!.id,
    );
    assert.equal(retainedReview.records[0]!.classification, 'duplicate');
    await call(f.bridge, 'intake_batch', secondBatch);
    const replayed = snapshot();
    assert.equal(replayed.version, retained.version, 'replay makes no new public mutation');
    assert.deepEqual(batchTransactions(f.db), transactions, 'replay retains the exact transaction');
    assert.equal(replayed.proposals.length, 2);
    assert.equal(
      selectedFixtureValue<Array<{ id: string }>>(f.db, f.item.id, [
        'intake',
        'workflow',
        'operations',
      ]).filter((operation) => operation.id === secondBatch.operationId).length,
      1,
    );
    assert.deepEqual(replayed.acceptances, accepted.acceptances);
    assert.deepEqual(
      getIntakeOriginal(f.db, f.root, 'cedar', f.item.id).bytes,
      Buffer.from(sourceText),
    );

    const destination = resolve(f.root, 'rebuilt-batch-revalidation');
    ensureProfileDirectories(destination, 'cedar');
    const { rebuildRecordDatabase } = await import('../record-versions.ts');
    rebuildRecordDatabase(profilePaths(destination, 'cedar').database, {
      profileId: 'cedar',
      storage: recordStorage,
    });
    const rebuilt = openDatabase(profilePaths(destination, 'cedar').database, 'cedar');
    try {
      attachPersonalDurability(rebuilt, {
        root: destination,
        profileId: 'cedar',
        recordStorage,
      });
      assert.equal(proposalCount(rebuilt, destination, 'cedar', f.item.id), 2);
      assert.deepEqual(batchTransactions(rebuilt), transactions);
      assert.equal(
        selectedFixtureHash(rebuilt, f.item.id, ['intake', 'workflow']),
        retained.workflowHash,
      );
      assert.equal(sqlNumber(rebuilt.prepare('SELECT count(*) n FROM observations').get(), 'n'), 2);
    } finally {
      rebuilt.close();
    }
    f.assistant.cancel('cedar', f.chat.id);
  },
);

// Each real native acceptance/race fixture takes 17–29s, including retained
// authority checks; independent host guards keep one case from timing out its siblings.
{
  const operations = (race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>) =>
    selectedFixtureValue<Array<{ id: string }>>(race.db, race.item.id, [
      'intake',
      'workflow',
      'operations',
    ]).map((operation) => operation.id);
  const assertRejectedBatch = (
    race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>,
    expectedReceipt?: unknown,
  ) => {
    assert.equal(proposalCount(race.db, race.root, 'cedar', race.item.id), 1);
    assert.ok(!selectedWorkflowHasOperation(race.db, race.item.id, race.secondBatch.operationId));
    race.assertAcceptanceRetained(race.db, expectedReceipt);
  };
  test(
    'counted-acceptance revalidation: a second CAS change is never retried twice',
    { timeout: 90_000 },
    async (t) => {
      let race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>;
      race = await eligibleCountedAcceptanceRace(t, async () => {
        const { updateIntakeMetadataRead } = await import('../intake.ts');
        await updateIntakeMetadataRead(race.db, race.root, 'cedar', race.item.id, {
          version: getIntakeRead(race.db, race.root, 'cedar', race.item.id).version,
          operationId: 'fictional-second-cas-change',
          metadata: { careArea: 'Fictional concurrent review' },
        });
      });
      await assert.rejects(
        call(race.bridge, 'intake_batch', race.secondBatch),
        (error: unknown) => {
          assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
          return true;
        },
      );
      assertRejectedBatch(race);
      assert.equal(
        selectedFixtureValue<IntakeWorkflow['plans']>(race.db, race.item.id, [
          'intake',
          'workflow',
          'plans',
        ])[0]!.units[1]!.status,
        'pending',
      );
    },
  );

  test(
    'counted-acceptance revalidation: Stop prevents the eligible retry',
    { timeout: 90_000 },
    async (t) => {
      let race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>;
      race = await eligibleCountedAcceptanceRace(t, () => {
        race.assistant.cancel('cedar', race.chat.id);
      });
      await assert.rejects(call(race.bridge, 'intake_batch', race.secondBatch));
      assertRejectedBatch(race);
    },
  );

  test(
    'counted-acceptance revalidation: database replacement prevents the eligible retry',
    { timeout: 90_000 },
    async (t) => {
      let race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>;
      race = await eligibleCountedAcceptanceRace(t, () => {
        race.databases.set('cedar', required(race.databases.get('cookie-dough')));
      });
      await assert.rejects(
        call(race.bridge, 'intake_batch', race.secondBatch),
        (error: unknown) => {
          assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
          return true;
        },
      );
      race.databases.set('cedar', race.db);
      assertRejectedBatch(race);
    },
  );

  test(
    'counted-acceptance revalidation: a replacement model request generation prevents the eligible retry',
    { timeout: 90_000 },
    async (t) => {
      let race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>;
      race = await eligibleCountedAcceptanceRace(t, async () => {
        await race.bridge.callbacks.onEvent('model/requestStarted', {
          turnId: 'fictional-replacement-model-request',
        });
      });
      await assert.rejects(
        call(race.bridge, 'intake_batch', race.secondBatch),
        (error: unknown) => {
          assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
          return true;
        },
      );
      assertRejectedBatch(race);
    },
  );

  test(
    'counted-acceptance revalidation: changed plan pins and unit state prevent the eligible retry',
    { timeout: 90_000 },
    async (t) => {
      let race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>;
      race = await eligibleCountedAcceptanceRace(t, async () => {
        const before = intakeSourceVersion(race.db, race.item.id);
        await race.mutateSelected(function* (view) {
          const intake = required(view.child(view.root(), 'intake'));
          const workflow = required(view.child(intake, 'workflow'));
          const plan = required(view.find('plan', workflow, race.plan.id));
          const pins = required(view.child(plan, 'pins'));
          const unit = required(view.childAt(plan, 'units', 1));
          yield {
            op: 'set',
            record: pins,
            field: 'model',
            jsonText: '"fictional-changed-model-pin"',
          };
          yield {
            op: 'set',
            record: unit,
            field: 'memberId',
            jsonText: '"fictional-changed-member"',
          };
          yield { op: 'set', record: unit, field: 'status', jsonText: '"completed"' };
          yield {
            op: 'append',
            record: unit,
            field: 'attempts',
            jsonText: '"fictional-concurrent-unit"',
          };
        });
        const after = intakeSourceVersion(race.db, race.item.id);
        assert.equal(after.version, before.version, 'the pin/unit corruption does not bump CAS');
        assert.notEqual(after.logicalBinding, before.logicalBinding);
        const changed = selectedFixtureValue<IntakeWorkflow['plans']>(race.db, race.item.id, [
          'intake',
          'workflow',
          'plans',
        ])[0]!;
        assert.equal(changed.pins.model, 'fictional-changed-model-pin');
        assert.equal(changed.units[1]!.memberId, 'fictional-changed-member');
        assert.equal(changed.units[1]!.status, 'completed');
        assert.ok(changed.units[1]!.attempts.includes('fictional-concurrent-unit'));
      });
      await assert.rejects(
        call(race.bridge, 'intake_batch', race.secondBatch),
        (error: unknown) => {
          assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
          return true;
        },
      );
      assertRejectedBatch(race);
    },
  );

  test(
    'counted-acceptance revalidation: durability uncertainty prevents the eligible retry',
    { timeout: 90_000 },
    async (t) => {
      const storage = encryptedRecordStorage(t);
      let race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>;
      race = await eligibleCountedAcceptanceRace(
        t,
        async ({ db }) => {
          const publish = storage.publishHead;
          storage.publishHead = (bytes) => {
            publish(bytes);
            if (selectedWorkflowHasOperation(db, race.item.id, 'fictional-lost-ack-question'))
              throw Error('Fictional accepted head acknowledgement lost');
          };
          try {
            await assert.rejects(
              () =>
                askIntakeQuestionRead(db, race.root, 'cedar', race.item.id, {
                  version: getIntakeRead(db, race.root, 'cedar', race.item.id).version,
                  operationId: 'fictional-lost-ack-question',
                  key: 'fictional-lost-ack-question',
                  prompt: 'Fictional accepted question with missing acknowledgement',
                  locator: 'fictional source',
                }),
              /accepted head acknowledgement lost/,
            );
          } finally {
            storage.publishHead = publish;
          }
        },
        undefined,
        storage,
      );
      await assert.rejects(call(race.bridge, 'intake_batch', race.secondBatch), {
        code: 'VERSION_CONFLICT',
      });
      assert.equal(personalDurabilityStatus(race.db).dirty, true);
      const { rebuildRecordDatabase } = await import('../record-versions.ts');
      const path = resolve(race.root, 'fictional-recovered-race.sqlite');
      rebuildRecordDatabase(path, { profileId: 'cedar', storage });
      const recovered = openDatabase(path, 'cedar');
      try {
        attachPersonalDurability(recovered, { profileId: 'cedar', recordStorage: storage });
        assert.equal(proposalCount(recovered, race.root, 'cedar', race.item.id), 1);
        assert.ok(
          !selectedWorkflowHasOperation(recovered, race.item.id, race.secondBatch.operationId),
        );
        assert.ok(
          selectedWorkflowHasOperation(recovered, race.item.id, 'fictional-lost-ack-question'),
        );
        race.assertAcceptanceRetained(recovered);
      } finally {
        recovered.close();
      }
    },
  );

  test(
    'counted-acceptance revalidation: a mismatched durable acceptance transaction refuses the retry',
    { timeout: 90_000 },
    async (t) => {
      let race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>;
      race = await eligibleCountedAcceptanceRace(
        t,
        ({ db }) => {
          const acceptance = required(
            selectedFixtureValue<NonNullable<IntakeWorkflow['reportAcceptances']>>(
              db,
              race.item.id,
              ['intake', 'workflow', 'reportAcceptances'],
            ).at(-1),
          );
          db.prepare('UPDATE __record_transactions SET result_json=? WHERE operation_id=?').run(
            '{}',
            acceptance.receipt.operationId,
          );
        },
        undefined,
        encryptedRecordStorage(t),
      );
      await assert.rejects(
        call(race.bridge, 'intake_batch', race.secondBatch),
        (error: unknown) => {
          assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
          return true;
        },
      );
      assertRejectedBatch(race, {});
    },
  );

  test(
    'counted-acceptance revalidation: a newly occupied operation ID prevents the eligible retry',
    { timeout: 90_000 },
    async (t) => {
      let race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>;
      race = await eligibleCountedAcceptanceRace(t, async () => {
        const before = intakeSourceVersion(race.db, race.item.id);
        await race.mutateSelected(function* (view) {
          const intake = required(view.child(view.root(), 'intake'));
          const workflow = required(view.child(intake, 'workflow'));
          yield {
            op: 'append',
            record: workflow,
            field: 'operations',
            jsonText: JSON.stringify({
              id: race.secondBatch.operationId,
              fingerprint: 'fictional-other-request-fingerprint',
              at: '2026-02-10T00:00:00.000Z',
            }),
          };
        });
        const after = intakeSourceVersion(race.db, race.item.id);
        assert.equal(after.version, before.version, 'the occupied ID does not bump CAS');
        assert.notEqual(after.logicalBinding, before.logicalBinding);
        assert.equal(
          operations(race).filter((id) => id === race.secondBatch.operationId).length,
          1,
        );
      });
      await assert.rejects(
        call(race.bridge, 'intake_batch', race.secondBatch),
        (error: unknown) => {
          assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
          return true;
        },
      );
      assert.equal(proposalCount(race.db, race.root, 'cedar', race.item.id), 1);
      race.assertAcceptanceRetained();
      assert.equal(operations(race).filter((id) => id === race.secondBatch.operationId).length, 1);
    },
  );

  test(
    'counted-acceptance revalidation: a stale materialized child hash and size refuse the retry',
    { timeout: 90_000 },
    async (t) => {
      let childPath = '';
      let race: Awaited<ReturnType<typeof eligibleCountedAcceptanceRace>>;
      race = await eligibleCountedAcceptanceRace(
        t,
        ({ db }) => {
          const changed = Buffer.from('Changed fictional child source bytes.');
          writeFileSync(childPath, changed);
          transaction(db, () =>
            db.prepare('UPDATE source_files SET sha256=@sha256,bytes=@bytes WHERE id=@id').run({
              sha256: createHash('sha256').update(changed).digest('hex'),
              bytes: changed.length,
              id: required(
                selectedFixtureValue<IntakeWorkflow['plans']>(db, race.item.id, [
                  'intake',
                  'workflow',
                  'plans',
                ])[0]!.units[1]!.sourceFileId,
              ),
            }),
          );
        },
        async (prepared) => {
          const { ensureNativeIntakeSchema } = await import('../intake.ts');
          const { indexIntakeEvidence } = await import('../intake-evidence.ts');
          const childBytes = Buffer.from('Original fictional child source bytes.');
          const child = required(
            retainIntakeChildren(prepared.db, prepared.root, 'cedar', prepared.item.id, [
              {
                filename: 'fictional-materialized-child.txt',
                locator: 'fictional member 2',
                bytes: childBytes,
              },
            ])[0],
          );
          const childIndex = await indexIntakeEvidence({
            db: prepared.db,
            root: prepared.root,
            profileId: 'cedar',
            id: child.id,
          });
          await ensureNativeIntakeSchema(prepared.db, 'cedar', child.id);
          const childIntake = getIntakeRead(prepared.db, prepared.root, 'cedar', child.id);
          assert.ok(isIntakeSummary(childIntake));
          await prepared.mutateSelected(function* (view) {
            const intake = required(view.child(view.root(), 'intake'));
            const workflow = required(view.child(intake, 'workflow'));
            const plan = required(view.find('plan', workflow, prepared.plan.id));
            const index = required(view.child(plan, 'index'));
            const unit = required(view.childAt(plan, 'units', 1));
            if (view.has(index, 'members')) assert.equal(view.childCount(index, 'members'), 0);
            // Expanded retained units require the same real child occurrence in
            // their delivery index before it can be selected or read.
            yield {
              op: 'set',
              record: index,
              field: 'members',
              jsonText: JSON.stringify([
                {
                  memberId: 'fictional-retained-child-occurrence',
                  ordinal: 0,
                  filename: 'fictional-materialized-child.txt',
                  locator: 'fictional member 2',
                  sourceFileId: child.id,
                  sourceHash: childIntake.sha256,
                  bytes: childIntake.bytes,
                  compressedBytes: childIntake.bytes,
                  duplicateOf: null,
                  index: childIndex,
                },
              ]),
            };
            yield {
              op: 'set',
              record: unit,
              field: 'sourceFileId',
              jsonText: JSON.stringify(child.id),
            };
            yield {
              op: 'set',
              record: unit,
              field: 'sourceHash',
              jsonText: JSON.stringify(childIntake.sha256),
            };
            yield {
              op: 'set',
              record: unit,
              field: 'bytes',
              jsonText: JSON.stringify(childIntake.bytes),
            };
            yield { op: 'set', record: unit, field: 'start', jsonText: '0' };
            yield { op: 'set', record: unit, field: 'end', jsonText: String(childBytes.length) };
          }, true);
          await readFixtureTextUnit(prepared.bridge, prepared.item.id, prepared.plan.units[1]!.id);
          childPath = getRetainedIntakeOriginalReference(
            prepared.db,
            prepared.root,
            'cedar',
            child.id,
          ).path;
        },
      );
      await assert.rejects(
        call(race.bridge, 'intake_batch', race.secondBatch),
        (error: unknown) => {
          assert.equal(hasCode(error, 'VERSION_CONFLICT'), true);
          return true;
        },
      );
      assertRejectedBatch(race);
    },
  );
}

// Four real native read/question/CAS/batch cycles take ~43s locally; exact cycle counts remain the oracle.
test(
  'four distinct durable batch cycles replenish only the local consecutive-stale budget',
  { timeout: 90_000 },
  async (t) => {
    const sourceText = Array.from(
      { length: 4 },
      (_, index) =>
        `Fictional retained result 0${index + 1}.40 mg. ` + 'fictional filler '.repeat(560),
    ).join('');
    const f = await linkedFictionalBatchConversion(t, {}, sourceText, undefined, 'first_unit');
    assert.equal(f.plan.units.length, 4);

    for (const [index, unit] of f.plan.units.entries()) {
      await call(f.bridge, 'intake_plan', {
        id: f.item.id,
        action: 'read_unit',
        unitId: unit.id,
      });
      const beforeReview = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
      const beforeContext = await call<NativeModelContext>(f.bridge, 'intake_plan', {
        id: f.item.id,
        action: 'read',
        freshStart: true,
        section: 'operations',
        offset: 0,
      });
      assertNativeModelPins(beforeContext.pins);
      const beforeCursor = firstModelRecordCursor(beforeContext);
      const batch = {
        ...f.batch,
        version: beforeReview.version,
        operationId: `fictional-durable-cycle-${index}`,
        jsonlText: JSON.stringify({
          format: 'health-record-v1',
          id: `fictional-durable-cycle-result-${index}`,
          kind: 'record',
          payload: { literal: `Fictional retained result 0${index + 1}.40 mg.` },
          provenance: {
            capturedVia: 'Fictional text fixture',
            sourceSystem: null,
            sourceRecordId: `fictional-durable-cycle-result-${index}`,
            evidenceClass: 'transcription',
            locator: unit.locator,
          },
          coverage: { status: 'partial', notes: ['The source remains subject to user review.'] },
          clinical: {
            kind: 'observation',
            subject: 'unknown',
            testLabel: `Fictional durable cycle result ${index + 1}`,
            valueText: `0${index + 1}.40`,
            unit: 'mg',
            date: `2026-02-0${index + 1}`,
          },
        }),
        summary: `Fictional reviewable cycle ${index + 1}; no record is accepted.`,
        coverage: [
          {
            unitId: unit.id,
            kind: 'extracted',
            notes: `Fictional unit ${index + 1} was read and retained for review.`,
          },
        ],
      };
      await askIntakeQuestionRead(f.db, f.root, 'cedar', f.item.id, {
        version: beforeReview.version,
        operationId: `fictional-durable-cycle-review-${index}`,
        key: `fictional-durable-cycle-question-${index}`,
        prompt: `Did the fictional reviewer inspect unit ${index + 1}?`,
        locator: unit.locator,
      });

      await assert.rejects(call(f.bridge, 'intake_batch', batch), {
        name: 'ModelToolValidationError',
        code: 'VERSION_CONFLICT',
      });
      assert.equal(f.chat.status, 'running');
      await assert.rejects(
        call(f.bridge, 'intake_plan', {
          id: f.item.id,
          action: 'read',
          section: 'operations',
          cursor: beforeCursor,
          version: beforeContext.pins.version,
          mappingVersion: beforeContext.pins.mappingVersion,
        }),
        { name: 'ModelToolValidationError', code: 'MODEL_CONTEXT_CHANGED' },
      );
      const refreshed = await call<NativeModelContext>(f.bridge, 'intake_plan', {
        id: f.item.id,
        action: 'read',
        freshStart: true,
        section: 'units',
        offset: 0,
      });
      assertNativeModelPins(refreshed.pins);
      await call(f.bridge, 'intake_batch', { ...batch, version: refreshed.pins.version });
      assert.equal(f.chat.status, 'running');
    }

    const retained = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
    assert.ok(isIntakeSummary(retained));
    assert.equal(retained.collections.proposals.total, 4);
    assert.equal(retained.collections.candidates.total, 4);
    assert.ok(
      selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units.every(
        (unit) => unit.status === 'completed',
      ),
    );
    assert.equal(sqlNumber(f.db.prepare('SELECT count(*) n FROM observations').get(), 'n'), 0);
    f.assistant.cancel('cedar', f.chat.id);
  },
);

test('configuration change and uncertain batch publication remain terminal without replay', async (t) => {
  const { saveMappingRule } = await import('../clinical-import.ts');
  const { transaction } = await import('../database.ts');
  const configured = await linkedFictionalBatchConversion(t);
  transaction(configured.db, () =>
    saveMappingRule(
      configured.db,
      configured.item.providerId,
      {
        match: { kind: 'observation', label: 'Fictional review race result' },
        set: { testLabel: 'Fictional reviewed result label' },
      },
      'fictional-config-change-before-batch',
    ),
  );
  await assert.rejects(call(configured.bridge, 'intake_batch', configured.batch), {
    code: 'EXTRACTION_CONFIG_CHANGED',
  });
  assert.equal(configured.chat.status, 'idle');
  assert.equal(required(configured.chat.reading).reason, 'tool_error');
  assert.equal(proposalCount(configured.db, configured.root, 'cedar', configured.item.id), 0);

  const storage = encryptedRecordStorage(t);
  const uncertain = await linkedFictionalBatchConversion(t, {}, undefined, storage);
  const publish = storage.publishHead;
  let lostBatchAcknowledgment = false;
  storage.publishHead = (bytes) => {
    publish(bytes);
    const batchPublished = selectedWorkflowHasOperation(
      uncertain.db,
      uncertain.item.id,
      uncertain.batch.operationId,
    );
    if (batchPublished) {
      lostBatchAcknowledgment = true;
      throw new Error('Fictional publication acknowledgement was unavailable');
    }
  };
  await assert.rejects(
    call(uncertain.bridge, 'intake_batch', uncertain.batch),
    /publication acknowledgement was unavailable/,
  );
  storage.publishHead = publish;
  assert.equal(
    lostBatchAcknowledgment,
    true,
    'failure follows the domain batch, not auxiliary preparation',
  );
  assert.equal(uncertain.chat.status, 'idle');
  assert.equal(required(uncertain.chat.reading).reason, 'tool_error');
  assert.equal(personalDurabilityStatus(uncertain.db).dirty, true);
  const { rebuildRecordDatabase } = await import('../record-versions.ts');
  const path = resolve(uncertain.root, 'fictional-recovered-batch.sqlite');
  rebuildRecordDatabase(path, { profileId: 'cedar', storage });
  const recovered = openDatabase(path, 'cedar');
  try {
    attachPersonalDurability(recovered, { profileId: 'cedar', recordStorage: storage });
    const retained = getIntakeRead(recovered, uncertain.root, 'cedar', uncertain.item.id);
    assert.ok(isIntakeSummary(retained));
    assert.equal(retained.durability?.pending, false);
    assert.equal(retained.collections.proposals.total, 1);
    assert.equal(
      selectedFixtureValue<Array<{ id: string }>>(recovered, uncertain.item.id, [
        'intake',
        'workflow',
        'operations',
      ]).filter((operation) => operation.id === uncertain.batch.operationId).length,
      1,
    );
    assert.equal(sqlNumber(recovered.prepare('SELECT count(*) n FROM observations').get(), 'n'), 0);
    await assert.rejects(
      call(uncertain.bridge, 'intake_batch', uncertain.batch),
      /no longer running/,
    );
    assert.equal(
      selectedFixtureValue<Array<{ id: string }>>(recovered, uncertain.item.id, [
        'intake',
        'workflow',
        'operations',
      ]).filter((operation) => operation.id === uncertain.batch.operationId).length,
      1,
    );
  } finally {
    recovered.close();
  }
});

// Three durable host contexts plus encrypted recovery/private-trace assertions take ~44s locally.
test(
  'stale batch repair is finite across successful reads and operation conflicts never rewrite work',
  { timeout: 90_000 },
  async (t) => {
    const traceBase = realpathSync(
      mkdtempSync(resolve(tmpdir(), 'health-assistant-terminal-trace-')),
    );
    const traceRoot = join(traceBase, 'trace');
    const grantFile = join(traceBase, 'grant.json');
    mkdirSync(traceRoot, { mode: 0o700 });
    chmodSync(traceRoot, 0o700);
    writeFileSync(
      grantFile,
      JSON.stringify({
        profileId: 'cedar',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
      { mode: 0o600 },
    );
    chmodSync(grantFile, 0o600);
    const privateTrace = createPrivateImportTrace({
      directory: traceRoot,
      grantFile,
      acknowledged: true,
    });
    const traceStatus = privateTrace.status('cedar');
    assert.equal(traceStatus.enabled, true, traceStatus.reason ?? 'private trace is enabled');
    const diagnostics = createImportDiagnostics({ enabled: true, privateTrace });
    t.after(() => {
      diagnostics.close();
      rmSync(traceBase, { recursive: true, force: true });
    });
    const f = await linkedFictionalBatchConversion(t, { diagnostics });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const current = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
      await askIntakeQuestionRead(f.db, f.root, 'cedar', f.item.id, {
        version: current.version,
        operationId: `fictional-concurrent-review-${attempt}`,
        key: `fictional-concurrent-question-${attempt}`,
        prompt: `Fictional concurrent review question ${attempt}`,
        locator: 'fictional line 1',
      });
      await assert.rejects(call(f.bridge, 'intake_batch', f.batch), {
        name: 'ModelToolValidationError',
        code: 'VERSION_CONFLICT',
      });
      assert.equal(f.chat.status, attempt < 3 ? 'running' : 'idle');
      if (attempt < 3) {
        const refreshed = await call<NativeModelContext>(f.bridge, 'intake_plan', {
          id: f.item.id,
          action: 'read',
          freshStart: true,
          section: 'units',
          offset: 0,
        });
        assertNativeModelPins(refreshed.pins);
        await call(f.bridge, 'intake_batch', {
          ...f.batch,
          version: refreshed.pins.version,
          operationId: `fictional-inspected-noop-${attempt}`,
          jsonlText: JSON.stringify({
            format: 'health-record-v1',
            id: 'fictional-inspected-context',
            kind: 'context',
            payload: { literal: 'Fictional context only; no candidate version is produced.' },
            provenance: {
              capturedVia: 'Fictional text fixture',
              sourceSystem: null,
              sourceRecordId: null,
              evidenceClass: 'unknown',
              locator: f.plan.units[0]!.locator,
            },
            coverage: { status: 'partial', notes: ['No extraction claim is made.'] },
          }),
          summary: 'Fictional inspected-only batch with no candidate or accounted-unit progress.',
          coverage: [
            {
              unitId: f.plan.units[0]!.id,
              kind: 'inspected',
              notes: 'The source was inspected without a retained extraction disposition.',
            },
          ],
        });
      }
    }
    assert.equal(required(f.chat.reading).reason, 'tool_error');
    assert.equal(f.bridge.closed, true);
    const stalled = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
    assert.ok(isIntakeSummary(stalled));
    assert.equal(
      stalled.collections.proposals.total,
      1,
      'the repeated context payload is retained once',
    );
    assert.equal(stalled.collections.candidates.total, 0);
    assert.equal(
      selectedFixturePlan(f.db, f.root, 'cedar', f.item.id).units[0]!.coverage?.kind,
      'inspected',
    );
    assert.ok(!selectedWorkflowHasOperation(f.db, f.item.id, f.batch.operationId));
    assert.equal(sqlNumber(f.db.prepare('SELECT count(*) n FROM observations').get(), 'n'), 0);
    assert.equal(privateTrace.status('cedar').recordedEvents, 1);
    const outputDirectory = join(traceRoot, readdirSync(traceRoot)[0]!);
    const terminalTrace = JSON.parse(
      gunzipSync(readFileSync(join(outputDirectory, readdirSync(outputDirectory)[0]!))).toString(),
    ) as {
      event: string;
      payload: { tool: string; failed: boolean; result: Record<string, unknown> };
    };
    assert.equal(terminalTrace.event, 'tool.response');
    assert.equal(terminalTrace.payload.tool, 'health_intake_batch');
    assert.equal(terminalTrace.payload.failed, true);
    assert.deepEqual(terminalTrace.payload.result, {
      name: 'HttpError',
      code: 'VERSION_CONFLICT',
      status: 409,
      message: 'This intake changed. Reload it before continuing.',
    });
    await assert.rejects(
      call(f.bridge, 'intake_plan', { id: f.item.id, action: 'read' }),
      /no longer running/,
    );
    assert.equal(
      privateTrace.status('cedar').recordedEvents,
      1,
      'a late callback after terminal close cannot append private trace data',
    );

    const extensionTool: HealthTool = {
      type: 'function',
      name: 'health_fictional_extension_failure',
      description: 'Exercise fictional extension failure redaction',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    };
    const privateExtensionDetail = 'fictional-extension-private-detail-must-not-be-retained';
    const extension = await linkedFictionalBatchConversion(t, {
      diagnostics,
      actionExtensions: {
        tools: [extensionTool],
        async call() {
          throw Object.assign(new Error(privateExtensionDetail), {
            code: privateExtensionDetail,
            status: 409,
          });
        },
      },
    });
    await assert.rejects(
      call(extension.bridge, 'fictional_extension_failure', { id: extension.item.id }),
      new RegExp(privateExtensionDetail),
    );
    assert.equal(extension.chat.status, 'idle');
    assert.equal(privateTrace.status('cedar').recordedEvents, 2);
    const privateEvents = readdirSync(outputDirectory).map((filename) =>
      JSON.parse(gunzipSync(readFileSync(join(outputDirectory, filename))).toString()),
    ) as Array<{
      payload: { tool: string; failed: boolean; result: Record<string, unknown> };
    }>;
    const extensionTrace = required(
      privateEvents.find((entry) => entry.payload.tool === extensionTool.name),
    );
    assert.deepEqual(extensionTrace.payload.result, {
      name: 'AssistantExtensionError',
      code: null,
      status: null,
      message: 'A scoped assistant extension rejected this request.',
    });
    assert.doesNotMatch(JSON.stringify(extensionTrace), new RegExp(privateExtensionDetail));

    const operation = await linkedFictionalBatchConversion(t);
    await call(operation.bridge, 'intake_batch', operation.batch);
    const afterFirst = getIntakeRead(operation.db, operation.root, 'cedar', operation.item.id);
    await assert.rejects(
      call(operation.bridge, 'intake_batch', {
        ...operation.batch,
        version: afterFirst.version,
        summary: 'A changed request must not reuse the fictional operation receipt.',
      }),
      { code: 'OPERATION_CONFLICT' },
    );
    const afterConflict = getIntakeRead(operation.db, operation.root, 'cedar', operation.item.id);
    assert.ok(isIntakeSummary(afterConflict));
    assert.equal(operation.chat.status, 'idle');
    assert.equal(required(operation.chat.reading).reason, 'tool_error');
    assert.equal(afterConflict.collections.proposals.total, 1);
    assert.equal(
      selectedFixtureValue<Array<{ id: string }>>(operation.db, operation.item.id, [
        'intake',
        'workflow',
        'operations',
      ]).filter((entry) => entry.id === operation.batch.operationId).length,
      1,
    );
    assert.equal(
      sqlNumber(operation.db.prepare('SELECT count(*) n FROM observations').get(), 'n'),
      0,
    );
  },
);

test('a malformed optical People envelope returns validation for repair without relaxing scope or accepting records', async (t) => {
  const f = await linkedFictionalOpticalConversion(t);
  assert.ok(isNativeAssistantCheckpoint(f.chat.conversionCheckpoint));
  const workflowBefore = selectedFixtureHash(f.db, f.item.id, ['intake', 'workflow']);
  const pendingBefore = structuredClone(selectedPending(f, f.item.id, f.chat));
  const readingBefore = structuredClone(f.chat.reading);
  assert.ok(readingBefore && (readingBefore.readWindows ?? 0) > 0);
  const proposal = {
    id: f.item.id,
    sourceTextRevisionId: f.sourceTextRevisionId,
    version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
    jsonlText: JSON.stringify(fictionalOpticalPeopleEnvelope()),
    summary: 'Fictional optical mapping and clinician',
  };
  await assert.rejects(call(f.bridge, 'intake_propose', proposal), {
    name: 'ModelToolValidationError',
    code: 'INVALID_JSONL',
    message: /Named People proposals require a report-scoped record envelope/,
  });
  assert.equal(f.chat.status, 'running');
  assert.equal(f.bridge.closed, false);
  assert.equal(f.chat.error, null);
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 0);
  assert.equal(getIntakeRead(f.db, f.root, 'cedar', f.item.id).version, proposal.version);
  assert.equal(selectedFixtureHash(f.db, f.item.id, ['intake', 'workflow']), workflowBefore);
  assert.deepEqual(selectedPending(f, f.item.id, f.chat), pendingBefore);
  for (const field of ['readWindows', 'distinctReads', 'modelRequests', 'turns'] as const)
    assert.equal(f.chat.reading?.[field], readingBefore[field]);
  const repaired = { ...fictionalOpticalPeopleEnvelope(), kind: 'record' };
  await call(f.bridge, 'intake_propose', { ...proposal, jsonlText: JSON.stringify(repaired) });
  assert.equal(f.chat.status, 'running');
  const current = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  const proposals = fixtureProposals(f.db, f.root, 'cedar', f.item.id);
  assert.equal(proposals.length, 1);
  const { reviewIntake } = await import('../intake.ts');
  const review = isIntakeSummary(current)
    ? await selectedFixtureReview(f.db, f.root, 'cedar', f.item.id, proposals[0]!.id)
    : reviewIntake(f.db, f.root, 'cedar', f.item.id, proposals[0]!.id);
  assert.equal(review.records[0]!.mapping.opticalPrescription?.eyes[0]?.sph?.valueText, '+01.25');
  assert.equal(required(f.db.prepare('SELECT count(*) n FROM documents').get()).n, 0);
  assert.equal(required(f.db.prepare('SELECT count(*) n FROM source_records').get()).n, 0);
  assert.deepEqual(
    getIntakeOriginal(f.db, f.root, 'cedar', f.item.id).bytes,
    Buffer.from(f.literal),
  );
  // A different stale write is terminal, even immediately after a repairable validation error.
  await assert.rejects(
    call(f.bridge, 'intake_propose', {
      ...proposal,
      jsonlText: JSON.stringify({ ...repaired, id: 'fictional-stale-result' }),
    }),
  );
  assert.equal(f.chat.status, 'idle');
  assert.equal(required(f.chat.reading).reason, 'tool_error');
  assert.ok(f.chat.error);
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 1);
});

test('three invalid conversion proposals pause with a durable actionable error even with intervening reads', async (t) => {
  const f = await linkedFictionalOpticalConversion(t);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(
      call(f.bridge, 'intake_propose', {
        id: f.item.id,
        sourceTextRevisionId: f.sourceTextRevisionId,
        version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
        jsonlText: JSON.stringify(fictionalOpticalPeopleEnvelope()),
        summary: 'Fictional invalid structure',
      }),
      { code: 'INVALID_JSONL' },
    );
    assert.equal(f.chat.status, attempt < 3 ? 'running' : 'idle');
    if (attempt < 3) await call(f.bridge, 'intake_read', { id: f.item.id });
  }
  assert.equal(f.bridge.closed, true);
  assert.equal(required(f.chat.reading).reason, 'tool_error');
  assert.match(
    required(f.chat.error),
    /Named People proposals require a report-scoped record envelope/,
  );
  assert.equal(readTestChat(f.root, 'cedar', f.chat.id).error, f.chat.error);
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 0);
  assert.equal(required(f.db.prepare('SELECT count(*) n FROM source_records').get()).n, 0);
});

test('successful current section reads reset only the finite model-context refresh budget', async (t) => {
  const f = await linkedFictionalOpticalConversion(t);
  await call(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
  });
  const created = await call<NativeModelContext>(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'read',
    freshStart: true,
    section: 'operations',
    offset: 0,
  });
  assertNativeModelPins(created.pins);
  const pins = created.pins;
  const cursor = firstModelRecordCursor(created);
  const staleRead = () =>
    call(f.bridge, 'intake_plan', {
      id: f.item.id,
      action: 'read',
      version: pins.version - 1,
      mappingVersion: pins.mappingVersion,
      section: 'operations',
      cursor,
    });
  for (const section of ['units', 'candidates', 'questions'] as const) {
    await assert.rejects(staleRead(), (error: unknown) => hasCode(error, 'MODEL_CONTEXT_CHANGED'));
    assert.equal(f.chat.status, 'running');
    const current = await call<NativeModelContext>(f.bridge, 'intake_plan', {
      id: f.item.id,
      action: 'read',
      freshStart: true,
      section,
      offset: 0,
    });
    assertNativeModelPins(current.pins);
    assert.deepEqual(current.pins, pins);
  }
  for (let refresh = 1; refresh <= 3; refresh++) {
    await assert.rejects(staleRead(), (error: unknown) => hasCode(error, 'MODEL_CONTEXT_CHANGED'));
    assert.equal(f.chat.status, refresh < 3 ? 'running' : 'idle');
  }
  assert.equal(required(f.chat.reading).reason, 'tool_error');
  assert.equal(f.bridge.closed, true);
});

test('new retained candidates continue a partially read window but exact proposal replay does not', async (t) => {
  fictionalModel(t);
  const f = fixture(t);
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-many-findings.txt',
    bytes: Buffer.from('Fictional multi-result source '.repeat(1800)),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional incremental extraction' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read this delivery',
    context: { intakeId: item.id },
  });
  await waitForConversionBridge(t, f, chat);
  await call(f.bridges[0], 'intake_read', { id: item.id });
  const propose = async (bridge: TestBridge, id: string) => {
    const sourceTextRevisionId = (
      await call<{ revisionId: string }>(bridge, 'intake_source_text', { id: item.id })
    ).revisionId;
    return call(bridge, 'intake_propose', {
      sourceTextRevisionId,
      id: item.id,
      version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
      summary: 'Fictional single result; more findings remain in this window',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id,
        kind: 'record',
        payload: { literal: 'Fictional finding 02.00 mg' },
        provenance: {
          capturedVia: null,
          sourceSystem: null,
          sourceRecordId: id,
          evidenceClass: 'transcription',
          locator: 'fictional current window',
        },
        coverage: { status: 'partial', notes: ['More fictional findings remain'] },
        clinical: {
          kind: 'observation',
          subject: 'unknown',
          testLabel: id,
          valueText: '02.00',
          unit: 'mg',
          date: '2026-02-04',
        },
      }),
    });
  };
  await propose(f.bridges[0], 'fictional-first');
  await complete(f.bridges[0]);
  await waitForConversionBridge(t, f, chat, 1);
  assert.equal(f.bridges.length, 2);
  await call(f.bridges[1], 'intake_read', { id: item.id });
  await propose(f.bridges[1], 'fictional-second');
  await complete(f.bridges[1]);
  await waitForConversionBridge(t, f, chat, 2);
  assert.equal(
    f.bridges.length,
    3,
    'new evidence mappings continue without advancing the source cursor',
  );
  assert.equal(f.bridges[2].prompt.conversion.retainedCandidateCount, 2);
  await propose(f.bridges[2], 'fictional-second');
  await complete(f.bridges[2]);
  await tick();
  assert.equal(f.bridges.length, 3, 'an exact repeated proposal cannot manufacture progress');
  assert.equal(required(chat.reading).reason, 'no_progress');
  assert.equal(required(chat.runs).length, 1, 'all continuations retain one bounded run budget');
  assert.equal(
    f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n,
    0,
    'extraction never accepts',
  );
});

async function linkedJSONPointerFixture(t: TestContext) {
  fictionalModel(t);
  const f = fixture(t);
  const path = resolve(f.root, 'fictional-pointer.zip');
  writeFileSync(
    path,
    zipFixture([{ name: 'records.json', data: '{"items":[{"value":"+01.20"}]}' }]),
  );
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-pointer.zip',
    bytes: readFileSync(path),
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional pointer recovery' });
  linkIntakeConversion(f.db, f.root, 'cedar', item.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read the fictional export',
    context: { intakeId: item.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  await call(bridge, 'intake_plan', {
    id: item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
  });
  const inventory = await call(bridge, 'intake_package', { id: item.id, action: 'inventory' });
  const args = { id: item.id, action: 'read_member', memberId: inventory.members[0].memberId };
  return { ...f, item, chat, bridge, args };
}

test('a missing JSON pointer can be corrected without ending conversion or weakening member scope', async (t) => {
  const f = await linkedJSONPointerFixture(t);
  await assert.rejects(call(f.bridge, 'intake_package', { ...f.args, jsonPointer: '/missing' }), {
    name: 'ModelToolValidationError',
    code: 'JSON_POINTER',
    message: /returned child pointer/,
  });
  assert.equal(f.chat.status, 'running');
  const corrected = await call(f.bridge, 'intake_package', { ...f.args, jsonPointer: '/items/0' });
  assert.match(corrected.structure.literal, /\+01\.20/);
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 0);
  await assert.rejects(
    call(f.bridge, 'intake_package', {
      ...f.args,
      memberId: 'member:not-supplied',
      jsonPointer: '/items',
    }),
  );
  assert.equal(f.chat.status, 'idle', 'a missing member remains a terminal scope error');
  assert.equal(required(f.chat.reading).reason, 'tool_error');
});

test('three missing JSON pointers pause even when successful reads occur between them', async (t) => {
  const f = await linkedJSONPointerFixture(t);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(
      call(f.bridge, 'intake_package', { ...f.args, jsonPointer: '/missing-' + attempt }),
      { code: 'JSON_POINTER' },
    );
    assert.equal(f.chat.status, attempt < 3 ? 'running' : 'idle');
    if (attempt < 3) await call(f.bridge, 'intake_package', { ...f.args, jsonPointer: '/items/0' });
  }
  assert.equal(required(f.chat.reading).reason, 'tool_error');
  assert.equal(f.bridge.closed, true);
  assert.match(required(f.chat.error), /JSON pointer/);
});

test('plan creation exposes host indexing while the tool is pending, then restores model wait', async (t) => {
  const f = await linkedFictionalOpticalConversion(t);
  const pending = call(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'create',
    version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
  });
  assert.equal(required(f.chat.reading).phase, 'indexing_source');
  assert.equal(readTestChat(f.root, 'cedar', f.chat.id).reading?.phase, 'indexing_source');
  await pending;
  assert.equal(required(f.chat.reading).phase, 'waiting_for_model');
  f.assistant.cancel('cedar', f.chat.id);
});

test('assistant clinical queries default to Self and can explicitly reach a Person clinical record', async (t) => {
  const { assistant, db, bridges } = fixture(t);
  const person = createNote(db, {
    kind: 'person',
    title: 'Rowan Example',
    person: { fullName: 'Rowan Example' },
  });
  db.exec(
    "INSERT INTO source_files(id,path,sha256,bytes) VALUES('family-file','fictional-family.json','fictional',1); INSERT INTO source_records(id,source_file_id,raw_json) VALUES('family-raw','family-file','{}')",
  );
  db.prepare(
    "INSERT INTO documents(id,source_record_id,title,extra_json) VALUES('family-doc','family-raw','Rowan fictional report',?)",
  ).run(JSON.stringify({ import: { personId: person.personId } }));
  assistant.create('cedar', { message: 'Read fictional family records' });
  await tick();
  const bridge = bridges[0];
  const queryTool = bridge.tools.find((item) => item.name === 'health_query');
  assert.ok(queryTool?.inputSchema.properties?.personId);
  const self = await call(bridge, 'query', { collection: 'documents' });
  assert.equal(self.data.length, 0);
  const family = await call<{ data: { id: string; personId: string }[] }>(bridge, 'query', {
    collection: 'documents',
    personId: person.personId,
  });
  assert.equal(family.data[0].id, 'family-doc');
  assert.equal(family.data[0].personId, person.personId);
  const detail = await call(bridge, 'read', { collection: 'documents', id: 'family-doc' });
  assert.equal(detail.personId, person.personId);
  complete(bridge);
});

test('default diagnostics explain stale batch refresh and repeated window stop without source identifiers', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: false });
  t.after(() => diagnostics.close());
  const f = await linkedFictionalBatchConversion(t, { diagnostics });
  const before = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  await askIntakeQuestionRead(f.db, f.root, 'cedar', f.item.id, {
    version: before.version,
    operationId: 'private-change-id',
    key: 'private-question-key',
    prompt: 'PRIVATE_FICTIONAL_MEDICAL_QUESTION',
    locator: 'PRIVATE_FICTIONAL_LOCATOR',
  });
  const after = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
  await assert.rejects(call(f.bridge, 'intake_batch', f.batch), (error: unknown) => {
    const facts = diagnosticFailureFields(error);
    assert.equal(facts.expectedVersion, f.batch.version);
    assert.equal(facts.currentVersion, after.version);
    assert.equal(facts.lastChangeCategory, 'question');
    assert.equal(facts.versionHistoryComplete, true);
    return hasCode(error, 'VERSION_CONFLICT');
  });
  await call(f.bridge, 'intake_plan', {
    id: f.item.id,
    action: 'read',
    freshStart: true,
    section: 'questions',
    offset: 0,
  });
  let stopped = false;
  for (let count = 0; count < 6; count++) {
    try {
      await call(f.bridge, 'intake_read', { id: f.item.id });
    } catch (error) {
      const facts = diagnosticFailureFields(error);
      assert.equal(facts.reasonCode, 'conversion_no_progress');
      assert.equal(facts.repeatedWindowCount, 3);
      assert.equal(facts.repeatedWindowLimit, 3);
      assert.equal(typeof facts.baselineReadWindows, 'number');
      assert.equal(typeof facts.windowOrdinal, 'number');
      stopped = true;
      break;
    }
  }
  assert.equal(stopped, true);
  const exported = diagnostics.exportSnapshot('cedar');
  const steps = exported.recentPerformance!.operations.flatMap(
    (operation) => operation.recoverySequence || [],
  );
  assert.ok(steps.some((step) => step.fields.recoveryAction === 'refresh_context'));
  assert.ok(steps.some((step) => step.fields.recoveryAction === 'context_read'));
  assert.ok(steps.some((step) => step.fields.repeatedWindowCount === 3));
  assert.doesNotMatch(
    JSON.stringify(exported),
    /PRIVATE_FICTIONAL|private-question-key|private-change-id/,
  );
});

test('throwing optional recovery diagnostics cannot fail a retained batch or bypass the repeated-read guard', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: false });
  t.after(() => diagnostics.close());
  const start = diagnostics.startActive.bind(diagnostics);
  diagnostics.startActive = (...args) => {
    const scope = start(...args);
    return {
      ...scope,
      record(event, fields, context) {
        if (fields?.recoveryAction) throw new Error('Fictional unavailable diagnostic sink');
        scope.record(event, fields, context);
      },
    };
  };
  const f = await linkedFictionalBatchConversion(t, { diagnostics });
  await call(f.bridge, 'intake_batch', f.batch);
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 1);
  let stopped = false;
  for (let count = 0; count < 6; count++) {
    try {
      await call(f.bridge, 'intake_read', { id: f.item.id });
    } catch (error) {
      assert.ok(hasCode(error, 'CONVERSION_NO_PROGRESS'));
      stopped = true;
      break;
    }
  }
  assert.equal(stopped, true);
  assert.equal(f.chat.reading?.reason, 'no_progress');
});

test('missing source revision pin is repairable before publication and reading continues', async (t) => {
  const f = await linkedFictionalBatchConversion(t, {}, undefined, encryptedRecordStorage(t));
  const { sourceTextRevisionId: _pin, ...missingPin } = f.batch;
  await assert.rejects(call(f.bridge, 'intake_batch', missingPin), (error: unknown) => {
    const facts = diagnosticFailureFields(error);
    assert.equal(facts.hasSuppliedSourceTextRevision, false);
    assert.equal(facts.suppliedSourceTextRevisionMatches, false);
    assert.equal(facts.currentSourceTextRead, true);
    assert.equal(facts.sourceTextChangedSinceRead, false);
    assert.equal(facts.sourceTextRepairable, true);
    return error instanceof ModelToolValidationError && error.code === 'SOURCE_TEXT_REQUIRED';
  });
  assert.equal(f.chat.status, 'running');
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 0);
  const passage = await call<{ revisionId: string }>(f.bridge, 'intake_source_text', {
    id: f.item.id,
  });
  const retained = await call<{
    version: number;
    proposalSourceText: ProposalSourceTextHandoff;
  }>(f.bridge, 'intake_batch', {
    ...f.batch,
    version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
    sourceTextRevisionId: passage.revisionId,
  });
  assert.equal(retained.proposalSourceText.currentRevisionId, passage.revisionId);
  assert.equal(retained.proposalSourceText.sourceTextRevisionId, passage.revisionId);
  assert.equal(retained.proposalSourceText.readRequired, false);
  assert.equal(f.chat.status, 'running');
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 1);
  await call(f.bridge, 'intake_batch', {
    ...f.batch,
    operationId: 'cookie-second-batch',
    version: retained.version,
    sourceTextRevisionId: retained.proposalSourceText.sourceTextRevisionId,
    jsonlText: JSON.stringify({ ...JSON.parse(f.batch.jsonlText), id: 'cookie-second-record' }),
  });
  assert.equal(f.chat.status, 'running');
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
});

test('source revision preflight repair has a finite budget even with successful intervening reads', async (t) => {
  const f = await linkedFictionalBatchConversion(t, {}, undefined, encryptedRecordStorage(t));
  const { sourceTextRevisionId: _pin, ...missingPin } = f.batch;
  for (let attempt = 0; attempt < 3; attempt++) {
    await call(f.bridge, 'intake_source_text', { id: f.item.id });
    await assert.rejects(
      call(f.bridge, 'intake_batch', missingPin),
      (error: unknown) =>
        error instanceof ModelToolValidationError && error.code === 'SOURCE_TEXT_REQUIRED',
    );
    assert.equal(f.chat.status, attempt < 2 ? 'running' : 'idle');
  }
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 0);
});

test('external text correction remains terminal even if the model supplies its new pin', async (t) => {
  const f = await linkedFictionalBatchConversion(t, {}, undefined, encryptedRecordStorage(t));
  const { getIntakeSourceText, reviewIntakeSourceText } = await import('../intake-source-text.ts');
  const prior = getIntakeSourceText(f.db, f.root, 'cedar', f.item.id).revision!;
  const updated = reviewIntakeSourceText(
    f.db,
    f.root,
    'cedar',
    f.item.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: prior.id,
      sourceHash: prior.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'cookie-correction',
          text: 'Cookie Doe corrected source.',
          provenance: 'human',
          region: { page: 1 },
        },
      ],
    },
    'fictional-owner',
  );
  await assert.rejects(
    call(f.bridge, 'intake_batch', {
      ...f.batch,
      version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
      sourceTextRevisionId: updated.revision!.id,
    }),
    (error: unknown) =>
      hasCode(error, 'SOURCE_TEXT_CHANGED') && !(error instanceof ModelToolValidationError),
  );
  assert.equal(f.chat.status, 'idle');
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 0);
});

for (const exposure of ['create', 'read', 'question'] as const)
  test(`unmeasured ${exposure} context retains the broad proposal source pin`, async (t) => {
    fictionalModel(t);
    const f = fixture(t, {}, encryptedRecordStorage(t));
    const item = uploadIntake(f.db, f.root, 'cedar', {
      filename: 'fictional-unmeasured-context.txt',
      bytes: Buffer.from('Fictional first-page evidence. '.repeat(2500)),
    });
    const { extractIntakeSourceText } = await import('../intake-source-extraction.ts');
    const extract = () =>
      extractIntakeSourceText({
        db: f.db,
        root: f.root,
        profileId: 'cedar',
        id: item.id,
        maxPages: 1,
      });
    await extract();
    // Prepare the plan outside the model response so the read case independently
    // proves broad fallback without also exposing a create response to the model.
    if (exposure === 'read')
      await createIntakePlan(f.db, f.root, 'cedar', item.id, {
        version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
      });
    f.assistant.create('cedar', { message: 'Review fictional bounded source evidence' });
    await tick();
    const bridge = f.bridges[0];
    const passage = await call<{ revisionId: string }>(bridge, 'intake_source_text', {
      id: item.id,
      page: 1,
    });
    const version = getIntakeRead(f.db, f.root, 'cedar', item.id).version;
    if (exposure === 'question')
      await call(bridge, 'intake_question', {
        id: item.id,
        version,
        key: 'fictional-source-question',
        prompt: 'Which fictional statement is evidenced?',
        locator: 'page 1',
      });
    else
      await call(bridge, 'intake_plan', {
        id: item.id,
        action: exposure,
        ...(exposure === 'read'
          ? { freshStart: true, offset: 0, section: 'questions' }
          : { version }),
      });
    await call(bridge, 'intake_propose', {
      id: item.id,
      version: getIntakeRead(f.db, f.root, 'cedar', item.id).version,
      summary: 'Fictional context after an unmeasured response',
      sourceTextRevisionId: passage.revisionId,
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-broad-context',
        kind: 'context',
        payload: { text: 'Fictional first-page evidence' },
        provenance: {
          capturedVia: 'Fictional text',
          sourceSystem: null,
          sourceRecordId: null,
          evidenceClass: 'transcription',
          locator: 'page 1',
        },
        coverage: { status: 'partial', notes: ['Later source remains.'] },
      }),
    });
    const proposal = fixtureProposals(f.db, f.root, 'cedar', item.id)[0]!;
    assert.equal(proposalDependenciesCurrent(f.db, proposal.id), null);
    assert.equal(
      f.db
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get(`intake_proposal_dependencies:v1:${proposal.id}`),
      undefined,
    );
    assert.equal(
      (await selectedFixtureReview(f.db, f.root, 'cedar', item.id, proposal.id)).sourceTextStale,
      false,
    );
    await extract();
    assert.equal(
      (await selectedFixtureReview(f.db, f.root, 'cedar', item.id, proposal.id)).sourceTextStale,
      true,
      'an unobserved append still stales a broadly pinned proposal',
    );
  });

test('a deferred model proposal survives an unrelated append but rejects a later observed correction', async (t) => {
  fictionalModel(t);
  const gates = [0, 1].map(() => {
    let observed!: () => void;
    let release!: () => void;
    let settle!: () => void;
    return {
      observed: new Promise<void>((resolve) => (observed = resolve)),
      released: new Promise<void>((resolve) => (release = resolve)),
      settled: new Promise<void>((resolve) => (settle = resolve)),
      signalObserved: () => observed(),
      signalSettled: () => settle(),
      release: () => release(),
    };
  });
  t.after(() => gates.forEach((gate) => gate.release()));
  let sourceId = '';
  let turn = 0;
  const outcomes: Array<{
    result?: { proposalSourceText: ProposalSourceTextHandoff };
    error?: unknown;
  }> = [];
  const f = fixture(
    t,
    {
      bridgeFactory: (callbacks) => ({
        async start() {
          return { model: 'fictional-deferred-source-response' };
        },
        async turn() {
          const currentTurn = turn++;
          await callbacks.beforeRequest?.();
          await callbacks.onEvent?.('turn/started', { turn: { id: `deferred-${currentTurn}` } });
          const passage = (await callbacks.onTool?.({
            tool: 'health_intake_source_text',
            arguments: { id: sourceId, page: 1 },
            callId: `fictional-deferred-read-${currentTurn}`,
          })) as { revisionId: string };
          const version = getIntakeRead(f.db, f.root, 'cedar', sourceId).version;
          gates[currentTurn]!.signalObserved();
          await gates[currentTurn]!.released;
          try {
            const result = (await callbacks.onTool?.({
              tool: 'health_intake_propose',
              arguments: {
                id: sourceId,
                version,
                sourceTextRevisionId: passage.revisionId,
                summary: 'Fictional deferred bounded proposal',
                jsonlText: JSON.stringify({
                  format: 'health-record-v1',
                  id: `fictional-deferred-context-${currentTurn}`,
                  kind: 'context',
                  payload: { text: 'Fictional first-page evidence' },
                  provenance: {
                    capturedVia: 'Fictional PDF',
                    sourceSystem: null,
                    sourceRecordId: null,
                    evidenceClass: 'transcription',
                    locator: 'page 1',
                  },
                  coverage: { status: 'partial', notes: ['Later source remains.'] },
                }),
              },
              callId: `fictional-deferred-proposal-${currentTurn}`,
            })) as { proposalSourceText: ProposalSourceTextHandoff };
            outcomes[currentTurn] = { result };
          } catch (error) {
            outcomes[currentTurn] = { error };
          }
          await callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });
          gates[currentTurn]!.signalSettled();
        },
        async cancel() {},
        close() {},
      }),
    },
    encryptedRecordStorage(t),
  );
  const item = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-late-sections.txt',
    bytes: Buffer.from('Fictional first-page evidence. '.repeat(2500)),
  });
  sourceId = item.id;
  const { extractIntakeSourceText } = await import('../intake-source-extraction.ts');
  const { getIntakeSourceText } = await import('../intake-source-text.ts');
  await extractIntakeSourceText({
    db: f.db,
    root: f.root,
    profileId: 'cedar',
    id: item.id,
    maxPages: 1,
  });
  const chat = f.assistant.create('cedar', { title: 'Fictional late page' });
  f.assistant.send('cedar', chat.id, { message: 'Review the fictional source page' });
  await gates[0]!.observed;
  assert.equal(chat.status, 'running', 'the model response is held after seeing page one');
  const beforeRevision = getIntakeSourceText(f.db, f.root, 'cedar', item.id).revision!.id;
  await extractIntakeSourceText({
    db: f.db,
    root: f.root,
    profileId: 'cedar',
    id: item.id,
    maxPages: 1,
  });
  assert.equal(outcomes.length, 0, 'no proposal returned while the provider is held');
  gates[0]!.release();
  await gates[0]!.settled;
  const result = outcomes[0]!.result!;
  assert.equal(outcomes[0]!.error, undefined);
  assert.equal(proposalCount(f.db, f.root, 'cedar', item.id), 1);
  assert.notEqual(result.proposalSourceText.currentRevisionId, beforeRevision);
  const proposal = fixtureProposals(f.db, f.root, 'cedar', item.id)[0]!;
  const dependency = JSON.parse(
    sqlText(
      f.db
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get(`intake_proposal_dependencies:v1:${proposal.id}`),
      'value',
    ),
  );
  assert.deepEqual(dependency, {
    format: 'intake-proposal-dependencies-v1',
    sources: [
      {
        intakeId: item.id,
        pages: [{ page: 1, hash: sourcePageCurrentHash(f.db, item.id, 1) }],
        spans: [{ spanId: 'p1-literal', hash: sourceSpanCurrentHash(f.db, item.id, 'p1-literal') }],
      },
    ],
  });
  assert.equal(proposalDependenciesCurrent(f.db, proposal.id), true);
  assert.equal(
    (await selectedFixtureReview(f.db, f.root, 'cedar', item.id, proposal.id)).sourceTextStale,
    false,
  );
  assert.equal(chat.status, 'idle');
  f.assistant.send('cedar', chat.id, { message: 'Review the same fictional page again' });
  await gates[1]!.observed;
  assert.equal(chat.status, 'running');
  const { reviewIntakeSourceText } = await import('../intake-source-text.ts');
  const current = getIntakeSourceText(f.db, f.root, 'cedar', item.id).revision!;
  reviewIntakeSourceText(
    f.db,
    f.root,
    'cedar',
    item.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: current.id,
      sourceHash: current.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'fictional-late-correction',
          text: 'Corrected fictional first-page evidence.',
          provenance: 'human',
          region: { page: 1 },
        },
      ],
    },
    'fictional-owner',
  );
  assert.equal(outcomes.length, 1, 'the corrected response is still held');
  assert.equal(proposalDependenciesCurrent(f.db, proposal.id), false);
  assert.equal(
    (await selectedFixtureReview(f.db, f.root, 'cedar', item.id, proposal.id)).sourceTextStale,
    true,
  );
  gates[1]!.release();
  await gates[1]!.settled;
  assert.ok(hasCode(outcomes[1]!.error, 'SOURCE_TEXT_CHANGED'));
  assert.equal(proposalCount(f.db, f.root, 'cedar', item.id), 1);
});

test('a passage read cannot erase a human correction that arrived during a provider response', async (t) => {
  const f = await linkedFictionalBatchConversion(t, {}, undefined, encryptedRecordStorage(t));
  const { getIntakeSourceText, reviewIntakeSourceText } = await import('../intake-source-text.ts');
  const prior = getIntakeSourceText(f.db, f.root, 'cedar', f.item.id).revision!;
  await assert.doesNotReject(async () => f.bridge.callbacks.beforeRequest?.());
  reviewIntakeSourceText(
    f.db,
    f.root,
    'cedar',
    f.item.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: prior.id,
      sourceHash: prior.sourceHash,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'cookie-mid-response',
          text: 'Cookie Doe corrected source.',
          provenance: 'human',
          region: { page: 1 },
        },
      ],
    },
    'fictional-owner',
  );
  await assert.rejects(
    call(f.bridge, 'intake_source_text', { id: f.item.id }),
    (error: unknown) => {
      assert.equal(diagnosticFailureFields(error).sourceTextChangedSinceRead, true);
      assert.equal(diagnosticFailureFields(error).sourceTextRepairable, false);
      return hasCode(error, 'SOURCE_TEXT_CHANGED') && !(error instanceof ModelToolValidationError);
    },
  );
  assert.equal(f.chat.status, 'idle');
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 0);
});

for (const resolvesCoverage of [false, true])
  test(`read-but-unaccounted candidates get one bounded reconciliation turn: ${resolvesCoverage ? 'resolved' : 'still blocked'}`, async (t) => {
    const diagnostics = createImportDiagnostics({
      enabled: true,
      capacity: 1000,
      resourceIntervalMs: 0,
    });
    t.after(() => diagnostics.close());
    const f = await linkedFictionalBatchConversion(t, { diagnostics });
    await call(f.bridge, 'intake_batch', f.batch);
    complete(f.bridge);
    await waitForConversionBridge(t, f, f.chat, 1);
    assert.equal(f.bridges.length, 2);
    assert.equal(f.chat.reading?.pendingReadWindows, 0);
    assert.equal(f.chat.reading?.remainingUnits, 1);
    complete(f.bridges[1]!);
    await waitForConversionBridge(t, f, f.chat, 2);
    assert.equal(
      f.bridges.length,
      3,
      'one extra pass reconciles pending coverage without an owner resume',
    );
    assert.equal(f.chat.status, 'running');
    assert.equal(f.chat.reading?.remainingUnits, 1, 'the host does not invent a coverage decision');
    if (resolvesCoverage) {
      await call(f.bridges[2]!, 'intake_batch', {
        ...f.batch,
        version: getIntakeRead(f.db, f.root, 'cedar', f.item.id).version,
        operationId: 'fictional-complete-coverage',
        coverage: [
          {
            unitId: f.plan.units[0]!.id,
            kind: 'extracted',
            notes: 'All fictional source content is represented by the retained result.',
          },
        ],
      });
    }
    complete(f.bridges[2]!);
    await tick();
    assert.equal(f.bridges.length, 3, 'no unbounded retry loop');
    assert.equal(f.chat.reading?.reason, resolvesCoverage ? 'reading_exhausted' : 'no_progress');
    assert.equal(f.chat.reading?.remainingUnits, resolvesCoverage ? 0 : 1);
    assert.equal(f.chat.runs?.length, 1, 'the recovery shares all existing run budgets');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 0);
    assert.ok(
      diagnostics
        .exportSnapshot('cedar')
        .events.some((event) => event.fields.recoveryAction === 'reconcile_coverage'),
    );
  });

test('a person-scoped conversation cannot switch subjects and its note proposal retains its owner', async (t) => {
  const { assistant, bridges, db } = fixture(t);
  const cookie = createNote(db, { kind: 'person', title: 'Cookie Doe' });
  const self = createNote(db, { title: 'Self only', content: 'Private context' });
  const chat = assistant.create('cedar', {
    message: 'Draft a note for Cookie',
    context: { route: `/notes?personId=${encodeURIComponent(cookie.personId!)}` },
  });
  await tick();
  await assert.rejects(
    call(bridges[0], 'read', { collection: 'notes', id: self.id }),
    /different person/,
  );
  const proposal = await call(bridges[0], 'propose_note', {
    title: 'Cookie context',
    content: 'Fictional family note',
    reason: 'Requested note',
  });
  complete(bridges[0]);
  assert.throws(
    () =>
      assistant.send('cedar', chat.id, {
        message: 'Now discuss Self',
        context: { route: '/notes?personId=patient' },
      }),
    /new conversation/,
  );
  const retained = assistant
    .get('cedar', chat.id)
    .proposals.find((item) => item.id === proposal.id);
  assert.equal(retained?.changes.ownerPersonId, cookie.personId);
});

test('approving unchanged source text during conversion neither restarts reading nor rejects the existing batch', async (t) => {
  const f = await linkedFictionalBatchConversion(t, {}, undefined, encryptedRecordStorage(t));
  const { getIntakeSourceText, reviewIntakeSourceText } = await import('../intake-source-text.ts');
  const prior = getIntakeSourceText(f.db, f.root, 'cedar', f.item.id).revision!;
  const approved = reviewIntakeSourceText(
    f.db,
    f.root,
    'cedar',
    f.item.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: prior.id,
      sourceHash: prior.sourceHash,
      action: 'confirm',
      scope: { page: 1 },
    },
    'fictional-owner',
  );
  assert.notEqual(approved.revision!.id, prior.id);
  await assert.doesNotReject(async () => f.bridge.callbacks.beforeRequest?.());
  await call(f.bridge, 'intake_batch', f.batch);
  assert.equal(f.chat.status, 'running');
  assert.equal(proposalCount(f.db, f.root, 'cedar', f.item.id), 1);
});

test('native assistant package navigation uses explicit inventory-only evidence without workflow hydration', async (t) => {
  fictionalModel(t);
  const f = fixture(t),
    { createPagedPackagePlan } = await import('../intake-package-plan.ts'),
    { intakeWorkCounters } = await import('../intake-work-accounting.ts');
  const source = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-navigation.zip',
    bytes: zipFixture([{ name: 'fictional.txt', data: 'Fictional original text.' }]),
  });
  await createPagedPackagePlan(f.db, f.root, 'cedar', source.id, {
    version: source.version,
    operationId: 'fictional-native-navigation',
  });
  const chat = f.assistant.create('cedar', { message: 'Inspect the fictional delivery.' });
  await tick();
  const before = { ...intakeWorkCounters(f.db).warm };
  for (const action of ['search', 'follow']) {
    const result = await call(f.bridges[0], 'intake_plan', {
      id: source.id,
      action,
      ...(action === 'search' ? { query: 'fictional' } : { referenceId: 'fictional-reference' }),
    });
    assert.equal(result.format, 'health-intake-navigation-v2');
    assert.equal(result.state, 'inventory_only');
    assert.equal(result.searched, false);
    assert.equal(result.followed, false);
  }
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  f.assistant.cancel('cedar', chat.id);
});

test('native package assistant dispatch retains scalar checkpoints and acknowledges deferred ledger reads before continuing', async (t) => {
  fictionalModel(t);
  const f = fixture(t),
    { createPagedPackagePlan, readPackagePlanScope } = await import('../intake-package-plan.ts'),
    { linkIntakeConversionRead, getIntakeRead, flushIntake } = await import('../intake.ts'),
    { intakeWorkCounters } = await import('../intake-work-accounting.ts');
  const source = uploadIntake(f.db, f.root, 'cedar', {
    filename: 'fictional-native.zip',
    bytes: zipFixture([
      { name: 'first.txt', data: 'Fictional native literal source.' },
      { name: 'second.txt', data: 'Another fictional source.' },
    ]),
  });
  await createPagedPackagePlan(f.db, f.root, 'cedar', source.id, {
    version: source.version,
    operationId: 'native-plan',
  });
  flushIntake(f.db, f.root, 'cedar');
  const chat = f.assistant.create('cedar', { title: 'Fictional native conversion' });
  await linkIntakeConversionRead(f.db, f.root, 'cedar', source.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read the selected native unit',
    context: { route: '/sources', intakeId: source.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  assert.equal(chat.status, 'running', chat.error || '');
  const checkpoint = chat.conversionCheckpoint;
  assert.ok(checkpoint && 'format' in checkpoint);
  assert.equal(checkpoint.format, 'health-intake-conversion-checkpoint-v2');
  assert.equal('seen' in checkpoint, false);
  assert.equal('pending' in checkpoint, false);
  const plan = required(readPackagePlanScope(f.db, f.root, 'cedar', source.id)),
    member = required(plan.inventory.member(0));
  const result = await bridge.callbacks.onTool({
    tool: 'health_intake_package',
    arguments: { id: source.id, action: 'read_member', memberId: member.memberId },
    callId: 'native-deferred',
    deferReadConsumption: true,
  });
  assert.ok(result);
  assert.equal(chat.reading?.distinctReads, 0);
  await bridge.callbacks.onEvent('model/toolResultsConsumed', { callIds: ['native-deferred'] });
  assert.equal(chat.reading?.distinctReads, 1);
  await bridge.callbacks.onEvent('model/toolResultsConsumed', { callIds: ['native-deferred'] });
  assert.equal(chat.reading?.distinctReads, 1);
  const before = { ...intakeWorkCounters(f.db).warm };
  await bridge.callbacks.onTool({
    tool: 'health_intake_package',
    arguments: { id: source.id, action: 'read_member', memberId: member.memberId, offset: 1 },
    callId: 'native-second',
    deferReadConsumption: true,
  });
  await bridge.callbacks.onEvent('model/toolResultsConsumed', { callIds: ['native-second'] });
  assert.equal(chat.reading?.distinctReads, 2);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  assert.ok('format' in getIntakeRead(f.db, f.root, 'cedar', source.id));
  f.assistant.cancel('cedar', chat.id);
});

test('native direct conversion prepares its first plan before provider dispatch without a legacy checkpoint', async (t) => {
  fictionalModel(t);
  const f = fixture(t),
    source = uploadIntake(f.db, f.root, 'cedar', {
      filename: 'fictional-direct.txt',
      bytes: Buffer.from('Fictional direct conversion evidence.'),
    });
  const { buildIntakeCollectionEnvelope } = await import('../intake-envelope-build.ts'),
    { linkIntakeConversionRead, getIntakeRead } = await import('../intake.ts');
  const row = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(source.id)!;
  await buildIntakeCollectionEnvelope(f.db, row as never);
  const chat = f.assistant.create('cedar', { title: 'Fictional direct conversion' });
  await linkIntakeConversionRead(f.db, f.root, 'cedar', source.id, chat.id);
  f.assistant.send('cedar', chat.id, {
    message: 'Read this direct source',
    context: { intakeId: source.id },
  });
  const bridge = await waitForConversionBridge(t, f, chat);
  assert.equal(chat.status, 'running', chat.error ?? '');
  assert.ok(chat.conversionCheckpoint && 'format' in chat.conversionCheckpoint);
  assert.equal(chat.conversionCheckpoint.format, 'health-intake-conversion-checkpoint-v2');
  assert.ok('format' in getIntakeRead(f.db, f.root, 'cedar', source.id));
  assert.equal('seen' in chat.conversionCheckpoint, false);
  assert.ok(bridge.prompt.conversion);
  const { readDirectPlanScope } = await import('../intake-direct-plan.ts'),
    selected = required(readDirectPlanScope(f.db, 'cedar', source.id));
  await call(bridge, 'intake_plan', {
    id: source.id,
    action: 'read_unit',
    unitId: selected.unitAt(0)!.id,
  });
  const proposed = await call(bridge, 'intake_propose', {
    id: source.id,
    version: getIntakeRead(f.db, f.root, 'cedar', source.id).version,
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-native-propose',
      kind: 'document',
      payload: { text: 'Fictional direct conversion evidence.' },
      provenance: {
        capturedVia: 'Fictional export',
        sourceSystem: 'Fictional source',
        sourceRecordId: 'fictional-native-propose',
        evidenceClass: 'provider_export',
        locator: 'fictional text',
      },
      coverage: { status: 'partial', notes: [] },
    }),
    summary: 'Fictional direct manual proposal',
  });
  assert.equal(proposed.format, 'health-intake-summary-v2');
  const retained = getIntakeRead(f.db, f.root, 'cedar', source.id);
  assert.ok('format' in retained);
  assert.equal(retained.collections.proposals.total, 1);
  f.assistant.cancel('cedar', chat.id);
});

for (const finalRace of ['unchanged', 'unrelated_write'] as const)
  test(
    `native assistant retains an exact delayed batch only across one disjoint public counted acceptance: ${finalRace}`,
    { timeout: 120000 },
    async (t) => {
      fictionalModel(t);
      const retries: unknown[] = [],
        f = fixture(t, {
          beforeBatchRevalidationRetry: ({ db, batchInput }) => {
            retries.push(structuredClone(batchInput));
            if (finalRace === 'unrelated_write')
              transaction(db, () =>
                db
                  .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
                  .run('fictional:unrelated-final-race', 'changed'),
              );
          },
        }),
        { buildIntakeCollectionEnvelope } = await import('../intake-envelope-build.ts'),
        { createIntakePlanRead, getIntakeRead, linkIntakeConversionRead } =
          await import('../intake.ts'),
        { readDirectPlanScope } = await import('../intake-direct-plan.ts'),
        { prepareCollectionReviewMembership } =
          await import('../intake-review-membership-index.ts'),
        { prepareCollectionClinicalReview } = await import('../intake-review-collection-host.ts'),
        { acceptIntakeReportSelectionAsync } = await import('../intake-report-acceptance.ts'),
        { iterateIntakeEnvelopeText } = await import('../intake-collection-envelope.ts');
      const source = uploadIntake(f.db, f.root, 'cedar', {
        filename: 'fictional-native-acceptance-race.txt',
        bytes: Buffer.from(
          'Fictional first report. ' +
            'first source evidence '.repeat(1500) +
            '\nFictional second report. ' +
            'second source evidence '.repeat(1500),
        ),
      });
      await buildIntakeCollectionEnvelope(f.db, { id: source.id });
      await createIntakePlanRead(f.db, f.root, 'cedar', source.id, {
        version: source.version,
        operationId: 'fictional-native-race-plan',
      });
      const plan = required(readDirectPlanScope(f.db, 'cedar', source.id)),
        firstUnit = required(plan.unitAt(0)),
        secondUnit = required(plan.unitAt(1));
      const chat = f.assistant.create('cedar', { title: 'Fictional native delayed approval' });
      await linkIntakeConversionRead(f.db, f.root, 'cedar', source.id, chat.id);
      f.assistant.send('cedar', chat.id, {
        message: 'Read the fictional source',
        context: { intakeId: source.id },
      });
      const bridge = await waitForConversionBridge(t, f, chat);
      assert.equal(chat.status, 'running', chat.error ?? '');
      const line = (id: string, locator: string) =>
        JSON.stringify({
          format: 'health-record-v1',
          id,
          kind: 'document',
          payload: { text: 'Fictional ' + id },
          provenance: {
            capturedVia: 'Fictional export',
            sourceSystem: 'Fictional source',
            sourceRecordId: id,
            evidenceClass: 'provider_export',
            locator,
          },
          coverage: { status: 'complete_response', notes: [] },
          clinical: {
            kind: 'document',
            subject: 'self',
            documentTitle: 'Fictional ' + id,
            date: '2026-01-01',
          },
        });
      await call(bridge, 'intake_plan', {
        id: source.id,
        action: 'read_unit',
        unitId: firstUnit.id,
      });
      await call(bridge, 'intake_batch', {
        id: source.id,
        planId: plan.planId,
        version: getIntakeRead(f.db, f.root, 'cedar', source.id).version,
        operationId: 'fictional-native-first-batch',
        jsonlText: line('first', firstUnit.locator),
        summary: 'Fictional first report',
        coverage: [
          { unitId: firstUnit.id, kind: 'extracted', notes: 'Fictional literal retained' },
        ],
      });
      const current = getIntakeRead(f.db, f.root, 'cedar', source.id);
      assert.ok('format' in current && current.collections.proposals.total === 1);
      const proposalId = JSON.parse(
        [...iterateIntakeEnvelopeText(f.db, { id: source.id })].join(''),
      ).intake.proposals[0].id as string;
      const readsBefore = chat.reading!.distinctReads!;
      await bridge.callbacks.onTool({
        tool: 'health_intake_plan',
        arguments: { id: source.id, action: 'read_unit', unitId: secondUnit.id },
        callId: 'fictional-native-delayed-read',
        deferReadConsumption: true,
      });
      assert.equal(chat.reading!.distinctReads, readsBefore);
      await prepareCollectionReviewMembership(f.db, { id: source.id });
      const session = prepareCollectionClinicalReview(f.db, f.root, 'cedar', source.id, proposalId);
      assert.equal(session.status, 'ready');
      if (session.status !== 'ready') throw Error('Expected selected review');
      const review = session.session.review;
      await bridge.callbacks.onEvent('model/requestStarted', {
        turnId: 'fictional-native-delayed',
      });
      const delayed = {
        id: source.id,
        planId: plan.planId,
        version: getIntakeRead(f.db, f.root, 'cedar', source.id).version,
        operationId: 'fictional-native-second-batch',
        jsonlText: line('second', secondUnit.locator),
        summary: 'Fictional second report',
        coverage: [
          { unitId: secondUnit.id, kind: 'extracted', notes: 'Fictional literal retained' },
        ],
      };
      await acceptIntakeReportSelectionAsync(f.db, f.root, 'cedar', {
        operationId: randomUUID(),
        blocks: [
          {
            intakeId: source.id,
            intakeVersion: review.version,
            proposalId,
            reviewToken: review.reviewToken,
            selections: review.records.map((record) => ({
              recordId: record.id,
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              mapping: record.mapping,
            })),
          },
        ],
      });
      await bridge.callbacks.onEvent('model/toolResultsConsumed', {
        callIds: ['fictional-native-delayed-read'],
      });
      assert.equal(chat.reading!.distinctReads, readsBefore + 1);
      if (finalRace === 'unrelated_write')
        await assert.rejects(call(bridge, 'intake_batch', delayed), (error: unknown) =>
          hasCode(error, 'VERSION_CONFLICT'),
        );
      else await call(bridge, 'intake_batch', delayed);
      const { id: _transportId, ...submitted } = delayed;
      assert.deepEqual(retries, [{ ...submitted, runId: chat.id }]);
      const retained = JSON.parse(
        [...iterateIntakeEnvelopeText(f.db, { id: source.id })].join(''),
      ).intake;
      assert.equal(retained.proposals.length, finalRace === 'unrelated_write' ? 1 : 2);
      assert.equal(retained.workflow.candidates[0].versions[0].status, 'accepted');
      if (finalRace === 'unchanged')
        assert.equal(retained.workflow.candidates[1].versions[0].status, 'pending');
      assert.equal(retained.workflow.reportAcceptances.length, 1);
      assert.equal(f.bridges.length, 1);
      if (finalRace === 'unchanged') await call(bridge, 'intake_batch', delayed);
      assert.equal(retries.length, 1);
      f.assistant.cancel('cedar', chat.id);
    },
  );

test(
  'a migrated assistant chat imports retained reading progress before native provider dispatch',
  { timeout: 120000 },
  async (t) => {
    fictionalModel(t);
    const base = fixture(t),
      { nativeAssistantConversion, isNativeAssistantCheckpoint } =
        await import('../assistant-intake-native.ts'),
      { readNativeAttributionMetadata } = await import('../assistant-intake-attribution.ts'),
      { getIntakeRead, readIntake, readIntakeUnit } = await import('../intake.ts'),
      { conversionCheckpoint, recordConversionRead, deferConversionRead, conversionReadKey } =
        await import('../intake-continuation.ts'),
      { recordAttributionRead, acknowledgeAttributionRead, startAttributionRequest } =
        await import('../intake-attribution.ts');
    const item = uploadIntake(base.db, base.root, 'cedar', {
      filename: 'fictional-prior-reading.txt',
      bytes: Buffer.from('Fictional prior reading evidence: result 02.40 mg on 2026-02-04.'),
    });
    await createIntakePlan(base.db, base.root, 'cedar', item.id, {
      version: item.version,
      operationId: 'fictional-prior-reading-plan',
    });
    const chat = base.assistant.create('cedar', { title: 'Fictional retained legacy reading' });
    linkIntakeConversion(base.db, base.root, 'cedar', item.id, chat.id);
    const f = { ...base, item, chat };
    // Seed a real pre-upgrade journal with the old reader/reducer, before the new
    // assistant prepares native authority. New sessions no longer produce this shape.
    const legacy = getIntake(f.db, f.root, 'cedar', item.id);
    assert.ok(legacy.workflow);
    const checkpointBefore = conversionCheckpoint(
      {},
      { ...legacy, workflow: legacy.workflow },
      'cedar',
    );
    const args = { id: item.id };
    assert.equal(
      recordConversionRead(
        checkpointBefore,
        'health_intake_read',
        args,
        readIntake(f.db, f.root, 'cedar', item.id),
      ),
      true,
    );
    const unit = required(legacy.workflow.plans[0]?.units[0]);
    assert.ok(
      deferConversionRead(
        checkpointBefore,
        'health_intake_plan',
        { id: item.id, action: 'read_unit', unitId: unit.id },
        await readIntakeUnit(f.db, f.root, 'cedar', item.id, unit.id),
      ),
    );
    const scope = recordAttributionRead(
      checkpointBefore,
      required(conversionReadKey('health_intake_read', args)),
      { sourceFileId: item.id, memberId: null, page: null },
    );
    acknowledgeAttributionRead(checkpointBefore, required(scope.scopeKey));
    startAttributionRequest(checkpointBefore, [required(scope.scopeKey)]);
    checkpointBefore.turns = 1;
    checkpointBefore.modelRequests = 1;
    f.chat.conversionCheckpoint = checkpointBefore;
    writeChat(f.root, 'cedar', f.chat, 'fictional-pre-upgrade-reading-journal');
    const previous = structuredClone(checkpointBefore);
    assert.ok(previous.seen.length > 0);
    assert.ok(previous.pending.length > 0);
    f.assistant.send('cedar', f.chat.id, {
      message: 'Continue the retained fictional source',
      context: { intakeId: f.item.id },
    });
    const bridge = await waitForConversionBridge(t, f, f.chat);
    assert.equal(f.chat.status, 'running', f.chat.error ?? '');
    assert.ok(bridge.prompt.conversion);
    const checkpoint = f.chat.conversionCheckpoint;
    assert.ok(isNativeAssistantCheckpoint(checkpoint));
    assert.equal('seen' in checkpoint, false);
    assert.equal('pending' in checkpoint, false);
    assert.equal(checkpoint.turns, previous.turns + 1);
    assert.equal(checkpoint.modelRequests, previous.modelRequests);
    assert.equal(f.chat.reading?.readWindows, previous.seen.length);
    assert.equal(
      f.chat.reading?.distinctReads,
      previous.distinctReads ?? previous.pagesProcessed ?? 0,
    );
    const header = getIntakeRead(f.db, f.root, 'cedar', f.item.id);
    assert.ok('format' in header);
    const host = nativeAssistantConversion(f.db, f.root, 'cedar', f.chat.id, header),
      attribution = readNativeAttributionMetadata(host, checkpoint);
    assert.deepEqual(attribution.totals, previous.attribution?.totals);
    assert.deepEqual(attribution.scopes, previous.attribution?.scopes);
    assert.ok(header.activePlan.state === 'exact' && header.activePlan.plan);
    // Text windows intentionally ignore row/page-size options. A different
    // fictional model pin makes this an actual replacement plan occurrence.
    const previousModel = process.env.CRS_AI_MODEL;
    process.env.CRS_AI_MODEL = 'fictional-replacement-model';
    try {
      await call(bridge, 'intake_plan', {
        id: f.item.id,
        action: 'create',
        version: header.version,
        replacePlanId: header.activePlan.plan.id,
        operationId: 'fictional-migrated-new-plan',
      });
    } finally {
      if (previousModel === undefined) delete process.env.CRS_AI_MODEL;
      else process.env.CRS_AI_MODEL = previousModel;
    }
    assert.equal(f.chat.reading?.readWindows, previous.seen.length);
    assert.equal(
      f.chat.reading?.distinctReads,
      previous.distinctReads ?? previous.pagesProcessed ?? 0,
    );
    assert.equal(f.chat.reading?.pendingReadWindows, previous.pending.length);
    assert.notEqual(checkpoint.planId, header.activePlan.plan.id);
    f.assistant.cancel('cedar', f.chat.id);
  },
);
