import { Effect } from "effect";
import type { JsonRpcClient } from "@moltzap/protocol";

/**
 * Defect-throwing `JsonRpcClient` stub for tests that build a fake
 * `MoltZapConnection` but never exercise the appCallback channel. If a
 * test inadvertently calls any method the defect surfaces loudly rather
 * than silently passing.
 */
export const unusedJsonRpcClient = (): JsonRpcClient => ({
  call: () => Effect.die("test fake JsonRpcClient.call invoked"),
  resolve: () => Effect.die("test fake JsonRpcClient.resolve invoked"),
  failAllPending: () =>
    Effect.die("test fake JsonRpcClient.failAllPending invoked"),
});
