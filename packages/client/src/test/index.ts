import { Effect } from "effect";
import { MoltZapWsClient } from "../ws-client.js";

export interface RegisterResponse {
  agentId: string;
  apiKey: string;
  claimUrl: string;
  claimToken: string;
}

/** Register a new agent via HTTP. Thin wrapper around the `/api/v1/auth/register`
 * endpoint — the WebSocket dance is {@link MoltZapWsClient}'s job; this just
 * returns the credentials tests need to feed it `agentKey` at construction. */
export const registerAgent = (
  baseUrl: string,
  name: string,
  opts?: { description?: string; inviteCode?: string },
): Effect.Effect<RegisterResponse, Error> =>
  Effect.tryPromise({
    try: () => {
      const body: Record<string, string> = { name };
      if (opts?.description) body.description = opts.description;
      if (opts?.inviteCode) body.inviteCode = opts.inviteCode;
      return fetch(`${baseUrl}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.flatMap((res) =>
      res.ok
        ? Effect.tryPromise({
            try: () => res.json() as Promise<RegisterResponse>,
            catch: (err) =>
              err instanceof Error ? err : new Error(String(err)),
          })
        : Effect.tryPromise({
            try: () => res.text(),
            catch: (err) =>
              err instanceof Error ? err : new Error(String(err)),
          }).pipe(
            Effect.flatMap((text) =>
              Effect.fail(new Error(`Register failed: ${res.status} ${text}`)),
            ),
          ),
    ),
  );

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
  opts?: { description?: string; inviteCode?: string },
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
