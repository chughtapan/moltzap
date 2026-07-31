/**
 * Task-layer helpers shared by delivery / lifecycle / isolation
 * properties.
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
  type Scope,
  type Schema,
} from "effect";
import type { AnyNotificationDefinition } from "#socket/catalog";
import {
  type NotificationDelivery,
  type NotificationParamsOf,
  isNotificationDeliveryFor,
} from "#transport";
import {
  taskCreate,
  type TaskId,
  taskRequest,
  type appId as AppIdSchema,
} from "#task";
import {
  type ConversationId,
  conversationArchivedNotificationDefinition,
  conversationCreatedNotificationDefinition,
  conversationParticipantsAddedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
  conversationUpdate,
  conversationUnarchivedNotificationDefinition,
} from "#conversation";
import {
  messageReceivedNotificationDefinition,
  messagesAuthorize,
  messagesSend,
} from "#message";
import { dispatchAuthorize } from "#message/dispatch";
import type { agentId } from "#identity";
import {
  conversationId as makeConversationId,
  taskId as makeTaskId,
  registerTestAgent,
  type TestAgent,
} from "../_shared/test-fixtures.js";
import { RpcResponseError } from "../_shared/errors.js";
import {
  makeAgentTestClient,
  type AgentTestClient,
  type AppTestClient,
  type NotificationClient,
} from "../_shared/driver/test-client.js";
import { registerTestApp } from "../_shared/test-app.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyInvariantViolation } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";

/** Provides the delivery category runtime value. */
export const DELIVERY_CATEGORY = "delivery";
/** Provides the delivery default timeout ms runtime value. */
export const DELIVERY_DEFAULT_TIMEOUT_MS = 5000;
/** Provides the delivery default property num runs runtime value. */
export const DELIVERY_DEFAULT_PROPERTY_NUM_RUNS = 3;
const MAX_N = 4;

/** Describes conversation fixture. */
export interface ConversationFixture {
  readonly owner: ConversationActor;
  readonly participants: readonly ConversationActor[];
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;

  /**
   * The app-principal `AppConnection` bound as the conversation's
   * moderator. App-admin RPCs (archive, unarchive, addParticipant,
   * removeParticipant, close) head their `requires` with `AppPrincipal`, so
   * they route through THIS client, not the agent `owner`. `owner` (an agent)
   * drives `agent/task/request` + `agent/message/send`.
   */
  readonly moderatorClient: AppTestClient;
}

/** Describes conversation actor. */
export interface ConversationActor {
  readonly agent: TestAgent;
  readonly client: AgentTestClient;

  /**
   * Per-client historical notification buffer: `subscribe`
   * only emits frames arriving AFTER materialisation, so a sequential
   * `send → awaitOneNotification` races the response frame. The buffer
   * is fed by a long-lived
   * `subscribeAll()` pump installed at `acquireClient` time;
   * `awaitOneNotification` consumes the buffer so frames that arrived
   * between the triggering RPC and the wait are still observable. This
   * mirrors `@moltzap/server-core/test-utils → connectTestClient` (the
   * `makeNotificationBuffer` JSDoc below covers the design).
   */
  readonly notifications: NotificationBuffer;
}

/**
 * Historical notification buffer used by `awaitOneNotification`. Holds
 * every inbound notification arriving on a single client's
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
    ReadonlyArray<NotificationDelivery<AnyNotificationDefinition>>
  >;
  readonly closed: Ref.Ref<boolean>;
}

type NotificationBufferUpdate<D extends AnyNotificationDefinition> = readonly [
  NotificationDelivery<D> | null,
  ReadonlyArray<NotificationDelivery<AnyNotificationDefinition>>,
];

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
 * @param client Client used for the operation.
 * @returns The created notification buffer.
 */
function makeNotificationBuffer(
  client: NotificationClient,
): Effect.Effect<NotificationBuffer, never, Scope.Scope> {
  return Effect.gen(function* () {
    const snapshot = yield* Ref.make<
      ReadonlyArray<NotificationDelivery<AnyNotificationDefinition>>
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
): Effect.Effect<NotificationDelivery<D> | null> {
  return Ref.modify(buffer.snapshot, (frames): NotificationBufferUpdate<D> => {
    const idx = frames.findIndex((frame) => frame.definition === definition);
    if (idx < 0) {
      return [null, frames];
    }
    const matched = frames[idx];
    if (
      matched === undefined ||
      !isNotificationDeliveryFor(matched, definition)
    ) {
      return [null, frames];
    }
    const remaining = [...frames.slice(0, idx), ...frames.slice(idx + 1)];
    return [matched, remaining];
  });
}

/**
 * Sentinel error tag surfaced when the underlying transport closed
 * before a matching notification arrived. Distinguishing close from
 * timeout helps debug genuine transport failures rather than silently
 * masquerading them as missing notifications.
 */
const bufferedStreamClosed = "BUFFERED_STREAM_CLOSED";
type BufferedStreamClosed = typeof bufferedStreamClosed;

function failBufferedStreamClosed(): Effect.Effect<
  never,
  BufferedStreamClosed
> {
  return Effect.fail(bufferedStreamClosed);
}

/**
 * Stream that polls the historical buffer for the first frame matching
 * `definition`, emits it as a singleton chunk, and removes it from the
 * buffer. Empty chunks back off the poll without terminating the stream
 * so `Stream.runHead` blocks until either a match arrives, the buffer's
 * pump signals close, or `Effect.timeoutFail` fires upstream. If the
 * pump has closed AND no matching frame remains, the stream fails with
 * `BUFFERED_STREAM_CLOSED` so the upstream waiter surfaces a transport
 * diagnostic rather than a generic timeout.
 * @param buffer Value supplied to the operation.
 * @param definition Protocol definition to process.
 * @returns The buffered subscribe stream result.
 */
function bufferedSubscribeStream<D extends AnyNotificationDefinition>(
  buffer: NotificationBuffer,
  definition: D,
): Stream.Stream<NotificationDelivery<D>, BufferedStreamClosed> {
  return Stream.repeatEffectChunk(
    pullMatchingFromBuffer(buffer, definition).pipe(
      Effect.flatMap((maybe) => {
        if (maybe !== null) {
          return Effect.succeed(Chunk.of(maybe));
        }
        return Ref.get(buffer.closed).pipe(
          Effect.flatMap((isClosed) =>
            isClosed
              ? failBufferedStreamClosed()
              : Effect.sleep(Duration.millis(PUMP_POLL_INTERVAL_MS)).pipe(
                  Effect.as(Chunk.empty<NotificationDelivery<D>>()),
                ),
          ),
        );
      }),
    ),
  );
}

/**
 * Executes the delivery violation operation.
 * @param name Name of the operation.
 * @param reason Value supplied to the operation.
 * @returns The delivery violation result.
 */
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
 *
 * Consumes the per-client historical `NotificationBuffer` populated by
 * the `subscribeAll()` pump installed at `acquireClient` time, so
 * sequential `send → awaitOneNotification` patterns observe frames that
 * arrived between the triggering RPC and the wait. Mirrors
 * `@moltzap/server-core/test-utils → awaitOneNotification`.
 *
 * Surfaces a single string message on either timeout or stream
 * exhaustion, so call sites use an `e.message`-style error mapper without
 * a tagged error type per definition.
 * @param buffer Value supplied to the operation.
 * @param definition Protocol definition to process.
 * @param timeoutMs Maximum time to wait in milliseconds.
 * @returns The await one notification result.
 */
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  buffer: NotificationBuffer,
  definition: D,
  timeoutMs: number,
): Effect.Effect<NotificationDelivery<D>, string> {
  return bufferedSubscribeStream(buffer, definition).pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () => `Timeout waiting for notification: ${definition.name}`,
    }),
    Effect.mapError((err) =>
      err === bufferedStreamClosed
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

/**
 * Executes the fixture n operation.
 * @param requested Value supplied to the operation.
 * @returns The fixture n result.
 */
export function fixtureN(requested: number): number {
  return Math.min(Math.max(1, requested), MAX_N);
}

/**
 * Executes the acquire property conversation operation.
 * @param ctx Context for the operation.
 * @param propertyName Value supplied to the operation.
 * @param namePrefix Value supplied to the operation.
 * @returns The acquire property conversation result.
 */
export function acquirePropertyConversation(
  ctx: ConformanceRunContext,
  propertyName: string,
  namePrefix: string,
): Effect.Effect<ConversationFixture, PropertyInvariantViolation, Scope.Scope> {
  return acquireConversation(ctx, 1, namePrefix).pipe(
    Effect.mapError((e) => deliveryViolation(propertyName, `fixture: ${e}`)),
  );
}

/**
 * Executes the first participant operation.
 * @param fixture Value supplied to the operation.
 * @param propertyName Value supplied to the operation.
 * @returns The first participant result.
 */
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

/**
 * Sends text.
 * @param actor Value supplied to the operation.
 * @param taskId Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @param text Text to process.
 * @returns The send text result.
 */
export function sendText(
  actor: ConversationActor,
  taskId: TaskId,
  conversationId: ConversationId,
  text: string,
) {
  return actor.client.sendRpc(messagesSend, {
    taskId,
    conversationId,
    parts: [{ type: "text", text }],
  });
}

// App-admin conversation updates head their `requires` with `AppPrincipal`;
// callers pass the fixture's `moderatorClient` (the app principal), NOT the
// agent owner.
/**
 * Executes the archive conversation operation.
 * @param moderatorClient Value supplied to the operation.
 * @param taskId Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @returns The archive conversation result.
 */
export function archiveConversation(
  moderatorClient: AppTestClient,
  taskId: TaskId,
  conversationId: ConversationId,
) {
  return moderatorClient.sendRpc(conversationUpdate, {
    action: "archive",
    taskId,
    conversationId,
  });
}

/**
 * Executes the unarchive conversation operation.
 * @param moderatorClient Value supplied to the operation.
 * @param taskId Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @returns The unarchive conversation result.
 */
export function unarchiveConversation(
  moderatorClient: AppTestClient,
  taskId: TaskId,
  conversationId: ConversationId,
) {
  return moderatorClient.sendRpc(conversationUpdate, {
    action: "unarchive",
    taskId,
    conversationId,
  });
}

/**
 * Waits for for conversation created notification.
 * @param observer Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @param propertyName Value supplied to the operation.
 * @returns The wait for conversation created notification result.
 */
export function waitForConversationCreatedNotification(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      conversationCreatedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `created event missing: ${reason}`),
      ),
    );
    if (event.params.conversationId !== conversationId) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad created event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForConversationCreatedNotification"));
}

/**
 * Waits for for message received notification.
 * @param observer Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @param propertyName Value supplied to the operation.
 * @returns The wait for message received notification result.
 */
export function waitForMessageReceivedNotification(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      messageReceivedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `message event missing: ${reason}`),
      ),
    );
    if (event.params.message.conversationId !== conversationId) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad message event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForMessageReceivedNotification"));
}

/**
 * Waits for for archived event.
 * @param observer Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @param propertyName Value supplied to the operation.
 * @returns The wait for archived event result.
 */
export function waitForArchivedEvent(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      conversationArchivedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `archive event missing: ${reason}`),
      ),
    );
    if (
      event.params.conversationId !== conversationId ||
      typeof event.params.archivedAt !== "string"
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

/**
 * Waits for for unarchived event.
 * @param observer Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @param propertyName Value supplied to the operation.
 * @returns The wait for unarchived event result.
 */
export function waitForUnarchivedEvent(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      conversationUnarchivedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `unarchive event missing: ${reason}`),
      ),
    );
    if (event.params.conversationId !== conversationId) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad unarchive event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForUnarchivedEvent"));
}

/** Describes assert conversation rejects messages input. */
export interface AssertConversationRejectsMessagesInput {
  readonly actor: ConversationActor;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly propertyName: string;
  readonly expectedError?: { readonly tag: string };
}

/**
 * Asserts conversation rejects messages.
 * @param input Input value to process.
 * @returns The assert conversation rejects messages result.
 */
export function assertConversationRejectsMessages(
  input: AssertConversationRejectsMessagesInput,
): Effect.Effect<void, PropertyInvariantViolation> {
  const expectedError = input.expectedError ?? {
    tag: "ConversationArchived",
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
        Option.some(
          deliveryViolation(
            propertyName,
            "agent/message/send succeeded while archived",
          ),
        ),
      onLeft: (error) => {
        const errorLabel =
          error instanceof RpcResponseError ? error.tag : error._tag;
        return error instanceof RpcResponseError &&
          error.tag === expectedError.tag
          ? Option.none()
          : Option.some(
              deliveryViolation(
                propertyName,
                `agent/message/send returned ${errorLabel}, expected ${expectedError.tag}`,
              ),
            );
      },
    });
    if (Option.isSome(outcomeViolation)) {
      return yield* Effect.fail(outcomeViolation.value);
    }
  }).pipe(Effect.withSpan("assertConversationRejectsMessages"));
}

/**
 * Executes the acquire client operation.
 * @param ctx Context for the operation.
 * @param name Name of the operation.
 * @returns The acquire client result.
 */
export function acquireClient(
  ctx: ConformanceRunContext,
  name: string,
): Effect.Effect<ConversationActor, string, Scope.Scope> {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name,
    }).pipe(Effect.mapError((e) => `register(${name}): ${e.body}`));
    const client = yield* makeAgentTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      defaultTimeoutMs: DELIVERY_DEFAULT_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((e) => `makeAgentTestClient(${name}): ${String(e)}`),
    );
    const notifications = yield* makeNotificationBuffer(client);
    return { agent, client, notifications };
  }).pipe(Effect.withSpan("acquireClient"));
}

/**
 * Fresh UUID manifest appId for a per-fixture conformance app.
 * @returns The fresh conformance app id result.
 */
function freshConformanceAppId(): string {
  return crypto.randomUUID();
}

function attachGrantDispatchAuthorize(
  client: AppTestClient,
): Effect.Effect<void> {
  return client.onAppCallback(dispatchAuthorize, () =>
    Effect.succeed({ admission: { decision: "grant" as const } }),
  );
}

function attachAcceptTaskCreate(client: AppTestClient): Effect.Effect<void> {
  return client.onAppCallback(taskCreate, () =>
    Effect.succeed({ verdict: { decision: "accept" as const } }),
  );
}

type ParticipantMap = Map<
  ConversationId,
  Set<Schema.Schema.Type<typeof agentId>>
>;

function attachForwardAllMessagesAuthorize(
  client: AppTestClient,
  participantsRef: Ref.Ref<ParticipantMap>,
): Effect.Effect<void> {
  return client.onAppCallback(messagesAuthorize, (params) =>
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

// Initial-conversation snapshot. `app/conversation/created` is the
// bulk event the server emits when a conversation is born (typically
// as the initialConversation hint folded into agent/task/request); seed
// participantsRef from its `participants` field so
// awaitConversationReady doesn't time out waiting for per-participant
// added events that the server never sent.
function applyConversationCreated(
  prev: ParticipantMap,
  params: NotificationParamsOf<
    typeof conversationCreatedNotificationDefinition
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
    typeof conversationParticipantsAddedNotificationDefinition
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
    typeof conversationParticipantsRemovedNotificationDefinition
  >,
): ParticipantMap {
  const convId = makeConversationId(params.conversationId);
  const existing = prev.get(convId);
  if (existing === undefined) {
    return prev;
  }
  const updated = new Set(existing);
  updated.delete(params.removedAgentId);
  const next = new Map(prev);
  next.set(convId, updated);
  return next;
}

function subscribeParticipantNotifications(
  client: AgentTestClient,
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
            mutate(
              m,
              /* Safe because client.subscribe preserves the descriptor D used to create this pump. */ notif.params as NotificationParamsOf<D>,
            ),
          ),
        ),
        Effect.catchAll(() => Effect.void),
      ),
    ).pipe(Effect.asVoid);

  return Effect.gen(function* () {
    yield* pump(
      conversationCreatedNotificationDefinition,
      applyConversationCreated,
    );
    yield* pump(
      conversationParticipantsAddedNotificationDefinition,
      applyParticipantsAdded,
    );
    yield* pump(
      conversationParticipantsRemovedNotificationDefinition,
      applyParticipantsRemoved,
    );
  });
}

const PARTICIPANT_READY_TIMEOUT_MS = 2000;
const PARTICIPANT_READY_POLL_MS = 10;

function awaitParticipantsForConversation(
  participantsRef: Ref.Ref<ParticipantMap>,
  conversationId: ConversationId,
  expectedAgentIds: ReadonlyArray<Schema.Schema.Type<typeof agentId>>,
): Effect.Effect<void, string> {
  const wanted = new Set(expectedAgentIds);
  return Effect.gen(function* () {
    const deadline = Date.now() + PARTICIPANT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const map = yield* Ref.get(participantsRef);
      const have = map.get(conversationId) ?? new Set();
      const missing = [...wanted].filter((a) => !have.has(a));
      if (missing.length === 0) {
        return;
      }
      yield* Effect.sleep(`${PARTICIPANT_READY_POLL_MS} millis`);
    }
    return yield* Effect.fail(
      `moderator did not observe participants for ${conversationId} within ${PARTICIPANT_READY_TIMEOUT_MS}ms`,
    );
  });
}

/** Describes moderated handle. */
export interface ModeratedHandle {
  readonly appId: Schema.Schema.Type<typeof AppIdSchema>;

  /**
   * The app-principal `AppConnection` bound as moderator. App-admin RPCs (their
   * `requires` head is `AppPrincipal`) route through this client.
   */
  readonly client: AppTestClient;

  /**
   * Block until the moderator has observed `expectedAgentIds` as
   * participants of `conversationId` via
   * `app/conversation/updateed` notifications. Bridges
   * the gap between the create RPC returning and the notification
   * arriving on the moderator's subscriber.
   */
  readonly awaitConversationReady: (
    conversationId: ConversationId,
    expectedAgentIds: ReadonlyArray<Schema.Schema.Type<typeof agentId>>,
  ) => Effect.Effect<void, string>;
}

/**
 * Wire a SEPARATE app principal as moderator: HTTP-register the manifest
 * + `appKey`-Connect an `AppTestClient` whose implicit registration binds it
 * as the app's moderator endpoint. The grant-all `DispatchAuthorize` +
 * accept `TaskCreate` + forward-all `MessagesAuthorize` callbacks run on
 * THAT app connection (all are server-initiated, app-principal
 * round-trips). The agent `owner` drives `agent/task/request` + `agent/message/send`.
 *
 * Participant tracking stays on `owner.client` (an agent + conversation
 * participant): the `app/conversation/created` + participants/added/removed
 * notifications are agent broadcasts that CANNOT reach an `AppConnection`.
 * The shared in-process `participantsRef` bridges the owner's subscriber to
 * the app's forward-all callback.
 * @param ctx Context for the operation.
 * @param owner Value supplied to the operation.
 * @param namePrefix Value supplied to the operation.
 * @returns The moderate as result.
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
    }).pipe(Effect.mapError((e) => `app registration failed: ${e._tag}`));
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

/**
 * Executes the acquire conversation operation.
 * @param ctx Context for the operation.
 * @param n Value supplied to the operation.
 * @param namePrefix Value supplied to the operation.
 * @returns The acquire conversation result.
 */
export function acquireConversation(
  ctx: ConformanceRunContext,
  n: number,
  namePrefix: string,
): Effect.Effect<ConversationFixture, string, Scope.Scope> {
  const clamped = Math.min(Math.max(1, n), MAX_N);
  return Effect.gen(function* () {
    const owner = yield* acquireClient(ctx, `${namePrefix}-owner`);
    const participants = yield* Effect.forEach(
      Array.from({ length: clamped }).keys(),
      (i) => acquireClient(ctx, `${namePrefix}-p${i}`),
      { concurrency: clamped },
    );
    // A separate app principal holds authority for app-only RPCs
    // (archive, addParticipant, close); DEFAULT_APP_ID has no app connection. `owner`
    // (agent) drives agent/task/request below.
    const moderator = yield* moderateAs(ctx, owner, namePrefix);
    const createResult = yield* owner.client
      .sendRpc(taskRequest, {
        appId: moderator.appId,
        invitedAgentIds: participants.map((p) => p.agent.agentId),
        initialConversation: {
          name: `${namePrefix}-conv`,
          participants: participants.map((p) => p.agent.agentId),
        },
      })
      .pipe(Effect.either);
    const created = yield* requireRight(
      createResult,
      (error) => `app/task/create failed: ${error._tag}`,
    );
    const conversationId = created.conversation?.id;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return yield* Effect.fail(`app/task/create returned no conversation.id`);
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
