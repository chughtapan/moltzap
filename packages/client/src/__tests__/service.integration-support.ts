import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import { Data, Effect } from "effect";
import {
  ConversationsArchive,
  ConversationsCreate,
  ConversationsList,
  ConversationArchivedError,
  MessageReceivedNotificationDefinition,
  type Message,
  MessagesList,
  MessagesSend,
} from "@moltzap/protocol";
import {
  startCoreTestServer,
  stopCoreTestServer,
  resetCoreTestDb,
} from "@moltzap/server-core/test-utils";
import { MoltZapWsClient } from "@moltzap/client";
import {
  registerAgent as registerAgentHttp,
  stripWsPath,
} from "@moltzap/client/test";
import {
  LocalServiceCommands,
  requestLocalService,
  request as socketRpcRequest,
  sendSocketRequest,
} from "../cli/socket-client.js";
import type {
  HistoryRequestInput,
  HistoryResponse,
} from "../runtime/local-history.js";
import { renderPart } from "../runtime/service-helpers.js";
import { MoltZapService } from "../service.js";

export const INTEGRATION_HOOK_TIMEOUT_MS = 60_000;
export const MESSAGE_SETTLE_MS = 500;
export const NOTIFICATION_WAIT_MS = 5_000;
export const HISTORY_SETTLE_MS = 2_000;
export const LONG_MESSAGE_LENGTH = 500;
export const HISTORY_MESSAGE_COUNT = 25;
export const SOCKET_RESPONSE_TIMEOUT_MS = 2_000;
export const CONTEXT_LIMIT = 2;
export const SOCKET_HISTORY_LIMIT = 10;
export const SOCKET_PAGE_MESSAGE_COUNT = 3;
export const SERVICE_NAME_TEST = "name-test";
export const HELLO_FROM_C = "Hello from C";
export const HELLO_RECEIVER = "Hello receiver";
export const HELLO_FROM_SERVICE = "Hello from service";
export const SHARED_UPDATE = "Shared update";
export const B_UPDATE = "B update";
export const FROM_C = "From C";
export const FROM_D = "From D";
export const FIRST_MESSAGE = "First";
export const SECOND_MESSAGE = "Second";
export const NEW_MESSAGE = "new msg";
export const PRICE_MESSAGE = "Price is $4000";
export const TRACK_SESSION_KEY = "track-test-session";
export const TRACK_NEW_MESSAGE = "track-msg-new";
export const IMAGE_MARKER = "[image]";
export const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
export const ONE_NEW_MARKER = "(1 new)";
export const ARCHIVED_MESSAGE = "Conversation is archived";
export const RESOLVED_AGENT_CONTEXT_NAME = "@name-res-c";
export const HISTORY_FIRST_BUFFER_MESSAGE = "msg-0";
export const HISTORY_LAST_BUFFER_MESSAGE = "msg-24";
export const PEEK_FROM_C = "from C";
export const HISTORY_PARTICIPANT_COUNT = 3;
export const SOCK_HIST_B_NAME = "sock-hist-b";

let baseUrl = "";
let wsUrl = "";

class ServiceIntegrationHookError extends Data.TaggedError(
  "ServiceIntegrationHookError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const hookPromise = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new ServiceIntegrationHookError({ operation, cause }),
  });

export function setupServiceIntegration(): void {
  beforeAll(
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const pgHost = inject("testPgHost");
          const pgPort = inject("testPgPort");
          const server = yield* hookPromise("startCoreTestServer", () =>
            startCoreTestServer({ pgHost, pgPort }),
          );
          baseUrl = server.baseUrl;
          wsUrl = server.wsUrl;
        }).pipe(Effect.withSpan("setupServiceIntegration")),
      ),
    INTEGRATION_HOOK_TIMEOUT_MS,
  );

  afterAll(() =>
    Effect.runPromise(
      hookPromise("stopCoreTestServer", () => stopCoreTestServer()),
    ),
  );

  beforeEach(() =>
    Effect.runPromise(hookPromise("resetCoreTestDb", () => resetCoreTestDb())),
  );
}

export function registerAgent(name: string) {
  return Effect.gen(function* () {
    const reg = yield* registerAgentHttp(baseUrl, name);
    const client = new MoltZapWsClient({
      serverUrl: stripWsPath(wsUrl),
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
      serverUrl: baseUrl,
      agentKey: apiKey,
    });
    yield* service.connect();
    return service;
  }).pipe(Effect.withSpan("connectService"));
}

export function sendAndSettle(
  client: MoltZapWsClient,
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

export const socketRequest = (
  method: string,
  params?: Record<string, unknown>,
  socketPath?: string,
) => {
  const resolvedParams = params ?? {};
  if (socketPath === undefined) {
    return sendSocketRequest(method, resolvedParams);
  }
  return sendSocketRequest(method, resolvedParams, socketPath);
};

export { socketRpcRequest };

type ConnectedService = Effect.Effect.Success<
  ReturnType<typeof connectService>
>;
type TestClient = Effect.Effect.Success<
  ReturnType<typeof registerAgent>
>["client"];

export type SocketHistoryResponse = HistoryResponse;

export const textContent = (message: Message): string =>
  message.parts.map(renderPart).join("");

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

export const socketHistory = (
  conversationId: string,
  sessionKey?: string,
  limit = SOCKET_HISTORY_LIMIT,
): Effect.Effect<SocketHistoryResponse, unknown> => {
  const params: HistoryRequestInput =
    sessionKey === undefined
      ? {
          conversationId,
          limit,
        }
      : {
          conversationId,
          sessionKey,
          limit,
        };
  return requestLocalService(LocalServiceCommands.History, params).pipe(
    Effect.withSpan("socketHistory"),
  );
};

export {
  ConversationsArchive,
  ConversationsCreate,
  ConversationsList,
  ConversationArchivedError,
  LocalServiceCommands,
  MessageReceivedNotificationDefinition,
  MessagesList,
  MessagesSend,
  requestLocalService,
};
