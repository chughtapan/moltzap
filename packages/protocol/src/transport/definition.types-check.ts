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
type _HandlerErrorIsNotAny = ExpectFalse<
  IsAny<Rpc.Error<typeof definition.serverRpc>>
>;
type _ClientErrorIsNotAny = ExpectFalse<
  IsAny<Rpc.Error<typeof definition.clientRpc>>
>;

const succeeds: Handler = () => Effect.void;
const failsDeclared: Handler = () =>
  Effect.fail(new DeclaredError({ data: { code: "declared" } }));

// @ts-expect-error — an undeclared tagged error is not wire-encodable here.
const failsUndeclared: Handler = () => Effect.fail(new UndeclaredError());

const incompatibleSameTagFailure = Effect.fail(
  new IncompatibleSameTagError({ data: { code: 1 } }),
);

// @ts-expect-error — matching `_tag` alone does not make the payload compatible.
const failsWithIncompatiblePayload: Handler = () => incompatibleSameTagFailure;

const untaggedFailure = { message: "untagged" } as const;

// @ts-expect-error — untagged errors are not part of the descriptor schema.
const failsUntagged: Handler = () => Effect.fail(untaggedFailure);

/** Aggregate so every value-level canary is retained by lint and declaration emit. */
export const definitionTypeCanaries = {
  succeeds,
  failsDeclared,
  failsUndeclared,
  failsWithIncompatiblePayload,
  failsUntagged,
} as const;
