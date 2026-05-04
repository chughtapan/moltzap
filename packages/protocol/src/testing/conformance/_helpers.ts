/**
 * Conformance-suite shared helpers — small utilities used by multiple
 * property modules. Keep this file thin; promote utilities here only
 * when they would otherwise be duplicated verbatim.
 */
import { Effect, Either } from "effect";
import type { TSchema } from "@sinclair/typebox";
import type { RpcDefinition } from "../../rpc.js";
import type { TestClient } from "../test-client.js";
import type {
  FrameSchemaError,
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "../errors.js";

/**
 * Send an RPC whose descriptor is not in the typed `rpcMethods` registry
 * (e.g., `apps/register`). Returns the result as `unknown`; the cast
 * widens `client.sendRpc`'s `D extends AnyRpcDefinition` constraint.
 */
export function sendUntypedRpc(
  client: TestClient,
  definition: RpcDefinition<string, TSchema, TSchema>,
  params: unknown,
): Effect.Effect<
  unknown,
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError
  | FrameSchemaError
> {
  const sendRpc = client.sendRpc as (
    definition: RpcDefinition<string, TSchema, TSchema>,
    params: unknown,
  ) => Effect.Effect<
    unknown,
    | RpcResponseError
    | RpcTimeoutError
    | TransportClosedError
    | TransportIoError
    | FrameSchemaError
  >;
  return sendRpc(definition, params);
}

export function requireRight<A, E, F>(
  value: Either.Either<A, E>,
  onLeft: (error: E) => F,
): Effect.Effect<A, F> {
  return Either.match(value, {
    onLeft: (error) => Effect.fail(onLeft(error)),
    onRight: (success) => Effect.succeed(success),
  });
}

export function leftOrNull<A, E>(value: Either.Either<A, E>): E | null {
  return Either.match(value, {
    onLeft: (error) => error,
    onRight: () => null,
  });
}

export function eitherTag<A, E extends { readonly _tag: string }>(
  value: Either.Either<A, E>,
): "Right" | E["_tag"] {
  return Either.match(value, {
    onLeft: (error) => error._tag,
    onRight: () => "Right",
  });
}
