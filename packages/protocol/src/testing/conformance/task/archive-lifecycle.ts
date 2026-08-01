/**
 * Archive lifecycle — archival is observable and enforced:
 *   - app/conversation/update archive broadcasts agent/conversation/archived
 *   - agent/message/send to the archived conversation returns the typed
 *     ConversationArchived error
 *   - app/conversation/update unarchive broadcasts agent/conversation/unarchived
 *   - agent/message/send succeeds again after unarchive
 */
import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";
import {
  acquirePropertyConversation,
  archiveConversation,
  assertConversationRejectsMessages,
  type ConversationActor,
  type ConversationFixture,
  DELIVERY_CATEGORY,
  deliveryViolation,
  firstParticipant,
  sendText,
  unarchiveConversation,
  waitForArchivedEvent,
  waitForUnarchivedEvent,
} from "./_helpers.js";

const PROPERTY = "archive-lifecycle";

export function registerArchiveLifecycle(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    PROPERTY,
    "archive/unarchive emits lifecycle events and gates agent/message/send",
    runArchiveLifecycle(ctx).pipe(Effect.withSpan("registerArchiveLifecycle")),
  );
}

function runArchiveLifecycle(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* acquirePropertyConversation(ctx, PROPERTY, "arch");
      const participant = yield* firstParticipant(fixture, PROPERTY);
      yield* assertArchive(fixture, participant);
      yield* assertUnarchive(fixture, participant);
    }),
  );
}

function assertArchive(
  fixture: ConversationFixture,
  participant: ConversationActor,
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

function assertUnarchive(
  fixture: ConversationFixture,
  participant: ConversationActor,
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
      fixture.owner.agent.agentId,
      PROPERTY,
    );
    const resumedSend = yield* sendText(
      participant,
      fixture.taskId,
      fixture.conversationId,
      "must-succeed-after-unarchive",
    ).pipe(Effect.either);
    yield* requireRight(resumedSend, (error) =>
      deliveryViolation(
        PROPERTY,
        `agent/message/send failed after unarchive: ${error._tag}`,
      ),
    );
  });
}
