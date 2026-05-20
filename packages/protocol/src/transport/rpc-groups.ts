/* eslint-disable jsdoc/text-escaping -- JSDoc references to generic types like `NotificationParamsOf<D>` use natural angle-bracket form inside backtick spans; matches filter-equivalence.test.ts precedent. */
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

type AnyServerRpcDefinition = RpcDefinition<string, TSchema, TSchema>;
type AnyNotificationDefinition = NotificationDefinition<string, TSchema>;

export type DecodedRpcRequest<D extends AnyServerRpcDefinition> =
  D extends AnyServerRpcDefinition
    ? {
        readonly frame: RequestFrame;
        readonly id: JsonRpcId;
        readonly definition: D;
        readonly params: ParamsOf<D>;
      }
    : never;

/**
 * A decoded notification carries the discriminator + descriptor + typed
 * params + the original wire `jsonrpc`. It does NOT extend `NotificationFrame`
 * — re-encoding goes through `definition.encode(params)`, not by re-serializing
 * this struct, so the strict-additionalProperties wire schema stays unstuck.
 *
 * The optional second parameter `R` narrows the `params` field to the refined
 * type — used by `MoltZapWsClient.subscribe`'s user-defined-type-guard
 * overload (spec #596 / architect plan §5.2). The default sentinel
 * `unknown` resolves to the per-branch `NotificationParamsOf<D>` shape,
 * preserving the one-arg form for every existing consumer.
 *
 * The default uses an `unknown` sentinel rather than `NotificationParamsOf<D>`
 * because TS does not distribute type-alias defaults through the
 * `D extends AnyNotificationDefinition` distributive conditional below —
 * a `NotificationParamsOf<D>` default would resolve once over the input
 * union and break per-branch params narrowing for `D` unions like
 * `DispatchesConsumed | DispatchesExpired`. Carrying `R` as a sentinel and
 * resolving inside the conditional keeps the original `params` shape per
 * distribution branch when the one-arg form is used.
 */
export type DecodedNotification<
  D extends AnyNotificationDefinition,
  R = unknown,
> = D extends AnyNotificationDefinition
  ? {
      readonly _tag: "Notification";
      readonly jsonrpc: NotificationFrame["jsonrpc"];
      readonly definition: D;
      readonly method: D["name"];
      readonly params: unknown extends R
        ? NotificationParamsOf<D>
        : Extract<R, NotificationParamsOf<D>>;
    }
  : never;

class UnknownRpcMethodError extends Data.TaggedError("UnknownRpcMethodError")<{
  readonly frame: RequestFrame;
}> {}

class InvalidRpcParamsError extends Data.TaggedError("InvalidRpcParamsError")<{
  readonly frame: RequestFrame;
  readonly definition: AnyServerRpcDefinition;
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
  const Definitions extends readonly AnyServerRpcDefinition[],
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
    frame,
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
