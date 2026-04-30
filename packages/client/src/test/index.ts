import { Effect } from "effect";
import { MoltZapWsClient } from "../ws-client.js";
import { registerAgent, type RegisterAgentOptions } from "../auth.js";

/** Back-compat re-exports. `registerAgent` and its types were promoted to
 * the `@moltzap/client` root; this surface stays so existing test imports
 * (`@moltzap/client/test`) keep working unchanged. New callers should
 * import from `@moltzap/client` directly. */
export {
  registerAgent,
  type RegisterAgentOptions,
  type RegisterResponse,
} from "../auth.js";

/** Strip the `/ws` suffix that test harnesses tack onto the WebSocket URL —
 * `MoltZapWsClient` re-appends it internally. */
export const stripWsPath = (wsUrl: string): string =>
  wsUrl.replace(/\/ws\/?$/, "");

export interface ConnectedTestAgent {
  client: MoltZapWsClient;
  agentId: string;
  apiKey: string;
  claimUrl: string;
  claimToken: string;
}

/** Register a fresh agent, build a `MoltZapWsClient` with its apiKey, and
 * complete the `auth/connect` handshake. Returns the live client ready for
 * RPCs and event waits. Caller is responsible for `yield* client.close()`. */
export const registerAndConnect = (
  baseUrl: string,
  wsUrl: string,
  name: string,
  opts?: RegisterAgentOptions,
): Effect.Effect<ConnectedTestAgent, Error> =>
  Effect.gen(function* () {
    const reg = yield* registerAgent(baseUrl, name, opts);
    const client = new MoltZapWsClient({
      serverUrl: stripWsPath(wsUrl),
      agentKey: reg.apiKey,
    });
    yield* client.connect().pipe(
      Effect.catchTag("RpcTimeoutError", (err) =>
        Effect.fail(new Error(`RPC timeout: ${err.method}`)),
      ),
      Effect.mapError((err) => new Error(err.message)),
    );
    return { client, ...reg };
  });
