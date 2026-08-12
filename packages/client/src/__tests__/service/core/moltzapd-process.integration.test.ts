import { HttpClient } from "@effect/platform";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { live as it } from "@effect/vitest";
import { spawn, type ChildProcess } from "node:child_process";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- A passive test listener selects an unused fixed port before the child process binds it.
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Duration, Effect, Schema, type Scope } from "effect";
import { expect } from "vitest";
import packageJson from "../../../../package.json" with { type: "json" };
import { withTestServiceConfig } from "../../../config.test-utils.js";
import * as H from "../../support/index.js";

const PROFILE_NAME = "moltzapd-process-integration";
const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const POLL_INTERVAL = Duration.millis(25);
const STARTUP_TIMEOUT = Duration.seconds(15);
const SHUTDOWN_TIMEOUT = Duration.seconds(5);
const healthSchema = Schema.Struct({ connections: Schema.Number });
const packageRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const daemonEntry = join(packageRoot, packageJson.bin.moltzapd);

type RegisteredAgent = Effect.Effect.Success<
  ReturnType<typeof H.registerAgent>
>;

interface RunningDaemon {
  readonly child: ChildProcess;
  readonly logs: () => string;
}

class ProcessTestError extends Data.TaggedError("ProcessTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const processTestError = (message: string, cause?: unknown): ProcessTestError =>
  new ProcessTestError({ message, cause });

const toError = (cause: unknown): ProcessTestError => {
  if (cause instanceof ProcessTestError) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return processTestError(message, cause);
};

const reservePort = Effect.async<number, ProcessTestError>((resume) => {
  const server = createServer();
  const onError = (cause: Error): void => {
    resume(Effect.fail(toError(cause)));
  };
  server.once("error", onError);
  server.listen(0, LOOPBACK_HOST, () => {
    server.off("error", onError);
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      resume(
        Effect.fail(processTestError("reserved listener exposed no TCP port")),
      );
      return;
    }
    server.close((cause) => {
      resume(
        cause === undefined
          ? Effect.succeed(address.port)
          : Effect.fail(toError(cause)),
      );
    });
  });
  return Effect.sync(() => {
    server.off("error", onError);
    if (server.listening) {
      server.close();
    }
  });
});

const startDaemon = (): RunningDaemon => {
  let output = "";
  const child = spawn(
    process.execPath,
    [daemonEntry, "--profile", PROFILE_NAME],
    {
      cwd: packageRoot,
      // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The isolated child must inherit the test-scoped profile and server configuration.
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const append = (chunk: Uint8Array): void => {
    output += new TextDecoder().decode(chunk);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return { child, logs: () => output };
};

const waitForExit = (running: RunningDaemon): Effect.Effect<undefined> => {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    return Effect.succeed(undefined);
  }
  return Effect.async<undefined>((resume) => {
    const onExit = (): void => {
      resume(Effect.succeed(undefined));
    };
    running.child.once("exit", onExit);
    return Effect.sync(() => {
      running.child.off("exit", onExit);
    });
  });
};

const stopDaemon = (running: RunningDaemon): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      return false;
    }
    running.child.kill("SIGTERM");
    const stopped = yield* Effect.raceFirst(
      waitForExit(running).pipe(Effect.as(true)),
      Effect.sleep(SHUTDOWN_TIMEOUT).pipe(Effect.as(false)),
    );
    if (stopped) {
      return false;
    }
    running.child.kill("SIGKILL");
    yield* waitForExit(running);
    return true;
  });

const acquireDaemon = (): Effect.Effect<RunningDaemon, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => startDaemon()),
    (running) => stopDaemon(running).pipe(Effect.ignore),
  );

const connectMcpOnce = (url: URL): Effect.Effect<Client, ProcessTestError> =>
  Effect.tryPromise({
    // eslint-disable-next-line agent-code-guard/async-keyword -- The official MCP SDK exposes a Promise-native client lifecycle.
    try: async () => {
      const client = new Client(
        { name: "moltzapd-process-integration", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
      );
      try {
        await client.connect(new StreamableHTTPClientTransport(url));
        return client;
      } catch (cause) {
        await client.close().catch(() => undefined);
        throw cause;
      }
    },
    catch: toError,
  });

const waitForMcpClient = (
  url: URL,
  running: RunningDaemon,
): Effect.Effect<Client, ProcessTestError> => {
  const poll: Effect.Effect<Client, ProcessTestError> = Effect.suspend(() => {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      return Effect.fail(
        processTestError(`moltzapd exited before readiness\n${running.logs()}`),
      );
    }
    return connectMcpOnce(url).pipe(
      Effect.catchAll(() =>
        Effect.sleep(POLL_INTERVAL).pipe(Effect.zipRight(poll)),
      ),
    );
  });
  return poll.pipe(
    Effect.timeoutFail({
      duration: STARTUP_TIMEOUT,
      onTimeout: () =>
        processTestError(`moltzapd did not expose MCP\n${running.logs()}`),
    }),
  );
};

const acquireMcpClient = (
  url: URL,
  running: RunningDaemon,
): Effect.Effect<Client, ProcessTestError, Scope.Scope> =>
  Effect.acquireRelease(waitForMcpClient(url, running), (client) =>
    Effect.tryPromise({ try: () => client.close(), catch: toError }).pipe(
      Effect.ignore,
    ),
  );

const callStatus = (client: Client) =>
  Effect.tryPromise({
    try: () => client.callTool({ name: "status", arguments: {} }),
    catch: toError,
  });

const isConnectedStatus = (content: unknown): boolean => {
  if (typeof content !== "object" || content === null) {
    return false;
  }
  return "connected" in content && content.connected === true;
};

const waitForConnectedStatus = (
  client: Client,
  running: RunningDaemon,
): Effect.Effect<Awaited<ReturnType<Client["callTool"]>>, ProcessTestError> => {
  const poll: Effect.Effect<
    Awaited<ReturnType<Client["callTool"]>>,
    ProcessTestError
  > = callStatus(client).pipe(
    Effect.flatMap((status) => {
      return isConnectedStatus(status.structuredContent)
        ? Effect.succeed(status)
        : Effect.sleep(POLL_INTERVAL).pipe(Effect.zipRight(poll));
    }),
  );
  return poll.pipe(
    Effect.timeoutFail({
      duration: STARTUP_TIMEOUT,
      onTimeout: () =>
        processTestError(`moltzapd did not connect\n${running.logs()}`),
    }),
  );
};

const healthConnections = (): Effect.Effect<number, unknown> =>
  HttpClient.get(new URL("/health", H.coreBaseUrl())).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknown(healthSchema)),
    Effect.map((health) => health.connections),
    Effect.provide(NodeHttpClient.layer),
  );

const waitForConnectionCount = (
  expected: number,
): Effect.Effect<void, ProcessTestError> => {
  const poll: Effect.Effect<void, ProcessTestError> = healthConnections().pipe(
    Effect.mapError(toError),
    Effect.flatMap((actual) =>
      actual === expected
        ? Effect.void
        : Effect.sleep(POLL_INTERVAL).pipe(Effect.zipRight(poll)),
    ),
  );
  return poll.pipe(
    Effect.timeoutFail({
      duration: STARTUP_TIMEOUT,
      onTimeout: () =>
        processTestError(
          `server connection count did not reach ${String(expected)}`,
        ),
    }),
  );
};

const runDaemonProcess = (owner: RegisteredAgent, mcpPort: number) =>
  withTestServiceConfig(
    {
      profileName: PROFILE_NAME,
      agentName: PROFILE_NAME,
      agentId: owner.agentId,
      agentKey: owner.apiKey,
      serverUrl: H.coreBaseUrl(),
      mcpPort,
    },
    Effect.scoped(
      Effect.gen(function* () {
        const url = new URL(
          MCP_PATH,
          `http://${LOOPBACK_HOST}:${String(mcpPort)}`,
        );

        expect(yield* healthConnections()).toBe(0);

        const running = yield* acquireDaemon();
        const status = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* acquireMcpClient(url, running);
            return yield* waitForConnectedStatus(client, running);
          }),
        );

        expect(status.structuredContent).toEqual({
          agentId: owner.agentId,
          connected: true,
          conversations: 0,
        });
        yield* waitForConnectionCount(1);

        const requiredKill = yield* stopDaemon(running);
        expect(requiredKill).toBe(false);
        yield* waitForConnectionCount(0);
      }).pipe(Effect.provide(NodeContext.layer)),
    ),
  );

H.setupServiceIntegration();

it("runs the package daemon through loopback MCP without a Unix socket", () => {
  expect.hasAssertions();
  return Effect.acquireUseRelease(
    H.registerAgent("moltzapd-process-owner"),
    (owner) =>
      Effect.scoped(reservePort).pipe(
        Effect.flatMap((mcpPort) => runDaemonProcess(owner, mcpPort)),
      ),
    (owner) => owner.client.close().pipe(Effect.ignore),
  );
});
