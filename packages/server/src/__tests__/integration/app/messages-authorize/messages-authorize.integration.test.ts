/** Integration coverage for the `app/message/authorize` send-side gate. */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Chunk, Data, Duration, Effect, Either, Fiber, Stream } from "effect";
import { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import {
  messageReceivedNotificationDefinition,
  messagesAuthorize,
  messagesList,
  messagesSend,
} from "@moltzap/protocol/message";
import {
  conversationCreate,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import type { AgentId, AppId, AppManifest } from "@moltzap/protocol/identity";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
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
  type TestAppClient,
} from "../../helpers.js";
import {
  conversationId as toConversationId,
  messageId as toMessageId,
  WIRE_ERROR_TAG,
} from "@moltzap/protocol/testing";

const it = effectIt.live;

const TEST_APP_ID =
  /* Safe because the test fixture establishes this asserted shape. */ "00000000-0000-4d11-8000-00000000a121" as AppId;
const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Messages-Authorize Test App",
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "hook", timeoutMs: 5_000 },
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
  | { decision: typeof DECISION_FORWARD; recipients: readonly AgentId[] }
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
 * Per-test moderator app principal. Its callbacks and app-owned RPCs run on
 * the app connection; the requesting agent drives `agent/message/send`.
 *
 * `sender` is the requesting agent. The app creates conversations with
 * `seedCreatorAsParticipant: false`, so the sender must be listed as a
 * participant for `agent/message/send` to reach `app/message/authorize`.
 */
interface ModeratorApp {
  readonly client: TestAppClient;
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
 * Server→client callbacks served by the moderator app principal. The
 * scenarios exercise `app/message/authorize`.
 * @returns The moderator handlers result.
 */
function moderatorHandlers(): AppCallbackHandlers<AppCallbackContext> {
  return {
    [dispatchAuthorize.name]: {
      definition: dispatchAuthorize,
      handle: () => Effect.dieMessage("unexpected app/dispatch/authorize"),
    },
    [messagesAuthorize.name]: {
      definition: messagesAuthorize,
      handle: () =>
        Effect.gen(function* () {
          appHookState.calls += 1;
          const verdict = appHookState.next;
          if ("kind" in verdict && verdict.kind === NEVER_REPLY) {
            return yield* Effect.never;
          }
          return {
            verdict:
              /* Safe because the test fixture establishes this asserted shape. */ verdict as MessageAuthorizeVerdict,
          };
        }),
    },
  };
}

function currentModeratorApp(): ModeratorApp {
  if (moderatorApp === null) {
    throw new Error("moderatorApp: not minted — call mintModeratorApp first");
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
): Effect.Effect<readonly string[], MessagesAuthorizeDbError> {
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
  readonly conversationId: ConversationId;
}

/**
 * Settle-window collector for `messages/received` notifications. Fork
 * BEFORE the triggering send and join after; `Stream.interruptAfter`
 * bounds collection so the assert doesn't block when no event is
 * expected.
 * @param agent Agent fixture that performs the operation.
 * @param settle Value supplied to the operation.
 * @returns The fork message received collector result.
 */
function forkMessageReceivedCollector(
  agent: ConnectedAgent,
  settle: Duration.DurationInput,
) {
  return agent.client
    .subscribe(messageReceivedNotificationDefinition)
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
      const wire =
        /* Safe because the test fixture establishes this asserted shape. */ error as {
          _tag?: string;
          message?: string;
        };
      expect(wire._tag).toBe(WIRE_ERROR_TAG.HookBlocked);
      if (messagePattern !== undefined) {
        expect(String(wire.message)).toMatch(messagePattern);
      }
    },
    onRight: () => expect.fail("expected HookBlockedError"),
  });
}

function expectDecisionTag(decision: unknown, tag: string): void {
  expect(
    /* Safe because the test fixture establishes this asserted shape. */
    (decision as { tag?: string }).tag,
  ).toBe(tag);
}

function expectDecisionReason(decision: unknown, reason: string): void {
  expect(
    /* Safe because the test fixture establishes this asserted shape. */
    (decision as { reason?: string }).reason,
  ).toBe(reason);
}

function expectDecisionRecipients(
  decision: unknown,
  recipients: readonly string[],
) {
  expect(
    /* Safe because the test fixture establishes this asserted shape. */
    (decision as { recipients?: readonly string[] }).recipients,
  ).toEqual(recipients);
}

/**
 * Mint the moderator app principal (HTTP register → `appKey` Connect) and
 * wire its callbacks. Every conversation it creates carries its DB-minted
 * `appId` (NOT `TEST_APP_MANIFEST.appId`) as the routing key, so the app's
 * `AppConnection` is the resolved moderator endpoint. Memoizes the app client
 * for the rest of the test so subsequent conversation creates reuse one app
 * principal.
 * @param agent The requesting agent that drives `agent/message/send`.
 * @returns The minted moderator app.
 */
function mintModeratorApp(agent: ConnectedAgent) {
  return Effect.gen(function* () {
    const registered = yield* registerApp(getBaseUrl(), TEST_APP_MANIFEST);
    const client = yield* connectAppClient(
      registered.appId,
      registered.appKey,
      moderatorHandlers(),
    );
    const minted: ModeratorApp = { client, sender: agent };
    moderatorApp = minted;
    return minted;
  });
}

// The app creates conversations off its own `AppConnection`
// (`seedCreatorAsParticipant: false`); the sender agent is added
// explicitly so its `agent/message/send` passes the participant gate.
function createManagedGroup(
  name: string,
  participants: readonly ConnectedAgent[],
) {
  const app = currentModeratorApp();
  return app.client.sendRpc(conversationCreate, {
    name,
    participants: [app.sender.agentId, ...participants.map((p) => p.agentId)],
  });
}

function createManagedDm(participant: ConnectedAgent) {
  const app = currentModeratorApp();
  return app.client.sendRpc(conversationCreate, {
    participants: [app.sender.agentId, participant.agentId],
  });
}

function sendText(
  agent: ConnectedAgent,
  binding: ConversationBinding,
  text: string,
) {
  return agent.client.sendRpc(messagesSend, {
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
    messagesSend,
    {
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

    yield* mintModeratorApp(alice);
    const conv = yield* createManagedGroup(CONV_NAME_BLOCK, [bob]);
    const binding: ConversationBinding = {
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
    const decision = yield* readDispatchDecision(
      /* Safe because the test fixture establishes this asserted shape. */ ids[0]!,
    );
    expectDecisionTag(decision, VERDICT_TAG_BLOCK);
    expectDecisionReason(decision, BLOCK_REASON);
  });
}

function tmUnreachableSynthesizesBlock() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    appHookState.next = { kind: NEVER_REPLY };

    yield* mintModeratorApp(alice);
    const conv = yield* createManagedDm(bob);
    const binding: ConversationBinding = {
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

    yield* mintModeratorApp(alice);
    const conv = yield* createManagedGroup(CONV_NAME_SUBSET, [
      bob,
      carol,
      dave,
    ]);
    const binding: ConversationBinding = {
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

    yield* mintModeratorApp(alice);
    const conv = yield* createManagedDm(bob);
    const binding: ConversationBinding = {
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
    const aliceList = yield* alice.client.sendRpc(messagesList, {
      conversationId: binding.conversationId,
    });
    const allIds = (yield* readAllMessageIdsForConversation(
      binding.conversationId,
    ))
      .slice()
      .sort((left, right) => left.localeCompare(right));
    expect(
      aliceList.messages
        .map((message) => message.id)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(allIds);
    const bobList = yield* bob.client.sendRpc(messagesList, {
      conversationId: binding.conversationId,
    });
    expect(bobList.messages.map((m) => m.id)).toEqual([
      forwarded.bobForward.message.id,
    ]);
    const carolList = yield* carol.client.sendRpc(messagesList, {
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
    yield* mintModeratorApp(alice);
    const conv = yield* createManagedGroup(CONV_NAME_VISIBILITY, [bob, carol]);
    const binding: ConversationBinding = {
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
    yield* mintModeratorApp(alice);
    const conv = yield* createManagedDm(bob);
    const binding: ConversationBinding = {
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

describe("app/message/authorize — block verdict paths", () => {
  it(
    "Block: sender fails, recipient receives no message, DB row records block",
    blockVerdictPreventsFanoutAndPersistsBlock,
    TEST_TIMEOUT_MS,
  );

  it(
    "app unreachable: envelope synthesizes Block and suppresses fan-out",
    tmUnreachableSynthesizesBlock,
    TEST_TIMEOUT_MS,
  );

  // DEFAULT_APP_ID is boot-installed in-process; no connected app can
  // register over it. The app/message/authorize verdict for
  // DEFAULT_APP_ID conversations is fixed to the default Forward policy
  // and cannot be overridden.
});

describe("app/message/authorize — forward verdict paths", () => {
  it(
    "Forward subset: only app-authorized recipients see messages/received",
    forwardSubsetOnlyNotifiesAuthorizedRecipient,
    TEST_TIMEOUT_MS,
  );

  it(
    "Forward empty: send succeeds, no fan-out, row records empty recipients",
    forwardEmptySendsNoFanout,
    TEST_TIMEOUT_MS,
  );
});

describe("app/message/authorize — visibility filter", () => {
  it(
    "Sender sees own forward + own block; recipient sees only forwards-containing-self",
    senderAndRecipientsSeeOnlyAuthorizedRows,
    TEST_TIMEOUT_MS,
  );
});

describe("app/message/authorize — CAS race", () => {
  it(
    "CAS guard: second pending-predicate update matches no rows and preserves committed state",
    casGuardPreservesCommittedVerdict,
    TEST_TIMEOUT_MS,
  );
});
