import { Effect, Exit } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  NO_SECOND_RELEASE_WINDOW_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";
import type { DispatchTestDriver, RecipientHandle } from "./_driver.js";

/**
 * Registers the one-live-dispatch-per-conversation property.
 * @param ctx Context for the operation.
 */
export function registerSameConversationDispatchRequestBusy(
  ctx: ConformanceRunContext,
): void {
  const name = "same-conversation-second-dispatch-returns-busy";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    "two concurrent requests for one conversation produce one lease and one no-lease conversation_busy outcome",
    withDriver(ctx, (driver) =>
      runSameConversationDispatchRequestBusy(name, driver),
    ).pipe(Effect.withSpan("registerSameConversationDispatchRequestBusy")),
  );
}

function runSameConversationDispatchRequestBusy(
  propertyName: string,
  driver: DispatchTestDriver,
) {
  return Effect.gen(function* () {
    yield* driver.moderator.handleAuthorize({
      respondWith: { _tag: "deny" },
    });
    const second = yield* driver.addRecipient({});
    const [firstOutcome, secondOutcome] = yield* requestConcurrentDispatches(
      driver,
      second,
    );

    let winnerRecipient = driver.recipient;
    let busyRecipient = second;
    let winnerLeaseId: Parameters<
      RecipientHandle["sendWithLease"]
    >[0]["leaseId"];
    if ("outcome" in firstOutcome) {
      yield* assertBusyOutcome(propertyName, firstOutcome);
      if ("outcome" in secondOutcome) {
        return yield* dispatchAdmissionViolation(
          propertyName,
          "both concurrent requests returned conversation_busy",
        );
      }
      winnerRecipient = second;
      busyRecipient = driver.recipient;
      winnerLeaseId = secondOutcome.leaseId;
    } else {
      if (!("outcome" in secondOutcome)) {
        return yield* dispatchAdmissionViolation(
          propertyName,
          "both concurrent requests minted leases",
        );
      }
      yield* assertBusyOutcome(propertyName, secondOutcome);
      winnerLeaseId = firstOutcome.leaseId;
    }

    yield* winnerRecipient.waitForRelease(matchesLeaseId(winnerLeaseId));
    yield* assertNoBusyRelease(propertyName, busyRecipient);

    yield* driver.moderator.handleAuthorize({ respondWith: { _tag: "deny" } });
    const retry = yield* driver.recipient.requestDispatch({
      conversationId: driver.fixtures.conversationId,
      messageId: freshMessageId(),
      senderAgentId: driver.moderator.agentId,
    });
    yield* driver.recipient.waitForRelease(matchesLeaseId(retry.leaseId));
  });
}

function requestConcurrentDispatches(
  driver: DispatchTestDriver,
  second: RecipientHandle,
) {
  const conversationId = driver.fixtures.conversationId;
  return Effect.all(
    [
      driver.recipient.requestDispatchOutcome({
        conversationId,
        messageId: freshMessageId(),
        senderAgentId: driver.moderator.agentId,
      }),
      second.requestDispatchOutcome({
        conversationId,
        messageId: freshMessageId(),
        senderAgentId: driver.moderator.agentId,
      }),
    ] as const,
    { concurrency: 2 },
  );
}

function assertBusyOutcome(
  propertyName: string,
  outcome: { readonly outcome: "conversation_busy" },
) {
  return Object.keys(outcome).length === 1
    ? Effect.void
    : dispatchAdmissionViolation(
        propertyName,
        "conversation_busy outcome unexpectedly carried lease data",
      );
}

function assertNoBusyRelease(propertyName: string, recipient: RecipientHandle) {
  return Effect.gen(function* () {
    const release = yield* Effect.exit(
      recipient.waitForRelease(undefined, NO_SECOND_RELEASE_WINDOW_MS),
    );
    if (Exit.isSuccess(release)) {
      return yield* dispatchAdmissionViolation(
        propertyName,
        "conversation_busy unexpectedly produced agent/dispatch/released",
      );
    }
  });
}

function matchesLeaseId(
  leaseId: Parameters<RecipientHandle["sendWithLease"]>[0]["leaseId"],
) {
  return (frame: { readonly params: unknown }) =>
    typeof frame.params === "object" &&
    frame.params !== null &&
    Reflect.get(frame.params, "leaseId") === leaseId;
}
