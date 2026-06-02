/**
 * @file The client-side reverse `@effect/rpc` server over the s2c channel.
 *
 * A connected client stands ONE `RpcServer&lt;ReverseRpcGroup>` on the s2c mux
 * sink. `ReverseRpcGroup` is the moderator callbacks (`dispatch/authorize`,
 * `messages/authorize`, `task/create`) ∪ every notification. The server fires
 * these as reverse RPCs over the s2c channel; this engine serves them:
 *
 * - A NOTIFICATION handler builds a `DecodedNotification` from the wire payload
 *   and routes it into the `SubscriberRegistry` (so `client.subscribe(def)`
 *   Streams fire), then returns `void` — the notification is fire-and-forget on
 *   the server side, the void ack just settles the reverse RPC.
 * - A CALLBACK handler runs the moderator logic (app clients only). An agent
 *   client is never a moderator, so its callback handlers reject — but they
 *   must still be present so the handler map covers every group member.
 *
 * The s2c Protocol is the SERVER side of the mux (`makeServerChannelProtocol`,
 * channel `s2c`): the client originates nothing on s2c, it only serves. The
 * caller registers the returned sink with `runMuxReader`.
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
  type DecodedNotification,
  type WireWrite,
} from "@moltzap/protocol";
import { Mailbox } from "effect";
import type { SubscriberRegistry } from "./subscribers.js";

/**
 * One notification handler: build the `DecodedNotification` envelope the
 * `SubscriberRegistry` dispatches, route it, return void. Closes over the
 * definition so `dispatch`'s `definition ===` match fires for `subscribe(def)`.
 */
const notificationHandler =
  (registry: SubscriberRegistry, definition: AnyNotificationDefinition) =>
  (params: unknown) => {
    // The `definition`/`params` correlation holds by construction: this handler
    // is bound to exactly this notification's wire member, so the engine
    // decoded `params` against `definition.paramsSchema`. The `dispatch`
    // signature wants the distributed `DecodedNotification` union; the envelope
    // shape is structurally that for this member.
    const decoded = {
      _tag: "Notification",
      jsonrpc: "2.0",
      definition,
      method: definition.name,
      params,
    } as DecodedNotification<AnyNotificationDefinition>;
    return registry.dispatch(decoded);
  };

/** One erased reverse-handler slot: any payload, any failure, `void`-ish result. */
type ReverseHandler = (
  params: never,
) => Effect.Effect<unknown, unknown>;

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
 * Stand the reverse `RpcServer&lt;ReverseRpcGroup>` over one socket's s2c channel.
 * Returns the s2c {@link ChannelSink} the caller registers with `runMuxReader`.
 * The engine reader is forked into the provided `Scope`.
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
      channel: "s2c",
      write: options.write,
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
