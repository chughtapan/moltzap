import { DEFAULT_APP_ID } from "@moltzap/protocol/task";
import type { AppHost } from "./app-host.js";

/**
 * Boot-time installation of the default app. Default-grant dispatch
 * hook + no message-authorize hook (falls through to the default
 * forward policy in `runMessageAuthorize`). TM-only RPCs are
 * unreachable on DEFAULT_APP_ID tasks by design.
 */
export function installDefaultApp(appHost: AppHost): void {
  appHost.installInProcessApp(
    { appId: DEFAULT_APP_ID, name: "Default" },
    {
      dispatchAuthorize: () => Promise.resolve({ decision: "grant" as const }),
    },
  );
}
