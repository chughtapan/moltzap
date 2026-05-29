import { HttpClient } from "@effect/platform";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
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
import type {
  DispatchContext,
  RpcMethodRegistry,
} from "../transport/context.js";
import type { ServerHandlers } from "@moltzap/protocol";
import { EnvelopeEncryption } from "../crypto/envelope.js";

// Handlers
import { agentsLookupHandlers } from "../identity/handlers/agents-lookup.handlers.js";
import { pingHandlers } from "../network/handlers/ping.handlers.js";
import { connectHandlers } from "../identity/handlers/connect.handlers.js";
import { messageHandlers } from "../task/handlers/messages.handlers.js";
import { presenceHandlers } from "../network/handlers/presence.handlers.js";
import { contactHandlers } from "../identity/handlers/contacts.handlers.js";
import { taskHandlers } from "../task/handlers/tasks.handlers.js";
import { appHandlers } from "./handlers/apps.handlers.js";
import { taskRequestHandlers } from "./handlers/task-request.handler.js";

import type { CoreApp, ConnectionHook, DisconnectionHook } from "./types.js";
import type { CoreConfig } from "../config.js";
import {
  AppHostTag,
  ConversationServiceTag,
  DbTag,
  DeliveryWebhookTag,
  EncryptionTag,
  ServicesLive,
  SessionValidatorTag,
  resolveServices,
} from "./layers.js";
import { installDefaultApp } from "./default-app.js";
import { makeNodeHttpServer } from "./node-http-server.js";
import { makeCoreHttpApp } from "./http-routes.js";
import { makeSocketHandler } from "./socket-handler.js";
import { applyOutboundWebhookCap } from "./outbound-webhook-cap.js";

/** Grace period after closing all WebSockets so in-flight sends can flush. */
const SHUTDOWN_DRAIN_MS = 500;

/**
 * Production HTTP client Layer: Undici-backed `HttpClient.HttpClient`
 * wrapped with the process-wide outbound-webhook semaphore from
 * {@link applyOutboundWebhookCap}. The cap is SHARED with the standalone
 * validator wiring in `standalone.ts` so all 3 outbound webhook paths
 * (delivery + contacts + sessions) pull from the same permit pool —
 * matching the prior bespoke `WebhookClient(10)` behavior where one
 * class instance was shared across all callers.
 *
 * The semaphore is applied via `HttpClient.transform`, which scopes it
 * to `httpClient.execute(request)` (bounded at headers-arrival); permits
 * return on fiber interrupt because the inner request runs inside the
 * `withPermits` scope.
 */
const HttpClientLive = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const inner = yield* HttpClient.HttpClient;
    return applyOutboundWebhookCap(inner);
  }),
).pipe(Layer.provide(NodeHttpClient.layerUndici));

class ServerCloseError extends Data.TaggedError("ServerCloseError")<{
  readonly cause: unknown;
}> {}

/**
 * D #705 §2.7 — typed fatal for boot failure. The `phase` discriminator names
 * which boot step failed:
 * - `"http-listen"` — step 5a's `NodeHttpServer.make` / `serverSvc.serve`
 *   typed `ServeError` (EADDRINUSE, EACCES, ...).
 * - `"default-app-connect"` — step 5c's `startDefaultApp` `BootDefaultAppError`
 *   (wrapping `client.connect()`'s `ConnectError`).
 *
 * Step 5b's `installDefaultApp` has error channel `never`; SQL faults defect
 * and flow through the boot-failure `catchAllCause` envelope without a phase
 * tag. Wired into the `createCoreApp` boot-failure error channel at the
 * boot-orchestrator cutover (phase 4).
 */
export class ServerBootFailedError extends Data.TaggedError(
  "ServerBootFailedError",
)<{
  readonly phase: "http-listen" | "default-app-connect";
  readonly cause: unknown;
}> {}

/**
 * D #705 §2.7 — shared cleanup-error log-and-swallow envelope. `catchAllCause`
 * (not `catchAll`) so DEFECTS (throwing finalizers, sync exceptions,
 * `Effect.die`) are caught alongside typed failures — `catchAll` would let
 * them propagate through `Cause`. The resulting Effect has a `never` error
 * channel, so the close contract is honest: nothing escapes regardless of
 * what the cleanup step does. `Cause.pretty` provides structured diagnostics
 * without smuggling a raw `Cause` through an `unknown`-typed channel.
 *
 * Module-private — wired into `createCoreApp`'s cleanup body at phase 4.
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

function resolveSpanProcessor(
  configured: SpanProcessor | undefined,
): SpanProcessor | null {
  if (configured !== undefined) return configured;
  return Effect.runSync(readDefaultSpanProcessor);
}

function makeCoreRuntime(config: CoreConfig) {
  const envelope = config.encryptionMasterSecret
    ? new EnvelopeEncryption(config.encryptionMasterSecret)
    : null;
  const spanProcessor = resolveSpanProcessor(config.spanProcessor);
  const TracingLive =
    spanProcessor === null ? Layer.empty : makeTracingLayer({ spanProcessor });
  const BaseLive = Layer.mergeAll(
    Layer.succeed(DbTag, config.db),
    Layer.succeed(EncryptionTag, envelope),
    Layer.succeed(SessionValidatorTag, config.sessionValidator ?? null),
    Layer.succeed(DeliveryWebhookTag, config.deliveryWebhook ?? null),
    HttpClientLive,
  );
  const ServicesWithBase = Layer.provideMerge(ServicesLive, BaseLive);
  const WireConversationIntoAppHost = Layer.effectDiscard(
    Effect.gen(function* () {
      const appHost = yield* AppHostTag;
      const conversation = yield* ConversationServiceTag;
      appHost.setConversationService(conversation);
      installDefaultApp(appHost);
    }).pipe(Effect.withSpan("makeCoreRuntime.wireConversationIntoAppHost")),
  );
  const FullLive = Layer.provideMerge(
    WireConversationIntoAppHost,
    ServicesWithBase,
  );
  const dispatchRuntime = ManagedRuntime.make(
    Layer.mergeAll(NodeHttpServer.layerContext, FullLive, TracingLive),
  );
  const services = dispatchRuntime.runSync(resolveServices);
  return { dispatchRuntime, services };
}

export function createCoreApp(config: CoreConfig): CoreApp {
  const { dispatchRuntime, services } = makeCoreRuntime(config);
  const connectionHooks: ConnectionHook[] = [];
  const disconnectionHooks: DisconnectionHook[] = [];
  const methods = makeCoreRpcMethods();
  const handlers = buildServerHandlers(methods);
  const handleSocket = makeSocketHandler({
    services,
    handlers,
    connectionHooks,
    disconnectionHooks,
  });
  const httpApp = makeCoreHttpApp({
    config,
    authService: services.authService,
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

  dispatchRuntime.runPromise(startup).catch((err) => {
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

function makeCoreRpcMethods(): RpcMethodRegistry {
  return [
    ...connectHandlers,
    ...agentsLookupHandlers,
    ...messageHandlers,
    ...presenceHandlers,
    ...appHandlers,
    ...taskRequestHandlers,
    ...contactHandlers,
    ...taskHandlers,
    ...pingHandlers,
  ];
}

/**
 * Convert the flat `RpcMethodRegistry` array into the Spec F (#617)
 * typed-dispatcher `ServerHandlers&lt;DispatchContext>` record, keyed by
 * each binding's `definition.name`. Duplicate method names collide at
 * `Map.set` time (impossible by construction — each handler file
 * exports a distinct method-definition slice of the catalog).
 *
 * The `as` cast bridges the upper-bound widening from
 * `RpcMethodBinding`'s storage-friendly `Context.Tag&lt;unknown, unknown>`
 * R-channel to `ServerHandlers`'s mapped-type slot shape. The dispatcher
 * erases R via `asNeverR` at runtime; the surrounding
 * `ManagedRuntime&lt;FullLive>` provides every Tag at request time.
 */
function buildServerHandlers(
  methods: RpcMethodRegistry,
): ServerHandlers<DispatchContext> {
  const table: Record<string, RpcMethodRegistry[number]> = {};
  for (const slot of methods) {
    table[slot.definition.name] = slot;
  }
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- catalog→record erasure: the flat array's union elements key into ServerHandlers's mapped record by definition.name; the cast bridges the type-level partition. The dispatcher's `asNeverR` post-erases the residual R channel at boundary.
  return table as unknown as ServerHandlers<DispatchContext>; // #ignore-sloppy-code[as-unknown-as]: catalog→record erasure: the flat array's union elements key into ServerHandlers's mapped record by definition.name; the dispatcher's `asNeverR` post-erases the residual R channel at boundary.
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
    setContactService: (checker) => services.appHost.setContactService(checker),
    close: () => Effect.runPromise(closeCoreAppEffect(options)),
  };
}

/**
 * Tear down a `CoreApp` in dependency order so in-flight work has a
 * chance to finish before its dependencies vanish.
 *
 * ```mermaid
 * flowchart LR
 *   A[messageService.close — interrupt webhook retries] --> B[appHost.destroy — clears manifests + hook registries]
 *   B --> C[for each conn — conn.shutdown signals closeRequested]
 *   C --> D[sleep SHUTDOWN_DRAIN_MS — drain in-flight RPCs]
 *   D --> E[Scope.close appScope — NodeHttpServer + upgrade wiring]
 *   E --> F[dispatchRuntime.dispose — finalize service Layers]
 *   F --> G[config.dbCleanup — optional caller hook]
 * ```
 *
 * `messageService.close()` runs FIRST so pending delivery-webhook
 * POSTs do not race the HTTP server teardown. `appHost.destroy()`
 * runs BEFORE per-connection shutdown: in-flight RPCs may observe
 * cleared manifests, and the `SHUTDOWN_DRAIN_MS` sleep is the only
 * mitigation today.
 */
function closeCoreAppEffect(options: CoreAppApiOptions) {
  const { services } = options;
  return Effect.gen(function* () {
    yield* services.messageService.close();
    services.appHost.destroy();
    for (const conn of yield* services.connections.allConnections()) {
      yield* conn.socket.shutdown;
    }
    yield* Effect.sleep(Duration.millis(SHUTDOWN_DRAIN_MS));
    yield* Scope.close(options.appScope, Exit.void);
    // Best-effort cleanup (D #705 §2.7 boot-resource lifecycle table): both
    // `dispatchRuntime.dispose()` and `dbCleanup()` log-and-swallow via the
    // shared defect-safe envelope so a failing finalizer never propagates out
    // of `close()`. `catchAllCause` also covers a sync throw inside the
    // promise-resolution path that a bare `catchAll` would miss.
    yield* Effect.tryPromise({
      try: () => options.dispatchRuntime.dispose(),
      catch: (cause) => new ServerCloseError({ cause }),
    }).pipe(
      logAndSwallowCause(
        "CoreApp.close: dispatchRuntime.dispose failed (continuing)",
      ),
    );
    const dbCleanup = options.config.dbCleanup;
    if (dbCleanup !== undefined) {
      yield* Effect.tryPromise({
        try: () => dbCleanup(),
        catch: (cause) => new ServerCloseError({ cause }),
      }).pipe(
        logAndSwallowCause("CoreApp.close: dbCleanup failed (continuing)"),
      );
    }
  }).pipe(Effect.withSpan("CoreApp.close"));
}
