/** @file Minimal real-process fixtures for the Client daemon acceptance test. */

import { WireVersions } from "@moltzap/identity/test";
import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  AgentName,
  AgentSigningAuthority,
  Ed25519PublicKey,
  PrincipalId,
} from "@moltzap/identity";
import { OperationId } from "@moltzap/identity/registry";
import {
  Console,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Redacted,
  Ref,
  Schema,
  Scope,
} from "effect";
import { createRequire } from "node:module";
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
// This black-box fixture owns exact temporary process files at the Node process boundary.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type TestContext } from "vitest";
import type { MessageAddressInput } from "../src/index.js";
import {
  managementReadConversationResultSchema,
  managementRegisterResultSchema,
  managementSearchConversationsResultSchema,
  managementStatusResultSchema,
  type ManagementReadConversationResult,
  type ManagementRegisterRequest,
  type ManagementRegisterResult,
  type ManagementSearchConversationsResult,
  type ManagementStatusResult,
} from "../src/harness/protocol/index.js";

/** Loader resolution follows Client dependencies even when child processes run from the workspace root. */
const require = createRequire(import.meta.url);

const LOOPBACK_HOST = "127.0.0.1";
const ADMISSION_CREDENTIAL = "client-process-admission";
const READY_STATUS = 204;
const SHUTDOWN_TIMEOUT = Duration.seconds(5);
/**
 * How long a finished test waits for its trace's scope to stop every child: a
 * trace holds at most seven, PGlite, the Registry, the Router and four
 * daemons, stopped one at a time, each within `SHUTDOWN_TIMEOUT` before it is
 * killed.
 */
const TEARDOWN_TIMEOUT_MS = 60_000;
const POLL_ATTEMPT_TIMEOUT = Duration.seconds(1);
const POLL_INTERVAL = Duration.millis(25);
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const PGLITE_BINARY = join(
  WORKSPACE_ROOT,
  "packages/registry/node_modules/.bin/pglite-server",
);
const REGISTRY_BINARY = join(
  WORKSPACE_ROOT,
  "packages/registry/bin/sharness-registry",
);
const ROUTER_BINARY = join(
  WORKSPACE_ROOT,
  "packages/router/bin/sharness-router",
);
const DAEMON_BINARY = join(WORKSPACE_ROOT, "packages/client/bin/sharnessd");
const FIREWALL_DAEMON = join(
  WORKSPACE_ROOT,
  "packages/client/integration/firewall-daemon.ts",
);

/** The mode of the firewall a daemon fixture installs; absent for `sharnessd` itself. */
export type FirewallMode = "guidance" | "enforcement";

/** One closed process-fixture failure with captured child output when available. */
export class ProcessTestError extends Data.TaggedError("ProcessTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface RunningProcess {
  readonly child: ChildProcess;
  readonly logs: () => string;
}

/** Shared Registry and Router coordinates for two endpoint daemons. */
export interface ProcessInfrastructure {
  readonly registryOrigin: URL;
  readonly routerOrigin: URL;
  readonly registrySignerPublicKeyJson: string;
  readonly temporaryDirectory: string;
  /**
   * Stops the Router and starts a fresh one on the same origin. The Router
   * keeps its state in memory, so the new process has a new
   * `RouterInstanceId` and no envelopes, as a redeployed Router does.
   */
  readonly restartRouter: Effect.Effect<void, ProcessTestError>;
}

/**
 * Exact reusable process inputs for one daemon identity and state directory.
 * A fixture with a `firewall` mode runs `firewall-daemon.ts`, which installs
 * that firewall; one without runs `sharnessd`.
 */
export interface DaemonProcessFixture {
  readonly agentName: AgentName;
  readonly endpoint: URL;
  readonly environment: Readonly<Record<string, string>>;
  readonly stateDirectory: string;
  readonly agentPrivateKeyFile: string;
  readonly firewall?: FirewallMode;
  readonly wireVersions?: {
    readonly emitted: string;
    readonly live: readonly string[];
    readonly history: readonly string[];
  };
}

/** Private management calls used to bootstrap and inspect a real daemon. */
export interface DaemonManagementClient {
  readonly register: (
    input: ManagementRegisterRequest,
  ) => Effect.Effect<ManagementRegisterResult, ProcessTestError>;
  readonly status: () => Effect.Effect<
    ManagementStatusResult,
    ProcessTestError
  >;
  readonly searchConversations: () => Effect.Effect<
    ManagementSearchConversationsResult,
    ProcessTestError
  >;
  readonly readConversation: (
    address: MessageAddressInput,
  ) => Effect.Effect<ManagementReadConversationResult, ProcessTestError>;
  readonly callExpectingProtocolError: (
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<DaemonProtocolError, ProcessTestError>;
}

/** Stable JSON-RPC error fields observed by the real MCP client. */
interface DaemonProtocolError {
  readonly code: number;
  readonly data?: unknown;
}

const processTestError = (message: string, cause?: unknown): ProcessTestError =>
  new ProcessTestError({ message, cause });

const reservePort = Effect.async<number, ProcessTestError>((resume) => {
  const server = createServer();
  const onError = (error: Error): void => {
    resume(Effect.fail(processTestError("could not reserve a port", error)));
  };
  server.once("error", onError);
  server.listen(0, LOOPBACK_HOST, () => {
    server.removeListener("error", onError);
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      resume(
        Effect.fail(processTestError("reserved listener exposed no port")),
      );
      return;
    }
    server.close((error) => {
      resume(
        error === undefined
          ? Effect.succeed(address.port)
          : Effect.fail(
              processTestError("could not release reserved port", error),
            ),
      );
    });
  });
  return Effect.sync(() => {
    if (server.listening) {
      server.close();
    }
  });
});

const startProcess = (
  executable: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  cwd = WORKSPACE_ROOT,
): RunningProcess => {
  const child = spawn(executable, arguments_, {
    cwd,
    env: { PATH: CHILD_PATH, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });
  return { child, logs: () => output };
};

/** Whether `child` has exited on its own or by a signal. */
const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const waitForExit = (running: RunningProcess): Effect.Effect<void> => {
  if (hasExited(running.child)) {
    return Effect.void;
  }
  return Effect.async<void>((resume) => {
    const onExit = (): void => {
      resume(Effect.void);
    };
    running.child.once("exit", onExit);
    return Effect.sync(() => {
      running.child.removeListener("exit", onExit);
    });
  });
};

/**
 * Stops one exact acquired child, escalating only after its shutdown grace.
 * A scope runs this release uninterruptibly, and a race does not finish until
 * its loser stops, so both sides are interruptible: otherwise every teardown
 * waits out the full grace for a child that has already exited.
 */
export const stopProcess = (running: RunningProcess): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (hasExited(running.child)) {
      return;
    }
    running.child.kill("SIGTERM");
    const stopped = yield* Effect.raceFirst(
      waitForExit(running).pipe(Effect.as(true), Effect.interruptible),
      Effect.sleep(SHUTDOWN_TIMEOUT).pipe(
        Effect.as(false),
        Effect.interruptible,
      ),
    );
    if (!stopped) {
      running.child.kill("SIGKILL");
      yield* waitForExit(running);
    }
  });

/**
 * Starts a child that the trace's enclosing scope stops. A scope closed by
 * interruption, as a timed-out test's is, first prints the child's output, so
 * one run shows where a hang stood.
 */
const managedProcess = (
  executable: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  cwd = WORKSPACE_ROOT,
) =>
  Effect.acquireRelease(
    Effect.sync(() => startProcess(executable, arguments_, environment, cwd)),
    (running, exit) =>
      Exit.isInterrupted(exit)
        ? Console.error(
            `${basename(executable)} (pid ${running.child.pid}) output when interrupted:\n${running.logs()}`,
          ).pipe(Effect.zipRight(stopProcess(running)))
        : stopProcess(running),
  );

const canConnect = (port: number) =>
  Effect.async<boolean>((resume) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    const finish = (connected: boolean): void => {
      socket.destroy();
      resume(Effect.succeed(connected));
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    return Effect.sync(() => {
      socket.destroy();
    });
  }).pipe(
    Effect.timeoutTo({
      duration: POLL_ATTEMPT_TIMEOUT,
      onTimeout: () => false,
      onSuccess: (connected) => connected,
    }),
  );

/** Whether `origin` answers its health check as ready. */
const isHealthy = (origin: URL) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(new URL("/healthz", origin), { signal }).then(async (response) => {
        await response.body?.cancel();
        return response.status === READY_STATUS;
      }),
    catch: (cause) => processTestError("health request failed", cause),
  }).pipe(
    Effect.timeout(POLL_ATTEMPT_TIMEOUT),
    Effect.orElseSucceed(() => false),
  );

/**
 * Polls `probe` until it reads true, and fails with the child's output once
 * the child exits first.
 * @param running Child that must become ready.
 * @param probe One readiness check of the child.
 * @param phase What the child had yet to do, for the failure message.
 * @returns Completion once `probe` reads true.
 */
const awaitReady = (
  running: RunningProcess,
  probe: Effect.Effect<boolean>,
  phase: string,
) =>
  Effect.gen(function* () {
    while (!hasExited(running.child)) {
      if (yield* probe) {
        return;
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
    return yield* Effect.fail(
      processTestError(`process exited before ${phase}\n${running.logs()}`),
    );
  });

const makePrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" });
};

const acquireTemporaryDirectory: Effect.Effect<
  string,
  ProcessTestError,
  Scope.Scope
> = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "sharness-client-process-")),
    catch: (cause) =>
      processTestError("could not create temporary directory", cause),
  }),
  (path) =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (cause) =>
        processTestError("could not remove temporary directory", cause),
    }).pipe(Effect.ignore),
);

const writePrivateFile = (path: string, content: string) =>
  Effect.tryPromise({
    try: () => writeFile(path, content, { encoding: "utf8", mode: 0o600 }),
    catch: (cause) => processTestError(`could not write ${path}`, cause),
  });

const makeDirectory = (path: string) =>
  Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }),
    catch: (cause) => processTestError(`could not create ${path}`, cause),
  });

const encodePublicKey = (
  publicKey: Ed25519PublicKey,
): Effect.Effect<string, ProcessTestError> =>
  Schema.encode(Ed25519PublicKey)(publicKey).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    Effect.mapError((cause) =>
      processTestError("could not encode Registry signer", cause),
    ),
  );

/** The Registry and Router executables one infrastructure runs. */
export interface NetworkBinaries {
  readonly registry: string;
  readonly router: string;
}

/**
 * Starts disposable PGlite, Registry, and Router processes from `binaries`,
 * such as a published release's executables. The Registry waits for PGlite
 * to listen; the Router reads the Registry only to serve a request, so it
 * starts alongside them. An injected `WireVersions` runs the workspace
 * Registry and Router under those sets instead.
 */
export const acquireProcessInfrastructureFrom = (
  binaries: NetworkBinaries,
): Effect.Effect<ProcessInfrastructure, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const versions = yield* Effect.serviceOption(WireVersions);
    const temporaryDirectory = yield* acquireTemporaryDirectory;
    const registryKeyPath = join(temporaryDirectory, "registry-key.pem");
    const registryPrivateKey = makePrivateKeyPem();
    yield* writePrivateFile(registryKeyPath, registryPrivateKey);
    const registryAuthority = yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(registryPrivateKey),
    ).pipe(
      Effect.mapError((cause) =>
        processTestError("could not load Registry signer", cause),
      ),
    );
    const registrySignerPublicKeyJson = yield* encodePublicKey(
      AgentSigningAuthority.publicKey(registryAuthority),
    );
    const [postgresqlPort, registryPort, routerPort] = yield* Effect.all(
      [reservePort, reservePort, reservePort] as const,
      { concurrency: 3 },
    );
    const registryOrigin = new URL(`http://${LOOPBACK_HOST}:${registryPort}`);
    const routerOrigin = new URL(`http://${LOOPBACK_HOST}:${routerPort}`);

    const startRegistry = Effect.gen(function* () {
      const postgresql = yield* managedProcess(PGLITE_BINARY, [
        "--db=memory://",
        `--port=${postgresqlPort}`,
        `--host=${LOOPBACK_HOST}`,
        "--max-connections=20",
      ]);
      yield* awaitReady(postgresql, canConnect(postgresqlPort), "listening");
      const registryCommand: readonly [string, readonly string[]] =
        Option.isNone(versions)
          ? [binaries.registry, []]
          : [
              process.execPath,
              [
                "--conditions=sharness-test",
                "--conditions=sharness-internal",
                "--input-type=module",
                "-e",
                `import { NodeRuntime } from "@effect/platform-node"; import { WireVersions } from "@moltzap/identity/test"; import { layer } from "@moltzap/registry"; import { ConfigProvider, Effect, Layer } from "effect"; Layer.launch(layer).pipe(Effect.provideService(WireVersions, ${JSON.stringify(versions.value)}), Effect.withConfigProvider(ConfigProvider.fromEnv()), NodeRuntime.runMain);`,
              ],
            ];
      const registry = yield* managedProcess(
        registryCommand[0],
        registryCommand[1],
        {
          SHARNESS_REGISTRY_HOST: LOOPBACK_HOST,
          SHARNESS_REGISTRY_PORT: String(registryPort),
          SHARNESS_REGISTRY_POSTGRESQL_URL: `postgresql://postgres:postgres@${LOOPBACK_HOST}:${postgresqlPort}/postgres`,
          SHARNESS_REGISTRY_ADMISSION_CREDENTIAL: ADMISSION_CREDENTIAL,
          SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH: registryKeyPath,
          SHARNESS_REGISTRY_LIST_PAGE_SIZE: "16",
        },
        join(WORKSPACE_ROOT, "packages/registry"),
      );
      yield* awaitReady(registry, isHealthy(registryOrigin), "health response");
    });
    const scope = yield* Effect.scope;
    const routerCommand: readonly [string, readonly string[]] = Option.isNone(
      versions,
    )
      ? [binaries.router, []]
      : [
          process.execPath,
          [
            "--conditions=sharness-test",
            "--input-type=module",
            "-e",
            `import { NodeRuntime } from "@effect/platform-node"; import { WireVersions } from "@moltzap/identity/test"; import { RouterServer } from "@moltzap/router/server"; import { ConfigProvider, Effect, Layer } from "effect"; Layer.launch(RouterServer.layer).pipe(Effect.provideService(WireVersions, ${JSON.stringify(versions.value)}), Effect.withConfigProvider(ConfigProvider.fromEnv()), NodeRuntime.runMain);`,
          ],
        ];
    const startRouter = managedProcess(
      routerCommand[0],
      routerCommand[1],
      {
        SHARNESS_ROUTER_HOST: LOOPBACK_HOST,
        SHARNESS_ROUTER_PORT: String(routerPort),
        SHARNESS_ROUTER_REGISTRY_ORIGIN: registryOrigin.origin,
        SHARNESS_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY: registrySignerPublicKeyJson,
        SHARNESS_ROUTER_REQUEST_CONCURRENCY_LIMIT: "16",
        SHARNESS_ROUTER_HELD_POLL_CAPACITY: "8",
      },
      join(WORKSPACE_ROOT, "packages/client"),
    ).pipe(
      Effect.tap((router) =>
        awaitReady(router, isHealthy(routerOrigin), "health response"),
      ),
      Scope.extend(scope),
    );
    const [, firstRouter] = yield* Effect.all([startRegistry, startRouter], {
      concurrency: 2,
    });
    const router = yield* Ref.make(firstRouter);
    const restartRouter = Ref.get(router).pipe(
      Effect.flatMap(stopProcess),
      Effect.zipRight(startRouter),
      Effect.flatMap((restarted) => Ref.set(router, restarted)),
    );

    return {
      registryOrigin,
      routerOrigin,
      registrySignerPublicKeyJson,
      temporaryDirectory,
      restartRouter,
    };
  });

/** Starts disposable PGlite, Registry, and Router processes from the workspace. */
export const acquireProcessInfrastructure = acquireProcessInfrastructureFrom({
  registry: REGISTRY_BINARY,
  router: ROUTER_BINARY,
});

/** Creates one independent daemon key, credential file, and durable state path. */
export const makeDaemonProcessFixture = (
  infrastructure: ProcessInfrastructure,
  name: string,
  firewall?: FirewallMode,
): Effect.Effect<DaemonProcessFixture, ProcessTestError> =>
  Effect.gen(function* () {
    const agentName = yield* Schema.decodeUnknown(AgentName)(name).pipe(
      Effect.mapError((cause) =>
        processTestError("invalid test agent name", cause),
      ),
    );
    const port = yield* reservePort;
    const directory = join(infrastructure.temporaryDirectory, name);
    const stateDirectory = join(directory, "state");
    const keyPath = join(directory, "agent-key.pem");
    const credentialPath = join(directory, "admission.txt");
    yield* makeDirectory(stateDirectory);
    yield* Effect.all(
      [
        writePrivateFile(keyPath, makePrivateKeyPem()),
        writePrivateFile(credentialPath, ADMISSION_CREDENTIAL),
      ] as const,
      { concurrency: 2, discard: true },
    );
    return {
      agentName,
      endpoint: new URL(`http://${LOOPBACK_HOST}:${port}/mcp`),
      stateDirectory,
      agentPrivateKeyFile: keyPath,
      environment: {
        SHARNESS_STATE_DIRECTORY: stateDirectory,
        SHARNESS_MCP_PORT: String(port),
        SHARNESS_REGISTRY_ORIGIN: infrastructure.registryOrigin.origin,
        SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY:
          infrastructure.registrySignerPublicKeyJson,
        SHARNESS_ROUTER_ORIGIN: infrastructure.routerOrigin.origin,
        SHARNESS_AGENT_PRIVATE_KEY_FILE: keyPath,
        SHARNESS_ADMISSION_CREDENTIAL_FILE: credentialPath,
        ...(firewall === undefined
          ? {}
          : { SHARNESS_TEST_FIREWALL_MODE: firewall }),
      },
      ...(firewall === undefined ? {} : { firewall }),
    };
  });

/** The command that runs one fixture's daemon. */
const daemonCommand = (
  fixture: DaemonProcessFixture,
): readonly [string, readonly string[]] =>
  fixture.firewall === undefined
    ? [DAEMON_BINARY, []]
    : [process.execPath, ["--import", require.resolve("tsx"), FIREWALL_DAEMON]];

/** Starts one sharnessd and returns only after its guarded loopback port listens. */
export const acquireDaemonProcess = (
  fixture: DaemonProcessFixture,
  executable?: string,
): Effect.Effect<RunningProcess, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const [binary, args] =
      fixture.wireVersions !== undefined
        ? ([
            process.execPath,
            [
              "--conditions=sharness-test",
              "--input-type=module",
              "-e",
              `import { NodeRuntime } from "@effect/platform-node"; import { WireVersions } from "@moltzap/identity/test"; import { Daemon } from "@moltzap/client/service"; import { ConfigProvider, Effect, Layer } from "effect"; Layer.launch(Daemon.layer).pipe(Effect.provideService(WireVersions, ${JSON.stringify(fixture.wireVersions)}), Effect.withConfigProvider(ConfigProvider.fromEnv()), NodeRuntime.runMain);`,
            ],
          ] as const)
        : executable === undefined
          ? daemonCommand(fixture)
          : ([executable, []] as const);
    const running = yield* managedProcess(
      binary,
      args,
      fixture.environment,
      join(WORKSPACE_ROOT, "packages/client"),
    );
    yield* awaitReady(
      running,
      canConnect(Number(fixture.endpoint.port)),
      "listening",
    );
    return running;
  });

/** Exit code and captured output of a daemon that stopped before listening. */
export interface DaemonStartupFailure {
  readonly exitCode: number | null;
  readonly logs: string;
}

/**
 * Starts one sharnessd that must stop before it listens. A daemon that listens
 * instead fails the fixture.
 */
export const awaitDaemonStartupFailure = (
  fixture: DaemonProcessFixture,
  command?: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd?: string;
  },
): Effect.Effect<DaemonStartupFailure, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const [executable, arguments_] =
      command === undefined
        ? daemonCommand(fixture)
        : ([command.executable, command.args] as const);
    const running = yield* managedProcess(
      executable,
      arguments_,
      fixture.environment,
      command?.cwd,
    );
    const listened = yield* awaitReady(
      running,
      canConnect(Number(fixture.endpoint.port)),
      "listening",
    ).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (listened) {
      return yield* Effect.fail(
        processTestError(`daemon listened unexpectedly\n${running.logs()}`),
      );
    }
    yield* waitForExit(running);
    return { exitCode: running.child.exitCode, logs: running.logs() };
  });

const makeIdentifier = (prefix: "opn_" | "prn_"): string =>
  `${prefix}${randomBytes(16).toString("base64url")}`;

/**
 * The vitest test function of a real-process trace that must assert. A test
 * that times out is failed without waiting for its body, and the worker can
 * exit before an interrupted trace's scope has stopped its children, which
 * then outlive the run. The trace therefore runs as a fiber that an
 * `onTestFinished` hook interrupts, waiting until its scope has stopped every
 * child.
 * @param trace A trace whose scope owns every process it starts.
 * @returns The test function, whose promise settles with the trace.
 */
export function processTrace<E>(
  trace: Effect.Effect<void, E>,
): (context: TestContext) => Promise<void> {
  return (context) => {
    expect.hasAssertions();
    const fiber = Effect.runFork(trace);
    context.onTestFinished(
      () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)),
      TEARDOWN_TIMEOUT_MS,
    );
    return Effect.runPromise(Fiber.join(fiber));
  };
}

/** Creates exact one-shot bootstrap fields for a fixture's configured identity. */
export const makeRegistrationRequest = (
  fixture: DaemonProcessFixture,
): ManagementRegisterRequest => ({
  operationId: Schema.decodeUnknownSync(OperationId)(makeIdentifier("opn_")),
  principalId: Schema.decodeUnknownSync(PrincipalId)(makeIdentifier("prn_")),
  agentName: fixture.agentName,
});

const callAndDecode = <A, I>(input: {
  readonly client: Client;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly schema: Schema.Schema<A, I>;
}): Effect.Effect<A, ProcessTestError> =>
  Effect.tryPromise({
    try: (signal) =>
      input.client.callTool(
        { name: input.name, arguments: input.arguments },
        { signal },
      ),
    catch: (cause) => processTestError(`${input.name} call failed`, cause),
  }).pipe(
    Effect.filterOrFail(
      (result) => result.isError !== true,
      () => processTestError(`${input.name} returned an MCP error`),
    ),
    Effect.flatMap((result) =>
      Schema.decodeUnknown(input.schema)(result.structuredContent).pipe(
        Effect.mapError((cause) =>
          processTestError(`${input.name} returned invalid content`, cause),
        ),
      ),
    ),
  );

const closeManagementClient = (client: Client): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => client.close(),
    catch: (cause) =>
      processTestError("could not close management client", cause),
  }).pipe(Effect.ignore);

const callExpectingProtocolError = (
  client: Client,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Effect.Effect<DaemonProtocolError, ProcessTestError> =>
  Effect.tryPromise({
    try: (signal) =>
      client.callTool({ name, arguments: arguments_ }, { signal }),
    catch: (cause) => processTestError(`${name} call failed`, cause),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        ProtocolError.isInstance(error.cause)
          ? Effect.succeed({ code: error.cause.code, data: error.cause.data })
          : Effect.fail(error),
      onSuccess: () =>
        Effect.fail(processTestError(`${name} unexpectedly succeeded`)),
    }),
  );

/** Acquires a private management-only MCP session against one real daemon. */
export const acquireDaemonManagementClient = (
  endpoint: URL,
): Effect.Effect<DaemonManagementClient, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = new Client(
      { name: "sharness-process-acceptance", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
      },
    );
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) =>
          client.connect(new StreamableHTTPClientTransport(endpoint), {
            signal,
          }),
        catch: (cause) =>
          processTestError("could not connect management client", cause),
      }),
      () => closeManagementClient(client),
    );
    return {
      register: (request) =>
        callAndDecode({
          client,
          name: "register",
          arguments: { ...request },
          schema: managementRegisterResultSchema,
        }),
      status: () =>
        callAndDecode({
          client,
          name: "status",
          arguments: {},
          schema: managementStatusResultSchema,
        }),
      searchConversations: () =>
        callAndDecode({
          client,
          name: "search_conversations",
          arguments: {},
          schema: managementSearchConversationsResultSchema,
        }),
      readConversation: (address) =>
        callAndDecode({
          client,
          name: "read_conversation",
          arguments: { address },
          schema: managementReadConversationResultSchema,
        }),
      callExpectingProtocolError: (name, arguments_) =>
        callExpectingProtocolError(client, name, arguments_),
    };
  });
