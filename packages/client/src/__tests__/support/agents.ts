import { Effect } from "effect";
import { ConversationsCreate, MessagesSend } from "@moltzap/protocol";
import { MoltZapAgentClient } from "@moltzap/client";
import {
  registerAgent as registerAgentHttp,
  stripWsPath,
} from "@moltzap/client/test";
import { MoltZapService } from "../../service.js";
import { MESSAGE_SETTLE_MS } from "./constants.js";
import { coreBaseUrl, coreWsUrl } from "./server.js";

export function registerAgent(name: string) {
  return Effect.gen(function* () {
    const reg = yield* registerAgentHttp(coreBaseUrl(), name);
    const client = new MoltZapAgentClient({
      serverUrl: stripWsPath(coreWsUrl()),
      agentKey: reg.apiKey,
    });
    return { client, ...reg };
  }).pipe(Effect.withSpan("registerAgent"));
}

export function connectService(
  apiKey: string,
): Effect.Effect<MoltZapService, Error> {
  return Effect.gen(function* () {
    const service = new MoltZapService({
      serverUrl: coreBaseUrl(),
      agentKey: apiKey,
    });
    yield* service.connect();
    return service;
  }).pipe(Effect.withSpan("connectService"));
}

export function sendAndSettle(
  client: MoltZapAgentClient,
  conversationId: string,
  text: string,
) {
  return Effect.gen(function* () {
    yield* client.sendRpc(MessagesSend, {
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

export const createDm = (service: ConnectedService, agentId: string) =>
  service
    .sendRpc(ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: agentId }],
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
