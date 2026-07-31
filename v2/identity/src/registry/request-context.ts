import { RpcMiddleware } from "@effect/rpc";
import { Context, Effect, FiberRef, Layer, Option } from "effect";
import { AuthenticationFailedError } from "../http-errors.js";

interface BootstrapAdmission {
  readonly admitted: true;
}

class BootstrapAdmissionContext extends Context.Tag(
  "@moltzap/v2-identity/BootstrapAdmissionContext",
)<BootstrapAdmissionContext, BootstrapAdmission>() {}

/** Required private RPC admission boundary for Registry registration. */
export class RegistryAdmission extends RpcMiddleware.Tag<RegistryAdmission>()(
  "@moltzap/v2-identity/RegistryAdmission",
  {
    provides: BootstrapAdmissionContext,
    failure: AuthenticationFailedError,
  },
) {}

const currentAdmission = FiberRef.unsafeMake<Option.Option<BootstrapAdmission>>(
  Option.none(),
);

/**
 * Runs private Registry dispatch with one already-verified admission proof.
 *
 * @param effect Private registration dispatch to admit.
 * @returns The dispatch with its admission proof scoped to the current fiber.
 */
export const withBootstrapAdmission = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.locally(
    currentAdmission,
    Option.some(Object.freeze({ admitted: true as const })),
  )(effect);

const readAdmission = FiberRef.get(currentAdmission).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.fail(new AuthenticationFailedError()),
      onSome: Effect.succeed,
    }),
  ),
);

/** Layer installed only inside the Registry process's private RPC runtime. */
export const registryAdmissionLayer = Layer.succeed(
  RegistryAdmission,
  () => readAdmission,
);
