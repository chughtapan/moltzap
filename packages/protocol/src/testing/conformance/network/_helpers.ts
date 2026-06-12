/**
 * Network-layer helpers shared by presence properties.
 */
import {
  Chunk,
  Duration,
  Effect,
  Fiber,
  Ref,
  Stream,
  type Scope,
} from "effect";

import { PresenceChangedNotificationDefinition } from "../../../network/index.js";
import type { NotificationDelivery } from "#transport";
import { PresenceSubscribe } from "../../../network/index.js";
import { AgentId } from "../../../identity/index.js";
import {
  makeAgentTestClient,
  makeCloseableAgentTestClient,
  type AgentTestClient,
  type CloseableAgentTestClient,
  type NotificationClient,
} from "../_shared/driver/test-client.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyInvariantViolation } from "../_shared/registry.js";

export const PRESENCE_CATEGORY = "presence" as const;
export const PRESENCE_DEFAULT_TIMEOUT_MS = 5000;

// Matches the server-derived `PresenceStatusEnum`. `working` is driven
// by the LeaseRegistry-grant lifecycle.
export type PresenceStatus = "online" | "working" | "offline";

export interface PresenceChangedPayload {
  readonly agentId: string;
  readonly status: PresenceStatus;
}

/**
 * Subscriber actor: an agent client plus the historical
 * `NotificationBuffer` fed by its `subscribeAll()` pump. `acquireClient`
 * installs the pump before the subscriber issues `presence/subscribe`,
 * so `waitForPresenceWithStatus` observes every `presence/changed` frame
 * the server broadcasts — including ones that land between the
 * triggering action and the wait.
 */
export interface PresenceActor {
  readonly agent: TestAgent;
  readonly client: AgentTestClient;
  readonly notifications: NotificationBuffer;
}

/**
 * Notification buffer feeding `waitForPresenceWithStatus`.
 * `pending` is a consume-once queue for waits; `snapshot` is append-only
 * history for sequence/count assertions. The pump fiber that feeds both
 * refs is interrupted by the `Scope` finalizer installed by
 * `makeNotificationBuffer`. `closed` flips to true when the transport-side
 * stream terminates so a waiter on a dead connection fails with a
 * transport-close diagnostic rather than a generic timeout.
 *
 * Mirrors `../task/_helpers.ts → NotificationBuffer`; the presence
 * helper polls with a payload predicate (agentId + status) rather than
 * by descriptor alone.
 */
export interface NotificationBuffer {
  readonly pending: Ref.Ref<ReadonlyArray<NotificationDelivery>>;
  readonly snapshot: Ref.Ref<ReadonlyArray<NotificationDelivery>>;
  readonly closed: Ref.Ref<boolean>;
}

const PUMP_POLL_INTERVAL_MS = 5;

/**
 * Fork a `subscribeAll()` pump that appends every inbound notification
 * to a shared snapshot Ref. The pump fiber's interrupt is registered
 * with the enclosing `Scope`. Materialising the pump at actor
 * acquisition time — rather than inside the wait loop — buffers
 * notifications that arrive between the triggering action and the wait,
 * which a fresh
 * `Stream.async`-backed `subscribeAll()` inside the loop would race-miss.
 */
function makeNotificationBuffer(
  client: NotificationClient,
): Effect.Effect<NotificationBuffer, never, Scope.Scope> {
  return Effect.gen(function* () {
    const pending = yield* Ref.make<ReadonlyArray<NotificationDelivery>>([]);
    const snapshot = yield* Ref.make<ReadonlyArray<NotificationDelivery>>([]);
    const closed = yield* Ref.make<boolean>(false);
    const pumpFiber = yield* Effect.fork(
      client.subscribeAll().pipe(
        Stream.runForEach((frame) =>
          Effect.all([
            Ref.update(pending, (xs) => [...xs, frame]),
            Ref.update(snapshot, (xs) => [...xs, frame]),
          ]),
        ),
        Effect.ensuring(Ref.set(closed, true)),
        Effect.catchAll(() => Effect.void),
      ),
    );
    yield* Effect.addFinalizer(() => Fiber.interrupt(pumpFiber));
    return { pending, snapshot, closed };
  });
}

/**
 * Remove and return the first buffered `presence/changed` frame whose
 * payload matches `expected.agentId` + `expected.status`, or `null` on
 * miss. Removal gives sequential `online → offline → online` waits a
 * consume-once semantic.
 */
function pullMatchingPresenceFromBuffer(
  buffer: NotificationBuffer,
  expected: PresenceChangedPayload,
): Effect.Effect<true | null> {
  return Ref.modify(buffer.pending, (frames) => {
    const idx = frames.findIndex((frame) => {
      if (frame.definition !== PresenceChangedNotificationDefinition) {
        return false;
      }
      const data = frame.params as PresenceChangedPayload | undefined;
      return (
        data !== undefined &&
        data.agentId === expected.agentId &&
        data.status === expected.status
      );
    });
    if (idx < 0) return [null, frames];
    const rest = [...frames.slice(0, idx), ...frames.slice(idx + 1)];
    return [true, rest];
  });
}

const PRESENCE_STREAM_CLOSED = "PRESENCE_STREAM_CLOSED" as const;
type PresenceStreamClosed = typeof PRESENCE_STREAM_CLOSED;

/**
 * Stream that polls the historical buffer for the first `presence/changed`
 * frame matching `expected`, emits it as a singleton chunk, and removes
 * it from the buffer. Empty chunks back off the poll without terminating
 * the stream so `Stream.runHead` blocks until either a match arrives, the
 * pump signals close, or `Effect.timeoutFail` fires upstream. If the pump
 * has closed AND no matching frame remains, the stream fails with
 * `PRESENCE_STREAM_CLOSED`.
 */
function bufferedPresenceStream(
  buffer: NotificationBuffer,
  expected: PresenceChangedPayload,
): Stream.Stream<true, PresenceStreamClosed> {
  return Stream.repeatEffectChunk(
    pullMatchingPresenceFromBuffer(buffer, expected).pipe(
      Effect.flatMap((maybe) => {
        if (maybe !== null) return Effect.succeed(Chunk.of(maybe));
        return Ref.get(buffer.closed).pipe(
          Effect.flatMap((isClosed) =>
            isClosed
              ? Effect.fail(PRESENCE_STREAM_CLOSED)
              : Effect.sleep(Duration.millis(PUMP_POLL_INTERVAL_MS)).pipe(
                  Effect.as(Chunk.empty<true>()),
                ),
          ),
        );
      }),
    ),
  );
}

export function presenceViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation {
  return new PropertyInvariantViolation({
    category: PRESENCE_CATEGORY,
    name,
    reason,
  });
}

export function registerAgent(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<TestAgent, PropertyInvariantViolation> {
  return registerTestAgent({
    baseUrl: ctx.realServer.baseUrl,
    name,
  }).pipe(
    Effect.mapError((e) =>
      presenceViolation(
        propertyName,
        `register(${name}): status=${e.status} body=${e.body}`,
      ),
    ),
  );
}

export function acquireClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<PresenceActor, PropertyInvariantViolation, Scope.Scope> {
  return Effect.gen(function* () {
    const agent = yield* registerAgent(ctx, propertyName, name);
    const client = yield* makeAgentTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      defaultTimeoutMs: PRESENCE_DEFAULT_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((e) =>
        presenceViolation(
          propertyName,
          `makeAgentTestClient(${name}): ${String(e)}`,
        ),
      ),
    );
    const notifications = yield* makeNotificationBuffer(client);
    return { agent, client, notifications };
  }).pipe(Effect.withSpan("acquireClient"));
}

export function acquireCloseableClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  agent: TestAgent,
  label: string,
): Effect.Effect<
  CloseableAgentTestClient,
  PropertyInvariantViolation,
  Scope.Scope
> {
  // makeCloseableAgentTestClient owns its own internal scope; bind its close
  // action to the surrounding Scope so the WebSocket does not escape the
  // property boundary.
  return Effect.gen(function* () {
    const client = yield* makeCloseableAgentTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      defaultTimeoutMs: PRESENCE_DEFAULT_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((e) =>
        presenceViolation(
          propertyName,
          `makeCloseableAgentTestClient(${label}): ${String(e)}`,
        ),
      ),
    );
    yield* Effect.addFinalizer(() =>
      client.close.pipe(Effect.orElseSucceed(() => undefined)),
    );
    return client;
  }).pipe(Effect.withSpan("acquireCloseableClient"));
}

export function subscribePresence(
  subscriber: AgentTestClient,
  agentId: AgentId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return subscriber.sendRpc(PresenceSubscribe, { agentIds: [agentId] }).pipe(
    Effect.mapError((e) =>
      presenceViolation(
        propertyName,
        `presence/subscribe failed: ${String(e)}`,
      ),
    ),
    Effect.asVoid,
  );
}

/**
 * Wait for the next `presence/changed` notification whose payload
 * matches `expected.agentId` + `expected.status`.
 *
 * Polls the subscriber's historical `NotificationBuffer` (fed by the
 * `subscribeAll()` pump installed at `acquireClient` time) rather than
 * materialising a fresh `subscribeAll()` Stream inline. The pump
 * buffers every notification from acquisition onward, so a `presence/changed`
 * that lands between the triggering action and this wait is still
 * observable. Each match is removed from the buffer, giving sequential
 * `online → offline → online` waits a consume-once semantic.
 */
export function waitForPresenceWithStatus(
  subscriber: PresenceActor,
  expected: PresenceChangedPayload,
  propertyName: string,
  timeoutMs: number = PRESENCE_DEFAULT_TIMEOUT_MS,
): Effect.Effect<void, PropertyInvariantViolation> {
  return bufferedPresenceStream(subscriber.notifications, expected).pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        presenceViolation(
          propertyName,
          `timed out waiting for presence/changed { agentId: ${expected.agentId}, status: ${expected.status} }`,
        ),
    }),
    Effect.mapError((e) =>
      e === PRESENCE_STREAM_CLOSED
        ? presenceViolation(
            propertyName,
            `connection closed before presence/changed { agentId: ${expected.agentId}, status: ${expected.status} } arrived`,
          )
        : e,
    ),
    Effect.flatMap((maybe) =>
      maybe._tag === "Some"
        ? Effect.void
        : Effect.fail(
            presenceViolation(
              propertyName,
              `event stream exhausted before presence/changed { agentId: ${expected.agentId}, status: ${expected.status} } arrived`,
            ),
          ),
    ),
  );
}

export function presenceStatusesFor(
  actor: PresenceActor,
  agentId: AgentId,
): Effect.Effect<ReadonlyArray<PresenceStatus>> {
  return Effect.gen(function* () {
    const snap = yield* Ref.get(actor.notifications.snapshot);
    const statuses: PresenceStatus[] = [];
    for (const frame of snap) {
      if (
        frame.definition === PresenceChangedNotificationDefinition &&
        (frame.params as PresenceChangedPayload).agentId === agentId
      ) {
        statuses.push((frame.params as PresenceChangedPayload).status);
      }
    }
    return statuses;
  }).pipe(Effect.withSpan("presenceStatusesFor"));
}

export function countPresenceChangedFor(
  actor: PresenceActor,
  agentId: AgentId,
): Effect.Effect<number> {
  return presenceStatusesFor(actor, agentId).pipe(Effect.map((s) => s.length));
}
