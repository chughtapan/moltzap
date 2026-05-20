/**
 * @file Compatibility helpers for tests that import `@moltzap/client/test`.
 */

import { Effect } from "effect";
import { MoltZapAgentClient } from "@moltzap/client";
import { registerAgent, type RegisterAgentOptions } from "@moltzap/client";
import type { RegisterAgentError } from "../auth.js";
import type { ServiceRpcError } from "../service.js";

/**
 * Back-compat re-exports. `registerAgent` and its types were promoted to
 * the `@moltzap/client` root; this surface stays so existing test imports
 * (`@moltzap/client/test`) keep working unchanged. New callers should
 * import from `@moltzap/client` directly.
 */
export {
  registerAgent,
  type RegisterAgentOptions,
  type RegisterResponse,
} from "@moltzap/client";

/**
 * Strip the `/ws` suffix that test harnesses tack onto the WebSocket URL.
 * @param wsUrl WebSocket URL supplied by a test harness.
 * @returns Base URL suitable for `MoltZapAgentClient`.
 */
export const stripWsPath = (wsUrl: string): string =>
  wsUrl.replace(/\/ws\/?$/, "");

/**
 * Registered and connected test agent credentials.
 */
export interface ConnectedTestAgent {
  client: MoltZapAgentClient;
  agentId: string;
  apiKey: string;
  claimUrl: string;
  claimToken: string;
}

/**
 * Error union surfaced by {@link registerAndConnect}.
 */
export type RegisterAndConnectError = RegisterAgentError | ServiceRpcError;

/**
 * Register a fresh agent, build a `MoltZapAgentClient` with its apiKey, and
 * complete the `network/connect` handshake. Returns the live client ready for
 * RPCs and event waits. Caller is responsible for `yield* client.close()`.
 * @param baseUrl HTTP base URL for the server.
 * @param wsUrl WebSocket URL from the test server.
 * @param name Agent name to register.
 * @param opts Optional registration fields.
 * @returns Connected test agent and credentials.
 */
export const registerAndConnect = (
  baseUrl: string,
  wsUrl: string,
  name: string,
  opts?: RegisterAgentOptions,
): Effect.Effect<ConnectedTestAgent, RegisterAndConnectError> =>
  Effect.gen(function* () {
    const reg = yield* registerAgent(baseUrl, name, opts);
    const client = new MoltZapAgentClient({
      serverUrl: stripWsPath(wsUrl),
      agentKey: reg.apiKey,
    });
    yield* client.connect();
    return { client, ...reg };
  }).pipe(Effect.withSpan("registerAndConnect"));
