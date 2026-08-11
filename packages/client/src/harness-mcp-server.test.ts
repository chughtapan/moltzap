/* eslint-disable agent-code-guard/async-keyword -- The official MCP SDK and Node loopback server expose Promise-native lifecycle APIs at this interoperability boundary. */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  createMcpHandler,
  McpServer,
  type Implementation,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- These loopback contract tests require raw Host headers and connection-refusal assertions that the Effect client does not expose.
import {
  Agent as NodeHttpAgent,
  request as nodeRequest,
  type IncomingMessage,
} from "node:http";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationCheckpoint } from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import { agentId, agentName, conversationId } from "@moltzap/protocol/testing";
import {
  makeHarnessMcpHttpHandler,
  type HarnessActiveTools,
} from "./harness-mcp-wire.js";
import { HARNESS_EVENTS_EXTENSION } from "./harness/index.js";
import { acquireHarnessMcpHttpServer } from "./harness-mcp-server.js";
import { makeHarnessMcpSubscriptionHandler } from "./harness-mcp-subscription.js";

const LOCALHOST = "127.0.0.1";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const MODERN_PROTOCOL_ERA = "modern";
// The daemon once served registration on its own path. Pinned here so the
// collapse to one URL stays proven rather than assumed.
const RETIRED_REGISTER_MCP_PATH = "/register/mcp";
const HARNESS_MCP_PATH = "/mcp";
const POST_METHOD = "POST";
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const METHOD_NOT_ALLOWED_STATUS = 405;
const GRACEFUL_SUBSCRIPTION_CLOSE = "graceful";
const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";
const BACKPRESSURE_PAYLOAD_BYTES = 8 * 1024 * 1024;
const BACKPRESSURE_WRITE_DELAY = Duration.millis(100);
const BACKPRESSURE_CLOSE_DEADLINE = Duration.seconds(3);
const SERVER_IMPLEMENTATION = {
  name: "harness-boundary-test",
  version: "1.0.0",
} satisfies Implementation;
const READ_CHECKPOINT = Schema.decodeSync(conversationCheckpoint)(
  "harness-read-checkpoint",
);
const START_OTHER_AGENT_NAME = agentName("peer-agent");
const START_CONVERSATION = {
  id: conversationId("550e8400-e29b-41d4-a716-446655440043"),
  createdBy: agentId("550e8400-e29b-41d4-a716-446655440044"),
  participants: [
    agentId("550e8400-e29b-41d4-a716-446655440044"),
    agentId("550e8400-e29b-41d4-a716-446655440045"),
  ],
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
};

const openServerScopes = new Set<Scope.CloseableScope>();
const openHandlers = new Set<McpHttpHandler>();
const openClients = new Set<Client>();
const noOp = (): undefined => undefined;

const makeReadPlaneHandlers = () => ({
  readConversation: vi.fn(() =>
    Effect.succeed({ messages: [], checkpoint: READ_CHECKPOINT }),
  ),
  searchAgents: vi.fn(() => Effect.succeed({ agents: [] })),
  searchConversations: vi.fn(() => Effect.succeed({ conversations: [] })),
});
type ReadPlaneHandlers = ReturnType<typeof makeReadPlaneHandlers>;

const makeStartConversationHandler = () =>
  vi.fn(() => Effect.succeed({ conversation: START_CONVERSATION }));
type StartConversationHandler = ReturnType<typeof makeStartConversationHandler>;

const makeHandler = (name: string, onCreate?: () => void): McpHttpHandler => {
  const handler = createMcpHandler(() => {
    onCreate?.();
    return new McpServer({ name, version: "1.0.0" });
  });
  openHandlers.add(handler);
  return handler;
};

const releaseServerScope = async (scope: Scope.CloseableScope) => {
  openServerScopes.delete(scope);
  await Effect.runPromise(Scope.close(scope, Exit.void));
};

const acquireServerWithHandler = async (handler: McpHttpHandler, port = 0) => {
  openHandlers.add(handler);
  const scope = Effect.runSync(Scope.make());
  const server = await Effect.runPromise(
    acquireHarnessMcpHttpServer({ port, handler }).pipe(Scope.extend(scope)),
  );
  openServerScopes.add(scope);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await releaseServerScope(scope);
    throw new Error("expected a TCP test server address");
  }
  return {
    baseUrl: `http://${LOCALHOST}:${address.port}`,
    server,
    scope,
  };
};

const makeServerWithHandler = async (handler: McpHttpHandler) =>
  (await acquireServerWithHandler(handler)).baseUrl;

const makeServer = async (onCreate?: () => void) =>
  await makeServerWithHandler(makeHandler("harness-test", onCreate ?? noOp));

const connectModernClient = async (url: URL) => {
  const client = new Client(
    { name: "harness-boundary-test", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: { pin: MODERN_PROTOCOL_VERSION },
      },
    },
  );
  openClients.add(client);
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
};

interface LoopbackResponse {
  readonly allow?: string;
  readonly status: number;
}

const requestLoopback = (
  url: URL,
  method = "GET",
  headers: Readonly<Record<string, string>> = {},
) =>
  new Promise<LoopbackResponse>((resolve, reject) => {
    const request = nodeRequest(url, { headers, method }, (response) => {
      response.resume();
      response.once("end", () => {
        resolve({
          allow: response.headers.allow,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.once("error", reject);
    request.end();
  });

afterEach(async () => {
  for (const client of openClients) {
    await client.close();
  }
  openClients.clear();
  for (const scope of openServerScopes) {
    await releaseServerScope(scope);
  }
  openServerScopes.clear();
  for (const handler of openHandlers) {
    await handler.close();
  }
  openHandlers.clear();
});

const servesModernDiscovery = async () => {
  let harnessCreates = 0;
  const baseUrl = await makeServer(() => {
    harnessCreates += 1;
  });

  const harnessClient = await connectModernClient(
    new URL(HARNESS_MCP_PATH, baseUrl),
  );

  expect(harnessClient.getProtocolEra()).toBe(MODERN_PROTOCOL_ERA);
  expect(harnessClient.getDiscoverResult()).toBeDefined();
  expect(harnessCreates).toBeGreaterThan(0);
};

const rejectsUnsupportedMethods = async () => {
  const baseUrl = await makeServer();

  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await requestLoopback(
      new URL(HARNESS_MCP_PATH, baseUrl),
      method,
    );
    expect(response.status).toBe(METHOD_NOT_ALLOWED_STATUS);
    expect(response.allow).toBe(POST_METHOD);
  }
};

const rejectsUnknownPaths = async () => {
  const baseUrl = await makeServer();
  const unknownUrl = new URL("/elsewhere", baseUrl);
  const postResponse = await requestLoopback(unknownUrl, POST_METHOD);
  const getResponse = await requestLoopback(unknownUrl);

  expect(postResponse.status).toBe(NOT_FOUND_STATUS);
  expect(getResponse.status).toBe(NOT_FOUND_STATUS);
};

const rejectsTheRetiredRegistrationPath = async () => {
  const baseUrl = await makeServer();
  const retiredUrl = new URL(RETIRED_REGISTER_MCP_PATH, baseUrl);

  expect((await requestLoopback(retiredUrl, POST_METHOD)).status).toBe(
    NOT_FOUND_STATUS,
  );
  expect((await requestLoopback(retiredUrl)).status).toBe(NOT_FOUND_STATUS);
};

const appliesLocalhostGuards = async () => {
  const baseUrl = await makeServer();
  const hostileHost = await requestLoopback(
    new URL("/elsewhere", baseUrl),
    "GET",
    { host: "example.com" },
  );
  const hostileOrigin = await requestLoopback(
    new URL(HARNESS_MCP_PATH, baseUrl),
    "GET",
    { origin: "https://example.com" },
  );
  const localhostOrigin = await requestLoopback(
    new URL(HARNESS_MCP_PATH, baseUrl),
    "GET",
    { origin: "http://localhost:4312" },
  );

  expect(hostileHost.status).toBe(FORBIDDEN_STATUS);
  expect(hostileOrigin.status).toBe(FORBIDDEN_STATUS);
  expect(localhostOrigin.status).toBe(METHOD_NOT_ALLOWED_STATUS);
};

const closesListenerWhenScopeReleases = async () => {
  const running = await acquireServerWithHandler(
    makeHandler("harness-scope-test"),
  );
  const harnessUrl = new URL(HARNESS_MCP_PATH, running.baseUrl);

  expect(running.server.listening).toBe(true);
  expect(running.server.address()).toMatchObject({ address: LOCALHOST });
  expect((await requestLoopback(harnessUrl)).status).toBe(
    METHOD_NOT_ALLOWED_STATUS,
  );

  await releaseServerScope(running.scope);

  expect(running.server.listening).toBe(false);
  await expect(requestLoopback(harnessUrl)).rejects.toBeDefined();
};

const closesListenerWhenAcquisitionIsInterrupted = async () => {
  const seed = await acquireServerWithHandler(
    makeHandler("harness-cancel-port-seed"),
  );
  const address = seed.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP test server address");
  }
  const port = address.port;
  await releaseServerScope(seed.scope);

  const acquisition = Effect.runFork(
    Effect.scoped(
      acquireHarnessMcpHttpServer({
        port,
        handler: makeHandler("harness-cancel-test"),
      }).pipe(Effect.zipRight(Effect.never)),
    ),
  );
  await Effect.runPromise(Fiber.interrupt(acquisition));

  const rebound = await acquireServerWithHandler(
    makeHandler("harness-cancel-rebind"),
    port,
  );
  expect(rebound.server.listening).toBe(true);
};

const closesHandlersWhenListenerBindFails = async () => {
  const occupied = await acquireServerWithHandler(
    makeHandler("harness-occupied-port"),
  );
  const address = occupied.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP test server address");
  }

  const harness = makeHandler("harness-bind-failure");
  const harnessClose = vi.spyOn(harness, "close");
  const acquisition = await Effect.runPromiseExit(
    Effect.scoped(
      acquireHarnessMcpHttpServer({
        port: address.port,
        handler: harness,
      }),
    ),
  );

  expect(Exit.isFailure(acquisition)).toBe(true);
  if (Exit.isFailure(acquisition)) {
    expect(Cause.squash(acquisition.cause)).toMatchObject({
      code: "EADDRINUSE",
    });
  }
  expect(harnessClose).toHaveBeenCalledOnce();
};

const closesActiveSubscriptionWhenScopeReleases = async () => {
  const running = await acquireServerWithHandler(
    makeHandler("harness-subscription-test"),
  );
  const client = await connectModernClient(
    new URL(HARNESS_MCP_PATH, running.baseUrl),
  );
  const subscription = await client.listen({ toolsListChanged: true });

  await releaseServerScope(running.scope);

  await expect(subscription.closed).resolves.toBe(GRACEFUL_SUBSCRIPTION_CLOSE);
  expect(running.server.listening).toBe(false);
};

const makeStatusHandler = (ownAgentId: AgentId, conversations: number) => () =>
  Effect.succeed({ agentId: ownAgentId, connected: true, conversations });

const unreachableRegister = () =>
  Effect.die(new Error("register is absent from the active catalog"));

const makeActivePhaseHandler = (tools: HarnessActiveTools) =>
  makeHarnessMcpHttpHandler({
    implementation: SERVER_IMPLEMENTATION,
    phase: () => ({ kind: "active", tools }),
    register: unreachableRegister,
    slotStatus: () => Effect.succeed({ connected: false, conversations: 0 }),
  });

const makeSubscriptionHarnessHandler = () => {
  const ownAgentId = agentId("550e8400-e29b-41d4-a716-446655440041");
  return makeActivePhaseHandler({
    ...makeReadPlaneHandlers(),
    reply: () => Effect.void,
    startConversation: makeStartConversationHandler(),
    status: makeStatusHandler(ownAgentId, 0),
  });
};

const makeListenPayload = (listenId: string): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: listenId,
    method: SUBSCRIPTIONS_LISTEN_METHOD,
    params: {
      notifications: { "xyz.moltzap/turnReady": true },
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: {
          name: "slow-reader-test",
          version: "1.0.0",
        },
        [CLIENT_CAPABILITIES_META_KEY]: {
          extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
        },
      },
    },
  });

interface PausedSubscriptionResponse {
  readonly agent: NodeHttpAgent;
  readonly body: () => string;
  readonly ended: Promise<undefined>;
  readonly response: IncomingMessage;
}

const openPausedSubscription = async (baseUrl: string, payload: string) => {
  const agent = new NodeHttpAgent({ keepAlive: true });
  let responseBody = "";
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = nodeRequest(
      new URL(HARNESS_MCP_PATH, baseUrl),
      {
        agent,
        headers: {
          "content-length": Buffer.byteLength(payload),
          "content-type": "application/json",
          "mcp-method": SUBSCRIPTIONS_LISTEN_METHOD,
          "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
        },
        method: POST_METHOD,
      },
      (incoming) => {
        incoming.pause();
        incoming.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf8");
        });
        resolve(incoming);
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
  const ended = new Promise<undefined>((resolve, reject) => {
    response.once("end", () => {
      resolve(undefined);
    });
    response.once("aborted", () => {
      reject(new Error("response aborted"));
    });
    response.once("error", reject);
  });
  return {
    agent,
    body: () => responseBody,
    ended,
    response,
  } satisfies PausedSubscriptionResponse;
};

const parseDataFrames = (responseBody: string): readonly unknown[] =>
  responseBody
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => {
      const parsed: unknown = JSON.parse(frame.slice("data: ".length));
      return parsed;
    });

const closesAfterSlowReaderObservesTerminalCompletion = async () => {
  const handler = makeSubscriptionHarnessHandler();
  const activeClose = vi.spyOn(handler, "close");
  const running = await acquireServerWithHandler(handler);
  const listenId = "slow-reader";
  const subscription = await openPausedSubscription(
    running.baseUrl,
    makeListenPayload(listenId),
  );

  const released = releaseServerScope(running.scope);
  await vi.waitFor(() => {
    expect(activeClose).toHaveBeenCalledOnce();
  });
  subscription.response.resume();
  await subscription.ended;
  await released;
  subscription.agent.destroy();

  const frames = parseDataFrames(subscription.body());
  expect(frames).toContainEqual({
    jsonrpc: "2.0",
    id: listenId,
    result: {
      resultType: "complete",
      _meta: {
        [SUBSCRIPTION_ID_META_KEY]: listenId,
        [SERVER_INFO_META_KEY]: SERVER_IMPLEMENTATION,
      },
    },
  });
  expect(running.server.listening).toBe(false);
};

const closesDespiteBackpressuredReader = async () => {
  const active = makeHarnessMcpSubscriptionHandler<{ readonly opaque: string }>(
    {
      delegate: makeHandler("harness-backpressure-test"),
      implementation: SERVER_IMPLEMENTATION,
    },
  );
  const running = await acquireServerWithHandler(active);
  const subscription = await openPausedSubscription(
    running.baseUrl,
    makeListenPayload("backpressured-reader"),
  );
  const ended = subscription.ended.catch(() => undefined);

  expect(
    active.publish({ opaque: "x".repeat(BACKPRESSURE_PAYLOAD_BYTES) }),
  ).toBe(true);
  await Effect.runPromise(Effect.sleep(BACKPRESSURE_WRITE_DELAY));

  openServerScopes.delete(running.scope);
  const closing = Effect.runFork(Scope.close(running.scope, Exit.void));
  const closedWithinDeadline = await Effect.runPromise(
    Fiber.join(closing).pipe(Effect.timeoutOption(BACKPRESSURE_CLOSE_DEADLINE)),
  );

  subscription.response.destroy();
  subscription.agent.destroy();
  await Effect.runPromise(Fiber.join(closing));
  await ended;

  expect(Option.isSome(closedWithinDeadline)).toBe(true);
  expect(running.server.listening).toBe(false);
};

const expectStartConversationInputSchema = (inputSchema: unknown) => {
  expect(inputSchema).toMatchObject({
    additionalProperties: false,
    properties: {
      otherAgentNames: {
        type: "array",
        minItems: 1,
        items: {
          type: "string",
          minLength: 3,
          maxLength: 32,
          pattern: "^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$",
        },
      },
      initialContent: { type: "string", minLength: 1 },
    },
    required: ["otherAgentNames", "initialContent"],
    type: "object",
  });
};

const expectActiveToolCatalog = async (harnessClient: Client) => {
  expect(harnessClient.getDiscoverResult()?.capabilities.extensions).toEqual({
    [HARNESS_EVENTS_EXTENSION]: {},
  });
  const tools = (await harnessClient.listTools()).tools;
  expect(tools.map((tool) => tool.name)).toEqual([
    "status",
    "search_agents",
    "search_conversations",
    "start_conversation",
    "read_conversation",
    "reply",
  ]);

  expect(
    tools.find(({ name }) => name === "search_agents")?.inputSchema,
  ).toMatchObject({
    additionalProperties: false,
    properties: {
      cursor: { type: "string" },
      query: { type: "string" },
    },
    type: "object",
  });
  expect(
    tools.find(({ name }) => name === "search_agents")?.inputSchema.properties,
  ).not.toHaveProperty("limit");
  expect(
    tools.find(({ name }) => name === "search_conversations")?.inputSchema
      .properties,
  ).not.toHaveProperty("count");
  expectStartConversationInputSchema(
    tools.find(({ name }) => name === "start_conversation")?.inputSchema,
  );
};

const expectStatusTool = async (harnessClient: Client, ownAgentId: string) => {
  const result = await harnessClient.callTool({
    name: "status",
    arguments: {},
  });
  const expected = { agentId: ownAgentId, connected: true, conversations: 3 };
  expect(result.structuredContent).toEqual(expected);
  expect(result.content).toEqual([
    { type: "text", text: JSON.stringify(expected) },
  ]);
};

const expectReadPlaneTools = async (
  harnessClient: Client,
  readPlane: ReadPlaneHandlers,
) => {
  await expect(
    harnessClient.callTool({
      name: "search_agents",
      arguments: { query: "" },
    }),
  ).resolves.toMatchObject({ structuredContent: { agents: [] } });
  expect(readPlane.searchAgents).toHaveBeenCalledWith({ query: "" });

  await expect(
    harnessClient.callTool({
      name: "search_conversations",
      arguments: { query: "peer" },
    }),
  ).resolves.toMatchObject({ structuredContent: { conversations: [] } });
  expect(readPlane.searchConversations).toHaveBeenCalledWith({ query: "peer" });

  const selectedConversationId = conversationId(
    "550e8400-e29b-41d4-a716-446655440042",
  );
  await expect(
    harnessClient.callTool({
      name: "read_conversation",
      arguments: { conversationId: selectedConversationId },
    }),
  ).resolves.toMatchObject({
    structuredContent: { messages: [], checkpoint: READ_CHECKPOINT },
  });
  expect(readPlane.readConversation).toHaveBeenCalledWith({
    conversationId: selectedConversationId,
  });
};

const expectStartConversationTool = async (
  harnessClient: Client,
  startConversation: StartConversationHandler,
) => {
  const input = {
    otherAgentNames: [START_OTHER_AGENT_NAME],
    initialContent: "Hello from the harness",
  };
  const result = await harnessClient.callTool({
    name: "start_conversation",
    arguments: input,
  });

  expect(startConversation).toHaveBeenCalledWith(input);
  expect(result.structuredContent).toEqual({
    conversation: START_CONVERSATION,
  });
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({ conversation: START_CONVERSATION }),
    },
  ]);
};

const exposesActiveTools = async () => {
  const ownAgentId = agentId("550e8400-e29b-41d4-a716-446655440040");
  const readPlane = makeReadPlaneHandlers();
  const startConversation = makeStartConversationHandler();
  const baseUrl = await makeServerWithHandler(
    makeActivePhaseHandler({
      ...readPlane,
      reply: () => Effect.void,
      startConversation,
      status: makeStatusHandler(ownAgentId, 3),
    }),
  );
  const harnessClient = await connectModernClient(
    new URL(HARNESS_MCP_PATH, baseUrl),
  );

  await expectActiveToolCatalog(harnessClient);
  await expectStatusTool(harnessClient, ownAgentId);
  await expectReadPlaneTools(harnessClient, readPlane);
  await expectStartConversationTool(harnessClient, startConversation);
};

const switchesCatalogWhenTheSlotActivates = async () => {
  const ownAgentId = agentId("550e8400-e29b-41d4-a716-446655440042");
  let activated = false;
  const tools: HarnessActiveTools = {
    ...makeReadPlaneHandlers(),
    reply: () => Effect.void,
    startConversation: makeStartConversationHandler(),
    status: makeStatusHandler(ownAgentId, 0),
  };
  const baseUrl = await makeServerWithHandler(
    makeHarnessMcpHttpHandler({
      implementation: SERVER_IMPLEMENTATION,
      phase: () =>
        activated ? { kind: "active", tools } : { kind: "slot" as const },
      register: () =>
        Effect.sync(() => {
          activated = true;
          return {
            agentId: ownAgentId,
            agentName: "slot-agent",
            serverUrl: "wss://example.test",
          };
        }),
      slotStatus: () => Effect.succeed({ connected: false, conversations: 0 }),
    }),
  );

  const slotClient = await connectModernClient(
    new URL(HARNESS_MCP_PATH, baseUrl),
  );
  expect((await slotClient.listTools()).tools.map(({ name }) => name)).toEqual([
    "register",
    "status",
  ]);
  // A slot with no identity still answers status; it reports holding nothing.
  expect(
    (await slotClient.callTool({ name: "status", arguments: {} }))
      .structuredContent,
  ).toEqual({ connected: false, conversations: 0 });

  await slotClient.callTool({ name: "register", arguments: {} });

  // Same client, same URL: the catalog follows slot state without a rebind.
  expect((await slotClient.listTools()).tools.map(({ name }) => name)).toEqual([
    "status",
    "search_agents",
    "search_conversations",
    "start_conversation",
    "read_conversation",
    "reply",
  ]);
};

// @agent-code-guard/regression-only: this finite matrix pins the single HTTP route and the official SDK's interoperability and guard behavior.
describe("scoped Harness MCP HTTP server", () => {
  it("serves modern discovery on the MCP path", servesModernDiscovery);
  it("allows only POST on the MCP path", rejectsUnsupportedMethods);
  it(
    "returns not found for paths outside the MCP surface",
    rejectsUnknownPaths,
  );
  it(
    "returns not found for the retired registration path",
    rejectsTheRetiredRegistrationPath,
  );
  it(
    "applies localhost Host and Origin guards before routing",
    appliesLocalhostGuards,
  );
  it("closes the loopback listener when its scope releases", () =>
    closesListenerWhenScopeReleases());
  it("closes the loopback listener when acquisition is interrupted", () =>
    closesListenerWhenAcquisitionIsInterrupted());
  it("closes MCP handlers when listener binding fails", () =>
    closesHandlersWhenListenerBindFails());
  it("closes an active MCP subscription when its scope releases", () =>
    closesActiveSubscriptionWhenScopeReleases());
  it("lets a slow reader observe terminal completion before prompt shutdown", () =>
    closesAfterSlowReaderObservesTerminalCompletion());
  it("bounds shutdown when an MCP reader stops draining its response", () =>
    closesDespiteBackpressuredReader());
  it("serves the active harness tools through one catalog", exposesActiveTools);
  it(
    "replaces the pre-active catalog after activation",
    switchesCatalogWhenTheSlotActivates,
  );
});

/* eslint-enable agent-code-guard/async-keyword -- Restore strict defaults after the Promise-native interoperability fixture. */
