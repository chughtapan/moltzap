import { HttpServer } from "@effect/platform";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { AuthenticatedHttp, Registry } from "@moltzap/v2-identity";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- NodeHttpServer.make requires Node's server factory at this adapter boundary.
import { createServer } from "node:http";
import { Data, Duration, Effect, Layer } from "effect";
import {
  loadRouterConfiguration,
  type RouterConfiguration,
} from "./configuration.js";
import { makeRouterFeed } from "./feed.js";
import { makeHeldPolls } from "./held-polls.js";
import { makeRouterHttpApp } from "./http.js";
import { makeRouterRpcClient } from "./operations.js";
import {
  generatePollCursorKey,
  generateRouterInstanceId,
  makePollCursorCodec,
} from "./poll-cursor.js";
import { makeRouterPoll } from "./poll.js";
import { makeRouterSend } from "./send.js";

/** Closed Router startup phase. */
export class StartupError extends Data.TaggedError("RouterServerStartupError")<{
  readonly phase: "configuration" | "listener";
}> {}

const configurationFailure = () => new StartupError({ phase: "configuration" });
const listenerFailure = () => new StartupError({ phase: "listener" });

const authenticatedHttpLayer = (configuration: RouterConfiguration) => {
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
};

const makeRequestHandler = (configuration: RouterConfiguration) =>
  Effect.gen(function* () {
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
    const heldPolls = yield* makeHeldPolls(configuration.heldPollCapacity);
    const send = makeRouterSend({
      routerInstanceId,
      feed,
      heldPolls,
    });
    const poll = makeRouterPoll({
      routerInstanceId,
      feed,
      heldPolls,
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

const serveRouter = Effect.gen(function* () {
  const configuration = yield* loadRouterConfiguration.pipe(
    Effect.mapError(configurationFailure),
  );
  const app = yield* makeRequestHandler(configuration);
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

/** Complete production Router process composition. */
export const layer: Layer.Layer<never, StartupError> =
  Layer.scopedDiscard(serveRouter);
