/**
 * @file Scoped ownership of the MoltZap server used by a simulation run.
 * This boundary owns only the server substrate: a fresh
 * PGlite volume, the container, and identities minted against that server.
 */
import { FileSystem, HttpClient } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { registerAgent } from "@moltzap/client/auth";
import type { AgentName, AgentId, AgentKey } from "@moltzap/protocol/identity";
import {
  httpBaseUrl,
  serverBaseUrl,
  type ServerBaseUrl,
} from "@moltzap/protocol/network";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Cause,
  type Context,
  Duration,
  Effect,
  Exit,
  Redacted,
  Schedule,
  Schema,
  type Scope,
} from "effect";
import {
  messageDatabasePathForVolume,
  type MessageDatabasePath,
} from "./message-store.js";
import {
  type ImageDigest,
  moltZapServerContainerUser,
  moltZapServerRunArgs,
  resolveServerImage,
  runServerCommand,
  SERVER_COMMAND_TIMEOUT,
  SERVER_CONTAINER_PORT,
  SERVER_DATA_MOUNT,
  SERVER_REGISTRATION_SECRET_ENV,
} from "./server-image.js";

const LOOPBACK_HOST = "127.0.0.1";
const SERVER_HEALTH_POLL_MS = 250;
const REGISTRATION_SECRET_BYTES = 32;
const SERVER_VOLUME_ROOT = join(
  homedir(),
  ".cache",
  "moltzap-simulator",
  "server-volumes",
);
const dockerSecurityOptions = Schema.parseJson(Schema.Array(Schema.String));

const moltZapServerOperation = Schema.Literal(
  "resolve-image",
  "create-volume",
  "start-container",
  "resolve-port",
  "wait-for-health",
  "verify-mount",
  "register-agent",
  "cleanup",
);

type MoltZapServerOperation = typeof moltZapServerOperation.Type;

/** The single failure vocabulary exposed by the MoltZap server boundary. */
export class MoltZapServerFailed extends Schema.TaggedError<MoltZapServerFailed>()(
  "MoltZapServerFailed",
  {
    operation: moltZapServerOperation,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `MoltZap server ${this.operation} failed: ${this.detail}`;
  }
}

interface MoltZapServerIdentity {
  readonly agentId: AgentId;
  readonly key: AgentKey;
}

type RunRegistrationSecret = Redacted.Redacted;

function makeRunRegistrationSecret(): RunRegistrationSecret {
  return Redacted.make(
    randomBytes(REGISTRATION_SECRET_BYTES).toString("base64url"),
  );
}

/** Configures acquire molt zap server. */
export interface AcquireMoltZapServerOptions {
  /** A local content-addressed image id. Omit it to build the package image. */
  readonly image?: ImageDigest;
  readonly readyTimeout: Duration.Duration;
}

/** Describes molt zap server. */
export interface MoltZapServer {
  readonly image: ImageDigest;
  readonly serverUrl: ServerBaseUrl;
  /** Exact stopped-store path fixed by the owned server image. */
  readonly messageDatabasePath: MessageDatabasePath;
  readonly register: (
    name: AgentName,
  ) => Effect.Effect<MoltZapServerIdentity, MoltZapServerFailed>;

  /**
   * Stop the container once while retaining the volume until scope close, so
   * traffic collection can open PGlite safely.
   */
  readonly stop: () => Effect.Effect<void, MoltZapServerFailed>;
}

type MoltZapServerStopReport =
  | {
      /** The traffic volume is safe to open only in this state. */
      readonly _tag: "stopped";
      readonly failures: readonly string[];
    }
  | {
      readonly _tag: "running";
      readonly failures: readonly string[];
    };

/**
 * Injectable effects keep partial-acquisition tests hermetic.
 * @internal
 */
export interface MoltZapServerOperations {
  readonly cleanupTimeout: Duration.Duration;
  readonly resolveImage: (
    image?: ImageDigest,
  ) => Effect.Effect<ImageDigest, unknown>;
  readonly createVolume: Effect.Effect<string, unknown>;
  readonly removeVolume: (volumePath: string) => Effect.Effect<void, unknown>;
  readonly startContainer: (
    image: ImageDigest,
    volumePath: string,
    containerName: string,
    registrationSecret: RunRegistrationSecret,
  ) => Effect.Effect<string, unknown>;
  readonly resolveServerUrl: (
    containerId: string,
  ) => Effect.Effect<ServerBaseUrl, unknown>;
  readonly awaitHealthy: (
    serverUrl: ServerBaseUrl,
    readyTimeout: Duration.Duration,
  ) => Effect.Effect<void, unknown>;
  readonly verifyMount: (
    volumePath: string,
    containerId: string,
  ) => Effect.Effect<void, unknown>;
  readonly register: (
    serverUrl: ServerBaseUrl,
    name: AgentName,
    registrationSecret: RunRegistrationSecret,
  ) => Effect.Effect<MoltZapServerIdentity, unknown>;
  readonly stopContainer: (containerId: string) => Effect.Effect<void, unknown>;
}

type OwnedVolume =
  | { readonly _tag: "absent" }
  | { readonly _tag: "mounted"; readonly path: string }
  | { readonly _tag: "removed" };

type OwnedContainer =
  | { readonly _tag: "absent" }
  | { readonly _tag: "may-be-running"; readonly name: string }
  | { readonly _tag: "stopped" };

interface OwnedResources {
  volume: OwnedVolume;
  container: OwnedContainer;
}

interface AcquiredServer {
  readonly image: ImageDigest;
  readonly serverUrl: ServerBaseUrl;
  readonly volumePath: string;
  readonly readyTimeout: Duration.Duration;
  readonly registrationSecret: RunRegistrationSecret;
}

interface ServerStart {
  readonly image: ImageDigest;
  readonly readyTimeout: Duration.Duration;
  readonly volumePath: string;
}

function failed(
  operation: MoltZapServerOperation,
  cause: unknown,
): MoltZapServerFailed {
  return MoltZapServerFailed.make({
    operation,
    detail: String(cause),
  });
}

function atStage<A, R>(
  operation: MoltZapServerOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, MoltZapServerFailed, R> {
  return effect.pipe(Effect.mapError((cause) => failed(operation, cause)));
}

function parsePublishedPort(output: string): Effect.Effect<string, string> {
  const port = output.trim().split("\n")[0]?.split(":").at(-1);
  return port === undefined || port.length === 0
    ? Effect.fail(`unparseable docker port output: ${output}`)
    : Effect.succeed(port);
}

function resolveServerUrl(
  containerId: string,
): Effect.Effect<ServerBaseUrl, unknown, CommandExecutor> {
  return runServerCommand([
    "docker",
    "port",
    containerId,
    `${String(SERVER_CONTAINER_PORT)}/tcp`,
  ]).pipe(
    Effect.flatMap(parsePublishedPort),
    Effect.flatMap((port) =>
      Effect.try({
        try: () => serverBaseUrl(`ws://${LOOPBACK_HOST}:${port}/ws`),
        catch: String,
      }),
    ),
  );
}

function awaitServerHealthy(
  serverUrl: ServerBaseUrl,
  readyTimeout: Duration.Duration,
): Effect.Effect<void, string, HttpClient.HttpClient> {
  const healthUrl = `${httpBaseUrl(serverUrl)}/health`;
  const probe = HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(healthUrl)),
    Effect.map((response) => response.status === 200),
    Effect.orElseSucceed(() => false),
  );
  return probe.pipe(
    Effect.filterOrFail(
      (healthy) => healthy,
      () => "not ready",
    ),
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(SERVER_HEALTH_POLL_MS)),
    }),
    Effect.timeoutFail({
      duration: readyTimeout,
      onTimeout: () =>
        `health endpoint did not answer within ${Duration.format(readyTimeout)}`,
    }),
    Effect.mapError(
      () =>
        `health endpoint did not answer within ${Duration.format(readyTimeout)}`,
    ),
    Effect.asVoid,
  );
}

function verifyMount(
  volumePath: string,
  containerId: string,
): Effect.Effect<void, unknown, FileSystem.FileSystem | CommandExecutor> {
  const sentinel = `.mount-probe-${containerId.slice(0, 12)}`;
  const hostPath = join(volumePath, sentinel);
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem
        .writeFileString(hostPath, containerId)
        .pipe(
          Effect.zipRight(
            runServerCommand([
              "docker",
              "exec",
              containerId,
              "test",
              "-f",
              `${SERVER_DATA_MOUNT}/${sentinel}`,
            ]),
          ),
          Effect.ensuring(fileSystem.remove(hostPath).pipe(Effect.ignore)),
        ),
    ),
    Effect.asVoid,
  );
}

function registerIdentity(
  serverUrl: ServerBaseUrl,
  name: AgentName,
  registrationSecret: RunRegistrationSecret,
): Effect.Effect<MoltZapServerIdentity, unknown> {
  return registerAgent(httpBaseUrl(serverUrl), name, {
    inviteCode: Redacted.value(registrationSecret),
  }).pipe(
    Effect.map((identity) => ({
      agentId: identity.agentId,
      key: identity.apiKey,
    })),
  );
}

const createServerVolume = FileSystem.FileSystem.pipe(
  Effect.flatMap((fileSystem) =>
    fileSystem.makeDirectory(SERVER_VOLUME_ROOT, { recursive: true }).pipe(
      Effect.andThen(
        fileSystem.makeTempDirectory({
          directory: SERVER_VOLUME_ROOT,
          prefix: "moltzap-sim-server-",
        }),
      ),
    ),
  ),
);

function stopServerContainer(
  containerName: string,
): Effect.Effect<void, string, CommandExecutor> {
  return runServerCommand(["docker", "stop", containerName]).pipe(
    Effect.asVoid,
    Effect.catchAll((detail) =>
      detail.includes("No such container") ? Effect.void : Effect.fail(detail),
    ),
  );
}

/** Represents molt zap server host values. */
export type MoltZapServerHost =
  | CommandExecutor
  | FileSystem.FileSystem
  | HttpClient.HttpClient;

function resolveServerContainerUser(): Effect.Effect<
  string | undefined,
  unknown,
  CommandExecutor
> {
  if (
    process.platform !== "linux" ||
    process.getuid === undefined ||
    process.getgid === undefined
  ) {
    return Effect.succeed(undefined);
  }
  const uid = process.getuid();
  const gid = process.getgid();
  return runServerCommand([
    "docker",
    "info",
    "--format",
    "{{json .SecurityOptions}}",
  ]).pipe(
    Effect.flatMap(Schema.decodeUnknown(dockerSecurityOptions)),
    Effect.flatMap((securityOptions) => {
      const containerUser = moltZapServerContainerUser(
        uid,
        gid,
        securityOptions,
      );
      return containerUser === null
        ? Effect.fail(
            "Docker userns-remap cannot safely write the simulator's host-owned server volume",
          )
        : Effect.succeed(containerUser);
    }),
  );
}

function startServerContainer(
  image: ImageDigest,
  volumePath: string,
  containerName: string,
  registrationSecret: RunRegistrationSecret,
): Effect.Effect<string, unknown, CommandExecutor> {
  return resolveServerContainerUser().pipe(
    Effect.flatMap((containerUser) =>
      runServerCommand(
        moltZapServerRunArgs(image, volumePath, containerName, containerUser),
        {
          environment: {
            [SERVER_REGISTRATION_SECRET_ENV]:
              Redacted.value(registrationSecret),
          },
        },
      ),
    ),
    Effect.map((output) => output.trim()),
    Effect.filterOrFail(
      (containerId) => containerId.length > 0,
      () => "docker run printed no container id",
    ),
  );
}

function makeMoltZapServerOperations(
  host: Context.Context<MoltZapServerHost>,
): MoltZapServerOperations {
  const provideHost = Effect.provide(host);
  return {
    cleanupTimeout: SERVER_COMMAND_TIMEOUT,
    resolveImage: (image) => provideHost(resolveServerImage(image)),
    createVolume: provideHost(createServerVolume),
    removeVolume: (volumePath) =>
      provideHost(
        FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) =>
            fileSystem.remove(volumePath, { recursive: true, force: true }),
          ),
        ),
      ),
    startContainer: (image, volumePath, containerName, registrationSecret) =>
      provideHost(
        startServerContainer(
          image,
          volumePath,
          containerName,
          registrationSecret,
        ),
      ),
    resolveServerUrl: (containerId) =>
      provideHost(resolveServerUrl(containerId)),
    awaitHealthy: (serverUrl, readyTimeout) =>
      provideHost(awaitServerHealthy(serverUrl, readyTimeout)),
    verifyMount: (volumePath, containerId) =>
      provideHost(verifyMount(volumePath, containerId)),
    register: registerIdentity,
    stopContainer: (containerId) =>
      provideHost(stopServerContainer(containerId)),
  };
}

function emptyOwnedResources(): OwnedResources {
  return {
    volume: { _tag: "absent" },
    container: { _tag: "absent" },
  };
}

function captureCleanup(
  label: string,
  effect: Effect.Effect<void, unknown>,
  timeout: Duration.Duration,
  confirm: () => void,
): Effect.Effect<readonly string[]> {
  return effect.pipe(
    // Scope finalizers are uninterruptible, so restore interruption locally.
    // The timeout waits for the owned operation to terminate before reporting.
    Effect.interruptible,
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () =>
        `${label} did not finish within ${Duration.format(timeout)}`,
    }),
    Effect.tap(() => Effect.sync(confirm)),
    Effect.exit,
    Effect.map((exit) =>
      Exit.isSuccess(exit) ? [] : [`${label}: ${Cause.pretty(exit.cause)}`],
    ),
  );
}

function stopContainer(
  operations: MoltZapServerOperations,
  owned: OwnedResources,
): Effect.Effect<readonly string[]> {
  if (owned.container._tag !== "may-be-running") {
    return Effect.succeed([]);
  }
  const containerName = owned.container.name;
  return captureCleanup(
    "server-container",
    operations.stopContainer(containerName),
    operations.cleanupTimeout,
    () => {
      owned.container = { _tag: "stopped" };
    },
  );
}

function removeVolume(
  operations: MoltZapServerOperations,
  owned: OwnedResources,
): Effect.Effect<readonly string[]> {
  if (owned.volume._tag !== "mounted") {
    return Effect.succeed([]);
  }
  if (owned.container._tag === "may-be-running") {
    return Effect.succeed([
      "server-volume: retained because container stop was not confirmed",
    ]);
  }
  const volumePath = owned.volume.path;
  return captureCleanup(
    "server-volume",
    operations.removeVolume(volumePath),
    operations.cleanupTimeout,
    () => {
      owned.volume = { _tag: "removed" };
    },
  );
}

function cleanupServer(
  operations: MoltZapServerOperations,
  owned: OwnedResources,
): Effect.Effect<readonly string[]> {
  return stopContainer(operations, owned);
}

function cleanupAll(
  operations: MoltZapServerOperations,
  owned: OwnedResources,
): Effect.Effect<readonly string[]> {
  return Effect.gen(function* () {
    const serverFailures = yield* cleanupServer(operations, owned);
    const volumeFailures = yield* removeVolume(operations, owned);
    return [...serverFailures, ...volumeFailures];
  });
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

function boundedOperation<A, E, R>(
  label: string,
  timeout: Duration.Duration,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | string, R> {
  return effect.pipe(
    Effect.interruptible,
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () =>
        `${label} did not finish within ${Duration.format(timeout)}`,
    }),
  );
}

function resolveRouterImage(
  options: AcquireMoltZapServerOptions,
  operations: MoltZapServerOperations,
): Effect.Effect<ImageDigest, MoltZapServerFailed> {
  return Effect.logInfo(
    "Preparing the MoltZap router image; the first build can take several minutes",
  ).pipe(
    Effect.annotateLogs({
      component: "moltzap-router",
      operation: "resolve-image",
    }),
    Effect.zipRight(
      atStage("resolve-image", operations.resolveImage(options.image)),
    ),
    Effect.tap((image) =>
      Effect.logInfo("MoltZap router image ready").pipe(
        Effect.annotateLogs({
          component: "moltzap-router",
          operation: "resolve-image",
          image,
        }),
      ),
    ),
  );
}

function claimVolume(
  operations: MoltZapServerOperations,
  owned: OwnedResources,
): Effect.Effect<string, MoltZapServerFailed> {
  return claimResource(
    atStage("create-volume", operations.createVolume),
    (path) => {
      owned.volume = { _tag: "mounted", path };
    },
  );
}

function startServer(
  input: ServerStart,
  operations: MoltZapServerOperations,
  owned: OwnedResources,
): Effect.Effect<AcquiredServer, MoltZapServerFailed> {
  return Effect.gen(function* () {
    const containerName = `moltzap-sim-${randomUUID()}`;
    const registrationSecret = makeRunRegistrationSecret();
    owned.container = { _tag: "may-be-running", name: containerName };
    yield* Effect.logInfo("Starting an isolated MoltZap router").pipe(
      Effect.annotateLogs({
        component: "moltzap-router",
        operation: "start-container",
      }),
    );
    const containerId = yield* atStage(
      "start-container",
      operations.startContainer(
        input.image,
        input.volumePath,
        containerName,
        registrationSecret,
      ),
    );
    const serverUrl = yield* atStage(
      "resolve-port",
      operations.resolveServerUrl(containerId),
    );
    yield* atStage(
      "wait-for-health",
      operations.awaitHealthy(serverUrl, input.readyTimeout),
    );
    yield* atStage(
      "verify-mount",
      operations.verifyMount(input.volumePath, containerId),
    );
    return {
      image: input.image,
      serverUrl,
      volumePath: input.volumePath,
      readyTimeout: input.readyTimeout,
      registrationSecret,
    };
  });
}

function acquireContainer(
  options: AcquireMoltZapServerOptions,
  operations: MoltZapServerOperations,
  owned: OwnedResources,
): Effect.Effect<AcquiredServer, MoltZapServerFailed> {
  return Effect.gen(function* () {
    const image = yield* resolveRouterImage(options, operations);
    const volumePath = yield* claimVolume(operations, owned);
    return yield* startServer(
      {
        image,
        volumePath,
        readyTimeout: options.readyTimeout,
      },
      operations,
      owned,
    );
  });
}

function acquireResources(
  options: AcquireMoltZapServerOptions,
  operations: MoltZapServerOperations,
  owned: OwnedResources,
): Effect.Effect<AcquiredServer, MoltZapServerFailed> {
  return Effect.gen(function* () {
    const container = yield* acquireContainer(options, operations, owned);
    yield* Effect.logInfo("MoltZap router ready").pipe(
      Effect.annotateLogs({
        component: "moltzap-router",
        operation: "wait-for-health",
        routerUrl: container.serverUrl,
      }),
    );
    return container;
  });
}

function stopReport(
  owned: OwnedResources,
  failures: readonly string[],
): MoltZapServerStopReport {
  return {
    _tag: owned.container._tag === "stopped" ? "stopped" : "running",
    failures,
  };
}

function stopOwnedServer(
  operations: MoltZapServerOperations,
  owned: OwnedResources,
  stopPermit: Effect.Semaphore,
): Effect.Effect<MoltZapServerStopReport> {
  return stopPermit
    .withPermits(1)(
      cleanupServer(operations, owned).pipe(
        Effect.map((failures) => stopReport(owned, failures)),
      ),
    )
    .pipe(Effect.uninterruptible);
}

function confirmTrafficSafeStop(
  report: MoltZapServerStopReport,
): Effect.Effect<void, MoltZapServerFailed> {
  if (report._tag === "running") {
    return Effect.fail(
      failed(
        "cleanup",
        `server container remained running: ${report.failures.join("; ")}`,
      ),
    );
  }
  return report.failures.length === 0
    ? Effect.void
    : Effect.logWarning(
        `MoltZap server stopped with cleanup warnings: ${report.failures.join("; ")}`,
      );
}

function makeServerHandle(
  acquired: AcquiredServer,
  owned: OwnedResources,
  operations: MoltZapServerOperations,
  stopPermit: Effect.Semaphore,
): MoltZapServer {
  return {
    image: acquired.image,
    serverUrl: acquired.serverUrl,
    messageDatabasePath: messageDatabasePathForVolume(acquired.volumePath),
    register: (name) =>
      atStage(
        "register-agent",
        boundedOperation(
          `agent registration for ${name}`,
          acquired.readyTimeout,
          operations.register(
            acquired.serverUrl,
            name,
            acquired.registrationSecret,
          ),
        ),
      ),
    stop: () =>
      stopOwnedServer(operations, owned, stopPermit).pipe(
        Effect.flatMap(confirmTrafficSafeStop),
      ),
  };
}

function finalRelease(
  operations: MoltZapServerOperations,
  owned: OwnedResources,
  stopPermit: Effect.Semaphore,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stopped = yield* stopOwnedServer(operations, owned, stopPermit);
    const volumeFailures = yield* stopPermit.withPermits(1)(
      removeVolume(operations, owned),
    );
    return [...stopped.failures, ...volumeFailures];
  }).pipe(
    Effect.uninterruptible,
    Effect.flatMap((failures) =>
      failures.length === 0
        ? Effect.void
        : Effect.logError(
            `MoltZap server cleanup was incomplete: ${failures.join("; ")}`,
          ),
    ),
  );
}

function installFinalizer(
  operations: MoltZapServerOperations,
  owned: OwnedResources,
  stopPermit: Effect.Semaphore,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.addFinalizer(() => finalRelease(operations, owned, stopPermit));
}

/**
 * Build an acquirer over explicit operations.
 * @param operations Value supplied to the operation.
 * @internal
 * @returns The created molt zap server acquirer.
 */
export function makeMoltZapServerAcquirer(
  operations: MoltZapServerOperations,
): (
  options: AcquireMoltZapServerOptions,
) => Effect.Effect<MoltZapServer, MoltZapServerFailed, Scope.Scope> {
  return (options) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const owned = emptyOwnedResources();
        const stopPermit = yield* Effect.makeSemaphore(1);
        const attempt = yield* restore(
          acquireResources(options, operations, owned),
        ).pipe(Effect.exit);
        if (Exit.isFailure(attempt)) {
          const cleanup = yield* cleanupAll(operations, owned);
          if (cleanup.length > 0) {
            if (Cause.isInterruptedOnly(attempt.cause)) {
              yield* Effect.logError(
                `Interrupted MoltZap server acquisition left incomplete cleanup: ${cleanup.join("; ")}`,
              );
              return yield* Effect.failCause(attempt.cause);
            }
            return yield* failed(
              "cleanup",
              `${Cause.pretty(attempt.cause)}; ${cleanup.join("; ")}`,
            );
          }
          return yield* Effect.failCause(attempt.cause);
        }
        yield* installFinalizer(operations, owned, stopPermit);
        return makeServerHandle(attempt.value, owned, operations, stopPermit);
      }),
    ).pipe(Effect.withSpan("acquireMoltZapServer"));
}

/**
 * Acquire one fresh MoltZap server and all resources that make it usable.
 * @param options Options that control the operation.
 * @returns The acquire molt zap server result.
 */
export function acquireMoltZapServer(
  options: AcquireMoltZapServerOptions,
): Effect.Effect<
  MoltZapServer,
  MoltZapServerFailed,
  Scope.Scope | MoltZapServerHost
> {
  return Effect.context<MoltZapServerHost>().pipe(
    Effect.flatMap((host) =>
      makeMoltZapServerAcquirer(makeMoltZapServerOperations(host))(options),
    ),
  );
}
