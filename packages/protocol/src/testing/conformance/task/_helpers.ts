/**
 * Task-layer helpers shared by delivery / lifecycle / isolation
 * properties. Carved verbatim from `conformance/delivery.ts@961a5c8`.
 */
import type { Static } from "@sinclair/typebox";
import { Duration, Effect, Either, Option, Stream, type Scope } from "effect";
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
  readonly owner: { agent: TestAgent; client: TestClient };
  readonly participants: ReadonlyArray<{
    agent: TestAgent;
    client: TestClient;
  }>;
  readonly conversationId: ConversationIdValue;
}

export type ConversationActor = {
  readonly agent: TestAgent;
  readonly client: TestClient;
};

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
 * polling shape (#645) with the `subscribe → runHead → timeoutFail`
 * pattern documented in
 * `packages/protocol/docs/architecture/12-test-client-stream-consolidation.md §6`.
 *
 * Surfaces a single string message on either timeout or terminal close
 * so call sites preserve the legacy `e.message`-style error mapper
 * without re-deriving a tagged error type per definition.
 */
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  client: TestClient,
  definition: D,
  timeoutMs: number,
): Effect.Effect<DecodedNotification<D>, string> {
  return client.subscribe(definition).pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () => `Timeout waiting for notification: ${definition.name}`,
    }),
    Effect.mapError((err) =>
      typeof err === "string"
        ? err
        : `Connection closed while waiting for notification: ${definition.name}`,
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
      observer.client,
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
      observer.client,
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
      observer.client,
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
      observer.client,
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
      observer.client,
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
): Effect.Effect<
  { agent: TestAgent; client: TestClient },
  string,
  Scope.Scope
> {
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
    return { agent, client };
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
