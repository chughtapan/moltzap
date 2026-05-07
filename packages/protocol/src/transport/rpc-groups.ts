import { Data, Effect } from "effect";
import type { TSchema } from "@sinclair/typebox";
import type { NotificationFrame, RequestFrame } from "./wire.js";
import type { JsonRpcId } from "./wire.js";
import type {
  NotificationDefinition,
  RpcDefinition,
  ParamsOf,
  NotificationParamsOf,
} from "./method.js";

type AnyRpcDefinition = RpcDefinition<string, TSchema, TSchema>;
type AnyNotificationDefinition = NotificationDefinition<string, TSchema>;

export type DecodedRpcRequest<D extends AnyRpcDefinition> =
  D extends AnyRpcDefinition
    ? {
        readonly id: JsonRpcId;
        readonly definition: D;
        readonly params: ParamsOf<D>;
      }
    : never;

/** A decoded notification carries the discriminator + descriptor + typed
 * params + the original wire `jsonrpc`. It does NOT extend `NotificationFrame`
 * — re-encoding goes through `definition.encode(params)`, not by re-serializing
 * this struct, so the strict-additionalProperties wire schema stays unstuck. */
export type DecodedNotification<D extends AnyNotificationDefinition> =
  D extends AnyNotificationDefinition
    ? {
        readonly _tag: "Notification";
        readonly jsonrpc: NotificationFrame["jsonrpc"];
        readonly definition: D;
        readonly method: D["name"];
        readonly params: NotificationParamsOf<D>;
      }
    : never;

class UnknownRpcMethodError extends Data.TaggedError("UnknownRpcMethodError")<{
  readonly frame: RequestFrame;
}> {}

class InvalidRpcParamsError extends Data.TaggedError("InvalidRpcParamsError")<{
  readonly frame: RequestFrame;
  readonly definition: AnyRpcDefinition;
}> {}

export type RpcRequestDecodeError =
  | UnknownRpcMethodError
  | InvalidRpcParamsError;

class UnknownNotificationMethodError extends Data.TaggedError(
  "UnknownNotificationMethodError",
)<{
  readonly frame: NotificationFrame;
}> {}

class InvalidNotificationParamsError extends Data.TaggedError(
  "InvalidNotificationParamsError",
)<{
  readonly frame: NotificationFrame;
  readonly definition: AnyNotificationDefinition;
}> {}

export type NotificationDecodeError =
  | UnknownNotificationMethodError
  | InvalidNotificationParamsError;

export function decodeRpcRequest<
  const Definitions extends readonly AnyRpcDefinition[],
>(
  definitions: Definitions,
  frame: RequestFrame,
): Effect.Effect<
  DecodedRpcRequest<Definitions[number]>,
  RpcRequestDecodeError
> {
  const definition = definitions.find((d) => d.name === frame.method);
  if (definition === undefined) {
    return Effect.fail(new UnknownRpcMethodError({ frame }));
  }
  const params = frame.params ?? {};
  if (!definition.validateParams(params)) {
    return Effect.fail(new InvalidRpcParamsError({ frame, definition }));
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
  definitions: Definitions,
  frame: NotificationFrame,
): Effect.Effect<
  DecodedNotification<Definitions[number]>,
  NotificationDecodeError
> {
  const definition = definitions.find((d) => d.name === frame.method);
  if (definition === undefined) {
    return Effect.fail(new UnknownNotificationMethodError({ frame }));
  }
  const params = frame.params ?? {};
  if (!definition.validateParams(params)) {
    return Effect.fail(
      new InvalidNotificationParamsError({ frame, definition }),
    );
  }
  // Build the decoded view explicitly. `_tag` is enumerable; consumers
  // that need a wire-frame must re-encode via `definition.encode(params)`.
  return Effect.succeed({
    _tag: "Notification" as const,
    jsonrpc: frame.jsonrpc,
    definition,
    method: definition.name,
    params,
  } as DecodedNotification<Definitions[number]>);
}

export function isDecodedNotification<D extends AnyNotificationDefinition>(
  definition: D,
  notification: DecodedNotification<AnyNotificationDefinition>,
): notification is DecodedNotification<D> {
  return notification.definition === definition;
}
