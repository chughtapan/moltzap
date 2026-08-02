import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { live as it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import { expect } from "vitest";
import { withTestServiceConfig } from "../../../config.test-utils.js";
import { getMoltZapAgentServiceSocketPath } from "../../../local-paths.js";
import { acquireMoltzapd } from "../../../moltzapd.js";
import * as H from "../../support/index.js";

const PROFILE_NAME = "moltzapd-integration";
const MCP_PATH = "/mcp";
const LOOPBACK_HOST = "127.0.0.1";
const MODERN_PROTOCOL_VERSION = "2026-07-28";

type RegisteredAgent = Effect.Effect.Success<
  ReturnType<typeof H.registerAgent>
>;
type MoltzapdServer = Effect.Effect.Success<ReturnType<typeof acquireMoltzapd>>;

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const harnessUrl = (server: MoltzapdServer): URL => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP moltzapd address");
  }
  return new URL(MCP_PATH, `http://${LOOPBACK_HOST}:${address.port}`);
};

const acquireMcpClient = (
  url: URL,
): Effect.Effect<Client, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new Client(
        { name: "moltzapd-integration", version: "1.0.0" },
        {
          versionNegotiation: {
            mode: { pin: MODERN_PROTOCOL_VERSION },
          },
        },
      );
      yield* Effect.tryPromise({
        try: () => client.connect(new StreamableHTTPClientTransport(url)),
        catch: toError,
      });
      return client;
    }),
    (client) =>
      Effect.tryPromise({ try: () => client.close(), catch: toError }).pipe(
        Effect.ignore,
      ),
  );

const runScopedDaemon = Effect.gen(function* () {
  const server = yield* acquireMoltzapd({
    profileName: PROFILE_NAME,
    port: 0,
  });
  const client = yield* acquireMcpClient(harnessUrl(server));
  const result = yield* Effect.tryPromise({
    try: () => client.callTool({ name: "status", arguments: {} }),
    catch: toError,
  });
  expect(server.listening).toBe(true);
  return { result, server };
});

function runRegisteredAgent(registered: RegisteredAgent) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const socketPath = getMoltZapAgentServiceSocketPath(registered.agentId);
    expect(yield* fileSystem.exists(socketPath)).toBe(false);

    const running = yield* Effect.scoped(runScopedDaemon);

    expect(running.result.structuredContent).toEqual({
      agentId: registered.agentId,
      connected: true,
      conversations: 0,
    });
    expect(running.server.listening).toBe(false);
    expect(yield* fileSystem.exists(socketPath)).toBe(false);
  }).pipe(Effect.provide(NodeContext.layer));
}

function runWithProfile(registered: RegisteredAgent) {
  return withTestServiceConfig(
    {
      profileName: PROFILE_NAME,
      agentName: PROFILE_NAME,
      agentId: registered.agentId,
      agentKey: registered.apiKey,
      serverUrl: H.coreBaseUrl(),
    },
    runRegisteredAgent(registered),
  );
}

H.setupServiceIntegration();

it("owns one agent connection and MCP listener without a Unix socket", () => {
  expect.hasAssertions();
  return Effect.acquireUseRelease(
    H.registerAgent("moltzapd-owner"),
    runWithProfile,
    (registered) => registered.client.close().pipe(Effect.ignore),
  );
});
