import { Effect } from "effect";
import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import { MessagesSend } from "@moltzap/protocol/message";
import type { AgentKey } from "@moltzap/protocol/identity";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import { createTestAgent } from "@moltzap/server-core/test-utils";
import { MoltZapAgentClient } from "@moltzap/client";
import { stripWsPath } from "../../test-utils/index.js";
import { MoltZapService } from "../../service.js";
import { MESSAGE_SETTLE_MS } from "./constants.js";
import { coreBaseUrl, coreWsUrl } from "./server.js";

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

export function sendAndSettle(
  client: MoltZapAgentClient,
  taskId: TaskId,
  conversationId: ConversationId,
  text: string,
) {
  return Effect.gen(function* () {
    yield* client.call(MessagesSend.name, {
      taskId,
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

export const createDm = (service: ConnectedService, agentId: AgentId) =>
  service
    .call(TaskRequest.name, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [agentId],
      initialConversation: { participants: [agentId] },
    })
    .pipe(Effect.withSpan("createDm"));

export const connectClients = (
  ...clients: ReadonlyArray<TestClient>
): Effect.Effect<void, unknown> =>
  Effect.all(
    clients.map((client) => client.connect()),
    { concurrency: clients.length },
  ).pipe(Effect.asVoid, Effect.withSpan("connectClients"));

export const closeClients = (
  ...clients: ReadonlyArray<TestClient>
): Effect.Effect<void> =>
  Effect.all(
    clients.map((client) => client.close()),
    { concurrency: clients.length },
  ).pipe(Effect.asVoid, Effect.withSpan("closeClients"));
