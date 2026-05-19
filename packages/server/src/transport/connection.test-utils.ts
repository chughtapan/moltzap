import { Effect } from "effect";
import type { AgentClientConnection } from "@moltzap/protocol";

/**
 * Defect-throwing `AgentClientConnection` stub for tests that build a
 * fake `MoltZapConnection` but never exercise the appCallback channel.
 * If a test inadvertently calls any method the defect surfaces loudly
 * rather than silently passing.
 */
export const unusedOriginator = (): AgentClientConnection => ({
  id: "test-fake-originator",
  call: () => Effect.die("test fake originator.call invoked"),
  resolve: () => Effect.die("test fake originator.resolve invoked"),
  failAllPending: () =>
    Effect.die("test fake originator.failAllPending invoked"),
  notify: (() => Effect.die("test fake originator.notify invoked")) as never,
});
