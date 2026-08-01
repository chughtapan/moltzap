/**
 * Delivery-property helpers: conversation fixtures and per-client
 * notification buffers.
 */
import { Effect, Fiber, Ref, Stream, type Scope, type Schema } from "effect";
import type { AnyNotificationDefinition } from "#socket/catalog";
import type { NotificationDelivery, NotificationParamsOf } from "#transport";
import type { appId as AppIdSchema } from "#identity/apps";
import {
  type ConversationId,
  agentConversationCreate,
  conversationCreatedNotificationDefinition,
  conversationParticipantsAddedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
} from "#conversation";
import { messagesAuthorize } from "#message";
import { dispatchAuthorize } from "#message/dispatch";
import type { agentId } from "#identity";
import {
  conversationId as makeConversationId,
  registerTestAgent,
  type TestAgent,
} from "../_shared/test-fixtures.js";
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
  readonly conversationId: ConversationId;

  /**
   * The app-principal `AppConnection` bound as the conversation's
   * moderator. App-admin RPCs head their `requires` with `AppPrincipal`, so
   * they route through THIS client, not the agent `owner`. `owner` drives
   * `agent/conversation/create` + `agent/message/send`.
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
   * `send → read snapshot` races the response frame. The buffer
   * is fed by a long-lived
   * `subscribeAll()` pump installed at `acquireClient` time, so frames that
   * arrived between the triggering RPC and the read are still observable.
   * This mirrors `@moltzap/server-core/test-utils → connectTestClient` (the
   * `makeNotificationBuffer` JSDoc below covers the design).
   */
  readonly notifications: NotificationBuffer;
}

/**
 * Historical notification buffer. Holds every inbound notification arriving
 * on a single client's `subscribeAll()` Stream.
 *
 * The `snapshot` and `closed` fields are the only public surfaces;
 * the pump fiber that feeds them is interrupted by the enclosing
 * Scope finalizer installed by `makeNotificationBuffer`. `closed` is
 * set to true when the transport-side stream terminates (either via
 * `TransportClosedError` or normal exhaustion).
 */
export interface NotificationBuffer {
  readonly snapshot: Ref.Ref<
    ReadonlyArray<NotificationDelivery<AnyNotificationDefinition>>
  >;
  readonly closed: Ref.Ref<boolean>;
}

/**
 * Fork a `subscribeAll()` pump that appends every inbound notification
 * to a shared snapshot Ref. The pump fiber's interrupt is registered
 * with the enclosing `Scope` so callers do not have to thread the
 * lifecycle through their own finalizers. Conformance `acquireClient`
 * sites consume via `actor.notifications`.
 *
 * Why a snapshot Ref instead of pulling the Stream directly: the
 * `RPC → observe-notification` pattern needs frames that arrive
 * BETWEEN the triggering RPC and the read. `Stream.async` only emits
 * frames that arrive after materialisation, so a fresh `subscribe`
 * inside the read would race-miss any frame already dispatched.
 * The buffer pump materialises eagerly at actor acquisition time.
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
        // can tell a transport close from a missing frame. Buffered
        // frames that arrived before the close stay available for one
        // final drain.
        Effect.ensuring(Ref.set(closed, true)),
        Effect.catchAll(() => Effect.void),
      ),
    );
    yield* Effect.addFinalizer(() => Fiber.interrupt(pumpFiber));
    return { snapshot, closed };
  });
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
 * Executes the fixture n operation.
 * @param requested Value supplied to the operation.
 * @returns The fixture n result.
 */
export function fixtureN(requested: number): number {
  return Math.min(Math.max(1, requested), MAX_N);
}

function acquireClient(
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

// Initial-membership snapshot. `agent/conversation/created` is the bulk event
// the server emits when a conversation is born; seed participantsRef from its
// `participants` field so awaitConversationReady doesn't time out waiting for
// per-participant added events that the server never sent.
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

interface ModeratedHandle {
  readonly appId: Schema.Schema.Type<typeof AppIdSchema>;

  /**
   * The app-principal `AppConnection` bound as moderator. App-admin RPCs (their
   * `requires` head is `AppPrincipal`) route through this client.
   */
  readonly client: AppTestClient;

  /**
   * Block until the moderator has observed `expectedAgentIds` as
   * participants of `conversationId` via the `agent/conversation/*`
   * notifications. Bridges the gap between the create RPC returning and the
   * notification arriving on the moderator's subscriber.
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
 * forward-all `MessagesAuthorize` callbacks run on THAT app connection (both
 * are server-initiated, app-principal round-trips). The agent `owner` drives
 * `agent/conversation/create` + `agent/message/send`.
 *
 * Participant tracking stays on `owner.client` (an agent + conversation
 * participant): the `agent/conversation/created` + participants/added/removed
 * notifications are agent broadcasts that CANNOT reach an `AppConnection`.
 * The shared in-process `participantsRef` bridges the owner's subscriber to
 * the app's forward-all callback.
 * @param ctx Context for the operation.
 * @param owner Agent actor whose subscriber tracks conversation membership.
 * @param namePrefix Prefix for the registered app name.
 * @returns The moderate as result.
 */
function moderateAs(
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
    // A separate app principal holds authority for app-only RPCs;
    // DEFAULT_APP_ID has no app connection. `owner` (agent) drives
    // agent/conversation/create below.
    const moderator = yield* moderateAs(ctx, owner, namePrefix);
    const createResult = yield* owner.client
      .sendRpc(agentConversationCreate, {
        appId: moderator.appId,
        name: `${namePrefix}-conv`,
        participants: participants.map((p) => p.agent.agentId),
      })
      .pipe(Effect.either);
    const created = yield* requireRight(
      createResult,
      (error) => `agent/conversation/create failed: ${error._tag}`,
    );
    const branded = makeConversationId(created.conversation.id);
    yield* moderator.awaitConversationReady(
      branded,
      participants.map((p) => p.agent.agentId),
    );
    return {
      owner,
      participants,
      conversationId: branded,
      moderatorClient: moderator.client,
    };
  }).pipe(Effect.withSpan("acquireConversation"));
}
