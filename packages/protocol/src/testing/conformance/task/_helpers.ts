/**
 * Task-layer helpers shared by delivery / lifecycle / isolation
 * properties. Carved verbatim from `conformance/delivery.ts@961a5c8`.
 */
import type { Static } from "@sinclair/typebox";
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
import type { DecodedNotification } from "../../../transport/rpc-groups.js";
import {
  ConversationArchivedError,
  ConversationArchivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  MessageReceivedNotificationDefinition,
  ConversationsArchive,
  ConversationsCreate,
  ConversationsUnarchive,
  ConversationsUpdate,
  MessagesSend,
  ConversationId,
} from "../../../task/methods.js";
import { AgentId } from "../../../identity/methods.js";
import { conversationId as makeConversationId } from "../_shared/test-fixtures.js";
import { RpcResponseError } from "../_shared/errors.js";
import {
  makeTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyInvariantViolation } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";

export const DELIVERY_CATEGORY = "delivery" as const;
export const DELIVERY_DEFAULT_TIMEOUT_MS = 5000;
export const DELIVERY_DEFAULT_CAPTURE_CAPACITY = 256;
export const DELIVERY_DEFAULT_PROPERTY_NUM_RUNS = 3;
const MAX_N = 4;

export type AgentIdValue = Static<typeof AgentId>;
export type ConversationIdValue = Static<typeof ConversationId>;

export interface ConversationFixture {
  readonly owner: ConversationActor;
  readonly participants: ReadonlyArray<ConversationActor>;
  readonly conversationId: ConversationIdValue;
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
   * mirrors `@moltzap/server-core/test-utils → connectTestClient` per
   * `packages/protocol/docs/architecture/12-test-client-stream-consolidation.md
   * → §3 "Historical-buffer bridge for integration tests"`.
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
 * lifecycle through their own finalizers. Mirrors the equivalent
 * `@moltzap/server-core/test-utils → makeNotificationBuffer` shape;
 * conformance acquireClient sites consume via `actor.notifications`.
 *
 * Registration is single-shot inside `Stream.runForEach`'s synchronous
 * setup phase, which runs as the first action of the forked fiber.
 * In practice the network round-trip of any subsequent test RPC
 * dominates the fork-scheduling delay, so the unfenced pattern is
 * sufficient for the conformance suite's `RPC → wait` workload
 * (matching the server-core integration-test bridge's design and
 * empirical reliability). Tests that genuinely need a tighter fence
 * pre-subscribe via `client.subscribe(def)` directly before the
 * triggering RPC and consume the Stream with `Stream.runHead` — the
 * pattern documented in §6 of
 * `packages/protocol/docs/architecture/12-test-client-stream-consolidation.md`.
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

type ArchiveEventData = {
  readonly conversationId?: unknown;
  readonly archivedAt?: unknown;
  readonly by?: unknown;
};

type ConversationNotificationData = {
  readonly conversation?: {
    readonly id?: unknown;
    readonly name?: unknown;
  };
};

type MessageEventData = {
  readonly message?: {
    readonly conversationId?: unknown;
  };
};

type UnarchiveEventData = {
  readonly conversationId?: unknown;
  readonly by?: unknown;
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
 * `@moltzap/server-core/test-utils → awaitOneNotification` per
 * `packages/protocol/docs/architecture/12-test-client-stream-consolidation.md
 * → §3 "Historical-buffer bridge for integration tests"`.
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
  conversationId: ConversationIdValue,
  text: string,
) {
  return actor.client.sendRpc(MessagesSend, {
    conversationId,
    parts: [{ type: "text", text }],
  });
}

export function archiveConversation(
  actor: ConversationActor,
  conversationId: ConversationIdValue,
) {
  return actor.client.sendRpc(ConversationsArchive, { conversationId });
}

export function updateConversationName(
  actor: ConversationActor,
  conversationId: ConversationIdValue,
  name: string,
) {
  return actor.client.sendRpc(ConversationsUpdate, {
    conversationId,
    name,
  });
}

export function unarchiveConversation(
  actor: ConversationActor,
  conversationId: ConversationIdValue,
) {
  return actor.client.sendRpc(ConversationsUnarchive, { conversationId });
}

export function waitForConversationCreatedNotification(
  observer: ConversationActor,
  conversationId: ConversationIdValue,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      ConversationCreatedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `created event missing: ${reason}`),
      ),
    );
    const data = event.params as ConversationNotificationData | undefined;
    if (data?.conversation?.id !== conversationId) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad created event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForConversationCreatedNotification"));
}

export function waitForConversationUpdatedNotification(
  observer: ConversationActor,
  conversationId: ConversationIdValue,
  name: string,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      ConversationUpdatedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `updated event missing: ${reason}`),
      ),
    );
    const data = event.params as ConversationNotificationData | undefined;
    if (
      data?.conversation?.id !== conversationId ||
      data.conversation.name !== name
    ) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad updated event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForConversationUpdatedNotification"));
}

export function waitForMessageReceivedNotification(
  observer: ConversationActor,
  conversationId: ConversationIdValue,
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
  conversationId: ConversationIdValue,
  byAgentId: AgentIdValue,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      ConversationArchivedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `archive event missing: ${reason}`),
      ),
    );
    const data = event.params as ArchiveEventData | undefined;
    if (
      data?.conversationId !== conversationId ||
      typeof data.archivedAt !== "string" ||
      data.by !== byAgentId
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
  conversationId: ConversationIdValue,
  byAgentId: AgentIdValue,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      ConversationUnarchivedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `unarchive event missing: ${reason}`),
      ),
    );
    const data = event.params as UnarchiveEventData | undefined;
    if (data?.conversationId !== conversationId || data.by !== byAgentId) {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad unarchive event payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  }).pipe(Effect.withSpan("waitForUnarchivedEvent"));
}

export function assertConversationRejectsMessages(
  actor: ConversationActor,
  conversationId: ConversationIdValue,
  propertyName: string,
  expectedError: { readonly code: number; readonly label: string } = {
    code: ConversationArchivedError.code,
    label: "ConversationArchived",
  },
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const outcome = yield* sendText(
      actor,
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
    const createResult = yield* owner.client
      .sendRpc(ConversationsCreate, {
        type: "group",
        name: `${namePrefix}-conv`,
        participants: participants.map((p) => ({
          type: "agent" as const,
          id: p.agent.agentId,
        })),
      })
      .pipe(Effect.either);
    const created = (yield* requireRight(
      createResult,
      (error) => `conversations/create failed: ${error._tag}`,
    )) as {
      conversation?: { id?: string };
    };
    const conversationId = created.conversation?.id;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return yield* Effect.fail(
        `conversations/create returned no conversation.id`,
      );
    }
    return {
      owner,
      participants,
      conversationId: makeConversationId(conversationId),
    };
  }).pipe(Effect.withSpan("acquireConversation"));
}
