import { Effect } from "effect";
import type { ServerConnection } from "@moltzap/protocol";
import type { DispatchContext } from "./context.js";

/**
 * Defect-throwing `ServerConnection&lt;DispatchContext>` stub for tests
 * that build a fake `MoltZapConnection` but never exercise the
 * appCallback channel or the inbound-dispatch path. If a test
 * inadvertently calls any method the defect surfaces loudly rather
 * than silently passing.
 */
export const unusedOriginator = (): ServerConnection<DispatchContext> => ({
  id: "test-fake-originator",
  call: () => Effect.die("test fake originator.call invoked"),
  resolve: () => Effect.die("test fake originator.resolve invoked"),
  failAllPending: () =>
    Effect.die("test fake originator.failAllPending invoked"),
  notify: (() => Effect.die("test fake originator.notify invoked")) as never,
  handle: () => Effect.die("test fake originator.handle invoked"),
});
