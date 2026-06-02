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
  TaskCreate,
  MessagesAuthorize,
  MessagesList,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  TaskConversationCreate,
  TaskRequest,
  type AgentId,
  type AppId,
  type AppManifest,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  setupAgentPair,
  registerApp,
  connectAppClient,
  getKyselyDb,
  getBaseUrl,
  type ConnectedAgent,
  type ServerTestClient,
} from "../../helpers.js";
import {
  conversationId as toConversationId,
  messageId as toMessageId,
  WIRE_ERROR_TAG,
} from "@moltzap/protocol/testing";

const it = effectIt.live;

const TEST_APP_ID = "00000000-0000-4d11-8000-00000000a121" as AppId;
const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Messages-Authorize Test App",
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "hook", timeoutMs: 5_000 },
    task_create: { kind: "accept" },
  },
};

const DECISION_FORWARD = "Forward";
const DECISION_BLOCK = "Block";
const NEVER_REPLY = "never-reply";
const VERDICT_TAG_FORWARD = "forward";
const VERDICT_TAG_BLOCK = "block";
const VERDICT_TAG_PENDING = "pending";
const BLOCK_REASON = "test-block";
const RACE_LOSER_REASON = "race-loser";
const BLOCK_MESSAGE_PATTERN = /block/i;
const CONV_NAME_BLOCK = "ma-block";
const CONV_NAME_SUBSET = "ma-subset";
const CONV_NAME_VISIBILITY = "vis-test";
const TEXT_BLOCKED = "blocked-msg";
const TEXT_SUBSET = "subset-msg";
const TEXT_UNREACHABLE = "unreachable";
const TEXT_EMPTY_FORWARD = "empty-forward";
const TEXT_FORWARD_CAROL = "m1-forward-carol";
const TEXT_BLOCKED_SECOND = "m2-blocked";
const TEXT_FORWARD_BOB = "m3-forward-bob";
const TEXT_RACE = "race";
const SHORT_SETTLE = "200 millis";
const LONG_SETTLE = "300 millis";
const SERVER_TIMEOUT_BUDGET_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 60_000;

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

/**
 * D #705 CP9 — the per-test moderator app is a SEPARATE app principal:
 * it registers via the `/api/v1/apps/register` HTTP endpoint and Connects
 * with its minted `appKey`, yielding an `AppConnection`. The
 * `messages/authorize` + `task/create` callbacks and the TM-admin
 * `task/conversation/create` RPCs run on THIS connection (all
 * `callablePrincipal: "app"`), disjoint from the requesting agent
 * (`alice`) who drives the agent-only `task/request` + `messages/send`.
 * Lazily minted by `createAppManagedTask`; the `beforeEach` reset closes
 * all clients via `resetTestDbEffect`, so the stale handle is dropped
 * here before the next test re-mints one.
 *
 * `sender` is the requesting agent (`alice`): the app creates conversations
 * with `seedCreatorAsParticipant: false`, so the sender MUST be listed as a
 * conversation participant or its `messages/send` is rejected with
 * `ForbiddenError` BEFORE the `messages/authorize` round-trip fires.
 */
interface ModeratorApp {
  readonly client: ServerTestClient;
  readonly sender: ConnectedAgent;
}

let moderatorApp: ModeratorApp | null = null;

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
          moderatorApp = null;
        }),
      ),
    ),
  ),
);

/**
 * Wire the server→client `messages/authorize` + `task/create` callbacks
 * on the moderator app principal `client`. Both are `callablePrincipal:
 * "app"` server-initiated round-trips; they MUST be live before the app
 * registers a routing endpoint so the verdict source is ready when the
 * first `messages/send` fires. `task/create` auto-accepts (these scenarios
 * exercise `messages/authorize`, not task admission).
 */
function wireModeratorCallbacks(client: ServerTestClient) {
  return Effect.gen(function* () {
    yield* client.onAppCallback(MessagesAuthorize, () =>
      Effect.gen(function* () {
        appHookState.calls += 1;
        const verdict = appHookState.next;
        if ("kind" in verdict && verdict.kind === NEVER_REPLY) {
          return yield* Effect.never;
        }
        return { verdict: verdict as MessageAuthorizeVerdict };
      }),
    );
    yield* client.onAppCallback(TaskCreate, () =>
      Effect.succeed({ verdict: { decision: "accept" as const } }),
    );
  });
}

function currentModeratorApp(): ModeratorApp {
  if (moderatorApp === null) {
    throw new Error(
      "moderatorApp: not minted — call createAppManagedTask first",
    );
  }
  return moderatorApp;
}

function dbError(message: string, cause: unknown) {
  return new MessagesAuthorizeDbError({ message, cause });
}

function readDispatchDecision(
  messageId: string,
): Effect.Effect<unknown, MessagesAuthorizeDbError> {
  return Effect.tryPromise({
    try: () =>
      getKyselyDb()
        .selectFrom("messages")
        .select("dispatch_decision")
        .where("id", "=", toMessageId(messageId))
        .executeTakeFirstOrThrow(),
    catch: (cause) => dbError("Unable to read dispatch_decision", cause),
  }).pipe(Effect.map((row) => row.dispatch_decision));
}

function readAllMessageIdsForConversation(
  conversationId: string,
): Effect.Effect<ReadonlyArray<string>, MessagesAuthorizeDbError> {
  return Effect.tryPromise({
    try: () =>
      getKyselyDb()
        .selectFrom("messages")
        .select("id")
        .where("conversation_id", "=", toConversationId(conversationId))
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
          dispatch_decision: {
            tag: VERDICT_TAG_BLOCK,
            reason: RACE_LOSER_REASON,
          },
        })
        .where("id", "=", toMessageId(messageId))
        .where(
          "dispatch_decision",
          "@>",
          JSON.stringify({ tag: VERDICT_TAG_PENDING }),
        )
        .returning("id")
        .execute(),
    catch: (cause) => dbError("Unable to attempt pending CAS update", cause),
  });
}

interface ConversationBinding {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

/**
 * Settle-window collector for `messages/received` notifications. Fork
 * BEFORE the triggering send and join after; `Stream.interruptAfter`
 * bounds collection so the assert doesn't block when no event is
 * expected.
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
      expect(wire.code).toBe(WIRE_ERROR_TAG.HookBlocked);
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
) {
  expect(
    (decision as { recipients?: ReadonlyArray<string> }).recipients,
  ).toEqual(recipients);
}

/**
 * Mint the moderator app principal (HTTP register → `appKey` Connect),
 * wire its callbacks, then have the requesting `agent` drive the
 * agent-only `task/request` against the DB-minted `appId`. The
 * server-minted `appId` (NOT `TEST_APP_MANIFEST.appId`) is what
 * `task/request` targets so the app's `AppConnection` is the resolved
 * moderator endpoint. Memoizes the app client for the rest of the test so
 * subsequent conversation creates reuse one app principal.
 */
function createAppManagedTask(
  agent: ConnectedAgent,
  invited: ReadonlyArray<ConnectedAgent>,
) {
  return Effect.gen(function* () {
    const registered = yield* registerApp(getBaseUrl(), TEST_APP_MANIFEST);
    const client = yield* connectAppClient(registered.appKey);
    moderatorApp = { client, sender: agent };
    yield* wireModeratorCallbacks(client);
    return yield* agent.client.sendRpc(TaskRequest, {
      appId: registered.appId,
      invitedAgentIds: invited.map((a) => a.agentId),
    });
  });
}

// The app creates conversations off its own `AppConnection`
// (`seedCreatorAsParticipant: false`); the sender agent is added
// explicitly so its `messages/send` passes the participant gate.
function createManagedGroup(
  taskId: TaskId,
  name: string,
  participants: ReadonlyArray<ConnectedAgent>,
) {
  const app = currentModeratorApp();
  return app.client.sendRpc(TaskConversationCreate, {
    taskId,
    name,
    participants: [app.sender.agentId, ...participants.map((p) => p.agentId)],
  });
}

function createManagedDm(taskId: TaskId, participant: ConnectedAgent) {
  const app = currentModeratorApp();
  return app.client.sendRpc(TaskConversationCreate, {
    taskId,
    participants: [app.sender.agentId, participant.agentId],
  });
}

function sendText(
  agent: ConnectedAgent,
  binding: ConversationBinding,
  text: string,
) {
  return agent.client.sendRpc(MessagesSend, {
    taskId: binding.taskId,
    conversationId: binding.conversationId,
    parts: [{ type: "text", text }],
  });
}

function sendTextWithTimeout(
  agent: ConnectedAgent,
  binding: ConversationBinding,
  text: string,
  timeoutMs: number,
) {
  return agent.client.sendRpc(
    MessagesSend,
    {
      taskId: binding.taskId,
      conversationId: binding.conversationId,
      parts: [{ type: "text", text }],
    },
    { timeoutMs },
  );
}

function blockVerdictPreventsFanoutAndPersistsBlock() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    appHookState.next = { decision: DECISION_BLOCK, reason: BLOCK_REASON };

    const task = yield* createAppManagedTask(alice, [bob]);
    const conv = yield* createManagedGroup(task.task.id, CONV_NAME_BLOCK, [
      bob,
    ]);
    const binding: ConversationBinding = {
      taskId: task.task.id,
      conversationId: conv.conversation.id,
    };
    const bobCollector = yield* forkMessageReceivedCollector(bob, SHORT_SETTLE);
    const outcome = yield* Effect.either(
      sendText(alice, binding, TEXT_BLOCKED),
    );
    expectHookBlocked(outcome, BLOCK_MESSAGE_PATTERN);
    expect(appHookState.calls).toBe(1);

    yield* assertNoMessageReceived(bobCollector);

    const ids = yield* readAllMessageIdsForConversation(binding.conversationId);
    expect(ids.length).toBe(1);
    const decision = yield* readDispatchDecision(ids[0]!);
    expectDecisionTag(decision, VERDICT_TAG_BLOCK);
    expectDecisionReason(decision, BLOCK_REASON);
  });
}

function tmUnreachableSynthesizesBlock() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    appHookState.next = { kind: NEVER_REPLY };

    const task = yield* createAppManagedTask(alice, [bob]);
    const conv = yield* createManagedDm(task.task.id, bob);
    const binding: ConversationBinding = {
      taskId: task.task.id,
      conversationId: conv.conversation.id,
    };
    const bobCollector = yield* forkMessageReceivedCollector(bob, SHORT_SETTLE);
    const outcome = yield* Effect.either(
      sendTextWithTimeout(
        alice,
        binding,
        TEXT_UNREACHABLE,
        SERVER_TIMEOUT_BUDGET_MS,
      ),
    );
    expectHookBlocked(outcome);

    yield* assertNoMessageReceived(bobCollector);
  });
}

function forwardSubsetOnlyNotifiesAuthorizedRecipient() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-sub");
    const bob = yield* registerAndConnect("bob-sub");
    const carol = yield* registerAndConnect("carol-sub");
    const dave = yield* registerAndConnect("dave-sub");

    const task = yield* createAppManagedTask(alice, [bob, carol, dave]);
    const conv = yield* createManagedGroup(task.task.id, CONV_NAME_SUBSET, [
      bob,
      carol,
      dave,
    ]);
    const binding: ConversationBinding = {
      taskId: task.task.id,
      conversationId: conv.conversation.id,
    };
    appHookState.next = {
      decision: DECISION_FORWARD,
      recipients: [carol.agentId],
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
    const sent = yield* sendText(alice, binding, TEXT_SUBSET);
    const messageId = sent.message.id;

    yield* assertExactMessageReceived(carolCollector, 1);
    yield* assertNoMessageReceived(bobCollector);
    yield* assertNoMessageReceived(daveCollector);

    const decision = yield* readDispatchDecision(messageId);
    expectDecisionTag(decision, VERDICT_TAG_FORWARD);
    expectDecisionRecipients(decision, [carol.agentId]);
  });
}

function forwardEmptySendsNoFanout() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    appHookState.next = { decision: DECISION_FORWARD, recipients: [] };

    const task = yield* createAppManagedTask(alice, [bob]);
    const conv = yield* createManagedDm(task.task.id, bob);
    const binding: ConversationBinding = {
      taskId: task.task.id,
      conversationId: conv.conversation.id,
    };
    const bobCollector = yield* forkMessageReceivedCollector(bob, SHORT_SETTLE);
    const sent = yield* sendText(alice, binding, TEXT_EMPTY_FORWARD);
    const messageId = sent.message.id;

    yield* assertNoMessageReceived(bobCollector);
    const decision = yield* readDispatchDecision(messageId);
    expectDecisionTag(decision, VERDICT_TAG_FORWARD);
    expectDecisionRecipients(decision, []);
  });
}

function sendThreeAuthorizedMessages(input: {
  readonly alice: ConnectedAgent;
  readonly bob: ConnectedAgent;
  readonly carol: ConnectedAgent;
  readonly binding: ConversationBinding;
}) {
  const { alice, bob, carol, binding } = input;
  return Effect.gen(function* () {
    appHookState.next = {
      decision: DECISION_FORWARD,
      recipients: [carol.agentId],
    };
    const carolForward = yield* sendText(alice, binding, TEXT_FORWARD_CAROL);
    appHookState.next = { decision: DECISION_BLOCK, reason: BLOCK_REASON };
    yield* Effect.either(sendText(alice, binding, TEXT_BLOCKED_SECOND));
    appHookState.next = {
      decision: DECISION_FORWARD,
      recipients: [bob.agentId],
    };
    const bobForward = yield* sendText(alice, binding, TEXT_FORWARD_BOB);
    return { carolForward, bobForward };
  });
}

interface VisibilityCheckInput {
  readonly alice: ConnectedAgent;
  readonly bob: ConnectedAgent;
  readonly carol: ConnectedAgent;
  readonly binding: ConversationBinding;
  readonly forwarded: {
    readonly carolForward: { message: { id: string } };
    readonly bobForward: { message: { id: string } };
  };
}

function expectPerCallerVisibility(input: VisibilityCheckInput) {
  const { alice, bob, carol, binding, forwarded } = input;
  return Effect.gen(function* () {
    const aliceList = yield* alice.client.sendRpc(MessagesList, {
      taskId: binding.taskId,
      conversationId: binding.conversationId,
    });
    const allIds = (yield* readAllMessageIdsForConversation(
      binding.conversationId,
    ))
      .slice()
      .sort();
    expect(aliceList.messages.map((m) => m.id).sort()).toEqual(allIds);
    const bobList = yield* bob.client.sendRpc(MessagesList, {
      taskId: binding.taskId,
      conversationId: binding.conversationId,
    });
    expect(bobList.messages.map((m) => m.id)).toEqual([
      forwarded.bobForward.message.id,
    ]);
    const carolList = yield* carol.client.sendRpc(MessagesList, {
      taskId: binding.taskId,
      conversationId: binding.conversationId,
    });
    expect(carolList.messages.map((m) => m.id)).toEqual([
      forwarded.carolForward.message.id,
    ]);
  });
}

function senderAndRecipientsSeeOnlyAuthorizedRows() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-vis");
    const bob = yield* registerAndConnect("bob-vis");
    const carol = yield* registerAndConnect("carol-vis");
    const task = yield* createAppManagedTask(alice, [bob, carol]);
    const conv = yield* createManagedGroup(task.task.id, CONV_NAME_VISIBILITY, [
      bob,
      carol,
    ]);
    const binding: ConversationBinding = {
      taskId: task.task.id,
      conversationId: conv.conversation.id,
    };
    const forwarded = yield* sendThreeAuthorizedMessages({
      alice,
      bob,
      carol,
      binding,
    });
    yield* expectPerCallerVisibility({
      alice,
      bob,
      carol,
      binding,
      forwarded,
    });
  });
}

function casGuardPreservesCommittedVerdict() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const task = yield* createAppManagedTask(alice, [bob]);
    const conv = yield* createManagedDm(task.task.id, bob);
    const binding: ConversationBinding = {
      taskId: task.task.id,
      conversationId: conv.conversation.id,
    };

    appHookState.next = {
      decision: DECISION_FORWARD,
      recipients: [bob.agentId],
    };
    const sent = yield* sendText(alice, binding, TEXT_RACE);
    const messageId = sent.message.id;

    expectDecisionTag(
      yield* readDispatchDecision(messageId),
      VERDICT_TAG_FORWARD,
    );
    const updated = yield* attemptPendingCasBlock(messageId);
    expect(updated.length).toBe(0);
    expectDecisionTag(
      yield* readDispatchDecision(messageId),
      VERDICT_TAG_FORWARD,
    );
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

  // DEFAULT_APP_ID is boot-installed in-process; a wire-app
  // AppsRegister against it is rejected. The messages/authorize
  // verdict for DEFAULT_APP_ID tasks is fixed to the default Forward
  // policy and cannot be overridden.
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
