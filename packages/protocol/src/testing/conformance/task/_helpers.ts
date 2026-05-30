/**
 * Task-layer helpers shared by delivery / lifecycle / isolation
 * properties. Carved verbatim from `conformance/delivery.ts@961a5c8`.
 */
import {
  Chunk,
  Duration,
  Effect,
  Either,
  Fiber,
  Option,
  Ref,
  Stream,
  Scope,
} from "effect";
import type { AnyNotificationDefinition } from "../../../rpc-registry.js";
import type { NotificationParamsOf } from "../../../transport/method.js";
import type { DecodedNotification } from "../../../transport/rpc-groups.js";
import {
  ConversationArchivedError,
  MessageReceivedNotificationDefinition,
  MessagesSend,
  ConversationId,
  TaskConversationArchive,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationUnarchive,
  TaskConversationUnarchivedNotificationDefinition,
  TaskRequest,
  TaskId,
} from "../../../task/methods.js";
import {
  DispatchAuthorize,
  MessagesAuthorize,
  TaskCreate,
} from "../../../app/methods.js";
import {
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
} from "../../../task/methods.js";
import { AppId as AppIdSchema } from "../../../task/ids.js";
import type { Static } from "@sinclair/typebox";
import { AgentId } from "../../../identity/methods.js";
import {
  conversationId as makeConversationId,
  taskId as makeTaskId,
} from "../_shared/test-fixtures.js";
import { RpcResponseError } from "../_shared/errors.js";
import {
  makeTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import { registerTestApp } from "../_shared/test-app.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyInvariantViolation } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";

export const DELIVERY_CATEGORY = "delivery" as const;
export const DELIVERY_DEFAULT_TIMEOUT_MS = 5000;
export const DELIVERY_DEFAULT_CAPTURE_CAPACITY = 256;
export const DELIVERY_DEFAULT_PROPERTY_NUM_RUNS = 3;
const MAX_N = 4;

export interface ConversationFixture {
  readonly owner: ConversationActor;
  readonly participants: ReadonlyArray<ConversationActor>;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;

  /**
   * D #705 CP9 — the app-principal `AppConnection` bound as the
   * conversation's moderator. TM-admin RPCs (archive, unarchive,
   * addParticipant, removeParticipant, close) are `callablePrincipal:
   * "app"`, so they route through THIS client, not the agent `owner`.
   * `owner` (an agent) still drives `task/request` + `messages/send`.
   */
  readonly moderatorClient: TestClient;
}

export type ConversationActor = {
  readonly agent: TestAgent;
  readonly client: TestClient;

  /**
   * Per-client historical notification buffer (#645): the consolidated
   * `TestClient.subscribe` only emits frames arriving AFTER
   * materialisation, so a sequential `send → awaitOneNotification` races
   * the response frame. The buffer is fed by a long-lived
   * `subscribeAll()` pump installed at `acquireClient` time;
   * `awaitOneNotification` consumes the buffer so frames that arrived
   * between the triggering RPC and the wait are still observable. This
   * mirrors `@moltzap/server-core/test-utils → connectTestClient` (the
   * `makeNotificationBuffer` JSDoc below covers the design).
   */
  readonly notifications: NotificationBuffer;
};

/**
 * Historical notification buffer used by `awaitOneNotification`. Holds
 * every inbound notification arriving on a single `TestClient`'s
 * `subscribeAll()` Stream until a consumer pulls a matching frame.
 *
 * The `snapshot` and `closed` fields are the only public surfaces;
 * the pump fiber that feeds them is interrupted by the enclosing
 * Scope finalizer installed by `makeNotificationBuffer`. `closed` is
 * set to true when the transport-side stream terminates (either via
 * `TransportClosedError` or normal exhaustion); `awaitOneNotification`
 * consumes it to surface "Connection closed" rather than masquerading
 * a missing notification as a timeout.
 */
export interface NotificationBuffer {
  readonly snapshot: Ref.Ref<
    ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
  >;
  readonly closed: Ref.Ref<boolean>;
}

const PUMP_POLL_INTERVAL_MS = 5;

/**
 * Fork a `subscribeAll()` pump that appends every inbound notification
 * to a shared snapshot Ref. The pump fiber's interrupt is registered
 * with the enclosing `Scope` so callers do not have to thread the
 * lifecycle through their own finalizers. Conformance `acquireClient`
 * sites consume via `actor.notifications`.
 *
 * Why a snapshot Ref instead of pulling the Stream directly: the
 * `RPC → wait-for-notification` pattern needs frames that arrive
 * BETWEEN the triggering RPC and the wait. `Stream.async` only emits
 * frames that arrive after materialisation, so a fresh `subscribe`
 * inside the wait loop would race-miss any frame already dispatched.
 * The buffer pump materialises eagerly at actor acquisition time;
 * subsequent waits poll the snapshot and remove the matched frame,
 * preserving the historical-buffer semantic the test pattern needs.
 *
 * Registration is single-shot inside `Stream.runForEach`'s synchronous
 * setup phase, which runs as the first action of the forked fiber.
 * In practice the network round-trip of any subsequent test RPC
 * dominates fork-scheduling delay. Tests that genuinely need a
 * tighter fence pre-subscribe via `client.subscribe(def)` directly
 * before the triggering RPC and consume the Stream with
 * `Stream.runHead`.
 */
function makeNotificationBuffer(
  client: TestClient,
): Effect.Effect<NotificationBuffer, never, Scope.Scope> {
  return Effect.gen(function* () {
    const snapshot = yield* Ref.make<
      ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
    >([]);
    const closed = yield* Ref.make<boolean>(false);
    const pumpFiber = yield* Effect.fork(
      client.subscribeAll().pipe(
        Stream.runForEach((frame) =>
          Ref.update(snapshot, (xs) => [...xs, frame]),
        ),
        // Terminal close fires `TransportClosedError`; the pump
        // exits — flip `closed` so consumers polling the snapshot
        // can fail with a transport-close diagnostic rather than a
        // generic timeout. Buffered frames that arrived before the
        // close stay available for one final drain.
        Effect.ensuring(Ref.set(closed, true)),
        Effect.catchAll(() => Effect.void),
      ),
    );
    yield* Effect.addFinalizer(() => Fiber.interrupt(pumpFiber));
    return { snapshot, closed };
  });
}

function pullMatchingFromBuffer<D extends AnyNotificationDefinition>(
  buffer: NotificationBuffer,
  definition: D,
): Effect.Effect<DecodedNotification<D> | null> {
  return Ref.modify(buffer.snapshot, (frames) => {
    const idx = frames.findIndex((frame) => frame.definition === definition);
    if (idx < 0) return [null, frames];
    const matched = frames[idx] as DecodedNotification<D>;
    const rest = [...frames.slice(0, idx), ...frames.slice(idx + 1)];
    return [matched, rest];
  });
}

/**
 * Sentinel error tag surfaced when the underlying transport closed
 * before a matching notification arrived. Distinguishing close from
 * timeout helps debug genuine transport failures rather than silently
 * masquerading them as missing notifications.
 */
const BUFFERED_STREAM_CLOSED = "BUFFERED_STREAM_CLOSED" as const;
type BufferedStreamClosed = typeof BUFFERED_STREAM_CLOSED;

/**
 * Stream that polls the historical buffer for the first frame matching
 * `definition`, emits it as a singleton chunk, and removes it from the
 * buffer. Empty chunks back off the poll without terminating the stream
 * so `Stream.runHead` blocks until either a match arrives, the buffer's
 * pump signals close, or `Effect.timeoutFail` fires upstream. If the
 * pump has closed AND no matching frame remains, the stream fails with
 * `BUFFERED_STREAM_CLOSED` so the upstream waiter surfaces a transport
 * diagnostic rather than a generic timeout.
 */
function bufferedSubscribeStream<D extends AnyNotificationDefinition>(
  buffer: NotificationBuffer,
  definition: D,
): Stream.Stream<DecodedNotification<D>, BufferedStreamClosed> {
  return Stream.repeatEffectChunk(
    pullMatchingFromBuffer(buffer, definition).pipe(
      Effect.flatMap((maybe) => {
        if (maybe !== null) return Effect.succeed(Chunk.of(maybe));
        return Ref.get(buffer.closed).pipe(
          Effect.flatMap((isClosed) =>
            isClosed
              ? Effect.fail(BUFFERED_STREAM_CLOSED)
              : Effect.sleep(Duration.millis(PUMP_POLL_INTERVAL_MS)).pipe(
                  Effect.as(Chunk.empty<DecodedNotification<D>>()),
                ),
          ),
        );
      }),
    ),
  );
}

type MessageEventData = {
  readonly message?: {
    readonly conversationId?: unknown;
  };
};

export function deliveryViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation {
  return new PropertyInvariantViolation({
    category: DELIVERY_CATEGORY,
    name,
    reason,
  });
}

/**
 * Stream-based one-shot waiter for protocol-side conformance helpers.
 * Replaces the deleted `TestClient.waitForNotification(def, timeoutMs)`
 * polling shape (#645).
 *
 * Consumes the per-client historical `NotificationBuffer` populated by
 * the `subscribeAll()` pump installed at `acquireClient` time, so
 * sequential `send → awaitOneNotification` patterns observe frames
 * that arrived between the triggering RPC and the wait — the legacy
 * polling semantic preserved without resurrecting the deleted
 * per-definition dedup ring. Mirrors
 * `@moltzap/server-core/test-utils → awaitOneNotification`.
 *
 * Surfaces a single string message on either timeout or stream
 * exhaustion so call sites preserve the legacy `e.message`-style error
 * mapper without re-deriving a tagged error type per definition.
 */
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  buffer: NotificationBuffer,
  definition: D,
  timeoutMs: number,
): Effect.Effect<DecodedNotification<D>, string> {
  return bufferedSubscribeStream(buffer, definition).pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () => `Timeout waiting for notification: ${definition.name}`,
    }),
    Effect.mapError((err) =>
      err === BUFFERED_STREAM_CLOSED
        ? `Connection closed while waiting for notification: ${definition.name}`
        : err,
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            `Stream exhausted while waiting for notification: ${definition.name}`,
          ),
        onSome: (notification) => Effect.succeed(notification),
      }),
    ),
  );
}

export function fixtureN(requested: number): number {
  return Math.min(Math.max(1, requested), MAX_N);
}

export function acquirePropertyConversation(
  ctx: ConformanceRunContext,
  propertyName: string,
  namePrefix: string,
): Effect.Effect<ConversationFixture, PropertyInvariantViolation, Scope.Scope> {
  return acquireConversation(ctx, 1, namePrefix).pipe(
    Effect.mapError((e) => deliveryViolation(propertyName, `fixture: ${e}`)),
  );
}

export function firstParticipant(
  fixture: ConversationFixture,
  propertyName: string,
): Effect.Effect<ConversationActor, PropertyInvariantViolation> {
  const participant = fixture.participants[0];
  return participant === undefined
    ? Effect.fail(
        deliveryViolation(propertyName, "fixture missing participant"),
      )
    : Effect.succeed(participant);
}

export function sendText(
  actor: ConversationActor,
  taskId: TaskId,
  conversationId: ConversationId,
  text: string,
) {
  return actor.client.sendRpc(MessagesSend, {
    taskId,
    conversationId,
    parts: [{ type: "text", text }],
  });
}

// TM-admin RPCs (`task/conversation/archive` + `unarchive`) are
// `callablePrincipal: "app"`; callers pass the fixture's
// `moderatorClient` (the app principal), NOT the agent owner.
export function archiveConversation(
  moderatorClient: TestClient,
  taskId: TaskId,
  conversationId: ConversationId,
) {
  return moderatorClient.sendRpc(TaskConversationArchive, {
    taskId,
    conversationId,
  });
}

export function unarchiveConversation(
  moderatorClient: TestClient,
  taskId: TaskId,
  conversationId: ConversationId,
) {
  return moderatorClient.sendRpc(TaskConversationUnarchive, {
    taskId,
    conversationId,
  });
}

export function waitForConversationCreatedNotification(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      TaskConversationCreatedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `created event missing: ${reason}`),
      ),
    );
    // #ignore-sloppy-code-next-line[params-cast]: assertion shape — event.params is `unknown` from the type-erased subscriber stream; narrow at observation site
    const data = event.params as { conversationId?: unknown } | undefined;
    if (data?.conversationId !== conversationId) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad created event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForConversationCreatedNotification"));
}

export function waitForMessageReceivedNotification(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      MessageReceivedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `message event missing: ${reason}`),
      ),
    );
    const data = event.params as MessageEventData | undefined;
    if (data?.message?.conversationId !== conversationId) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad message event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForMessageReceivedNotification"));
}

export function waitForArchivedEvent(
  observer: ConversationActor,
  conversationId: ConversationId,
  _byAgentId: AgentId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      TaskConversationArchivedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `archive event missing: ${reason}`),
      ),
    );
    // #ignore-sloppy-code-next-line[params-cast]: assertion shape — event.params is `unknown` from the type-erased subscriber stream; narrow at observation site
    const data = event.params as
      | {
          conversationId?: unknown;
          archivedAt?: unknown;
        }
      | undefined;
    if (
      data?.conversationId !== conversationId ||
      typeof data.archivedAt !== "string"
    ) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad archive event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForArchivedEvent"));
}

export function waitForUnarchivedEvent(
  observer: ConversationActor,
  conversationId: ConversationId,
  _byAgentId: AgentId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      TaskConversationUnarchivedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `unarchive event missing: ${reason}`),
      ),
    );
    // #ignore-sloppy-code-next-line[params-cast]: assertion shape — event.params is `unknown` from the type-erased subscriber stream; narrow at observation site
    const data = event.params as { conversationId?: unknown } | undefined;
    if (data?.conversationId !== conversationId) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad unarchive event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForUnarchivedEvent"));
}

export interface AssertConversationRejectsMessagesInput {
  readonly actor: ConversationActor;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly propertyName: string;
  readonly expectedError?: { readonly code: number; readonly label: string };
}

export function assertConversationRejectsMessages(
  input: AssertConversationRejectsMessagesInput,
): Effect.Effect<void, PropertyInvariantViolation> {
  const expectedError = input.expectedError ?? {
    code: ConversationArchivedError.code,
    label: "ConversationArchived",
  };
  const { actor, taskId, conversationId, propertyName } = input;
  return Effect.gen(function* () {
    const outcome = yield* sendText(
      actor,
      taskId,
      conversationId,
      "must-fail-while-archived",
    ).pipe(Effect.either);
    const outcomeViolation = Either.match(outcome, {
      onRight: () =>
        deliveryViolation(
          propertyName,
          "messages/send succeeded while archived",
        ),
      onLeft: (error) => {
        if (
          error instanceof RpcResponseError &&
          error.code === expectedError.code
        ) {
          return null;
        }
        const errorLabel =
          error instanceof RpcResponseError
            ? `${error._tag}/${error.code}`
            : error._tag;
        return deliveryViolation(
          propertyName,
          `messages/send returned ${errorLabel}, expected ${expectedError.label}`,
        );
      },
    });
    if (outcomeViolation !== null) {
      return yield* Effect.fail(outcomeViolation);
    }
  }).pipe(Effect.withSpan("assertConversationRejectsMessages"));
}

export function acquireClient(
  ctx: ConformanceRunContext,
  name: string,
): Effect.Effect<ConversationActor, string, Scope.Scope> {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name,
    }).pipe(Effect.mapError((e) => `register(${name}): ${e.body}`));
    const client = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DELIVERY_DEFAULT_TIMEOUT_MS,
      captureCapacity: DELIVERY_DEFAULT_CAPTURE_CAPACITY,
    }).pipe(Effect.mapError((e) => `makeTestClient(${name}): ${String(e)}`));
    const notifications = yield* makeNotificationBuffer(client);
    return { agent, client, notifications };
  }).pipe(Effect.withSpan("acquireClient"));
}

/** Fresh UUID manifest appId for a per-fixture conformance app. */
function freshConformanceAppId(): string {
  return crypto.randomUUID();
}

function attachGrantDispatchAuthorize(client: TestClient): Effect.Effect<void> {
  return client.onAppCallback(DispatchAuthorize, () =>
    Effect.succeed({ admission: { decision: "grant" as const } }),
  );
}

function attachAcceptTaskCreate(client: TestClient): Effect.Effect<void> {
  return client.onAppCallback(TaskCreate, () =>
    Effect.succeed({ verdict: { decision: "accept" as const } }),
  );
}

type ParticipantMap = Map<ConversationId, Set<Static<typeof AgentId>>>;

function attachForwardAllMessagesAuthorize(
  client: TestClient,
  participantsRef: Ref.Ref<ParticipantMap>,
): Effect.Effect<void> {
  return client.onAppCallback(MessagesAuthorize, (params) =>
    Effect.gen(function* () {
      const map = yield* Ref.get(participantsRef);
      const conv = map.get(makeConversationId(params.conversationId));
      const recipients =
        conv === undefined
          ? []
          : [...conv].filter((a) => a !== params.message.senderAgentId);
      return {
        verdict: { decision: "Forward" as const, recipients },
      };
    }),
  );
}

// Initial-conversation snapshot. `task/conversation/created` is the
// bulk event the server emits when a conversation is born (typically
// as the initialConversation hint folded into task/request); seed
// participantsRef from its `participants` field so
// awaitConversationReady doesn't time out waiting for per-participant
// added events that the server never sent.
function applyConversationCreated(
  prev: ParticipantMap,
  params: NotificationParamsOf<
    typeof TaskConversationCreatedNotificationDefinition
  >,
): ParticipantMap {
  const convId = makeConversationId(params.conversationId);
  const next = new Map(prev);
  next.set(convId, new Set(params.participants));
  return next;
}

function applyParticipantsAdded(
  prev: ParticipantMap,
  params: NotificationParamsOf<
    typeof TaskConversationParticipantsAddedNotificationDefinition
  >,
): ParticipantMap {
  const convId = makeConversationId(params.conversationId);
  const existing = prev.get(convId) ?? new Set();
  const updated = new Set(existing);
  updated.add(params.addedAgentId);
  const next = new Map(prev);
  next.set(convId, updated);
  return next;
}

function applyParticipantsRemoved(
  prev: ParticipantMap,
  params: NotificationParamsOf<
    typeof TaskConversationParticipantsRemovedNotificationDefinition
  >,
): ParticipantMap {
  const convId = makeConversationId(params.conversationId);
  const existing = prev.get(convId);
  if (existing === undefined) return prev;
  const updated = new Set(existing);
  updated.delete(params.removedAgentId);
  const next = new Map(prev);
  next.set(convId, updated);
  return next;
}

function subscribeParticipantNotifications(
  client: TestClient,
  participantsRef: Ref.Ref<ParticipantMap>,
): Effect.Effect<void, never, Scope.Scope> {
  const pump = <D extends AnyNotificationDefinition>(
    definition: D,
    mutate: (
      prev: ParticipantMap,
      params: NotificationParamsOf<D>,
    ) => ParticipantMap,
  ) =>
    Effect.forkScoped(
      client.subscribe(definition).pipe(
        Stream.runForEach((notif) =>
          Ref.update(participantsRef, (m) =>
            mutate(m, notif.params as NotificationParamsOf<D>),
          ),
        ),
        Effect.catchAll(() => Effect.void),
      ),
    ).pipe(Effect.asVoid);

  return Effect.gen(function* () {
    yield* pump(
      TaskConversationCreatedNotificationDefinition,
      applyConversationCreated,
    );
    yield* pump(
      TaskConversationParticipantsAddedNotificationDefinition,
      applyParticipantsAdded,
    );
    yield* pump(
      TaskConversationParticipantsRemovedNotificationDefinition,
      applyParticipantsRemoved,
    );
  });
}

const PARTICIPANT_READY_TIMEOUT_MS = 2000;
const PARTICIPANT_READY_POLL_MS = 10;

function awaitParticipantsForConversation(
  participantsRef: Ref.Ref<ParticipantMap>,
  conversationId: ConversationId,
  expectedAgentIds: ReadonlyArray<Static<typeof AgentId>>,
): Effect.Effect<void, string> {
  const wanted = new Set(expectedAgentIds);
  return Effect.gen(function* () {
    const deadline = Date.now() + PARTICIPANT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const map = yield* Ref.get(participantsRef);
      const have = map.get(conversationId) ?? new Set();
      const missing = [...wanted].filter((a) => !have.has(a));
      if (missing.length === 0) return;
      yield* Effect.sleep(`${PARTICIPANT_READY_POLL_MS} millis`);
    }
    return yield* Effect.fail(
      `moderator did not observe participants for ${conversationId} within ${PARTICIPANT_READY_TIMEOUT_MS}ms`,
    );
  });
}

export interface ModeratedHandle {
  readonly appId: Static<typeof AppIdSchema>;

  /**
   * The app-principal `AppConnection` bound as moderator. TM-admin RPCs
   * (`callablePrincipal: "app"`) route through this client.
   */
  readonly client: TestClient;

  /**
   * Block until the moderator has observed `expectedAgentIds` as
   * participants of `conversationId` via
   * `task/conversation/participants/added` notifications. Bridges
   * the gap between the create RPC returning and the notification
   * arriving on the moderator's subscriber.
   */
  readonly awaitConversationReady: (
    conversationId: ConversationId,
    expectedAgentIds: ReadonlyArray<Static<typeof AgentId>>,
  ) => Effect.Effect<void, string>;
}

/**
 * D #705 CP9 — wire a SEPARATE app principal as moderator: HTTP-register
 * the manifest + `appKey`-Connect a `TestClient` whose implicit
 * registration binds it as the app's moderator endpoint. The grant-all
 * `DispatchAuthorize` + accept `TaskCreate` + forward-all
 * `MessagesAuthorize` callbacks run on THAT app connection (all are
 * server-initiated, app-principal round-trips). The agent `owner` still
 * drives `task/request` + `messages/send`.
 *
 * Participant tracking stays on `owner.client` (an agent + conversation
 * participant): the `task/conversation/created` + participants/added/removed
 * notifications are agent broadcasts that CANNOT reach an `AppConnection`.
 * The shared in-process `participantsRef` bridges the owner's subscriber to
 * the app's forward-all callback.
 */
export function moderateAs(
  ctx: ConformanceRunContext,
  owner: ConversationActor,
  namePrefix: string,
): Effect.Effect<ModeratedHandle, string, Scope.Scope> {
  return Effect.gen(function* () {
    const participantsRef = yield* Ref.make<ParticipantMap>(new Map());
    yield* subscribeParticipantNotifications(owner.client, participantsRef);
    const app = yield* registerTestApp({
      baseUrl: ctx.realServer.baseUrl,
      wsUrl: ctx.realServer.wsUrl,
      appId: freshConformanceAppId(),
      name: `${namePrefix}-app`,
    }).pipe(Effect.mapError((e) => `apps/register failed: ${e._tag}`));
    yield* attachGrantDispatchAuthorize(app.client);
    yield* attachAcceptTaskCreate(app.client);
    yield* attachForwardAllMessagesAuthorize(app.client, participantsRef);
    const handle: ModeratedHandle = {
      appId: app.appId,
      client: app.client,
      awaitConversationReady: (conversationId, expectedAgentIds) =>
        awaitParticipantsForConversation(
          participantsRef,
          conversationId,
          expectedAgentIds,
        ),
    };
    return handle;
  }).pipe(Effect.withSpan("moderateAs"));
}

export function acquireConversation(
  ctx: ConformanceRunContext,
  n: number,
  namePrefix: string,
): Effect.Effect<ConversationFixture, string, Scope.Scope> {
  const clamped = Math.min(Math.max(1, n), MAX_N);
  return Effect.gen(function* () {
    const owner = yield* acquireClient(ctx, `${namePrefix}-owner`);
    const participants = yield* Effect.forEach(
      Array.from({ length: clamped }, (_, i) => i),
      (i) => acquireClient(ctx, `${namePrefix}-p${i}`),
      { concurrency: clamped },
    );
    // Spec D3 + #677 + D #705 CP9: a separate app principal holds TM
    // authority for TM-only RPCs (archive, addParticipant, close);
    // DEFAULT_APP_ID has no TM. `owner` (agent) drives task/request below.
    const moderator = yield* moderateAs(ctx, owner, namePrefix);
    const createResult = yield* owner.client
      .sendRpc(TaskRequest, {
        appId: moderator.appId,
        invitedAgentIds: participants.map((p) => p.agent.agentId),
        initialConversation: {
          name: `${namePrefix}-conv`,
          participants: participants.map((p) => p.agent.agentId),
        },
      })
      .pipe(Effect.either);
    const created = (yield* requireRight(
      createResult,
      (error) => `task/create failed: ${error._tag}`,
    )) as {
      task: { id: string };
      conversation: { id: string } | null;
    };
    const conversationId = created.conversation?.id;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return yield* Effect.fail(`task/create returned no conversation.id`);
    }
    const branded = makeConversationId(conversationId);
    yield* moderator.awaitConversationReady(
      branded,
      participants.map((p) => p.agent.agentId),
    );
    return {
      owner,
      participants,
      taskId: makeTaskId(created.task.id),
      conversationId: branded,
      moderatorClient: moderator.client,
    };
  }).pipe(Effect.withSpan("acquireConversation"));
}
