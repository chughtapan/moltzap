/**
 * Archive lifecycle — archival is observable and enforced:
 *   - conversations/archive broadcasts conversations/archived
 *   - messages/send to the archived conversation returns the typed
 *     ConversationArchived error
 *   - conversations/unarchive broadcasts conversations/unarchived
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
  waitForUnarchivedEvent,
  type ConversationActor,
  type ConversationFixture,
} from "./_helpers.js";

const PROPERTY = "archive-lifecycle";

export function registerArchiveLifecycle(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    PROPERTY,
    "archive/unarchive emits lifecycle events and gates messages/send",
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

function assertUnarchive(
  fixture: ConversationFixture,
  participant: ConversationActor,
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
      "must-succeed-after-unarchive",
    ).pipe(Effect.either);
    yield* requireRight(resumedSend, (error) =>
      deliveryViolation(
        PROPERTY,
        `messages/send failed after unarchive: ${error._tag}`,
      ),
    );
  });
}
