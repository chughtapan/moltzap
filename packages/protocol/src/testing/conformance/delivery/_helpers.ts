/**
 * Delivery-property helpers: conversation fixtures and per-client
 * notification buffers.
 */
import { Effect, Fiber, Ref, Stream, type Scope } from "effect";
import type { AnyNotificationDefinition } from "#socket/catalog";
import type { NotificationDelivery } from "#transport";
import { DEFAULT_APP_ID } from "#identity/apps";
import { type ConversationId, agentConversationCreate } from "#conversation";
import {
  conversationId as makeConversationId,
  registerTestAgent,
  type TestAgent,
} from "../_shared/test-fixtures.js";
import {
  makeAgentTestClient,
  type AgentTestClient,
  type NotificationClient,
} from "../_shared/driver/test-client.js";
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
    const createResult = yield* owner.client
      .sendRpc(agentConversationCreate, {
        appId: DEFAULT_APP_ID,
        name: `${namePrefix}-conv`,
        participants: participants.map((p) => p.agent.agentId),
      })
      .pipe(Effect.either);
    const created = yield* requireRight(
      createResult,
      (error) => `agent/conversation/create failed: ${error._tag}`,
    );
    const branded = makeConversationId(created.conversation.id);
    return {
      owner,
      participants,
      conversationId: branded,
    };
  }).pipe(Effect.withSpan("acquireConversation"));
}
