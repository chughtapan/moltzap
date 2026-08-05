import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import { principalGateErrorClasses } from "#transport";

const principalGateFailure = Schema.Union(...principalGateErrorClasses);

/**
 * Principal requirement: the connection is an authenticated agent. The sole
 * principal gate — every gated method heads its `requires` with this tag,
 * rejecting the unauthenticated pre-connect arm.
 */
export class AuthenticatedAgent extends RpcMiddleware.Tag<AuthenticatedAgent>()(
  "@moltzap/protocol/requirement/AuthenticatedAgent",
  { failure: principalGateFailure },
) {}
