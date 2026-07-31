import {
  AuthenticationFailedError,
  type VerifiedAgentRequest,
} from "@moltzap/v2-identity";
import { RpcMiddleware } from "@effect/rpc";
import { Context, Effect, FiberRef, Layer, Option } from "effect";

const currentVerifiedRequest = FiberRef.unsafeMake(
  Option.none<VerifiedAgentRequest>(),
);

/** Private RPC service containing the current verified HTTP request. */
export class VerifiedRouterRequest extends Context.Tag(
  "@moltzap/v2-router/VerifiedRouterRequest",
)<VerifiedRouterRequest, VerifiedAgentRequest>() {}

/** Required private RPC middleware for registered-agent operations. */
export class RegisteredAgentRequest extends RpcMiddleware.Tag<RegisteredAgentRequest>()(
  "@moltzap/v2-router/RegisteredAgentRequest",
  {
    failure: AuthenticationFailedError,
    provides: VerifiedRouterRequest,
  },
) {}

/** Required private-RPC middleware that carries the HTTP verification proof. */
export const registeredAgentRequestLayer = Layer.succeed(
  RegisteredAgentRequest,
  () =>
    FiberRef.get(currentVerifiedRequest).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AuthenticationFailedError()),
          onSome: Effect.succeed,
        }),
      ),
    ),
);

/**
 * Limits one verified request proof to the dynamic extent of one RPC call.
 *
 * @param verifiedRequest Authentication proof for the current HTTP request.
 * @param effect Correlated private RPC call.
 * @returns The call with the proof installed only for its dynamic extent.
 */
export const withVerifiedRouterRequest = <A, E, R>(
  verifiedRequest: VerifiedAgentRequest,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.locally(currentVerifiedRequest, Option.some(verifiedRequest))(effect);
