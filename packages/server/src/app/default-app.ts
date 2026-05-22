import { DEFAULT_APP_ID } from "@moltzap/protocol/task";
import type { AppHost } from "./app-host.js";

/**
 * Boot-time hook for the unmoderated default app.
 *
 * Registers a default-grant `taskAuthorizeDispatch` hook for
 * DEFAULT_APP_ID so dispatch admission on unmoderated tasks resolves
 * uniformly through the same path as any other registered app —
 * `runAppBoundDispatchRoundTrip` calls the hook, hook returns grant,
 * lease transitions to GRANTED.
 *
 * No other DEFAULT_APP_ID behavior lives in server production code.
 * TM-only RPCs (task/conversation/create, task/close, etc.) require a
 * registered remote-app connection and are unreachable on DEFAULT_APP_ID
 * tasks by design. Client-side dedup ("one DM per participant set") is
 * a client concern.
 */
export function installDefaultAppDispatchHook(appHost: AppHost): void {
  appHost.onTaskAuthorizeDispatch(DEFAULT_APP_ID, () =>
    Promise.resolve({ decision: "grant" as const }),
  );
}
