/**
 * Conversation lifecycle — birth and traffic are observable:
 *   - app/conversation/create broadcasts agent/conversation/created
 *   - agent/message/send broadcasts agent/message/received.
 */
import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";
import {
  DELIVERY_CATEGORY,
  acquirePropertyConversation,
  deliveryViolation,
  firstParticipant,
  sendText,
  waitForConversationCreatedNotification,
  waitForMessageReceivedNotification,
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
    "create/send lifecycle is observable",
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
      "lifecycle-first-send",
    ).pipe(Effect.either);
    yield* requireRight(firstSend, (error) =>
      deliveryViolation(PROPERTY, `agent/message/send failed: ${error._tag}`),
    );
    yield* waitForMessageReceivedNotification(
      participant,
      fixture.conversationId,
      PROPERTY,
    );
  });
}
