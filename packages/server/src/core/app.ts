// safer-arch-ignore no-cross-domain-sibling-import: Core app is the server composition root and must assemble identity registration with the protocol socket adapter.
import { NodeHttpServer } from "@effect/platform-node";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect";

import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { makeTracingLayer, readDefaultSpanProcessor } from "./tracing.js";
import { DbTag } from "#db";
import { EncryptionTag, EnvelopeEncryption } from "#db/crypto";

import type { CoreApp, ConnectionHook, DisconnectionHook } from "./types.js";
import type { CoreConfig } from "#config";
import { AppEndpointRegistryTag } from "../identity/apps/layer.js";
import { installDefaultApp } from "../identity/apps/default-app.js";
import { ConnectionHooksTag } from "./hooks.js";
import { servicesLive, resolveServices } from "./layers.js";
import { makeNodeHttpServer, makeCoreHttpApp } from "#http";
import { makeMoltzapSocketHandler } from "../moltzap/server-socket.js";

/** Grace period after closing all WebSockets so in-flight sends can flush. */
const SHUTDOWN_DRAIN_MS = 500;

class ServerCloseError extends Data.TaggedError("ServerCloseError")<{
  readonly cause: unknown;
}> {}

/**
 * Typed fatal for boot failure. The `phase` discriminator names
 * which boot step failed:
 * - `"http-listen"` — step 5a's `NodeHttpServer.make` / `serverSvc.serve`
 *   typed `ServeError` (EADDRINUSE, EACCES, ...).
 * - `"default-app-connect"` — step 5c's `startDefaultApp` `BootDefaultAppError`
 *   (wrapping `client.connect()`'s `ConnectError`).
 *
 * Step 5b's `installDefaultApp` has error channel `never`; SQL faults defect
 * and flow through the boot-failure `catchAllCause` envelope without a phase
 * tag.
 */
export class ServerBootFailedError extends Data.TaggedError(
  "ServerBootFailedError",
)<{
  readonly phase: "http-listen" | "default-app-connect";
  readonly cause: unknown;
}> {}

/**
 * Shared cleanup-error log-and-swallow envelope. `catchAllCause`
 * (not `catchAll`) so DEFECTS (throwing finalizers, sync exceptions,
 * `Effect.die`) are caught alongside typed failures — `catchAll` would let
 * them propagate through `Cause`. The resulting Effect has a `never` error
 * channel, so the close contract is honest: nothing escapes regardless of
 * what the cleanup step does. `Cause.pretty` provides structured diagnostics
 * without smuggling a raw `Cause` through an `unknown`-typed channel.
 * @param label Value supplied to the operation.
 * @returns The resolve span processor result.
 */
const logAndSwallowCause =
  (label: string) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    eff.pipe(
      Effect.catchAllCause((cleanupCause) =>
        Effect.logError(label).pipe(
          Effect.annotateLogs({ cleanupCause: Cause.pretty(cleanupCause) }),
        ),
      ),
      Effect.asVoid,
    );

/**
 * Run a best-effort cleanup promise, logging and swallowing any failure.
 * @param run Value supplied to the operation.
 * @param label Value supplied to the operation.
 * @returns The resolve span processor result.
 */
const runCleanupStep = (
  run: () => PromiseLike<unknown>,
  label: string,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ServerCloseError({ cause }),
  }).pipe(logAndSwallowCause(label));

function resolveSpanProcessor(
  configured?: SpanProcessor,
): SpanProcessor | null {
  if (configured !== undefined) {
    return configured;
  }
  return Effect.runSync(readDefaultSpanProcessor);
}

function makeCoreRuntime(config: CoreConfig) {
  const envelope = config.encryptionMasterSecret
    ? new EnvelopeEncryption(config.encryptionMasterSecret)
    : null;
  const spanProcessor = resolveSpanProcessor(config.spanProcessor);
  const tracingLive =
    spanProcessor === null ? Layer.empty : makeTracingLayer({ spanProcessor });
  const baseLive = Layer.mergeAll(
    Layer.succeed(DbTag, config.db),
    Layer.succeed(EncryptionTag, envelope),
  );
  const servicesWithBase = Layer.provideMerge(servicesLive, baseLive);
  const installDefaultAppValue = Layer.effectDiscard(
    Effect.gen(function* () {
      const appEndpointRegistry = yield* AppEndpointRegistryTag;
      installDefaultApp(appEndpointRegistry);
    }).pipe(Effect.withSpan("makeCoreRuntime.installDefaultApp")),
  );
  const fullLive = Layer.provideMerge(installDefaultAppValue, servicesWithBase);
  // The connection/disconnection hook arrays are created here so the native
  // `agent/network/connect` handler can fire the connection hooks via
  // `ConnectionHooksTag`. They are mutable references the `CoreApp.onConnection`
  // / `onDisconnection` accessors push into AFTER this runtime is built; the
  // native handler reads the live array contents per connect.
  const connectionHooks: ConnectionHook[] = [];
  const disconnectionHooks: DisconnectionHook[] = [];
  const hooksLive = Layer.succeed(ConnectionHooksTag, {
    connectionHooks,
    disconnectionHooks,
  });
  const dispatchRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      NodeHttpServer.layerContext,
      fullLive,
      hooksLive,
      tracingLive,
    ),
  );
  const services = dispatchRuntime.runSync(resolveServices);
  return { dispatchRuntime, services, connectionHooks, disconnectionHooks };
}

/**
 * Creates core app.
 * @param config Documentation generation configuration.
 * @returns The created core app.
 */
export function createCoreApp(config: CoreConfig): CoreApp {
  const { dispatchRuntime, services, connectionHooks, disconnectionHooks } =
    makeCoreRuntime(config);
  const handleSocket = makeMoltzapSocketHandler({
    services,
    disconnectionHooks,
  });
  const httpApp = makeCoreHttpApp({
    config,
    authService: services.authService,
    appAuthService: services.appAuthService,
    connections: services.connections,
    handleSocket,
  });
  const appScope = Effect.runSync(Scope.make());
  let actualPort = config.port;
  const startup = Effect.gen(function* () {
    const serverSvc = yield* NodeHttpServer.make(makeNodeHttpServer, {
      port: config.port,
      host: "0.0.0.0",
    });
    yield* serverSvc.serve(httpApp);
    const addr = serverSvc.address;
    actualPort = addr._tag === "TcpAddress" ? addr.port : config.port;
    yield* Effect.logInfo("MoltZap core server listening").pipe(
      Effect.annotateLogs({ port: actualPort }),
    );
  }).pipe(Effect.withSpan("createCoreApp.startup"), Scope.extend(appScope));

  dispatchRuntime.runPromise(startup).catch((err: unknown) => {
    Effect.runFork(
      Effect.logError("Server startup failed").pipe(
        Effect.annotateLogs({ err }),
      ),
    );
  });

  return makeCoreAppApi({
    config,
    dispatchRuntime,
    services,
    connectionHooks,
    disconnectionHooks,
    appScope,
    getPort: () => actualPort,
  });
}

type CoreRuntime = ReturnType<typeof makeCoreRuntime>;

interface CoreAppApiOptions {
  readonly config: CoreConfig;
  readonly dispatchRuntime: CoreRuntime["dispatchRuntime"];
  readonly services: CoreRuntime["services"];
  readonly connectionHooks: ConnectionHook[];
  readonly disconnectionHooks: DisconnectionHook[];
  readonly appScope: Scope.CloseableScope;
  readonly getPort: () => number;
}

function makeCoreAppApi(options: CoreAppApiOptions): CoreApp {
  const { services } = options;
  return {
    get port() {
      return options.getPort();
    },
    onConnection: (hook) => options.connectionHooks.push(hook),
    onDisconnection: (hook) => options.disconnectionHooks.push(hook),
    networkSendService: services.networkSendService,
    connections: services.connections,
    leaseRegistry: services.leaseRegistry,
    setContactService: (checker) => {
      services.appEndpointRegistry.setContactService(checker);
    },
    close: () =>
      Effect.runPromise(closeCoreAppEffect(options).pipe(Effect.as(undefined))),
  };
}

/**
 * Tear down a `CoreApp` in dependency order so in-flight work has a
 * chance to finish before its dependencies vanish.
 *
 * ```mermaid
 * flowchart LR
 *   A[leaseRegistry.shutdown — fail-closed leases + interrupt TTL/round-trip fibers] --> B[messageService.close — interrupt webhook retries]
 *   B --> C[for each conn — conn.shutdown signals closeRequested]
 *   C --> D[sleep SHUTDOWN_DRAIN_MS — drain in-flight RPCs]
 *   D --> E[Scope.close appScope — NodeHttpServer + upgrade wiring]
 *   E --> F[dispatchRuntime.dispose — finalize service Layers]
 *   F --> G[config.dbCleanup — optional caller hook]
 * ```
 *
 * `leaseRegistry.shutdown()` runs FIRST, before any socket teardown.
 * `messageService.close()` runs next so pending delivery-webhook POSTs
 * do not race the HTTP server teardown.
 *
 * `leaseRegistry.shutdown()` runs BEFORE `Scope.close(appScope)`:
 * it atomically closes and drains lease state, stops background notification
 * and retention work, and interrupts live TTL/moderator round-trip fibers.
 * Later per-connection disconnect cleanup therefore observes an empty,
 * closed registry and cannot schedule new lease work during scope teardown.
 * See
 * `dispatch/lease-registry.ts → LeaseRegistry.shutdown`.
 * @param options Options that control the operation.
 * @returns The close core app effect result.
 */
function closeCoreAppEffect(options: CoreAppApiOptions) {
  const { services } = options;
  return Effect.gen(function* () {
    // Drain the lease runtime before socket teardown. Subsequent disconnect
    // cleanup observes an empty, closed registry; background notification,
    // retention, TTL, and moderator round-trip work is stopped first.
    yield* services.leaseRegistry.shutdown();
    yield* services.messageService.close();
    for (const conn of yield* services.connections.allConnections()) {
      yield* conn.socket.shutdown;
    }
    yield* Effect.sleep(Duration.millis(SHUTDOWN_DRAIN_MS));
    yield* Scope.close(options.appScope, Exit.void);
    // Best-effort cleanup: both
    // `dispatchRuntime.dispose()` and `dbCleanup()` log-and-swallow via the
    // shared defect-safe envelope so a failing finalizer never propagates out
    // of `close()`. `catchAllCause` also covers a sync throw inside the
    // promise-resolution path that a bare `catchAll` would miss.
    yield* runCleanupStep(
      () => options.dispatchRuntime.dispose(),
      "CoreApp.close: dispatchRuntime.dispose failed (continuing)",
    );
    const dbCleanup = options.config.dbCleanup;
    if (dbCleanup !== undefined) {
      yield* runCleanupStep(
        dbCleanup,
        "CoreApp.close: dbCleanup failed (continuing)",
      );
    }
  }).pipe(Effect.withSpan("CoreApp.close"));
}
