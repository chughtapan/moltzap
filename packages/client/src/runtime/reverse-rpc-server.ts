/**
 * @file The client-side reverse `@effect/rpc` server over the shared socket.
 *
 * A connected client stands ONE `RpcServer&lt;ReverseRpcGroup>` as the socket's
 * `server` sink. `ReverseRpcGroup` is the moderator callbacks
 * (`dispatch/authorize`, `messages/authorize`, `task/create`) ∪ every
 * notification. The server fires these as reverse RPCs (request-family frames);
 * this engine serves them:
 *
 * - A NOTIFICATION handler routes Schema-decoded params into the
 *   `SubscriberRegistry` (so `client.subscribe(def)` Streams fire), then
 *   returns `void` — the notification is fire-and-forget on the server side,
 *   the void ack just settles the reverse RPC.
 * - A CALLBACK handler runs the moderator logic (app clients only). An agent
 *   client is never a moderator, so its callback handlers reject — but they
 *   must still be present so the handler map covers every group member.
 *
 * This is the SERVER side of the socket (`makeServerChannelProtocol`): the
 * client originates nothing here, it only serves the server's reverse RPCs. The
 * caller registers the returned sink as the socket's `server` sink with
 * `runMuxReader`.
 */
import { RpcServer } from "@effect/rpc";
import type { RpcGroup } from "@effect/rpc";
import { Deferred, Effect, Layer, Scope } from "effect";
import {
  ReverseRpcGroup,
  notificationDefinitions,
  makeServerProtocolLayer,
  type ChannelSink,
  type AnyNotificationDefinition,
  type NotConnectedError,
  type NotificationDelivery,
  type NotificationSubscriberRegistry,
  type NotificationParamsOf,
  type WireWrite,
} from "@moltzap/protocol";
import { Mailbox } from "effect";

type SubscriberRegistry = NotificationSubscriberRegistry<NotConnectedError>;

/**
 * One notification handler: route the Schema-decoded params into the
 * `SubscriberRegistry`, return void. Closes over the definition so dispatch's
 * `definition ===` match fires for `subscribe(def)`.
 */
const notificationHandler =
  (registry: SubscriberRegistry, definition: AnyNotificationDefinition) =>
  (params: unknown) => {
    // The `definition`/`params` correlation holds by construction: this handler
    // is bound to exactly this notification's reverse-RPC member, so the engine
    // decoded `params` against `definition.paramsSchema`.
    return registry.dispatch(
      {
        definition,
        method: definition.name,
        params: params as NotificationParamsOf<AnyNotificationDefinition>,
      } as NotificationDelivery,
    );
  };

/** One erased reverse-handler slot: any payload, any failure, `void`-ish result. */
type ReverseHandler = (params: never) => Effect.Effect<unknown, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow an unknown to an indexable object, or undefined when it is not one. */
const asObject = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

/** The `_tag` discriminant of a value, or undefined when it is not an object. */
const tagOf = (value: unknown): unknown => asObject(value)?.["_tag"];

/**
 * The flat tagged error inside an engine `Cause` envelope, or undefined when the
 * frame is not the single-failure shape the unwrap targets. The serializer
 * encodes a reverse-handler failure as
 * `{error:{_tag:"Cause", code, message, data: theEffectCause}}`; this digs out
 * the `{_tag:"Forbidden", message, data}` tagged error from `error.data` when
 * that Cause is a single `Fail`. Any other shape (`Die`/`Parallel`/`Sequential`,
 * or an already-flat error) yields undefined.
 */
const taggedErrorFromCause = (frame: Record<string, unknown>): unknown => {
  const error = asObject(frame["error"]);
  if (error === undefined || error["_tag"] !== "Cause") return undefined;
  const cause = asObject(error["data"]);
  if (cause === undefined || cause["_tag"] !== "Fail") return undefined;
  const tagged = cause["error"];
  return typeof tagOf(tagged) === "string" ? tagged : undefined;
};

/**
 * Wrap the reverse `WireWrite` so a reverse-handler error frame leaves the wire
 * as a flat tagged error, the same projection the forward call path surfaces.
 * Each chunk is a bare encoded engine frame. Rewrite it only when its `error`
 * carries the engine's `Cause` envelope, otherwise pass the chunk through
 * untouched.
 *
 * Only error frames need rewriting, and the `Cause` envelope always carries the
 * `Cause` discriminant, so a cheap substring guard skips the `JSON.parse` for
 * every success ack and notification, which is the common case.
 */
const flattenReverseErrors =
  (write: WireWrite): WireWrite =>
  (chunk) => {
    if (!chunk.includes("Cause")) return write(chunk);
    const rewritten = rewriteCauseFrame(chunk);
    return write(rewritten ?? chunk);
  };

/**
 * Rewrite one chunk's error frame to the flat tagged error, or undefined when
 * the chunk is not a rewritable `Cause`-carrying error frame (non-JSON, no
 * `error`, or a non-single-failure Cause). The spread preserves every frame
 * field, so any future engine metadata rides through untouched.
 */
const rewriteCauseFrame = (chunk: string): string | undefined => {
  const frame = asObject(parseJson(chunk));
  if (frame === undefined) return undefined;
  const tagged = taggedErrorFromCause(frame);
  if (tagged === undefined) return undefined;
  return JSON.stringify({ ...frame, error: tagged });
};

/**
 * `JSON.parse` that yields undefined instead of throwing on bad input. A parse
 * failure here is not an error to surface — it means this chunk is not a
 * rewritable error frame, so the caller forwards the original bytes untouched.
 */
const parseJson = (raw: string): unknown =>
  Effect.runSync(
    Effect.try(() => JSON.parse(raw) as unknown).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );

/**
 * Build the reverse handler map. Every notification tag routes into the
 * registry; the three callback tags use the supplied `callbackHandlers` (the
 * app client's moderator handlers) or a default reject (an agent client serves
 * the group but is never a moderator).
 *
 * The return is annotated `HandlersFrom&lt;Rpcs>` (a plain type annotation, NOT a
 * cast): TS checks the dynamically-keyed `Record` is assignable to the branded
 * per-tag shape — each slot's erased `(params: never) => Effect&lt;unknown,
 * unknown>` is broad enough to satisfy every member's `ToHandlerFn` — so the
 * binding is type-verified, not laundered. The per-tag payload↔handler
 * correlation holds by construction (each notification handler is bound to its
 * own definition; each callback handler keyed by its method name).
 */
const buildReverseHandlers = (options: {
  readonly registry: SubscriberRegistry;
  readonly callbackHandlers: Record<
    string,
    (params: unknown) => Effect.Effect<unknown, unknown>
  >;
}): RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ReverseRpcGroup>> => {
  const handlers: Record<string, ReverseHandler> = {};
  for (const definition of notificationDefinitions) {
    handlers[definition.name] = notificationHandler(
      options.registry,
      definition,
    );
  }
  for (const [tag, handler] of Object.entries(options.callbackHandlers)) {
    handlers[tag] = handler;
  }
  return handlers;
};

/**
 * Stand the reverse `RpcServer&lt;ReverseRpcGroup>` over one socket. Returns the
 * {@link ChannelSink} the caller registers as the socket's `server` sink with
 * `runMuxReader`. The engine reader is forked into the provided `Scope`.
 */
export const buildReverseServer = (options: {
  readonly registry: SubscriberRegistry;
  readonly callbackHandlers: Record<
    string,
    (params: unknown) => Effect.Effect<unknown, unknown>
  >;
  readonly write: WireWrite;
  readonly scope: Scope.Scope;
}): Effect.Effect<{ readonly sink: ChannelSink }> =>
  Effect.gen(function* () {
    const sinkReady = yield* Deferred.make<ChannelSink>();
    const disconnects = yield* Mailbox.make<number>();
    const protocolLayer = makeServerProtocolLayer({
      write: flattenReverseErrors(options.write),
      disconnects,
      sinkReady,
    });
    const handlers = buildReverseHandlers(options);
    const engineLayer = RpcServer.layer(ReverseRpcGroup).pipe(
      Layer.provide(ReverseRpcGroup.toLayer(handlers)),
      Layer.provide(protocolLayer),
    );
    yield* Layer.build(engineLayer).pipe(Scope.extend(options.scope));
    const sink = yield* Deferred.await(sinkReady);
    return { sink };
  }).pipe(Effect.withSpan("buildReverseServer"));
