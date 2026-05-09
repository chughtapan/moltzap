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
  updateConversationName,
  waitForArchivedEvent,
  waitForConversationCreatedNotification,
  waitForConversationUpdatedNotification,
  waitForMessageReceivedNotification,
  waitForUnarchivedEvent,
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
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquirePropertyConversation(
          ctx,
          PROPERTY,
          "life",
        );
        const participant = yield* firstParticipant(fixture, PROPERTY);

        yield* waitForConversationCreatedNotification(
          participant,
          fixture.conversationId,
          PROPERTY,
        );

        const firstSend = yield* sendText(
          fixture.owner,
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

        const updatedName = `Lifecycle ${ctx.seed}`;
        const update = yield* updateConversationName(
          fixture.owner,
          fixture.conversationId,
          updatedName,
        ).pipe(Effect.either);
        yield* requireRight(update, (error) =>
          deliveryViolation(
            PROPERTY,
            `conversations/update failed: ${error._tag}`,
          ),
        );
        yield* waitForConversationUpdatedNotification(
          participant,
          fixture.conversationId,
          updatedName,
          PROPERTY,
        );

        const archive = yield* archiveConversation(
          fixture.owner,
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
        yield* assertConversationRejectsMessages(
          participant,
          fixture.conversationId,
          PROPERTY,
        );

        const unarchive = yield* unarchiveConversation(
          fixture.owner,
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
          fixture.conversationId,
          "lifecycle-after-unarchive",
        ).pipe(Effect.either);
        yield* requireRight(resumedSend, (error) =>
          deliveryViolation(
            PROPERTY,
            `messages/send failed after unarchive: ${error._tag}`,
          ),
        );
      }),
    ),
  );
}
