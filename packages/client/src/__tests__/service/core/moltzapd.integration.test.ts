import { FileSystem, HttpClient } from "@effect/platform";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { live as it } from "@effect/vitest";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- This integration test needs a passive TCP port blocker to force the package-private Node listener's real bind-failure path.
import { createServer, type Server as NodeHttpServer } from "node:http";
import { Cause, Data, Effect, Exit, Schema, Scope } from "effect";
import { expect } from "vitest";
import { withTestServiceConfig } from "../../../config.test-utils.js";
import { getMoltZapAgentServiceSocketPath } from "../../../local-paths.js";
import { acquireMoltzapd } from "../../../moltzapd.js";
import * as H from "../../support/index.js";

const PROFILE_NAME = "moltzapd-integration";
const MCP_PATH = "/mcp";
const LOOPBACK_HOST = "127.0.0.1";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const healthSchema = Schema.Struct({ connections: Schema.Number });

type RegisteredAgent = Effect.Effect.Success<
  ReturnType<typeof H.registerAgent>
>;
type MoltzapdServer = Effect.Effect.Success<ReturnType<typeof acquireMoltzapd>>;

interface PortBlocker {
  readonly port: number;
  readonly server: NodeHttpServer;
}

class PortBlockerError extends Data.TaggedError("PortBlockerError")<{
  readonly cause: unknown;
}> {}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const healthConnections = (): Effect.Effect<number, unknown> =>
  HttpClient.get(new URL("/health", H.coreBaseUrl())).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknown(healthSchema)),
    Effect.map((health) => health.connections),
    Effect.provide(NodeHttpClient.layer),
  );

const listenPortBlocker: Effect.Effect<PortBlocker, PortBlockerError> =
  Effect.async((resume) => {
    const server = createServer();
    const onError = (error: Error): void => {
      resume(Effect.fail(new PortBlockerError({ cause: error })));
    };
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        resume(
          Effect.fail(
            new PortBlockerError({
              cause: new Error("expected a TCP blocker address"),
            }),
          ),
        );
        return;
      }
      resume(Effect.succeed({ port: address.port, server }));
    });
    return Effect.sync(() => {
      server.off("error", onError);
      if (server.listening) {
        server.close();
      }
    });
  });

const closePortBlocker = (blocker: PortBlocker): Effect.Effect<void, Error> =>
  Effect.async((resume) => {
    if (!blocker.server.listening) {
      resume(Effect.void);
      return;
    }
    blocker.server.close((error) => {
      resume(error === undefined ? Effect.void : Effect.fail(error));
    });
  });

const acquirePortBlocker: Effect.Effect<
  PortBlocker,
  PortBlockerError,
  Scope.Scope
> = Effect.acquireRelease(listenPortBlocker, (blocker) =>
  closePortBlocker(blocker).pipe(Effect.ignore),
);

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

const runScopedDaemon = (socketPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
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
    expect(yield* fileSystem.exists(socketPath)).toBe(false);
    expect(yield* healthConnections()).toBe(1);
    return { result, server };
  });

function runRegisteredAgent(registered: RegisteredAgent) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const socketPath = getMoltZapAgentServiceSocketPath(registered.agentId);
    expect(yield* fileSystem.exists(socketPath)).toBe(false);

    const running = yield* Effect.scoped(runScopedDaemon(socketPath));

    expect(running.result.structuredContent).toEqual({
      agentId: registered.agentId,
      connected: true,
      conversations: 0,
    });
    expect(running.server.listening).toBe(false);
    expect(yield* fileSystem.exists(socketPath)).toBe(false);
    expect(yield* healthConnections()).toBe(0);
  }).pipe(Effect.provide(NodeContext.layer));
}

const runFailedAcquisition = Effect.gen(function* () {
  const blocker = yield* acquirePortBlocker;
  const ambientScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

  expect(yield* healthConnections()).toBe(0);
  const attempted = yield* Effect.exit(
    acquireMoltzapd({
      profileName: PROFILE_NAME,
      port: blocker.port,
    }).pipe(Scope.extend(ambientScope)),
  );

  expect(Exit.isFailure(attempted)).toBe(true);
  if (Exit.isFailure(attempted)) {
    expect(Cause.squash(attempted.cause)).toMatchObject({
      code: "EADDRINUSE",
    });
  }
  expect(yield* healthConnections()).toBe(0);
});

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

function runFailedAcquisitionWithProfile(registered: RegisteredAgent) {
  return withTestServiceConfig(
    {
      profileName: PROFILE_NAME,
      agentName: PROFILE_NAME,
      agentId: registered.agentId,
      agentKey: registered.apiKey,
      serverUrl: H.coreBaseUrl(),
    },
    Effect.scoped(runFailedAcquisition),
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

it("rolls back the agent connection when MCP listener acquisition fails", () => {
  expect.hasAssertions();
  return Effect.acquireUseRelease(
    H.registerAgent("moltzapd-rollback"),
    runFailedAcquisitionWithProfile,
    (registered) => registered.client.close().pipe(Effect.ignore),
  );
});
