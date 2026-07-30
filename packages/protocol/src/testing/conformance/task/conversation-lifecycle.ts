/**
 * Conversation lifecycle — the supported reversible path is observable
 * and enforced:
 *   - app/conversation/create broadcasts agent/conversation/created
 *   - agent/message/send broadcasts agent/message/received
 *   - app/conversation/update broadcasts agent/conversation lifecycle events
 *   - archive/unarchive form the only reversible terminal state
 *   - archived conversations reject agent/message/send
 *   - agent/message/send succeeds again after unarchive.
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

/**
 * Registers conversation lifecycle.
 * @param ctx Context for the operation.
 */
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
        `agent/message/send failed before archive: ${error._tag}`,
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
      fixture.moderatorClient,
      fixture.taskId,
      fixture.conversationId,
    ).pipe(Effect.either);
    yield* requireRight(archive, (error) =>
      deliveryViolation(PROPERTY, `archive failed: ${error._tag}`),
    );
    yield* waitForArchivedEvent(participant, fixture.conversationId, PROPERTY);
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
      fixture.moderatorClient,
      fixture.taskId,
      fixture.conversationId,
    ).pipe(Effect.either);
    yield* requireRight(unarchive, (error) =>
      deliveryViolation(PROPERTY, `unarchive failed: ${error._tag}`),
    );
    yield* waitForUnarchivedEvent(
      participant,
      fixture.conversationId,
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
        `agent/message/send failed after unarchive: ${error._tag}`,
      ),
    );
  });
}
