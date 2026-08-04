import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { spawn, type ChildProcess } from "node:child_process";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- A passive test listener selects an unused fixed port before the packaged daemon binds it.
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Duration, Effect, type Scope } from "effect";
import packageJson from "../../../package.json" with { type: "json" };
import { parseProfileName, resolveProfileRecord } from "../../profile.js";

const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const POLL_INTERVAL = Duration.millis(25);
const STARTUP_TIMEOUT = Duration.seconds(15);
const SHUTDOWN_TIMEOUT = Duration.seconds(5);
const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const daemonEntry = join(packageRoot, packageJson.bin.moltzapd);

interface RunningDaemon {
  readonly child: ChildProcess;
  readonly logs: () => string;
}

class PackagedMoltzapdTestError extends Data.TaggedError(
  "PackagedMoltzapdTestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Explicit endpoint for a packaged daemon owned by the enclosing test scope. */
export interface PackagedMoltzapd {
  readonly mcpUrl: string;
  readonly logs: () => string;
}

/** Inputs for starting the packaged daemon against caller-scoped test config. */
export interface PackagedMoltzapdOptions {
  readonly profileName: string;
}

const packagedMoltzapdTestError = (
  message: string,
  cause?: unknown,
): PackagedMoltzapdTestError =>
  new PackagedMoltzapdTestError({ message, cause });

const toError = (cause: unknown): PackagedMoltzapdTestError => {
  if (cause instanceof PackagedMoltzapdTestError) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return packagedMoltzapdTestError(message, cause);
};

/**
 * Reserve a free loopback port for a test slot.
 *
 * The daemon binds exactly the port its slot names and never selects one, so a
 * test that spawns a daemon reserves the port here and writes it into the slot
 * before starting the child.
 */
export const reserveTestMcpPort = Effect.async<
  number,
  PackagedMoltzapdTestError
>((resume) => {
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
        Effect.fail(
          packagedMoltzapdTestError("reserved listener exposed no TCP port"),
        ),
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

const startDaemon = (profileName: string): RunningDaemon => {
  let output = "";
  const child = spawn(
    process.execPath,
    [daemonEntry, "--profile", profileName],
    {
      cwd: packageRoot,
      // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The isolated child inherits the caller-scoped test profile and server URL.
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

const stopDaemon = (running: RunningDaemon): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      return;
    }
    running.child.kill("SIGTERM");
    const stopped = yield* Effect.raceFirst(
      waitForExit(running).pipe(Effect.as(true)),
      Effect.sleep(SHUTDOWN_TIMEOUT).pipe(Effect.as(false)),
    );
    if (stopped) {
      return;
    }
    running.child.kill("SIGKILL");
    yield* waitForExit(running);
  });

const acquireDaemon = (
  profileName: string,
): Effect.Effect<RunningDaemon, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => startDaemon(profileName)),
    (running) => stopDaemon(running),
  );

const connectMcpOnce = (
  url: URL,
): Effect.Effect<Client, PackagedMoltzapdTestError> =>
  Effect.tryPromise({
    // eslint-disable-next-line agent-code-guard/async-keyword -- The official MCP SDK exposes a Promise-native client lifecycle.
    try: async () => {
      const client = new Client(
        { name: "packaged-moltzapd-test", version: "1.0.0" },
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
): Effect.Effect<Client, PackagedMoltzapdTestError> => {
  const poll: Effect.Effect<Client, PackagedMoltzapdTestError> = Effect.suspend(
    () => {
      if (
        running.child.exitCode !== null ||
        running.child.signalCode !== null
      ) {
        return Effect.fail(
          packagedMoltzapdTestError(
            `moltzapd exited before readiness\n${running.logs()}`,
          ),
        );
      }
      return connectMcpOnce(url).pipe(
        Effect.catchAll(() =>
          Effect.sleep(POLL_INTERVAL).pipe(Effect.zipRight(poll)),
        ),
      );
    },
  );
  return poll.pipe(
    Effect.timeoutFail({
      duration: STARTUP_TIMEOUT,
      onTimeout: () =>
        packagedMoltzapdTestError(
          `moltzapd did not expose MCP\n${running.logs()}`,
        ),
    }),
  );
};

const callStatus = (client: Client) =>
  Effect.tryPromise({
    try: () => client.callTool({ name: "status", arguments: {} }),
    catch: toError,
  });

const isConnectedStatus = (content: unknown): boolean =>
  typeof content === "object" &&
  content !== null &&
  "connected" in content &&
  content.connected === true;

const waitForConnectedStatus = (
  client: Client,
  running: RunningDaemon,
): Effect.Effect<void, PackagedMoltzapdTestError> => {
  const poll: Effect.Effect<void, PackagedMoltzapdTestError> = callStatus(
    client,
  ).pipe(
    Effect.flatMap((status) =>
      isConnectedStatus(status.structuredContent)
        ? Effect.void
        : Effect.sleep(POLL_INTERVAL).pipe(Effect.zipRight(poll)),
    ),
  );
  return poll.pipe(
    Effect.timeoutFail({
      duration: STARTUP_TIMEOUT,
      onTimeout: () =>
        packagedMoltzapdTestError(
          `moltzapd did not connect\n${running.logs()}`,
        ),
    }),
  );
};

const closeMcpClient = (client: Client): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => client.close(), catch: toError }).pipe(
    Effect.ignore,
  );

/**
 * Starts the package's real `moltzapd` binary against an existing slot.
 * The slot carries the loopback port, so the child receives only its profile
 * name and the returned URL is derived from the same persisted value.
 *
 * @param options Existing profile name for the child process.
 * @returns A scoped packaged daemon after its MCP status reports connected.
 */
export const acquirePackagedMoltzapd = (
  options: PackagedMoltzapdOptions,
): Effect.Effect<PackagedMoltzapd, PackagedMoltzapdTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const name = yield* parseProfileName(options.profileName).pipe(
      Effect.mapError(toError),
    );
    const record = yield* resolveProfileRecord(name).pipe(
      Effect.mapError(toError),
    );
    const running = yield* acquireDaemon(options.profileName);
    const url = new URL(
      MCP_PATH,
      `http://${LOOPBACK_HOST}:${String(record.mcpPort)}`,
    );
    yield* Effect.scoped(
      Effect.acquireRelease(
        waitForMcpClient(url, running),
        closeMcpClient,
      ).pipe(
        Effect.flatMap((client) => waitForConnectedStatus(client, running)),
      ),
    );
    return { mcpUrl: url.href, logs: running.logs };
  }).pipe(Effect.withSpan("acquirePackagedMoltzapd"));
