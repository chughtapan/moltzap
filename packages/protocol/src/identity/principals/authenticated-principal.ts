import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import { principalGateErrorClasses } from "#transport";

const principalGateFailure = Schema.Union(...principalGateErrorClasses);

/**
 * Principal requirement: require any authenticated arm. Used by methods that
 * are shared by first-party agent and app clients but still must reject the
 * unauthenticated pre-connect arm.
 */
export class AuthenticatedPrincipal extends RpcMiddleware.Tag<AuthenticatedPrincipal>()(
  "@moltzap/protocol/requirement/AuthenticatedPrincipal",
  { failure: principalGateFailure },
) {}
