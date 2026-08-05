/** @file Scope-owned production MoltZap router process for the controller. */
// safer-arch-ignore no-fat-orchestrator: This private controller entry point composes one complete production-router lifetime behind the narrow RouterProvider contract.

import { FileSystem, HttpClient } from "@effect/platform";
import type {
  CommandExecutor,
  ExitCode,
  Process,
} from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { registerAgent } from "@moltzap/client/auth";
import { agentConversationCreate } from "@moltzap/protocol/conversation";
import type { AgentId, AgentKey, AgentName } from "@moltzap/protocol/identity";
import {
  messageReceivedNotificationDefinition,
  messagesSend,
} from "@moltzap/protocol/message";
import {
  httpBaseUrl,
  serverBaseUrl,
  type ServerBaseUrl,
} from "@moltzap/protocol/network";
import { MoltZapAgentClient } from "@moltzap/protocol/socket";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  type Fiber,
  Layer,
  Redacted,
  Schedule,
  Scope,
  Stream,
} from "effect";
import {
  baseChildEnvironmentConfig,
  escalatingKill,
  makeExactEnvironmentCommand,
  type ProcessTreeCleanup,
  startSupervisedProcess,
} from "./command.js";
import { resolveInstalledPackageBin } from "./packages.js";
import {
  messageDatabasePathForVolume,
  type MessageDatabasePath,
  readCommittedRouterMessages,
} from "./messages.js";
import {
  routerProviderLayer,
  RouterOperations,
  type RouterDriver,
} from "../driver.js";
import {
  makeRouterStopReport,
  type CommittedRouterMessage,
  type EndpointTransport,
  type ParticipantIds,
  type RouterProvider,
  type RouterStopped,
} from "../router.js";
import { networkError } from "../failure.js";
const LOOPBACK_HOST = "127.0.0.1";
/** Port owned by the controller-local production router process. */
export const SERVER_CONTAINER_PORT = 3000;
const SERVER_REGISTRATION_SECRET_ENV = "MOLTZAP_REGISTRATION_SECRET";
const SERVER_HEALTH_POLL_MS = 250;
const REGISTRATION_SECRET_BYTES = 32;
const SERVER_TERM_WAIT_MS = 10_000;
const SERVER_KILL_WAIT_MS = 5_000;
const SERVER_CLEANUP_TIMEOUT = Duration.seconds(20);
const SERVER_CONFIG_FILE = "moltzap.yaml";
const SERVER_PACKAGE = "@moltzap/server-core";
const SERVER_BIN = "moltzap-server";
const SERVER_ADMIN_USER_ID = "5f1cbf1e-0d68-4b04-9c1a-2a0f5f0a1c31";
const LOOPBACK_SERVER_URL = serverBaseUrl(
  `ws://${LOOPBACK_HOST}:${String(SERVER_CONTAINER_PORT)}/ws`,
);

type RunRegistrationSecret = Redacted.Redacted;

interface RouterIdentity {
  readonly agentId: AgentId;
  readonly key: AgentKey;
}

interface ServerProcessStart {
  readonly binary: string;
  readonly configurationPath: string;
  readonly registrationSecret: RunRegistrationSecret;
  readonly runDirectory: string;
}

interface ServerConfigurationInput {
  readonly databasePath: MessageDatabasePath;
  readonly port: number;
}

/**
 * Options for one controller-owned production router process.
 * @internal
 */
export interface ServerProcessRouterOptions {
  readonly advertisedServerUrl: ServerBaseUrl;
  readonly startupTimeout: Duration.Duration;
}

/**
 * Injectable process operations used by deterministic lifecycle tests.
 * @internal
 */
export interface ServerProcessRouterOperations<ProcessHandle> {
  readonly cleanupTimeout: Duration.Duration;
  readonly resolveBinary: Effect.Effect<string, unknown>;
  readonly createRunDirectory: Effect.Effect<string, unknown>;
  readonly writeConfiguration: (
    runDirectory: string,
    input: ServerConfigurationInput,
  ) => Effect.Effect<string, unknown>;
  readonly startProcess: (
    input: ServerProcessStart,
  ) => Effect.Effect<ProcessHandle, unknown>;
  readonly awaitHealthy: (
    address: ServerBaseUrl,
    startupTimeout: Duration.Duration,
  ) => Effect.Effect<void, unknown>;
  readonly register: (
    address: ServerBaseUrl,
    name: AgentName,
    registrationSecret: RunRegistrationSecret,
  ) => Effect.Effect<RouterIdentity, unknown>;
  readonly attachEndpoint: (
    address: ServerBaseUrl,
    key: AgentKey,
  ) => Effect.Effect<EndpointTransport, unknown, Scope.Scope>;
  readonly stopProcess: (
    process: ProcessHandle,
  ) => Effect.Effect<void, unknown>;
  readonly readCommittedMessages: (
    databasePath: MessageDatabasePath,
  ) => Effect.Effect<readonly CommittedRouterMessage[], unknown>;
  readonly removeRunDirectory: (
    runDirectory: string,
  ) => Effect.Effect<void, unknown>;
}

type ServerProcessOperation =
  | "resolve-binary"
  | "create-run-directory"
  | "write-configuration"
  | "create-registration-secret"
  | "start-process"
  | "wait-for-health"
  | "register-agent"
  | "cleanup";

class ServerProcessFailed extends Data.TaggedError("ServerProcessFailed")<{
  readonly operation: ServerProcessOperation;
  readonly detail: string;
}> {
  override get message(): string {
    return `MoltZap server process ${this.operation} failed: ${this.detail}`;
  }
}

const failureDetails: Readonly<
  Record<Exclude<ServerProcessOperation, "cleanup">, string>
> = {
  "resolve-binary": "the installed server binary is unavailable",
  "create-run-directory": "the run data directory could not be created",
  "write-configuration": "the run configuration could not be written",
  "create-registration-secret":
    "the run registration secret could not be created",
  "start-process": "the server child could not be started",
  "wait-for-health":
    "the server did not become healthy before the startup deadline",
  "register-agent": "the server rejected agent registration",
};

type OwnedRunDirectory =
  | { readonly _tag: "absent" }
  | { readonly _tag: "owned"; readonly path: string }
  | { readonly _tag: "removed" };

type OwnedProcess<ProcessHandle> =
  | { readonly _tag: "absent" }
  | { readonly _tag: "running"; readonly handle: ProcessHandle }
  | { readonly _tag: "stopped" };

interface OwnedResources<ProcessHandle> {
  runDirectory: OwnedRunDirectory;
  process: OwnedProcess<ProcessHandle>;
}

interface AcquiredProcess {
  readonly databasePath: MessageDatabasePath;
  readonly registrationSecret: RunRegistrationSecret;
  readonly startupTimeout: Duration.Duration;
}

interface StartedServerProcess {
  readonly proc: Process;
  readonly exitFiber: Fiber.RuntimeFiber<ExitCode, PlatformError>;
  readonly processTreeCleanup: ProcessTreeCleanup;
  readonly scope: Scope.CloseableScope;
}

function processFailure(
  operation: ServerProcessOperation,
  detail?: string,
): ServerProcessFailed {
  const safeDetail =
    detail ??
    (operation === "cleanup"
      ? "server process cleanup did not complete"
      : failureDetails[operation]);
  return new ServerProcessFailed({
    operation,
    detail: safeDetail,
  });
}

function atStage<A, R>(
  operation: Exclude<ServerProcessOperation, "cleanup">,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, ServerProcessFailed, R> {
  return effect.pipe(Effect.mapError(() => processFailure(operation)));
}

function makeRunRegistrationSecret(): Effect.Effect<
  RunRegistrationSecret,
  ServerProcessFailed
> {
  return Effect.try({
    try: () =>
      Redacted.make(
        randomBytes(REGISTRATION_SECRET_BYTES).toString("base64url"),
      ),
    catch: () => processFailure("create-registration-secret"),
  });
}

/**
 * Render the secret-free server configuration persisted in a run directory.
 * @param input Value supplied to the operation.
 * @internal
 * @returns The rendered server configuration.
 */
export function renderServerProcessConfiguration(
  input: ServerConfigurationInput,
): string {
  return [
    `admin_user_id: ${SERVER_ADMIN_USER_ID}`,
    "registration:",
    `  secret: "\${${SERVER_REGISTRATION_SECRET_ENV}}"`,
    "server:",
    `  port: ${String(input.port)}`,
    "  cors_origins:",
    '    - "*"',
    "database:",
    `  data_dir: ${JSON.stringify(input.databasePath)}`,
    "",
  ].join("\n");
}

function endpointMessages(
  client: MoltZapAgentClient,
): Effect.Effect<EndpointTransport["received"], never, Scope.Scope> {
  return client
    .subscribeScoped(messageReceivedNotificationDefinition)
    .pipe(
      Effect.map((received) =>
        received.pipe(
          Stream.mapError((cause) => networkError("receive", cause)),
        ),
      ),
    );
}

function openConversationWith(
  client: MoltZapAgentClient,
): EndpointTransport["openConversation"] {
  return (participants: ParticipantIds) =>
    client
      .callDefinition(agentConversationCreate, {
        participants,
      })
      .pipe(
        Effect.mapError((cause) => networkError("open-conversation", cause)),
        Effect.map((result) => ({ conversationId: result.conversation.id })),
      );
}

function sendWith(client: MoltZapAgentClient): EndpointTransport["send"] {
  return (conversationId, parts) =>
    client.callDefinition(messagesSend, { conversationId, parts }).pipe(
      Effect.map((result) => result.message),
      Effect.mapError((cause) => networkError("send", cause)),
    );
}

function endpointTransport(
  address: ServerBaseUrl,
  key: AgentKey,
): Effect.Effect<EndpointTransport, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const client = new MoltZapAgentClient({
      serverUrl: httpBaseUrl(address),
      agentKey: key,
    });
    yield* Effect.addFinalizer(() => client.close());
    const received = yield* endpointMessages(client);
    yield* client.connect();
    return {
      received,
      openConversation: openConversationWith(client),
      send: sendWith(client),
    };
  });
}

function awaitServerHealthy(
  address: ServerBaseUrl,
  startupTimeout: Duration.Duration,
): Effect.Effect<void, unknown> {
  const healthUrl = `${httpBaseUrl(address)}/health`;
  const probe = HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(healthUrl)),
    Effect.map((response) => response.status === 200),
    Effect.orElseSucceed(() => false),
  );
  return probe.pipe(
    Effect.filterOrFail(
      (healthy) => healthy,
      () => undefined,
    ),
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(SERVER_HEALTH_POLL_MS)),
    }),
    Effect.timeout(startupTimeout),
    Effect.asVoid,
    Effect.provide(NodeHttpClient.layer),
  );
}

function registerIdentity(
  address: ServerBaseUrl,
  name: AgentName,
  registrationSecret: RunRegistrationSecret,
): Effect.Effect<RouterIdentity, unknown> {
  return registerAgent(httpBaseUrl(address), name, {
    inviteCode: Redacted.value(registrationSecret),
  }).pipe(
    Effect.map((identity) => ({
      agentId: identity.agentId,
      key: identity.apiKey,
    })),
  );
}

function startServerProcess(
  input: ServerProcessStart,
): Effect.Effect<StartedServerProcess, unknown, CommandExecutor> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const baseEnvironment = yield* baseChildEnvironmentConfig;
      const scope = yield* Scope.make();
      const processTreeCleanup: ProcessTreeCleanup = {
        claimed: false,
        launcherOwnsExitCleanup: true,
      };
      const command = makeExactEnvironmentCommand({
        command: input.binary,
        args: [],
        cwd: input.runDirectory,
        cleanupTreeOnExit: true,
        env: {
          ...baseEnvironment,
          HOME: input.runDirectory,
          NODE_ENV: "production",
          MOLTZAP_CONFIG: input.configurationPath,
          PORT: String(SERVER_CONTAINER_PORT),
          [SERVER_REGISTRATION_SECRET_ENV]: Redacted.value(
            input.registrationSecret,
          ),
        },
      });
      const started = yield* restore(
        startSupervisedProcess(
          command,
          scope,
          () => undefined,
          processTreeCleanup,
        ),
      ).pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
      return { ...started, scope };
    }),
  );
}

function stopServerProcess(process: StartedServerProcess): Effect.Effect<void> {
  return escalatingKill(
    process.proc,
    process.exitFiber,
    {
      termWaitMs: SERVER_TERM_WAIT_MS,
      killWaitMs: SERVER_KILL_WAIT_MS,
    },
    process.processTreeCleanup,
  ).pipe(Effect.zipRight(Scope.close(process.scope, Exit.void)));
}

function realServerProcessOperations(): ServerProcessRouterOperations<StartedServerProcess> {
  const provideNode = Effect.provide(NodeContext.layer);
  return {
    cleanupTimeout: SERVER_CLEANUP_TIMEOUT,
    resolveBinary: Effect.try({
      try: () => resolveInstalledPackageBin(SERVER_PACKAGE, SERVER_BIN),
      catch: () => undefined,
    }),
    createRunDirectory: provideNode(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem.makeTempDirectory({
            prefix: "moltzap-controller-router-",
          }),
        ),
      ),
    ),
    writeConfiguration: (runDirectory, input) => {
      const configurationPath = join(runDirectory, SERVER_CONFIG_FILE);
      return provideNode(
        FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) =>
            fileSystem.writeFileString(
              configurationPath,
              renderServerProcessConfiguration(input),
            ),
          ),
          Effect.as(configurationPath),
        ),
      );
    },
    startProcess: (input) => provideNode(startServerProcess(input)),
    awaitHealthy: awaitServerHealthy,
    register: registerIdentity,
    attachEndpoint: endpointTransport,
    stopProcess: stopServerProcess,
    readCommittedMessages: readCommittedRouterMessages,
    removeRunDirectory: (runDirectory) =>
      provideNode(
        FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) =>
            fileSystem.remove(runDirectory, { recursive: true, force: true }),
          ),
        ),
      ),
  };
}

function emptyOwnedResources<ProcessHandle>(): OwnedResources<ProcessHandle> {
  return {
    runDirectory: { _tag: "absent" },
    process: { _tag: "absent" },
  };
}

function claimResource<A, E, R>(
  acquire: Effect.Effect<A, E, R>,
  claim: (resource: A) => void,
): Effect.Effect<A, E, R> {
  return Effect.uninterruptibleMask((restore) =>
    restore(acquire).pipe(
      Effect.tap((resource) =>
        Effect.sync(() => {
          claim(resource);
        }),
      ),
    ),
  );
}

function captureCleanup(
  label: "server-process" | "server-run-directory",
  effect: Effect.Effect<void, unknown>,
  timeout: Duration.Duration,
  confirm: () => void,
): Effect.Effect<readonly string[]> {
  return effect.pipe(
    Effect.interruptible,
    Effect.timeout(timeout),
    Effect.tap(() => Effect.sync(confirm)),
    Effect.exit,
    Effect.map((result) => (Exit.isSuccess(result) ? [] : [label])),
  );
}

function stopOwnedProcess<ProcessHandle>(
  operations: ServerProcessRouterOperations<ProcessHandle>,
  owned: OwnedResources<ProcessHandle>,
  permit: Effect.Semaphore,
): Effect.Effect<readonly string[]> {
  return permit
    .withPermits(1)(
      Effect.suspend(() => {
        if (owned.process._tag !== "running") {
          return Effect.succeed([]);
        }
        return captureCleanup(
          "server-process",
          operations.stopProcess(owned.process.handle),
          operations.cleanupTimeout,
          () => {
            owned.process = { _tag: "stopped" };
          },
        );
      }),
    )
    .pipe(Effect.uninterruptible);
}

function removeOwnedRunDirectory<ProcessHandle>(
  operations: ServerProcessRouterOperations<ProcessHandle>,
  owned: OwnedResources<ProcessHandle>,
  permit: Effect.Semaphore,
): Effect.Effect<readonly string[]> {
  return permit.withPermits(1)(
    Effect.suspend(() => {
      if (owned.runDirectory._tag !== "owned") {
        return Effect.succeed([]);
      }
      if (owned.process._tag === "running") {
        return Effect.succeed(["server-run-directory"]);
      }
      return captureCleanup(
        "server-run-directory",
        operations.removeRunDirectory(owned.runDirectory.path),
        operations.cleanupTimeout,
        () => {
          owned.runDirectory = { _tag: "removed" };
        },
      );
    }),
  );
}

function cleanupAll<ProcessHandle>(
  operations: ServerProcessRouterOperations<ProcessHandle>,
  owned: OwnedResources<ProcessHandle>,
  permit: Effect.Semaphore,
): Effect.Effect<readonly string[]> {
  return Effect.gen(function* () {
    const processFailures = yield* stopOwnedProcess(operations, owned, permit);
    const directoryFailures = yield* removeOwnedRunDirectory(
      operations,
      owned,
      permit,
    );
    return [...processFailures, ...directoryFailures];
  });
}

function acquireProcess<ProcessHandle>(
  startupTimeout: Duration.Duration,
  operations: ServerProcessRouterOperations<ProcessHandle>,
  owned: OwnedResources<ProcessHandle>,
): Effect.Effect<AcquiredProcess, ServerProcessFailed> {
  return Effect.gen(function* () {
    const binary = yield* atStage("resolve-binary", operations.resolveBinary);
    const runDirectory = yield* claimResource(
      atStage("create-run-directory", operations.createRunDirectory),
      (path) => {
        owned.runDirectory = { _tag: "owned", path };
      },
    );
    const databasePath = messageDatabasePathForVolume(runDirectory);
    const configurationPath = yield* atStage(
      "write-configuration",
      operations.writeConfiguration(runDirectory, {
        databasePath,
        port: SERVER_CONTAINER_PORT,
      }),
    );
    const registrationSecret = yield* makeRunRegistrationSecret();
    yield* claimResource(
      atStage(
        "start-process",
        operations.startProcess({
          binary,
          configurationPath,
          registrationSecret,
          runDirectory,
        }),
      ),
      (handle) => {
        owned.process = { _tag: "running", handle };
      },
    );
    yield* atStage(
      "wait-for-health",
      operations.awaitHealthy(LOOPBACK_SERVER_URL, startupTimeout),
    );
    return { databasePath, registrationSecret, startupTimeout };
  });
}

function boundedOperation<A, E, R>(
  timeout: Duration.Duration,
  effect: Effect.Effect<A, E, R>,
) {
  return effect.pipe(Effect.interruptible, Effect.timeout(timeout));
}

function collectStoppedRouter<ProcessHandle>(
  acquired: AcquiredProcess,
  operations: ServerProcessRouterOperations<ProcessHandle>,
  owned: OwnedResources<ProcessHandle>,
  permit: Effect.Semaphore,
): Effect.Effect<RouterStopped, ReturnType<typeof networkError>> {
  return Effect.gen(function* () {
    yield* stopOwnedProcess(operations, owned, permit).pipe(
      Effect.flatMap((failures) =>
        failures.length === 0 && owned.process._tag === "stopped"
          ? Effect.void
          : Effect.fail(
              networkError(
                "stop-router",
                "the controller router process could not be terminated",
              ),
            ),
      ),
    );
    const messages = yield* operations
      .readCommittedMessages(acquired.databasePath)
      .pipe(
        Effect.mapError(() =>
          networkError(
            "stop-router",
            "committed router messages could not be read",
          ),
        ),
      );
    return makeRouterStopReport(messages);
  });
}

function makeDriver<ProcessHandle>(
  advertisedServerUrl: ServerBaseUrl,
  acquired: AcquiredProcess,
  operations: ServerProcessRouterOperations<ProcessHandle>,
  runtime: {
    readonly owned: OwnedResources<ProcessHandle>;
    readonly permit: Effect.Semaphore;
  },
): RouterDriver {
  return {
    address: advertisedServerUrl,
    register: (name) =>
      atStage(
        "register-agent",
        boundedOperation(
          acquired.startupTimeout,
          operations.register(
            LOOPBACK_SERVER_URL,
            name,
            acquired.registrationSecret,
          ),
        ),
      ),
    attachEndpoint: (key) =>
      operations.attachEndpoint(LOOPBACK_SERVER_URL, key),
    stopAndCollect: collectStoppedRouter(
      acquired,
      operations,
      runtime.owned,
      runtime.permit,
    ),
  };
}

function finalRelease<ProcessHandle>(
  operations: ServerProcessRouterOperations<ProcessHandle>,
  owned: OwnedResources<ProcessHandle>,
  permit: Effect.Semaphore,
): Effect.Effect<void> {
  return cleanupAll(operations, owned, permit).pipe(
    Effect.flatMap((failures) =>
      failures.length === 0
        ? Effect.void
        : Effect.logError("MoltZap server process cleanup was incomplete").pipe(
            Effect.annotateLogs({ resources: failures.join(",") }),
          ),
    ),
    Effect.uninterruptible,
  );
}

function acquireServerProcessDriver<ProcessHandle>(
  options: ServerProcessRouterOptions,
  operations: ServerProcessRouterOperations<ProcessHandle>,
): Effect.Effect<RouterDriver, unknown, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const owned = emptyOwnedResources<ProcessHandle>();
      const permit = yield* Effect.makeSemaphore(1);
      const attempt = yield* restore(
        acquireProcess(options.startupTimeout, operations, owned),
      ).pipe(Effect.exit);
      if (Exit.isFailure(attempt)) {
        const cleanupFailures = yield* cleanupAll(operations, owned, permit);
        if (cleanupFailures.length > 0) {
          if (Cause.isInterruptedOnly(attempt.cause)) {
            yield* Effect.logError(
              "Interrupted MoltZap server process acquisition left incomplete cleanup",
            );
            return yield* Effect.failCause(attempt.cause);
          }
          return yield* processFailure(
            "cleanup",
            "server process acquisition cleanup did not complete",
          );
        }
        return yield* Effect.failCause(attempt.cause);
      }
      yield* Effect.addFinalizer(() => finalRelease(operations, owned, permit));
      return makeDriver(
        options.advertisedServerUrl,
        attempt.value,
        operations,
        { owned, permit },
      );
    }),
  ).pipe(Effect.withSpan("acquireMoltZapServerProcess"));
}

/**
 * Install a controller-owned server process as the run's router driver.
 * @param options Advertised Service URL and startup deadline.
 * @param operations Injectable lifecycle operations.
 * @internal
 * @returns A Layer providing the router driver acquirer.
 */
export function serverProcessRouterOperationsLayer<ProcessHandle>(
  options: ServerProcessRouterOptions,
  operations: ServerProcessRouterOperations<ProcessHandle>,
): Layer.Layer<RouterOperations> {
  return Layer.succeed(RouterOperations, (driverOptions) =>
    acquireServerProcessDriver(
      {
        advertisedServerUrl: options.advertisedServerUrl,
        startupTimeout: driverOptions.startupTimeout,
      },
      operations,
    ),
  );
}

/**
 * Publish the package-private router service backed by a real server process.
 * @param options Advertised Service URL and startup deadline.
 * @internal
 * @returns A Layer providing the controller router service.
 */
export function serverProcessRouterProviderLayer(
  options: ServerProcessRouterOptions,
): Layer.Layer<RouterProvider> {
  return routerProviderLayer({ startupTimeout: options.startupTimeout }).pipe(
    Layer.provide(
      serverProcessRouterOperationsLayer(
        options,
        realServerProcessOperations(),
      ),
    ),
  );
}
