/* eslint-disable agent-code-guard/async-keyword -- The official MCP SDK and Node loopback server expose Promise-native lifecycle APIs at this interoperability boundary. */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  McpServer,
  type Implementation,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- These loopback contract tests require raw Host headers and connection-refusal assertions that the Effect client does not expose.
import { request as nodeRequest } from "node:http";
import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentId } from "@moltzap/protocol/testing";
import { makeHarnessMcpHttpHandlers } from "./harness-mcp-wire.js";
import { localDaemonCommands } from "./local-daemon-rpc.js";
import { makeLocalDaemonHandlers } from "./service-local-daemon.js";
import { acquireHarnessMcpHttpServer } from "./harness-mcp-server.js";

const LOCALHOST = "127.0.0.1";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const MODERN_PROTOCOL_ERA = "modern";
const REGISTER_MCP_PATH = "/register/mcp";
const HARNESS_MCP_PATH = "/mcp";
const POST_METHOD = "POST";
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const METHOD_NOT_ALLOWED_STATUS = 405;
const GRACEFUL_SUBSCRIPTION_CLOSE = "graceful";
const SERVER_IMPLEMENTATION = {
  name: "harness-boundary-test",
  version: "1.0.0",
} satisfies Implementation;

const openServerScopes = new Set<Scope.CloseableScope>();
const openHandlers = new Set<McpHttpHandler>();
const openClients = new Set<Client>();
const noOp = (): undefined => undefined;

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

const acquireServerWithHandlers = async (
  registration: McpHttpHandler,
  harness: McpHttpHandler,
  port = 0,
) => {
  openHandlers.add(registration);
  openHandlers.add(harness);
  const scope = Effect.runSync(Scope.make());
  const server = await Effect.runPromise(
    acquireHarnessMcpHttpServer({
      port,
      registrationHandler: registration,
      harnessHandler: harness,
    }).pipe(Scope.extend(scope)),
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

const makeServerWithHandlers = async (
  registration: McpHttpHandler,
  harness: McpHttpHandler,
) => (await acquireServerWithHandlers(registration, harness)).baseUrl;

const makeServer = async (
  onRegistrationCreate?: () => void,
  onHarnessCreate?: () => void,
) => {
  const registrationCreate = onRegistrationCreate ?? noOp;
  const harnessCreate = onHarnessCreate ?? noOp;
  const registration = makeHandler("registration-test", registrationCreate);
  const harness = makeHandler("harness-test", harnessCreate);
  return await makeServerWithHandlers(registration, harness);
};

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
  let registrationCreates = 0;
  let harnessCreates = 0;
  const baseUrl = await makeServer(
    () => {
      registrationCreates += 1;
    },
    () => {
      harnessCreates += 1;
    },
  );

  const registrationClient = await connectModernClient(
    new URL(REGISTER_MCP_PATH, baseUrl),
  );
  const harnessClient = await connectModernClient(
    new URL(HARNESS_MCP_PATH, baseUrl),
  );

  expect(registrationClient.getProtocolEra()).toBe(MODERN_PROTOCOL_ERA);
  expect(registrationClient.getDiscoverResult()).toBeDefined();
  expect(harnessClient.getProtocolEra()).toBe(MODERN_PROTOCOL_ERA);
  expect(harnessClient.getDiscoverResult()).toBeDefined();
  expect(registrationCreates).toBeGreaterThan(0);
  expect(harnessCreates).toBeGreaterThan(0);
};

const rejectsUnsupportedMethods = async () => {
  const baseUrl = await makeServer();

  for (const path of [REGISTER_MCP_PATH, HARNESS_MCP_PATH]) {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await requestLoopback(new URL(path, baseUrl), method);
      expect(response.status).toBe(METHOD_NOT_ALLOWED_STATUS);
      expect(response.allow).toBe(POST_METHOD);
    }
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
    new URL(REGISTER_MCP_PATH, baseUrl),
    "GET",
    { origin: "http://localhost:4312" },
  );

  expect(hostileHost.status).toBe(FORBIDDEN_STATUS);
  expect(hostileOrigin.status).toBe(FORBIDDEN_STATUS);
  expect(localhostOrigin.status).toBe(METHOD_NOT_ALLOWED_STATUS);
};

const closesListenerWhenScopeReleases = async () => {
  const running = await acquireServerWithHandlers(
    makeHandler("registration-scope-test"),
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
  const seed = await acquireServerWithHandlers(
    makeHandler("registration-cancel-port-seed"),
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
        registrationHandler: makeHandler("registration-cancel-test"),
        harnessHandler: makeHandler("harness-cancel-test"),
      }).pipe(Effect.zipRight(Effect.never)),
    ),
  );
  await Effect.runPromise(Fiber.interrupt(acquisition));

  const rebound = await acquireServerWithHandlers(
    makeHandler("registration-cancel-rebind"),
    makeHandler("harness-cancel-rebind"),
    port,
  );
  expect(rebound.server.listening).toBe(true);
};

const closesHandlersWhenListenerBindFails = async () => {
  const occupied = await acquireServerWithHandlers(
    makeHandler("registration-occupied-port"),
    makeHandler("harness-occupied-port"),
  );
  const address = occupied.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP test server address");
  }

  const registration = makeHandler("registration-bind-failure");
  const harness = makeHandler("harness-bind-failure");
  const registrationClose = vi.spyOn(registration, "close");
  const harnessClose = vi.spyOn(harness, "close");
  const acquisition = await Effect.runPromiseExit(
    Effect.scoped(
      acquireHarnessMcpHttpServer({
        port: address.port,
        registrationHandler: registration,
        harnessHandler: harness,
      }),
    ),
  );

  expect(Exit.isFailure(acquisition)).toBe(true);
  if (Exit.isFailure(acquisition)) {
    expect(Cause.squash(acquisition.cause)).toMatchObject({
      code: "EADDRINUSE",
    });
  }
  expect(registrationClose).toHaveBeenCalledOnce();
  expect(harnessClose).toHaveBeenCalledOnce();
};

const closesActiveSubscriptionWhenScopeReleases = async () => {
  const running = await acquireServerWithHandlers(
    makeHandler("registration-subscription-test"),
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

const exposesOnlyExistingStatusBehavior = async () => {
  const ownAgentId = agentId("550e8400-e29b-41d4-a716-446655440040");
  const localHandlers = makeLocalDaemonHandlers({
    ownAgentId,
    connected: () => true,
    conversationCount: () => 3,
    call: () => {
      throw new Error("status must not call an agent RPC");
    },
    handleHistoryRequest: () => {
      throw new Error("status must not read local history");
    },
  });
  const handlers = makeHarnessMcpHttpHandlers({
    implementation: SERVER_IMPLEMENTATION,
    status: localHandlers[localDaemonCommands.status],
  });
  const baseUrl = await makeServerWithHandlers(
    handlers.registration,
    handlers.active,
  );
  const registrationClient = await connectModernClient(
    new URL(REGISTER_MCP_PATH, baseUrl),
  );
  const harnessClient = await connectModernClient(
    new URL(HARNESS_MCP_PATH, baseUrl),
  );

  expect((await registrationClient.listTools()).tools).toEqual([]);
  expect(
    (await harnessClient.listTools()).tools.map((tool) => tool.name),
  ).toEqual(["status"]);

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

// @agent-code-guard/regression-only: this finite matrix pins the two HTTP routes and the official SDK's interoperability and guard behavior.
describe("scoped Harness MCP HTTP server", () => {
  it("serves modern discovery on both MCP paths", servesModernDiscovery);
  it("allows only POST on known MCP paths", rejectsUnsupportedMethods);
  it(
    "returns not found for paths outside the two MCP surfaces",
    rejectsUnknownPaths,
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
  it(
    "serves only the existing status behavior through the active catalog",
    exposesOnlyExistingStatusBehavior,
  );
});

/* eslint-enable agent-code-guard/async-keyword -- Restore strict defaults after the Promise-native interoperability fixture. */
