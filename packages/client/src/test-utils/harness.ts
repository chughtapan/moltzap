import { Effect } from "effect";
import { MoltZapAgentClient } from "../agent-client.js";
import { registerAgent, type RegisterResponse } from "../auth.js";

/**
 * Connected-client shape used by cross-package integration harnesses:
 * notification subscription plus definition-keyed RPC dispatch over one
 * authenticated agent socket.
 */
export interface HarnessAgentClient {
  readonly close: () => Effect.Effect<void>;
  readonly subscribe: MoltZapAgentClient["subscribe"];
  readonly sendRpc: MoltZapAgentClient["callDefinition"];
}

/** Describes connected harness agent. */
export interface ConnectedHarnessAgent extends RegisterResponse {
  readonly client: HarnessAgentClient;
}

/**
 * Registers an agent through the public HTTP boundary, then opens and
 * authenticates its WS client; the client derives its `/ws` endpoint from
 * the HTTP base itself.
 * @param baseUrl Value supplied to the operation.
 * @param name Name of the operation.
 * @returns The register and connect result.
 */
export function registerAndConnect(
  baseUrl: string,
  name: string,
): Effect.Effect<ConnectedHarnessAgent, Error> {
  return Effect.gen(function* () {
    const registered = yield* registerAgent(baseUrl, name);
    const client = new MoltZapAgentClient({
      serverUrl: baseUrl,
      agentKey: registered.apiKey,
    });
    yield* client
      .connect()
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );
    return {
      agentId: registered.agentId,
      apiKey: registered.apiKey,
      client: {
        close: () => client.close(),
        subscribe: client.subscribe.bind(client),
        sendRpc: client.callDefinition.bind(client),
      },
    };
  }).pipe(Effect.withSpan("registerAndConnect"));
}
