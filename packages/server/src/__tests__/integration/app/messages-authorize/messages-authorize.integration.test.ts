/**
 * #560 — `messages/authorize` send-side gate.
 *
 * Validates the verdict-path, race-safety, default-flow regression,
 * and per-caller visibility filter from architect plan §8.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Chunk, Data, Duration, Effect, Either, Fiber, Stream } from "effect";
import {
  ConversationsCreate,
  HookBlockedError,
  MessagesList,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  TasksCreate,
  TasksCreateConversation,
  type AgentId,
  type AppManifest,
  type ConversationId,
  type MessageId,
} from "@moltzap/protocol";
import { endpointAddress } from "@moltzap/protocol/network";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  setupAgentPair,
  getTestCoreApp,
  getKyselyDb,
  type ConnectedAgent,
} from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "messages-authorize-test-app";
const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Messages-Authorize Test App",
  hooks: {
    message_authorize: { timeout_ms: 5_000 },
  },
};

const DEFAULT_DM_TM_ADDRESS = endpointAddress(
  "tm:app:00000000-0000-4d11-8000-000000000d11",
);
const DECISION_FORWARD = "Forward";
const DECISION_BLOCK = "Block";
const NEVER_REPLY = "never-reply";
const VERDICT_TAG_FORWARD = "forward";
const VERDICT_TAG_BLOCK = "block";
const VERDICT_TAG_PENDING = "pending";
const BLOCK_REASON = "test-block";
const DEFAULT_DM_BLOCK_REASON = "default-dm-block";
const RACE_LOSER_REASON = "race-loser";
const BLOCK_MESSAGE_PATTERN = /block/i;
const CONV_TYPE_DM = "dm";
const CONV_TYPE_GROUP = "group";
const PARTICIPANT_TYPE_AGENT = "agent";
const PART_TYPE_TEXT = "text";
const CONV_NAME_BLOCK = "ma-block";
const CONV_NAME_SUBSET = "ma-subset";
const CONV_NAME_VISIBILITY = "vis-test";
const TEXT_BLOCKED = "blocked-msg";
const TEXT_SUBSET = "subset-msg";
const TEXT_UNREACHABLE = "unreachable";
const TEXT_EMPTY_FORWARD = "empty-forward";
const TEXT_DM_BLOCKED = "dm-blocked";
const TEXT_FORWARD_CAROL = "m1-forward-carol";
const TEXT_BLOCKED_SECOND = "m2-blocked";
const TEXT_FORWARD_BOB = "m3-forward-bob";
const TEXT_RACE = "race";
const SHORT_SETTLE = "200 millis";
const LONG_SETTLE = "300 millis";
const SERVER_TIMEOUT_BUDGET_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 60_000;
const MIN_DEFAULT_DM_HOOK_CALLS = 1;

type MessageAuthorizeVerdict =
  | { decision: typeof DECISION_FORWARD; recipients: ReadonlyArray<AgentId> }
  | { decision: typeof DECISION_BLOCK; reason?: string };

interface VerdictState {
  next: MessageAuthorizeVerdict | { kind: typeof NEVER_REPLY };
  calls: number;
}

class MessagesAuthorizeDbError extends Data.TaggedError(
  "MessagesAuthorizeDbError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

let appHookState: VerdictState = {
  next: { decision: DECISION_FORWARD, recipients: [] },
  calls: 0,
};
let defaultDmHookState: VerdictState | null = null;

beforeAll(() => Effect.runPromise(startTestServerEffect()), START_TIMEOUT_MS);
afterAll(() => Effect.runPromise(stopTestServerEffect()));
beforeEach(() =>
  Effect.runPromise(
    resetTestDbEffect().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          appHookState = {
            next: { decision: DECISION_FORWARD, recipients: [] },
            calls: 0,
          };
          defaultDmHookState = null;
          getTestCoreApp().registerApp(TEST_APP_MANIFEST);
        }),
      ),
    ),
  ),
);

function registerTmHook(tmAgentId: string): void {
  const addr = endpointAddress(`tm:agent:${tmAgentId}`);
  getTestCoreApp().registerMessageAuthorize(addr, () => {
    appHookState.calls += 1;
    const verdict = appHookState.next;
    if ("kind" in verdict && verdict.kind === NEVER_REPLY) {
      return Effect.runPromise(Effect.never);
    }
    return verdict as MessageAuthorizeVerdict;
  });
}

function registerDefaultDmHook(verdict: MessageAuthorizeVerdict): void {
  defaultDmHookState = { next: verdict, calls: 0 };
  getTestCoreApp().registerMessageAuthorize(DEFAULT_DM_TM_ADDRESS, () => {
    if (defaultDmHookState === null) expect.fail("default DM hook not seeded");
    defaultDmHookState.calls += 1;
    return defaultDmHookState.next as MessageAuthorizeVerdict;
  });
}

function dbError(message: string, cause: unknown) {
  return new MessagesAuthorizeDbError({ message, cause });
}

function readTmDecision(
  messageId: string,
): Effect.Effect<unknown, MessagesAuthorizeDbError> {
  return Effect.tryPromise({
    try: () =>
      getKyselyDb()
        .selectFrom("messages")
        .select("tm_decision")
        .where("id", "=", messageId)
        .executeTakeFirstOrThrow(),
    catch: (cause) => dbError("Unable to read tm_decision", cause),
  }).pipe(Effect.map((row) => row.tm_decision));
}

function readAllMessageIdsForConversation(
  conversationId: string,
): Effect.Effect<ReadonlyArray<string>, MessagesAuthorizeDbError> {
  return Effect.tryPromise({
    try: () =>
      getKyselyDb()
        .selectFrom("messages")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .execute(),
    catch: (cause) => dbError("Unable to read conversation messages", cause),
  }).pipe(Effect.map((rows) => rows.map((row) => row.id)));
}

function attemptPendingCasBlock(messageId: string) {
  return Effect.tryPromise({
    try: () =>
      getKyselyDb()
        .updateTable("messages")
        .set({
          tm_decision: { tag: VERDICT_TAG_BLOCK, reason: RACE_LOSER_REASON },
        })
        .where("id", "=", messageId)
        .where(
          "tm_decision",
          "@>",
          JSON.stringify({ tag: VERDICT_TAG_PENDING }),
        )
        .returning("id")
        .execute(),
    catch: (cause) => dbError("Unable to attempt pending CAS update", cause),
  });
}

function agentParticipant(agent: ConnectedAgent) {
  return { type: PARTICIPANT_TYPE_AGENT, id: agent.agentId };
}

function textPart(text: string) {
  return { type: PART_TYPE_TEXT, text };
}

/**
 * Settle-window collector for `messages/received` notifications.
 *
 * Post-#645 the legacy `drainNotifications` snapshot is deleted; the
 * new Stream.async-backed subscription only observes frames emitted
 * from materialisation forward. Each call site that previously
 * asserted "no message received" via a settle-then-drain pattern now
 * forks one of these collectors BEFORE the triggering send and joins
 * it after — the `Stream.interruptAfter` window bounds collection so
 * the assert doesn't block when no event is expected.
 */
function forkMessageReceivedCollector(
  agent: ConnectedAgent,
  settle: Duration.DurationInput,
) {
  return agent.client
    .subscribe(MessageReceivedNotificationDefinition)
    .pipe(
      Stream.interruptAfter(Duration.decode(settle)),
      Stream.runCollect,
      Effect.fork,
    );
}

function assertNoMessageReceived<E>(
  collector: Fiber.RuntimeFiber<Chunk.Chunk<unknown>, E>,
): Effect.Effect<void, E> {
  return Effect.map(Fiber.join(collector), (chunk) => {
    expect(Chunk.toReadonlyArray(chunk)).toHaveLength(0);
  });
}

function assertExactMessageReceived<E>(
  collector: Fiber.RuntimeFiber<Chunk.Chunk<unknown>, E>,
  count: number,
): Effect.Effect<void, E> {
  return Effect.map(Fiber.join(collector), (chunk) => {
    expect(Chunk.toReadonlyArray(chunk)).toHaveLength(count);
  });
}

function expectHookBlocked(
  outcome: Either.Either<unknown, unknown>,
  messagePattern?: RegExp,
): void {
  Either.match(outcome, {
    onLeft: (error) => {
      const wire = error as { code?: number; message?: string };
      expect(wire.code).toBe(HookBlockedError.code);
      if (messagePattern !== undefined) {
        expect(String(wire.message)).toMatch(messagePattern);
      }
    },
    onRight: () => expect.fail("expected HookBlockedError"),
  });
}

function expectDecisionTag(decision: unknown, tag: string): void {
  expect((decision as { tag?: string }).tag).toBe(tag);
}

function expectDecisionReason(decision: unknown, reason: string): void {
  expect((decision as { reason?: string }).reason).toBe(reason);
}

function expectDecisionRecipients(
  decision: unknown,
  recipients: ReadonlyArray<string>,
): void {
  expect(
    (decision as { recipients?: ReadonlyArray<string> }).recipients,
  ).toEqual(recipients);
}

function createSelfTask(agent: ConnectedAgent) {
  return agent.client.sendRpc(TasksCreate, {
    appId: TEST_APP_ID,
    tmType: "self",
  });
}

function createManagedGroup(
  agent: ConnectedAgent,
  taskId: string,
  name: string,
  participants: ReadonlyArray<ConnectedAgent>,
) {
  return agent.client.sendRpc(TasksCreateConversation, {
    taskId,
    type: CONV_TYPE_GROUP,
    name,
    participants: participants.map(agentParticipant),
  });
}

function createManagedDm(
  agent: ConnectedAgent,
  taskId: string,
  participant: ConnectedAgent,
) {
  return agent.client.sendRpc(TasksCreateConversation, {
    taskId,
    type: CONV_TYPE_DM,
    participants: [agentParticipant(participant)],
  });
}

function sendText(
  agent: ConnectedAgent,
  conversationId: ConversationId,
  text: string,
) {
  return agent.client.sendRpc(MessagesSend, {
    conversationId,
    parts: [textPart(text)],
  });
}

function sendTextWithTimeout(
  agent: ConnectedAgent,
  conversationId: ConversationId,
  text: string,
  timeoutMs: number,
) {
  return agent.client.sendRpc(
    MessagesSend,
    {
      conversationId,
      parts: [textPart(text)],
    },
    { timeoutMs },
  );
}

function blockVerdictPreventsFanoutAndPersistsBlock() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    registerTmHook(alice.agentId);
    appHookState.next = { decision: DECISION_BLOCK, reason: BLOCK_REASON };

    const task = yield* createSelfTask(alice);
    const conv = yield* createManagedGroup(
      alice,
      task.task.id,
      CONV_NAME_BLOCK,
      [bob],
    );
    const conversationId = conv.conversation.id as ConversationId;
    const bobCollector = yield* forkMessageReceivedCollector(bob, SHORT_SETTLE);
    const outcome = yield* Effect.either(
      sendText(alice, conversationId, TEXT_BLOCKED),
    );
    expectHookBlocked(outcome, BLOCK_MESSAGE_PATTERN);
    expect(appHookState.calls).toBe(1);

    yield* assertNoMessageReceived(bobCollector);

    const ids = yield* readAllMessageIdsForConversation(conversationId);
    expect(ids.length).toBe(1);
    const decision = yield* readTmDecision(ids[0]!);
    expectDecisionTag(decision, VERDICT_TAG_BLOCK);
    expectDecisionReason(decision, BLOCK_REASON);
  });
}

function tmUnreachableSynthesizesBlock() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    registerTmHook(alice.agentId);
    appHookState.next = { kind: NEVER_REPLY };

    const task = yield* createSelfTask(alice);
    const conv = yield* createManagedDm(alice, task.task.id, bob);
    const conversationId = conv.conversation.id as ConversationId;
    const bobCollector = yield* forkMessageReceivedCollector(bob, SHORT_SETTLE);
    const outcome = yield* Effect.either(
      sendTextWithTimeout(
        alice,
        conversationId,
        TEXT_UNREACHABLE,
        SERVER_TIMEOUT_BUDGET_MS,
      ),
    );
    expectHookBlocked(outcome);

    yield* assertNoMessageReceived(bobCollector);
  });
}

function defaultDmHookBlockChangesBehavior() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    registerDefaultDmHook({
      decision: DECISION_BLOCK,
      reason: DEFAULT_DM_BLOCK_REASON,
    });

    const conv = yield* alice.client.sendRpc(ConversationsCreate, {
      type: CONV_TYPE_DM,
      participants: [agentParticipant(bob)],
    });
    const conversationId = conv.conversation.id as ConversationId;
    const bobCollector = yield* forkMessageReceivedCollector(bob, SHORT_SETTLE);
    const outcome = yield* Effect.either(
      sendText(alice, conversationId, TEXT_DM_BLOCKED),
    );
    expectHookBlocked(outcome);
    expect(defaultDmHookState?.calls).toBeGreaterThanOrEqual(
      MIN_DEFAULT_DM_HOOK_CALLS,
    );

    yield* assertNoMessageReceived(bobCollector);
  });
}

function forwardSubsetOnlyNotifiesAuthorizedRecipient() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-sub");
    const bob = yield* registerAndConnect("bob-sub");
    const carol = yield* registerAndConnect("carol-sub");
    const dave = yield* registerAndConnect("dave-sub");
    registerTmHook(alice.agentId);

    const task = yield* createSelfTask(alice);
    const conv = yield* createManagedGroup(
      alice,
      task.task.id,
      CONV_NAME_SUBSET,
      [bob, carol, dave],
    );
    const conversationId = conv.conversation.id as ConversationId;
    appHookState.next = {
      decision: DECISION_FORWARD,
      recipients: [carol.agentId as AgentId],
    };

    const carolCollector = yield* forkMessageReceivedCollector(
      carol,
      LONG_SETTLE,
    );
    const bobCollector = yield* forkMessageReceivedCollector(bob, LONG_SETTLE);
    const daveCollector = yield* forkMessageReceivedCollector(
      dave,
      LONG_SETTLE,
    );
    const sent = yield* sendText(alice, conversationId, TEXT_SUBSET);
    const messageId = sent.message.id as MessageId;

    yield* assertExactMessageReceived(carolCollector, 1);
    yield* assertNoMessageReceived(bobCollector);
    yield* assertNoMessageReceived(daveCollector);

    const decision = yield* readTmDecision(messageId);
    expectDecisionTag(decision, VERDICT_TAG_FORWARD);
    expectDecisionRecipients(decision, [carol.agentId]);
  });
}

function forwardEmptySendsNoFanout() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    registerTmHook(alice.agentId);
    appHookState.next = { decision: DECISION_FORWARD, recipients: [] };

    const task = yield* createSelfTask(alice);
    const conv = yield* createManagedDm(alice, task.task.id, bob);
    const conversationId = conv.conversation.id as ConversationId;
    const bobCollector = yield* forkMessageReceivedCollector(bob, SHORT_SETTLE);
    const sent = yield* sendText(alice, conversationId, TEXT_EMPTY_FORWARD);
    const messageId = sent.message.id as MessageId;

    yield* assertNoMessageReceived(bobCollector);
    const decision = yield* readTmDecision(messageId);
    expectDecisionTag(decision, VERDICT_TAG_FORWARD);
    expectDecisionRecipients(decision, []);
  });
}

function senderAndRecipientsSeeOnlyAuthorizedRows() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-vis");
    const bob = yield* registerAndConnect("bob-vis");
    const carol = yield* registerAndConnect("carol-vis");
    registerTmHook(alice.agentId);

    const task = yield* createSelfTask(alice);
    const conv = yield* createManagedGroup(
      alice,
      task.task.id,
      CONV_NAME_VISIBILITY,
      [bob, carol],
    );
    const conversationId = conv.conversation.id as ConversationId;

    appHookState.next = {
      decision: DECISION_FORWARD,
      recipients: [carol.agentId as AgentId],
    };
    const carolForward = yield* sendText(
      alice,
      conversationId,
      TEXT_FORWARD_CAROL,
    );

    appHookState.next = { decision: DECISION_BLOCK, reason: BLOCK_REASON };
    yield* Effect.either(sendText(alice, conversationId, TEXT_BLOCKED_SECOND));

    appHookState.next = {
      decision: DECISION_FORWARD,
      recipients: [bob.agentId as AgentId],
    };
    const bobForward = yield* sendText(alice, conversationId, TEXT_FORWARD_BOB);

    const aliceList = yield* alice.client.sendRpc(MessagesList, {
      conversationId,
    });
    const aliceIds = aliceList.messages.map((message) => message.id).sort();
    const allIds = (yield* readAllMessageIdsForConversation(conversationId))
      .slice()
      .sort();
    expect(aliceIds).toEqual(allIds);

    const bobList = yield* bob.client.sendRpc(MessagesList, { conversationId });
    expect(bobList.messages.map((message) => message.id)).toEqual([
      bobForward.message.id,
    ]);

    const carolList = yield* carol.client.sendRpc(MessagesList, {
      conversationId,
    });
    expect(carolList.messages.map((message) => message.id)).toEqual([
      carolForward.message.id,
    ]);
  });
}

function casGuardPreservesCommittedVerdict() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    registerTmHook(alice.agentId);
    const task = yield* createSelfTask(alice);
    const conv = yield* createManagedDm(alice, task.task.id, bob);
    const conversationId = conv.conversation.id as ConversationId;

    appHookState.next = {
      decision: DECISION_FORWARD,
      recipients: [bob.agentId as AgentId],
    };
    const sent = yield* sendText(alice, conversationId, TEXT_RACE);
    const messageId = sent.message.id;

    expectDecisionTag(yield* readTmDecision(messageId), VERDICT_TAG_FORWARD);
    const updated = yield* attemptPendingCasBlock(messageId);
    expect(updated.length).toBe(0);
    expectDecisionTag(yield* readTmDecision(messageId), VERDICT_TAG_FORWARD);
  });
}

describe("messages/authorize — block verdict paths", () => {
  it(
    "Block: sender fails, recipient receives no message, DB row records block",
    blockVerdictPreventsFanoutAndPersistsBlock,
    TEST_TIMEOUT_MS,
  );

  it(
    "TM unreachable: envelope synthesizes Block and suppresses fan-out",
    tmUnreachableSynthesizesBlock,
    TEST_TIMEOUT_MS,
  );

  it(
    "default-DM messageAuthorize: replacing the default hook with Block changes behavior",
    defaultDmHookBlockChangesBehavior,
    TEST_TIMEOUT_MS,
  );
});

describe("messages/authorize — forward verdict paths", () => {
  it(
    "Forward subset: only TM-authorized recipients see messages/received",
    forwardSubsetOnlyNotifiesAuthorizedRecipient,
    TEST_TIMEOUT_MS,
  );

  it(
    "Forward empty: send succeeds, no fan-out, row records empty recipients",
    forwardEmptySendsNoFanout,
    TEST_TIMEOUT_MS,
  );
});

describe("messages/authorize — visibility filter", () => {
  it(
    "Sender sees own forward + own block; recipient sees only forwards-containing-self",
    senderAndRecipientsSeeOnlyAuthorizedRows,
    TEST_TIMEOUT_MS,
  );
});

describe("messages/authorize — CAS race", () => {
  it(
    "CAS guard: second pending-predicate update matches no rows and preserves committed state",
    casGuardPreservesCommittedVerdict,
    TEST_TIMEOUT_MS,
  );
});
