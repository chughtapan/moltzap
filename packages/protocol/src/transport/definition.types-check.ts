/**
 * @file Compile-time canaries for descriptor-derived RPC handler errors.
 *
 * `Rpc.ToHandlerFn` must read the precise handler-domain error schema carried
 * by `defineRpc`. Each negative control is guarded by `@ts-expect-error`, so
 * erasing that schema back to `any` makes the directive unused and fails the
 * build with TS2578.
 */
import type { Rpc } from "@effect/rpc";
import { Effect, Schema } from "effect";
import { defineRpc } from "./definition.js";

class DeclaredError extends Schema.TaggedError<DeclaredError>()(
  "DefinitionCanaryError",
  { data: Schema.Struct({ code: Schema.String }) },
) {}

class UndeclaredError extends Schema.TaggedError<UndeclaredError>()(
  "UndeclaredDefinitionCanaryError",
  {},
) {}

class IncompatibleSameTagError extends Schema.TaggedError<IncompatibleSameTagError>()(
  "DefinitionCanaryError",
  { data: Schema.Struct({ code: Schema.Number }) },
) {}

const definition = defineRpc({
  name: "definition/type-canary",
  params: Schema.Struct({}),
  result: Schema.Void,
  requires: [],
  errors: [DeclaredError],
});

type Handler = Rpc.ToHandlerFn<typeof definition.serverRpc, never>;
type IsAny<A> = 0 extends 1 & A ? true : false;
type ExpectFalse<A extends false> = A;
type UndeclaredHandler = () => Effect.Effect<void, UndeclaredError>;
type IncompatibleSameTagHandler = () => Effect.Effect<
  void,
  IncompatibleSameTagError
>;
type UntaggedHandler = () => Effect.Effect<
  void,
  { readonly message: "untagged" }
>;
type HandlerErrorIsNotAny = ExpectFalse<
  IsAny<Rpc.Error<typeof definition.serverRpc>>
>;
type ClientErrorIsNotAny = ExpectFalse<
  IsAny<Rpc.Error<typeof definition.clientRpc>>
>;
type UndeclaredErrorIsRejected = ExpectFalse<
  UndeclaredHandler extends Handler ? true : false
>;
type IncompatiblePayloadIsRejected = ExpectFalse<
  IncompatibleSameTagHandler extends Handler ? true : false
>;
type UntaggedErrorIsRejected = ExpectFalse<
  UntaggedHandler extends Handler ? true : false
>;
const definitionTypeProofs: readonly [
  HandlerErrorIsNotAny,
  ClientErrorIsNotAny,
  UndeclaredErrorIsRejected,
  IncompatiblePayloadIsRejected,
  UntaggedErrorIsRejected,
] = [false, false, false, false, false];

const succeeds: Handler = () => Effect.void;
const failsDeclared: Handler = () =>
  Effect.fail(new DeclaredError({ data: { code: "declared" } }));

/** Aggregate retaining positive handlers and every negative type proof. */
export const definitionTypeCanaries = {
  definition,
  succeeds,
  failsDeclared,
  proofs: definitionTypeProofs,
} as const;
