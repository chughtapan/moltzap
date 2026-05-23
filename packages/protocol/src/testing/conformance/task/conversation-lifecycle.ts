/**
 * Conversation lifecycle — the supported reversible path is observable
 * and enforced:
 *   - conversations/create broadcasts conversations/created
 *   - messages/send broadcasts messages/received
 *   - conversations/update broadcasts conversations/updated
 *   - archive/unarchive form the only reversible terminal state
 *   - archived conversations reject messages/send
 *   - messages/send succeeds again after unarchive
 */
import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";
import {
  DELIVERY_CATEGORY,
  acquirePropertyConversation,
  archiveConversation,
  assertConversationRejectsMessages,
  deliveryViolation,
  firstParticipant,
  sendText,
  unarchiveConversation,
  waitForArchivedEvent,
  waitForConversationCreatedNotification,
  waitForMessageReceivedNotification,
  waitForUnarchivedEvent,
  type ConversationActor,
  type ConversationFixture,
} from "./_helpers.js";

const PROPERTY = "conversation-lifecycle";

export function registerConversationLifecycle(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    PROPERTY,
    "create/send/update/archive/unarchive lifecycle is observable and enforced",
    runConversationLifecycle(ctx).pipe(
      Effect.withSpan("registerConversationLifecycle"),
    ),
  );
}

type LifecycleFixture = ConversationFixture;
type LifecycleParticipant = ConversationActor;

function runConversationLifecycle(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* acquirePropertyConversation(ctx, PROPERTY, "life");
      const participant = yield* firstParticipant(fixture, PROPERTY);
      yield* assertCreatedAndInitialSend(fixture, participant);
      // Spec D3 D10 deletes the `conversations/update` RPC and its
      // notification; the conversation rename branch retires with the
      // legacy surface.
      yield* assertArchivePhase(fixture, participant);
      yield* assertUnarchivePhase(fixture, participant);
    }),
  );
}

function assertCreatedAndInitialSend(
  fixture: LifecycleFixture,
  participant: LifecycleParticipant,
) {
  return Effect.gen(function* () {
    yield* waitForConversationCreatedNotification(
      participant,
      fixture.conversationId,
      PROPERTY,
    );
    const firstSend = yield* sendText(
      fixture.owner,
      fixture.taskId,
      fixture.conversationId,
      "lifecycle-before-update",
    ).pipe(Effect.either);
    yield* requireRight(firstSend, (error) =>
      deliveryViolation(
        PROPERTY,
        `messages/send failed before archive: ${error._tag}`,
      ),
    );
    yield* waitForMessageReceivedNotification(
      participant,
      fixture.conversationId,
      PROPERTY,
    );
  });
}

function assertArchivePhase(
  fixture: LifecycleFixture,
  participant: LifecycleParticipant,
) {
  return Effect.gen(function* () {
    const archive = yield* archiveConversation(
      fixture.owner,
      fixture.taskId,
      fixture.conversationId,
    ).pipe(Effect.either);
    yield* requireRight(archive, (error) =>
      deliveryViolation(PROPERTY, `archive failed: ${error._tag}`),
    );
    yield* waitForArchivedEvent(
      participant,
      fixture.conversationId,
      fixture.owner.agent.agentId,
      PROPERTY,
    );
    yield* assertConversationRejectsMessages({
      actor: participant,
      taskId: fixture.taskId,
      conversationId: fixture.conversationId,
      propertyName: PROPERTY,
    });
  });
}

function assertUnarchivePhase(
  fixture: LifecycleFixture,
  participant: LifecycleParticipant,
) {
  return Effect.gen(function* () {
    const unarchive = yield* unarchiveConversation(
      fixture.owner,
      fixture.taskId,
      fixture.conversationId,
    ).pipe(Effect.either);
    yield* requireRight(unarchive, (error) =>
      deliveryViolation(PROPERTY, `unarchive failed: ${error._tag}`),
    );
    yield* waitForUnarchivedEvent(
      participant,
      fixture.conversationId,
      fixture.owner.agent.agentId,
      PROPERTY,
    );
    const resumedSend = yield* sendText(
      participant,
      fixture.taskId,
      fixture.conversationId,
      "lifecycle-after-unarchive",
    ).pipe(Effect.either);
    yield* requireRight(resumedSend, (error) =>
      deliveryViolation(
        PROPERTY,
        `messages/send failed after unarchive: ${error._tag}`,
      ),
    );
  });
}
