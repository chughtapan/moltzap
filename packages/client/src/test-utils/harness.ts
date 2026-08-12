/**
 * @file Connects black-box test agents through the public registration and
 * authenticated WebSocket boundaries.
 */
import { Cause, Effect } from "effect";
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

/** Registration material paired with its authenticated test client. */
export interface ConnectedHarnessAgent extends RegisterResponse {
  readonly client: HarnessAgentClient;
}

/**
 * Registers an agent through the public HTTP boundary, then opens and
 * authenticates its WS client; the client derives its `/ws` endpoint from
 * the HTTP base itself.
 * @param baseUrl HTTP origin used for registration and socket discovery.
 * @param name Display name assigned to the registered test agent.
 * @returns Registration material and the connected client capability.
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
          cause instanceof Error ? cause : new Cause.UnknownException(cause),
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
