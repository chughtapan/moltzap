/**
 * @file Production composition and the executable boundary for the
 * in-memory Router. The Router has no database, and a restart changes
 * its RouterInstanceId.
 */
import { HttpServer } from "@effect/platform";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { AuthenticatedHttp } from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Data, Duration, Effect, Layer } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- NodeHttpServer.make requires Node's server factory at this adapter boundary.
import { createServer } from "node:http";
import { loadRouterConfiguration, type RouterConfiguration } from "./router.js";
import { makeRouterFeed } from "./router/feed.js";
import { makeRouterHttpApp } from "./router/http.js";
import {
  generatePollCursorKey,
  generateRouterInstanceId,
  makePollCursorCodec,
} from "./router/poll-cursor.js";
import { makePollWaiters } from "./router/poll-waiters.js";
import { makeRouterPoll } from "./router/poll.js";
import { makeRouterRpcClient } from "./router/rpc.js";
import { makeRouterSend } from "./router/send.js";

// Production Router process surface.
// eslint-disable-next-line @typescript-eslint/no-namespace -- The namespace keeps the process layer and its closed startup error under one RouterServer capability.
export namespace RouterServer {
  /** Closed Router startup phase. */
  export class StartupError extends Data.TaggedError(
    "RouterServerStartupError",
  )<{
    readonly phase: "configuration" | "listener";
    readonly reason?: "legacy-key";
    readonly keys?: readonly string[];
  }> {
    override get message(): string {
      const details =
        this.reason === undefined
          ? ""
          : ` (${this.reason}: ${this.keys?.join(", ")})`;
      return `Router startup failed: ${this.phase}${details}`;
    }
  }

  const runRouterServer = Effect.gen(function* () {
    const configuration = yield* loadRouterConfiguration.pipe(
      Effect.mapError(configurationFailure),
    );
    const app = yield* buildRouterApp(configuration);
    const httpServer = yield* NodeHttpServer.make(createServer, {
      host: configuration.host,
      port: configuration.port,
    }).pipe(Effect.mapError(listenerFailure));
    yield* HttpServer.serveEffect(app).pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provide(authenticatedHttpLayer(configuration)),
      Effect.provide(NodeHttpServer.layerContext),
    );
  }).pipe(Effect.withSpan("RouterServer.layer"));

  /**
   * Complete production Router process composition.
   *
   * ```mermaid
   * flowchart LR
   *   Binary["sharness-router"] --> Server["RouterServer.layer"]
   *   Server --> App["buildRouterApp"]
   *   App --> Http["makeRouterHttpApp"]
   *   Http --> Authentication["AuthenticatedHttp"]
   *   Authentication --> Rpc["private Router RPC"]
   *   Rpc --> Operations["send or poll"]
   *   Operations --> State["feed, cursor, and poll waiters"]
   *   State --> Response["exact HTTP response"]
   * ```
   */
  export const layer: Layer.Layer<never, StartupError> =
    Layer.scopedDiscard(runRouterServer);

  function buildRouterApp(configuration: RouterConfiguration) {
    return Effect.gen(function* () {
      const routerInstanceId = yield* Effect.try({
        try: generateRouterInstanceId,
        catch: () => new StartupError({ phase: "configuration" }),
      });
      const cursorKey = yield* Effect.try({
        try: generatePollCursorKey,
        catch: () => new StartupError({ phase: "configuration" }),
      });
      const feed = yield* makeRouterFeed({
        routerInstanceId,
        retainedMessageCapacity: configuration.retainedMessageCapacity,
        retainedMessageByteCapacity: configuration.retainedMessageByteCapacity,
      });
      const pollWaiters = yield* makePollWaiters(
        configuration.heldPollCapacity,
      );
      const send = makeRouterSend({
        routerInstanceId,
        feed,
        pollWaiters,
      });
      const poll = makeRouterPoll({
        routerInstanceId,
        feed,
        pollWaiters,
        cursorCodec: makePollCursorCodec({
          key: cursorKey,
          routerInstanceId,
        }),
        pollMessageLimit: configuration.pollMessageLimit,
        pollResponseByteLimit: configuration.pollResponseByteLimit,
      });
      return makeRouterHttpApp({
        client: yield* makeRouterRpcClient({ send, poll }),
        feed,
        requestSemaphore: yield* Effect.makeSemaphore(
          configuration.requestConcurrencyLimit,
        ),
      });
    });
  }

  function authenticatedHttpLayer(configuration: RouterConfiguration) {
    const registryLayer = Registry.layer({
      origin: configuration.registryOrigin,
      registrySignerPublicKey: configuration.registrySignerPublicKey,
      requestTimeout: Duration.millis(configuration.registryLookupTimeoutMs),
    }).pipe(Layer.provide(NodeHttpClient.layer));
    return AuthenticatedHttp.layer({
      liveNonceCapacity: configuration.liveNonceCapacity,
      agentCardCacheCapacity: configuration.agentCardCacheCapacity,
      registryLookupConcurrencyLimit:
        configuration.registryLookupConcurrencyLimit,
    }).pipe(Layer.provide(registryLayer));
  }

  function configurationFailure(
    error: Effect.Effect.Error<typeof loadRouterConfiguration>,
  ) {
    return new StartupError({
      phase: "configuration",
      ...(error._tag === "LegacyConfigurationError"
        ? { reason: "legacy-key", keys: error.keys }
        : {}),
    });
  }

  function listenerFailure() {
    return new StartupError({ phase: "listener" });
  }
}
