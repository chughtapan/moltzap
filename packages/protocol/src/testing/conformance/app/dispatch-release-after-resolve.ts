import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  NO_SECOND_RELEASE_WINDOW_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  type ReleaseFrameView,
  withDriver,
} from "./_helpers.js";
import type { DispatchTestDriver } from "./_driver.js";

type ReleaseVerdict =
  | { readonly _tag: "grant" }
  | { readonly _tag: "deny"; readonly reason: string }
  | { readonly _tag: "hold"; readonly reason: string };

const RELEASE_VERDICTS: readonly ReleaseVerdict[] = [
  { _tag: "grant" },
  { _tag: "deny", reason: "policy" },
  { _tag: "hold", reason: "queued" },
];

function expectedLeaseState(
  verdict: ReleaseVerdict,
): "GRANTED" | "DENIED" | "HOLD" {
  if (verdict._tag === "grant") {
    return "GRANTED";
  }
  if (verdict._tag === "deny") {
    return "DENIED";
  }
  return "HOLD";
}

/**
 * Registers dispatch release fires after resolve.
 * @param ctx Context for the operation.
 */
export function registerDispatchReleaseFiresAfterResolve(
  ctx: ConformanceRunContext,
): void {
  const name = "dispatch-release-fires-after-resolve";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    "for every resolved lease (grant/deny/hold), exactly one agent/dispatch/released reaches the recipient",
    assertAllSingleReleases(ctx, name).pipe(
      Effect.withSpan("registerDispatchReleaseFiresAfterResolve"),
    ),
  );
}

function assertAllSingleReleases(
  ctx: ConformanceRunContext,
  propertyName: string,
) {
  return Effect.gen(function* () {
    for (const verdict of RELEASE_VERDICTS) {
      yield* withDriver(ctx, (driver) =>
        assertSingleRelease(propertyName, driver, verdict),
      );
    }
  });
}

function assertSingleRelease(
  propertyName: string,
  driver: DispatchTestDriver,
  verdict: ReleaseVerdict,
) {
  return Effect.gen(function* () {
    yield* driver.moderator.handleAuthorize({ respondWith: verdict });
    const ack = yield* driver.recipient.requestDispatch({
      conversationId: driver.fixtures.conversationId,
      messageId: freshMessageId(),
      senderAgentId: driver.moderator.agentId,
    });
    yield* driver.assertLeaseState(ack.dispatchId, expectedLeaseState(verdict));
    const release = yield* driver.recipient.waitForRelease();
    yield* assertNoSecondRelease(propertyName, driver);
    const params = release.params as ReleaseFrameView;
    yield* assertReleaseLeaseId(propertyName, params, ack.leaseId);
    yield* assertReleaseDecision(propertyName, params, verdict);
  });
}

function assertNoSecondRelease(
  propertyName: string,
  driver: DispatchTestDriver,
) {
  return Effect.gen(function* () {
    const followup = yield* Effect.exit(
      driver.recipient.waitForRelease(undefined, NO_SECOND_RELEASE_WINDOW_MS),
    );
    if (followup._tag === "Success") {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          "expected exactly one agent/dispatch/released per lease; got a second frame",
        ),
      );
    }
  });
}

function assertReleaseLeaseId(
  propertyName: string,
  params: ReleaseFrameView,
  expectedLeaseId: string,
) {
  return params.leaseId === expectedLeaseId
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `release leaseId ${params.leaseId} != ack ${expectedLeaseId}`,
        ),
      );
}

function assertReleaseDecision(
  propertyName: string,
  params: ReleaseFrameView,
  verdict: ReleaseVerdict,
) {
  return params.verdict.decision === verdict._tag
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `release decision ${params.verdict.decision} != expected ${verdict._tag}`,
        ),
      );
}
