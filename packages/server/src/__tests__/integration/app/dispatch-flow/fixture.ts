import type { AppManifest } from "@moltzap/protocol";
import { messageId } from "@moltzap/protocol/testing";
import { Effect } from "effect";
import {
  getTestCoreApp,
  resetTestDbEffect,
  startTestServerEffect,
  stopTestServerEffect,
} from "../../helpers.js";

type GrantVerdict = {
  readonly decision: "grant";
  readonly leaseTimeoutMs?: number;
};
type DenyVerdict = { readonly decision: "deny"; readonly reason?: string };
type HoldVerdict = { readonly decision: "hold"; readonly reason?: string };
type HookVerdict = GrantVerdict | DenyVerdict | HoldVerdict;

export type DispatchHookVerdict =
  | HookVerdict
  | { readonly kind: "never-reply" };

export const EXPECTED_TYPE_STRING = "string";
export const EITHER_LEFT_TAG = "Left";
export const DISPATCH_STATE_GRANTED = "GRANTED";
export const DISPATCH_STATE_EXPIRED = "EXPIRED";
export const DISPATCH_STATE_ABANDONED = "ABANDONED";
export const DISPATCH_STATE_CONSUMED = "CONSUMED";
export const DISPATCH_VERDICT_GRANT = "grant";
export const DISPATCH_VERDICT_DENY = "deny";
export const DISPATCH_VERDICT_HOLD = "hold";
export const MODERATOR_UNAVAILABLE_REASON = "moderator_unavailable";
export const MODERATOR_TIMEOUT_REASON = "timeout";

export const startDispatchFlowServer = () =>
  Effect.runPromise(startTestServerEffect());

export const stopDispatchFlowServer = () =>
  Effect.runPromise(stopTestServerEffect());

export const makeProbeMessageId = () => messageId(crypto.randomUUID());

export function createDispatchFlowFixture(manifest: AppManifest) {
  let hookCalls = 0;
  let nextHookVerdict: DispatchHookVerdict = { decision: "grant" };

  const authorizeDispatch = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        hookCalls += 1;
        const verdict = nextHookVerdict;
        if ("kind" in verdict && verdict.kind === "never-reply") {
          return yield* Effect.never;
        }
        return verdict;
      }).pipe(Effect.withSpan("dispatchFlow.authorizeHook")),
    );

  const reset = resetTestDbEffect().pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        hookCalls = 0;
        nextHookVerdict = { decision: "grant" };
        const coreApp = getTestCoreApp();
        coreApp.registerApp(manifest);
        coreApp.onTaskAuthorizeDispatch(manifest.appId, authorizeDispatch);
      }),
    ),
    Effect.withSpan("dispatchFlow.reset"),
  );

  return {
    reset,
    hookCalls: () => hookCalls,
    setNextHookVerdict: (verdict: DispatchHookVerdict) => {
      nextHookVerdict = verdict;
    },
  };
}
