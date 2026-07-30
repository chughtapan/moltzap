/**
 * Server-core conformance entry. The protocol package owns property
 * registration, seeds, artifacts, and suite execution; this file supplies the
 * real server factory and optional Toxiproxy lifecycle.
 */
import {
  Command,
  FetchHttpClient,
  FileSystem,
  HttpClient,
  HttpClientResponse,
  Path,
} from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import {
  Cause,
  Config,
  ConfigProvider,
  Data,
  Duration,
  Effect,
  Exit,
  Schema,
} from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userId } from "@moltzap/protocol/identity";
import {
  RealServerAcquireError,
  runConformanceSuite,
  type SuiteResult,
  type ToxiproxyNetworkConfig,
} from "@moltzap/protocol/testing";
import {
  startCoreTestServer,
  stopCoreTestServer,
} from "../../test-utils/index.js";

const ENABLED_ENV_VALUE = "1";
const DEFAULT_TOXIPROXY_URL = "http://127.0.0.1:8474";
const COMPOSE_FILE_NAME = "docker-compose.conformance.yml";
const CONFORMANCE_ADMIN_USER_ID = Schema.decodeUnknownSync(userId)(
  "00000000-0000-4000-8000-000000000340",
);
const TOXIPROXY_PROBE_INTERVAL = "500 millis";
const TOXIPROXY_BOOT_TIMEOUT_MS = 30_000;
const TOXIPROXY_REUSE_TIMEOUT_MS = 5_000;
const TOXIPROXY_BEFORE_ALL_TIMEOUT_MS = 60_000;
const CONFORMANCE_SUITE_TIMEOUT_MS = 600_000;
const TOXIPROXY_BRIDGE_UPSTREAM_HOST = "host.docker.internal";
const TOXIPROXY_BRIDGE_LISTEN_HOST = "0.0.0.0";
const TOXIPROXY_BRIDGE_CONNECT_HOST = "127.0.0.1";
const TOXIPROXY_BRIDGE_PORT_MIN = 47_000;
const TOXIPROXY_BRIDGE_PORT_MAX = 47_099;
const DOCKER_COMMAND = "docker";
const COMPOSE_SUBCOMMAND = "compose";
const DOCKER_UP_COMMAND = "docker compose up";
const DOCKER_DOWN_COMMAND = "docker compose down";
const SUCCESS_EXIT_CODE = 0;
const FAILURE_REASON_KEYS = ["cause", "reason", "message"] as const;

class ComposeFileNotFound extends Data.TaggedError("ComposeFileNotFound")<{
  readonly cwd: string;
}> {}

class ToxiproxyCommandExited extends Data.TaggedError(
  "ToxiproxyCommandExited",
)<{
  readonly command: string;
  readonly exitCode: number;
}> {}

class ToxiproxyProbeTimeout extends Data.TaggedError("ToxiproxyProbeTimeout")<{
  readonly url: string;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `Toxiproxy not reachable at ${this.url} after ${this.timeoutMs}ms`;
  }
}

class ConformanceSuiteFailed extends Data.TaggedError(
  "ConformanceSuiteFailed",
)<{
  readonly summary: string;
}> {
  override get message(): string {
    return this.summary;
  }
}

interface ConformanceEnv {
  readonly skipToxiproxy: boolean;
  readonly skipDocker: boolean;
  readonly toxiproxyUrl: string;
}

interface ComposeController {
  readonly teardown: Effect.Effect<
    void,
    PlatformError | ToxiproxyCommandExited,
    NodeContext.NodeContext
  >;
}

interface ToxiproxySetup {
  readonly compose: ComposeController | null;
  readonly url: string | null;
}

interface ToxiproxyState {
  compose: ComposeController | null;
  toxiproxyUrl: string | null;
}

const conformanceEnvConfig = Config.all({
  skipToxiproxy: enabledEnvFlag("SKIP_TOXIPROXY"),
  skipDocker: enabledEnvFlag("SKIP_DOCKER"),
  toxiproxyUrl: Config.string("TOXIPROXY_URL").pipe(
    Config.withDefault(DEFAULT_TOXIPROXY_URL),
  ),
});
const CONFORMANCE_ENV = loadConformanceEnv();

function enabledEnvFlag(name: string) {
  return Config.string(name).pipe(
    Config.withDefault("0"),
    Config.map((value) => value === ENABLED_ENV_VALUE),
  );
}

function loadConformanceEnv(): ConformanceEnv {
  return Effect.runSync(
    conformanceEnvConfig.pipe(
      Effect.withConfigProvider(ConfigProvider.fromEnv()),
    ),
  );
}

function dockerComposeDown(composePath: string) {
  return runDockerCompose(
    DOCKER_DOWN_COMMAND,
    dockerComposeCommand(composePath, "down", "-v"),
  );
}

function dockerComposeUp(composePath: string) {
  return runDockerCompose(
    DOCKER_UP_COMMAND,
    dockerComposeCommand(composePath, "up", "-d"),
  );
}

function dockerComposeCommand(composePath: string, ...args: string[]) {
  return Command.make(
    DOCKER_COMMAND,
    COMPOSE_SUBCOMMAND,
    "-f",
    composePath,
    ...args,
  ).pipe(Command.stdout("inherit"), Command.stderr("inherit"));
}

function runDockerCompose(command: string, process: Command.Command) {
  return Command.exitCode(process).pipe(
    Effect.flatMap((exitCode) =>
      Number(exitCode) === SUCCESS_EXIT_CODE
        ? Effect.void
        : Effect.fail(
            new ToxiproxyCommandExited({
              command,
              exitCode: Number(exitCode),
            }),
          ),
    ),
  );
}

function findComposeFile() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = process.cwd();
    const candidates = [
      path.resolve(cwd, "../../", COMPOSE_FILE_NAME),
      path.resolve(cwd, COMPOSE_FILE_NAME),
    ] as const;

    for (const candidate of candidates) {
      if (yield* fs.exists(candidate)) {
        return candidate;
      }
    }
    return yield* Effect.fail(new ComposeFileNotFound({ cwd }));
  });
}

function bringUpToxiproxy() {
  return Effect.gen(function* () {
    const composePath = yield* findComposeFile();
    yield* dockerComposeUp(composePath);
    return { teardown: dockerComposeDown(composePath) };
  });
}

function waitForToxiproxy(url: string, timeoutMs: number) {
  return waitForToxiproxyReady(url).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () => new ToxiproxyProbeTimeout({ url, timeoutMs }),
    }),
  );
}

function waitForToxiproxyReady(
  url: string,
): Effect.Effect<void, never, HttpClient.HttpClient> {
  return probeToxiproxy(url).pipe(
    Effect.catchAll((probeErr) =>
      Effect.logWarning("toxiproxy readiness probe failed", probeErr).pipe(
        Effect.zipRight(Effect.sleep(TOXIPROXY_PROBE_INTERVAL)),
        Effect.zipRight(waitForToxiproxyReady(url)),
      ),
    ),
  );
}

function probeToxiproxy(url: string) {
  return HttpClient.get(`${url}/version`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.asVoid,
  );
}

function setupToxiproxy(env: ConformanceEnv) {
  return Effect.gen(function* () {
    if (env.skipToxiproxy) {
      return { compose: null, url: null } satisfies ToxiproxySetup;
    }
    if (env.skipDocker) {
      yield* waitForToxiproxy(env.toxiproxyUrl, TOXIPROXY_REUSE_TIMEOUT_MS);
      return { compose: null, url: env.toxiproxyUrl };
    }
    const compose = yield* bringUpToxiproxy();
    yield* waitForToxiproxy(env.toxiproxyUrl, TOXIPROXY_BOOT_TIMEOUT_MS);
    return { compose, url: env.toxiproxyUrl };
  });
}

function conformanceRealServer() {
  return Effect.tryPromise({
    try: () =>
      startCoreTestServer({
        adminUserId: CONFORMANCE_ADMIN_USER_ID,
      }),
    catch: (cause) => new RealServerAcquireError({ cause }),
  }).pipe(
    Effect.flatMap((handle) =>
      Effect.gen(function* () {
        if (
          usesUnassignedPort(handle.baseUrl) ||
          usesUnassignedPort(handle.wsUrl)
        ) {
          return yield* Effect.fail(
            new RealServerAcquireError({
              cause: new Error(
                `core test server did not acquire a listening port: baseUrl=${handle.baseUrl} wsUrl=${handle.wsUrl}`,
              ),
            }),
          ).pipe(Effect.ensuring(closeConformanceTestServer()));
        }
        return {
          wsUrl: handle.wsUrl,
          baseUrl: handle.baseUrl,
          close: closeConformanceTestServer(),
        };
      }),
    ),
  );
}

function closeConformanceTestServer() {
  return Effect.tryPromise({
    try: () => stopCoreTestServer(),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.logDebug("conformance test server teardown failed", cause),
    ),
  );
}

function usesUnassignedPort(url: string): boolean {
  if (!URL.canParse(url)) {
    return true;
  }
  return new URL(url).port === "0";
}

const bridgeToxiproxyNetwork: ToxiproxyNetworkConfig = {
  upstreamHost: TOXIPROXY_BRIDGE_UPSTREAM_HOST,
  listenHost: TOXIPROXY_BRIDGE_LISTEN_HOST,
  connectHost: TOXIPROXY_BRIDGE_CONNECT_HOST,
  listenPortRange: {
    min: TOXIPROXY_BRIDGE_PORT_MIN,
    max: TOXIPROXY_BRIDGE_PORT_MAX,
  },
};

function runConformanceAssertion(toxiproxyUrl: string | null) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      runConformanceSuite({
        realServer: conformanceRealServer(),
        toxiproxyUrl,
        toxiproxyNetwork:
          toxiproxyUrl === null ? undefined : bridgeToxiproxyNetwork,
      }),
    );
    expect(
      Exit.isSuccess(exit),
      Exit.isSuccess(exit)
        ? "conformance suite succeeded"
        : Cause.pretty(exit.cause),
    ).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }

    const result: SuiteResult = exit.value;
    yield* logSuiteResult(result);
    if (result.failed.length > 0) {
      return yield* Effect.fail(
        new ConformanceSuiteFailed({
          summary: failedSummary(result),
        }),
      );
    }
  });
}

function logSuiteResult(result: SuiteResult) {
  return Effect.gen(function* () {
    yield* Effect.logInfo(conformanceSummary(result));
    if (result.unavailable.length > 0) {
      yield* Effect.logInfo(unavailableSummary(result));
    }
  });
}

function conformanceSummary(result: SuiteResult) {
  return `[conformance] seed=${result.seed} passed=${result.passed.length} unavailable=${result.unavailable.length} failed=${result.failed.length}`;
}

function unavailableSummary(result: SuiteResult) {
  return `[conformance] unavailable: ${result.unavailable.map(formatUnavailable).join(" | ")}`;
}

function formatUnavailable(unavailable: { name: string; reason: string }) {
  return `${unavailable.name}: ${unavailable.reason}`;
}

function failedSummary(result: SuiteResult) {
  const failed = result.failed.map(formatFailure).join("; ");
  const total =
    result.failed.length + result.passed.length + result.unavailable.length;
  return `${result.failed.length}/${total} failed: ${failed}`;
}

function formatFailure(failure: SuiteResult["failed"][number]) {
  return `${failure.name}: ${failureTag(failure.failure)} — ${failureReason(failure.failure)}`;
}

function failureTag(failure: unknown) {
  const tag = readProperty(failure, "_tag");
  return typeof tag === "string" ? tag : "unknown";
}

function failureReason(failure: unknown) {
  for (const key of FAILURE_REASON_KEYS) {
    const value = readProperty(failure, key);
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean"
    ) {
      return String(value);
    }
    if (value instanceof Error) {
      return value.message;
    }
  }
  return "";
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function makeToxiproxyState(): ToxiproxyState {
  return { compose: null, toxiproxyUrl: null };
}

function setupToxiproxyBeforeAll(state: ToxiproxyState) {
  return setupToxiproxy(CONFORMANCE_ENV).pipe(
    Effect.tap(rememberToxiproxySetup(state)),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeContext.layer),
  );
}

function rememberToxiproxySetup(state: ToxiproxyState) {
  return (setup: ToxiproxySetup) =>
    Effect.sync(() => {
      state.compose = setup.compose;
      state.toxiproxyUrl = setup.url;
    });
}

function teardownToxiproxyAfterAll(state: ToxiproxyState) {
  if (state.compose === null) {
    return undefined;
  }
  return Effect.runPromise(
    state.compose.teardown.pipe(Effect.provide(NodeContext.layer)),
  );
}

describe("moltzap-server-core conformance", () => {
  const toxiproxyState = makeToxiproxyState();

  beforeAll(
    () => Effect.runPromise(setupToxiproxyBeforeAll(toxiproxyState)),
    TOXIPROXY_BEFORE_ALL_TIMEOUT_MS,
  );

  afterAll(() => teardownToxiproxyAfterAll(toxiproxyState));

  it(
    "every protocol conformance property passes against the core server",
    () => {
      expect.hasAssertions();
      return Effect.runPromise(
        runConformanceAssertion(toxiproxyState.toxiproxyUrl),
      );
    },
    CONFORMANCE_SUITE_TIMEOUT_MS,
  );
});
