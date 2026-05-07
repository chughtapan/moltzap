import { Data, Effect } from "effect";
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

export class RegisterAndConnectError extends Data.TaggedError(
  "RegisterAndConnectError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Register a fresh agent, build a `MoltZapWsClient` with its apiKey, and
 * complete the `network/connect` handshake. Returns the live client ready for
 * RPCs and event waits. Caller is responsible for `yield* client.close()`. */
export const registerAndConnect = (
  baseUrl: string,
  wsUrl: string,
  name: string,
  opts?: RegisterAgentOptions,
): Effect.Effect<ConnectedTestAgent, RegisterAndConnectError> =>
  Effect.gen(function* () {
    const reg = yield* registerAgent(baseUrl, name, opts).pipe(
      Effect.mapError(
        (cause) =>
          new RegisterAndConnectError({
            message: "Agent registration failed",
            cause,
          }),
      ),
    );
    const client = new MoltZapWsClient({
      serverUrl: stripWsPath(wsUrl),
      agentKey: reg.apiKey,
    });
    yield* client.connect().pipe(
      Effect.catchTag("RpcTimeoutError", (err) =>
        Effect.fail(
          new RegisterAndConnectError({
            message: `RPC timeout: ${err.method}`,
            cause: err,
          }),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new RegisterAndConnectError({
            message: cause.message,
            cause,
          }),
      ),
    );
    return { client, ...reg };
  });
