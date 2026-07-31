import { Effect } from "effect";
import { messagesSend } from "@moltzap/protocol/message";
import {
  DEFAULT_APP_ID,
  type AgentKey,
  type AgentId,
} from "@moltzap/protocol/identity";
import {
  agentConversationCreate,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import { createTestAgent } from "@moltzap/server-core/test-utils";
import { MoltZapAgentClient } from "../../agent-client.js";
import { stripWsPath } from "../../test-utils/index.js";
import { MoltZapService } from "../../service.js";
import { MESSAGE_SETTLE_MS } from "./constants.js";
import { coreBaseUrl, coreWsUrl } from "./server.js";

/**
 * Registers agent.
 * @param name Name of the operation.
 * @returns The register agent result.
 */
export function registerAgent(name: string) {
  return Effect.gen(function* () {
    const reg = yield* createTestAgent(name);
    const client = new MoltZapAgentClient({
      serverUrl: stripWsPath(coreWsUrl()),
      agentKey: reg.apiKey,
    });
    return { ...reg, client };
  }).pipe(Effect.withSpan("registerAgent"));
}

/**
 * Executes the connect service operation.
 * @param apiKey Value supplied to the operation.
 * @param agentId Identifier of the agent targeted by the operation.
 * @returns The connect service result.
 */
export function connectService(
  apiKey: AgentKey,
  agentId: AgentId,
): Effect.Effect<MoltZapService, Error> {
  return Effect.gen(function* () {
    const service = MoltZapService.fromConfig({
      agentId,
      agentKey: apiKey,
      serverUrl: coreBaseUrl(),
    });
    yield* service.connect();
    return service;
  }).pipe(Effect.withSpan("connectService"));
}

/**
 * Sends and settle.
 * @param client Client used for the operation.
 * @param conversationId Value supplied to the operation.
 * @param text Text to process.
 * @returns The send and settle result.
 */
export function sendAndSettle(
  client: MoltZapAgentClient,
  conversationId: ConversationId,
  text: string,
) {
  return Effect.gen(function* () {
    yield* client.call(messagesSend.name, {
      conversationId,
      parts: [{ type: "text", text }],
    });
    yield* Effect.sleep(`${MESSAGE_SETTLE_MS} millis`);
  }).pipe(Effect.withSpan("sendAndSettle"));
}

type ConnectedService = Effect.Effect.Success<
  ReturnType<typeof connectService>
>;
type TestClient = Effect.Effect.Success<
  ReturnType<typeof registerAgent>
>["client"];

/**
 * Provides the create dm runtime value.
 * @param service Value supplied to the operation.
 * @param agentId Identifier of the agent targeted by the operation.
 * @returns The created dm.
 */
export const createDm = (service: ConnectedService, agentId: AgentId) =>
  service
    .call(agentConversationCreate.name, {
      appId: DEFAULT_APP_ID,
      participants: [agentId],
    })
    .pipe(Effect.withSpan("createDm"));

/**
 * Provides the connect clients runtime value.
 * @param clients Value supplied to the operation.
 * @returns The connect clients result.
 */
export const connectClients = (
  ...clients: readonly TestClient[]
): Effect.Effect<void, unknown> =>
  Effect.all(
    clients.map((client) => client.connect()),
    { concurrency: clients.length },
  ).pipe(Effect.asVoid, Effect.withSpan("connectClients"));

/**
 * Error-free finalizer: closes services synchronously, then all clients concurrently.
 * @param services Value supplied to the operation.
 * @param clients Value supplied to the operation.
 * @returns The close all result.
 */
export const closeAll = (
  services: readonly ConnectedService[],
  clients: readonly TestClient[],
): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const service of services) {
      service.close();
    }
  }).pipe(
    Effect.zipRight(
      Effect.forEach(clients, (client) => client.close().pipe(Effect.ignore), {
        concurrency: clients.length,
      }),
    ),
    Effect.asVoid,
    Effect.withSpan("closeAll"),
  );
