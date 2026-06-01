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
  ServerRpcSlots,
  ServerRpcSlotTable,
} from "../transport/context.js";
import {
  projectPrincipalKinds,
  validatePrincipalKinds,
  PrincipalKindRegistryError,
  type ServerMethodBindings,
} from "../transport/server-method-bindings.js";
import {
  ServerEngineRpcGroup,
  UNAUTHENTICATED_METHODS,
  findEngineGatingMismatch,
} from "@moltzap/protocol";
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
  const slots = buildValidatedServerSlots();
  const handleSocket = makeSocketHandler({
    services,
    slots,
    connectionHooks,
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

function makeCoreRpcMethods(): ServerRpcSlots {
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
 * Key the flat `ServerRpcSlots` array into the cast-free
 * {@link ServerRpcSlotTable} the dispatcher indexes by `frame.method`.
 * Each slot is already a real `ErasedSlot` (from a
 * `defineXMethod` wrapper); this just keys it by `slot.definition.name`.
 * Duplicate method names collide on `table[name]` (impossible by
 * construction — each handler file exports a distinct method slice of the
 * catalog). NO erasure cast: the `ErasedSlot` IS the dispatch surface.
 */
function buildServerSlots(methods: ServerRpcSlots): ServerRpcSlotTable {
  const table: Record<string, ServerRpcSlots[number]> = {};
  for (const slot of methods) {
    table[slot.definition.name] = slot;
  }
  return table;
}

/**
 * Assemble the dispatch slot table, validating the #720 principal-kind policy
 * registry at boot first. The slots are built once and threaded through both
 * the fail-closed check and the table keying.
 */
function buildValidatedServerSlots(): ServerRpcSlotTable {
  const methods = makeCoreRpcMethods();
  // Runtime gate-presence backstop: every engine member carries
  // `PrincipalResolution` iff it is not unauthenticated. Inspects the actual
  // built middleware, which the group's single type assertion cannot prove.
  const gatingMismatch = findEngineGatingMismatch();
  if (gatingMismatch !== undefined) {
    throw new PrincipalKindRegistryError(
      `ServerEngineRpcGroup gating mismatch for ${gatingMismatch}`,
    );
  }
  validateCorePrincipalKinds(methods);
  return buildServerSlots(methods);
}

/**
 * Assemble the single-source {@link ServerMethodBindings} tuple from the slots'
 * `binding` field — the #720 policy each `define*Method` wrapper surfaced. The
 * native engine's handler map and the `principalKinds` policy table are both
 * projections of this tuple, so they cannot drift.
 */
function serverMethodBindings(methods: ServerRpcSlots): ServerMethodBindings {
  return methods.map((slot) => slot.binding);
}

/**
 * The authenticated tag set the native engine gates: every WS-dispatched
 * `define*Method` binding MINUS the unauthenticated allowlist. Derived from the
 * binding registry (the WS surface), NOT from the full `serverRpcMethods`
 * catalog: that catalog also carries the HTTP-only `agents/register`,
 * `agents/claim`, `agents/invite`, and `invites/createAgent` methods, which have
 * no WS handler slot (served over `http-routes.ts`) — the WS engine never
 * dispatches them, so they are not part of its gated surface.
 *
 * Every gated tag is also a {@link ServerEngineRpcGroup} member (the group is
 * catalog-derived and a superset of the WS surface); a policy naming a tag the
 * group lacks would be a wiring defect, caught by the stray-key check.
 */
function expectedGatedTags(
  bindings: ServerMethodBindings,
): ReadonlySet<string> {
  const unauth = new Set<string>(UNAUTHENTICATED_METHODS);
  const engineMembers = new Set<string>(ServerEngineRpcGroup.requests.keys());
  const gated = new Set<string>();
  for (const b of bindings) {
    if (unauth.has(b.tag)) continue;
    if (!engineMembers.has(b.tag)) {
      throw new PrincipalKindRegistryError(
        `binding tag is not a ServerEngineRpcGroup member: ${b.tag}`,
      );
    }
    gated.add(b.tag);
  }
  return gated;
}

/**
 * Boot-time fail-closed backstop (#720 §D.3): assert the projected
 * `principalKinds` keys EXACTLY equal the gated WS-binding tag set. A method that
 * reached the authenticated engine without a policy, or a policy naming a tag
 * the WS surface lacks, throws here rather than defaulting permissively. The
 * type-level partition canary pins the static shape; this catches a build that
 * somehow skipped it.
 */
function validateCorePrincipalKinds(methods: ServerRpcSlots): void {
  const bindings = serverMethodBindings(methods);
  validatePrincipalKinds(
    projectPrincipalKinds(bindings),
    expectedGatedTags(bindings),
  );
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
 *   A[leaseRegistry.shutdown — fail-closed leases + interrupt TTL/round-trip fibers] --> B[messageService.close — interrupt webhook retries]
 *   B --> C[appHost.destroy — clears manifests + hook registries]
 *   C --> D[for each conn — conn.shutdown signals closeRequested]
 *   D --> E[sleep SHUTDOWN_DRAIN_MS — drain in-flight RPCs]
 *   E --> F[Scope.close appScope — NodeHttpServer + upgrade wiring]
 *   F --> G[dispatchRuntime.dispose — finalize service Layers]
 *   G --> H[config.dbCleanup — optional caller hook]
 * ```
 *
 * `leaseRegistry.shutdown()` runs FIRST, before any socket teardown.
 * `messageService.close()` runs next so pending delivery-webhook POSTs
 * do not race the HTTP server teardown. `appHost.destroy()` runs BEFORE
 * per-connection shutdown: in-flight RPCs may observe cleared manifests,
 * and the `SHUTDOWN_DRAIN_MS` sleep is the only mitigation.
 *
 * `leaseRegistry.shutdown()` runs BEFORE `Scope.close(appScope)`:
 * closing the app scope interrupts every per-connection WS fiber, and each
 * runs its disconnect cleanup UNINTERRUPTIBLY. For a recipient holding a
 * GRANTED lease that cleanup emits a `dispatches/expired` frame to the
 * moderator connection; when the moderator socket is torn down concurrently
 * the cross-connection write parks on its closed write-latch forever,
 * deadlocking `Scope.close`. Draining the registry first (fail-closed every
 * lease so notifications drop, interrupt the live TTL/round-trip fibers)
 * removes the parked write. See
 * `task/leases/lease-registry.ts → LeaseRegistry.shutdown`.
 */
function closeCoreAppEffect(options: CoreAppApiOptions) {
  const { services } = options;
  return Effect.gen(function* () {
    // Drain the lease runtime FIRST, before any socket teardown. Both
    // the explicit `conn.socket.shutdown` loop below AND `Scope.close`'s
    // interrupt of the WS fibers trigger each connection's disconnect cleanup
    // (`socket-handler.ts → closeSocketSession → leaseRegistry.abandon`),
    // which for a recipient holding a GRANTED lease emits a cross-connection
    // `dispatches/expired` frame to the moderator. If the moderator socket is
    // closing concurrently that write parks forever on its closed write-latch.
    // Flipping the registry closed up front makes every such notification drop
    // instead of park; it also interrupts the live TTL/round-trip fibers.
    yield* services.leaseRegistry.shutdown();
    yield* services.messageService.close();
    services.appHost.destroy();
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
