/* eslint-disable agent-code-guard/async-keyword -- The official MCP SDK and Node loopback server expose Promise-native lifecycle APIs at this interoperability boundary. */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  createServer,
  request as nodeRequest,
  type Server as NodeServer,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarnessMcpRequestListener } from "./harness-mcp-server.js";

const LOCALHOST = "127.0.0.1";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const MODERN_PROTOCOL_ERA = "modern";
const REGISTER_MCP_PATH = "/register/mcp";
const HARNESS_MCP_PATH = "/mcp";
const POST_METHOD = "POST";
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const METHOD_NOT_ALLOWED_STATUS = 405;

const openServers = new Set<NodeServer>();
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

const listen = async (server: NodeServer) => {
  openServers.add(server);
  await new Promise<undefined>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, LOCALHOST, () => {
      server.off("error", onError);
      resolve(undefined);
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP test server address");
  }
  return address.port;
};

const makeServer = async (
  onRegistrationCreate?: () => void,
  onHarnessCreate?: () => void,
) => {
  const registrationCreate = onRegistrationCreate ?? noOp;
  const harnessCreate = onHarnessCreate ?? noOp;
  const registration = makeHandler("registration-test", registrationCreate);
  const harness = makeHandler("harness-test", harnessCreate);
  const server = createServer(
    makeHarnessMcpRequestListener(registration, harness),
  );
  const port = await listen(server);
  return `http://${LOCALHOST}:${port}`;
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

const requestStatus = (url: URL, headers: Readonly<Record<string, string>>) =>
  new Promise<number>((resolve, reject) => {
    const request = nodeRequest(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => {
        resolve(response.statusCode ?? 0);
      });
    });
    request.once("error", reject);
    request.end();
  });

afterEach(async () => {
  await Promise.all([...openClients].map((client) => client.close()));
  openClients.clear();
  await Promise.all([...openHandlers].map((handler) => handler.close()));
  openHandlers.clear();
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<undefined>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) {
              resolve(undefined);
            } else {
              reject(error);
            }
          });
        }),
    ),
  );
  openServers.clear();
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
      const response = await fetch(new URL(path, baseUrl), { method });
      expect(response.status).toBe(METHOD_NOT_ALLOWED_STATUS);
      expect(response.headers.get("allow")).toBe(POST_METHOD);
    }
  }
};

const rejectsUnknownPaths = async () => {
  const baseUrl = await makeServer();
  const postResponse = await fetch(new URL("/elsewhere", baseUrl), {
    method: POST_METHOD,
  });
  const getResponse = await fetch(new URL("/elsewhere", baseUrl));

  expect(postResponse.status).toBe(NOT_FOUND_STATUS);
  expect(getResponse.status).toBe(NOT_FOUND_STATUS);
};

const appliesLocalhostGuards = async () => {
  const baseUrl = await makeServer();
  const hostileHostStatus = await requestStatus(
    new URL("/elsewhere", baseUrl),
    { host: "example.com" },
  );
  const hostileOrigin = await fetch(new URL(HARNESS_MCP_PATH, baseUrl), {
    headers: { origin: "https://example.com" },
  });
  const localhostOrigin = await fetch(new URL(REGISTER_MCP_PATH, baseUrl), {
    headers: { origin: "http://localhost:4312" },
  });

  expect(hostileHostStatus).toBe(FORBIDDEN_STATUS);
  expect(hostileOrigin.status).toBe(FORBIDDEN_STATUS);
  expect(localhostOrigin.status).toBe(METHOD_NOT_ALLOWED_STATUS);
};

// @agent-code-guard/regression-only: this finite matrix pins the two HTTP routes and the official SDK's interoperability and guard behavior.
describe("makeHarnessMcpRequestListener", () => {
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
});

/* eslint-enable agent-code-guard/async-keyword -- Restore strict defaults after the Promise-native interoperability fixture. */
