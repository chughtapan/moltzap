import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  dispatchAdmissionViolation,
  freshMessageId,
  type ReleaseFrameView,
  withDriver,
} from "./_helpers.js";
import type { DispatchTestDriver } from "./_driver.js";

type AuthorizeVerdict =
  | { readonly _tag: "grant" }
  | { readonly _tag: "deny"; readonly reason: string }
  | { readonly _tag: "hold"; readonly reason: string };

const VERDICTS: ReadonlyArray<AuthorizeVerdict> = [
  { _tag: "grant" },
  { _tag: "deny", reason: "policy" },
  { _tag: "hold", reason: "queued" },
];

export function registerDispatchAuthorizeVerdictResolves(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-authorize-verdict-resolves-lease";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "moderator's {grant|deny|hold} reply causes the server to emit agent/dispatch/released with the matching verdict to the recipient",
    assertAllVerdictReleases(ctx, NAME).pipe(
      Effect.withSpan("registerDispatchAuthorizeVerdictResolves"),
    ),
  );
}

function assertAllVerdictReleases(
  ctx: ConformanceRunContext,
  propertyName: string,
) {
  return Effect.gen(function* () {
    for (const verdict of VERDICTS) {
      yield* withDriver(ctx, (driver) =>
        assertVerdictRelease(propertyName, driver, verdict),
      );
    }
  });
}

function assertVerdictRelease(
  propertyName: string,
  driver: DispatchTestDriver,
  verdict: AuthorizeVerdict,
) {
  return Effect.gen(function* () {
    yield* driver.moderator.handleAuthorize({ respondWith: verdict });
    const ack = yield* driver.recipient.requestDispatch({
      conversationId: driver.fixtures.conversationId,
      messageId: freshMessageId(),
      senderAgentId: driver.moderator.agentId,
    });
    const release = yield* driver.recipient.waitForRelease();
    const params = release.params as ReleaseFrameView;
    yield* assertReleaseLeaseId(propertyName, params, ack.leaseId);
    yield* assertReleaseDecision(propertyName, params, verdict);
    yield* assertReleaseReason(propertyName, params, verdict);
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
  verdict: AuthorizeVerdict,
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

function assertReleaseReason(
  propertyName: string,
  params: ReleaseFrameView,
  verdict: AuthorizeVerdict,
) {
  if (verdict._tag === "grant" || params.verdict.reason === verdict.reason) {
    return Effect.void;
  }
  return Effect.fail(
    dispatchAdmissionViolation(
      propertyName,
      `release reason ${String(params.verdict.reason)} != expected ${verdict.reason}`,
    ),
  );
}
