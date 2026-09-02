/** @file Minimal real-process fixtures for the Client daemon acceptance test. */

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
import { Data, Duration, Effect, Redacted, Schema, type Scope } from "effect";
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
// This black-box fixture owns exact temporary process files at the Node process boundary.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageAddressInput } from "../src/contract.js";
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
} from "../src/management-runtime.js";

const LOOPBACK_HOST = "127.0.0.1";
const ADMISSION_CREDENTIAL = "client-process-admission";
const READY_STATUS = 204;
const STARTUP_TIMEOUT = Duration.seconds(30);
const SHUTDOWN_TIMEOUT = Duration.seconds(5);
const POLL_INTERVAL = Duration.millis(25);
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const PGLITE_BINARY = join(
  WORKSPACE_ROOT,
  "packages/identity/node_modules/.bin/pglite-server",
);
const REGISTRY_BINARY = join(
  WORKSPACE_ROOT,
  "packages/identity/bin/moltzap-registry",
);
const ROUTER_BINARY = join(
  WORKSPACE_ROOT,
  "packages/router/bin/moltzap-router",
);
const DAEMON_BINARY = join(WORKSPACE_ROOT, "packages/client/bin/moltzapd");

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
}

/** Exact reusable process inputs for one daemon identity and state directory. */
export interface DaemonProcessFixture {
  readonly agentName: AgentName;
  readonly endpoint: URL;
  readonly environment: Readonly<Record<string, string>>;
  readonly stateDirectory: string;
}

/** Private management calls used to bootstrap and inspect a real daemon. */
export interface DaemonManagementClient {
  readonly listToolNames: () => Effect.Effect<
    readonly string[],
    ProcessTestError
  >;
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
export interface DaemonProtocolError {
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
): RunningProcess => {
  const child = spawn(executable, arguments_, {
    cwd: WORKSPACE_ROOT,
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

const waitForExit = (running: RunningProcess): Effect.Effect<void> => {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
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

/** Stops one exact acquired child, escalating only after its shutdown grace. */
export const stopProcess = (running: RunningProcess): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      return;
    }
    running.child.kill("SIGTERM");
    const stopped = yield* Effect.raceFirst(
      waitForExit(running).pipe(Effect.as(true)),
      Effect.sleep(SHUTDOWN_TIMEOUT).pipe(Effect.as(false)),
    );
    if (!stopped) {
      running.child.kill("SIGKILL");
      yield* waitForExit(running);
    }
  });

const managedProcess = (
  executable: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) =>
  // Every process is tied to the integration behavior's enclosing scope.
  Effect.acquireRelease(
    Effect.sync(() => startProcess(executable, arguments_, environment)),
    stopProcess,
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
  });

const waitForTcpListener = (running: RunningProcess, port: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + Duration.toMillis(STARTUP_TIMEOUT);
    while (Date.now() < deadline) {
      if (
        running.child.exitCode !== null ||
        running.child.signalCode !== null
      ) {
        return yield* Effect.fail(
          processTestError(
            `process exited before listening\n${running.logs()}`,
          ),
        );
      }
      if (yield* canConnect(port)) {
        return;
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
    return yield* Effect.fail(
      processTestError(
        `process did not listen before timeout\n${running.logs()}`,
      ),
    );
  });

const readHealthStatus = (origin: URL) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(new URL("/healthz", origin), { signal }).then(async (response) => {
        await response.body?.cancel();
        return response.status;
      }),
    catch: (cause) => processTestError("health request failed", cause),
  });

const waitForHealth = (running: RunningProcess, origin: URL) =>
  Effect.gen(function* () {
    const deadline = Date.now() + Duration.toMillis(STARTUP_TIMEOUT);
    while (Date.now() < deadline) {
      if (
        running.child.exitCode !== null ||
        running.child.signalCode !== null
      ) {
        return yield* Effect.fail(
          processTestError(
            `process exited before health response\n${running.logs()}`,
          ),
        );
      }
      const status = yield* readHealthStatus(origin).pipe(Effect.option);
      if (status._tag === "Some" && status.value === READY_STATUS) {
        return;
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
    return yield* Effect.fail(
      processTestError(`process did not become healthy\n${running.logs()}`),
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
    try: () => mkdtemp(join(tmpdir(), "moltzap-client-process-")),
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

/** Starts disposable PGlite, Registry, and Router processes in dependency order. */
export const acquireProcessInfrastructure: Effect.Effect<
  ProcessInfrastructure,
  ProcessTestError,
  Scope.Scope
> = Effect.gen(function* () {
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

  const postgresql = yield* managedProcess(PGLITE_BINARY, [
    "--db=memory://",
    `--port=${postgresqlPort}`,
    `--host=${LOOPBACK_HOST}`,
    "--max-connections=20",
  ]);
  yield* waitForTcpListener(postgresql, postgresqlPort);

  const registryOrigin = new URL(`http://${LOOPBACK_HOST}:${registryPort}`);
  const registry = yield* managedProcess(REGISTRY_BINARY, [], {
    MOLTZAP_REGISTRY_HOST: LOOPBACK_HOST,
    MOLTZAP_REGISTRY_PORT: String(registryPort),
    MOLTZAP_REGISTRY_POSTGRESQL_URL: `postgresql://postgres:postgres@${LOOPBACK_HOST}:${postgresqlPort}/postgres`,
    MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL: ADMISSION_CREDENTIAL,
    MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH: registryKeyPath,
    MOLTZAP_REGISTRY_LIST_PAGE_SIZE: "16",
  });
  yield* waitForHealth(registry, registryOrigin);

  const routerOrigin = new URL(`http://${LOOPBACK_HOST}:${routerPort}`);
  const router = yield* managedProcess(ROUTER_BINARY, [], {
    MOLTZAP_ROUTER_HOST: LOOPBACK_HOST,
    MOLTZAP_ROUTER_PORT: String(routerPort),
    MOLTZAP_ROUTER_REGISTRY_ORIGIN: registryOrigin.origin,
    MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY: registrySignerPublicKeyJson,
    MOLTZAP_ROUTER_REQUEST_CONCURRENCY_LIMIT: "16",
    MOLTZAP_ROUTER_HELD_POLL_CAPACITY: "8",
  });
  yield* waitForHealth(router, routerOrigin);

  return {
    registryOrigin,
    routerOrigin,
    registrySignerPublicKeyJson,
    temporaryDirectory,
  };
});

/** Creates one independent daemon key, credential file, and durable state path. */
export const makeDaemonProcessFixture = (
  infrastructure: ProcessInfrastructure,
  name: string,
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
      environment: {
        MOLTZAPD_STATE_DIRECTORY: stateDirectory,
        MOLTZAPD_MCP_PORT: String(port),
        MOLTZAPD_REGISTRY_ORIGIN: infrastructure.registryOrigin.origin,
        MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY:
          infrastructure.registrySignerPublicKeyJson,
        MOLTZAPD_ROUTER_ORIGIN: infrastructure.routerOrigin.origin,
        MOLTZAPD_AGENT_PRIVATE_KEY_FILE: keyPath,
        MOLTZAPD_ADMISSION_CREDENTIAL_FILE: credentialPath,
      },
    };
  });

/** Starts one moltzapd and returns only after its guarded loopback port listens. */
export const acquireDaemonProcess = (
  fixture: DaemonProcessFixture,
): Effect.Effect<RunningProcess, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const running = yield* managedProcess(
      DAEMON_BINARY,
      [],
      fixture.environment,
    );
    yield* waitForTcpListener(running, Number(fixture.endpoint.port));
    return running;
  });

const makeIdentifier = (prefix: "opn_" | "prn_"): string =>
  `${prefix}${randomBytes(16).toString("base64url")}`;

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

const listToolNames = (
  client: Client,
): Effect.Effect<readonly string[], ProcessTestError> =>
  Effect.tryPromise({
    try: (signal) =>
      client.listTools(undefined, { cacheMode: "refresh", signal }),
    catch: (cause) => processTestError("could not list MCP tools", cause),
  }).pipe(Effect.map(({ tools }) => tools.map(({ name }) => name).sort()));

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
      { name: "moltzap-process-acceptance", version: "1.0.0" },
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
      listToolNames: () => listToolNames(client),
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
