import { Rpc, RpcGroup } from "@effect/rpc";
import { Data, Effect, Layer, Schema } from "effect";
import type { NotificationFrame, RequestFrame } from "./schema/frames.js";
import type { JsonRpcMethod, JsonRpcStringId } from "./schema/json-rpc.js";
import type {
  NotificationDefinition,
  NotificationParamsOf,
} from "./notification.js";
import type { ParamsOf, ResultOf, RpcDefinition, TSchema } from "./rpc.js";

type AnyRpcDefinition = RpcDefinition<string, TSchema, TSchema>;
type AnyNotificationDefinition = NotificationDefinition<string, TSchema>;

type EffectRpcFor<D extends AnyRpcDefinition> = Rpc.Rpc<
  D["name"],
  Schema.Schema<ParamsOf<D>>,
  Schema.Schema<ResultOf<D>>
>;

type EffectNotificationRpcFor<D extends AnyNotificationDefinition> = Rpc.Rpc<
  D["name"],
  Schema.Schema<NotificationParamsOf<D>>,
  typeof Schema.Void
>;

type EffectRpcUnion<Definitions extends readonly AnyRpcDefinition[]> =
  Definitions[number] extends infer D
    ? D extends AnyRpcDefinition
      ? EffectRpcFor<D>
      : never
    : never;

type EffectNotificationRpcUnion<
  Definitions extends readonly AnyNotificationDefinition[],
> = Definitions[number] extends infer D
  ? D extends AnyNotificationDefinition
    ? EffectNotificationRpcFor<D>
    : never
  : never;

/**
 * TypeBox remains the runtime decode authority for MoltZap wire data.
 * `@effect/rpc` needs an Effect Schema at descriptor-construction time, so
 * we give it an opaque schema with the TypeBox static type projected onto it.
 * These schemas are intentionally not used to validate the wire; the
 * descriptor's compiled AJV validator is the only boundary decoder.
 */
const bridgeEffectRpcType = <A>(value: unknown): A => value as A;

const opaqueEffectSchema = <A>(): Schema.Schema<A> =>
  Schema.declare<A>((input): input is A => {
    void input;
    return true;
  });

const toEffectRpc = <D extends AnyRpcDefinition>(
  definition: D,
): EffectRpcFor<D> =>
  Rpc.make(definition.name, {
    payload: opaqueEffectSchema<ParamsOf<D>>(),
    success: opaqueEffectSchema<ResultOf<D>>(),
  });

const toEffectNotificationRpc = <D extends AnyNotificationDefinition>(
  definition: D,
): EffectNotificationRpcFor<D> =>
  Rpc.make(definition.name, {
    payload: opaqueEffectSchema<NotificationParamsOf<D>>(),
    success: Schema.Void,
  });

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
  readonly effectGroup: RpcGroup.RpcGroup<EffectRpcUnion<Definitions>>;
  readonly byName: ReadonlyMap<JsonRpcMethod, Definitions[number]>;
  readonly byDefinition: ReadonlySet<Definitions[number]>;
}

export interface NotificationDescriptorGroup<
  LayerName extends string,
  Definitions extends readonly AnyNotificationDefinition[],
> {
  readonly layer: LayerName;
  readonly definitions: Definitions;
  readonly effectGroup: RpcGroup.RpcGroup<
    EffectNotificationRpcUnion<Definitions>
  >;
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
  const effectRpcs = definitions.map(toEffectRpc);
  return {
    layer,
    definitions,
    effectGroup: bridgeEffectRpcType<
      RpcGroup.RpcGroup<EffectRpcUnion<Definitions>>
    >(RpcGroup.make(...effectRpcs)),
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
  const effectRpcs = definitions.map(toEffectNotificationRpc);
  return {
    layer,
    definitions,
    effectGroup: bridgeEffectRpcType<
      RpcGroup.RpcGroup<EffectNotificationRpcUnion<Definitions>>
    >(RpcGroup.make(...effectRpcs)),
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

export type DecodedNotification<D extends AnyNotificationDefinition> =
  D extends AnyNotificationDefinition
    ? NotificationFrame & {
        readonly definition: D;
        readonly method: D["name"];
        readonly params: NotificationParamsOf<D>;
      }
    : never;

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
  return Effect.succeed({
    ...frame,
    definition,
    method: definition.name,
    params,
  } as DecodedNotification<Definitions[number]>);
}

export function isDecodedRpcRequest<D extends AnyRpcDefinition>(
  definition: D,
  request: DecodedRpcRequest<AnyRpcDefinition>,
): request is DecodedRpcRequest<D> {
  return request.definition === definition;
}

export function isDecodedNotification<D extends AnyNotificationDefinition>(
  definition: D,
  notification: DecodedNotification<AnyNotificationDefinition>,
): notification is DecodedNotification<D> {
  return notification.definition === definition;
}

export interface RpcHandlerBinding<D extends AnyRpcDefinition, E, R> {
  readonly definition: D;
  readonly handler: (params: ParamsOf<D>) => Effect.Effect<ResultOf<D>, E, R>;
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

export const bindRpcHandler = <D extends AnyRpcDefinition, E, R>(
  definition: D,
  handler: (params: ParamsOf<D>) => Effect.Effect<ResultOf<D>, E, R>,
): RpcHandlerBinding<D, E, R> => ({ definition, handler });

export const bindNotificationHandler = <
  D extends AnyNotificationDefinition,
  E,
  R,
>(
  definition: D,
  handler: (params: NotificationParamsOf<D>) => Effect.Effect<void, E, R>,
): NotificationHandlerBinding<D, E, R> => ({ definition, handler });

type RpcHandlerTuple<Definitions extends readonly AnyRpcDefinition[], E> = {
  readonly [Index in keyof Definitions]: Definitions[Index] extends AnyRpcDefinition
    ? RpcHandlerBinding<Definitions[Index], E, unknown>
    : never;
};

type NotificationHandlerTuple<
  Definitions extends readonly AnyNotificationDefinition[],
  E,
> = {
  readonly [Index in keyof Definitions]: Definitions[Index] extends AnyNotificationDefinition
    ? NotificationHandlerBinding<Definitions[Index], E, unknown>
    : never;
};

type RpcBindingRequirements<Bindings extends readonly unknown[]> =
  Bindings[number] extends RpcHandlerBinding<AnyRpcDefinition, unknown, infer R>
    ? R
    : never;

type NotificationBindingRequirements<Bindings extends readonly unknown[]> =
  Bindings[number] extends NotificationHandlerBinding<
    AnyNotificationDefinition,
    unknown,
    infer R
  >
    ? R
    : never;

export interface EffectRpcHandlerLayer<
  Definitions extends readonly AnyRpcDefinition[],
  E,
  R,
> {
  readonly group: RpcDescriptorGroup<string, Definitions>;
  readonly layer: Layer.Layer<
    Rpc.ToHandler<EffectRpcUnion<Definitions>>,
    never,
    R
  >;
  readonly byName: ReadonlyMap<JsonRpcMethod, Definitions[number]>;
  readonly byDefinition: ReadonlySet<Definitions[number]>;
  readonly dispatch: (
    request: DecodedRpcRequest<Definitions[number]>,
  ) => Effect.Effect<ResultOf<Definitions[number]>, E, R>;
}

export interface EffectNotificationHandlerLayer<
  Definitions extends readonly AnyNotificationDefinition[],
  E,
  R,
> {
  readonly group: NotificationDescriptorGroup<string, Definitions>;
  readonly layer: Layer.Layer<
    Rpc.ToHandler<EffectNotificationRpcUnion<Definitions>>,
    never,
    R
  >;
  readonly byName: ReadonlyMap<JsonRpcMethod, Definitions[number]>;
  readonly byDefinition: ReadonlySet<Definitions[number]>;
  readonly dispatch: (
    notification: DecodedNotification<Definitions[number]>,
  ) => Effect.Effect<void, E, R>;
}

export function isDecodedRpcRequestInGroup<
  const Definitions extends readonly AnyRpcDefinition[],
>(
  group: RpcDescriptorGroup<string, Definitions>,
  request: DecodedRpcRequest<AnyRpcDefinition>,
): request is DecodedRpcRequest<Definitions[number]> {
  return group.byDefinition.has(request.definition as Definitions[number]);
}

export function isDecodedNotificationInGroup<
  const Definitions extends readonly AnyNotificationDefinition[],
>(
  group: NotificationDescriptorGroup<string, Definitions>,
  notification: DecodedNotification<AnyNotificationDefinition>,
): notification is DecodedNotification<Definitions[number]> {
  return group.byDefinition.has(notification.definition as Definitions[number]);
}

export function defineEffectRpcHandlers<
  const Definitions extends readonly AnyRpcDefinition[],
  E,
  const Bindings extends RpcHandlerTuple<Definitions, E>,
>(
  group: RpcDescriptorGroup<string, Definitions>,
  bindings: Bindings,
): EffectRpcHandlerLayer<Definitions, E, RpcBindingRequirements<Bindings>> {
  const dispatchHandlers = new Map<
    Definitions[number],
    (params: unknown) => Effect.Effect<unknown, E, unknown>
  >();
  const handlers = Object.fromEntries(
    bindings.map((binding) => {
      const handler = (params: unknown) =>
        binding.handler(bridgeEffectRpcType<never>(params));
      dispatchHandlers.set(binding.definition as Definitions[number], handler);
      return [binding.definition.name, handler];
    }),
  );
  return {
    group,
    layer: group.effectGroup.toLayer(
      group.effectGroup.of(
        bridgeEffectRpcType<RpcGroup.HandlersFrom<EffectRpcUnion<Definitions>>>(
          handlers,
        ),
      ),
    ) as Layer.Layer<
      Rpc.ToHandler<EffectRpcUnion<Definitions>>,
      never,
      RpcBindingRequirements<Bindings>
    >,
    byName: group.byName,
    byDefinition: group.byDefinition,
    dispatch: (request) => {
      const handler = dispatchHandlers.get(request.definition);
      if (handler === undefined) {
        return Effect.die(new Error("Missing RPC handler for descriptor"));
      }
      return handler(request.params) as Effect.Effect<
        ResultOf<Definitions[number]>,
        E,
        RpcBindingRequirements<Bindings>
      >;
    },
  };
}

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
  const dispatchHandlers = new Map<
    Definitions[number],
    (params: unknown) => Effect.Effect<void, E, unknown>
  >();
  const handlers = Object.fromEntries(
    bindings.map((binding) => {
      const handler = (params: unknown) =>
        binding.handler(bridgeEffectRpcType<never>(params));
      dispatchHandlers.set(binding.definition as Definitions[number], handler);
      return [binding.definition.name, handler];
    }),
  );
  return {
    group,
    layer: group.effectGroup.toLayer(
      group.effectGroup.of(
        bridgeEffectRpcType<
          RpcGroup.HandlersFrom<EffectNotificationRpcUnion<Definitions>>
        >(handlers),
      ),
    ) as Layer.Layer<
      Rpc.ToHandler<EffectNotificationRpcUnion<Definitions>>,
      never,
      NotificationBindingRequirements<Bindings>
    >,
    byName: group.byName,
    byDefinition: group.byDefinition,
    dispatch: (notification) => {
      const handler = dispatchHandlers.get(notification.definition);
      if (handler === undefined) {
        return Effect.die(
          new Error("Missing notification handler for descriptor"),
        );
      }
      return handler(notification.params) as Effect.Effect<
        void,
        E,
        NotificationBindingRequirements<Bindings>
      >;
    },
  };
}
