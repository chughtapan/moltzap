/** @file Controller-local realization of one experiment-controlled endpoint. */

import type { AgentId, PrincipalId } from "@moltzap/identity";
import type { OperationId } from "@moltzap/identity/registry";
import {
  acquireHarnessClient,
  AgentName,
  type HarnessClient,
  type HarnessTurn,
  type StartInput,
} from "@moltzap/client";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Either,
  ExecutionStrategy,
  Exit,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { type ChildProcess, spawn } from "node:child_process";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- This private process adapter owns exact controller-local state files at the child-process boundary.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttachedEndpoint,
  makeParticipantHandle,
  networkError,
  type NetworkError,
} from "../network/index.js";
import {
  ADMISSION_CREDENTIAL_SECRET_KEY,
  AGENT_PRIVATE_KEY_SECRET_KEY,
  generateAgentDaemonAuthority,
  type SocietyNetworkAuthority,
} from "./society-network.js";

const LOOPBACK_HOST = "127.0.0.1";
const DAEMON_ENTRYPOINT =
  "/srv/moltzap/node_modules/@moltzap/client/bin/moltzapd";
const REGISTRAR_ENTRYPOINT = "/opt/moltzap/register-daemon.mjs";
const STARTUP_TIMEOUT = Duration.seconds(30);
const SHUTDOWN_TIMEOUT = Duration.seconds(5);
const POLL_INTERVAL = Duration.millis(25);
const DAEMON_LISTENER_ATTEMPTS = 3;

interface RunningProcess {
  readonly child: ChildProcess;
  readonly exit: Deferred.Deferred<ProcessExit>;
  readonly failure: Effect.Effect<never, NetworkError>;
  readonly logs: () => string;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface ControlledEndpointRuntimeInput {
  readonly authority: SocietyNetworkAuthority;
  readonly resolveAgentId: (
    name: typeof AgentName.Type,
  ) => Effect.Effect<AgentId, NetworkError>;
}

interface ControlledEndpointRequest<Name extends string> {
  readonly name: Name;
  readonly routerOrigin: URL;
}

interface StartedControlledDaemon<Name extends string> {
  readonly daemon: RunningProcess;
  readonly endpoint: URL;
  readonly name: typeof AgentName.Type;
  readonly operationId: OperationId;
  readonly principalId: PrincipalId;
  readonly request: ControlledEndpointRequest<Name>;
}

interface VerifiedDaemonListener {
  readonly daemon: RunningProcess;
  readonly endpoint: URL;
}

/** Inputs retained only by the controller's active society network. */
export interface ControlledEndpointRuntime {
  readonly acquire: <const Name extends string>(
    input: ControlledEndpointRequest<Name>,
  ) => Effect.Effect<AttachedEndpoint<Name>, NetworkError, Scope.Scope>;
}

/**
 * Builds controlled endpoints around one run's secret network authority.
 * @param input Run-owned authority and exact Registry identity resolver.
 * @returns A scoped production-daemon endpoint acquirer.
 */
export function makeControlledEndpointRuntime(
  input: ControlledEndpointRuntimeInput,
): ControlledEndpointRuntime {
  return Object.freeze({
    acquire: <const Name extends string>(
      request: ControlledEndpointRequest<Name>,
    ) => acquireControlledEndpoint(input, request),
  });
}

function ensureProcessRunning(
  running: RunningProcess,
): Effect.Effect<void, NetworkError> {
  const { exitCode, signalCode } = running.child;
  return exitCode === null && signalCode === null
    ? Effect.void
    : Effect.fail(
        boundaryFailure(
          exitDescription(
            "controlled daemon",
            { code: exitCode, signal: signalCode },
            running.logs(),
          ),
        ),
      );
}

function boundaryFailure(cause: unknown): NetworkError {
  return networkError("attach-endpoint", cause);
}

// #ignore-sloppy-code-next-line[async-keyword]: The Effect adapter owns the callback-based Node listener boundary without a JavaScript promise function.
const reservePort: Effect.Effect<number, NetworkError> = Effect.async(
  (resume) => {
    const server = createServer();
    const fail = (cause: Error): void => {
      resume(Effect.fail(boundaryFailure(cause)));
    };
    server.once("error", fail);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        resume(
          Effect.fail(
            boundaryFailure("reserved endpoint listener exposed no port"),
          ),
        );
        return;
      }
      server.close((cause) => {
        resume(
          cause === undefined
            ? Effect.succeed(address.port)
            : Effect.fail(boundaryFailure(cause)),
        );
      });
    });
    return Effect.sync(() => {
      if (server.listening) {
        server.close();
      }
    });
  },
);

function acquireProcess(
  executable: string,
  processArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
): Effect.Effect<RunningProcess, NetworkError, Scope.Scope> {
  return Effect.acquireRelease(
    startProcess(executable, processArguments, environment),
    (running) => stopProcess(running).pipe(Effect.ignore),
  );
}

function startProcess(
  executable: string,
  processArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
): Effect.Effect<RunningProcess, NetworkError> {
  return Effect.gen(function* () {
    const failed = yield* Deferred.make<never, NetworkError>();
    const exited = yield* Deferred.make<ProcessExit>();
    return yield* Effect.try({
      try: () => {
        let output = "";
        const append = (chunk: string): void => {
          output += chunk;
        };
        const child = spawn(executable, processArguments, {
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        captureProcessOutput(child, append);
        child.on("error", (cause) => {
          append(`${cause.message}\n`);
          Effect.runSync(Deferred.fail(failed, boundaryFailure(cause)));
        });
        child.once("exit", (code, signal) => {
          Effect.runSync(Deferred.succeed(exited, { code, signal }));
        });
        return Object.freeze({
          child,
          exit: exited,
          failure: Deferred.await(failed),
          logs: () => output,
        });
      },
      catch: boundaryFailure,
    });
  });
}

function captureProcessOutput(
  child: ChildProcess,
  append: (chunk: string) => void,
): void {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
}

function receivedTurns(
  client: HarnessClient,
  daemon: RunningProcess,
): Stream.Stream<HarnessTurn, NetworkError> {
  return client.turns.pipe(
    Stream.mapError((cause) => networkError("receive", cause.reason)),
    Stream.merge(
      Stream.fromEffect(processTerminationFailure(daemon, "receive")),
    ),
  );
}

function processTerminationFailure(
  running: RunningProcess,
  operation: "attach-endpoint" | "receive",
): Effect.Effect<never, NetworkError> {
  return waitForExit(running).pipe(
    Effect.mapError((cause) => networkError(operation, cause.detail)),
    Effect.flatMap((exit) =>
      Effect.fail(
        networkError(
          operation,
          exitDescription("controlled daemon", exit, running.logs()),
        ),
      ),
    ),
  );
}

function waitForExit(
  running: RunningProcess,
): Effect.Effect<ProcessExit, NetworkError> {
  return Effect.raceFirst(observeExit(running), running.failure);
}

function observeExit(running: RunningProcess): Effect.Effect<ProcessExit> {
  return Deferred.await(running.exit);
}

function exitDescription(
  label: string,
  exit: ProcessExit,
  logs: string,
): string {
  let status: string;
  if (exit.signal !== null) {
    status = `after signal ${exit.signal}`;
  } else if (exit.code === null) {
    status = "without an exit status";
  } else {
    status = `with code ${String(exit.code)}`;
  }
  return `${label} exited ${status}: ${logs}`;
}

function stopProcess(
  running: RunningProcess,
): Effect.Effect<void, NetworkError> {
  return Effect.gen(function* () {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      return;
    }
    const observed = yield* terminateProcessWithin(
      running,
      "SIGTERM",
      Duration.toMillis(SHUTDOWN_TIMEOUT),
    );
    if (!observed) {
      yield* terminateProcessWithin(
        running,
        "SIGKILL",
        Duration.toMillis(SHUTDOWN_TIMEOUT),
      );
    }
  });
}

function terminateProcessWithin(
  running: RunningProcess,
  signal: NodeJS.Signals,
  timeoutMillis: number,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => running.child.kill(signal),
      catch: () => false,
    }).pipe(Effect.catchAll(() => Effect.succeed(false)));
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMillis;
    while (true) {
      if (Option.isSome(yield* Deferred.poll(running.exit))) {
        return true;
      }
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) {
        return false;
      }
      yield* Effect.sleep(
        Math.min(remaining, Duration.toMillis(POLL_INTERVAL)),
      );
    }
  });
}

const canConnect = (port: number): Effect.Effect<boolean> =>
  // #ignore-sloppy-code-next-line[async-keyword]: The Effect adapter owns the callback-based Node socket boundary without a JavaScript promise function.
  Effect.async((resume) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    const finish = (connected: boolean): void => {
      socket.destroy();
      resume(Effect.succeed(connected));
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
    return Effect.sync(() => {
      socket.destroy();
    });
  });

function waitForListener(
  running: RunningProcess,
  port: number,
): Effect.Effect<void, NetworkError> {
  return Effect.raceFirst(pollListener(running, port), running.failure);
}

function pollListener(
  running: RunningProcess,
  port: number,
): Effect.Effect<void, NetworkError> {
  return Effect.gen(function* () {
    const deadline = Date.now() + Duration.toMillis(STARTUP_TIMEOUT);
    while (Date.now() < deadline) {
      if (
        running.child.exitCode !== null ||
        running.child.signalCode !== null
      ) {
        return yield* Effect.fail(
          boundaryFailure(
            `controlled daemon exited before listening: ${running.logs()}`,
          ),
        );
      }
      if (yield* canConnect(port)) {
        return;
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
    return yield* Effect.fail(
      boundaryFailure(
        `controlled daemon did not listen before timeout: ${running.logs()}`,
      ),
    );
  });
}

const acquireTemporaryDirectory: Effect.Effect<
  string,
  NetworkError,
  Scope.Scope
> = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "moltzap-controlled-endpoint-")),
    catch: boundaryFailure,
  }),
  (directory) =>
    Effect.tryPromise({
      try: () => rm(directory, { recursive: true, force: true }),
      catch: boundaryFailure,
    }).pipe(Effect.ignore),
);

function writePrivateFile(
  path: string,
  content: string,
): Effect.Effect<void, NetworkError> {
  return Effect.tryPromise({
    try: () => writeFile(path, content, { encoding: "utf8", mode: 0o600 }),
    catch: boundaryFailure,
  });
}

function prepareEndpointFiles(input: {
  readonly authority: SocietyNetworkAuthority;
  readonly privateKeyPem: string;
}): Effect.Effect<
  Readonly<{
    stateDirectory: string;
    privateKeyPath: string;
    admissionCredentialPath: string;
  }>,
  NetworkError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const directory = yield* acquireTemporaryDirectory;
    const stateDirectory = join(directory, "state");
    const privateKeyPath = join(directory, AGENT_PRIVATE_KEY_SECRET_KEY);
    const admissionCredentialPath = join(
      directory,
      ADMISSION_CREDENTIAL_SECRET_KEY,
    );
    yield* Effect.tryPromise({
      try: () => mkdir(stateDirectory, { recursive: true }),
      catch: boundaryFailure,
    });
    yield* Effect.all(
      [
        writePrivateFile(privateKeyPath, input.privateKeyPem),
        writePrivateFile(
          admissionCredentialPath,
          input.authority.admissionCredential,
        ),
      ],
      { concurrency: 2, discard: true },
    );
    return Object.freeze({
      stateDirectory,
      privateKeyPath,
      admissionCredentialPath,
    });
  });
}

function runRegistrar(
  environment: Readonly<Record<string, string>>,
): Effect.Effect<void, NetworkError, Scope.Scope> {
  return Effect.gen(function* () {
    const registrar = yield* acquireProcess(
      process.execPath,
      [REGISTRAR_ENTRYPOINT],
      environment,
    );
    const exit = yield* waitForExit(registrar).pipe(
      Effect.timeoutFail({
        duration: STARTUP_TIMEOUT,
        onTimeout: () =>
          boundaryFailure("controlled daemon registration timed out"),
      }),
    );
    if (exit.code !== 0 || exit.signal !== null) {
      return yield* Effect.fail(
        boundaryFailure(
          exitDescription(
            "controlled daemon registrar",
            exit,
            registrar.logs(),
          ),
        ),
      );
    }
  });
}

function daemonEnvironment(input: {
  readonly authority: SocietyNetworkAuthority;
  readonly routerOrigin: URL;
  readonly port: number;
  readonly files: {
    readonly stateDirectory: string;
    readonly privateKeyPath: string;
    readonly admissionCredentialPath: string;
  };
}): Readonly<Record<string, string>> {
  return Object.freeze({
    NODE_ENV: "production",
    MOLTZAPD_STATE_DIRECTORY: input.files.stateDirectory,
    MOLTZAPD_MCP_PORT: String(input.port),
    MOLTZAPD_REGISTRY_ORIGIN: input.authority.registryOrigin,
    MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY:
      input.authority.registrySignerPublicKeyJson,
    MOLTZAPD_ROUTER_ORIGIN: input.routerOrigin.origin,
    MOLTZAPD_AGENT_PRIVATE_KEY_FILE: input.files.privateKeyPath,
    MOLTZAPD_ADMISSION_CREDENTIAL_FILE: input.files.admissionCredentialPath,
  });
}

function registrarEnvironment(input: {
  readonly endpoint: URL;
  readonly name: typeof AgentName.Type;
  readonly operationId: OperationId;
  readonly principalId: PrincipalId;
}): Readonly<Record<string, string>> {
  return Object.freeze({
    NODE_ENV: "production",
    MOLTZAP_MCP_URL: input.endpoint.href,
    MOLTZAP_REGISTRATION_OPERATION_ID: input.operationId,
    MOLTZAP_REGISTRATION_PRINCIPAL_ID: input.principalId,
    MOLTZAP_REGISTRATION_AGENT_NAME: input.name,
  });
}

function startConversation(
  client: HarnessClient,
  input: StartInput,
): Effect.Effect<void, NetworkError> {
  return client
    .start(input)
    .pipe(Effect.mapError((cause) => networkError("start", cause.reason)));
}

function verifyDaemonEndpoint(
  endpoint: URL,
): Effect.Effect<void, NetworkError> {
  return Effect.scoped(
    acquireHarnessClient(endpoint).pipe(
      Effect.mapError(() =>
        boundaryFailure(
          "controlled daemon listener did not expose the Harness MCP capability",
        ),
      ),
      Effect.asVoid,
    ),
  );
}

function acquireVerifiedDaemonListenerAttempt(input: {
  readonly authority: SocietyNetworkAuthority;
  readonly routerOrigin: URL;
  readonly files: {
    readonly stateDirectory: string;
    readonly privateKeyPath: string;
    readonly admissionCredentialPath: string;
  };
}): Effect.Effect<VerifiedDaemonListener, NetworkError, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const parentScope = yield* Scope.Scope;
      const attemptScope = yield* Scope.fork(
        parentScope,
        ExecutionStrategy.sequential,
      );
      const exit = yield* Effect.gen(function* () {
        // moltzapd accepts a port number rather than an inherited listener.
        // The MCP probe proves that the post-reservation owner is the expected
        // daemon before registration can commit an identity.
        const port = yield* restore(reservePort);
        const endpoint = new URL(`http://${LOOPBACK_HOST}:${String(port)}/mcp`);
        const daemon = yield* acquireProcess(
          process.execPath,
          [DAEMON_ENTRYPOINT],
          daemonEnvironment({
            authority: input.authority,
            routerOrigin: input.routerOrigin,
            port,
            files: input.files,
          }),
        ).pipe(Scope.extend(attemptScope));
        yield* restore(
          waitForListener(daemon, port).pipe(
            Effect.zipRight(verifyDaemonEndpoint(endpoint)),
          ),
        );
        yield* ensureProcessRunning(daemon);
        return Object.freeze({ daemon, endpoint });
      }).pipe(Effect.exit);
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      yield* Scope.close(attemptScope, exit);
      return yield* Effect.failCause(exit.cause);
    }),
  );
}

function acquireVerifiedDaemonListener(input: {
  readonly authority: SocietyNetworkAuthority;
  readonly routerOrigin: URL;
  readonly files: {
    readonly stateDirectory: string;
    readonly privateKeyPath: string;
    readonly admissionCredentialPath: string;
  };
}): Effect.Effect<VerifiedDaemonListener, NetworkError, Scope.Scope> {
  return Effect.gen(function* () {
    let lastFailure: NetworkError | undefined;
    for (let attempt = 0; attempt < DAEMON_LISTENER_ATTEMPTS; attempt += 1) {
      const outcome = yield* acquireVerifiedDaemonListenerAttempt(input).pipe(
        Effect.either,
      );
      const result = Either.match(outcome, {
        onLeft: (failure) => ({
          failure,
          listener: Option.none<VerifiedDaemonListener>(),
        }),
        onRight: (listener) => ({
          failure: undefined,
          listener: Option.some(listener),
        }),
      });
      if (Option.isSome(result.listener)) {
        return result.listener.value;
      }
      lastFailure = result.failure;
    }
    return yield* Effect.fail(
      boundaryFailure(
        `controlled daemon listener handoff failed after ${String(DAEMON_LISTENER_ATTEMPTS)} attempts: ${lastFailure?.detail ?? "unknown failure"}`,
      ),
    );
  });
}

function startControlledDaemon<const Name extends string>(
  input: ControlledEndpointRuntimeInput,
  request: ControlledEndpointRequest<Name>,
): Effect.Effect<StartedControlledDaemon<Name>, NetworkError, Scope.Scope> {
  return Effect.gen(function* () {
    const name = yield* Schema.decodeUnknown(AgentName)(request.name).pipe(
      Effect.mapError(boundaryFailure),
    );
    const authority = yield* Effect.try({
      try: generateAgentDaemonAuthority,
      catch: boundaryFailure,
    });
    const files = yield* prepareEndpointFiles({
      authority: input.authority,
      privateKeyPem: authority.privateKeyPem,
    });
    const { daemon, endpoint } = yield* acquireVerifiedDaemonListener({
      authority: input.authority,
      routerOrigin: request.routerOrigin,
      files,
    });
    return Object.freeze({
      daemon,
      endpoint,
      name,
      operationId: authority.operationId,
      principalId: authority.principalId,
      request,
    });
  });
}

function acquireControlledEndpoint<const Name extends string>(
  input: ControlledEndpointRuntimeInput,
  request: ControlledEndpointRequest<Name>,
): Effect.Effect<AttachedEndpoint<Name>, NetworkError, Scope.Scope> {
  return Effect.gen(function* () {
    const daemon = yield* startControlledDaemon(input, request);
    yield* runRegistrar(
      registrarEnvironment({
        endpoint: daemon.endpoint,
        name: daemon.name,
        operationId: daemon.operationId,
        principalId: daemon.principalId,
      }),
    ).pipe(
      Effect.raceFirst(
        processTerminationFailure(daemon.daemon, "attach-endpoint"),
      ),
    );
    const client = yield* acquireHarnessClient(daemon.endpoint).pipe(
      Effect.mapError(() =>
        boundaryFailure("controlled daemon MCP connection failed"),
      ),
      Effect.raceFirst(
        processTerminationFailure(daemon.daemon, "attach-endpoint"),
      ),
    );
    const participant = makeParticipantHandle(
      daemon.request.name,
      yield* input.resolveAgentId(daemon.name),
    );
    yield* ensureProcessRunning(daemon.daemon);
    return Object.freeze({
      participant,
      transport: Object.freeze({
        received: receivedTurns(client, daemon.daemon),
        start: (startInput: StartInput) =>
          startConversation(client, startInput),
      }),
    });
  }).pipe(Effect.withSpan("Simulator.acquireControlledEndpoint"));
}
