import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeContext } from "@effect/platform-node";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Data, Duration, Effect, Layer, type Scope } from "effect";
import packageJson from "../package.json" with { type: "json" };
import {
  acquireHarnessClient,
  type HarnessClientService,
} from "./harness-client.js";
import { getMoltZapConfigDir } from "./local-paths.js";
import { parseProfileName, resolveProfileRecord } from "./profile.js";

const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const POLL_INTERVAL = Duration.millis(25);
const STARTUP_TIMEOUT = Duration.seconds(15);
const SHUTDOWN_TIMEOUT = Duration.seconds(5);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const daemonEntry = join(packageRoot, packageJson.bin.moltzapd);

interface RunningDaemon {
  readonly child: ChildProcess;
  readonly logs: () => string;
}

class MoltzapdChildError extends Data.TaggedError("MoltzapdChildError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Explicit endpoint for a packaged daemon owned by the enclosing test scope. */
export interface MoltzapdChild {
  readonly mcpUrl: string;
  readonly logs: () => string;
}

/** Inputs for starting the packaged daemon against caller-scoped test config. */
export interface MoltzapdChildOptions {
  readonly profileName: string;
}

const moltzapdChildError = (
  message: string,
  cause?: unknown,
): MoltzapdChildError => new MoltzapdChildError({ message, cause });

const toError = (cause: unknown): MoltzapdChildError => {
  if (cause instanceof MoltzapdChildError) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return moltzapdChildError(message, cause);
};

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

const closeMcpClient = (client: Client): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => client.close(), catch: toError }).pipe(
    Effect.ignore,
  );

const connectMcpOnce = (url: URL): Effect.Effect<Client, MoltzapdChildError> =>
  Effect.gen(function* () {
    const client = new Client(
      { name: "moltzapd-child", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    );
    // A client that fails to connect still holds a transport, so the failure
    // path closes it before surfacing the cause.
    yield* Effect.tryPromise({
      try: () => client.connect(new StreamableHTTPClientTransport(url)),
      catch: toError,
    }).pipe(Effect.tapError(() => closeMcpClient(client)));
    return client;
  });

const waitForMcpClient = (
  url: URL,
  running: RunningDaemon,
): Effect.Effect<Client, MoltzapdChildError> => {
  const poll: Effect.Effect<Client, MoltzapdChildError> = Effect.suspend(() => {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      return Effect.fail(
        moltzapdChildError(
          `moltzapd exited before readiness\n${running.logs()}`,
        ),
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
        moltzapdChildError(`moltzapd did not expose MCP\n${running.logs()}`),
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
): Effect.Effect<void, MoltzapdChildError> => {
  const poll: Effect.Effect<void, MoltzapdChildError> = callStatus(client).pipe(
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
        moltzapdChildError(`moltzapd did not connect\n${running.logs()}`),
    }),
  );
};

/**
 * Starts the package's real `moltzapd` binary against an existing slot.
 * The slot carries the loopback port, so the child receives only its profile
 * name and the returned URL is derived from the same persisted value.
 *
 * @param options Existing profile name for the child process.
 * @returns A scoped packaged daemon after its MCP status reports connected.
 */
export const acquireMoltzapdChild = (
  options: MoltzapdChildOptions,
): Effect.Effect<MoltzapdChild, MoltzapdChildError, Scope.Scope> =>
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
  }).pipe(Effect.withSpan("acquireMoltzapdChild"));

/**
 * Acquire the adapter-facing client for one named profile slot.
 *
 * This is the whole production composition: the slot's own daemon child, the
 * loopback endpoint derived from the slot, and a file-backed checkpoint store.
 * A caller supplies only the profile name — no URL, no port, no store.
 *
 * The checkpoint directory is keyed by profile name rather than AgentId,
 * because the store must be provided before `acquireHarnessClient` reads the
 * identity from the daemon's status tool. One slot is exactly one AgentId, so
 * the profile name is a stable agent scope.
 *
 * @param profileName Existing slot owning the daemon and its checkpoints.
 * @returns The scoped adapter-facing service value.
 */
export const harnessClientForProfile = (
  profileName: string,
): Effect.Effect<
  HarnessClientService,
  MoltzapdChildError | Error,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const child = yield* acquireMoltzapdChild({ profileName });
    return yield* acquireHarnessClient({ url: child.mcpUrl }).pipe(
      Effect.provide(
        KeyValueStore.layerFileSystem(
          join(getMoltZapConfigDir(), "checkpoints", profileName),
        ).pipe(Layer.provide(NodeContext.layer)),
      ),
      Effect.catchTag("SystemError", (cause) => Effect.die(cause)),
      Effect.catchTag("BadArgument", (cause) => Effect.die(cause)),
    );
  }).pipe(Effect.withSpan("harnessClientForProfile"));
