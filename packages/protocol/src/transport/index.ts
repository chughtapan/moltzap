/**
 * @file Internal transport runtime helpers and shared wire contracts.
 * @internal
 */
import type { Rpc } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import { Effect } from "effect";

// RPC + notification descriptor types. Effect RPC owns frame decoding; these
// descriptors own per-method payload/result schemas and the client subscription
// notification envelope produced after native decode.
export type {
  RpcDefinition,
  RpcDefinitionAny,
  NotificationDefinition,
  NotificationDefinitionAny,
  ParamsOf,
  ResultOf,
  NotificationPayloadOf,
  NotificationParamsOf,
  NotificationDelivery,
  RpcErrorClass,
  CallErrorsOf,
  DomainErrorsOf,
  RequirementErrorsOf,
  ResponseErrorsOf,
} from "./definition.js";
/** Re-exports the public API from `./definition.js`. */
export {
  defineNotification,
  defineRpc,
  isNotificationDeliveryFor,
} from "./definition.js";

/** Re-exports the public API from `./notification-subscribers.js`. */
export {
  makeNotificationSubscriberRegistry,
  notificationSubscribe,
  notificationSubscribeAll,
} from "./notification-subscribers.js";
/** Re-exports the public API from `./notification-subscribers.js`. */
export type {
  NotificationSubscriberRegistry,
  NotificationSubscriberRegistryOptions,
  NotificationSubscriptionHandle,
} from "./notification-subscribers.js";

/** The `Rpc` member of `Rpcs` whose tag is `K`. */
export type RpcForTag<
  Rpcs extends Rpc.Any,
  K extends Rpcs["_tag"],
> = Extract<Rpcs, { readonly _tag: K }>;

/** The payload type one tag accepts. */
export type PayloadForTag<
  Rpcs extends Rpc.Any,
  K extends Rpcs["_tag"],
> = Rpc.PayloadConstructor<RpcForTag<Rpcs, K>>;

/** The success type one tag returns. */
export type SuccessForTag<
  Rpcs extends Rpc.Any,
  K extends Rpcs["_tag"],
> = Rpc.Success<RpcForTag<Rpcs, K>>;

/** The method's own tagged-error union for one tag. */
export type ErrorForTag<
  Rpcs extends Rpc.Any,
  K extends Rpcs["_tag"],
> = Rpc.Error<RpcForTag<Rpcs, K>>;

/** A tag-keyed view of the non-flat client returned by `RpcClient.make`. */
export type TypedDispatchMap<Rpcs extends Rpc.Any, E> = {
  readonly [K in Rpcs["_tag"]]: (
    payload: PayloadForTag<Rpcs, K>,
  ) => Effect.Effect<SuccessForTag<Rpcs, K>, ErrorForTag<Rpcs, K> | E>;
};

/** Dispatches one call while retaining the selected tag's exact types. */
export function dispatchCall<
  Rpcs extends Rpc.Any,
  E,
  K extends Rpcs["_tag"],
>(
  map: TypedDispatchMap<Rpcs, E>,
  tag: K,
  payload: PayloadForTag<Rpcs, K>,
): Effect.Effect<SuccessForTag<Rpcs, K>, ErrorForTag<Rpcs, K> | E> {
  return map[tag](payload);
}

/**
 * Binds a non-flat client to a tag-keyed call and folds the engine's closed
 * socket error into the caller's transport error channel.
 */
export function makeTypedTransportCall<
  Rpcs extends Rpc.Any,
  TransportError,
>(
  client: TypedDispatchMap<Rpcs, RpcClientError>,
  onTransportError: () => TransportError,
): <Tag extends Rpcs["_tag"]>(
  tag: Tag,
  payload: PayloadForTag<Rpcs, Tag>,
) => Effect.Effect<
  SuccessForTag<Rpcs, Tag>,
  ErrorForTag<Rpcs, Tag> | TransportError
> {
  return (tag, payload) =>
    dispatchCall(client, tag, payload).pipe(
      Effect.catchTag("RpcClientError", () => Effect.fail(onTransportError())),
    );
}

/** Re-exports the public API from `./pagination.js`. */
export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  listLimitSchema,
  listCursorSchema,
} from "./pagination.js";
/** Re-exports the public API from `./pagination.js`. */
export type { ListCursor } from "./pagination.js";

/** Re-exports the public API from `./wire-string.js`. */
export {
  dateTimeStringSchema,
  formatString,
  stringEnum,
} from "./wire-string.js";

// Transport-layer call errors: the failures that originate at the CLIENT
// transport, not at a method handler. Domain failures ride their own
// `Schema.TaggedError` class, decoded per-method against the method's
// `errorSchema` union by `_tag`.
/** Re-exports the public API from `./rpc-errors.js`. */
export { NotConnectedError, RpcTimeoutError } from "./rpc-errors.js";

// Cross-cutting wire tagged-error classes. Each is a `Schema.TaggedError`: both
// the runtime failure constructor AND a wire `Schema` whose `_tag` is the
// per-method error-union discriminant the engine decodes against.
/** Re-exports the public API from `./wire-errors.js`. */
export {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidParamsError,
  // Connect-handler wire error.
  AlreadyConnected,
  principalGateErrorClasses,
  // Shared optional `message`/`data` fields every wire tagged-error carries.
  errorPayloadFields,
} from "./wire-errors.js";
/** Re-exports the public API from `./wire-errors.js`. */
export type { RpcErrorPayload } from "./wire-errors.js";

/** Re-exports the public API from `./mux.js`. */
export {
  makeClientChannelProtocol,
  makeServerChannelProtocol,
  runMuxReader,
} from "./mux.js";
/** Re-exports the public API from `./mux.js`. */
export type { ChannelSink, WireWrite } from "./mux.js";
