import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import { principalGateErrorClasses } from "#transport";

const principalGateFailure = Schema.Union(...principalGateErrorClasses);

/**
 * Principal requirement: narrow the live connection to the app arm. The first
 * element of an app-callable method's `requires`. Fails `Unauthorized` /
 * `Forbidden` on a non-app arm.
 */
export class AppPrincipal extends RpcMiddleware.Tag<AppPrincipal>()(
  "@moltzap/protocol/requirement/AppPrincipal",
  { failure: principalGateFailure },
) {}
