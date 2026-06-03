/**
 * Network-layer helpers shared by presence properties.
 */
import {
  Chunk,
  Duration,
  Effect,
  Fiber,
  Option,
  Ref,
  Stream,
  type Scope,
} from "effect";

import { PresenceChangedNotificationDefinition } from "../../../network/index.js";
import { notificationDefinitions } from "../../../rpc-registry.js";
import type { AnyNotificationDefinition } from "../../../rpc-registry.js";
import { isDecodedNotification } from "../../../transport/index.js";
import type { DecodedNotification } from "../../../transport/index.js";
import { decodeNotification } from "../../index.js";
import { PresenceSubscribe } from "../../../network/index.js";
import { AgentId } from "../../../identity/index.js";
import {
  makeCloseableTestClient,
  makeTestClient,
  type CloseableTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";
import type { CapturedFrame } from "../_shared/captures.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import {
  isNotificationFrame,
  isRequestFrame,
} from "../_shared/frame-mutator.js";
import type { AnyFrame } from "../_shared/frame-mutator.js";
import type { NotificationFrame } from "../../../transport/index.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyInvariantViolation } from "../_shared/registry.js";

export const PRESENCE_CATEGORY = "presence" as const;
export const PRESENCE_DEFAULT_TIMEOUT_MS = 5000;
export const PRESENCE_DEFAULT_CAPTURE_CAPACITY = 256;

// Matches the server-derived `PresenceStatusEnum`. `working` is driven
// by the LeaseRegistry-grant lifecycle.
export type PresenceStatus = "online" | "working" | "offline";

export interface PresenceChangedPayload {
  readonly agentId: string;
  readonly status: PresenceStatus;
}

/**
 * Subscriber actor: a `TestClient` plus the historical
 * `NotificationBuffer` fed by its `subscribeAll()` pump. `acquireClient`
 * installs the pump before the subscriber issues `presence/subscribe`,
 * so `waitForPresenceWithStatus` observes every `presence/changed` frame
 * the server broadcasts — including ones that land between the
 * triggering action and the wait.
 */
export interface PresenceActor {
  readonly agent: TestAgent;
  readonly client: TestClient;
  readonly notifications: NotificationBuffer;
}

/**
 * Historical notification buffer feeding `waitForPresenceWithStatus`.
 * Holds every inbound notification arriving on a single subscriber's
 * `subscribeAll()` Stream until a consumer pulls a matching frame. The
 * pump fiber that feeds `snapshot` is interrupted by the `Scope`
 * finalizer installed by `makeNotificationBuffer`. `closed` flips to
 * true when the transport-side stream terminates so a waiter on a dead
 * connection fails with a transport-close diagnostic rather than a
 * generic timeout.
 *
 * Mirrors `../task/_helpers.ts → NotificationBuffer`; the presence
 * helper polls with a payload predicate (agentId + status) rather than
 * by descriptor alone.
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
 * with the enclosing `Scope`. Materialising the pump at actor
 * acquisition time — rather than inside the wait loop — captures frames
 * that arrive between the triggering action and the wait, which a fresh
 * `Stream.async`-backed `subscribeAll()` inside the loop would race-miss.
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
        Effect.ensuring(Ref.set(closed, true)),
        Effect.catchAll(() => Effect.void),
      ),
    );
    yield* Effect.addFinalizer(() => Fiber.interrupt(pumpFiber));
    return { snapshot, closed };
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
  return Ref.modify(buffer.snapshot, (frames) => {
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
    const client = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: PRESENCE_DEFAULT_TIMEOUT_MS,
      captureCapacity: PRESENCE_DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        presenceViolation(
          propertyName,
          `makeTestClient(${name}): ${String(e)}`,
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
): Effect.Effect<CloseableTestClient, PropertyInvariantViolation, Scope.Scope> {
  // makeCloseableTestClient owns its own internal scope; bind its close
  // action to the surrounding Scope so the WebSocket does not escape the
  // property boundary.
  return Effect.gen(function* () {
    const client = yield* makeCloseableTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: PRESENCE_DEFAULT_TIMEOUT_MS,
      captureCapacity: PRESENCE_DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        presenceViolation(
          propertyName,
          `makeCloseableTestClient(${label}): ${String(e)}`,
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
  subscriber: TestClient,
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
 * captures every frame from acquisition onward, so a `presence/changed`
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
  client: TestClient,
  agentId: AgentId,
): Effect.Effect<ReadonlyArray<PresenceStatus>> {
  return Effect.gen(function* () {
    const snap = yield* client.snapshot;
    const statuses: PresenceStatus[] = [];
    for (const entry of snap) {
      const status = yield* presenceStatusFromCapture(entry, agentId);
      if (status !== null) {
        statuses.push(status);
      }
    }
    return statuses;
  }).pipe(Effect.withSpan("presenceStatusesFor"));
}

// The server pushes notifications as void-result s2c RPCs, so an inbound
// presence/changed is captured as a REQUEST frame (carrying an `id`) rather
// than a bare notification. Project either onto the notification shape the
// `decodeNotification` decoder reads.
function asNotificationFrame(frame: AnyFrame): NotificationFrame | null {
  if (isNotificationFrame(frame)) return frame;
  if (isRequestFrame(frame)) {
    return {
      jsonrpc: "2.0",
      method: frame.method,
      ...(frame.params !== undefined ? { params: frame.params } : {}),
    };
  }
  return null;
}

function presenceStatusFromCapture(
  entry: CapturedFrame,
  agentId: AgentId,
): Effect.Effect<PresenceStatus | null> {
  return Effect.gen(function* () {
    if (entry.kind !== "inbound" || entry.frame === null) return null;
    const notificationFrame = asNotificationFrame(entry.frame);
    if (notificationFrame === null) return null;
    const notification = yield* decodeNotification(
      notificationDefinitions,
      notificationFrame,
    ).pipe(Effect.option);
    const presenceNotification = Option.filter(notification, (decoded) =>
      isDecodedNotification(PresenceChangedNotificationDefinition, decoded),
    );
    if (Option.isNone(presenceNotification)) return null;
    const data = presenceNotification.value.params;
    return data.agentId === agentId ? data.status : null;
  });
}

export function countPresenceChangedFor(
  client: TestClient,
  agentId: AgentId,
): Effect.Effect<number> {
  return presenceStatusesFor(client, agentId).pipe(Effect.map((s) => s.length));
}
