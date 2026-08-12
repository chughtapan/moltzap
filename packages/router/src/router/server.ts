/** @file Production Router process composition and startup failure boundary. */
import { HttpServer } from "@effect/platform";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { AuthenticatedHttp } from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Data, Duration, Effect, Layer } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- NodeHttpServer.make requires Node's server factory at this adapter boundary.
import { createServer } from "node:http";
import {
  loadRouterConfiguration,
  type RouterConfiguration,
} from "./configuration.js";
import { makeRouterFeed } from "./feed.js";
import { makeRouterHttpApp } from "./http.js";
import {
  generatePollCursorKey,
  generateRouterInstanceId,
  makePollCursorCodec,
} from "./poll-cursor.js";
import { makePollWaiters } from "./poll-waiters.js";
import { makeRouterPoll } from "./poll.js";
import { makeRouterRpcClient } from "./rpc.js";
import { makeRouterSend } from "./send.js";

/** Closed Router startup phase. */
export class StartupError extends Data.TaggedError("RouterServerStartupError")<{
  readonly phase: "configuration" | "listener";
}> {}

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
 *   Binary["moltzap-router"] --> Server["RouterServer.layer"]
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
      catch: configurationFailure,
    });
    const cursorKey = yield* Effect.try({
      try: generatePollCursorKey,
      catch: configurationFailure,
    });
    const feed = yield* makeRouterFeed({
      routerInstanceId,
      retainedMessageCapacity: configuration.retainedMessageCapacity,
      retainedMessageByteCapacity: configuration.retainedMessageByteCapacity,
    });
    const pollWaiters = yield* makePollWaiters(configuration.heldPollCapacity);
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

function configurationFailure() {
  return new StartupError({ phase: "configuration" });
}

function listenerFailure() {
  return new StartupError({ phase: "listener" });
}
