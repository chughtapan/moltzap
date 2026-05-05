/**
 * Descriptor-driven Effect-native RPC + notification group helpers.
 *
 * TypeBox + the shared AJV instance (`internal/ajv.ts`) is the single
 * runtime decode authority for wire data. This module owns the
 * Effect-native plumbing on top of those descriptors: group construction,
 * per-frame decode, handler binding, and dispatch.
 */
import { Data, Effect } from "effect";
import type { NotificationFrame, RequestFrame } from "./schema/frames.js";
import type { JsonRpcMethod, JsonRpcStringId } from "./schema/json-rpc.js";
import type {
  NotificationDefinition,
  NotificationParamsOf,
} from "./notification.js";
import type { ParamsOf, RpcDefinition, TSchema } from "./rpc.js";

type AnyRpcDefinition = RpcDefinition<string, TSchema, TSchema>;
type AnyNotificationDefinition = NotificationDefinition<string, TSchema>;

const descriptorMap = <D extends { readonly name: JsonRpcMethod }>(
  definitions: readonly D[],
): ReadonlyMap<JsonRpcMethod, D> => {
  const map = new Map<JsonRpcMethod, D>();
  for (const definition of definitions) {
    map.set(definition.name, definition);
  }
  return map;
};

const descriptorSet = <D>(definitions: readonly D[]): ReadonlySet<D> =>
  new Set(definitions);

export interface RpcDescriptorGroup<
  LayerName extends string,
  Definitions extends readonly AnyRpcDefinition[],
> {
  readonly layer: LayerName;
  readonly definitions: Definitions;
  readonly byName: ReadonlyMap<JsonRpcMethod, Definitions[number]>;
  readonly byDefinition: ReadonlySet<Definitions[number]>;
}

export interface NotificationDescriptorGroup<
  LayerName extends string,
  Definitions extends readonly AnyNotificationDefinition[],
> {
  readonly layer: LayerName;
  readonly definitions: Definitions;
  readonly byName: ReadonlyMap<JsonRpcMethod, Definitions[number]>;
  readonly byDefinition: ReadonlySet<Definitions[number]>;
}

export function defineRpcGroup<
  const LayerName extends string,
  const Definitions extends readonly AnyRpcDefinition[],
>(
  layer: LayerName,
  definitions: Definitions,
): RpcDescriptorGroup<LayerName, Definitions> {
  return {
    layer,
    definitions,
    byName: descriptorMap(definitions),
    byDefinition: descriptorSet(definitions),
  };
}

export function defineNotificationGroup<
  const LayerName extends string,
  const Definitions extends readonly AnyNotificationDefinition[],
>(
  layer: LayerName,
  definitions: Definitions,
): NotificationDescriptorGroup<LayerName, Definitions> {
  return {
    layer,
    definitions,
    byName: descriptorMap(definitions),
    byDefinition: descriptorSet(definitions),
  };
}

export type DecodedRpcRequest<D extends AnyRpcDefinition> =
  D extends AnyRpcDefinition
    ? {
        readonly id: JsonRpcStringId;
        readonly definition: D;
        readonly params: ParamsOf<D>;
      }
    : never;

/**
 * Common shape for a decoded notification — same wire fields and
 * descriptor attachment regardless of validation state. The `params`
 * channel is the only thing that differs between `Raw` and validated
 * `DecodedNotification` (see below); keeping the rest in one place
 * avoids drift if either shape evolves.
 */
type DecodedNotificationShape<
  D extends AnyNotificationDefinition,
  P,
> = NotificationFrame & {
  readonly _tag: "Notification";
  readonly definition: D;
  readonly method: D["name"];
  readonly params: P;
};

/**
 * What the wire decoder produces for a known method BEFORE payload
 * validation. The decoder is payload-opaque per the
 * `delivery/payload-opacity-client` and
 * `boundary/schema-exhaustive-fuzz-client` conformance properties — the
 * `params` field genuinely carries `unknown` until a typed bridge runs
 * `definition.validateParams` (or the shared `validateNotificationParams`
 * helper). Inbound flows: subscriber-fanout dispatch and the
 * `notificationsBufferRef` / `notificationWaitersRef` queues hold this
 * shape; typed bridges lift to `DecodedNotification<D>` after validation.
 */
export type RawDecodedNotification<D extends AnyNotificationDefinition> =
  D extends AnyNotificationDefinition
    ? DecodedNotificationShape<D, unknown>
    : never;

/**
 * Post-validation notification: `params` is statically narrowed to the
 * descriptor's payload type. Produced by the validating
 * `decodeNotification` (group helper below) and by typed-bridge lifts
 * (`validateNotificationParams` predicate); typed handlers consume this
 * shape exclusively.
 */
export type DecodedNotification<D extends AnyNotificationDefinition> =
  D extends AnyNotificationDefinition
    ? DecodedNotificationShape<D, NotificationParamsOf<D>>
    : never;

/**
 * What the wire decoder produces for an unknown method — the protocol
 * has no `NotificationDefinition` registered for `method`, so there is
 * no descriptor to attach. Conformance fuzz subscribers exercise this
 * branch (e.g. `schema-conformance/notification-well-formedness-client`,
 * `schema-conformance/malformed-frame-handling-client`); production
 * typed handlers cannot consume it because the discriminator
 * (`definition` field absent) excludes it from
 * `RawDecodedNotification<…>`.
 */
export interface UnknownDecodedNotification extends NotificationFrame {
  readonly _tag: "Notification";
  // Discriminator vs `RawDecodedNotification<…>`: this branch never has
  // `definition`. The compiler enforces the split — production code
  // that reads `notification.definition` cannot accept this branch.
  readonly definition?: undefined;
}

// `DecodedNotificationFrame` (the closed union over the protocol's
// concrete notification descriptors plus the unknown-method branch) is
// declared in `schema/notifications.ts` so it can specialize over the
// concrete `AnyNotificationDefinition` union (vs. the broad
// `NotificationDefinition<string, TSchema>` constraint visible here).
// Consumers import it from the package barrel — see
// `client/runtime/frame.ts` and `client/runtime/subscribers.ts`.

export class UnknownRpcMethodError extends Data.TaggedError(
  "UnknownRpcMethodError",
)<{
  readonly layer: string;
  readonly frame: RequestFrame;
}> {}

export class InvalidRpcParamsError extends Data.TaggedError(
  "InvalidRpcParamsError",
)<{
  readonly layer: string;
  readonly frame: RequestFrame;
  readonly definition: AnyRpcDefinition;
}> {}

export type RpcRequestDecodeError =
  | UnknownRpcMethodError
  | InvalidRpcParamsError;

export class UnknownNotificationMethodError extends Data.TaggedError(
  "UnknownNotificationMethodError",
)<{
  readonly layer: string;
  readonly frame: NotificationFrame;
}> {}

export class InvalidNotificationParamsError extends Data.TaggedError(
  "InvalidNotificationParamsError",
)<{
  readonly layer: string;
  readonly frame: NotificationFrame;
  readonly definition: AnyNotificationDefinition;
}> {}

export type NotificationDecodeError =
  | UnknownNotificationMethodError
  | InvalidNotificationParamsError;

export interface RpcBoundaryService<
  Definitions extends readonly AnyRpcDefinition[],
> {
  readonly decodeRequest: (
    frame: RequestFrame,
  ) => Effect.Effect<
    DecodedRpcRequest<Definitions[number]>,
    RpcRequestDecodeError
  >;
}

export interface NotificationBoundaryService<
  Definitions extends readonly AnyNotificationDefinition[],
> {
  readonly decode: (
    frame: NotificationFrame,
  ) => Effect.Effect<
    DecodedNotification<Definitions[number]>,
    NotificationDecodeError
  >;
}

export function makeRpcBoundaryService<
  const Definitions extends readonly AnyRpcDefinition[],
>(
  group: RpcDescriptorGroup<string, Definitions>,
): RpcBoundaryService<Definitions> {
  return {
    decodeRequest: (frame) => decodeRpcRequest(group, frame),
  };
}

export function makeNotificationBoundaryService<
  const Definitions extends readonly AnyNotificationDefinition[],
>(
  group: NotificationDescriptorGroup<string, Definitions>,
): NotificationBoundaryService<Definitions> {
  return {
    decode: (frame) => decodeNotification(group, frame),
  };
}

export function decodeRpcRequest<
  const Definitions extends readonly AnyRpcDefinition[],
>(
  group: RpcDescriptorGroup<string, Definitions>,
  frame: RequestFrame,
): Effect.Effect<
  DecodedRpcRequest<Definitions[number]>,
  RpcRequestDecodeError
> {
  const definition = group.byName.get(frame.method);
  if (definition === undefined) {
    return Effect.fail(
      new UnknownRpcMethodError({ layer: group.layer, frame }),
    );
  }
  const params = frame.params ?? {};
  if (!definition.validateParams(params)) {
    return Effect.fail(
      new InvalidRpcParamsError({ layer: group.layer, frame, definition }),
    );
  }
  return Effect.succeed({
    id: frame.id,
    definition,
    params,
  } as DecodedRpcRequest<Definitions[number]>);
}

export function decodeNotification<
  const Definitions extends readonly AnyNotificationDefinition[],
>(
  group: NotificationDescriptorGroup<string, Definitions>,
  frame: NotificationFrame,
): Effect.Effect<
  DecodedNotification<Definitions[number]>,
  NotificationDecodeError
> {
  const definition = group.byName.get(frame.method);
  if (definition === undefined) {
    return Effect.fail(
      new UnknownNotificationMethodError({ layer: group.layer, frame }),
    );
  }
  const params = frame.params ?? {};
  if (!definition.validateParams(params)) {
    return Effect.fail(
      new InvalidNotificationParamsError({
        layer: group.layer,
        frame,
        definition,
      }),
    );
  }
  // `_tag` attaches non-enumerably so the decoded value still satisfies
  // `validators.notificationFrame` (strict `additionalProperties: false`):
  // wire-shape preservation matters for downstream filters / serializers.
  const decoded: Record<string, unknown> = {
    ...frame,
    definition,
    method: definition.name,
    params,
  };
  Object.defineProperty(decoded, "_tag", {
    value: "Notification",
    enumerable: false,
  });
  return Effect.succeed(decoded as DecodedNotification<Definitions[number]>);
}

export function isDecodedRpcRequest<D extends AnyRpcDefinition>(
  definition: D,
  request: DecodedRpcRequest<AnyRpcDefinition>,
): request is DecodedRpcRequest<D> {
  return request.definition === definition;
}

/**
 * Definition-identity guard for a notification.
 *
 * Two overload shapes:
 *   1. Post-validation input (`DecodedNotification<…>`): narrows to
 *      `DecodedNotification<D>` — params remain typed.
 *   2. Pre-validation input (raw + unknown union): narrows to
 *      `RawDecodedNotification<D>` — params stay `unknown` until a
 *      typed bridge lifts via `validateNotificationParams`.
 *
 * The runtime check is identical (descriptor identity); the type
 * channel keeps the validated/unvalidated split honest. Order matters:
 * the validated overload appears first so a `DecodedNotification`
 * input picks it (subtype of the raw union).
 */
export function isDecodedNotification<D extends AnyNotificationDefinition>(
  definition: D,
  notification: DecodedNotification<AnyNotificationDefinition>,
): notification is DecodedNotification<D>;
export function isDecodedNotification<D extends AnyNotificationDefinition>(
  definition: D,
  notification:
    | RawDecodedNotification<AnyNotificationDefinition>
    | UnknownDecodedNotification,
): notification is RawDecodedNotification<D>;
export function isDecodedNotification<D extends AnyNotificationDefinition>(
  definition: D,
  notification:
    | DecodedNotification<AnyNotificationDefinition>
    | RawDecodedNotification<AnyNotificationDefinition>
    | UnknownDecodedNotification,
): boolean {
  return notification.definition === definition;
}

export function isDecodedRpcRequestInGroup<
  const Definitions extends readonly AnyRpcDefinition[],
>(
  group: RpcDescriptorGroup<string, Definitions>,
  request: DecodedRpcRequest<AnyRpcDefinition>,
): request is DecodedRpcRequest<Definitions[number]> {
  return group.byDefinition.has(request.definition as Definitions[number]);
}

/**
 * Group-membership guard for a notification.
 *
 * Two overload shapes parallel `isDecodedNotification`: validated
 * inputs narrow to `DecodedNotification<Definitions[number]>` (params
 * stay typed); raw inputs narrow to
 * `RawDecodedNotification<Definitions[number]>` (params stay
 * `unknown`). Inbound typed-bridge consumers (`service.handleNotification`)
 * use the raw overload, then run `validateNotificationParams` to lift
 * to the validated form before dispatching to typed handlers.
 */
export function isDecodedNotificationInGroup<
  const Definitions extends readonly AnyNotificationDefinition[],
>(
  group: NotificationDescriptorGroup<string, Definitions>,
  notification: DecodedNotification<AnyNotificationDefinition>,
): notification is DecodedNotification<Definitions[number]>;
export function isDecodedNotificationInGroup<
  const Definitions extends readonly AnyNotificationDefinition[],
>(
  group: NotificationDescriptorGroup<string, Definitions>,
  notification:
    | RawDecodedNotification<AnyNotificationDefinition>
    | UnknownDecodedNotification,
): notification is RawDecodedNotification<Definitions[number]>;
export function isDecodedNotificationInGroup<
  const Definitions extends readonly AnyNotificationDefinition[],
>(
  group: NotificationDescriptorGroup<string, Definitions>,
  notification:
    | DecodedNotification<AnyNotificationDefinition>
    | RawDecodedNotification<AnyNotificationDefinition>
    | UnknownDecodedNotification,
): boolean {
  const { definition } = notification;
  if (definition === undefined) return false;
  return group.byDefinition.has(definition as Definitions[number]);
}

export interface NotificationHandlerBinding<
  D extends AnyNotificationDefinition,
  E,
  R,
> {
  readonly definition: D;
  readonly handler: (
    params: NotificationParamsOf<D>,
  ) => Effect.Effect<void, E, R>;
}

export const bindNotificationHandler = <
  D extends AnyNotificationDefinition,
  E,
  R,
>(
  definition: D,
  handler: (params: NotificationParamsOf<D>) => Effect.Effect<void, E, R>,
): NotificationHandlerBinding<D, E, R> => ({ definition, handler });

type NotificationHandlerTuple<
  Definitions extends readonly AnyNotificationDefinition[],
  E,
> = {
  readonly [Index in keyof Definitions]: Definitions[Index] extends AnyNotificationDefinition
    ? NotificationHandlerBinding<Definitions[Index], E, unknown>
    : never;
};

type NotificationBindingRequirements<Bindings extends readonly unknown[]> =
  Bindings[number] extends NotificationHandlerBinding<
    AnyNotificationDefinition,
    unknown,
    infer R
  >
    ? R
    : never;

export interface EffectNotificationHandlerLayer<
  Definitions extends readonly AnyNotificationDefinition[],
  E,
  R,
> {
  readonly group: NotificationDescriptorGroup<string, Definitions>;
  readonly byName: ReadonlyMap<JsonRpcMethod, Definitions[number]>;
  readonly byDefinition: ReadonlySet<Definitions[number]>;
  readonly dispatch: (
    notification: DecodedNotification<Definitions[number]>,
  ) => Effect.Effect<void, E, R>;
}

/**
 * Bind a tuple of notification handlers to their descriptors. Returns a
 * dispatcher that routes each `DecodedNotification` to its handler by
 * descriptor identity, so dispatch is O(1) with no name-string compare.
 *
 * The internal handler map stores `unknown -> Effect<void, E, R>` because
 * `Definitions[number]` is a union and each binding is keyed to one
 * concrete `D`. Descriptor identity proves the type-level link between
 * the dispatched `params` and the bound handler — but it does NOT prove
 * the runtime params actually conform for *inbound* notifications: the
 * wire decoder is payload-opaque (required so
 * `delivery/payload-opacity-client` and
 * `boundary/schema-exhaustive-fuzz-client` conformance hold). Outbound
 * bindings whose call sites already constructed `params` against the
 * schema are safe. *Inbound* dispatchers MUST route through
 * `client/src/ws-client.ts:validateNotificationParams` before invoking
 * the handler. Current inbound bridges that do so:
 *   - `client/src/ws-client.ts:acceptTypedNotification` — typed
 *     `waitForNotification` promise resolver.
 *   - `client/src/service.ts:handleNotification` — subscriber-fanout
 *     dispatch into `notificationHandlers.dispatch`.
 * The cast inside `dispatch(notification.params)` below is sound for
 * outbound, unsound for unguarded inbound — every inbound bridge owns
 * the validation step.
 */
export function defineEffectNotificationHandlers<
  const Definitions extends readonly AnyNotificationDefinition[],
  E,
  const Bindings extends NotificationHandlerTuple<Definitions, E>,
>(
  group: NotificationDescriptorGroup<string, Definitions>,
  bindings: Bindings,
): EffectNotificationHandlerLayer<
  Definitions,
  E,
  NotificationBindingRequirements<Bindings>
> {
  type Requirements = NotificationBindingRequirements<Bindings>;
  const dispatchHandlers = new Map<
    AnyNotificationDefinition,
    (params: unknown) => Effect.Effect<void, E, Requirements>
  >();
  for (const binding of bindings) {
    dispatchHandlers.set(
      binding.definition,
      binding.handler as (
        params: unknown,
      ) => Effect.Effect<void, E, Requirements>,
    );
  }
  return {
    group,
    byName: group.byName,
    byDefinition: group.byDefinition,
    dispatch: (notification) => {
      const handler = dispatchHandlers.get(notification.definition);
      if (handler === undefined) {
        return Effect.die(
          new Error(
            `Missing notification handler for ${String(notification.method)}`,
          ),
        );
      }
      return handler(notification.params);
    },
  };
}
